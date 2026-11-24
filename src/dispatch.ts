import type { Context } from '@deepseek-ai/cordis'
import { randomUUID } from 'node:crypto'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-commands'
import type {} from '@deepseek-ai/dsh-subagent'
import { pickRoute, type RouteFields, type RouteNote } from './profile-route.ts'
import { validateEntryId, type RosterDiagnostic, type RosterView } from './roster.ts'
import type { Group } from './groups.ts'
import { assertSessionModelAllowed } from './model-policy.ts'

export interface DispatchLibrary {
  subagentProvider: string
  raw: RosterView
  view: RosterView
  profile?: string
  notes: Record<string, RouteNote>
  overlayErrors: Record<string, string>
  groups: Record<string, Group>
  groupDiagnostics: RosterDiagnostic[]
}

interface Parent {
  id?: string
  options?: RouteFields & { subagentDepth?: number }
  session?: {
    requestHeader?(): { config?: RouteFields, adapterDefaults?: { reasoningEffort?: boolean } } | undefined
    header?: { delegationDepth?: number }
  }
}

interface ModelOverride {
  provider: string
  model: string
  reasoningEffort: string | undefined
}

interface NativeHost {
  resolveMaxDepth(): number
  namesOf: Function
  resolveName: Function
  getProvider(name: string): {
    prepareContinuable?: Function
    inheritsParentContext?: boolean
    capabilities: { depthLimit?: boolean, agentOptions?: boolean }
  } | undefined
  startActivation(spec: {
    provider: string, parent: Parent, signal: AbortSignal, label: string, childId?: string,
    delivery: 'parent', prompt: { type: 'text', text: string }[],
    maxDepth: number, agentOptions?: RouteFields
  }): Promise<{ childId: string, name: string }>
}

function nativeHost(ctx: Context): NativeHost | undefined {
  const host = ctx.subagents as unknown as Partial<NativeHost> | undefined
  if (typeof host?.startActivation === 'function' && typeof host.namesOf === 'function'
    && typeof host.resolveName === 'function' && typeof host.resolveMaxDepth === 'function'
    && typeof host.getProvider === 'function') return host as NativeHost
}

function sameModelSelection(a: RouteFields, b: RouteFields) {
  return a.provider === b.provider && a.model === b.model && a.reasoningEffort === b.reasoningEffort
}

// A fork replays the parent's last model choice from its completed history.
// Select this child's route after replay and before the host admits its first task.
async function startWithForkRoute(ctx: Context, host: NativeHost, spec: Parameters<NativeHost['startActivation']>[0], route: RouteFields) {
  const { provider, model, reasoningEffort } = route
  if (!spec.parent.id || !provider || !model) throw new Error('Cannot apply the selected model to this fork.')
  const childId = randomUUID()
  const lifetime = new AbortController()
  const signal = AbortSignal.any([spec.signal, lifetime.signal])
  let finished = false
  const detach = ctx.effect(function* () {
    yield ctx.on('agent/created', event => {
      const { agent } = event
      if (agent.id !== childId) return
      if (!('source' in event) || event.source !== 'startup' || agent.session.header.parentSession !== spec.parent.id) {
        throw new Error('The fork was not created under the expected parent.')
      }
      const child = agent as unknown as { model?: { current?(): RouteFields | undefined, select(selection: RouteFields): void } }
      if ('inheritedEventCount' in agent.session && agent.session.inheritedEventCount === 0) {
        // An empty fork normally starts on the right route. The host may have copied
        // an adapter's resolved effort into its options as an explicit selection.
        const initial = child.model?.current?.()
        if (!initial || sameModelSelection(initial, route)) return
      }
      if (typeof child.model?.select !== 'function') throw new Error('This host cannot select a model for a forked child.')
      child.model.select({ provider, model, ...(reasoningEffort !== undefined ? { reasoningEffort } : {}) })
    }, { global: true, prepend: true })
    yield () => { if (!finished) lifetime.abort() }
  }, 'subagent-library: select fork model')
  try {
    return await host.startActivation({ ...spec, childId, signal })
  } finally {
    finished = true
    await detach()
  }
}

const own = <T>(record: Record<string, T>, id: string): T | undefined =>
  Object.hasOwn(record, id) ? record[id] : undefined

function depthLimit(host: NativeHost, roleLimit?: number): number {
  const limit = host.resolveMaxDepth()
  if (!Number.isSafeInteger(limit) || limit < 0) throw new Error('The host returned an invalid maxDepth.')
  return Math.min(limit, roleLimit ?? limit)
}

/** Availability knowable without a calling session, also used by the settings view. */
export function roleUnavailable(ctx: Context, lib: DispatchLibrary, id: string, override?: ModelOverride): string | undefined {
  if (validateEntryId(id)) return `entry id "${id}" is invalid`
  if (lib.raw.listing === 'unreadable') return 'The role directory is unreadable.'
  const broken = lib.raw.diagnostics.find(item => item.severity === 'error' && item.id === id)
  if (broken) return `Role "${id}" is unreadable: ${broken.message}`
  const row = own(lib.view.entries, id)
  if (!row) return `subagent library has no entry "${id}" (available: ${Object.keys(lib.view.entries).join(', ') || 'none'})`
  if (!row.enabled) return `entry "${id}" is disabled`
  if (row.entry.toolFilter !== undefined) return `This host cannot enforce a per-child toolFilter. Review and explicitly remove the saved toolFilter to enable "${id}".`
  if (lib.notes[id] === 'overlay-broken') return lib.overlayErrors[id] || 'Invalid profile route.'
  if (lib.notes[id] === 'profile-missing' && !override) return `Provider "${row.entry.provider}" is not registered in this profile. Edit the role route for "${lib.profile}".`
  const host = nativeHost(ctx)
  if (!host) return 'This host lacks the native named activations, member addressing, or delegation limits required for dispatch.'
  const transport = row.entry.subagentProvider ?? lib.subagentProvider
  const backend = host.getProvider(transport)
  if (!backend) return `subagent transport provider "${transport}" is not registered`
  if (typeof backend.prepareContinuable !== 'function') return `Transport "${transport}" does not support continuable children.`
  if (!backend.capabilities.depthLimit) return `Transport "${transport}" cannot enforce maxDepth.`
  if ((override || Object.keys(pickRoute(row.entry)).length) && !backend.capabilities.agentOptions) return `Transport "${transport}" does not support agentOptions for this role.`
  if (depthLimit(host, row.entry.maxDepth) === 0) return 'maxDepth is 0. Child creation is disabled.'
}

function groupById(lib: DispatchLibrary, id: string): Group {
  if (validateEntryId(id)) throw new Error(`Invalid group_id "${id}".`)
  const problem = lib.groupDiagnostics.find(d => d.severity === 'error' && (d.id === id || (!d.id && d.file === '_groups')))
  if (problem) throw new Error(`Group "${id}" is unreadable: ${problem.message}`)
  const group = own(lib.groups, id)
  if (!group) throw new Error(`Unknown group_id "${id}". Use list_subagents({kind:"groups"}).`)
  return group
}

function checkArguments(args: unknown, keys: readonly string[]): void {
  if (typeof args !== 'object' || args === null || Array.isArray(args)) throw new Error('Expected an object with named arguments.')
  if (Object.hasOwn(args, 'run_in_background')) throw new Error('Remove run_in_background. delegate now returns the native name immediately. Read the result through the host notification.')
  const extra = Object.keys(args).filter(key => !keys.includes(key))
  if (extra.length) throw new Error(`Unknown arguments: ${extra.join(', ')}. Accepted: ${keys.join(', ')}.`)
  for (const [key, value] of Object.entries(args)) {
    if (typeof value !== 'string') throw new Error(`Argument "${key}" must be a string.`)
  }
}

function modelOverride(args: { provider?: string, model?: string, reasoning_effort?: string }): ModelOverride | undefined {
  const { provider, model, reasoning_effort } = args
  if (provider === undefined && model === undefined && reasoning_effort === undefined) return undefined
  if (!provider?.trim() || !model?.trim()) throw new Error('A model override requires both a non-empty provider and model. Omit all three model fields to use the role default.')
  if (reasoning_effort !== undefined && !reasoning_effort.trim()) throw new Error('Provide a non-empty reasoning_effort or omit it for the selected model default.')
  // An own undefined value explicitly clears even a compatible parent's effort in startActivation.
  return { provider, model, reasoningEffort: reasoning_effort }
}

// A saved role can inherit compatible parent effort. An explicit selection owns its effort.
function childModelRoute(inherited: RouteFields | undefined, overrides: RouteFields = {}) {
  const provider = overrides.provider ?? inherited?.provider
  const model = overrides.model ?? inherited?.model
  const sameModel = provider === inherited?.provider && model === inherited?.model
  const reasoningEffort = Object.hasOwn(overrides, 'reasoningEffort') ? overrides.reasoningEffort
    : sameModel ? inherited?.reasoningEffort : undefined
  return pickRoute({ provider, model, reasoningEffort })
}

async function preflight(ctx: Context, host: NativeHost, entry: DispatchLibrary['view']['entries'][string]['entry'], parent: Parent, signal: AbortSignal, override?: ModelOverride) {
  signal.throwIfAborted()
  const maxDepth = depthLimit(host, entry.maxDepth)
  const depth = Math.max(parent.options?.subagentDepth ?? 0, parent.session?.header?.delegationDepth ?? 0)
  if (depth >= maxDepth) throw new Error(`Child depth ${depth + 1} exceeds maxDepth ${maxDepth}.`)
  const route = { ...pickRoute(entry), ...override }
  const options = { maxDepth, ...(Object.keys(route).length ? { agentOptions: route } : {}) }
  if (route.provider !== undefined || route.model !== undefined || route.reasoningEffort !== undefined) {
    const requested = childModelRoute(parent.session?.requestHeader?.()?.config ?? parent.options, route)
    if (!requested.provider || !requested.model) throw new Error('Cannot resolve the saved child route without an effective provider and model.')
    const llm = ctx.get('llm') as { resolveCallConfig?(route: RouteFields, signal: AbortSignal): Promise<RouteFields | undefined> } | undefined
    if (typeof llm?.resolveCallConfig !== 'function') throw new Error('The host LLM service cannot validate the saved role route.')
    const resolved = await llm.resolveCallConfig(requested, signal)
    const display = pickRoute({
      provider: resolved?.provider ?? requested.provider, model: resolved?.model ?? requested.model,
      reasoningEffort: resolved?.reasoningEffort ?? requested.reasoningEffort,
    })
    return { options, checked: { requested, display } }
  }
  return { options }
}

const SESSION_DEFAULT = '(session default)'

interface Query { kind?: string, group_id?: string }

export function registerLibraryTools<L extends DispatchLibrary>(
  ctx: Context,
  loadEffective: () => Promise<L>,
  routeNoteText: (lib: L, id: string) => string | undefined,
  getSettingsFailure: () => string | undefined,
) {
  const readLibrary = () => {
    const failure = getSettingsFailure()
    if (failure !== undefined) throw new Error(failure)
    return loadEffective()
  }

  async function catalog(args: Query, parent: Parent | undefined, signal: AbortSignal): Promise<JsonValue[]> {
    if (args.kind !== undefined && args.kind !== 'roles' && args.kind !== 'groups') throw new Error('kind must be "roles" or "groups".')
    if (args.group_id !== undefined && args.kind === 'roles') throw new Error('group_id requires kind "groups" or no kind.')
    const lib = await readLibrary()
    const rows: JsonValue[] = []
    const groups = args.group_id !== undefined || args.kind === 'groups'
    const reasons = new Map<string, string | undefined>()
    function configuredRoute(id: string, entry: RouteFields) {
      const routeNote = routeNoteText(lib, id)
      return {
        provider: entry.provider ?? SESSION_DEFAULT, model: entry.model ?? SESSION_DEFAULT,
        ...(entry.reasoningEffort ? { reasoningEffort: entry.reasoningEffort } : {}),
        ...(routeNote ? { routeNote } : {}),
      }
    }
    async function availability(id: string): Promise<Record<string, JsonValue>> {
      if (!reasons.has(id)) {
        let reason = roleUnavailable(ctx, lib, id)
        if (!reason && parent) {
          try {
            await preflight(ctx, nativeHost(ctx)!, lib.view.entries[id].entry, parent, signal)
          } catch (error) {
            signal.throwIfAborted()
            reason = error instanceof Error ? error.message : String(error)
          }
        }
        reasons.set(id, reason)
      }
      const reason = reasons.get(id)
      return reason === undefined ? { launchable: true } : { launchable: false, reason }
    }
    if (!groups) {
      for (const [id, row] of Object.entries(lib.view.entries)) {
        rows.push({ id, description: row.entry.description, ...configuredRoute(id, row.entry),
          ...(!row.enabled ? { enabled: false } : {}),
          ...await availability(id) })
      }
    } else if (args.group_id === undefined) {
      for (const [id, group] of Object.entries(lib.groups)) {
        rows.push({ id, ...(group.name ? { name: group.name } : {}), description: group.description,
          enabled: group.enabled !== false, memberCount: group.members.length })
      }
    } else {
      const group = groupById(lib, args.group_id)
      const members: JsonValue[] = []
      for (const member of group.members) {
        const role = own(lib.view.entries, member.role)
        members.push({ ...member, ...(role ? configuredRoute(member.role, role.entry) : {}),
          ...(group.enabled === false ? { launchable: false, reason: 'Group is disabled.' } : await availability(member.role)) })
      }
      return [{ id: args.group_id, ...(group.name ? { name: group.name } : {}), description: group.description,
        enabled: group.enabled !== false, ...(group.instructions ? { instructions: group.instructions } : {}), members }]
    }
    const diagnostics = (groups ? lib.groupDiagnostics : lib.view.diagnostics)
      .filter(d => d.severity !== 'info').map(d => `${d.severity}${d.id ? ` [${d.id}]` : ''}: ${d.message}`)
    if (diagnostics.length) rows.push({ diagnostics })
    return rows
  }

  ctx.tools.register(defineTool({
    name: 'list_subagents',
    description: 'List saved roles or groups. Use group_id to see exact slot keys, roles, default assignments and availability.',
    parameters: {
      kind: { type: 'string', enum: ['roles', 'groups'], description: 'Omit for roles. Use groups to browse saved groups.' },
      group_id: { type: 'string', description: 'Inspect one group. Implies groups.' },
    },
    output: { schema: { type: 'array', items: { type: 'json' } }, render: (_args, rows) => [{ type: 'text', text: JSON.stringify(rows) }] },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      checkArguments(args, ['kind', 'group_id'])
      return catalog(args, exec.agent as Parent | undefined, exec.signal)
    },
  }))

  ctx.tools.register(defineTool({
    name: 'delegate',
    description: 'Start one member by library_id or by group_id and exact slot. For independent tasks, issue separate delegate calls in the same response. Use each returned name to address that member. Omit model fields to use the role default. Select an authorized model only when the task calls for it.',
    parameters: {
      library_id: { type: 'string', description: 'Role ID for a direct start. Omit when selecting a group slot.' },
      group_id: { type: 'string', description: 'Group containing the selected slot. Requires slot.' },
      slot: { type: 'string', description: 'One exact slot key in group_id. Its saved assignment is included.' },
      prompt: { type: 'string', required: true, description: 'Task and context for this member.' },
      description: { type: 'string', description: 'Optional short display label.' },
      provider: { type: 'string', description: 'LLM provider for this start. Requires model. Use list_subagent_models if available to discover authorized choices.' },
      model: { type: 'string', description: 'Exact model ID for this start. Requires provider.' },
      reasoning_effort: { type: 'string', description: 'Effort for the selected provider and model. Omit for that model’s default.' },
    },
    output: { schema: { type: 'object', additionalProperties: false, properties: {
      kind: { type: 'string', required: true }, library_id: { type: 'string', required: true },
      name: { type: 'string', required: true }, subagentId: { type: 'string', required: true },
      group_id: { type: 'string' }, slot: { type: 'string' }, routeNote: { type: 'string' },
      provider: { type: 'string' }, model: { type: 'string' }, reasoningEffort: { type: 'string' },
    } }, render: (_args, receipt) => [{ type: 'text', text: JSON.stringify(receipt) }] },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      checkArguments(args, ['library_id', 'group_id', 'slot', 'prompt', 'description', 'provider', 'model', 'reasoning_effort'])
      if (!args.prompt?.trim()) throw new Error('Provide a non-empty prompt for this member.')
      const grouped = args.group_id !== undefined && args.slot !== undefined && args.library_id === undefined
      const direct = args.library_id !== undefined && args.group_id === undefined && args.slot === undefined
      if (!direct && !grouped) {
        if (args.group_id !== undefined && args.slot === undefined && args.library_id === undefined) {
          const group = groupById(await readLibrary(), args.group_id)
          throw new Error(`Group "${args.group_id}" requires exactly one slot. Available: ${group.members.map(member => member.slot).join(', ')}.`)
        }
        throw new Error('Specify either library_id alone or group_id with exactly one slot.')
      }
      if (!exec.agent) throw new Error('delegate requires a calling agent.')
      const override = modelOverride(args)
      const lib = await readLibrary()
      let id = args.library_id
      let group: Group | undefined
      let assignment: string | undefined
      if (grouped) {
        group = groupById(lib, args.group_id!)
        if (group.enabled === false) throw new Error(`Group "${args.group_id}" is disabled.`)
        const member = group.members.find(m => m.slot === args.slot)
        if (!member) throw new Error(`Unknown slot "${args.slot}" in "${args.group_id}". Available: ${group.members.map(m => m.slot).join(', ')}.`)
        id = member.role
        assignment = member.assignment
      }
      const library_id = id!
      const target = grouped ? `${args.group_id}/${args.slot} (${library_id})` : library_id
      const unavailable = roleUnavailable(ctx, lib, library_id, override)
      if (unavailable) throw new Error(`delegate "${target}": ${unavailable}`)
      const entry = lib.view.entries[library_id].entry
      const routeNote = override ? undefined : routeNoteText(lib, library_id)
      const sections = [
        entry.persona && `Role persona:\n${entry.persona}`,
        group?.instructions && `Group instructions:\n${group.instructions}`,
        assignment && `Slot assignment:\n${assignment}`,
      ].filter(Boolean)
      const text = sections.length ? [...sections, `Task:\n${args.prompt}`].join('\n\n') : args.prompt
      const parent = exec.agent as Parent
      const host = nativeHost(ctx)!
      const provider = entry.subagentProvider ?? lib.subagentProvider
      const transport = host.getProvider(provider)
      try {
        if (override) assertSessionModelAllowed(ctx, parent, override)
        const { options, checked } = await preflight(ctx, host, entry, parent, exec.signal, override)
        exec.signal.throwIfAborted()
        if (host.getProvider(provider) !== transport) throw new Error('Transport changed during route validation. Retry the selected member.')
        if (override) assertSessionModelAllowed(ctx, parent, override)
        // A user can switch the parent's model during the asynchronous check.
        // Only apply adapter defaults to the exact selection that was checked.
        const header = parent.session?.requestHeader?.()
        const live = childModelRoute(header?.config ?? parent.options, options.agentOptions)
        const launch = checked && sameModelSelection(checked.requested, live) ? checked.display : live
        const badge = launch.model ? ` [${[launch.model, launch.reasoningEffort].filter(Boolean).join(' · ')}]` : ''
        const description = args.description?.trim()
        const identity = grouped ? `${args.group_id}/${args.slot}` : library_id
        const label = `${identity}${badge}${description ? ` · ${description}` : ''}`
        const spec: Parameters<NativeHost['startActivation']>[0] = {
          parent, signal: exec.signal, provider, label, delivery: 'parent', prompt: [{ type: 'text', text }], ...options,
        }
        // Fork seeds stop at the last completed turn, before a switch on the dispatch turn.
        // Keep an inherited adapter default implicit when recording the child's selection.
        const forkRoute = !checked && header?.adapterDefaults?.reasoningEffort ? { ...live, reasoningEffort: undefined } : live
        const started = transport?.inheritsParentContext && (checked || (live.provider && live.model))
          ? await startWithForkRoute(ctx, host, spec, forkRoute)
          : await host.startActivation(spec)
        if (!started.name || !started.childId) throw new Error('Missing native receipt. Check list_agents for this label before retrying.')
        return { kind: 'activation', library_id, ...(grouped ? { group_id: args.group_id!, slot: args.slot! } : {}),
          name: started.name, subagentId: started.childId, ...launch, ...(routeNote ? { routeNote } : {}) }
      } catch (error) {
        exec.signal.throwIfAborted()
        throw new Error(`delegate "${target}": ${error instanceof Error ? error.message : String(error)}`, { cause: error })
      }
    },
  }))

  ctx.systemPrompt.section({
    name: 'subagent-library', order: 116.6,
    text: context => ctx.tools.get('list_subagents', context.scope) === undefined ? ''
      : 'Use native subagent tools for ad hoc work. Browse saved roles and groups with list_subagents. You can delegate independent assignments in parallel, one call per member.',
  })
  ctx.get('commands')?.register({
    name: 'subagent', description: 'Browse saved roles, groups and group slots.',
    input: { hint: 'roles | groups [group-id]' },
    handler: async invocation => {
      const [kind = 'roles', group_id, extra] = invocation.rawInput.trim().split(/\s+/).filter(Boolean)
      if (extra || (kind !== 'roles' && kind !== 'groups') || (group_id && kind !== 'groups')) {
        return { kind: 'error', text: '用法：/subagent roles 或 /subagent groups [group-id]' }
      }
      try {
        const rows = await catalog({ kind, group_id }, invocation.agent as Parent, invocation.signal)
        const lines = formatCatalog(rows, kind, group_id)
        return { kind: 'success', text: lines.join('\n') }
      } catch (error) {
        return { kind: 'error', text: error instanceof Error ? error.message : String(error) }
      }
    },
  })
}

function formatConfiguredRoute(row: { [key: string]: JsonValue | undefined }): string {
  if (!row.model) return ''
  const model = row.model === SESSION_DEFAULT ? '跟随主会话模型' : row.model
  const provider = row.provider && row.provider !== SESSION_DEFAULT ? `${row.provider}/` : ''
  return `${provider}${model}${row.reasoningEffort ? ` · ${row.reasoningEffort}` : ''}`
}

/** Render the same on-demand catalog for the command palette. */
function formatCatalog(rows: JsonValue[], kind: string, groupId?: string): string[] {
  const title = groupId ? `编队 ${groupId}` : kind === 'groups' ? '编队目录' : '角色名册'
  const lines = [title]
  if (!rows.length) return [`${title}为空。`]
  for (const value of rows) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue
    if (Array.isArray(value.diagnostics)) {
      for (const message of value.diagnostics) lines.push(`! ${message}`)
      continue
    }
    if (value.id !== groupId) {
      const label = value.name ? `${value.id}（${value.name}）` : value.id
      const status = value.reason ? ` · 不可派遣：${value.reason}` : value.enabled === false ? ' · 已停用' : ''
      const detail = kind === 'groups' ? `${value.memberCount} 名成员` : formatConfiguredRoute(value)
      lines.push(`${label} · ${value.description}（${detail}）${status}`)
      if (value.routeNote) lines.push(`  ${value.routeNote}`)
      continue
    }
    lines.push(`${value.name ? `${value.name} · ` : ''}${value.description}${value.enabled === false ? ' · 已停用' : ''}`)
    if (value.instructions) lines.push(`编队说明：${value.instructions}`)
    if (Array.isArray(value.members)) {
      for (const member of value.members) {
        if (!member || typeof member !== 'object' || Array.isArray(member)) continue
        lines.push([`${member.slot} → ${member.role}`, formatConfiguredRoute(member), member.assignment,
          member.launchable ? '可派遣' : `不可派遣：${member.reason}`].filter(Boolean).join(' · '))
      }
    }
  }
  return lines
}
