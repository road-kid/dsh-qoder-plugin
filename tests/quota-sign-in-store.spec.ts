import { afterEach, describe, expect, it, vi } from 'vitest'

/**
 * The shared sign-in snapshot is the ONLY thing the switcher can say about the
 * variant the page is not looking at. Before this face existed it was a plain
 * pair of booleans initialised to `false`, so a freshly mounted page "knew" the
 * Global account was signed out and drew the grey dot ARGUMENT — the reported
 * defect. These cases pin the three states (unknown / signed in / signed out)
 * and the localStorage memory that survives a reload.
 */
describe('quota sign-in snapshot', () => {
  interface FakeStorage extends Storage {
    dump: () => Record<string, string>
  }

  function fakeStorage(seed: Record<string, string> = {}): FakeStorage {
    const map = new Map(Object.entries(seed))
    return {
      getItem: (key: string) => map.get(key) ?? null,
      setItem: (key: string, value: string) => { map.set(key, value) },
      removeItem: (key: string) => { map.delete(key) },
      clear: () => { map.clear() },
      key: (index: number) => [...map.keys()][index] ?? null,
      get length() { return map.size },
      dump: () => Object.fromEntries(map),
    }
  }

  /** Import the module in a fresh registry, with `window` shaped as the test needs. */
  async function load(storage?: Storage) {
    vi.resetModules()
    if (storage !== undefined) vi.stubGlobal('window', { localStorage: storage })
    return import('../src/client/quota-settings-store.ts')
  }

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.resetModules()
  })

  it('starts unknown instead of claiming both variants are signed out', async () => {
    const store = await load()
    expect(store.quotaSignInState()).toEqual({ cn: undefined, global: undefined })
  })

  it('records a known answer without inventing one for the other variant', async () => {
    const store = await load()
    store.noteQuotaSignIn('qoder', true)
    expect(store.quotaSignInState()).toEqual({ cn: true, global: undefined })
    expect(store.quotaSignInState().global).not.toBe(false)
  })

  it('remembers the last known answers across a reload', async () => {
    const storage = fakeStorage()
    const first = await load(storage)
    first.noteQuotaSignIn('qoder', true)
    first.noteQuotaSignIn('qoder-global', false)
    expect(storage.dump()['dsh-qoder-plugin:sign-in']).toBe(JSON.stringify({ cn: true, global: false }))

    // A reload: a new module instance reading the same storage.
    const second = await load(storage)
    expect(second.quotaSignInState()).toEqual({ cn: true, global: false })
  })

  it('survives a corrupt stored value by falling back to unknown', async () => {
    const storage = fakeStorage({ 'dsh-qoder-plugin:sign-in': '{not json' })
    const store = await load(storage)
    expect(store.quotaSignInState()).toEqual({ cn: undefined, global: undefined })
  })

  it('drops non-boolean fields rather than promoting them to a sign-in state', async () => {
    const storage = fakeStorage({ 'dsh-qoder-plugin:sign-in': JSON.stringify({ cn: 'yes', global: 1 }) })
    const store = await load(storage)
    expect(store.quotaSignInState()).toEqual({ cn: undefined, global: undefined })
  })

  it('forgets everything on reset — memory and storage both', async () => {
    const storage = fakeStorage()
    const store = await load(storage)
    store.noteQuotaSignIn('qoder', true)
    store.resetQuotaSignIn()
    expect(store.quotaSignInState()).toEqual({ cn: undefined, global: undefined })
    expect(storage.dump()['dsh-qoder-plugin:sign-in']).toBe('{}')
  })

  it('publishes a revision change only when a value actually moves', async () => {
    const store = await load()
    const seen: number[] = []
    store.onQuotaSettingsChange(() => seen.push(store.quotaSettingsRevision()))
    const before = store.quotaSettingsRevision()
    store.noteQuotaSignIn('qoder', true)
    store.noteQuotaSignIn('qoder', true)
    expect(store.quotaSettingsRevision()).toBe(before + 1)
    expect(seen).toHaveLength(1)
  })
})
