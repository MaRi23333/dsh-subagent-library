/** Directory-backed roles and groups, profile model routes, and the library settings API. */
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { deleteGroup, loadGroups, lockRoster, parseGroup, roleUsages, writeGroup, type Group } from './groups.ts'
import { registerLibraryTools, roleUnavailable } from './dispatch.ts'
// NOTE: `@deepseek-ai/dsh-settings` must NOT be value-imported here. DSH
// 0.1.7 removed the settingsNamespace() VALUE export (type-only remains), and
// a value import fails the whole module load → the entire plugin 503s
// (SUB-ROSTER-YML-001 follow-up; docs/DSH-VERSIONS.md 0.1.7-rc.2). The
// settings seam below detects the host generation structurally at runtime.
// This type-only import exists for the cordis `ctx.settings` augmentation on
// hosts where the type package still declares it — erased at runtime.
import type {} from '@deepseek-ai/dsh-settings'
import type {} from '@deepseek-ai/dsh-host-webserver'
import {
  ENTRY_ID,
  deleteEntryFile,
  entryFileName,
  kFsPort,
  loadRoster,
  migrateLegacyEntries,
  nodeFsPort,
  parseEntryDocument,
  removeYmlSibling,
  resolveEntriesDir,
  serializeEntry,
  validateEntryId,
  writeEntryFile,
  EntrySchema,
  type Entry,
  type FsPort,
  type RosterEntry,
  type RosterDiagnostic,
  type RosterView,
} from './roster.ts'
import {
  deleteOrphanOverlays,
  hasOrphanOverlays,
  deleteProfileOverlay,
  deleteRouteOverlays,
  hashProfileView,
  preserveSharedRoute,
  parseRouteOverlay,
  writeRouteOverlay,
  type RouteOverlay,
  profilePathProblem,
  pickRoute,
  readRouteOverlay,
  sameRoute,
  resolveEffectiveEntry,
  routeBinding,
  stripRoute,
  withRoute,
  syncProfileRoute,
  type RouteNote,
} from './profile-route.ts'

export type { Entry, ToolFilter } from './roster.ts'

export const name = 'subagent-library'
export const inject = ['subagents', 'tools', 'systemPrompt']

export interface Config {
  /** Subagent transport provider used when an entry names none. */
  subagentProvider: string
  /** Roster directory holding one `<id>.yaml` per entry. Default `~/.dsh/subagents`. */
  entriesDir?: string
  /** @deprecated 0.2.x inline roster — retained for migration. */
  entries?: Record<string, Entry>
}

export const Config: z<Config> = z.object({
  subagentProvider: z.string().default('spawn'),
  entriesDir: z.string(),
  entries: z.dict(EntrySchema).default({}),
})

export function apply(ctx: Context, config: Config) {
  // ── settings seam: entry config as base, user document hot-reloaded ───────
  // Inline the optional-settings wiring (same pattern as dsh-agent-presets):
  // `installSettingsSection` is deliberately NOT used — in this harness build
  // its registration is dropped for bundle-loaded plugins. The inject callback
  // fires once the settings service finishes initializing.
  // ── settings seam (runtime dual-shape) ─────────────────────────────────────
  // DSH 0.1.7 replaced the register()-based settings provider with the
  // profile-backed `SettingsForms` service (config moved from settings.yaml
  // into the profile's cordis.patch.yml) and removed the settingsNamespace()
  // value export. Both host generations are detected structurally at runtime;
  // the namespace is the profile entry id (`subagent-library`).
  interface SettingsSeam {
    /** Live config of this namespace; undefined = use apply()'s base config. */
    readConfig(): Config | undefined
    /** Legacy `entries` stored in the settings document (rollback copies). */
    legacyUserEntries(): Record<string, Entry> | undefined
    unsetEntries(ids: string[]): Promise<'done' | 'skipped-readonly' | 'no-settings'>
    isWritable(): boolean
  }
  const SETTINGS_NS = 'subagent-library'
  /** Shape of the parts of `ctx.configEditor` (DSH ≥0.1.7) the seam uses. */
  interface ConfigEditorHost {
    entries?(): Array<{ options?: { id?: unknown }; id?: unknown }>
    edit(entry: unknown, change: (current: Record<string, unknown>, inherited: Record<string, unknown>) => Record<string, unknown>): Promise<void>
  }
  let configEditorHost: ConfigEditorHost | undefined
  let settings: SettingsSeam | undefined
  /** Non-null when the settings seam could not initialize (e.g. a hand-edited
   *  stored section fails the Config schema on the legacy register path).
   *  Failures surface through every consumer instead of leaving the library
   *  silently degraded. */
  let settingsFailure: string | undefined
  ctx.inject(['settings'], (sctx: Context) => {
    /** Structural view covering both host generations (type deps stay pinned
     *  to 0.1.0-rc.6, so nothing here can rely on their static types). */
    const svc = sctx.settings as unknown as {
      register?(ns: unknown, schema: unknown, options?: { base?: Config }): { get(): Config }
      describe?(): Array<{ ns: unknown; user?: unknown; value?: unknown; revision: number }>
      mutate?(ns: string, ops: Array<{ op: string; path: ReadonlyArray<string> }>, expectedRevision?: number): Promise<void>
      writable?: boolean
    }
    if (typeof svc?.register === 'function') {
      // ── DSH ≤0.1.6 — register() + live scope.get() ────────────────────────
      try {
        const scope = svc.register(SETTINGS_NS, Config, { base: config })
        const legacyRaw = (): { entries?: Record<string, Entry> } | undefined => {
          try {
            // Method-call form ON PURPOSE: the real SettingsProvider.describe
            // depends on `this` — a detached alias (`const d = svc.describe;
            // d()`) throws, the catch below swallows it, and legacyCount
            // falsely reports 0 while clear-legacy claims success
            // (SUB-COMPAT-017-001).
            const row = svc.describe?.().find((candidate) => String(candidate.ns) === SETTINGS_NS)
            return (row?.user ?? undefined) as { entries?: Record<string, Entry> } | undefined
          } catch {
            return undefined
          }
        }
        settings = {
          readConfig: () => scope.get(),
          legacyUserEntries: () => legacyRaw()?.entries,
          unsetEntries: async (ids) => {
            if (ids.length === 0) return 'done'
            if (typeof svc.mutate !== 'function') return 'no-settings'
            if (svc.writable === false) return 'skipped-readonly'
            await svc.mutate(SETTINGS_NS, ids.map((id) => ({ op: 'unset', path: ['entries', id] })))
            return 'done'
          },
          isWritable: () => svc.writable !== false,
        }
      } catch (error) {
        settingsFailure = `subagent-library 设置段注册失败：${String(error)}。请检查存储的 subagent-library 配置段（常见：description 缺失、entries 写成数组、YAML 布尔/字符串误写）。`
      }
      return
    }
    if (typeof svc?.register !== 'function') {
      // ── DSH ≥0.1.7 — profile-backed config (configEditor channel) ──────────
      // SettingsForms on 0.1.7 surfaces ONLY entries with volatile fields
      // (live secrets; red team blocker #1): describe() never contains us and
      // mutate() throws "has no volatile fields" — the service is unusable
      // for ordinary plugin config. Ordinary config — including entriesDir
      // and the imported legacy `entries` — reaches this plugin through
      // apply()'s config (the Loader re-applies on patch edits), so:
      //   readConfig        = apply()'s config (NOT describe — its value-shape
      //                       fallback once bound another plugin's entry,
      //                       red team major #2)
      //   legacy read/unset = profile patch via ctx.configEditor, whose
      //                       inject is bound separately below (0.1.7+ only).
      /** Resolved schema defaults, computed once. Used to RESTORE effective
       *  defaults in the apply()-closure when a raw patch `next` drops keys —
       *  the ConfigEditor raw layer does NOT carry schema defaults
       *  (e.g. `subagentProvider: 'spawn'`), and a wholesale overwrite of the
       *  resolved config with raw values silently removed them, breaking
       *  delegation with "provider not registered"
       *  (SUB-COMPAT-017-004). Defaults are restored in the closure ONLY —
       *  never written back into the raw patch. */
      let schemaDefaultsCache: Config | undefined
      const schemaDefaults = (): Config => {
        if (schemaDefaultsCache === undefined) {
          try {
            schemaDefaultsCache = Config({} as never) as Config
          } catch {
            schemaDefaultsCache = { subagentProvider: 'spawn', entries: {} }
          }
        }
        // Fresh shallow copy per call (entries cloned too): applyReconciled
        // writes these values into the live config — handing out the cached
        // object by reference would let any future in-place write poison the
        // defaults forever (GLM re-verification minor).
        const cached = schemaDefaultsCache as unknown as Record<string, unknown>
        return {
          ...cached,
          entries: { ...((cached['entries'] ?? {}) as Record<string, Entry>) },
        } as Config
      }
      /** Reflect a reconciled RAW config into the apply()-closure, re-resolving
       *  schema defaults for keys the raw layer dropped. The Loader reconcile
       *  may restart this plugin asynchronously, but the in-flight HTTP
       *  response and later reads must not lose defaults in the meantime. */
      const applyReconciled = (next: Record<string, unknown>): void => {
        const target = config as unknown as Record<string, unknown>
        const defaults = schemaDefaults() as unknown as Record<string, unknown>
        // The key universe MUST include the SCHEMA keys: a schema-declared key
        // that is absent from BOTH the raw patch and the resolved closure
        // (already reconciled away) still needs its default re-applied —
        // iterating only target ∪ next silently skips exactly that case
        // (SUB-COMPAT-017-004 root cause).
        const keys = new Set([...Object.keys(defaults), ...Object.keys(target), ...Object.keys(next)])
        for (const key of keys) {
          // Prototype-dangerous keys never enter the resolved config (raw
          // JSON can carry an own `__proto__` key; plain assignment would hit
          // the prototype setter).
          if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue
          if (Object.hasOwn(next, key)) {
            target[key] = next[key]
          } else if (defaults[key] !== undefined) {
            target[key] = defaults[key]
          } else if (key in target) {
            delete target[key]
          }
        }
      }
      settings = {
        readConfig: () => config,
        legacyUserEntries: () => (config.entries ?? undefined) as Record<string, Entry> | undefined,
        unsetEntries: async (ids) => {
          if (ids.length === 0) return 'done'
          const editor = configEditorHost
          if (editor === undefined) return 'no-settings'
          if (svc.writable === false) return 'skipped-readonly'
          const entry = editor.entries?.().find((row) => {
            const id = (row.options as { id?: unknown } | undefined)?.id ?? row.id
            return String(id ?? '') === SETTINGS_NS
          })
          if (entry === undefined) return 'no-settings'
          let applied: Record<string, unknown> | undefined
          await editor.edit(entry, (current) => {
            // Start from the MERGED entries view (patch + inherited): a plain
            // patch delete cannot remove an inherited key, so the converged
            // set is written back as an explicit override. The callback must
            // ALWAYS return an object — undefined violates the host contract
            // (red team re-verification major #2).
            const patchEntries = (typeof current['entries'] === 'object' && current['entries'] !== null
              ? { ...(current['entries'] as Record<string, unknown>) }
              : {})
            const merged = {
              ...((config.entries ?? {}) as Record<string, unknown>),
              ...patchEntries,
            }
            let changed = false
            for (const id of ids) {
              if (Object.hasOwn(merged, id)) {
                delete merged[id]
                changed = true
              }
            }
            const next = changed ? { ...current, entries: merged } : { ...current }
            applied = next
            return next
          })
          if (applied !== undefined) applyReconciled(applied)
          return 'done'
        },
        isWritable: () => svc.writable !== false,
      }
      return
    }
    // Neither generation detected: the seam stays undefined and every
    // consumer degrades to apply()'s base config — the roster FILE path (the
    // primary storage since 0.3.0) does not depend on the settings service.
  })
  // ── configEditor binding (DSH ≥0.1.7 only) ─────────────────────────────────
  // Its own inject on purpose: ≤0.1.6 hosts have no configEditor service, so
  // this callback never fires there and the legacy seam keeps using its own
  // mutate(). On ≥0.1.7 it hands the editor to the ≥0.1.7 seam for legacy
  // unset / clear-legacy.
  ctx.inject(['settings', 'configEditor'], (ectx: Context) => {
    const editor = (ectx as unknown as Record<string, unknown>).configEditor as ConfigEditorHost | undefined
    if (editor !== undefined) configEditorHost = editor
  })
  /** Library entries restricted to schema-consistent ids: a hand-written key
   *  like `k3_reviewer` passes z.dict (any string key) but can never be
   *  delegated or deleted, so it is filtered out of every view. */
  const filterEntries = (raw: Record<string, Entry> | undefined): Record<string, Entry> =>
    Object.fromEntries(Object.entries(raw ?? {}).filter(([id]) => ENTRY_ID.test(id)))
  const resolveConfig = (): Config => {
    const base = settings?.readConfig() ?? config
    return { ...base, entries: filterEntries(base.entries) }
  }

  // ── directory roster: one-shot idempotent migration + fresh reads ─────────
  // Tests install an in-memory FsPort under `kFsPort` on the Context
  // (SUB-TEST-001: no real disk access); production falls back to node:fs.
  const fsPort = (): FsPort =>
    (ctx as unknown as Record<symbol, unknown>)[kFsPort] as FsPort | undefined ?? nodeFsPort
  let migratedDir: string | undefined
  let migrationFailure: string | undefined
  /** Seed missing files once per directory, retaining the legacy settings.
   * Retry a partial migration on the next maintenance read. */
  const ensureMigrated = async (dir: string, cfg: Config): Promise<void> => {
    const legacy = cfg.entries ?? {}
    if (Object.keys(legacy).length === 0) return
    if (migratedDir === dir) return
    try {
      const result = await migrateLegacyEntries({ dir, legacy, fs: fsPort() })
      if (result.diagnostics.length === 0) {
        migratedDir = dir
        migrationFailure = undefined
      } else {
        migrationFailure = `${result.diagnostics.map((item) => item.message).join('；')}（修复后将自动重试）`
      }
    } catch (error) {
      migrationFailure = `${String(error)}——下次使用名册时自动重试；重启 dsh web 亦可立即重试`
    }
  }
  /** Fresh roster view for every consumer (tools, command, settings API):
   *  no cache — tens of small files read in milliseconds, and the cache layer
   *  is exactly where mtime/case/rename bugs live (v0.3.0 design review). */
  const loadLibrary = async (maintain: boolean, cfg: Config, dir: string): Promise<{ subagentProvider: string, view: RosterView }> => {
    if (settingsFailure !== undefined) throw new Error(settingsFailure)
    if (maintain) await ensureMigrated(dir, cfg)
    const view = await loadRoster({ dir, legacy: cfg.entries, fs: fsPort() })
    if (migrationFailure !== undefined) {
      view.diagnostics.unshift({ severity: 'warning', message: `旧条目自动迁移未完成：${migrationFailure}` })
    }
    return { subagentProvider: cfg.subagentProvider, view }
  }
  /** Launcher-owned profile. Absent hosts keep the shared-file route. An
   *  unsafe name is still a profile — it must not silently write its route
   *  into the shared roster. */
  const currentProfile = ():
    | { kind: 'absent' }
    | { kind: 'ready', name: string }
    | { kind: 'unsafe', name: string, reason: string } => {
    const profile = ctx.get('profileContext') as { name?: unknown } | undefined
    if (profile == null) return { kind: 'absent' }
    const name = profile.name
    if (typeof name !== 'string' || name === '') return { kind: 'unsafe', name: '', reason: '宿主提供的 profile 缺少名称，无法保存该配置的模型设置。' }
    const reason = profilePathProblem(name)
    return reason === undefined ? { kind: 'ready', name } : { kind: 'unsafe', name, reason }
  }
  /** Provider ids registered in THIS process. Undefined when the host has no
   *  `llm` service — a missing list must not be treated as "no providers",
   *  or every shared route would be dropped. */
  const registeredProviderIds = (): ReadonlySet<string> | undefined => {
    const llm = ctx.get('llm') as { listProviders?: () => Array<{ id?: unknown }> } | undefined
    if (typeof llm?.listProviders !== 'function') return undefined
    try {
      const ids = llm.listProviders()
        .map((item) => item?.id)
        .filter((id): id is string => typeof id === 'string' && id !== '')
      return new Set(ids)
    } catch {
      return undefined
    }
  }
  interface EffectiveLibrary {
    groups: Record<string, Group>
    groupDiagnostics: RosterDiagnostic[]
    subagentProvider: string
    /** Shared rows. Writers use this, not `view.entries`, so a hidden foreign
     *  route is not mistaken for an empty route. */
    raw: RosterView
    /** Effective entries for this profile. `hash` includes this profile's overlays. */
    view: RosterView
    profile?: string
    /** Set when the profile name cannot store an overlay directory. */
    profileProblem?: string
    notes: Record<string, RouteNote>
    /** Shared-file provider that this profile refused to call. */
    ignoredProviders: Record<string, string>
    overlayErrors: Record<string, string>
    /** Canonical overlay text keyed by id, for the conflict hash. */
    overlayTexts: Record<string, string>
    /** A mismatched binding on a readable shared file can be removed under the directory lock. */
    staleProfileOverlay?: boolean
    registeredProviders?: readonly string[]
  }
  /** Only the directory lock owner may migrate or clean up overlays. */
  const readEffective = async (maintain: boolean, cfg: Config, dir: string): Promise<EffectiveLibrary> => {
    const lib = await loadLibrary(maintain, cfg, dir)
    const { groups, groupDiagnostics, groupRevision } = await loadGroups(lib.view.dir, fsPort())
    const sharedHash = createHash('sha256').update(JSON.stringify([
      dir, lib.view.hash, lib.view.fileRevision, groupRevision,
    ])).digest('hex').slice(0, 16)
    const state = currentProfile()
    if (state.kind === 'absent') return {
      ...lib, groups, groupDiagnostics, raw: lib.view, view: { ...lib.view, hash: sharedHash },
      notes: {}, ignoredProviders: {}, overlayErrors: {}, overlayTexts: {},
    }
    const registered = registeredProviderIds()
    const notes: Record<string, RouteNote> = Object.create(null)
    const ignoredProviders: Record<string, string> = Object.create(null)
    const overlayErrors: Record<string, string> = Object.create(null)
    const overlayTexts: Record<string, string> = Object.create(null)
    const entries: Record<string, RosterEntry> = Object.create(null)
    const diagnostics = [...lib.view.diagnostics]
    let staleProfileOverlay = false
    if (state.kind === 'unsafe') {
      diagnostics.unshift({
        severity: 'error',
        message: `${state.reason}。本 profile 不会把模型路由写进共享名册；未注册的共享 provider 仍不会被调用。`,
      })
    } else if (maintain) {
      await deleteOrphanOverlays(lib.view.dir, lib.view.listing, lib.view.presentIds, fsPort())
    }
    for (const [id, row] of Object.entries(lib.view.entries)) {
      let overlay = undefined
      if (state.kind === 'ready') {
        const read = await readRouteOverlay(lib.view.dir, state.name, id, fsPort())
        if (!read.ok) {
          notes[id] = 'overlay-broken'
          overlayErrors[id] = read.message
          if (read.text !== undefined) overlayTexts[id] = read.text
          entries[id] = { ...row, entry: stripRoute(row.entry) }
          diagnostics.push({ severity: 'error', id, message: read.message })
          continue
        }
        if (read.overlay !== undefined && read.boundHash !== undefined && read.boundHash !== routeBinding(row.entry)) {
          const readable = row.source === 'file' && !lib.view.diagnostics.some(d => d.id === id && d.severity === 'error')
          if (readable) staleProfileOverlay = true
          if (maintain && readable) await deleteProfileOverlay(lib.view.dir, state.name, id, fsPort())
          else if (read.text !== undefined) overlayTexts[id] = read.text
          diagnostics.push({
            severity: 'warning',
            id,
            message: `profile "${state.name}" 的路由覆盖已失效（共享名册路由已变），已忽略。`,
          })
        } else {
          overlay = read.overlay
          if (read.text !== undefined && read.overlay !== undefined) overlayTexts[id] = read.text
        }
      }
      const resolved = resolveEffectiveEntry(row.entry, overlay, registered)
      notes[id] = resolved.note
      entries[id] = { ...row, entry: resolved.entry }
      if (resolved.note === 'foreign-ignored' && row.entry.provider !== undefined) {
        ignoredProviders[id] = row.entry.provider
      }
    }
    const hash = hashProfileView(sharedHash, state.name, Object.fromEntries(Object.keys(entries).map(id =>
      [id, JSON.stringify([notes[id], overlayTexts[id], overlayErrors[id]])])))
    return {
      groups,
      groupDiagnostics,
      subagentProvider: lib.subagentProvider,
      raw: lib.view,
      view: { ...lib.view, entries, diagnostics, hash },
      ...(state.kind === 'ready' ? { profile: state.name } : { profile: state.name, profileProblem: state.reason }),
      notes,
      ignoredProviders,
      overlayErrors,
      overlayTexts,
      staleProfileOverlay,
      ...(registered === undefined ? {} : { registeredProviders: [...registered] }),
    }
  }
  const loadEffective = async (): Promise<EffectiveLibrary> => {
    const config = resolveConfig()
    const dir = resolveEntriesDir(config.entriesDir)
    const opened = await readEffective(false, config, dir)
    const { listing, presentIds } = opened.raw
    let needsMaintenance = opened.staleProfileOverlay === true
    if (dir !== migratedDir && listing !== 'unreadable') {
      const legacy = Object.keys(config.entries ?? {}).filter(id => !validateEntryId(id))
      if (legacy.length) {
        if (legacy.some(id => !presentIds.has(id)) || migrationFailure !== undefined) needsMaintenance = true
        else migratedDir = dir // Already seeded, including by another host.
      }
    }
    if (!needsMaintenance && opened.profile !== undefined && !opened.profileProblem) {
      needsMaintenance = await hasOrphanOverlays(dir, listing, presentIds, fsPort())
    }
    if (!needsMaintenance) return opened
    // Re-read under the write lock before migrating or removing anything:
    // a concurrent writer can create a role or change its overlay after the probe.
    let unlock
    try { unlock = await lockRoster(dir, fsPort(), 0) } catch { return opened }
    try {
      const latest = resolveConfig()
      return resolveEntriesDir(latest.entriesDir) === dir ? await readEffective(true, latest, dir) : opened
    } finally { await unlock() }
  }
  const routeNoteText = (lib: EffectiveLibrary, id: string): string | undefined => {
    const note = lib.notes[id]
    const profile = lib.profile ?? 'this profile'
    if (note === 'foreign-ignored') {
      return `provider "${lib.ignoredProviders[id] ?? '?'}" is not registered in profile "${profile}"; this call uses the session model`
    }
    if (note === 'profile') return `route is pinned to profile "${profile}"`
    if (note === 'inherit') return `profile "${profile}" inherits the session model`
    if (note === 'profile-missing') {
      return `profile "${profile}" route provider is not registered in this profile`
    }
    if (note === 'overlay-broken') return lib.overlayErrors[id]
    return undefined
  }

  // ── settings page API (own HTTP routes) ────────────────────────────────────
  // The Web gateway only exposes namespaces on its own allowlist
  // (`WEB_SETTINGS_NAMESPACES` / model-provider namespaces in
  // @deepseek-ai/dsh-host-apiproxy), so a third-party plugin's settings
  // section is invisible to the browser through `api.settings.*`. Serve the
  // editor through the plugin's own routes instead, exactly like fish-tts.
  const MAX_BODY_BYTES = 1 << 20

  /** Distinguish "over the size cap" (413) from "not valid JSON" (400). */
  type BodyRead =
    | { ok: true; body: Record<string, unknown> }
    | { ok: false; error: 'too-large' | 'bad-json' }

  const readJsonBody = async (req: IncomingMessage): Promise<BodyRead> => {
    const chunks: Buffer[] = []
    let size = 0
    for await (const chunk of req) {
      const buffer = chunk as Buffer
      size += buffer.length
      if (size > MAX_BODY_BYTES) return { ok: false, error: 'too-large' }
      chunks.push(buffer)
    }
    if (chunks.length === 0) return { ok: true, body: {} }
    try {
      const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      return typeof parsed === 'object' && parsed !== null
        ? { ok: true, body: parsed as Record<string, unknown> }
        : { ok: false, error: 'bad-json' }
    } catch {
      return { ok: false, error: 'bad-json' }
    }
  }

  const sendJson = (res: ServerResponse, status: number, value: unknown): void => {
    const body = JSON.stringify(value)
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': Buffer.byteLength(body),
      'cache-control': 'no-store',
    })
    res.end(body)
  }

  // Cross-origin write protection (same posture as dsh-plugin-fish-tts).
  const guardWrite = (req: IncomingMessage, res: ServerResponse): boolean => {
    const contentType = (req.headers['content-type'] ?? '').split(';')[0]?.trim().toLowerCase()
    if (contentType !== 'application/json') {
      sendJson(res, 415, { ok: false, error: 'content-type-json-required' })
      return false
    }
    const origin = req.headers.origin
    if (origin !== undefined) {
      let originHost = ''
      try {
        originHost = new URL(origin).host
      } catch {
        originHost = ''
      }
      const hostHeader = req.headers.host ?? ''
      const sameOrigin = originHost !== '' && originHost === hostHeader
      const loopback = originHost.startsWith('127.0.0.1:')
        || originHost.startsWith('localhost:')
        || originHost.startsWith('[::1]:')
      if (!sameOrigin && !loopback) {
        sendJson(res, 403, { ok: false, error: 'cross-origin-forbidden' })
        return false
      }
    }
    return true
  }

  /** Wire shape of one roster row for the settings editor: the stored entry
   *  plus the enabled flag when false and a `source` marker for legacy rows. */
  const availability = (reason: string | undefined) => reason ? { launchable: false, reason } : { launchable: true }

  /** Legacy settings entries currently shadowed by a roster file — the safe
   *  one-click cleanup set for the 0.2→0.3 transition (a legacy row WITHOUT a
   *  file is still serving and must survive). */
  const legacyShadowedIds = (view: RosterView): string[] => {
    const raw = settings?.legacyUserEntries()
    if (raw === undefined) return []
    return Object.keys(raw).filter((id) => ENTRY_ID.test(id) && view.entries[id]?.source === 'file')
  }

  const profileRouteWarnings = (lib: EffectiveLibrary): Array<{ severity: 'warning', id: string, message: string }> => {
    if (lib.profile === undefined) return []
    return Object.entries(lib.ignoredProviders).map(([id, provider]) => ({
      severity: 'warning' as const,
      id,
      message: `共享名册路由 provider "${provider}" 未在当前 profile "${lib.profile}" 注册，调用将改用本会话模型。在此填写的 Provider/模型只保存到这个 profile。`,
    }))
  }
  const wireView = (
    lib: EffectiveLibrary,
    legacySkipWarning = false,
    extraWarnings: string[] = [],
  ): Record<string, unknown> => {
    const reasons = new Map<string, string | undefined>()
    const reasonFor = (id: string) => {
      if (!reasons.has(id)) reasons.set(id, roleUnavailable(ctx, lib, id))
      return reasons.get(id)
    }
    const opWarnings = extraWarnings.map((message) => ({ severity: 'warning' as const, message }))
    const diagnostics = [
      ...opWarnings,
      ...(legacySkipWarning
        ? [{ severity: 'warning' as const, message: '设置服务只读：settings 中的旧副本未能同步移除，被删条目可能以旧副本复活' }]
        : []),
      ...profileRouteWarnings(lib),
      ...lib.view.diagnostics,
      ...lib.groupDiagnostics,
    ]
    return {
      ok: true,
      writable: true,
      dir: lib.view.dir,
      hash: lib.view.hash,
      ...(lib.profile !== undefined ? { profile: lib.profile } : {}),
      ...(lib.profileProblem && { routeWriteProblem: lib.profileProblem }),
      entries: Object.fromEntries(Object.entries(lib.view.entries).map(([id, row]) => [id, {
        ...row.entry,
        ...(row.enabled ? {} : { enabled: false }),
        ...(row.source === 'legacy' && { source: 'legacy' }),
        ...(lib.notes[id] && lib.notes[id] !== 'shared' && { routeNote: lib.notes[id] }),
        ...availability(reasonFor(id)),
      }])),
      sharedEntries: Object.fromEntries(Object.entries(lib.raw.entries).map(([id, row]) => [id, {
        ...row.entry, ...(row.enabled ? {} : { enabled: false }),
      }])),
      groups: Object.fromEntries(Object.entries(lib.groups).map(([id, group]) => [id, {
        ...group,
        members: group.members.map(member => ({
          ...member, ...availability(group.enabled === false ? `编队 "${id}" 已停用` : reasonFor(member.role)),
        })),
      }])),
      groupDiagnostics: lib.groupDiagnostics,
      roleUsages: roleUsages(lib.groups),
      diagnostics,
      legacyCount: legacyShadowedIds(lib.view).length,
    }
  }

  ctx.inject(['webServer'], (wctx: Context) => {
    const web = wctx.webServer
    /** Best-effort removal of legacy-only settings entries (the file half is
     *  already gone). No expectedRevision: last-write-wins — a racing settings
     *  writer must not fail a delete that mostly succeeded. Returns whether
     *  the unset actually ran, so a read-only settings service can be surfaced
     *  instead of a silent false success (red team A7 / k3 #4). */
    const unsetLegacy = async (ids: string[]): Promise<'done' | 'skipped-readonly' | 'no-settings'> => {
      if (ids.length === 0) return 'done'
      return settings?.unsetEntries(ids) ?? 'no-settings'
    }
    class WriteProblem extends Error {
      constructor(readonly status: number, readonly code: string, message: string, readonly details: Record<string, unknown> = {}) {
        super(message)
      }
    }

    const applyWrite = async (body: Record<string, unknown>, opened: EffectiveLibrary) => {
      const current = opened.raw
      const fs = fsPort()
      const op = body.op
      const id = typeof body.id === 'string' ? body.id : ''
      const warnings: string[] = []
      const unreadable = (diagnostics: RosterDiagnostic[]) => new WriteProblem(503, 'references-unreadable',
        '引用或角色无法完整读取，请修复后重试。', { diagnostics })
      const checkDeletion = (ids: string[]) => {
        if (!ids.length) return
        if (opened.groupDiagnostics.length) throw unreadable(opened.groupDiagnostics)
        const usages = roleUsages(opened.groups)
        const references = ids.flatMap(roleId => (usages[roleId] ?? []).map(ref => ids.length === 1 ? ref : { roleId, ...ref }))
        if (references.length) throw new WriteProblem(409, 'role-in-use', '有编队成员还在使用这个角色。请先给他们换个角色，或将他们移出编队。', { references })
      }
      const readErrors = (role: string) => current.unreadableIds.has(role)
        ? current.diagnostics.filter(d => d.id === role && d.severity !== 'info') : []
      const deleteRoles = async (ids: string[]) => {
        for (const role of ids) {
          await deleteEntryFile(current.dir, role, fs)
          await deleteRouteOverlays(current.dir, role, fs)
        }
        return await unsetLegacy(ids) === 'skipped-readonly'
      }

      if (op === 'clear-legacy') {
        if (settings && !settings.isWritable()) throw new WriteProblem(403, 'readonly', '设置服务只读，无法清除旧副本')
        await unsetLegacy(legacyShadowedIds(current))
        return {}
      }
      if (op !== 'save' && op !== 'delete' && op !== 'save-entry' && op !== 'save-group' && op !== 'delete-group') {
        throw new WriteProblem(400, 'unknown-op', '未知的保存操作')
      }
      const invalidId = op === 'save' ? undefined : validateEntryId(id)
      if (invalidId) throw new WriteProblem(400, 'invalid-id', invalidId)
      if (op === 'save-group' || op === 'delete-group') {
        if (opened.groupDiagnostics.some(d => !d.id)) throw unreadable(opened.groupDiagnostics)
        const groupProblems = opened.groupDiagnostics.filter(d => d.id === id)
        if (op === 'save-group' && groupProblems.length) throw unreadable(groupProblems)
        if (groupProblems.some(d => d.file !== `_groups/${id}.yaml` && d.file !== `_groups/${id}.yml`)) throw unreadable(groupProblems)
        if (op === 'delete-group') {
          await deleteGroup(current.dir, id, fs)
          return {}
        }
        let group: Group
        try { group = parseGroup(body.group, true) }
        catch (error) { throw new WriteProblem(400, 'invalid-group', String(error)) }
        const oldMembers = new Map(opened.groups[id]?.members.map(m => [m.slot, m.role]))
        for (const { role, slot } of group.members) {
          if (oldMembers.get(slot) === role) continue
          if (current.listing === 'unreadable') throw unreadable(current.diagnostics)
          const problems = current.diagnostics.filter(d => d.id === role && d.severity === 'error')
          if (!problems.length) problems.push(...readErrors(role))
          if (problems.length) throw unreadable(problems)
          if (!current.entries[role]) throw new WriteProblem(400, 'invalid-reference', `成员 "${slot}" 使用的角色 "${role}" 不在名册里`, { slot, role })
        }
        if (!isDeepStrictEqual(group, opened.groups[id])) await writeGroup(current.dir, id, group, fs)
        return {}
      }
      if (current.listing === 'unreadable') throw unreadable(current.diagnostics)
      if (op === 'delete') {
        checkDeletion([id])
        return { skipped: await deleteRoles([id]) }
      }

      const single = op === 'save-entry'
      const candidate = single ? { [id]: body.entry } : body.entries
      if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
        throw new WriteProblem(400, 'entries-object-required', 'entries 需要对象')
      }
      const documents = new Map<string, ReturnType<typeof parseEntryDocument>>()
      let route: RouteOverlay | undefined
      if (single && body.route !== undefined) {
        if (opened.profileProblem) throw new WriteProblem(400, 'profile-path', opened.profileProblem)
        try { route = parseRouteOverlay(body.route) }
        catch (error) { throw new WriteProblem(400, 'invalid-route', String(error)) }
      }
      if (single && body.clearToolFilter !== undefined && typeof body.clearToolFilter !== 'boolean') {
        throw new WriteProblem(400, 'rejected', 'clearToolFilter 需要布尔值')
      }
      const deletedIds = single ? [] : Object.keys(current.entries).filter(role => !Object.hasOwn(candidate, role))
      checkDeletion(deletedIds)
      // A legacy snapshot can't distinguish a broken file from an intentionally omitted role.
      if (!single) {
        const damaged = [...current.unreadableIds].flatMap(readErrors)
        if (damaged.length) throw unreadable(damaged)
        if (deletedIds.some(role => current.entries[role].entry.toolFilter !== undefined)) {
          throw new WriteProblem(409, 'tool-filter-protected', '请在角色行显式删除带有工具限制的角色。')
        }
      }
      for (const [role, value] of Object.entries(candidate)) {
        const invalid = validateEntryId(role)
        if (invalid) throw new WriteProblem(400, 'invalid-entry-id', invalid)
        const problems = readErrors(role)
        if (problems.length) throw unreadable(problems)
        if (!value || typeof value !== 'object' || Array.isArray(value)) throw new WriteProblem(400, 'rejected', '条目需要对象')
        const payload = { ...value } as Record<string, unknown>
        for (const key of ['source', 'routeNote', 'launchable', 'reason']) delete payload[key]
        const previous = current.entries[role]?.entry
        if (previous?.backgroundMode && !Object.hasOwn(payload, 'backgroundMode')) payload.backgroundMode = previous.backgroundMode
        if (single && body.clearToolFilter === true) delete payload.toolFilter
        else if (single && previous?.toolFilter !== undefined && !Object.hasOwn(payload, 'toolFilter')) payload.toolFilter = previous.toolFilter
        let parsed: ReturnType<typeof parseEntryDocument>
        try { parsed = parseEntryDocument(payload) }
        catch (error) { throw new WriteProblem(400, 'rejected', `条目 "${role}"：${String(error)}`) }
        if (previous?.toolFilter !== undefined && !(single && body.clearToolFilter === true)
          && !isDeepStrictEqual(previous.toolFilter, parsed.entry.toolFilter)) {
          throw new WriteProblem(409, 'tool-filter-protected', `角色 "${role}" 的工具限制需要单独确认移除。`)
        }
        if (!single && opened.profileProblem
          && !sameRoute(pickRoute(parsed.entry), pickRoute(opened.view.entries[role]?.entry ?? {}))) {
          throw new WriteProblem(400, 'profile-path', opened.profileProblem)
        }
        documents.set(role, parsed)
      }
      for (const [role, doc] of documents) {
        const prev = current.entries[role]
        // A single-entry save carries route edits separately from role identity.
        // Only a host without a profile applies an explicit route to the shared file.
        let shared = single || opened.profile !== undefined ? preserveSharedRoute(doc.entry, prev?.entry) : doc.entry
        if (!opened.profile && route !== undefined) {
          shared = 'inherit' in route ? stripRoute(doc.entry) : withRoute(doc.entry, route)
        }
        if (prev?.source === 'file' && prev.file === entryFileName(role)
          && serializeEntry(prev.entry, prev.enabled) === serializeEntry(shared, doc.enabled)) {
          try { await removeYmlSibling(current.dir, role, fs) }
          catch (error) { warnings.push(`条目 "${role}" 的同名 .yml 残留清除失败：${String(error)}`) }
        } else {
          await writeEntryFile({ dir: current.dir, id: role, entry: shared, enabled: doc.enabled, fs })
        }
        if (doc.entry.toolFilter !== undefined) warnings.push(`条目 "${role}" 带 toolFilter，当前宿主无法强制执行逐条目工具过滤。`)
        if (opened.profile && !opened.profileProblem) {
          if (single && route !== undefined) {
            await writeRouteOverlay(current.dir, opened.profile, role, route, fs, undefined, routeBinding(shared))
          } else if (!single) {
            await syncProfileRoute({ dir: current.dir, profile: opened.profile, id: role, client: doc.entry,
              shown: opened.view.entries[role]?.entry ?? { description: doc.entry.description }, shared, fs })
          }
        }
      }
      return { skipped: await deleteRoles(deletedIds), warnings }
    }

    wctx.effect(() => web.register({
      kind: 'exact',
      path: '/subagent-library/api',
      handler: async (req: IncomingMessage, res: ServerResponse) => {
        if (req.method === 'GET') {
          if (settingsFailure !== undefined) {
            sendJson(res, 503, { ok: false, error: 'not-ready', message: settingsFailure })
            return
          }
          try {
            sendJson(res, 200, wireView(await loadEffective()))
          } catch (error) {
            sendJson(res, 500, { ok: false, error: 'roster-unreadable', message: String(error) })
          }
          return
        }
        if (req.method !== 'POST') {
          sendJson(res, 405, { ok: false, error: 'method-not-allowed' })
          return
        }
        if (!guardWrite(req, res)) return
        if (settingsFailure !== undefined) {
          sendJson(res, 503, { ok: false, error: 'not-ready', message: settingsFailure })
          return
        }
        const read = await readJsonBody(req)
        if (!read.ok) {
          if (read.error === 'too-large') {
            sendJson(res, 413, { ok: false, error: 'body-too-large' })
          } else {
            sendJson(res, 400, { ok: false, error: 'bad-json' })
          }
          return
        }
        const body = read.body
        const expectedHash = typeof body.expectedHash === 'string' ? body.expectedHash : undefined
        if (['save-entry', 'save-group', 'delete-group'].includes(String(body.op)) && !expectedHash) {
          sendJson(res, 400, { ok: false, error: 'expected-hash-required' })
          return
        }
        let response: Record<string, unknown>
        let status = 200
        const config = { ...resolveConfig() }
        const dir = resolveEntriesDir(config.entriesDir)
        // A settings write may replace the legacy section. Refresh it only for this locked directory.
        const latestConfig = () => {
          const latest = resolveConfig()
          return resolveEntriesDir(latest.entriesDir) === dir ? latest : config
        }
        try {
          const unlock = await lockRoster(dir, fsPort())
          try {
            const opened = await readEffective(body.op === 'clear-legacy' && expectedHash === undefined, latestConfig(), dir)
            if (expectedHash !== undefined && expectedHash !== opened.view.hash) {
              throw new WriteProblem(409, 'conflict', '名册已变更，请核对最新内容。')
            }
            const result = await applyWrite(body, opened)
            response = wireView(await readEffective(true, latestConfig(), dir), result.skipped, result.warnings)
          } finally {
            await unlock()
          }
        } catch (error) {
          const busy = (error as NodeJS.ErrnoException).code === 'ROSTER_BUSY'
          status = error instanceof WriteProblem ? error.status : busy ? 503 : 500
          const code = error instanceof WriteProblem ? error.code : busy ? 'roster-busy' : 'write-failed'
          const view = await readEffective(false, latestConfig(), dir).then(wireView).catch(() => undefined)
          response = { ok: false, error: code, message: String(error), ...(error instanceof WriteProblem && error.details), view }
        }
        sendJson(res, status, response)
      },
    }), 'subagent-library: settings api route')
  })

  registerLibraryTools(ctx, loadEffective, routeNoteText, () => settingsFailure)
}
