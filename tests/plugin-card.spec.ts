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
import { noteQuotaStatus, quotaReadout, setQuotaReadout } from '../src/client/quota-settings-store.ts'
import { resetQuotaSignIn, resetQuotaStatusDocuments } from '../src/client/quota-settings-store.ts'
import type { QoderWebStatus } from '../src/status-paths.ts'

/**
 * Card tests for the compact settings page.
 *
 * The page is three cards (账号 / 模型 / 高级设置), and the card owns three
 * sensitive write paths: the PAT entry (what it sends and which header
 * authorizes it), the batched 一键签到 claim, and the models pane's BATCHED
 * save (one refresh for the whole change set, never one per toggle). A
 * signed-out account gets only 账号 + 高级设置 — model preferences for an
 * account nobody is signed into would be settings that cannot be exercised
 * yet.
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
  /**
   * The host's answer to the two pool writes (activate-account /
   * remove-account). The real route answers `{ ok: true }` on success and its
   * existing error shape on a refused id — never a 500 for a stale id.
   */
  let accountReply: unknown = { ok: true }

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
    accountReply = { ok: true }
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
    if (action.action === 'activate-account' || action.action === 'remove-account') return accountReply
    if (action.action === 'set-account-enabled') return accountReply
    if (action.action === 'refresh') return refreshReply
    if (action.action === 'set-models-enabled') return writeReply
    if (action.action === 'set-model-context-window') return writeReply
    if (action.action === 'checkin') return { state: 'claimed', amount: 100 }
    return { state: 'ok', validation: 'non-validating', efforts: [] }
  }

  afterEach(() => {
    act(() => view?.unmount())
    // The readout switch is a CARD-owned client preference (the host does not
    // own the field), so its store is module state shared across tests.
    setQuotaReadout(true)
    // The status documents are module state too: drop them so the next case's
    // mount reads its own mocked body instead of this one's cached answer.
    resetQuotaStatusDocuments()
    resetQuotaSignIn()
    vi.unstubAllGlobals()
  })

  interface SettingsSeed {
    autoCheckInCN?: boolean
    quotaPollMs?: number
    autoFailoverEnabled?: boolean
    queueWaitAttempts?: number
    queueWaitSeconds?: number
    routingStrategy?: 'save-order' | 'custom'
    routingOrder?: readonly string[]
    stickinessRounds?: number
    stickinessRequests?: number
    stickinessMinutes?: number
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
          quotaPollMs: 300_000,
          ...seed,
        },
      }),
      subscribe: () => () => {},
      set: vi.fn(),
    }
  }
  type SettingsScope = ReturnType<typeof fakeSettingsScope>

  async function mount(variant?: QoderCardVariant, scope?: SettingsScope, unified = false): Promise<void> {
    // A case that mounts twice to show a changed document replaces the previous
    // instance: a leaked card stays subscribed to the shared store and would
    // re-create its poll timer when a later case publishes a document.
    act(() => view?.unmount())
    const props = {
      t,
      ...variant === undefined ? {} : { variant },
      ...scope === undefined ? {} : { scope },
      ...unified ? { unified: true as const } : {},
    } as unknown as Parameters<typeof QoderPluginCard>[0]
    await act(async () => { view = create(createElement(QoderPluginCard, props)) })
    // The page body is a grid of cards; the owner draws the title/breadcrumb,
    // so there is no disclosure header to expand of the card's own.
    expect(view!.root.findAll(node => node.props.className === 'qdp-page')).toHaveLength(1)
    expect(view!.root.findAll(node => node.props.className === 'qdp-cardOpen')).toHaveLength(0)
    expect(view!.root.findAll(node => node.props.className === 'qdp-cardHeader')).toHaveLength(0)
  }

  /** Render the page with a bound settings face (needed for the advanced card). */
  async function mountWithSettings(scope: SettingsScope, variant?: QoderCardVariant, unified = false): Promise<void> {
    await mount(variant, scope, unified)
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

  it('renders the signed-in page as exactly three cards, in contract order', async () => {
    await mount()
    expect(sectionCount()).toBe(3)
    expect(titles()).toEqual([
      en.accountHeading,
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

  // ---- advanced card: readout switch + variant header checkboxes -----------

  /** The per-variant checkboxes living beside the segmented 版本 tabs. */
  const variantChecks = () => inputs().filter(node => node.props.className === 'qdp-segCheck')

  it('renders one readout switch and the two variant header checkboxes', async () => {
    signedOut()
    // The checkbox pair lives in the unified header's segmented switcher.
    await mountWithSettings(fakeSettingsScope(), undefined, true)
    // These rows are configuration, not account state: a signed-out page keeps
    // 账号 + 高级设置 and still reflects the stored values.
    expect(titles()).toEqual([en.accountHeading, en.quotaSectionAdvanced])
    const tree = rendered()
    expect(tree).toContain(en.quotaReadoutEnabledLabel)
    expect(tree).toContain(en.quotaReadoutEnabledDesc)
    // The per-variant readout rows are gone.
    expect(tree).not.toContain('国内版额度')
    expect(tree).not.toContain('国际版额度')
    const readout = switchFor(en.quotaReadoutEnabledLabel)
    expect(readout).toBeDefined()
    expect(readout!.props['aria-checked']).toBe(true)
    expect(readout!.props.disabled).toBeFalsy()
    // The master switches became checkboxes beside the segmented tabs.
    expect(variantChecks()).toHaveLength(2)
    for (const box of variantChecks()) {
      expect(box.props.checked).toBe(true)
      expect(box.props.disabled).toBeFalsy()
    }
  })

  it('writes the readout switch to the client store, not the settings face', async () => {
    signedOut()
    const scope = fakeSettingsScope()
    await mountWithSettings(scope)
    await flip(en.quotaReadoutEnabledLabel)
    expect(quotaReadout().enabled).toBe(false)
    // A CLIENT preference: nothing reaches the host settings face.
    expect(scope.set).not.toHaveBeenCalled()
  })

  it('writes each variant header checkbox to its own settings field', async () => {
    const scope = fakeSettingsScope()
    await mountWithSettings(scope, undefined, true)
    const [cnBox, globalBox] = variantChecks()
    await act(async () => { cnBox!.props.onChange({ target: { checked: false } }) })
    expect(scope.set).toHaveBeenCalledWith('variantEnabledCN', false)
    await act(async () => { globalBox!.props.onChange({ target: { checked: false } }) })
    expect(scope.set).toHaveBeenCalledWith('variantEnabledGlobal', false)
  })

  it('commits the refresh interval on blur, never on a keystroke', async () => {
    const scope = fakeSettingsScope()
    await mountWithSettings(scope)
    const poll = inputs().filter(node => node.props['aria-label'] === en.quotaPollLabel)[0]!
    expect(poll.props.value).toBe('5') // 300_000 ms renders as five minutes
    // Typing is a draft: a write per keystroke cannot work, because clearing
    // the field to retype it yields '' and the controlled input would snap
    // back to the stored value under the user's cursor.
    await act(async () => { poll.props.onChange({ target: { value: '7' } }) })
    expect(scope.set).not.toHaveBeenCalled()
    await act(async () => { poll.props.onBlur() })
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

  // ---- account pool: one row per stored PAT, switch and remove by id --------

  /** Two stored accounts: the first in use, the second the failover spare. */
  function withPool(overrides: Record<string, unknown> = {}): void {
    signedIn({
      accounts: {
        entries: [
          { id: 'pat:aaaa', source: 'card', active: true, order: 1, patTail: 'aaaa', accountName: 'Alice', savedAtMs: 1_700_000_000_000 },
          { id: 'pat:bbbb', source: 'card', active: false, order: 2, patTail: 'bbbb' },
        ],
        autoFailover: true,
      },
      ...overrides,
    })
  }

  /** How many account rows contain a node with this exact class. */
  function poolRowsWith(className: string): number {
    const rows = view!.root.findAll(node => node.props.className === 'qdp-accountItem')
    return rows.filter(row => row.findAll(node => node.props.className === className).length > 0).length
  }

  it('lists one row per stored account and marks the one in use', async () => {
    withPool()
    await mount()
    const tree = rendered()
    expect(tree).toContain(en.accountsHeading)
    expect(tree).toContain(en.accountsHint)
    // Both rows carry their own redacted facts, never a token.
    expect(tree).toContain(t('patTail', { tail: '****aaaa' }))
    expect(tree).toContain(t('patTail', { tail: '****bbbb' }))
    expect(tree).toContain('Alice')
    // The unnamed account is still identifiable by its failover position.
    expect(tree).toContain(t('accountSlot', { order: 2 }))
    // Exactly one row is the account in use: its Use button is the disabled one.
    const useButtons = buttons().filter(node => node.children.join('') === en.accountSwitch)
    expect(useButtons).toHaveLength(2)
    expect(useButtons.filter(node => node.props.disabled === true)).toHaveLength(1)
    const rows = view!.root.findAll(node => node.props.className === 'qdp-accountItem')
    // One row per stored account, in the host's failover order, keyed by the id
    // the writes use — never by the token.
    expect(rows.map(row => row.props['data-account-id'])).toEqual(['pat:aaaa', 'pat:bbbb'])
    // The marker sits on the first row only: the in-use row draws the done dot
    // plus the tag, the spare draws the plain empty dot.
    expect(poolRowsWith('qdp-dot qdp-dotDone')).toBe(1)
    expect(poolRowsWith('qdp-dot')).toBe(1)
    expect(tree.split('"className":"qdp-tag qdp-tagSuccess"},"children":["In use"]').length - 1).toBe(1)
    // The pool owns the credential actions now: the single-credential row's
    // 「更换 PAT」/「删除」 pair gives way to per-row actions plus 「添加账号」.
    expect(buttonLabels()).not.toContain(en.patReplace)
    expect(buttonLabels()).toContain(en.accountAdd)
    expect(buttonLabels().filter(label => label === en.accountSwitch)).toHaveLength(2)
  })

  it('keeps the single-credential row when the pool is empty (env-only credential)', async () => {
    signedIn({
      pat: { source: 'env', patTail: 'env1' },
      accounts: { entries: [], autoFailover: true },
    })
    await mount()
    const tree = rendered()
    // `accounts()` omits an env-only credential by design, so the pool must not
    // claim there are no credentials — the env row is the only description left.
    expect(tree).not.toContain(en.accountsHeading)
    expect(tree).toContain(en.patHeading)
    expect(tree).toContain(en.patSourceEnv)
    expect(buttonLabels()).toContain(en.patReplace)
    expect(buttonLabels()).toContain(en.patRemove)
    expect(buttonLabels()).not.toContain(en.accountSwitch)
  })

  it('opens the same paste-a-PAT entry for 「添加账号」 and adds no optimistic row', async () => {
    withPool()
    await mount()
    expect(patInputs()).toHaveLength(0)
    await press(en.accountAdd)
    // The pool's add IS the PAT entry: one entry point, one upsert path.
    expect(patInputs()).toHaveLength(1)
    // Nothing is added until the host confirms it: the list still shows two.
    expect(getBodies('save-pat')).toEqual([])
    expect(poolRowsWith('qdp-dot qdp-dotDone') + poolRowsWith('qdp-dot')).toBe(2)
  })

  it('switches the active account by id, on its own auth route, then re-reads', async () => {
    withPool()
    await mount()
    const readsBefore = reads
    const spare = t('accountSlot', { order: 2 })
    await press(t('accountSwitchAria', { name: spare }))
    expect(getBodies('activate-account')).toEqual([{ action: 'activate-account', accountId: 'pat:bbbb' }])
    // The id is the one-way hash the document handed over; the token is never
    // sent back, and the write is authorized by the same header as a PAT save.
    expect(rendered()).not.toContain('pt-test')
    const post = posts.find(entry => String(entry.init.body).includes('activate-account'))!
    expect(post.url).toBe(QODER_CN_CARD.authPath)
    expect((post.init.headers as Record<string, string>)['X-Qoder-Auth-Key']).toBe('test-auth-key')
    // One re-read, so the whole document (active dot, summary, credits) moves.
    expect(reads - readsBefore).toBe(1)
    expect(rendered()).toContain(t('accountSwitched', { name: spare }))
  })

  it('arms the remove confirm on its own row and posts remove-account only on confirm', async () => {
    withPool()
    await mount()
    const spare = t('accountSlot', { order: 2 })
    await press(t('accountRemoveAria', { name: spare }))
    // First press only arms: an account removal is never one click.
    expect(getBodies('remove-account')).toEqual([])
    expect(rendered()).toContain(en.accountRemoveConfirm)
    await press(en.cancel)
    expect(rendered()).not.toContain(en.accountRemoveConfirm)
    await press(t('accountRemoveAria', { name: spare }))
    await press(en.accountRemoveConfirmYes)
    expect(getBodies('remove-account')).toEqual([{ action: 'remove-account', accountId: 'pat:bbbb' }])
    expect(rendered()).toContain(en.accountRemoved)
  })

  it('reports a refused pool write instead of pretending the list changed', async () => {
    withPool()
    await mount()
    accountReply = { ok: false, error: 'qoder_unknown_account' }
    const readsBefore = reads
    await press(t('accountSwitchAria', { name: t('accountSlot', { order: 2 }) }))
    expect(rendered()).toContain(t('accountActionFailed', { message: 'qoder_unknown_account' }))
    // A stale id means another surface moved the pool: re-read rather than
    // leave a list on screen that no longer matches the host.
    expect(reads - readsBefore).toBe(1)
  })

  it('says nothing about accounts when the host serves no pool at all', async () => {
    // The pre-pool document shape: `pat` only. The card must keep working
    // against it rather than render an empty account list.
    await mount()
    const tree = rendered()
    expect(tree).not.toContain(en.accountsHeading)
    expect(tree).toContain(en.patHeading)
    expect(buttonLabels()).not.toContain(en.accountAdd)
  })

  // ---- upstream notice: a queue condition, not a credential error ----------

  /** One recorded upstream refusal, as the host projects it. */
  function notice(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      kind: 'queued',
      upstreamMessage: 'RESOURCE_LIMIT: model queue is full',
      retryAfterMs: 65_000,
      waited: false,
      at: 1_700_000_000_000,
      occurrences: 1,
      ...overrides,
    }
  }

  it('renders the upstream refusal with its own words, delay, and non-credential hint', async () => {
    withPool({ upstreamNotice: notice() })
    await mount()
    const tree = rendered()
    expect(tree).toContain(en.upstreamNoticeKindQueued)
    expect(tree).toContain(en.upstreamNoticeHeading)
    // The upstream's own text is quoted so the user can paste it into a report.
    expect(tree).toContain(t('upstreamNoticeMessage', { message: 'RESOURCE_LIMIT: model queue is full' }))
    expect(tree).toContain(t('upstreamNoticeRetry', { seconds: 65 }))
    expect(tree).toContain(en.upstreamNoticeNotAuth)
    // It must NOT read as a PAT problem: the whole point of the notice is that
    // re-generating a working token is the wrong response.
    expect(tree).not.toContain(en.patInvalid)
  })

  it('carries the notice in a warn-toned block, never the error alert', async () => {
    withPool({ upstreamNotice: notice({ kind: 'unavailable' }) })
    await mount()
    const blocks = view!.root.findAll(node => node.props.className === 'qdp-notice')
    expect(blocks).toHaveLength(1)
    expect(blocks[0]!.props['data-notice-kind']).toBe('unavailable')
    expect(blocks[0]!.props.role).toBe('status')
    expect(rendered()).toContain(en.upstreamNoticeKindUnavailable)
    // The auth/refresh failure styling stays reserved for failures.
    expect(view!.root.findAll(node => String(node.props.className).includes('qdp-alertError'))).toHaveLength(0)
  })

  it('claims a wait only when the notice records that one happened', async () => {
    withPool({ upstreamNotice: notice({ waited: true, retryAfterMs: 30_000 }) })
    await mount()
    expect(rendered()).toContain(t('upstreamNoticeWaited', { seconds: 30 }))
    act(() => view?.unmount())

    withPool({ upstreamNotice: notice({ waited: false, retryAfterMs: 30_000 }) })
    await mount()
    const tree = rendered()
    expect(tree).not.toContain(t('upstreamNoticeWaited', { seconds: 30 }))
    // Not waiting is stated as advice, not as a past tense that would be a lie.
    expect(tree).toContain(t('upstreamNoticeRetry', { seconds: 30 }))
  })

  it('states no delay when the upstream gave none, but still records the wait', async () => {
    withPool({ upstreamNotice: notice({ waited: false, retryAfterMs: undefined }) })
    await mount()
    let tree = rendered()
    expect(tree).not.toContain(en.upstreamNoticeRetry.split('{seconds}')[0]!)
    expect(tree).toContain(en.upstreamNoticeHeading)
    act(() => view?.unmount())

    withPool({ upstreamNotice: notice({ waited: true, retryAfterMs: undefined }) })
    await mount()
    tree = rendered()
    // A wait that happened with no stated delay is still a wait that happened.
    expect(tree).toContain(en.upstreamNoticeWaitedNoDelay)
    expect(tree).not.toContain(t('upstreamNoticeWaited', { seconds: 30 }))
  })

  it('mentions recurrence only after the first sighting', async () => {
    withPool({ upstreamNotice: notice({ occurrences: 1 }) })
    await mount()
    expect(rendered()).not.toContain(en.upstreamNoticeRecurrence.split('{count}')[0]!)
    act(() => view?.unmount())

    withPool({ upstreamNotice: notice({ occurrences: 3 }) })
    await mount()
    expect(rendered()).toContain(t('upstreamNoticeRecurrence', { count: 3 }))
  })

  it('renders no notice block when the upstream has refused nothing', async () => {
    withPool()
    await mount()
    expect(view!.root.findAll(node => node.props.className === 'qdp-notice')).toHaveLength(0)
    expect(rendered()).not.toContain(en.upstreamNoticeHeading)
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

  // ---- account card: the batched 一键签到 ------------------------------------

  it('posts the batched claim write to its own probe route and reports the outcome', async () => {
    signedIn({
      checkIn: { lastDate: '2026-10-17', today: '2026-10-18', lastAt: 1, status: 'claimed', amount: 100 },
    })
    await mount()
    await press(en.checkInAll)
    // This standalone card only knows its OWN variant is signed in (the Global
    // sign-in is reported through the unified page), so one claim is sent.
    expect(getBodies('checkin')).toHaveLength(1)
    expect(posts[0]!.url).toBe(QODER_CN_CARD.probePath)
    expect(rendered()).toContain(t('autoCheckInStatusClaimed', { amount: 100 }))
  })

  it('shows the claimed tag on the account strip when today is already claimed', async () => {
    signedIn({
      checkIn: { lastDate: '2026-10-18', today: '2026-10-18', lastAt: 1, status: 'already-claimed', amount: 100 },
    })
    await mount()
    expect(rendered()).toContain(en.checkInClaimedToday)
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

  // ---- account pool: parking a seat ------------------------------------------

  /** The park checkbox of the row the host named `name`. */
  const parkBox = (name: string) =>
    inputs().filter(node => node.props['aria-label'] === t('accountEnabledAria', { name }))[0]

  /** The pool rows in document order, parked rows included. */
  const poolRowList = () => view!.root.findAll(node =>
    node.props['className'] === 'qdp-accountItem' || node.props['className'] === 'qdp-accountItem is-off')

  /** A number input on the page, located by its own aria label. */
  const inputFor = (label: string) => {
    const found = inputs().filter(node => node.props['aria-label'] === label)[0]
    if (found === undefined) throw new Error(`no input "${label}"`)
    return found
  }

  it('draws a park box on every seat and states a parked seat is excluded, not gone', async () => {
    withPool({
      accounts: {
        entries: [
          { id: 'pat:aaaa', source: 'card', active: true, order: 1, patTail: 'aaaa', accountName: 'Alice' },
          { id: 'pat:bbbb', source: 'card', active: false, order: 2, patTail: 'bbbb', enabled: false },
        ],
        autoFailover: true,
      },
    })
    await mount()
    const spare = t('accountSlot', { order: 2 })
    // One box per seat, and it is the ONLY statement about whether that seat
    // takes part in automatic switching at all.
    expect(parkBox('Alice')?.props.checked).toBe(true)
    expect(parkBox(spare)?.props.checked).toBe(false)
    // Parked is not removed: the row keeps its place, dimmed, with both of its
    // actions intact — the whole reason to park instead of deleting.
    expect(poolRowList().map(row => row.props['className']))
      .toEqual(['qdp-accountItem', 'qdp-accountItem is-off'])
    expect(buttonLabels()).toContain(en.accountAdd)
    expect(buttonLabels().filter(label => label === en.patRemove)).toHaveLength(2)
    // A parked seat reports no spendable figure and says why: a balance beside
    // it would be credit this list promises never to spend.
    expect(rendered()).toContain(en.accountParked)
    expect(rendered()).toContain(en.accountCreditsParked)
    // Parking is not switching: the in-use seat is still the in-use seat.
    expect(rendered()).toContain(en.accountCurrent)
  })

  it('posts set-account-enabled for the row id, then re-reads the document', async () => {
    withPool()
    await mount()
    const spare = t('accountSlot', { order: 2 })
    const readsBefore = reads
    await act(async () => { parkBox(spare)!.props.onChange({ target: { checked: false } }) })
    expect(getBodies('set-account-enabled')).toEqual([
      { action: 'set-account-enabled', accountId: 'pat:bbbb', enabled: false },
    ])
    // The reply is a verdict, not a description: the document is re-read so the
    // row ends up stating what the host stored, not what was clicked.
    expect(reads - readsBefore).toBe(1)
    expect(rendered()).toContain(t('accountParkedNotice', { name: spare }))
  })

  it('disables the row being parked until the host answers, and no other row', async () => {
    withPool()
    await mount()
    const spare = t('accountSlot', { order: 2 })
    holdPosts = true
    await act(async () => { parkBox(spare)!.props.onChange({ target: { checked: false } }) })
    expect(parkBox(spare)?.props.disabled).toBe(true)
    // Park writes are per-row and idempotent: parking one seat must not lock
    // the others while the host is still deciding.
    expect(parkBox('Alice')?.props.disabled).toBe(false)
    holdPosts = false
    await releasePosts({ ok: true })
    expect(parkBox(spare)?.props.disabled).toBe(false)
    expect(rendered()).toContain(t('accountParkedNotice', { name: spare }))
  })

  it('reports a refused park write instead of flipping the box', async () => {
    withPool()
    await mount()
    accountReply = { ok: false, error: 'qoder_unknown_account' }
    await act(async () => { parkBox('Alice')!.props.onChange({ target: { checked: false } }) })
    expect(rendered()).toContain(t('accountActionFailed', { message: 'qoder_unknown_account' }))
    // The host refused it, so the box shows the document's truth, not the click.
    expect(parkBox('Alice')?.props.checked).toBe(true)
  })

  // ---- advanced card: the failover policy ------------------------------------

  it('writes the failover policy switch through the settings face', async () => {
    const scope = fakeSettingsScope()
    await mountWithSettings(scope)
    expect(switchFor(en.autoFailoverLabel)?.props['aria-checked']).toBe(true)
    await flip(en.autoFailoverLabel)
    // A policy the host drops is a lie the user would only discover after a
    // failover went the wrong way, so this is a settings write, never local.
    expect(scope.set).toHaveBeenCalledWith('autoFailoverEnabled', false)
  })

  it('clamps a queue wait into the host bounds and writes an accepted one', async () => {
    // Seeded non-zero so that "0 is meaningful, not 'no value'" is a real
    // transition: committing the default 0 would be a no-op by design.
    const scope = fakeSettingsScope({ queueWaitAttempts: 3, queueWaitSeconds: 30 })
    await mountWithSettings(scope)
    // Re-query before each interaction: a render replaces the test instance,
    // and the props on the old one are the previous render's closures.
    const commit = async (label: string, value: string): Promise<void> => {
      await act(async () => { inputFor(label).props.onChange({ target: { value } }) })
      await act(async () => { inputFor(label).props.onBlur() })
    }
    // The host accepts 0..10 attempts; a number it would drop must never be
    // posted as though it had been recorded, so the field clamps it instead.
    await act(async () => { inputFor(en.queueWaitAttemptsLabel).props.onChange({ target: { value: '11' } }) })
    expect(scope.set).not.toHaveBeenCalled()
    await act(async () => { inputFor(en.queueWaitAttemptsLabel).props.onBlur() })
    expect(scope.set).toHaveBeenCalledWith('queueWaitAttempts', 10)
    expect(scope.set).not.toHaveBeenCalledWith('queueWaitAttempts', 11)
    // 0 is meaningful — report the queue answer at once — so it must be sent.
    await commit(en.queueWaitAttemptsLabel, '0')
    expect(scope.set).toHaveBeenCalledWith('queueWaitAttempts', 0)
    // Zero seconds is not "no wait": the floor is one second.
    await commit(en.queueWaitSecondsLabel, '0')
    expect(scope.set).toHaveBeenCalledWith('queueWaitSeconds', 1)
    await commit(en.queueWaitSecondsLabel, '45')
    expect(scope.set).toHaveBeenCalledWith('queueWaitSeconds', 45)
  })

  it('switches the routing strategy through the settings face', async () => {
    const scope = fakeSettingsScope()
    await mountWithSettings(scope)
    const select = view!.root.findByType('select')
    expect(select.props.value).toBe('save-order')
    // Under save order the list IS the account list above, so a second copy
    // would only invite the user to reorder something that cannot move.
    expect(view!.root.findAll(node => node.props['className'] === 'qdp-routingList')).toHaveLength(0)
    await act(async () => { select.props.onChange({ target: { value: 'custom' } }) })
    expect(scope.set).toHaveBeenCalledWith('routingStrategy', 'custom')
  })

  it('reorders the failover walk and writes the new order by value', async () => {
    const scope = fakeSettingsScope({ routingStrategy: 'custom', routingOrder: ['pat:aaaa', 'pat:bbbb'] })
    withPool()
    await mountWithSettings(scope)
    expect(view!.root
      .findAll(node => node.props['className'] === 'qdp-routingItem')
      .map(node => node.props['data-account-id'])).toEqual(['pat:aaaa', 'pat:bbbb'])
    await press(t('routingOrderMoveDownAria', { name: 'Alice' }))
    // The stored order is a value, not a reference: the face hands back a fresh
    // array per document, and the write has to carry the plain id list.
    expect(scope.set).toHaveBeenCalledWith('routingOrder', ['pat:bbbb', 'pat:aaaa'])
  })

  it('puts each seat balance and observed state on its routing row', async () => {
    // A routing row is a choice, not just a label: the two facts the user
    // weighs when ordering the walk are what the seat still has and whether it
    // is serving, so they sit on the name line exactly as in the account list.
    withPool({
      accounts: {
        entries: [
          {
            id: 'pat:aaaa',
            source: 'card',
            active: true,
            order: 1,
            patTail: 'aaaa',
            accountName: 'Alice',
            health: 'normal',
            credits: { total: 5, accounts: [{ packageName: 'pro', remain: 1234, size: 1300 }] },
          },
          {
            id: 'pat:bbbb',
            source: 'card',
            active: false,
            order: 2,
            patTail: 'bbbb',
            enabled: false,
          },
        ],
        autoFailover: true,
      },
    })
    await mountWithSettings(fakeSettingsScope({ routingStrategy: 'custom', routingOrder: ['pat:aaaa', 'pat:bbbb'] }))
    const rows = view!.root.findAll(node => node.props['className'] === 'qdp-routingItem')
    expect(rows).toHaveLength(2)
    /*
     * Walk the rendered tree for the <li> that carries each account id. The
     * renderer's instances do not expose their own JSON, so the row text is
     * collected from the tree the card actually rendered — which is what the
     * user sees, not what a prop happened to hold.
     */
    const rowTextOf = (accountId: string): string => {
      const tree = view!.toJSON() as unknown as { props?: Record<string, unknown>, children?: unknown[] }
      const find = (node: unknown): unknown => {
        if (node === null || typeof node !== 'object') return undefined
        const typed = node as { props?: Record<string, unknown>, children?: unknown[] }
        if (typed.props?.['data-account-id'] === accountId) return typed
        for (const child of typed.children ?? []) {
          const hit = find(child)
          if (hit !== undefined) return hit
        }
        return undefined
      }
      const matched = find(tree)
      return matched === undefined ? '' : JSON.stringify(matched)
    }
    const first = rowTextOf('pat:aaaa')
    expect(first).toContain('Alice')
    expect(first).toContain('1,234')
    expect(first).toContain(en.accountHealthNormal)
    // A parked seat is out of the walk: it says so instead of printing a
    // spendable-looking figure, and it carries no service state at all.
    const second = rowTextOf('pat:bbbb')
    expect(second).toContain(en.accountCreditsParked)
    // Parked is stated as parked, never as a healthy seat: it is out of the
    // automatic walk, so a 正常 tag beside it would promise a route that is not
    // there. The account list uses the same two words for the same reason.
    expect(second).toContain(en.accountParked)
    expect(second).not.toContain(en.accountHealthNormal)
    // Parked carries no state word at all — not even the neutral 尚未观测.
    expect(second).not.toContain(en.accountHealthUnknown)
  })

  it('states an unobserved seat as 尚未观测 in both pool views, never as 正常', async () => {
    // `withPool` stores two enabled seats and neither has a recorded failure.
    // Absent health is "nothing observed yet", not "observed healthy": the
    // composer panel already stays silent about that gap, and the two pool
    // views must not fill the silence with a claim the host never made.
    withPool()
    await mountWithSettings(fakeSettingsScope({ routingStrategy: 'custom', routingOrder: ['pat:aaaa', 'pat:bbbb'] }))
    const chips = view!.root.findAll(node =>
      node.props['className'] === 'qdp-tag' && node.children.join('') === en.accountHealthUnknown)
    // One chip per seat in the account list, and one per seat in the routing
    // list: the two views of the same pool say the same thing.
    expect(chips).toHaveLength(4)
    for (const chip of chips) {
      expect(chip.props['className']).not.toContain('qdp-tagSuccess')
      expect(chip.props['className']).not.toContain('qdp-tagWarn')
    }
    expect(rendered()).not.toContain(en.accountHealthNormal)
  })

  it('separates a standby automatic switch from one the user turned off', async () => {
    // A single seat with the preference still on: the pool cannot fail over, but
    // that is not the user's choice — saying 已关闭 would claim a decision the
    // user never made, and the settings switch beside it still reads 开.
    withPool({
      accounts: {
        entries: [
          { id: 'pat:aaaa', source: 'card', active: true, order: 1, patTail: 'aaaa' },
        ],
        autoFailover: false,
        autoFailoverEnabled: true,
      },
    })
    await mount()
    const text = rendered()
    expect(text).toContain(en.accountsFailoverIdle)
    expect(text).not.toContain(en.accountsFailoverOff)
  })

  it('says 自动切换已关闭 only when the preference itself is off', async () => {
    withPool({
      accounts: {
        entries: [
          { id: 'pat:aaaa', source: 'card', active: true, order: 1, patTail: 'aaaa' },
          { id: 'pat:bbbb', source: 'card', active: false, order: 2, patTail: 'bbbb' },
        ],
        autoFailover: false,
        autoFailoverEnabled: false,
      },
    })
    await mount()
    const text = rendered()
    expect(text).toContain(en.accountsFailoverOff)
    expect(text).not.toContain(en.accountsFailoverIdle)
  })

  it('lists the in-stream error counters the host observed, and hides zeroes', async () => {
    withPool({ innerErrors: { rate_limit: 2, content_policy: 1, auth: 0 } })
    await mount()
    const text = rendered()
    expect(text).toContain(en.innerErrorsHeading)
    expect(text).toContain('Rate limit 2')
    expect(text).toContain('Content policy 1')
    // A class that never occurred is noise, not a fact worth a row.
    expect(text).not.toContain('Auth 0')
  })

  it('renders no in-stream error caption when the process observed none', async () => {
    withPool({ innerErrors: { rate_limit: 0, content_policy: 0, auth: 0 } })
    await mount()
    expect(rendered()).not.toContain(en.innerErrorsHeading)
  })

  it('writes all three stickiness bounds on commit and clamps one outside them', async () => {
    const scope = fakeSettingsScope()
    await mountWithSettings(scope)
    const commit = async (label: string, value: string): Promise<void> => {
      const field = inputFor(label)
      await act(async () => { field.props.onChange({ target: { value } }) })
      await act(async () => { field.props.onBlur() })
    }
    await commit(en.stickinessRoundsLabel, '2')
    expect(scope.set).toHaveBeenCalledWith('stickinessRounds', 2)
    await commit(en.stickinessRequestsLabel, '120')
    expect(scope.set).toHaveBeenCalledWith('stickinessRequests', 120)
    // 99999 is past the card's 1440-minute ceiling; the host would refuse it,
    // so it is clamped rather than posted as though it had been recorded.
    await commit(en.stickinessMinutesLabel, '99999')
    expect(scope.set).toHaveBeenCalledWith('stickinessMinutes', 1440)
    expect(scope.set).not.toHaveBeenCalledWith('stickinessMinutes', 99999)
    await commit(en.stickinessMinutesLabel, '30')
    expect(scope.set).toHaveBeenCalledWith('stickinessMinutes', 30)
  })

  it('shows the three stickiness bounds with the host defaults', async () => {
    const scope = fakeSettingsScope()
    await mountWithSettings(scope)
    // The host defaults: 3 rounds, 200 requests, 180 minutes. A control that
    // rendered a different default would silently tell the user a number the
    // host is not using.
    expect(inputFor(en.stickinessRoundsLabel).props.value).toBe('3')
    expect(inputFor(en.stickinessRequestsLabel).props.value).toBe('200')
    expect(inputFor(en.stickinessMinutesLabel).props.value).toBe('180')
  })

  // ---- advanced card: the mixed-variant warning ------------------------------

  /**
   * Two pools that disagree about exactly one model: China serves `m3`, Global
   * does not. An order that interleaves them can therefore hand `m3` to a
   * variant that never offers it.
   *
   * The banner EXPLAINS that; it does not gate the write. The user asked for the
   * order, and the walk skips an account whose variant cannot serve the model,
   * so there is nothing to consent to and nothing to hold back.
   *
   * Last in the file on purpose: the store keeps a seeded Global document
   * between tests, so this one has to put the shared store back itself (the
   * `finally` block), and the card's own document is re-read on every mount.
   */
  it('explains a mixed-variant order and writes it straight through', async () => {
    withPool({
      models: [...MODELS, { id: 'm3', name: 'M3', contextWindow: 200_000, defaultContextWindow: 200_000 }],
      disabledModels: [],
    })
    noteQuotaStatus('qoder-global', {
      status: 'signed-in',
      pat: { source: 'card', patTail: 'gggg' },
      accounts: {
        entries: [{ id: 'pat:gggg', source: 'card', active: true, order: 1, accountName: 'Gina' }],
        autoFailover: true,
      },
      models: MODELS,
      disabledModels: [],
    } as unknown as QoderWebStatus)
    try {
      const scope = fakeSettingsScope({ routingStrategy: 'custom', routingOrder: ['pat:aaaa', 'pat:gggg'] })
      await mountWithSettings(scope)
      expect(rendered()).toContain(en.routingMixedHeading)
      expect(rendered()).toContain(t('routingMixedOffenderCN', { models: 'm3' }))
      // No consent control of any kind: the banner carries facts only.
      expect(view!.root.findAll(node => node.props['className'] === 'qdp-routingAck')).toEqual([])
      // The edit is written immediately, carrying the ids in the order the user
      // built rather than the order on the wire.
      await press(t('routingOrderMoveDownAria', { name: 'Alice' }))
      expect(scope.set).toHaveBeenCalledWith('routingOrder', ['pat:gggg', 'pat:aaaa', 'pat:bbbb'])
    } finally {
      noteQuotaStatus('qoder-global', { status: 'signed-out' } as unknown as QoderWebStatus)
      noteQuotaStatus('qoder', { status: 'signed-out' } as unknown as QoderWebStatus)
    }
  })
})
