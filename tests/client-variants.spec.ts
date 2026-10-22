import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { QoderProbeControl, cardVariantFor, type QoderProbeControlProps } from '../src/client/QoderProbeControl.tsx'
import {
  QODER_CARD_VARIANTS,
  QODER_CN_CARD,
  QODER_GLOBAL_CARD,
  QoderPluginCard,
  type QoderCardVariant,
  type QoderPluginCardProps,
} from '../src/client/QoderPluginCard.tsx'
import { en, zh } from '../src/client/locales.ts'
import type { QoderSettingsKey } from '../src/client/locales.ts'
import {
  QODER_AUTH_PATH,
  QODER_GLOBAL_AUTH_PATH,
  QODER_GLOBAL_PROBE_PATH,
  QODER_GLOBAL_STATUS_PATH,
  QODER_PROBE_PATH,
  QODER_STATUS_PATH,
} from '../src/status-paths.ts'

/**
 * Two-product client behaviour. The card component and the composer control are
 * shared by both providers, so these tests cover the ways one product's state
 * could leak into the other's surface: a wrong route, a wrong title, or a PAT
 * saved for the wrong product. The auth arm is the PAT entry — the card's only
 * credential action — so the variant-specific guide line, placeholder, and
 * auth route are asserted here too.
 */

const t = (key: QoderSettingsKey, params: Record<string, unknown> = {}): string =>
  Object.entries(params).reduce(
    (text, [name, value]) => text.replace(`{${name}}`, String(value)),
    en[key] as string,
  )

describe('card variants', () => {
  it('exposes one card per provider, with distinct routes and copy', () => {
    expect(QODER_CARD_VARIANTS).toHaveLength(2)
    expect(QODER_CARD_VARIANTS.map(card => card.id)).toEqual(['qoder', 'qoder-global'])
    const routes = QODER_CARD_VARIANTS.map(card => `${card.statusPath}|${card.probePath}|${card.authPath}`)
    expect(new Set(routes).size).toBe(2)
    // Distinct title/intro/hint/PAT-guide keys, so one product's copy cannot
    // appear as the other's.
    expect(QODER_GLOBAL_CARD.titleKey).not.toBe(QODER_CN_CARD.titleKey)
    expect(QODER_GLOBAL_CARD.introKey).not.toBe(QODER_CN_CARD.introKey)
    expect(QODER_GLOBAL_CARD.signedOutKey).not.toBe(QODER_CN_CARD.signedOutKey)
    expect(QODER_GLOBAL_CARD.patGuideKey).not.toBe(QODER_CN_CARD.patGuideKey)
    expect(QODER_GLOBAL_CARD.patPlaceholderKey).not.toBe(QODER_CN_CARD.patPlaceholderKey)
  })

  it('points each card at its variant\'s own triple of routes', () => {
    // The routes are the single source of the split: a card reading the other
    // variant's auth path would store a token on the wrong product.
    expect(QODER_CN_CARD).toMatchObject({
      id: 'qoder',
      statusPath: QODER_STATUS_PATH,
      probePath: QODER_PROBE_PATH,
      authPath: QODER_AUTH_PATH,
    })
    expect(QODER_GLOBAL_CARD).toMatchObject({
      id: 'qoder-global',
      statusPath: QODER_GLOBAL_STATUS_PATH,
      probePath: QODER_GLOBAL_PROBE_PATH,
      authPath: QODER_GLOBAL_AUTH_PATH,
    })
  })

  it('routes each provider id to its own card and nothing else', () => {
    expect(cardVariantFor('qoder')).toBe(QODER_CN_CARD)
    expect(cardVariantFor('qoder-global')).toBe(QODER_GLOBAL_CARD)
    // Any other provider resolves to no card, which is what keeps the composer
    // entry off non-Qoder models.
    expect(cardVariantFor('deepseek')).toBeUndefined()
    expect(cardVariantFor('')).toBeUndefined()
  })

  it('has copy for both products in both languages', () => {
    for (const card of QODER_CARD_VARIANTS) {
      expect(zh[card.titleKey]).toBeTruthy()
      expect(zh[card.introKey]).toBeTruthy()
      expect(zh[card.signedOutKey]).toBeTruthy()
      expect(zh[card.patGuideKey]).toBeTruthy()
      expect(zh[card.patPlaceholderKey]).toBeTruthy()
      // The two titles must actually differ in each language, not just be
      // distinct keys with identical text.
      expect(zh[card.titleKey]).toContain(card.id === 'qoder-global' ? '国际版' : '国内版')
    }
    expect(zh.titleAI).not.toBe(zh.title)
    expect(en.titleAI).not.toBe(en.title)
  })

  it('names the right site in each PAT guide and placeholder', () => {
    // The card is the only place a user learns where to mint the token, so the
    // China arm must say qoder.com.cn and the global arm qoder.com.
    expect(en[QODER_CN_CARD.patGuideKey]).toContain('qoder.com.cn')
    expect(en[QODER_CN_CARD.patPlaceholderKey]).toContain('qoder.com.cn')
    expect(en[QODER_GLOBAL_CARD.patGuideKey]).toContain('qoder.com')
    expect(en[QODER_GLOBAL_CARD.patPlaceholderKey]).toContain('qoder.com')
    expect(en[QODER_GLOBAL_CARD.patGuideKey]).not.toContain('qoder.com.cn')
    expect(zh[QODER_CN_CARD.patGuideKey]).toContain('qoder.com.cn')
    expect(zh[QODER_GLOBAL_CARD.patGuideKey]).toContain('qoder.com')
  })

  it('carries the PAT semantic key group in both languages', () => {
    // The WorkBuddy-era sign-in / credential-import copy is gone; these are the
    // keys the PAT arm renders, so a missing one is a crash at first paint.
    const patKeys = [
      'patHeading', 'patGuide', 'patGuideAI', 'patPlaceholder', 'patPlaceholderAI',
      'patSave', 'patSaving', 'patSaved', 'patSaveFailed', 'patInvalid',
      'patReplace', 'patClear', 'patClearing',
      'patSourceCard', 'patSourceEnv', 'patSourceCli', 'patSavedAt', 'patTail',
    ] as const satisfies readonly QoderSettingsKey[]
    for (const key of patKeys) {
      expect(en[key]).toBeTruthy()
      expect(zh[key]).toBeTruthy()
    }
  })

  it('carries the account-pool and upstream-notice key groups in both languages', () => {
    // The pool and the notice are the two surfaces added for account failover.
    // Every key here is rendered by the card whenever the host serves a pool or
    // records an upstream refusal, so a missing zh string would ship a blank
    // row to half the users.
    const poolKeys = [
      'accountsHeading', 'accountsHint', 'accountsFailoverOn', 'accountsFailoverOff',
      'accountsLastFailover', 'accountsLastFailoverReason', 'accountSlot',
      'accountCurrent', 'accountSwitch', 'accountSwitchAria', 'patRemove',
      'accountRemoveAria', 'accountRemoveConfirm', 'accountRemoveConfirmYes',
      'accountAdd', 'accountSwitched', 'accountRemoved', 'accountActionFailed',
    ] as const satisfies readonly QoderSettingsKey[]
    const noticeKeys = [
      'upstreamNoticeKindQueued', 'upstreamNoticeKindUnavailable',
      'upstreamNoticeHeading', 'upstreamNoticeAt', 'upstreamNoticeMessage',
      'upstreamNoticeWaited', 'upstreamNoticeWaitedNoDelay', 'upstreamNoticeRetry',
      'upstreamNoticeNotAuth', 'upstreamNoticeAdvice', 'upstreamNoticeRecurrence',
    ] as const satisfies readonly QoderSettingsKey[]
    for (const key of [...poolKeys, ...noticeKeys]) {
      expect(en[key]).toBeTruthy()
      expect(zh[key]).toBeTruthy()
    }

    // The interpolated strings must keep their placeholders in BOTH languages —
    // the card fills them positionally, so a dropped `{seconds}` would render a
    // sentence with no number rather than fail loudly.
    for (const key of ['upstreamNoticeWaited', 'upstreamNoticeRetry'] as const) {
      expect(en[key]).toContain('{seconds}')
      expect(zh[key]).toContain('{seconds}')
    }
    for (const key of ['accountSwitchAria', 'accountRemoveAria', 'accountSwitched'] as const) {
      expect(en[key]).toContain('{name}')
      expect(zh[key]).toContain('{name}')
    }
    expect(en.accountActionFailed).toContain('{message}')
    expect(zh.accountActionFailed).toContain('{message}')
    expect(en.upstreamNoticeMessage).toContain('{message}')
    expect(zh.upstreamNoticeMessage).toContain('{message}')

    // Real translations, not the English text copied into the Chinese map.
    expect(zh.accountsHeading).not.toBe(en.accountsHeading)
    expect(zh.upstreamNoticeNotAuth).not.toBe(en.upstreamNoticeNotAuth)
  })
})

describe('plugin card per variant', () => {
  let view: ReactTestRenderer | undefined
  let statusBody: Record<string, unknown>
  /** Resolvers for in-flight auth POSTs, so "validating PAT" is observable. */
  let pendingAuth: (() => void)[] = []
  /** The auth route's JSON verdict (`{ ok }` or `{ ok: false, error }`). */
  let authAnswer: () => unknown = () => ({ ok: true })
  /** Whether the auth route answers at the HTTP level: a 5xx is not a verdict. */
  let authHttpOk = true
  const request = vi.fn()

  /** A signed-in document for the variant, with the PAT summary the card shows. */
  function signedIn(overrides: Record<string, unknown> = {}): void {
    statusBody = {
      status: 'signed-in',
      region: 'china',
      pat: { source: 'card', savedAtMs: Date.UTC(2026, 8, 12, 8, 30), patTail: 'abcd' },
      authKey: 'auth-key',
      probeKey: 'probe-key',
      credits: { total: 40, accounts: [] },
      models: [],
      ...overrides,
    }
  }

  beforeEach(() => {
    signedIn()
    pendingAuth = []
    authAnswer = () => ({ ok: true })
    authHttpOk = true
    request.mockReset().mockImplementation(async (_url: string, init?: RequestInit) => {
      if (init?.method !== 'POST') return { ok: true, json: async () => statusBody }
      const path = String(_url)
      if (!path.endsWith('/auth')) {
        return { ok: true, json: async () => ({ state: 'ok', validation: 'non-validating', efforts: [] }) }
      }
      // Hold the auth POST open, so the pending label is observable rather than
      // a race against the microtask queue.
      await new Promise<void>(resolve => { pendingAuth.push(resolve) })
      return {
        ok: authHttpOk,
        status: authHttpOk ? 200 : 500,
        json: async () => authAnswer(),
      }
    })
    vi.stubGlobal('fetch', request)
    // 「更换 PAT」 focuses the field through rAF; the stub never runs the callback,
    // which keeps react-test-renderer's ref (a TestInstance with no focus()) out
    // of the way.
    vi.stubGlobal('requestAnimationFrame', () => 1)
    vi.stubGlobal('window', {
      setInterval: () => 1,
      clearInterval: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      requestAnimationFrame: () => 1,
    })
  })

  afterEach(() => {
    act(() => view?.unmount())
    vi.unstubAllGlobals()
  })

  async function mount(variant?: QoderCardVariant): Promise<void> {
    await act(async () => {
      // The card reads `t` and `variant`; the remaining props belong to the slot
      // that mounts it in DSH, so the test supplies only what it uses.
      const props = {
        t: t as QoderPluginCardProps['t'],
        // The Plugins page renders the card as its configuration page; the
        // owner draws the title and opened it, so there is nothing to expand.
        view: 'page' as const,
        ...variant === undefined ? {} : { variant },
      } as unknown as Parameters<typeof QoderPluginCard>[0]
      view = create(createElement(QoderPluginCard, props))
    })
  }

  const buttonLabels = (): string[] => view!.root.findAllByType('button').map(node => node.children.join(''))
  const press = async (label: string, nth = 0): Promise<void> => {
    // The page's refresh control is an icon button: its accessible name (not
    // its glyph) is the stable label, so match that too.
    const matches = view!.root.findAllByType('button')
      .filter(node => node.children.join('') === label || node.props['aria-label'] === label)
    const node = matches[nth]
    if (node === undefined) throw new Error(`no button #${nth} labelled ${label}; have: ${buttonLabels().join(' | ')}`)
    await act(async () => { node.props.onClick() })
  }
  const patInputs = () => view!.root.findAllByType('input').filter(node => node.props.type === 'password')
  /** POSTs to a variant's auth route, with their parsed bodies. */
  const posts = (path: string) => request.mock.calls
    .filter(([url, init]) => String(url) === path && init?.method === 'POST')
    .map(([, init]) => JSON.parse(String((init as { body: string }).body)) as Record<string, unknown>)
  const typePat = async (value: string): Promise<void> => {
    const input = patInputs()[0]
    if (input === undefined) throw new Error('no PAT input rendered')
    await act(async () => { input.props.onChange({ target: { value } }) })
  }

  it('reads the CN route by default', async () => {
    await mount()
    expect(request.mock.calls[0]![0]).toBe(QODER_CN_CARD.statusPath)
    // Every request this card makes must stay on its own variant's route: the
    // title it used to render is gone (the Plugins page heads the page from the
    // package manifest), so route discipline is what identifies the variant now.
    for (const call of request.mock.calls) expect(call[0]).toBe(QODER_CN_CARD.statusPath)
    expect(QODER_CN_CARD.statusPath).not.toBe(QODER_GLOBAL_CARD.statusPath)
  })

  it('reads the Global route when handed that variant', async () => {
    await mount(QODER_GLOBAL_CARD)
    // The critical assertion: the card must not read the CN status document,
    // which would show the other product's account and balance.
    expect(request.mock.calls[0]![0]).toBe(QODER_GLOBAL_CARD.statusPath)
    for (const call of request.mock.calls) expect(call[0]).not.toBe(QODER_CN_CARD.statusPath)
  })

  it('reports the PAT source and redacted tail instead of a token', async () => {
    await mount()
    const rendered = JSON.stringify(view!.toJSON())
    expect(rendered).toContain(en.patSourceCard)
    expect(rendered).toContain('****abcd')
    // An env-sourced credential is labelled as such, so a user can tell where
    // to change it.
    signedIn({ pat: { source: 'env', patTail: '1234' } })
    await press(en.refresh)
    expect(JSON.stringify(view!.toJSON())).toContain(en.patSourceEnv)
  })

  it('saves the PAT to its own variant route, under the auth key', async () => {
    statusBody = { status: 'signed-out', authKey: 'auth-key' }
    await mount(QODER_GLOBAL_CARD)
    await typePat('  pat-from-global-account  ')
    await press(en.patSave)
    // The pending label while the host validates.
    expect(buttonLabels()).toContain(en.patSaving)
    await act(async () => { for (const release of pendingAuth.splice(0)) release() })
    const bodies = posts(QODER_GLOBAL_AUTH_PATH)
    expect(bodies).toHaveLength(1)
    // Trimmed before posting, and never to the CN route: a global token saved
    // for the China product would silently authenticate the wrong account.
    expect(bodies[0]).toEqual({ action: 'save-pat', pat: 'pat-from-global-account' })
    expect(posts(QODER_AUTH_PATH)).toHaveLength(0)
    const headers = request.mock.calls.find(([url, init]) => String(url) === QODER_GLOBAL_AUTH_PATH && init?.method === 'POST')![1] as RequestInit
    expect((headers.headers as Record<string, string>)['X-Qoder-Auth-Key']).toBe('auth-key')
    expect(JSON.stringify(view!.toJSON())).toContain(en.patSaved)
  })

  it('shows the localized rejection for qoder_invalid_pat, keeping the draft', async () => {
    statusBody = { status: 'signed-out', authKey: 'auth-key' }
    authAnswer = () => ({ ok: false, error: 'qoder_invalid_pat' })
    await mount(QODER_CN_CARD)
    await typePat('bogus')
    await press(en.patSave)
    await act(async () => { for (const release of pendingAuth.splice(0)) release() })
    const rendered = JSON.stringify(view!.toJSON())
    expect(rendered).toContain(en.patInvalid)
    // The stable code is a wire detail; the user reads the re-generate prompt.
    expect(rendered).not.toContain('qoder_invalid_pat')
    expect(patInputs()[0]!.props.value).toBe('bogus')
  })

  it('treats a missing token the same way as a rejected one', async () => {
    // Both stable codes mean "paste a real PAT"; neither is a transport error.
    statusBody = { status: 'signed-out', authKey: 'auth-key' }
    authAnswer = () => ({ ok: false, error: 'qoder_missing_pat' })
    await mount(QODER_CN_CARD)
    await typePat('x')
    await press(en.patSave)
    await act(async () => { for (const release of pendingAuth.splice(0)) release() })
    expect(JSON.stringify(view!.toJSON())).toContain(en.patInvalid)
  })

  it('names the transport failure instead of claiming the token was rejected', async () => {
    statusBody = { status: 'signed-out', authKey: 'auth-key' }
    authHttpOk = false
    authAnswer = () => ({})
    await mount(QODER_CN_CARD)
    await typePat('some-pat')
    await press(en.patSave)
    await act(async () => { for (const release of pendingAuth.splice(0)) release() })
    const rendered = JSON.stringify(view!.toJSON())
    expect(rendered).toContain(t('patSaveFailed', { message: 'HTTP 500' }))
    expect(rendered).not.toContain(en.patInvalid)
    // The paste survives a failed request: retyping a long token is the user's loss.
    expect(patInputs()[0]!.props.value).toBe('some-pat')
  })

  it('sends nothing while the PAT field is blank', async () => {
    statusBody = { status: 'signed-out', authKey: 'auth-key' }
    await mount(QODER_CN_CARD)
    const save = view!.root.findAllByType('button').find(node => node.children.join('') === en.patSave)!
    expect(save.props.disabled).toBe(true)
    await act(async () => { save.props.onClick() })
    expect(posts(QODER_AUTH_PATH)).toHaveLength(0)
  })

  it('removes the stored PAT from the signed-in arm after confirming', async () => {    await mount()
    // The destructive remove confirms inline before it posts.
    await press(en.patRemove)
    expect(posts(QODER_AUTH_PATH)).toEqual([])
    await press(en.patClearConfirmYes)
    await act(async () => { for (const release of pendingAuth.splice(0)) release() })
    expect(posts(QODER_AUTH_PATH)).toContainEqual({ action: 'clear' })
  })

  it('shows the variant-specific PAT hint when signed out', async () => {
    statusBody = { status: 'signed-out', authKey: 'auth-key' }
    await mount(QODER_GLOBAL_CARD)
    const rendered = JSON.stringify(view!.toJSON())
    expect(rendered).toContain(en.signedOutHintAI)
    expect(rendered).toContain(en[QODER_GLOBAL_CARD.patGuideKey])
    // The entry belongs to this card: the placeholder names qoder.com, not the
    // China site.
    expect(patInputs()[0]!.props.placeholder).toBe(en[QODER_GLOBAL_CARD.patPlaceholderKey])
  })

  it('shows a diagnosable sign-out reason instead of the generic hint', async () => {
    statusBody = {
      status: 'signed-out',
      authKey: 'auth-key',
      reason: 'Qoder Global found a China-region credential in its file — save a Global PAT',
    }
    await mount(QODER_GLOBAL_CARD)
    const rendered = JSON.stringify(view!.toJSON())
    expect(rendered).toContain('found a China-region credential')
    // Telling the user to sign in is wrong advice when a path is what is broken.
    expect(rendered).not.toContain(en.signedOutHintAI)
  })

  it('renders no PAT entry without an auth key', async () => {
    // The key is what authorizes the write; without it the input would be a
    // field that can only ever fail.
    statusBody = { status: 'signed-out' }
    await mount(QODER_CN_CARD)
    expect(patInputs()).toHaveLength(0)
    expect(JSON.stringify(view!.toJSON())).toContain(en.signedOutHint)
  })
})

describe('composer control provider routing', () => {
  let view: ReactTestRenderer | undefined
  let state: ReturnType<QoderProbeControlProps['directory']['getSnapshot']>
  const listeners = new Set<() => void>()
  const request = vi.fn()
  let statusBody: Record<string, unknown>
  const directory = {
    getSnapshot: () => state,
    subscribe: (listener: () => void) => { listeners.add(listener); return () => listeners.delete(listener) },
  } as QoderProbeControlProps['directory']

  function select(provider: string, model: string): void {
    state = { current: { provider, model }, status: 'ready', groups: [], failures: [], error: null, routable: true }
    listeners.forEach(listener => listener())
  }

  beforeEach(() => {
    statusBody = {
      status: 'signed-in',
      probeKey: 'test-key',
      probe: { consent: true, running: false, candidates: ['qoder-reasoning'], results: [] },
    }
    select('qoder', 'qoder-reasoning')
    request.mockReset().mockImplementation(async () => ({ ok: true, json: async () => statusBody }))
    vi.stubGlobal('fetch', request)
    vi.stubGlobal('window', {
      setInterval: () => 1,
      clearInterval: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
    })
  })

  afterEach(() => {
    act(() => view?.unmount())
    vi.unstubAllGlobals()
    listeners.clear()
  })

  async function mount(): Promise<void> {
    await act(async () => {
      view = create(createElement(QoderProbeControl, { directory, t: t as QoderProbeControlProps['t'] }))
    })
  }

  const posts = () => request.mock.calls.filter(([, init]) => init?.method === 'POST')

  it('reads the CN status route for a CN model', async () => {
    await mount()
    expect(request.mock.calls[0]![0]).toBe(QODER_CN_CARD.statusPath)
  })

  it('reads the Global status route for a Global model', async () => {
    select('qoder-global', 'qoder-reasoning')
    await mount()
    // Same model id on both endpoints, so only the provider can decide which
    // document holds this model's state.
    expect(request.mock.calls[0]![0]).toBe(QODER_GLOBAL_CARD.statusPath)
  })

  it('posts a detection to the selected provider route only', async () => {
    select('qoder-global', 'qoder-reasoning')
    await mount()
    // Confirm, then run.
    const buttons = view!.root.findAllByType('button')
    await act(async () => { buttons[0]!.props.onClick() })
    const confirm = view!.root.findAllByType('button').find(node => node.children.join('') === en.probeConfirmAction)
    await act(async () => { confirm!.props.onClick() })
    expect(posts()).toHaveLength(1)
    expect(posts()[0]![0]).toBe(QODER_GLOBAL_CARD.probePath)
    expect(posts()[0]![0]).not.toBe(QODER_CN_CARD.probePath)
  })

  it('does not show for a non-Qoder provider', async () => {
    select('deepseek', 'qoder-reasoning')
    await mount()
    expect(view?.toJSON()).toBeNull()
    expect(request).not.toHaveBeenCalled()
  })
})
