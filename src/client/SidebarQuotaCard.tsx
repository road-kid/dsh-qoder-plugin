/**
 * The sidebar footer quota card + the center-column dashboard it opens.
 *
 * The structure is a direct port of commandcode's plans & quota panel
 * (src/client/panel-view.tsx + panel.ts), which the user held up as the
 * reference: the card IS the button (the shell supplies no chrome), it renders
 * one block per merged package group — the group's remain/total, its
 * percentage and its bar — carries the last-updated time in the card's top
 * row, and opens a dashboard in the layout's keyed `main` slot on click. In
 * the 56px rail it collapses to a 36px icon button carrying the ring.
 *
 * Data comes from the variant's status route (poll, paused while hidden);
 * strings come from the `panel.qoder-quota` locale namespace; classes come
 * from `./quota-styles.ts` (`qdp-` prefix).
 */

import { useEffect, useState, useSyncExternalStore } from 'react'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import { isQoderWebStatus } from './status-document.ts'
import type { QoderWebStatus } from '../status-paths.ts'
import type { QoderSettingsKey } from './locales.ts'
import { clampPercent, mergeCreditAccounts, sortPackageRows, visibleQuotaGroups } from './quota-merge.ts'
import { onQuotaSettingsChange, noteQuotaStatus, quotaPollMs, quotaSettingsRevision, quotaStatus, quotaStatusFetchedAt, quotaToggles, variantOfStatusPath } from './quota-settings-store.ts'
import { QdpButton, QdpIconButton, QdpStateDot, QdpTag } from './controls.tsx'
/** Everything the registration binds into the card. */
export interface SidebarQuotaCardInjected {
  /** Translator bound to the quota namespace. */
  t: (key: QuotaCopyKey, params?: Record<string, unknown>) => string
  /** Which variant's status route this card polls. */
  statusPath: string
  /** Select the dashboard panel in the center column (layout seam). */
  open: () => void
}

/**
 * The card's own copy keys — the subset of the shared settings key set the
 * quota surfaces render.
 */
export type QuotaCopyKey =
  | 'quotaCardCN'
  | 'quotaCardGlobal'
  | 'quotaUnknownTotal'
  | 'quotaUnlimited'
  | 'quotaExpires'
  | 'quotaNoExpiry'
  | 'quotaError'
  | 'quotaNotSignedIn'
  | 'quotaUpdated'
  | 'quotaDashboardTitle'
  | 'quotaDashboardSubtitle'
  | 'quotaRefresh'
  | 'quotaRefreshing'
  | 'quotaClose'
  | 'quotaByPackage'
  | 'quotaTotal'
  | 'quotaTotalRemain'
  | 'quotaTotalShare'
  | 'quotaColPackage'
  | 'quotaColRemain'
  | 'quotaColExpiry'
  /** PAT identity line for the dashboard card head. */
  | 'patTail'
  | 'signedIn'
  /** Usage-percentage line under the totals. */
  | 'quotaCycleUsed'

/** Compile-time assertion: every quota key must exist in the shared key set. */
const _assertQuotaKeys: Record<QuotaCopyKey, QoderSettingsKey> = {
  quotaCardCN: 'quotaCardCN',
  quotaCardGlobal: 'quotaCardGlobal',
  quotaUnknownTotal: 'quotaUnknownTotal',
  quotaUnlimited: 'quotaUnlimited',
  quotaExpires: 'quotaExpires',
  quotaNoExpiry: 'quotaNoExpiry',
  quotaError: 'quotaError',
  quotaNotSignedIn: 'quotaNotSignedIn',
  quotaUpdated: 'quotaUpdated',
  quotaDashboardTitle: 'quotaDashboardTitle',
  quotaDashboardSubtitle: 'quotaDashboardSubtitle',
  quotaRefresh: 'quotaRefresh',
  quotaRefreshing: 'quotaRefreshing',
  quotaClose: 'quotaClose',
  quotaByPackage: 'quotaByPackage',
  quotaTotal: 'quotaTotal',
  quotaTotalRemain: 'quotaTotalRemain',
  quotaTotalShare: 'quotaTotalShare',
  quotaColPackage: 'quotaColPackage',
  quotaColRemain: 'quotaColRemain',
  quotaColExpiry: 'quotaColExpiry',
  patTail: 'patTail',
  signedIn: 'signedIn',
  quotaCycleUsed: 'quotaCycleUsed',
}
void _assertQuotaKeys

export type SidebarQuotaCardProps =
  PropsRuntime<'sidebar.footer.action'>
  & Partial<SidebarQuotaCardInjected>

/** Fallback translator: renders keys bare rather than throwing unbound. */
const fallbackT = (key: QuotaCopyKey): string => key

/**
 * Identity line under the dashboard card title: the redacted PAT tail when a
 * token is on file, plain signed-in copy if the summary is missing, and the
 * save-a-PAT hint otherwise. There is no nickname on a PAT document.
 */
function ownerText(status: QoderWebStatus | undefined, t: (key: QuotaCopyKey, params?: Record<string, unknown>) => string): string {
  if (status === undefined || status.status !== 'signed-in') return t('quotaNotSignedIn')
  const tail = status.pat?.patTail
  return tail === undefined ? t('signedIn') : t('patTail', { tail: `****${tail}` })
}

/** One bar in the footer card / dashboard: a merged group's figures. */
interface QuotaBarView {
  /** Package display name. */
  label: string
  /** `remain / size`, or the unlimited glyph, or the unknown-total copy. */
  detail: string
  /** Printed right-hand percentage; undefined when there is no ratio. */
  percent: string | undefined
  /** Fill width, clamped to [0, 100]. */
  barPercent: number
  /** Render in the error colour (nearly exhausted). */
  warn: boolean
  /** Group expiry, verbatim; undefined when none was reported. */
  packageEndTime: string | undefined
}

/** Project the credit accounts into the card's bar list. */
function buildBars(accounts: readonly { packageName: string; remain: number; size: number; unlimited?: true; packageEndTime?: string }[]): QuotaBarView[] {
  // Merge first, THEN the sidebar's visibility+ordering rule: live groups
  // render first (first-seen order), spent-but-not-expired groups sink to
  // the bottom (lowest priority), expired groups drop out entirely.
  const groups = visibleQuotaGroups(mergeCreditAccounts(accounts))
  const bars: QuotaBarView[] = []
  for (const group of groups) {
    const percent = group.unlimited ? undefined : clampPercent(group.remain, group.size)
    const detail = group.unlimited
      ? '∞'
      : percent === undefined
        ? `${group.remain.toLocaleString()} · ?`
        : `${group.remain.toLocaleString()} / ${group.size.toLocaleString()}`
    bars.push({
      label: group.packageName,
      detail,
      percent: percent === undefined ? undefined : `${Math.round(percent)}%`,
      barPercent: percent === undefined ? 0 : Math.max(2, percent),
      warn: !group.unlimited && percent !== undefined && percent < 20,
      packageEndTime: group.packageEndTime,
    })
  }
  return bars
}

/**
 * The quota ring — commandcode's glyph ported verbatim (`qdp-` classes): a
 * faint track plus an arc whose sweep is the consumption, drawn from 12
 * o'clock. Circumference 2πr = 45.55 at r = 7.25.
 */
function Ring({ percent, warn, size }: { percent: number; warn: boolean; size: number }): React.ReactNode {
  const clamped = Math.min(100, Math.max(0, percent))
  const circumference = 45.55
  const dashoffset = Math.round(circumference * (1 - clamped / 100) * 1000) / 1000
  return (
    <span className="qdp-glyph" aria-hidden="true">
      <svg viewBox="0 0 20 20" width={size} height={size} focusable="false">
        <circle cx="10" cy="10" r="7.25" fill="none" stroke="currentColor" strokeWidth="1.5" opacity="0.4" />
        <circle
          cx="10"
          cy="10"
          r="7.25"
          fill="none"
          stroke={warn ? 'var(--dsw-alias-state-error-primary)' : 'currentColor'}
          strokeWidth="2.5"
          strokeLinecap="round"
          strokeDasharray={String(circumference)}
          strokeDashoffset={String(dashoffset)}
          transform="rotate(-90 10 10)"
        />
      </svg>
    </span>
  )
}

/** One per-package row in the dashboard's detail table (NOT merged). */
interface PackageRow {
  name: string
  remain: number
  size: number
  percent: number | undefined
  warn: boolean
  packageEndTime: string | undefined
}

/**
 * The dashboard's detail rows: EVERY package as the upstream reported it —
 * no merging, exhausted ones included. The sidebar card shows the merged
 * overview; this panel is the itemised ledger, so collapsing here would
 * destroy the only place a per-package figure is visible.
 */
function buildPackageRows(accounts: readonly { packageName: string; remain: number; size: number; unlimited?: true; packageEndTime?: string }[]): PackageRow[] {
  // Every package renders unmerged (the itemised ledger), but the ordering
  // rule applies: live rows first, spent-yet-active rows sunk to the bottom,
  // expired rows dropped entirely.
  const ordered = sortPackageRows(accounts)
  return ordered.map(account => {
    const percent = account.unlimited === true ? undefined : clampPercent(account.remain, account.size)
    return {
      name: account.packageName,
      remain: account.remain,
      size: account.size,
      percent,
      warn: account.unlimited !== true && percent !== undefined && percent < 20,
      packageEndTime: account.packageEndTime,
    }
  })
}

/** Time-of-day formatter for the updated stamp. */
function timeText(ms: number): string {
  return new Date(ms).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
}

/** One variant's sidebar quota card. */
export function SidebarQuotaCard(props: SidebarQuotaCardProps): React.ReactNode {
  const { t = fallbackT, statusPath, open } = props
  const variantId = statusPath !== undefined ? variantOfStatusPath(statusPath) : 'qoder'
  const nameKey: QuotaCopyKey = variantId === 'qoder-global' ? 'quotaCardGlobal' : 'quotaCardCN'
  const wide = props.wide !== false
  const [failed, setFailed] = useState(false)
  // The saved toggle gates the card live; the shared store's revision is the
  // subscription, so a landed save re-renders (and re-gates) instantly — and
  // the SAME subscription delivers documents fetched by ANY surface (the
  // dashboard's refresh, the other card's poll, this card's own mount fetch),
  // so every surface always shows the same latest numbers.
  useSyncExternalStore(onQuotaSettingsChange, quotaSettingsRevision)
  const enabled = variantId === 'qoder' ? quotaToggles().cn : quotaToggles().global
  const status = quotaStatus(variantId)
  const signedIn = status?.status === 'signed-in'

  // Poll on the configured interval for as long as the card is enabled —
  // the user's design: the SIDEBAR card keeps itself current on the setting's
  // cadence (the freshness/cache rule lives on the panel's display path
  // only). Skips ticks while the document is hidden, and re-fetches when
  // visibility returns so a long-idle page catches up.
  useEffect(() => {
    if (statusPath === undefined || !enabled) return undefined
    let disposed = false
    let timer: number | undefined
    const controller = new AbortController()
    const refresh = async (): Promise<void> => {
      try {
        const response = await fetch(statusPath, { signal: controller.signal, headers: { accept: 'application/json' } })
        const body: unknown = await response.json()
        if (disposed) return
        if (!response.ok || !isQoderWebStatus(body)) {
          setFailed(true)
          return
        }
        setFailed(false)
        noteQuotaStatus(variantId, body)
      } catch {
        if (!disposed) setFailed(true)
      }
    }
    const isHidden = (): boolean => typeof document !== 'undefined' && document.hidden
    const loop = (): void => {
      if (isHidden()) return
      void refresh()
    }
    timer = window.setInterval(loop, Math.max(60_000, quotaPollMs()))
    void refresh()
    const onVisible = (): void => {
      if (!isHidden()) loop()
    }
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', onVisible)
    }
    return () => {
      disposed = true
      controller.abort()
      if (timer !== undefined) window.clearInterval(timer)
      if (typeof document !== 'undefined') {
        document.removeEventListener('visibilitychange', onVisible)
      }
    }
  }, [statusPath, enabled, variantId])

  // The gate is a render decision, not a registration decision (commandcode's
  // rule): the entry stays in the slot ledger while an off setting renders
  // nothing at all. It sits after every hook so the rules of hooks hold.
  if (enabled === false) return null

  const credits = status !== undefined && 'credits' in status ? status.credits : undefined
  const bars = credits === undefined ? [] : buildBars(credits.accounts ?? [])
  const lowest = bars.reduce<number | undefined>((acc, bar) => {
    if (bar.percent === undefined) return acc
    const value = Number.parseFloat(bar.percent)
    if (!Number.isFinite(value)) return acc
    return acc === undefined ? value : Math.min(acc, value)
  }, undefined)
  const ringPercent = failed || status === undefined ? 0 : credits?.unlimited === true ? 100 : lowest ?? 0
  const ringWarn = failed || (lowest !== undefined && lowest < 20)
  const fetchedAt = quotaStatusFetchedAt(variantId)
  const title = [
    t(nameKey),
    ...bars.map(bar => `${bar.label} ${bar.detail}${bar.percent === undefined ? '' : ` (${bar.percent})`}`),
    fetchedAt !== undefined ? `${t('quotaUpdated')} ${timeText(fetchedAt)}` : '',
  ].filter(part => part !== '').join(' · ')

  if (!wide) {
    return (
      <button
        type="button"
        className="qdp-railButton"
        aria-label={title}
        title={title}
        disabled={!signedIn}
        onClick={() => {
          if (!signedIn) return
          open?.()
        }}
      >
        <Ring percent={ringPercent} warn={ringWarn} size={18} />
      </button>
    )
  }

  return (
    <button
      type="button"
      className="qdp-foot"
      aria-label={title}
      title={title}
      disabled={!signedIn}
      onClick={() => {
        if (!signedIn) return
        open?.()
      }}
    >
      <span className="qdp-footTop">
        <Ring percent={ringPercent} warn={ringWarn} size={16} />
        <span className="qdp-footName">{t(nameKey)}</span>
        <span className="qdp-spacer" />
        {fetchedAt !== undefined ? <span className="qdp-updated">{t('quotaUpdated')} {timeText(fetchedAt)}</span> : null}
      </span>

      {failed ? (
        <span className="qdp-footRow">
          <span className="qdp-footLabel">{t('quotaError')}</span>
        </span>
      ) : bars.length === 0 ? (
        <span className="qdp-footRow">
          <span className="qdp-footLabel">
            {status === undefined
              ? '…'
              : !('credits' in status)
                ? t('quotaNotSignedIn')
                // Signed in but the balance fetch failed: say THAT, not
                // "sign in" — the two mean opposite actions.
                : (status.creditsError ?? t('quotaError'))}
          </span>
        </span>
      ) : (
        bars.map((bar, index) => (
          <span className="qdp-footRow" key={`${index}\u0000${bar.label}\u0000${bar.packageEndTime ?? ''}`}>
            <span className="qdp-footHead">
              <span className="qdp-footLabel" title={bar.packageEndTime !== undefined ? `${t('quotaExpires')} ${bar.packageEndTime}` : t('quotaNoExpiry')}>
                {bar.label}
              </span>
              <span className="qdp-footAmount">{bar.detail}</span>
              <span className="qdp-footPct">{bar.percent ?? ''}</span>
            </span>
            <span className="qdp-footBar">
              <span
                className={bar.warn ? 'qdp-footFill qdp-footFillWarn' : 'qdp-footFill'}
                style={{ width: `${bar.barPercent}%` }}
              />
            </span>
          </span>
        ))
      )}
    </button>
  )
}

/* ------------------------------------------------------------------ dashboard */

/**
 * The registration's inject face: the hooks compartment rides the renderer's
 * hooks→useX binding (the face itself is cached once per entry and spread, so
 * every value that moves MUST ride the hooks channel — a face getter would be
 * frozen at bind time).
 */
export interface QuotaDashboardInjected {
  hooks: {
    quotaDashboard: { getSnapshot: () => QuotaDashboardState; subscribe: (listener: () => void) => () => void }
  }
  t: (key: QuotaCopyKey, params?: Record<string, unknown>) => string
  statusPaths: readonly string[]
  refresh: () => void
  close: () => void
  /** Fetch the variant the user just picked (see {@link QuotaDashboardProps.onVariantPicked}). */
  onVariantPicked: (path: string) => void
}

/** Props the dashboard panel receives through its inject face. */
export interface QuotaDashboardState {
  /** Both variants' status documents, in `statusPaths` order. */
  documents: readonly (QoderWebStatus | undefined)[]
  /** When the shared fetch last settled. */
  fetchedAt: number | undefined
  /** Whether the shared fetch is in flight. */
  loading: boolean
  /** The variant the last card click asked for (drives the followed tab). */
  activePath: string
}

/** Props the dashboard panel receives through its inject face. */
export interface QuotaDashboardProps {
  t: (key: QuotaCopyKey, params?: Record<string, unknown>) => string
  /** Both variants' status routes, in the same order as the state's documents. */
  statusPaths: readonly string[]
  refresh: () => void
  close: () => void
  /**
   * The user picked a different variant's tab: the panel must fetch THAT
   * variant when the shared store holds nothing (or something stale) for it.
   * Its sidebar card may be off, so no other surface ever fetched it — without
   * this the tab showed "sign in" until the user toggled a setting.
   */
  onVariantPicked: (path: string) => void
  /**
   * The dashboard's live state, delivered as a selector hook over an
   * observable source — the commandcode `hooks` mechanism. The renderer
   * CACHES an inject face once per entry and SPREADS it into props, so a
   * getter on the face is read exactly once and frozen; any value that moves
   * must ride the hooks channel, whose `useQuotaDashboard(selector)` reads
   * the CURRENT source value on every render and resubscribes on change.
   */
  useQuotaDashboard: <T>(selector: (state: QuotaDashboardState) => T) => T
}

/**
 * The center-column dashboard, registered into the layout's keyed `main` slot
 * under the id the footer cards select, so card → panel is one navigation
 * entry. One variant at a time, switched by tabs (commandcode's account-tab
 * pattern): CN and international are separate accounts with separate package
 * lists, so mixing them into one column would misattribute every number.
 *
 * The panel fetches BOTH routes itself on mount and on the shared poll
 * interval — a user opening the panel must never wait for the sidebar cards'
 * next tick, and must never see a stale "sign in" just because no poll had
 * run yet. The tab defaults to the variant whose card was clicked.
 */
export function QuotaDashboard(props: QuotaDashboardProps): React.ReactNode {
  const { t = fallbackT, statusPaths, refresh, close, useQuotaDashboard, onVariantPicked } = props
  // The dashboard rides the SAME shared store as the sidebar cards: the
  // hooks-channel snapshot carries only the followed tab; documents come from
  // the shared revision subscription, so a refresh updates both surfaces at
  // once and the card never disagrees with the panel.
  useSyncExternalStore(onQuotaSettingsChange, quotaSettingsRevision)
  const state = useQuotaDashboard(s => s)
  const followedPath = state.activePath
  const [userPicked, setUserPicked] = useState<string | undefined>(undefined)
  const activePathResolved = userPicked ?? followedPath
  const activeVariant = variantOfStatusPath(activePathResolved)
  const status = quotaStatus(activeVariant)
  const loading = state.loading
  const fetchedAt = state.fetchedAt
  const credits = status !== undefined && 'credits' in status ? status.credits : undefined
  // The detail table: EVERY package, unmerged, exhausted included — the
  // sidebar card is the merged overview, this panel is the itemised ledger.
  const rows = credits === undefined ? [] : buildPackageRows(credits.accounts ?? [])
  const nameKey: QuotaCopyKey = activeVariant === 'qoder-global' ? 'quotaCardGlobal' : 'quotaCardCN'
  const signedIn = status?.status === 'signed-in'
  // Overall bar: remaining over granted, summed from the packages. Qoder's
  // `credits.total` is a USAGE percentage, not a remainder — it feeds the
  // "used this cycle" line below, never the total row. The host applies the
  // upstream totalSize floor; without it the per-package sum stands, and 0
  // renders the bar as indeterminate rather than asserting a false full usage.
  const totalRemain = credits === undefined ? 0 : credits.accounts.reduce((sum, account) => sum + account.remain, 0)
  const totalSize = credits?.totalSize ?? credits?.accounts.reduce((sum, account) => sum + account.size, 0) ?? 0
  const totalPercent = clampPercent(totalRemain, totalSize)
  const plan = status !== undefined && status.status === 'signed-in' ? status.plan : undefined
  return (
    <div className="qdp-main" role="region" aria-label={t('quotaDashboardTitle')}>
      <div className="qdp-mainInner">
        <header className="qdp-header">
          <div className="qdp-headerText">
            <h2 className="qdp-title">{t('quotaDashboardTitle')}</h2>
            <p className="qdp-subtitle">{t('quotaDashboardSubtitle')}</p>
          </div>
          <span className="qdp-spacer" />
          {fetchedAt !== undefined ? <span className="qdp-meta">{t('quotaUpdated')} {timeText(fetchedAt)}</span> : null}
          <QdpButton variant="outline" disabled={loading} onClick={() => refresh()}>
            {loading ? <QdpStateDot state="ongoing" /> : null}
            {loading ? t('quotaRefreshing') : t('quotaRefresh')}
          </QdpButton>
          <QdpIconButton label={t('quotaClose')} onClick={() => close()}>
            <span aria-hidden="true">×</span>
          </QdpIconButton>
        </header>

        {statusPaths.length > 1 ? (
          <div className="qdp-tabs" role="tablist" aria-label={t('quotaDashboardTitle')}>
            {statusPaths.map(path => {
              const variant = variantOfStatusPath(path)
              const key: QuotaCopyKey = variant === 'qoder-global' ? 'quotaCardGlobal' : 'quotaCardCN'
              return (
                <button
                  key={path}
                  type="button"
                  role="tab"
                  aria-selected={path === activePathResolved}
                  className={path === activePathResolved ? 'qdp-tab qdp-tabActive' : 'qdp-tab'}
                  onClick={() => {
                    setUserPicked(path)
                    // Fetch the newly shown variant when the shared store has
                    // nothing (or something stale) for it — its sidebar card
                    // being off means no other surface ever fetched it.
                    onVariantPicked(path)
                  }}
                >
                  {t(key)}
                </button>
              )
            })}
          </div>
        ) : null}

        <section className="qdp-dashCard" aria-label={t(nameKey)}>
          <div className="qdp-dashCardHead">
            <div className="qdp-inline">
              <span className="qdp-avatar">{activeVariant === 'qoder-global' ? 'GL' : 'CN'}</span>
              <span className="qdp-cardIdentity">
                <span className="qdp-dashCardTitle">{t(nameKey)}</span>
                <span className="qdp-cardOwner">{ownerText(status, t)}</span>
              </span>
            </div>
            {plan !== undefined || credits?.unlimited === true ? (
              <div className="qdp-inline">
                {plan !== undefined ? <QdpTag>{plan.planTierName}</QdpTag> : null}
                {plan?.organizationName !== undefined ? <QdpTag>{plan.organizationName}</QdpTag> : null}
                {plan?.endDate !== undefined ? <QdpTag>{`${t('quotaExpires')} ${plan.endDate}`}</QdpTag> : null}
                {credits?.unlimited === true ? <QdpTag>{t('quotaUnlimited')}</QdpTag> : null}
              </div>
            ) : null}
          </div>
          {!signedIn ? (
            <div className="qdp-notice">
              <p className="qdp-noticeTitle">{t('quotaNotSignedIn')}</p>
            </div>
          ) : credits === undefined ? (
            <div className="qdp-notice qdp-noticeError">
              <p className="qdp-noticeTitle">{t('quotaError')}</p>
              {status !== undefined && status.status === 'signed-in' && status.creditsError !== undefined ? (
                <p className="qdp-muted">{status.creditsError}</p>
              ) : null}
              <div className="qdp-actions">
                <QdpButton variant="outline" disabled={loading} onClick={() => refresh()}>
                  {t('quotaRefresh')}
                </QdpButton>
              </div>
            </div>
          ) : (
            <>
              {/* Overall total: remaining / granted, its share of the granted
                  total, the account-wide bar, then this cycle's usage. A zero
                  totalSize renders the bar indeterminate — never a false 100%. */}
              <p className="qdp-totalLine">
                {t('quotaTotalRemain')} <strong className="qdp-totalValue">{totalRemain.toLocaleString()}</strong>
                {' / '}
                {totalSize > 0 ? totalSize.toLocaleString() : t('quotaUnknownTotal')}
              </p>
              <p className="qdp-totalSub">
                {t('quotaTotalShare', {
                  percent: totalPercent === undefined ? t('quotaUnknownTotal') : `${totalPercent.toFixed(2)}%`,
                })}
              </p>
              <div
                className="qdp-bar"
                role="progressbar"
                aria-label={t('quotaTotal')}
                {...totalPercent === undefined
                  ? { 'aria-valuetext': t('quotaUnknownTotal') }
                  : { 'aria-valuemin': 0, 'aria-valuemax': 100, 'aria-valuenow': Math.round(totalPercent) }}
              >
                {totalPercent === undefined ? (
                  <div className="qdp-barFill qdp-barFillIndeterminate" />
                ) : (
                  <div
                    className={totalPercent < 20 ? 'qdp-barFill qdp-barFillWarn' : 'qdp-barFill'}
                    style={{ width: `${Math.max(2, totalPercent)}%` }}
                  />
                )}
              </div>
              {Number.isFinite(credits.total) || credits.cycleResetTime !== undefined ? (
                <p className="qdp-caption">
                  {Number.isFinite(credits.total) ? t('quotaCycleUsed', { percent: String(credits.total) }) : null}
                  {Number.isFinite(credits.total) && credits.cycleResetTime !== undefined ? ' · ' : null}
                  {credits.cycleResetTime !== undefined ? `${t('quotaExpires')} ${credits.cycleResetTime}` : null}
                </p>
              ) : null}

              <h3 className="qdp-blockTitle">{t('quotaByPackage')}</h3>
              {rows.length === 0 ? (
                <div className="qdp-empty">{t('quotaUnknownTotal')}</div>
              ) : (
                <table className="qdp-table">
                  <thead>
                    <tr>
                      <th>{t('quotaColPackage')}</th>
                      <th>{t('quotaColRemain')}</th>
                      <th>{t('quotaColExpiry')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((row, index) => (
                      <tr key={`${index}\u0000${row.name}\u0000${row.packageEndTime ?? ''}`}>
                        <td>{row.name}</td>
                        <td className="qdp-num">
                          <span className="qdp-numText">{row.remain.toLocaleString()} / {row.size.toLocaleString()}</span>
                          <span className="qdp-miniBar">
                            {row.percent === undefined ? (
                              <span className="qdp-footFill qdp-barFillIndeterminate" />
                            ) : (
                              <span
                                className={row.warn ? 'qdp-footFill qdp-footFillWarn' : 'qdp-footFill'}
                                style={{ width: `${Math.max(2, row.percent)}%` }}
                              />
                            )}
                          </span>
                        </td>
                        <td className="qdp-expiry" title={row.packageEndTime ?? t('quotaNoExpiry')}>
                          {row.packageEndTime ?? '—'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </>
          )}
        </section>
      </div>
    </div>
  )
}
