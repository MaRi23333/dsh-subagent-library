/**
 * Settings-API route tests (SUB-TEST-001): the write-path negative matrix
 * (415 / 403 / 413 / 400 / 409 / 500), entry-id validation incl.
 * prototype-polluting keys, file-roster save/delete semantics, hash conflict
 * handling, and the settingsFailure diagnostic. All traffic goes through the
 * real handler mounted by apply() against in-memory doubles — no network,
 * real files or credentials.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { API_PATH, dispatch, jsonBody, makeHost, postJson, type MockHost } from './helpers.ts'
import { parse as parseYaml } from 'yaml'

const ENTRY = { description: 'fake role for tests' }

function hostWith(options: Parameters<typeof makeHost>[0] = {}): MockHost {
  return makeHost({ baseEntries: { 'good-entry': { ...ENTRY } }, ...options })
}

test('GET returns the roster view and filters schema-invalid legacy ids out', async () => {
  // A hand-written key like `bad_key` passes z.dict but violates ENTRY_ID;
  // it must be hidden from every view (red-team finding #2).
  const host = hostWith({
    baseEntries: { 'good-entry': { ...ENTRY }, bad_key: { description: 'orphaned' } },
  })
  const res = await dispatch(host.web, API_PATH)
  assert.equal(res.status, 200)
  const body = jsonBody(res)
  assert.equal(body['ok'], true)
  assert.equal(body['writable'], true)
  assert.equal(typeof body['hash'], 'string')
  assert.equal(body['dir'], '/roster')
  assert.deepEqual(Object.keys(body['entries'] as Record<string, unknown>), ['good-entry'])
})

test('GET surfaces roster-file diagnostics alongside the surviving entries', async () => {
  const host = makeHost({
    rosterFiles: {
      '/roster/broken.yaml': 'description: [unclosed',
      '/roster/unknown-key.yaml': 'description: x\ntypo_field: y\n',
    },
  })
  const res = await dispatch(host.web, API_PATH)
  assert.equal(res.status, 200)
  const body = jsonBody(res)
  assert.deepEqual(Object.keys(body['entries'] as Record<string, unknown>), [])
  const diagnostics = body['diagnostics'] as Array<{ severity: string }>
  assert.equal(diagnostics.length, 2)
  assert.ok(diagnostics.every((item) => item.severity === 'error'))
})

test('GET marks a legacy row shadowed by a file with an info diagnostic', async () => {
  const host = makeHost({
    baseEntries: { shadowed: { description: 'old copy' } },
    rosterFiles: { '/roster/shadowed.yaml': 'description: new copy\n' },
  })
  const res = await dispatch(host.web, API_PATH)
  assert.equal(res.status, 200)
  const body = jsonBody(res)
  const shadowed = (body['entries'] as Record<string, Record<string, unknown>>)['shadowed']
  assert.equal(shadowed?.['description'], 'new copy', 'the file wins')
  assert.equal(shadowed?.['source'], undefined, 'the shadowing row serves from the file, not legacy')
  const diagnostics = body['diagnostics'] as Array<{ severity: string, id?: string }>
  const info = diagnostics.find((item) => item.id === 'shadowed')
  assert.equal(info?.severity, 'info')
})

test('GET surfaces the settingsFailure diagnostic as 503 + message', async () => {
  const host = hostWith({ failRegister: true })
  const res = await dispatch(host.web, API_PATH)
  assert.equal(res.status, 503)
  const body = jsonBody(res)
  assert.equal(body['error'], 'not-ready')
  assert.match(String(body['message']), /注册失败/)
})

test('POST rejects a non-JSON content type (415)', async () => {
  const host = hostWith()
  const res = await dispatch(host.web, API_PATH, {
    method: 'POST',
    headers: { 'content-type': 'text/plain', host: '127.0.0.1:3080' },
    body: '{}',
  })
  assert.equal(res.status, 415)
  assert.equal(jsonBody(res)['error'], 'content-type-json-required')
})

test('POST rejects a cross-origin write (403)', async () => {
  const host = hostWith()
  const res = await postJson(host.web, { op: 'save', entries: {} }, { origin: 'https://evil.example' })
  assert.equal(res.status, 403)
  assert.equal(jsonBody(res)['error'], 'cross-origin-forbidden')
})

test('POST allows a missing Origin header (curl-style clients)', async () => {
  const host = hostWith()
  const res = await postJson(host.web, { op: 'save', entries: { 'new-entry': { ...ENTRY } } })
  assert.equal(res.status, 200)
})

test('POST allows a loopback Origin even when the host header differs', async () => {
  const host = hostWith()
  const res = await postJson(host.web, { op: 'save', entries: { 'new-entry': { ...ENTRY } } }, { origin: 'http://127.0.0.1:9999' })
  assert.equal(res.status, 200)
})

test('POST rejects a body over the 1 MiB cap (413)', async () => {
  const host = hostWith()
  const res = await postJson(host.web, Buffer.alloc((1 << 20) + 1, 0x78))
  assert.equal(res.status, 413)
  assert.equal(jsonBody(res)['error'], 'body-too-large')
})

test('POST rejects malformed JSON (400 bad-json)', async () => {
  const host = hostWith()
  const res = await postJson(host.web, '{not json')
  assert.equal(res.status, 400)
  assert.equal(jsonBody(res)['error'], 'bad-json')
})

test('POST save requires an entries object (400 entries-object-required)', async () => {
  const host = hostWith()
  const res = await postJson(host.web, { op: 'save', entries: [] })
  assert.equal(res.status, 400)
  assert.equal(jsonBody(res)['error'], 'entries-object-required')
})

test('POST save rejects schema-invalid entry ids (400 invalid-entry-id)', async () => {
  // `__proto__` must be an OWN key of the payload — an object literal would
  // set the prototype instead, so parse it from a JSON string.
  const cases: Array<Record<string, unknown>> = [
    JSON.parse('{"__proto__": {"description": "pollute"}}') as Record<string, unknown>,
    { 'bad_key': { ...ENTRY } },
    { BadKey: { ...ENTRY } },
    { '-leading-dash': { ...ENTRY } },
    { con: { ...ENTRY } },
    { [`${'a'.repeat(65)}`]: { ...ENTRY } },
  ]
  for (const entries of cases) {
    const host = hostWith()
    const res = await postJson(host.web, { op: 'save', entries })
    assert.equal(res.status, 400, JSON.stringify(entries))
    assert.equal(jsonBody(res)['error'], 'invalid-entry-id')
  }
})

test('POST save rejects entries failing the entry schema (400 rejected)', async () => {
  const host = hostWith()
  const res = await postJson(host.web, { op: 'save', entries: { 'no-description': {} } })
  assert.equal(res.status, 400)
  assert.equal(jsonBody(res)['error'], 'rejected')
})

test('POST save rejects unknown fields loudly instead of dropping them (400 rejected)', async () => {
  // A typo'd field must not silently vanish into the default.
  const host = hostWith()
  const res = await postJson(host.web, {
    op: 'save',
    entries: { typo: { description: 'x', backgroundmode: 'continuable' } },
  })
  assert.equal(res.status, 400)
  assert.equal(jsonBody(res)['error'], 'rejected')
  assert.match(String(jsonBody(res)['message']), /backgroundmode/)
})

test('POST save snapshot writes files and unsets legacy rows absent from the payload', async () => {
  const host = hostWith({
    user: { subagentProvider: 'fork', entries: { 'stale-entry': { ...ENTRY } } },
  })
  const res = await postJson(host.web, { op: 'save', entries: { 'fresh-entry': { ...ENTRY } } })
  assert.equal(res.status, 200)
  const body = jsonBody(res)
  assert.deepEqual(Object.keys(body['entries'] as Record<string, unknown>), ['fresh-entry'])
  // The fresh row became a roster file…
  const files = host.fs.files()
  const written = files['/roster/fresh-entry.yaml']
  assert.match(String(written), /description: fake role for tests/)
  // …and the stale legacy row was removed from settings (files win — a
  // surviving legacy copy would resurrect the entry on the next read).
  assert.equal((host.settings.userSection()?.['entries'] as Record<string, unknown>)?.['stale-entry'], undefined)
  // Other top-level user keys survive the legacy unset.
  assert.equal(host.settings.userSection()?.['subagentProvider'], 'fork')
})

test('POST save carries enabled:false into the file and the wire view', async () => {
  const host = hostWith()
  const res = await postJson(host.web, {
    op: 'save',
    entries: { sleeping: { ...ENTRY, enabled: false } },
  })
  assert.equal(res.status, 200)
  const body = jsonBody(res)
  assert.equal((body['entries'] as Record<string, Record<string, unknown>>)['sleeping']?.['enabled'], false)
  const written = host.fs.files()['/roster/sleeping.yaml']
  assert.deepEqual(parseYaml(String(written) as string), {
    description: 'fake role for tests',
    enabled: false,
  })
})

test('POST save strips the editor provenance marker before persisting', async () => {
  const host = hostWith()
  const res = await postJson(host.web, {
    op: 'save',
    entries: { promoted: { ...ENTRY, source: 'legacy' } },
  })
  assert.equal(res.status, 200)
  const written = parseYaml(String(host.fs.files()['/roster/promoted.yaml']) as string) as Record<string, unknown>
  assert.equal(written['source'], undefined)
})

test('POST save accepts any toolFilter names — delegate-time restrict is the enforcement', async () => {
  // The harness keeps every model-facing tool on the agent plane (global layer
  // empty by design), and the set a child inherits depends on the parent at
  // delegate time; no host-plane probe can enumerate it exactly. tools.restrict
  // at child composition validates loudly with a precise "known global tools: …"
  // error, which is the real guard. A save-time pre-check produced false
  // rejections that broke the settings UI for legitimate deny lists
  // (0.2.2–0.2.4; removed in 0.2.5).
  const host = hostWith()
  const res = await postJson(host.web, {
    op: 'save',
    entries: {
      'reader-role': { ...ENTRY, toolFilter: { deny: ['write', 'edit', 'todo_write'] } },
      'maybe-typo': { ...ENTRY, toolFilter: { deny: ['ghost-tool'] } },
    },
  })
  assert.equal(res.status, 200)
  assert.equal(jsonBody(res)['ok'], true)
})

test('POST save with a stale expectedHash conflicts (409) and carries the fresh view', async () => {
  const host = hostWith()
  const res = await postJson(host.web, { op: 'save', entries: { 'new-entry': { ...ENTRY } }, expectedHash: 'stale-hash' })
  assert.equal(res.status, 409)
  const body = jsonBody(res)
  assert.equal(body['error'], 'conflict')
  // k3-helper review: the 409 must carry the fresh view so the editor can
  // merge and re-apply instead of blind-retrying.
  assert.ok((body['entries'] as Record<string, unknown>)['good-entry'] !== undefined)
  assert.equal(typeof body['hash'], 'string')
})

test('POST save ignores a non-string expectedHash (documented leniency)', async () => {
  const host = hostWith()
  const res = await postJson(host.web, { op: 'save', entries: { 'new-entry': { ...ENTRY } }, expectedHash: 0.5 })
  assert.equal(res.status, 200)
})

test('POST delete removes the file and the legacy copy; invalid ids are rejected', async () => {
  const host = hostWith({ baseEntries: {}, user: { entries: { doomed: { ...ENTRY } } }, rosterFiles: { '/roster/filed.yaml': 'description: x\n' } })
  const doomed = await postJson(host.web, { op: 'delete', id: 'doomed' })
  assert.equal(doomed.status, 200)
  assert.deepEqual(Object.keys(jsonBody(doomed)['entries'] as Record<string, unknown>), ['filed'])
  assert.equal((host.settings.userSection()?.['entries'] as Record<string, unknown>)?.['doomed'], undefined)

  const filed = await postJson(host.web, { op: 'delete', id: 'filed' })
  assert.equal(filed.status, 200)
  assert.deepEqual(Object.keys(jsonBody(filed)['entries'] as Record<string, unknown>), [])
  assert.equal(host.fs.files()['/roster/filed.yaml'], undefined)

  const bad = await postJson(host.web, { op: 'delete', id: '__proto__' })
  assert.equal(bad.status, 400)
  assert.equal(jsonBody(bad)['error'], 'invalid-id')
})

test('readonly settings no longer block roster writes; legacy-only deletes just skip the unset', async () => {
  // Files are not the settings service: FS errors surface per op (500), and a
  // read-only settings service only means the legacy copy cannot be unset.
  const host = hostWith({ writable: false })
  const save = await postJson(host.web, { op: 'save', entries: { 'new-entry': { ...ENTRY } } })
  assert.equal(save.status, 200)
  assert.ok(host.fs.files()['/roster/new-entry.yaml'] !== undefined)
})

test('POST clear-legacy unsets the migrated legacy copies and reports the count', async () => {
  // Legacy entries live in the settings user layer (the settings.yaml
  // document); the first read migrates them into roster files, so every
  // legacy copy is "shadowed" and safe to clear.
  const host = hostWith({ user: { entries: { alpha: { ...ENTRY }, beta: { description: 'beta role' } } } })
  const before = await dispatch(host.web, API_PATH)
  assert.equal((jsonBody(before)['legacyCount'] as number | undefined) ?? 0, 2, 'both legacy copies are shadowed by files')
  assert.ok(host.fs.files()['/roster/alpha.yaml'] !== undefined, 'migration exported alpha before clearing')

  const res = await postJson(host.web, { op: 'clear-legacy' })
  assert.equal(res.status, 200)
  const body = jsonBody(res)
  assert.equal(body['legacyCount'], 0)
  assert.deepEqual(Object.keys(body['entries'] as Record<string, unknown>).sort(), ['alpha', 'beta'], 'the roster files keep serving')
  assert.deepEqual(host.settings.userSection()?.['entries'], {}, 'settings.yaml entries are now empty')
})

test('POST rejects an unknown op (400 unknown-op)', async () => {
  const host = hostWith()
  const res = await postJson(host.web, { op: 'explode' })
  assert.equal(res.status, 400)
  assert.equal(jsonBody(res)['error'], 'unknown-op')
})

test('unsupported methods get 405', async () => {
  const host = hostWith()
  const res = await dispatch(host.web, API_PATH, { method: 'PUT', headers: { host: '127.0.0.1:3080' } })
  assert.equal(res.status, 405)
  assert.equal(jsonBody(res)['error'], 'method-not-allowed')
})
