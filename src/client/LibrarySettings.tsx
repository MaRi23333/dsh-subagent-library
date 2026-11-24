/** The library and group editors share a server view; each row owns its draft. */
import { useCallback, useEffect, useId, useRef, useState } from 'react'
import type { InjectFace, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type { LibraryView, LibraryWrite, LibraryWriteResult, RoleUsage } from './index.tsx'
import { Action, availability, GroupFields, memberState, References, RoleFields } from './editor-fields.tsx'
import { equal, freshDraft, NEW, own, rebase, saveWrite, serverForm, validate, type Draft, type Form, type Tab } from './editor-state.ts'
import { BANNER, S, SETTINGS_CSS } from './settings-theme.ts'

export interface LibrarySettingsInjected {
  readView: () => Promise<LibraryView>
  writeView: (write: LibraryWrite) => Promise<LibraryWriteResult>
  subscribeRefresh: (fn: (revision?: number) => void) => () => void
}
export type LibrarySettingsProps = PropsRuntime<'settings.section'> & InjectFace<LibrarySettingsInjected>

type RowDraft = Draft & { references?: RoleUsage[]; awaitingCurrent?: boolean }
type DialogState = { title: string; content: React.ReactNode; label: string; confirm: () => void; destructive?: boolean }

function Modal({ dialog, close }: { dialog: DialogState; close: () => void }): React.ReactElement {
  const ref = useRef<HTMLDialogElement>(null)
  const id = useId()
  useEffect(() => {
    const node = ref.current
    node?.showModal()
    return () => { node?.close() }
  }, [])
  return <dialog className="library-dialog" ref={ref} aria-labelledby={id} onCancel={close}>
    <h3 id={id}>{dialog.title}</h3>{dialog.content}
    <div style={S.actions}><span style={S.spacer} />
      <Action action="cancel" autoFocus onClick={close}>取消</Action>
      <Action action="confirm" tone={dialog.destructive ? 'danger' : 'primary'} onClick={() => { close(); dialog.confirm() }}>{dialog.label}</Action>
    </div>
  </dialog>
}

function CompareForm({ form }: { form?: Form }): React.ReactElement {
  if (!form) return <p>条目已删除或尚未创建。</p>
  const rows: Array<[string, string]> = [['ID', form.id], ['状态', form.enabled ? '已启用' : '已停用'], ['描述', form.description]]
  if (form.kind === 'groups') {
    rows.push(['名称', form.name], ['共享说明', form.instructions])
    form.members.forEach(m => rows.push([m.slot || '成员', [m.role, m.assignment].filter(Boolean).join(' / ')]))
  } else {
    rows.push(['Provider', form.provider], ['模型', form.model], ['思考档位', form.reasoningEffort], ['输出上限', form.maxTokens],
      ['传输层', form.subagentProvider], ['深度上限', form.maxDepth], ['角色人设', form.persona])
    if (form.inherit || form.routeNote) rows.push(['路由状态', form.inherit ? '保存后使用会话模型' : ({
      profile: '当前 profile 路由', inherit: '使用会话模型', 'foreign-ignored': '共享 Provider 未注册',
      'profile-missing': '当前 Provider 未注册', 'overlay-broken': '路由无法读取',
    }[form.routeNote!])])
    if (form.filter) rows.push(['旧工具限制', form.clearToolFilter ? '保存时解除' : JSON.stringify(form.filter)])
  }
  return <dl>{rows.map(([name, value], i) => <div key={i}><dt>{name}</dt><dd>{value || '—'}</dd></div>)}</dl>
}

export function LibrarySettings({ readView, writeView, subscribeRefresh }: LibrarySettingsProps): React.ReactElement {
  const scope = useId()
  const root = useRef<HTMLDivElement>(null)
  const [view, setView] = useState<LibraryView | null>(null)
  const [tab, setTab] = useState<Tab>('roles')
  const [filters, setFilters] = useState({ roles: '', groups: '' })
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})
  const [drafts, setDrafts] = useState<Record<string, RowDraft>>({})
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<{ text: string; error?: boolean }>()
  const [dialog, setDialog] = useState<DialogState>()
  const active = useRef(false)
  const writing = useRef(false)
  const pendingRefresh = useRef(false)
  const readNumber = useRef(0)
  const load = useCallback(async (manual = false) => {
    if (writing.current) { pendingRefresh.current = true; return }
    const request = ++readNumber.current
    try {
      const latest = await readView()
      if (!active.current || request !== readNumber.current) return
      setView(latest)
      setDrafts(rows => {
        if (!Object.values(rows).some(row => row.awaitingCurrent)) return rows
        return Object.fromEntries(Object.entries(rows).map(([id, row]) =>
          [id, row.awaitingCurrent ? { ...row, awaitingCurrent: false } : row]))
      })
      if (manual) setNotice({ text: '已读取当前配置。' })
    } catch (error) {
      if (active.current && request === readNumber.current) setNotice({ text: String(error), error: true })
    }
  }, [readView])
  useEffect(() => {
    active.current = true
    void load()
    const unsubscribe = subscribeRefresh(() => { void load() })
    return () => { active.current = false; readNumber.current++; unsubscribe() }
  }, [load, subscribeRefresh])

  const keyFor = (kind: Tab, id: string) => kind + '/' + id
  const key = (id: string) => keyFor(tab, id)
  const label = tab === 'roles' ? '角色' : '编队'
  const readonly = busy || !view?.writable
  function put(k: string, draft: RowDraft | undefined) {
    setDrafts(current => {
      const next = { ...current }
      if (draft) next[k] = draft
      else delete next[k]
      return next
    })
  }
  function reveal(id: string, slot?: string) {
    requestAnimationFrame(() => {
      const card = root.current?.querySelector<HTMLElement>(`[data-card="${CSS.escape(id)}"]`)
      const member = slot && card?.querySelector<HTMLElement>(`[data-slot-key="${CSS.escape(slot)}"] [data-field="slot"]`)
      const target = member || card?.querySelector<HTMLButtonElement>('[data-row-id]')
      target?.focus({ preventScroll: true })
      target?.scrollIntoView({ block: 'nearest' })
    })
  }
  function jump(ref: RoleUsage) {
    setTab('groups')
    setFilters(old => ({ ...old, groups: '' }))
    setExpanded(old => ({ ...old, [keyFor('groups', ref.groupId)]: true }))
    setNotice(undefined)
    reveal(ref.groupId, ref.slot)
  }
  function changeTab(next: Tab, focus: boolean) {
    setTab(next)
    setNotice(undefined)
    if (focus) requestAnimationFrame(() => root.current?.querySelector<HTMLButtonElement>(`[data-tab="${next}"]`)?.focus())
  }

  async function write(operation: LibraryWrite, row?: { id: string; draft: RowDraft }, success = '已保存。') {
    if (writing.current) return
    writing.current = true
    readNumber.current++ // An older GET must never replace the write response.
    setBusy(true)
    setNotice(undefined)
    const k = row && key(row.id)
    try {
      const result = await writeView(operation)
      if (!active.current) return
      if (result.ok) {
        setView(result.view)
        if (k && row) {
          put(k, undefined)
          setExpanded(old => ({ ...old, [k]: false }))
          if (operation.op === 'save-entry' || operation.op === 'save-group') reveal(operation.id)
          else requestAnimationFrame(() => root.current?.querySelector<HTMLButtonElement>('[data-action="new"]')?.focus())
        }
        setNotice({ text: success })
      } else {
        if (result.view) setView(result.view)
        if (k && row) {
          put(k, { ...row.draft, conflict: result.conflict,
            message: result.conflict ? undefined : result.message ?? '保存失败。',
            references: result.references, awaitingCurrent: result.conflict && !result.view })
          setExpanded(old => ({ ...old, [k]: true }))
          if (result.conflict && !result.view) pendingRefresh.current = true
          if (result.references?.length && !result.view) pendingRefresh.current = true
        } else setNotice({ text: result.message ?? '配置发生变化，请刷新后重试。', error: true })
      }
    } catch (error) {
      if (active.current) setNotice({ text: String(error), error: true })
    } finally {
      writing.current = false
      if (active.current) {
        setBusy(false)
        if (pendingRefresh.current) { pendingRefresh.current = false; void load() }
      }
    }
  }

  if (!view) return <div className="dsh-library" style={S.root}><style>{SETTINGS_CSS}</style>
    <h2 style={S.heading}>子代理库</h2><span role="status">{notice?.text ?? '正在加载…'}</span>
    <div><Action action="refresh" onClick={() => void load(true)}>重试</Action></div></div>
  const currentView = view
  function add() {
    const k = key(NEW)
    put(k, freshDraft(currentView, tab, NEW))
    setExpanded(old => ({ ...old, [k]: true }))
    setNotice(undefined)
    reveal(NEW)
  }
  function compare(id: string, draft: RowDraft) {
    const current = serverForm(currentView, tab, id === NEW ? draft.form.id.trim() : id)
    const collision = id === NEW && !!current
    const recreate = !current && id !== NEW
    const competingMembers = draft.form.kind === 'groups' && draft.base?.kind === 'groups' && current?.kind === 'groups'
      && !equal(draft.base.members, draft.form.members) && !equal(draft.base.members, current.members) && !equal(current.members, draft.form.members)
    setDialog({ title: '配置版本有冲突', label: collision ? '返回更换 ID' : recreate ? '保留草稿为新条目' : '保留草稿，继续编辑',
      content: <><div className="library-compare"><article><strong>当前配置</strong><CompareForm form={current} /></article>
        <article><strong>你的草稿</strong><CompareForm form={draft.form} /></article></div>
        {competingMembers && <p style={BANNER.warn}>双方都修改了编队成员。保留草稿将采用你这份完整的成员名单和分工。</p>}
        {collision ? <p>这个 ID 已有配置。请为新条目更换 ID 后再创建。</p>
          : <p>保留已编辑的字段，其他字段采用当前配置。{recreate ? '再次保存将重新创建这个条目。' : '再次保存才会写入配置。'}</p>}</>,
      confirm: () => {
        if (!collision) { put(key(id), rebase(draft, current)); return }
        requestAnimationFrame(() => root.current?.querySelector<HTMLInputElement>('[data-card="@new"] [data-field="id"]')?.focus())
      } })
  }
  function remove(id: string, draft: RowDraft) {
    const refs = tab === 'roles' ? own(currentView.roleUsages, id) : undefined
    if (refs?.length) {
      put(key(id), { ...draft, references: refs })
      return
    }
    setDialog({ title: '删除' + label, label: '确认删除', destructive: true,
      content: <p>确定删除 <strong>{draft.form.kind === 'groups' && draft.form.name || id}</strong>？{tab === 'groups' && '名册中的角色仍可单独使用。'}</p>,
      confirm: () => void write({ op: tab === 'roles' ? 'delete' : 'delete-group', id, expectedHash: currentView.hash }, { id, draft }, '已删除' + label + ' ' + id + '。') })
  }
  const needle = filters[tab].trim().toLowerCase()
  const serverIds = Object.keys(tab === 'roles' ? view.entries : view.groups)
  const ids = [...new Set([
    ...Object.keys(drafts).filter(k => k.startsWith(tab + '/') && !serverIds.includes(k.slice(tab.length + 1))).map(k => k.slice(tab.length + 1)),
    ...serverIds,
  ])].filter(id => {
    if (!needle || id === NEW || drafts[key(id)] && expanded[key(id)]) return true
    const form = drafts[key(id)]?.form ?? serverForm(view, tab, id)
    return form && [id, form.description, ...(form.kind === 'roles'
      ? [form.model, form.provider, form.persona, form.reasoningEffort] : [form.name])].some(s => s.toLowerCase().includes(needle))
  })

  return <div ref={root} className="dsh-library" style={S.root}>
    <style>{SETTINGS_CSS}</style>
    <header style={S.headingRow}><h2 style={S.heading}>子代理库</h2><span style={S.spacer} />
      <Action action="refresh" disabled={busy} onClick={() => void load(true)}>刷新</Action></header>
    <div className="library-tabs" role="tablist" aria-label="设置分类">
      {(['roles', 'groups'] as const).map(kind => <button key={kind} type="button" role="tab" data-tab={kind}
        id={scope + kind} aria-controls={scope + '-panel'} aria-selected={tab === kind} tabIndex={tab === kind ? 0 : -1}
        onClick={() => changeTab(kind, false)} onKeyDown={e => {
          if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) {
            e.preventDefault()
            changeTab(e.key === 'Home' ? 'roles' : e.key === 'End' ? 'groups' : tab === 'groups' ? 'roles' : 'groups', true)
          }
        }}>{kind === 'roles' ? '角色名册' : '编队'}</button>)}
    </div>
    <section role="tabpanel" id={scope + '-panel'} aria-labelledby={scope + tab} className="library-panel">
      <div style={BANNER.info}>{tab === 'roles'
        ? <span>{view.profile && <><strong>当前 profile：<code>{view.profile}</code></strong>。</>}角色配置由引用它的编队共享。{view.profile && '模型路由按 profile 保存。'}</span>
        : '编队支持逐个派遣，开启或关闭智能体团队均可使用。'}</div>
      {view.diagnostics?.length ? <details style={BANNER.warn}><summary>配置诊断（{view.diagnostics.length}）</summary>
        {view.diagnostics.map((item, i) => <div key={i}>{item.file ?? item.id} {item.message}</div>)}</details> : null}
      {tab === 'roles' && (view.legacyCount ?? 0) > 0 && <div style={BANNER.info}>
        <span>名册已接管 {view.legacyCount} 个旧条目。确认迁移后可清除旧配置中的角色副本。</span>
        <div><Action action="clear-legacy" disabled={readonly} onClick={() => setDialog({ title: '清除旧副本', label: '确认清除',
          content: <p>清除旧配置中已迁移的角色副本？名册文件会保留。</p>, destructive: true,
          confirm: () => void write({ op: 'clear-legacy', expectedHash: view.hash }, undefined, '已清除旧副本。') })}>清除旧副本</Action></div></div>}
      <div style={S.bar}><label className="library-search" style={S.search}><svg aria-hidden="true" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="10.5" cy="10.5" r="5.5"/><path d="m15 15 5 5"/></svg>
        <input type="search" aria-label={'筛选' + label} value={filters[tab]} placeholder={tab === 'roles' ? '筛选角色 ID、描述、模型' : '筛选编队名称、ID、描述'}
          onChange={e => setFilters({ ...filters, [tab]: e.target.value })} style={S.searchInput} /></label>
        <Action action="new" tone="primary" disabled={readonly || !!drafts[key(NEW)]} onClick={add}><span aria-hidden="true">＋ </span>新建{label}</Action></div>
      {notice && <div role="status" style={notice.error ? BANNER.error : BANNER.ok}>{notice.text}</div>}
      <div style={S.list}>{!ids.length && <div style={S.empty}>{needle ? '没有匹配的条目。' : '暂无' + label + '。'}</div>}
        {ids.map(id => {
          const k = key(id)
          const draft = drafts[k] ?? freshDraft(view, tab, id)
          const form = draft.form
          const open = Boolean(expanded[k])
          const isNew = id === NEW
          const current = serverForm(view, tab, isNew ? form.id.trim() : id)
          const collision = isNew && !!current
          const stale = Boolean(draft.conflict || !equal(draft.base, current))
          const dirty = !equal(draft.base, form)
          const refs = own(view.roleUsages, id) ?? []
          const blocked = form.kind === 'groups' ? form.members.filter(m => memberState(view, form, m)).length : 0
          const roleState = form.kind === 'roles' && availability(own(view.entries, id))
          const contentId = scope + tab + id
          function change(next: Form) {
            put(k, equal(draft.base, next) && !stale ? undefined : { ...draft, form: next, message: undefined, references: undefined,
              conflict: isNew && form.id !== next.id && !draft.awaitingCurrent ? false : draft.conflict })
            setNotice(undefined)
          }
          return <article key={k} className="dsh-library-card" data-card={id} style={{ ...S.row, ...(!form.enabled && S.rowOff), ...(open && S.rowOpen) }}>
            <div style={S.head}><button type="button" style={S.disclosure} className="dsh-library-disclosure" data-row-id={id} data-action="toggle"
              aria-expanded={open} aria-controls={contentId} onClick={() => setExpanded(old => ({ ...old, [k]: !open }))}>
              <span aria-hidden="true" style={{ ...S.chevron, transform: open ? 'rotate(90deg)' : undefined }}>❯</span>
              <span style={S.titleRow}><strong style={form.kind === 'roles' ? S.id : undefined}>{isNew ? '新建' + label : form.kind === 'groups' ? form.name || id : id}</strong>
                {dirty && !isNew && <span style={S.dirtyChip}>未保存</span>}{stale && <span style={S.dirtyChip}>版本冲突</span>}</span></button>
              <label style={S.headToggle}><input className="dsh-library-switch" type="checkbox" role="switch" data-field="enabled" aria-label={label + '启用状态'}
                checked={form.enabled} disabled={readonly} onChange={e => { change({ ...form, enabled: e.target.checked }); setExpanded(old => ({ ...old, [k]: true })) }} />
                {form.enabled ? '已启用' : '已停用'}</label></div>
            {!open && <div style={S.overview}><p style={S.excerpt}>{form.description || '填写' + label + '的用途。'}</p>
              <div style={S.route}>{form.kind === 'groups'
                ? <><span style={S.metaLabel}>{form.members.length} 名成员</span>{blocked > 0 && <span style={S.dirtyChip}>{blocked} 名暂时无法派遣</span>}</>
                : <><span style={S.metaLabel}>模型</span><code style={S.model}>{form.model || '跟随会话'}</code>
                  {form.provider && <code style={S.provider}>{form.provider}</code>}{form.reasoningEffort && <span style={S.glyph}>思考 {form.reasoningEffort}</span>}
                  {refs.length > 0 && <span style={S.glyph}>{refs.length} 名编队成员在用</span>}{roleState && !isNew && <span style={S.dirtyChip}>{roleState}</span>}</>}</div></div>}
            <div id={contentId} hidden={!open}>{open && <fieldset disabled={readonly} className="library-editor" style={S.body}>
              {stale && <div role="alert" style={BANNER.warn}>{collision ? '这个 ID 已有配置，请更换 ID 再创建。' : '配置已在别处更新，你的草稿已保留。'}
                <div>{draft.awaitingCurrent
                  ? <Action action="refresh" onClick={() => void load(true)}>重新读取当前版本</Action>
                  : <Action action="compare" className="library-link" onClick={() => compare(id, draft)}>查看当前版本</Action>}</div></div>}
              {draft.references?.length ? <div role="alert" style={BANNER.warn}>
                <References refs={draft.references} view={view} jump={jump} title="无法删除，以下编队成员还在使用这个角色" />
                <span>请给这些成员更换角色，或将他们移出编队后再删除。</span></div>
                : form.kind === 'roles' && draft.message && <div role="alert" style={BANNER.warn}>{draft.message}</div>}
              {form.kind === 'roles' ? <RoleFields {...{ form, isNew, change, view, refs, jump }} /> : <GroupFields {...{ form, isNew, change, view }} message={draft.message} />}
              <div style={S.actions}>{!isNew && current && <Action action="delete" tone="danger" disabled={stale} onClick={() => remove(id, draft)}>删除{label}</Action>}
                <span style={S.spacer} />
                {(dirty || stale) && <Action action="revert" tone="ghost" onClick={() => {
                  put(k, undefined)
                  if (isNew) requestAnimationFrame(() => root.current?.querySelector<HTMLButtonElement>('[data-action="new"]')?.focus())
                  else reveal(id)
                }}>{isNew ? '取消' : '还原草稿'}</Action>}
                <Action action="save" tone="primary" disabled={!dirty || stale} onClick={() => {
                  const error = validate(form, view, isNew, draft.base)
                  if (error) { put(k, { ...draft, message: error }); return }
                  const impact = form.kind === 'roles' && !form.enabled && draft.base?.enabled && refs.length ? ` ${refs.length} 名编队成员暂时无法派遣。` : ''
                  void write(saveWrite(draft, view), { id, draft }, `已保存${label} ${form.id.trim()}。${impact}`)
                }}>{isNew ? '创建' + label : '保存修改'}</Action></div>
            </fieldset>}</div>
          </article>
        })}</div>
      <details style={S.footer}><summary style={S.footerSummary}>存储与备份说明</summary><p style={S.hint}>
        角色保存在 <code>{view.dir || '~/.dsh/subagents/'}</code>，编队位于该目录下的 <code>_groups/</code>。
        备份时一并保留角色文件、编队和 <code>_profiles/</code> 中的模型路由。</p></details>
    </section>
    {dialog && <Modal dialog={dialog} close={() => setDialog(undefined)} />}
  </div>
}
