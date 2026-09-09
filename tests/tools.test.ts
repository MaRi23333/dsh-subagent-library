/**
 * Model-facing tool tests (SUB-TEST-001): list_subagents catalog shaping and
 * delegate's id validation — including the prototype-chain lookup guard
 * (`constructor` & co. must hit the missing-entry error, never a real
 * delegation). Everything runs against in-memory doubles; the fake transport
 * registry knows no providers, so delegation can never actually start.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { makeHost, type MockHost } from './helpers.ts'

interface RegisteredTool {
  execute: (args: Record<string, unknown>, exec: Record<string, unknown>) => Promise<unknown>
  output?: { render?: (args: unknown, value: Record<string, unknown>) => Array<{ type: string, text: string }> }
}

function tool(host: MockHost, name: string): RegisteredTool {
  const registered = host.tools.get(name)
  assert.ok(registered, `tool not registered: ${name}`)
  return registered as unknown as RegisteredTool
}

/** The calling agent object — dsh-tools' scope key (never its Context). */
const AGENT = { fake: 'parent-agent', ctx: { fake: 'scope' } }
const EXEC = { agent: AGENT, signal: new AbortController().signal }

test('list_subagents returns the filtered catalog with a toolFilter summary', async () => {
  const host = makeHost({
    knownTools: ['write', 'edit'],
    baseEntries: {
      reader: {
        description: 'fake read-only role',
        provider: 'fake-provider',
        model: 'fake-model',
        toolFilter: { deny: ['write', 'edit'] },
      },
      bad_key: { description: 'orphaned hand-written key' },
    },
  })
  const rows = (await tool(host, 'list_subagents').execute({}, EXEC)) as Array<Record<string, unknown>>
  assert.equal(rows.length, 1)
  assert.equal(rows[0]?.['id'], 'reader')
  assert.equal(rows[0]?.['provider'], 'fake-provider')
  assert.equal(rows[0]?.['backgroundMode'], 'one-shot')
  assert.equal(rows[0]?.['toolFilter'], 'deny:[write, edit]')
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

test('delegate drops toolFilter names the calling session cannot restrict', async () => {
  // restrict() fails the WHOLE filter on a name the child cannot inherit, and a
  // roster entry is shared by every session — so a fixed deny list must not be
  // able to break delegation (real case: deny lists carrying `subagent`).
  const host = makeHost({
    knownTools: ['write'],
    subagentProviders: ['spawn'],
    baseEntries: {
      reviewer: { description: 'fake', toolFilter: { deny: ['write', 'subagent'] } },
    },
  })
  const result = (await tool(host, 'delegate').execute(
    { library_id: 'reviewer', prompt: 'x' },
    EXEC,
  )) as Record<string, unknown>

  // `subagent` is invisible here → reported as "does not exist in this session".
  assert.match(String((result['droppedTools'] as string[])[0]), /^subagent（本会话不存在）/)
  assert.equal(host.subagentStarts.length, 1)
  assert.deepEqual(host.subagentStarts[0]?.request['toolFilter'], { deny: ['write'] })
  // The scope passed to tools.view() is the AGENT object, never its Context
  // (passing agent.ctx silently resolves no layers — the cdb128d bug).
  assert.equal(host.toolViewScopes[0], AGENT)
})

test('delegate drops scope-local names that are visible but not restrictable', async () => {
  // The real DSH 0.1.2-rc.1 case: the official `subagent` tool lives on each
  // agent's OWN layer, so it is visible to the caller yet rejected by
  // restrict() as scope-local. Visibility is not the predicate — the
  // restrictable set is.
  const host = makeHost({
    knownTools: ['write', 'subagent'],
    restrictableTools: ['write'],
    subagentProviders: ['spawn'],
    baseEntries: {
      reviewer: { description: 'fake', toolFilter: { deny: ['write', 'subagent'] } },
    },
  })
  const result = (await tool(host, 'delegate').execute(
    { library_id: 'reviewer', prompt: 'x' },
    EXEC,
  )) as Record<string, unknown>

  assert.match(String((result['droppedTools'] as string[])[0]), /^subagent（本会话专属工具/)
  assert.deepEqual(host.subagentStarts[0]?.request['toolFilter'], { deny: ['write'] })
})

test('delegate falls back to visibility when the registry has no view() (documented gap)', async () => {
  // Characterization test: without view() the sanitizer can only use visibility,
  // so a scope-local name survives and restrict() would reject the whole filter
  // again — the pre-0.2.7 loud failure. Documented, not silently "fixed".
  const host = makeHost({
    knownTools: ['write', 'subagent'],
    noToolView: true,
    subagentProviders: ['spawn'],
    baseEntries: {
      reviewer: { description: 'fake', toolFilter: { deny: ['write', 'subagent'] } },
    },
  })
  const result = (await tool(host, 'delegate').execute(
    { library_id: 'reviewer', prompt: 'x' },
    EXEC,
  )) as Record<string, unknown>

  assert.equal(result['droppedTools'], undefined)
  assert.deepEqual(host.subagentStarts[0]?.request['toolFilter'], { deny: ['write', 'subagent'] })
  assert.deepEqual(host.toolViewScopes, [])
})

test('delegate refuses an allow list that this session cannot apply at all', async () => {
  // Dropping an allow name makes the filter STRICTER; dropping every allow name
  // would leave `allow: []` = a child with no global tools. Fail loudly instead.
  const host = makeHost({
    knownTools: ['read'],
    restrictableTools: ['read'],
    subagentProviders: ['spawn'],
    baseEntries: {
      reader: { description: 'fake', toolFilter: { allow: ['write'] } },
    },
  })
  await assert.rejects(
    () => tool(host, 'delegate').execute({ library_id: 'reader', prompt: 'x' }, EXEC),
    /allow list names no tool this session can apply.*write/s,
  )
  assert.equal(host.subagentStarts.length, 0)
})

test('delegate result render carries the ignored-name note', async () => {
  const host = makeHost({
    knownTools: ['write'],
    subagentProviders: ['spawn'],
    baseEntries: {
      reviewer: { description: 'fake', toolFilter: { deny: ['write', 'ghost-tool'] } },
    },
  })
  const delegate = tool(host, 'delegate')
  const result = (await delegate.execute({ library_id: 'reviewer', prompt: 'x' }, EXEC)) as Record<string, unknown>
  const rendered = delegate.output?.render?.({}, result) ?? []
  assert.match(rendered.map((block) => block.text).join(''), /已忽略本会话不可用的工具名：ghost-tool（本会话不存在）/)
})

test('list_subagents summarizes the SANITIZED filter for the calling session', async () => {
  const host = makeHost({
    knownTools: ['write', 'subagent'],
    restrictableTools: ['write'],
    baseEntries: {
      reviewer: { description: 'fake', toolFilter: { deny: ['write', 'subagent'] } },
    },
  })
  const rows = (await tool(host, 'list_subagents').execute({}, EXEC)) as Array<Record<string, unknown>>
  assert.equal(rows[0]?.['toolFilter'], 'deny:[write] 忽略:[subagent]')
})

test('delegate omits the filter when every toolFilter name is unknown here', async () => {
  const host = makeHost({
    knownTools: [],
    subagentProviders: ['spawn'],
    baseEntries: {
      reviewer: { description: 'fake', toolFilter: { deny: ['ghost-tool'] } },
    },
  })
  const result = (await tool(host, 'delegate').execute(
    { library_id: 'reviewer', prompt: 'x' },
    EXEC,
  )) as Record<string, unknown>

  assert.match(String((result['droppedTools'] as string[])[0]), /^ghost-tool（本会话不存在）/)
  assert.equal(host.subagentStarts.length, 1)
  assert.equal(Object.hasOwn(host.subagentStarts[0]?.request ?? {}, 'toolFilter'), false)
})

test('both tools throw the settingsFailure diagnostic when registration failed', async () => {
  const host = makeHost({ failRegister: true, baseEntries: { reader: { description: 'fake' } } })
  await assert.rejects(() => tool(host, 'list_subagents').execute({}, EXEC), /注册失败/)
  await assert.rejects(
    () => tool(host, 'delegate').execute({ library_id: 'reader', prompt: 'x' }, EXEC),
    /注册失败/,
  )
})
