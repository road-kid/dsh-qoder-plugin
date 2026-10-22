/**
 * Composer quota panel: the stored-account pool (m01197).
 *
 * The user's requirement is that 对话框的积分显示界面 shows EVERY saved account —
 * 「点击用户名切换账号」 — so this suite pins the three things that make the pool
 * safe rather than merely present:
 *
 * - each row carries its OWN plan and credits, so a spare account is priced
 *   before the user moves to it;
 * - the collapsed chip still speaks only for the ACTIVE account, so a spare's
 *   figure can never become the headline (requirement 4);
 * - the row is still a switch when its billing read failed, because an account
 *   whose price is unknown is exactly the one a user may need to move to.
 *
 * The env-only credential — no pool at all — must render the single-variant row
 * it always did, so both "absent" and "empty" are pinned here too.
 *
 * Order awareness: `quota-settings-store` has no reset entry point, so each test
 * notes its own fixture before mounting (this also makes the mount read a
 * no-op: a just-noted document is fresh). The switch's re-read is FORCED, which
 * is why it still hits the stub and is asserted through `request`.
 *
 * Node environment: no DOM, no window; `fetch` is a global stub.
 *
 * @module dsh-qoder-plugin/test/client-quota-accounts.spec
 */

import { createElement } from 'react'
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ComposerQuotaChip, type ComposerQuotaInjected } from '../src/client/ComposerQuota.tsx'
import { en } from '../src/client/locales.ts'
import { noteQuotaStatus, resetQuotaSignIn, resetQuotaStatusDocuments, setQuotaReadout } from '../src/client/quota-settings-store.ts'
import {
  QODER_AUTH_PATH,
  QODER_STATUS_PATH,
  type QoderAccountSummary,
  type QoderWebCredits,
  type QoderWebStatus,
} from '../src/status-paths.ts'

/** Translator stub over the English table (same helper the sibling spec uses). */
const t = ((key: string, params: Record<string, unknown> = {}) => (
  Object.entries(params).reduce<string>(
    (text, [name, value]) => text.replace(`{${name}}`, String(value)),
    en[key as keyof typeof en] as string,
  )
)) as ComposerQuotaInjected['t']

/** Locale formatting must match the component's `formatNumber`, not a literal. */
const number = (value: number): string => new Intl.NumberFormat(undefined).format(value)

/** `t('exactRemaining', …)` — the `remaining / size` figure every priced row shows. */
const remaining = (remain: number, size: number): string => (
  en.exactRemaining.replace('{remain}', number(remain)).replace('{size}', number(size))
)

/** The accessible name of one account's switch control. */
const switchLabel = (name: string): string => en.accountSwitchAria.replace('{name}', name)

/** One countable package. */
function credits(remain: number, size: number, packageName: string): QoderWebCredits {
  return { total: 0, totalSize: size, accounts: [{ packageName, remain, size }] }
}

/** A pool of two named accounts, with `activeId`'s seat in use. */
function poolEntries(activeId: string): QoderAccountSummary[] {
  return [
    {
      id: 'acct-primary',
      accountName: 'Yao Lin',
      patTail: 'a1b2',
      source: 'card',
      active: activeId === 'acct-primary',
      order: 1,
      plan: { planTierName: 'Pro' },
      credits: credits(1200, 1200, 'Pro'),
    },
    {
      id: 'acct-spare',
      accountName: 'Backup Seat',
      patTail: 'c3d4',
      source: 'card',
      active: activeId === 'acct-spare',
      order: 2,
      plan: { planTierName: 'Team' },
      credits: credits(9999, 10000, 'Team'),
    },
  ]
}

/**
 * The two-account pool document.
 *
 * The spare's 9,999 is deliberately unlike the active seat's 1,200: it is the
 * marker a leaked headline would show, so one assertion can catch it.
 */
function poolStatus(activeId: string): QoderWebStatus {
  const active = activeId === 'acct-spare'
  return {
    status: 'signed-in',
    authKey: 'probe-key',
    plan: { planTierName: active ? 'Team' : 'Pro' },
    credits: active ? credits(9999, 10000, 'Team') : credits(1200, 1200, 'Pro'),
    accounts: { entries: poolEntries(activeId), autoFailover: true },
  }
}

/** The env-only credential: signed in, priced, and no stored pool at all. */
const ENV_ONLY_STATUS: QoderWebStatus = {
  status: 'signed-in',
  plan: { planTierName: 'Pro' },
  credits: credits(1200, 1200, 'Pro'),
}

/** A pool the host reported but with nothing stored (env credential). */
const EMPTY_POOL_STATUS: QoderWebStatus = {
  status: 'signed-in',
  authKey: 'probe-key',
  plan: { planTierName: 'Pro' },
  credits: credits(1200, 1200, 'Pro'),
  accounts: { entries: [], autoFailover: false },
}

/**
 * An unlimited active seat plus a countable spare.
 *
 * Both halves carry the unlimited shape for the ACTIVE account (the host prices
 * each stored credential itself), which is the case that must still read
 * "Unlimited" rather than falling back to a neighbour's number.
 */
const UNLIMITED_ACTIVE_STATUS: QoderWebStatus = {
  status: 'signed-in',
  authKey: 'probe-key',
  plan: { planTierName: 'Pro' },
  credits: {
    total: 0,
    unlimited: true,
    accounts: [{ packageName: 'Pro', remain: 0, size: 0, unlimited: true }],
  },
  accounts: {
    entries: [
      {
        id: 'acct-primary',
        accountName: 'Yao Lin',
        source: 'card',
        active: true,
        order: 1,
        plan: { planTierName: 'Pro' },
        credits: {
          total: 0,
          unlimited: true,
          accounts: [{ packageName: 'Pro', remain: 0, size: 0, unlimited: true }],
        },
      },
      {
        id: 'acct-spare',
        accountName: 'Backup Seat',
        source: 'card',
        active: false,
        order: 2,
        plan: { planTierName: 'Team' },
        credits: credits(9999, 10000, 'Team'),
      },
    ],
    autoFailover: true,
  },
}

/** The document the stub status route currently serves; tests swap it. */
let served: QoderWebStatus = poolStatus('acct-primary')

/** Build a fetch result carrying `body`. */
function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response
}

/** The auth route's answer; refusal/transport tests replace it. */
let authAnswer: () => Promise<Response> = async () => jsonResponse({ ok: true })

/** Fetch stub; the status route serves `served`, every other path is the auth route. */
const request = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit): Promise<Response> => (
  String(input) === QODER_STATUS_PATH ? jsonResponse(served) : authAnswer()
))

/** Build the smallest model-directory store the chip consumes. */
function createDirectory(provider: string): ComposerQuotaInjected['directory'] {
  const listeners = new Set<() => void>()
  const state = {
    current: { provider, model: 'qoder-pro' },
    status: 'ready',
    groups: [],
    failures: [],
    error: null,
    routable: true,
  }
  return {
    getSnapshot: () => state,
    subscribe: (listener: () => void) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
  } as unknown as ComposerQuotaInjected['directory']
}

let view: ReactTestRenderer | null = null

/** The mounted renderer; throws instead of asserting non-null. */
function currentView(): ReactTestRenderer {
  if (view === null) throw new Error('the chip is not mounted')
  return view
}

/** Publish `document` for the CN variant, then mount the chip on `qoder`. */
async function mountWith(document: QoderWebStatus): Promise<void> {
  served = document
  noteQuotaStatus('qoder', document)
  const directory = createDirectory('qoder')
  await act(async () => {
    view = create(createElement(ComposerQuotaChip, { directory, t }))
  })
}

/** Flush the promise chains a click can start (write, re-read, publish, render). */
async function flush(): Promise<void> {
  await act(async () => {
    for (let tick = 0; tick < 8; tick += 1) await Promise.resolve()
  })
}

/** Host instances carrying one exact `qdp-*` class, under `root` if given. */
function hostsByClass(className: string, root?: ReactTestInstance): ReactTestInstance[] {
  const scope = root ?? currentView().root
  return scope.findAll(node => (
    typeof node.type === 'string' && String(node.props.className ?? '').split(/\s+/).includes(className)
  ))
}

/** The one host instance carrying `className`; throws when absent. */
function single(className: string, root?: ReactTestInstance): ReactTestInstance {
  const found = hostsByClass(className, root)[0]
  if (found === undefined) throw new Error(`no element with class ${className}`)
  return found
}

/** Host buttons with the given accessible name. */
function buttonsByLabel(label: string): ReactTestInstance[] {
  return currentView().root.findAll(node => node.type === 'button' && node.props['aria-label'] === label)
}

/** Concatenated text of one rendered subtree (host strings only). */
function textOf(instance: ReactTestInstance): string {
  const parts: string[] = []
  const walk = (node: ReactTestInstance | string): void => {
    if (typeof node === 'string') {
      parts.push(node)
      return
    }
    for (const child of node.children) walk(child)
  }
  walk(instance)
  return parts.join('')
}

/** The serialized tree, for class/text assertions. */
function treeText(): string {
  return JSON.stringify(currentView().toJSON())
}

/** The chip's rendered text (name, separator, readout). */
function chipText(): string {
  return textOf(single('qdp-chip'))
}

/** Click the chip to open the panel. */
async function open(): Promise<void> {
  await act(async () => {
    single('qdp-chip').props.onClick()
    await Promise.resolve()
  })
  await flush()
}

/** Every path the component has requested so far. */
function requestedPaths(): string[] {
  return request.mock.calls.map(call => String(call[0]))
}

/** The one POST the panel made, if any. */
function postCall() {
  return request.mock.calls.find(call => call[1]?.method === 'POST')
}

beforeEach(() => {
  served = poolStatus('acct-primary')
  authAnswer = async () => jsonResponse({ ok: true })
  request.mockReset()
  request.mockImplementation(async (input: RequestInfo | URL): Promise<Response> => (
    String(input) === QODER_STATUS_PATH ? jsonResponse(served) : authAnswer()
  ))
  vi.stubGlobal('fetch', request)
  view = null
})

afterEach(() => {
  act(() => {
    view?.unmount()
  })
  view = null
  setQuotaReadout(true)
  resetQuotaStatusDocuments()
  resetQuotaSignIn()
  vi.unstubAllGlobals()
})

describe('composer quota account pool', () => {
  it('prices every stored account in its own row and marks the seat in use', async () => {
    await mountWith(poolStatus('acct-primary'))
    await open()

    const rows = hostsByClass('qdp-popAccount')
    expect(rows).toHaveLength(2)
    expect(hostsByClass('qdp-popAccounts')).toHaveLength(1)
    expect(treeText()).toContain(en.accountsHeading)

    const activeRow = single('qdp-popAccountActive')
    expect(textOf(activeRow)).toContain('Yao Lin')
    expect(textOf(activeRow)).toContain(en.accountCurrent)
    expect(textOf(activeRow)).toContain('Pro')
    expect(textOf(activeRow)).toContain(remaining(1200, 1200))
    expect(textOf(activeRow)).not.toContain(number(9999))

    // The pool REPLACES the single-variant row: the active account's numbers
    // appear once, not twice.
    expect(hostsByClass('qdp-popVariant')).toHaveLength(0)

    const spareRow = rows.find(row => textOf(row).includes('Backup Seat'))
    expect(spareRow).toBeDefined()
    if (spareRow === undefined) return
    expect(textOf(spareRow)).toContain('Team')
    expect(textOf(spareRow)).toContain(remaining(9999, 10000))
    // Every priced row draws its own bar.
    expect(hostsByClass('qdp-popBar', spareRow)).toHaveLength(1)
  })

  it('offers the username as the switch only on rows that are not in use', async () => {
    await mountWith(poolStatus('acct-primary'))
    await open()

    // The active seat's name is text: clicking it would be a no-op.
    expect(buttonsByLabel(switchLabel('Yao Lin'))).toHaveLength(0)
    expect(hostsByClass('qdp-popAccountSwitch', single('qdp-popAccountActive'))).toHaveLength(0)
    expect(single('qdp-popAccountActive').props['data-account-id']).toBe('acct-primary')

    const spareSwitch = buttonsByLabel(switchLabel('Backup Seat'))
    expect(spareSwitch).toHaveLength(1)
    expect(spareSwitch[0]?.props.disabled).toBe(false)
    expect(single('qdp-popAccountSwitch').props.type).toBe('button')
    // The name IS the control, so the panel says so once above the rows.
    expect(textOf(single('qdp-popAccountsHead'))).toContain(en.accountsSwitchHint)
  })

  it('never lets a spare account figures reach the chip headline', async () => {
    await mountWith(poolStatus('acct-primary'))
    await flush()

    expect(chipText()).toContain(number(1200))
    expect(chipText()).not.toContain(number(9999))
    expect(chipText()).not.toContain(en.quotaUnlimited)
  })

  it('keeps "Unlimited" for an active seat that has nothing countable', async () => {
    // The spare is countable here; the active seat is the one that decides, so
    // the chip must not fall back to a neighbour's number.
    await mountWith(UNLIMITED_ACTIVE_STATUS)
    await flush()

    expect(chipText()).toContain(en.quotaUnlimited)
    expect(chipText()).not.toContain(number(9999))
    // The panel agrees: the active row reads Unlimited, the spare keeps its figure.
    await open()
    expect(textOf(single('qdp-popAccountActive'))).toContain(en.quotaUnlimited)
    expect(textOf(single('qdp-popAccountActive'))).not.toContain(number(9999))
  })

  it('posts the switch to the auth route and re-reads the document to move the marker', async () => {
    await mountWith(poolStatus('acct-primary'))
    await open()

    served = poolStatus('acct-spare')
    await act(async () => {
      const button = buttonsByLabel(switchLabel('Backup Seat'))[0]
      if (button === undefined) throw new Error('no switch for the spare account')
      button.props.onClick()
      await Promise.resolve()
    })
    await flush()

    const post = postCall()
    expect(post).toBeDefined()
    if (post === undefined) return
    expect(String(post[0])).toBe(QODER_AUTH_PATH)
    expect(post[1]?.method).toBe('POST')
    expect(post[1]?.credentials).toBe('same-origin')
    expect(post[1]?.headers).toEqual({
      'Content-Type': 'application/json',
      'X-Qoder-Auth-Key': 'probe-key',
    })
    expect(JSON.parse(String(post[1]?.body))).toEqual({
      action: 'activate-account',
      accountId: 'acct-spare',
    })

    // The write's own answer says nothing about the new seat: the FORCED
    // re-read is what moves the marker and the chip together.
    expect(requestedPaths().filter(path => path === QODER_STATUS_PATH).length).toBeGreaterThanOrEqual(1)
    expect(treeText()).toContain(en.accountSwitched.replace('{name}', 'Backup Seat'))
    expect(textOf(single('qdp-popAccountActive'))).toContain('Backup Seat')
    expect(buttonsByLabel(switchLabel('Yao Lin'))).toHaveLength(1)
    expect(chipText()).toContain(number(9999))
    expect(chipText()).not.toContain(number(1200))
  })

  it('keeps an account whose billing read failed visible, switchable and unpriced', async () => {
    const withBroken: QoderWebStatus = {
      status: 'signed-in',
      authKey: 'probe-key',
      plan: { planTierName: 'Pro' },
      credits: credits(1200, 1200, 'Pro'),
      accounts: {
        entries: [
          ...poolEntries('acct-primary'),
          {
            id: 'acct-broken',
            accountName: 'Broken Seat',
            source: 'card',
            active: false,
            order: 3,
            creditsError: 'HTTP 503',
          },
        ],
        autoFailover: true,
      },
    }
    await mountWith(withBroken)
    await open()

    const rows = hostsByClass('qdp-popAccount')
    expect(rows).toHaveLength(3)
    const broken = rows.find(row => textOf(row).includes('Broken Seat'))
    expect(broken).toBeDefined()
    if (broken === undefined) return

    // Name + unavailable marker, no bar and no invented figure...
    expect(textOf(broken)).toContain(en.quotaError)
    expect(textOf(broken)).toContain('—')
    expect(hostsByClass('qdp-popBar', broken)).toHaveLength(0)
    expect(hostsByClass('qdp-popAccountUnavailable', broken)).toHaveLength(1)
    // ...and still the switch: the account the price is missing for is exactly
    // the one the user may need to move to.
    expect(buttonsByLabel(switchLabel('Broken Seat'))).toHaveLength(1)
  })

  it('reports a refused switch and still re-reads the pool', async () => {
    await mountWith(poolStatus('acct-primary'))
    await open()

    authAnswer = async () => jsonResponse({ ok: false, error: 'unknown account' })
    await act(async () => {
      const button = buttonsByLabel(switchLabel('Backup Seat'))[0]
      if (button === undefined) throw new Error('no switch for the spare account')
      button.props.onClick()
      await Promise.resolve()
    })
    await flush()

    expect(treeText()).toContain(en.accountActionFailed.replace('{message}', 'unknown account'))
    // A refused id can mean another surface changed the pool: re-read anyway.
    expect(requestedPaths().filter(path => path === QODER_STATUS_PATH).length).toBeGreaterThanOrEqual(1)
    // The verdict did not move the seat.
    expect(textOf(single('qdp-popAccountActive'))).toContain('Yao Lin')
  })

  it('reports a transport failure with the generic message', async () => {
    await mountWith(poolStatus('acct-primary'))
    await open()

    authAnswer = async () => {
      throw new Error('boom')
    }
    await act(async () => {
      const button = buttonsByLabel(switchLabel('Backup Seat'))[0]
      if (button === undefined) throw new Error('no switch for the spare account')
      button.props.onClick()
      await Promise.resolve()
    })
    await flush()

    expect(treeText()).toContain(en.accountActionFailed.replace('{message}', 'boom'))
  })

  it('shows names without a switch when the document carries no auth key', async () => {
    // An older host, or an error document: the rows are still readable, but a
    // control that cannot work is not offered.
    const noKey: QoderWebStatus = {
      status: 'signed-in',
      plan: { planTierName: 'Pro' },
      credits: credits(1200, 1200, 'Pro'),
      accounts: { entries: poolEntries('acct-primary'), autoFailover: true },
    }
    await mountWith(noKey)
    await open()

    expect(hostsByClass('qdp-popAccount')).toHaveLength(2)
    expect(buttonsByLabel(switchLabel('Backup Seat'))).toHaveLength(0)
    expect(textOf(single('qdp-popAccountActive'))).toContain(en.accountCurrent)
    // No key means no switch, so the panel must not promise one.
    expect(textOf(single('qdp-popAccountsHead'))).not.toContain(en.accountsSwitchHint)
  })

  it('falls back to the token tail, then to the saved slot, for unnamed accounts', async () => {
    const unnamed: QoderWebStatus = {
      status: 'signed-in',
      authKey: 'probe-key',
      plan: { planTierName: 'Pro' },
      credits: credits(1200, 1200, 'Pro'),
      accounts: {
        entries: [
          {
            id: 'acct-primary',
            accountName: 'Yao Lin',
            source: 'card',
            active: true,
            order: 1,
            plan: { planTierName: 'Pro' },
            credits: credits(1200, 1200, 'Pro'),
          },
          {
            id: 'acct-tail',
            patTail: 'c3d4',
            source: 'card',
            active: false,
            order: 2,
            credits: credits(10, 100, 'Tail'),
          },
          {
            id: 'acct-anon',
            source: 'env',
            active: false,
            order: 4,
            credits: credits(20, 100, 'Anon'),
          },
        ],
        autoFailover: true,
      },
    }
    await mountWith(unnamed)
    await open()

    expect(buttonsByLabel(switchLabel('c3d4'))).toHaveLength(1)
    expect(buttonsByLabel(switchLabel(en.accountSlot.replace('{order}', '4')))).toHaveLength(1)
  })

  it('renders the single-variant row when the document has no pool', async () => {
    await mountWith(ENV_ONLY_STATUS)
    await open()

    expect(hostsByClass('qdp-popVariant')).toHaveLength(1)
    expect(hostsByClass('qdp-popAccount')).toHaveLength(0)
    expect(hostsByClass('qdp-popAccounts')).toHaveLength(0)
    expect(textOf(single('qdp-popVariant'))).toContain(en.quotaChipCN)
    expect(textOf(single('qdp-popVariant'))).toContain(remaining(1200, 1200))
  })

  it('renders the single-variant row when the pool is empty', async () => {
    await mountWith(EMPTY_POOL_STATUS)
    await open()

    expect(hostsByClass('qdp-popVariant')).toHaveLength(1)
    expect(hostsByClass('qdp-popAccount')).toHaveLength(0)
    expect(textOf(single('qdp-popVariant'))).toContain(remaining(1200, 1200))
  })
})
