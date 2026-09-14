/**
 * dsh-subagent-library: a directory-backed named-subagent library.
 *
 * Since 0.3.0 the roster lives as ONE FILE PER ENTRY (`<id>.yaml`, id = file
 * name) under a roster directory (default `~/.dsh/subagents`, configurable via
 * `subagent-library.entriesDir`), hot-effective with no restart and no cache.
 * Each entry names a role: a model, an optional persona, an optional tool
 * filter, a depth cap and a background mode. The 0.2.x inline
 * `subagent-library.entries` settings document keeps working as a READ-ONLY
 * legacy fallback (files win; a per-entry idempotent migration seeds the
 * directory once) and is scheduled for removal in 0.4.0. The plugin registers
 * two model-facing tools on the HOST plane so every session sees them
 * regardless of agent preset:
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
 * harness' ordinary subagent semantics: approval pinned to `never` on
 * delegation, inherited sandbox scope, depth caps, and continuable support
 * where the provider offers it.
 *
 * @module dsh-subagent-library
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { JsonValue } from '@deepseek-ai/dsh-session'
import { assertSubagentMaxDepth, settleRun } from '@deepseek-ai/dsh-subagent'
import type { SubagentResult, SubagentRun, SubagentStartRequest } from '@deepseek-ai/dsh-subagent'
import { settingsNamespace } from '@deepseek-ai/dsh-settings'
import type { SettingsNamespace, SettingsProvider } from '@deepseek-ai/dsh-settings'
import type { CommandResult } from '@deepseek-ai/dsh-commands'
import type {} from '@deepseek-ai/dsh-host-webserver'
import {
  ENTRY_ID,
  deleteEntryFile,
  kFsPort,
  loadRoster,
  migrateLegacyEntries,
  nodeFsPort,
  parseEntryDocument,
  resolveEntriesDir,
  validateEntryId,
  writeEntryFile,
  EntrySchema,
  type Entry,
  type FsPort,
  type RosterEntry,
  type RosterView,
  type ToolFilter,
} from './roster.ts'

export type { Entry, ToolFilter } from './roster.ts'

export const name = 'subagent-library'
export const inject = ['subagents', 'tools', 'systemPrompt']

const LIBRARY_SECTION_ORDER = 116.6
/** Recursion cap applied when an entry omits maxDepth and the transport can
 *  enforce it — the harness itself imposes no global delegation cap
 *  (resolveChildDepth checks only an explicit value), and the official
 *  subagent tool defaults to 3 to keep chained delegation bounded. */
const DEFAULT_MAX_DEPTH = 3

export interface Config {
  /** Subagent transport provider used when an entry names none. */
  subagentProvider: string
  /** Roster directory holding one `<id>.yaml` per entry. Default `~/.dsh/subagents`. */
  entriesDir?: string
  /** @deprecated 0.2.x inline roster — read-only legacy fallback in 0.3.x, removal planned for 0.4.0. */
  entries?: Record<string, Entry>
}

export const Config: z<Config> = z.object({
  subagentProvider: z.string().default('spawn'),
  entriesDir: z.string(),
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

/** Foreground collection: await the child, dispose the run, map stop reasons.
 *  `run.result` rejection must still release the run (mirrors settleRun). */
async function settleForegroundRun(run: SubagentRun): Promise<{ kind: 'foreground'; runId: string; output: JsonValue[] }> {
  let result: SubagentResult
  try {
    result = await run.result
  } finally {
    await run.dispose().catch(() => { /* keep the original failure */ })
  }
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
  /** toolFilter names this calling session cannot see, dropped before delegation. */
  droppedTools?: string[]
}

/** One toolFilter name this session cannot apply, with the reason it cannot. */
interface DroppedToolName {
  name: string
  /** `session-local`: visible to the caller but on its OWN layer, so neither
   *  restrictable nor inherited by children (e.g. the official `subagent` tool
   *  in DSH 0.1.2-rc.1). `unknown`: nothing in this session knows the name —
   *  typically a typo or a tool this deployment does not mount. */
  reason: 'session-local' | 'unknown'
}

/**
 * Drop toolFilter names the CALLING session cannot restrict.
 *
 * `ctx.tools.restrict` validates against the child's inherited surface (global
 * layer + ancestors) and fails the WHOLE filter on one name it cannot admit —
 * unknown names and scope-local names included. A roster entry is shared by
 * every session, so a fixed deny list breaks delegation in any session whose
 * composition lacks one of the names (real case: deny lists carrying
 * `subagent` — a per-agent scope-local tool in DSH 0.1.2-rc.1 — or tools a
 * preset never mounts). Names outside the caller's restrictable set are dropped
 * (restrict could not have removed them anyway, and the child never inherits
 * the parent's own registrations) and reported in the delegate result instead
 * of failing the whole delegation.
 *
 * Dropping a DENY name can only widen the child (the name was unrestrictable,
 * so the child could never have it removed); dropping every ALLOW name would
 * leave the child with no global tools at all, which is reported separately as
 * `allowEmptied` so the caller can fail loudly instead of starting a crippled
 * child.
 * @param scope - the CALLING AGENT (dsh-tools' scope key), not its Context.
 */
function sanitizeToolFilter(
  ctx: Context,
  filter: ToolFilter | undefined,
  scope: unknown,
): { filter: ToolFilter | undefined, dropped: DroppedToolName[], allowEmptied: boolean } {
  if (filter === undefined) return { filter: undefined, dropped: [], allowEmptied: false }
  const tools = ctx.tools as unknown as {
    get(name: string, scope?: unknown): unknown
    /** Present on dsh-tools' runtime instance; absent from its public types. */
    view?(scope?: unknown): { restrictableNames?: Set<string> } | undefined
  }
  // restrict() admits exactly the child's inherited names, which equal the
  // caller's own restrictableNames: the child binds to the caller's standing
  // mount, so both chains are the same. Prefer that exact set and fall back to
  // visibility only if an older registry lacks `view()` (the fallback keeps
  // scope-local names, i.e. the pre-0.2.7 loud failure returns on that path).
  const restrictable = tools.view?.(scope)?.restrictableNames
  const restrictableName = (name: string): boolean => restrictable !== undefined
    ? restrictable.has(name)
    : tools.get(name, scope) !== undefined
  const keep = (list: string[] | undefined): string[] | undefined => list?.filter(restrictableName)
  const allow = keep(filter.allow)
  const deny = keep(filter.deny)
  const dropped: DroppedToolName[] = [...(filter.allow ?? []), ...(filter.deny ?? [])]
    .filter((name) => !restrictableName(name))
    .map((name) => ({
      name,
      reason: restrictable !== undefined && tools.get(name, scope) !== undefined ? 'session-local' : 'unknown',
    }))
  // Presence is preserved for `allow` — an empty allow list is a deliberate
  // "the child keeps no global tools" — while an empty deny list is a no-op and
  // is dropped so a fully sanitized filter does not travel at all.
  const next: ToolFilter = {
    ...(allow !== undefined ? { allow } : {}),
    ...(deny !== undefined && deny.length > 0 ? { deny } : {}),
  }
  return {
    filter: next.allow === undefined && next.deny === undefined ? undefined : next,
    dropped,
    allowEmptied: filter.allow !== undefined && filter.allow.length > 0 && allow !== undefined && allow.length === 0,
  }
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
  /** Non-null when the settings seam could not register this namespace (e.g. a
   *  hand-edited settings.yaml section fails the Config schema). Registration
   *  failing inside a Cordis child fiber would otherwise leave the library
   *  silently empty; surface the cause through every consumer instead. */
  let settingsFailure: string | undefined
  ctx.inject(['settings'], (sctx: Context) => {
    settingsService = sctx.settings
    settingsNs = settingsNamespace('subagent-library')
    try {
      const scope = sctx.settings.register(settingsNs, Config, { base: config })
      source = () => scope.get()
      sctx.effect(() => () => {
        source = () => config
      })
      scope.watch(() => {
        // nothing derived is memoized — every operation re-reads the source.
      })
    } catch (error) {
      settingsFailure = `subagent-library 设置段注册失败：${String(error)}。请检查 $DSH_HOME/settings.yaml 的 subagent-library 段（常见：description 缺失、entries 写成数组、YAML 布尔/字符串误写）。`
    }
  })
  /** Library entries restricted to schema-consistent ids: a hand-written key
   *  like `k3_reviewer` passes z.dict (any string key) but can never be
   *  delegated or deleted, so it is filtered out of every view. */
  const filterEntries = (raw: Record<string, Entry> | undefined): Record<string, Entry> =>
    Object.fromEntries(Object.entries(raw ?? {}).filter(([id]) => ENTRY_ID.test(id)))
  const resolveConfig = (): Config => {
    const base = source !== undefined ? source() : config
    return { ...base, entries: filterEntries(base.entries) }
  }

  // ── directory roster: one-shot idempotent migration + fresh reads ─────────
  // Tests install an in-memory FsPort under `kFsPort` on the Context
  // (SUB-TEST-001: no real disk access); production falls back to node:fs.
  const fsPort = (): FsPort =>
    (ctx as unknown as Record<symbol, unknown>)[kFsPort] as FsPort | undefined ?? nodeFsPort
  let migratedDir: string | undefined
  let migrationFailure: string | undefined
  /** Seed the roster directory from legacy settings entries — exactly once
   *  per directory. Per-entry idempotent (existing files are never touched),
   *  and legacy documents are deliberately KEPT in settings as the rollback
   *  copy for users downgrading the plugin (removal planned for 0.4.0). */
  const ensureMigrated = async (): Promise<void> => {
    const legacy = resolveConfig().entries ?? {}
    if (Object.keys(legacy).length === 0) return
    const dir = resolveEntriesDir(resolveConfig().entriesDir)
    if (migratedDir === dir) return
    migratedDir = dir // never hot-loop a failing migration on every roster read
    try {
      const result = await migrateLegacyEntries({ dir, legacy, fs: fsPort() })
      migrationFailure = result.diagnostics.length > 0
        ? result.diagnostics.map((item) => item.message).join('；')
        : undefined
    } catch (error) {
      migrationFailure = String(error)
    }
  }
  /** Fresh roster view for every consumer (tools, command, settings API):
   *  no cache — tens of small files read in milliseconds, and the cache layer
   *  is exactly where mtime/case/rename bugs live (v0.3.0 design review). */
  const loadLibrary = async (): Promise<{ subagentProvider: string, view: RosterView }> => {
    if (settingsFailure !== undefined) throw new Error(settingsFailure)
    const cfg = resolveConfig()
    await ensureMigrated()
    const view = await loadRoster({ dir: resolveEntriesDir(cfg.entriesDir), legacy: cfg.entries, fs: fsPort() })
    if (migrationFailure !== undefined) {
      view.diagnostics.unshift({ severity: 'warning', message: `旧条目自动迁移未完成：${migrationFailure}` })
    }
    return { subagentProvider: cfg.subagentProvider, view }
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
  const wireEntries = (view: RosterView): Record<string, unknown> =>
    Object.fromEntries(Object.entries(view.entries).map(([id, row]) => [id, {
      ...row.entry,
      ...(row.enabled ? {} : { enabled: false }),
      ...(row.source === 'legacy' ? { source: 'legacy' } : {}),
    }]))

  const wireView = async (): Promise<Record<string, unknown>> => {
    const { view } = await loadLibrary()
    return {
      ok: true,
      writable: true,
      dir: view.dir,
      hash: view.hash,
      entries: wireEntries(view),
      diagnostics: view.diagnostics,
    }
  }

  ctx.inject(['webServer'], (wctx: Context) => {
    const web = wctx.webServer
    /** Best-effort removal of legacy-only settings entries (the file half is
     *  already gone). No expectedRevision: last-write-wins — a racing settings
     *  writer must not fail a delete that mostly succeeded. */
    const unsetLegacy = async (ids: string[]): Promise<void> => {
      if (ids.length === 0) return
      const svc = settingsService
      const ns = settingsNs
      if (svc === undefined || ns === undefined || !svc.writable) return
      await svc.mutate(ns, ids.map((id) => ({ op: 'unset', path: ['entries', id] })))
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
            sendJson(res, 200, await wireView())
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
        const rawHash = body['expectedHash']
        // Non-string hashes are treated as absent (documented leniency, same
        // posture the old expectedRevision revision had).
        const expectedHash = typeof rawHash === 'string' ? rawHash : undefined
        try {
          const { view: current } = await loadLibrary()
          // UI write guard: hash of the rows the editor last saw. A stale hash
          // gets a 409 that CARRIES the fresh view so the editor can merge and
          // retry instead of just failing (v0.3.0 design review, k3-helper).
          if (expectedHash !== undefined && expectedHash !== current.hash) {
            sendJson(res, 409, {
              ok: false,
              error: 'conflict',
              dir: current.dir,
              hash: current.hash,
              entries: wireEntries(current),
              diagnostics: current.diagnostics,
            })
            return
          }
          if (body['op'] === 'delete') {
            const id = typeof body['id'] === 'string' ? body['id'] : ''
            if (!ENTRY_ID.test(id)) {
              sendJson(res, 400, { ok: false, error: 'invalid-id' })
              return
            }
            await deleteEntryFile(current.dir, id, fsPort())
            // The id may also exist as a legacy settings copy (imported rows
            // keep their settings document until cleaned) — unset it too; the
            // unset is a no-op when the key is absent.
            await unsetLegacy([id])
          } else if (body['op'] === 'save') {
            const entries = body['entries']
            if (typeof entries !== 'object' || entries === null || Array.isArray(entries)) {
              sendJson(res, 400, { ok: false, error: 'entries-object-required' })
              return
            }
            const candidate = entries as Record<string, unknown>
            // Validate EVERY id and payload before touching the disk. toolFilter
            // names are still NOT pre-checked against the tool registry —
            // `tools.restrict` at child composition remains the real guard
            // (0.2.2–0.2.4 showed a save-time pre-check only false-rejects).
            const validated = new Map<string, { entry: Entry, enabled: boolean }>()
            for (const [id, value] of Object.entries(candidate)) {
              const idError = validateEntryId(id)
              if (idError !== undefined) {
                sendJson(res, 400, { ok: false, error: 'invalid-entry-id', message: idError })
                return
              }
              const payload = { ...(value as Record<string, unknown>) }
              delete payload['source'] // editor provenance marker, not entry data
              try {
                validated.set(id, parseEntryDocument(payload))
              } catch (error) {
                sendJson(res, 400, { ok: false, error: 'rejected', message: `条目 "${id}"：${String(error)}` })
                return
              }
            }
            // Snapshot semantics: every payload row becomes a file; roster rows
            // absent from the payload are deleted — the file directly, AND the
            // possible legacy copy through the settings service. After a
            // successful migration a row can exist in BOTH stores; deleting
            // only the file would let the legacy copy resurrect it.
            for (const [id, doc] of validated) {
              await writeEntryFile({ dir: current.dir, id, entry: doc.entry, enabled: doc.enabled, fs: fsPort() })
            }
            const deletedIds: string[] = []
            for (const [id, row] of Object.entries(current.entries)) {
              if (validated.has(id)) continue
              deletedIds.push(id)
              if (row.source === 'file') await deleteEntryFile(current.dir, id, fsPort())
            }
            await unsetLegacy(deletedIds)
          } else {
            sendJson(res, 400, { ok: false, error: 'unknown-op' })
            return
          }
          sendJson(res, 200, await wireView())
        } catch (error) {
          // Per-file writes are individually atomic; a mid-snapshot failure
          // leaves a partial roster and is reported loudly with the message.
          sendJson(res, 500, { ok: false, error: 'write-failed', message: String(error) })
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
    async execute(_args, exec) {
      if (settingsFailure !== undefined) throw new Error(settingsFailure)
      const { view } = await loadLibrary()
      const agent = exec.agent
      /** The catalog must not advertise a filter this session cannot apply:
       *  summarize the SANITIZED filter and list what was ignored, so the model
       *  sees the same tool scope delegation will actually produce. */
      const filterSummary = (row: RosterEntry): string | undefined => {
        const entry = row.entry
        if (entry.toolFilter === undefined) return undefined
        const declared = [
          entry.toolFilter.allow !== undefined ? `allow:[${entry.toolFilter.allow.join(', ')}]` : '',
          entry.toolFilter.deny !== undefined ? `deny:[${entry.toolFilter.deny.join(', ')}]` : '',
        ].filter(Boolean).join(' ')
        if (agent === undefined) return declared
        const { filter, dropped } = sanitizeToolFilter(ctx, entry.toolFilter, agent)
        const effective = filter === undefined
          ? '(本会话无可应用的名单项)'
          : [
              filter.allow !== undefined ? `allow:[${filter.allow.join(', ')}]` : '',
              filter.deny !== undefined ? `deny:[${filter.deny.join(', ')}]` : '',
            ].filter(Boolean).join(' ')
        return dropped.length > 0
          ? `${effective} 忽略:[${dropped.map((item) => item.name).join(', ')}]`
          : effective
      }
      /** Row shape mirrors the tool's declared output schema (JsonValue-safe:
       *  no bare Record<string, unknown>, the diagnostics row included). */
      type CatalogRow = {
        id?: string
        description?: string
        provider?: string
        model?: string
        backgroundMode?: string
        toolFilter?: string
        enabled?: boolean
        diagnostics?: string[]
      }
      const rows: CatalogRow[] = Object.entries(view.entries).map(([id, row]) => {
        const summary = filterSummary(row)
        return {
          id,
          description: row.entry.description,
          provider: row.entry.provider ?? '(session default)',
          model: row.entry.model ?? '(session default)',
          backgroundMode: row.entry.backgroundMode ?? 'one-shot',
          ...(row.enabled ? {} : { enabled: false }),
          ...(summary !== undefined ? { toolFilter: summary } : {}),
        }
      })
      // Roster files that failed to load must be visible to the model too —
      // a silently missing entry looks like "the agent disappeared". Info
      // diagnostics (legacy-shadow notices) stay on the settings page: while
      // legacy copies exist they would repeat on every catalog call.
      const catalogDiagnostics = view.diagnostics.filter((item) => item.severity !== 'info')
      if (catalogDiagnostics.length > 0) {
        rows.push({
          diagnostics: catalogDiagnostics.map((item) =>
            `${item.severity}${item.id !== undefined ? ` [${item.id}]` : ''}: ${item.message}`),
        })
      }
      return rows
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
      render: (_args, value) => {
        const dropped = Array.isArray(value.droppedTools)
          ? value.droppedTools.filter((name): name is string => typeof name === 'string')
          : []
        const text = value.kind === 'background'
          ? `started background subagent task ${value.jobId}`
          : value.kind === 'continuable'
            ? `started subagent ${value.subagentId}`
            : value.kind === 'foreground'
              ? outputValueText(value.output ?? [])
              : JSON.stringify(value)
        return [{
          type: 'text',
          text: text + (dropped.length > 0
            ? `\n（已忽略本会话不可用的工具名：${dropped.join('；')}）`
            : ''),
        }]
      },
    },
    isConcurrencySafe: () => true,
    async execute(args, exec): Promise<DelegateResult> {
      if (settingsFailure !== undefined) throw new Error(settingsFailure)
      const parent = exec.agent
      if (!parent) throw new Error('delegate tool requires a calling agent (exec.agent was undefined)')
      const { subagentProvider: defaultProvider, view } = await loadLibrary()
      if (!ENTRY_ID.test(args.library_id)) throw new Error(`subagent library entry id "${args.library_id}" is invalid`)
      // Own-property lookup only: a plain-object prototype chain would resolve
      // ids like `constructor` to inherited functions (≠ undefined) and slip
      // past the missing-entry error into a real delegation.
      const row = Object.hasOwn(view.entries, args.library_id) ? view.entries[args.library_id] : undefined
      if (row === undefined) {
        const ids = Object.keys(view.entries)
        throw new Error(`subagent library has no entry "${args.library_id}"${ids.length ? ` (available: ${ids.join(', ')})` : ' (library is empty)'}`)
      }
      if (!row.enabled) {
        throw new Error(`delegate: entry "${args.library_id}" is disabled — remove "enabled: false" in its roster file (or re-enable it on the settings page) to delegate to it again`)
      }
      const entry = row.entry

      const subagentProviderName = entry.subagentProvider ?? defaultProvider
      const transport = ctx.subagents.getProvider(subagentProviderName)
      if (transport === undefined) {
        throw new Error(`subagent transport provider "${subagentProviderName}" is not registered (available: ${ctx.subagents.list().join(', ') || 'none'})`)
      }

      const continuable = entry.backgroundMode === 'continuable'
      if (continuable && transport.prepareContinuable === undefined) {
        throw new Error(`delegate: transport "${subagentProviderName}" does not support continuable children`)
      }

      // A missing maxDepth used to mean "harness-managed", but the harness
      // imposes no global recursion cap (resolveChildDepth checks only an
      // explicit value). Default to 3 like the official subagent tool, but
      // only when the transport can enforce it — providers without a
      // depthLimit capability stay unaffected (design decision #4, amended
      // after the red-team review).
      const maxDepth = entry.maxDepth ?? (transport.capabilities.depthLimit ? DEFAULT_MAX_DEPTH : undefined)
      if (maxDepth !== undefined) assertSubagentMaxDepth(maxDepth)
      // Resolve toolFilter names against the CALLING session before delegating:
      // restrict() fails the whole filter on any name the child cannot inherit
      // (unknown, or scope-local to this parent), and one shared roster entry
      // would then fail per session. The scope key is the AGENT object itself
      // (dsh-tools resolves views with `exec.agent`; dsh-scope tags it via
      // `ctx[kScope]`), never the agent's Context. See sanitizeToolFilter.
      const { filter: toolFilter, dropped, allowEmptied } = sanitizeToolFilter(ctx, entry.toolFilter, parent)
      const droppedTools = dropped.map((item) => item.reason === 'session-local'
        ? `${item.name}（本会话专属工具，子代本就继承不到）`
        : `${item.name}（本会话不存在）`)
      if (allowEmptied) {
        throw new Error(`delegate: entry "${args.library_id}" allow list names no tool this session can apply (${droppedTools.join('; ')}) — refusing to start a child with no tools at all`)
      }
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
          // Keyed on the DECLARED filter, not the sanitized one: a transport that
          // cannot apply filters must still refuse an entry that asks for one,
          // even if every name happened to be dropped in this session.
          throw new Error(`delegate: transport "${subagentProviderName}" cannot apply a tool filter (no toolFilter capability)`)
        }
      }

      // entry.provider/model are the LLM route + model (agentOptions), NOT the
      // subagent transport; the transport is `subagentProvider` (default spawn).
      const agentOptions = entry.provider !== undefined || entry.model !== undefined || entry.maxTokens !== undefined
        ? {
            ...(entry.provider !== undefined ? { provider: entry.provider } : {}),
            ...(entry.model !== undefined ? { model: entry.model } : {}),
            ...(entry.maxTokens !== undefined ? { maxTokens: entry.maxTokens } : {}),
          }
        : undefined
      const request: Omit<SubagentStartRequest, 'signal' | 'outputSchema'> = {
        label: args.description ?? args.library_id,
        prompt: [{ type: 'text' as const, text: args.prompt }],
        parent,
        ...(agentOptions !== undefined ? { agentOptions } : {}),
        ...(entry.persona !== undefined ? { persona: entry.persona } : {}),
        ...(toolFilter !== undefined ? { toolFilter } : {}),
        ...(maxDepth !== undefined ? { maxDepth } : {}),
      }
      const droppedNote = droppedTools.length > 0 ? { droppedTools } : {}

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
            ...droppedNote,
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
          ...droppedNote,
        }
      }
      return {
        ...(await settleForegroundRun(await ctx.subagents.start(subagentProviderName, {
          ...request,
          signal: exec.signal,
        }))),
        ...droppedNote,
      }
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
      handler: async (): Promise<CommandResult> => {
        const { view } = await loadLibrary()
        const ids = Object.keys(view.entries)
        const lines = ids.map((id) => {
          const row = view.entries[id]
          const tags = [
            `${row.entry.provider ?? '默认模型路由'}/${row.entry.model ?? '默认模型'}`,
            row.entry.backgroundMode === 'continuable' ? '可续聊' : '',
            row.source === 'legacy' ? 'legacy' : '',
            row.enabled ? '' : '已停用',
          ].filter(Boolean).join('，')
          return `- ${id}: ${row.entry.description} [${tags}]`
        })
        const diagnosticLines = view.diagnostics
          .filter((item) => item.severity !== 'info')
          .map((item) => `  ! ${item.severity}${item.id !== undefined ? ` [${item.id}]` : ''}: ${item.message}`)
        const text = ids.length === 0 && view.diagnostics.length === 0
          ? `子代理库为空。在名册目录放置 <id>.yaml 文件（默认 ~/.dsh/subagents/，可用 subagent-library.entriesDir 配置），或在设置页添加。`
          : `子代理库（${ids.length} 个，目录 ${view.dir}）：\n` + [...lines, ...diagnosticLines].join('\n')
        return { kind: 'success', text }
      },
    })
  }
}
