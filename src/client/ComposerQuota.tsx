/**
 * Composer quota readout: a chip in the Composer toolbar that expands into an
 * anchored panel for the session model's Qoder variant.
 *
 * This replaces the old sidebar quota cards and the center-column dashboard.
 * The user's instruction was "取消原本的额度显示方式，改为「输入框内显示额度读数 +
 * 点击展开小面板」(m01150)": the seat must not occupy toolbar space for readers
 * who keep another provider selected, so the chip resolves the session's model
 * directory itself and renders nothing unless the current provider is one of
 * this plugin's (`qoder` / `qoder-global`). A later round added the switches —
 * "输入框中显示额度应该加入开关" — and made the panel speak about ONE product only
 * (m01963): the panel lists just the variant the session model is drawn from,
 * and the chip disappears when that variant's readout switch is off.
 *
 * Shape:
 *
 * - the chip is a one-line readout — variant short name + remaining credit —
 *   modeled on the WorkBuddy credit chip the user pointed at;
 * - the panel is anchored to the chip with `position: fixed`, opening upward
 *   when there is room (the composer sits at the bottom of the window) and
 *   flipping/clamping when there is not;
 * - the panel has one row for the active variant: name, plan tag,
 *   `remaining / total`, a thin bar and the percent + expiry caption;
 * - documents are shared, not owned: successful reads publish through
 *   `noteQuotaStatus` (the same store the settings surfaces read), failed reads
 *   keep the last good document and surface a one-line error instead of
 *   blanking the figures;
 * - the remaining figure is the summed per-package remainder, and "Unlimited"
 *   is reserved for documents with no countable size at all: the upstream
 *   marks accounts `unlimited: true` even when gift packages carry real
 *   figures (live CN document: `{unlimited:true, accounts:[{remain:1933,size:2400},
 *   {remain:0,size:0}]}`), which used to make the chip read 不限量 on an account
 *   with 1,933 credits left (m01963 item 5).
 *
 * Styling lives entirely in quota-styles.ts (`qdp-chip`, `qdp-pop*`); the only
 * inline sizes are the bar's `width` percent and the panel's fixed `left`/`top`,
 * which are geometry, not appearance.
 *
 * @module dsh-connect-qoder-x/client/composer-quota
 */

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from 'react'
import type { ModelDirectory } from '@deepseek-ai/dsh-client-ui-model-selection/client'
import { QODER_CARD_VARIANTS, type QoderCardVariant, type QoderPluginCardInjected } from './QoderPluginCard.tsx'
import { cx, QdpIconButton, QdpTag } from './controls.tsx'
import { clampPercent } from './quota-merge.ts'
import { isQoderWebStatus } from './status-document.ts'
import {
  noteQuotaStatus,
  onQuotaSettingsChange,
  quotaPollMs,
  quotaReadout,
  quotaSettingsRevision,
  quotaStatus,
  quotaStatusFetchedAt,
  quotaStatusIsFresh,
} from './quota-settings-store.ts'
import type { QoderWebCredits, QoderWebStatus } from '../status-paths.ts'

/** Injected props; `directory` resolves the session's current model selection. */
export interface ComposerQuotaInjected {
  t: QoderPluginCardInjected['t']
  /** Same store type as `QoderProbeControl`'s composer seat. */
  directory: ModelDirectory['store']
}

/** Panel width, mirrored by `.qdp-pop` in quota-styles.ts. */
const PANEL_WIDTH = 300
/** Breathing room between the chip and its panel. */
const ANCHOR_GAP = 8
/** The panel never comes closer than this to a viewport edge. */
const VIEWPORT_MARGIN = 12
/** The shared poll interval can never be shorter than one minute. */
const MIN_POLL_MS = 60_000
/** Below this share of the granted total the bar turns warn-coloured. */
const WARN_PERCENT = 20

/** Group digits in the browser's locale (same formatting the old card used). */
function formatNumber(value: number): string {
  return new Intl.NumberFormat(undefined).format(value)
}

/** Percent with at most one fraction digit. */
function formatPercent(percent: number): string {
  return new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 }).format(percent)
}

/** Wall-clock `HH:mm`, matching the old card's "updated" caption. */
function timeText(ms: number): string {
  return new Date(ms).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
}

/**
 * Expiry text: a locale date when the upstream string parses, otherwise the
 * string verbatim. The upstream reports ISO strings and numeric epochs that the
 * host normalizes; an unrecognized shape is displayed as-is rather than guessed
 * into a date.
 */
function expiryText(value: string): string {
  const parsed = Date.parse(value)
  if (Number.isNaN(parsed)) return value
  return new Date(parsed).toLocaleDateString(undefined, {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  })
}

/**
 * The chip's short product name.
 *
 * The variant table in QoderPluginCard.tsx carries `titleKey` (full card title)
 * but no `nameKey`; the composer chip needs the one-word label, which is what
 * the composer-specific `quotaChip*` copy keys are for.
 */
function chipNameKey(card: QoderCardVariant): 'quotaChipCN' | 'quotaChipGlobal' {
  return card.id === 'qoder-global' ? 'quotaChipGlobal' : 'quotaChipCN'
}

/** The remaining-credit figures every readout is built from. */
interface CreditSummary {
  /** Summed remainder across the packages. */
  remain: number
  /** Countable size: summed package sizes, else the reported total, else 0. */
  total: number
  /** True only when the document has no countable size at all. */
  unlimited: boolean
}

/**
 * Distill a credits document into the numbers the chip and the panel show.
 *
 * "Unlimited" means "there is nothing to count", not "the upstream flagged it":
 * live documents report `credits.unlimited: true` while still carrying real
 * per-package sizes (the CN gift plan), and treating the flag alone as unlimited
 * hid thousands of remaining credits behind 不限量. The rule (m01963 item 5):
 * unlimited only when `Σ account.size <= 0`; otherwise `Σ remain / Σ size`,
 * falling back to `credits.totalSize` when every package reports size 0.
 */
function creditSummary(credits: QoderWebCredits): CreditSummary {
  const accounts = credits.accounts
  const remain = accounts.reduce((sum, account) => sum + account.remain, 0)
  const summedSize = accounts.reduce((sum, account) => sum + account.size, 0)
  const unlimited = summedSize <= 0
    && (credits.unlimited === true || accounts.some(account => account.unlimited === true))
  let total = 0
  if (!unlimited) {
    if (summedSize > 0) total = summedSize
    else if (credits.totalSize !== undefined && credits.totalSize > 0) total = credits.totalSize
  }
  return { remain, total, unlimited }
}

/**
 * The chip's remaining-credit readout: a number, "Unlimited", or an em dash.
 *
 * The em dash is the not-ready state (no document yet, signed out, or an
 * upstream error document) rather than "0", which would claim an empty account.
 */
function chipReadout(status: QoderWebStatus | undefined, t: QoderPluginCardInjected['t']): string {
  if (status === undefined || status.status !== 'signed-in') return '—'
  const credits = status.credits
  if (credits === undefined) return '—'
  const summary = creditSummary(credits)
  return summary.unlimited ? t('quotaUnlimited') : formatNumber(summary.remain)
}

/** The figures one panel row renders, or `undefined` when there are none. */
interface VariantFigures {
  planName: string | undefined
  unlimited: boolean
  remain: number
  total: number
  percent: number | undefined
  expiry: string | undefined
}

/**
 * Project a status document into the row's figures.
 *
 * `undefined` means "no figures to draw" (no document, signed out, or the
 * upstream error arm) — the row renders an empty/error state instead of
 * inventing zeroes. The credit figures follow {@link creditSummary}; the
 * denominator is the summed package size (the reported total only when the
 * packages carry no size at all).
 */
function variantFigures(status: QoderWebStatus | undefined): VariantFigures | undefined {
  if (status === undefined || status.status !== 'signed-in') return undefined
  const credits = status.credits
  if (credits === undefined) return undefined
  const summary = creditSummary(credits)
  return {
    planName: status.plan?.planTierName,
    unlimited: summary.unlimited,
    remain: summary.remain,
    total: summary.total,
    // `clampPercent` returns undefined for an unknown denominator: the row then
    // draws no bar rather than an invented full one.
    percent: summary.unlimited ? undefined : clampPercent(summary.remain, summary.total),
    expiry: credits.cycleResetTime ?? status.plan?.endDate,
  }
}

/** The row-head value copy: unlimited, `remain / size`, or "remain only". */
function valueText(figures: VariantFigures, t: QoderPluginCardInjected['t']): string {
  if (figures.unlimited) return t('quotaUnlimited')
  if (figures.total > 0) {
    return t('exactRemaining', {
      remain: formatNumber(figures.remain),
      size: formatNumber(figures.total),
    })
  }
  return t('creditPackageUnknownSize', { remain: formatNumber(figures.remain) })
}

/** The row caption: percent remaining and when the quota lapses. */
function captionText(figures: VariantFigures, t: QoderPluginCardInjected['t']): string {
  const parts: string[] = []
  if (figures.percent !== undefined) {
    parts.push(t('percentRemaining', { percent: formatPercent(figures.percent) }))
  }
  parts.push(
    figures.expiry !== undefined
      ? `${t('quotaExpires')} ${expiryText(figures.expiry)}`
      : t('quotaNoExpiry'),
  )
  return parts.join(' · ')
}

/**
 * Whether `target` is inside `container`.
 *
 * The container refs are null while the panel is closed and in DOM-less test
 * environments; the Node guard keeps that case from touching an undefined
 * `Node` global.
 */
function containsTarget(container: HTMLElement | null, target: EventTarget | null): boolean {
  if (container === null || target === null) return false
  return typeof Node !== 'undefined' && target instanceof Node && container.contains(target)
}

/** The active variant's panel row. */
function VariantRow({ card, status, failed, t }: {
  card: QoderCardVariant
  status: QoderWebStatus | undefined
  failed: boolean
  t: QoderPluginCardInjected['t']
}): ReactNode {
  const figures = variantFigures(status)
  const failedDocument = status?.status === 'error'
  return (
    <div className="qdp-popVariant">
      <div className="qdp-popVariantHead">
        <span className="qdp-popName">{t(chipNameKey(card))}</span>
        {figures?.planName !== undefined ? <QdpTag>{figures.planName}</QdpTag> : null}
        <span className="qdp-popValue">{figures === undefined ? '—' : valueText(figures, t)}</span>
      </div>
      {figures === undefined ? (
        failed || failedDocument || (status !== undefined && status.status === 'signed-in') ? (
          // A failed read and a signed-in document without credit answers are
          // both "unavailable", not "zero": say so instead of drawing a bar.
          <p className="qdp-alert qdp-alertError">{t('quotaError')}</p>
        ) : status === undefined ? (
          <p className="qdp-empty">{t('quotaPanelEmpty')}</p>
        ) : (
          <p className="qdp-caption">{t('quotaNotSignedIn')}</p>
        )
      ) : (
        <>
          <div className="qdp-popBar">
            <div
              className={cx(
                'qdp-popBarFill',
                figures.percent !== undefined && figures.percent < WARN_PERCENT && 'qdp-popWarn',
              )}
              style={{ width: `${figures.percent === undefined ? 100 : Math.max(2, figures.percent)}%` }}
            />
          </div>
          <span className="qdp-popCaption">{captionText(figures, t)}</span>
          {failed || failedDocument ? (
            // The stale-but-useful figures stay on screen; the failure is
            // reported beside them so "old number" never passes for "fresh".
            <p className="qdp-alert qdp-alertError">{t('quotaError')}</p>
          ) : null}
        </>
      )}
    </div>
  )
}

/**
 * Model-independent shell: resolves the selection and the readout switches,
 * then renders the chip.
 *
 * Returning `null` for every other provider is what keeps the composer seat
 * free for readers who do not use Qoder; the guard runs after all hooks so hook
 * order cannot change with the selection or the settings.
 */
export function ComposerQuotaChip({ directory, t }: ComposerQuotaInjected): ReactNode {
  const subscribe = useCallback((listener: () => void) => directory.subscribe(listener), [directory])
  const snapshot = useCallback(() => directory.getSnapshot(), [directory])
  const selection = useSyncExternalStore(subscribe, snapshot, snapshot).current
  // Readout switches come from the shared settings document: subscribe so a
  // saved master/variant switch hides or shows the chip without a reload.
  useSyncExternalStore(onQuotaSettingsChange, quotaSettingsRevision, quotaSettingsRevision)
  const readout = quotaReadout()
  const card = selection == null
    ? undefined
    : QODER_CARD_VARIANTS.find(variant => variant.id === selection.provider)
  if (card === undefined) return null
  const variantEnabled = card.id === 'qoder-global' ? readout.global : readout.cn
  return readout.enabled && variantEnabled ? <ComposerQuota card={card} t={t} /> : null
}

/**
 * The readout itself, mounted only while a Qoder provider is selected and its
 * readout switch is on.
 *
 * @param card - the variant whose status route the chip reads.
 * @param t - translator bound to the shared settings namespace.
 */
function ComposerQuota({ card, t }: {
  card: QoderCardVariant
  t: QoderPluginCardInjected['t']
}): ReactNode {
  const [open, setOpen] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  /** Whether the most recent read for this variant failed; cleared by success. */
  const [failed, setFailed] = useState(false)
  /** Fixed-panel geometry, measured from the chip; `null` until first measured. */
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null)
  const triggerRef = useRef<HTMLButtonElement | null>(null)
  const panelRef = useRef<HTMLDivElement | null>(null)
  const mounted = useRef(true)
  /** Guards a slow read and a refresh from double-fetching the same route. */
  const inFlight = useRef(false)

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  // Shared store subscription: a read from any surface (settings card, the
  // other composer instance) updates this chip too, and a failed read keeps the
  // previous document — the figures stay readable.
  useSyncExternalStore(onQuotaSettingsChange, quotaSettingsRevision, quotaSettingsRevision)
  // The subscribed poll interval restarts the timer when 刷新间隔 changes, so a
  // saved interval takes effect without remounting the composer.
  const pollMs = useSyncExternalStore(onQuotaSettingsChange, quotaPollMs, quotaPollMs)

  /**
   * Read the active variant's status route.
   *
   * `force` bypasses the freshness cache (refresh button, interval ticks);
   * otherwise a document younger than the configured poll interval is reused,
   * so opening the panel right after a mount does not re-hit the billing route.
   * Failures keep the previous document and only add the error line.
   */
  const fetchStatus = useCallback(async (force: boolean): Promise<void> => {
    if (!force && quotaStatusIsFresh(card.id, quotaPollMs())) return
    if (inFlight.current) return
    inFlight.current = true
    try {
      const response = await fetch(card.statusPath, { headers: { accept: 'application/json' } })
      const body: unknown = await response.json().catch((): undefined => undefined)
      if (!mounted.current) return
      if (!response.ok || !isQoderWebStatus(body)) {
        setFailed(true)
        return
      }
      // Publish through the shared store: this seat, the settings card and any
      // other quota surface then show the same document.
      noteQuotaStatus(card.id, body)
      setFailed(false)
    } catch {
      if (mounted.current) setFailed(true)
    } finally {
      inFlight.current = false
    }
  }, [card])

  // Mount (and selection switch): one gated read, then the configured interval.
  // The tick is forced: the interval IS the cache lifetime, and a user who set
  // five minutes expects a five-minute-old read to be replaced, not skipped.
  useEffect(() => {
    void fetchStatus(false)
    const intervalMs = Math.max(MIN_POLL_MS, pollMs)
    const timer: ReturnType<typeof setInterval> = setInterval(() => {
      // A background tab costs nothing: the next visible tick catches up.
      if (typeof document !== 'undefined' && document.hidden) return
      void fetchStatus(true)
    }, intervalMs)
    const onVisibilityChange = (): void => {
      if (typeof document !== 'undefined' && !document.hidden) void fetchStatus(false)
    }
    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisibilityChange)
    return () => {
      clearInterval(timer)
      if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisibilityChange)
    }
  }, [card, fetchStatus, pollMs])

  // Opening the panel catches up the one row it shows; the same freshness gate
  // applies, so a fresh document is not re-read.
  useEffect(() => {
    if (!open) return
    void fetchStatus(false)
  }, [open, fetchStatus])

  const close = useCallback((): void => {
    setOpen(false)
    // The chip is the trigger; focus goes back to where the panel came from.
    triggerRef.current?.focus()
  }, [])

  const toggle = useCallback((): void => {
    if (open) close()
    else setOpen(true)
  }, [close, open])

  // Outside pointerdown closes. Clicks inside the panel and on the chip itself
  // are not "outside" — the chip toggles on its own click, and closing twice
  // would swallow the reopen.
  useEffect(() => {
    if (!open || typeof document === 'undefined') return
    const onPointerDown = (event: PointerEvent): void => {
      if (containsTarget(panelRef.current, event.target) || containsTarget(triggerRef.current, event.target)) return
      close()
      // The press's own default focus step runs after this listener, so the
      // chip would lose focus to whatever was clicked; take it back on the
      // next task (D2: the same return the Escape path performs).
      if (typeof window !== 'undefined') {
        window.setTimeout(() => {
          triggerRef.current?.focus()
        }, 0)
      }
    }
    document.addEventListener('pointerdown', onPointerDown, true)
    return () => document.removeEventListener('pointerdown', onPointerDown, true)
  }, [open, close])

  // Keyboard escape closes the panel; the handler sits on the focused panel so
  // it cannot interfere with the composer's own Escape handling while closed.
  const onPanelKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (event.key !== 'Escape') return
    event.preventDefault()
    event.stopPropagation()
    close()
  }

  /**
   * Anchor the panel to the chip.
   *
   * The composer sits at the bottom of the window, so "above" is the default.
   * If the panel does not fit above it flips below; if it fits in neither place
   * it is clamped to the viewport. Left is clamped the same way (the chip can be
   * close to either edge). Measured on mount, on scroll/resize, and after every
   * render so a growing panel keeps its anchor.
   */
  const measure = useCallback((): void => {
    const trigger = triggerRef.current
    if (trigger === null || typeof window === 'undefined') return
    const triggerRect = trigger.getBoundingClientRect()
    const panel = panelRef.current
    const panelHeight = panel === null ? 0 : panel.getBoundingClientRect().height
    const viewportWidth = window.innerWidth
    const viewportHeight = window.innerHeight
    const width = Math.min(PANEL_WIDTH, viewportWidth - VIEWPORT_MARGIN * 2)
    const left = Math.max(
      VIEWPORT_MARGIN,
      Math.min(triggerRect.left, viewportWidth - VIEWPORT_MARGIN - width),
    )
    const preferredTop = triggerRect.top - ANCHOR_GAP - panelHeight
    const belowTop = triggerRect.bottom + ANCHOR_GAP
    const top = preferredTop >= VIEWPORT_MARGIN
      ? preferredTop
      : belowTop + panelHeight <= viewportHeight - VIEWPORT_MARGIN
        ? belowTop
        : Math.max(VIEWPORT_MARGIN, viewportHeight - VIEWPORT_MARGIN - panelHeight)
    setPosition(previous => (
      previous !== null && Math.abs(previous.left - left) < 0.5 && Math.abs(previous.top - top) < 0.5
        ? previous
        : { left, top }
    ))
  }, [])

  // Re-measure after every commit while open: the panel's height depends on the
  // document (row appears, captions wrap), and the anchor must follow it.
  useLayoutEffect(() => {
    if (open) measure()
  })

  // Focus moves into the panel when it opens, so Escape works immediately and
  // screen readers announce the dialog.
  useLayoutEffect(() => {
    if (open) panelRef.current?.focus()
  }, [open])

  // A scrolled or resized window moves the chip away from a fixed panel; keep
  // the two together. Scroll uses capture because the composer's scroll
  // container is not the window itself.
  useEffect(() => {
    if (!open || typeof window === 'undefined') return
    const onViewportChange = (): void => measure()
    window.addEventListener('scroll', onViewportChange, true)
    window.addEventListener('resize', onViewportChange)
    return () => {
      window.removeEventListener('scroll', onViewportChange, true)
      window.removeEventListener('resize', onViewportChange)
    }
  }, [open, measure])

  /** Force-read the active variant (the panel's refresh action). */
  const refresh = useCallback(async (): Promise<void> => {
    if (refreshing) return
    setRefreshing(true)
    try {
      await fetchStatus(true)
    } finally {
      if (mounted.current) setRefreshing(false)
    }
  }, [fetchStatus, refreshing])

  const currentStatus = quotaStatus(card.id)
  const name = t(chipNameKey(card))
  const readout = chipReadout(currentStatus, t)
  const fetchedAt = quotaStatusFetchedAt(card.id)

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className="qdp-chip"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={`${t('quotaChipAria')}: ${name} · ${readout}`}
        onClick={toggle}
      >
        <span className="qdp-chipName">{name}</span>
        <span aria-hidden="true">·</span>
        <span className="qdp-chipValue">{readout}</span>
      </button>
      {open ? (
        <div
          ref={panelRef}
          role="dialog"
          aria-label={t('quotaDashboardTitle')}
          tabIndex={-1}
          className="qdp-pop"
          style={position === null ? undefined : { left: position.left, top: position.top }}
          onKeyDown={onPanelKeyDown}
        >
          <div className="qdp-popHead">
            <span className="qdp-popTitle">{t('quotaDashboardTitle')}</span>
            {fetchedAt !== undefined ? (
              <span className="qdp-popTime">{`${t('quotaUpdated')} ${timeText(fetchedAt)}`}</span>
            ) : null}
            <QdpIconButton
              className="qdp-popRefresh"
              label={refreshing ? t('quotaRefreshing') : t('quotaRefresh')}
              disabled={refreshing}
              onClick={() => {
                void refresh()
              }}
            >
              <svg
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.6"
                aria-hidden="true"
                focusable="false"
              >
                <path d="M20 11a8 8 0 1 0-2.35 5.66" />
                <path d="M20 4v7h-7" />
              </svg>
            </QdpIconButton>
          </div>
          <div className="qdp-popList">
            <VariantRow card={card} status={currentStatus} failed={failed} t={t} />
          </div>
          <div className="qdp-popFoot">
            <span>
              {t('quotaPanelAutoRefresh', {
                minutes: String(Math.round(Math.max(MIN_POLL_MS, quotaPollMs()) / 60_000)),
              })}
            </span>
          </div>
        </div>
      ) : null}
    </>
  )
}
