/**
 * Directory-backed roster store for dsh-subagent-library (0.3.0+).
 *
 * One named subagent per YAML file (`<id>.yaml`, id = file name) under a
 * roster directory (default `~/.dsh/subagents`). The legacy inline
 * `subagent-library.entries` settings document keeps working as a read-only
 * fallback during 0.3.x: file entries win, legacy-only entries still serve,
 * and a per-entry idempotent migration seeds the directory once.
 *
 * Design notes (v0.3.0 review, k3-helper):
 *  - No caching: rosters are tens of small files, every consumer re-reads the
 *    directory. The cache layer is exactly where mtime/case/rename bugs live.
 *  - Bad files never brick the roster: they are skipped and reported as
 *    diagnostics that every consumer surfaces.
 *  - Writes are per-file atomic (temp file + rename with bounded retries for
 *    Windows AV/indexer transient locks); roster-level saves are best-effort.
 *  - All filesystem access goes through an injectable `FsPort` (tests install
 *    an in-memory port via the `kFsPort` symbol; production uses node:fs).
 *
 * @module dsh-subagent-library/roster
 */
import { createHash } from 'node:crypto'
import { homedir } from 'node:os'
import * as nodePath from 'node:path'
import { promises as nodeFsPromises } from 'node:fs'
import z from '@deepseek-ai/schemastery'
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'

/** Entry ids are lowercase dns-ish labels. Also enforced for file names. */
export const ENTRY_ID = /^[a-z0-9][a-z0-9-]*$/
/** NTFS single component cap is 255; `<id>.yaml` plus headroom stays far below. */
export const MAX_ID_LENGTH = 64
/** Windows reserved device names — `<name>.yaml` is an illegal file name. */
const RESERVED_NAMES = new Set([
  'con', 'prn', 'aux', 'nul',
  ...Array.from({ length: 9 }, (_, index) => `com${index + 1}`),
  ...Array.from({ length: 9 }, (_, index) => `lpt${index + 1}`),
])

/** Optional child tool scoping (subset semantics documented on `delegate`). */
export interface ToolFilter {
  /** Global tool names the child keeps; everything else is removed. */
  allow?: string[]
  /** Global tool names removed from the child. */
  deny?: string[]
}

/** One named library entry (file or legacy document shape). */
export interface Entry {
  /** Role description surfaced to the model in `list_subagents`; keep it self-contained. */
  description: string
  /** LLM provider route for the child (e.g. `deepseek-official`, `kimi-coding`); omitted children use the caller's loop defaults. */
  provider?: string
  /** Provider model id; omitted children use the caller's loop defaults. */
  model?: string
  /** Subagent transport provider (e.g. `spawn`); defaults to the plugin-level `subagentProvider`. */
  subagentProvider?: string
  /** Per-request output cap for the child. */
  maxTokens?: number
  /** Per-child persona shadowing the deployment persona for this child. */
  persona?: string
  /** Child tool scoping. */
  toolFilter?: ToolFilter
  /** Absolute delegation-depth cap for the child; requires provider depthLimit. */
  maxDepth?: number
  /** `one-shot` (default) or `continuable` (durable, resumable background child). */
  backgroundMode?: 'one-shot' | 'continuable'
}

export const EntrySchema: z<Entry> = z.object({
  description: z.string().required(),
  provider: z.string(),
  model: z.string(),
  subagentProvider: z.string(),
  maxTokens: z.natural().max(Number.MAX_SAFE_INTEGER),
  persona: z.string(),
  toolFilter: z.object({
    allow: z.array(z.string()).default(undefined as unknown as string[]),
    deny: z.array(z.string()).default(undefined as unknown as string[]),
  }).default(undefined as unknown as { allow: string[]; deny: string[] }),
  maxDepth: z.natural().max(Number.MAX_SAFE_INTEGER),
  backgroundMode: z.union(['one-shot', 'continuable'] as const).default('one-shot'),
})

const ENTRY_KEYS = new Set([
  'description', 'provider', 'model', 'subagentProvider', 'maxTokens',
  'persona', 'toolFilter', 'maxDepth', 'backgroundMode',
])

/** Narrow filesystem port so tests never touch the real disk (SUB-TEST-001). */
export interface FsPort {
  readdir(dir: string): Promise<string[]>
  readFile(path: string): Promise<Buffer>
  writeFile(path: string, data: string): Promise<void>
  rename(from: string, to: string): Promise<void>
  unlink(path: string): Promise<void>
  mkdir(dir: string, options: { recursive: true }): Promise<void>
}

/** Key under which a host/test may inject an `FsPort` on the plugin Context. */
export const kFsPort: unique symbol = Symbol.for('dsh-subagent-library.fs-port')

export const nodeFsPort: FsPort = {
  readdir: (dir) => nodeFsPromises.readdir(dir),
  readFile: (path) => nodeFsPromises.readFile(path),
  writeFile: (path, data) => nodeFsPromises.writeFile(path, data, 'utf8'),
  rename: (from, to) => nodeFsPromises.rename(from, to),
  unlink: (path) => nodeFsPromises.unlink(path),
  mkdir: async (dir, options) => { await nodeFsPromises.mkdir(dir, options) },
}

const isEnoent = (error: unknown): boolean =>
  (error as { code?: unknown }).code === 'ENOENT'

const defaultDelay = (ms: number): Promise<void> =>
  new Promise((resolve) => { setTimeout(resolve, ms) })

/** Validate one entry id; returns the error message, or undefined when valid. */
export function validateEntryId(id: string): string | undefined {
  if (!ENTRY_ID.test(id)) return `id "${id}" must match ${String(ENTRY_ID)}`
  if (id.length > MAX_ID_LENGTH) return `id "${id}" exceeds ${MAX_ID_LENGTH} characters`
  if (RESERVED_NAMES.has(id)) return `id "${id}" is a reserved Windows device name and cannot be a roster file`
  return undefined
}

/** Expand `~`, anchor relative paths at `~/.dsh`, keep absolutes as-is. */
export function resolveEntriesDir(entriesDir: string | undefined, home = homedir()): string {
  const raw = entriesDir?.trim()
  if (raw === undefined || raw === '') return nodePath.join(home, '.dsh', 'subagents')
  const expanded = raw === '~' || raw.startsWith('~/') || raw.startsWith('~\\')
    ? nodePath.join(home, raw.slice(2))
    : raw
  return nodePath.isAbsolute(expanded) ? expanded : nodePath.join(home, '.dsh', expanded)
}

const stripBom = (text: string): string =>
  text.charCodeAt(0) === 0xFEFF ? text.slice(1) : text

export interface RosterDiagnostic {
  severity: 'error' | 'warning' | 'info'
  /** Entry id the diagnostic is about, when known. */
  id?: string
  /** Roster file name the diagnostic is about, when known. */
  file?: string
  message: string
}

/** One resolved roster row: a validated entry plus its storage provenance. */
export interface RosterEntry {
  entry: Entry
  /** `false` = kept in every view (so the UI can re-enable it) but refused by `delegate`. */
  enabled: boolean
  source: 'file' | 'legacy'
  /** Roster file name (not the full path) when `source === 'file'`. */
  file?: string
}

export interface RosterView {
  dir: string
  entries: Record<string, RosterEntry>
  diagnostics: RosterDiagnostic[]
  /** Stable content hash of the roster rows — the UI write guard. */
  hash: string
}

/**
 * Parse and validate one entry document (file contents or a save payload).
 * Unknown keys are LOUDLY rejected: a typo'd `backgroundmode` must not be
 * silently dropped into a default. Returns the normalized entry and the
 * enabled flag (default true).
 */
export function parseEntryDocument(raw: unknown): { entry: Entry, enabled: boolean } {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error('条目内容必须是对象（字段：description / provider / model / …）')
  }
  const record = raw as Record<string, unknown>
  const unknownKeys = Object.keys(record).filter((key) => key !== 'enabled' && !ENTRY_KEYS.has(key))
  if (unknownKeys.length > 0) {
    throw new Error(`未知字段：${unknownKeys.join(', ')}（可用：${[...ENTRY_KEYS, 'enabled'].join(', ')}）`)
  }
  const { enabled = true, ...rest } = record
  if (typeof enabled !== 'boolean') throw new Error('enabled 必须是布尔值')
  // The schema performs the real structural validation at runtime; the cast
  // only bridges the static type (rest may legitimately lack optional keys).
  const entry = EntrySchema(rest as unknown as Entry)
  if (typeof entry !== 'object' || entry === null) throw new Error('条目校验失败')
  return { entry, enabled }
}

/** Canonical JSON of one entry (recursively key-sorted) — hash input. */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical)
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, item]) => item !== undefined)
        .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
        .map(([key, item]) => [key, canonical(item)]),
    )
  }
  return value
}

function hashEntries(entries: Record<string, RosterEntry>): string {
  const payload = Object.keys(entries).sort().map((id) => [
    id,
    entries[id].enabled,
    canonical(entries[id].entry),
  ])
  return createHash('sha256').update(JSON.stringify(payload)).digest('hex').slice(0, 16)
}

/** Serialize an entry to YAML. Defaults are omitted (`enabled: true`,
 *  `backgroundMode: 'one-shot'`); output is UTF-8 without BOM, unwrapped. */
export function serializeEntry(entry: Entry, enabled = true): string {
  const record = entry as unknown as Record<string, unknown>
  const doc: Record<string, unknown> = {}
  for (const key of ['description', 'provider', 'model', 'subagentProvider', 'maxTokens', 'persona', 'toolFilter', 'maxDepth', 'backgroundMode']) {
    const value = record[key]
    if (value === undefined) continue
    if (key === 'backgroundMode' && value === 'one-shot') continue
    doc[key] = value
  }
  if (!enabled) doc['enabled'] = false
  return stringifyYaml(doc, { lineWidth: 0 })
}

export const entryFileName = (id: string): string => `${id}.yaml`

/** Atomic single-file write: temp name in the roster dir, then rename with
 *  bounded retries (Windows AV/indexer transiently lock fresh files). */
export async function writeEntryFile(options: {
  dir: string
  id: string
  entry: Entry
  enabled?: boolean
  fs?: FsPort
  delay?: (ms: number) => Promise<void>
}): Promise<void> {
  const fsp = options.fs ?? nodeFsPort
  const wait = options.delay ?? defaultDelay
  await fsp.mkdir(options.dir, { recursive: true })
  const target = nodePath.join(options.dir, entryFileName(options.id))
  const temp = nodePath.join(options.dir, `.${options.id}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}.tmp`)
  await fsp.writeFile(temp, serializeEntry(options.entry, options.enabled ?? true))
  for (let attempt = 0; ; attempt += 1) {
    try {
      await fsp.rename(temp, target)
      return
    } catch (error) {
      if (attempt >= 2) {
        await fsp.unlink(temp).catch(() => { /* best effort cleanup */ })
        throw error
      }
      await wait(50 * 3 ** attempt)
    }
  }
}

/** Remove one roster file; a missing file is already the desired state. */
export async function deleteEntryFile(dir: string, id: string, fsp: FsPort = nodeFsPort): Promise<void> {
  try {
    await fsp.unlink(nodePath.join(dir, entryFileName(id)))
  } catch (error) {
    if (!isEnoent(error)) throw error
  }
}

export interface LoadRosterOptions {
  dir: string
  /** Legacy inline settings entries — read-only fallback, shadowed by files. */
  legacy?: Record<string, Entry>
  fs?: FsPort
}

/**
 * Read the whole roster fresh: directory files first (sorted), then legacy
 * entries that no file shadows. Diagnostics carry every skip reason.
 */
export async function loadRoster(options: LoadRosterOptions): Promise<RosterView> {
  const fsp = options.fs ?? nodeFsPort
  const diagnostics: RosterDiagnostic[] = []
  const entries: Record<string, RosterEntry> = {}

  let names: string[]
  try {
    names = (await fsp.readdir(options.dir)).slice().sort()
  } catch (error) {
    if (!isEnoent(error)) {
      diagnostics.push({ severity: 'error', message: `名册目录不可读 ${options.dir}：${String(error)}` })
    }
    names = []
  }

  const owner = new Map<string, string>()
  for (const name of names) {
    const lower = name.toLowerCase()
    if (!lower.endsWith('.yaml') && !lower.endsWith('.yml')) continue
    const id = lower.replaceAll('.yml', '').replaceAll('.yaml', '')
    if (lower !== name) {
      diagnostics.push({ severity: 'warning', file: name, id, message: `文件名必须全小写，已跳过 "${name}"` })
      continue
    }
    const idError = validateEntryId(id)
    if (idError !== undefined) {
      diagnostics.push({ severity: 'error', file: name, id, message: idError })
      continue
    }
    const existing = owner.get(id)
    if (existing !== undefined) {
      diagnostics.push({ severity: 'error', file: name, id, message: `与 "${existing}" 解析出相同 id（.yaml/.yml 只能保留一个），已跳过` })
      continue
    }
    owner.set(id, name)
    let text: string
    try {
      text = (await fsp.readFile(nodePath.join(options.dir, name))).toString('utf8')
    } catch (error) {
      diagnostics.push({ severity: 'error', file: name, id, message: `读取失败，条目已跳过：${String(error)}` })
      owner.delete(id)
      continue
    }
    try {
      const { entry, enabled } = parseEntryDocument(parseYaml(stripBom(text)))
      entries[id] = { entry, enabled, source: 'file', file: name }
    } catch (error) {
      diagnostics.push({ severity: 'error', file: name, id, message: `解析或校验失败，条目已跳过：${String(error)}` })
    }
  }

  for (const [id, entry] of Object.entries(options.legacy ?? {})) {
    // Invalid legacy ids can never be addressed by delegate/delete; skip them
    // silently (same posture as the red-team #2 filter on settings views).
    if (!ENTRY_ID.test(id)) continue
    const file = entries[id]
    if (file !== undefined) {
      diagnostics.push({
        severity: 'info',
        id,
        message: `settings 中的旧条目已被名册文件 "${file.file}" 覆盖（旧条目可从 settings.yaml 删除）`,
      })
      continue
    }
    entries[id] = { entry, enabled: true, source: 'legacy' }
  }

  return { dir: options.dir, entries, diagnostics, hash: hashEntries(entries) }
}

export interface MigrationResult {
  imported: string[]
  skipped: Array<{ id: string, reason: string }>
  diagnostics: RosterDiagnostic[]
}

/**
 * One-time-per-directory, per-entry idempotent migration: every legacy entry
 * that has no roster file yet (and a valid id) is written to `<id>.yaml`.
 * Legacy settings entries are intentionally KEPT (rollback copy for users
 * downgrading the plugin); re-running never duplicates or overwrites.
 */
export async function migrateLegacyEntries(options: {
  dir: string
  legacy: Record<string, Entry>
  fs?: FsPort
  delay?: (ms: number) => Promise<void>
}): Promise<MigrationResult> {
  const fsp = options.fs ?? nodeFsPort
  const diagnostics: RosterDiagnostic[] = []
  const imported: string[] = []
  const skipped: MigrationResult['skipped'] = []
  let names: Set<string>
  try {
    names = new Set((await fsp.readdir(options.dir)).map((name) => name.toLowerCase()))
  } catch (error) {
    if (!isEnoent(error)) throw error
    names = new Set()
  }
  for (const [id, entry] of Object.entries(options.legacy)) {
    const idError = validateEntryId(id)
    if (idError !== undefined) {
      skipped.push({ id, reason: idError })
      continue
    }
    if (names.has(`${id}.yaml`) || names.has(`${id}.yml`)) {
      skipped.push({ id, reason: 'roster file already exists' })
      continue
    }
    try {
      await writeEntryFile({ dir: options.dir, id, entry, fs: fsp, delay: options.delay })
      names.add(`${id}.yaml`)
      imported.push(id)
    } catch (error) {
      diagnostics.push({ severity: 'error', id, message: `迁移写入失败：${String(error)}` })
    }
  }
  return { imported, skipped, diagnostics }
}
