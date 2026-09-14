/**
 * dsh-subagent-library — browser half.
 *
 * A Settings section card ("子代理库") that reads and edits the
 * `subagent-library` settings namespace through the plugin's own host routes
 * (`/subagent-library/api`). The standard `api.settings.*` wire face cannot
 * serve a third-party namespace in this harness build (the gateway only
 * exposes its own allowlist), so the editor talks to the host directly,
 * exactly like dsh-plugin-fish-tts does.
 */
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import { LibrarySettings, type LibrarySettingsInjected } from './LibrarySettings.tsx'
import { decorateSettingsNavIcon } from './nav-icon.ts'
import { en, zh } from './locales.ts'

const NS = 'subagent-library'
const API_PATH = '/subagent-library/api'

/** Wire view of one library entry as stored in a roster file (or legacy). */
export interface StoredEntry {
  description?: string
  provider?: string
  model?: string
  subagentProvider?: string
  reasoningEffort?: string
  maxTokens?: number
  persona?: string
  toolFilter?: { allow?: string[]; deny?: string[] }
  maxDepth?: number
  backgroundMode?: 'one-shot' | 'continuable'
  /** Present only when the entry is disabled (`enabled: false`). */
  enabled?: boolean
  /** Present only for rows still served from the legacy settings document. */
  source?: 'legacy'
}

export interface LibraryDiagnostic {
  severity: 'error' | 'warning' | 'info'
  id?: string
  file?: string
  message: string
}

export interface LibraryView {
  writable: boolean
  /** Roster directory the files live in (informational, shown in the UI). */
  dir: string
  /** Stable content hash of the roster rows — the write guard. */
  hash: string
  entries: Record<string, StoredEntry>
  diagnostics?: LibraryDiagnostic[]
  /** Legacy settings copies currently shadowed by a roster file — the safe
   *  one-click cleanup set for the 0.2→0.3 transition. */
  legacyCount?: number
}

export type LibraryWrite =
  | { op: 'save'; entries: Record<string, StoredEntry>; expectedHash?: string }
  | { op: 'delete'; id: string; expectedHash?: string }
  | { op: 'clear-legacy'; expectedHash?: string }

export type LibraryWriteResult =
  | { ok: true; view: LibraryView }
  // A conflict carries the fresh view so the editor can merge and let the
  // user retry instead of staring at a bare error (v0.3.0 design review).
  | { ok: false; conflict?: boolean; message?: string; view?: LibraryView }

/** Host error codes that carry no `message`; map them to user-facing text. */
const ERROR_TEXT: Record<string, string> = {
  'not-ready': '设置服务尚未就绪，请稍后重试。',
  'content-type-json-required': '请求被拒绝：写入只接受 JSON。',
  'cross-origin-forbidden': '请求被拒绝：跨源写入。',
  'body-too-large': '请求体超过 1 MiB 上限。',
  'bad-json': '请求体不是合法 JSON。',
  'entries-object-required': '缺少 entries 对象。',
  'invalid-id': '条目 ID 非法。',
  'unknown-op': '未知操作。',
  'roster-unreadable': '名册目录读取失败。',
  'write-failed': '名册文件写入失败。',
}

interface WireView {
  ok?: boolean
  writable?: boolean
  dir?: string
  hash?: string
  entries?: Record<string, StoredEntry>
  diagnostics?: LibraryDiagnostic[]
  error?: string
  message?: string
  view?: WireView
}

const parseView = (value: WireView): LibraryView => ({
  writable: value.writable ?? true,
  dir: value.dir ?? '',
  hash: value.hash ?? '',
  entries: value.entries ?? {},
  diagnostics: value.diagnostics ?? [],
})

async function readView(): Promise<LibraryView> {
  const response = await fetch(API_PATH, { cache: 'no-store' })
  const body: unknown = await response.json()
  if (!response.ok || typeof body !== 'object' || body === null || (body as WireView).ok !== true) {
    const error = (body as WireView | null)?.error
    // A diagnostic `message` (e.g. settings-seam registration failure) wins
    // over the generic per-code text.
    const message = (body as WireView | null)?.message
    throw new Error(message ?? (error !== undefined ? ERROR_TEXT[error] : undefined) ?? '子代理库接口不可用（插件未加载？）')
  }
  return parseView(body as WireView)
}

async function writeView(write: LibraryWrite): Promise<LibraryWriteResult> {
  try {
    const response = await fetch(API_PATH, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(write),
      cache: 'no-store',
    })
    const body: unknown = await response.json()
    const wire = (typeof body === 'object' && body !== null ? body : {}) as WireView
    if (response.status === 409) {
      // The fresh view rides along: the editor merges it so the user sees the
      // concurrent change and can re-apply theirs instead of blind-retrying.
      return { ok: false, conflict: true, view: wire.view !== undefined ? parseView(wire.view) : undefined }
    }
    if (!response.ok || wire.ok !== true) {
      return { ok: false, message: wire.message ?? (wire.error !== undefined ? ERROR_TEXT[wire.error] : undefined) ?? '保存失败' }
    }
    return { ok: true, view: parseView(wire) }
  } catch (error) {
    return { ok: false, message: String(error) }
  }
}

export const inject = ['slots', 'locale', 'remote']

export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'subagent-library: dictionaries')

  // Pushed invalidation: any committed change to the subagent-library
  // namespace re-reads the document. The push carries the new revision so a
  // subscriber can tell its own write's echo (≤ last committed) from an
  // external change without racing the write response.
  const listeners = new Set<(revision?: number) => void>()
  const subscribeRefresh = (fn: (revision?: number) => void): (() => void) => {
    listeners.add(fn)
    return () => { listeners.delete(fn) }
  }
  const refresh = (revision?: number): void => {
    for (const fn of listeners) {
      try {
        fn(revision)
      } catch {
        // one stale subscriber must not break the others
      }
    }
  }
  ctx.effect(() => ctx.remote.$on('settings/document-updated', (ns: string, revision?: number) => {
    if (ns === NS) refresh(revision)
  }), 'subagent-library: settings invalidation')

  // ── settings section card ──────────────────────────────────────────────────
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: NS,
    order: 40,
    label: () => '子代理库',
    inject: (): LibrarySettingsInjected => ({ readView, writeView, subscribeRefresh }),
  }, LibrarySettings))

  decorateSettingsNavIcon(ctx)
}
