/**
 * Directory-backed roster store for dsh-subagent-library (0.3.0+).
 *
 * One named subagent per YAML file (`<id>.yaml`, id = file name) under a
 * roster directory (default `~/.dsh/subagents`). The legacy inline
 * `subagent-library.entries` settings document keeps working as a read-only
 * fallback during 0.3.x: file entries win, legacy-only entries still serve,
 * and a per-entry idempotent migration seeds the directory once.
 *
 * Design notes (v0.3.0 review, k3-helper):
 *  - No caching: rosters are tens of small files, every consumer re-reads the
 *    directory. The cache layer is exactly where mtime/case/rename bugs live.
 *  - Bad files never brick the roster: they are skipped and reported as
 *    diagnostics that every consumer surfaces.
 *  - Writes are per-file atomic (temp file + rename with bounded retries for
 *    Windows AV/indexer transient locks); roster-level saves are best-effort.
 *  - All filesystem access goes through an injectable `FsPort` (tests install
 *    an in-memory port via the `kFsPort` symbol; production uses node:fs).
 *
 * @module dsh-subagent-library/roster
 */
import { createHash } from 'node:crypto'
import { homedir } from 'node:os'
import * as nodePath from 'node:path'
import { promises as nodeFsPromises } from 'node:fs'
import z from '@deepseek-ai/schemastery'
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'
import { validateEntryId } from './entry-id.ts'

export { ENTRY_ID, MAX_ID_LENGTH, validateEntryId } from './entry-id.ts'

/** Optional child tool scoping (subset semantics documented on `delegate`). */
export interface ToolFilter {
  /** Global tool names the child keeps; everything else is removed. */
  allow?: string[]
  /** Global tool names removed from the child. */
  deny?: string[]
}

/** One named library entry (file or legacy document shape). */
export interface Entry {
  /** Role description surfaced to the model in `list_subagents`; keep it self-contained. */
  description: string
  /** LLM provider route for the child (e.g. `deepseek-official`, `kimi-coding`); omitted children use the caller's loop defaults. */
  provider?: string
  /** Provider model id; omitted children use the caller's loop defaults. */
  model?: string
  /** Adapter-owned reasoning-effort id for the child (e.g. `max`, `high`);
   *  omitted children keep the parent/deployment default. Passed through the
   *  official `agentOptions.reasoningEffort` override (AgentOptions): the
   *  harness resolves it in `resolveChildAgentOptions` and automatically drops
   *  an INHERITED effort when the child's route differs from the parent's, so
   *  an unset field never leaks an effort across models. */
  reasoningEffort?: string
  /** Subagent transport provider (e.g. `spawn`); defaults to the plugin-level `subagentProvider`. */
  subagentProvider?: string
  /** Per-request output cap for the child. */
  maxTokens?: number
  /** Role guidance included in the child's first task. */
  persona?: string
  /** Child tool scoping. */
  toolFilter?: ToolFilter
  /** Absolute delegation-depth cap for the child; requires provider depthLimit. */
  maxDepth?: number
  /** Historical setting retained for existing files. Native dispatch ignores it. */
  backgroundMode?: 'one-shot' | 'continuable'
}

export const EntrySchema: z<Entry> = z.object({
  description: z.string().required(),
  provider: z.string(),
  model: z.string(),
  subagentProvider: z.string(),
  reasoningEffort: z.string(),
  maxTokens: z.natural().max(Number.MAX_SAFE_INTEGER),
  persona: z.string(),
  toolFilter: z.object({
    allow: z.array(z.string()).default(undefined as unknown as string[]),
    deny: z.array(z.string()).default(undefined as unknown as string[]),
  }).default(undefined as unknown as { allow: string[]; deny: string[] }),
  maxDepth: z.natural().max(Number.MAX_SAFE_INTEGER),
  backgroundMode: z.union(['one-shot', 'continuable'] as const),
})

const ENTRY_KEYS = new Set([
  'description', 'provider', 'model', 'subagentProvider', 'reasoningEffort', 'maxTokens',
  'persona', 'toolFilter', 'maxDepth', 'backgroundMode',
])

/** Narrow filesystem port so tests never touch the real disk (SUB-TEST-001). */
export interface FsPort {
  readdir(dir: string): Promise<string[]>
  readFile(path: string): Promise<Buffer>
  writeFile(path: string, data: string, flag?: 'wx'): Promise<void>
  rename(from: string, to: string): Promise<void>
  unlink(path: string): Promise<void>
  mkdir(dir: string, options: { recursive: true }): Promise<void>
}

/** Key under which a host/test may inject an `FsPort` on the plugin Context. */
export const kFsPort: unique symbol = Symbol.for('dsh-subagent-library.fs-port')

export const nodeFsPort: FsPort = {
  readdir: (dir) => nodeFsPromises.readdir(dir),
  readFile: (path) => nodeFsPromises.readFile(path),
  writeFile: (path, data, flag) => nodeFsPromises.writeFile(path, data, { encoding: 'utf8', flag }),
  rename: (from, to) => nodeFsPromises.rename(from, to),
  unlink: (path) => nodeFsPromises.unlink(path),
  mkdir: async (dir, options) => { await nodeFsPromises.mkdir(dir, options) },
}

const isEnoent = (error: unknown): boolean =>
  (error as { code?: unknown }).code === 'ENOENT'

const defaultDelay = (ms: number): Promise<void> =>
  new Promise((resolve) => { setTimeout(resolve, ms) })

/** Expand `~`, anchor relative paths at `~/.dsh`, keep absolutes as-is. */
export function resolveEntriesDir(entriesDir: string | undefined, home = homedir()): string {
  const raw = entriesDir?.trim()
  if (raw === undefined || raw === '') return nodePath.join(home, '.dsh', 'subagents')
  const expanded = raw === '~' || raw.startsWith('~/') || raw.startsWith('~\\')
    ? nodePath.join(home, raw.slice(2))
    : raw
  return nodePath.isAbsolute(expanded) ? expanded : nodePath.join(home, '.dsh', expanded)
}

const stripBom = (text: string): string =>
  text.charCodeAt(0) === 0xFEFF ? text.slice(1) : text

export interface RosterDiagnostic {
  severity: 'error' | 'warning' | 'info'
  /** Entry id the diagnostic is about, when known. */
  id?: string
  /** Roster file name the diagnostic is about, when known. */
  file?: string
  message: string
}

/** One resolved roster row: a validated entry plus its storage provenance. */
export interface RosterEntry {
  entry: Entry
  /** `false` = kept in every view (so the UI can re-enable it) but refused by `delegate`. */
  enabled: boolean
  source: 'file' | 'legacy'
  /** Roster file name (not the full path) when `source === 'file'`. */
  file?: string
}

export interface RosterView {
  dir: string
  entries: Record<string, RosterEntry>
  diagnostics: RosterDiagnostic[]
  /** Stable content hash of the roster rows — the UI write guard. */
  hash: string
  /** File bytes and read failures also guard against overwriting an external edit. */
  fileRevision: string
  /**
   * Whether the roster directory listing itself succeeded.
   * `unreadable` is not "empty": callers must not treat missing entries as deleted.
   */
  listing: 'ok' | 'missing' | 'unreadable'
  /**
   * Ids named by a `.yaml`/`.yml` the listing actually returned, including
   * files that later failed to read or parse. Absence from `entries` is not
   * absence from disk.
   */
  presentIds: ReadonlySet<string>
  /** Named files whose contents or filename could not be trusted. */
  unreadableIds: ReadonlySet<string>
}

/**
 * Parse and validate one entry document (file contents or a save payload).
 * Unknown keys are LOUDLY rejected: a typo'd `backgroundmode` must not be
 * silently dropped into a default. Returns the normalized entry and the
 * enabled flag (default true).
 */
export function parseEntryDocument(raw: unknown): { entry: Entry, enabled: boolean } {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error('条目内容必须是对象（字段：description / provider / model / …）')
  }
  const record = raw as Record<string, unknown>
  const unknownKeys = Object.keys(record).filter((key) => key !== 'enabled' && !ENTRY_KEYS.has(key))
  if (unknownKeys.length > 0) {
    throw new Error(`未知字段：${unknownKeys.join(', ')}（可用：${[...ENTRY_KEYS, 'enabled'].join(', ')}）`)
  }
  const { enabled = true, ...rest } = record
  if (typeof enabled !== 'boolean') throw new Error('enabled 必须是布尔值')
  // reasoningEffort is adapter-owned and deliberately free-form, but it must
  // LOOK like an id: the official model-selection layer overrides or clears
  // an inherited effort when installed, and on the raw path the adapter reads
  // it verbatim — reject prose typos here instead of failing deep in an
  // adapter far away from the YAML line that caused it (red team A4).
  if (typeof record['reasoningEffort'] === 'string'
    && !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(record['reasoningEffort'])) {
    throw new Error(`reasoningEffort 须为 effort id（如 max / high / medium / low），收到 "${record['reasoningEffort']}"`)
  }
  // The schema performs the real structural validation at runtime; the cast
  // only bridges the static type (rest may legitimately lack optional keys).
  const entry = EntrySchema(rest as unknown as Entry)
  if (typeof entry !== 'object' || entry === null) throw new Error('条目校验失败')
  return { entry, enabled }
}

/** Canonical JSON of one entry (recursively key-sorted) — hash input. */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical)
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, item]) => item !== undefined)
        .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
        .map(([key, item]) => [key, canonical(item)]),
    )
  }
  return value
}

function hashEntries(entries: Record<string, RosterEntry>): string {
  const payload = Object.keys(entries).sort().map((id) => [
    id,
    entries[id].enabled,
    canonical(entries[id].entry),
  ])
  return createHash('sha256').update(JSON.stringify(payload)).digest('hex').slice(0, 16)
}

/** Serialize an entry to YAML, preserving explicit legacy fields. */
export function serializeEntry(entry: Entry, enabled = true): string {
  const record = entry as unknown as Record<string, unknown>
  const doc: Record<string, unknown> = {}
  for (const key of ['description', 'provider', 'model', 'subagentProvider', 'reasoningEffort', 'maxTokens', 'persona', 'toolFilter', 'maxDepth', 'backgroundMode']) {
    const value = record[key]
    if (value === undefined) continue
    doc[key] = value
  }
  if (!enabled) doc['enabled'] = false
  return stringifyYaml(doc, { lineWidth: 0 })
}

/** The CANONICAL file name for an id — always `.yaml` (SUB-ROSTER-YML-001:
 *  save converges every entry onto this spelling). */
export const entryFileName = (id: string): string => `${id}.yaml`

/** Every on-disk spelling that can serve one id. `loadRoster` READS both, so
 *  writes and deletes must address both too — a `.yml`-only entry that
 *  survives a delete would resurrect after every restart (SUB-ROSTER-YML-001). */
export const entryFileNames = (id: string): string[] => [`${id}.yaml`, `${id}.yml`]

/** A transient Windows file lock can delay unlink; ENOENT is already clean. */
export async function unlinkWithRetry(
  file: string,
  fsp: FsPort = nodeFsPort,
  delay: (ms: number) => Promise<void> = defaultDelay,
): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await fsp.unlink(file)
      return
    } catch (error) {
      if (isEnoent(error)) return
      if (attempt >= 2) throw error
      await delay(50 * 3 ** attempt)
    }
  }
}

/** Remove the noncanonical spelling after saving an entry. */
export function removeYmlSibling(dir: string, id: string, fsp = nodeFsPort, delay = defaultDelay): Promise<void> {
  return unlinkWithRetry(nodePath.join(dir, `${id}.yml`), fsp, delay)
}

/** Atomic single-file write: temp name in the roster dir, then rename with
 *  bounded retries (Windows AV/indexer transiently lock fresh files). */
export async function writeEntryFile(options: {
  dir: string
  id: string
  entry: Entry
  enabled?: boolean
  fs?: FsPort
  delay?: (ms: number) => Promise<void>
}): Promise<void> {
  const fsp = options.fs ?? nodeFsPort
  const wait = options.delay ?? defaultDelay
  await writeYamlFile(options.dir, options.id, serializeEntry(options.entry, options.enabled ?? true), fsp, wait)
  await removeYmlSibling(options.dir, options.id, fsp, wait)
}

export async function writeYamlFile(dir: string, id: string, contents: string, fsp: FsPort, wait = defaultDelay): Promise<void> {
  const invalid = validateEntryId(id)
  if (invalid) throw new Error(invalid)
  await fsp.mkdir(dir, { recursive: true })
  const target = nodePath.join(dir, entryFileName(id))
  const temp = nodePath.join(dir, `.${id}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}.tmp`)
  await fsp.writeFile(temp, contents)
  for (let attempt = 0; ; attempt += 1) {
    try {
      await fsp.rename(temp, target)
      break
    } catch (error) {
      if (attempt >= 2) {
        await fsp.unlink(temp).catch(() => { /* best effort cleanup */ })
        throw error
      }
      await wait(50 * 3 ** attempt)
    }
  }
}

/** Remove every on-disk spelling that can serve one id (`.yaml` AND `.yml`);
 *  a missing file is already the desired state (SUB-ROSTER-YML-001). */
export async function deleteEntryFile(dir: string, id: string, fsp: FsPort = nodeFsPort): Promise<void> {
  for (const name of entryFileNames(id)) {
    try {
      await fsp.unlink(nodePath.join(dir, name))
    } catch (error) {
      if (!isEnoent(error)) throw error
    }
  }
}

export interface LoadRosterOptions {
  dir: string
  /** Legacy inline settings entries — read-only fallback, shadowed by files. */
  legacy?: Record<string, Entry>
  fs?: FsPort
}

/**
 * Read the whole roster fresh: directory files first (sorted), then legacy
 * entries that no file shadows. Diagnostics carry every skip reason.
 */
export async function loadRoster(options: LoadRosterOptions): Promise<RosterView> {
  const fsp = options.fs ?? nodeFsPort
  const diagnostics: RosterDiagnostic[] = []
  const entries: Record<string, RosterEntry> = Object.create(null)
  const revision = createHash('sha256')

  let names: string[]
  let listing: RosterView['listing']
  try {
    names = (await fsp.readdir(options.dir)).slice().sort()
    listing = 'ok'
  } catch (error) {
    if (isEnoent(error)) {
      listing = 'missing'
    } else {
      listing = 'unreadable'
      diagnostics.push({ severity: 'error', message: `名册目录不可读 ${options.dir}：${String(error)}` })
    }
    names = []
  }
  /** Every roster id the listing named, before read/parse. A failed file is
   *  still present — overlay cleanup must not treat it as deleted. */
  const presentIds = new Set<string>()

  const owner = new Map<string, string>()
  /** A bad file blocks edits even when a sibling or legacy copy can still be displayed. */
  const failedFileIds = new Set<string>()
  for (const name of names) {
    const lower = name.toLowerCase()
    if (!lower.endsWith('.yaml') && !lower.endsWith('.yml')) continue
    // Suffix-only strip (never replaceAll — `a.yaml1.yaml` must not become `a1`).
    const id = lower.endsWith('.yaml') ? lower.slice(0, -5) : lower.slice(0, -4)
    // `_`-prefixed names are intentional NON-roster content (the `_backups/`
    // directory agents use for pre-edit copies, `_draft.yaml`, …) — skipped
    // silently, never reported as diagnostics noise.
    if (id.startsWith('_')) continue
    revision.update(JSON.stringify(name))
    presentIds.add(id)
    if (lower !== name) {
      failedFileIds.add(id)
      diagnostics.push({ severity: 'warning', file: name, id, message: `文件名必须全小写，已跳过 "${name}"` })
      continue
    }
    const idError = validateEntryId(id)
    if (idError !== undefined) {
      diagnostics.push({ severity: 'error', file: name, id, message: idError })
      continue
    }
    const existing = owner.get(id)
    let text: string
    try {
      text = (await fsp.readFile(nodePath.join(options.dir, name))).toString('utf8')
      revision.update(JSON.stringify(text))
    } catch (error) {
      diagnostics.push({ severity: 'error', file: name, id, message: `读取失败，条目已跳过：${String(error)}` })
      failedFileIds.add(id)
      continue
    }
    if (existing !== undefined) {
      diagnostics.push({ severity: 'error', file: name, id, message: `与 "${existing}" 解析出相同 id（.yaml/.yml 只能保留一个），已跳过` })
      continue
    }
    owner.set(id, name)
    try {
      const { entry, enabled } = parseEntryDocument(parseYaml(stripBom(text)))
      entries[id] = { entry, enabled, source: 'file', file: name }
    } catch (error) {
      diagnostics.push({ severity: 'error', file: name, id, message: `解析或校验失败，条目已跳过：${String(error)}` })
      failedFileIds.add(id)
    }
  }

  for (const [id, entry] of Object.entries(options.legacy ?? {})) {
    // Invalid legacy ids can never be addressed by delegate/delete; skip them
    // silently (same posture as the red-team #2 filter on settings views).
    if (validateEntryId(id)) continue
    const file = entries[id]
    if (file !== undefined) {
      diagnostics.push({
        severity: 'info',
        id,
        message: `settings 中的旧条目已被名册文件 "${file.file}" 覆盖（旧条目可从 settings.yaml 删除）`,
      })
      continue
    }
    if (failedFileIds.has(id)) {
      diagnostics.push({
        severity: 'error',
        id,
        message: '名册文件损坏，settings 旧配置仅作展示兜底。修复或删除坏文件后才能派遣。',
      })
    }
    entries[id] = { entry, enabled: true, source: 'legacy' }
  }

  revision.update(JSON.stringify(diagnostics))
  return {
    dir: options.dir, entries, diagnostics, hash: hashEntries(entries),
    fileRevision: revision.digest('hex'), listing, presentIds, unreadableIds: failedFileIds,
  }
}

export interface MigrationResult {
  imported: string[]
  skipped: Array<{ id: string, reason: string }>
  diagnostics: RosterDiagnostic[]
}

/**
 * One-time-per-directory, per-entry idempotent migration: every legacy entry
 * that has no roster file yet (and a valid id) is written to `<id>.yaml`.
 * Legacy settings entries are intentionally KEPT (rollback copy for users
 * downgrading the plugin); re-running never duplicates or overwrites.
 */
export async function migrateLegacyEntries(options: {
  dir: string
  legacy: Record<string, Entry>
  fs?: FsPort
  delay?: (ms: number) => Promise<void>
}): Promise<MigrationResult> {
  const fsp = options.fs ?? nodeFsPort
  const diagnostics: RosterDiagnostic[] = []
  const imported: string[] = []
  const skipped: MigrationResult['skipped'] = []
  let names: Set<string>
  try {
    names = new Set((await fsp.readdir(options.dir)).map((name) => name.toLowerCase()))
  } catch (error) {
    if (!isEnoent(error)) throw error
    names = new Set()
  }
  for (const [id, entry] of Object.entries(options.legacy)) {
    const idError = validateEntryId(id)
    if (idError !== undefined) {
      skipped.push({ id, reason: idError })
      continue
    }
    if (names.has(`${id}.yaml`) || names.has(`${id}.yml`)) {
      skipped.push({ id, reason: 'roster file already exists' })
      continue
    }
    try {
      await writeEntryFile({ dir: options.dir, id, entry, fs: fsp, delay: options.delay })
      names.add(`${id}.yaml`)
      imported.push(id)
    } catch (error) {
      diagnostics.push({ severity: 'error', id, message: `迁移写入失败：${String(error)}` })
    }
  }
  return { imported, skipped, diagnostics }
}
