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

/** Wire view of one library entry as stored in the settings document. */
export interface StoredEntry {
  description?: string
  provider?: string
  model?: string
  subagentProvider?: string
  maxTokens?: number
  persona?: string
  toolFilter?: { allow?: string[]; deny?: string[] }
  maxDepth?: number
  backgroundMode?: 'one-shot' | 'continuable'
}

export interface LibraryView {
  writable: boolean
  revision: number
  entries: Record<string, StoredEntry>
}

export type LibraryWrite =
  | { op: 'save'; entries: Record<string, StoredEntry>; expectedRevision?: number }
  | { op: 'delete'; id: string; expectedRevision?: number }

export type LibraryWriteResult =
  | { ok: true; view: LibraryView }
  | { ok: false; conflict?: boolean; message?: string }

/** Host error codes that carry no `message`; map them to user-facing text. */
const ERROR_TEXT: Record<string, string> = {
  'not-ready': '设置服务尚未就绪，请稍后重试。',
  'readonly': '设置当前为只读，无法写入。',
  'content-type-json-required': '请求被拒绝：写入只接受 JSON。',
  'cross-origin-forbidden': '请求被拒绝：跨源写入。',
  'body-too-large': '请求体超过 1 MiB 上限。',
  'bad-json': '请求体不是合法 JSON。',
  'entries-object-required': '缺少 entries 对象。',
  'invalid-id': '条目 ID 非法。',
  'unknown-op': '未知操作。',
}

async function readView(): Promise<LibraryView> {
  const response = await fetch(API_PATH, { cache: 'no-store' })
  const body: unknown = await response.json()
  if (!response.ok || typeof body !== 'object' || body === null || (body as { ok?: boolean }).ok !== true) {
    const error = (body as { error?: string } | null)?.error
    // A diagnostic `message` (e.g. settings-seam registration failure) wins
    // over the generic per-code text.
    const message = (body as { message?: string } | null)?.message
    throw new Error(message ?? (error !== undefined ? ERROR_TEXT[error] : undefined) ?? '子代理库接口不可用（插件未加载？）')
  }
  const value = body as { writable: boolean; revision: number; entries: Record<string, StoredEntry> }
  return { writable: value.writable, revision: value.revision, entries: value.entries ?? {} }
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
    if (response.status === 409) return { ok: false, conflict: true }
    if (!response.ok || typeof body !== 'object' || body === null || (body as { ok?: boolean }).ok !== true) {
      const message = (body as { message?: string } | null)?.message
      const error = (body as { error?: string } | null)?.error
      return { ok: false, message: message ?? (error !== undefined ? ERROR_TEXT[error] : undefined) ?? '保存失败' }
    }
    const value = body as { writable: boolean; revision: number; entries: Record<string, StoredEntry> }
    return { ok: true, view: { writable: value.writable, revision: value.revision, entries: value.entries ?? {} } }
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
