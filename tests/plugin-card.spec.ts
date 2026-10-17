import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  QODER_CN_CARD,
  QODER_GLOBAL_CARD,
  QoderPluginCard,
  type QoderCardVariant,
} from '../src/client/QoderPluginCard.tsx'
import { ModelsPane } from '../src/client/ModelsPane.tsx'
import { en } from '../src/client/locales.ts'
import { quotaReadout, setQuotaReadout } from '../src/client/quota-settings-store.ts'

/**
 * Card tests for the compact settings page.
 *
 * The page is four cards (账号 / 签到 / 模型 / 高级设置), and the card owns three
 * sensitive write paths: the PAT entry (what it sends and which header
 * authorizes it), the check-in claim, and the models pane's BATCHED save (one
 * refresh for the whole change set, never one per toggle). A signed-out account
 * gets only 账号 + 高级设置 — check-in and model preferences for an account
 * nobody is signed into would be settings that cannot be exercised yet.
 */

const t = (key: keyof typeof en, params: Record<string, unknown> = {}): string =>
  Object.entries(params).reduce(
    (text, [name, value]) => text.replace(`{${name}}`, String(value)),
    en[key] as string,
  )

interface Posted {
  url: string
  init: RequestInit
}

/** Model fixture whose declared stops make a window override possible. */
const MODELS = [
  { id: 'm1', name: 'M1', contextWindow: 200_000, defaultContextWindow: 200_000, supportedContextWindows: [200_000, 1_000_000] },
  { id: 'm2', name: 'M2', contextWindow: 128_000, defaultContextWindow: 128_000 },
]

describe('Qoder plugin card', () => {
  let view: ReactTestRenderer | undefined
  let statusBody: unknown
  let statusFails = false
  const posts: Posted[] = []
  /** Resolvers for held POSTs, so "in flight" is observable, not a race. */
  let releaseQueue: ((body: unknown) => void)[] = []
  let holdPosts = false
  const intervalHandles = new Map<number, () => void>()
  let nextHandle = 1
  /** Count of status GETs, so "exactly one re-read" is assertable. */
  let reads = 0
  /**
   * The host's answer to a model probe write. The route reports a failed write
   * as HTTP 200 with `{state:'failed', reason}` — the shape the card used to
   * ignore.
   */
  let writeReply: unknown = { state: 'updated' }
  /** The host's answer to 「刷新模型」 (`refresh` action). */
  let refreshReply: unknown = { state: 'refreshed', reason: '12 models' }

  function signedIn(overrides: Record<string, unknown> = {}): void {
    statusBody = {
      status: 'signed-in',
      pat: { source: 'card', savedAtMs: 1_700_000_000_000, patTail: 'abcd' },
      credits: { total: 40, totalSize: 100, accounts: [] },
      probeKey: 'test-probe-key',
      authKey: 'test-auth-key',
      probe: { consent: true, running: false, candidates: ['hy3', 'glm-5.2'], results: [] },
      ...overrides,
    }
  }

  function signedOut(overrides: Record<string, unknown> = {}): void {
    statusBody = { status: 'signed-out', authKey: 'test-auth-key', ...overrides }
  }

  beforeEach(() => {
    signedIn()
    statusFails = false
    holdPosts = false
    posts.length = 0
    releaseQueue = []
    intervalHandles.clear()
    reads = 0
    writeReply = { state: 'updated' }
    refreshReply = { state: 'refreshed', reason: '12 models' }
    vi.stubGlobal('fetch', vi.fn(async (input: unknown, init?: RequestInit) => {
      if (init?.method === 'POST') {
        const url = String(input)
        posts.push({ url, init })
        const body = await new Promise<unknown>(resolve => {
          if (holdPosts) releaseQueue.push(resolve)
          else resolve(postReply(url, init))
        })
        return { ok: true, status: 200, json: async () => body }
      }
      reads += 1
      if (statusFails) throw new Error('socket died')
      return { ok: true, status: 200, json: async () => statusBody }
    }))
    vi.stubGlobal('window', {
      setInterval: (handler: () => void) => {
        const handle = nextHandle++
        intervalHandles.set(handle, handler)
        return handle
      },
      clearInterval: (handle: number) => { intervalHandles.delete(handle) },
    })
    vi.stubGlobal('requestAnimationFrame', (cb: (time: number) => void) => cb(0))
  })

  /** The host answer a POST earns by its body, per the real route contract. */
  function postReply(_url: string, init: RequestInit): unknown {
    const action = JSON.parse(String(init.body)) as { action?: string }
    if (action.action === 'save-pat') return { ok: true, status: 'saved' }
    if (action.action === 'clear') return { ok: true }
    if (action.action === 'refresh') return refreshReply
    if (action.action === 'set-models-enabled') return writeReply
    if (action.action === 'set-model-context-window') return writeReply
    if (action.action === 'checkin') return { state: 'claimed', amount: 100 }
    if (action.action === 'clear-checkin-logs') return { state: 'cleared' }
    return { state: 'ok', validation: 'non-validating', efforts: [] }
  }

  afterEach(() => {
    act(() => view?.unmount())
    // The readout switches are CARD-owned client preferences (the host rejects
    // the field), so their store is module state shared across tests.
    setQuotaReadout(true, true, true)
    vi.unstubAllGlobals()
  })

  interface SettingsSeed {
    autoCheckInCN?: boolean
    checkInMinuteCN?: number
    quotaPollMs?: number
  }

  /**
   * The bound settings face, as the card sees it. The readout switches are NOT
   * part of it — they live in the shared store, seeded through
   * `setQuotaReadout`.
   */
  function fakeSettingsScope(seed: SettingsSeed = {}) {
    return {
      getSnapshot: () => ({
        status: 'ready' as const,
        writable: true,
        value: {
          autoCheckInCN: false,
          autoCheckInGlobal: false,
          checkInMinuteCN: 600,
          checkInMinuteGlobal: 600,
          quotaPollMs: 300_000,
          ...seed,
        },
      }),
      subscribe: () => () => {},
      set: vi.fn(),
    }
  }
  type SettingsScope = ReturnType<typeof fakeSettingsScope>

  async function mount(variant?: QoderCardVariant, scope?: SettingsScope): Promise<void> {
    const props = {
      t,
      ...variant === undefined ? {} : { variant },
      ...scope === undefined ? {} : { scope },
    } as unknown as Parameters<typeof QoderPluginCard>[0]
    await act(async () => { view = create(createElement(QoderPluginCard, props)) })
    // The page body is a grid of cards; the owner draws the title/breadcrumb,
    // so there is no disclosure header to expand of the card's own.
    expect(view!.root.findAll(node => node.props.className === 'qdp-page')).toHaveLength(1)
    expect(view!.root.findAll(node => node.props.className === 'qdp-cardOpen')).toHaveLength(0)
    expect(view!.root.findAll(node => node.props.className === 'qdp-cardHeader')).toHaveLength(0)
  }

  /** Render the page with a bound settings face (needed for the advanced card). */
  async function mountWithSettings(scope: SettingsScope, variant?: QoderCardVariant): Promise<void> {
    await mount(variant, scope)
  }

  const titles = (): string[] => view!.root
    .findAll(node => node.props.className === 'qdp-sectionTitle')
    .map(node => node.children.join(''))
  const sectionCount = (): number => view!.root.findAll(node => node.props.className === 'qdp-card').length
  const rendered = (): string => JSON.stringify(view!.toJSON())

  const buttons = () => view!.root.findAllByType('button')
  const buttonLabels = (): string[] => buttons().map(node => String(node.children.join('')))
  const press = async (label: string, nth = 0): Promise<void> => {
    const matches = buttons().filter(node => node.children.join('') === label || node.props['aria-label'] === label)
    const node = matches[nth]
    if (node === undefined) throw new Error(`no button #${nth} "${label}"; have: ${buttonLabels().join(' | ')}`)
    await act(async () => { node.props.onClick() })
  }
  const inputs = () => view!.root.findAllByType('input')
  const patInputs = () => inputs().filter(node => node.props.type === 'password')
  const typePat = async (value: string): Promise<void> => {
    const input = patInputs()[0]
    if (input === undefined) throw new Error('no PAT input rendered')
    await act(async () => { input.props.onChange({ target: { value } }) })
  }
  /** Fire every held POST with the given reply body. */
  const releasePosts = async (reply: unknown): Promise<void> => {
    const pending = releaseQueue
    releaseQueue = []
    await act(async () => { for (const resolve of pending) resolve(reply) })
  }
  const getBodies = (action: string): Record<string, unknown>[] => posts
    .map(post => JSON.parse(String(post.init.body)) as Record<string, unknown>)
    .filter(body => body['action'] === action)

  /** Every switch on the page, located by its visible/aria label. */
  const switches = () => view!.root.findAll(node => node.props.role === 'switch')
  const switchFor = (label: string) =>
    switches().filter(node => node.props['aria-label'] === label)[0]
  const flip = async (label: string): Promise<void> => {
    const node = switchFor(label)
    if (node === undefined) {
      throw new Error(`no switch "${label}"; have: ${switches().map(n => String(n.props['aria-label'])).join(' | ')}`)
    }
    await act(async () => { node.props.onClick() })
  }

  // ---- page anatomy ---------------------------------------------------------

  it('renders the signed-in page as exactly four cards, in contract order', async () => {
    await mount()
    expect(sectionCount()).toBe(4)
    expect(titles()).toEqual([
      en.accountHeading,
      en.quotaSectionUsage,
      en.paneModels,
      en.quotaSectionAdvanced,
    ])
    // The 可用额度 card is gone: the composer chip owns the quota readout now.
    expect(rendered()).not.toContain(en.creditsHeading)
  })

  it('keeps only the account and advanced cards while signed out', async () => {
    signedOut()
    await mount()
    // Check-in and model preferences belong to an account nobody is signed
    // into; the PAT entry is the only action such a page can offer.
    expect(sectionCount()).toBe(2)
    expect(titles()).toEqual([en.accountHeading, en.quotaSectionAdvanced])
    expect(patInputs()).toHaveLength(1)
  })

  // ---- advanced card: quota-readout switches ---------------------------------

  it('renders the readout switches default-on even without a signed-in account', async () => {
    signedOut()
    await mountWithSettings(fakeSettingsScope())
    // The rows are configuration, not account state: a signed-out page keeps
    // 账号 + 高级设置, and the readout group still reflects the stored values.
    expect(titles()).toEqual([en.accountHeading, en.quotaSectionAdvanced])
    const tree = rendered()
    expect(tree).toContain(en.quotaReadoutEnabledLabel)
    expect(tree).toContain(en.quotaReadoutEnabledDesc)
    expect(tree).toContain(en.quotaReadoutCNLabel)
    expect(tree).toContain(en.quotaReadoutCNDesc)
    expect(tree).toContain(en.quotaReadoutGlobalLabel)
    expect(tree).toContain(en.quotaReadoutGlobalDesc)
    for (const label of [en.quotaReadoutEnabledLabel, en.quotaReadoutCNLabel, en.quotaReadoutGlobalLabel]) {
      const node = switchFor(label)
      expect(node).toBeDefined()
      expect(node!.props['aria-checked']).toBe(true)
      // The master has no `disabled` attribute at all; the variants carry
      // `disabled={false}` while it is on.
      expect(node!.props.disabled).toBeFalsy()
    }
  })

  it('writes each readout switch to its own field, immediately', async () => {
    signedOut()
    const scope = fakeSettingsScope()
    await mountWithSettings(scope)
    // Variant switches first: once the master is off they are disabled by
    // design, exactly like the UI users see.
    await flip(en.quotaReadoutCNLabel)
    expect(quotaReadout()).toEqual({ enabled: true, cn: false, global: true })
    await flip(en.quotaReadoutGlobalLabel)
    expect(quotaReadout()).toEqual({ enabled: true, cn: false, global: false })
    // Toggling the master carries the two per-variant values through unchanged.
    await flip(en.quotaReadoutEnabledLabel)
    expect(quotaReadout()).toEqual({ enabled: false, cn: false, global: false })
    // This is a CLIENT preference, not a host settings field: nothing may reach
    // the settings face (the shipped host rejects `quotaReadoutEnabled`).
    expect(scope.set).not.toHaveBeenCalled()
  })

  it('disables both variant readout switches, and drops their writes, under the master', async () => {
    signedOut()
    setQuotaReadout(false, true, true)
    const scope = fakeSettingsScope()
    await mountWithSettings(scope)
    expect(switchFor(en.quotaReadoutEnabledLabel)!.props['aria-checked']).toBe(false)
    for (const label of [en.quotaReadoutCNLabel, en.quotaReadoutGlobalLabel]) {
      expect(switchFor(label)!.props.disabled).toBe(true)
      // A disabled button is still in the tree; a programmatic click must not
      // write a preference the master switch has hidden.
      await flip(label)
    }
    expect(quotaReadout()).toEqual({ enabled: false, cn: true, global: true })
    expect(scope.set).not.toHaveBeenCalled()
    // The master itself stays live: turning it back on re-arms both variants
    // (and keeps their stored values).
    await flip(en.quotaReadoutEnabledLabel)
    expect(quotaReadout()).toEqual({ enabled: true, cn: true, global: true })
    expect(switchFor(en.quotaReadoutCNLabel)!.props.disabled).toBe(false)
    expect(switchFor(en.quotaReadoutGlobalLabel)!.props.disabled).toBe(false)
  })

  it('keeps the refresh interval an immediate write in the advanced card', async () => {
    const scope = fakeSettingsScope()
    await mountWithSettings(scope)
    const poll = inputs().filter(node => node.props['aria-label'] === en.quotaPollLabel)[0]!
    expect(poll.props.value).toBe(5) // 300_000 ms renders as five minutes
    await act(async () => { poll.props.onChange({ target: { value: '7' } }) })
    expect(scope.set).toHaveBeenCalledWith('quotaPollMs', 420_000)
  })

  // ---- PAT entry (signed-out arm) ----------------------------------------

  it("shows the PAT entry only when the document carries this card's auth key", async () => {
    signedOut()
    await mount()
    expect(patInputs()).toHaveLength(1)
    const input = patInputs()[0]!
    expect(input.props.placeholder).toBe(en.patPlaceholder)
    expect(input.props.value).toBe('')
    // Without a key the entry would POST into a 403 it cannot pass, so the
    // card withholds it entirely.
    signedOut({ authKey: undefined })
    await mount()
    expect(patInputs()).toHaveLength(0)
  })

  it('sends the trimmed draft to the variant auth route with the key header', async () => {
    signedOut()
    await mount()
    await press(en.patSave) // empty draft stays inert
    expect(posts).toEqual([])
    await typePat('  pt-pasted  ')
    await press(en.patSave)
    expect(posts).toHaveLength(1)
    expect(posts[0]!.url).toBe(QODER_CN_CARD.authPath)
    const headers = posts[0]!.init.headers as Record<string, string>
    expect(headers['X-Qoder-Auth-Key']).toBe('test-auth-key')
    expect(JSON.parse(String(posts[0]!.init.body))).toEqual({ action: 'save-pat', pat: 'pt-pasted' })
  })

  it('reports the save lifecycle: busy label, then the signed-in body takes over', async () => {
    signedOut()
    holdPosts = true
    await mount()
    await typePat('pt-good')
    await press(en.patSave)
    expect(buttonLabels()).toContain(en.patSaving)
    // The next read answers signed-in, exactly like the host route after a
    // save — and the entry gives way to the account body.
    signedIn()
    await releasePosts({ ok: true, status: 'saved' })
    expect(patInputs()).toHaveLength(0)
    expect(buttonLabels()).toContain(en.patRemove)
  })

  it('renders the stable refusal codes as the re-generate prompt, not raw wire text', async () => {
    signedOut()
    holdPosts = true
    await mount()
    await typePat('pt-dead')
    await press(en.patSave)
    await releasePosts({ ok: false, error: 'qoder_invalid_pat' })
    expect(rendered()).toContain(en.patInvalid)
    expect(rendered()).not.toContain('qoder_invalid_pat')
  })

  it('passes any other save failure through with its detail', async () => {
    signedOut()
    holdPosts = true
    await mount()
    await typePat('pt-x')
    await press(en.patSave)
    await releasePosts({ ok: false, error: 'disk on fire' })
    expect(rendered()).toContain(t('patSaveFailed', { message: 'disk on fire' }))
  })

  it('keeps Enter and clicking equivalent and lets the draft live only in state', async () => {
    signedOut()
    await mount()
    // Enter on an empty draft stays inert...
    await act(async () => { patInputs()[0]!.props.onKeyDown({ key: 'Enter', preventDefault: () => {} }) })
    expect(posts).toHaveLength(0)
    // ...and the next Enter carries the then-current draft.
    await typePat('pt-enter')
    await act(async () => { patInputs()[0]!.props.onKeyDown({ key: 'Enter', preventDefault: () => {} }) })
    expect(posts).toHaveLength(1)
    expect(JSON.parse(String(posts[0]!.init.body))).toEqual({ action: 'save-pat', pat: 'pt-enter' })
  })

  // ---- signed-in arm: credential row, replace, clear ----------------------

  it('summarizes the credential in effect without ever spelling the token', async () => {
    await mount()
    const tree = rendered()
    expect(tree).toContain(t('patTail', { tail: '****abcd' }))
    expect(tree).toContain(en.patSourceCard)
    expect(tree).not.toContain('pt-test')
    // The credential row carries both actions; removal still arms a confirm.
    expect(buttonLabels()).toContain(en.patRemove)
    expect(buttonLabels()).toContain(en.patReplace)
  })

  it('Remove PAT arms a cancellable confirm over the live document', async () => {
    await mount()
    await press(en.patRemove)
    expect(buttonLabels()).toContain(en.patClearConfirmYes)
    await press(en.cancel)
    expect(buttonLabels()).toContain(en.patRemove)
    // Canceling never touches the route: the stored PAT is still in effect.
    expect(posts).toEqual([])
  })

  it('Clear PAT confirms inline, then posts the clear action and re-reads to the signed-out entry', async () => {
    holdPosts = true
    await mount()
    // First press only ARMS the confirm — nothing is sent yet.
    await press(en.patRemove)
    expect(posts).toHaveLength(0)
    expect(buttonLabels()).toContain(en.patClearConfirmYes)
    expect(buttonLabels()).toContain(en.cancel)
    // The confirm press sends the write.
    await press(en.patClearConfirmYes)
    expect(JSON.parse(String(posts[0]!.init.body))).toEqual({ action: 'clear' })
    expect(buttonLabels()).toContain(en.patClearing)
    signedOut()
    await releasePosts({ ok: true })
    expect(patInputs()).toHaveLength(1) // signed-out arm with an authKey re-offers entry
  })

  // ---- poll liveness --------------------------------------------------------

  it('polls while signed in and stops once a document confirms sign-out', async () => {
    await mount()
    expect([...intervalHandles.keys()]).toHaveLength(1)
    // The signed-out answer is a fact about the account: the poll parks until
    // a PAT save re-arms it through the effect.
    intervalHandles.clear()
    signedOut()
    await press(en.refresh)
    expect([...intervalHandles.keys()]).toHaveLength(0)
  })

  // ---- check-in card --------------------------------------------------------

  it('renders the claim row and the compact ledger, then writes the clear action', async () => {
    signedIn({
      checkIn: {
        lastDate: '2026-10-17',
        today: '2026-10-18',
        lastAt: 1_700_000_000_000,
        status: 'claimed',
        amount: 100,
        logs: [
          { id: 'g1', date: '2026-10-17', timestamp: 1_700_000_000_000, status: 'claimed', amount: 100 },
          { id: 'g2', date: '2026-10-16', timestamp: 1_699_900_000_000, status: 'claimed', amount: 50 },
        ],
      },
    })
    await mount()
    const tree = rendered()
    expect(tree).toContain(t('ledgerCount', { count: 2 }))
    expect(tree).toContain('+100')
    // Yesterday's grant does not disable today's claim (the DATE must match).
    expect(buttonLabels()).toContain(en.checkInNow)
    await press(en.checkInClear)
    expect(getBodies('clear-checkin-logs')).toHaveLength(1)
    const logRows = view!.root.findAll(node => node.props.className === 'qdp-logRow')
    expect(logRows).toHaveLength(2)
  })

  it('posts the claim write to its own probe route and reports the outcome', async () => {
    signedIn({
      checkIn: { lastDate: '2026-10-17', today: '2026-10-18', lastAt: 1, status: 'claimed', amount: 100, logs: [] },
    })
    await mount()
    await press(en.checkInNow)
    expect(getBodies('checkin')).toHaveLength(1)
    expect(posts[0]!.url).toBe(QODER_CN_CARD.probePath)
    expect(rendered()).toContain(t('autoCheckInStatusClaimed', { amount: 100 }))
  })

  it('shows the claimed tag instead of the button when today is already claimed', async () => {
    signedIn({
      checkIn: { lastDate: '2026-10-18', today: '2026-10-18', lastAt: 1, status: 'already-claimed', amount: 100, logs: [] },
    })
    await mount()
    expect(rendered()).toContain(en.checkInClaimedToday)
    expect(buttonLabels()).not.toContain(en.checkInNow)
  })

  // ---- models card: batched save wiring -------------------------------------

  it('applies the enable/disable delta, one window write and exactly ONE re-read', async () => {
    signedIn({ models: MODELS, disabledModels: ['m2'] })
    await mount()
    // The pane only stages changes; nothing is posted until its save bar fires.
    expect(posts).toEqual([])
    const readsBefore = reads
    const pane = view!.root.findByType(ModelsPane)
    await act(async () => {
      pane.props.onSave({ disabled: ['m1'], windows: { m1: 1_000_000 } })
    })
    // Disable m1, then enable m2, then the one window change — in that order.
    expect(getBodies('set-models-enabled')).toEqual([
      { action: 'set-models-enabled', models: ['m1'], enabled: false },
      { action: 'set-models-enabled', models: ['m2'], enabled: true },
    ])
    expect(getBodies('set-model-context-window')).toEqual([
      { action: 'set-model-context-window', model: 'm1', window: 1_000_000 },
    ])
    // The whole batch re-reads the document once, not once per write.
    expect(reads - readsBefore).toBe(1)
    const writes = posts.filter(post => {
      const body = JSON.parse(String(post.init.body)) as { action?: string }
      return body.action?.startsWith('set-') === true
    })
    expect(writes).toHaveLength(3)
    expect(writes.every(post => post.url === QODER_CN_CARD.probePath)).toBe(true)
  })

  it('skips the empty deltas but still re-reads once', async () => {
    signedIn({ models: MODELS, disabledModels: [] })
    await mount()
    const readsBefore = reads
    const pane = view!.root.findByType(ModelsPane)
    await act(async () => {
      pane.props.onSave({ disabled: [], windows: {} })
    })
    expect(posts).toEqual([])
    expect(reads - readsBefore).toBe(1)
  })

  it('reports a refused model write in place and does not re-read', async () => {
    signedIn({ models: MODELS, disabledModels: [] })
    await mount()
    writeReply = { state: 'failed', reason: 'catalogue refused the write' }
    const readsBefore = reads
    const pane = view!.root.findByType(ModelsPane)
    await act(async () => {
      pane.props.onSave({ disabled: ['m1'], windows: { m1: 1_000_000 } })
    })
    // The pane renders the failure instead of the page repainting from a stale
    // catalog: the save aborts at the first refused write.
    expect(rendered()).toContain(t('modelsSaveFailed', { message: 'catalogue refused the write' }))
    expect(reads - readsBefore).toBe(0)
    expect(view!.root.findByType(ModelsPane).props.saveError).toBe('catalogue refused the write')
  })

  // ---- models card: catalog refresh ----------------------------------------

  it('surfaces the reason when the MODEL refresh reports a failure in a 200 body', async () => {
    await mount()
    refreshReply = { state: 'failed', reason: 'Qoder model discovery network request failed.' }
    await press(en.refreshModels)
    const tree = rendered()
    expect(tree).toContain('Qoder model discovery network request failed.')
    expect(tree).toContain(en.statusRefreshFailed.split('{message}')[0]!)
  })

  it('keeps a successful model refresh quiet', async () => {
    await mount()
    refreshReply = { state: 'refreshed', reason: '12 models' }
    await press(en.refreshModels)
    const tree = rendered()
    expect(tree).not.toContain(en.statusRefreshFailed.split('{message}')[0]!)
    expect(tree).not.toContain('12 models')
  })

  it('falls back to the generic label when a failed refresh gives no reason', async () => {
    await mount()
    refreshReply = { state: 'failed' }
    await press(en.refreshModels)
    expect(rendered()).toContain(en.requestFailed)
  })

  // ---- read failures ---------------------------------------------------------

  it('reports a failed refresh beside the document it cannot replace', async () => {
    await mount()
    statusFails = true
    await press(en.refresh)
    const tree = rendered()
    expect(tree).toContain(en.statusRefreshFailed.split('{message}')[0]!)
    expect(tree).toContain(en.signedIn) // the document is still rendered
  })

  it('turns an unreadable 200 into the error arm rather than dereferencing it', async () => {
    statusBody = null
    await mount()
    const tree = rendered()
    // 首次读取就给了不可解析的 200:账号状态落到 error 臂并给出无效响应提示,
    // 而不是把 null 当文档解引用崩掉。
    expect(tree).toContain(en.statusResponseInvalid)
    expect(tree).toContain(en.requestFailed) // the account state label
    expect(tree).not.toContain(en.signedIn)
  })

  // ---- variant copy and routes -------------------------------------------------

  it("the Global card asks its own routes and shows qoder.com's guide", async () => {
    signedOut()
    await mount(QODER_GLOBAL_CARD)
    const asked = vi.mocked(fetch).mock.calls.map(call => String(call[0]))
    expect(asked).toContain(QODER_GLOBAL_CARD.statusPath)
    const tree = rendered()
    expect(tree).toContain(en.patGuideAI)
    expect(tree).toContain(en.patPlaceholderAI)
    expect(tree).not.toContain('qoder.com.cn')
  })
})
