import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  QODER_CN_CARD,
  QODER_GLOBAL_CARD,
  QoderPluginCard,
  type QoderCardVariant,
} from '../src/client/QoderPluginCard.tsx'
import { en } from '../src/client/locales.ts'
import type { QoderWebStatus } from '../src/status-paths.ts'

/**
 * Card tests for the PAT flow and the three-tab body.
 *
 * The card's job changed with the upstream: there is no browser sign-in flow
 * anymore, so the sensitive surface is the PAT entry — what it sends, which
 * header authorizes it, and what each host answer renders. The probe section
 * keeps its old regression (only the pressed row may claim to be running)
 * because the fix lives in this component, not the route.
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
  /**
   * The host's answer to the 「刷新模型」 action. Mutable because the route
   * reports a FAILED model refresh as HTTP 200 with `{state:'failed', reason}`
   * — the shape the card used to ignore.
   */
  let refreshReply: unknown = { state: 'refreshed', reason: '12 models' }

  function signedIn(overrides: Partial<QoderWebStatus> = {}): void {
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
    return { state: 'ok', validation: 'non-validating', efforts: [] }
  }

  afterEach(() => {
    act(() => view?.unmount())
    vi.unstubAllGlobals()
  })

  async function mount(variant?: QoderCardVariant): Promise<void> {
    const props = { t, ...variant === undefined ? {} : { variant } } as unknown as Parameters<typeof QoderPluginCard>[0]
    await act(async () => { view = create(createElement(QoderPluginCard, props)) })
    // 插件配置页由宿主画面包屑/图标/标题/版本/描述,卡片自己只渲染正文:
    // 恒为展开态,没有 disclosure 头可点。旧版本在这里点
    // findAllByType('button')[0] 把折叠卡片打开;现在第一个按钮属于正文,
    // 点了反而会误触(例如刷新)。这里改为断言正文容器与五个分区都在。
    expect(view!.root.findAll(n => n.props.className === 'qdp-card qdp-cardOpen')).toHaveLength(1)
    // 未登录时只有账户/额度/高级设置三个分区;登录后再加上使用与签到、模型。
    const titles = view!.root
      .findAll(n => n.props.className === 'qdp-sectionTitle')
      .map(node => node.children.join(''))
    expect(titles.slice(0, 2)).toEqual([en.accountHeading, en.creditsHeading])
    expect(titles).toContain(en.quotaSectionAdvanced)
    expect(view!.root.findAll(n => n.props.className === 'qdp-cardHeader')).toHaveLength(0)
  }

  /**
   * 「用量与签到」与「模型」现在是页面上并排的两个分区,不再是 pane tab:
   * 切页动作消失,只需确认该分区标题在同一棵树上。
   */
  const openPane = async (label: string): Promise<void> => {
    const titles = view!.root
      .findAll(n => n.props.className === 'qdp-sectionTitle')
      .map(node => node.children.join(''))
    expect(titles).toContain(label)
  }

  const buttonLabels = (): string[] => view!.root.findAllByType('button').map(node => node.children.join(''))
  const press = async (label: string, nth = 0): Promise<void> => {
    const matches = view!.root.findAllByType('button').filter(entry => entry.children.join('') === label)
    const node = matches[nth]
    if (node === undefined) throw new Error(`no button #${nth} "${label}"; have: ${buttonLabels().join(' | ')}`)
    await act(async () => { node.props.onClick() })
  }
  const inputs = () => view!.root.findAllByType('input')
  const typePat = async (value: string): Promise<void> => {
    const input = inputs()[0]
    if (input === undefined) throw new Error('no PAT input rendered')
    await act(async () => { input.props.onChange({ target: { value } }) })
  }
  /** Fire every held POST with the given reply body. */
  const releasePosts = async (reply: unknown): Promise<void> => {
    const pending = releaseQueue
    releaseQueue = []
    await act(async () => { for (const resolve of pending) resolve(reply) })
  }

  // ---- PAT entry (signed-out arm) ----------------------------------------

  it("shows the PAT entry only when the document carries this card's auth key", async () => {
    signedOut()
    await mount()
    expect(inputs()).toHaveLength(1)
    const input = inputs()[0]!
    expect(input.props.type).toBe('password')
    expect(input.props.placeholder).toBe(en.patPlaceholder)
    expect(input.props.value).toBe('')
    // Without a key the entry would POST into a 403 it cannot pass, so the
    // card withholds it entirely.
    signedOut({ authKey: undefined })
    await mount()
    expect(inputs()).toHaveLength(0)
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
    // save — and the entry gives way to the account body. (The 'PAT saved'
    // notice renders inside the entry itself, so it is the signed-in swap a
    // user actually sees as the success signal.)
    signedIn()
    await releasePosts({ ok: true, status: 'saved' })
    expect(inputs()).toHaveLength(0)
    expect(buttonLabels()).toContain(en.patRemove)
  })

  it('renders the stable refusal codes as the re-generate prompt, not raw wire text', async () => {
    signedOut()
    holdPosts = true
    await mount()
    await typePat('pt-dead')
    await press(en.patSave)
    await releasePosts({ ok: false, error: 'qoder_invalid_pat' })
    const tree = JSON.stringify(view!.toJSON())
    expect(tree).toContain(en.patInvalid)
    expect(tree).not.toContain('qoder_invalid_pat')
  })

  it('passes any other save failure through with its detail', async () => {
    signedOut()
    holdPosts = true
    await mount()
    await typePat('pt-x')
    await press(en.patSave)
    await releasePosts({ ok: false, error: 'disk on fire' })
    expect(JSON.stringify(view!.toJSON())).toContain(t('patSaveFailed', { message: 'disk on fire' }))
  })

  it('keeps Enter and clicking equivalent and lets the draft live only in state', async () => {
    signedOut()
    await mount()
    // Enter on an empty draft stays inert...
    await act(async () => { inputs()[0]!.props.onKeyDown({ key: 'Enter', preventDefault: () => {} }) })
    expect(posts).toHaveLength(0)
    // ...and the next Enter carries the then-current draft: re-read the props
    // after the change, since the previous handler closes over the old state.
    await typePat('pt-enter')
    await act(async () => { inputs()[0]!.props.onKeyDown({ key: 'Enter', preventDefault: () => {} }) })
    expect(posts).toHaveLength(1)
    expect(JSON.parse(String(posts[0]!.init.body))).toEqual({ action: 'save-pat', pat: 'pt-enter' })
  })

  // ---- signed-in arm: summary, replace, clear ------------------------------

  it('summarizes the credential in effect without ever spelling the token', async () => {
    await mount()
    const tree = JSON.stringify(view!.toJSON())
    expect(tree).toContain(t('patTail', { tail: '****abcd' }))
    expect(tree).toContain(en.patSourceCard)
    expect(tree).not.toContain('pt-test')
    // 账户分区的动作行同时给出「更换」与「删除」:两者都已接线路由,
    // 删除仍要过内联确认。
    expect(buttonLabels()).toContain(en.patRemove)
    expect(buttonLabels()).toContain(en.patReplace)
  })

  it('Remove PAT arms a cancellable confirm over the live document', async () => {
    await mount()
    await press(en.patRemove)
    // The confirm row replaces the PAT box; cancel returns to it.
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
    expect(inputs()).toHaveLength(1) // signed-out arm with an authKey re-offers entry
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

  // ---- context tab: maximum-window preference -------------------------------

  it('offers the per-model window chooser on the Models pane, a route write', async () => {
    statusBody = {
      status: 'signed-in',
      probeKey: 'test-probe-key',
      authKey: 'test-auth-key',
      models: [{ id: 'm1', name: 'M1', contextWindow: 200_000, supportedContextWindows: [200_000, 1_000_000] }],
    }
    await mount()
    await openPane(en.paneModels)
    // The slider's value is the INDEX into [origin, ...declared], so the
    // first real size of [200K, 1M] sits at 1 — but what it posts is the
    // size itself, never the index.
    const slider = view!.root.findAllByType('input').filter(node => node.props.type === 'range')[0]
    expect(slider).toBeDefined()
    expect(slider!.props.value).toBe(1)
    await act(async () => { slider!.props.onChange({ currentTarget: { value: '2' } }) })
    expect(posts).toHaveLength(1)
    expect(JSON.parse(String(posts[0]!.init.body))).toEqual({ action: 'set-model-context-window', model: 'm1', window: 1_000_000 })
  })

  it('offers only the windows the upstream declared, as slider stops', async () => {
    statusBody = {
      status: 'signed-in',
      probeKey: 'test-probe-key',
      authKey: 'test-auth-key',
      models: [{ id: 'm1', name: 'M1', contextWindow: 200_000, supportedContextWindows: [200_000, 1_000_000] }],
    }
    await mount()
    await openPane(en.paneModels)
    const slider = view!.root.findAllByType('input').filter(node => node.props.type === 'range')[0]
    expect(slider).toBeDefined()
    // Exactly one stop per declared size, plus the origin at 0 (which only
    // widens the track — it is not a reachable size). No intermediate token
    // counts are reachable, which is the guarantee the old <select> gave.
    expect(slider!.props.min).toBe(0)
    expect(slider!.props.max).toBe(2)
    // The tick labels name the sizes, ascending.
    const tree = JSON.stringify(view!.toJSON())
    expect(tree).toContain('200K')
    expect(tree).toContain('1M')
  })

  it('still draws a track for a single declared size, unwritable', async () => {
    statusBody = {
      status: 'signed-in',
      probeKey: 'test-probe-key',
      authKey: 'test-auth-key',
      models: [{ id: 'm1', name: 'M1', contextWindow: 200_000, supportedContextWindows: [200_000] }],
    }
    await mount()
    await openPane(en.paneModels)
    // One declared size used to fall back to a plain text label, which read
    // as "the control is gone". With the origin stop there is always a track;
    // the handle parks on the only real size and dragging to the origin (or
    // anywhere) writes nothing, because there is no other size to reach.
    const slider = view!.root.findAllByType('input').filter(node => node.props.type === 'range')[0]
    expect(slider).toBeDefined()
    expect(slider!.props.value).toBe(1)
    expect(slider!.props.max).toBe(1)
    await act(async () => { slider!.props.onChange({ currentTarget: { value: '0' } }) })
    expect(posts).toHaveLength(0)
    // The size is still labelled, ascending, and the origin prints no digit.
    const tree = JSON.stringify(view!.toJSON())
    expect(tree).toContain('200K')
    expect(tree).not.toContain('>0<')
  })

  // ---- tabbed body -----------------------------------------------------------

  it('renders quota detail and context on the one page', async () => {
    statusBody = {
      status: 'signed-in',
      probeKey: 'test-probe-key',
      authKey: 'test-auth-key',
      credits: {
        total: 25,
        accounts: [
          { packageName: '个人额度', remain: 75, size: 100 },
          { packageName: '组织资源包', remain: 0, size: 50 },
          { packageName: 'Unbounded', remain: 5, size: 0, unlimited: true },
        ],
      },
      models: [
        { id: 'm1', name: 'M1', contextWindow: 200_000, defaultContextWindow: 128_000, supportedContextWindows: [128_000, 1_000_000] },
      ],
    }
    await mount()
    // The Usage pane carries the cycle summary and the package bars.
    let tree = JSON.stringify(view!.toJSON())
    // The exhausted package is dropped; the unknown-size one renders unlimited copy.
    expect(tree).toContain(t('exactRemaining', { remain: '75', size: '100' }))
    expect(tree).not.toContain('组织资源包')
    expect(tree).toContain(en.unlimitedQuota)
    // The Models pane carries the per-model window slider beside the toggles.
    await openPane(en.paneModels)
    tree = JSON.stringify(view!.toJSON())
    // The fixture's effective window (200K) is not one of the declared stops
    // ([128K, 1M]), so the handle parks on the nearest declared one. Its label
    // is the stop the slider can actually reach, not the out-of-list value.
    expect(tree).toContain('128K')
    expect(tree).toContain('1M')
    expect(view!.root.findAllByType('input').filter(node => node.props.type === 'range')).toHaveLength(1)
  })

  it('offers the per-model window chooser on the Global card, a route write', async () => {
    statusBody = {
      status: 'signed-in',
      probeKey: 'test-probe-key',
      authKey: 'test-auth-key',
      models: [{ id: 'm1', name: 'M1', contextWindow: 200_000, supportedContextWindows: [200_000, 1_000_000] }],
    }
    await mount(QODER_GLOBAL_CARD)
    await openPane(en.paneModels)
    const slider = view!.root.findAllByType('input').filter(node => node.props.type === 'range')[0]
    expect(slider).toBeDefined()
    await act(async () => { slider!.props.onChange({ currentTarget: { value: '2' } }) })
    expect(posts).toHaveLength(1)
    expect(posts[0]!.url).toBe(QODER_GLOBAL_CARD.probePath)
    expect(JSON.parse(String(posts[0]!.init.body))).toEqual({ action: 'set-model-context-window', model: 'm1', window: 1_000_000 })
  })

  // ---- read failures ----------------------------------------------------------

  it('reports a failed refresh beside the document it cannot replace', async () => {
    await mount()
    statusFails = true
    await press(en.refresh)
    const tree = JSON.stringify(view!.toJSON())
    expect(tree).toContain(en.statusRefreshFailed.split('{message}')[0]!)
    expect(tree).toContain(en.signedIn) // the document is still rendered
  })

  it('surfaces the reason when the MODEL refresh reports a failure in a 200 body', async () => {
    /*
     * The route answers HTTP 200 with `{state:'failed', reason}` for a refresh
     * that could not reach the upstream. Checking `response.ok` alone — what
     * the card used to do — threw nothing and said nothing, so the user saw
     * stale models and a failure with no explanation. The reason must reach
     * the screen.
     */
    await mount()
    await openPane(en.paneModels)
    refreshReply = { state: 'failed', reason: 'Qoder model discovery network request failed.' }
    await press(en.refreshModels)
    const tree = JSON.stringify(view!.toJSON())
    expect(tree).toContain('Qoder model discovery network request failed.')
    expect(tree).toContain(en.statusRefreshFailed.split('{message}')[0]!)
  })

  it('keeps a successful model refresh quiet', async () => {
    await mount()
    await openPane(en.paneModels)
    refreshReply = { state: 'refreshed', reason: '12 models' }
    await press(en.refreshModels)
    const tree = JSON.stringify(view!.toJSON())
    // No error line, and the host's internal count is not shown as a message.
    expect(tree).not.toContain(en.statusRefreshFailed.split('{message}')[0]!)
    expect(tree).not.toContain('12 models')
  })

  it('falls back to the generic label when a failed refresh gives no reason', async () => {
    await mount()
    await openPane(en.paneModels)
    refreshReply = { state: 'failed' }
    await press(en.refreshModels)
    const tree = JSON.stringify(view!.toJSON())
    expect(tree).toContain(en.requestFailed)
  })

  it('turns an unreadable 200 into the error arm rather than dereferencing it', async () => {
    statusBody = null
    await mount()
    const tree = JSON.stringify(view!.toJSON())
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
    const asked = (await vi.mocked(fetch).mock.calls).map(call => String(call[0]))
    expect(asked).toContain(QODER_GLOBAL_CARD.statusPath)
    const tree = JSON.stringify(view!.toJSON())
    // 标题/图标/描述归宿主详情页,组件只画正文;Global 变体自己的文案
    // 落在正文里 —— PAT 指引与占位符。
    expect(tree).toContain(en.patGuideAI)
    expect(tree).toContain(en.patPlaceholderAI)
    expect(tree).not.toContain('qoder.com.cn')
  })
})
