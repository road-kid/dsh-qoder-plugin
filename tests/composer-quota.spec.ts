/**
 * Composer quota chip + anchored panel (v3: one variant, readout switches,
 * real remaining credit).
 *
 * The suite mirrors the component's contract: the chip appears only for the
 * plugin's own providers AND only while its readout switch is on, the panel
 * speaks about the session's active variant only, and "Unlimited" is reserved
 * for documents with no countable size (the upstream flags `unlimited: true`
 * while still reporting real gift-package figures — m01963 item 5).
 *
 * The suite is order-aware: `quota-settings-store` has no reset entry point
 * (successful reads publish there module-wide), so each test builds on the
 * documents the earlier ones noted and notes its own fixture before mounting
 * when the value matters. The readout switches are reset after every test.
 *
 * Node environment: no DOM and no window. Refs are null unless `createNodeMock`
 * supplies one, `document`/`window` are stubbed only where the component talks
 * to them, and `fetch` is a global stub like the other composer specs.
 *
 * @module dsh-qoder-plugin/test/composer-quota.spec
 */

import { createElement, type ReactElement } from 'react'
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ComposerQuotaChip, type ComposerQuotaInjected } from '../src/client/ComposerQuota.tsx'
import { en } from '../src/client/locales.ts'
import { noteQuotaStatus, setQuotaReadout } from '../src/client/quota-settings-store.ts'
import {
  QODER_GLOBAL_STATUS_PATH,
  QODER_STATUS_PATH,
  type QoderWebStatus,
} from '../src/status-paths.ts'

/** Translator stub over the English table (same helper the probe spec uses). */
const t = ((key: string, params: Record<string, unknown> = {}) => (
  Object.entries(params).reduce<string>(
    (text, [name, value]) => text.replace(`{${name}}`, String(value)),
    en[key as keyof typeof en] as string,
  )
)) as ComposerQuotaInjected['t']

/** Locale formatting must match the component's `formatNumber`, not a literal. */
const number = (value: number): string => new Intl.NumberFormat(undefined).format(value)

/** CN variant: two packages summing to a full cycle. */
const CN_STATUS: QoderWebStatus = {
  status: 'signed-in',
  plan: { planTierName: 'Pro' },
  credits: {
    total: 0,
    totalSize: 1500,
    accounts: [
      { packageName: 'Pro', remain: 1200, size: 1200 },
      { packageName: 'Add-on', remain: 300, size: 300 },
    ],
  },
}

/**
 * The live CN document that used to read "Unlimited": the upstream marks the
 * credits unlimited while the gift package still carries 1,933 of 2,400.
 */
const BUGGY_CN_STATUS: QoderWebStatus = {
  status: 'signed-in',
  plan: { planTierName: '个人版' },
  credits: {
    total: 19,
    totalSize: 2400,
    unlimited: true,
    accounts: [
      { packageName: '个人额度', remain: 0, size: 0 },
      { packageName: '赠送额度', remain: 1933, size: 2400 },
    ],
  },
}

/** Global variant: half a cycle left, one countable package. */
const GLOBAL_STATUS: QoderWebStatus = {
  status: 'signed-in',
  plan: { planTierName: 'Qoder Global Pro' },
  credits: {
    total: 0,
    totalSize: 1400,
    accounts: [{ packageName: 'Global', remain: 1397, size: 1400 }],
    cycleResetTime: '2026-11-01T00:00:00.000Z',
  },
}

/** Nothing countable at all — the only document that may read "Unlimited". */
const UNLIMITED_STATUS: QoderWebStatus = {
  status: 'signed-in',
  plan: { planTierName: 'Pro' },
  credits: {
    total: 0,
    accounts: [{ packageName: 'Pro', remain: 0, size: 0, unlimited: true }],
    unlimited: true,
  },
}

/** Save a PAT prompt: no credit figures in this document. */
const SIGNED_OUT_STATUS: QoderWebStatus = { status: 'signed-out' }

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

/** A fetch result carrying one status document. */
function statusResponse(path: string): Response {
  const body = path === QODER_GLOBAL_STATUS_PATH ? GLOBAL_STATUS : CN_STATUS
  return {
    ok: true,
    status: 200,
    json: async () => body,
  } as unknown as Response
}

/** Stub of the pieces of `document` the component reads. */
interface DocumentStub {
  hidden: boolean
  visibilityState: 'visible' | 'hidden'
  listeners: Array<{ type: string; handler: (event: unknown) => void; capture: boolean }>
  addEventListener: (type: string, handler: (event: unknown) => void, options?: boolean | AddEventListenerOptions) => void
  removeEventListener: (type: string, handler: (event: unknown) => void) => void
}

/** `document` stand-in that records listeners so tests can fire them. */
function createDocumentStub(): DocumentStub {
  const document = {
    hidden: false,
    visibilityState: 'visible' as const,
    listeners: [] as DocumentStub['listeners'],
    addEventListener(type: string, handler: (event: unknown) => void, options?: boolean | AddEventListenerOptions): void {
      const capture = options === true
        || (typeof options === 'object' && options !== null && options.capture === true)
      document.listeners.push({ type, handler, capture })
    },
    removeEventListener(type: string, handler: (event: unknown) => void): void {
      const index = document.listeners.findIndex(entry => entry.type === type && entry.handler === handler)
      if (index >= 0) document.listeners.splice(index, 1)
    },
  }
  return document
}

/** Fetch stub; every test starts from the canned documents above. */
const request = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit): Promise<Response> => statusResponse(String(input)))

let view: ReactTestRenderer | null = null

/** Mount the chip with the given provider selected. */
async function mount(provider: string, options?: { createNodeMock?: (element: ReactElement) => unknown }): Promise<void> {
  const directory = createDirectory(provider)
  await act(async () => {
    view = create(
      createElement(ComposerQuotaChip, { directory, t }),
      options?.createNodeMock === undefined ? undefined : { createNodeMock: options.createNodeMock },
    )
  })
}

/** Flush pending promise chains inside `act`. */
async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

/** Host instances carrying one exact `qdp-*` class. */
function hostsByClass(className: string): ReturnType<ReactTestRenderer['root']['findAll']> {
  return view!.root.findAll(node => (
    typeof node.type === 'string' && String(node.props.className ?? '').split(/\s+/).includes(className)
  ))
}

/** Host buttons with the given accessible name. */
function buttonsByLabel(label: string): ReturnType<ReactTestRenderer['root']['findAll']> {
  return view!.root.findAll(node => node.type === 'button' && node.props['aria-label'] === label)
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
  return JSON.stringify(view!.toJSON())
}

/** The chip's rendered text (name, separator, readout). */
function chipText(): string {
  return textOf(hostsByClass('qdp-chip')[0]!)
}

/** Click the chip to open the panel. */
async function open(): Promise<void> {
  await act(async () => {
    hostsByClass('qdp-chip')[0]!.props.onClick()
    await Promise.resolve()
  })
  await flush()
}

/** Every path the component has requested so far. */
function requestedPaths(): string[] {
  return request.mock.calls.map(([input]) => String(input))
}

beforeEach(() => {
  request.mockReset()
  request.mockImplementation(async (input: RequestInfo | URL): Promise<Response> => statusResponse(String(input)))
  vi.stubGlobal('fetch', request)
  view = null
})

afterEach(() => {
  act(() => {
    view?.unmount()
  })
  view = null
  setQuotaReadout(true, true, true)
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('ComposerQuotaChip', () => {
  it('renders nothing while another provider is selected', async () => {
    await mount('deepseek-chat')

    expect(view!.toJSON()).toBeNull()
    expect(request).not.toHaveBeenCalled()
  })

  it('shows the selected variant remaining credit and publishes the document', async () => {
    await mount('qoder')
    await flush()

    expect(chipText()).toContain(number(1500))
    expect(chipText()).toContain(en.quotaChipCN)
    expect(treeText()).toContain('qdp-chip')

    expect(request).toHaveBeenCalledTimes(1)
    expect(request.mock.calls[0]![0]).toBe(QODER_STATUS_PATH)
    expect(request.mock.calls[0]![1]).toEqual({ headers: { accept: 'application/json' } })

    const chip = hostsByClass('qdp-chip')[0]!
    expect(chip.props['aria-haspopup']).toBe('dialog')
    expect(chip.props['aria-expanded']).toBe(false)
    expect(chip.props['aria-label']).toContain(en.quotaChipAria)
    expect(chip.props['aria-label']).toContain(number(1500))
  })

  it('opens a single-variant panel for the active CN model', async () => {
    await mount('qoder')
    await flush()
    await open()

    const dialog = view!.root.findAllByProps({ role: 'dialog' })
    expect(dialog).toHaveLength(1)
    expect(dialog[0]!.props['aria-label']).toBe(en.quotaDashboardTitle)

    // Exactly one row — the active variant — and the other product is absent.
    const rows = hostsByClass('qdp-popVariant')
    expect(rows).toHaveLength(1)
    expect(treeText()).toContain(en.quotaChipCN)
    expect(treeText()).not.toContain(en.quotaChipGlobal)
    expect(requestedPaths()).not.toContain(QODER_GLOBAL_STATUS_PATH)

    // Bar width + row caption for a full cycle.
    const fill = hostsByClass('qdp-popBarFill')[0]!
    expect(fill.props.style).toEqual({ width: '100%' })
    expect(treeText()).toContain(en.quotaNoExpiry)

    // Footer carries only the auto-refresh note (no static variant caption).
    expect(textOf(hostsByClass('qdp-popFoot')[0]!)).toBe(
      en.quotaPanelAutoRefresh.replace('{minutes}', '5'),
    )
    expect(buttonsByLabel(en.quotaRefresh)).toHaveLength(1)
    expect(hostsByClass('qdp-chip')[0]!.props['aria-expanded']).toBe(true)
  })

  it('shows only the Global variant for a Global model', async () => {
    noteQuotaStatus('qoder-global', { ...GLOBAL_STATUS })
    await mount('qoder-global')
    await flush()

    expect(chipText()).toContain(en.quotaChipGlobal)
    expect(chipText()).toContain(number(1397))

    await open()
    expect(hostsByClass('qdp-popVariant')).toHaveLength(1)
    expect(treeText()).toContain(en.quotaChipGlobal)
    expect(treeText()).toContain(number(1397))
    expect(treeText()).toContain(`${number(1397)} / ${number(1400)}`)
    expect(requestedPaths()).not.toContain(QODER_STATUS_PATH)
  })

  it('gates the chip on the master and per-variant readout switches', async () => {
    await mount('qoder')
    expect(hostsByClass('qdp-chip')).toHaveLength(1)

    act(() => {
      setQuotaReadout(false, true, true)
    })
    expect(view!.toJSON()).toBeNull()

    act(() => {
      setQuotaReadout(true, true, true)
    })
    expect(hostsByClass('qdp-chip')).toHaveLength(1)

    act(() => {
      setQuotaReadout(true, false, true)
    })
    expect(view!.toJSON()).toBeNull()

    // The Global switch is irrelevant to a CN model.
    act(() => {
      setQuotaReadout(true, true, false)
    })
    expect(hostsByClass('qdp-chip')).toHaveLength(1)

    // …but it hides the Global model.
    act(() => {
      view!.unmount()
    })
    view = null
    await mount('qoder-global')
    expect(view!.toJSON()).toBeNull()

    act(() => {
      setQuotaReadout(true, true, true)
    })
    expect(hostsByClass('qdp-chip')).toHaveLength(1)
  })

  it('shows the signed-out hint for the active variant when signed out', async () => {
    noteQuotaStatus('qoder', { ...SIGNED_OUT_STATUS })
    await mount('qoder')
    await flush()

    expect(chipText()).toContain('—')

    await open()
    expect(hostsByClass('qdp-popVariant')).toHaveLength(1)
    expect(treeText()).toContain(en.quotaNotSignedIn)
    expect(treeText()).not.toContain(en.quotaUnlimited)
  })

  it('reads real credit even when the upstream flags the account unlimited', async () => {
    noteQuotaStatus('qoder', { ...BUGGY_CN_STATUS })
    request.mockImplementation(async (): Promise<Response> => ({
      ok: true,
      status: 200,
      json: async () => BUGGY_CN_STATUS,
    } as unknown as Response))
    await mount('qoder')
    await flush()

    // The bug: chip must read the gift package's real remainder, not 不限量.
    expect(chipText()).toContain(number(1933))
    expect(chipText()).not.toContain(en.quotaUnlimited)

    await open()
    expect(treeText()).toContain(`${number(1933)} / ${number(2400)}`)
    expect(treeText()).toContain(en.percentRemaining.replace('{percent}', '80.5'))
    expect(treeText()).not.toContain(en.quotaUnlimited)

    const fill = hostsByClass('qdp-popBarFill')[0]!
    expect(Number.parseFloat(String(fill.props.style.width))).toBeCloseTo(80.54, 1)
  })

  it('renders unlimited only when the document has no countable size', async () => {
    noteQuotaStatus('qoder', { ...UNLIMITED_STATUS })
    await mount('qoder')
    await flush()
    await open()

    expect(chipText()).toContain(en.quotaUnlimited)
    expect(treeText()).toContain(en.quotaUnlimited)
    // No percentage can exist for an uncounted pool: full bar, no warn.
    const fill = hostsByClass('qdp-popBarFill')[0]!
    expect(fill.props.style).toEqual({ width: '100%' })
    expect(String(fill.props.className)).not.toContain('qdp-popWarn')
  })

  it('keeps the last good figures and shows an error line when the refresh fails', async () => {
    noteQuotaStatus('qoder', { ...UNLIMITED_STATUS })
    await mount('qoder')
    await flush()
    await open()

    request.mockImplementation(async (): Promise<Response> => {
      throw new Error('offline')
    })
    await act(async () => {
      buttonsByLabel(en.quotaRefresh)[0]!.props.onClick()
      await Promise.resolve()
    })
    await flush()

    // The stale (but useful) figures survived; the failure is reported beside
    // them rather than replacing them with zeroes.
    expect(chipText()).toContain(en.quotaUnlimited)
    expect(hostsByClass('qdp-alertError').length).toBeGreaterThanOrEqual(1)
    expect(treeText()).toContain(en.quotaError)
    expect(buttonsByLabel(en.quotaRefresh)).toHaveLength(1)
  })

  it('closes on Escape and on an outside pointerdown (returning focus)', async () => {
    const document = createDocumentStub()
    vi.stubGlobal('document', document)
    await mount('qoder')
    await flush()

    await open()
    expect(view!.root.findAllByProps({ role: 'dialog' })).toHaveLength(1)
    act(() => {
      view!.root.findAllByProps({ role: 'dialog' })[0]!.props.onKeyDown({
        key: 'Escape',
        preventDefault: () => undefined,
        stopPropagation: () => undefined,
      })
    })
    expect(view!.root.findAllByProps({ role: 'dialog' })).toHaveLength(0)
    expect(document.listeners.some(entry => entry.type === 'pointerdown')).toBe(false)

    await open()
    const pointerdown = document.listeners.find(entry => entry.type === 'pointerdown')
    expect(pointerdown).toBeDefined()
    act(() => {
      pointerdown!.handler({ target: null })
    })
    expect(view!.root.findAllByProps({ role: 'dialog' })).toHaveLength(0)
    expect(hostsByClass('qdp-chip')[0]!.props['aria-expanded']).toBe(false)
  })

  it('polls at the configured interval and skips hidden documents', async () => {
    const document = createDocumentStub()
    vi.stubGlobal('document', document)
    noteQuotaStatus('qoder', { ...CN_STATUS })
    // Only the interval is faked; React and promise scheduling stay real.
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })

    await mount('qoder')
    await flush()
    const afterMount = request.mock.calls.length

    // The default cadence is five minutes; one tick must hit the status route.
    act(() => {
      vi.advanceTimersByTime(300_000)
    })
    await flush()
    expect(request.mock.calls.length).toBe(afterMount + 1)
    expect(String(request.mock.calls[afterMount]![0])).toBe(QODER_STATUS_PATH)

    document.hidden = true
    act(() => {
      vi.advanceTimersByTime(300_000)
    })
    await flush()
    expect(request.mock.calls.length).toBe(afterMount + 1)

    // Unmount stops the timer for good.
    act(() => {
      view!.unmount()
    })
    view = null
    document.hidden = false
    act(() => {
      vi.advanceTimersByTime(300_000)
    })
    expect(request.mock.calls.length).toBe(afterMount + 1)
  })

  it('anchors the panel above the chip', async () => {
    const windowStub = {
      innerWidth: 1024,
      innerHeight: 768,
      setTimeout: (handler: () => void, _timeout?: number): number => {
        handler()
        return 1
      },
      addEventListener: (): void => undefined,
      removeEventListener: (): void => undefined,
    }
    vi.stubGlobal('window', windowStub)
    const createNodeMock = (element: ReactElement): unknown => {
      const props = element.props as Record<string, unknown>
      const rect = props['role'] === 'dialog'
        ? { height: 200 }
        : { left: 40, right: 160, top: 600, bottom: 624, width: 120, height: 24, x: 40, y: 600 }
      return {
        getBoundingClientRect: () => rect,
        contains: () => false,
        focus: () => undefined,
      }
    }

    await mount('qoder', { createNodeMock })
    await flush()
    await open()

    // Above the chip: 600 (chip top) - 8 (gap) - 200 (panel height) = 392.
    const panel = hostsByClass('qdp-pop')[0]!
    expect(panel.props.style).toEqual({ left: 40, top: 392 })
  })
})
