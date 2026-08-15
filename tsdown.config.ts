/**
 * Build both halves of dsh-plugin-subagent-library:
 *  - node half:  src/index.ts          -> lib/index.js  (ESM, node)
 *  - client half: src/client/index.tsx -> lib/client.js (CJS closure for window.__ModuleLoader__)
 * Externals mirror the loader module table (packages/client/web/src/platform.ts)
 * plus the documented runtime-store exemption.
 */
import { defineConfig } from 'tsdown'

const PLATFORM_MODULES = [
  'react', 'react/jsx-runtime', 'react-dom', 'react-dom/client', '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-ui-slots', '@deepseek-ai/dsh-client-web-react',
  '@deepseek-ai/dsh-client-ui-primitives', '@deepseek-ai/dsh-client-ui-attachment',
  '@deepseek-ai/dsh-client-schema-form',
] as const

const RUNTIME_STORE_EXEMPTION = '@deepseek-ai/dsh-client-runtime/client'
const CLIENT_EXTERNALS: readonly string[] = [...PLATFORM_MODULES, RUNTIME_STORE_EXEMPTION]

export default defineConfig([
  {
    name: 'dsh-plugin-subagent-library',
    entry: { index: 'src/index.ts' },
    outDir: 'lib',
    format: ['esm'],
    platform: 'node',
    target: 'es2024',
    clean: false,
    dts: false,
    sourcemap: true,
  },
  {
    name: 'dsh-plugin-subagent-library/client',
    entry: { client: 'src/client/index.tsx' },
    outDir: 'lib',
    format: ['cjs'],
    platform: 'browser',
    target: 'es2022',
    clean: false,
    dts: false,
    sourcemap: true,
    external: [...CLIENT_EXTERNALS],
    define: {
      'process.env.NODE_ENV': JSON.stringify('production'),
      'import.meta.env.MODE': JSON.stringify('production'),
      'import.meta.env': JSON.stringify({ MODE: 'production' }),
    },
    noExternal: (id: string) => (CLIENT_EXTERNALS.includes(id) ? undefined : true),
    outputOptions: {
      entryFileNames: 'client.js',
      banner: 'window.__ModuleLoader__.load({ id: "dsh-plugin-subagent-library", factory: (require) => {',
      footer: 'return module.exports; } });',
      intro: 'var module = { exports: {} }; var exports = module.exports;',
    },
  },
])
