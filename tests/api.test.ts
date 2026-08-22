/**
 * Settings-API route tests (SUB-TEST-001): the write-path negative matrix
 * (415 / 403 / 413 / 400 / 409), entry-id validation incl. prototype-polluting
 * keys, replace-semantics persistence, and the settingsFailure diagnostic.
 * All traffic goes through the real handler mounted by apply() against
 * in-memory doubles — no network, files or credentials.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { API_PATH, dispatch, jsonBody, makeHost, postJson, type MockHost } from './helpers.ts'

const ENTRY = { description: 'fake role for tests' }

function hostWith(options: Parameters<typeof makeHost>[0] = {}): MockHost {
  return makeHost({ baseEntries: { 'good-entry': { ...ENTRY } }, ...options })
}

test('GET returns the view and filters schema-invalid entry ids out', async () => {
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
  assert.deepEqual(Object.keys(body['entries'] as Record<string, unknown>), ['good-entry'])
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
  ]
  for (const entries of cases) {
    const host = hostWith()
    const res = await postJson(host.web, { op: 'save', entries })
    assert.equal(res.status, 400, JSON.stringify(entries))
    assert.equal(jsonBody(res)['error'], 'invalid-entry-id')
  }
})

test('POST save rejects entries failing the Config schema (400 rejected)', async () => {
  const host = hostWith()
  const res = await postJson(host.web, { op: 'save', entries: { 'no-description': {} } })
  assert.equal(res.status, 400)
  assert.equal(jsonBody(res)['error'], 'rejected')
})

test('POST save wholesale-replaces entries and preserves other user keys', async () => {
  const host = hostWith({
    user: { subagentProvider: 'fork', entries: { 'stale-entry': { ...ENTRY } } },
  })
  const res = await postJson(host.web, { op: 'save', entries: { 'fresh-entry': { ...ENTRY } } })
  assert.equal(res.status, 200)
  const body = jsonBody(res)
  assert.deepEqual(Object.keys(body['entries'] as Record<string, unknown>), ['fresh-entry'])
  // The replace must spread the previous user section underneath (design #9).
  assert.equal(host.settings.userSection()?.['subagentProvider'], 'fork')
  assert.equal(body['revision'], 1)
})

test('POST save with a stale expectedRevision conflicts (409)', async () => {
  const host = hostWith()
  const res = await postJson(host.web, { op: 'save', entries: { 'new-entry': { ...ENTRY } }, expectedRevision: 99 })
  assert.equal(res.status, 409)
  assert.equal(jsonBody(res)['error'], 'conflict')
})

test('POST save ignores a non-integer expectedRevision (documented leniency)', async () => {
  const host = hostWith()
  const res = await postJson(host.web, { op: 'save', entries: { 'new-entry': { ...ENTRY } }, expectedRevision: 0.5 })
  assert.equal(res.status, 200)
})

test('POST save rejects a toolFilter naming unregistered tools (400 invalid-tool-name)', async () => {
  const host = hostWith({ knownTools: ['read'] })
  const bad = await postJson(host.web, {
    op: 'save',
    entries: { 'filtered-entry': { ...ENTRY, toolFilter: { deny: ['ghost-tool'] } } },
  })
  assert.equal(bad.status, 400)
  assert.equal(jsonBody(bad)['error'], 'invalid-tool-name')

  const good = await postJson(host.web, {
    op: 'save',
    entries: { 'filtered-entry': { ...ENTRY, toolFilter: { deny: ['read'] } } },
  })
  assert.equal(good.status, 200)
})

test('POST delete removes an entry; invalid delete ids are rejected', async () => {
  const host = hostWith({ user: { entries: { doomed: { ...ENTRY } } } })
  const ok = await postJson(host.web, { op: 'delete', id: 'doomed' })
  assert.equal(ok.status, 200)
  assert.deepEqual(Object.keys(jsonBody(ok)['entries'] as Record<string, unknown>), [])

  const bad = await postJson(host.web, { op: 'delete', id: '__proto__' })
  assert.equal(bad.status, 400)
  assert.equal(jsonBody(bad)['error'], 'invalid-id')
})

test('POST rejects writes in readonly mode (403 readonly)', async () => {
  const host = hostWith({ writable: false })
  const res = await postJson(host.web, { op: 'save', entries: { 'new-entry': { ...ENTRY } } })
  assert.equal(res.status, 403)
  assert.equal(jsonBody(res)['error'], 'readonly')
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
