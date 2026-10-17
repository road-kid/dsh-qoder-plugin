import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { QoderCredentialStore, QODER_PAT_ENV_CN, QODER_PAT_ENV_GLOBAL } from '../src/auth.ts'
import { QoderCatalog, FALLBACK_QODER_MODELS } from '../src/catalog.ts'
import {
  QODER_AUTH_PATH,
  QODER_GLOBAL_AUTH_PATH,
  QODER_GLOBAL_PROBE_PATH,
  QODER_GLOBAL_STATUS_PATH,
  QODER_PROBE_PATH,
  QODER_STATUS_PATH,
} from '../src/status-paths.ts'
import {
  CHINA_VARIANT,
  GLOBAL_VARIANT,
  QODER_VARIANTS,
  variantFor,
} from '../src/variants.ts'

/**
 * The two-variant contract. Both arms are the same upstream in different
 * regions, and they differ only by route, file identity, and display identity.
 * Everything that varies is one descriptor, so these tests cover the three
 * ways that can go wrong: a credential crossing products, one variant's files
 * answering for the other, and a route one arm serves that the other's card
 * then calls.
 */

const CLEANUP: (() => Promise<void>)[] = []

afterEach(async () => {
  for (const dispose of CLEANUP.splice(0)) await dispose()
  vi.unstubAllEnvs()
})

async function tempDir(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'qoder-variants-'))
  CLEANUP.push(() => rm(root, { recursive: true, force: true }))
  return root
}

describe('variant descriptors', () => {
  it("keeps the China arm on the plugin's no-suffix identity", () => {
    expect(CHINA_VARIANT.id).toBe('qoder')
    expect(CHINA_VARIANT.displayName).toBe('Qoder')
    expect(CHINA_VARIANT.appName).toBe('Qoder')
    expect(CHINA_VARIANT.region).toBe('china')
    expect(CHINA_VARIANT.ownFilename).toBe('.qoder-auth.json')
    expect(CHINA_VARIANT.probeFilename).toBe('.qoder-probe.json')
    expect(CHINA_VARIANT.catalogFilename).toBe('.qoder-catalog.json')
    expect(CHINA_VARIANT.statusPath).toBe('/plugins/dsh-qoder-plugin/status')
    expect(CHINA_VARIANT.probePath).toBe('/plugins/dsh-qoder-plugin/probe')
    expect(CHINA_VARIANT.authPath).toBe('/plugins/dsh-qoder-plugin/auth')
  })

  it('gives the Global arm its own files and /global/ routes', () => {
    expect(GLOBAL_VARIANT.id).toBe('qoder-global')
    expect(GLOBAL_VARIANT.displayName).toBe('Qoder Global')
    expect(GLOBAL_VARIANT.appName).toBe('Qoder Global')
    expect(GLOBAL_VARIANT.region).toBe('global')
    expect(GLOBAL_VARIANT.ownFilename).toBe('.qoder-global-auth.json')
    expect(GLOBAL_VARIANT.probeFilename).toBe('.qoder-global-probe.json')
    expect(GLOBAL_VARIANT.catalogFilename).toBe('.qoder-global-catalog.json')
    expect(GLOBAL_VARIANT.statusPath).toBe('/plugins/dsh-qoder-plugin/global/status')
    expect(GLOBAL_VARIANT.probePath).toBe('/plugins/dsh-qoder-plugin/global/probe')
    expect(GLOBAL_VARIANT.authPath).toBe('/plugins/dsh-qoder-plugin/global/auth')
  })

  it('orders the table China-first as the default and compatibility anchor', () => {
    expect(QODER_VARIANTS).toEqual([CHINA_VARIANT, GLOBAL_VARIANT])
    expect(variantFor('qoder')).toBe(CHINA_VARIANT)
    expect(variantFor('qoder-global')).toBe(GLOBAL_VARIANT)
    expect(variantFor('workbuddy')).toBeUndefined()
    expect(variantFor('qoder-ai')).toBeUndefined()
  })

  it('shares no field value between the two arms', () => {
    // A shared credential or probe file would let one product's state answer
    // for the other; a shared route would cross the cards.
    for (const field of ['id', 'displayName', 'appName', 'region', 'ownFilename', 'probeFilename', 'catalogFilename', 'statusPath', 'probePath', 'authPath'] as const) {
      expect(CHINA_VARIANT[field]).not.toBe(GLOBAL_VARIANT[field])
    }
  })

  it("answers the quota store's path test with the arm it belongs to", () => {
    // quota-settings-store decides the variant from the status path alone.
    // The international route contract is the `/global/` segment: it must not
    // regress to the WorkBuddy-era `/ai/` spelling, and the China route must
    // never acquire either marker.
    for (const variant of QODER_VARIANTS) {
      const looksGlobal = variant.statusPath.includes('/global/')
      const looksLikeOldAi = variant.statusPath.includes('/ai/')
      expect(looksLikeOldAi).toBe(false)
      expect(looksGlobal).toBe(variant === GLOBAL_VARIANT)
      expect(variant.probePath.includes('/global/')).toBe(looksGlobal)
      expect(variant.authPath.includes('/global/')).toBe(looksGlobal)
    }
  })
})

describe('status-path literals', () => {
  it('mirror the variant table so both bundles agree without a shared expression', () => {
    // The browser and host bundles are built independently; these literals are
    // the contract they meet on. Any drift is the desk asking a route the
    // host never mounted.
    expect(CHINA_VARIANT.statusPath).toBe(QODER_STATUS_PATH)
    expect(CHINA_VARIANT.probePath).toBe(QODER_PROBE_PATH)
    expect(CHINA_VARIANT.authPath).toBe(QODER_AUTH_PATH)
    expect(GLOBAL_VARIANT.statusPath).toBe(QODER_GLOBAL_STATUS_PATH)
    expect(GLOBAL_VARIANT.probePath).toBe(QODER_GLOBAL_PROBE_PATH)
    expect(GLOBAL_VARIANT.authPath).toBe(QODER_GLOBAL_AUTH_PATH)
    expect(QODER_GLOBAL_STATUS_PATH).toBe('/plugins/dsh-qoder-plugin/global/status')
    expect(QODER_GLOBAL_PROBE_PATH).toBe('/plugins/dsh-qoder-plugin/global/probe')
    expect(QODER_GLOBAL_AUTH_PATH).toBe('/plugins/dsh-qoder-plugin/global/auth')
  })
})

describe('credentials never cross the arms', () => {
  it('a token saved through one variant is invisible to the other', async () => {
    const dir = await tempDir()
    const china = new QoderCredentialStore({ variant: CHINA_VARIANT, ownPath: join(dir, CHINA_VARIANT.ownFilename) })
    const global = new QoderCredentialStore({ variant: GLOBAL_VARIANT, ownPath: join(dir, GLOBAL_VARIANT.ownFilename) })
    await china.save('pt-china-only')
    await expect(china.current()).resolves.toMatchObject({ pat: 'pt-china-only', region: 'china' })
    await expect(global.current()).resolves.toBeUndefined()
    await global.save('pt-global-only')
    await expect(global.current()).resolves.toMatchObject({ pat: 'pt-global-only', region: 'global' })
    await expect(china.current()).resolves.toMatchObject({ pat: 'pt-china-only' })
    await global.clear()
    await expect(china.current()).resolves.toMatchObject({ pat: 'pt-china-only' })
  })

  it("each arm's env fallback answers only for its own region", async () => {
    vi.stubEnv(QODER_PAT_ENV_GLOBAL, 'pt-env-global')
    vi.stubEnv(QODER_PAT_ENV_CN, 'pt-env-cn')
    const dir = await tempDir()
    const china = new QoderCredentialStore({ variant: CHINA_VARIANT, ownPath: join(dir, 'absent-a.json') })
    const global = new QoderCredentialStore({ variant: GLOBAL_VARIANT, ownPath: join(dir, 'absent-b.json') })
    await expect(china.current()).resolves.toMatchObject({ pat: 'pt-env-cn', region: 'china', source: 'env' })
    await expect(global.current()).resolves.toMatchObject({ pat: 'pt-env-global', region: 'global', source: 'env' })
  })
})

describe('catalogs never cross the arms', () => {
  it('the shared fallback roster exists so a signed-out variant shows nothing rather than failing', () => {
    // Reasoning and rate metadata are absent: the defaults declare none, and
    // the mirror must not invent any.
    const ids = FALLBACK_QODER_MODELS.map(model => model.id)
    expect(ids).toEqual(['cmodel', 'auto', 'ultimate', 'performance', 'efficient', 'lite'])
    for (const model of FALLBACK_QODER_MODELS) {
      expect(model.billing).toEqual({ free: false, rateUnknown: true })
      expect(model.reasoning).toBeUndefined()
      expect(model.source).toBe('system')
    }
  })

  it('one catalog per variant keeps its own model list', async () => {
    const dir = await tempDir()
    const chinaCatalog = new QoderCatalog()
    const globalCatalog = new QoderCatalog()
    chinaCatalog.set([{ id: 'ultimate', name: 'Qoder Ultimate', contextWindow: 1_000_000, maxTokens: 32_768, supportsImages: true, billing: { credits: 'x1.6', free: false } }])
    // Empty is how a signed-out variant hides: the model picker drops an empty
    // group, so visibility is separate from content. The fallback() door
    // ignores visibility — its caller already knows the credential state.
    globalCatalog.setVisible(false)
    expect(globalCatalog.current()).toEqual([])
    expect(globalCatalog.fallback()).toEqual(FALLBACK_QODER_MODELS)
    expect(chinaCatalog.current().map(model => model.id)).toEqual(['ultimate'])
    expect(chinaCatalog.setVisible(false)).toBe(true)
    expect(chinaCatalog.setVisible(false)).toBe(false)
    chinaCatalog.setVisible(true)
    expect(chinaCatalog.current().length).toBeGreaterThan(0)
    void dir
  })

  it('the maximum-window preference upgrades declared windows and nothing else', () => {
    const catalog = new QoderCatalog([{
      id: 'w',
      name: 'Wide',
      contextWindow: 128_000,
      defaultContextWindow: 128_000,
      supportedContextWindows: [128_000, 1_000_000],
      maxTokens: 32_768,
      supportsImages: false,
      billing: { free: false, rateUnknown: true },
    }])
    expect(catalog.current()[0]?.contextWindow).toBe(128_000)
    expect(catalog.setUseMaximumContextWindow(true)).toBe(true)
    expect(catalog.current()[0]).toMatchObject({ contextWindow: 1_000_000, defaultContextWindow: 128_000 })
    expect(catalog.setUseMaximumContextWindow(true)).toBe(false)
    // A row without declared windows is untouched by the preference.
    const plain = new QoderCatalog([{ id: 'p', name: 'P', contextWindow: 10, maxTokens: 5, supportsImages: false, billing: { free: true } }])
    plain.setUseMaximumContextWindow(true)
    expect(plain.current()[0]?.contextWindow).toBe(10)
  })
})

describe('parse-era shapes are gone', () => {
  it('a WorkBuddy-era document never migrates into either arm', async () => {
    const dir = await tempDir()
    const legacy = {
      version: 1,
      region: 'cn',
      auth: { accessToken: 'at', refreshToken: 'rt', expiresAt: 1_792_128_236, domain: 'www.codebuddy.cn' },
      account: { uid: 'uid-1' },
    }
    for (const variant of QODER_VARIANTS) {
      const own = join(dir, variant.ownFilename)
      await writeFile(own, JSON.stringify(legacy))
      const store = new QoderCredentialStore({ variant, ownPath: own })
      await expect(store.current()).resolves.toBeUndefined()
    }
  })
})
