/**
 * Profile-scoped model routes (issue #3). The shared roster must not make
 * desktop call a provider that exists only in the web profile.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parse as parseYaml } from 'yaml'
import { API_PATH, dispatch, jsonBody, makeHost, postJson } from './helpers.ts'
import {
  isSafeProfileName,
  parseRouteOverlay,
  preserveSharedRoute,
  resolveEffectiveEntry,
  type Entry,
} from '../src/profile-route.ts'

const ENTRY: Entry = {
  description: 'shared role',
  provider: 'web-only',
  model: 'web-model',
  reasoningEffort: 'high',
  persona: 'stay shared',
}

test('a provider missing from this profile is not called', () => {
  const resolved = resolveEffectiveEntry(ENTRY, undefined, new Set(['desktop-gateway']))
  assert.equal(resolved.note, 'foreign-ignored')
  assert.equal(resolved.entry.provider, undefined)
  assert.equal(resolved.entry.model, undefined)
  assert.equal(resolved.entry.reasoningEffort, undefined)
  assert.equal(resolved.entry.persona, 'stay shared')
})

test('a provider registered here keeps the shared route', () => {
  const resolved = resolveEffectiveEntry(ENTRY, undefined, new Set(['web-only']))
  assert.equal(resolved.note, 'shared')
  assert.equal(resolved.entry.provider, 'web-only')
  assert.equal(resolved.entry.model, 'web-model')
})

test('without an LLM registry the shared route is left alone', () => {
  const resolved = resolveEffectiveEntry(ENTRY, undefined, undefined)
  assert.equal(resolved.note, 'shared')
  assert.equal(resolved.entry.provider, 'web-only')
})

test('a profile overlay replaces the shared route', () => {
  const resolved = resolveEffectiveEntry(ENTRY, { provider: 'desktop-gateway', model: 'desk' }, new Set(['desktop-gateway']))
  assert.equal(resolved.note, 'profile')
  assert.equal(resolved.entry.provider, 'desktop-gateway')
  assert.equal(resolved.entry.model, 'desk')
  assert.equal(resolved.entry.persona, 'stay shared')
})

test('inherit drops the shared route even when that provider exists here', () => {
  const resolved = resolveEffectiveEntry(ENTRY, { inherit: true }, new Set(['web-only']))
  assert.equal(resolved.note, 'inherit')
  assert.equal(resolved.entry.provider, undefined)
})

test('an overlay provider missing from this profile is reported, not silently swapped', () => {
  const resolved = resolveEffectiveEntry(ENTRY, { provider: 'missing' }, new Set(['desktop-gateway']))
  assert.equal(resolved.note, 'profile-missing')
  assert.equal(resolved.entry.provider, 'missing')
})

test('profile names cannot escape the roster directory', () => {
  assert.equal(isSafeProfileName('desktop'), true)
  assert.equal(isSafeProfileName('web'), true)
  assert.equal(isSafeProfileName('my profile'), true)
  assert.equal(isSafeProfileName('../web'), false)
  assert.equal(isSafeProfileName('desktop/extra'), false)
  assert.equal(isSafeProfileName(''), false)
  assert.equal(isSafeProfileName('desktop.'), false)
  assert.equal(isSafeProfileName('CON'), false)
})

test('parseRouteOverlay rejects a mixed inherit document', () => {
  assert.deepEqual(parseRouteOverlay({ inherit: true }), { inherit: true })
  assert.throws(() => parseRouteOverlay({ inherit: true, provider: 'x' }), /cannot be combined/)
})

test('preserveSharedRoute keeps the other profile\'s provider while taking this profile\'s description', () => {
  const next = preserveSharedRoute(
    { description: 'edited here', provider: 'desktop-gateway', model: 'desk' },
    ENTRY,
  )
  assert.equal(next.description, 'edited here')
  assert.equal(next.provider, 'web-only')
  assert.equal(next.model, 'web-model')
})

test('desktop delegate does not call a web-only provider', async () => {
  const host = makeHost({
    profileName: 'desktop',
    llmProviders: ['desktop-gateway'],
    subagentProviders: ['spawn'],
    rosterFiles: {
      '/roster/reviewer.yaml': 'description: shared role\nprovider: web-only\nmodel: web-model\n',
    },
  })
  const tool = host.tools.get('delegate')
  assert.ok(tool)
  const result = await tool.execute(
    { library_id: 'reviewer', prompt: 'x' },
    { agent: { fake: 'parent' }, signal: new AbortController().signal },
  ) as { routeNote?: string }
  assert.equal(host.subagentStarts.length, 1)
  assert.equal(Object.hasOwn(host.subagentStarts[0]?.request ?? {}, 'agentOptions'), false)
  assert.match(result.routeNote ?? '', /not registered/)
})

test('desktop settings save pins a local route and leaves the shared provider untouched', async () => {
  const host = makeHost({
    profileName: 'desktop',
    llmProviders: ['desktop-gateway'],
    subagentProviders: ['spawn'],
    rosterFiles: {
      '/roster/reviewer.yaml': 'description: shared role\nprovider: web-only\nmodel: web-model\n',
    },
  })
  const before = jsonBody(await dispatch(host.web, API_PATH))
  const listed = host.tools.get('list_subagents')
  assert.ok(listed)
  const rows = await listed.execute({}, { agent: { fake: 'parent' }, signal: new AbortController().signal }) as Array<Record<string, unknown>>
  assert.equal(rows[0]?.['provider'], '(session default)')
  assert.match(String(rows[0]?.['routeNote']), /web-only/)

  const saved = await postJson(host.web, {
    op: 'save',
    expectedHash: before['hash'],
    entries: {
      reviewer: {
        description: 'shared role',
        provider: 'desktop-gateway',
        model: 'desk-model',
      },
    },
  })
  assert.equal(saved.status, 200, saved.body)
  const shared = parseYaml(String(host.fs.files()['/roster/reviewer.yaml'])) as Record<string, unknown>
  assert.equal(shared['provider'], 'web-only', 'shared file must keep the other profile route')
  const overlay = Object.entries(host.fs.files()).find(([path]) => path.includes('/_profiles/desktop/reviewer.yaml'))
  assert.ok(overlay, `overlay missing: ${Object.keys(host.fs.files()).join(', ')}`)
  assert.match(overlay[1], /desktop-gateway/)

  await host.tools.get('delegate')!.execute(
    { library_id: 'reviewer', prompt: 'x' },
    { agent: { fake: 'parent' }, signal: new AbortController().signal },
  )
  assert.deepEqual(host.subagentStarts.at(-1)?.request['agentOptions'], {
    provider: 'desktop-gateway',
    model: 'desk-model',
  })
})

test('a full-snapshot description edit does not pin inherit over a hidden foreign route', async () => {
  const host = makeHost({
    profileName: 'desktop',
    llmProviders: ['desktop-gateway'],
    subagentProviders: ['spawn'],
    rosterFiles: {
      '/roster/reviewer.yaml': 'description: shared role\nprovider: web-only\nmodel: web-model\n',
      '/roster/other.yaml': 'description: other role\nprovider: web-only\nmodel: other-model\n',
    },
  })
  const before = jsonBody(await dispatch(host.web, API_PATH))
  const entries = before['entries'] as Record<string, Record<string, unknown>>
  assert.equal(entries['reviewer']?.['provider'], undefined)
  assert.equal(entries['other']?.['provider'], undefined)
  assert.equal(entries['reviewer']?.['routeNote'], 'foreign-ignored')
  const saved = await postJson(host.web, {
    op: 'save',
    expectedHash: before['hash'],
    entries: {
      reviewer: { ...entries['reviewer'], description: 'edited description', routeNote: 'foreign-ignored' },
      other: entries['other'],
    },
  })
  assert.equal(saved.status, 200, saved.body)
  const files = host.fs.files()
  assert.equal(Object.keys(files).some((path) => path.includes('/_profiles/')), false, JSON.stringify(files))
  const shared = parseYaml(String(files['/roster/reviewer.yaml'])) as Record<string, unknown>
  assert.equal(shared['description'], 'edited description')
  assert.equal(shared['provider'], 'web-only')
  const other = parseYaml(String(files['/roster/other.yaml'])) as Record<string, unknown>
  assert.equal(other['provider'], 'web-only')

  const later = makeHost({
    profileName: 'desktop',
    llmProviders: ['web-only', 'desktop-gateway'],
    subagentProviders: ['spawn'],
    rosterFiles: files,
  })
  await later.tools.get('delegate')!.execute(
    { library_id: 'reviewer', prompt: 'x' },
    { agent: { fake: 'parent' }, signal: new AbortController().signal },
  )
  assert.deepEqual(later.subagentStarts[0]?.request['agentOptions'], {
    provider: 'web-only',
    model: 'web-model',
  })
})

test('profile-missing overlay refuses to start', async () => {
  const host = makeHost({
    profileName: 'desktop',
    llmProviders: ['desktop-gateway'],
    subagentProviders: ['spawn'],
    rosterFiles: {
      '/roster/reviewer.yaml': 'description: shared role\nprovider: web-only\nmodel: web-model\n',
      '/roster/_profiles/desktop/reviewer.yaml': 'provider: missing\nmodel: nope\n',
    },
  })
  await assert.rejects(
    () => host.tools.get('delegate')!.execute(
      { library_id: 'reviewer', prompt: 'x' },
      { agent: { fake: 'parent' }, signal: new AbortController().signal },
    ),
    /not registered in this profile/,
  )
  assert.equal(host.subagentStarts.length, 0)
})

test('deleting an entry drops its overlay so a recreated id does not revive the old route', async () => {
  const host = makeHost({
    profileName: 'desktop',
    llmProviders: ['desktop-gateway', 'web-only'],
    subagentProviders: ['spawn'],
    rosterFiles: {
      '/roster/reviewer.yaml': 'description: shared role\nprovider: web-only\nmodel: web-model\n',
    },
  })
  const before = jsonBody(await dispatch(host.web, API_PATH))
  const pinned = await postJson(host.web, {
    op: 'save',
    expectedHash: before['hash'],
    entries: {
      reviewer: { description: 'shared role', provider: 'desktop-gateway', model: 'desk-model' },
    },
  })
  assert.equal(pinned.status, 200, pinned.body)
  assert.ok(Object.keys(host.fs.files()).some((path) => path.includes('/_profiles/desktop/reviewer.yaml')))
  const hash = jsonBody(pinned)['hash']
  const removed = await postJson(host.web, { op: 'delete', id: 'reviewer', expectedHash: hash })
  assert.equal(removed.status, 200, removed.body)
  assert.equal(Object.keys(host.fs.files()).some((path) => path.includes('reviewer')), false)

  await host.fs.writeFile('/roster/reviewer.yaml', 'description: recreated\nprovider: web-only\nmodel: new-model\n')
  await host.tools.get('delegate')!.execute(
    { library_id: 'reviewer', prompt: 'x' },
    { agent: { fake: 'parent' }, signal: new AbortController().signal },
  )
  assert.deepEqual(host.subagentStarts[0]?.request['agentOptions'], {
    provider: 'web-only',
    model: 'new-model',
  })
})

test('a hand-deleted roster file loses its overlay on the next read', async () => {
  const host = makeHost({
    profileName: 'desktop',
    llmProviders: ['desktop-gateway', 'fresh'],
    subagentProviders: ['spawn'],
    rosterFiles: {
      '/roster/reviewer.yaml': 'description: shared role\nprovider: web-only\nmodel: web-model\n',
      '/roster/_profiles/desktop/reviewer.yaml': 'provider: desktop-gateway\nmodel: old\nboundHash: deadbeefdeadbeef\n',
    },
  })
  await host.fs.unlink('/roster/reviewer.yaml')
  await host.tools.get('list_subagents')!.execute({}, { agent: { fake: 'parent' }, signal: new AbortController().signal })
  assert.equal(Object.keys(host.fs.files()).some((path) => path.includes('reviewer')), false)
  await host.fs.writeFile('/roster/reviewer.yaml', 'description: recreated\nprovider: fresh\nmodel: new-model\n')
  await host.tools.get('delegate')!.execute(
    { library_id: 'reviewer', prompt: 'x' },
    { agent: { fake: 'parent' }, signal: new AbortController().signal },
  )
  assert.deepEqual(host.subagentStarts[0]?.request['agentOptions'], {
    provider: 'fresh',
    model: 'new-model',
  })
})

test('an unsafe profile name does not write its route into the shared file', async () => {
  const host = makeHost({
    profileName: 'desktop.',
    llmProviders: ['desktop-gateway'],
    subagentProviders: ['spawn'],
    rosterFiles: {
      '/roster/reviewer.yaml': 'description: shared role\nprovider: web-only\nmodel: web-model\n',
    },
  })
  await host.tools.get('delegate')!.execute(
    { library_id: 'reviewer', prompt: 'x' },
    { agent: { fake: 'parent' }, signal: new AbortController().signal },
  )
  assert.equal(Object.hasOwn(host.subagentStarts[0]?.request ?? {}, 'agentOptions'), false)
  const before = jsonBody(await dispatch(host.web, API_PATH))
  const rejected = await postJson(host.web, {
    op: 'save',
    expectedHash: before['hash'],
    entries: {
      reviewer: { description: 'shared role', provider: 'desktop-gateway', model: 'desk' },
    },
  })
  assert.equal(rejected.status, 400)
  assert.equal(jsonBody(rejected)['error'], 'profile-path')
  const shared = parseYaml(String(host.fs.files()['/roster/reviewer.yaml'])) as Record<string, unknown>
  assert.equal(shared['provider'], 'web-only')
})

test('web still uses the shared route after desktop pins its own', async () => {
  const desktop = makeHost({
    profileName: 'desktop',
    llmProviders: ['desktop-gateway'],
    subagentProviders: ['spawn'],
    rosterFiles: {
      '/roster/reviewer.yaml': 'description: shared role\nprovider: web-only\nmodel: web-model\n',
    },
  })
  const listed = jsonBody(await dispatch(desktop.web, API_PATH))
  const saved = await postJson(desktop.web, {
    op: 'save',
    expectedHash: listed['hash'],
    entries: {
      reviewer: { description: 'shared role', provider: 'desktop-gateway', model: 'desk-model' },
    },
  })
  assert.equal(saved.status, 200, saved.body)

  const web = makeHost({
    profileName: 'web',
    llmProviders: ['web-only'],
    subagentProviders: ['spawn'],
    rosterFiles: desktop.fs.files(),
  })
  await web.tools.get('delegate')!.execute(
    { library_id: 'reviewer', prompt: 'x' },
    { agent: { fake: 'parent' }, signal: new AbortController().signal },
  )
  assert.deepEqual(web.subagentStarts[0]?.request['agentOptions'], {
    provider: 'web-only',
    model: 'web-model',
  })
})
