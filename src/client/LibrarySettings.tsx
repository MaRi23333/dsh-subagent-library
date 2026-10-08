/**
 * Settings section: edit the subagent library document through the plugin's
 * own host routes. A `settings-conflict` (409) reloads instead of clobbering
 * a concurrent change.
 *
 * Each collapsed card separates identity, description, model and execution
 * metadata. Editing stays behind a disclosure so long values never compete
 * with the name or enable switch for the same horizontal space.
 */
import { useEffect, useId, useMemo, useRef, useState } from 'react'
import type { InjectFace, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type { LibraryView, LibraryWrite, LibraryWriteResult, StoredEntry } from './index.tsx'
import { ACCENT, BANNER, DANGER, MONO, S, SETTINGS_CSS, SUCCESS } from './settings-theme.ts'

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

/** Deep equality for the two entry shapes we compare (server row vs draft).
 *  JSON round-trip is enough: every field is a string, number, boolean, or
 *  array of strings, and key order is stable because both sides are built by
 *  the same spread-from-server path. */
const sameEntry = (a: StoredEntry | undefined, b: StoredEntry | undefined): boolean =>
  JSON.stringify(a) === JSON.stringify(b)

/** Content-adaptive textarea: grows with its text (clamped) so long personas
 *  are readable without dragging while short ones stay compact. Re-measures
 *  after every render (value changes re-render) and on input. */
function AutoTextarea(props: Omit<React.TextareaHTMLAttributes<HTMLTextAreaElement>, 'style'> & { style?: React.CSSProperties }): React.ReactElement {
  const { style, ...rest } = props
  const ref = useRef<HTMLTextAreaElement | null>(null)
  const resize = (): void => {
    const el = ref.current
    if (el === null) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(Math.max(el.scrollHeight, 86), 440)}px`
  }
  useEffect(() => { resize() })
  return <textarea {...rest} ref={ref} onInput={resize} style={{ ...style, overflow: 'auto' }} />
}

/** Single-line label + control, so every field in the editor lines up on the
 *  same left edge regardless of how many share a row. */
function Field(props: { label: string; hint?: string; children: React.ReactNode }): React.ReactElement {
  const { label, hint, children } = props
  return (
    <label style={S.field}>
      <span style={S.fieldLabel}>{label}</span>
      {children}
      {hint !== undefined && <span style={{ ...S.hint, marginTop: 3 }}>{hint}</span>}
    </label>
  )
}

/** Chevron that rotates on open — the only motion in the page, and cheap. */
function Chevron(props: { open: boolean }): React.ReactElement {
  return (
    <span style={{ ...S.chevron, transform: props.open ? 'rotate(90deg)' : 'none' }}>
      <svg width="11" height="11" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M4.5 2.5L8 6l-3.5 3.5" />
      </svg>
    </span>
  )
}

/** Parse / render the comma-separated deny list without ever dropping a
 *  hand-written allow list the editor does not surface. */
const parseList = (value: string): string[] => value.split(',').map((item) => item.trim()).filter(Boolean)
const listToText = (list: string[] | undefined): string => (list ?? []).join(', ')

/** Draft actions disappear on success. Keep keyboard focus on their card. */
function focusDisclosure(event: React.MouseEvent<HTMLButtonElement>): void {
  if (event.detail === 0) {
    event.currentTarget.closest('[data-entry-id]')?.querySelector<HTMLButtonElement>('[data-row-id]')?.focus()
  }
}

export function LibrarySettings(props: LibrarySettingsProps): React.ReactElement {
  const { readView, writeView, subscribeRefresh } = props
  const sectionId = useId()

  const [view, setView] = useState<LibraryView | null>(null)
  const [entries, setEntries] = useState<Record<string, StoredEntry>>({})
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null)
  const [newId, setNewId] = useState('')
  const [newEntry, setNewEntry] = useState<StoredEntry>({ description: '', provider: '', model: '', backgroundMode: 'one-shot' })
  /** Editing is opt-in; newly created entries open to finish configuration. */
  const [open, setOpen] = useState<Record<string, boolean>>({})
  const [adding, setAdding] = useState(false)
  const [filter, setFilter] = useState('')

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
        // The 409 carries the fresh server view: adopt ONLY the view (fresh
        // hash/diagnostics/legacyCount) and KEEP local drafts. Save is a full
        // snapshot anyway, so an informed retry overwrites the concurrent
        // change — silently wiping the user's drafts here would compound the
        // loss instead (red team A3).
        if (result.view !== undefined) {
          setView(result.view)
        } else {
          load()
        }
        setStatus({ kind: 'error', text: '名册已被其他窗口或外部修改（已切换到最新基线）。你的未保存修改已保留；再次保存将以你的版本覆盖。' })
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
    if (clean.reasoningEffort === '') delete clean.reasoningEffort
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
      setOpen((current) => ({ ...current, [id]: true }))
      return
    }
    if (entry.maxDepth !== undefined && (!Number.isInteger(entry.maxDepth) || entry.maxDepth < 1)) {
      setStatus({ kind: 'error', text: '深度上限需为 ≥1 的整数。' })
      setOpen((current) => ({ ...current, [id]: true }))
      return
    }
    if (entry.maxTokens !== undefined && (!Number.isInteger(entry.maxTokens) || entry.maxTokens < 1)) {
      setStatus({ kind: 'error', text: '输出上限需为 ≥1 的整数。' })
      setOpen((current) => ({ ...current, [id]: true }))
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
        setAdding(false)
        setOpen((current) => ({ ...current, [id]: true }))
      }
    })
  }

  /** One row's field edit; `patch` merges onto the current draft. */
  const patch = (id: string, changes: Partial<StoredEntry>): void => {
    setEntries((current) => ({ ...current, [id]: { ...current[id], ...changes } }))
  }

  const revertEntry = (id: string): void => {
    const saved = view?.entries[id]
    if (saved !== undefined) {
      setEntries((current) => ({ ...current, [id]: structuredClone(saved) }))
    }
  }

  const setDeny = (id: string, text: string): void => {
    const deny = parseList(text)
    const allow = entries[id]?.toolFilter?.allow
    const keepAllow = allow !== undefined && allow.length > 0
    patch(id, {
      toolFilter: keepAllow || deny.length > 0
        ? {
            ...(keepAllow ? { allow } : {}),
            ...(deny.length > 0 ? { deny } : {}),
          }
        : undefined,
    })
  }

  // ── derived: summary + ordering + filtering ──────────────────────────────
  const ids = useMemo(() => Object.keys(entries), [entries])
  const stats = useMemo(() => {
    let off = 0
    let legacy = 0
    for (const id of ids) {
      const entry = entries[id]
      if (entry.enabled === false) off += 1
      if (entry.source === 'legacy') legacy += 1
    }
    return { total: ids.length, off, legacy }
  }, [ids, entries])

  /** Disabled rows sink to the bottom (they are not what you came to look at),
   *  then plain alphabetical. */
  const orderedIds = useMemo(() => [...ids].sort((a, b) => {
    const offA = entries[a].enabled === false ? 1 : 0
    const offB = entries[b].enabled === false ? 1 : 0
    if (offA !== offB) return offA - offB
    return a.localeCompare(b)
  }), [ids, entries])

  const needle = filter.trim().toLowerCase()
  const visibleIds = useMemo(() => {
    if (needle === '') return orderedIds
    return orderedIds.filter((id) => {
      const entry = entries[id]
      const haystack = [id, entry.description, entry.model, entry.provider, entry.reasoningEffort, entry.persona]
        .filter((value): value is string => typeof value === 'string')
        .join('\n')
        .toLowerCase()
      return haystack.includes(needle)
    })
  }, [orderedIds, entries, needle])

  const dirtyIds = useMemo(() => {
    const set = new Set<string>()
    for (const id of ids) {
      if (!sameEntry(entries[id], view?.entries[id])) set.add(id)
    }
    return set
  }, [ids, entries, view])

  const openCount = visibleIds.filter((id) => open[id] === true).length
  const allOpen = visibleIds.length > 0 && openCount === visibleIds.length
  const toggleAll = (): void => {
    setOpen((current) => {
      const next = { ...current }
      for (const id of visibleIds) next[id] = !allOpen
      return next
    })
  }

  // ── render ───────────────────────────────────────────────────────────────
  if (view === null) {
    return (
      <div className="dsh-library" style={S.root}>
        <style>{SETTINGS_CSS}</style>
        <div style={S.headingRow}>
          <div style={S.heading}>子代理库</div>
          <button type="button" onClick={load} style={S.button}>重试</button>
        </div>
        {status !== null && (
          <div style={status.kind === 'ok' ? BANNER.ok : BANNER.error}>{status.text}</div>
        )}
        {status === null && <div style={S.sub}>正在加载…（若长时间无响应，请重试或检查插件是否加载）</div>}
      </div>
    )
  }

  return (
    <div className="dsh-library" style={S.root}>
      <style>{SETTINGS_CSS}</style>
      <div style={S.pageHeader}>
        <div style={S.headingRow}>
          <h2 style={S.heading}>子代理库</h2>
          <span style={{ flex: 1 }} />
          <button type="button" onClick={load} disabled={busy} style={S.button}>刷新</button>
        </div>
        <span style={S.sub}>
          集中管理角色、模型与执行方式。展开条目编辑，保存后即刻生效。
        </span>
      </div>

      {(view.diagnostics?.length ?? 0) > 0 && (
        <div style={BANNER.warn}>
          {view.diagnostics!.map((item, index) => (
            <div
              key={index}
              style={{
                fontWeight: item.severity === 'error' ? 600 : 400,
                opacity: item.severity === 'info' ? 0.78 : 1,
              }}
            >
              {item.severity === 'error' ? '错误' : item.severity === 'warning' ? '警告' : '提示'}{item.id !== undefined ? ` [${item.id}]` : ''}：{item.message}
            </div>
          ))}
        </div>
      )}

      {(view.legacyCount ?? 0) > 0 && (
        <div style={BANNER.info}>
          <span>
            0.2→0.3 迁移：{view.legacyCount} 个旧条目已导出为名册文件并优先生效，settings.yaml 中的旧副本仍在（仅作回滚兜底）。确认名册正常后可一键清除。
          </span>
          <button
            type="button"
            disabled={busy}
            onClick={() => {
              if (window.confirm('确认清除 settings.yaml 中已迁移的旧条目副本？（名册文件不受影响）')) {
                void applyWrite({ op: 'clear-legacy', expectedHash: view?.hash }, '')
              }
            }}
            style={{ ...S.button, alignSelf: 'flex-start' }}
          >
            清除旧条目
          </button>
        </div>
      )}

      {/* Summary band — the "at a glance" answer, before any scrolling. */}
      <div style={S.band}>
        <div style={S.bandStats}>
          <div style={S.bandStat}>
            <span style={S.bandValue}>{stats.total}</span>
            <span style={S.bandLabel}>个子代理</span>
          </div>
          <div style={S.bandStat}>
            <span style={{ ...S.bandValue, color: SUCCESS }}>{stats.total - stats.off}</span>
            <span style={S.bandLabel}>已启用</span>
          </div>
          {stats.off > 0 && (
            <div style={S.bandStat}>
              <span style={S.bandValue}>{stats.off}</span>
              <span style={S.bandLabel}>已停用</span>
            </div>
          )}
          {dirtyIds.size > 0 && (
            <div style={S.bandStat}>
              <span style={{ ...S.bandValue, color: DANGER }}>{dirtyIds.size}</span>
              <span style={S.bandLabel}>未保存</span>
            </div>
          )}
        </div>
        <div style={S.bandDir}>
          <span style={S.bandLabel}>名册目录</span>
          <span style={S.bandPath} title={view.dir || '~/.dsh/subagents'}>{view.dir || '~/.dsh/subagents'}</span>
        </div>
      </div>

      {stats.total > 0 && (
        <div style={S.bar}>
          <label style={S.search}>
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" style={{ color: 'inherit', opacity: 0.6, flex: 'none' }} aria-hidden="true">
              <circle cx="5" cy="5" r="3.4" />
              <path d="M7.6 7.6L10.5 10.5" />
            </svg>
            <input
              value={filter}
              onChange={(event) => setFilter(event.target.value)}
              placeholder="筛选 id、描述、模型…"
              aria-label="筛选子代理"
              style={S.searchInput}
            />
            {filter !== '' && (
              <button
                type="button"
                onClick={() => setFilter('')}
                title="清除筛选"
                style={{ ...S.ghost, padding: 0, fontSize: 13, lineHeight: 1 }}
              >
                ×
              </button>
            )}
          </label>
          <button type="button" onClick={toggleAll} disabled={visibleIds.length === 0} style={S.button}>{allOpen ? '全部收起' : '全部展开'}</button>
          <button
            type="button"
            onClick={() => setAdding((current) => !current)}
            style={adding ? S.button : S.primary}
          >
            {adding ? '取消新增' : '＋ 新增子代理'}
          </button>
        </div>
      )}

      {/* Add-card: default-collapsed behind the bar button so the roster owns
          the screen; it expands into the same field groups an entry row uses. */}
      {(adding || stats.total === 0) && (
        <div className="dsh-library-card" style={{ ...S.row, ...S.rowOpen }}>
          <div style={S.addHead}>
            <div style={S.addIntro}>
              <span style={{ ...S.id, color: ACCENT }}>新增子代理</span>
              <span style={S.sub}>填写 ID 与角色描述，其余配置可稍后补充。</span>
            </div>
            <button type="button" disabled={busy} onClick={addEntry} style={S.primary}>创建子代理</button>
          </div>
          <div style={S.body}>
            <div className="dsh-library-grid" style={S.grid}>
              <Field label="ID" hint="小写字母 / 数字 / 连字符">
                <input value={newId} onChange={(event) => setNewId(event.target.value)} placeholder="k3-reviewer" style={S.input} />
              </Field>
              <Field label="模型" hint="留空随默认路由">
                <input value={newEntry.model ?? ''} onChange={(event) => setNewEntry({ ...newEntry, model: event.target.value })} placeholder="k3-256k" style={S.input} />
              </Field>
            </div>
            <Field label="描述（模型可见）">
              <textarea
                value={newEntry.description ?? ''}
                onChange={(event) => setNewEntry({ ...newEntry, description: event.target.value })}
                placeholder="一句话说明这个角色做什么——模型靠它选人"
                rows={1}
                style={{ ...S.prose, overflow: 'auto' }}
              />
            </Field>
            <div className="dsh-library-grid" style={S.grid}>
              <Field label="Provider">
                <input value={newEntry.provider ?? ''} onChange={(event) => setNewEntry({ ...newEntry, provider: event.target.value })} placeholder="kimi-coding" style={S.input} />
              </Field>
              <Field label="传输层">
                <input value={newEntry.subagentProvider ?? ''} onChange={(event) => setNewEntry({ ...newEntry, subagentProvider: event.target.value })} placeholder="spawn（默认）" style={S.input} />
              </Field>
              <Field label="后台模式">
                <select
                  value={newEntry.backgroundMode ?? 'one-shot'}
                  onChange={(event) => setNewEntry({ ...newEntry, backgroundMode: event.target.value as 'one-shot' | 'continuable' })}
                  style={S.input}
                >
                  <option value="one-shot">one-shot</option>
                  <option value="continuable">continuable</option>
                </select>
              </Field>
              <Field label="深度上限">
                <input
                  type="number"
                  min={1}
                  value={newEntry.maxDepth ?? ''}
                  onChange={(event) => setNewEntry({ ...newEntry, maxDepth: event.target.value === '' ? undefined : Number(event.target.value) })}
                  style={S.input}
                />
              </Field>
              <Field label="输出上限">
                <input
                  type="number"
                  min={1}
                  value={newEntry.maxTokens ?? ''}
                  onChange={(event) => setNewEntry({ ...newEntry, maxTokens: event.target.value === '' ? undefined : Number(event.target.value) })}
                  placeholder="tokens"
                  style={S.input}
                />
              </Field>
            </div>
            <div className="dsh-library-grid" style={S.grid}>
              <Field label="思考强度">
                <input
                  value={newEntry.reasoningEffort ?? ''}
                  onChange={(event) => setNewEntry({ ...newEntry, reasoningEffort: event.target.value === '' ? undefined : event.target.value.trim() })}
                  placeholder="max / high / medium / low（留空随父会话默认）"
                  style={S.input}
                />
              </Field>
              <Field label="禁用工具" hint="英文逗号分隔；写入时只增删 deny，不触碰手写的 allow">
                <input
                  value={listToText(newEntry.toolFilter?.deny)}
                  onChange={(event) => {
                    const deny = parseList(event.target.value)
                    const allow = newEntry.toolFilter?.allow
                    const keepAllow = allow !== undefined && allow.length > 0
                    setNewEntry({
                      ...newEntry,
                      toolFilter: keepAllow || deny.length > 0
                        ? { ...(keepAllow ? { allow } : {}), ...(deny.length > 0 ? { deny } : {}) }
                        : undefined,
                    })
                  }}
                  placeholder="write, edit, todo_write, …"
                  style={S.input}
                />
              </Field>
            </div>
            <Field label="角色提示词（可选）">
              <AutoTextarea
                value={newEntry.persona ?? ''}
                onChange={(event) => setNewEntry({ ...newEntry, persona: event.target.value })}
                placeholder="子代理的系统提示词"
                style={S.prose}
              />
            </Field>
          </div>
        </div>
      )}

      {stats.total === 0 && (
        <div style={S.empty}>
          库为空。在上方填一个 id 与描述即可创建第一个条目，
          <br />
          或直接在名册目录放一个 <code>&lt;id&gt;.yaml</code>。
        </div>
      )}

      {stats.total > 0 && visibleIds.length === 0 && (
        <div style={S.empty}>没有匹配「{filter}」的条目。</div>
      )}

      {visibleIds.length > 0 && (
        <div style={S.listCaption}>
          <span>{needle === '' ? '角色名册' : `匹配 ${visibleIds.length} / ${stats.total} 个子代理`}</span>
          <span>点击名称展开配置</span>
        </div>
      )}

      <div style={S.list}>
        {visibleIds.map((id) => {
          const entry = entries[id]
          const isOpen = open[id] === true
          const dirty = dirtyIds.has(id)
          const off = entry.enabled === false
          const model = entry.model || ''
          const provider = entry.provider || ''
          const route = provider !== '' && model !== ''
            ? `${provider}/${model}`
            : model !== '' ? model : provider !== '' ? provider : '默认路由'
          return (
            <div key={id} className="dsh-library-card" data-entry-id={id} style={{ ...S.row, ...(isOpen ? S.rowOpen : null), ...(off ? S.rowOff : null) }}>
              <div style={S.head}>
                <button
                  type="button"
                  className="dsh-library-disclosure"
                  style={S.disclosure}
                  aria-expanded={isOpen}
                  aria-controls={`${sectionId}-${id}`}
                  aria-label={`${isOpen ? '收起' : '展开'} ${id} 的配置`}
                  data-row-id={id}
                  onClick={() => setOpen((current) => ({ ...current, [id]: !isOpen }))}
                >
                  <Chevron open={isOpen} />
                  <span style={S.titleRow}>
                    <span style={S.id}>{id}</span>
                    {entry.source === 'legacy' && <span style={S.chip}>旧版条目</span>}
                    {dirty && <span style={S.dirtyChip}>未保存</span>}
                  </span>
                </button>
                <label
                  style={S.headToggle}
                  title="切换后需保存此条目才会生效"
                >
                  <input
                    className="dsh-library-switch"
                    type="checkbox"
                    role="switch"
                    aria-label={`启用 ${id}`}
                    checked={!off}
                    onChange={(event) => patch(id, { enabled: event.target.checked ? undefined : false })}
                  />
                  <span>{off ? '已停用' : '已启用'}</span>
                </label>
              </div>

              <div style={S.overview}>
                <p style={S.excerpt} title={entry.description ?? ''}>
                  {entry.description || '暂无角色描述'}
                </p>
                <div style={S.route} title={`路由：${route}`}>
                  <span style={S.metaLabel}>模型</span>
                  <span style={S.model}>{model || '跟随默认模型'}</span>
                  {provider !== '' && <span style={S.provider}>{provider}</span>}
                </div>
                <div style={S.glyphs}>
                  <span style={entry.backgroundMode === 'continuable' ? S.modeChip : S.glyph}>
                    {entry.backgroundMode === 'continuable' ? '可续聊' : '单次任务'}
                  </span>
                  {entry.reasoningEffort && <span style={S.glyph}>思考 <span style={S.metaValue}>{entry.reasoningEffort}</span></span>}
                  {entry.maxDepth !== undefined && <span style={S.glyph}>深度 <span style={S.metaValue}>{entry.maxDepth}</span></span>}
                  {entry.maxTokens !== undefined && <span style={S.glyph}>输出 <span style={S.metaValue}>{entry.maxTokens.toLocaleString('en-US')}</span> tokens</span>}
                  {entry.persona && <span style={S.glyph}>角色提示词</span>}
                  {(entry.toolFilter?.deny?.length ?? 0) > 0 && <span style={S.glyph}>禁用 {entry.toolFilter!.deny!.length} 项工具</span>}
                  {(entry.toolFilter?.allow?.length ?? 0) > 0 && <span style={S.glyph}>允许 {entry.toolFilter!.allow!.length} 项工具</span>}
                </div>
              </div>

              {dirty && !isOpen && (
                <div style={S.draftActions}>
                  <span style={S.hint}>保存后生效</span>
                  <span style={S.spacer} />
                  <button type="button" disabled={busy} onClick={(event) => { focusDisclosure(event); revertEntry(id) }} style={S.ghost}>还原</button>
                  <button type="button" disabled={busy} onClick={(event) => { focusDisclosure(event); updateEntry(id, entry) }} style={S.primary}>保存修改</button>
                </div>
              )}

              <div id={`${sectionId}-${id}`} hidden={!isOpen}>
                {isOpen && <div style={S.body}>
                  <div style={S.group}>
                    <span style={S.groupTitle}>概述</span>
                    <Field label="描述（模型可见）" hint="模型用 list_subagents 读到的就是这句话，写清角色与适用场景">
                      <textarea
                        value={entry.description ?? ''}
                        onChange={(event) => patch(id, { description: event.target.value })}
                        placeholder="角色描述"
                        rows={1}
                        style={{ ...S.prose, overflow: 'auto' }}
                      />
                    </Field>
                  </div>

                  <div style={S.group}>
                    <span style={S.groupTitle}>路由与执行</span>
                    <div className="dsh-library-grid" style={S.grid}>
                      <Field label="Provider">
                        <input value={entry.provider ?? ''} onChange={(event) => patch(id, { provider: event.target.value })} placeholder="deepseek-official / kimi-coding" style={S.input} />
                      </Field>
                      <Field label="模型">
                        <input value={entry.model ?? ''} onChange={(event) => patch(id, { model: event.target.value })} placeholder="k3-256k" style={S.input} />
                      </Field>
                      <Field label="传输层" hint="留空用 spawn">
                        <input value={entry.subagentProvider ?? ''} onChange={(event) => patch(id, { subagentProvider: event.target.value })} placeholder="spawn（默认）" style={S.input} />
                      </Field>
                      <Field label="后台模式">
                        <select
                          value={entry.backgroundMode ?? 'one-shot'}
                          onChange={(event) => patch(id, { backgroundMode: event.target.value as 'one-shot' | 'continuable' })}
                          style={S.input}
                        >
                          <option value="one-shot">one-shot</option>
                          <option value="continuable">continuable</option>
                        </select>
                      </Field>
                    </div>
                    <div className="dsh-library-grid" style={S.grid}>
                      <Field label="思考强度" hint="留空随父会话默认">
                        <input
                          value={entry.reasoningEffort ?? ''}
                          onChange={(event) => patch(id, { reasoningEffort: event.target.value === '' ? undefined : event.target.value.trim() })}
                          placeholder="max / high / medium / low"
                          style={S.input}
                        />
                      </Field>
                      <Field label="深度上限">
                        <input
                          type="number"
                          min={1}
                          value={entry.maxDepth ?? ''}
                          onChange={(event) => patch(id, { maxDepth: event.target.value === '' ? undefined : Number(event.target.value) })}
                          style={S.input}
                        />
                      </Field>
                      <Field label="输出上限">
                        <input
                          type="number"
                          min={1}
                          value={entry.maxTokens ?? ''}
                          onChange={(event) => patch(id, { maxTokens: event.target.value === '' ? undefined : Number(event.target.value) })}
                          placeholder="tokens"
                          style={S.input}
                        />
                      </Field>
                    </div>
                  </div>

                  <div style={S.group}>
                    <span style={S.groupTitle}>工具与提示词</span>
                    <Field label="禁用工具" hint="英文逗号分隔；留空表示不限制。手写的 allow 列表会原样保留">
                      <input
                        value={listToText(entry.toolFilter?.deny)}
                        onChange={(event) => setDeny(id, event.target.value)}
                        placeholder="write, edit, todo_write, …"
                        style={S.input}
                      />
                    </Field>
                    <Field label="角色提示词（可选）">
                      <AutoTextarea
                        value={entry.persona ?? ''}
                        onChange={(event) => patch(id, { persona: event.target.value })}
                        placeholder="子代理的系统提示词"
                        style={S.prose}
                      />
                    </Field>
                  </div>

                  <div style={S.actions}>
                    {dirty
                      ? <span style={{ ...S.hint, color: DANGER }}>此条目有未保存修改</span>
                      : <span style={S.hint}>{entry.source === 'legacy' ? '来自 settings.yaml 的迁移副本' : '与名册文件一致'}</span>}
                    <span style={S.spacer} />
                    <button
                      type="button"
                      disabled={busy || !dirty}
                      onClick={() => revertEntry(id)}
                      style={{ ...S.ghost, opacity: busy || !dirty ? 0.45 : 1 }}
                      title="丢弃本行的未保存修改，恢复为服务器当前值"
                    >
                      还原
                    </button>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => removeEntry(id)}
                      style={{ ...S.danger, opacity: busy ? 0.55 : 1 }}
                    >
                      删除
                    </button>
                    <button
                      type="button"
                      disabled={busy || !dirty}
                      onClick={() => updateEntry(id, entry)}
                      style={{ ...S.primary, opacity: busy || !dirty ? 0.5 : 1 }}
                    >
                      保存
                    </button>
                  </div>
                </div>}
              </div>
            </div>
          )
        })}
      </div>

      {status !== null && (
        <div role="status" aria-live="polite" style={status.kind === 'ok' ? BANNER.ok : BANNER.error}>
          {status.text}
        </div>
      )}

      <details style={S.footer}>
        <summary style={S.footerSummary}>存储与备份说明</summary>
        <div style={S.hint}>
        配置存储于名册目录 <code style={{ fontFamily: MONO }}>{view.dir || '~/.dsh/subagents'}</code>（每具名子代理一个 <code>&lt;id&gt;.yaml</code>，可手编、热生效；<code>_</code> 前缀的文件/目录为非名册内容，如 <code>_backups/</code> 备份区）。
        让 agent 修改条目前，建议先把原文件复制到 <code>_backups/</code> 里。
        settings.yaml 中的旧 entries 仅作迁移兜底读取，文件优先生效。
        </div>
      </details>
    </div>
  )
}
