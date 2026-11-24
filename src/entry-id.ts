/** Entry ids are lowercase DNS-like labels. Also enforced for file names. */
export const ENTRY_ID = /^[a-z0-9][a-z0-9-]*$/
/** NTFS single component cap is 255; `<id>.yaml` plus headroom stays far below. */
export const MAX_ID_LENGTH = 64
const RESERVED_NAMES = new Set([
  'con', 'prn', 'aux', 'nul',
  ...Array.from({ length: 9 }, (_, index) => `com${index + 1}`),
  ...Array.from({ length: 9 }, (_, index) => `lpt${index + 1}`),
])

export function entryIdIssue(id: string): 'required' | 'start' | 'characters' | 'length' | 'reserved' | undefined {
  if (!id) return 'required'
  if (!/^[a-z0-9]/.test(id)) return 'start'
  if (!ENTRY_ID.test(id)) return 'characters'
  if (id.length > MAX_ID_LENGTH) return 'length'
  if (RESERVED_NAMES.has(id)) return 'reserved'
}

/** Validate one entry id; returns the error message, or undefined when valid. */
export function validateEntryId(id: string): string | undefined {
  switch (entryIdIssue(id)) {
    case 'required':
    case 'start':
    case 'characters': return `id "${id}" must match ${String(ENTRY_ID)}`
    case 'length': return `id "${id}" exceeds ${MAX_ID_LENGTH} characters`
    case 'reserved': return `id "${id}" is a reserved Windows device name and cannot be a roster file`
  }
}

/** Check draft member codes using the same trimming the settings writer applies. */
export function memberCodeErrors(values: readonly string[]): Array<string | undefined> {
  const codes = values.map(value => value.trim())
  const seen = new Set<string>()
  const duplicates = new Set<string>()
  for (const code of codes) {
    if (seen.has(code)) duplicates.add(code)
    seen.add(code)
  }
  return codes.map(code => {
    switch (entryIdIssue(code)) {
      case 'required': return '请填写成员代号。'
      case 'start': return '成员代号须以小写字母或数字开头。'
      case 'characters': return '成员代号只能使用小写字母、数字和短横线。'
      case 'length': return `成员代号最多 ${MAX_ID_LENGTH} 个字符。`
      case 'reserved': return '这个成员代号是系统保留名称，请换一个。'
      default: return duplicates.has(code) ? '此代号已在编队中使用，请换一个。' : undefined
    }
  })
}
