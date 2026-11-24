/**
 * Client wire-contract tests (k3 review round 2: src/client had ZERO tests,
 * and both findings — the dropped legacyCount, the 409 view shape — lived
 * exactly on this layer). No fetch: only the pure mapping is exercised.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseView } from '../src/client/index.tsx'
import { freshDraft, rebase, saveWrite, serverForm } from '../src/client/editor-state.ts'

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
  assert.deepEqual(view.groups, {})
  assert.deepEqual(view.roleUsages, {})
  assert.deepEqual(view.diagnostics, [])
  assert.equal(view.hash, '')
  assert.equal(view.profile, undefined)
})

test('the editor receives member order, role references and both versions of the route', () => {
  const members = [
    { slot: 'facts', role: 'writer', assignment: 'check facts', launchable: false, reason: 'role disabled' },
    { slot: 'wording', role: 'writer', launchable: false, reason: 'role disabled' },
  ]
  const view = parseView({
    entries: { writer: { provider: 'local' } },
    sharedEntries: { writer: { provider: 'shared' } },
    groups: { editorial: { description: 'edit text', members } },
    roleUsages: { writer: members.map(({ slot }) => ({ groupId: 'editorial', slot })) },
  })
  assert.deepEqual(view.groups.editorial.members, members)
  assert.deepEqual(view.roleUsages.writer.map(ref => ref.slot), ['facts', 'wording'])
  assert.equal(view.entries.writer.provider, 'local')
  assert.equal(view.sharedEntries.writer.provider, 'shared')
})

test('parseView keeps the current profile so the settings page can say whose models it edits', () => {
  const view = parseView({
    profile: 'desktop',
    entries: { reviewer: { description: 'x', routeNote: 'foreign-ignored' } },
  })
  assert.equal(view.profile, 'desktop')
  assert.equal(view.entries['reviewer']?.routeNote, 'foreign-ignored')
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

test('editing a description leaves the profile route and existing tool restrictions to the server', () => {
  const view = parseView({ profile: 'desktop', hash: 'current', entries: {
    writer: { description: 'old', provider: 'desktop-models', routeNote: 'profile', toolFilter: { deny: ['edit'] } },
  } })
  const draft = freshDraft(view, 'roles', 'writer')
  const write = saveWrite({ ...draft, form: { ...draft.form, description: 'new' } }, view)
  assert.deepEqual(write, { op: 'save-entry', id: 'writer', expectedHash: 'current', entry: { description: 'new' } })
})

test('editing a role without a profile preserves its shared model and a zero depth limit', () => {
  const view = parseView({ hash: 'shared', entries: { writer: { description: 'old', maxDepth: 0 } },
    sharedEntries: { writer: { description: 'old', model: 'shared-model', maxDepth: 0 } } })
  const draft = freshDraft(view, 'roles', 'writer')
  assert.equal(draft.form.kind, 'roles')
  if (draft.form.kind !== 'roles') return
  assert.equal(draft.form.model, 'shared-model')
  const write = saveWrite({ ...draft, form: { ...draft.form, description: 'new' } }, view)
  assert.deepEqual(write, { op: 'save-entry', id: 'writer', expectedHash: 'shared', entry: { description: 'new', maxDepth: 0 } })
  const newModel = saveWrite({ ...draft, form: { ...draft.form, model: 'new-model' } }, view)
  assert.equal(newModel.op, 'save-entry')
  if (newModel.op === 'save-entry') assert.deepEqual(newModel.route, { model: 'new-model' })
  const clear = saveWrite({ ...draft, form: { ...draft.form, model: '' } }, view)
  assert.equal(clear.op, 'save-entry')
  if (clear.op === 'save-entry') assert.deepEqual(clear.route, { inherit: true })
})

test('after comparing a conflict, the next save retains unedited fields from the server', () => {
  const old = parseView({ hash: 'old', groups: {
    crew: { description: 'edit me', members: [{ slot: 'first', role: 'writer' }] },
  } })
  const updated = parseView({ hash: 'updated', groups: {
    crew: { description: 'edit me', members: [{ slot: 'first', role: 'writer', assignment: 'updated elsewhere' }] },
  } })
  const draft = freshDraft(old, 'groups', 'crew')
  const kept = rebase({ ...draft, form: { ...draft.form, description: 'my draft' } }, serverForm(updated, 'groups', 'crew'))
  const write = saveWrite(kept, updated)
  assert.equal(write.op, 'save-group')
  if (write.op !== 'save-group') return
  assert.equal(write.expectedHash, 'updated')
  assert.equal(write.group.description, 'my draft')
  assert.deepEqual(write.group.members, [{ slot: 'first', role: 'writer', assignment: 'updated elsewhere' }])
})

test('recreating a concurrently deleted role keeps the tool restrictions from its draft', () => {
  const filter = { deny: ['edit'] }
  const old = parseView({ entries: { writer: { description: 'old', toolFilter: filter } } })
  const draft = freshDraft(old, 'roles', 'writer')
  const deleted = parseView({ hash: 'after-delete' })
  const kept = rebase({ ...draft, form: { ...draft.form, description: 'restored' } }, undefined)
  assert.deepEqual(saveWrite(kept, deleted), { op: 'save-entry', id: 'writer', expectedHash: 'after-delete',
    entry: { description: 'restored', toolFilter: filter } })
})
