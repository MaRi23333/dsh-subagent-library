import { useCallback, useId, useRef, useState } from 'react'
import { entryIdIssue, MAX_ID_LENGTH, memberCodeErrors } from '../entry-id.ts'
import type { LibraryView, RoleUsage, StoredEntry } from './index.tsx'
import { emptyMember, own, type Form, type GroupForm, type RoleForm } from './editor-state.ts'
import { BANNER, S } from './settings-theme.ts'

export function Action({ action, tone = 'button', children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement> & {
  action: string
  tone?: 'button' | 'primary' | 'ghost' | 'danger'
}): React.ReactElement {
  return <button {...props} type="button" data-action={action} style={{ ...S[tone], ...props.style }}>{children}</button>
}

function Field({ label, name, value, change, multiline, hint, describedBy, ...props }: {
  label: string
  name: string
  value: string
  change?: (value: string) => void
  multiline?: boolean
  hint?: string
  describedBy?: string
  placeholder?: string
  min?: number
  readOnly?: boolean
}): React.ReactElement {
  const id = useId()
  const hintId = hint ? `${id}-hint` : undefined
  const description = [describedBy, hintId].filter(Boolean).join(' ') || undefined
  return <div style={S.field}><label htmlFor={id} style={S.fieldLabel}>{label}</label>
    {multiline
      ? <textarea id={id} aria-describedby={description} data-field={name} value={value} rows={name === 'assignment' ? 1 : 2} placeholder={props.placeholder}
          onChange={e => change?.(e.target.value)} style={S.prose} />
      : <input {...props} id={id} aria-describedby={description} data-field={name} type={props.min === undefined ? 'text' : 'number'} value={value}
          onChange={e => change?.(e.target.value)} style={S.input} />}
    {hint && <span id={hintId} className="library-field-note" style={S.hint}>{hint}</span>}
  </div>
}

export function References({ refs, view, jump, title }: {
  refs: RoleUsage[]
  view: LibraryView
  jump: (ref: RoleUsage) => void
  title: string
}): React.ReactElement {
  return <div className="library-refs"><strong>{title}</strong><ul>{refs.map(ref =>
    <li key={ref.groupId + '/' + ref.slot}><Action action="jump" data-group={ref.groupId} data-slot-id={ref.slot}
      className="library-link" onClick={() => jump(ref)}>{own(view.groups, ref.groupId)?.name || ref.groupId} / <code>{ref.slot}</code></Action></li>
  )}</ul></div>
}

export function availability(role: StoredEntry | undefined): string {
  if (!role) return '角色缺失'
  if (role.enabled === false) return '角色已停用'
  if (role.toolFilter) return '旧工具限制'
  if (role.launchable === false) {
    if (role.routeNote === 'profile-missing') return '当前 Provider 未注册'
    if (role.routeNote === 'overlay-broken') return '当前路由无法读取'
    if (role.maxDepth === 0 || role.reason?.startsWith('maxDepth is 0')) return '深度上限为 0'
    if (role.reason?.includes('native named activations')) return '宿主缺少原生具名派遣支持'
    if (role.reason?.startsWith('subagent transport provider')) return '传输层未注册'
    if (role.reason?.startsWith('Transport ')) return '传输层无法执行当前配置'
    return '暂时无法派遣'
  }
  return ''
}

export function memberState(view: LibraryView, form: GroupForm, member: GroupForm['members'][number]): string {
  if (!form.enabled) return '编队已停用'
  if (!member.role) return ''
  const reason = availability(own(view.entries, member.role))
  if (reason) return reason
  const saved = own(view.groups, form.id)
  if (saved && saved.enabled !== false && saved.members.some(m =>
    m.slot === member.slot && m.role === member.role && m.launchable === false)) return '暂时无法派遣'
  return ''
}

const notes: Record<NonNullable<StoredEntry['routeNote']>, string> = {
  'profile': '使用当前 profile 的独立路由。',
  'inherit': '当前 profile 已设置为跟随会话。',
  'foreign-ignored': '共享 Provider 未在此 profile 注册，当前跟随会话。',
  'profile-missing': '当前 profile 的 Provider 尚未注册，可更换 Provider 或使用会话模型。',
  'overlay-broken': '当前 profile 的路由无法读取，可重新设置或使用会话模型。',
}

export function RoleFields({ form, isNew, change, view, refs, jump }: {
  form: RoleForm
  isNew: boolean
  change: (next: Form) => void
  view: LibraryView
  refs: RoleUsage[]
  jump: (ref: RoleUsage) => void
}): React.ReactElement {
  const patch = (values: Partial<RoleForm>) => change({ ...form, ...values })
  const route = (field: 'provider' | 'model' | 'reasoningEffort' | 'maxTokens', value: string) => patch({ [field]: value, inherit: false })
  const saved = own(view.entries, form.id)
  const routeReadOnly = !!view.routeWriteProblem
  const hasRoute = [form.provider, form.model, form.reasoningEffort, form.maxTokens].some(value => value.trim())
  const clearRoute = (inherit: boolean) => patch({ inherit, provider: '', model: '', reasoningEffort: '', maxTokens: '' })
  return <>
    {saved?.launchable === false && saved.enabled !== false && !saved.toolFilter && <div style={BANNER.warn}>
      <strong>{availability(saved)}</strong>{saved.reason && <span>{saved.reason}</span>}</div>}
    {isNew && <Field name="id" label="角色 ID" value={form.id} change={id => patch({ id })} placeholder="reviewer" />}
    <Field name="description" label="角色描述" multiline value={form.description} change={description => patch({ description })} />
    <div><h3>{view.profile || routeReadOnly ? '模型路由' : '共享模型路由'}{view.profile && <span style={S.hint}> · {view.profile}</span>}</h3>
      <p style={S.hint}>{view.routeWriteProblem ?? (view.profile
        ? (form.routeNote ? notes[form.routeNote] : '模型与思考档位只应用于当前 profile。')
        : '这里编辑角色的共享默认路由。全部留空后保存，共享默认将跟随会话。共享路由变更后，绑定旧默认路由的 profile 需重新设置。')}</p></div>
    <div className="library-grid" style={S.grid}>
      <Field name="provider" label="Provider" value={form.provider} change={v => route('provider', v)} readOnly={routeReadOnly} placeholder="跟随会话" />
      <Field name="model" label="模型" value={form.model} change={v => route('model', v)} readOnly={routeReadOnly} placeholder="跟随会话" />
      <Field name="reasoningEffort" label="思考档位" value={form.reasoningEffort} change={v => route('reasoningEffort', v)} readOnly={routeReadOnly} placeholder="例如 high" />
      <Field name="maxTokens" label="输出上限" value={form.maxTokens} change={v => route('maxTokens', v)} readOnly={routeReadOnly} min={1} placeholder="tokens" />
    </div>
    {!routeReadOnly && <div>{view.profile
      ? <Action action="inherit" disabled={form.inherit || form.routeNote === 'inherit' && !hasRoute} onClick={() => clearRoute(true)}>
        {form.inherit ? '保存后使用会话模型' : '使用会话模型'}</Action>
      : <Action action="clear-shared-route" disabled={!hasRoute} onClick={() => clearRoute(false)}>清空共享路由</Action>}</div>}
    <div className="library-grid" style={S.grid}>
      <Field name="subagentProvider" label="传输层" value={form.subagentProvider} change={subagentProvider => patch({ subagentProvider })} placeholder="spawn（默认）" />
      <Field name="maxDepth" label="深度上限" value={form.maxDepth} change={maxDepth => patch({ maxDepth })} min={0} placeholder="跟随宿主"
        hint="留空时跟随宿主。填写后使用宿主与角色上限中较低的值，填 0 禁止派遣。" />
    </div>
    <Field name="persona" label="角色人设" multiline value={form.persona} change={persona => patch({ persona })} />
    {form.filter && <div style={BANNER.warn}><strong>旧工具限制</strong>
      <span>这个角色的工具限制无法在当前宿主执行。解除限制后可按宿主的权限派遣。</span>
      {form.filter.allow && <span>允许：<code>{form.filter.allow.join(', ') || '空列表'}</code></span>}
      {form.filter.deny && <span>禁用：<code>{form.filter.deny.join(', ') || '空列表'}</code></span>}
      <label><input type="checkbox" data-field="clearToolFilter" checked={form.clearToolFilter}
        onChange={e => patch({ clearToolFilter: e.target.checked })} /> 保存时解除旧工具限制</label>
    </div>}
    {refs.length > 0 && <div style={form.enabled ? BANNER.info : BANNER.warn}>
      <References refs={refs} view={view} jump={jump} title={form.enabled ? '使用此角色的编队成员' : '停用角色后，以下成员将无法派遣'} />
    </div>}
  </>
}

function copySelection(id: string, doc: Document): boolean {
  const focused = doc.activeElement as HTMLElement | null
  const input = doc.createElement('textarea')
  input.value = id
  input.readOnly = true
  Object.assign(input.style, { position: 'fixed', inset: '0 auto auto 0', opacity: '0', pointerEvents: 'none' })
  doc.body.append(input)
  try {
    input.focus({ preventScroll: true })
    input.select()
    return doc.execCommand('copy')
  } catch {
    return false
  } finally {
    input.remove()
    focused?.focus({ preventScroll: true })
  }
}

function RoleIdCopy({ id }: { id: string }): React.ReactElement {
  const [status, setStatus] = useState<'copied' | 'manual'>()
  const manualInput = useRef<HTMLInputElement | null>(null)
  const trigger = useRef<HTMLButtonElement>()
  const selectId = useCallback((input: HTMLInputElement | null) => {
    manualInput.current = input
    // Keep focus where the user moved it while awaiting clipboard permission.
    if (trigger.current?.matches(':focus')) {
      input?.focus({ preventScroll: true })
      input?.select()
    }
  }, [])

  async function copy(event: React.MouseEvent<HTMLButtonElement>) {
    const button = event.currentTarget
    trigger.current = button
    try {
      await navigator.clipboard.writeText(id)
      setStatus('copied')
      return
    } catch {
      if (!button.isConnected) return
    }
    if (copySelection(id, button.ownerDocument)) { setStatus('copied'); return }
    setStatus('manual')
    selectId(manualInput.current)
  }

  return <>
    <div className="library-field-actions">
      <Action action="copy-role-id" className="library-link" aria-label="复制角色 ID" onClick={copy}>复制 ID</Action>
      <span style={S.hint} role="status">{status === 'copied' ? '已复制' : status === 'manual' ? '请手动复制下方 ID' : ''}</span>
    </div>
    {status === 'manual' && <input ref={selectId} data-field="role-id" aria-label="角色 ID" style={S.input}
      value={id} readOnly onFocus={event => event.currentTarget.select()} />}
  </>
}

export function GroupFields({ form, isNew, change, view, message }: {
  form: GroupForm
  isNew: boolean
  change: (next: Form) => void
  view: LibraryView
  message?: string
}): React.ReactElement {
  const id = useId()
  const rulesId = `${id}-slot-rules`
  const list = useRef<HTMLOListElement>(null)
  const addButton = useRef<HTMLDivElement>(null)
  const slots = form.members.map(member => member.slot)
  const slotErrors = memberCodeErrors(slots)
  const usedSlots = new Set(slots.map(slot => slot.trim()))
  const patch = (values: Partial<GroupForm>) => change({ ...form, ...values })
  const patchMember = (i: number, values: Partial<GroupForm['members'][number]>) =>
    patch({ members: form.members.map((member, index) => index === i ? { ...member, ...values } : member) })
  const focus = (i: number) => requestAnimationFrame(() => {
    const input = list.current?.children[i]?.querySelector<HTMLInputElement>('[data-field="slot"]')
    const target = input ?? addButton.current?.querySelector('button')
    target?.focus()
  })
  function move(i: number, to: number) {
    const members = [...form.members]
    const [member] = members.splice(i, 1)
    members.splice(to, 0, member)
    patch({ members })
    focus(to)
  }
  return <>
    <div style={BANNER.warn}>
      <span id={rulesId} data-slot-rules>{isNew ? '编队 ID 和成员代号' : '成员代号'}请用小写字母、数字或短横线，最多 {MAX_ID_LENGTH} 个字符。中间不能有空格，开头不能用短横线。组内代号不能重复。</span>
      {message && <strong role="alert">{message}</strong>}
    </div>
    <div className="library-grid" style={S.grid}>
      <Field name="name" label="编队名称" value={form.name} change={name => patch({ name })} placeholder="留空时使用编队 ID" />
      <Field name="id" label="编队 ID" value={form.id} change={id => patch({ id })} describedBy={isNew ? rulesId : undefined} readOnly={!isNew} placeholder="change-review" />
    </div>
    <Field name="description" label="编队描述" multiline value={form.description} change={description => patch({ description })} />
    <Field name="instructions" label="共享说明" multiline value={form.instructions} change={instructions => patch({ instructions })} />
    <div className="library-members-head" ref={addButton}><h3>编队成员</h3>
      <Action action="add-slot" onClick={() => { patch({ members: [...form.members, emptyMember()] }); focus(form.members.length) }}>＋ 添加成员</Action>
    </div>
    {!form.members.length && <div style={S.empty}>添加至少一名成员。</div>}
    <ol className="library-members" ref={list}>{form.members.map((member, i) => {
      const role = own(view.entries, member.role)
      const state = memberState(view, form, member)
      const slotId = `${id}-slot-${i}`
      const error = (member.slot || member.role) && slotErrors[i]
      const errorId = `${slotId}-error`
      const canUseRoleId = role && !member.slot.trim() && !entryIdIssue(member.role)
      const roleIdUsed = canUseRoleId && usedSlots.has(member.role)
      return <li key={i} data-slot={i} data-slot-key={member.slot}>
        <div className="library-member-head"><strong>成员 {i + 1}</strong>
          {state && <span style={S.dirtyChip}>{state}</span>}
          <span style={S.spacer} />
          <Action action="up" aria-label={`上移成员 ${i + 1}`} title="上移" disabled={i === 0} onClick={() => move(i, i - 1)}>↑</Action>
          <Action action="down" aria-label={`下移成员 ${i + 1}`} title="下移" disabled={i + 1 === form.members.length} onClick={() => move(i, i + 1)}>↓</Action>
          <Action action="remove" tone="danger" aria-label={`移除成员 ${i + 1}`} onClick={() => {
            patch({ members: form.members.filter((_, n) => n !== i) }); focus(Math.min(i, form.members.length - 2))
          }}>移除</Action>
        </div>
        <div className="library-grid" style={S.grid}>
          <div style={S.field}>
            <label htmlFor={slotId} style={S.fieldLabel}>成员代号</label>
            <input id={slotId} style={S.input} data-field="slot" value={member.slot} placeholder="例如 review"
              autoComplete="off" autoCapitalize="none" spellCheck={false} aria-invalid={!!error || undefined}
              aria-describedby={error ? `${rulesId} ${errorId}` : rulesId} onChange={e => patchMember(i, { slot: e.target.value })} />
            <span id={errorId} data-slot-error className="library-field-error" aria-live="polite">{error}</span>
            {canUseRoleId && <div className="library-field-actions">
              <Action action="use-role-id" className="library-link" disabled={roleIdUsed}
                onClick={() => { patchMember(i, { slot: member.role }); focus(i) }}>用角色 ID</Action>
              {roleIdUsed && <span style={S.hint}>此代号已使用</span>}
            </div>}
          </div>
          <div style={S.field}>
            <label htmlFor={`${slotId}-role`} style={S.fieldLabel}>角色</label>
            <select id={`${slotId}-role`} style={S.input} data-field="role" value={member.role} onChange={e => patchMember(i, { role: e.target.value })}>
              <option value="">选择名册中的角色</option>
              {member.role && !role && <option value={member.role}>{member.role} · 角色缺失</option>}
              {Object.entries(view.entries).map(([id, row]) => <option key={id} value={id}>{id}{availability(row) && ' · ' + availability(row)}</option>)}
            </select>
            {member.role && <RoleIdCopy key={member.role} id={member.role} />}
          </div>
        </div>
        <Field name="assignment" label="默认分工" multiline value={member.assignment}
          change={assignment => patchMember(i, { assignment })} placeholder="例如：检查这次改动会不会影响已有功能" />
      </li>
    })}</ol>
  </>
}
