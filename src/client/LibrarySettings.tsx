/**
 * Settings section: edit the subagent library document through the plugin's
 * own host routes. A `settings-conflict` (409) reloads instead of clobbering
 * a concurrent change.
 */
import { useEffect, useRef, useState } from 'react'
import type { InjectFace, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type { LibraryView, LibraryWrite, LibraryWriteResult, StoredEntry } from './index.tsx'

export interface LibrarySettingsInjected {
  readView: () => Promise<LibraryView>
  writeView: (write: LibraryWrite) => Promise<LibraryWriteResult>
  /** Re-run the loader on any pushed `settings/document-updated` for this
   *  namespace; the push's revision lets the section skip its own echo. */
  subscribeRefresh: (fn: (revision?: number) => void) => () => void
}

export type LibrarySettingsProps =
  PropsRuntime<'settings.section'>
  & InjectFace<LibrarySettingsInjected>

export function LibrarySettings(props: LibrarySettingsProps): React.ReactElement {
  const { readView, writeView, subscribeRefresh } = props

  const [view, setView] = useState<LibraryView | null>(null)
  const [entries, setEntries] = useState<Record<string, StoredEntry>>({})
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null)
  const [newId, setNewId] = useState('')
  const [newEntry, setNewEntry] = useState<StoredEntry>({ description: '', provider: '', model: '', backgroundMode: 'one-shot' })

  const alive = useRef(true)
  /** Synchronous busy flag (see applyWrite's re-entry guard). */
  const busyRef = useRef(false)
  useEffect(() => () => { alive.current = false }, [])

  /** True while a write request is in flight: the push and the HTTP response
   *  travel on independent channels, so a push may arrive before the response
   *  commits our state. Pushes in this window are skipped and re-run after. */
  const pendingSelfWrite = useRef(false)
  const skippedWhilePending = useRef(false)

  const load = (): void => {
    void (async () => {
      try {
        const next = await readView()
        if (!alive.current) return
        setView(next)
        setEntries(structuredClone(next.entries))
      } catch (error) {
        if (alive.current) setStatus({ kind: 'error', text: String(error) })
      }
    })()
  }

  useEffect(() => {
    load()
    // File-roster changes carry no push (the roster is read fresh on every
    // load, no watcher by design); this fires only for settings-layer commits
    // such as a legacy-only entry being unset. Reload unless our own write is
    // in flight — a reload here would wipe unsaved drafts in other rows.
    return subscribeRefresh(() => {
      if (pendingSelfWrite.current) {
        skippedWhilePending.current = true
        return
      }
      load()
    })
  }, [subscribeRefresh])

  const applyWrite = async (write: LibraryWrite, touchedId: string): Promise<boolean> => {
    // Synchronous re-entry guard: setBusy is async state, so two clicks in the
    // same frame would both fire applyWrite with one expectedHash and the
    // second would 409 — then reload and wipe drafts in other rows.
    if (busyRef.current) return false
    busyRef.current = true
    setBusy(true)
    setStatus(null)
    pendingSelfWrite.current = true
    try {
      const result = await writeView(write)
      if (!alive.current) return false
      pendingSelfWrite.current = false
      const skipped = skippedWhilePending.current
      skippedWhilePending.current = false
      if (result.ok) {
        setView(result.view)
        // Merge only the row this write touched (fresh server value);
        // unsaved drafts in other rows survive — they are never persisted,
        // because save bases on view.entries.
        setEntries((current) => {
          const next = { ...current }
          const fresh = result.view.entries[touchedId]
          if (fresh !== undefined) next[touchedId] = structuredClone(fresh)
          else delete next[touchedId]
          return next
        })
        setStatus({ kind: 'ok', text: '已保存' })
        // A push skipped while the write was in flight may have carried an
        // external change; reload to pick it up.
        if (skipped) load()
        return true
      }
      skippedWhilePending.current = false
      if (result.conflict) {
        // The 409 carries the fresh server view: adopt it so the user sees
        // the concurrent change and can re-apply their edit — not a dead end.
        if (result.view !== undefined) {
          setView(result.view)
          setEntries(structuredClone(result.view.entries))
        } else {
          load()
        }
        setStatus({ kind: 'error', text: '名册已被其他窗口或外部修改，已加载最新内容，请重试。' })
      } else {
        if (skipped) load()
        setStatus({ kind: 'error', text: result.message ?? '保存失败' })
      }
      return false
    } finally {
      pendingSelfWrite.current = false
      busyRef.current = false
      if (alive.current) setBusy(false)
    }
  }

  /** Normalize one entry for persistence: empty optional fields are dropped
   *  (they then fall back to their defaults instead of being stored as '' or
   *  stale values), and toolFilter survives only while it still scopes
   *  something — an allow list alone must NOT be deleted by an editor that
   *  only shows deny. */
  const cleanEntry = (entry: StoredEntry): StoredEntry => {
    const clean: StoredEntry = { ...entry }
    // Provenance markers are wire-only and must never land in a roster file.
    delete clean.source
    // `enabled` persists only when explicitly false (true is the default).
    if (clean.enabled === undefined || clean.enabled) delete clean.enabled
    if (clean.provider === '') delete clean.provider
    if (clean.model === '') delete clean.model
    if (clean.subagentProvider === '') delete clean.subagentProvider
    if (clean.persona === '') delete clean.persona
    if (clean.description === '') delete clean.description
    if (clean.maxDepth === undefined) delete clean.maxDepth
    if (clean.maxTokens === undefined) delete clean.maxTokens
    const filter = clean.toolFilter
    if (filter !== undefined
      && (filter.allow === undefined || filter.allow.length === 0)
      && (filter.deny === undefined || filter.deny.length === 0)) {
      delete clean.toolFilter
    }
    return clean
  }

  const updateEntry = (id: string, entry: StoredEntry): void => {
    if ((entry.description ?? '').trim() === '') {
      setStatus({ kind: 'error', text: '描述不能为空。' })
      return
    }
    if (entry.maxDepth !== undefined && (!Number.isInteger(entry.maxDepth) || entry.maxDepth < 1)) {
      setStatus({ kind: 'error', text: '深度上限需为 ≥1 的整数。' })
      return
    }
    if (entry.maxTokens !== undefined && (!Number.isInteger(entry.maxTokens) || entry.maxTokens < 1)) {
      setStatus({ kind: 'error', text: '输出上限需为 ≥1 的整数。' })
      return
    }
    // Save against the server truth, not the local snapshot: an unsaved draft
    // in another row must never be silently persisted by this row's button.
    void applyWrite({ op: 'save', entries: { ...(view?.entries ?? {}), [id]: cleanEntry(entry) }, expectedHash: view?.hash }, id)
  }

  const removeEntry = (id: string): void => {
    if (!window.confirm(`确认删除子代理 "${id}"？该操作立即删除其名册文件。`)) return
    void applyWrite({ op: 'delete', id, expectedHash: view?.hash }, id)
  }

  const addEntry = (): void => {
    const id = newId.trim()
    if (!/^[a-z0-9][a-z0-9-]*$/.test(id) || (newEntry.description ?? '').trim() === '') {
      setStatus({ kind: 'error', text: 'ID 需为小写字母/数字/连字符，且必须有描述。' })
      return
    }
    const serverEntries = view?.entries ?? {}
    if (serverEntries[id] !== undefined) {
      setStatus({ kind: 'error', text: `ID "${id}" 已存在。` })
      return
    }
    if (newEntry.maxTokens !== undefined && (!Number.isInteger(newEntry.maxTokens) || newEntry.maxTokens < 1)) {
      setStatus({ kind: 'error', text: '输出上限需为 ≥1 的整数。' })
      return
    }
    if (newEntry.maxDepth !== undefined && (!Number.isInteger(newEntry.maxDepth) || newEntry.maxDepth < 1)) {
      setStatus({ kind: 'error', text: '深度上限需为 ≥1 的整数。' })
      return
    }
    void applyWrite({ op: 'save', entries: { ...serverEntries, [id]: cleanEntry(newEntry) }, expectedHash: view?.hash }, id).then((ok) => {
      if (alive.current && ok) {
        setNewId('')
        setNewEntry({ description: '', provider: '', model: '', backgroundMode: 'one-shot' })
      }
    })
  }

  const rowStyle = { display: 'flex', alignItems: 'center', gap: '8px' } as const
  /** Shrinkable multi-column row: min-width 0 lets inputs shrink below their
   *  intrinsic width instead of overflowing the settings card (form controls
   *  otherwise keep their default width as a flex minimum). */
  const colStyle = { ...rowStyle, flex: 1, minWidth: 0 } as const
  const labelStyle = { fontSize: '13px', opacity: 0.85, minWidth: '72px' } as const
  const inputStyle = {
    flex: 1,
    minWidth: 0,
    fontSize: '13px',
    fontFamily: 'monospace',
    padding: '4px 8px',
    border: '1px solid var(--dsh-color-border, #3a3f4b)',
    borderRadius: '4px',
    background: 'transparent',
    color: 'inherit',
  } as const
  const buttonStyle = {
    padding: '3px 12px',
    fontSize: '12px',
    cursor: 'pointer',
    opacity: busy ? 0.55 : 1,
  } as const
  const cardStyle = {
    display: 'flex',
    flexDirection: 'column',
    gap: '6px',
    padding: '10px 12px',
    border: '1px solid var(--dsh-color-border, #3a3f4b)',
    borderRadius: '6px',
  } as const
  const hintStyle = { fontSize: '11px', opacity: 0.6, marginTop: '2px' } as const

  if (view === null) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', padding: '12px 4px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
          <div style={{ fontSize: '15px', fontWeight: 600 }}>子代理库</div>
          <button type="button" onClick={load} style={{ ...buttonStyle, opacity: 0.7 }}>重试</button>
        </div>
        {status !== null && (
          <div style={{ fontSize: '12px', color: status.kind === 'ok' ? 'var(--dsh-color-success, #30a46c)' : 'var(--dsh-color-danger, #e5484d)', whiteSpace: 'pre-wrap' }}>
            {status.text}
          </div>
        )}
        {status === null && <div style={{ fontSize: '13px', opacity: 0.8 }}>正在加载…（若长时间无响应，请重试或检查插件是否加载）</div>}
      </div>
    )
  }

  const ids = Object.keys(entries)

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '10px', padding: '12px 4px', maxWidth: '720px' }}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
          <div style={{ fontSize: '15px', fontWeight: 600 }}>子代理库</div>
          <button type="button" onClick={load} style={{ ...buttonStyle, opacity: 0.7 }}>刷新</button>
        </div>
        <span style={hintStyle}>管理具名角色子代理。保存即写名册文件并热生效：模型可在任意会话通过 list_subagents / delegate 使用。</span>
      </div>

      {(view.diagnostics?.length ?? 0) > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '2px', padding: '8px 10px', border: '1px solid var(--dsh-color-warning, #f5a623)', borderRadius: '6px', fontSize: '12px' }}>
          {view.diagnostics!.map((item, index) => (
            <div
              key={index}
              style={{
                color: item.severity === 'error' ? 'var(--dsh-color-danger, #e5484d)' : item.severity === 'warning' ? 'var(--dsh-color-warning, #b8860b)' : 'inherit',
                opacity: item.severity === 'info' ? 0.75 : 1,
              }}
            >
              {item.severity === 'error' ? '错误' : item.severity === 'warning' ? '警告' : '提示'}{item.id !== undefined ? ` [${item.id}]` : ''}：{item.message}
            </div>
          ))}
        </div>
      )}

      {ids.length === 0 && (
        <div style={{ fontSize: '13px', opacity: 0.8 }}>库为空。添加第一个条目开始使用。</div>
      )}

      {ids.map((id) => {
        const entry = entries[id]
        return (
          <div key={id} style={cardStyle}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
              <span style={{ fontSize: '13px', fontWeight: 600, fontFamily: 'monospace', opacity: entry.enabled === false ? 0.5 : 1 }}>{id}</span>
              {entry.source === 'legacy' && (
                <span style={{ fontSize: '10px', padding: '1px 6px', borderRadius: '8px', border: '1px solid var(--dsh-color-border, #3a3f4b)', opacity: 0.7 }}>legacy</span>
              )}
              <span style={{ fontSize: '11px', opacity: 0.7 }}>
                {entry.provider || '默认路由'}/{entry.model || '默认模型'}
                {entry.backgroundMode === 'continuable' ? ' · 可续聊' : ''}
                {entry.maxDepth !== undefined ? ` · 深度${entry.maxDepth}` : ''}
                {entry.maxTokens !== undefined ? ` · ${entry.maxTokens}tok` : ''}
                {entry.enabled === false ? ' · 已停用' : ''}
              </span>
              <span style={{ flex: 1 }} />
              <label style={{ fontSize: '12px', display: 'flex', alignItems: 'center', gap: '4px', cursor: 'pointer' }}>
                <input
                  type="checkbox"
                  checked={entry.enabled !== false}
                  onChange={(event) => setEntries({ ...entries, [id]: { ...entry, enabled: event.target.checked ? undefined : false } })}
                />
                启用
              </label>
              <button type="button" disabled={busy} onClick={() => removeEntry(id)} style={buttonStyle}>删除</button>
              <button type="button" disabled={busy} onClick={() => updateEntry(id, entry)} style={buttonStyle}>保存</button>
            </div>

            <div style={rowStyle}>
              <span style={labelStyle}>描述</span>
              <input
                value={entry.description ?? ''}
                onChange={(event) => setEntries({ ...entries, [id]: { ...entry, description: event.target.value } })}
                placeholder="角色描述（模型可见）"
                style={inputStyle}
              />
            </div>

            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px' }}>
              <div style={colStyle}>
                <span style={labelStyle}>Provider</span>
                <input
                  value={entry.provider ?? ''}
                  onChange={(event) => setEntries({ ...entries, [id]: { ...entry, provider: event.target.value } })}
                  placeholder="deepseek-official / kimi-coding"
                  style={inputStyle}
                />
              </div>
              <div style={colStyle}>
                <span style={labelStyle}>模型</span>
                <input
                  value={entry.model ?? ''}
                  onChange={(event) => setEntries({ ...entries, [id]: { ...entry, model: event.target.value } })}
                  placeholder="k3-256k"
                  style={inputStyle}
                />
              </div>
            </div>

            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px' }}>
              <div style={colStyle}>
                <span style={labelStyle}>传输层</span>
                <input
                  value={entry.subagentProvider ?? ''}
                  onChange={(event) => setEntries({ ...entries, [id]: { ...entry, subagentProvider: event.target.value } })}
                  placeholder="spawn（默认）"
                  style={inputStyle}
                />
              </div>
              <div style={colStyle}>
                <span style={labelStyle}>输出上限</span>
                <input
                  type="number"
                  min={1}
                  value={entry.maxTokens ?? ''}
                  onChange={(event) => setEntries({ ...entries, [id]: { ...entry, maxTokens: event.target.value === '' ? undefined : Number(event.target.value) } })}
                  placeholder="tokens"
                  style={{ ...inputStyle, maxWidth: '110px' }}
                />
              </div>
            </div>

            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px' }}>
              <div style={colStyle}>
                <span style={labelStyle}>深度上限</span>
                <input
                  type="number"
                  min={1}
                  value={entry.maxDepth ?? ''}
                  onChange={(event) => setEntries({ ...entries, [id]: { ...entry, maxDepth: event.target.value === '' ? undefined : Number(event.target.value) } })}
                  style={{ ...inputStyle, maxWidth: '80px' }}
                />
              </div>
              <div style={colStyle}>
                <span style={labelStyle}>后台模式</span>
                <select
                  value={entry.backgroundMode ?? 'one-shot'}
                  onChange={(event) => setEntries({ ...entries, [id]: { ...entry, backgroundMode: event.target.value as 'one-shot' | 'continuable' } })}
                  style={{ ...inputStyle, maxWidth: '140px' }}
                >
                  <option value="one-shot">one-shot</option>
                  <option value="continuable">continuable</option>
                </select>
              </div>
              <div style={{ ...colStyle, flex: 2 }}>
                <span style={labelStyle}>禁用工具</span>
                <input
                  value={(entry.toolFilter?.deny ?? []).join(', ')}
                  onChange={(event) => {
                    const deny = event.target.value.split(',').map((item) => item.trim()).filter(Boolean)
                    // The editor only shows deny; a hand-written allow list is
                    // preserved so an edit to deny cannot silently drop it.
                    const allow = entry.toolFilter?.allow
                    setEntries({
                      ...entries,
                      [id]: {
                        ...entry,
                        toolFilter: (allow !== undefined && allow.length > 0) || deny.length > 0
                          ? {
                              ...(allow !== undefined && allow.length > 0 ? { allow } : {}),
                              ...(deny.length > 0 ? { deny } : {}),
                            }
                          : undefined,
                      },
                    })
                  }}
                  placeholder="write, edit, todo_write, …"
                  style={inputStyle}
                />
              </div>
            </div>

            <div style={rowStyle}>
              <span style={labelStyle}>角色提示词</span>
              <textarea
                value={entry.persona ?? ''}
                onChange={(event) => setEntries({ ...entries, [id]: { ...entry, persona: event.target.value } })}
                placeholder="子代理的系统提示词（可选）"
                rows={3}
                style={{ ...inputStyle, resize: 'vertical', fontFamily: 'inherit' }}
              />
            </div>
          </div>
        )
      })}

      {/* Add-card mirrors the entry-card rhythm: header row with the action
          button on the right, then one label row per field group. */}
      <div style={cardStyle}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
          <span style={{ fontSize: '13px', fontWeight: 600 }}>新增子代理</span>
          <span style={{ flex: 1 }} />
          <button type="button" disabled={busy} onClick={addEntry} style={buttonStyle}>添加</button>
        </div>
        <div style={rowStyle}>
          <span style={labelStyle}>ID</span>
          <input value={newId} onChange={(event) => setNewId(event.target.value)} placeholder="k3-reviewer" style={{ ...inputStyle, maxWidth: '200px' }} />
        </div>
        <div style={rowStyle}>
          <span style={labelStyle}>描述</span>
          <input
            value={newEntry.description ?? ''}
            onChange={(event) => setNewEntry({ ...newEntry, description: event.target.value })}
            placeholder="角色描述（模型可见）"
            style={inputStyle}
          />
        </div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px' }}>
          <div style={colStyle}>
            <span style={labelStyle}>Provider</span>
            <input value={newEntry.provider ?? ''} onChange={(event) => setNewEntry({ ...newEntry, provider: event.target.value })} placeholder="kimi-coding" style={inputStyle} />
          </div>
          <div style={colStyle}>
            <span style={labelStyle}>模型</span>
            <input value={newEntry.model ?? ''} onChange={(event) => setNewEntry({ ...newEntry, model: event.target.value })} placeholder="k3-256k" style={inputStyle} />
          </div>
        </div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px' }}>
          <div style={colStyle}>
            <span style={labelStyle}>传输层</span>
            <input value={newEntry.subagentProvider ?? ''} onChange={(event) => setNewEntry({ ...newEntry, subagentProvider: event.target.value })} placeholder="spawn（默认）" style={inputStyle} />
          </div>
          <div style={colStyle}>
            <span style={labelStyle}>输出上限</span>
            <input
              type="number"
              min={1}
              value={newEntry.maxTokens ?? ''}
              onChange={(event) => setNewEntry({ ...newEntry, maxTokens: event.target.value === '' ? undefined : Number(event.target.value) })}
              placeholder="tokens（可选）"
              style={{ ...inputStyle, maxWidth: '110px' }}
            />
          </div>
        </div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px' }}>
          <div style={colStyle}>
            <span style={labelStyle}>深度上限</span>
            <input
              type="number"
              min={1}
              value={newEntry.maxDepth ?? ''}
              onChange={(event) => setNewEntry({ ...newEntry, maxDepth: event.target.value === '' ? undefined : Number(event.target.value) })}
              style={{ ...inputStyle, maxWidth: '80px' }}
            />
          </div>
          <div style={colStyle}>
            <span style={labelStyle}>后台模式</span>
            <select
              value={newEntry.backgroundMode ?? 'one-shot'}
              onChange={(event) => setNewEntry({ ...newEntry, backgroundMode: event.target.value as 'one-shot' | 'continuable' })}
              style={{ ...inputStyle, maxWidth: '140px' }}
            >
              <option value="one-shot">one-shot</option>
              <option value="continuable">continuable</option>
            </select>
          </div>
          <div style={{ ...colStyle, flex: 2 }}>
            <span style={labelStyle}>禁用工具</span>
            <input
              value={(newEntry.toolFilter?.deny ?? []).join(', ')}
              onChange={(event) => {
                const deny = event.target.value.split(',').map((item) => item.trim()).filter(Boolean)
                const allow = newEntry.toolFilter?.allow
                setNewEntry({
                  ...newEntry,
                  toolFilter: (allow !== undefined && allow.length > 0) || deny.length > 0
                    ? {
                        ...(allow !== undefined && allow.length > 0 ? { allow } : {}),
                        ...(deny.length > 0 ? { deny } : {}),
                      }
                    : undefined,
                })
              }}
              placeholder="write, edit, todo_write, …"
              style={inputStyle}
            />
          </div>
        </div>
        <div style={rowStyle}>
          <span style={labelStyle}>角色提示词</span>
          <textarea
            value={newEntry.persona ?? ''}
            onChange={(event) => setNewEntry({ ...newEntry, persona: event.target.value })}
            placeholder="子代理的系统提示词（可选）"
            rows={3}
            style={{ ...inputStyle, resize: 'vertical', fontFamily: 'inherit' }}
          />
        </div>
      </div>

      {status !== null && (
        <div style={{ fontSize: '12px', color: status.kind === 'ok' ? 'var(--dsh-color-success, #30a46c)' : 'var(--dsh-color-danger, #e5484d)' }}>
          {status.text}
        </div>
      )}

      <div style={{ fontSize: '11px', opacity: 0.55, paddingTop: '4px' }}>
        配置存储于名册目录 {view.dir || '~/.dsh/subagents'}（每具名子代理一个 &lt;id&gt;.yaml，可手编、热生效）。
        settings.yaml 中的旧 entries 仅作迁移兜底读取，文件优先生效。
      </div>
    </div>
  )
}
