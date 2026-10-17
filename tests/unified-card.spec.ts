import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { QoderPluginCard, type QoderPluginCardProps } from '../src/client/QoderPluginCard.tsx'
import { QuotaSettingsContent } from '../src/client/QuotaSettingsCard.tsx'
import { SidebarQuotaCard } from '../src/client/SidebarQuotaCard.tsx'
import { en, zh } from '../src/client/locales.ts'
import type { QoderSettingsKey } from '../src/client/locales.ts'
import { noteQuotaSignIn, noteQuotaStatus, setQuotaToggles } from '../src/client/quota-settings-store.ts'
import { QODER_AUTH_PATH, QODER_GLOBAL_AUTH_PATH, QODER_GLOBAL_STATUS_PATH, QODER_STATUS_PATH } from '../src/status-paths.ts'

const t = (key: QoderSettingsKey, params: Record<string, unknown> = {}): string =>
  Object.entries(params).reduce(
    (text, [name, value]) => text.replace(`{${name}}`, String(value)),
    en[key] as string,
  )

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
          json: async () => ({
            status: 'signed-out',
            region: 'global',
            authKey: 'global-auth-key',
          }),
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
    setQuotaToggles(false, false)
    noteQuotaSignIn('qoder', false)
    noteQuotaSignIn('qoder-global', false)
    vi.unstubAllGlobals()
  })

  async function mountUnified(): Promise<void> {
    const fakeScope = {
      getSnapshot: () => ({
        status: 'ready' as const,
        writable: true,
        value: { sidebarQuotaCN: true, sidebarQuotaGlobal: false, quotaPollMs: 300_000 },
      }),
      subscribe: () => () => {},
      set: vi.fn(),
    }
    const props = {
      t: t as QoderPluginCardProps['t'],
      // The card is the Plugins page's configuration PAGE now, not a collapsed
      // card: the owner already drew the title and the disclosure affordance.
      view: 'page' as const,
      unified: true,
      scope: fakeScope as any,
      signedIn: () => ({ cn: true, global: false }),
    } as unknown as Parameters<typeof QoderPluginCard>[0]
    await act(async () => {
      view = create(createElement(QoderPluginCard, props))
    })
  }

  it('draws the body-only configuration on the page view, and only the one-liner on the summary view', async () => {
    await mountUnified()
    const json = JSON.stringify(view!.toJSON())
    // 插件详情页的标题/图标/描述由宿主画:本组件不再画 disclosure 头,
    // 也不再重复一遍 intro 文案。
    expect(json).not.toContain(en.unifiedIntro)
    expect(view!.root.findAll(n => n.props.className === 'qdp-cardHeader')).toHaveLength(0)
    expect(json).not.toContain('aria-expanded')
    // 正文:恒展开的容器 + 五个分区(账户/额度/使用与签到/模型/高级设置)。
    const root = view!.root.findAll(n => typeof n.props.className === 'string' && n.props.className.includes('qdp-card '))[0]
    expect(root!.props.className).toContain('qdp-cardOpen')
    expect(view!.root.findAll(n => n.props.className === 'qdp-section')).toHaveLength(5)
    // 变体切换只剩一层 tablist,且恰好一个 tab 处于选中态。
    expect(view!.root.findAllByProps({ 'aria-selected': true })).toHaveLength(1)
  })

  it('renders usage and models side by side on one page — there is no pane to switch', async () => {
    await mountUnified()
    const json = JSON.stringify(view!.toJSON())
    // 旧的 pane tab 已删:两个分区与高级设置同时挂载,不需要切页/展开。
    expect(view!.root.findAll(n => n.props.role === 'tab' && n.children.includes(en.paneModels))).toHaveLength(0)
    expect(json).toContain(en.ledgerHeading)
    expect(view!.root.findAll(n => n.props.className === 'qdp-sectionTitle').map(node => node.children.join('')))
      .toEqual([en.accountHeading, en.creditsHeading, en.quotaSectionUsage, en.paneModels, en.quotaSectionAdvanced])
    expect(json).toContain(en.quotaPollLabel)
    expect(json).toContain(en.patBoxLabel)
  })

  it('labels the variant switcher for assistive tech', async () => {
    await mountUnified()
    const tabList = view!.root.find(n => n.props.role === 'tablist' && n.props['aria-label'] === 'Qoder Version Selection')
    const tabs = tabList.findAllByType('button')
    expect(tabs).toHaveLength(2)
    // 选中态唯一,其余用 roving tabIndex 收成一个 tab stop。
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
    // Exactly the one-liner, as TEXT: no wrapper, no controls. The owner renders
    // this inside the card row's description line.
    expect(view!.toJSON()).toBe(en.unifiedIntro)
    // Chosen for being ABSENT from the one-liner itself, so their absence is
    // evidence about the view and not about the copy: `variantTabCN` is the bare
    // word "China", which the intro already contains.
    const json = JSON.stringify(view!.toJSON())
    expect(json).not.toContain(en.quotaToggleCN)
    expect(json).not.toContain(en.quotaPollLabel)
  })

  it('opens on the account with the variant tabs; settings sit flat below', async () => {
    await mountUnified()
    const json = JSON.stringify(view!.toJSON())
    // Variant tabs stay the ONE level of tabs
    expect(json).toContain(en.variantTabCN)
    expect(json).toContain(en.variantTabGlobal)
    // Default active is CN (signed-in in our mock)
    expect(json).toContain(t('patTail', { tail: '****1111' }))
    // Settings render FLAT (no fold to open) and SCOPED to the active
    // variant: the CN tab shows CN rows only.
    expect(json).toContain(en.quotaToggleCN)
    expect(json).toContain(en.quotaPollLabel)
    expect(json).not.toContain(en.quotaToggleGlobal)
  })

  it('switches between China and Global tabs when clicked', async () => {
    await mountUnified()
    // Find the segmented tab buttons: China and Global
    const tabList = view!.root.find(n => n.props.role === 'tablist' && n.props['aria-label'] === 'Qoder Version Selection')
    const tabButtons = tabList.findAllByType('button')
    expect(tabButtons).toHaveLength(2)

    // Click Global tab (second tab)
    const globalTab = tabButtons[1]!
    await act(async () => { globalTab.props.onClick() })

    let json = JSON.stringify(view!.toJSON())
    // Global is signed out in mock, so it shows signed-out hint and Global PAT guide
    expect(json).toContain(en.signedOutHintAI)
    expect(json).toContain(en.patGuideAI)

    // Click China tab again (first tab)
    const cnTab = tabButtons[0]!
    await act(async () => { cnTab.props.onClick() })

    json = JSON.stringify(view!.toJSON())
    expect(json).toContain(t('patTail', { tail: '****1111' }))
  })

  it('reactively enables sidebar quota toggle when user signs in or saves PAT', async () => {
    let cnSignedIn = false
    request.mockImplementation(async (url: string, init?: RequestInit) => {
      if (init?.method === 'POST') {
        const body = JSON.parse(String(init.body))
        postedActions.push({ url, body })
        if (body.action === 'save-pat') {
          cnSignedIn = true
        }
        return { ok: true, status: 200, json: async () => ({ ok: true, status: 'saved' }) }
      }
      const path = String(url)
      if (path === QODER_STATUS_PATH) {
        return {
          ok: true,
          status: 200,
          json: async () => cnSignedIn ? ({
            status: 'signed-in',
            region: 'china',
            pat: { source: 'card', savedAtMs: 1700000000000, patTail: '2222' },
            authKey: 'cn-auth-key',
            credits: { total: 50, accounts: [] },
            models: [],
          }) : ({
            status: 'signed-out',
            region: 'china',
            authKey: 'cn-auth-key',
          }),
        }
      }
      if (path === QODER_GLOBAL_STATUS_PATH) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            status: 'signed-out',
            region: 'global',
            authKey: 'global-auth-key',
          }),
        }
      }
      return { ok: true, status: 200, json: async () => ({ status: 'signed-out' }) }
    })

    const fakeScope = {
      getSnapshot: () => ({
        status: 'ready' as const,
        writable: true,
        value: { sidebarQuotaCN: false, sidebarQuotaGlobal: false, quotaPollMs: 300_000 },
      }),
      subscribe: () => () => {},
      set: vi.fn(),
    }
    const props = {
      t: t as QoderPluginCardProps['t'],
      // The card is the Plugins page's configuration PAGE now, not a collapsed
      // card: the owner already drew the title and the disclosure affordance.
      view: 'page' as const,
      unified: true,
      scope: fakeScope as any,
    } as unknown as Parameters<typeof QoderPluginCard>[0]

    await act(async () => {
      view = create(createElement(QoderPluginCard, props))
    })

    // 高级设置里的侧栏开关。按 aria-label 精确定位 —— 账户分区的变体
    // 启用开关也叫 role=switch,不能按顺序取第一个。
    const quotaSwitch = () =>
      view!.root.findAll(n => n.props.role === 'switch' && n.props['aria-label'] === en.quotaToggleCN)[0]!
    // Initially disabled because cn is signed out
    expect(quotaSwitch().props.disabled).toBe(true)

    // Fill in PAT input and click save
    const patInput = view!.root.find(n => n.type === 'input' && n.props.type === 'password')
    await act(async () => {
      patInput.props.onChange({ target: { value: 'test-pat-token' } })
    })

    // Click save button
    const saveBtn = view!.root.findAll(n => n.type === 'button' && n.props.children === en.patSave)[0]!
    await act(async () => {
      await saveBtn.props.onClick()
    })

    // After saving PAT, China switch must be reactively enabled!
    expect(quotaSwitch().props.disabled).toBe(false)
  })

  it('(a) disables quota switches when accounts are not signed in and (b) prevents disabled click from calling scope.set', async () => {
    request.mockImplementation(async () => {
      return { ok: true, status: 200, json: async () => ({ status: 'signed-out' }) }
    })
    const mockSet = vi.fn()
    const fakeScope = {
      getSnapshot: () => ({
        status: 'ready' as const,
        writable: true,
        value: { sidebarQuotaCN: false, sidebarQuotaGlobal: false, quotaPollMs: 300_000 },
      }),
      subscribe: () => () => {},
      set: mockSet,
    }
    const props = {
      t: t as QoderPluginCardProps['t'],
      // The card is the Plugins page's configuration PAGE now, not a collapsed
      // card: the owner already drew the title and the disclosure affordance.
      view: 'page' as const,
      unified: true,
      scope: fakeScope as any,
      signedIn: () => ({ cn: false, global: false }),
    } as unknown as Parameters<typeof QoderPluginCard>[0]

    await act(async () => {
      view = create(createElement(QoderPluginCard, props))
    })

    // 正文恒挂载:没有 disclosure 头,也就没有「先展开」这一步。
    expect(view!.root.findAll(n => n.props.className === 'qdp-cardHeader')).toHaveLength(0)
    // 未登录时只有账户/额度/高级设置三个分区。
    expect(view!.root.findAll(n => n.props.className === 'qdp-sectionTitle').map(node => node.children.join('')))
      .toContain(en.quotaSectionAdvanced)

    // (a) Verify switches are disabled when not signed in (CN-scoped rows).
    // 按 aria-label 定位高级设置里的侧栏开关(账户分区的变体开关也是 switch)。
    const cnSwitch = view!.root.findAll(n => n.props.role === 'switch' && n.props['aria-label'] === en.quotaToggleCN)[0]!
    expect(cnSwitch.props.disabled).toBe(true)

    // (b) Simulate clicking switches in disabled state; verify scope.set is NEVER triggered
    await act(async () => {
      cnSwitch!.props.onClick()
    })
    // The Global rows are not rendered on the CN-scoped pane; there is no
    // globalSwitch to click, and the CN switch is disabled anyway.
    expect(mockSet).not.toHaveBeenCalled()
  })

  it('(c) safely blocks SidebarQuotaCard click when status is signed-out in wide and rail modes', async () => {
    request.mockImplementation(async () => {
      return { ok: true, status: 200, json: async () => ({ status: 'signed-out' }) }
    })

    // Enable quota toggles so SidebarQuotaCard renders instead of returning null
    setQuotaToggles(true, true)
    noteQuotaStatus('qoder', { status: 'signed-out' })
    noteQuotaSignIn('qoder', false)

    const openMock = vi.fn()

    // 1. Wide mode test
    let wideView: ReactTestRenderer | undefined
    await act(async () => {
      wideView = create(createElement(SidebarQuotaCard, {
        t: t as any,
        statusPath: QODER_STATUS_PATH,
        open: openMock,
        wide: true,
      } as any))
    })

    const wideBtn = wideView!.root.findByProps({ className: 'qdp-foot' })
    expect(wideBtn.props.disabled).toBe(true)

    // Attempt clicking wide button while signed-out
    await act(async () => {
      wideBtn.props.onClick()
    })
    expect(openMock).not.toHaveBeenCalled()
    act(() => wideView?.unmount())

    // 2. Rail mode (collapsed icon button) test
    let railView: ReactTestRenderer | undefined
    await act(async () => {
      railView = create(createElement(SidebarQuotaCard, {
        t: t as any,
        statusPath: QODER_STATUS_PATH,
        open: openMock,
        wide: false,
      } as any))
    })

    const railBtn = railView!.root.findByProps({ className: 'qdp-railButton' })
    expect(railBtn.props.disabled).toBe(true)

    // Attempt clicking rail button while signed-out
    await act(async () => {
      railBtn.props.onClick()
    })
    expect(openMock).not.toHaveBeenCalled()
    act(() => railView?.unmount())

    // 3. When signed-in, clicking wide button opens dashboard
    request.mockImplementation(async (url: string) => {
      const path = String(url)
      if (path === QODER_STATUS_PATH) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            status: 'signed-in',
            region: 'china',
            credits: { total: 50, accounts: [] },
          }),
        }
      }
      return { ok: true, status: 200, json: async () => ({ status: 'signed-out' }) }
    })
    noteQuotaStatus('qoder', {
      status: 'signed-in',
      credits: { total: 50, accounts: [] },
    })
    noteQuotaSignIn('qoder', true)

    let signedInView: ReactTestRenderer | undefined
    await act(async () => {
      signedInView = create(createElement(SidebarQuotaCard, {
        t: t as any,
        statusPath: QODER_STATUS_PATH,
        open: openMock,
        wide: true,
      } as any))
    })

    const signedInBtn = signedInView!.root.findByProps({ className: 'qdp-foot' })
    expect(signedInBtn.props.disabled).toBe(false)

    await act(async () => {
      signedInBtn.props.onClick()
    })
    expect(openMock).toHaveBeenCalledTimes(1)
    act(() => signedInView?.unmount())
  })

  it('rejects write to scope.set when attempting to turn on sidebarQuotaCN/Global while unsigned', async () => {
    const mockSet = vi.fn()
    const fakeScope = {
      getSnapshot: () => ({
        status: 'ready' as const,
        writable: true,
        value: { sidebarQuotaCN: false, sidebarQuotaGlobal: false, quotaPollMs: 300_000 },
      }),
      subscribe: () => () => {},
      set: mockSet,
    }
    let contentRenderer: ReactTestRenderer | undefined
    await act(async () => {
      contentRenderer = create(createElement(QuotaSettingsContent, {
        t: t as any,
        scope: fakeScope as any,
        signedIn: () => ({ cn: false, global: false }),
      }))
    })

    const switches = contentRenderer!.root.findAll(n => n.props.role === 'switch')
    expect(switches.length).toBeGreaterThanOrEqual(2)
    for (const sw of switches) {
      expect(sw.props.disabled).toBe(true)
    }

    // Even if onToggle was triggered directly with next=true, write() must intercept and drop it
    const toggleRows = contentRenderer!.root.findAll(n => typeof n.props.onToggle === 'function')
    for (const row of toggleRows) {
      await act(async () => {
        row.props.onToggle(true)
      })
    }
    expect(mockSet).not.toHaveBeenCalled()
    act(() => contentRenderer?.unmount())
  })

  it('renders the check-in state and its actions on the Usage pane when logs exist', async () => {
    request.mockImplementation(async (url: string) => {
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
            checkIn: {
              lastDate: '2026-09-21',
              /*
               * `today` is pinned in the fixture rather than read from the
               * clock, so this test asserts the claimed-day rendering without
               * depending on when it runs. The DATE stays deliberately in the
               * past: a card that ignored `today` would render this record as
               * 「今日已签到」 forever, which is the bug the stale-day test
               * below pins from the other side.
               */
              today: '2026-09-21',
              lastAt: 1700000000000,
              status: 'claimed',
              amount: 100,
              logs: [
                {
                  id: 'log-1',
                  date: '2026-09-21',
                  timestamp: 1700000000000,
                  status: 'claimed',
                  amount: 100,
                },
                {
                  id: 'log-2',
                  date: '2026-09-21',
                  timestamp: 1700003600000,
                  status: 'already-claimed',
                  amount: 100,
                  message: 'Already claimed today',
                },
              ],
            },
          }),
        }
      }
      return { ok: true, status: 200, json: async () => ({ status: 'signed-out' }) }
    })

    await act(async () => {
      view = create(createElement(QoderPluginCard, {
        t: t as any,
        unified: true,
        view: 'page',
      } as any))
    })

    // Check-in lives on the Usage pane's own line: state text and action
    // buttons are visible without any expansion.

    // 需求(m02274 第 3 条):「今日：+100 Credits」状态文本已删 —— 它把
    // 用户手动点的签到也说成「已自动签到」,是错误表述;领过没有由按钮
    // 自己表达(灰掉 + 「今日已签到」),不再用文字复述。
    expect(view!.root.findAll(n => n.children.includes('+100 Credits'))).toHaveLength(0)

    // 需求(m01317 第 3 条):旧的日志展开/刷新/清空三件套按钮已经删掉,改用
    // 与「可用额度」并排的领取台账。
    const ledgerHeading = view!.root.findAll(n => n.children.includes(en.ledgerHeading))
    expect(ledgerHeading.length).toBeGreaterThanOrEqual(1)
    // 旧日志表格的「展开」按钮不能再出现。注意不能拿 checkInRefresh 当探针:
    // 它的英文就是 "Refresh",与账号框自己那个刷新按钮(以及设置里的
    // 「刷新模型列表」)同字,断言必然误伤。
    expect(view!.root.findAll(n => n.children.includes(en.checkInLogShow))).toHaveLength(0)
    // 「清空日志」是保留的:上一轮改版把它从日志表格搬到台账标题行时漏掉了,
    // 清空动作因此一度无处可点(见 clearCheckInLogs 的接线)。它在台账的
    // 标题行里,与表头同一层,不在旧三件套里。
    expect(view!.root.findAll(n => n.children.includes(en.checkInClear)).length).toBeGreaterThanOrEqual(1)
    // 需求(m02274 第 1 条):7/30 天窗口切换已删,台账不再按时间窗过滤,
    // 界面能显示几条就显示几条。这条 fixture 的 timestamp 是 2023-11-15,
    // 旧版会把它过滤掉并给出空态;现在这笔领取直接列出,「+100」就在行上。
    expect(view!.root.findAll(n => n.children.includes(en.ledgerEmpty))).toHaveLength(0)
    // 台账只收真正领到的笔。fixture 特意多放了一条 already-claimed 观察记录,
    // 它的时间只是那次请求的时钟、不是发放时刻,所以不能变成第二行 —— 这正是
    // 用户报的「同一笔出现 17:47 / 23:12 两行」。
    const ledgerRows = view!.root.findAll(n => n.children.includes('+100'))
    expect(ledgerRows).toHaveLength(1)

    // The day is already claimed in this fixture, so the claim button reads
    // 「今日已签到」 and is DISABLED — the action is not re-offered.
    const claimedBtn = view!.root.findAll(n => n.children.includes(en.checkInClaimedToday))[0]
    expect(claimedBtn).toBeDefined()
    expect(claimedBtn!.props.disabled).toBe(true)
  })

  it('keeps the claim button disabled when the day was already claimed upstream', async () => {
    request.mockImplementation(async (url: string) => {
      if (String(url) === QODER_STATUS_PATH) {
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
            checkIn: {
              lastDate: '2026-09-21',
              // Same-day as the record, so the defensive `already-claimed`
              // branch is what keeps the button greyed out — not the date.
              today: '2026-09-21',
              lastAt: 1700003600000,
              status: 'already-claimed',
              amount: 100,
              message: 'Already claimed today',
            },
          }),
        }
      }
      return { ok: true, status: 200, json: async () => ({ status: 'signed-out' }) }
    })

    await act(async () => {
      view = create(createElement(QoderPluginCard, {
        t: t as any,
        unified: true,
        view: 'page',
      } as any))
    })

    // 「上游今天已经领过」也是领取过的状态:按钮必须保持灰掉 + 今日已签到。
    // 旧代码只认 claimed,already-claimed 会把按钮重新点亮,再点一次就又多
    // 一行用点击时钟盖章的 +100 —— 用户截图里的 17:47 / 23:12 就是这么来的。
    const claimedBtn = view!.root.findAll(n => n.children.includes(en.checkInClaimedToday))[0]
    expect(claimedBtn).toBeDefined()
    expect(claimedBtn!.props.disabled).toBe(true)
    // 这条观察不是一次发放,台账里不该出现 +100 行。
    expect(view!.root.findAll(n => n.children.includes('+100'))).toHaveLength(0)
  })

  it('re-offers the claim when the stored record is from an earlier day', async () => {
    /*
     * 用户报的 bug:没有签到,卡片却显示「今日已签到」,按钮永远是灰的。
     *
     * checkIn 是**持久化记录**,不是实时读数。旧代码只看 status,于是三天前
     * 那笔 claimed 一直满足条件,按钮从此再也点不动 —— 记录里的 lastDate 根本
     * 没被读过。这里让记录停在几天前、today 落在今天,断言按钮必须重新可点。
     */
    request.mockImplementation(async (url: string) => {
      if (String(url) === QODER_STATUS_PATH) {
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
            checkIn: {
              lastDate: '2026-09-27',
              // 记录停在 09-27,今天是 09-30:这一天并没有签到。
              today: '2026-09-30',
              lastAt: 1790502156407,
              status: 'claimed',
              amount: 100,
              logs: [
                {
                  id: '2026-09-27-1790502156407',
                  date: '2026-09-27',
                  timestamp: 1790502156407,
                  status: 'claimed',
                  amount: 100,
                },
              ],
            },
          }),
        }
      }
      return { ok: true, status: 200, json: async () => ({ status: 'signed-out' }) }
    })

    await act(async () => {
      view = create(createElement(QoderPluginCard, {
        t: t as any,
        unified: true,
        view: 'page',
      } as any))
    })

    // 按钮必须回到「立即领取」并重新可点 —— 今天还没领。
    expect(view!.root.findAll(n => n.children.includes(en.checkInClaimedToday))).toHaveLength(0)
    const claimBtn = view!.root.findAll(n => n.children.includes(en.checkInNow))[0]
    expect(claimBtn).toBeDefined()
    expect(claimBtn!.props.disabled).toBe(false)
    // 历史那一笔仍然在台账里:过去领到的东西不会因为跨天而消失。
    expect(view!.root.findAll(n => n.children.includes('+100'))).toHaveLength(1)
  })

  it('treats a same-day failed attempt as retryable, not as claimed', async () => {
    /*
     * 日期相等不等于领到了。no-campaign / error 是今天失败的一次尝试,
     * 按钮必须保持可点 —— 否则一次上游抖动就把这一整天烧掉了,这正是
     * 调度器 sweepOne 里那条「只有真的领到才算数」的客户端对应物。
     */
    request.mockImplementation(async (url: string) => {
      if (String(url) === QODER_STATUS_PATH) {
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
            checkIn: {
              lastDate: '2026-09-30',
              today: '2026-09-30',
              lastAt: 1790600000000,
              status: 'no-campaign',
              message: 'No claimable benefit campaign found for this region',
            },
          }),
        }
      }
      return { ok: true, status: 200, json: async () => ({ status: 'signed-out' }) }
    })

    await act(async () => {
      view = create(createElement(QoderPluginCard, {
        t: t as any,
        unified: true,
        view: 'page',
      } as any))
    })

    expect(view!.root.findAll(n => n.children.includes(en.checkInClaimedToday))).toHaveLength(0)
    const claimBtn = view!.root.findAll(n => n.children.includes(en.checkInNow))[0]
    expect(claimBtn).toBeDefined()
    expect(claimBtn!.props.disabled).toBe(false)
  })

  it('stores a typed check-in time as minutes past midnight in UTC+8', async () => {
    const mockSet = vi.fn()
    const fakeScope = {
      getSnapshot: () => ({
        status: 'ready' as const,
        writable: true,
        value: {
          sidebarQuotaCN: false,
          sidebarQuotaGlobal: false,
          autoCheckInCN: true,
          autoCheckInGlobal: false,
          checkInMinuteCN: 600,
          checkInMinuteGlobal: 600,
          quotaPollMs: 300_000,
        },
      }),
      subscribe: () => () => {},
      set: mockSet,
    }
    let renderer: ReactTestRenderer | undefined
    await act(async () => {
      renderer = create(createElement(QuotaSettingsContent, {
        t: t as any,
        scope: fakeScope as any,
        signedIn: () => ({ cn: true, global: false }),
      }))
    })

    // Two rows, each an hour and a minute field — typeable under any input
    // method, unlike the `type="time"` spinner segments this replaced.
    // data-checkin-part 现在是 QdpInput 组合件 + 它渲染出的原生 <input> 两处
    // 都带:只数 type 为字符串的宿主节点,才是真正的输入框。
    const hostParts = (name: string) =>
      renderer!.root.findAll(n => n.props['data-checkin-part'] === name && typeof n.type === 'string')
    const part = (name: string, index = 0) => hostParts(name)[index]!
    expect(hostParts('hour')).toHaveLength(2)
    expect(hostParts('minute')).toHaveLength(2)
    expect(renderer!.root.findAll(n => n.props.type === 'time')).toHaveLength(0)

    // The stored minute count renders as 10:00.
    expect(part('hour').props.value).toBe('10')
    expect(part('minute').props.value).toBe('00')

    await act(async () => { part('hour').props.onChange({ target: { value: '14' } }) })
    await act(async () => { part('minute').props.onChange({ target: { value: '30' } }) })
    // Nothing is written mid-typing; the commit is what persists it.
    expect(mockSet).not.toHaveBeenCalled()
    await act(async () => { part('hour').props.onBlur() })
    expect(mockSet).toHaveBeenCalledWith('checkInMinuteCN', 870)

    // The Global row stays locked while its own account is signed out.
    expect(part('hour', 1).props.disabled).toBe(true)
    expect(part('minute', 1).props.disabled).toBe(true)
    act(() => renderer?.unmount())
  })
})
