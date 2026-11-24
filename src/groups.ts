import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { parse, stringify } from 'yaml'
import { deleteEntryFile, removeYmlSibling, unlinkWithRetry, validateEntryId, writeYamlFile, type FsPort, type RosterDiagnostic } from './roster.ts'

export interface GroupMember {
  slot: string
  role: string
  assignment?: string
}

export interface Group {
  name?: string
  description: string
  enabled?: boolean
  instructions?: string
  members: GroupMember[]
}

function record(value: unknown, fields: string[]): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('需要对象')
  const unknown = Object.keys(value).filter(key => !fields.includes(key))
  if (unknown.length) throw new Error(`未知字段：${unknown.join(', ')}`)
  return value as Record<string, unknown>
}

function idField(value: unknown, key: string): string {
  if (typeof value !== 'string' || validateEntryId(value)) throw new Error(`${key}无效，请使用小写字母、数字或短横线，以字母或数字开头，最长 64 个字符，并避开系统保留名称。`)
  return value
}

export function parseGroup(value: unknown, fromSettingsView = false): Group {
  const raw = record(value, ['name', 'description', 'enabled', 'instructions', 'members'])
  if (typeof raw.description !== 'string' || !raw.description.trim()) throw new Error('description 需要非空文字')
  if (raw.enabled !== undefined && typeof raw.enabled !== 'boolean') throw new Error('enabled 需要布尔值')
  for (const key of ['name', 'instructions']) {
    if (raw[key] !== undefined && typeof raw[key] !== 'string') throw new Error(`${key} 需要文字`)
  }
  if (!Array.isArray(raw.members) || !raw.members.length) throw new Error('请至少添加一名编队成员')
  const slots = new Set<string>()
  const memberFields = ['slot', 'role', 'assignment']
  if (fromSettingsView) memberFields.push('launchable', 'reason')
  const members = raw.members.map((value): GroupMember => {
    const item = record(value, memberFields)
    const slot = idField(item.slot, '成员代号')
    if (slots.has(slot)) throw new Error(`成员代号 "${slot}" 在这个编队里已被使用，请换一个`)
    slots.add(slot)
    if (item.assignment !== undefined && typeof item.assignment !== 'string') throw new Error('assignment 需要文字')
    return { slot, role: idField(item.role, '角色 ID'), ...(item.assignment !== undefined && { assignment: item.assignment }) }
  })
  return {
    ...(typeof raw.name === 'string' && { name: raw.name }),
    description: raw.description,
    ...(raw.enabled !== undefined && { enabled: raw.enabled }),
    ...(typeof raw.instructions === 'string' && { instructions: raw.instructions }),
    members,
  }
}

export async function loadGroups(dir: string, fs: FsPort) {
  const groupDir = join(dir, '_groups')
  const groups: Record<string, Group> = Object.create(null)
  const groupDiagnostics: RosterDiagnostic[] = []
  const revision = createHash('sha256')
  let names: string[] = []
  try {
    names = (await fs.readdir(groupDir)).sort()
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      groupDiagnostics.push({ severity: 'error', file: '_groups', message: `编队目录不可读：${String(error)}` })
    }
  }
  const seen = new Set<string>()
  for (const name of names) {
    if (!/\.ya?ml$/i.test(name) || name.startsWith('_')) continue
    const id = name.replace(/\.ya?ml$/i, '').toLowerCase()
    const file = `_groups/${name}`
    revision.update(JSON.stringify(name))
    try {
      if (name !== name.toLowerCase()) throw new Error('文件名必须全小写')
      const invalid = validateEntryId(id)
      if (invalid) throw new Error(invalid)
      const data = (await fs.readFile(join(groupDir, name))).toString('utf8')
      revision.update(JSON.stringify(data))
      if (seen.has(id)) throw new Error('同名编队文件重复')
      seen.add(id)
      groups[id] = parseGroup(parse(data))
    } catch (error) {
      groupDiagnostics.push({ severity: 'error', id, file, message: `编队 ${file} 无法使用：${String(error)}` })
    }
  }
  for (const problem of groupDiagnostics) if (problem.id) delete groups[problem.id]
  revision.update(JSON.stringify(groupDiagnostics))
  return { groups, groupDiagnostics, groupRevision: revision.digest('hex') }
}

export function roleUsages(groups: Record<string, Group>): Record<string, Array<{ groupId: string, slot: string }>> {
  const result: ReturnType<typeof roleUsages> = Object.create(null)
  for (const [groupId, group] of Object.entries(groups)) {
    for (const { slot, role } of group.members) (result[role] ??= []).push({ groupId, slot })
  }
  return result
}

export async function writeGroup(dir: string, id: string, group: Group, fs: FsPort): Promise<void> {
  const groupDir = join(dir, '_groups')
  await writeYamlFile(groupDir, id, stringify(group, { lineWidth: 0 }), fs)
  await removeYmlSibling(groupDir, id, fs)
}

export const deleteGroup = (dir: string, id: string, fs: FsPort): Promise<void> =>
  deleteEntryFile(join(dir, '_groups'), id, fs)

/** All participating hosts use the same exclusive file. A timeout never steals a live lock. */
export async function lockRoster(dir: string, fs: FsPort, waitMs = 3000): Promise<() => Promise<void>> {
  const file = join(dir, '.roster-write.lock')
  await fs.mkdir(dir, { recursive: true })
  const deadline = Date.now() + waitMs
  for (;;) {
    try {
      await fs.writeFile(file, JSON.stringify({ pid: process.pid, started: new Date().toISOString() }), 'wx')
      return () => unlinkWithRetry(file, fs)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      if (Date.now() >= deadline) throw Object.assign(new Error(`名册写锁正被占用：${file}。请重试；若宿主异常退出，确认无写入者后可移除该锁文件。`), { code: 'ROSTER_BUSY' })
      await new Promise(resolve => setTimeout(resolve, 35))
    }
  }
}
