import type { LibraryView, LibraryWrite, RouteFields, StoredEntry, StoredGroup } from './index.tsx'
import { entryIdIssue, memberCodeErrors } from '../entry-id.ts'

export type Tab = 'roles' | 'groups'
export const NEW = '@new'
export const own = <T,>(rows: Record<string, T>, id: string): T | undefined =>
  Object.hasOwn(rows, id) ? rows[id] : undefined

interface BasicForm {
  id: string
  description: string
  enabled: boolean
}
export interface RoleForm extends BasicForm {
  kind: 'roles'
  provider: string
  model: string
  reasoningEffort: string
  maxTokens: string
  maxDepth: string
  subagentProvider: string
  persona: string
  filter?: StoredEntry['toolFilter']
  routeNote?: StoredEntry['routeNote']
  inherit: boolean
  clearToolFilter: boolean
}
export interface MemberForm {
  slot: string
  role: string
  assignment: string
}
export interface GroupForm extends BasicForm {
  kind: 'groups'
  name: string
  instructions: string
  members: MemberForm[]
}
export type Form = RoleForm | GroupForm
export interface Draft {
  base?: Form
  form: Form
  conflict?: boolean
  message?: string
}

export function emptyMember(): MemberForm {
  return { slot: '', role: '', assignment: '' }
}

function roleForm(id: string, row: StoredEntry): RoleForm {
  return {
    kind: 'roles', id, enabled: row.enabled !== false, description: row.description ?? '',
    provider: row.provider ?? '', model: row.model ?? '', reasoningEffort: row.reasoningEffort ?? '',
    maxTokens: String(row.maxTokens ?? ''), maxDepth: String(row.maxDepth ?? ''),
    subagentProvider: row.subagentProvider ?? '', persona: row.persona ?? '',
    filter: row.toolFilter, routeNote: row.routeNote, inherit: false, clearToolFilter: false,
  }
}

function groupForm(id: string, group: StoredGroup): GroupForm {
  return {
    kind: 'groups', id, enabled: group.enabled !== false, description: group.description,
    name: group.name ?? '', instructions: group.instructions ?? '',
    members: group.members.map(({ slot, role, assignment }) => ({ slot, role, assignment: assignment ?? '' })),
  }
}

export function serverForm(view: LibraryView, tab: Tab, id: string): Form | undefined {
  if (tab === 'groups') {
    const group = own(view.groups, id)
    return group && groupForm(id, group)
  }
  const role = own(view.entries, id)
  if (!role) return undefined
  return roleForm(id, view.profile ? role : { ...role, ...own(view.sharedEntries, id) })
}

export function freshDraft(view: LibraryView, tab: Tab, id: string): Draft {
  const base = serverForm(view, tab, id)
  const form = base ?? (tab === 'roles' ? roleForm('', {}) : groupForm('', { description: '', members: [emptyMember()] }))
  return { form, base }
}

// The form constructors produce the same key order for each server snapshot.
export const equal = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b)

/** Keep edited fields and bring untouched ones forward after an explicit comparison. */
export function rebase(draft: Draft, current: Form | undefined): Draft {
  if (!current || !draft.base) return { form: draft.form, base: current }
  const base = draft.base
  const changes = Object.fromEntries(Object.entries(draft.form).filter(([key, value]) =>
    !equal(value, Reflect.get(base, key))))
  const form = { ...current, ...changes }
  if (form.kind === 'roles' && form.inherit) {
    return { base: current, form: { ...form, provider: '', model: '', reasoningEffort: '', maxTokens: '' } }
  }
  return { base: current, form }
}

export function validate(form: Form, view: LibraryView, isNew: boolean, base?: Form): string | undefined {
  const id = form.id.trim()
  const idIssue = entryIdIssue(id)
  if (idIssue === 'reserved') return '这个 ID 是系统保留名称，请换一个。'
  if (idIssue && form.kind === 'groups') {
    if (idIssue === 'required') return '请填写编队 ID。'
    if (/\s/.test(id)) return '编队 ID 中不能有空格，可以用短横线连接单词。'
    return '请按上面的格式修改编队 ID，例如 review-group。'
  }
  if (idIssue) return 'ID 可使用小写字母、数字和短横线，以字母或数字开头，最长 64 个字符。'
  if (isNew && serverForm(view, form.kind, id)) return '此 ID 已存在，请换一个。'
  if (!form.description.trim()) return '请填写描述。'
  if (form.kind === 'roles') {
    for (const [value, min, label] of [[form.maxDepth, 0, '深度上限'], [form.maxTokens, 1, '输出上限']] as const) {
      if (value && (!Number.isSafeInteger(Number(value)) || Number(value) < min)) return `${label}需为 ≥${min} 的整数。`
    }
    return
  }
  if (!form.members.length) return '请添加至少一名编队成员。'
  const codeError = memberCodeErrors(form.members.map(m => m.slot)).find(Boolean)
  if (codeError) return codeError
  for (const member of form.members) {
    const unchanged = base?.kind === 'groups' && base.members.some(m => m.slot === member.slot.trim() && m.role === member.role)
    if (!member.role || (!unchanged && !own(view.entries, member.role))) return '请为每位成员选择名册中的角色。'
  }
}

function routeFields(form: RoleForm): RouteFields {
  return {
    ...(form.provider.trim() && { provider: form.provider.trim() }),
    ...(form.model.trim() && { model: form.model.trim() }),
    ...(form.reasoningEffort.trim() && { reasoningEffort: form.reasoningEffort.trim() }),
    ...(form.maxTokens && { maxTokens: Number(form.maxTokens) }),
  }
}

export function saveWrite(draft: Draft, view: LibraryView): LibraryWrite {
  const { form, base } = draft
  const id = form.id.trim()
  const expectedHash = view.hash
  const common = { description: form.description, ...(!form.enabled && { enabled: false }) }
  if (form.kind === 'groups') return {
    op: 'save-group', id, expectedHash,
    group: {
      ...common,
      ...(form.name.trim() && { name: form.name.trim() }),
      ...(form.instructions && { instructions: form.instructions }),
      members: form.members.map(m => ({
        slot: m.slot.trim(), role: m.role, ...(m.assignment && { assignment: m.assignment }),
      })),
    },
  }
  const fields = routeFields(form)
  const previous = base?.kind === 'roles' ? routeFields(base) : {}
  const routeChanged = form.inherit || !equal(fields, previous)
  return {
    op: 'save-entry', id, expectedHash,
    entry: { ...common, ...(form.persona && { persona: form.persona }),
      ...(!base && form.filter && !form.clearToolFilter && { toolFilter: form.filter }),
      ...(form.subagentProvider.trim() && { subagentProvider: form.subagentProvider.trim() }),
      ...(form.maxDepth && { maxDepth: Number(form.maxDepth) }) },
    ...(routeChanged && { route: form.inherit || !Object.keys(fields).length ? { inherit: true as const } : fields }),
    ...(form.clearToolFilter && { clearToolFilter: true }),
  }
}
