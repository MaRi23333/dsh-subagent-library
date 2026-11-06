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
  if (id === 'react/jsx-runtime') return { jsx: (type, props) => ({ type, props }), jsxs: (type, props) => ({ type, props }), Fragment: () => null }
  if (id === 'react-dom' || id === 'react-dom/client') return { createRoot: () => ({ render: () => {} }) }
  // Other externals (cordis, dsh-client-*) are only referenced by the loader
  // at runtime; the factory itself must not need them at load time.
  return {}
})

assert.ok(exported !== null && typeof exported === 'object', 'client factory must return module exports')

// Exercise the native settings registration without browser DOM or API access.
const registrations = new Map()
const cleanups = []
exported.apply({
  effect: (effect) => { cleanups.push(effect()) },
  locale: { register: () => () => {} },
  remote: { $on: () => () => {} },
  slots: {
    inject: (_name, callback) => { cleanups.push(callback()) },
    register: (spec, component) => {
      registrations.set(spec.name, { spec, component })
      return () => registrations.delete(spec.name)
    },
  },
})
const section = registrations.get('settings.section')
const icon = registrations.get('settings.section.icon')
assert.equal(section?.spec.id, 'subagent-library')
assert.equal(icon?.spec.id, section.spec.id, 'icon must match the host row-id filter')
const svg = icon.component({ size: 20, active: true })
assert.equal(svg.type, 'svg')
assert.equal(svg.props.width, 20)
assert.equal(svg.props.height, 20)
assert.equal(svg.props.stroke, 'currentColor')
assert.equal(icon.component({ size: 18, active: false }).props.width, 18)
for (const cleanup of cleanups.reverse()) cleanup?.()
assert.equal(registrations.size, 0, 'unloading must remove both settings registrations')

console.log('client ModuleLoader smoke OK: registered "dsh-subagent-library", factory executed')
