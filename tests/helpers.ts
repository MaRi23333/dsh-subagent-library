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
  /** Tool names the fake registry knows; anything else resolves to undefined. */
  knownTools?: string[]
  /**
   * Fake live agents, each with the tool names visible in its scoped view.
   * Mirrors the real harness: per-agent (agent-plane) tools like write/edit
   * live on the agent ctx, not the global layer. Defaults to one agent with
   * the standard agent-plane tool set.
   */
  agents?: Array<{ tools?: string[] }>
  /** Simulate a host with no live agent to probe (save defers to delegate-time validation). */
  noAgents?: boolean
}

/** The standard agent-plane tool names an agent preset composes for itself. */
export const AGENT_PLANE_TOOLS = [
  'write', 'edit', 'todo_write', 'create_goal', 'update_goal',
  'subagent', 'subagent_fork', 'send_message', 'interrupt_agent', 'workflow', 'ralph',
]

export interface MockHost {
  web: MockWeb
  tools: Map<string, { name: string; execute: (args: never, exec: never) => Promise<unknown> }>
  settings: MockSettings
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
  const settings = makeSettings(options)
  let settingsCb: ((sctx: unknown) => void) | undefined

  // Fake live agents (default: one agent composing the standard agent-plane
  // tools) whose ctx serve as the scoped view key for tools.get(name, scope).
  const agents = options.noAgents
    ? []
    : (options.agents ?? [{ tools: AGENT_PLANE_TOOLS }])

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
      get: (name: string, scope?: unknown) => {
        if (scope === undefined) return knownTools.has(name) ? { name } : undefined
        const scoped = scope as { tools?: string[] }
        return (scoped.tools ?? []).includes(name) ? { name } : undefined
      },
    },
    agents: {
      list: () => agents.map((agent) => ({ ctx: agent })),
    },
    systemPrompt: { section: () => {} },
    subagents: {
      getProvider: () => undefined,
      list: () => [] as string[],
    },
    get: () => undefined,
  }

  apply(ctx as never, { subagentProvider: 'spawn', entries: options.baseEntries ?? {} })
  if (settingsCb === undefined) throw new Error('apply() did not register a settings inject callback')
  settingsCb({ settings, effect: (fn: () => unknown) => fn() })

  return { web, tools, settings }
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
  const record: MockRes = {
    status: 200,
    headers: {},
    body: '',
    writeHead(status, headers) {
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
