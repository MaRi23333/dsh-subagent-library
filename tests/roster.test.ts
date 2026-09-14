/**
 * Roster store tests (SUB-TEST-001): id validation, directory scanning,
 * diagnostics for broken files, hash stability, atomic-write retries and the
 * per-entry idempotent legacy migration — all against the in-memory FsPort.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { homedir } from 'node:os'
import * as path from 'node:path'
import { parse as parseYaml } from 'yaml'
import {
  deleteEntryFile,
  loadRoster,
  MAX_ID_LENGTH,
  migrateLegacyEntries,
  parseEntryDocument,
  resolveEntriesDir,
  serializeEntry,
  validateEntryId,
  writeEntryFile,
  type Entry,
  type FsPort,
} from '../src/roster.ts'
import { makeMemFs } from './helpers.ts'

const ENTRY: Entry = {
  description: 'fake role',
  provider: 'fake-provider',
  model: 'fake-model',
  reasoningEffort: 'max',
  persona: '你是假角色',
  backgroundMode: 'continuable',
}

test('validateEntryId enforces the roster file constraints', () => {
  assert.equal(validateEntryId('a'), undefined)
  assert.equal(validateEntryId('glm-reader-2'), undefined)
  assert.match(validateEntryId('Bad') ?? '', /must match/)
  assert.match(validateEntryId('-lead') ?? '', /must match/)
  assert.match(validateEntryId('a_b') ?? '', /must match/)
  assert.match(validateEntryId('a'.repeat(MAX_ID_LENGTH + 1)) ?? '', /exceeds/)
  assert.equal(validateEntryId('a'.repeat(MAX_ID_LENGTH)), undefined)
  // Windows reserved device names: `con.yaml` is an illegal file name.
  assert.match(validateEntryId('con') ?? '', /reserved/)
  assert.match(validateEntryId('nul') ?? '', /reserved/)
  assert.match(validateEntryId('com1') ?? '', /reserved/)
})

test('resolveEntriesDir expands ~, anchors relative paths at ~/.dsh, keeps absolutes', () => {
  const home = homedir()
  assert.equal(resolveEntriesDir(undefined, home), path.join(home, '.dsh', 'subagents'))
  assert.equal(resolveEntriesDir('', home), path.join(home, '.dsh', 'subagents'))
  assert.equal(resolveEntriesDir('~', home), home)
  assert.equal(resolveEntriesDir('~/roster', home), path.join(home, 'roster'))
  assert.equal(resolveEntriesDir('subs', home), path.join(home, '.dsh', 'subs'))
  assert.equal(resolveEntriesDir('/abs/dir', home), path.win32.isAbsolute('/abs/dir') ? '/abs/dir' : path.join(home, '.dsh', '/abs/dir'))
})

test('parseEntryDocument validates, rejects unknown keys, and applies schema defaults', () => {
  const { entry, enabled } = parseEntryDocument({ description: 'x', enabled: false })
  assert.equal(entry.description, 'x')
  assert.equal(enabled, false)

  const defaulted = parseEntryDocument({ description: 'x' })
  assert.equal(defaulted.enabled, true)
  assert.equal((defaulted.entry as Entry & { backgroundMode?: string }).backgroundMode ?? 'one-shot', 'one-shot')

  assert.throws(() => parseEntryDocument({ typo_field: 'x' }), /未知字段/)
  assert.throws(() => parseEntryDocument({ description: 'x', enabled: 'yes' }), /enabled/)
  assert.throws(() => parseEntryDocument('nope'), /对象/)
  assert.throws(() => parseEntryDocument({}), /description/)
  // reasoningEffort must look like an adapter effort id, not prose (A4).
  assert.throws(() => parseEntryDocument({ description: 'x', reasoningEffort: '最大 力度' }), /reasoningEffort/)
  const effort = parseEntryDocument({ description: 'x', reasoningEffort: 'max' })
  assert.equal((effort.entry as Entry & { reasoningEffort?: string }).reasoningEffort, 'max')
})

test('serializeEntry omits defaults and round-trips through YAML', () => {
  const text = serializeEntry(ENTRY, true)
  assert.match(text, /backgroundMode: continuable/)
  assert.match(text, /reasoningEffort: max/)
  assert.doesNotMatch(text, /enabled/)
  const back = parseEntryDocument(parseYaml(text))
  assert.equal(back.enabled, true)
  assert.deepEqual(back.entry, ENTRY)

  // Schema defaults are omitted: `backgroundMode: 'one-shot'` and
  // `enabled: true` never land in the file.
  const plain = serializeEntry({ ...ENTRY, backgroundMode: 'one-shot' }, true)
  assert.doesNotMatch(plain, /backgroundMode/)
  assert.doesNotMatch(plain, /enabled/)

  const disabled = serializeEntry(ENTRY, false)
  assert.match(disabled, /enabled: false/)
  const backDisabled = parseEntryDocument(parseYaml(disabled))
  assert.equal(backDisabled.enabled, false)
  assert.deepEqual(backDisabled.entry, ENTRY)
})

test('loadRoster skips `_`-prefixed names silently (backups, drafts)', async () => {
  // readdir lists directories too: `_backups/` sits next to the roster files,
  // and agents may drop `_draft.yaml`-style files — all non-roster content
  // that must never surface as diagnostics noise.
  const fs = makeMemFs({
    '/roster/_backups/old.yaml': 'description: backup copy\n',
    '/roster/_draft.yaml': 'description: draft\n',
    '/roster/real.yaml': 'description: real entry\n',
  })
  const baseReaddir = fs.readdir.bind(fs)
  fs.readdir = async (dir: string) => [...await baseReaddir(dir), '_backups']
  const view = await loadRoster({ dir: '/roster', fs })
  assert.deepEqual(Object.keys(view.entries), ['real'])
  assert.equal(view.diagnostics.length, 0)
})

test('loadRoster escalates broken-file + legacy overlap to a loud error (A2)', async () => {
  // The silent-stale-config trap: the file is broken, the legacy copy serves,
  // delegate succeeds — the user believes their edit is live. Must be loud.
  const fs = makeMemFs({ '/roster/broken.yaml': 'description: [oops\n' })
  const view = await loadRoster({ dir: '/roster', legacy: { broken: { description: 'old copy' } }, fs })
  assert.equal(view.entries['broken']?.source, 'legacy')
  const escalated = view.diagnostics.find((item) => item.severity === 'error' && /兜底/.test(item.message))
  assert.ok(escalated !== undefined, 'the fallback must be escalated to its own loud error')
  assert.match(escalated?.message ?? '', /旧配置/)
})

test('loadRoster strips only the file SUFFIX, not inner .yaml substrings', async () => {
  const fs = makeMemFs({ '/roster/a.yaml1.yaml': 'description: tricky\n' })
  const view = await loadRoster({ dir: '/roster', fs })
  assert.deepEqual(Object.keys(view.entries), [])
  assert.match(view.diagnostics[0]?.message ?? '', /must match/)
})

test('loadRoster reads files sorted, skips broken ones with diagnostics', async () => {
  const fs = makeMemFs({
    '/roster/b-reader.yaml': 'description: reader\n',
    '/roster/a-worker.yaml': 'description: worker\nprovider: qwen\n',
    '/roster/broken.yaml': 'description: [unclosed\n',
    '/roster/unknown.yaml': 'description: x\nnope: y\n',
    '/roster/Foo.yaml': 'description: bad case\n',
    '/roster/notes.md': 'not a roster file\n',
  })
  const view = await loadRoster({ dir: '/roster', fs })
  assert.deepEqual(Object.keys(view.entries), ['a-worker', 'b-reader'])
  assert.equal(view.entries['a-worker']?.source, 'file')
  assert.equal(view.entries['a-worker']?.file, 'a-worker.yaml')
  const byFile = new Map(view.diagnostics.map((item) => [item.file, item]))
  assert.equal(byFile.get('broken.yaml')?.severity, 'error')
  assert.match(byFile.get('broken.yaml')?.message ?? '', /解析或校验失败/)
  assert.equal(byFile.get('unknown.yaml')?.severity, 'error')
  assert.match(byFile.get('unknown.yaml')?.message ?? '', /nope/)
  assert.equal(byFile.get('Foo.yaml')?.severity, 'warning')
  assert.match(byFile.get('Foo.yaml')?.message ?? '', /小写/)
  assert.ok(!view.diagnostics.some((item) => item.file === 'notes.md'))
})

test('loadRoster: duplicate ids across .yaml/.yml keep one winner with a loud loser', async () => {
  const fs = makeMemFs({
    '/roster/dup.yaml': 'description: winner\n',
    '/roster/dup.yml': 'description: loser\n',
  })
  const view = await loadRoster({ dir: '/roster', fs })
  assert.equal(view.entries['dup']?.entry.description, 'winner')
  assert.match(view.diagnostics[0]?.message ?? '', /相同 id/)
})

test('loadRoster tolerates a missing directory and merges legacy entries beneath files', async () => {
  const fs = makeMemFs()
  const legacy = { 'legacy-only': { ...ENTRY }, shadowed: { description: 'old copy' } }
  const empty = await loadRoster({ dir: '/absent', legacy, fs })
  assert.deepEqual(Object.keys(empty.entries), ['legacy-only', 'shadowed'])
  assert.ok(empty.diagnostics.every((item) => item.severity !== 'error'))

  // Now the shadowing file appears: file wins, legacy keeps serving the rest,
  // and the shadowed legacy row gets an informational diagnostic.
  const fs2 = makeMemFs({ '/roster/shadowed.yaml': 'description: new copy\n' })
  const populated = await loadRoster({ dir: '/roster', legacy, fs: fs2 })
  assert.equal(populated.entries['shadowed']?.entry.description, 'new copy')
  assert.equal(populated.entries['legacy-only']?.source, 'legacy')
  const info = populated.diagnostics.find((item) => item.id === 'shadowed')
  assert.equal(info?.severity, 'info')
})

test('loadRoster ignores legacy keys that fail ENTRY_ID (unchanged red-team posture)', async () => {
  const fs = makeMemFs()
  const view = await loadRoster({ dir: '/roster', legacy: { bad_key: { description: 'x' } } as never, fs })
  assert.deepEqual(Object.keys(view.entries), [])
})

test('hash: content-addressed, file-name and order independent, change-sensitive', async () => {
  const a = await loadRoster({ dir: '/r', legacy: { one: { ...ENTRY }, two: { description: 'two' } }, fs: makeMemFs() })
  const b = await loadRoster({ dir: '/r', legacy: { two: { description: 'two' }, one: { ...ENTRY } }, fs: makeMemFs() })
  assert.equal(a.hash, b.hash)
  const fs = makeMemFs({ '/r/one.yaml': `${serializeEntry(ENTRY)}\n` })
  const c = await loadRoster({ dir: '/r', legacy: { two: { description: 'two' } }, fs })
  assert.equal(c.hash, b.hash, 'promoting a legacy row to an identical file must not change the hash')
  const fsChanged = makeMemFs({ '/r/one.yaml': 'description: changed\n' })
  const d = await loadRoster({ dir: '/r', legacy: { two: { description: 'two' } }, fs: fsChanged })
  assert.notEqual(d.hash, c.hash)
})

test('writeEntryFile lands atomically; transient rename locks are retried with backoff', async () => {
  const fs = makeMemFs()
  const waits: number[] = []
  let failures = 0
  const flaky: FsPort = {
    ...fs,
    async rename(from, to) {
      if (failures < 2) {
        failures += 1
        throw Object.assign(new Error('EPERM: file locked by indexer'), { code: 'EPERM' })
      }
      return fs.rename(from, to)
    },
  }
  await writeEntryFile({ dir: '/roster', id: 'reader', entry: ENTRY, fs: flaky, delay: async (ms) => { waits.push(ms) } })
  assert.match(String(fs.files()['/roster/reader.yaml']), /fake role/)
  assert.deepEqual(waits, [50, 150])

  const doomed = makeMemFs()
  const hopeless: FsPort = {
    ...doomed,
    rename: async () => { throw Object.assign(new Error('EPERM forever'), { code: 'EPERM' }) },
  }
  await assert.rejects(
    () => writeEntryFile({ dir: '/roster', id: 'reader', entry: ENTRY, fs: hopeless, delay: async () => {} }),
    /EPERM forever/,
  )
  // The temp file is cleaned up after the final failure — no litter in the dir.
  assert.deepEqual(Object.keys(doomed.files()), [])
})

test('deleteEntryFile removes the file and tolerates a missing one', async () => {
  const fs = makeMemFs({ '/roster/doomed.yaml': 'description: x\n' })
  await deleteEntryFile('/roster', 'doomed', fs)
  assert.equal(fs.files()['/roster/doomed.yaml'], undefined)
  await deleteEntryFile('/roster', 'never-existed', fs)
})

test('migrateLegacyEntries is per-entry idempotent and never overwrites existing files', async () => {
  const fs = makeMemFs({ '/roster/manual.yaml': 'description: hand written\n' })
  const legacy = {
    alpha: { ...ENTRY },
    manual: { description: 'legacy copy' },
    Bad_Key: { description: 'invalid id' },
    con: { description: 'reserved' },
  } as unknown as Record<string, Entry>
  const first = await migrateLegacyEntries({ dir: '/roster', legacy, fs })
  assert.deepEqual(first.imported.sort(), ['alpha'])
  assert.deepEqual(first.skipped.map((item) => item.id).sort(), ['Bad_Key', 'con', 'manual'])
  assert.deepEqual(parseYaml(String(fs.files()['/roster/alpha.yaml'])), {
    description: ENTRY.description,
    provider: ENTRY.provider,
    model: ENTRY.model,
    reasoningEffort: ENTRY.reasoningEffort,
    persona: ENTRY.persona,
    backgroundMode: 'continuable',
  })

  // Second run: nothing to do — the migration is idempotent across restarts.
  const second = await migrateLegacyEntries({ dir: '/roster', legacy, fs })
  assert.deepEqual(second.imported, [])
  assert.equal(second.skipped.length, 4)
  assert.equal(fs.files()['/roster/manual.yaml'], 'description: hand written\n', 'hand-written files are never clobbered')
})

test('migrateLegacyEntries records per-entry write failures instead of aborting the batch', async () => {
  const base = makeMemFs()
  const broken: FsPort = {
    ...base,
    async writeFile(path, data) {
      if (path.includes('cursed')) throw new Error('disk full')
      return base.writeFile(path, data)
    },
  }
  const result = await migrateLegacyEntries({ dir: '/roster', legacy: { cursed: { ...ENTRY }, fine: { description: 'ok' } }, fs: broken })
  assert.deepEqual(result.imported, ['fine'])
  assert.match(result.diagnostics[0]?.message ?? '', /disk full/)
  assert.ok(base.files()['/roster/fine.yaml'] !== undefined)
})
