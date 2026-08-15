/**
 * dsh-plugin-subagent-library: a settings-driven named-subagent library.
 *
 * Entries live in the `subagent-library.entries` settings document (hot
 * reloaded, no restart), keyed by id. Each entry names a role: a model, an
 * optional persona, an optional tool filter, a depth cap and a background
 * mode. The plugin registers two model-facing tools on the HOST plane so every
 * session sees them regardless of agent preset:
 *
 *   - `list_subagents` — the catalog (id + description + model), so the model
 *     can pick an entry instead of guessing that a role exists.
 *   - `delegate` — start one library subagent by `library_id` (foreground,
 *     background one-shot task, or continuable child per the entry).
 *
 * Plus a `/subagent` slash command listing the catalog for humans.
 *
 * Delegation itself goes through the standard `ctx.subagents` seam with the
 * spawn provider (or any provider an entry names), so children keep the
 * harness' ordinary subagent semantics: delegated approval policy, inherited
 * sandbox scope, depth caps, and continuable support where the provider
 * offers it.
 *
 * @module dsh-plugin-subagent-library
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { JsonValue } from '@deepseek-ai/dsh-session'
import { assertSubagentMaxDepth, settleRun } from '@deepseek-ai/dsh-subagent'
import type { SubagentRun, SubagentStartRequest } from '@deepseek-ai/dsh-subagent'
import { settingsNamespace } from '@deepseek-ai/dsh-settings'
import type { SettingsNamespace, SettingsProvider } from '@deepseek-ai/dsh-settings'
import type { CommandResult } from '@deepseek-ai/dsh-commands'
import type {} from '@deepseek-ai/dsh-host-webserver'

export const name = 'subagent-library'
export const inject = ['subagents', 'tools', 'systemPrompt']

const ENTRY_ID = /^[a-z0-9][a-z0-9-]*$/
const LIBRARY_SECTION_ORDER = 116.6

/** Optional child tool scoping: named tools vanish from the child's prompt AND refuse execution. */
export interface ToolFilter {
  /** Global tool names the child keeps; everything else is removed. */
  allow?: string[]
  /** Global tool names removed from the child. */
  deny?: string[]
}

/** One named library entry. */
export interface Entry {
  /** Role description surfaced to the model in `list_subagents`; keep it self-contained. */
  description: string
  /** LLM provider route for the child (e.g. `deepseek-official`, `kimi-coding`); omitted children use the caller's loop defaults. */
  provider?: string
  /** Provider model id; omitted children use the caller's loop defaults. */
  model?: string
  /** Subagent transport provider (e.g. `spawn`); defaults to the plugin-level `subagentProvider`. */
  subagentProvider?: string
  /** Per-request output cap for the child. */
  maxTokens?: number
  /** Per-child persona shadowing the deployment persona for this child. */
  persona?: string
  /** Child tool scoping. */
  toolFilter?: ToolFilter
  /** Absolute delegation-depth cap for the child; requires provider depthLimit. */
  maxDepth?: number
  /** `one-shot` (default) or `continuable` (durable, resumable background child). */
  backgroundMode?: 'one-shot' | 'continuable'
}

export interface Config {
  /** Subagent transport provider used when an entry names none. */
  subagentProvider: string
  /** Named subagent library, keyed by id (`[a-z0-9][a-z0-9-]*`). */
  entries: Record<string, Entry>
}

const EntrySchema = z.object({
  description: z.string().required(),
  provider: z.string(),
  model: z.string(),
  subagentProvider: z.string(),
  maxTokens: z.natural().max(Number.MAX_SAFE_INTEGER),
  persona: z.string(),
  toolFilter: z.object({
    allow: z.array(z.string()).default(undefined as unknown as string[]),
    deny: z.array(z.string()).default(undefined as unknown as string[]),
  }).default(undefined as unknown as { allow: string[]; deny: string[] }),
  maxDepth: z.natural().max(Number.MAX_SAFE_INTEGER),
  backgroundMode: z.union(['one-shot', 'continuable'] as const).default('one-shot'),
})

export const Config: z<Config> = z.object({
  subagentProvider: z.string().default('spawn'),
  entries: z.dict(EntrySchema).default({}),
})

/** Render text blocks from the canonical JSON block array without trusting arbitrary values. */
function outputValueText(values: readonly JsonValue[]): string {
  return values
    .filter((value): value is { type: 'text'; text: string } =>
      typeof value === 'object' && value !== null && !Array.isArray(value)
      && value.type === 'text' && typeof value.text === 'string')
    .map(value => value.text)
    .join('')
}

/** Settle pending startup without rejecting the task producer contract. */
async function settleStart(start: Promise<SubagentRun>, signal: AbortSignal): Promise<{ status: string; detail?: string }> {
  try {
    return await settleRun(await start)
  } catch (error: unknown) {
    return signal.aborted
      ? { status: 'killed' }
      : { status: 'failed', detail: String(error) }
  }
}

/** Foreground collection: await the child, dispose the run, map stop reasons. */
async function settleForegroundRun(run: SubagentRun): Promise<{ kind: 'foreground'; runId: string; output: JsonValue[] }> {
  const result = await run.result
  await run.dispose()
  if (result.stopReason !== 'completed') {
    const text = outputValueText(result.output as unknown as JsonValue[])
    throw new Error(`subagent run ended: ${result.stopReason}${text ? ` — partial output: ${text}` : ''}`)
  }
  return { kind: 'foreground', runId: run.id, output: result.output as unknown as JsonValue[] }
}

/** Minimal structural view of the optional jobs service (dsh-jobs + dsh-tool-jobs). */
interface JobRunner {
  start(options: {
    kind: string
    label: string
    owner: unknown
    run: () => { cancel: (reason?: string) => void; done: Promise<unknown> }
  }): string
}

/** Canonical delegate tool result (JsonValue-compatible, no explicit-undefined properties). */
type DelegateResult = {
  kind: string
  runId?: string
  output?: JsonValue[]
  jobId?: string
  subagentId?: string
}

export function apply(ctx: Context, config: Config) {
  // ── settings seam: entry config as base, user document hot-reloaded ───────
  // Inline the optional-settings wiring (same pattern as dsh-agent-presets):
  // `installSettingsSection` is deliberately NOT used — in this harness build
  // its registration is dropped for bundle-loaded plugins. The inject callback
  // fires once the settings service finishes initializing.
  let source: (() => Config) | undefined
  let settingsService: SettingsProvider | undefined
  let settingsNs: SettingsNamespace | undefined
  ctx.inject(['settings'], (sctx: Context) => {
    settingsService = sctx.settings
    settingsNs = settingsNamespace('subagent-library')
    const scope = sctx.settings.register(settingsNs, Config, { base: config })
    source = () => scope.get()
    sctx.effect(() => () => {
      source = () => config
    })
    scope.watch(() => {
      // nothing derived is memoized — every operation re-reads the source.
    })
  })
  const resolveConfig = (): Config => (source !== undefined ? source() : config)

  // ── settings page API (own HTTP routes) ────────────────────────────────────
  // The Web gateway only exposes namespaces on its own allowlist
  // (`WEB_SETTINGS_NAMESPACES` / model-provider namespaces in
  // @deepseek-ai/dsh-host-apiproxy), so a third-party plugin's settings
  // section is invisible to the browser through `api.settings.*`. Serve the
  // editor through the plugin's own routes instead, exactly like fish-tts.
  const MAX_BODY_BYTES = 1 << 20

  const readJsonBody = async (req: IncomingMessage): Promise<Record<string, unknown> | null> => {
    const chunks: Buffer[] = []
    let size = 0
    for await (const chunk of req) {
      const buffer = chunk as Buffer
      size += buffer.length
      if (size > MAX_BODY_BYTES) return null
      chunks.push(buffer)
    }
    if (chunks.length === 0) return {}
    try {
      const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      return typeof parsed === 'object' && parsed !== null ? parsed as Record<string, unknown> : null
    } catch {
      return null
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

  /** Raw `entries` map from one descriptor layer; arrays and non-objects are
   *  rejected so a damaged document cannot masquerade as the library. */
  const entriesOf = (section: unknown): Record<string, Entry> | undefined => {
    if (typeof section !== 'object' || section === null || Array.isArray(section)) return undefined
    const entries = (section as { entries?: unknown }).entries
    return typeof entries === 'object' && entries !== null && !Array.isArray(entries)
      ? entries as Record<string, Entry>
      : undefined
  }

  const currentView = (): { writable: boolean; revision: number; entries: Record<string, Entry> } | null => {
    const svc = settingsService
    const ns = settingsNs
    if (svc === undefined || ns === undefined) return null
    const descriptor = svc.describe().find((candidate) => candidate.ns === ns)
    if (descriptor === undefined) return null
    const entries = entriesOf(descriptor.user) ?? entriesOf(descriptor.value) ?? {}
    return { writable: svc.writable, revision: descriptor.revision, entries }
  }

  ctx.inject(['webServer'], (wctx: Context) => {
    const web = wctx.webServer
    wctx.effect(() => web.register({
      kind: 'exact',
      path: '/subagent-library/api',
      handler: async (req: IncomingMessage, res: ServerResponse) => {
        if (req.method === 'GET') {
          const view = currentView()
          if (view === null) {
            sendJson(res, 503, { ok: false, error: 'not-ready' })
            return
          }
          sendJson(res, 200, { ok: true, ...view })
          return
        }
        if (req.method !== 'POST') {
          sendJson(res, 405, { ok: false, error: 'method-not-allowed' })
          return
        }
        if (!guardWrite(req, res)) return
        const body = await readJsonBody(req)
        if (body === null) {
          sendJson(res, 400, { ok: false, error: 'bad-json' })
          return
        }
        const svc = settingsService
        const ns = settingsNs
        if (svc === undefined || ns === undefined) {
          sendJson(res, 503, { ok: false, error: 'not-ready' })
          return
        }
        const rawRevision = body['expectedRevision']
        const expectedRevision = typeof rawRevision === 'number' && Number.isInteger(rawRevision) ? rawRevision : undefined
        try {
          if (body['op'] === 'delete') {
            const id = typeof body['id'] === 'string' ? body['id'] : ''
            if (!ENTRY_ID.test(id)) {
              sendJson(res, 400, { ok: false, error: 'invalid-id' })
              return
            }
            await svc.mutate(ns, [{ op: 'unset', path: ['entries', id] }], expectedRevision)
          } else if (body['op'] === 'save') {
            const entries = body['entries']
            if (typeof entries !== 'object' || entries === null || Array.isArray(entries)) {
              sendJson(res, 400, { ok: false, error: 'entries-object-required' })
              return
            }
            const candidate = entries as Record<string, unknown>
            const badKey = Object.keys(candidate).find((key) => !ENTRY_ID.test(key))
            if (badKey !== undefined) {
              sendJson(res, 400, { ok: false, error: 'invalid-entry-id', message: `entry id "${badKey}" is invalid` })
              return
            }
            // Validate against the plugin schema before persisting.
            Config({ ...config, entries: candidate as Record<string, Entry> })
            // Wholesale-replace the `entries` map: the editor sends a COMPLETE
            // snapshot (fields the user cleared are absent, which is exactly
            // how a removal is expressed), while settings `update` deep-merges
            // and can never remove keys the patch dropped. Other top-level
            // user keys (e.g. subagentProvider) are preserved by spreading the
            // current raw section underneath.
            const saveDescriptor = svc.describe().find((row) => row.ns === ns)
            const userSection = (saveDescriptor?.user ?? {}) as Record<string, unknown>
            await svc.replace(ns, { ...userSection, entries: candidate }, expectedRevision)
          } else {
            sendJson(res, 400, { ok: false, error: 'unknown-op' })
            return
          }
          const view = currentView()
          if (view === null) {
            sendJson(res, 503, { ok: false, error: 'not-ready' })
            return
          }
          sendJson(res, 200, { ok: true, ...view })
        } catch (error) {
          const message = String(error)
          // SettingsConflictError carries a stable `code` property; checking the
          // property (not `instanceof`) survives the bundled module copy.
          if ((error as { code?: unknown }).code === 'SETTINGS_CONFLICT') {
            sendJson(res, 409, { ok: false, error: 'conflict' })
          } else {
            sendJson(res, 400, { ok: false, error: 'rejected', message })
          }
        }
      },
    }), 'subagent-library: settings api route')
  })

  // ── model-facing tools ─────────────────────────────────────────────────────
  ctx.tools.register(defineTool({
    name: 'list_subagents',
    description: 'List the named subagents available in the subagent library: each entry shows its id, role description, provider, model, background mode and tool filter (allow/deny scoping — e.g. deny:[write, edit] marks a read-only role). Call this before delegating so you can pick a matching library_id.',
    parameters: {},
    output: {
      schema: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            description: { type: 'string' },
            provider: { type: 'string' },
            model: { type: 'string' },
            backgroundMode: { type: 'string' },
            toolFilter: { type: 'string' },
          },
          additionalProperties: true,
        },
      },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    isConcurrencySafe: () => true,
    async execute() {
      const lib = resolveConfig()
      return Object.entries(lib.entries).map(([id, entry]) => ({
        id,
        description: entry.description,
        provider: entry.provider ?? '(session default)',
        model: entry.model ?? '(session default)',
        backgroundMode: entry.backgroundMode ?? 'one-shot',
        ...(entry.toolFilter !== undefined
          ? {
              toolFilter: [
                entry.toolFilter.allow !== undefined ? `allow:[${entry.toolFilter.allow.join(', ')}]` : '',
                entry.toolFilter.deny !== undefined ? `deny:[${entry.toolFilter.deny.join(', ')}]` : '',
              ].filter(Boolean).join(' '),
            }
          : {}),
      }))
    },
  }))

  ctx.tools.register(defineTool({
    name: 'delegate',
    description: 'Delegate a task to a named subagent from the subagent library (see list_subagents for available entries and their roles). The child runs on the entry\'s configured model with its role persona and tool scope. Prefer this over ad-hoc subagent calls when a library entry matches the task.',
    parameters: {
      library_id: {
        type: 'string',
        required: true,
        description: 'id of the library entry to use',
      },
      prompt: {
        type: 'string',
        required: true,
        description: 'task content delivered to the child as its first user message',
      },
      description: {
        type: 'string',
        description: 'short display label recorded for the child session',
      },
      run_in_background: {
        type: 'boolean',
        description: 'start as a background task and return immediately (continuable entries run in the background by default)',
        default: false,
      },
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          kind: { type: 'string' },
          runId: { type: 'string' },
          output: { type: 'array', items: { type: 'json' } },
          jobId: { type: 'string' },
          subagentId: { type: 'string' },
        },
        additionalProperties: true,
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.kind === 'background'
          ? `started background subagent task ${value.jobId}`
          : value.kind === 'continuable'
            ? `started subagent ${value.subagentId}`
            : value.kind === 'foreground'
              ? outputValueText(value.output ?? [])
              : JSON.stringify(value),
      }],
    },
    isConcurrencySafe: () => true,
    async execute(args, exec): Promise<DelegateResult> {
      const parent = exec.agent
      if (!parent) throw new Error('delegate tool requires a calling agent (exec.agent was undefined)')
      const lib = resolveConfig()
      if (!ENTRY_ID.test(args.library_id)) throw new Error(`subagent library entry id "${args.library_id}" is invalid`)
      // Own-property lookup only: a plain-object prototype chain would resolve
      // ids like `constructor` to inherited functions (≠ undefined) and slip
      // past the missing-entry error into a real delegation.
      const entry = Object.hasOwn(lib.entries, args.library_id) ? lib.entries[args.library_id] : undefined
      if (entry === undefined) {
        const ids = Object.keys(lib.entries)
        throw new Error(`subagent library has no entry "${args.library_id}"${ids.length ? ` (available: ${ids.join(', ')})` : ' (library is empty)'}`)
      }

      const subagentProviderName = entry.subagentProvider ?? lib.subagentProvider
      const transport = ctx.subagents.getProvider(subagentProviderName)
      if (transport === undefined) {
        throw new Error(`subagent transport provider "${subagentProviderName}" is not registered (available: ${ctx.subagents.list().join(', ') || 'none'})`)
      }

      const continuable = entry.backgroundMode === 'continuable'
      if (continuable && transport.prepareContinuable === undefined) {
        throw new Error(`delegate: transport "${subagentProviderName}" does not support continuable children`)
      }

      const maxDepth = entry.maxDepth
      if (maxDepth !== undefined) assertSubagentMaxDepth(maxDepth)
      // The one-shot capability flags (depthLimit/persona/toolFilter) describe
      // ONLY the one-shot `start` path; a continuable child is composed by the
      // continuation manager itself (persona/toolFilter applied on activation,
      // gated solely by `prepareContinuable`). Skip them for continuable runs.
      if (!continuable) {
        if (maxDepth !== undefined && !transport.capabilities.depthLimit) {
          throw new Error(`delegate: transport "${subagentProviderName}" cannot enforce maxDepth (no depthLimit capability)`)
        }
        if (entry.persona !== undefined && !transport.capabilities.persona) {
          throw new Error(`delegate: transport "${subagentProviderName}" cannot apply a persona (no persona capability)`)
        }
        if (entry.toolFilter !== undefined && entry.toolFilter.allow === undefined && entry.toolFilter.deny === undefined) {
          throw new Error(`delegate: entry "${args.library_id}" names a toolFilter with neither allow nor deny`)
        }
        if (entry.toolFilter !== undefined && !transport.capabilities.toolFilter) {
          throw new Error(`delegate: transport "${subagentProviderName}" cannot apply a tool filter (no toolFilter capability)`)
        }
      }

      // entry.provider/model are the LLM route + model (agentOptions), NOT the
      // subagent transport; the transport is `subagentProvider` (default spawn).
      const agentOptions = entry.provider !== undefined || entry.model !== undefined || entry.maxTokens !== undefined
        ? { provider: entry.provider, model: entry.model, maxTokens: entry.maxTokens }
        : undefined
      const request: Omit<SubagentStartRequest, 'signal' | 'outputSchema'> = {
        label: args.description ?? args.library_id,
        prompt: [{ type: 'text' as const, text: args.prompt }],
        parent,
        ...(agentOptions !== undefined ? { agentOptions } : {}),
        ...(entry.persona !== undefined ? { persona: entry.persona } : {}),
        ...(entry.toolFilter !== undefined ? { toolFilter: entry.toolFilter } : {}),
        ...(maxDepth !== undefined ? { maxDepth } : {}),
      }

      const runInBackground = args.run_in_background === true || continuable
      if (runInBackground) {
        if (continuable) {
          return {
            kind: 'continuable',
            subagentId: (await ctx.subagents.startContinuable({
              provider: subagentProviderName,
              label: args.description ?? args.library_id,
              request,
              signal: exec.signal,
            })).childId,
          }
        }
        const jobs = ctx.get('jobs') as JobRunner | undefined
        if (jobs === undefined) {
          throw new Error('background jobs unavailable: load @deepseek-ai/dsh-jobs and @deepseek-ai/dsh-tool-jobs')
        }
        return {
          kind: 'background',
          jobId: jobs.start({
            kind: 'subagent',
            label: args.description ?? args.library_id,
            owner: parent,
            run: () => {
              const controller = new AbortController()
              return {
                cancel: (reason) => {
                  controller.abort(reason ?? 'background subagent task killed')
                },
                done: settleStart(ctx.subagents.start(subagentProviderName, {
                  ...request,
                  signal: controller.signal,
                }), controller.signal),
              }
            },
          }),
        }
      }
      return settleForegroundRun(await ctx.subagents.start(subagentProviderName, {
        ...request,
        signal: exec.signal,
      }))
    },
  }))

  // ── prompt section: teach the model the library exists and how to use it ───
  ctx.systemPrompt.section({
    name: 'subagent-library',
    order: LIBRARY_SECTION_ORDER,
    text: (context) => ctx.tools.get('list_subagents', context.scope) === undefined
      ? ''
      : 'Use list_subagents to see the named subagents in the library, then delegate with the delegate tool (library_id + prompt). Library entries run on a fixed model with a role persona; prefer them over ad-hoc subagent calls when an entry matches the task.',
  })

  // ── /subagent command: human-facing catalog ────────────────────────────────
  const commands = ctx.get('commands')
  if (commands !== undefined) {
    commands.register({
      name: 'subagent',
      description: 'List the subagent library entries',
      handler: (): CommandResult => {
        const lib = resolveConfig()
        const ids = Object.keys(lib.entries)
        const text = ids.length === 0
          ? '子代理库为空。在 settings.yaml 的 subagent-library.entries 下添加条目（id / description / provider / model / subagentProvider / persona / toolFilter / maxDepth / backgroundMode）。'
          : `子代理库（${ids.length} 个）：\n` + ids.map((id) => {
            const entry = lib.entries[id]
            return `- ${id}: ${entry.description} [${entry.provider ?? '默认模型路由'}/${entry.model ?? '默认模型'}${entry.backgroundMode === 'continuable' ? '，可续聊' : ''}]`
          }).join('\n')
        return { kind: 'success', text }
      },
    })
  }
}
