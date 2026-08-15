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
  | 'settings.background'
  | 'settings.provider'
  | 'settings.sourceHint'

export const zh: Record<SubagentLibraryKey, string> = {
  'settings.title': '子代理库',
  'settings.hint': '管理具名角色子代理。保存后热生效：模型可在任意会话通过 list_subagents / delegate 使用。',
  'settings.empty': '库为空。添加第一个条目开始使用。',
  'settings.missing': '未找到 subagent-library 配置段（插件未加载？）。',
  'settings.add': '添加',
  'settings.addNew': '新增子代理',
  'settings.delete': '删除',
  'settings.save': '保存',
  'settings.saved': '已保存',
  'settings.conflict': '配置已被其他窗口修改，已重新加载，请重试。',
  'settings.error': '保存失败：',
  'settings.id': 'ID',
  'settings.description': '描述',
  'settings.model': '模型',
  'settings.persona': '角色提示词',
  'settings.toolFilter': '禁用工具',
  'settings.maxDepth': '深度上限',
  'settings.background': '后台模式',
  'settings.provider': 'Provider',
  'settings.sourceHint': '配置存储于 $DSH_HOME/settings.yaml 的 subagent-library.entries。',
}

export const en: Record<SubagentLibraryKey, string> = {
  'settings.title': 'Subagent Library',
  'settings.hint': 'Manage named role subagents. Changes apply live: models use them via list_subagents / delegate in any session.',
  'settings.empty': 'Library is empty. Add the first entry to get started.',
  'settings.missing': 'No subagent-library section found (plugin not loaded?).',
  'settings.add': 'Add',
  'settings.addNew': 'New subagent',
  'settings.delete': 'Delete',
  'settings.save': 'Save',
  'settings.saved': 'Saved',
  'settings.conflict': 'Config changed elsewhere; reloaded — please retry.',
  'settings.error': 'Save failed: ',
  'settings.id': 'ID',
  'settings.description': 'Description',
  'settings.model': 'Model',
  'settings.persona': 'Persona',
  'settings.toolFilter': 'Denied tools',
  'settings.maxDepth': 'Max depth',
  'settings.background': 'Background',
  'settings.provider': 'Provider',
  'settings.sourceHint': 'Stored at $DSH_HOME/settings.yaml under subagent-library.entries.',
}
