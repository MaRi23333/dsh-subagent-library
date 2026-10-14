/**
 * Per-profile model routes for a shared roster (issue #3).
 *
 * Roster files under `~/.dsh/subagents/` are home-level and shared by every
 * profile. Their `provider` / `model` strings are not: `desktop` and `web`
 * keep separate LLM registries. Passing a web-authored provider into a
 * desktop delegation fails when that provider is not registered there.
 *
 * Identity (description, persona, tools, enablement) stays in the shared
 * file. Route fields are resolved for the current profile:
 *   1. an explicit overlay at `<roster>/_profiles/<profile>/<id>.yaml`
 *   2. the shared file's route, when its provider is registered here
 *      (or when this process has no LLM registry to check)
 *   3. otherwise drop the foreign route and inherit the calling session
 *
 * `_profiles/` is not a roster: the scanner only reads `*.yaml` in the
 * roster directory itself, and `_`-prefixed names are non-roster content.
 *
 * @module dsh-subagent-library/profile-route
 */
import { createHash } from 'node:crypto'
import * as nodePath from 'node:path'
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'
import {
  entryFileNames,
  type Entry,
  type FsPort,
  nodeFsPort,
} from './roster.ts'

/** Route fields that name an LLM, not the subagent transport. */
export const ROUTE_KEYS = ['provider', 'model', 'reasoningEffort', 'maxTokens'] as const

export type RouteKey = (typeof ROUTE_KEYS)[number]

export interface RouteFields {
  provider?: string
  model?: string
  reasoningEffort?: string
  maxTokens?: number
}

/** Explicit "use this profile's session model" marker. */
export interface InheritRoute {
  inherit: true
}

export type RouteOverlay = InheritRoute | RouteFields

export type RouteNote =
  | 'shared'
  | 'profile'
  | 'inherit'
  | 'foreign-ignored'
  | 'profile-missing'
  | 'overlay-broken'

/** Directory under the roster that holds per-profile route files. */
export const PROFILE_ROUTES_DIR = '_profiles'

const EFFORT_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/
const BOUND_HASH = /^[a-f0-9]{16}$/
/** Windows reserved device names. The stem before the first dot is what the OS checks. */
const RESERVED_BASENAMES = new Set([
  'con', 'prn', 'aux', 'nul',
  ...Array.from({ length: 9 }, (_, index) => `com${index + 1}`),
  ...Array.from({ length: 9 }, (_, index) => `lpt${index + 1}`),
])

const isEnoent = (error: unknown): boolean =>
  (error as { code?: unknown }).code === 'ENOENT'

const isNotDir = (error: unknown): boolean =>
  (error as { code?: unknown }).code === 'ENOTDIR'

const defaultDelay = (ms: number): Promise<void> =>
  new Promise((resolve) => { setTimeout(resolve, ms) })

/**
 * Why this profile name cannot be a route-overlay directory, or undefined when
 * it can. Matches the host's profile-name rules (empty, slashes, `.`, `..`,
 * `node_modules` are invalid) and also rejects Windows path-segment traps
 * (reserved device names, trailing dot/space, `|?*` and controls). A legal
 * host name such as `my profile` is safe. An unsafe name must not fall back
 * to writing this profile's route into the shared roster file.
 */
export function profilePathProblem(name: string): string | undefined {
  if (name === '' || name.includes('/') || name.includes('\\') || name === '.' || name === '..'
    || name === 'node_modules') {
    return `profile name ${JSON.stringify(name)} is not a usable directory name`
  }
  if (name.length > 200) return `profile name ${JSON.stringify(name)} is too long to store a route file`
  if (/[<>:"|?*]/.test(name) || [...name].some((char) => char.charCodeAt(0) < 0x20)) {
    return `profile name ${JSON.stringify(name)} contains characters that cannot be a directory`
  }
  if (name.endsWith('.') || name.endsWith(' ')) {
    return `profile name ${JSON.stringify(name)} cannot end with a dot or space`
  }
  const stem = name.split('.')[0]?.toLowerCase() ?? ''
  if (RESERVED_BASENAMES.has(stem)) {
    return `profile name ${JSON.stringify(name)} is a reserved device name`
  }
  return undefined
}

/** Profile names that are safe as a single path segment under `_profiles/`. */
export function isSafeProfileName(name: string): boolean {
  return profilePathProblem(name) === undefined
}

/** Stable id of the shared file's route. An overlay is bound to this value. */
export function routeBinding(entry: Entry | undefined): string {
  return createHash('sha256').update(JSON.stringify(pickRoute(entry ?? {}))).digest('hex').slice(0, 16)
}

/**
 * Settings-page conflict hash. Includes this profile's overlays so two editors
 * of the same profile cannot silently overwrite each other's route, while a
 * route saved on another profile does not change this hash.
 */
export function hashProfileView(sharedHash: string, profile: string, overlays: Record<string, string>): string {
  const payload = Object.keys(overlays).sort().map((id) => [id, overlays[id]])
  return createHash('sha256').update(JSON.stringify([sharedHash, profile, payload])).digest('hex').slice(0, 16)
}

export function overlayDirectory(rosterDir: string, profile: string): string {
  if (!isSafeProfileName(profile)) {
    throw new Error(`unsafe profile name "${profile}"`)
  }
  return nodePath.join(rosterDir, PROFILE_ROUTES_DIR, profile)
}

export function pickRoute(entry: Entry | RouteFields): RouteFields {
  const record = entry as unknown as Record<string, unknown>
  const route: RouteFields = {}
  const provider = record['provider']
  const model = record['model']
  const reasoningEffort = record['reasoningEffort']
  const maxTokens = record['maxTokens']
  if (typeof provider === 'string' && provider !== '') route.provider = provider
  if (typeof model === 'string' && model !== '') route.model = model
  if (typeof reasoningEffort === 'string' && reasoningEffort !== '') route.reasoningEffort = reasoningEffort
  if (typeof maxTokens === 'number') route.maxTokens = maxTokens
  return route
}

export function hasRoute(route: RouteFields): boolean {
  return route.provider !== undefined
    || route.model !== undefined
    || route.reasoningEffort !== undefined
    || route.maxTokens !== undefined
}

export function sameRoute(left: RouteFields, right: RouteFields): boolean {
  return left.provider === right.provider
    && left.model === right.model
    && left.reasoningEffort === right.reasoningEffort
    && left.maxTokens === right.maxTokens
}

/** Drop LLM route fields. Identity, transport, and tool scope stay. */
export function stripRoute(entry: Entry): Entry {
  const next: Entry = { ...entry }
  delete next.provider
  delete next.model
  delete next.reasoningEffort
  delete next.maxTokens
  return next
}

export function withRoute(entry: Entry, route: RouteFields): Entry {
  const next = stripRoute(entry)
  if (route.provider !== undefined) next.provider = route.provider
  if (route.model !== undefined) next.model = route.model
  if (route.reasoningEffort !== undefined) next.reasoningEffort = route.reasoningEffort
  if (route.maxTokens !== undefined) next.maxTokens = route.maxTokens
  return next
}

/**
 * Shared-file body for a profile-scoped save: keep this profile's identity
 * edit, but do not overwrite another profile's authored route.
 */
export function preserveSharedRoute(incoming: Entry, previous: Entry | undefined): Entry {
  return withRoute(stripRoute(incoming), pickRoute(previous ?? {}))
}

function isInherit(overlay: RouteOverlay): overlay is InheritRoute {
  return (overlay as InheritRoute).inherit === true
}

/**
 * Resolve the route this profile should actually call.
 * `registered === undefined` means the host exposed no provider list, so a
 * shared route cannot be classified as foreign and is left unchanged.
 */
export function resolveEffectiveEntry(
  entry: Entry,
  overlay: RouteOverlay | undefined,
  registered: ReadonlySet<string> | undefined,
): { entry: Entry, note: RouteNote } {
  if (overlay !== undefined && isInherit(overlay)) {
    return { entry: stripRoute(entry), note: 'inherit' }
  }
  if (overlay !== undefined && hasRoute(overlay)) {
    const next = withRoute(entry, overlay)
    if (overlay.provider !== undefined && registered !== undefined && !registered.has(overlay.provider)) {
      return { entry: next, note: 'profile-missing' }
    }
    return { entry: next, note: 'profile' }
  }
  if (entry.provider !== undefined && entry.provider !== ''
    && registered !== undefined && !registered.has(entry.provider)) {
    return { entry: stripRoute(entry), note: 'foreign-ignored' }
  }
  return { entry, note: 'shared' }
}

export interface OverlayDocument {
  overlay: RouteOverlay
  /** Shared-route binding captured when this overlay was written. */
  boundHash?: string
}

/** Parse an overlay file, including the optional shared-route binding. */
export function parseOverlayDocument(raw: unknown): OverlayDocument {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error('profile route must be an object')
  }
  const record = { ...(raw as Record<string, unknown>) }
  const bound = record['boundHash']
  delete record['boundHash']
  if (bound !== undefined && (typeof bound !== 'string' || !BOUND_HASH.test(bound))) {
    throw new Error('boundHash must be 16 hex characters')
  }
  return {
    overlay: parseRouteOverlay(record),
    ...(typeof bound === 'string' ? { boundHash: bound } : {}),
  }
}

export function parseRouteOverlay(raw: unknown): RouteOverlay {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error('profile route must be an object')
  }
  const record = raw as Record<string, unknown>
  const allowed = new Set(['inherit', ...ROUTE_KEYS])
  const unknown = Object.keys(record).filter((key) => !allowed.has(key))
  if (unknown.length > 0) throw new Error(`unknown route fields: ${unknown.join(', ')}`)
  if (record['inherit'] === true) {
    const extras = Object.keys(record).filter((key) => key !== 'inherit')
    if (extras.length > 0) throw new Error('inherit: true cannot be combined with route fields')
    return { inherit: true }
  }
  if ('inherit' in record) throw new Error('inherit must be true when present')
  const route: RouteFields = {}
  if ('provider' in record) {
    if (typeof record['provider'] !== 'string' || record['provider'] === '') {
      throw new Error('provider must be a non-empty string')
    }
    route.provider = record['provider']
  }
  if ('model' in record) {
    if (typeof record['model'] !== 'string' || record['model'] === '') {
      throw new Error('model must be a non-empty string')
    }
    route.model = record['model']
  }
  if ('reasoningEffort' in record) {
    if (typeof record['reasoningEffort'] !== 'string' || !EFFORT_ID.test(record['reasoningEffort'])) {
      throw new Error('reasoningEffort must be an effort id')
    }
    route.reasoningEffort = record['reasoningEffort']
  }
  if ('maxTokens' in record) {
    const maxTokens = record['maxTokens']
    if (typeof maxTokens !== 'number' || !Number.isSafeInteger(maxTokens) || maxTokens < 1) {
      throw new Error('maxTokens must be a positive integer')
    }
    route.maxTokens = maxTokens
  }
  if (!hasRoute(route)) throw new Error('profile route is empty')
  return route
}

export function serializeRouteOverlay(overlay: RouteOverlay, boundHash?: string): string {
  const doc: Record<string, unknown> = isInherit(overlay) ? { inherit: true } : {}
  if (!isInherit(overlay)) {
    for (const key of ROUTE_KEYS) {
      const value = overlay[key]
      if (value !== undefined) doc[key] = value
    }
  }
  if (boundHash !== undefined) doc['boundHash'] = boundHash
  return stringifyYaml(doc, { lineWidth: 0 })
}

async function atomicWrite(
  dir: string,
  fileName: string,
  text: string,
  fsp: FsPort,
  delay: (ms: number) => Promise<void>,
): Promise<void> {
  await fsp.mkdir(dir, { recursive: true })
  const target = nodePath.join(dir, fileName)
  const temp = nodePath.join(dir, `.${fileName}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}.tmp`)
  await fsp.writeFile(temp, text)
  for (let attempt = 0; ; attempt += 1) {
    try {
      await fsp.rename(temp, target)
      return
    } catch (error) {
      if (attempt >= 2) {
        await fsp.unlink(temp).catch(() => { /* best-effort cleanup */ })
        throw error
      }
      await delay(50 * 3 ** attempt)
    }
  }
}

export type OverlayRead =
  | { ok: true, overlay?: RouteOverlay, boundHash?: string, text?: string }
  | { ok: false, message: string }

/** Read one profile's route file. A missing file is "no overlay", not an error. */
export async function readRouteOverlay(
  rosterDir: string,
  profile: string,
  id: string,
  fsp: FsPort = nodeFsPort,
): Promise<OverlayRead> {
  let dir: string
  try {
    dir = overlayDirectory(rosterDir, profile)
  } catch (error) {
    return { ok: false, message: String(error) }
  }
  let text: string | undefined
  let used: string | undefined
  for (const name of entryFileNames(id)) {
    try {
      text = (await fsp.readFile(nodePath.join(dir, name))).toString('utf8')
      used = name
      break
    } catch (error) {
      if (!isEnoent(error)) {
        return { ok: false, message: `profile route unreadable (${profile}/${name}): ${String(error)}` }
      }
    }
  }
  if (text === undefined || used === undefined) return { ok: true }
  try {
    const stripped = text.charCodeAt(0) === 0xFEFF ? text.slice(1) : text
    const parsed = parseOverlayDocument(parseYaml(stripped))
    return { ok: true, overlay: parsed.overlay, boundHash: parsed.boundHash, text: stripped }
  } catch (error) {
    return { ok: false, message: `profile route ${profile}/${used} is invalid: ${String(error)}` }
  }
}

export async function writeRouteOverlay(
  rosterDir: string,
  profile: string,
  id: string,
  overlay: RouteOverlay,
  fsp: FsPort = nodeFsPort,
  delay: (ms: number) => Promise<void> = defaultDelay,
  boundHash?: string,
): Promise<void> {
  const dir = overlayDirectory(rosterDir, profile)
  await atomicWrite(dir, `${id}.yaml`, serializeRouteOverlay(overlay, boundHash), fsp, delay)
  const yml = nodePath.join(dir, `${id}.yml`)
  try {
    await fsp.unlink(yml)
  } catch (error) {
    if (!isEnoent(error)) throw error
  }
}

export async function deleteProfileOverlay(
  rosterDir: string,
  profile: string,
  id: string,
  fsp: FsPort = nodeFsPort,
): Promise<void> {
  const dir = overlayDirectory(rosterDir, profile)
  for (const name of entryFileNames(id)) {
    try {
      await fsp.unlink(nodePath.join(dir, name))
    } catch (error) {
      if (!isEnoent(error) && !isNotDir(error)) throw error
    }
  }
}

/**
 * Remove every profile's route file for one entry. Deleting the shared entry
 * must not leave a stale overlay that reappears if the id is created again.
 */
export async function deleteRouteOverlays(
  rosterDir: string,
  id: string,
  fsp: FsPort = nodeFsPort,
): Promise<void> {
  const root = nodePath.join(rosterDir, PROFILE_ROUTES_DIR)
  let names: string[]
  try {
    names = await fsp.readdir(root)
  } catch (error) {
    if (isEnoent(error) || isNotDir(error)) return
    throw error
  }
  for (const profile of names) {
    if (!isSafeProfileName(profile)) continue
    await deleteProfileOverlay(rosterDir, profile, id, fsp)
  }
}

/**
 * Persist a route edit relative to the route the settings page displayed.
 * An echoed empty route — the page hid a provider this profile does not
 * have — is not an edit and must not become `inherit: true`.
 * @returns whether an overlay file was written.
 */
export async function syncProfileRoute(options: {
  dir: string
  profile: string
  id: string
  /** Entry the client saved. */
  client: Entry
  /** Effective entry this profile was shown. Empty route when the shared provider was hidden. */
  shown: Entry
  /** Shared-file entry, used only to bind the overlay to that route. */
  shared: Entry | undefined
  fs?: FsPort
}): Promise<boolean> {
  const fsp = options.fs ?? nodeFsPort
  const clientRoute = pickRoute(options.client)
  const shownRoute = pickRoute(options.shown)
  if (sameRoute(clientRoute, shownRoute)) return false
  await writeRouteOverlay(
    options.dir,
    options.profile,
    options.id,
    hasRoute(clientRoute) ? clientRoute : { inherit: true },
    fsp,
    defaultDelay,
    routeBinding(options.shared),
  )
  return true
}

/**
 * Both roster spellings are confirmed missing. Any other outcome — the file
 * exists, or the check itself failed — is not absence. A read/parse/permission
 * error must not be turned into a delete (SUB-PROFILE-SEC-001).
 */
async function sharedEntryConfirmedAbsent(rosterDir: string, id: string, fsp: FsPort): Promise<boolean> {
  for (const name of entryFileNames(id)) {
    try {
      await fsp.readFile(nodePath.join(rosterDir, name))
      return false
    } catch (error) {
      if (!isEnoent(error)) return false
    }
  }
  return true
}

/**
 * Drop overlay files only when this read proved the shared entry is gone.
 *
 * A successful directory listing plus a per-id ENOENT re-check is the only
 * read-time signal. `unreadable` / `missing` listings, a file that was listed
 * but failed to read or parse, and any non-ENOENT re-check keep every
 * profile's overlay bytes. Explicit entry deletion still uses
 * {@link deleteRouteOverlays}; this function is not that path.
 */
export async function deleteOrphanOverlays(
  rosterDir: string,
  listing: 'ok' | 'missing' | 'unreadable',
  presentIds: ReadonlySet<string>,
  fsp: FsPort = nodeFsPort,
): Promise<void> {
  if (listing !== 'ok') return
  const root = nodePath.join(rosterDir, PROFILE_ROUTES_DIR)
  let profiles: string[]
  try {
    profiles = await fsp.readdir(root)
  } catch (error) {
    if (isEnoent(error) || isNotDir(error)) return
    // Cannot see the overlay tree. Do not guess which files are orphans.
    return
  }
  for (const profile of profiles) {
    if (!isSafeProfileName(profile)) continue
    const dir = overlayDirectory(rosterDir, profile)
    let names: string[]
    try {
      names = await fsp.readdir(dir)
    } catch (error) {
      if (isEnoent(error) || isNotDir(error)) continue
      // This profile's overlay directory could not be listed. Leave it, and
      // do not use that failure as a reason to clean any other profile.
      continue
    }
    for (const name of names) {
      const lower = name.toLowerCase()
      if (!lower.endsWith('.yaml') && !lower.endsWith('.yml')) continue
      const id = lower.endsWith('.yaml') ? lower.slice(0, -5) : lower.slice(0, -4)
      if (presentIds.has(id)) continue
      if (!await sharedEntryConfirmedAbsent(rosterDir, id, fsp)) continue
      try {
        await fsp.unlink(nodePath.join(dir, name))
      } catch (error) {
        if (!isEnoent(error)) throw error
      }
    }
  }
}
