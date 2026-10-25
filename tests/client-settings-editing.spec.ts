import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { QoderPluginCard, type QoderPluginCardProps } from '../src/client/QoderPluginCard.tsx'
import { en } from '../src/client/locales.ts'
import type { QoderSettingsKey } from '../src/client/locales.ts'
import {
  resetQuotaSignIn,
  resetQuotaStatusDocuments,
  setAdvancedSettingsOpen,
  setQuotaReadout,
} from '../src/client/quota-settings-store.ts'
import { QODER_GLOBAL_STATUS_PATH, QODER_STATUS_PATH } from '../src/status-paths.ts'
import { QdpNumberField } from '../src/client/controls.tsx'
import { OwnQuotaSettingsScope } from '../src/client/http-settings-scope.ts'

/**
 * Editing the advanced settings card.
 *
 * These pin the two failure modes the user hit: a number field that wrote on
 * every keystroke (so clearing it to retype snapped back to the stored value
 * and the control read as uneditable), and controls that looked live while the
 * settings face had never answered — a click was accepted and silently
 * dropped. The card must either take the change or say it did not.
 */

const t = (key: QoderSettingsKey, params: Record<string, unknown> = {}): string =>
  Object.entries(params).reduce(
    (text, [name, value]) => text.replace(`{${name}}`, String(value)),
    en[key] as string,
  )

interface ScopeState {
  status: 'loading' | 'ready' | 'unavailable'
  error?: string
  value: Record<string, unknown>
}

/** A settings scope whose snapshot the test can move and whose writes it records. */
function fakeScope(initial: Partial<ScopeState> = {}) {
  const state: ScopeState = {
    status: 'ready',
    value: {},
    ...initial,
  }
  const listeners: Array<() => void> = []
  const set = vi.fn(async (field: string, value: unknown) => {
    // Apply the write the way the real face does: the next snapshot carries it,
    // and the subscribers are told — the card reads settings through
    // useSyncExternalStore, so nothing re-renders without this.
    state.value = { ...state.value, [field]: value }
    for (const listener of [...listeners]) listener()
    return true
  })
  return {
    state,
    set,
    scope: {
      getSnapshot: () => ({
        status: state.status,
        writable: true,
        value: state.value,
        ...state.error === undefined ? {} : { error: state.error },
      }),
      subscribe: (listener: () => void) => {
        listeners.push(listener)
        return () => {}
      },
      set,
    },
  }
}

describe('Advanced settings editing', () => {
  let view: ReactTestRenderer | undefined
  const request = vi.fn()

  beforeEach(() => {
    // 高级设置 ships with its switch off, so its rows are not in the document
    // until it is opened. This whole file edits exactly those rows.
    setAdvancedSettingsOpen(true)
    request.mockReset().mockImplementation(async (url: string) => {
      const path = String(url)
      if (path === QODER_STATUS_PATH) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            status: 'signed-in',
            region: 'china',
            pat: { source: 'card', patTail: '1111' },
            authKey: 'cn-auth-key',
            credits: { total: 30, accounts: [] },
            models: [],
            accounts: {
              entries: [
                {
                  id: 'acct-b',
                  accountName: 'B',
                  patTail: '2222',
                  source: 'card',
                  active: false,
                  order: 2,
                  enabled: true,
                  health: 'limited',
                  credits: { total: 50, accounts: [{ packageName: 'Pro', remain: 10, size: 20 }] },
                },
                {
                  id: 'acct-a',
                  accountName: 'A',
                  patTail: '1111',
                  source: 'card',
                  active: true,
                  order: 1,
                  credits: { total: 5, accounts: [{ packageName: 'Pro', remain: 2391, size: 2400 }] },
                },
              ],
              autoFailover: true,
              autoFailoverEnabled: true,
            },
          }),
        }
      }
      if (path === QODER_GLOBAL_STATUS_PATH) {
        return { ok: true, status: 200, json: async () => ({ status: 'signed-out', region: 'global' }) }
      }
      return { ok: true, status: 200, json: async () => ({ status: 'signed-out' }) }
    })
    vi.stubGlobal('fetch', request)
    vi.stubGlobal('requestAnimationFrame', (cb: (time: number) => void) => cb(0))
    vi.stubGlobal('window', {
      setInterval: () => 1,
      clearInterval: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
    })
    vi.stubGlobal('document', {
      hidden: false,
      addEventListener: () => {},
      removeEventListener: () => {},
    })
  })

  afterEach(() => {
    act(() => view?.unmount())
    resetQuotaSignIn()
    resetQuotaStatusDocuments()
    setQuotaReadout(true)
    vi.unstubAllGlobals()
  })

  async function mount(scope: ReturnType<typeof fakeScope>): Promise<void> {
    const props = {
      t: t as QoderPluginCardProps['t'],
      view: 'page' as const,
      unified: true,
      scope: scope.scope as never,
    } as unknown as Parameters<typeof QoderPluginCard>[0]
    await act(async () => { view = create(createElement(QoderPluginCard, props)) })
  }

  /** All rendered text under one node, flattened (test instances have no toJSON). */
  const textOf = (node: { children: ReadonlyArray<unknown> }): string => {
    const parts: string[] = []
    const walk = (value: unknown): void => {
      if (typeof value === 'string') { parts.push(value); return }
      if (typeof value === 'number') { parts.push(String(value)); return }
      if (Array.isArray(value)) { for (const item of value) walk(item); return }
      if (typeof value === 'object' && value !== null && 'children' in value) {
        walk((value as { children: ReadonlyArray<unknown> }).children)
      }
    }
    walk(node.children)
    return parts.join('')
  }

  /** The number field carrying one marker. */
  /** The number field carrying one marker (fails loudly when absent). */
  const field = (marker: string): { props: Record<string, any> } => {
    const found = view!.root.findAll(node => node.props['data-number-field'] === marker)[0]
    if (found === undefined) throw new Error(`no number field "${marker}"`)
    return found as unknown as { props: Record<string, any> }
  }

  /** Fire a change/blur the way a user typing would. */
  const type = async (marker: string, text: string): Promise<void> => {
    const node = field(marker)
    await act(async () => { node.props.onChange({ target: { value: text } }) })
  }

  const blur = async (marker: string): Promise<void> => {
    const node = field(marker)
    await act(async () => { node.props.onBlur() })
  }

  const key = async (marker: string, name: string): Promise<void> => {
    const node = field(marker)
    const event = { key: name, preventDefault: () => {} }
    await act(async () => { node.props.onKeyDown(event) })
  }

  /** The stickiness master switch (fails loudly when absent). */
  const stickinessSwitch = (): { props: Record<string, any> } => {
    const found = view!.root.findAll(node =>
      node.props['role'] === 'switch' && node.props['aria-label'] === en.stickinessLabel,
    )[0]
    if (found === undefined) throw new Error('no stickiness switch')
    return found as unknown as { props: Record<string, any> }
  }

  it('commits a typed stickiness bound on blur, not on every keystroke', async () => {    const scope = fakeScope({ value: { stickinessRounds: 1 } })
    await mount(scope)
    expect(field('stickiness-rounds')).toBeDefined()

    // Typing alone writes nothing: the field is a draft until it is committed.
    await type('stickiness-rounds', '')
    await type('stickiness-rounds', '7')
    expect(scope.set).not.toHaveBeenCalled()

    await blur('stickiness-rounds')
    expect(scope.set).toHaveBeenCalledTimes(1)
    expect(scope.set).toHaveBeenCalledWith('stickinessRounds', 7)
  })

  it('commits on Enter as well, so the keyboard path is the same as blur', async () => {
    const scope = fakeScope({ value: { stickinessRequests: 60 } })
    await mount(scope)
    await type('stickiness-requests', '120')
    await key('stickiness-requests', 'Enter')
    expect(scope.set).toHaveBeenCalledWith('stickinessRequests', 120)
  })

  it('clamps an out-of-range entry instead of writing a value the host would refuse', async () => {
    const scope = fakeScope({ value: { stickinessMinutes: 180 } })
    await mount(scope)
    await type('stickiness-minutes', '99999')
    await blur('stickiness-minutes')
    // 1440 is the card's own ceiling; the host would refuse anything above it.
    expect(scope.set).toHaveBeenCalledWith('stickinessMinutes', 1440)
    expect(field('stickiness-minutes').props.value).toBe('1440')
  })

  it('reverts a field left with no number, rather than writing NaN', async () => {
    const scope = fakeScope({ value: { queueWaitAttempts: 3 } })
    await mount(scope)
    await type('queue-wait-attempts', '')
    await blur('queue-wait-attempts')
    expect(scope.set).not.toHaveBeenCalled()
    expect(field('queue-wait-attempts').props.value).toBe('3')
  })

  it('reverts the draft on Escape', async () => {
    const scope = fakeScope({ value: { queueWaitSeconds: 30 } })
    await mount(scope)
    await type('queue-wait-seconds', '99')
    await key('queue-wait-seconds', 'Escape')
    expect(scope.set).not.toHaveBeenCalled()
    expect(field('queue-wait-seconds').props.value).toBe('30')
  })

  it('writes nothing when the committed value did not change', async () => {
    const scope = fakeScope({ value: { stickinessRounds: 5 } })
    await mount(scope)
    await type('stickiness-rounds', '5')
    await blur('stickiness-rounds')
    expect(scope.set).not.toHaveBeenCalled()
  })

  it('hides the three stickiness bounds while the master switch is off', async () => {
    const scope = fakeScope({ value: { stickinessEnabled: false, stickinessRounds: 3 } })
    await mount(scope)
    expect(stickinessSwitch().props['aria-checked']).toBe(false)
    expect(view!.root.findAll(node => node.props['data-number-field'] === 'stickiness-rounds')).toHaveLength(0)
    expect(view!.root.findAll(node => node.props['data-number-field'] === 'stickiness-requests')).toHaveLength(0)
    expect(view!.root.findAll(node => node.props['data-number-field'] === 'stickiness-minutes')).toHaveLength(0)

    // Turning it on writes the flag and — once the scope echoes the new value —
    // the bounds render again.
    await act(async () => { stickinessSwitch().props.onClick() })
    expect(scope.set).toHaveBeenCalledWith('stickinessEnabled', true)
    scope.state.value = { ...scope.state.value, stickinessEnabled: true }
    await act(async () => { view!.root }) // let state settle
    await mount(scope)
    expect(field('stickiness-rounds')).toBeDefined()
    expect(field('stickiness-requests')).toBeDefined()
    expect(field('stickiness-minutes')).toBeDefined()
  })

  it('hides the three stickiness bounds while the master switch is off', async () => {
    const scope = fakeScope({ value: { stickinessEnabled: false, stickinessRounds: 3 } })
    await mount(scope)
    expect(stickinessSwitch().props['aria-checked']).toBe(false)
    expect(view!.root.findAll(node => node.props['data-number-field'] === 'stickiness-rounds')).toHaveLength(0)
    expect(view!.root.findAll(node => node.props['data-number-field'] === 'stickiness-requests')).toHaveLength(0)
    expect(view!.root.findAll(node => node.props['data-number-field'] === 'stickiness-minutes')).toHaveLength(0)

    // Turning the switch on writes the flag; the fake scope applies the write
    // and notifies, so the card re-reads and the three bounds render.
    await act(async () => { stickinessSwitch().props.onClick() })
    expect(scope.set).toHaveBeenCalledWith('stickinessEnabled', true)
    expect(field('stickiness-rounds')).toBeDefined()
    expect(field('stickiness-requests')).toBeDefined()
    expect(field('stickiness-minutes')).toBeDefined()

    // Turning it back off hides them again without touching the stored bounds.
    await act(async () => { stickinessSwitch().props.onClick() })
    expect(scope.set).toHaveBeenCalledWith('stickinessEnabled', false)
    expect(view!.root.findAll(node => node.props['data-number-field'] === 'stickiness-rounds')).toHaveLength(0)
    expect(view!.root.findAll(node => node.props['data-number-field'] === 'stickiness-requests')).toHaveLength(0)
    expect(view!.root.findAll(node => node.props['data-number-field'] === 'stickiness-minutes')).toHaveLength(0)
  })

  it('defaults the stickiness master switch to on when the document predates it', async () => {
    // A settings document written by an older card carries no flag; the parse
    // must read it as ON, or upgrading the bundle would silently disable a
    // feature the user never touched.
    const scope = fakeScope({ value: { stickinessRounds: 3 } })
    await mount(scope)
    expect(stickinessSwitch().props['aria-checked']).toBe(true)
    expect(field('stickiness-rounds')).toBeDefined()
  })

  it('disables every settings control while the face is still loading, and says why', async () => {
    const scope = fakeScope({ status: 'loading' })
    await mount(scope)
    // The note explains the disabled state; a silent inert control is exactly
    // what made the page look broken.
    expect(JSON.stringify(view!.toJSON())).toContain(en.settingsLoading)
    for (const marker of ['stickiness-rounds', 'stickiness-requests', 'stickiness-minutes', 'queue-wait-attempts']) {
      expect(field(marker).props.disabled).toBe(true)
    }
    expect(stickinessSwitch().props.disabled).toBe(true)
  })

  it('enables the controls once the face answers', async () => {
    const scope = fakeScope({ status: 'ready', value: { stickinessRounds: 1 } })
    await mount(scope)
    expect(field('stickiness-rounds').props.disabled).toBe(false)
  })

  it('reports a refused write instead of leaving the control looking applied', async () => {
    const scope = fakeScope({ status: 'ready', value: {}, error: 'stale write key' })
    await mount(scope)
    const text = JSON.stringify(view!.toJSON())
    expect(text).toContain('stale write key')
    expect(text).toContain(en.settingsWriteFailed.replace('{message}', 'stale write key'))
  })

  it('shows each account balance and state on the name line, right after the name', async () => {
    await mount(fakeScope())
    const rows = view!.root.findAll(node => node.props['data-account-id'] !== undefined)
    expect(rows.length).toBe(2)

    // Row A: active, no observed failure -> 尚未观测, with its balance inline.
    // Not 正常: absent health means the host has not observed anything yet, and
    // the composer panel stays silent about exactly the same gap.
    const rowA = rows.find(row => row.props['data-account-id'] === 'acct-a')!
    const nameLineA = rowA.findAll(node => node.props.className === 'qdp-accountItemName')[0]!
    const textA = textOf(nameLineA)
    expect(textA).toContain('A')
    expect(textA).toContain('2,391')
    expect(textA).toContain(en.accountHealthUnknown)
    expect(textA).not.toContain(en.accountHealthNormal)
    // The gap is stated in the neutral tone: not an alarm, not a healthy tick.
    const healthChipA = nameLineA.findAll(node => node.props.className === 'qdp-accountHealth')[0]!
    expect(healthChipA.findAll(node => node.props.className === 'qdp-tag')).toHaveLength(1)
    expect(healthChipA.findAll(node => node.props.className === 'qdp-tagSuccess')).toHaveLength(0)
    expect(healthChipA.findAll(node => node.props.className === 'qdp-tagWarn')).toHaveLength(0)

    // Row B: observed 限流, balance inline too.
    const rowB = rows.find(row => row.props['data-account-id'] === 'acct-b')!
    const nameLineB = rowB.findAll(node => node.props.className === 'qdp-accountItemName')[0]!
    const textB = textOf(nameLineB)
    expect(textB).toContain('B')
    expect(textB).toContain(en.accountHealthLimited)

    // The old separate facts line is gone: everything sits on the name line.
    expect(rowA.findAll(node => node.props.className === 'qdp-accountItemFacts')).toHaveLength(0)
  })

  it('leaves a parked account without a health chip but keeps its credits wording', async () => {
    const scope = fakeScope()
    const body = {
      status: 'signed-in',
      region: 'china',
      pat: { source: 'card', patTail: '1111' },
      authKey: 'cn-auth-key',
      credits: { total: 30, accounts: [] },
      models: [],
      accounts: {
        entries: [{
          id: 'acct-c',
          accountName: 'C',
          source: 'card',
          active: true,
          order: 1,
          enabled: false,
          credits: { total: 5, accounts: [] },
        }],
        autoFailover: true,
        autoFailoverEnabled: true,
      },
    }
    request.mockImplementation(async (url: string) => {
      if (String(url) === QODER_STATUS_PATH) return { ok: true, status: 200, json: async () => body }
      return { ok: true, status: 200, json: async () => ({ status: 'signed-out' }) }
    })
    await mount(scope)
    const row = view!.root.findAll(node => node.props['data-account-id'] === 'acct-c')[0]!
    const text = textOf(row)
    expect(text).toContain(en.accountParked)
    expect(text).toContain(en.accountCreditsParked)
    // A parked seat is out of the walk, so claiming a state for it would lie —
    // including the neutral 「尚未观测」, which is still a statement about a seat.
    expect(text).not.toContain(en.accountHealthNormal)
    expect(text).not.toContain(en.accountHealthUnknown)
  })
})

describe('QdpNumberField', () => {
  it('keeps its draft while the stored value is unchanged', async () => {
    let view: ReactTestRenderer | undefined
    const onCommit = vi.fn()
    await act(async () => {
      view = create(createElement(QdpNumberField, {
        value: 3,
        min: 0,
        max: 10,
        label: 'n',
        onCommit,
      }))
    })
    const input = view!.root.findAllByType('input')[0]!
    await act(async () => { input.props.onChange({ target: { value: '8' } }) })
    // A re-render with the same stored value must not clobber the draft.
    await act(async () => {
      view!.update(createElement(QdpNumberField, {
        value: 3,
        min: 0,
        max: 10,
        label: 'n',
        onCommit,
      }))
    })
    expect(view!.root.findAllByType('input')[0]!.props.value).toBe('8')
    await act(async () => { view!.unmount() })
  })
})

/**
 * The settings scope behind the card.
 *
 * The card's controls are only as alive as this object: it owns the write key,
 * the retries that ride out the host's own mount, and the decision to report a
 * refusal instead of swallowing it. Each case below is one of the ways the page
 * used to go dead.
 */
describe('OwnQuotaSettingsScope', () => {
  const FACE = '/plugins/dsh-qoder-plugin/settings'

  interface Call { method: string; key: string | undefined; body: unknown }

  /** A fake settings face whose answers each test scripts. */
  function face(script: {
    get: Array<() => { ok: boolean; status: number; body: unknown }>
    post?: Array<() => { ok: boolean; status: number; body: unknown }>
  }) {
    const calls: Call[] = []
    const gets = [...script.get]
    const posts = [...(script.post ?? [])]
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      const headers = (init?.headers ?? {}) as Record<string, string>
      calls.push({
        method: init?.method ?? 'GET',
        key: headers['X-Qoder-Settings-Key'],
        body: init?.body === undefined ? undefined : JSON.parse(String(init.body)),
      })
      const answer = (init?.method === 'POST' ? posts.shift() : gets.shift())?.() ?? { ok: false, status: 404, body: { error: 'no script' } }
      return {
        ok: answer.ok,
        status: answer.status,
        json: async () => answer.body,
      }
    })
    vi.stubGlobal('fetch', fetchMock)
    return { calls, fetchMock }
  }

  const document = (key: string, value: Record<string, unknown>) => ({ key, value, base: {}, user: {} })

  afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); resetQuotaStatusDocuments(); resetQuotaSignIn() })

  it('retries a read that raced the host mount instead of staying on defaults', async () => {
    vi.useFakeTimers()
    face({
      get: [
        () => ({ ok: false, status: 404, body: { error: 'not mounted' } }),
        () => ({ ok: true, status: 200, body: document('k2', { stickinessRounds: 4 }) }),
      ],
    })
    const scope = new OwnQuotaSettingsScope()
    const pending = scope.load()
    await vi.advanceTimersByTimeAsync(400)
    const value = await pending
    expect(value).toEqual({ stickinessRounds: 4 })
    expect(scope.getSnapshot().status).toBe('ready')
    expect(scope.getSnapshot().value).toEqual({ stickinessRounds: 4 })
  })

  it('heals a stale write key by re-reading and retrying once', async () => {
    vi.useFakeTimers()
    const { calls } = face({
      get: [
        () => ({ ok: true, status: 200, body: document('old-key', { stickinessRounds: 1 }) }),
        // The re-read after the 403 hands back the re-minted key.
        () => ({ ok: true, status: 200, body: document('new-key', { stickinessRounds: 1 }) }),
      ],
      post: [
        () => ({ ok: false, status: 403, body: { error: 'stale write key' } }),
        () => ({ ok: true, status: 200, body: document('new-key', { stickinessRounds: 6 }) }),
      ],
    })
    const scope = new OwnQuotaSettingsScope()
    const loading = scope.load()
    await vi.advanceTimersByTimeAsync(0)
    await loading

    const accepted = await scope.set('stickinessRounds', 6)
    expect(accepted).toBe(true)
    expect(scope.getSnapshot().error).toBeUndefined()
    expect(scope.getSnapshot().value).toEqual({ stickinessRounds: 6 })
    // First POST with the stale key, then the re-read, then the retry with the
    // fresh one: exactly one heal, never a loop.
    const posts = calls.filter(call => call.method === 'POST')
    expect(posts.map(call => call.key)).toEqual(['old-key', 'new-key'])
  })

  it('reports a refused value without re-reading, because the key was fine', async () => {
    vi.useFakeTimers()
    const { calls } = face({
      get: [() => ({ ok: true, status: 200, body: document('k1', {}) })],
      post: [() => ({ ok: false, status: 400, body: { error: 'stickinessMinutes must be 0..1440' } })],
    })
    const scope = new OwnQuotaSettingsScope()
    const loading = scope.load()
    await vi.advanceTimersByTimeAsync(0)
    await loading

    const accepted = await scope.set('stickinessMinutes', 99_999)
    expect(accepted).toBe(false)
    // The refusal reaches the card, so the control cannot look applied.
    expect(scope.getSnapshot().error).toBe('stickinessMinutes must be 0..1440')
    // A bad value is not a stale key: no pointless re-read.
    expect(calls.filter(call => call.method === 'GET')).toHaveLength(1)
  })

  it('explains a face it could never read, instead of loading forever', async () => {
    vi.useFakeTimers()
    face({
      get: [
        () => ({ ok: false, status: 404, body: { error: 'not mounted' } }),
        () => ({ ok: false, status: 404, body: { error: 'not mounted' } }),
        () => ({ ok: false, status: 404, body: { error: 'not mounted' } }),
      ],
    })
    const scope = new OwnQuotaSettingsScope()
    const pending = scope.load()
    await vi.advanceTimersByTimeAsync(400)
    await vi.advanceTimersByTimeAsync(1200)
    const value = await pending
    expect(value).toBeUndefined()
    const snapshot = scope.getSnapshot()
    expect(snapshot.status).toBe('loading')
    // Without this the card could only say "loading…" for the life of the tab.
    expect(snapshot.error).toBe('not mounted')
  })

  it('ensureLoaded joins an in-flight read instead of starting a second one', async () => {
    vi.useFakeTimers()
    const { calls } = face({
      get: [() => ({ ok: true, status: 200, body: document('k1', {}) })],
    })
    const scope = new OwnQuotaSettingsScope()
    const pending = scope.load()
    scope.ensureLoaded()
    scope.ensureLoaded()
    await vi.advanceTimersByTimeAsync(0)
    await pending
    expect(calls.filter(call => call.method === 'GET')).toHaveLength(1)
    // Once loaded, another call is a no-op too.
    scope.ensureLoaded()
    await vi.advanceTimersByTimeAsync(0)
    expect(calls.filter(call => call.method === 'GET')).toHaveLength(1)
  })
})
