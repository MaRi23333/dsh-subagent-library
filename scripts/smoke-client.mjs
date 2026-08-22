/**
 * Client-bundle smoke: lib/client.js must self-register through the global
 * ModuleLoader with the plugin id and execute its factory with stub requires
 * (react etc.), mirroring how the web app loads bundles.
 * Run after `pnpm run build`.
 */
import { createRequire } from 'node:module'
import assert from 'node:assert/strict'

const require = createRequire(import.meta.url)
const factories = new Map()

globalThis.window = {
  __ModuleLoader__: {
    load({ id, factory }) {
      factories.set(id, factory)
    },
  },
}

require('../lib/client.js')

assert.ok(factories.has('dsh-subagent-library'), 'client bundle did not self-register under its id')

const factory = factories.get('dsh-subagent-library')
const exported = factory((id) => {
  if (id === 'react') return { createElement: () => null, Fragment: () => null }
  if (id === 'react/jsx-runtime') return { jsx: () => null, jsxs: () => null, Fragment: () => null }
  if (id === 'react-dom' || id === 'react-dom/client') return { createRoot: () => ({ render: () => {} }) }
  // Other externals (cordis, dsh-client-*) are only referenced by the loader
  // at runtime; the factory itself must not need them at load time.
  return {}
})

assert.ok(exported !== null && typeof exported === 'object', 'client factory must return module exports')

console.log('client ModuleLoader smoke OK: registered "dsh-subagent-library", factory executed')
