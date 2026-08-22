/**
 * npm pack whitelist (SUB-PKG-001 / SUB-TEST-001): the published tarball must
 * contain exactly the approved files — no stray build output, no sources, no
 * local config, no HANDOFF.md. Run: pnpm run check:pack
 */
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

/**
 * Locate npm's CLI entry next to the running node binary. Layout differs
 * between platforms:
 *   Windows:  <nodeDir>/node_modules/npm/bin/npm-cli.js
 *   POSIX:    <prefix>/lib/node_modules/npm/bin/npm-cli.js
 * where <nodeDir> = dirname(process.execPath) and <prefix> = its parent.
 * Returns null when neither layout exists (unusual installs).
 */
function resolveNpmCli() {
  const candidates = [
    join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    join(dirname(dirname(process.execPath)), 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  ]
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate
  }
  return null
}

const npmCli = resolveNpmCli()

/** Run `npm pack --dry-run --json --ignore-scripts` and capture stdout. */
function runPack() {
  if (npmCli !== null) {
    return spawnSync(process.execPath, [npmCli, 'pack', '--dry-run', '--json', '--ignore-scripts'], {
      cwd: root,
      encoding: 'utf8',
    })
  }
  // Fallback: rely on PATH (shell on Windows for the .cmd shim).
  return spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm',
    ['pack', '--dry-run', '--json', '--ignore-scripts'],
    { cwd: root, encoding: 'utf8', shell: process.platform === 'win32' })
}

const spawned = runPack()
if (spawned.status !== 0) {
  process.stderr.write(spawned.stderr ?? '')
  process.exit(spawned.status ?? 1)
}
const out = spawned.stdout
const [result] = JSON.parse(out)
const files = result.files.map((f) => f.path).sort()

const expected = [
  'LICENSE',
  'README.md',
  'cordis.patch.yml',
  'lib/client.js',
  'lib/client.js.map',
  'lib/index.js',
  'lib/index.js.map',
  'package.json',
].sort()

if (JSON.stringify(files) !== JSON.stringify(expected)) {
  console.error('pack contents mismatch!')
  console.error('  got:     ', files.join(', '))
  console.error('  expected:', expected.join(', '))
  process.exit(1)
}

console.log(`pack whitelist OK (${files.length} files, ${result.size} bytes): ${files.join(', ')}`)
