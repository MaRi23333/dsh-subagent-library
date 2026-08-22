/**
 * Host-entry smoke: the built lib/index.js must be importable (its top-level
 * schema definition executes) and expose the expected plugin surface.
 * Run after `pnpm run build`.
 */
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const pkg = require('../package.json')

const mod = await import('../lib/index.js')

if (mod.name !== 'subagent-library') throw new Error(`host name mismatch: ${mod.name}`)
if (typeof mod.apply !== 'function') throw new Error('host apply is not a function')
if (mod.Config == null || (typeof mod.Config !== 'object' && typeof mod.Config !== 'function')) {
  throw new Error('host Config schema missing')
}

console.log(`host smoke OK: ${pkg.name}@${pkg.version}, apply=${typeof mod.apply}, Config=${typeof mod.Config}`)
