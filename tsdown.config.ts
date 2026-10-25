import { readFileSync } from 'node:fs'
import type { UserConfig } from 'tsdown'

/**
 * The package manifest, read once for both identity values the build stamps in.
 *
 * The bundle's registration id MUST equal the package name: the client module
 * system loads a bundle for a boot-graph row whose id is the PACKAGE NAME and
 * then asserts `factories.has(id)` — a bundle that registers under any other id
 * fails with `loaded without registering "<pkg>" via __ModuleLoader__.load`.
 * Reading it here rather than repeating the literal is what keeps the two in
 * step; the hardcoded copy is exactly how this fork shipped a bundle
 * registering as `dsh-qoder-connect` while the manifest said otherwise.
 */
const MANIFEST = JSON.parse(
  readFileSync(new URL('./package.json', import.meta.url), 'utf8'),
) as { name: string, version: string }

const PLUGIN_ID = MANIFEST.name

/** Read the npm version once so the build injects it into src/version.ts. */
const PACKAGE_VERSION = MANIFEST.version

/** Build-time define map; `src/version.ts` reads `__DSH_QODER_VERSION__`. */
const VERSION_DEFINE = { __DSH_QODER_VERSION__: JSON.stringify(PACKAGE_VERSION) }

const CLIENT_EXTERNALS = [
  'react',
  'react/jsx-runtime',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-runtime/client',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-locale/client',
] as const

export default [
  {
    entry: {
      index: 'src/index.ts',
      bin: 'src/bin.ts',
    },
    outDir: 'lib',
    format: ['esm'],
    platform: 'node',
    target: 'es2024',
    fixedExtension: false,
    dts: true,
    clean: true,
    define: VERSION_DEFINE,
    deps: {
      neverBundle: [
        '@earendil-works/pi-ai',
        '@deepseek-ai/schemastery',
        '@deepseek-ai/cordis',
        '@deepseek-ai/dsh-atomic-write',
        '@deepseek-ai/dsh-attachment',
        '@deepseek-ai/dsh-home-paths',
        '@deepseek-ai/dsh-host-webserver',
        '@deepseek-ai/dsh-llm',
        '@deepseek-ai/dsh-llm-pi-ai',
        '@deepseek-ai/dsh-settings',
      ],
    },
  },
  {
    entry: { client: 'src/client/index.tsx' },
    outDir: 'lib',
    format: ['cjs'],
    platform: 'browser',
    /*
     * No declarations for the client bundle: it is not a typed module. The host
     * loads it through `window.__ModuleLoader__` (see the banner below), no
     * TypeScript consumer imports it, and tsdown emits nothing for this entry
     * even with `dts: true` — verified against a full build. `package.json`
     * therefore exposes `./client` as a runtime path only, without a `types`
     * condition that would point at a file the build never writes.
     */
    dts: false,
    clean: false,
    define: VERSION_DEFINE,
    deps: { neverBundle: [...CLIENT_EXTERNALS] },
    outputOptions: {
      entryFileNames: 'client.js',
      banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(PLUGIN_ID)}, factory: (require) => {`,
      footer: 'return module.exports; } });',
      intro: 'var module = { exports: {} }; var exports = module.exports;',
    },
  },
] satisfies UserConfig[]
