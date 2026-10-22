import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { QoderCredentialStore, qoderCredentialIdentity } from '../src/auth.ts'
import { CHINA_VARIANT } from '../src/variants.ts'

/**
 * Parking an account: the flag that takes a stored token out of the automatic
 * failover walk WITHOUT deleting it.
 *
 * The cases below are the promise the checkbox makes: the row survives a
 * restart, the walk never picks a parked account, a pool with nothing enabled
 * ends the walk instead of cycling, and a document written before the field
 * existed keeps every account usable.
 */

const CLEANUP: (() => Promise<void>)[] = []

afterEach(async () => {
  await Promise.all(CLEANUP.splice(0).map(clean => clean()))
})

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'qoder-enabled-'))
  CLEANUP.push(() => rm(dir, { recursive: true, force: true }))
  return dir
}

function storeAt(ownPath: string): QoderCredentialStore {
  return new QoderCredentialStore({ variant: CHINA_VARIANT, ownPath })
}

/** Three tokens, saved in order, with the first one active. */
async function threeAccounts(ownPath: string): Promise<QoderCredentialStore> {
  const store = storeAt(ownPath)
  await store.save('pt-alpha')
  await store.save('pt-beta')
  await store.save('pat-gamma')
  await store.activate(qoderCredentialIdentity({ pat: 'pt-alpha' }))
  return store
}

describe('per-account enablement', () => {
  it('round-trips a park through the file', async () => {
    const dir = await tempDir()
    const path = join(dir, '.qoder-auth.json')
    const store = await threeAccounts(path)
    const beta = qoderCredentialIdentity({ pat: 'pt-beta' })

    await expect(store.setEnabled(beta, false)).resolves.toBe(true)

    const reopened = storeAt(path)
    const entries = await reopened.accounts()
    expect(entries.find(entry => entry.id === beta)?.enabled).toBe(false)
    // Everything else stays enabled, and `enabled` stays ABSENT rather than
    // being materialized as `true` — the field's meaning depends on that.
    expect(entries.filter(entry => entry.enabled === false)).toHaveLength(1)
    expect(entries.filter(entry => !('enabled' in entry))).toHaveLength(2)
  })

  it('un-parking drops the field instead of storing true', async () => {
    const dir = await tempDir()
    const path = join(dir, '.qoder-auth.json')
    const store = await threeAccounts(path)
    const beta = qoderCredentialIdentity({ pat: 'pt-beta' })

    await store.setEnabled(beta, false)
    await store.setEnabled(beta, true)

    const raw = JSON.parse(await readFile(path, 'utf8')) as { accounts: { id: string; enabled?: unknown }[] }
    const row = raw.accounts.find(entry => entry.id === beta)
    expect(row).toBeDefined()
    expect('enabled' in (row as object)).toBe(false)
    await expect(store.accounts()).resolves.toSatisfy(
      (entries: readonly { id: string; enabled?: boolean }[]) => entries.every(entry => entry.enabled === undefined),
    )
  })

  it('answers false for an unknown id rather than throwing', async () => {
    const dir = await tempDir()
    const store = await threeAccounts(join(dir, '.qoder-auth.json'))
    await expect(store.setEnabled('pat:no-such-account', false)).resolves.toBe(false)
  })

  it('keeps a parked active account active and signable', async () => {
    const dir = await tempDir()
    const store = await threeAccounts(join(dir, '.qoder-auth.json'))
    const alpha = qoderCredentialIdentity({ pat: 'pt-alpha' })

    await store.setEnabled(alpha, false)

    const entries = await store.accounts()
    const row = entries.find(entry => entry.id === alpha)
    expect(row?.active).toBe(true)
    expect(row?.enabled).toBe(false)
    // Parking never moves the active pointer: the user parked an account, they
    // did not switch which subscription pays.
    await expect(store.current()).resolves.toMatchObject({ pat: 'pt-alpha' })
  })

  it('re-saving a parked token un-parks it', async () => {
    const dir = await tempDir()
    const store = await threeAccounts(join(dir, '.qoder-auth.json'))
    const beta = qoderCredentialIdentity({ pat: 'pt-beta' })

    await store.setEnabled(beta, false)
    await store.save('pt-beta')

    const row = (await store.accounts()).find(entry => entry.id === beta)
    expect(row?.enabled).toBeUndefined()
  })
})

describe('the failover walk skips parked accounts', () => {
  it('never returns a parked successor', async () => {
    const dir = await tempDir()
    const store = await threeAccounts(join(dir, '.qoder-auth.json'))
    const alpha = qoderCredentialIdentity({ pat: 'pt-alpha' })
    const beta = qoderCredentialIdentity({ pat: 'pt-beta' })

    await store.setEnabled(beta, false)

    // alpha -> beta is parked, so the walk lands on gamma.
    await expect(store.nextAfter(alpha)).resolves.toMatchObject({ pat: 'pat-gamma' })
  })

  it('ends the walk when nothing else is enabled', async () => {
    const dir = await tempDir()
    const store = await threeAccounts(join(dir, '.qoder-auth.json'))
    const alpha = qoderCredentialIdentity({ pat: 'pt-alpha' })
    const beta = qoderCredentialIdentity({ pat: 'pt-beta' })
    const gamma = qoderCredentialIdentity({ pat: 'pat-gamma' })

    await store.setEnabled(alpha, false)
    await store.setEnabled(beta, false)
    await store.setEnabled(gamma, false)
    await expect(store.nextAfter(alpha)).resolves.toBeUndefined()
  })

  it('walks forward from a parked starting id', async () => {
    const dir = await tempDir()
    const store = await threeAccounts(join(dir, '.qoder-auth.json'))
    const beta = qoderCredentialIdentity({ pat: 'pt-beta' })

    // beta is the account that just failed, and the user parked it. The walk
    // must still move PAST it rather than report the pool as exhausted.
    await store.setEnabled(beta, false)
    await expect(store.nextAfter(beta)).resolves.toMatchObject({ pat: 'pat-gamma' })
  })

  it('preserves the one-lap bound and never loops back to the start', async () => {
    const dir = await tempDir()
    const store = await threeAccounts(join(dir, '.qoder-auth.json'))
    const gamma = qoderCredentialIdentity({ pat: 'pat-gamma' })
    const alpha = qoderCredentialIdentity({ pat: 'pt-alpha' })
    const beta = qoderCredentialIdentity({ pat: 'pt-beta' })

    await store.setEnabled(alpha, false)
    await store.setEnabled(beta, false)
    // Only gamma is enabled, so the walk from gamma answers nothing at all —
    // wrapping onto the account it was given would be a cycle, not a walk.
    await expect(store.nextAfter(gamma)).resolves.toBeUndefined()
  })

  it('starts from the first ENABLED account for an unknown id', async () => {
    const dir = await tempDir()
    const store = await threeAccounts(join(dir, '.qoder-auth.json'))
    const alpha = qoderCredentialIdentity({ pat: 'pt-alpha' })

    await store.setEnabled(alpha, false)
    await expect(store.nextAfter(undefined)).resolves.toMatchObject({ pat: 'pt-beta' })
    await expect(store.nextAfter('pat:unknown')).resolves.toMatchObject({ pat: 'pt-beta' })
  })
})

describe('documents written before parking existed', () => {
  it('reads a v2 single-token file as one enabled account', async () => {
    const dir = await tempDir()
    const path = join(dir, '.qoder-auth.json')
    const { writeFile } = await import('node:fs/promises')
    await writeFile(path, JSON.stringify({ version: 2, pat: 'pt-sole', region: 'china' }), 'utf8')

    const store = storeAt(path)
    const entries = await store.accounts()
    expect(entries).toHaveLength(1)
    expect(entries[0]?.enabled).toBeUndefined()
    await expect(store.nextAfter(undefined)).resolves.toMatchObject({ pat: 'pt-sole' })
  })

  it('treats a hand-edited enabled value that is not false as enabled', async () => {
    const dir = await tempDir()
    const path = join(dir, '.qoder-auth.json')
    const { writeFile } = await import('node:fs/promises')
    const id = qoderCredentialIdentity({ pat: 'pt-odd' })
    await writeFile(path, JSON.stringify({
      version: 3,
      activeId: id,
      accounts: [{ id, pat: 'pt-odd', region: 'china', enabled: 0 }],
    }), 'utf8')

    const store = storeAt(path)
    const entries = await store.accounts()
    expect(entries[0]?.enabled).toBeUndefined()
    await expect(store.nextAfter(undefined)).resolves.toMatchObject({ pat: 'pt-odd' })
  })
})
