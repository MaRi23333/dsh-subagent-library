/**
 * 子代理库设置词典（最少化：zh 主、en 兜底）。
 * The namespace merge into LocaleNamespaceMap is what makes the slot-level
 * `locale` seat and the typed `t` prop work.
 */
import type {} from '@deepseek-ai/dsh-client-ui-slots'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    'subagent-library': SubagentLibraryKey
  }
}

export type SubagentLibraryKey =
  | 'settings.title'
  | 'settings.hint'
  | 'settings.empty'
  | 'settings.missing'
  | 'settings.add'
  | 'settings.addNew'
  | 'settings.delete'
  | 'settings.save'
  | 'settings.saved'
  | 'settings.conflict'
  | 'settings.error'
  | 'settings.id'
  | 'settings.description'
  | 'settings.model'
  | 'settings.persona'
  | 'settings.toolFilter'
  | 'settings.maxDepth'
  | 'settings.provider'
  | 'settings.sourceHint'

export const zh: Record<SubagentLibraryKey, string> = {
  'settings.title': '子代理库',
  'settings.hint': '管理名册中的角色和编队，为编队成员指定代号与默认分工。',
  'settings.empty': '库为空。添加第一个条目开始使用。',
  'settings.missing': '未找到 subagent-library 配置段（插件未加载？）。',
  'settings.add': '添加',
  'settings.addNew': '新建角色',
  'settings.delete': '删除',
  'settings.save': '保存',
  'settings.saved': '已保存',
  'settings.conflict': '配置已在别处更新，你的草稿已保留。查看当前配置后可继续编辑。',
  'settings.error': '保存失败：',
  'settings.id': 'ID',
  'settings.description': '描述',
  'settings.model': '模型',
  'settings.persona': '角色提示词',
  'settings.toolFilter': '旧工具限制',
  'settings.maxDepth': '深度上限',
  'settings.provider': 'Provider',
  'settings.sourceHint': '角色保存在名册目录，编队位于 _groups/，各 profile 的模型路由位于 _profiles/。',
}

export const en: Record<SubagentLibraryKey, string> = {
  'settings.title': 'Subagent Library',
  'settings.hint': 'Manage roles and groups. Give each group member a code and a default assignment.',
  'settings.empty': 'Library is empty. Add the first entry to get started.',
  'settings.missing': 'No subagent-library section found (plugin not loaded?).',
  'settings.add': 'Add',
  'settings.addNew': 'New role',
  'settings.delete': 'Delete',
  'settings.save': 'Save',
  'settings.saved': 'Saved',
  'settings.conflict': 'Settings changed elsewhere. Your draft is preserved. Review the current settings to continue editing.',
  'settings.error': 'Save failed: ',
  'settings.id': 'ID',
  'settings.description': 'Description',
  'settings.model': 'Model',
  'settings.persona': 'Persona',
  'settings.toolFilter': 'Legacy tool restrictions',
  'settings.maxDepth': 'Max depth',
  'settings.provider': 'Provider',
  'settings.sourceHint': 'Roles are stored in the roster directory, groups in _groups/, and profile model routes in _profiles/.',
}
