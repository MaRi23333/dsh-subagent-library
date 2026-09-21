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
}

export function makeSettings(options: SettingsOptions = {}): MockSettings {
  let ns: unknown
  let value: SectionLike = {}
  let user: SectionLike | undefined = options.user
  let revision = 0
  const writable = options.writable ?? true

  const effective = (): SectionLike => ({
    ...value,
    ...(user ?? {}),
    entries: user?.entries ?? value.entries ?? {},
  })
  const checkConflict = (expectedRevision?: number): void => {
    if (expectedRevision !== undefined && expectedRevision !== revision) {
      throw Object.assign(new Error(`settings conflict: expected revision ${expectedRevision}, current ${revision}`), {
        code: 'SETTINGS_CONFLICT',
      })
    }
  }

  return {
    get writable() { return writable },
    register(registeredNs, _schema, registerOptions) {
      if (options.failRegister === true) {
        throw new Error('SettingsError: subagent-library.entries.bad_key: description is required (fake stored-section failure)')
      }
      ns = registeredNs
      if (registerOptions?.base !== undefined) value = registerOptions.base
      return { get: () => effective(), watch: () => {} }
    },
    describe() {
      return [{ ns, user, value, revision }]
    },
    replace(_ns, doc, expectedRevision) {
      checkConflict(expectedRevision)
      user = doc
      revision += 1
      return Promise.resolve()
    },
    mutate(_ns, ops, expectedRevision) {
      checkConflict(expectedRevision)
      const base = effective()
      const next: SectionLike = { ...base, entries: { ...(base.entries ?? {}) } }
      for (const op of ops) {
        if (op.op === 'unset' && op.path[0] === 'entries' && typeof op.path[1] === 'string') {
          delete next.entries?.[op.path[1]]
        }
      }
      user = next
      revision += 1
      return Promise.resolve()
    },
    userSection: () => user,
    revision: () => revision,
  }
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
  let settingsCb: ((sctx: unknown) => void) | undefined
  const fs = makeMemFs(options.rosterFiles)

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
        settingsCb = cb
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

  apply(ctx as never, {
    subagentProvider: 'spawn',
    entries: options.baseEntries ?? {},
    entriesDir: options.rosterDir ?? '/roster',
  })
  if (settingsCb === undefined) throw new Error('apply() did not register a settings inject callback')
  settingsCb({ settings, effect: (fn: () => unknown) => fn() })

  return { web, tools, settings, subagentStarts, toolViewScopes, fs }
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
