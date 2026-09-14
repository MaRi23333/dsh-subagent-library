/**
 * Client wire-contract tests (k3 review round 2: src/client had ZERO tests,
 * and both findings — the dropped legacyCount, the 409 view shape — lived
 * exactly on this layer). No fetch: only the pure mapping is exercised.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseView } from '../src/client/index.tsx'

test('parseView maps legacyCount — the migration banner depends on it', () => {
  const view = parseView({
    ok: true,
    writable: true,
    dir: '/roster',
    hash: 'abc123',
    entries: { a: { description: 'x' } },
    diagnostics: [],
    legacyCount: 3,
  })
  assert.equal(view.legacyCount, 3)
  assert.equal(view.hash, 'abc123')
})

test('parseView defaults every optional field', () => {
  const view = parseView({})
  assert.equal(view.legacyCount, 0)
  assert.equal(view.writable, true)
  assert.deepEqual(view.entries, {})
  assert.deepEqual(view.diagnostics, [])
  assert.equal(view.hash, '')
})

test('409 wire contract: the fresh view rides in `view` and parses cleanly', () => {
  // Server shape (index.ts): { ok:false, error:'conflict', view: {…} }
  const conflictBody = {
    ok: false,
    error: 'conflict',
    view: {
      ok: true,
      writable: true,
      dir: '/roster',
      hash: 'fresh-hash',
      entries: { other: { description: 'server value' } },
      diagnostics: [{ severity: 'info' as const, id: 'x', message: 'shadowed' }],
      legacyCount: 2,
    },
  }
  assert.equal(conflictBody.error, 'conflict')
  const view = parseView(conflictBody.view)
  assert.equal(view.hash, 'fresh-hash')
  assert.equal(view.legacyCount, 2)
  assert.equal(view.entries['other']?.description, 'server value')
})
