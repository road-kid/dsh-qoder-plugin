/** Qoder status card contributed to Harness Plugin configuration. */

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-settings-plugins/client'
import {
  QODER_AUTH_PATH,
  QODER_GLOBAL_AUTH_PATH,
  QODER_GLOBAL_PROBE_PATH,
  QODER_GLOBAL_STATUS_PATH,
  QODER_PROBE_PATH,
  QODER_STATUS_PATH,
} from '../status-paths.ts'
import type {
  QoderCatalogModelSnapshot,
  QoderCredentialSource,
  QoderWebCatalog,
  QoderWebCredits,
  QoderProbeAction,
  QoderVariantId,
  QoderWebStatus,
} from '../status-paths.ts'
import { isQoderWebStatus } from './status-document.ts'
import { QdpButton, QdpInput, QdpSegmented, QdpStateDot, QdpSwitch, QdpTag } from './controls.tsx'
import type { QdpDotState } from './controls.tsx'
import { mergeCreditAccounts, visibleQuotaGroups } from './quota-merge.ts'
import type { QoderSettingsKey } from './locales.ts'
import { QuotaSettingsContent, type QuotaSection, type QuotaSettingsScope } from './QuotaSettingsCard.tsx'
import {
  noteQuotaSignIn,
  noteQuotaStatus,
  onQuotaSettingsChange,
  quotaSignInState,
} from './quota-settings-store.ts'

/** Localized copy injected by the browser-plugin registration. */
export interface QoderPluginCardInjected {
  t: (key: QoderSettingsKey, params?: Record<string, unknown>) => string
  /** The bound quota settings face, when the host serves one. */
  scope?: QuotaSettingsScope<QuotaSection> | undefined
  /** Sign-in state per variant; a toggle is disabled when its variant is out. */
  signedIn?: () => { cn: boolean; global: boolean }
  /**
   * Which product variant this card instance renders.
   */
  variant?: QoderCardVariant
  /**
   * Whether to render as the unified Qoder card (merging quota settings + CN + Global with tabs).
   */
  unified?: boolean
}

/** The browser-visible half of a variant: identity, routes, and copy keys. */
export interface QoderCardVariant {
  id: QoderVariantId
  /** Locale key for the card title. */
  titleKey: QoderSettingsKey
  /** Locale key for the card intro line. */
  introKey: QoderSettingsKey
  /** Locale key for the not-signed-in hint. */
  signedOutKey: QoderSettingsKey
  /** Locale key for the PAT generation guide above the input. */
  patGuideKey: QoderSettingsKey
  /** Locale key for the PAT input placeholder (names the site to generate at). */
  patPlaceholderKey: QoderSettingsKey
  statusPath: string
  probePath: string
  authPath: string
}


/** China Qoder; the plugin's primary card and default. */
export const QODER_CN_CARD: QoderCardVariant = {
  id: 'qoder',
  titleKey: 'title',
  introKey: 'intro',
  signedOutKey: 'signedOutHint',
  patGuideKey: 'patGuide',
  patPlaceholderKey: 'patPlaceholder',
  statusPath: QODER_STATUS_PATH,
  probePath: QODER_PROBE_PATH,
  authPath: QODER_AUTH_PATH,
}

/** International Qoder Global. */
export const QODER_GLOBAL_CARD: QoderCardVariant = {
  id: 'qoder-global',
  titleKey: 'titleAI',
  introKey: 'introAI',
  signedOutKey: 'signedOutHintAI',
  patGuideKey: 'patGuideAI',
  patPlaceholderKey: 'patPlaceholderAI',
  statusPath: QODER_GLOBAL_STATUS_PATH,
  probePath: QODER_GLOBAL_PROBE_PATH,
  authPath: QODER_GLOBAL_AUTH_PATH,
}

/** Both cards, in display order (China first). */
export const QODER_CARD_VARIANTS: readonly QoderCardVariant[] = [QODER_CN_CARD, QODER_GLOBAL_CARD]
/**
 * Props delivered by the Plugins page's configuration seats.
 *
 * `view` is the owner's contract (`PluginConfigViewProps` in
 * `ui-plugin-manager`): `summary` asks for the one-liner the card list shows and
 * the fallback for a row with no description, `page` asks for the configuration
 * body. On `page` the OWNER already draws the title, icon, and breadcrumb, so
 * this component draws no heading and no disclosure chrome of its own.
 *
 * The slot is named by the seat this component is primarily registered into;
 * the sibling registration (`plugins.bundle.config`) passes the same props.
 */
export type QoderPluginCardProps =
  PropsRuntime<'plugins.row.config'>
  & Partial<QoderPluginCardInjected>

const POLL_INTERVAL_MS = 60_000

/**
 * Map the status document's state onto the local state-dot vocabulary.
 *
 * `loading` is its own state: before the first response the card knows nothing
 * about the account, so it must not borrow the signed-out grey — that would read
 * as "nobody is signed in" when the truth is "not read yet". The dot itself is
 * rendered by the `QdpStateDot` control, so no colour literals live here.
 */
function dotStateOf(status: 'loading' | QoderWebStatus['status']): QdpDotState {
  if (status === 'signed-in') return 'done'
  if (status === 'error') return 'error'
  if (status === 'loading') return 'ongoing'
  return 'idle'
}

function formatNumber(value: number): string {
  return new Intl.NumberFormat(undefined).format(value)
}

function formatPercent(value: number): string {
  return new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 }).format(value)
}

/** Date-only formatting for expiries: the day is what a validity window means. */
function formatDate(ms: number): string {
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(new Date(ms))
}

function formatTime(ms: number): string {
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(ms))
}

function formatCycleReset(time: string): string {
  const parsed = Date.parse(time)
  if (!Number.isNaN(parsed)) return formatTime(parsed)
  return time
}

function patSourceText(source: QoderCredentialSource, t: QoderPluginCardInjected['t']): string {
  if (source === 'env') return t('patSourceEnv')
  if (source === 'cli') return t('patSourceCli')
  return t('patSourceCard')
}

/**
 * One billing package as a labeled progress bar.
 *
 * A package whose allowance the upstream never reported (`size` not positive)
 * has no percentage to state. It must not fall back to 100%: the plugin would be
 * claiming a full quota it knows nothing about, which is the opposite of the
 * honest "remaining N" line printed below it. Unknown size therefore renders the
 * percent slot as unknown copy and an unfilled, indeterminate track.
 */
function CreditBar({ label, remain, size, unlimited, packageEndTime, t }: {
  label: string
  remain: number
  size: number
  unlimited?: boolean | undefined
  packageEndTime?: string | undefined
  t: QoderPluginCardInjected['t']
}): React.ReactNode {
  const expiry = packageEndTime === undefined
    ? null
    : <p className="qdp-rate">{t('quotaExpires')} {formatCycleReset(packageEndTime)}</p>
  if (unlimited === true) {
    const quotaText = t('unlimitedQuota')
    return (
      <div className="qdp-group">
        <div className="qdp-label">
          <span>{label}</span>
          <span>{quotaText}</span>
        </div>
        <div
          className="qdp-track"
          role="progressbar"
          aria-label={label}
          /*
           * "Uncapped" is not "100% remaining", so the range attributes are
           * omitted and no fill is drawn: an uncapped quota has no proportion
           * to state, and a full bar would assert one.
           */
          aria-valuetext={quotaText}
        />
        <p className="qdp-body">{quotaText}</p>
        {expiry}
      </div>
    )
  }
  const sizeKnown = size > 0
  const detail = sizeKnown
    ? t('exactRemaining', { remain: formatNumber(remain), size: formatNumber(size) })
    : t('creditPackageUnknownSize', { remain: formatNumber(remain) })
  const percent = sizeKnown ? (remain / size) * 100 : undefined
  const display = percent === undefined
    ? t('percentUnknown')
    : t('percentRemaining', { percent: formatPercent(percent) })
  return (
    <div className="qdp-group">
      <div className="qdp-label">
        <span>{label}</span>
        <span>{display}</span>
      </div>
      <div
        className="qdp-track"
        role="progressbar"
        aria-label={label}
        /*
         * No numeric value when the size is unknown: the range attributes are
         * omitted so assistive technology reports an indeterminate bar rather
         * than a second, louder repeat of the false 100%.
         */
        {...percent === undefined
          ? { 'aria-valuetext': detail }
          : { 'aria-valuemin': 0, 'aria-valuemax': 100, 'aria-valuenow': percent }}
      >
        {/* Fill width is the only dynamic value; colour/radius come from the
            qdp-barFill class (never a literal token fallback). */}
        {percent === undefined
          ? null
          : <div className="qdp-barFill" style={{ width: `${String(Math.max(0, Math.min(100, percent)))}%` }} />}
      </div>
      <p className="qdp-body">{detail}</p>
      {expiry}
    </div>
  )
}


/**
 * The 额度 section body: account-wide remaining/total headline, the cycle reset
 * time, then ONE progress row per merged credit group.
 *
 * The accounts are merged first (`mergeCreditAccounts`) so a package bought
 * several times reads as one bar with summed figures instead of near-duplicate
 * rows, and filtered through `visibleQuotaGroups` so spent rows stay out of the
 * overview while anything still has credit. A credit read failure renders as an
 * alert with an in-place retry instead of a silent blank: the message travels on
 * the status document's `creditsError`.
 */
function QuotaSummary({ credits, creditsError, t, busy, onRetry }: {
  credits?: QoderWebCredits | undefined
  creditsError?: string | undefined
  t: QoderPluginCardInjected['t']
  busy: boolean
  onRetry: () => void
}): React.ReactNode {
  if (creditsError !== undefined) {
    /* A failed credit read is visible and retryable in place: a silent blank
       would read as "no allowance" instead of "not read yet". */
    return (
      <div className="qdp-alert qdp-alertError" role="alert">
        <span>{t('creditsError', { message: creditsError })}</span>
        <div className="qdp-actions">
          <QdpButton disabled={busy} onClick={onRetry}>
            {busy ? t('refreshing') : t('refresh')}
          </QdpButton>
        </div>
      </div>
    )
  }
  if (credits === undefined) return <p className="qdp-empty">{t('creditsNoData')}</p>
  const groups = visibleQuotaGroups(mergeCreditAccounts(credits.accounts))
  const totalRemain = groups.reduce((sum, group) => sum + group.remain, 0)
  const declaredSize = groups.reduce((sum, group) => sum + group.size, 0)
  const totalSize = credits.totalSize ?? declaredSize
  const unlimited = credits.unlimited === true
  const usage = Number.isFinite(credits.total)
    ? t('creditsUsed', { percent: formatPercent(credits.total) })
    : unlimited ? t('creditsUsedUnlimited') : t('creditsNoData')
  return (
    <>
      <p className="qdp-totalLine">
        {t('quotaTotalRemain')}{' '}
        <strong className="qdp-totalValue">{unlimited ? t('quotaUnlimited') : formatNumber(totalRemain)}</strong>
        {unlimited ? null : <>{' / '}{totalSize > 0 ? formatNumber(totalSize) : t('quotaUnknownTotal')}</>}
      </p>
      <p className="qdp-totalSub">{usage}</p>
      {credits.cycleResetTime === undefined
        ? null
        : <p className="qdp-windowReset">{t('cycleResetAt', { time: formatCycleReset(credits.cycleResetTime) })}</p>}
      {groups.length === 0
        ? <p className="qdp-empty">{t('creditsNoData')}</p>
        : groups.map((group, index) => (
          <CreditBar
            key={`${group.packageName}-${String(index)}`}
            label={group.packageName}
            remain={group.remain}
            size={group.size}
            unlimited={group.unlimited}
            packageEndTime={group.packageEndTime}
            t={t}
          />
        ))}
    </>
  )
}


/**
 * Context capacity, listed in full.
 *
 * Every model the upstream reports a capacity for, largest first. A one-line
 * summary with the exceptions on hover was tried and rejected: capacity is
 * reference data you scan by model, and hiding most of it behind a hover made
 * the common case (a model you already have in mind) the hard one to look up.
 *
 * Purely a report of the upstream's own numbers — the middle alternatives the
 * upstream lists between the default and the maximum are display-only (the
 * upstream honours the default and the maximum, nothing between), so the only
 * control is the maximum-window preference below, which flips every eligible
 * model between its default and its largest declared window.
 */
function formatTokens(tokens: number): string {
  if (tokens >= 1_000_000 && tokens % 1_000_000 === 0) return `${tokens / 1_000_000}M`
  if (tokens >= 1_000 && tokens % 1_000 === 0) return `${tokens / 1_000}K`
  return String(tokens)
}

/**
 * A credit multiplier, spelled the way Qoder spells it: the number first, then
 * `x` — `0.0x` for a free model, `0.1x`, `0.5x`, `1.4x`.
 *
 * The upstream's own label is `x<n>` (see `normalizeCredits`), but the user
 * reads the rate as a price multiplier ("half price"), and every Qoder surface
 * they compared against prints it after the number. Two decimals are ALWAYS
 * shown, so the free tier reads `0.0x` rather than `0x`: the column then has
 * one decimal width throughout, and `0.0x` says "a rate that happens to be
 * zero" where a bare `0x` reads like a different kind of value.
 */
function formatRate(factor: number): string {
  return `${factor.toFixed(1)}x`
}

/**
 * 「使用与签到」section body: the claim ledger beside the claim action.
 *
 * The credit breakdown moved out of this panel into its own 额度 section — one
 * surface answers one question. What remains is the check-in half: the ledger
 * of claimed grants on the left and today's claim CTA (with the next automatic
 * run) on the right. `qdp-twoUp` falls back to one column on narrow pages.
 */
function UsageCheckInPanel({ checkIn, t, busy, checkingIn, checkInNotice, autoCheckIn, onCheckIn, clearingLogs, logsDisabled, onClearLogs }: {
  checkIn?: Extract<QoderWebStatus, { status: 'signed-in' }>['checkIn'] | undefined
  t: QoderPluginCardInjected['t']
  busy?: boolean
  checkingIn?: boolean
  checkInNotice?: string | undefined
  /**
   * Whether this variant's AUTOMATIC check-in toggle is on. The scheduler
   * arms a timer for every variant (so a toggle flipped on later still
   * fires), which means `nextRunAt` exists even while the feature is off —
   * showing it then is what made the card promise a run that would not
   * happen. The line is gated on this flag.
   */
  autoCheckIn?: boolean
  onCheckIn: () => void
  /** A clear-logs request is in flight. */
  clearingLogs?: boolean | undefined
  /** No usable credential, so the ledger's clear action cannot run. */
  logsDisabled?: boolean | undefined
  onClearLogs?: (() => void) | undefined
}): React.ReactNode {
  /**
   * Today's benefit is already in — whether this process granted it or merely
   * found the upstream reporting it as claimed.
   *
   * `already-claimed` must count: the upstream answers that way for every later
   * request on a claimed day, so treating only `claimed` as "done" re-armed the
   * button and invited the repeat click that used to append a phantom ledger
   * row (see the ledger's filter below).
   *
   * The DATE must count too, and this is the part that was missing. `checkIn`
   * is the persisted record, not a live reading: a `claimed` row from three
   * days ago satisfies the status test forever, so the button stayed greyed
   * out reading 「今日已签到」 on days the user had not checked in at all —
   * the record's own `lastDate` was never consulted. Comparing against
   * `today` (stamped host-side in UTC+8, the day the scheduler itself uses)
   * returns the button to 「立即领取」 once the record stops describing today.
   *
   * Both tests are required, and neither is redundant: `status` alone pins the
   * button forever, while a date alone would treat a failed or no-campaign
   * attempt earlier today as a completed claim.
   */
  const claimedToday = checkIn !== undefined
    && checkIn.lastDate === checkIn.today
    && (checkIn.status === 'claimed' || checkIn.status === 'already-claimed')
  return (
    /*
     * One row of two panels: the claim ledger on the left, today's claim CTA on
     * the right. `qdp-twoUp` falls back to one column on narrow pages. The CTA
     * is the one action in this section worth the md size; it stays disabled
     * while a claim is pending and once today's claim is in.
     */
    <div className="qdp-twoUp">
      <CheckInLedger
        logs={checkIn?.logs}
        t={t}
        {...clearingLogs === undefined ? {} : { clearing: clearingLogs }}
        {...logsDisabled === undefined ? {} : { disabled: logsDisabled }}
        {...onClearLogs === undefined ? {} : { onClear: onClearLogs }}
      />
      <div className="qdp-panel">
        <div className="qdp-panelHead">
          <h3 className="qdp-panelTitle">{t('paneUsage')}</h3>
        </div>
        {/*
         * Only 「下次自动领取」 is stated here. The old 「今日：{state}」 line
         * described the plugin's own state machine and called a manual claim an
         * automatic one; the CTA's disabled state already says whether today's
         * claim is in.
         */}
        {autoCheckIn !== true || checkIn?.nextRunAt === undefined ? null : (
          <p className="qdp-panelMeta">{t('checkInNextRun', { time: formatTime(checkIn.nextRunAt) })}</p>
        )}
        {/*
         * 「立即领取」 is an ACTION: once today's claim is in, re-offering it
         * invites a request the upstream will only refuse. The claimed state
         * keeps the same button in a quiet variant and disables it.
         */}
        <QdpButton
          variant={claimedToday ? 'outline' : 'primary'}
          size="md"
          className="qdp-claimBtn"
          disabled={busy === true || checkingIn === true || claimedToday}
          onClick={onCheckIn}
        >
          {checkingIn === true ? t('checkInChecking') : claimedToday ? t('checkInClaimedToday') : t('checkInNow')}
        </QdpButton>
        {checkInNotice === undefined ? null : <p className="qdp-body">{checkInNotice}</p>}
      </div>
    </div>
  )
}

/**
 * 「3 天内到期」的统计窗口。30 天有效期的包还剩 20 天才到期,不该出现在
 * 「3 天内到期」里 —— 这里统计的是窗口内真的会作废的笔,不是「所有还没过期的」。
 * workbuddy 的「最近 3 天到期」就是这个读法。
 */
const SOON_WINDOW_MS = 3 * 24 * 60 * 60 * 1000

/**
 * 最近的签到记录(BOX):插件内每次签到领取到的资源包、数量与到期时间。
 *
 * 这是原来「签到日志」表格的替代:表格只能证明「点过按钮」,而这里回答的是
 * 用户真正关心的问题 —— 我手上有哪些还没过期的资源包,各自什么时候作废。
 * 因此按「领取时间」倒序列出,并在每行右侧给出该笔的到期日;上游没给有效期
 * 的笔(手动签到)按领取后 30 天补算,不再显示「有效期未知」。
 */
function CheckInLedger({ logs, t, clearing, disabled, onClear }: {
  logs: readonly {
    id: string
    date: string
    timestamp: number
    status: string
    amount?: number | undefined
    expiresAtMs?: number | undefined
  }[] | undefined
  t: QoderPluginCardInjected['t']
  /** A clear request is in flight; the button reads 「正在清空…」. */
  clearing?: boolean | undefined
  /** No usable credential, so the action cannot run. */
  disabled?: boolean | undefined
  onClear?: (() => void) | undefined
}): React.ReactNode {
  const now = Date.now()
  /*
   * 手动在插件里签到的 +100 Credits,上游不回带有效期;活动的口径是领取后
   * 30 天有效,所以按领取时间补算。活动口径变化时改这一个常数即可 —— 不写
   * 进存储,存储里的字段仍然忠实于上游给没给。
   */
  const MANUAL_GRANT_VALIDITY_MS = 30 * 24 * 60 * 60 * 1000
  const effectiveExpiry = (entry: { timestamp: number; expiresAtMs?: number | undefined }): number =>
    entry.expiresAtMs ?? entry.timestamp + MANUAL_GRANT_VALIDITY_MS
  /*
   * 界面能显示几条就显示几条:不再有 7/30 天切换,也不再按时间窗过滤。
   * 台账回答的是「我手上有哪些资源包」,把窗口做成按钮只是把同一个列表切成
   * 两半,用户还得猜哪一半是对的。条数由 CSS 的行高上限决定(见
   * .qdp-ledgerList 的 max-height),多了就滚动 —— 而不是悄悄丢掉。
   */
  const claimed = (logs ?? [])
    /*
     * 只有真的领到的那一笔才入账。
     *
     * `already-claimed` 是「上游今天已经领过」的观察,不是一次领取 —— 它的
     * timestamp 是那次请求的时钟,不是发放时刻(上游根本不回传发放时刻),
     * 所以把它当成一笔资源包会在台账上写出一个从未发生过的时间。这份台账要
     * 回答的是「我手上有哪些资源包、各自的到期日」,所以只统计 claimed;
     * no-campaign / error 同样不是资源包。
     */
    .filter(entry => entry.status === 'claimed')
    .sort((a, b) => b.timestamp - a.timestamp)
  /*
   * 「3 天内到期」只统计在这个窗口内真的会作废的笔 —— 不是「所有还没过期的」。
   * workbuddy 的「最近 3 天到期」就是这个读法:30 天有效期的包还剩 20 天才
   * 到期,它不该出现在「3 天内到期」里。有效期按补算后的口径算(见上),
   * 所以手动签到的包也参与统计。
   */
  const expiringSoon = claimed.filter(entry => {
    const expiry = effectiveExpiry(entry)
    return expiry > now && expiry <= now + SOON_WINDOW_MS
  })
  const expiringSoonTotal = expiringSoon.reduce((sum, entry) => sum + (entry.amount ?? 0), 0)
  return (
    <div className="qdp-panel">
      <div className="qdp-panelHead">
        <h3 className="qdp-panelTitle">{t('ledgerHeading')}</h3>
        {onClear === undefined ? null : (
          /* 清空日志 lives on its own panel head: the ledger rewrite dropped the
             control that used to sit beside the log table, leaving the
             clear-checkin-logs action with no way to reach it. */
          <QdpButton
            variant="dangerQuiet"
            disabled={disabled === true || clearing === true}
            onClick={onClear}
          >
            {clearing === true ? t('checkInClearing') : t('checkInClear')}
          </QdpButton>
        )}
      </div>
      {claimed.length === 0 ? (
        <p className="qdp-empty">{t('ledgerEmpty')}</p>
      ) : (
        <div className="qdp-logList qdp-ledgerList">
          {claimed.map(entry => {
            const expiry = effectiveExpiry(entry)
            const expired = expiry <= now
            return (
              <div key={entry.id} className="qdp-ledgerRow">
                <span className="qdp-ledgerDate">{formatTime(entry.timestamp)}</span>
                <span className="qdp-ledgerAmount">{entry.amount === undefined ? '—' : `+${entry.amount}`}</span>
                <span className={expired ? 'qdp-ledgerExpiry qdp-ledgerExpired' : 'qdp-ledgerExpiry'}>
                  {expired ? t('ledgerExpired') : t('ledgerExpiresAt', { date: formatDate(expiry) })}
                </span>
              </div>
            )
          })}
        </div>
      )}
      {/* 底部到期小结:与上面的记录行用一条分隔线断开,只占 3 行的空间,
          剩下的高度留给上面的记录列表。 */}
      <div className="qdp-ledgerFoot">
        <span className="qdp-panelMeta">{t('ledgerExpiringHeading', { days: 3 })}</span>
        <span className="qdp-ledgerFootValue">{String(expiringSoonTotal)}</span>
      </div>
    </div>
  )
}

/**
 * 「模型」面板:可见性开关与每个模型的上下文容量合并到同一行(原先一个只有
 * 一个复选框的「上下文」tab + 一个纯开关列表),刷新模型按钮挪进本栏头部
 * (原先孤悬在账号行上)。max-window 偏好置于列表上方。
 */
function ModelsPane({ models, disabledModels = [], catalog, t, busy, onSetModelContextWindow, onSetModelsEnabled, onRefreshModels }: {
  models: readonly QoderCatalogModelSnapshot[] | undefined
  disabledModels?: readonly string[] | undefined
  catalog?: QoderWebCatalog | undefined
  t: QoderPluginCardInjected['t']
  busy?: boolean
  onSetModelContextWindow: (model: string, window: number) => void
  onSetModelsEnabled: (models: readonly string[], enabled: boolean) => void
  onRefreshModels: () => void
}): React.ReactNode {
  /*
   * Display order, NOT upstream order.
   *
   * The discovery answer arrives in whatever order the upstream lists it,
   * which put 「Qoder Auto」 second-to-last — an arbitrary place for the
   * default/auto entry a user looks for first. Rather than trusting it, the
   * roster is sorted by a deliberate tier: the auto/default entry first, then
   * the strongest tiers, then the cheap ones, and finally anything the
   * upstream added that this list does not know about (kept, at the end, in
   * upstream order — an unknown entry is still better than a hidden one).
   */
  const MODEL_TIER: readonly string[] = ['auto', 'ultimate', 'performance', 'cmodel', 'efficient', 'lite']
  const tierOf = (id: string): number => {
    const index = MODEL_TIER.indexOf(id)
    return index === -1 ? MODEL_TIER.length : index
  }
  /*
   * The sort key is the model's DEFAULT window, never the effective one.
   *
   * `contextWindow` carries whatever override the user just picked (catalog.ts
   * all(): an override replaces contextWindow outright), so sorting by it moved
   * a row the moment its own chooser changed — the list "乱动" under the cursor
   * the user was aiming at. `defaultContextWindow` is the upstream's own value
   * and is untouched by the override, so the order holds still while windows
   * are edited. Within a tier the wider default leads.
   */
  const capabilityOf = (model: QoderCatalogModelSnapshot): number =>
    model.defaultContextWindow ?? model.contextWindow ?? 0
  const list = [...(models ?? [])].sort((a, b) => {
    const byTier = tierOf(a.id) - tierOf(b.id)
    if (byTier !== 0) return byTier
    const byCapability = capabilityOf(b) - capabilityOf(a)
    // Last resort: the id, so two models with the same tier and window keep a
    // fixed order across renders instead of swapping by array position.
    return byCapability !== 0 ? byCapability : a.id.localeCompare(b.id)
  })
  /*
   * 滑块的横轴是整张列表共用的,不是每行各画一条。
   *
   * 之前 stops 从本行自己的声明档位算出来,于是「只有 200K 一档」的模型
   * 把 200K 铺在自己的轨道上(把手顶到最右),而 [200K,400K,1M] 的行把
   * 同样三档摊开 —— 两行长度一样、刻度却对不齐,同一个 200K 落在不同的
   * 列上,用户没法横向比较。现在按 token 的绝对值取一个全局端点:每行
   * 用同样的像素宽度,刻度出现在 value/axisMax 的比例位置,200K 在所有
   * 行里都停在同一列。
   */
  const axisMax = list.reduce((best, model) => {
    const declaredMax = (model.supportedContextWindows ?? []).reduce((top, value) => (value > top ? value : top), 0)
    const fallback = model.defaultContextWindow ?? model.contextWindow ?? 0
    const rowMax = declaredMax > 0 ? declaredMax : fallback
    return rowMax > best ? rowMax : best
  }, 0)
  /*
   * 每一行画哪些刻度:优先用上游声明过的档位,再补上全局端点 —— 只画本行
   * 档位的话,一档的模型刻度会散落在别处,又多出对不齐的问题;端点补进去
   * 后所有行的关键刻度都落在同一列。最后加上 0 起点,0 是起点不是档位
   * (见下面 stops 的注释),它负责把轨道铺满,拖上去不写任何东西。
   */
  const axisTicks = (declared: readonly number[]): number[] =>
    [...new Set([0, ...declared, axisMax])]
      .filter(value => Number.isFinite(value) && value >= 0 && value <= axisMax)
      .sort((a, b) => a - b)
  return (
    <div className="qdp-list">
      {/* No pane title: the section head above already names this pane. The row
          keeps only the catalogue provenance and its refresh control. */}
      <div className="qdp-modelHead">
        <span />
        <div className="qdp-inline">
          {catalog === undefined ? null : (
            <span className="qdp-modelMeta">
              {catalog.source === 'live' && catalog.fetchedAt !== undefined
                ? t('catalogLive', { time: formatTime(catalog.fetchedAt) })
                : catalog.source === 'saved' && catalog.fetchedAt !== undefined
                  ? t('catalogSaved', { time: formatTime(catalog.fetchedAt) })
                  : t('catalogFallback')}
            </span>
          )}
          <QdpButton disabled={busy === true} onClick={onRefreshModels}>
            {busy === true ? t('refreshingModels') : t('refreshModels')}
          </QdpButton>
        </div>
      </div>
      {catalog?.error === undefined ? null : (
        /* A stale/failed catalogue read is visible where the models are, with the
           same refresh control as the head row serving as its retry. */
        <div className="qdp-alert qdp-alertError" role="alert">
          <span>{t('catalogError', { message: catalog.error })}</span>
          <div className="qdp-actions">
            <QdpButton disabled={busy === true} onClick={onRefreshModels}>
              {busy === true ? t('refreshingModels') : t('refreshModels')}
            </QdpButton>
          </div>
        </div>
      )}
      {list.length === 0 ? (
        <p className="qdp-empty">{t('modelsNoModels')}</p>
      ) : (
        <>
          {/*
           * 列头(需求 3):横线把工具行与列表分开,线下列出两列的标题 ——
           * 左边是被勾选的模型名,右边是这一行的上下文窗口滑块。没有列头时
           * 右侧那排滑块看不出是什么,只能靠猜。
           */}
          <div className="qdp-modelColumns">
            <span>{t('modelNameColumn')}</span>
            <span>{t('contextHeading')}</span>
          </div>
          <div className="qdp-modelList">
          {list.map(model => {
            const isModelEnabled = !disabledModels.includes(model.id)
            const capacity = model.contextWindow
            /*
             * 滑块只走上游声明过的档位,Qoder 没报过的值一个都不发。
             *
             * stops 升序,而且第 0 位是「起点」而不是档位 —— 起点标 0,
             * 只用来把轨道铺满(否则模型只剩一档时连条都画不出来),
             * 拖到它上面不写任何东西。真实档位从下标 1 起,所以顺序即
             * 档位高低;原先给 select 用的是降序(大的在前),滑块必须
             * 反过来,否则往右拖反而变小。
             */
            /*
             * 刻度按全局横轴取,而不是只取本行的档位。行为上的两处要点:
             *
             * (a) 把手/刻度的位置一律用 value/axisMax 的比例,所以「只有
             *     200K 一档」的模型,把手停在 200K 处而不是顶到最右 ——
             *     最右是 axisMax(1M),它根本没这个档位。
             * (b) 下标仍然保留 0 号起点,但它只用来铺满轨道;起点不可写,
             *     真实档位是 axisTicks 里 >0 的那些。
             *
             * 用户可选的档位仍是「本行声明过的」:轴上多出来的中间刻度只是
             * 让人对齐,不能因为别的行支持 1M 就允许这一行写 1M —— 发出去
             * 的值必须在上游声明列表里,否则等于替上游发明档位。
             */
            const declared = [...new Set(model.supportedContextWindows ?? (capacity !== undefined ? [capacity] : []))].sort((a, b) => a - b)
            const stops = axisTicks(declared)
            const axisSpan = axisMax > 0 ? axisMax : 1
            const ratioOf = (value: number): number => (value / axisSpan) * 100
            const effective = capacity ?? model.defaultContextWindow
            /*
             * 把手停在哪:先看当前值是否正好落在某个刻度上;不在时(上游
             * 改了口径、或旧配置留下裸值)退回最近的一档,只影响「把手画
             * 在哪」,不会因为渲染而回写任何东西 —— 写回只发生在用户真的
             * 拖动之后。
             */
            const nearest = effective === undefined || effective <= 0
              ? 0
              : stops.reduce((best, choice, index) =>
                  Math.abs(choice - effective) < Math.abs(stops[best]! - effective) ? index : best, 0)
            const currentValue = effective === undefined || effective <= 0 ? 0 : stops[nearest] ?? 0
            const currentIndex = stops.indexOf(currentValue)
            // 可写档位:本行声明过的那些,按轴上的下标排列。
            const writable = new Set(declared)
            return (
              <div
                key={model.id}
                className="qdp-modelRow"
                style={{ opacity: isModelEnabled ? 1 : 0.65 }}
              >
                <label className="qdp-modelEnable">
                  <input
                    type="checkbox"
                    checked={isModelEnabled}
                    disabled={busy}
                    onChange={event => { onSetModelsEnabled([model.id], event.currentTarget.checked) }}
                  />
                  <span className="qdp-modelCopy">
                    <span className="qdp-modelName">
                      {model.name}
                      {/*
                       * 积分消耗倍率(需求 2):直接用上游给的数字,格式化成
                       * 「0.5x」这种写法。上游没说倍率时留空 —— 不猜一个
                       * x1,那会把「不知道」说成「基准价」。
                       */}
                      {model.priceFactor === undefined ? null : (
                        <span className="qdp-modelRate">{formatRate(model.priceFactor)}</span>
                      )}
                    </span>
                    <span className="qdp-modelMeta">{model.id}</span>
                  </span>
                </label>
                <span className="qdp-contextPicker">
                  {declared.length > 0 ? (
                    /*
                     * 每个有档位的模型都画轨道 —— 只有一个档位的模型也有条
                     * (把手停在那一档,拖到起点 0 不写任何东西,所以事实上
                     * 不可滑动),不能因为「没得拖」就退化成一行文字:用户
                     * 要的是轨道始终可见,起点把轨道铺满正是为了这个。
                     */
                    <span className="qdp-windowSlider">
                        {/*
                         * 视觉层:轨道 + 已选填充 + 把手。真正的输入是下面那层
                         * 透明的 range input,拖拽、点击定位、方向键都由它接,
                         * 所以键盘可达性和原生行为都保持不变。
                         *
                         * 位置一律按 token 的绝对值占全轴的比例来算(不是按
                         * 下标),这是「所有行的条一样长、同一档在同一列」的
                         * 关键:轨道宽度是每行同样的像素,值决定刻度落在哪。
                         */}
                        <span className="qdp-windowTrack" aria-hidden="true">
                          <span
                            className="qdp-windowFill"
                            style={{ width: `${String(ratioOf(currentValue))}%` }}
                          />
                          <span
                            className="qdp-windowKnob"
                            style={{ left: `${String(ratioOf(currentValue))}%` }}
                          />
                          <input
                            className="qdp-windowInput"
                            type="range"
                            min={0}
                            max={stops.length - 1}
                            step={1}
                            value={currentIndex}
                            disabled={busy}
                            aria-label={`${model.name} ${t('contextHeading')}`}
                            aria-valuetext={currentValue <= 0 ? t('contextHeading') : formatTokens(currentValue)}
                            onChange={event => {
                              // 滑块的取值是轴上下标,但发出去的永远是那一档
                              // 的真实 token 数 —— 上游字段的语义没有变。轴上
                              // 的 0 号是起点、别的行贡献的中间刻度也不是本行
                              // 声明过的档位,这两类都不写任何东西。
                              const index = Number(event.currentTarget.value)
                              const choice = stops[index]
                              if (choice !== undefined && writable.has(choice)) onSetModelContextWindow(model.id, choice)
                            }}
                          />
                        </span>
                        <span className="qdp-windowTicks" aria-hidden="true">
                          {/*
                           * 首尾必定标出,中间最多再标一档,标满会糊成一片。
                           * 0 号是起点,只画刻度线不印数字(需求:从 0 档开始
                           * 显示条,但不显示 0 这个数字)。
                           */}
                          {(() => {
                            /*
                             * 标签只印本行声明过的档位,而且不超过 3 个就全部
                             * 印出来(200K/400K/1M 一档不落 —— 上一版把起点
                             * 也算进「最多三档」,400K 的标签就是这样丢的);
                             * 更多档时才收敛到首、中、尾。轴上由别的行贡献的
                             * 中间刻度不印数字 —— 那不是这一行能选的档位,
                             * 印出来就是在暗示可以选。起点 0 只画刻度线。
                             */
                            const labelled = declared.length <= 3
                              ? new Set(declared)
                              : new Set([declared[0], declared[Math.floor((declared.length - 1) / 2)], declared[declared.length - 1]])
                            return stops.map((choice, index) => (
                              <span
                                key={index}
                                className="qdp-windowTick"
                                style={{ left: `${String(ratioOf(choice))}%` }}
                              >
                                {choice === 0 ? (
                                  <span className="qdp-windowTickMark" />
                                ) : labelled.has(choice) ? (
                                  formatTokens(choice)
                                ) : null}
                              </span>
                            ))
                          })()}
                        </span>
                    </span>
                  ) : capacity !== undefined ? (
                    <span className="qdp-modelMeta">{formatTokens(capacity)}</span>
                  ) : null}
                </span>
              </div>
            )
          })}
          </div>
        </>
      )}
    </div>
  )
}

/**
 * Render Qoder PAT state, quota, catalog, and context capacities as the Plugins
 * page's configuration page (or its one-liner, when the owner asks for
 * `summary`).
 *
 * On `page` this component renders the configuration BODY only: the Plugins page
 * draws the breadcrumb, icon, title, version and description, so no shell chrome
 * or second title lives here. The unified card's variant switcher stays as
 * in-page navigation. Sections, top to bottom:
 *
 * 1. 账户 — variant switcher, status dot + account name + plan tag + expiry,
 *    refresh / replace-PAT / sign-out actions, credential provenance and entry
 * 2. 额度 — remaining/total headline, cycle reset, one merged-group bar each
 * 3. 使用与签到 — claim ledger beside today's claim CTA
 * 4. 模型 — per-model visibility toggles and context-window sliders
 * 5. 高级设置 — the variant-scoped quota settings rows
 */
export function QoderPluginCard(props: QoderPluginCardProps) {
  const { t, scope, signedIn, variant, unified, view } = props
  if (t === undefined) throw new Error('Qoder plugin card requires its translation function')

  const isUnified = unified === true
  const liveSignIn = useSyncExternalStore(onQuotaSettingsChange, quotaSignInState)
  /**
   * The automatic check-in toggles, read from the same settings face the
   * settings rows write. The scheduler arms a timer for EVERY variant (so a
   * toggle flipped on later still fires), so `nextRunAt` alone cannot tell
   * 「已安排」 from 「功能没开」 — this flag is what the card gates the
   * 「下次自动领取」 line on.
   *
   * getSnapshot MUST return the same reference between renders unless the
   * store changed: returning `scope.getSnapshot().value` (a fresh object each
   * call) re-renders forever and trips React's maximum-update-depth guard —
   * the exact hazard `stableProject` documents in QuotaSettingsCard. The
   * projection here is a STRING, so identity is stable by construction.
   */
  const settingsSubscribe = useCallback((onStoreChange: () => void) => {
    return scope?.subscribe(onStoreChange) ?? (() => {})
  }, [scope])
  const autoCheckInKey = useSyncExternalStore(settingsSubscribe, () => {
    const value = scope?.getSnapshot().value
    return `${value?.autoCheckInCN === true ? '1' : '0'}${value?.autoCheckInGlobal === true ? '1' : '0'}`
  })
  const autoCheckInCN = autoCheckInKey.startsWith('1')
  const autoCheckInGlobal = autoCheckInKey.endsWith('1')
  const [activeVariantId, setActiveVariantId] = useState<QoderVariantId>('qoder')
  const currentVariant = isUnified
    ? (activeVariantId === 'qoder' ? QODER_CN_CARD : QODER_GLOBAL_CARD)
    : (variant ?? QODER_CN_CARD)

  const [status, setStatus] = useState<QoderWebStatus>()
  const [signedInState, setSignedInState] = useState<boolean>()
  const [readFailure, setReadFailure] = useState<string>()
  const [busy, setBusy] = useState(false)
  const [patDraft, setPatDraft] = useState('')
  const [replacing, setReplacing] = useState(false)
  const [patBusy, setPatBusy] = useState(false)
  const [patError, setPatError] = useState<string>()
  const [patNotice, setPatNotice] = useState<string>()
  const [checkingIn, setCheckingIn] = useState(false)
  const [clearingLogs, setClearingLogs] = useState(false)
  const [checkInNotice, setCheckInNotice] = useState<string>()
  /** 「清除 PAT」的内联确认：点一次进入确认，再点一次才真正清除。 */
  const [confirmingClear, setConfirmingClear] = useState(false)
  /**
   * 每个 variant 的启用勾选(workbuddy 的 tab-switch)。这是客户端意图层:
   * 关掉的 variant 不再轮询/显示其内容;模型通道的开关仍由 disabledModels
   * 决定,这里不写宿主配置。
   */
  const [variantEnabled, setVariantEnabled] = useState<{ cn: boolean; global: boolean }>({ cn: true, global: true })
  const cnEnabled = variantEnabled.cn
  const globalEnabled = variantEnabled.global
  const mounted = useRef(true)
  const readSeq = useRef(0)
  const manualControllers = useRef(new Set<AbortController>())

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      for (const controller of manualControllers.current) controller.abort()
      manualControllers.current.clear()
    }
  }, [])

  const trackController = useCallback((): AbortController => {
    const controller = new AbortController()
    manualControllers.current.add(controller)
    return controller
  }, [])

  const authKey = status === undefined || status.status === 'error' ? undefined : status.authKey

  const refresh = useCallback(async (signal?: AbortSignal): Promise<boolean> => {
    const seq = ++readSeq.current
    const current = (): boolean => mounted.current && signal?.aborted !== true && seq === readSeq.current
    try {
      const response = await fetch(currentVariant.statusPath, {
        headers: { accept: 'application/json' },
        credentials: 'same-origin',
        ...signal === undefined ? {} : { signal },
      })
      const value: unknown = await response.json().catch(() => undefined)
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      if (!isQoderWebStatus(value)) throw new Error(t('statusResponseInvalid'))
      if (!current()) return false
      setStatus(value)
      if (value.status === 'signed-in') {
        setSignedInState(true)
        noteQuotaStatus(currentVariant.id, value)
      } else if (value.status === 'signed-out') {
        setSignedInState(false)
        noteQuotaStatus(currentVariant.id, value)
      }
      setReadFailure(undefined)
      return true
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : t('requestFailed')
      if (current()) {
        setReadFailure(message)
        setStatus(previous => previous === undefined ? { status: 'error', message } : previous)
      }
      return false
    }
  }, [currentVariant.statusPath, t])

  // The card IS the page now: the owner mounts it only while its detail page is
  // open, so there is no `open` flag to gate the first read on. It still reads
  // once per variant switch, and re-reads when the variant changes.
  useEffect(() => {
    setStatus(undefined)
    setSignedInState(undefined)
    setReadFailure(undefined)
    setPatDraft('')
    setReplacing(false)
    setPatError(undefined)
    setPatNotice(undefined)
    const controller = new AbortController()
    void refresh(controller.signal)
    return () => { controller.abort() }
  }, [currentVariant.statusPath, refresh])

  // The 60s poll. Also ungated: a mounted page is a page the user is looking at,
  // which is exactly when the poll is wanted (the tab is hidden only while the
  // user is away, and `refresh` already tolerates a hidden document elsewhere).
  useEffect(() => {
    if (signedInState === false) return
    const controller = new AbortController()
    const timer = window.setInterval(() => { void refresh(controller.signal) }, POLL_INTERVAL_MS)
    return () => {
      window.clearInterval(timer)
      controller.abort()
    }
  }, [refresh, signedInState])

  const manualRefresh = async (): Promise<void> => {
    setBusy(true)
    const controller = trackController()
    try {
      await refresh(controller.signal)
    } finally {
      manualControllers.current.delete(controller)
      if (mounted.current) setBusy(false)
    }
  }

  /**
   * Ask the host to re-read the credential and re-fetch this variant's catalog.
   *
   * Shares the probe route's key and guards: it is a write that spends an
   * upstream request, so it does not belong on the read-only status GET. A
   * failure is surfaced through the refreshed document's `catalog.error` rather
   * than thrown away, so the reason survives the round trip.
   */
  const refreshModels = useCallback(async (): Promise<void> => {
    const key = status?.status === 'signed-in' ? status.probeKey : undefined
    if (key === undefined) return
    setBusy(true)
    /*
     * A failed refresh must say WHY, and the reason travels in the BODY.
     *
     * The route answers HTTP 200 for a failed refresh and puts the failure in
     * `{state:'failed', reason}` — so checking `response.ok` alone (what this
     * used to do) treated every failure as a success: no throw, no message,
     * just the old model list still on screen. That is exactly the reported
     * "refresh does not work and shows a failure notice with no reason":
     * whatever the user saw came from somewhere else, because this path could
     * not report anything at all.
     *
     * The body is parsed the same way `manualCheckIn` below parses it, so both
     * manual actions report their outcome consistently.
     */
    let result: { state?: string; reason?: string } | undefined
    const controller = trackController()
    try {
      const response = await fetch(currentVariant.probePath, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Qoder-Probe-Key': key },
        credentials: 'same-origin',
        signal: controller.signal,
        body: JSON.stringify({ action: 'refresh' } satisfies QoderProbeAction),
      })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      result = await response.json() as { state?: string; reason?: string }
    } catch (error: unknown) {
      if (mounted.current && controller.signal.aborted !== true) {
        setReadFailure(error instanceof Error ? error.message : t('requestFailed'))
      }
      manualControllers.current.delete(controller)
      return
    } finally {
      if (mounted.current) setBusy(false)
    }
    /*
     * The failure branch returns BEFORE the status re-read: `refresh()` would
     * repaint the card with the same stale catalog, and leaving the reason on
     * screen is the whole point. `state: 'refreshed'` (or an absent state from
     * an older host) falls through and re-reads as before.
     */
    if (result.state === 'failed') {
      if (mounted.current) setReadFailure(result.reason ?? t('requestFailed'))
      manualControllers.current.delete(controller)
      return
    }
    if (result.state === 'refreshed' && mounted.current) setReadFailure(undefined)
    try {
      await refresh(controller.signal)
    } finally {
      manualControllers.current.delete(controller)
    }
  }, [currentVariant.probePath, refresh, status, t, trackController])

  const manualCheckIn = useCallback(async (): Promise<void> => {
    const key = status?.status === 'signed-in' ? status.probeKey : undefined
    if (key === undefined) return
    setCheckingIn(true)
    setCheckInNotice(undefined)
    const controller = trackController()
    try {
      const response = await fetch(currentVariant.probePath, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Qoder-Probe-Key': key },
        credentials: 'same-origin',
        signal: controller.signal,
        body: JSON.stringify({ action: 'checkin' } satisfies QoderProbeAction),
      })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const result = await response.json() as { state?: string; amount?: number; reason?: string; reasonCode?: string }
      if (result.state === 'claimed') {
        setCheckInNotice(t('autoCheckInStatusClaimed', { amount: result.amount ?? 100 }))
      } else if (result.state === 'already-claimed') {
        setCheckInNotice(t('autoCheckInStatusAlready'))
      } else if (result.state === 'no-campaign') {
        setCheckInNotice(t('autoCheckInStatusNoCampaign'))
      } else if (result.reasonCode === 'no-client') {
        /*
         * The one failure the user can fix, so it gets its own sentence
         * instead of the generic "error: <English prose>" line. The
         * international campaign is only served to requests carrying an
         * identity minted by an installed Qoder client, so its absence is a
         * missing dependency, not a broken account.
         */
        setCheckInNotice(t('checkInNeedsClient'))
      } else if (result.reason) {
        setCheckInNotice(t('autoCheckInStatusError', { message: result.reason }))
      }
    } catch (error: unknown) {
      if (mounted.current && controller.signal.aborted !== true) {
        setCheckInNotice(error instanceof Error ? error.message : t('requestFailed'))
      }
    } finally {
      manualControllers.current.delete(controller)
      if (mounted.current) setCheckingIn(false)
    }
    try {
      await refresh(controller.signal)
    } finally {
      manualControllers.current.delete(controller)
    }
  }, [currentVariant.probePath, refresh, status, t, trackController])

  const clearCheckInLogs = useCallback(async (): Promise<void> => {
    const key = status?.status === 'signed-in' ? status.probeKey : undefined
    if (key === undefined) return
    setClearingLogs(true)
    setCheckInNotice(undefined)
    const controller = trackController()
    try {
      const response = await fetch(currentVariant.probePath, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Qoder-Probe-Key': key },
        credentials: 'same-origin',
        signal: controller.signal,
        body: JSON.stringify({ action: 'clear-checkin-logs' } satisfies QoderProbeAction),
      })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
    } catch (error: unknown) {
      if (mounted.current && controller.signal.aborted !== true) {
        setCheckInNotice(error instanceof Error ? error.message : t('requestFailed'))
      }
    } finally {
      manualControllers.current.delete(controller)
      if (mounted.current) setClearingLogs(false)
    }
    try {
      await refresh(controller.signal)
    } finally {
      manualControllers.current.delete(controller)
    }
  }, [currentVariant.probePath, refresh, status, t, trackController])

  /**
   * Run one probe-route control action and refresh the card's state afterwards.
   *
   * The key travels in a header, not the body: it authorizes the write, and
   * the host never accepts a prompt, a sentinel, or a model outside its own
   * catalog from here.
   */
  const control = useCallback(async (action: QoderProbeAction): Promise<void> => {
    const key = status?.status === 'signed-in' ? status.probeKey : undefined
    if (key === undefined) return
    setBusy(true)
    const controller = trackController()
    try {
      const response = await fetch(currentVariant.probePath, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Qoder-Probe-Key': key },
        credentials: 'same-origin',
        signal: controller.signal,
        body: JSON.stringify(action),
      })
      const value: unknown = await response.json().catch(() => undefined)
      if (!response.ok) {
        const message = typeof value === 'object' && value !== null && 'error' in value
          ? String((value as Record<string, unknown>)['error'])
          : `HTTP ${response.status}`
        throw new Error(message)
      }
      if ((action.action === 'set-maximum-context-window' || action.action === 'set-models-enabled')
        && (typeof value !== 'object' || value === null || (value as Record<string, unknown>)['state'] !== 'updated')) {
        const reason = typeof value === 'object' && value !== null && 'reason' in value
          ? String((value as Record<string, unknown>)['reason'])
          : t('requestFailed')
        throw new Error(reason)
      }
      await refresh(controller.signal)
    } catch (error: unknown) {
      if (mounted.current && controller.signal.aborted !== true) {
        setReadFailure(error instanceof Error ? error.message : t('requestFailed'))
      }
    } finally {
      manualControllers.current.delete(controller)
      if (mounted.current) setBusy(false)
    }
  }, [currentVariant.probePath, refresh, status, t, trackController])

  /**
   * Validate and store the pasted PAT (or overwrite the stored one).
   *
   * The PAT route answers both outcomes as 200 with `ok` carrying the verdict —
   * a refused token is an answer, not a transport failure — so the card checks
   * `ok` and translates the stable `qoder_invalid_pat` / `qoder_missing_pat`
   * codes into the re-generate prompt. The route is variant-fixed: the token
   * this card saves can only ever be validated and stored for this product.
   */
  const savePat = useCallback(async (): Promise<void> => {
    const key = authKey
    const pat = patDraft.trim()
    if (key === undefined || pat === '' || patBusy) return
    setPatBusy(true)
    setPatError(undefined)
    setPatNotice(undefined)
    const controller = trackController()
    try {
      const response = await fetch(currentVariant.authPath, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Qoder-Auth-Key': key },
        credentials: 'same-origin',
        signal: controller.signal,
        body: JSON.stringify({ action: 'save-pat', pat }),
      })
      const value: unknown = await response.json().catch(() => undefined)
      const record = typeof value === 'object' && value !== null ? value as Record<string, unknown> : {}
      const detail = typeof record['error'] === 'string' ? record['error'] : `HTTP ${response.status}`
      if (!response.ok) {
        setPatError(t('patSaveFailed', { message: detail }))
        return
      }
      if (record['ok'] !== true) {
        /*
         * Three outcomes, three messages. `qoder_unreachable` must NOT say the
         * token is bad: nothing judged it, so the honest instruction is to
         * retry, and the upstream detail rides along in `reason`.
         */
        const reason = typeof record['reason'] === 'string' ? record['reason'] : t('requestFailed')
        if (detail === 'qoder_invalid_pat' || detail === 'qoder_missing_pat') {
          setPatError(t('patInvalid'))
        } else if (detail === 'qoder_unreachable') {
          setPatError(t('patUnreachable', { message: reason }))
        } else {
          setPatError(t('patSaveFailed', { message: detail }))
        }
        return
      }
      setPatDraft('')
      setReplacing(false)
      setPatNotice(t('patSaved'))
      noteQuotaSignIn(currentVariant.id, true)
      await refresh(controller.signal)
    } catch (error: unknown) {
      if (mounted.current && controller.signal.aborted !== true) {
        setPatError(t('patSaveFailed', {
          message: error instanceof Error ? error.message : t('requestFailed'),
        }))
      }
    } finally {
      manualControllers.current.delete(controller)
      if (mounted.current) setPatBusy(false)
    }
  }, [authKey, currentVariant.authPath, patBusy, patDraft, refresh, t, trackController])

  /** Remove the stored PAT; the host answer is `{ ok: true }`, then the card re-reads. */
  const clearPat = useCallback(async (): Promise<void> => {
    const key = authKey
    if (key === undefined || patBusy) return
    setPatBusy(true)
    setPatError(undefined)
    setPatNotice(undefined)
    setReplacing(false)
    const controller = trackController()
    try {
      const response = await fetch(currentVariant.authPath, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Qoder-Auth-Key': key },
        credentials: 'same-origin',
        signal: controller.signal,
        body: JSON.stringify({ action: 'clear' }),
      })
      // Whatever the outcome, the inline confirm has served its purpose.
      setConfirmingClear(false)
      const value: unknown = await response.json().catch(() => undefined)
      const record = typeof value === 'object' && value !== null ? value as Record<string, unknown> : {}
      if (!response.ok || record['ok'] !== true) {
        const detail = typeof record['error'] === 'string' ? record['error'] : `HTTP ${response.status}`
        setPatError(t('patSaveFailed', { message: detail }))
        return
      }
      setPatDraft('')
      const signedOutDoc: QoderWebStatus = { status: 'signed-out', authKey: key }
      setStatus(signedOutDoc)
      setSignedInState(false)
      noteQuotaStatus(currentVariant.id, signedOutDoc)
      noteQuotaSignIn(currentVariant.id, false)
      await refresh(controller.signal)
    } catch (error: unknown) {
      if (mounted.current && controller.signal.aborted !== true) {
        setPatError(t('patSaveFailed', {
          message: error instanceof Error ? error.message : t('requestFailed'),
        }))
      }
    } finally {
      manualControllers.current.delete(controller)
      if (mounted.current) setPatBusy(false)
    }
  }, [authKey, currentVariant.authPath, patBusy, refresh, t, trackController])

  /**
   * 更换 PAT: open the entry over the signed-in document, pre-cleared and
   * focused. Unlike the removed device-flow switch this needs no sign-out
   * first — saving validates the new token and overwrites the stored one
   * only on success, so a mistyped paste can never strand the working
   * credential.
   */
  const patEntry = (): React.ReactNode => (
    <div className="qdp-stack">
      <p className="qdp-body">{t(currentVariant.patGuideKey)}</p>
      <div className="qdp-patRow">
        <QdpInput
          type="password"
          value={patDraft}
          placeholder={t(currentVariant.patPlaceholderKey)}
          aria-label={t('patHeading')}
          disabled={patBusy}
          onChange={event => { setPatDraft(event.target.value) }}
          onKeyDown={event => {
            if (event.key === 'Enter') {
              event.preventDefault()
              void savePat()
            }
          }}
        />
        <QdpButton
          variant="primary"
          disabled={patBusy || busy || patDraft.trim() === ''}
          onClick={() => { void savePat() }}
        >
          {patBusy ? t('patSaving') : t('patSave')}
        </QdpButton>
        {replacing ? (
          <QdpButton
            disabled={patBusy}
            onClick={() => {
              setReplacing(false)
              setPatDraft('')
              setPatError(undefined)
            }}
          >
            {t('cancel')}
          </QdpButton>
        ) : null}
      </div>
      {patError === undefined ? null : (
        /* The save control beside the field is the retry: an invalid PAT is a
           value problem, not a transport one. */
        <div className="qdp-alert qdp-alertError" role="alert">{patError}</div>
      )}
      {patNotice === undefined ? null : <p className="qdp-body">{patNotice}</p>}
    </div>
  )

  // The page's one-liner for the card list. It is ALSO the page's own intro
  // line: the Plugins page draws the title and description from the package
  // manifest, so the fallback description text has to come from here either way.
  // On `page`, the OWNER draws the heading — this component renders no title.
  const cardIntro = isUnified ? t('unifiedIntro') : t(currentVariant.introKey)

  const label = status === undefined
    ? t('loading')
    : status.status === 'signed-in'
      ? t('signedIn')
      : status.status === 'error'
        ? t('requestFailed')
        : t('signedOut')

  /* The account box's state line: with a known subscriber name it reads
     「已登录：name」; without one it is the plain signed-in copy. */
  const signedInLabel = status?.status === 'signed-in' && status.pat?.accountName !== undefined
    ? t('accountSignedInAs', { name: status.pat.accountName })
    : label

  // Per-variant state dots for the segmented switcher: the variant being read
  // shows the live document state, the other one its last known sign-in state.
  const reported = signedIn?.()
  const cnSignedIn = reported !== undefined ? reported.cn : liveSignIn.cn
  const globalSignedIn = reported !== undefined ? reported.global : liveSignIn.global
  const cnDotState = dotStateOf(isUnified && activeVariantId === 'qoder'
    ? (status === undefined ? 'loading' : status.status)
    : (cnSignedIn ? 'signed-in' : 'signed-out'))
  const globalDotState = dotStateOf(isUnified && activeVariantId === 'qoder-global'
    ? (status === undefined ? 'loading' : status.status)
    : (globalSignedIn ? 'signed-in' : 'signed-out'))
  const planTag = status?.status === 'signed-in' && status.plan !== undefined
    ? t('planTier', { name: status.plan.planTierName })
    : undefined
  const planMeta = status?.status === 'signed-in' && status.plan !== undefined
    ? [
      status.plan.organizationName === undefined ? null : t('planOrganization', { name: status.plan.organizationName }),
      status.plan.endDate === undefined ? null : t('planEndsAt', { date: formatCycleReset(status.plan.endDate) }),
    ].filter(part => part !== null).join(' · ')
    : undefined

  // The one-liner the card list shows (and the fallback where a row has no
  // description). Rendered without any state read: it is asked for by the list
  // view, where none of this card's controls exist.
  if (view === 'summary') return <>{cardIntro}</>

  // The settings face always follows the variant on screen: the unified card's
  // switcher, or the standalone card's fixed variant.
  const settingsVariant = isUnified
    ? (activeVariantId === 'qoder' ? 'cn' : 'global')
    : (currentVariant.id === 'qoder' ? 'cn' : 'global')
  const signedInDoc = status?.status === 'signed-in' ? status : undefined

  /*
   * Body-only configuration page.
   *
   * The OWNER draws the breadcrumb, icon, title, version and description for
   * `plugins.row.config` (`PluginConfigViewProps`), so this tree starts at the
   * configuration body: no shell card, no disclosure header, no second title.
   * `qdp-card`/`qdp-cardOpen`/`qdp-cardBody` stay as the body wrapper pair (they
   * carry no chrome) so the existing render assertions keep finding the same
   * root.
   *
   * Sections follow the page anatomy in order: 账户 → 额度 → 使用与签到 → 模型 →
   * 高级设置. The variant switcher opens the 账户 section; each variant's enable
   * intent is preserved as a switch in 账户 (the old per-tab switch).
   */
  return (
    <div className="qdp-card qdp-cardOpen">
      <div className="qdp-cardBody">
        {/* ── 1. 账户: state dot + name + plan tag + expiry + actions ── */}
        <section className="qdp-section">
          <div className="qdp-sectionHead">
            <h2 className="qdp-sectionTitle">{t('accountHeading')}</h2>
            {isUnified ? (
              <QdpSegmented
                label="Qoder Version Selection"
                value={activeVariantId}
                options={[
                  {
                    value: 'qoder',
                    /* An off side still shows its tab (it explains why the side
                       is quiet) but reads disabled, exactly like the old per-tab
                       switch. The switch itself re-enables it. */
                    disabled: !cnEnabled,
                    label: (
                      <>
                        <QdpStateDot state={cnDotState} />
                        <span>{t('variantTabCN')}</span>
                      </>
                    ),
                  },
                  {
                    value: 'qoder-global',
                    disabled: !globalEnabled,
                    label: (
                      <>
                        <QdpStateDot state={globalDotState} />
                        <span>{t('variantTabGlobal')}</span>
                      </>
                    ),
                  },
                ]}
                onChange={setActiveVariantId}
              />
            ) : null}
          </div>
          <div className="qdp-sectionBody">
            <div className="qdp-accountBox">
              <div className="qdp-accountMain">
                <div className="qdp-accountState" role="status" aria-busy={status === undefined}>
                  <QdpStateDot state={dotStateOf(status === undefined ? 'loading' : status.status)} />
                  <span>{signedInLabel}</span>
                  {planTag === undefined ? null : <QdpTag>{planTag}</QdpTag>}
                </div>
                {status?.status !== 'signed-in' || status.pat === undefined ? null : (
                  <span className="qdp-accountExpiry">
                    {[patSourceText(status.pat.source, t),
                      status.pat.savedAtMs === undefined ? null : t('patSavedAt', { time: formatTime(status.pat.savedAtMs) }),
                      status.pat.patTail === undefined ? null : t('patTail', { tail: `****${status.pat.patTail}` })].filter(Boolean).join(' · ')}
                  </span>
                )}
                {planMeta === undefined || planMeta === '' ? null : (
                  <span className="qdp-accountExpiry">{planMeta}</span>
                )}
              </div>
              <div className="qdp-actions">
                <QdpButton disabled={busy} onClick={() => { void manualRefresh() }}>
                  {busy ? t('refreshing') : t('refresh')}
                </QdpButton>
                {signedInDoc === undefined ? null : (
                  <>
                    <QdpButton disabled={busy || patBusy} onClick={() => { setReplacing(open => !open) }}>
                      {t('patReplace')}
                    </QdpButton>
                    <QdpButton variant="dangerQuiet" disabled={busy || patBusy} onClick={() => { setConfirmingClear(true) }}>
                      {t('patRemove')}
                    </QdpButton>
                  </>
                )}
              </div>
            </div>
            {/* The variant enable intent (formerly a switch inside each tab):
                kept as plain settings rows so an off side still reads "off". */}
            {isUnified ? (
              <>
                <div className="qdp-row">
                  <div className="qdp-rowText">
                    <span className="qdp-rowTitle">{t('variantTabCN')}</span>
                    <p className="qdp-rowDesc">{t('variantEnable')}</p>
                  </div>
                  <div className="qdp-rowControl">
                    <QdpSwitch
                      checked={cnEnabled}
                      onChange={next => { setVariantEnabled(prev => ({ ...prev, cn: next })) }}
                      label={`${t('variantTabCN')} · ${t('variantEnable')}`}
                    />
                  </div>
                </div>
                <div className="qdp-row">
                  <div className="qdp-rowText">
                    <span className="qdp-rowTitle">{t('variantTabGlobal')}</span>
                    <p className="qdp-rowDesc">{t('variantEnable')}</p>
                  </div>
                  <div className="qdp-rowControl">
                    <QdpSwitch
                      checked={globalEnabled}
                      onChange={next => { setVariantEnabled(prev => ({ ...prev, global: next })) }}
                      label={`${t('variantTabGlobal')} · ${t('variantEnable')}`}
                    />
                  </div>
                </div>
              </>
            ) : null}
            {confirmingClear && signedInDoc !== undefined && signedInDoc.pat !== undefined ? (
              <div className="qdp-alert" role="alert">
                <span>{t('patClearConfirm')}</span>
                <div className="qdp-actions">
                  <QdpButton variant="danger" disabled={busy || patBusy} onClick={() => { void clearPat() }}>
                    {patBusy ? t('patClearing') : t('patClearConfirmYes')}
                  </QdpButton>
                  <QdpButton disabled={patBusy} onClick={() => { setConfirmingClear(false) }}>
                    {t('cancel')}
                  </QdpButton>
                </div>
              </div>
            ) : null}
            {/* The credential's identity stays visible (a labelled field, not a
                caption): source · saved time · tail, plus the account name. */}
            {signedInDoc === undefined || signedInDoc.pat === undefined ? null : (
              <div className="qdp-patBox">
                <div className="qdp-patBoxCopy">
                  <span className="qdp-accountState">{t('patBoxLabel')}</span>
                  <span className="qdp-patBoxMeta">
                    {[signedInDoc.pat.accountName,
                      signedInDoc.pat.patTail === undefined ? null : t('patTail', { tail: `****${signedInDoc.pat.patTail}` })].filter(Boolean).join(' · ')}
                  </span>
                </div>
              </div>
            )}
            {replacing ? patEntry() : null}
            {signedInDoc !== undefined && signedInDoc.jobTokenRefreshedAt !== undefined ? (
              <p className="qdp-meta">{t('jobTokenRefreshed', { time: formatTime(signedInDoc.jobTokenRefreshedAt) })}</p>
            ) : null}
            {readFailure === undefined || signedInState === undefined ? null : (
              <div className="qdp-alert qdp-alertError" role="alert">
                <span>{t('statusRefreshFailed', { message: readFailure })}</span>
                <div className="qdp-actions">
                  <QdpButton disabled={busy} onClick={() => { void manualRefresh() }}>
                    {busy ? t('refreshing') : t('refresh')}
                  </QdpButton>
                </div>
              </div>
            )}
            {signedInDoc === undefined && status?.status === 'signed-out' ? (
              <>
                <p className={status.reason === undefined ? 'qdp-body' : 'qdp-error'}>
                  {status.reason ?? t(currentVariant.signedOutKey)}
                </p>
                {authKey === undefined ? null : patEntry()}
              </>
            ) : null}
            {status?.status === 'error' ? (
              <div className="qdp-alert qdp-alertError" role="alert">{status.message}</div>
            ) : null}
          </div>
        </section>

        {/* ── 2. 额度: headline, reset, one bar per merged credit group ── */}
        <section className="qdp-section">
          <div className="qdp-sectionHead">
            <h2 className="qdp-sectionTitle">{t('creditsHeading')}</h2>
          </div>
          <div className="qdp-sectionBody">
            {signedInDoc === undefined
              ? <p className="qdp-empty">{status === undefined ? t('loading') : t('quotaNotSignedIn')}</p>
              : (
                <QuotaSummary
                  credits={signedInDoc.credits}
                  creditsError={signedInDoc.creditsError}
                  t={t}
                  busy={busy}
                  onRetry={() => { void manualRefresh() }}
                />
              )}
          </div>
        </section>

        {/* ── 3. 使用与签到: the claim ledger + today's claim CTA ── */}
        {signedInDoc === undefined ? null : (
          <section className="qdp-section">
            <div className="qdp-sectionHead">
              <h2 className="qdp-sectionTitle">{t('quotaSectionUsage')}</h2>
            </div>
            <div className="qdp-sectionBody">
              <UsageCheckInPanel
                checkIn={signedInDoc.checkIn}
                autoCheckIn={isUnified
                  ? (activeVariantId === 'qoder' ? autoCheckInCN : autoCheckInGlobal)
                  : (currentVariant.id === 'qoder' ? autoCheckInCN : autoCheckInGlobal)}
                t={t}
                busy={busy}
                checkingIn={checkingIn}
                checkInNotice={checkInNotice}
                onCheckIn={() => { void manualCheckIn() }}
                clearingLogs={clearingLogs}
                logsDisabled={false}
                onClearLogs={() => { void clearCheckInLogs() }}
              />
            </div>
          </section>
        )}

        {/* ── 4. 模型: visibility toggles + per-model context window ── */}
        {signedInDoc === undefined ? null : (
          <section className="qdp-section">
            <div className="qdp-sectionHead">
              <h2 className="qdp-sectionTitle">{t('paneModels')}</h2>
            </div>
            <div className="qdp-sectionBody">
              <ModelsPane
                models={signedInDoc.models}
                disabledModels={signedInDoc.disabledModels}
                catalog={signedInDoc.catalog}
                t={t}
                busy={busy}
                onSetModelContextWindow={(model, window) => {
                  void control({ action: 'set-model-context-window', model, window })
                }}
                onSetModelsEnabled={(models, enabled) => {
                  void control({ action: 'set-models-enabled', models, enabled })
                }}
                onRefreshModels={() => { void refreshModels() }}
              />
            </div>
          </section>
        )}

        {/* ── 5. 高级设置: sidebar/check-in settings, flat rows in one section ── */}
        <section className="qdp-section">
          <div className="qdp-sectionHead">
            <h2 className="qdp-sectionTitle">{t('quotaSectionAdvanced')}</h2>
          </div>
          <div className="qdp-sectionBody">
            <QuotaSettingsContent
              t={t}
              scope={scope}
              signedIn={signedIn}
              variant={settingsVariant}
            />
          </div>
        </section>
      </div>
    </div>
  )
}
