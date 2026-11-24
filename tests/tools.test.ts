import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import { makeHost, postJson, type MockHost } from './helpers.ts'

function tool(host: MockHost, name: string) {
  const registered = host.tools.get(name)
  assert.ok(registered, `tool not registered: ${name}`)
  return registered
}

/** The calling agent object — dsh-tools' scope key (never its Context). */
const AGENT = { id: 'lead-session', options: { provider: 'parent-provider', model: 'parent-model', reasoningEffort: 'high' }, session: { header: {} } }
const EXEC = { agent: AGENT, signal: new AbortController().signal }

test('separate member calls opt into parallel tool scheduling', () => {
  const host = makeHost({ baseEntries: { reader: { description: 'Read material' } } })
  const delegate = tool(host, 'delegate')
  assert.ok('isConcurrencySafe' in delegate && typeof delegate.isConcurrencySafe === 'function')
  for (const target of [{ library_id: 'reader' }, { group_id: 'pair', slot: 'first' }]) {
    assert.equal(delegate.isConcurrencySafe({ ...target, prompt: 'Check your assignment.' }), true)
  }
  assert.match(delegate.description, /separate delegate calls in the same response/)
})

test('delegate rejects ids that fail ENTRY_ID', async () => {
  const host = makeHost({ baseEntries: { reader: { description: 'fake' } } })
  await assert.rejects(
    () => tool(host, 'delegate').execute({ library_id: '__proto__', prompt: 'x' }, EXEC),
    /entry id "__proto__" is invalid/,
  )
})

test('delegate never resolves prototype-chain names as entries', async () => {
  // `constructor` passes ENTRY_ID; only the own-property lookup keeps it from
  // delegating into an inherited function (k3-helper finding #1).
  const host = makeHost({ baseEntries: { reader: { description: 'fake' } } })
  await assert.rejects(
    () => tool(host, 'delegate').execute({ library_id: 'constructor', prompt: 'x' }, EXEC),
    /has no entry "constructor" \(available: reader\)/,
  )
})

test('delegate names the available entries for an unknown id', async () => {
  const host = makeHost({ baseEntries: { reader: { description: 'fake' } } })
  await assert.rejects(
    () => tool(host, 'delegate').execute({ library_id: 'ghost', prompt: 'x' }, EXEC),
    /has no entry "ghost" \(available: reader\)/,
  )
})

test('delegate reports an unregistered transport before doing any work', async () => {
  const host = makeHost({ baseEntries: { reader: { description: 'fake' } } })
  await assert.rejects(
    () => tool(host, 'delegate').execute({ library_id: 'reader', prompt: 'x' }, EXEC),
    /subagent transport provider "spawn" is not registered/,
  )
})

test('both tools throw the settingsFailure diagnostic when registration failed', async () => {
  const host = makeHost({ failRegister: true, baseEntries: { reader: { description: 'fake' } } })
  await assert.rejects(() => tool(host, 'list_subagents').execute({}, EXEC), /注册失败/)
  await assert.rejects(
    () => tool(host, 'delegate').execute({ library_id: 'reader', prompt: 'x' }, EXEC),
    /注册失败/,
  )
})

test('list_subagents marks disabled entries and surfaces roster diagnostics', async () => {
  const host = makeHost({
    rosterFiles: {
      '/roster/off.yaml': 'description: disabled role\nenabled: false\n',
      '/roster/on.yaml': 'description: live role\n',
      '/roster/broken.yaml': 'description: [oops\n',
    },
  })
  const rows = (await tool(host, 'list_subagents').execute({}, EXEC)) as Array<Record<string, unknown>>
  const off = rows.find((row) => row['id'] === 'off')
  assert.equal(off?.['enabled'], false)
  assert.equal(rows.find((row) => row['id'] === 'on')?.['enabled'], undefined)
  const diagnostics = rows.find((row) => row['diagnostics'] !== undefined) as Record<string, unknown> | undefined
  assert.ok(diagnostics !== undefined, 'broken roster files must be visible to the model')
  assert.match(JSON.stringify(diagnostics), /\[broken\]/)
})

test('delegate refuses a disabled entry before any transport work', async () => {
  const host = makeHost({
    subagentProviders: ['spawn'],
    rosterFiles: { '/roster/off.yaml': 'description: disabled role\nenabled: false\n' },
  })
  await assert.rejects(
    () => tool(host, 'delegate').execute({ library_id: 'off', prompt: 'x' }, EXEC),
    /entry "off" is disabled/,
  )
  assert.equal(host.subagentStarts.length, 0)
})

test('legacy base entries migrate into roster files on first read and keep serving', async () => {
  const host = makeHost({
    baseEntries: { migrated: { description: 'from settings', provider: 'qwen' } },
  })
  const rows = (await tool(host, 'list_subagents').execute({}, EXEC)) as Array<Record<string, unknown>>
  assert.deepEqual(rows.map((row) => row['id']), ['migrated'])
  // The migration wrote the file; the row now comes from the roster file, and
  // the legacy copy is still in settings (rollback copy until 0.4.0).
  assert.match(String(host.fs.files()['/roster/migrated.yaml']), /from settings/)
  const second = (await tool(host, 'list_subagents').execute({}, EXEC)) as Array<Record<string, unknown>>
  assert.deepEqual(second.map((row) => row['id']), ['migrated'], 'second read stays stable (idempotent migration)')
})

test('delegate passes reasoningEffort through agentOptions and reports the model route', async () => {
  // resolveChildAgentOptions merges agentOptions over the parent's options and
  // drops an inherited effort when the route changes — an explicit entry-level
  // reasoningEffort rides the same official override.
  const host = makeHost({
    subagentProviders: ['spawn'],
    baseEntries: {
      thinker: {
        description: 'fake',
        provider: 'qwen',
        model: 'qwen3.8-flash',
        reasoningEffort: 'high',
        maxTokens: 4096,
      },
    },
    sessionProjections: { stateOf() { throw new Error('A saved route must not read model selection policy') } },
  })
  const delegate = tool(host, 'delegate')
  const args = { library_id: 'thinker', prompt: 'x', description: '  Check the reasoning  ' }
  const receipt = await delegate.execute(args, EXEC)
  assert.deepEqual(receipt, {
    kind: 'activation', library_id: 'thinker', name: 'agent-1', subagentId: 'child-1',
    provider: 'qwen', model: 'qwen3.8-flash', reasoningEffort: 'high',
  })
  assert.deepEqual(JSON.parse(delegate.output.render(args, receipt)[0].text), receipt)
  assert.equal(host.subagentStarts.length, 1)
  assert.equal(host.subagentStarts[0].request.label, 'thinker [qwen3.8-flash · high] · Check the reasoning')
  assert.deepEqual(host.subagentStarts[0]?.request['agentOptions'], {
    provider: 'qwen',
    model: 'qwen3.8-flash',
    reasoningEffort: 'high',
    maxTokens: 4096,
  })
  assert.ok(!host.servicesRead.includes('sessionProjections'))
})

test('a transiently failed migration retries on the next roster read (A5)', async () => {
  // The latch must only engage on SUCCESS: one AV-lock during export must not
  // strand the entry on the legacy path until 0.4 removes legacy reading.
  const host = makeHost({ baseEntries: { retry: { description: 'retry me' } } })
  const originalWrite = host.fs.writeFile.bind(host.fs)
  let broke = false
  const flakyWrite = async (path: string, data: string): Promise<void> => {
    // writeEntryFile writes a DOT-TEMP file first; inject the failure there.
    const normalized = path.replaceAll('\\', '/')
    if (!broke && /(^|\/)\.retry\..+\.tmp$/.test(normalized)) {
      broke = true
      throw Object.assign(new Error('EPERM transient'), { code: 'EPERM' })
    }
    return originalWrite(path, data)
  }
  ;(host.fs as { writeFile: (path: string, data: string) => Promise<void> }).writeFile = flakyWrite

  const first = (await tool(host, 'list_subagents').execute({}, EXEC)) as Array<Record<string, unknown>>
  assert.equal(host.fs.files()['/roster/retry.yaml'], undefined, 'first attempt failed')
  const diag = first.find((row) => row['diagnostics'] !== undefined) as Record<string, unknown> | undefined
  assert.ok(diag !== undefined && JSON.stringify(diag).includes('自动重试'), 'the failure must be visible and promise a retry')

  ;(host.fs as { writeFile: (path: string, data: string) => Promise<void> }).writeFile = originalWrite
  await tool(host, 'list_subagents').execute({}, EXEC)
  assert.match(String(host.fs.files()['/roster/retry.yaml']), /retry me/, 'the retry must succeed without a restart')
})

test('delegate inherits the session route without looking up a model for unset or maxTokens-only overrides', async () => {
  const checks: unknown[] = []
  const host = makeHost({
    subagentProviders: ['spawn'],
    baseEntries: { plain: { description: 'plain role' }, limited: { description: 'limited role', maxTokens: 4096 } },
    routeCheck: async route => { checks.push(route) },
  })
  const delegate = tool(host, 'delegate')
  const route = { provider: 'parent-provider', model: 'parent-model', reasoningEffort: 'high' }
  assert.deepEqual(await delegate.execute({ library_id: 'plain', prompt: 'x' }, EXEC), {
    kind: 'activation', library_id: 'plain', name: 'agent-1', subagentId: 'child-1', ...route,
  })
  assert.deepEqual(await delegate.execute({ library_id: 'limited', prompt: 'x' }, EXEC), {
    kind: 'activation', library_id: 'limited', name: 'agent-2', subagentId: 'child-2', ...route,
  })
  assert.equal(Object.hasOwn(host.subagentStarts[0].request, 'agentOptions'), false)
  assert.deepEqual(host.subagentStarts[1].request.agentOptions, { maxTokens: 4096 })
  assert.equal(host.subagentStarts[0].request.label, 'plain [parent-model · high]')
  assert.equal(host.subagentStarts[1].request.label, 'limited [parent-model · high]')
  assert.deepEqual(checks, [])
})

test('delegate omits optional model fields and the label marker when the host has no route to inherit', async () => {
  const host = makeHost({ rosterFiles: groupFiles, subagentProviders: ['spawn'] })
  const delegate = tool(host, 'delegate')
  const ctx = { ...EXEC, agent: { id: 'unconfigured', options: {}, session: { header: {} } } }
  const receipt = await delegate.execute({ library_id: 'author', prompt: 'x', description: 'Review the draft' }, ctx)
  assert.deepEqual(receipt, { kind: 'activation', library_id: 'author', name: 'agent-1', subagentId: 'child-1' })
  assert.equal(host.subagentStarts[0].request.label, 'author · Review the draft')
  await delegate.execute({ group_id: 'pair', slot: 'second', prompt: 'x', description: 'Review the draft' }, ctx)
  assert.equal(host.subagentStarts[1].request.label, 'pair/second · Review the draft')
})

test('schema defaults survive clear-legacy + delete on a raw-patch host (SUB-COMPAT-017-004)', async () => {
  // The 0.1.7 seam writes the ConfigEditor RAW layer back into the resolved
  // closure. The raw layer has NO schema defaults: a wholesale overwrite used
  // to drop `subagentProvider: 'spawn'`, and the next delegate failed with
  // "provider not registered" (platform blocker SUB-COMPAT-017-004).
  const host = makeHost({
    settingsShape: 'forms',
    formsRawOmitsDefaults: true,
    subagentProviders: ['spawn'],
    baseEntries: { alpha: { description: 'a' }, beta: { description: 'b' } },
  })
  const clear = await postJson(host.web, { op: 'clear-legacy' })
  assert.equal(clear.status, 200)
  const del = await postJson(host.web, { op: 'delete', id: 'alpha' })
  assert.equal(del.status, 200)

  // The resolved closure must still know the default transport…
  assert.equal(host.applyConfig['subagentProvider'], 'spawn')
  // …and delegation keeps working through it.
  await tool(host, 'delegate').execute({ library_id: 'beta', prompt: 'x' }, EXEC)
  assert.equal(host.subagentStarts.length, 1)
  assert.equal(host.subagentStarts[0]?.provider, 'spawn')
  assert.equal(host.applyConfig['entriesDir'], '/roster', 'an explicitly configured entriesDir must also survive')
})

const groupFiles = {
  '/roster/author.yaml': 'description: author\npersona: author persona\n',
  '/roster/_groups/pair.yaml': [
    'description: pair', 'instructions: shared instructions', 'members:',
    '  - slot: first', '    role: author', '    assignment: first assignment',
    '  - slot: second', '    role: author', '    assignment: second assignment',
  ].join('\n'),
}

const parentRoute = { provider: AGENT.options.provider, model: AGENT.options.model }
const alternateRoute = { provider: 'local', model: 'alternate' }
const allowParentRoute = { stateOf: () => [parentRoute] }

test('authorized overrides apply once to direct calls and independently to slots of the same role', async () => {
  const savedRoute = { provider: 'local', model: 'saved', reasoningEffort: 'medium', maxTokens: 1600 }
  const checks: Record<string, unknown>[] = []
  let policyRead = false
  const host = makeHost({
    profileName: 'desktop', subagentProviders: ['spawn'], llmProviders: ['local', 'parent-provider'],
    rosterFiles: {
      ...groupFiles,
      '/roster/_profiles/desktop/author.yaml': 'provider: local\nmodel: saved\nreasoningEffort: medium\nmaxTokens: 1600',
    },
    sessionProjections: {
      stateOf(session, key) {
        assert.equal(session, AGENT.session)
        assert.equal(key, 'subagentModelSelectionPolicy')
        policyRead = true
        return [parentRoute, alternateRoute]
      },
    },
    routeCheck: async (route, signal) => {
      assert.equal(signal, EXEC.signal)
      if (route.model !== savedRoute.model) assert.equal(policyRead, true)
      policyRead = false
      checks.push(route)
      return { ...route, reasoningEffort: route.reasoningEffort ?? 'low', maxTokens: 4000 }
    },
  })
  const before = host.fs.files()
  const delegate = tool(host, 'delegate')
  const prompt = 'Review the draft'
  const description = 'Check the ending'
  const direct = { library_id: 'author', prompt, description }
  const first = { group_id: 'pair', slot: 'first', prompt, description }
  const second = { ...first, slot: 'second' }
  const steps = [
    { target: direct, route: alternateRoute, effort: 'max', expectedEffort: 'max', label: 'author [alternate · max] · Check the ending' },
    { target: first, route: parentRoute, expectedEffort: 'low', label: 'pair/first [parent-model · low] · Check the ending' },
    { target: second, route: alternateRoute, effort: 'high', expectedEffort: 'high', label: 'pair/second [alternate · high] · Check the ending' },
  ]
  for (const [index, { target, route, effort, expectedEffort, label }] of steps.entries()) {
    policyRead = false
    const args = { ...target, ...route, ...(effort === undefined ? {} : { reasoning_effort: effort }) }
    const receipt = await delegate.execute(args, EXEC)
    assert.deepEqual(receipt, {
      kind: 'activation', library_id: 'author', name: `agent-${index + 1}`, subagentId: `child-${index + 1}`,
      ...('group_id' in target ? { group_id: 'pair', slot: target.slot } : {}),
      ...route, reasoningEffort: expectedEffort,
    })
    assert.deepEqual(JSON.parse(delegate.output.render(args, receipt)[0].text), receipt)
    const request = host.subagentStarts[index].request
    assert.equal(request.label, label)
    assert.equal(request.provider, 'spawn')
    assert.equal(request.maxDepth, 1)
    assert.deepEqual(request.agentOptions, { ...route, reasoningEffort: effort, maxTokens: savedRoute.maxTokens })
    assert.equal(checks[index].reasoningEffort, effort)
  }

  const readsBeforeDefault = host.servicesRead.filter(service => service === 'sessionProjections').length
  assert.deepEqual(await delegate.execute(first, EXEC), {
    kind: 'activation', library_id: 'author', group_id: 'pair', slot: 'first', name: 'agent-4', subagentId: 'child-4',
    provider: 'local', model: 'saved', reasoningEffort: 'medium', routeNote: 'route is pinned to profile "desktop"',
  })
  assert.deepEqual(host.subagentStarts[3].request.agentOptions, savedRoute)
  assert.equal(host.subagentStarts[3].request.label, 'pair/first [saved · medium] · Check the ending')
  assert.equal(host.servicesRead.filter(service => service === 'sessionProjections').length, readsBeforeDefault)
  assert.deepEqual(host.fs.files(), before)
})

test('explicit model selection requires two non-empty route IDs and an optional non-empty effort', async () => {
  const host = makeHost({ rosterFiles: groupFiles, subagentProviders: ['spawn'], sessionProjections: allowParentRoute })
  const delegate = tool(host, 'delegate')
  for (const fields of [
    { provider: parentRoute.provider },
    { model: parentRoute.model },
    { reasoning_effort: 'high' },
    { ...parentRoute, provider: '' },
    { ...parentRoute, model: ' \t ' },
    { ...parentRoute, provider: ' ' },
    { ...parentRoute, model: '' },
  ]) {
    await assert.rejects(() => delegate.execute({ library_id: 'author', prompt: 'task', ...fields }, EXEC), /provider.*model/i)
  }
  for (const reasoning_effort of ['', ' \t ']) {
    await assert.rejects(
      () => delegate.execute({ group_id: 'pair', slot: 'first', prompt: 'task', ...parentRoute, reasoning_effort }, EXEC),
      /reasoning_effort/,
    )
  }
  assert.ok(!host.servicesRead.includes('sessionProjections'))
  assert.equal(host.subagentStarts.length, 0)
})

test('model authorization applies to the exact pair before adapter lookup, with only the live parent route when there is no policy', async () => {
  const checks: Record<string, unknown>[] = []
  let policy: unknown = [parentRoute, alternateRoute]
  const host = makeHost({
    rosterFiles: groupFiles, subagentProviders: ['spawn'],
    sessionProjections: { stateOf: () => policy },
    routeCheck: async route => {
      checks.push(route)
      if (route.reasoningEffort === 'invalid') throw new Error('Unsupported effort invalid')
    },
  })
  const delegate = tool(host, 'delegate')
  const args = { library_id: 'author', prompt: 'task' }
  for (const route of [
    { ...parentRoute, provider: alternateRoute.provider },
    { ...parentRoute, model: alternateRoute.model },
    { ...parentRoute, model: parentRoute.model.toUpperCase() },
  ]) {
    await assert.rejects(() => delegate.execute({ ...args, ...route }, EXEC), /not allowed|not authorized/i)
  }
  policy = [alternateRoute]
  await assert.rejects(() => delegate.execute({ ...args, ...parentRoute }, EXEC), /not allowed|not authorized/i)
  policy = null
  const liveRoute = { provider: 'live-provider', model: 'live-model' }
  const ctx = { ...EXEC, agent: { ...AGENT, session: {
    ...AGENT.session, requestHeader: () => ({ config: { ...liveRoute, reasoningEffort: 'high' } }),
  } } }
  await assert.rejects(() => delegate.execute({ ...args, ...parentRoute }, ctx), /parent|current/i)
  await assert.rejects(() => delegate.execute({ ...args, ...alternateRoute }, ctx), /parent|current/i)
  assert.deepEqual(checks, [])
  assert.equal(host.subagentStarts.length, 0)
  await assert.rejects(() => delegate.execute({ ...args, ...liveRoute, reasoning_effort: 'invalid' }, ctx), /Unsupported effort/)
  assert.equal(host.subagentStarts.length, 0)
  await delegate.execute({ ...args, ...liveRoute }, ctx)
  assert.deepEqual(checks, [{ ...liveRoute, reasoningEffort: 'invalid' }, liveRoute])
  assert.deepEqual(host.subagentStarts[0].request.agentOptions, { ...liveRoute, reasoningEffort: undefined })
})

test('unavailable and malformed projection states fail closed even for the parent route', async () => {
  const args = { library_id: 'author', prompt: 'task', ...parentRoute }
  for (const sessionProjections of [
    undefined,
    {},
    { stateOf: () => undefined },
    { stateOf() { throw new Error('unregistered projection') } },
    { stateOf: () => [] },
    { stateOf: () => ({ allowedModels: [parentRoute] }) },
    { stateOf: () => [parentRoute, { provider: 'local' }] },
  ]) {
    const host = makeHost({
      rosterFiles: groupFiles, subagentProviders: ['spawn'], sessionProjections,
      routeCheck: async () => assert.fail('The route must not reach the adapter'),
    })
    await assert.rejects(() => tool(host, 'delegate').execute(args, EXEC), /policy|authorization|model selection/i)
    assert.equal(host.subagentStarts.length, 0)
  }
})

test('an override without a policy is rejected if the parent switches routes during preflight', async () => {
  const validation = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  let route = parentRoute
  const host = makeHost({
    rosterFiles: groupFiles, subagentProviders: ['spawn'], sessionProjections: { stateOf: () => null },
    routeCheck: async () => {
      validation.resolve()
      await release.promise
    },
  })
  const ctx = { ...EXEC, agent: { ...AGENT, session: {
    ...AGENT.session, requestHeader: () => ({ config: route }),
  } } }
  const pending = tool(host, 'delegate').execute({ library_id: 'author', prompt: 'task', ...parentRoute }, ctx)
  await Promise.race([validation.promise, pending])
  route = alternateRoute
  release.resolve()
  await assert.rejects(pending, /parent|current/i)
  assert.equal(host.subagentStarts.length, 0)
})

test('an authorized override can replace an unregistered profile route but cannot replace a broken overlay', async () => {
  const overlayPath = '/roster/_profiles/desktop/author.yaml'
  const host = makeHost({
    profileName: 'desktop', llmProviders: ['parent-provider'], subagentProviders: ['spawn'],
    rosterFiles: { ...groupFiles, [overlayPath]: 'provider: missing\nmodel: old\nreasoningEffort: medium\nmaxTokens: 1200' },
    sessionProjections: allowParentRoute,
  })
  const delegate = tool(host, 'delegate')
  const args = { group_id: 'pair', slot: 'first', prompt: 'task' }
  await assert.rejects(() => delegate.execute(args, EXEC), /missing.*not registered/)
  const before = host.fs.files()
  assert.deepEqual(await delegate.execute({ ...args, ...parentRoute }, EXEC), {
    kind: 'activation', library_id: 'author', group_id: 'pair', slot: 'first', name: 'agent-1', subagentId: 'child-1',
    ...parentRoute,
  })
  assert.deepEqual(host.subagentStarts[0].request.agentOptions, { ...parentRoute, reasoningEffort: undefined, maxTokens: 1200 })
  assert.deepEqual(host.fs.files(), before)
  await assert.rejects(() => delegate.execute(args, EXEC), /missing.*not registered/)
  await host.fs.writeFile(overlayPath, 'provider: [')
  await assert.rejects(() => delegate.execute({ ...args, ...parentRoute }, EXEC), /profile route|overlay/i)
  assert.equal(host.subagentStarts.length, 1)
})

test('role and group catalogs share configured routes, and the group command renders them beside assignments', async () => {
  const host = makeHost({
    profileName: 'desktop', subagentProviders: ['spawn'], llmProviders: ['local'],
    rosterFiles: {
      ...groupFiles,
      '/roster/reviewer.yaml': 'description: reviewer',
      '/roster/writer.yaml': 'description: writer\nreasoningEffort: high',
      '/roster/_profiles/desktop/reviewer.yaml': 'provider: local\nmodel: model-pro\nreasoningEffort: medium',
      '/roster/_groups/routes.yaml': [
        'description: route examples', 'members:',
        '  - slot: read', '    role: author', '    assignment: Read sources',
        '  - slot: review', '    role: reviewer', '    assignment: Check facts',
        '  - slot: write', '    role: writer', '    assignment: Draft the report',
      ].join('\n'),
    },
  })
  const directory = tool(host, 'list_subagents')
  const roles = await directory.execute({}, EXEC) as Array<Record<string, unknown>>
  const [group] = await directory.execute({ group_id: 'routes' }, EXEC) as Array<{ members: Array<Record<string, unknown>> }>
  const getRoute = ({ provider, model, reasoningEffort, routeNote }: Record<string, unknown>) => ({
    provider, model, reasoningEffort, routeNote,
  })
  const [reader, reviewer, writer] = group.members.map(getRoute)
  assert.deepEqual(reader, { provider: '(session default)', model: '(session default)', reasoningEffort: undefined, routeNote: undefined })
  assert.deepEqual(reviewer, { provider: 'local', model: 'model-pro', reasoningEffort: 'medium', routeNote: 'route is pinned to profile "desktop"' })
  assert.deepEqual(writer, { ...reader, reasoningEffort: 'high' })
  for (const member of group.members) {
    assert.deepEqual(getRoute(member), getRoute(roles.find(role => role.id === member.role)!))
  }
  const result = await host.command.get('subagent')!({ rawInput: ' groups routes', ...EXEC })
  assert.equal(result.kind, 'success')
  assert.match(result.text, /^read → author.*跟随主会话模型.*Read sources/m)
  assert.match(result.text, /^review → reviewer.*local\/model-pro · medium.*Check facts/m)
  assert.match(result.text, /^write → writer.*跟随主会话模型 · high.*Draft the report/m)
  assert.equal(host.subagentStarts.length, 0)
})

for (const teams of [false, true]) {
  test(`Teams ${teams ? 'on' : 'absent'}: browse the group and receive one native identity with its model route`, async () => {
    const host = makeHost({ rosterFiles: groupFiles, subagentProviders: ['spawn'], teams })
    const directory = tool(host, 'list_subagents')
    const groups = await directory.execute({ kind: 'groups' }, EXEC) as Array<Record<string, unknown>>
    assert.equal(groups[0]?.memberCount, 2)
    assert.equal(groups[0]?.members, undefined)
    const [group] = await directory.execute({ group_id: 'pair' }, EXEC) as Array<{ members: Array<Record<string, unknown>>, instructions: string }>
    assert.equal(group.instructions, 'shared instructions')
    assert.deepEqual(group.members.map(m => [m.slot, m.role, m.launchable]), [['first', 'author', true], ['second', 'author', true]])
    assert.equal(host.subagentStarts.length, 0)

    const delegate = tool(host, 'delegate')
    const args = { group_id: 'pair', slot: 'second', prompt: 'current task', description: '  Review the ending  ' }
    const receipt = await delegate.execute(args, EXEC)
    assert.deepEqual(receipt, {
      kind: 'activation', library_id: 'author', group_id: 'pair', slot: 'second', name: 'agent-1', subagentId: 'child-1',
      provider: 'parent-provider', model: 'parent-model', reasoningEffort: 'high',
    })
    assert.deepEqual(JSON.parse(delegate.output.render(args, receipt)[0].text), receipt)
    assert.equal(host.subagentStarts.length, 1)
    assert.deepEqual(host.subagentStarts[0].request, {
      provider: 'spawn', parent: AGENT, signal: EXEC.signal, label: 'pair/second [parent-model · high] · Review the ending',
      delivery: 'parent', prompt: [{ type: 'text', text: 'Role persona:\nauthor persona\n\nGroup instructions:\nshared instructions\n\nSlot assignment:\nsecond assignment\n\nTask:\ncurrent task' }],
      maxDepth: 1,
    })
    assert.equal(host.subagentStarts[0].request.parent, AGENT)
    assert.equal(host.subagentStarts[0].signal, EXEC.signal)
    assert.equal(host.subagentDisposes.length, 0)
    const next = await delegate.execute({ group_id: 'pair', slot: 'first', prompt: 'next' }, EXEC) as { name: string }
    assert.equal(next.name, 'agent-2')
    assert.equal(host.subagentStarts[1].request.label, 'pair/first [parent-model · high]')
    assert.doesNotMatch(JSON.stringify(host.subagentStarts[1].request.prompt), /second assignment/)
    const direct = await delegate.execute({ library_id: 'author', prompt: 'independent' }, EXEC) as { name: string }
    assert.equal(direct.name, 'agent-3')
    assert.doesNotMatch(JSON.stringify(host.subagentStarts[2].request.prompt), /assignment|shared instructions/)
    assert.ok(!host.servicesRead.some(service => /team|job/i.test(service)), JSON.stringify(host.servicesRead))
    assert.ok(!host.servicesRead.includes('sessionProjections'))
  })
}

test('invalid or legacy selections never start a child', async () => {
  const host = makeHost({ rosterFiles: groupFiles, subagentProviders: ['spawn'] })
  const delegate = tool(host, 'delegate')
  for (const [selection, reason] of [
    [{ group_id: 'pair' }, /exactly one slot.*first, second/],
    [{ slot: 'first' }, /exactly one slot/],
    [{ library_id: 'author', group_id: 'pair', slot: 'first' }, /either library_id/],
    [{ group_id: 'pair', slot: 'missing' }, /first, second/],
    [{ group_id: 'ghost', slot: 'first' }, /Unknown group_id/],
    [{ group_id: 'pair', slot: ['first', 'second'] }, /string/],
    [{ group_id: ['pair'], slot: 'first' }, /string/],
    [{ library_id: ['author'] }, /string/],
    [{ library_id: 'author', description: 4 }, /string/],
    [{ library_id: 'author', prompt: ['work'] }, /string/],
    [{ library_id: 'author', run_in_background: false }, /Remove run_in_background/],
    [{ library_id: 'author', reasoningEffort: 'injected' }, /Unknown arguments/],
    [{ library_id: 'author', prompt: '   ' }, /non-empty/],
  ] as const) {
    await assert.rejects(() => delegate.execute({ prompt: 'task', ...selection }, EXEC), reason)
  }
  await assert.rejects(() => tool(host, 'list_subagents').execute({ kind: 'roles', group_id: 'pair' }, EXEC), /requires kind/)
  assert.equal(host.subagentStarts.length, 0)
})

test('a corrupt role with a legacy fallback, a missing role, a disabled role and a filtered role leave their sibling usable', async () => {
  const host = makeHost({
    subagentProviders: ['spawn'], baseEntries: { broken: { description: 'legacy backup' } },
    sessionProjections: allowParentRoute,
    rosterFiles: {
      '/roster/broken.yaml': 'description: [broken',
      '/roster/locked.yaml': 'description: restricted\ntoolFilter:\n  deny: [write]\n',
      '/roster/off.yaml': 'description: disabled\nenabled: false\n',
      '/roster/live.yaml': 'description: enabled\n',
      '/roster/_groups/mixed.yaml': 'description: mixed\nmembers:\n' +
        ['broken', 'missing', 'locked', 'off', 'live'].map(role => `  - slot: ${role}\n    role: ${role}`).join('\n'),
    },
  })
  const [group] = await tool(host, 'list_subagents').execute({ group_id: 'mixed' }, EXEC) as Array<{ members: Array<{ launchable: boolean, reason?: string }> }>
  assert.deepEqual(group.members.map(m => m.launchable), [false, false, false, false, true])
  for (const [index, reason] of [/unreadable/, /no entry/, /toolFilter/, /disabled/].entries()) {
    assert.match(group.members[index].reason!, reason)
  }
  const { reason: _missingReason, ...missing } = group.members[1]
  assert.deepEqual(missing, { slot: 'missing', role: 'missing', launchable: false })
  const delegate = tool(host, 'delegate')
  await delegate.execute({ group_id: 'mixed', slot: 'live', prompt: 'start' }, EXEC)
  for (const [slot, reason] of [['broken', /unreadable/], ['missing', /no entry/], ['locked', /toolFilter/], ['off', /disabled/]] as const) {
    const target = { group_id: 'mixed', slot, prompt: 'task' }
    await assert.rejects(() => delegate.execute(target, EXEC), reason)
    await assert.rejects(() => delegate.execute({ ...target, ...parentRoute }, EXEC), reason)
  }
  assert.equal(host.subagentStarts.length, 1)
  assert.deepEqual(host.subagentDisposes, [])
  await host.fs.writeFile('/roster/_groups/mixed.yaml', 'description: disabled\nenabled: false\nmembers:\n  - slot: live\n    role: live')
  await assert.rejects(() => delegate.execute({ group_id: 'mixed', slot: 'live', prompt: 'task' }, EXEC), /disabled/)
  await assert.rejects(() => delegate.execute({ group_id: 'mixed', slot: 'live', prompt: 'task', ...parentRoute }, EXEC), /disabled/)
  await delegate.execute({ library_id: 'live', prompt: 'task' }, EXEC)
  assert.equal(host.subagentStarts.length, 2)
})

test('native limit and persisted parent depth are enforced before creation', async () => {
  const host = makeHost({ subagentProviders: ['spawn'], hostMaxDepth: 2, sessionProjections: allowParentRoute,
    baseEntries: { capped: { description: 'capped', maxDepth: 5 }, smaller: { description: 'smaller', maxDepth: 1 }, zero: { description: 'zero', maxDepth: 0 } } })
  const delegate = tool(host, 'delegate')
  for (const [id, limit] of [['capped', 2], ['smaller', 1]] as const) {
    await delegate.execute({ library_id: id, prompt: 'task' }, EXEC)
    assert.equal(host.subagentStarts.at(-1)?.request.maxDepth, limit)
  }
  await assert.rejects(() => delegate.execute({ library_id: 'zero', prompt: 'task' }, EXEC), /maxDepth is 0/)
  await assert.rejects(() => delegate.execute({ library_id: 'zero', prompt: 'task', ...parentRoute }, EXEC), /maxDepth is 0/)
  const ctx = { ...EXEC, agent: { options: { subagentDepth: 0 }, session: { header: { delegationDepth: 2 } } } }
  await assert.rejects(() => delegate.execute({ library_id: 'capped', prompt: 'task' }, ctx), /depth 3 exceeds maxDepth 2/)
  await assert.rejects(() => delegate.execute({ library_id: 'capped', prompt: 'task', ...parentRoute }, ctx), /depth 3 exceeds maxDepth 2/)
  assert.equal(host.subagentStarts.length, 2)
})

test('preflight uses the live parent request route, validates effort and skips sibling route lookups during start', async () => {
  const checks: Record<string, unknown>[] = []
  const host = makeHost({
    profileName: 'desktop', subagentProviders: ['spawn'], llmProviders: ['local', 'latest'],
    routeCheck: async (route, signal) => {
      assert.equal(signal, EXEC.signal)
      checks.push(route)
      if (route.model === 'broken') throw new Error('Unknown model broken')
      if (route.reasoningEffort === 'invalid') throw new Error('Unsupported effort invalid')
      if (route.model === 'new') return { ...route, reasoningEffort: 'low', maxTokens: 3072 }
    },
    rosterFiles: {
      ...groupFiles,
      '/roster/bad.yaml': 'description: bad',
      '/roster/_profiles/desktop/bad.yaml': 'provider: local\nmodel: broken',
      '/roster/_profiles/desktop/author.yaml': 'reasoningEffort: high',
      '/roster/_groups/mixed.yaml': 'description: mixed\nmembers:\n  - slot: good\n    role: author\n  - slot: bad\n    role: bad',
    },
  })
  const ctx = { ...EXEC, agent: { options: { provider: 'old', model: 'old', reasoningEffort: 'old' }, session: {
    header: {}, requestHeader: () => ({ config: { provider: 'latest', model: 'current', reasoningEffort: 'medium' } }),
  } } }
  const delegate = tool(host, 'delegate')
  const args = { group_id: 'mixed', slot: 'good', prompt: 'task' }
  assert.deepEqual(await delegate.execute(args, ctx), {
    kind: 'activation', library_id: 'author', group_id: 'mixed', slot: 'good', name: 'agent-1', subagentId: 'child-1',
    provider: 'latest', model: 'current', reasoningEffort: 'high', routeNote: 'route is pinned to profile "desktop"',
  })
  assert.deepEqual(checks, [{ provider: 'latest', model: 'current', reasoningEffort: 'high' }])
  assert.deepEqual(host.subagentStarts[0].request.agentOptions, { reasoningEffort: 'high' })
  assert.equal(host.subagentStarts[0].request.label, 'mixed/good [current · high]')
  await host.fs.writeFile('/roster/_profiles/desktop/author.yaml', 'provider: local\nmodel: new')
  assert.deepEqual(await delegate.execute(args, ctx), {
    kind: 'activation', library_id: 'author', group_id: 'mixed', slot: 'good', name: 'agent-2', subagentId: 'child-2',
    provider: 'local', model: 'new', reasoningEffort: 'low', routeNote: 'route is pinned to profile "desktop"',
  })
  assert.deepEqual(checks.at(-1), { provider: 'local', model: 'new' })
  assert.deepEqual(host.subagentStarts[1].request.agentOptions, { provider: 'local', model: 'new' })
  assert.equal(host.subagentStarts[1].request.label, 'mixed/good [new · low]')
  await assert.rejects(() => delegate.execute({ ...args, slot: 'bad' }, ctx), /mixed\/bad.*Unknown model broken/)
  await host.fs.writeFile('/roster/_profiles/desktop/author.yaml', 'provider: local\nmodel: new\nreasoningEffort: invalid')
  const [group] = await tool(host, 'list_subagents').execute({ group_id: 'mixed' }, ctx) as Array<{ members: Array<{ reason?: string }> }>
  assert.match(group.members[0].reason!, /Unsupported effort/)
  assert.match(group.members[1].reason!, /Unknown model/)
  assert.equal(host.subagentStarts.length, 2)
})

test('a partial override uses the parent model at launch when it changes during asynchronous validation', async () => {
  const checks: Record<string, unknown>[] = []
  const validation = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  let selection = { provider: 'parent-provider', model: 'before-switch', reasoningEffort: 'medium' }
  const host = makeHost({
    subagentProviders: ['spawn'],
    baseEntries: { worker: { description: 'worker', provider: 'local' } },
    routeCheck: async route => {
      checks.push(route)
      validation.resolve()
      await release.promise
      return { ...route, reasoningEffort: 'high' }
    },
  })
  const ctx = { ...EXEC, agent: { ...AGENT, session: { header: {}, requestHeader: () => ({ config: selection }) } } }
  const pending = tool(host, 'delegate').execute({ library_id: 'worker', prompt: 'task' }, ctx)
  await Promise.race([validation.promise, pending])
  assert.equal(host.subagentStarts.length, 0)
  selection = { provider: 'parent-provider', model: 'after-switch', reasoningEffort: 'low' }
  release.resolve()
  assert.deepEqual(await pending, {
    kind: 'activation', library_id: 'worker', name: 'agent-1', subagentId: 'child-1',
    provider: 'local', model: 'after-switch',
  })
  assert.deepEqual(checks, [{ provider: 'local', model: 'before-switch' }])
  assert.deepEqual(host.subagentStarts[0].request.agentOptions, { provider: 'local' })
  assert.equal(host.subagentStarts[0].request.label, 'worker [after-switch]')
})

test('old hosts allow on-demand discovery and unsupported transports never start', async () => {
  for (const [extra, message] of [
    [{ activationApi: false }, /named activations/],
    [{ externalOnly: true }, /continuable/],
    [{ providerCapabilities: { depthLimit: false } }, /cannot enforce maxDepth/],
  ] as const) {
    const host = makeHost({ subagentProviders: ['spawn'], rosterFiles: groupFiles, ...extra })
    const [row] = await tool(host, 'list_subagents').execute({}, EXEC) as Array<{ id: string, reason: string }>
    assert.equal(row.id, 'author')
    assert.match(row.reason, message)
    await assert.rejects(() => tool(host, 'delegate').execute({ library_id: 'author', prompt: 'task' }, EXEC), message)
    assert.equal(host.subagentStarts.length, 0)
  }
  const noAgentOptions = makeHost({
    subagentProviders: ['spawn'], rosterFiles: groupFiles, sessionProjections: allowParentRoute,
    providerCapabilities: { agentOptions: false },
  })
  await assert.rejects(
    () => tool(noAgentOptions, 'delegate').execute({ library_id: 'author', prompt: 'task', ...parentRoute }, EXEC),
    /agentOptions/,
  )
  assert.equal(noAgentOptions.subagentStarts.length, 0)
  await tool(noAgentOptions, 'delegate').execute({ library_id: 'author', prompt: 'task' }, EXEC)
  assert.equal(noAgentOptions.subagentStarts.length, 1)

  const host = makeHost({ subagentProviders: ['spawn'], rosterFiles: groupFiles, startFailure: 'tree at capacity' })
  await assert.rejects(() => tool(host, 'delegate').execute({ group_id: 'pair', slot: 'first', prompt: 'task' }, EXEC), /pair\/first.*capacity/)
  assert.equal(host.subagentStarts.length, 1)
  assert.deepEqual(host.subagentDisposes, [])
})

test('aborted preflight leaves no accepted member', async () => {
  const controller = new AbortController()
  const host = makeHost({ subagentProviders: ['spawn'],
    baseEntries: { a: { description: 'worker', provider: 'p', model: 'm' } },
    routeCheck: async (_route, signal) => { assert.equal(signal, controller.signal); controller.abort() },
  })
  await assert.rejects(() => tool(host, 'delegate').execute({ library_id: 'a', prompt: 'task' }, { agent: AGENT, signal: controller.signal }), /abort/i)
  assert.equal(host.subagentStarts.length, 0)
})

test('a following fork uses the current dispatch turn even when its seed ends on the previous model', async () => {
  const events = new Context()
  const lifecycle = await events.plugin(() => {})
  const old = { provider: 'before', model: 'a', reasoningEffort: 'medium' }
  const current = { provider: 'after', model: 'b', reasoningEffort: 'high' }
  let replayed: { provider: string, model: string, reasoningEffort?: string } = old
  let inheritedEventCount = 0
  const host = makeHost({
    subagentProviders: ['fork'], inheritingProviders: ['fork'], lifecycle: lifecycle.ctx,
    rosterFiles: { '/roster/reader.yaml': 'description: reader\nsubagentProvider: fork\nmaxTokens: 80' },
    async beforeStartActivation(_request, childId) {
      await events.serial('agent/created', {
        source: 'startup', agent: {
          id: childId, session: { header: { parentSession: AGENT.id }, inheritedEventCount },
          model: { current: () => replayed, select(route: typeof replayed) { replayed = route } },
        },
      } as never)
    },
  })
  try {
    for (const [count, defaultEffort] of [[3, false], [3, true], [0, true]] as const) {
      inheritedEventCount = count
      replayed = count ? old : current
      const parent = { ...AGENT, options: old, session: {
        requestHeader: () => ({ config: current, adapterDefaults: { reasoningEffort: defaultEffort } }),
      } }
      const result = await tool(host, 'delegate').execute({ library_id: 'reader', prompt: 'review' }, { ...EXEC, agent: parent })
      assert.deepEqual(replayed, defaultEffort ? { provider: current.provider, model: current.model } : current)
      assert.deepEqual(result, { kind: 'activation', library_id: 'reader', name: `agent-${host.subagentStarts.length}`,
        subagentId: host.subagentStarts.at(-1)!.request.childId, ...current })
      assert.equal(host.subagentStarts.at(-1)!.request.label, 'reader [b · high]')
      assert.deepEqual(host.subagentStarts.at(-1)!.request.agentOptions, { maxTokens: 80 })
      assert.ok(!host.servicesRead.includes('sessionProjections'))
    }
  } finally {
    await lifecycle.dispose()
  }
})

test('forks select their own launch model after history replay and release their listener on success, failure or unload', async () => {
  const events = new Context()
  const lifecycle = await events.plugin(() => {})
  const selected: Array<{ childId: string, route: unknown }> = []
  const savedRoute = { provider: 'local', model: 'saved', reasoningEffort: 'medium' }
  const overrideRoute = { ...alternateRoute, reasoningEffort: 'max' }
  const announce = (childId: string, parentSession: string, inheritedEventCount = 5, source = 'startup') =>
    events.serial('agent/created', {
      source,
      agent: {
        id: childId, session: { header: { parentSession }, inheritedEventCount },
        model: { select(route: unknown) { selected.push({ childId, route }) } },
      },
    } as never)
  const gates = new Map(['first', 'second', 'unload'].map(prompt => [prompt, {
    entered: Promise.withResolvers<string>(), proceed: Promise.withResolvers<void>(),
  }]))
  const host = makeHost({
    subagentProviders: ['fork', 'spawn'], inheritingProviders: ['fork'],
    rosterFiles: {
      '/roster/forked.yaml': 'description: forked\nsubagentProvider: fork\nprovider: local\nmodel: saved\nreasoningEffort: medium',
      '/roster/spawned.yaml': 'description: spawned\nprovider: local\nmodel: saved',
    },
    sessionProjections: { stateOf: () => [alternateRoute] },
    lifecycle: lifecycle.ctx,
    async beforeStartActivation(request, childId) {
      const [{ text }] = request.prompt as Array<{ text: string }>
      const signal = request.signal as AbortSignal
      const gate = gates.get(text)
      if (gate) {
        gate.entered.resolve(childId)
        await gate.proceed.promise
      }
      signal.throwIfAborted()
      const parent = request.parent as typeof AGENT
      await announce(childId, text === 'wrong parent' ? 'other-parent' : parent.id,
        request.provider === 'spawn' || text === 'no history' ? 0 : 5,
        text === 'restored child' ? 'resume' : 'startup')
    },
  })
  const delegate = tool(host, 'delegate')
  const target = { library_id: 'forked' }
  const secondParent = { ...AGENT, id: 'second-parent' }
  const first = delegate.execute({ ...target, prompt: 'first' }, EXEC)
  const second = delegate.execute({
    ...target, prompt: 'second', ...alternateRoute, reasoning_effort: overrideRoute.reasoningEffort,
  }, { ...EXEC, agent: secondParent })
  const [firstId, secondId] = await Promise.race([
    Promise.all([gates.get('first')!.entered.promise, gates.get('second')!.entered.promise]),
    Promise.race([first, second]).then(() => assert.fail('Ended before both forks were waiting')),
  ])
  assert.notEqual(firstId, secondId)
  assert.equal(lifecycle.getEffects().length, 2)
  await announce('unrelated-child', AGENT.id)
  await delegate.execute({ ...target, prompt: 'no history' }, EXEC)
  await delegate.execute({ library_id: 'spawned', prompt: 'ordinary spawn' }, EXEC)
  assert.equal(host.subagentStarts.at(-1)?.request.childId, undefined)
  assert.equal(host.subagentStarts.at(-1)?.signal, EXEC.signal)
  assert.deepEqual(selected, [])
  assert.equal(lifecycle.getEffects().length, 2)

  gates.get('second')!.proceed.resolve()
  assert.equal((await second as { subagentId: string }).subagentId, secondId)
  assert.deepEqual(selected, [{ childId: secondId, route: overrideRoute }])
  assert.equal(lifecycle.getEffects().length, 1)
  await announce(secondId, secondParent.id)

  gates.get('first')!.proceed.resolve()
  assert.equal((await first as { subagentId: string }).subagentId, firstId)
  assert.deepEqual(selected, [{ childId: secondId, route: overrideRoute }, { childId: firstId, route: savedRoute }])
  assert.equal(lifecycle.getEffects().length, 0)

  for (const prompt of ['wrong parent', 'restored child']) {
    await assert.rejects(() => delegate.execute({ ...target, prompt }, EXEC), /expected parent/)
    assert.equal(lifecycle.getEffects().length, 0)
    assert.equal(selected.length, 2)
  }

  const pending = delegate.execute({ ...target, prompt: 'unload' }, EXEC)
  const unload = gates.get('unload')!
  const unloadId = await Promise.race([unload.entered.promise, pending.then(() => assert.fail('Ended before unload'))])
  await lifecycle.dispose()
  unload.proceed.resolve()
  await assert.rejects(pending, /abort/i)
  assert.equal(host.subagentStarts.at(-1)?.request.childId, unloadId)
  assert.equal(EXEC.signal.aborted, false)
  assert.equal(lifecycle.getEffects().length, 0)
  await announce(unloadId, AGENT.id)
  assert.equal(selected.length, 2)
})

test('legacy modes both become native named children and preserve the source file bytes', async () => {
  for (const mode of ['one-shot', 'continuable']) {
    const source = `# Old role\ndescription: role\nbackgroundMode: ${mode}\nsubagentProvider: fork\n`
    const host = makeHost({ rosterFiles: { '/roster/role.yaml': source }, subagentProviders: ['fork'] })
    const result = await tool(host, 'delegate').execute({ library_id: 'role', prompt: 'work' }, EXEC)
    assert.deepEqual(result, {
      kind: 'activation', library_id: 'role', name: 'agent-1', subagentId: 'child-1',
      provider: 'parent-provider', model: 'parent-model', reasoningEffort: 'high',
    })
    const spec = host.subagentStarts[0].request
    assert.equal(spec.provider, 'fork')
    assert.equal(spec.delivery, 'parent')
    assert.deepEqual(spec.prompt, [{ type: 'text', text: 'work' }])
    assert.equal(Object.hasOwn(spec, 'agentPreset'), false)
    assert.equal(host.fs.files()['/roster/role.yaml'], source)
  }
})

test('a duplicate slot makes just its group unavailable to tools and commands', async () => {
  const host = makeHost({ rosterFiles: { ...groupFiles,
    '/roster/_groups/broken.yaml': 'description: broken\nmembers:\n  - slot: a\n    role: author\n  - slot: a\n    role: author',
  }, subagentProviders: ['spawn'] })
  const list = tool(host, 'list_subagents')
  await assert.rejects(() => list.execute({ group_id: 'broken' }, EXEC), /broken.*unreadable/)
  assert.match(JSON.stringify(await list.execute({ kind: 'groups' }, EXEC)), /broken/)
  assert.equal((await host.command.get('subagent')!({ rawInput: ' groups broken', ...EXEC })).kind, 'error')
  const delegate = tool(host, 'delegate')
  await assert.rejects(() => delegate.execute({ group_id: 'broken', slot: 'a', prompt: 'task' }, EXEC), /broken.*unreadable/)
  await assert.rejects(() => delegate.execute({ group_id: 'broken', slot: 'a', prompt: 'task', ...parentRoute }, EXEC), /broken.*unreadable/)
  assert.equal(host.subagentStarts.length, 0)
  await delegate.execute({ group_id: 'pair', slot: 'first', prompt: 'task' }, EXEC)
  assert.equal(host.subagentStarts.length, 1)
})

test('catalog edits, policy changes, direct and slot starts and command queries preserve the registered prefix', async () => {
  let policy = [parentRoute]
  const host = makeHost({ rosterFiles: groupFiles, subagentProviders: ['spawn'], sessionProjections: { stateOf: () => policy } })
  const section = host.section.get('subagent-library')!
  const history = [{ role: 'user', content: 'unchanged history' }]
  const serialize = () => JSON.stringify({
    system: section({ scope: AGENT }), tools: [...host.tools.values()].map(t => [t.name, t.description, t.parameters]), history,
  })
  const initial = serialize()
  assert.match(initial, /Use native subagent tools for ad hoc work/)
  assert.deepEqual([...host.tools.keys()], ['list_subagents', 'delegate'])
  const command = host.command.get('subagent')!
  const result = await command({ rawInput: ' groups pair', ...EXEC })
  assert.equal(result.kind, 'success')
  assert.match(result.text, /second assignment/)
  const first = result.text.split('\n').find(line => line.includes('first → author')) ?? ''
  assert.match(first, /跟随主会话模型/)
  assert.match(first, /first assignment/)
  assert.match(first, /可派遣/)
  assert.equal(host.subagentStarts.length, 0)
  const delegate = tool(host, 'delegate')
  await delegate.execute({ library_id: 'author', prompt: 'first' }, EXEC)
  await delegate.execute({ library_id: 'author', prompt: 'first', ...parentRoute }, EXEC)
  assert.equal(serialize(), initial)
  policy = [alternateRoute]
  await assert.rejects(
    () => delegate.execute({ library_id: 'author', prompt: 'first', ...parentRoute }, EXEC),
    /not allowed|not authorized/i,
  )
  await delegate.execute({ library_id: 'author', prompt: 'first', ...alternateRoute }, EXEC)
  assert.equal(serialize(), initial)
  await host.fs.writeFile('/roster/author.yaml', 'description: revised\npersona: fresh role')
  await host.fs.writeFile('/roster/_groups/other.yaml', groupFiles['/roster/_groups/pair.yaml'])
  for (const [group_id, slot] of [['pair', 'second'], ['other', 'first'], ['pair', 'first'], ['other', 'first']]) {
    await delegate.execute({ group_id, slot, prompt: 'after change' }, EXEC)
    assert.match(JSON.stringify(host.subagentStarts.at(-1)?.request.prompt), /fresh role/)
    assert.equal(serialize(), initial)
  }
  host.tools.delete('list_subagents')
  assert.equal(section({ scope: AGENT }), '')
})
