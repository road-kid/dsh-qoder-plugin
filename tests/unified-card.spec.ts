import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { QoderPluginCard, type QoderPluginCardProps } from '../src/client/QoderPluginCard.tsx'
import { en } from '../src/client/locales.ts'
import type { QoderSettingsKey } from '../src/client/locales.ts'
import { noteQuotaStatus, quotaReadout, resetQuotaSignIn, resetQuotaStatusDocuments, setQuotaReadout } from '../src/client/quota-settings-store.ts'
import { QODER_GLOBAL_STATUS_PATH, QODER_STATUS_PATH, type QoderWebStatus } from '../src/status-paths.ts'

const t = (key: QoderSettingsKey, params: Record<string, unknown> = {}): string =>
  Object.entries(params).reduce(
    (text, [name, value]) => text.replace(`{${name}}`, String(value)),
    en[key] as string,
  )

/**
 * The unified card is the configuration PAGE of the Plugins surface: the owner
 * draws the title/header and the composer chip owns the quota readout, so the
 * card body is a grid of three compact cards (账号 / 模型 / 高级设置) and
 * nothing else. Signed out there are only 账号 and 高级设置 — model
 * preferences need an account to act on.
 */
describe('Unified Qoder Plugin Card', () => {
  let view: ReactTestRenderer | undefined
  const request = vi.fn()
  const postedActions: { url: string; body: unknown }[] = []

  beforeEach(() => {
    postedActions.length = 0
    request.mockReset().mockImplementation(async (url: string, init?: RequestInit) => {
      if (init?.method === 'POST') {
        const body = JSON.parse(String(init.body))
        postedActions.push({ url, body })
        return { ok: true, status: 200, json: async () => ({ ok: true, status: 'saved' }) }
      }
      const path = String(url)
      if (path === QODER_STATUS_PATH) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            status: 'signed-in',
            region: 'china',
            pat: { source: 'card', savedAtMs: 1700000000000, patTail: '1111' },
            authKey: 'cn-auth-key',
            credits: { total: 30, accounts: [] },
            models: [],
          }),
        }
      }
      if (path === QODER_GLOBAL_STATUS_PATH) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ status: 'signed-out', region: 'global', authKey: 'global-auth-key' }),
        }
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
    // The readout switches are a client preference in the shared store, not a
    // field of the settings face; reset them between tests.
    setQuotaReadout(true)
    vi.unstubAllGlobals()
  })

  interface ScopeSeed {
    autoCheckInCN?: boolean
    autoCheckInGlobal?: boolean
    checkInMinute?: number
    quotaPollMs?: number
  }

  function fakeScope(seed: ScopeSeed = {}) {
    return {
      getSnapshot: () => ({
        status: 'ready' as const,
        writable: true,
        value: {
          autoCheckInCN: false,
          autoCheckInGlobal: false,
          checkInMinute: 600,
          quotaPollMs: 300_000,
          ...seed,
        },
      }),
      subscribe: () => () => {},
      set: vi.fn(),
    }
  }

  interface MountOptions {
    scope?: ReturnType<typeof fakeScope>
    /** Omit to let the card derive sign-in from its own reads/store. */
    reported?: { cn: boolean | undefined, global: boolean | undefined }
  }

  async function mountUnified(options: MountOptions = {}): Promise<void> {
    // Replace any instance a case already mounted, so no stale subscription
    // keeps re-rendering behind the next assertion.
    act(() => view?.unmount())
    const props = {
      t: t as QoderPluginCardProps['t'],
      // The card is the Plugins page's configuration PAGE, not a collapsed row:
      // there is no disclosure header to expand.
      view: 'page' as const,
      unified: true,
      scope: (options.scope ?? fakeScope()) as never,
      ...options.reported === undefined ? {} : { signedIn: () => options.reported! },
    } as unknown as Parameters<typeof QoderPluginCard>[0]
    await act(async () => { view = create(createElement(QoderPluginCard, props)) })
  }

  const json = (): string => JSON.stringify(view!.toJSON())
  const titles = (): string[] => view!.root
    .findAll(node => node.props.className === 'qdp-sectionTitle')
    .map(node => node.children.join(''))
  // A card is anything carrying the class, not the exact string: a card is free
  // to carry extra classes beside it.
  const cards = () => view!.root.findAll(node =>
    typeof node.props.className === 'string' && node.props.className.split(' ').includes('qdp-card'))
  const tabButtons = () => {
    const tabList = view!.root.find(node => node.props.role === 'tablist' && node.props['aria-label'] === en.variantSwitcherAria)
    return tabList.findAllByType('button')
  }
  const switchFor = (label: string) =>
    view!.root.findAll(node => node.props.role === 'switch' && node.props['aria-label'] === label)[0]
  const hostParts = (name: string) =>
    view!.root.findAll(node => node.props['data-checkin-part'] === name && typeof node.type === 'string')

  it('draws a four-card configuration page with no hand-rolled chrome', async () => {
    await mountUnified()
    // Root wrapper is the page grid; each section is its own card, and the
    // fourth (高级设置) is an ordinary card whose body follows a switch.
    expect(view!.root.findAll(node => node.props.className === 'qdp-page')).toHaveLength(1)
    expect(cards()).toHaveLength(4)
    // No disclosure element and no second-level header: the switch is a normal
    // control, so nothing on the page can grow chrome of its own.
    expect(view!.root.findAll(node => node.type === 'details')).toHaveLength(0)
    expect(view!.root.findAll(node => node.props.className === 'qdp-cardHeader')).toHaveLength(0)
    expect(json()).not.toContain('aria-expanded')
    // The variant switcher is the ONE level of tabs, and only one is selected.
    expect(view!.root.findAllByProps({ 'aria-selected': true })).toHaveLength(1)
  })

  it('lays the four cards out in contract order — the quota and check-in cards are gone', async () => {
    await mountUnified()
    expect(titles()).toEqual([
      en.accountHeading,
      en.paneModels,
      en.quotaSectionSettings,
      en.quotaSectionAdvanced,
    ])
    // 可用额度 moved to the composer chip: the page must not draw it again.
    expect(json()).not.toContain(en.creditsHeading)
    expect(json()).toContain(en.quotaPollLabel)
  })

  it('labels the variant switcher for assistive tech', async () => {
    await mountUnified()
    const tabs = tabButtons()
    expect(tabs).toHaveLength(2)
    // One selected tab, the other roving-tabIndex'd out of the tab order.
    expect(tabs[0]!.props['aria-selected']).toBe(true)
    expect(tabs[1]!.props['aria-selected']).toBe(false)
    expect(tabs[0]!.props.tabIndex).toBe(0)
    expect(tabs[1]!.props.tabIndex).toBe(-1)
  })

  it('renders only the one-liner when the owner asks for the summary view', async () => {
    await mountUnified()
    await act(async () => {
      view!.update(createElement(QoderPluginCard, {
        t: t as QoderPluginCardProps['t'],
        unified: true,
        view: 'summary',
      } as unknown as Parameters<typeof QoderPluginCard>[0]))
    })
    expect(view!.toJSON()).toBe(en.unifiedIntro)
    const text = json()
    expect(text).not.toContain(en.quotaPollLabel)
    expect(text).not.toContain(en.patHeading)
  })

  it('opens on the China account with its settings scoped to that variant', async () => {
    // The check-in moment is a sub-menu of the automatic check-in switch, so
    // the switch has to be on for the row to exist at all.
    await mountUnified({ scope: fakeScope({ autoCheckInCN: true }) })
    expect(json()).toContain(t('patTail', { tail: '****1111' }))
    // Settings render flat (no fold). The check-in time is ONE control shared
    // by both variants: no per-variant copy exists any more.
    expect(json()).toContain(en.checkInTime)
    expect(json()).not.toContain('签到时间（国内版）')
    expect(json()).not.toContain('签到时间（国际版）')
    expect(json()).toContain(en.checkInTimeHint)
  })

  it('puts the daily check-in above the failover policy', async () => {
    await mountUnified({ scope: fakeScope({ autoCheckInCN: true }) })
    const text = json()
    // Reading the card top to bottom: the once-a-day housekeeping action comes
    // first, the policy that changes how a running conversation is served
    // second. A user looking for "turn check-in on" should not have to scroll
    // past the failover controls to find it.
    expect(text.indexOf(en.paneUsage)).toBeGreaterThan(-1)
    expect(text.indexOf(en.checkInTime)).toBeGreaterThan(-1)
    expect(text.indexOf(en.autoFailoverLabel)).toBeGreaterThan(-1)
    expect(text.indexOf(en.paneUsage)).toBeLessThan(text.indexOf(en.autoFailoverLabel))
    expect(text.indexOf(en.checkInTime)).toBeLessThan(text.indexOf(en.autoFailoverLabel))
  })

  it('switches between China and Global tabs when clicked', async () => {
    await mountUnified()
    await act(async () => { tabButtons()[1]!.props.onClick() })

    // Global is signed out in the mock, so it offers the Global PAT guide.
    let text = json()
    expect(text).toContain(en.signedOutHintAI)
    expect(text).toContain(en.patGuideAI)
    expect(text).not.toContain(t('patTail', { tail: '****1111' }))

    await act(async () => { tabButtons()[0]!.props.onClick() })
    text = json()
    expect(text).toContain(t('patTail', { tail: '****1111' }))
  })

  it('does not carry a pool confirmation from one tab to the other', async () => {
    // The two products keep separate account lists, so an "已切换到备用账号"
    // line belongs to the tab that produced it: painted under Global it would
    // claim a switch that never happened on that account.
    request.mockImplementation(async (url: string, init?: RequestInit) => {
      if (init?.method === 'POST') return { ok: true, status: 200, json: async () => ({ ok: true, status: 'saved' }) }
      if (String(url) === QODER_STATUS_PATH) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            status: 'signed-in',
            region: 'china',
            pat: { source: 'card', savedAtMs: 1700000000000, patTail: '1111' },
            authKey: 'cn-auth-key',
            accounts: {
              autoFailover: true,
              entries: [
                { id: 'pat:main', source: 'card', active: true, order: 1, patTail: '1111' },
                { id: 'pat:spare', accountName: '备用账号', source: 'card', active: false, order: 2, patTail: '2222' },
              ],
            },
            credits: { total: 30, accounts: [] },
            models: [],
          }),
        }
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({ status: 'signed-out', region: 'global', authKey: 'global-auth-key' }),
      }
    })
    await mountUnified()

    const switchButton = view!.root.findAll(node => node.type === 'button' && node.props['aria-label'] === t('accountSwitchAria', { name: '备用账号' }))[0]
    await act(async () => { switchButton!.props.onClick() })
    expect(json()).toContain(t('accountSwitched', { name: '备用账号' }))

    // Global has no pool of its own, so the confirmation has nothing to stand on.
    await act(async () => { tabButtons()[1]!.props.onClick() })
    const text = json()
    expect(text).not.toContain(t('accountSwitched', { name: '备用账号' }))
    expect(text).not.toContain('pat:spare')
  })

  it('reactively enables the auto-check-in switch when a PAT turns the account signed-in', async () => {
    let cnSignedIn = false
    request.mockImplementation(async (url: string, init?: RequestInit) => {
      if (init?.method === 'POST') {
        const body = JSON.parse(String(init.body))
        postedActions.push({ url, body })
        if (body.action === 'save-pat') cnSignedIn = true
        return { ok: true, status: 200, json: async () => ({ ok: true, status: 'saved' }) }
      }
      if (String(url) === QODER_STATUS_PATH) {
        return {
          ok: true,
          status: 200,
          json: async () => cnSignedIn
            ? {
                status: 'signed-in',
                region: 'china',
                pat: { source: 'card', savedAtMs: 1700000000000, patTail: '2222' },
                authKey: 'cn-auth-key',
                credits: { total: 50, accounts: [] },
                models: [],
              }
            : { status: 'signed-out', region: 'china', authKey: 'cn-auth-key' },
        }
      }
      return { ok: true, status: 200, json: async () => ({ status: 'signed-out', authKey: 'global-auth-key' }) }
    })
    await mountUnified()
    // Sign-in is derived from the store/read path, not the `signedIn` prop, so
    // this pinned the reactive wiring that used to leave the switch dead.
    expect(switchFor(en.paneUsage)!.props.disabled).toBe(true)

    const patInput = view!.root.find(node => node.type === 'input' && node.props.type === 'password')
    await act(async () => { patInput.props.onChange({ target: { value: 'test-pat-token' } }) })
    const saveBtn = view!.root.findAll(node => node.type === 'button' && node.props.children === en.patSave)[0]!
    await act(async () => { await saveBtn.props.onClick() })
    expect(switchFor(en.paneUsage)!.props.disabled).toBe(false)
  })

  it('disables the auto-check-in switch when unsigned and drops a forced write', async () => {
    request.mockImplementation(async () => ({ ok: true, status: 200, json: async () => ({ status: 'signed-out' }) }))
    const scope = fakeScope()
    await mountUnified({ scope, reported: { cn: false, global: false } })

    // Signed out: only 账号 + 设置 + 高级设置 are mounted.
    expect(cards()).toHaveLength(3)
    expect(titles()).toEqual([en.accountHeading, en.quotaSectionSettings, en.quotaSectionAdvanced])

    // The readout switch is configuration, not account state: the signed-out
    // page keeps it and it reflects the stored (default-on) value.
    expect(switchFor(en.quotaReadoutEnabledLabel)!.props['aria-checked']).toBe(true)

    const toggle = switchFor(en.paneUsage)!
    expect(toggle.props.disabled).toBe(true)
    // Defensive: even a programmatic click must not arm a timer for an account
    // nobody is signed into.
    await act(async () => { toggle.props.onClick() })
    expect(scope.set).not.toHaveBeenCalled()
  })

  it('writes the refresh interval from the advanced card body, immediately', async () => {
    const scope = fakeScope()
    await mountUnified({ scope })
    const poll = view!.root.findAll(node => node.type === 'input' && node.props['aria-label'] === en.quotaPollLabel)[0]!
    expect(poll.props.value).toBe('5') // 300_000 ms renders as five minutes
    // A draft until committed: writing per keystroke is what made the field
    // impossible to retype.
    await act(async () => { poll.props.onChange({ target: { value: '7' } }) })
    expect(scope.set).not.toHaveBeenCalled()
    await act(async () => { poll.props.onBlur() })
    expect(scope.set).toHaveBeenCalledWith('quotaPollMs', 420_000)
  })

  it('writes the single readout switch to the client store', async () => {
    setQuotaReadout(false)
    const scope = fakeScope()
    await mountUnified({ scope })
    expect(switchFor(en.quotaReadoutEnabledLabel)!.props['aria-checked']).toBe(false)
    // The write goes to the shared client store — the shipped host rejects the
    // field on its settings face — so the settings scope is never touched.
    await act(async () => { switchFor(en.quotaReadoutEnabledLabel)!.props.onClick() })
    expect(quotaReadout().enabled).toBe(true)
    expect(scope.set).not.toHaveBeenCalled()
  })

  // ── check-in card fixtures (status read held by the test) ─────────────────

  const CHECK_IN_MODELS: unknown[] = []

  async function mountWithStatus(body: unknown): Promise<void> {
    request.mockImplementation(async (url: string, init?: RequestInit) => {
      if (init?.method === 'POST') {
        postedActions.push({ url: String(url), body: JSON.parse(String(init.body)) })
        return { ok: true, status: 200, json: async () => ({ ok: true, status: 'saved' }) }
      }
      if (String(url) === QODER_STATUS_PATH) return { ok: true, status: 200, json: async () => body }
      return { ok: true, status: 200, json: async () => ({ status: 'signed-out' }) }
    })
    await mountUnified()
  }

  function signedInDoc(checkIn: Record<string, unknown>): Record<string, unknown> {
    return {
      status: 'signed-in',
      region: 'china',
      pat: { source: 'card', savedAtMs: 1700000000000, patTail: '1111' },
      authKey: 'cn-auth-key',
      credits: { total: 30, accounts: [] },
      models: CHECK_IN_MODELS,
      checkIn,
    }
  }

  it('renders the account strip with the claimed tag and no ledger rows', async () => {
    await mountWithStatus(signedInDoc({
      lastDate: '2026-09-21',
      // `today` is pinned in the fixture rather than read from the clock.
      today: '2026-09-21',
      lastAt: 1700000000000,
      status: 'claimed',
      amount: 100,
    }))
    // The ledger is gone entirely: the strip carries the state instead.
    expect(view!.root.findAll(node => node.props.className === 'qdp-logRow')).toHaveLength(0)
    expect(json()).toContain(en.checkInClaimedToday)
    // The batched claim stays reachable even on a claimed day.
    expect(json()).toContain(en.checkInAll)
  })

  it('treats an upstream already-claimed day as claimed', async () => {
    await mountWithStatus(signedInDoc({
      lastDate: '2026-09-21',
      today: '2026-09-21',
      lastAt: 1700003600000,
      status: 'already-claimed',
      amount: 100,
    }))
    expect(json()).toContain(en.checkInClaimedToday)
  })

  it('re-offers the claim when the stored record is from an earlier day', async () => {
    await mountWithStatus(signedInDoc({
      lastDate: '2026-09-27',
      // The record stops three days back; today is later, so nothing is claimed.
      today: '2026-09-30',
      lastAt: 1790502156407,
      status: 'claimed',
      amount: 100,
    }))
    expect(json()).not.toContain(en.checkInClaimedToday)
    expect(json()).toContain(en.checkInAll)
  })

  it('treats a same-day failed attempt as retryable, not as claimed', async () => {
    await mountWithStatus(signedInDoc({
      lastDate: '2026-09-30',
      today: '2026-09-30',
      lastAt: 1790600000000,
      status: 'no-campaign',
      message: 'No claimable benefit campaign found for this region',
    }))
    expect(json()).not.toContain(en.checkInClaimedToday)
    expect(json()).toContain(en.checkInAll)
  })

  it('stores a typed check-in time as minutes past midnight in UTC+8', async () => {
    const scope = fakeScope({ autoCheckInCN: true, checkInMinute: 600 })
    await mountUnified({ scope, reported: { cn: true, global: false } })
    // ONE shared row for both variants, so there is exactly one hours and one
    // minutes field. data-checkin-part is on both the composite and the host
    // input; count only host nodes (typeof type === 'string').
    expect(hostParts('hour')).toHaveLength(1)
    expect(hostParts('minute')).toHaveLength(1)
    expect(view!.root.findAll(node => node.props.type === 'time')).toHaveLength(0)
    const part = (name: string) => hostParts(name)[0]!
    // The stored shared minute count renders as 10:00.
    expect(part('hour').props.value).toBe('10')
    expect(part('minute').props.value).toBe('00')

    await act(async () => { part('hour').props.onChange({ target: { value: '14' } }) })
    await act(async () => { part('minute').props.onChange({ target: { value: '30' } }) })
    // Nothing persists mid-typing; the blur commits the pair to the ONE shared
    // field the host scheduler reads for both variants.
    expect(scope.set).not.toHaveBeenCalled()
    await act(async () => { part('hour').props.onBlur() })
    expect(scope.set).toHaveBeenCalledWith('checkInMinute', 870)

    // The row follows the switch ON SCREEN: the Global tab's own check-in
    // switch is off in this seed, so switching there closes the row. The
    // shared moment is not re-scoped — it is simply not editable from a tab
    // whose own check-in is off.
    await act(async () => { tabButtons()[1]!.props.onClick() })
    expect(hostParts('hour')).toHaveLength(0)
    // Back on the China tab the one shared row returns, reading the shared
    // field: the fake scope records writes without applying them, so it shows
    // the stored 10:00 — the row holds no per-tab state of its own.
    await act(async () => { tabButtons()[0]!.props.onClick() })
    expect(hostParts('hour')[0]!.props.value).toBe('10')
  })

  // ---- stale-while-revalidate: instant paint, background truth -------------

  /** A status body shaped like the host's, for seeding the shared store. */
  const doc = (patTail: string, region: 'china' | 'global'): QoderWebStatus => ({
    status: 'signed-in',
    region,
    authKey: region === 'china' ? 'cn-auth-key' : 'global-auth-key',
    pat: { source: 'card', patTail },
  } as unknown as QoderWebStatus)

  it('paints the document it already has and revalidates it in the background', async () => {
    noteQuotaStatus('qoder', doc('cached', 'china'))
    let release: () => void = () => {}
    const held = new Promise<void>(resolve => { release = resolve })
    request.mockImplementation(async (_url: string, init?: RequestInit) => {
      if (init?.method === 'POST') return { ok: true, status: 200, json: async () => ({ ok: true, status: 'saved' }) }
      await held
      return { ok: true, status: 200, json: async () => doc('fresh', 'china') }
    })

    await mountUnified()
    // The cached account is on screen at once — no spinner, no blank document.
    expect(json()).toContain(t('patTail', { tail: '****cached' }))
    expect(json()).not.toContain(en.loading)
    // The cache is a head start, not a freeze: the mount read was still issued.
    expect(request.mock.calls.filter(call => call[0] === QODER_STATUS_PATH)).toHaveLength(1)

    await act(async () => {
      release()
      await new Promise(resolve => setTimeout(resolve, 0))
    })
    expect(json()).toContain(t('patTail', { tail: '****fresh' }))
    expect(json()).not.toContain(t('patTail', { tail: '****cached' }))
  })

  it('prefetches the other variant so its tab opens on an account, not a spinner', async () => {
    let globalReads = 0
    request.mockImplementation(async (url: string, init?: RequestInit) => {
      if (init?.method === 'POST') return { ok: true, status: 200, json: async () => ({ ok: true, status: 'saved' }) }
      if (String(url) === QODER_GLOBAL_STATUS_PATH) {
        globalReads += 1
        // First answer is the prefetch; the tab's own revalidation never lands,
        // so anything on screen after the switch came from the cache.
        return globalReads === 1
          ? { ok: true, status: 200, json: async () => doc('7777', 'global') }
          : { ok: true, status: 200, json: () => new Promise(() => {}) }
      }
      return { ok: true, status: 200, json: async () => doc('1111', 'china') }
    })

    await mountUnified()
    // Mount reads the active variant AND warms the sibling.
    expect(globalReads).toBe(1)

    await act(async () => { tabButtons()[1]!.props.onClick() })
    expect(json()).toContain(t('patTail', { tail: '****7777' }))
    expect(json()).not.toContain(en.loading)
    // The switch revalidated in the background; it did not blank the tab first.
    expect(globalReads).toBe(2)
  })

  it('shows an unknown variant as in progress instead of a grey signed-out dot', async () => {
    await mountUnified({ reported: { cn: true, global: undefined } })
    const tabDot = (index: number) => tabButtons()[index]!
      .findAll(node => typeof node.type === 'string' && String(node.props.className ?? '').startsWith('qdp-dot'))
      .map(node => String(node.props.className))
      .join(' ')
    // Known signed-in: the solid dot.
    expect(tabDot(0)).toContain('qdp-dotDone')
    // Never read: the spinner, NOT the idle grey that claimed "signed out".
    expect(tabDot(1)).toContain('qdp-dotOngoing')
    expect(tabDot(1)).not.toContain('qdp-dotDone')
  })

  it('keeps the last good document when a revalidation fails', async () => {
    noteQuotaStatus('qoder', doc('kept', 'china'))
    request.mockImplementation(async (_url: string, init?: RequestInit) => {
      if (init?.method === 'POST') return { ok: true, status: 200, json: async () => ({ ok: true, status: 'saved' }) }
      throw new Error('network down')
    })
    await mountUnified()
    expect(json()).toContain(t('patTail', { tail: '****kept' }))
    // The failure is reported without replacing the account body with an error.
    expect(json()).toContain(t('statusRefreshFailed', { message: 'network down' }))
  })
})
