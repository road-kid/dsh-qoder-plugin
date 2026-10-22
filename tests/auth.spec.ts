import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  patTail,
  qoderCredentialIdentity,
  qoderOwnAuthPath,
  QoderCredentialStore,
  QODER_AUTH_FILENAME,
  QODER_PAT_ENV_CN,
  QODER_PAT_ENV_GLOBAL,
  type AuthLogger,
} from '../src/auth.ts'
import {
  qoderPluginDataDir,
  QODER_DATA_DIR_ENV,
  QODER_DATA_DIR_NAME,
} from '../src/paths.ts'
import { CHINA_VARIANT, GLOBAL_VARIANT, type QoderVariant } from '../src/variants.ts'

/**
 * The Qoder credential store: a pool of Personal Access Tokens per variant,
 * one small JSON document on disk, and an environment fallback. There is no
 * device flow, no refresh, and no expiry — so the cases below are the pool's
 * own rules (save order, upsert, activation, removal, the failover walk), the
 * three ways a token can be found, and the stale-file refusal the WorkBuddy
 * era leaves behind.
 */

const CLEANUP: (() => Promise<void>)[] = []

afterEach(async () => {
  await Promise.all(CLEANUP.splice(0).map(clean => clean()))
  vi.unstubAllEnvs()
})

/** Fresh temp directory, cleaned up after the case. */
async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'qoder-store-'))
  CLEANUP.push(() => rm(dir, { recursive: true, force: true }))
  return dir
}

/** A store over an explicit plugin-owned path, with an optional logger. */
function storeAt(
  ownPath: string,
  variant: QoderVariant = CHINA_VARIANT,
  logger?: AuthLogger,
): QoderCredentialStore {
  return new QoderCredentialStore({ variant, ownPath, ...logger === undefined ? {} : { logger } })
}

/** A credential document in the plugin's v2 on-disk layout. */
function authDocument(pat = 'pt-test-0001', savedAt = Date.now()): string {
  return JSON.stringify({ version: 2, pat, region: 'china', savedAt })
}

/** The shape WorkBuddy-era tooling left behind (flat form): accessToken, no pat. */
function legacyDocument(): string {
  return JSON.stringify({
    accessToken: 'at',
    refreshToken: 'rt',
    expiresAt: 1_792_128_236,
    domain: 'www.codebuddy.cn',
    uid: 'uid-1',
    nickname: 'nick',
  })
}

describe('QoderCredentialStore: file reading', () => {
  it('serves the stored token as a card-source credential', async () => {
    const own = join(await tempDir(), 'own.json')
    const savedAt = 1_792_128_236_868
    await writeFile(own, authDocument('pt-file-abc', savedAt))
    const credential = await storeAt(own).current()
    expect(credential).toEqual({ pat: 'pt-file-abc', region: 'china', savedAtMs: savedAt, source: 'card' })
  })

  it('drops a non-finite or absent savedAt rather than inventing one', async () => {
    const own = join(await tempDir(), 'own.json')
    await writeFile(own, JSON.stringify({ version: 2, pat: 'pt-x', region: 'china', savedAt: 'tomorrow' }))
    await expect(storeAt(own).current()).resolves.toEqual({ pat: 'pt-x', region: 'china', source: 'card' })
  })

  it('falls back to the variant region when the file names none valid', async () => {
    const own = join(await tempDir(), 'own.json')
    await writeFile(own, JSON.stringify({ version: 2, pat: 'pt-x', region: 'mars' }))
    // Only 'global' and 'china' are facts here; anything else is not a region,
    // and the arm's own descriptor is the honest answer.
    await expect(storeAt(own, GLOBAL_VARIANT).current()).resolves.toMatchObject({ region: 'global' })
  })

  it('treats a blank pat as no credential', async () => {
    const own = join(await tempDir(), 'own.json')
    await writeFile(own, authDocument('   '))
    await expect(storeAt(own).current()).resolves.toBeUndefined()
  })

  it('treats unreadable or malformed files as signed-out, not as an error', async () => {
    const dir = await tempDir()
    const missing = storeAt(join(dir, 'absent.json'))
    await expect(missing.current()).resolves.toBeUndefined()
    await expect(missing.resolve()).rejects.toThrow(/MISSING_CREDENTIAL/)

    const broken = join(dir, 'broken.json')
    await writeFile(broken, 'not json')
    await expect(storeAt(broken).current()).resolves.toBeUndefined()

    const list = join(dir, 'list.json')
    await writeFile(list, '[1,2,3]')
    await expect(storeAt(list).current()).resolves.toBeUndefined()
  })
})

describe('QoderCredentialStore: stale WorkBuddy files', () => {
  it('refuses a legacy document and names the fix', async () => {
    const own = join(await tempDir(), 'own.json')
    await writeFile(own, legacyDocument())
    await expect(storeAt(own).current()).resolves.toBeUndefined()
    const status = await storeAt(own).status()
    expect(status.state).toBe('missing')
    expect(status.reason).toMatch(/stale WorkBuddy credential file/)
    expect(status.reason).toMatch(/Personal Access Token/)
  })

  it('warns once per store, not once per read', async () => {
    const own = join(await tempDir(), 'own.json')
    await writeFile(own, legacyDocument())
    let warnings = 0
    const store = storeAt(own, CHINA_VARIANT, { warn: () => { warnings += 1 } })
    await store.current()
    await store.current()
    await store.current()
    expect(warnings).toBe(1)
  })

  it('clears the legacy reason once a valid token is saved', async () => {
    const own = join(await tempDir(), 'own.json')
    await writeFile(own, legacyDocument())
    const store = storeAt(own)
    await expect(store.status()).resolves.toMatchObject({ state: 'missing', reason: expect.any(String) })
    await store.save('pt-new-1234')
    await expect(store.status()).resolves.toMatchObject({ state: 'configured' })
    const status = await store.status()
    expect(status.reason).toBeUndefined()
  })

  it('treats the nested legacy layout as an unusable file, no reason', async () => {
    // The refusal marker is a top-level `accessToken`. The older plugin's
    // nested {auth:{accessToken}} document carries no top-level marker, so it
    // degrades to a plain signed-out — never a fake migration, never a crash.
    const own = join(await tempDir(), 'own.json')
    await writeFile(own, JSON.stringify({
      version: 1,
      region: 'cn',
      auth: { accessToken: 'at', refreshToken: 'rt', expiresAt: 1_792_128_236, domain: 'www.codebuddy.cn' },
      account: { uid: 'uid-1' },
    }))
    await expect(storeAt(own).current()).resolves.toBeUndefined()
    const status = await storeAt(own).status()
    expect(status.state).toBe('missing')
    expect(status.reason).toBeUndefined()
  })
})

describe('QoderCredentialStore: environment fallback', () => {
  it('uses QODER_PERSONAL_ACCESS_TOKEN for the global arm', async () => {
    vi.stubEnv(QODER_PAT_ENV_GLOBAL, '  pt-env-global  ')
    const own = join(await tempDir(), 'absent.json')
    const credential = await storeAt(own, GLOBAL_VARIANT).current()
    // The env value is trimmed, and env-sourced credentials carry no savedAt.
    expect(credential).toEqual({ pat: 'pt-env-global', region: 'global', source: 'env' })
  })

  it('uses QODER_CN_PERSONAL_ACCESS_TOKEN for the china arm', async () => {
    vi.stubEnv(QODER_PAT_ENV_CN, 'pt-env-cn')
    const own = join(await tempDir(), 'absent.json')
    await expect(storeAt(own, CHINA_VARIANT).current()).resolves.toMatchObject({
      pat: 'pt-env-cn',
      region: 'china',
      source: 'env',
    })
  })

  it('keeps the arms separate: global never reads the CN variable', async () => {
    vi.stubEnv(QODER_PAT_ENV_CN, 'pt-env-cn')
    const own = join(await tempDir(), 'absent.json')
    await expect(storeAt(own, GLOBAL_VARIANT).current()).resolves.toBeUndefined()
  })

  it('ignores an env value that is only whitespace', async () => {
    vi.stubEnv(QODER_PAT_ENV_GLOBAL, '   ')
    await expect(storeAt(join(await tempDir(), 'absent.json'), GLOBAL_VARIANT).current()).resolves.toBeUndefined()
  })

  it('prefers a saved token over a stray env value', async () => {
    vi.stubEnv(QODER_PAT_ENV_CN, 'pt-env')
    const own = join(await tempDir(), 'own.json')
    await writeFile(own, authDocument('pt-file'))
    const credential = await storeAt(own).current()
    expect(credential).toMatchObject({ pat: 'pt-file', source: 'card' })
  })

  it('a legacy file is no file at all, so env still answers', async () => {
    // The legacy document is not a saved token, and the env rule is "use the
    // environment when no file credential exists". Refusing to fall through
    // would strand a profile whose env is the only live credential.
    vi.stubEnv(QODER_PAT_ENV_CN, 'pt-env')
    const own = join(await tempDir(), 'own.json')
    await writeFile(own, legacyDocument())
    await expect(storeAt(own).current()).resolves.toMatchObject({ pat: 'pt-env', source: 'env' })
  })
})

describe('QoderCredentialStore: save, clear, and the on-disk layout', () => {
  it('writes the v3 pool document and reads it back', async () => {
    const dir = await tempDir()
    const own = join(dir, 'own.json')
    const before = Date.now()
    const credential = await storeAt(own).save('  pt-saved-99  ')
    const document = JSON.parse(await readFile(own, 'utf8')) as Record<string, unknown>
    // The single-account file is the pool with one row, not a second layout:
    // one code path writes and reads accounts, and a one-account install is
    // simply the smallest pool.
    expect(Object.keys(document).sort()).toEqual(['accounts', 'activeId', 'version'])
    expect(document.version).toBe(3)
    const accounts = document.accounts as Record<string, unknown>[]
    expect(accounts).toHaveLength(1)
    expect(Object.keys(accounts[0]!).sort()).toEqual(['id', 'pat', 'region', 'savedAt'])
    expect(accounts[0]).toMatchObject({ pat: 'pt-saved-99', region: 'china' })
    // The pointer names the row it signs with, by that row's own id.
    expect(document.activeId).toBe(accounts[0]!.id)
    expect(typeof accounts[0]!.savedAt).toBe('number')
    expect(accounts[0]!.savedAt as number).toBeGreaterThanOrEqual(before)
    expect(credential).toMatchObject({ pat: 'pt-saved-99', source: 'card' })
    await expect(storeAt(own).current()).resolves.toMatchObject({ pat: 'pt-saved-99' })
  })

  it('reads the v2 document a pre-pool build wrote', async () => {
    // Upgrading must not sign anyone out: every existing install has the
    // single-token shape on disk, and the pool reader has to accept it. The
    // next write rewrites the file, so the old shape only has to be READ.
    const dir = await tempDir()
    const own = join(dir, 'own.json')
    await writeFile(own, JSON.stringify({ version: 2, pat: 'pt-old-1', region: 'china', savedAt: 1_700_000_000_000 }))
    await expect(storeAt(own).current()).resolves.toMatchObject({ pat: 'pt-old-1', savedAtMs: 1_700_000_000_000 })
    await expect(storeAt(own).accounts()).resolves.toMatchObject([{ order: 1, active: true }])
    // A later save rewrites the whole file in the pool shape, keeping the
    // migrated token as a row.
    await storeAt(own).save('pt-new-2')
    const document = JSON.parse(await readFile(own, 'utf8')) as { version: number; accounts: { pat: string }[] }
    expect(document.version).toBe(3)
    expect(document.accounts.map(account => account.pat)).toEqual(['pt-old-1', 'pt-new-2'])
  })

  it('records cli provenance when the CLI saves', async () => {
    // `source` is the store's runtime knowledge only: the file itself has no
    // field for it, so a reload always reads back as 'card'.
    const dir = await tempDir()
    const own = join(dir, 'own.json')
    await storeAt(own).save('pt-cli-1', 'cli')
    await expect(storeAt(own).current()).resolves.toMatchObject({ source: 'card' })
  })

  it('refuses to save a blank token', async () => {
    const own = join(await tempDir(), 'own.json')
    await expect(storeAt(own).save('   ')).rejects.toThrow(/empty Personal Access Token/)
  })

  it('creates the directory its first write needs', async () => {
    const dir = await tempDir()
    const own = join(dir, 'absent', 'deeper', '.qoder-auth.json')
    const store = storeAt(own)
    await store.save('pt-deep-1')
    await expect(store.current()).resolves.toMatchObject({ pat: 'pt-deep-1' })
  })

  it('clear removes the file and a second clear is not an error', async () => {
    const dir = await tempDir()
    const own = join(dir, 'own.json')
    const store = storeAt(own)
    await store.save('pt-1')
    await store.clear()
    await expect(store.current()).resolves.toBeUndefined()
    await expect(store.clear()).resolves.toBeUndefined()
    await store.logout() // the alias does the same thing
  })

  it('leaves the credential file and nothing else beside it', async () => {
    const dir = await tempDir()
    await storeAt(join(dir, QODER_AUTH_FILENAME)).save('pt-1')
    expect(await readdir(dir)).toEqual([QODER_AUTH_FILENAME])
  })
})

describe('QoderCredentialStore: redacted status', () => {
  it('summarizes a stored token without ever carrying it', async () => {
    const dir = await tempDir()
    const own = join(dir, 'own.json')
    const store = storeAt(own)
    await store.save('pt-secret-abcd')
    const status = await store.status()
    expect(status).toEqual({
      state: 'configured',
      region: 'china',
      filePath: own,
      pat: { source: 'card', savedAtMs: expect.any(Number), patTail: 'abcd' },
    })
    expect(JSON.stringify(status)).not.toContain('pt-secret-abcd')
  })

  it('shows an env token as source env with no savedAt', async () => {
    vi.stubEnv(QODER_PAT_ENV_GLOBAL, 'pt-env-wxyz')
    const status = await storeAt(join(await tempDir(), 'absent.json'), GLOBAL_VARIANT).status()
    expect(status).toEqual({
      state: 'configured',
      region: 'global',
      filePath: expect.any(String),
      pat: { source: 'env', patTail: 'wxyz' },
    })
  })

  it('reports missing with the file path for diagnostics', async () => {
    const own = join(await tempDir(), 'absent.json')
    const status = await storeAt(own).status()
    expect(status).toEqual({ state: 'missing', region: 'china', filePath: own })
  })
})

describe('patTail and credential identity', () => {
  it('shows only the last four trimmed characters', () => {
    expect(patTail('  pt-abcdef  ')).toBe('cdef')
    expect(patTail('abcd')).toBe('abcd')
    expect(patTail('abc')).toBeUndefined()
    expect(patTail('')).toBeUndefined()
  })

  it('keys identity by a one-way hash, not any suffix of the token', async () => {
    const pat = 'pt-correlate-54321'
    const expected = `pat:${createHash('sha256').update(pat).digest('hex').slice(0, 16)}`
    expect(qoderCredentialIdentity({ pat })).toBe(expected)
    expect(qoderCredentialIdentity({ pat })).toBe(qoderCredentialIdentity({ pat }))
    // Different tokens get different keys, and the key never leaks the token.
    expect(qoderCredentialIdentity({ pat: 'pt-correlate-54322' })).not.toBe(expected)
    expect(expected).not.toContain('54321')
    // The identity used by probe/catalog stores derives from the live credential.
    const store = storeAt(join(await tempDir(), 'own.json'))
    const credential = await store.save(pat)
    expect(qoderCredentialIdentity(credential)).toBe(expected)
  })
})

describe('plugin data directory', () => {
  it('uses the override when one is set', () => {
    vi.stubEnv(QODER_DATA_DIR_ENV, '/tmp/qoder-override')
    expect(qoderPluginDataDir()).toBe('/tmp/qoder-override')
  })

  it('ignores a blank override', () => {
    vi.stubEnv(QODER_DATA_DIR_ENV, '  ')
    // Falls through to profile/home discovery, which is never the blank string.
    expect(qoderPluginDataDir()).not.toBe('  ')
  })

  it('picks the profile whose manifest declares this plugin', async () => {
    const home = await tempDir()
    await mkdir(join(home, 'profiles', 'web'), { recursive: true })
    await writeFile(
      join(home, 'profiles', 'web', 'package.json'),
      JSON.stringify({ name: 'dsh-profile-web', dependencies: { 'dsh-qoder-plugin': 'link:E:/elsewhere' } }),
    )
    await mkdir(join(home, 'profiles', 'desktop'), { recursive: true })
    await writeFile(join(home, 'profiles', 'desktop', 'package.json'), JSON.stringify({ name: 'dsh-profile-desktop' }))

    vi.stubEnv(QODER_DATA_DIR_ENV, '')
    vi.stubEnv('DSH_HOME', home)
    expect(qoderPluginDataDir()).toBe(join(home, 'profiles', 'web', QODER_DATA_DIR_NAME))
  })

  it('does not guess between two profiles that both declare it', async () => {
    const home = await tempDir()
    for (const name of ['web', 'desktop']) {
      await mkdir(join(home, 'profiles', name), { recursive: true })
      await writeFile(
        join(home, 'profiles', name, 'package.json'),
        JSON.stringify({ dependencies: { 'dsh-qoder-plugin': 'link:E:/elsewhere' } }),
      )
    }
    vi.stubEnv(QODER_DATA_DIR_ENV, '')
    vi.stubEnv('DSH_HOME', home)
    // Neither profile's installed copy resolves to this package, so writing a
    // credential into a guess would be worse than the documented fallback.
    expect(qoderPluginDataDir()).toBe(join(home, QODER_DATA_DIR_NAME))
  })

  it('falls back under the Harness home when no profile can be discovered', () => {
    vi.stubEnv(QODER_DATA_DIR_ENV, '')
    vi.stubEnv('DSH_HOME', '/tmp/qoder-home')
    const resolved = qoderPluginDataDir()
    expect(basename(resolved)).toBe(QODER_DATA_DIR_NAME)
    expect(dirname(resolved).endsWith(join('tmp', 'qoder-home'))).toBe(true)
    expect(resolved).not.toBe('/tmp/qoder-home')
  })

  it('gives each variant its own file inside one data directory', () => {
    const cn = new QoderCredentialStore({ variant: CHINA_VARIANT })
    const global = new QoderCredentialStore({ variant: GLOBAL_VARIANT })
    expect(cn.ownAuthPath()).toBe(join(qoderPluginDataDir(), CHINA_VARIANT.ownFilename))
    expect(global.ownAuthPath()).toBe(join(qoderPluginDataDir(), GLOBAL_VARIANT.ownFilename))
    expect(cn.ownAuthPath()).not.toBe(global.ownAuthPath())
    expect(qoderOwnAuthPath(CHINA_VARIANT)).toBe(cn.ownAuthPath())
    expect(qoderOwnAuthPath(GLOBAL_VARIANT)).toBe(global.ownAuthPath())
  })
})

describe('resolve and patPromise', () => {
  it('resolve hands the credential while one exists', async () => {
    const own = join(await tempDir(), 'own.json')
    const store = storeAt(own)
    await store.save('pt-1')
    await expect(store.resolve()).resolves.toMatchObject({ pat: 'pt-1' })
    await expect(store.patPromise()).resolves.toBe('pt-1')
  })

  it('resolve fails with MISSING_CREDENTIAL naming the card as the fix', async () => {
    const store = storeAt(join(await tempDir(), 'absent.json'))
    await expect(store.resolve()).rejects.toThrow(/MISSING_CREDENTIAL/)
    await expect(store.resolve()).rejects.toThrow(/settings card/)
    await expect(store.patPromise()).rejects.toThrow(/MISSING_CREDENTIAL/)
  })
})

describe('QoderCredentialStore: the account pool', () => {
  // The pool is the whole point of the multi-PAT feature, and its rules are all
  // about the ORDER of the rows: which one signs, which one inherits when one is
  // removed, and which one failover reaches next. A v2 file upgraded to the pool
  // shape is covered above; these cases pin the behaviour that only exists once a
  // second token has been saved.

  it('upserts a token that is already stored instead of adding a second row', async () => {
    const own = join(await tempDir(), 'own.json')
    const store = storeAt(own)
    const duplicate = qoderCredentialIdentity({ pat: 'pt-dup-1' })
    await store.save('pt-dup-1')
    await store.save('pt-other-2')
    // Pasting the first token again means "use this one", not "add a copy of
    // it": a duplicate row would fail over into itself and pay for the same
    // request twice. The row keeps its position and becomes active.
    await store.save('  pt-dup-1  ')
    await expect(store.accounts()).resolves.toMatchObject([
      { id: duplicate, order: 1, active: true },
      { id: qoderCredentialIdentity({ pat: 'pt-other-2' }), order: 2, active: false },
    ])
    await expect(store.current()).resolves.toMatchObject({ pat: 'pt-dup-1' })
  })

  it('re-stamps a foreign region from the variant on the next write', async () => {
    const own = join(await tempDir(), 'own.json')
    const foreign = 'pt-copied-from-global'
    const id = qoderCredentialIdentity({ pat: foreign })
    // A row can claim the other arm's region: the file was hand-copied between
    // the two stores, or written by a build that stored the wrong one. This
    // store can only ever present a token to its own region, so keeping the
    // claim would be a lie the file tells about itself.
    await writeFile(own, JSON.stringify({
      version: 3,
      activeId: id,
      accounts: [{ id, pat: foreign, region: 'global', savedAt: 1_700_000_000_000 }],
    }))
    await storeAt(own).save('pt-china-own')
    const document = JSON.parse(await readFile(own, 'utf8')) as {
      accounts: { pat: string; region: string }[]
    }
    expect(document.accounts.map(account => [account.pat, account.region])).toEqual([
      [foreign, 'china'],
      ['pt-china-own', 'china'],
    ])
  })

  it('switches the active pointer on activate, durably', async () => {
    const own = join(await tempDir(), 'own.json')
    const store = storeAt(own)
    const first = qoderCredentialIdentity({ pat: 'pt-first' })
    await store.save('pt-first')
    await store.save('pt-second') // saving selects, so 'second' signs requests
    await expect(store.current()).resolves.toMatchObject({ pat: 'pt-second' })
    await expect(store.activate(first)).resolves.toMatchObject({ pat: 'pt-first' })
    await expect(store.current()).resolves.toMatchObject({ pat: 'pt-first' })
    await expect(store.status()).resolves.toMatchObject({ pat: { patTail: 'irst' } })
    await expect(store.accounts()).resolves.toMatchObject([
      { id: first, active: true },
      { active: false },
    ])
    // A fresh store over the same file must agree: the pointer is on disk, not
    // in the instance that performed the switch.
    await expect(storeAt(own).current()).resolves.toMatchObject({ pat: 'pt-first' })
  })

  it('rejects an unknown account id rather than switching to another one', async () => {
    const own = join(await tempDir(), 'own.json')
    const store = storeAt(own)
    await store.save('pt-known')
    const stranger = qoderCredentialIdentity({ pat: 'pt-never-saved' })
    // The card's id came from a status document that may have gone stale (the
    // row was removed in another tab). Switching to a DIFFERENT account than
    // the one asked for is the surprise this feature exists to remove.
    await expect(store.activate(stranger)).rejects.toBeInstanceOf(Error)
    await expect(store.activate(stranger)).rejects.toThrow(stranger)
    await expect(store.current()).resolves.toMatchObject({ pat: 'pt-known' })
  })

  it('removing the active account activates the next one in save order', async () => {
    const own = join(await tempDir(), 'own.json')
    const store = storeAt(own)
    await store.save('pt-a')
    await store.save('pt-b')
    await store.save('pt-c')
    const [first] = await store.accounts()
    await store.activate(first!.id)
    await expect(store.remove(first!.id)).resolves.toBe(true)
    // The successor is the account failover would have picked next, so deleting
    // a dead token lands on a live one while other tokens remain.
    await expect(store.current()).resolves.toMatchObject({ pat: 'pt-b' })
    await expect(store.accounts()).resolves.toMatchObject([
      { order: 1, active: true },
      { order: 2, active: false },
    ])
  })

  it('removing the last account in save order falls back to the one before it', async () => {
    const own = join(await tempDir(), 'own.json')
    const store = storeAt(own)
    await store.save('pt-a')
    await store.save('pt-b')
    // 'b' is active because save selects it, and it has no successor: the
    // account before it is the only remaining candidate.
    const last = qoderCredentialIdentity({ pat: 'pt-b' })
    await expect(store.remove(last)).resolves.toBe(true)
    await expect(store.current()).resolves.toMatchObject({ pat: 'pt-a' })
  })

  it('reports a removal that matched nothing instead of pretending success', async () => {
    const store = storeAt(join(await tempDir(), 'own.json'))
    await store.save('pt-only')
    await expect(store.remove('pat:0000000000000000')).resolves.toBe(false)
    await expect(store.accounts()).resolves.toHaveLength(1)
    await expect(store.current()).resolves.toMatchObject({ pat: 'pt-only' })
  })

  it('removing the last account signs out and leaves no file, like clear', async () => {
    const dir = await tempDir()
    const own = join(dir, 'own.json')
    const store = storeAt(own)
    await store.save('pt-last')
    await expect(store.remove(qoderCredentialIdentity({ pat: 'pt-last' }))).resolves.toBe(true)
    await expect(store.current()).resolves.toBeUndefined()
    await expect(store.accounts()).resolves.toEqual([])
    await expect(store.status()).resolves.toMatchObject({ state: 'missing' })
    // An empty pool document is indistinguishable from a configured store to
    // anything that inspects the path, while the user is in exactly the state
    // clear() produces. So it goes the way clear() leaves it.
    expect(await readdir(dir)).toEqual([])
  })

  it('lists no accounts when there is no document at all', async () => {
    const store = storeAt(join(await tempDir(), 'absent.json'))
    await expect(store.accounts()).resolves.toEqual([])
    await expect(store.list()).resolves.toEqual([])
  })

  it('does not list an env-only credential as a pool account', async () => {
    vi.stubEnv(QODER_PAT_ENV_CN, 'pt-env-only')
    const store = storeAt(join(await tempDir(), 'absent.json'))
    await expect(store.current()).resolves.toMatchObject({ pat: 'pt-env-only', source: 'env' })
    // The pool is what is on disk. The environment token is a fallback the card
    // cannot switch away from or remove, so it is deliberately not a row.
    await expect(store.accounts()).resolves.toEqual([])
  })

  it('walks the pool in save order and wraps, so a tried-set can stop it', async () => {
    const own = join(await tempDir(), 'own.json')
    const store = storeAt(own)
    const only = qoderCredentialIdentity({ pat: 'pt-one' })
    await store.save('pt-one')
    // One account is nothing else to try: failover must not retry the token
    // that just failed.
    await expect(store.nextAfter(only)).resolves.toBeUndefined()
    await store.save('pt-two')
    const [first, second] = await store.accounts()
    await expect(store.nextAfter(first!.id)).resolves.toMatchObject({ pat: 'pt-two' })
    // Wrapping is pinned explicitly: the transport walks with a tried-set and
    // stops when the successor is an id it has already used, which is what makes
    // a full pass over the pool end instead of looping.
    await expect(store.nextAfter(second!.id)).resolves.toMatchObject({ pat: 'pt-one' })
    await expect(store.nextAfter(undefined)).resolves.toMatchObject({ pat: 'pt-one' })
  })
})

describe('QoderCredentialStore mutation queue', () => {
  /*
   * Every mutator loads the document, edits it in memory, and writes it back, so
   * two overlapping mutators would drop one of the two edits: the second write
   * republishes a list that never contained the first one's change. The card can
   * produce exactly that (a double-submitted save, or two tabs), so the store
   * serializes the sections instead of trusting its callers to.
   */

  it('keeps both accounts when two saves overlap', async () => {
    const store = storeAt(join(await tempDir(), 'own.json'))
    await Promise.all([store.save('pt-race-a'), store.save('pt-race-b')])
    const tails = (await store.accounts()).map(account => account.patTail).sort()
    expect(tails).toEqual(['ce-a', 'ce-b'])
  })

  it('does not let a save resurrect an account removed beside it', async () => {
    const store = storeAt(join(await tempDir(), 'own.json'))
    await store.save('pt-keep')
    await store.save('pt-doomed')
    await Promise.all([
      store.remove(qoderCredentialIdentity({ pat: 'pt-doomed' })),
      store.save('pt-fresh'),
    ])
    // Neither edit may be lost: the removal must not be undone by the concurrent
    // write, and the saved account must not be dropped by it.
    const tails = (await store.accounts()).map(account => account.patTail).sort()
    expect(tails).toEqual(['keep', 'resh'])
    await expect(store.patPromise()).resolves.toBe('pt-fresh')
  })

  it('leaves the document whole when activation and saving overlap', async () => {
    const own = join(await tempDir(), 'own.json')
    const store = storeAt(own)
    const first = await store.save('pt-first')
    await store.save('pt-second')
    await Promise.all([
      store.activate(qoderCredentialIdentity({ pat: first.pat })),
      store.save('pt-third'),
    ])
    // Whichever order the queue chose, the file is parseable and the active
    // pointer names an account that is really in the pool.
    const parsed = JSON.parse(await readFile(own, 'utf8')) as {
      activeId?: string
      accounts?: { id: string }[]
    }
    const ids = (parsed.accounts ?? []).map(account => account.id)
    expect(ids).toHaveLength(3)
    expect(ids).toContain(parsed.activeId)
  })

  it('keeps running later mutators after one of them rejects', async () => {
    const store = storeAt(join(await tempDir(), 'own.json'))
    await store.save('pt-survivor')
    // A rejected section must not leave the queue settled on a rejected promise,
    // which would fail every later call with this error instead of running it.
    await expect(store.activate('pat:does-not-exist')).rejects.toThrow(/no stored account matches/u)
    await expect(store.save('pt-later')).resolves.toMatchObject({ pat: 'pt-later' })
    await expect(store.patPromise()).resolves.toBe('pt-later')
  })
})
