/**
 * Minimal doubles for exercising the plugin host (apply) end-to-end without a
 * real harness: a webServer stub capturing the registered route, an in-memory
 * settings service implementing exactly the slices apply() consumes
 * (register / describe / replace / mutate / writable), a tool registry, and
 * IncomingMessage/ServerResponse stand-ins.
 *
 * SUB-TEST-001 constraint: no real credentials, files, env or network — every
 * value below is fabricated, and the doubles fail closed (unknown tool names
 * resolve to undefined, unseeded services are absent).
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { apply, type Entry } from '../src/index.ts'
import { kFsPort, type FsPort } from '../src/roster.ts'

export interface RouteSpec {
  kind: string
  path: string
  handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
}

export interface MockWeb {
  routes: Map<string, RouteSpec>
  register: (spec: RouteSpec) => void
}

export function makeWeb(): MockWeb {
  const routes = new Map<string, RouteSpec>()
  return {
    routes,
    register(spec: RouteSpec): void {
      routes.set(spec.path, spec)
    },
  }
}

interface SectionLike {
  entries?: Record<string, Entry>
  [key: string]: unknown
}

export interface MockSettings {
  writable: boolean
  register: (ns: unknown, schema: unknown, options?: { base?: SectionLike }) => { get: () => SectionLike; watch: (cb: () => void) => void }
  describe: () => Array<{ ns: unknown; user: SectionLike | undefined; value: SectionLike; revision: number }>
  replace: (ns: unknown, doc: SectionLike, expectedRevision?: number) => Promise<void>
  mutate: (ns: unknown, ops: Array<{ op: string; path: string[] }>, expectedRevision?: number) => Promise<void>
  /** Test inspection: the current raw user layer (what replace/mutate wrote). */
  userSection: () => SectionLike | undefined
  revision: () => number
}

export interface SettingsOptions {
  /** Pre-seeded user layer (e.g. `{ subagentProvider: 'fork', entries: {...} }`). */
  user?: SectionLike
  writable?: boolean
  /** Simulate a stored section that fails schema validation at register time. */
  failRegister?: boolean
  /**
   * `legacy` (default) = DSH ≤0.1.6 SettingsProvider with register();
   * `forms` = DSH ≥0.1.7 profile-backed SettingsForms (describe/mutate).
   */
  settingsShape?: 'legacy' | 'forms'
}

/** DSH ≥0.1.7 double: SettingsForms (writable flag only — the plugin must NOT
 *  use describe/mutate on this generation) plus the `ctx.configEditor` the
 *  plugin is expected to use for ordinary profile-config edits. The patch
 *  layer for entry `subagent-library` tracks legacy `entries`. The rows use
 *  the REAL cordis Loader Entry shape (id at `options.id`) so a shape mistake
 *  in the plugin cannot hide behind the mock (red team re-verification #1). */
export interface MockFormsSettings {
  writable: boolean
  configEditor: {
    entries(): Array<{ options: { id: string } }>
    edit(
      entry: unknown,
      change: (current: Record<string, unknown>, inherited: Record<string, unknown>) => Record<string, unknown>,
    ): Promise<void>
  }
  /** Current legacy `entries` in the profile patch (what unsetLegacy clears). */
  userEntries: () => Record<string, Entry>
  revision: () => number
}

export function makeFormsSettings(
  options: SettingsOptions,
  rosterDir: string,
  /** The apply()-arg config object — mutated in place by edit(), mirroring
   *  the real Loader reconciliation so the plugin's `config` closure stays
   *  current without a restart. */
  configRef: Config,
): MockFormsSettings {
  let revision = 41
  const entry = { options: { id: 'subagent-library' } }
  // SINGLE source of truth = configRef (the plugin's own closure): current()
  // and userEntries() MUST read the same store, or the change() callback sees
  // a pre-edit snapshot forever (k3 audit: dual data sources masked the
  // options.id blocker).
  const current = (): Record<string, unknown> => ({
    subagentProvider: 'spawn',
    entriesDir: rosterDir,
    entries: { ...((configRef['entries'] ?? {}) as Record<string, Entry>) },
  })
  return {
    writable: options.writable ?? true,
    configEditor: {
      entries: () => [entry],
      async edit(_entryTarget, change) {
        const next = change(current(), {})
        if (next === undefined) throw new Error('configEditor change must return an object (host contract)')
        // Loader reconciliation semantics: the entry's live config becomes
        // exactly `next` — keys dropped from `next` disappear from the config.
        for (const key of Object.keys(configRef)) {
          if (!(key in next)) delete configRef[key]
        }
        Object.assign(configRef, next)
        revision += 1
      },
    },
    userEntries: () => {
      const entries = configRef['entries']
      return typeof entries === 'object' && entries !== null
        ? { ...(entries as Record<string, Entry>) }
        : {}
    },
    revision: () => revision,
  }
}

/** THIS-DEPENDENT on purpose: the real SettingsProvider.describe() reads
 *  instance state, so a DETACHED alias call (`const d = svc.describe; d()`)
 *  throws — the plugin must always invoke it as a method with the receiver
 *  intact (SUB-COMPAT-017-001: a detached call was swallowed by a try/catch
 *  and falsely reported legacyCount=0 while clear-legacy claimed success). */
class MockSettingsImpl implements MockSettings {
  private regNs: unknown
  private baseValue: SectionLike = {}
  user?: SectionLike
  private rev = 0
  readonly writable: boolean
  private readonly opts: SettingsOptions

  constructor(options: SettingsOptions) {
    this.opts = options
    this.writable = options.writable ?? true
    this.user = options.user
  }

  private effective(): SectionLike {
    return {
      ...this.baseValue,
      ...(this.user ?? {}),
      entries: this.user?.entries ?? this.baseValue.entries ?? {},
    }
  }

  register(registeredNs: unknown, _schema: unknown, registerOptions?: { base?: SectionLike }): { get(): SectionLike; watch(): void } {
    if (this.opts.failRegister === true) {
      throw new Error('SettingsError: subagent-library.entries.bad_key: description is required (fake stored-section failure)')
    }
    this.regNs = registeredNs
    if (registerOptions?.base !== undefined) this.baseValue = registerOptions.base
    return { get: () => this.effective(), watch: () => {} }
  }

  describe(): Array<{ ns: unknown; user: SectionLike | undefined; value: SectionLike; revision: number }> {
    return [{ ns: this.regNs, user: this.user, value: this.baseValue, revision: this.rev }]
  }

  async replace(_ns: unknown, doc: SectionLike, expectedRevision?: number): Promise<void> {
    if (expectedRevision !== undefined && expectedRevision !== this.rev) {
      throw Object.assign(new Error(`settings conflict: expected revision ${expectedRevision}, current ${this.rev}`), { code: 'SETTINGS_CONFLICT' })
    }
    this.user = doc
    this.rev += 1
  }

  async mutate(_ns: unknown, ops: Array<{ op: string; path: string[] }>, expectedRevision?: number): Promise<void> {
    if (expectedRevision !== undefined && expectedRevision !== this.rev) {
      throw Object.assign(new Error(`settings conflict: expected revision ${expectedRevision}, current ${this.rev}`), { code: 'SETTINGS_CONFLICT' })
    }
    const base = this.effective()
    const next: SectionLike = { ...base, entries: { ...(base.entries ?? {}) } }
    for (const op of ops) {
      if (op.op === 'unset' && op.path[0] === 'entries' && typeof op.path[1] === 'string') {
        delete next.entries?.[op.path[1]]
      }
    }
    this.user = next
    this.rev += 1
  }

  userSection(): SectionLike | undefined {
    return this.user
  }

  currentRevision(): number {
    return this.rev
  }
}

export function makeSettings(options: SettingsOptions = {}): MockSettings {
  return new MockSettingsImpl(options)
}

export interface HostOptions extends SettingsOptions {
  /** Entries baked into the plugin base config (the `value` layer). */
  baseEntries?: Record<string, Entry>
  /** Roster directory passed as `entriesDir` (fake path, resolved by MemFs). */
  rosterDir?: string
  /** Files the in-memory roster directory starts with (`/roster/reader.yaml` → YAML). */
  rosterFiles?: Record<string, string>
  /** Tool names the fake registry knows (visible in a scope view). */
  knownTools?: string[]
  /**
   * Names `restrict()` would admit (global + inherited). Defaults to
   * `knownTools`; set it narrower to model scope-local tools — visible to the
   * agent but NOT restrictable (the official `subagent` tool in DSH 0.1.2-rc.1).
   */
  restrictableTools?: string[]
  /** Omit `tools.view()` to exercise the visibility fallback path. */
  noToolView?: boolean
  /** Subagent transport providers the fake registry knows (default: none). */
  subagentProviders?: string[]
}

export interface MockHost {
  web: MockWeb
  tools: Map<string, { name: string; execute: (args: never, exec: never) => Promise<unknown> }>
  settings: MockSettings
  /** Every `subagents.start(provider, request)` the plugin performed. */
  subagentStarts: Array<{ provider: string, request: Record<string, unknown> }>
  /** Every scope passed to `tools.view(scope)` — must be the Agent object. */
  toolViewScopes: unknown[]
  /** The in-memory FsPort the plugin was given (assert files written here). */
  fs: MemFs
  /** DSH ≥0.1.7 SettingsForms double — populated and used when the host is
   *  created with `settingsShape: 'forms'`. */
  forms: MockFormsSettings
}

const enoent = (): Error => Object.assign(new Error('ENOENT (memfs)'), { code: 'ENOENT' })

/** In-memory FsPort: the roster loader/writer runs entirely against this map,
 *  so tests never touch the real filesystem (SUB-TEST-001). Paths are exact
 *  string keys; a directory "exists" once it has entries or was mkdir'ed. */
export interface MemFs extends FsPort {
  /** Snapshot of every stored file (full path → content). */
  files: () => Record<string, string>
}

export function makeMemFs(initial: Record<string, string> = {}): MemFs {
  // Keys are ALWAYS stored normalized (backslashes → slashes): the production
  // code joins paths with node:path, which on Windows yields `\roster\x.yaml`
  // while tests write `/roster/x.yaml`.
  const normalize = (value: string): string => value.replaceAll('\\', '/')
  const files = new Map<string, string>(
    Object.entries(initial).map(([key, value]) => [normalize(key), value]),
  )
  const dirs = new Set<string>()
  const parentOf = (value: string): string => {
    const cut = value.lastIndexOf('/')
    return cut <= 0 ? '/' : value.slice(0, cut)
  }
  return {
    async readdir(dir) {
      const normalized = normalize(dir)
      const names = [...files.keys()]
        .filter((path) => parentOf(path) === normalized)
        .map((path) => path.slice(normalized.length + 1))
      if (names.length === 0 && !dirs.has(normalized)) throw enoent()
      return names
    },
    async readFile(path) {
      const value = files.get(normalize(path))
      if (value === undefined) throw enoent()
      return Buffer.from(value, 'utf8')
    },
    async writeFile(path, data) {
      files.set(normalize(path), data)
    },
    async rename(from, to) {
      const value = files.get(normalize(from))
      if (value === undefined) throw enoent()
      files.set(normalize(to), value)
      files.delete(normalize(from))
    },
    async unlink(path) {
      if (!files.delete(normalize(path))) throw enoent()
    },
    async mkdir(dir, _options) {
      let current = normalize(dir)
      const seen: string[] = []
      while (current !== '' && current !== '/' && !dirs.has(current)) {
        seen.push(current)
        const cut = current.lastIndexOf('/')
        current = cut <= 0 ? '/' : current.slice(0, cut)
      }
      for (const item of seen.reverse()) dirs.add(item)
    },
    files: () => Object.fromEntries(files),
  }
}

/**
 * Wire apply() against doubles. The settings inject callback fires immediately
 * (mirroring a harness where the settings service is already up); the
 * webServer inject registers the route synchronously through effect().
 */
export function makeHost(options: HostOptions = {}): MockHost {
  const web = makeWeb()
  const tools: MockHost['tools'] = new Map()
  const knownTools = new Set(options.knownTools ?? [])
  const restrictableTools = new Set(options.restrictableTools ?? options.knownTools ?? [])
  const settings = makeSettings(options)
  const subagentStarts: MockHost['subagentStarts'] = []
  const toolViewScopes: MockHost['toolViewScopes'] = []
  /** The plugin registers TWO settings injects on ≥0.1.7 (seam +
   *  configEditor binding); the mock must fire ALL of them. */
  const settingsCbs: Array<(sctx: unknown) => void> = []
  const fs = makeMemFs(options.rosterFiles)
  const applyConfig: Config = {
    subagentProvider: 'spawn',
    entries: options.baseEntries ?? {},
    entriesDir: options.rosterDir ?? '/roster',
  }
  const forms = makeFormsSettings(options, options.rosterDir ?? '/roster', applyConfig)

  const providerNames = options.subagentProviders ?? []
  const providers = new Map(providerNames.map((providerName) => [providerName, {
    capabilities: { depthLimit: true, persona: true, toolFilter: true },
    start: (name: string, request: Record<string, unknown>) => {
      subagentStarts.push({ provider: name, request })
      return {
        id: 'fake-run',
        result: Promise.resolve({ stopReason: 'completed', output: [{ type: 'text', text: 'fake child reply' }] }),
        dispose: () => Promise.resolve(),
      }
    },
  }]))

  const ctx = {
    inject(deps: string[], cb: (ictx: unknown) => void): void {
      if (deps.includes('settings')) {
        settingsCbs.push(cb)
        return
      }
      if (deps.includes('webServer')) {
        cb({ webServer: web, effect: (fn: () => unknown) => fn() })
      }
    },
    tools: {
      register: (tool: { name: string; execute: (args: never, exec: never) => Promise<unknown> }) => {
        tools.set(tool.name, tool)
      },
      // Visible catalog: tests only need "this name is visible / not visible".
      get: (name: string, _scope?: unknown) => (knownTools.has(name) ? { name } : undefined),
      // restrictableNames: the set restrict() admits for a scope.
      ...(options.noToolView === true
        ? {}
        : {
            view: (scope?: unknown) => {
              toolViewScopes.push(scope)
              return { restrictableNames: restrictableTools }
            },
          }),
    },
    systemPrompt: { section: () => {} },
    subagents: {
      getProvider: (name: string) => providers.get(name),
      list: () => providerNames,
      // Service-level entry point: the plugin calls ctx.subagents.start(name, request).
      start: (name: string, request: Record<string, unknown>) => {
        const provider = providers.get(name)
        if (provider === undefined) throw new Error(`fake subagents: no provider "${name}"`)
        return provider.start(name, request)
      },
    },
    get: () => undefined,
  }
  // SUB-TEST-001: the plugin must never touch the real disk — the FsPort is
  // injected BEFORE apply() so every roster read/write lands in memory.
  ;(ctx as unknown as Record<symbol, unknown>)[kFsPort] = fs

  apply(ctx as never, applyConfig)
  if (settingsCbs.length === 0) throw new Error('apply() did not register a settings inject callback')
  // 'forms' mimics DSH ≥0.1.7 (SettingsForms + ctx.configEditor, no
  // register()) — the plugin must detect the generation structurally and
  // route ordinary config edits through configEditor. Fire ALL registered
  // settings injects (the plugin has two on ≥0.1.7: seam + editor binding).
  const sctxFor = options.settingsShape === 'forms'
    ? { settings: forms, configEditor: forms.configEditor, effect: (fn: () => unknown) => fn() }
    : { settings, effect: (fn: () => unknown) => fn() }
  for (const cb of settingsCbs) cb(sctxFor)

  return { web, tools, settings, forms, subagentStarts, toolViewScopes, fs }
}

export interface ReqOptions {
  method?: string
  headers?: Record<string, string | undefined>
  body?: string | Buffer
}

export function makeReq(options: ReqOptions = {}): IncomingMessage {
  const { method = 'GET', headers = {}, body = '' } = options
  const req = { method, headers } as IncomingMessage
  const buffer = Buffer.isBuffer(body) ? body : Buffer.from(body)
  ;(req as unknown as { [Symbol.asyncIterator]: () => AsyncIterator<Buffer> })[Symbol.asyncIterator] =
    async function* (): AsyncGenerator<Buffer> {
      if (buffer.length > 0) yield buffer
    }
  return req
}

export interface MockRes {
  status: number
  headers: Record<string, string | number>
  body: string
  writeHead: (status: number, headers: Record<string, string | number>) => void
  end: (body?: unknown) => void
}

export function makeRes(): MockRes {
  let headersSent = false
  const record: MockRes = {
    status: 200,
    headers: {},
    body: '',
    writeHead(status, headers) {
      // Mirror the real http.ServerResponse: a handler that answers twice
      // must fail loudly instead of silently overwriting the first response.
      if (headersSent) throw new Error('ERR_HTTP_HEADERS_SENT: sendJson called twice on one response')
      headersSent = true
      record.status = status
      record.headers = headers
    },
    end(body?: unknown) {
      record.body = typeof body === 'string' ? body : (body as Buffer | undefined)?.toString('utf8') ?? ''
    },
  }
  return record
}

export function jsonBody(res: MockRes): Record<string, unknown> {
  return JSON.parse(res.body) as Record<string, unknown>
}

const API_PATH = '/subagent-library/api'
const JSON_HEADERS = { 'content-type': 'application/json', host: '127.0.0.1:3080' }

/** POST a JSON payload through the mounted route with the guard-satisfying headers. */
export function postJson(
  web: MockWeb,
  payload: unknown,
  headerOverrides: Record<string, string | undefined> = {},
): Promise<MockRes> {
  return dispatch(web, API_PATH, {
    method: 'POST',
    headers: { ...JSON_HEADERS, ...headerOverrides },
    body: typeof payload === 'string' || Buffer.isBuffer(payload) ? payload : JSON.stringify(payload),
  })
}

export async function dispatch(
  web: MockWeb,
  path: string,
  reqOptions: ReqOptions = {},
): Promise<MockRes> {
  const spec = web.routes.get(path)
  if (spec === undefined) throw new Error(`route not mounted: ${path}`)
  const req = makeReq(reqOptions)
  const res = makeRes()
  await spec.handler(req, res as ServerResponse)
  return res
}

export { API_PATH, JSON_HEADERS }
