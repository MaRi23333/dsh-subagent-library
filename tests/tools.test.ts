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

test('both tools throw the settingsFailure diagnostic when registration failed', async () => {
  const host = makeHost({ failRegister: true, baseEntries: { reader: { description: 'fake' } } })
  await assert.rejects(() => tool(host, 'list_subagents').execute({}, EXEC), /注册失败/)
  await assert.rejects(
    () => tool(host, 'delegate').execute({ library_id: 'reader', prompt: 'x' }, EXEC),
    /注册失败/,
  )
})
