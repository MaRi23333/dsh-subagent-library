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
}

function tool(host: MockHost, name: string): RegisteredTool {
  const registered = host.tools.get(name)
  assert.ok(registered, `tool not registered: ${name}`)
  return registered as unknown as RegisteredTool
}

const EXEC = { agent: { fake: 'parent-agent' }, signal: new AbortController().signal }

test('list_subagents returns the filtered catalog with a toolFilter summary', async () => {
  const host = makeHost({
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

test('delegate drops toolFilter names the calling session cannot see', async () => {
  // restrict() fails the WHOLE filter on a name the child cannot inherit, and a
  // roster entry is shared by every session — so a fixed deny list must not be
  // able to break delegation (real case: deny lists carrying `subagent` in a
  // session whose composition never mounts it).
  const host = makeHost({
    knownTools: ['write'],
    subagentProviders: ['spawn'],
    baseEntries: {
      reviewer: { description: 'fake', toolFilter: { deny: ['write', 'subagent'] } },
    },
  })
  const result = (await tool(host, 'delegate').execute(
    { library_id: 'reviewer', prompt: 'x' },
    { agent: { fake: 'parent', ctx: { fake: 'scope' } }, signal: new AbortController().signal },
  )) as Record<string, unknown>

  assert.deepEqual(result['droppedTools'], ['subagent'])
  assert.equal(host.subagentStarts.length, 1)
  assert.deepEqual(host.subagentStarts[0]?.request['toolFilter'], { deny: ['write'] })
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
    { agent: { fake: 'parent', ctx: { fake: 'scope' } }, signal: new AbortController().signal },
  )) as Record<string, unknown>

  assert.deepEqual(result['droppedTools'], ['ghost-tool'])
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
