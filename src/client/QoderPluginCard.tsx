/** Qoder status card contributed to Harness Plugin configuration. */

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent, ReactNode } from 'react'
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
  QoderAccountHealth,
  QoderAccountSummary,
  QoderAuthAction,
  QoderAuthRequest,
  QoderCredentialSource,
  QoderProbeAction,
  QoderVariantId,
  QoderWebAccounts,
  QoderWebCatalog,
  QoderWebCredits,
  QoderWebStatus,
  QoderWebUpstreamNotice,
} from '../status-paths.ts'
import { isQoderWebStatus } from './status-document.ts'
import {
  QdpButton,
  QdpIconButton,
  QdpInput,
  QdpNumberField,
  QdpSegmented,
  QdpStateDot,
  QdpSwitch,
  QdpTag,
} from './controls.tsx'
import type { QdpDotState } from './controls.tsx'
import { ModelsPane, type ModelsDraft } from './ModelsPane.tsx'
import { creditSummary } from './quota-merge.ts'
import type { QoderSettingsKey } from './locales.ts'
import type { QuotaSection, QuotaSettingsScope } from './QuotaSettingsCard.tsx'
import {
  noteQuotaSignIn,
  noteQuotaStatus,
  onQuotaSettingsChange,
  quotaPollMs,
  quotaReadout,
  quotaSettingsRevision,
  quotaSignInState,
  quotaStatus,
  quotaStatusIsFresh,
  setQuotaReadout,
} from './quota-settings-store.ts'

/** Localized copy injected by the browser-plugin registration. */
export interface QoderPluginCardInjected {
  t: (key: QoderSettingsKey, params?: Record<string, unknown>) => string
  /** The bound quota settings face, when the host serves one. */
  scope?: QuotaSettingsScope<QuotaSection> | undefined
  /**
   * Sign-in state per variant; a toggle is disabled when its variant is out.
   * `undefined` means no status read has landed yet — not signed out.
   */
  signedIn?: () => { cn: boolean | undefined; global: boolean | undefined }
  /**
   * Which product variant this card instance renders.
   */
  variant?: QoderCardVariant
  /**
   * Whether to render as the unified Qoder card (both variants behind one
   * segmented switcher) — the Plugins-page seats always pass `true`.
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

/** Page-level poll period, in milliseconds. */
const POLL_INTERVAL_MS = 60_000
/** 10:00 UTC+8, the upstream campaign's reset moment (mirrors QuotaSettingsCard). */
const CHECK_IN_MINUTE_DEFAULT = 600
/** Default billing-endpoint poll period, in milliseconds (mirrors the settings face). */
const POLL_DEFAULT_MS = 300_000
/** The face clamps the poll interval at one minute. */
const POLL_MIN_MS = 60_000
/**
 * The card's own ceiling for the poll interval, in minutes.
 *
 * The host sets no upper bound (a poll is cheap), but a field with no ceiling
 * invites a typo that parks the readout for a day; one day is the widest
 * interval that can still be called a poll.
 */
const POLL_MINUTES_MAX = 1440

/*
 * The failover/routing policy defaults and bounds.
 *
 * They MIRROR the host Config's own validation. Clamping here is not
 * cosmetic: the host refuses an out-of-range write, so a keystroke the field
 * would reject must never leave the control showing a value the document does
 * not hold. The defaults are what an older document — one written before these
 * fields existed — means, so the controls render the behaviour that is actually
 * in force rather than zeroed-out inputs.
 */
const QUEUE_WAIT_ATTEMPTS_DEFAULT = 0
const QUEUE_WAIT_ATTEMPTS_MAX = 10
const QUEUE_WAIT_SECONDS_DEFAULT = 30
const QUEUE_WAIT_SECONDS_MIN = 1
const QUEUE_WAIT_SECONDS_MAX = 300
const STICKINESS_ROUNDS_DEFAULT = 3
const STICKINESS_ROUNDS_MAX = 100
const STICKINESS_REQUESTS_DEFAULT = 200
const STICKINESS_REQUESTS_MAX = 10_000
const STICKINESS_MINUTES_DEFAULT = 180
const STICKINESS_MINUTES_MAX = 1440
/** The routing strategies the host accepts; 'save-order' is the default. */
type QoderRoutingStrategy = 'save-order' | 'custom'

/** Clamp an integer field into the host's accepted range, ignoring junk input. */
function clampInt(value: number, min: number, max: number): number | undefined {
  if (!Number.isFinite(value)) return undefined
  return Math.min(max, Math.max(min, Math.trunc(value)))
}

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

/** Time-of-day formatting for "next run" and credential-saved lines. */
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
 * One pooled account's facts, in the same order the single-credential row used
 * (source · saved · tail) plus the failover position.
 *
 * The position leads because it is the only thing that distinguishes two rows
 * saved at the same moment, and because it is what the user is choosing between
 * when they press 「切换使用」.
 */
function accountRowMeta(account: QoderAccountSummary, t: QoderPluginCardInjected['t']): string {
  return [
    t('accountSlot', { order: account.order }),
    patSourceText(account.source, t),
    account.savedAtMs === undefined ? null : t('patSavedAt', { time: formatTime(account.savedAtMs) }),
    account.patTail === undefined ? null : t('patTail', { tail: `****${account.patTail}` }),
  ].filter(part => part !== null).join(' · ')
}

/**
 * One pooled account's own credit figure.
 *
 * The row follows the SAME summation rule as the card header (see
 * `creditSummary`), because two currency rules over one credential is how a
 * card ends up disagreeing with itself.
 *
 * A PARKED account reports no figure at all. It is excluded from the failover
 * walk and from the composer panel's totals, so printing a spendable-looking
 * number beside it would promise a balance this list will never route through;
 * saying why is more honest than an em dash that reads as a failed read.
 */
function accountRowCredits(
  account: Pick<QoderAccountSummary, 'enabled' | 'credits' | 'creditsError'>,
  t: QoderPluginCardInjected['t'],
): string {
  if (account.enabled === false) return t('accountCreditsParked')
  if (account.credits === undefined) {
    return account.creditsError === undefined
      ? t('accountCreditsUnknown')
      : t('creditsError', { message: account.creditsError })
  }
  const summary = creditSummary(account.credits)
  return t('accountCreditsValue', {
    value: summary.unlimited ? t('quotaUnlimited') : new Intl.NumberFormat(undefined).format(summary.remain),
  })
}

/**
 * One account's observed service state, as the user-facing word for it.
 *
 * 限流 is the upstream's own term for an account that only ever answers with a
 * per-model queue, so the label states the condition the host actually
 * recorded instead of guessing at a cause.
 *
 * An absent state is not a healthy one: `health` stays undefined until the
 * transport observes a failure, so the word for it is 「尚未观测」 — the same
 * silence {@link ComposerQuota} keeps, said out loud where a tag is expected.
 */
export function accountHealthLabel(
  health: QoderAccountHealth | undefined,
  t: QoderPluginCardInjected['t'],
): string {
  if (health === undefined) return t('accountHealthUnknown')
  if (health === 'queued') return t('accountHealthQueued')
  if (health === 'limited') return t('accountHealthLimited')
  return t('accountHealthNormal')
}

/** One saved account as the routing list needs it: identity, name, owner. */
interface RoutingAccount {
  readonly id: string
  /** The upstream's subscriber name, or `''` when the host had none. */
  readonly name: string
  /** The save order, used as the row's name when the upstream named nobody. */
  readonly order: number
  readonly variant: 'cn' | 'global'
  /**
   * The seat's balance and observed state, carried here so the routing list can
   * answer "which of these is worth putting first" without a second document.
   *
   * These are the same fields the account list reads; they ride this projection
   * because the two lists are two views of one pool, and a pool row that showed
   * a balance in one view and nothing in the other would read as a bug.
   */
  readonly credits?: QoderWebCredits
  readonly creditsError?: string
  readonly health?: QoderAccountHealth
  readonly enabled?: boolean
}

/** The facts the mixed-variant routing warning compares, across both variants. */
interface RoutingFacts {
  readonly accounts: readonly RoutingAccount[]
  /** The model ids each variant OFFERS: its catalogue minus its blacklist. */
  readonly cnServed: readonly string[]
  readonly globalServed: readonly string[]
  /** Every model id each variant's catalogue declares, offered or not. */
  readonly cnCatalog: readonly string[]
  readonly globalCatalog: readonly string[]
}

/**
 * The two variants' routing facts as one stable string.
 *
 * The warning compares facts that live in two documents — this card's variant
 * and whatever the shared store last saw of the other one — and
 * `useSyncExternalStore` requires a snapshot that is reference-stable between
 * renders (see {@link settingsKeyOf}). JSON is stable by construction; it is
 * parsed back into {@link RoutingFacts} and cached by that string, so a render
 * reads the same object until the store actually changes.
 */
function routingKeyOf(): string {
  const project = (variantId: 'qoder' | 'qoder-global'): unknown => {
    // A signed-out document has no pool and no catalog, so there is nothing to
    // compare. Narrowing here is what keeps a missing pool from being read as
    // "the user changed something" on every render.
    const doc = quotaStatus(variantId)
    const signedIn = doc?.status === 'signed-in' ? doc : undefined
    /*
     * Every read here is defensive, because this runs inside a
     * `useSyncExternalStore` snapshot: a hostile or half-written document must
     * degrade to "nothing to compare", not throw. A throw in the snapshot takes
     * the entire card down — the user would lose the sign-in controls over a
     * malformed pool they cannot even see — so a bad shape is flattened here
     * rather than surfaced.
     */
    const entries = Array.isArray(signedIn?.accounts?.entries) ? signedIn.accounts.entries : []
    const disabled = Array.isArray(signedIn?.disabledModels) ? signedIn.disabledModels : []
    const catalog = Array.isArray(signedIn?.models) ? signedIn.models : []
    const ids = catalog
      .map(model => (typeof model?.id === 'string' ? model.id : ''))
      .filter(id => id !== '')
    return [
      entries
        .filter(entry => typeof entry === 'object' && entry !== null)
        .map(entry => [
          entry.id,
          entry.accountName ?? '',
          entry.order,
          entry.credits ?? null,
          entry.creditsError ?? null,
          entry.health ?? null,
          entry.enabled ?? null,
        ]),
      ids.filter(id => !disabled.includes(id)),
      ids,
    ]
  }
  return JSON.stringify([project('qoder'), project('qoder-global')])
}

let routingCacheKey: string | undefined
let routingCacheFacts: RoutingFacts | undefined

/** The parsed facts behind {@link routingKeyOf}, rebuilt only when it changes. */
function routingFacts(): RoutingFacts {
  const key = routingKeyOf()
  if (key !== routingCacheKey || routingCacheFacts === undefined) {
    routingCacheKey = key
    routingCacheFacts = parseRoutingFacts(key)
  }
  return routingCacheFacts
}

function readRoutingIds(value: unknown): readonly string[] {
  return Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string') : []
}

function readRoutingAccounts(value: unknown, variant: 'cn' | 'global'): readonly RoutingAccount[] {
  if (!Array.isArray(value)) return []
  const accounts: RoutingAccount[] = []
  for (const item of value) {
    if (!Array.isArray(item)) continue
    const [id, name, order, credits, creditsError, health, enabled] =
      item as unknown as readonly [unknown, unknown, unknown, unknown, unknown, unknown, unknown]
    if (typeof id !== 'string' || id === '') continue
    accounts.push({
      id,
      name: typeof name === 'string' ? name : '',
      order: typeof order === 'number' ? order : accounts.length + 1,
      variant,
      ...typeof credits === 'object' && credits !== null ? { credits: credits as QoderWebCredits } : {},
      ...typeof creditsError === 'string' ? { creditsError } : {},
      ...health === 'normal' || health === 'queued' || health === 'limited' ? { health } : {},
      ...typeof enabled === 'boolean' ? { enabled } : {},
    })
  }
  return accounts
}

function parseRoutingFacts(raw: string): RoutingFacts {
  const empty: RoutingFacts = {
    accounts: [],
    cnServed: [],
    globalServed: [],
    cnCatalog: [],
    globalCatalog: [],
  }
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed) || parsed.length < 2) return empty
    const cn = parsed[0] as readonly [unknown, unknown, unknown]
    const global = parsed[1] as readonly [unknown, unknown, unknown]
    return {
      accounts: [...readRoutingAccounts(cn[0], 'cn'), ...readRoutingAccounts(global[0], 'global')],
      cnServed: readRoutingIds(cn[1]),
      cnCatalog: readRoutingIds(cn[2]),
      globalServed: readRoutingIds(global[1]),
      globalCatalog: readRoutingIds(global[2]),
    }
  } catch {
    return empty
  }
}

/**
 * The models that make a mixed order unsafe: ones a variant offers while the
 * OTHER variant's catalogue does not declare them at all.
 *
 * A side whose catalogue the store has never seen contributes no offenders —
 * an empty catalogue would make every model look one-sided, and a warning that
 * cannot name a single model is worse than no warning.
 */
function mixedRoutingOffenders(facts: RoutingFacts): { cn: readonly string[]; global: readonly string[] } {
  const globalCatalog = new Set(facts.globalCatalog)
  const cnCatalog = new Set(facts.cnCatalog)
  return {
    cn: facts.globalCatalog.length === 0 ? [] : facts.cnServed.filter(id => !globalCatalog.has(id)),
    global: facts.cnCatalog.length === 0 ? [] : facts.globalServed.filter(id => !cnCatalog.has(id)),
  }
}

/**
 * The order the routing list shows: what the user chose, then every account
 * they have not placed yet, in save order.
 *
 * The fallback is load-bearing. The stored order is only ever the user's own
 * list, so an account saved AFTER that list was written would otherwise vanish
 * from the very controls meant to order it — and a list that silently drops a
 * member is worse than one that appends it.
 */
function mergeRoutingOrder(chosen: readonly string[], saveOrder: readonly string[]): readonly string[] {
  const known = new Set(saveOrder)
  const placed: string[] = []
  for (const id of chosen) {
    if (known.has(id) && !placed.includes(id)) placed.push(id)
  }
  return [...placed, ...saveOrder.filter(id => !placed.includes(id))]
}

/**
 * POST one auth action and report whether the host accepted it.
 *
 * Every auth action answers the same shape — `{ ok: true }`, or
 * `{ ok: false, error }` / a 5xx — so the transport is shared and a refused id
 * stays a VERDICT rather than a transport failure. Callers re-read the document
 * afterwards instead of trusting the reply to describe the new state.
 */
async function postAuthAction(
  path: string,
  key: string,
  body: QoderAuthRequest,
  signal: AbortSignal,
): Promise<{ ok: boolean; detail: string }> {
  const response = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Qoder-Auth-Key': key },
    credentials: 'same-origin',
    signal,
    body: JSON.stringify(body),
  })
  const value: unknown = await response.json().catch(() => undefined)
  const record = typeof value === 'object' && value !== null ? value as Record<string, unknown> : {}
  if (response.ok && record['ok'] === true) return { ok: true, detail: '' }
  return {
    ok: false,
    detail: typeof record['error'] === 'string' ? record['error'] : `HTTP ${response.status}`,
  }
}

/**
 * The upstream "model not serviceable" notice.
 *
 * This is deliberately NOT an error alert. A saturated per-model queue (or a
 * service that is switched off) resolves by waiting, and the one action a user
 * must not take is re-generating a perfectly good PAT — the old rendering put
 * this text where credential errors go and users reasonably concluded their
 * token was broken. So the block carries the upstream's own words for the user
 * to quote, states a retry delay only when the upstream supplied one, claims a
 * wait ONLY when `waited` records that one actually happened, and says outright
 * that the credential is not the problem.
 */
function UpstreamNoticeBlock({ notice, t }: {
  notice: QoderWebUpstreamNotice
  t: QoderPluginCardInjected['t']
}): ReactNode {
  // Milliseconds are the wire unit; a countdown the user reads is seconds, and
  // rounding a sub-second ask down to 0 would read as "retry now". Only a
  // FINITE number becomes a countdown: a document carrying a string (or NaN)
  // would otherwise paint "NaN s", and a missing `at` would throw out of
  // `Intl.DateTimeFormat` and take the whole page down with it.
  const retrySeconds = typeof notice.retryAfterMs === 'number' && Number.isFinite(notice.retryAfterMs)
    ? Math.max(1, Math.round(notice.retryAfterMs / 1000))
    : undefined
  const at = typeof notice.at === 'number' && Number.isFinite(notice.at) ? notice.at : undefined
  const occurrences = typeof notice.occurrences === 'number' && Number.isFinite(notice.occurrences)
    ? notice.occurrences
    : 1
  return (
    <div className="qdp-notice" role="status" data-notice-kind={notice.kind}>
      <div className="qdp-noticeHead">
        <QdpTag tone="warn">
          {notice.kind === 'queued' ? t('upstreamNoticeKindQueued') : t('upstreamNoticeKindUnavailable')}
        </QdpTag>
        <span className="qdp-noticeTitle">{t('upstreamNoticeHeading')}</span>
        {at === undefined ? null : <span className="qdp-noticeAt">{t('upstreamNoticeAt', { time: formatTime(at) })}</span>}
      </div>
      {notice.upstreamMessage === undefined ? null : (
        <p className="qdp-noticeQuote">{t('upstreamNoticeMessage', { message: notice.upstreamMessage })}</p>
      )}
      {notice.waited
        ? (
          <p className="qdp-body">
            {retrySeconds === undefined
              ? t('upstreamNoticeWaitedNoDelay')
              : t('upstreamNoticeWaited', { seconds: retrySeconds })}
          </p>
        )
        : (retrySeconds === undefined ? null : <p className="qdp-body">{t('upstreamNoticeRetry', { seconds: retrySeconds })}</p>)}
      <p className="qdp-body">{t('upstreamNoticeNotAuth')}</p>
      <p className="qdp-caption">
        {occurrences > 1
          ? `${t('upstreamNoticeAdvice')} · ${t('upstreamNoticeRecurrence', { count: occurrences })}`
          : t('upstreamNoticeAdvice')}
      </p>
    </div>
  )
}

/**
 * The section head's catalogue provenance line: where the visible model roster
 * came from and when. `live` and `saved` name the last successful fetch; the
 * built-in fallback says so explicitly instead of pretending to be current.
 */
function catalogCaptionOf(catalog: QoderWebCatalog | undefined, t: QoderPluginCardInjected['t']): string | undefined {
  if (catalog === undefined) return undefined
  if (catalog.source === 'live') {
    return catalog.fetchedAt === undefined ? t('catalogFallback') : t('catalogLive', { time: formatTime(catalog.fetchedAt) })
  }
  if (catalog.source === 'saved') {
    return catalog.fetchedAt === undefined ? t('catalogFallback') : t('catalogSaved', { time: formatTime(catalog.fetchedAt) })
  }
  return t('catalogFallback')
}

/** Minutes past midnight (UTC+8), split for the two number fields. */
function splitMinutes(minutes: number): { hours: number; minutes: number } {
  const safe = Number.isFinite(minutes) ? Math.trunc(minutes) : CHECK_IN_MINUTE_DEFAULT
  const clamped = safe < 0 || safe > 1439 ? CHECK_IN_MINUTE_DEFAULT : safe
  return { hours: Math.floor(clamped / 60), minutes: clamped % 60 }
}

/**
 * The automatic check-in time: the moment a variant checks in, as two typeable
 * number fields.
 *
 * Deliberately NOT `<input type="time">`: that control's segments are spinners,
 * and with an IME active (every Chinese/Japanese keyboard) the segments refuse
 * typed digits, leaving only the tiny stepper arrows — unusable for the one
 * thing this control exists to do. Two plain number fields accept typing under
 * any input method; the value is committed on blur or Enter, so a half-typed
 * field never writes a wrong moment to the settings file.
 */
function CheckInTimeRow({ label, value, disabled, onPick }: {
  label: string
  value: number
  disabled?: boolean
  onPick: (minutes: number) => void
}): ReactNode {
  const split = splitMinutes(value)
  const [hourDraft, setHourDraft] = useState(String(split.hours))
  const [minuteDraft, setMinuteDraft] = useState(String(split.minutes).padStart(2, '0'))

  // Re-seed the fields whenever the stored value changes underneath us (a
  // save landing, another surface editing it). Editing itself does not write
  // until commit, so this cannot fight the typist.
  useEffect(() => {
    const next = splitMinutes(value)
    setHourDraft(String(next.hours))
    setMinuteDraft(String(next.minutes).padStart(2, '0'))
  }, [value])

  const commit = (): void => {
    const parsedHours = Number.parseInt(hourDraft, 10)
    const parsedMinutes = Number.parseInt(minuteDraft, 10)
    const hours = Number.isFinite(parsedHours) ? Math.min(23, Math.max(0, parsedHours)) : split.hours
    const minutes = Number.isFinite(parsedMinutes) ? Math.min(59, Math.max(0, parsedMinutes)) : split.minutes
    const next = hours * 60 + minutes
    if (next === value) {
      // Nothing to write, but normalize what is on screen ("9" -> "09").
      setHourDraft(String(hours))
      setMinuteDraft(String(minutes).padStart(2, '0'))
      return
    }
    onPick(next)
  }

  const onKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>): void => {
    if (event.key === 'Enter') {
      event.preventDefault()
      commit()
    }
  }

  return (
    <>
      <QdpInput
        className="qdp-inputShort"
        type="number"
        min={0}
        max={23}
        value={hourDraft}
        disabled={disabled === true}
        aria-label={`${label} — hour`}
        data-checkin-part="hour"
        onChange={event => { setHourDraft(event.target.value) }}
        onBlur={commit}
        onKeyDown={onKeyDown}
      />
      <span className="qdp-muted" aria-hidden="true">:</span>
      <QdpInput
        className="qdp-inputShort"
        type="number"
        min={0}
        max={59}
        value={minuteDraft}
        disabled={disabled === true}
        aria-label={`${label} — minute`}
        data-checkin-part="minute"
        onChange={event => { setMinuteDraft(event.target.value) }}
        onBlur={commit}
        onKeyDown={onKeyDown}
      />
      <span className="qdp-caption">UTC+8</span>
    </>
  )
}

/** The advanced-settings rows, projected from the settings face. */
interface CheckInSettings {
  autoCN: boolean
  autoGlobal: boolean
  /** The one shared check-in moment, minutes past midnight UTC+8. */
  minute: number
  pollMs: number
  /** The whole-variant master switches (on unless explicitly off). */
  variantCN: boolean
  variantGlobal: boolean
  status: 'loading' | 'ready' | 'unavailable'
  writable: boolean
  /** Whether a connection failure may walk on to the next account. */
  autoFailoverEnabled: boolean
  queueWaitAttempts: number
  queueWaitSeconds: number
  routingStrategy: QoderRoutingStrategy
  /** The user's own priority list, account ids, highest priority first. */
  routingOrder: readonly string[]
  stickinessRounds: number
  stickinessRequests: number
  stickinessMinutes: number
  /** The last write the host refused, or '' when the last one landed. */
  writeError: string
}

const UNAVAILABLE_SETTINGS: CheckInSettings = {
  autoCN: false,
  autoGlobal: false,
  minute: CHECK_IN_MINUTE_DEFAULT,
  pollMs: POLL_DEFAULT_MS,
  variantCN: true,
  variantGlobal: true,
  status: 'unavailable',
  writable: false,
  autoFailoverEnabled: true,
  queueWaitAttempts: QUEUE_WAIT_ATTEMPTS_DEFAULT,
  queueWaitSeconds: QUEUE_WAIT_SECONDS_DEFAULT,
  routingStrategy: 'save-order',
  routingOrder: [],
  stickinessRounds: STICKINESS_ROUNDS_DEFAULT,
  stickinessRequests: STICKINESS_REQUESTS_DEFAULT,
  stickinessMinutes: STICKINESS_MINUTES_DEFAULT,
  writeError: '',
}

/**
 * Read the advanced-settings half of the settings face as a STABLE STRING.
 *
 * `useSyncExternalStore`'s getSnapshot must return the same reference between
 * renders unless the store changed. The face's value is a fresh object per
 * accepted document, so projecting it directly would re-render forever
 * (React #185); the JSON string below is stable by construction, and is parsed
 * back into the fields the card actually renders.
 *
 * The readout switch is deliberately NOT projected here: it is a client-side
 * preference (the shipped host's settings face does not own it), so it lives in
 * the shared store and is read directly by the advanced card.
 */
function settingsKeyOf(scope: QuotaSettingsScope<QuotaSection> | undefined): string {
  if (scope === undefined) return 'unavailable'
  const snapshot = scope.getSnapshot()
  const value = snapshot.value ?? {}
  return JSON.stringify([
    value.autoCheckInCN === true,
    value.autoCheckInGlobal === true,
    typeof value.checkInMinute === 'number' ? value.checkInMinute : CHECK_IN_MINUTE_DEFAULT,
    snapshot.status,
    snapshot.writable,
    typeof value.quotaPollMs === 'number' ? value.quotaPollMs : POLL_DEFAULT_MS,
    value.variantEnabledCN !== false,
    value.variantEnabledGlobal !== false,
    // The failover/routing policy. `routingOrder` is compared by VALUE: the
    // face hands back a fresh array per document, and a reference comparison
    // would re-render the card on every read.
    value.autoFailoverEnabled !== false,
    typeof value.queueWaitAttempts === 'number' ? value.queueWaitAttempts : QUEUE_WAIT_ATTEMPTS_DEFAULT,
    typeof value.queueWaitSeconds === 'number' ? value.queueWaitSeconds : QUEUE_WAIT_SECONDS_DEFAULT,
    value.routingStrategy === 'custom' ? 'custom' : 'save-order',
    Array.isArray(value.routingOrder) ? value.routingOrder : [],
    typeof value.stickinessRounds === 'number' ? value.stickinessRounds : STICKINESS_ROUNDS_DEFAULT,
    typeof value.stickinessMinutes === 'number' ? value.stickinessMinutes : STICKINESS_MINUTES_DEFAULT,
    // Appended rather than inserted: the tuple is positional, and a new field in
    // the middle would silently re-label every field after it.
    typeof value.stickinessRequests === 'number' ? value.stickinessRequests : STICKINESS_REQUESTS_DEFAULT,
    // The last refusal, so a control that did not take says so. Appended for
    // the same positional reason as the field above.
    snapshot.error ?? '',
  ])
}

function parseSettingsKey(raw: string): CheckInSettings {
  if (raw === 'unavailable') return UNAVAILABLE_SETTINGS
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed) || parsed.length < 6) return UNAVAILABLE_SETTINGS
    const autoCN = parsed[0] === true
    const autoGlobal = parsed[1] === true
    const minute = typeof parsed[2] === 'number' ? parsed[2] : CHECK_IN_MINUTE_DEFAULT
    const status = parsed[3] === 'ready' || parsed[3] === 'loading' ? parsed[3] : 'unavailable'
    const pollMs = typeof parsed[5] === 'number' ? parsed[5] : POLL_DEFAULT_MS
    const routingOrder = Array.isArray(parsed[12])
      ? parsed[12].filter((id): id is string => typeof id === 'string')
      : []
    return {
      autoCN,
      autoGlobal,
      minute,
      pollMs,
      variantCN: parsed[6] !== false,
      variantGlobal: parsed[7] !== false,
      status,
      writable: parsed[4] === true,
      autoFailoverEnabled: parsed[8] !== false,
      queueWaitAttempts: typeof parsed[9] === 'number' ? parsed[9] : QUEUE_WAIT_ATTEMPTS_DEFAULT,
      queueWaitSeconds: typeof parsed[10] === 'number' ? parsed[10] : QUEUE_WAIT_SECONDS_DEFAULT,
      routingStrategy: parsed[11] === 'custom' ? 'custom' : 'save-order',
      routingOrder,
      stickinessRounds: typeof parsed[13] === 'number' ? parsed[13] : STICKINESS_ROUNDS_DEFAULT,
      stickinessMinutes: typeof parsed[14] === 'number' ? parsed[14] : STICKINESS_MINUTES_DEFAULT,
      stickinessRequests: typeof parsed[15] === 'number' ? parsed[15] : STICKINESS_REQUESTS_DEFAULT,
      writeError: typeof parsed[16] === 'string' ? parsed[16] : '',
    }
  } catch {
    return UNAVAILABLE_SETTINGS
  }
}

/**
 * Render the Qoder account, model and advanced-settings sections as the
 * Plugins page's configuration page (or its one-liner, when the owner asks
 * for `summary`).
 *
 * On `page` this component renders the configuration BODY only: the Plugins
 * page draws the breadcrumb, icon, title, version and description, so no shell
 * chrome or second title lives here. The page is a grid of three cards:
 *
 * 1. 账号 — variant switcher (with per-variant enable checkboxes), status row,
 *    account summary strip, credential row, PAT entry
 * 2. 模型 — catalogue provenance + refresh, then the models pane body
 * 3. 高级设置 — quota-readout switch, auto check-in + its UTC+8 time, poll interval
 *
 * A signed-out account renders 账号 (with the PAT entry) and 高级设置 only:
 * model preferences for an account nobody is signed into would be settings the
 * user cannot exercise yet.
 */
/**
 * The custom routing order, top to bottom.
 *
 * The list is what the failover walk follows, so a row's position is its
 * priority and the only two edits are 「上移 / 下移」. Both ends are disabled
 * rather than hidden: the buttons stay where the eye left them, and a disabled
 * up-arrow on the first row IS the statement that it is already first.
 */
function RoutingOrderList(props: {
  ids: readonly string[]
  nameOf: (id: string) => string
  variantOf: (id: string) => 'cn' | 'global' | undefined
  accountOf: (id: string) => RoutingAccount | undefined
  disabled: boolean
  t: QoderPluginCardInjected['t']
  onMove: (from: number, to: number) => void
}): ReactNode {
  const { ids, nameOf, variantOf, accountOf, disabled, t, onMove } = props
  if (ids.length === 0) return <p className="qdp-caption">{t('routingOrderMissing')}</p>
  return (
    <ol className="qdp-routingList">
      {ids.map((id, index) => {
        const name = nameOf(id)
        const side = variantOf(id)
        const account = accountOf(id)
        /*
         * Balance and state follow the name, exactly as they do in the account
         * list above. A row's position in this list is a routing decision, and
         * the two facts that make that decision are what the seat still has and
         * whether it is currently serving — showing them here is what turns the
         * order from a list of names into a list of choices.
         *
         * A seat the host has no figure for shows the same words the account
         * list uses (`accountCreditsUnknown` / the read's own error), so the
         * two views never disagree about a seat.
         */
        const creditsText = account === undefined ? undefined : accountRowCredits(account, t)
        /*
         * Same rule as the account list: an enabled seat shows its observed
         * state, and an unobserved one says so (neutral 尚未观测) rather than
         * claiming 正常 — nothing has failed, but nothing has served either. A
         * parked seat shows no service state at all: it is out of the walk, so
         * calling it healthy would be a promise this list will not keep.
         */
        const showHealth = account !== undefined && account.enabled !== false
        const health = account?.health
        return (
          <li className="qdp-routingItem" key={id} data-account-id={id}>
            {/* Name and balance share one growing cell so the balance sits
                right after the name instead of being pushed to the far edge by
                the action buttons. */}
            <span className="qdp-routingWho">
              <span className="qdp-routingName">{name}</span>
              {creditsText === undefined ? null : (
                <span className="qdp-routingCredits">{creditsText}</span>
              )}
            </span>
            {showHealth ? (
              <QdpTag tone={health === undefined ? 'neutral' : health === 'normal' ? 'success' : 'warn'}>
                {accountHealthLabel(health, t)}
              </QdpTag>
            ) : null}
            {side === undefined ? null : (
              <QdpTag tone="neutral">{side === 'cn' ? t('variantTabCN') : t('variantTabGlobal')}</QdpTag>
            )}
            {account?.enabled === false ? <QdpTag tone="neutral">{t('accountParked')}</QdpTag> : null}
            <span className="qdp-routingItemActions">
              <QdpButton
                variant="outline"
                size="sm"
                disabled={disabled || index === 0}
                aria-label={t('routingOrderMoveUpAria', { name })}
                onClick={() => { onMove(index, index - 1) }}
              >
                {t('routingOrderMoveUp')}
              </QdpButton>
              <QdpButton
                variant="outline"
                size="sm"
                disabled={disabled || index === ids.length - 1}
                aria-label={t('routingOrderMoveDownAria', { name })}
                onClick={() => { onMove(index, index + 1) }}
              >
                {t('routingOrderMoveDown')}
              </QdpButton>
            </span>
          </li>
        )
      })}
    </ol>
  )
}

/**
 * The mixed-variant routing warning.
 *
 * A custom order that interleaves the two variants can send a request to a
 * variant that does not offer the model at all. This is stated as a fact, not a
 * gate: the user asked for the order and the walk skips accounts that cannot
 * serve the model anyway, so the banner exists to explain what will happen —
 * never to hold the write back or to ask for an acknowledgement.
 */
function MixedRoutingWarning(props: {
  offendersCN: readonly string[]
  offendersGlobal: readonly string[]
  t: QoderPluginCardInjected['t']
}): ReactNode {
  const { offendersCN, offendersGlobal, t } = props
  return (
    <div className="qdp-alert qdp-routingWarning" role="alert">
      <span className="qdp-routingWarningTitle">{t('routingMixedHeading')}</span>
      <span>{t('routingMixedBody')}</span>
      {offendersCN.length + offendersGlobal.length === 0 ? null : (
        <span>
          {t('routingMixedOffenders')}
          <span className="qdp-routingOffenders">
            {offendersCN.length === 0
              ? null
              : <span>{t('routingMixedOffenderCN', { models: offendersCN.join('、') })}</span>}
            {offendersGlobal.length === 0
              ? null
              : <span>{t('routingMixedOffenderGlobal', { models: offendersGlobal.join('、') })}</span>}
          </span>
        </span>
      )}
    </div>
  )
}

/** 14px stroke refresh glyph, so the icon-button matches the host's icon set. */
function RefreshGlyph(): ReactNode {
  return (
    <svg aria-hidden="true" width="14" height="14" viewBox="0 0 16 16" fill="none">
      <path
        d="M13.2 6.4A5.4 5.4 0 1 0 13 10.6M13.2 2.6v3.8H9.4"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

export function QoderPluginCard(props: QoderPluginCardProps) {
  const { t, scope, signedIn, variant, unified, view } = props
  if (t === undefined) throw new Error('Qoder plugin card requires its translation function')

  const isUnified = unified === true
  const liveSignIn = useSyncExternalStore(onQuotaSettingsChange, quotaSignInState)
  /**
   * The composer-readout switches are a CLIENT preference, not part of the host
   * settings document: the shipped settings face rejects the field with HTTP
   * 400 `unknown field`, so the shared store owns (and persists) it. The store
   * returns a stable cached snapshot, which is what `useSyncExternalStore`
   * requires.
   */
  const readout = useSyncExternalStore(onQuotaSettingsChange, quotaReadout)
  /**
   * Both variants' account pools and catalogues, as a stable snapshot.
   *
   * The custom routing order spans BOTH variants, so the warning that guards a
   * mixed order has to read the other variant's document too — not just the one
   * this card is showing. It comes from the shared store rather than a fetch:
   * the card never asks the host for a variant the user is not looking at.
   */
  const routing = useSyncExternalStore(onQuotaSettingsChange, routingFacts)
  /*
   * Re-render whenever ANY surface publishes a status document.
   *
   * The card reads the shared documents through {@link quotaStatus}; another
   * surface (the composer chip, the sidebar card) can publish one for the
   * variant this card is not showing, and the switcher's dot and tab body must
   * follow that write. The revision is the subscription's only job here.
   */
  useSyncExternalStore(onQuotaSettingsChange, quotaSettingsRevision, quotaSettingsRevision)
  /** The check-in half of the settings face, as a stable projection string. */
  const settingsSubscribe = useCallback((onStoreChange: () => void) => {
    return scope?.subscribe(onStoreChange) ?? (() => {})
  }, [scope])
  const settingsRaw = useSyncExternalStore(settingsSubscribe, () => settingsKeyOf(scope))
  const settings = parseSettingsKey(settingsRaw)
  /*
   * Ask the face for its document once, on mount, when it has not answered yet.
   *
   * The browser half can activate before the host route is registered, and a
   * page that came up in that window used to stay on its defaults — every
   * control enabled and inert — for the life of the tab. This is a no-op when
   * the document is already loaded or a read is in flight.
   */
  useEffect(() => { scope?.ensureLoaded?.() }, [scope])

  const [activeVariantId, setActiveVariantId] = useState<QoderVariantId>('qoder')
  const currentVariant = isUnified
    ? (activeVariantId === 'qoder' ? QODER_CN_CARD : QODER_GLOBAL_CARD)
    : (variant ?? QODER_CN_CARD)

  /**
   * The last known sign-in fact for one variant, from the host injection when
   * it supplies one (the settings integration does) and from the shared store
   * otherwise. `undefined` = never read, which is NOT the same as signed out.
   */
  const reported = signedIn?.()
  const knownSignIn = (variantId: QoderVariantId): boolean | undefined => {
    const key = variantId === 'qoder' ? 'cn' : 'global'
    return reported !== undefined ? reported[key] : liveSignIn[key]
  }

  /**
   * Last status document PER VARIANT, plus the last read failure per variant.
   *
   * A single `status` cleared on every switch made the card blank and start
   * over: even a variant whose document was already cached on this page fell
   * back to the spinner, and a variant never read fell back to the grey
   * "signed out" dot — which is exactly what made the Global tab look disabled
   * on entry. Keyed per variant, the switcher paints the last read at once and
   * revalidates it in the background.
   */
  const [documents, setDocuments] = useState<Partial<Record<QoderVariantId, QoderWebStatus>>>({})
  const [readFailures, setReadFailures] = useState<Partial<Record<QoderVariantId, string>>>({})
  const status = documents[currentVariant.id] ?? quotaStatus(currentVariant.id)
  const readFailure = readFailures[currentVariant.id]
  const [busy, setBusy] = useState(false)
  const [patDraft, setPatDraft] = useState('')
  const [replacing, setReplacing] = useState(false)
  const [patBusy, setPatBusy] = useState(false)
  const [patError, setPatError] = useState<string>()
  const [patNotice, setPatNotice] = useState<string>()
  const [checkingIn, setCheckingIn] = useState(false)
  const [checkInNotice, setCheckInNotice] = useState<string>()
  /** 「删除 PAT」的内联确认：点一次进入确认，再点一次才真正清除。 */
  const [confirmingClear, setConfirmingClear] = useState(false)
  /**
   * The account-pool actions: one busy flag for switch/remove, the id whose
   * row is asking for a remove confirmation, and one message pair.
   *
   * `accountError` is deliberately NOT `patError`: the PAT entry can be closed
   * when a row action fails, and an error parked inside a hidden box is an
   * error the user never sees.
   */
  const [accountBusy, setAccountBusy] = useState(false)
  const [confirmingRemoveId, setConfirmingRemoveId] = useState<string>()
  const [accountError, setAccountError] = useState<string>()
  const [accountNotice, setAccountNotice] = useState<string>()
  /**
   * The ids with an in-flight park/unpark write.
   *
   * A SET, not one flag: parking two seats is two independent writes to two
   * accounts, and a single shared busy flag would make the second click a
   * silent no-op. It is separate from `accountBusy` (switch/remove) because the
   * two gestures touch different rows and must not block each other.
   */
  const [togglingIds, setTogglingIds] = useState<readonly string[]>([])
  /**
   * The model pane's batched save: its own busy flag, separate from a refresh.
   */
  const [savingModels, setSavingModels] = useState(false)
  const [modelsSaveError, setModelsSaveError] = useState<string>()
  const mounted = useRef(true)
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

  // A per-variant read counter: the prefetch for the inactive variant runs
  // alongside the active variant's read, and one shared counter would let the
  // slower prefetch discard the other's newer answer.
  const readSeq = useRef<Partial<Record<QoderVariantId, number>>>({})

  /**
   * Read one variant's status document.
   *
   * With `force: false` (the sibling prefetch) the shared cache decides first:
   * a document younger than the configured poll interval is reused, so warming
   * the other tab costs no upstream call — the configured interval is a cache
   * lifetime, not a metronome. Mount, tab switches, every explicit gesture
   * (refresh, a write's follow-up) and the interval tick force: they paint the
   * cached document at once and revalidate it, so a stale cache never sticks.
   */
  const readVariant = useCallback(async (
    target: QoderCardVariant,
    options: { force?: boolean },
    signal?: AbortSignal,
  ): Promise<boolean> => {
    const variantId = target.id
    if (options.force !== true && quotaStatusIsFresh(variantId, quotaPollMs())) return false
    const seq = (readSeq.current[variantId] ?? 0) + 1
    readSeq.current[variantId] = seq
    const current = (): boolean => mounted.current
      && signal?.aborted !== true
      && readSeq.current[variantId] === seq
    try {
      const response = await fetch(target.statusPath, {
        headers: { accept: 'application/json' },
        credentials: 'same-origin',
        ...signal === undefined ? {} : { signal },
      })
      const value: unknown = await response.json().catch(() => undefined)
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      if (!isQoderWebStatus(value)) throw new Error(t('statusResponseInvalid'))
      if (!current()) return false
      // The local copy renders a body with no sign-in meaning (the host's own
      // `error` status); only real sign-in documents reach the shared store,
      // whose cache the other surfaces gate their own reads on.
      setDocuments(previous => previous[variantId] === value ? previous : { ...previous, [variantId]: value })
      setReadFailures(previous => previous[variantId] === undefined ? previous : { ...previous, [variantId]: undefined })
      if (value.status === 'signed-in' || value.status === 'signed-out') noteQuotaStatus(variantId, value)
      return true
    } catch (error: unknown) {
      if (!current()) return false
      const message = error instanceof Error && error.message !== '' ? error.message : t('requestFailed')
      setReadFailures(previous => ({ ...previous, [variantId]: message }))
      // Keep the last good document on screen — a failed revalidation is not a
      // reason to forget the account. Only a variant with nothing to show gets
      // the error body, and its message stays attached to its own tab.
      setDocuments(previous => previous[variantId] !== undefined || quotaStatus(variantId) !== undefined
        ? previous
        : { ...previous, [variantId]: { status: 'error', message } })
      return false
    }
  }, [t])

  /** A deliberate re-read: user refresh, a write's follow-up, the poll tick. */
  const refresh = useCallback(
    (signal?: AbortSignal): Promise<boolean> => readVariant(currentVariant, { force: true }, signal),
    [currentVariant, readVariant],
  )

  /** Record (or clear) the read failure a variant's tab shows. */
  const noteReadFailure = useCallback((variantId: QoderVariantId, message: string | undefined): void => {
    setReadFailures(previous => previous[variantId] === message
      ? previous
      : { ...previous, [variantId]: message })
  }, [])

  // The card IS the page now: the owner mounts it only while its detail page is
  // open, so there is no `open` flag to gate the first read on. Switching
  // variants no longer blanks the document: the cached one paints immediately
  // and the forced read below revalidates it in the background.
  useEffect(() => {
    setPatDraft('')
    setReplacing(false)
    setPatError(undefined)
    setPatNotice(undefined)
    // Pool state is per-variant: CN and Global keep separate account lists, so a
    // switch must not leave the other product's confirmation, refusal, or armed
    // remove-confirm sitting under the new variant's rows.
    setAccountError(undefined)
    setAccountNotice(undefined)
    setConfirmingRemoveId(undefined)
    setConfirmingClear(false)
    setCheckInNotice(undefined)
    const controller = new AbortController()
    void readVariant(currentVariant, { force: true }, controller.signal)
    return () => { controller.abort() }
  }, [currentVariant.statusPath, readVariant])

  /*
   * Prefetch the sibling variant once, on mount.
   *
   * The Global status route is the slow one (a cross-border read), and the
   * switcher used to start from nothing for it: clicking it showed a spinner
   * until that read finished, even though the answer was needed one click
   * later anyway. Reading both variants up front makes the switch instant; a
   * document that is already cache-fresh is skipped.
   */
  const prefetched = useRef(false)
  useEffect(() => {
    if (!isUnified || prefetched.current) return
    prefetched.current = true
    const controller = new AbortController()
    for (const candidate of QODER_CARD_VARIANTS) {
      if (candidate.id === currentVariant.id) continue
      if (quotaStatusIsFresh(candidate.id, quotaPollMs())) continue
      void readVariant(candidate, {}, controller.signal)
    }
    return () => { controller.abort() }
  }, [currentVariant.id, isUnified, readVariant])

  // The 60s poll. Also ungated: a mounted page is a page the user is looking at.
  // A variant known to be signed out is not polled — there is nothing to learn
  // from a status route with no PAT (an unknown variant keeps polling until its
  // first answer lands).
  const currentSignIn = knownSignIn(currentVariant.id)
  useEffect(() => {
    if (currentSignIn === false) return
    const controller = new AbortController()
    const timer = window.setInterval(
      () => { void readVariant(currentVariant, { force: true }, controller.signal) },
      POLL_INTERVAL_MS,
    )
    return () => {
      window.clearInterval(timer)
      controller.abort()
    }
  }, [currentSignIn, currentVariant, readVariant])

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
     * `{state:'failed', reason}` — checking `response.ok` alone would treat
     * every failure as a success: no throw, no message, just the old model list
     * still on screen. The body is parsed the same way `manualCheckInAll` parses
     * it, so both manual actions report their outcome consistently.
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
        noteReadFailure(currentVariant.id, error instanceof Error ? error.message : t('requestFailed'))
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
      if (mounted.current) noteReadFailure(currentVariant.id, result.reason ?? t('requestFailed'))
      manualControllers.current.delete(controller)
      return
    }
    if (result.state === 'refreshed' && mounted.current) noteReadFailure(currentVariant.id, undefined)
    try {
      await refresh(controller.signal)
    } finally {
      manualControllers.current.delete(controller)
    }
  }, [currentVariant.id, currentVariant.probePath, noteReadFailure, refresh, status, t, trackController])

  /**
   * 「一键签到」: claim today's benefit for EVERY signed-in variant in one click.
   *
   * The probe key is process-wide (one key authorizes both variants' routes),
   * so the card can drive the other variant's route without a second read. A
   * variant that is not signed in is skipped rather than attempted: its route
   * would only answer with a credential error the user cannot act on from here.
   *
   * One failure must not abort the other claim: each target is wrapped
   * separately and its own sentence is appended, so a China failure still lets
   * Global claim (and vice versa).
   */
  const manualCheckInAll = useCallback(async (): Promise<void> => {
    const document = status?.status === 'signed-in' ? status : undefined
    const key = document?.probeKey
    if (key === undefined) return
    setCheckingIn(true)
    setCheckInNotice(undefined)
    const controller = trackController()
    const sentences: string[] = []
    try {
      for (const variant of QODER_CARD_VARIANTS) {
        const isCurrent = variant.id === currentVariant.id
        const signedIn = isCurrent || (variant.id === 'qoder' ? liveSignIn.cn : liveSignIn.global)
        if (!signedIn) continue
        const name = t(variant.id === 'qoder' ? 'variantTabCN' : 'variantTabGlobal')
        try {
          const response = await fetch(variant.probePath, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Qoder-Probe-Key': key },
            credentials: 'same-origin',
            signal: controller.signal,
            body: JSON.stringify({ action: 'checkin' } satisfies QoderProbeAction),
          })
          if (!response.ok) throw new Error(`HTTP ${response.status}`)
          const result = await response.json() as { state?: string; amount?: number; reason?: string; reasonCode?: string }
          const text = result.state === 'claimed'
            ? t('autoCheckInStatusClaimed', { amount: result.amount ?? 100 })
            : result.state === 'already-claimed'
              ? t('autoCheckInStatusAlready')
              : result.state === 'no-campaign'
                ? t('autoCheckInStatusNoCampaign')
                : result.reasonCode === 'no-client'
                  ? t('checkInNeedsClient')
                  : result.reason === undefined
                    ? undefined
                    : t('autoCheckInStatusError', { message: result.reason })
          if (text !== undefined) sentences.push(`${name} · ${text}`)
        } catch (error: unknown) {
          if (controller.signal.aborted === true) return
          const message = error instanceof Error ? error.message : t('requestFailed')
          sentences.push(`${name} · ${message}`)
        }
      }
      if (mounted.current && sentences.length > 0) setCheckInNotice(sentences.join('；'))
    } finally {
      manualControllers.current.delete(controller)
      if (mounted.current) setCheckingIn(false)
    }
    try {
      await refresh(controller.signal)
    } finally {
      manualControllers.current.delete(controller)
    }
  }, [currentVariant.id, liveSignIn, refresh, status, t, trackController])

  /**
   * One probe-route write, WITHOUT a status re-read.
   *
   * The batch save below issues several writes (two enable/disable batches and
   * one window write per changed model) and re-reads the status exactly once
   * afterwards. Refreshing per write would repaint the page between every
   * round trip, reset the pane's draft mid-save, and multiply the reads.
   *
   * The key travels in a header, not the body: it authorizes the write, and
   * the host never accepts a prompt, a sentinel, or a model outside its own
   * catalog from here.
   */
  const probeWrite = useCallback(async (action: QoderProbeAction): Promise<void> => {
    const key = status?.status === 'signed-in' ? status.probeKey : undefined
    if (key === undefined) throw new Error(t('requestFailed'))
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
      if (
        action.action === 'set-maximum-context-window'
        || action.action === 'set-models-enabled'
        || action.action === 'set-model-context-window'
      ) {
        if (typeof value !== 'object' || value === null || (value as Record<string, unknown>)['state'] !== 'updated') {
          const reason = typeof value === 'object' && value !== null && 'reason' in value
            ? String((value as Record<string, unknown>)['reason'])
            : t('requestFailed')
          throw new Error(reason)
        }
      }
    } finally {
      manualControllers.current.delete(controller)
    }
  }, [currentVariant.probePath, status, t, trackController])

  /**
   * Apply one draft from the models pane as a batch: the enable/disable delta,
   * then one write per changed context window, then ONE status re-read.
   *
   * The draft is a diff against the catalogue (the pane only stages models that
   * differ), so empty deltas are skipped rather than posted: the host rejects an
   * empty `models` list, and a pointless write is a failed save in waiting.
   */
  const saveModelDraft = useCallback(async (draft: ModelsDraft): Promise<void> => {
    const document = status?.status === 'signed-in' ? status : undefined
    if (document?.probeKey === undefined) return
    setSavingModels(true)
    setModelsSaveError(undefined)
    try {
      const baseDisabled = document.disabledModels ?? []
      const toDisable = draft.disabled.filter(id => !baseDisabled.includes(id))
      const toEnable = baseDisabled.filter(id => !draft.disabled.includes(id))
      if (toDisable.length > 0) {
        await probeWrite({ action: 'set-models-enabled', models: toDisable, enabled: false })
      }
      if (toEnable.length > 0) {
        await probeWrite({ action: 'set-models-enabled', models: toEnable, enabled: true })
      }
      const models = document.models ?? []
      for (const [model, window] of Object.entries(draft.windows)) {
        const baseline = models.find(entry => entry.id === model)
        const baselineWindow = baseline?.contextWindow ?? baseline?.defaultContextWindow
        if (baselineWindow === window) continue
        await probeWrite({ action: 'set-model-context-window', model, window })
      }
      // Exactly one re-read for the whole batch: the pane re-bases its draft
      // from the refreshed document, which is what makes the save feel applied.
      await refresh()
    } catch (error: unknown) {
      if (mounted.current) setModelsSaveError(error instanceof Error ? error.message : t('requestFailed'))
    } finally {
      if (mounted.current) setSavingModels(false)
    }
  }, [probeWrite, refresh, status, t])

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
      setDocuments(previous => ({ ...previous, [currentVariant.id]: signedOutDoc }))
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
   * 「切换使用」/「删除账号」: the two pool writes, addressed by the account id
   * the status document handed us.
   *
   * The id is the credential's one-way hash, never the token, so a card can
   * only ever name an account the host already told it about and the host
   * re-checks it against the pool it owns. The route answers the same shape as
   * save/clear (`{ ok: true }`, or `{ ok: false, error }` / a 5xx), and a
   * refused id is a verdict rather than a transport failure — so it is reported
   * and the pool is re-read, because an unknown id means another surface
   * changed the list under this card.
   *
   * A successful write is not trusted to describe itself: `refresh` re-reads
   * the document, which is what makes the active dot, the summary strip, and
   * the credit figure all move together.
   */
  const accountAction = useCallback(async (
    action: Extract<QoderAuthAction, 'activate-account' | 'remove-account'>,
    accountId: string,
    name: string,
  ): Promise<void> => {
    const key = authKey
    if (key === undefined || accountBusy) return
    setAccountBusy(true)
    setAccountError(undefined)
    setAccountNotice(undefined)
    setConfirmingRemoveId(undefined)
    const controller = trackController()
    try {
      const body: QoderAuthRequest = { action, accountId }
      const result = await postAuthAction(currentVariant.authPath, key, body, controller.signal)
      if (!result.ok) {
        setAccountError(t('accountActionFailed', { message: result.detail }))
      } else {
        setAccountNotice(action === 'activate-account' ? t('accountSwitched', { name }) : t('accountRemoved'))
      }
      await refresh(controller.signal)
    } catch (error: unknown) {
      if (mounted.current && controller.signal.aborted !== true) {
        setAccountError(t('accountActionFailed', {
          message: error instanceof Error ? error.message : t('requestFailed'),
        }))
      }
    } finally {
      manualControllers.current.delete(controller)
      if (mounted.current) setAccountBusy(false)
    }
  }, [accountBusy, authKey, currentVariant.authPath, refresh, t, trackController])

  /**
   * Park or unpark one pooled account.
   *
   * The checkbox is bound to the DOCUMENT (`enabled !== false`), never to an
   * optimistic local copy. Flipping it in state would show a value the host may
   * refuse, and the row's own re-read would then snap it back — a flicker users
   * read as a lost click. So the row reports itself busy and the value moves
   * only when the document says it did; a refusal keeps the previous value and
   * surfaces the host's reason in the shared account error line.
   *
   * Pending state is per account (see `togglingIds`), so one seat's write never
   * freezes another's checkbox.
   */
  const accountToggle = useCallback(async (
    accountId: string,
    enabled: boolean,
    name: string,
  ): Promise<void> => {
    const key = authKey
    if (key === undefined || togglingIds.includes(accountId)) return
    setTogglingIds(ids => [...ids, accountId])
    setAccountError(undefined)
    setAccountNotice(undefined)
    const controller = trackController()
    try {
      const body: QoderAuthRequest = { action: 'set-account-enabled', accountId, enabled }
      const result = await postAuthAction(currentVariant.authPath, key, body, controller.signal)
      if (!result.ok) {
        setAccountError(t('accountActionFailed', { message: result.detail }))
      } else {
        setAccountNotice(enabled ? t('accountEnabledNotice', { name }) : t('accountParkedNotice', { name }))
      }
      await refresh(controller.signal)
    } catch (error: unknown) {
      if (mounted.current && controller.signal.aborted !== true) {
        setAccountError(t('accountActionFailed', {
          message: error instanceof Error ? error.message : t('requestFailed'),
        }))
      }
    } finally {
      manualControllers.current.delete(controller)
      if (mounted.current) setTogglingIds(ids => ids.filter(id => id !== accountId))
    }
  }, [authKey, currentVariant.authPath, refresh, t, togglingIds, trackController])

  /**
   * The inline PAT entry: a password field plus save (and cancel while
   * replacing). The save control beside the field is the retry: an invalid PAT
   * is a value problem, not a transport one.
   */
  const patEntry = (): ReactNode => (
    <div className="qdp-stack">
      <p className="qdp-caption">{t(currentVariant.patGuideKey)}</p>
      <div className="qdp-row">
        <QdpInput
          className="qdp-patInput"
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

  /* The account row's state line: with a known subscriber name it reads
     「已登录：name」; without one it is the plain signed-in copy. */
  const signedInLabel = status?.status === 'signed-in' && status.pat?.accountName !== undefined
    ? t('accountSignedInAs', { name: status.pat.accountName })
    : label

  // Per-variant state dots for the segmented switcher: the variant being shown
  // renders its live document state, the other one its last known sign-in fact.
  // A variant switched OFF (its checkbox unchecked) is grey regardless of its
  // account: the switcher describes what is offered, and a disabled variant
  // offers nothing — signed in or not. A variant nobody has read yet is NOT
  // grey either: "not looked" and "signed out" are different facts, so it keeps
  // the neutral working state until its first answer lands.
  const dotFor = (target: QoderCardVariant, enabled: boolean): QdpDotState => {
    if (!enabled) return 'idle'
    if (isUnified && activeVariantId === target.id) {
      const document = documents[target.id] ?? quotaStatus(target.id)
      return dotStateOf(document === undefined ? 'loading' : document.status)
    }
    const known = knownSignIn(target.id)
    return known === undefined ? 'ongoing' : dotStateOf(known ? 'signed-in' : 'signed-out')
  }
  const cnDotState = dotFor(QODER_CN_CARD, settings.variantCN !== false)
  const globalDotState = dotFor(QODER_GLOBAL_CARD, settings.variantGlobal !== false)
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
  const settingsVariant: 'cn' | 'global' = isUnified
    ? (activeVariantId === 'qoder' ? 'cn' : 'global')
    : (currentVariant.id === 'qoder' ? 'cn' : 'global')
  const signedInDoc = status?.status === 'signed-in' ? status : undefined
  const settingsSignedIn = Boolean(knownSignIn(settingsVariant === 'cn' ? 'qoder' : 'qoder-global'))
  /** Whether EITHER account is signed in — the shared check-in time needs one. */
  const anySignedIn = Boolean(knownSignIn('qoder') || knownSignIn('qoder-global'))
  const autoCheckInOn = settingsVariant === 'cn' ? settings.autoCN : settings.autoGlobal
  /** One moment for both variants: the card edits a single shared setting. */
  const checkInMinute = settings.minute
  const readoutEnabled = readout.enabled
  const pollMinutes = Math.max(1, Math.round(settings.pollMs / 60_000))
  /**
   * One write path for every advanced-card control: the local settings face is
   * immediate (there is no save button), and a face the host does not serve —
   * or one that refuses writes — is skipped instead of pretending to store.
   */
  const writeSetting = (field: keyof QuotaSection, value: boolean | number): void => {
    if (settings.status === 'unavailable' || scope === undefined) return
    void scope.set(field, value)
  }
  /**
   * Write a field whose value is not a boolean or number.
   *
   * Kept separate from {@link writeSetting} so the scalar path above can never
   * be handed an array by mistake — a routing order posted through it would be
   * silently dropped by the host's own typing.
   */
  const writeStructuredSetting = (field: keyof QuotaSection, value: string | readonly string[]): void => {
    if (settings.status === 'unavailable' || scope === undefined) return
    void scope.set(field, value)
  }
  /**
   * The automatic check-in controls write the same fields the advanced card
   * always wrote; a variant with no PAT cannot arm a timer it could never fire,
   * so the switch stays disabled until that variant signs in.
   */
  const writeAutoCheckIn = (next: boolean): void => {
    if (!settingsSignedIn) return
    writeSetting(settingsVariant === 'cn' ? 'autoCheckInCN' : 'autoCheckInGlobal', next)
  }
  /**
   * The ONE check-in time.
   *
   * The shared field is the value the host's scheduler reads first, so writing
   * it alone retimes both variants. The legacy per-variant fields are cleared
   * (null) so a stale value can never outrank the shared one on an older
   * settings face that keeps them.
   */
  const writeCheckInMinute = (minutes: number): void => {
    if (!anySignedIn) return
    writeSetting('checkInMinute', minutes)
  }
  /**
   * The readout switch is NOT gated on sign-in: it describes what the composer
   * chip should show, and a user configuring the plugin before signing in must
   * still be able to hide it.
   *
   * It writes the shared STORE, not the settings scope: the shipped host does
   * not own this preference, and a browser preference must work against any
   * loaded host version. `setQuotaReadout` bumps the store's revision
   * synchronously, so the card re-renders from it.
   */
  const writeReadoutEnabled = (next: boolean): void => {
    setQuotaReadout(next)
  }
  /**
   * The per-variant master checkboxes beside the switcher tabs. They gate the
   * PROVIDER (no model of that variant is offered) without touching the
   * per-model blacklist, so flipping one back on restores exactly the previous
   * model selection.
   */
  const writeVariantEnabled = (variant: 'cn' | 'global', next: boolean): void => {
    writeSetting(variant === 'cn' ? 'variantEnabledCN' : 'variantEnabledGlobal', next)
  }
  const writePollMinutes = (minutes: number): void => {
    writeSetting('quotaPollMs', Math.max(POLL_MIN_MS, minutes * 60_000))
  }

  // ── routing policy ────────────────────────────────────────────────────
  /**
   * The routing controls write the host's OWN failover fields, so a settings
   * face that does not serve them gets no controls at all — a switch whose
   * value the host drops is a lie the user would only discover after a
   * failover went the wrong way.
   */
  const routingWritable = settings.status !== 'unavailable' && scope !== undefined
  /**
   * Whether the settings face has actually answered.
   *
   * While it is still loading the card renders the schema defaults, so every
   * control looks live but a write would be dropped (there is no document to
   * authorize it). Such controls are disabled instead of silently inert: a
   * control that accepts a click and forgets it is the exact failure this
   * state exists to prevent.
   */
  const settingsReady = settings.status === 'ready'
  const routingStrategy = settings.routingStrategy
  const routingStoredOrder = settings.routingOrder
  const routingNameOf = (id: string): string => {
    const account = routing.accounts.find(entry => entry.id === id)
    if (account === undefined) return id
    return account.name === '' ? t('accountSlot', { order: account.order }) : account.name
  }
  const routingVariantOf = (id: string): 'cn' | 'global' | undefined =>
    routing.accounts.find(entry => entry.id === id)?.variant
  /** Every variant holding this id: one token saved to both counts as both. */
  const routingSidesOf = (id: string): readonly ('cn' | 'global')[] => {
    const sides: ('cn' | 'global')[] = []
    if (routing.accounts.some(entry => entry.id === id && entry.variant === 'cn')) sides.push('cn')
    if (routing.accounts.some(entry => entry.id === id && entry.variant === 'global')) sides.push('global')
    return sides
  }
  const routingSaveOrder = routing.accounts.map(entry => entry.id)
  const routingOrderIds = mergeRoutingOrder(routingStoredOrder, routingSaveOrder)
  /*
   * The warning is scoped to a CUSTOM order on purpose.
   *
   * A pool that spans both variants is the normal state for anyone with
   * accounts on both sides, and under save order the user never authored that
   * interleaving — it is just the order the tokens were saved in. Warning about
   * it would put a banner on the ordinary pool that names models and offers no
   * change to make, which is the noise this card avoids elsewhere. What the
   * warning has to catch is the order the user is BUILDING here: that one can
   * hand a request to the variant that does not serve the model, and it is
   * exactly the order this control is about to write.
   */
  const routingMixed = routingStrategy === 'custom' && new Set(routingOrderIds.flatMap(routingSidesOf)).size > 1
  const routingOffenders = routingMixed ? mixedRoutingOffenders(routing) : { cn: [], global: [] }
  /**
   * Apply a routing change.
   *
   * The mixed-variant banner is informational: the order the user builds is
   * written straight through, because the walk simply skips an account whose
   * variant does not serve the model. Nothing here may hold a write back — the
   * user has already been told what the interleaving costs.
   */
  const applyRouting = (
    next: { strategy: 'save-order' | 'custom'; order: readonly string[] },
  ): void => {
    if (!routingWritable) return
    if (next.strategy !== settings.routingStrategy) writeStructuredSetting('routingStrategy', next.strategy)
    if (next.order.join('\u0000') !== routingStoredOrder.join('\u0000')) {
      writeStructuredSetting('routingOrder', [...next.order])
    }
  }
  const moveRoutingAccount = (from: number, to: number): void => {
    const ids = [...routingOrderIds]
    if (from < 0 || from >= ids.length || to < 0 || to >= ids.length) return
    const moved = ids.splice(from, 1)[0]
    if (moved === undefined) return
    ids.splice(to, 0, moved)
    applyRouting({ strategy: 'custom', order: ids })
  }
  const chooseRoutingStrategy = (next: 'save-order' | 'custom'): void => {
    applyRouting({ strategy: next, order: routingOrderIds })
  }

  // ── check-in strip data ───────────────────────────────────────────────
  const checkIn = signedInDoc?.checkIn
  /**
   * Today's benefit is already in — whether this process granted it or merely
   * found the upstream reporting it as claimed.
   *
   * `already-claimed` must count: the upstream answers that way for every later
   * request on a claimed day, so treating only `claimed` as "done" re-armed the
   * button and invited the repeat click. The DATE must count too — `checkIn` is
   * the persisted record, not a live reading, and `today` is stamped host-side
   * in UTC+8 (the day the scheduler uses), so a `claimed` row from three days
   * ago no longer disables today's button.
   */
  const claimedToday = checkIn !== undefined
    && checkIn.lastDate === checkIn.today
    && (checkIn.status === 'claimed' || checkIn.status === 'already-claimed')
  const catalogCaption = signedInDoc === undefined ? undefined : catalogCaptionOf(signedInDoc.catalog, t)

  // ── account card data ─────────────────────────────────────────────────
  /**
   * The account summary strip (剩余积分 / 签到状态 / 当前使用 / 一键签到).
   *
   * The remaining figure follows the SAME rule as the composer chip — summed
   * package remainder, "Unlimited" only when nothing is countable — because a
   * second currency rule on the same document is a bug waiting to happen.
   */
  const creditsText = signedInDoc?.credits === undefined
    ? '—'
    : (() => {
      const summary = creditSummary(signedInDoc.credits)
      return summary.unlimited
        ? t('quotaUnlimited')
        : new Intl.NumberFormat(undefined).format(summary.remain)
    })()
  const accountName = signedInDoc?.pat?.accountName
  const credentialMeta = signedInDoc?.pat === undefined
    ? undefined
    : [
      patSourceText(signedInDoc.pat.source, t),
      signedInDoc.pat.savedAtMs === undefined ? null : t('patSavedAt', { time: formatTime(signedInDoc.pat.savedAtMs) }),
      signedInDoc.pat.patTail === undefined ? null : t('patTail', { tail: `****${signedInDoc.pat.patTail}` }),
    ].filter(part => part !== null).join(' · ')
  const signedOutStatus = status?.status === 'signed-out' ? status : undefined
  const patEntryOpen = replacing || signedOutStatus !== undefined
  /**
   * The account pool, when the host serves one.
   *
   * `accounts` is present even with a single account (`entries.length === 1`),
   * and the list below renders from it alone — a synthesized one-row shape
   * would be a second code path that only ever shows one row. An EMPTY pool is
   * treated as absent on purpose: `accounts()` omits an env-only credential by
   * design, and that credential still needs the single-credential row to
   * describe it.
   */
  const servedAccounts = signedInDoc?.accounts
  /**
   * Rows whose `id` is missing are dropped rather than rendered.
   *
   * The id IS the write key (`{action, accountId}`) and the row's React key, so
   * an entry without one can only offer a control that sends `undefined` — and
   * a hostile or newer-host document must not be able to paint a dead button or
   * crash the page on `entries` itself.
   */
  const poolEntries = (Array.isArray(servedAccounts?.entries) ? servedAccounts.entries : []).filter(
    entry => typeof entry?.id === 'string' && entry.id.length > 0,
  )
  const pool = servedAccounts !== undefined && poolEntries.length > 0
    ? { ...servedAccounts, entries: poolEntries }
    : undefined
  /**
   * The host's in-process count of upstream errors that arrived INSIDE a 200
   * stream (a refused chat, a rate-limit page) and that the transport had to
   * classify after the status code said "fine".
   *
   * Rendered only when at least one has happened: zero is the normal case and
   * needs no row. The counts are per process, so they reset on restart — the
   * caption says so rather than pretending to be a lifetime statistic.
   */
  const innerErrorsSummary = (() => {
    const counters = signedInDoc?.innerErrors
    if (counters === undefined) return undefined
    const parts = ([
      ['content_policy', t('innerErrorsContentPolicy')],
      ['rate_limit', t('innerErrorsRateLimit')],
      ['invalid_request', t('innerErrorsInvalidRequest')],
      ['auth', t('innerErrorsAuth')],
      ['other', t('innerErrorsOther')],
    ] as const)
      .map(([kind, label]) => ({ label, count: counters[kind] ?? 0 }))
      .filter(item => item.count > 0)
      .map(item => `${item.label} ${item.count}`)
    return parts.length === 0 ? undefined : parts.join(' · ')
  })()
  const upstreamNotice = signedInDoc?.upstreamNotice

  return (
    <div className="qdp-page">
      {/* ── 1. 账号: switcher + one status row + credential row + PAT entry ── */}
      <section className="qdp-card">
        <div className="qdp-sectionHead">
          <h2 className="qdp-sectionTitle">{t('accountHeading')}</h2>
          {isUnified ? (
            <QdpSegmented
              label={t('variantSwitcherAria')}
              value={activeVariantId}
              options={[
                {
                  value: 'qoder',
                  label: (
                    <>
                      <QdpStateDot state={cnDotState} />
                      <span>{t('variantTabCN')}</span>
                    </>
                  ),
                  trailing: (
                    <input
                      type="checkbox"
                      className="qdp-segCheck"
                      checked={settings.variantCN}
                      disabled={!settingsReady}
                      aria-label={`${t('variantTabCN')} — ${t('variantEnable')}`}
                      title={t('variantEnable')}
                      onClick={event => { event.stopPropagation() }}
                      onChange={event => { writeVariantEnabled('cn', event.target.checked) }}
                    />
                  ),
                },
                {
                  value: 'qoder-global',
                  label: (
                    <>
                      <QdpStateDot state={globalDotState} />
                      <span>{t('variantTabGlobal')}</span>
                    </>
                  ),
                  trailing: (
                    <input
                      type="checkbox"
                      className="qdp-segCheck"
                      checked={settings.variantGlobal}
                      disabled={!settingsReady}
                      aria-label={`${t('variantTabGlobal')} — ${t('variantEnable')}`}
                      title={t('variantEnable')}
                      onClick={event => { event.stopPropagation() }}
                      onChange={event => { writeVariantEnabled('global', event.target.checked) }}
                    />
                  ),
                },
              ]}
              onChange={setActiveVariantId}
            />
          ) : null}
          <QdpIconButton
            label={t('refresh')}
            disabled={busy}
            onClick={() => { void manualRefresh() }}
          >
            <RefreshGlyph />
          </QdpIconButton>
        </div>
        <div className="qdp-sectionBody">
          <div className="qdp-row">
            <div className="qdp-rowText">
              <span className="qdp-rowTitle" role="status" aria-busy={status === undefined}>
                <QdpStateDot state={dotStateOf(status === undefined ? 'loading' : status.status)} />
                <span>{signedInLabel}</span>
                {planTag === undefined ? null : <QdpTag>{planTag}</QdpTag>}
              </span>
              {planMeta === undefined || planMeta === '' ? null : <span className="qdp-rowDesc">{planMeta}</span>}
            </div>
          </div>
          {signedInDoc === undefined ? null : (
            <div className="qdp-accountSummary">
              <div className="qdp-accountStat">
                <span className="qdp-accountStatLabel">{t('creditsRemaining')}</span>
                <span className="qdp-accountStatValue qdp-num">{creditsText}</span>
              </div>
              <div className="qdp-accountStat">
                <span className="qdp-accountStatLabel">{t('checkInStatus')}</span>
                <span className="qdp-accountStatValue">
                  {claimedToday
                    ? <QdpTag tone="success">{t('checkInClaimedToday')}</QdpTag>
                    : <span>{t('checkInNotClaimed')}</span>}
                </span>
              </div>
              <div className="qdp-accountStat">
                <span className="qdp-accountStatLabel">{t('accountCurrent')}</span>
                <span className="qdp-accountStatValue">{accountName ?? t('signedIn')}</span>
              </div>
              <div className="qdp-accountActions">
                <QdpButton
                  variant="primary"
                  size="sm"
                  disabled={busy || checkingIn || !anySignedIn}
                  onClick={() => { void manualCheckInAll() }}
                >
                  {checkingIn ? t('checkInChecking') : t('checkInAll')}
                </QdpButton>
              </div>
            </div>
          )}
          {checkInNotice === undefined ? null : <p className="qdp-body">{checkInNotice}</p>}
          {upstreamNotice === undefined ? null : <UpstreamNoticeBlock notice={upstreamNotice} t={t} />}
          {pool === undefined ? null : (
            <div className="qdp-accountPool">
              <div className="qdp-row">
                <div className="qdp-rowText">
                  <span className="qdp-rowTitle">
                    <span>{t('accountsHeading')}</span>
                    <QdpTag tone={pool.autoFailover ? 'success' : 'neutral'}>
                      {pool.autoFailover
                        ? t('accountsFailoverOn')
                        : pool.autoFailoverEnabled === false ? t('accountsFailoverOff') : t('accountsFailoverIdle')}
                    </QdpTag>
                  </span>
                  <span className="qdp-rowDesc">{t('accountsHint')}</span>
                </div>
                <div className="qdp-rowControl">
                  <QdpButton
                    variant="outline"
                    size="sm"
                    disabled={busy || patBusy || accountBusy || authKey === undefined}
                    onClick={() => {
                      // The pool's "add" is the same entry the single-credential
                      // row uses: `save` upserts by identity and activates, so a
                      // re-pasted token refreshes its row instead of duplicating it.
                      setPatError(undefined)
                      setPatNotice(undefined)
                      setReplacing(true)
                    }}
                  >
                    {t('accountAdd')}
                  </QdpButton>
                </div>
              </div>
              <ul className="qdp-accountList">
                {pool.entries.map(entry => {
                  const name = entry.accountName ?? t('accountSlot', { order: entry.order })
                  const armed = confirmingRemoveId === entry.id
                  /*
                   * The seat's state, always shown for an enabled seat.
                   *
                   * `entry.health` is absent until the transport observes a
                   * failure, and an absent state is not the same as a healthy
                   * one — saying 正常 would invent an observation the host never
                   * made, and the composer panel already stays silent about it.
                   * So the account list names the gap: an enabled seat with no
                   * observation reads 「尚未观测」 in the neutral tone. A parked
                   * seat shows no state at all: it is out of the walk, so
                   * calling it healthy would be a promise this list will not
                   * keep.
                   */
                  const showHealth = entry.enabled !== false
                  const health = entry.health
                  return (
                    <li
                      className={entry.enabled === false ? 'qdp-accountItem is-off' : 'qdp-accountItem'}
                      key={entry.id}
                      data-account-id={entry.id}
                    >
                      {/* The park checkbox is FIRST, before the name: it is the
                          only control that says whether this row takes part in
                          automatic switching at all, and the answer has to be
                          readable before the actions beside it. */}
                      <label className="qdp-accountCheck">
                        <input
                          type="checkbox"
                          checked={entry.enabled !== false}
                          disabled={busy || accountBusy || togglingIds.includes(entry.id)}
                          aria-label={t('accountEnabledAria', { name })}
                          onChange={event => { void accountToggle(entry.id, event.target.checked, name) }}
                        />
                      </label>
                      <div className="qdp-accountItemInfo">
                        <span className="qdp-accountItemName">
                          <QdpStateDot state={entry.active ? 'done' : 'idle'} />
                          <span>{name}</span>
                          {/*
                            Balance and state sit on the name line, right after
                            the name: they are how the user tells two seats
                            apart ("which of these still has credits"), so they
                            must be readable without scanning down each row.
                            A parked seat reports `accountCreditsParked` instead
                            of a figure: it is excluded from the walk, so a
                            spendable-looking number beside it would be a
                            promise this list will never keep.
                          */}
                          <span className="qdp-accountItemCredits">{accountRowCredits(entry, t)}</span>
                          {showHealth ? (
                            <span className="qdp-accountHealth" title={t('accountHealthAria')}>
                              <QdpTag tone={health === undefined ? 'neutral' : health === 'normal' ? 'success' : 'warn'}>
                                {accountHealthLabel(health, t)}
                              </QdpTag>
                            </span>
                          ) : null}
                          {entry.active ? <QdpTag tone="success">{t('accountCurrent')}</QdpTag> : null}
                          {entry.enabled === false ? <QdpTag tone="neutral">{t('accountParked')}</QdpTag> : null}
                        </span>
                        <span className="qdp-accountItemMeta">{accountRowMeta(entry, t)}</span>
                      </div>
                      <div className="qdp-rowControl">
                        <QdpButton
                          variant="outline"
                          size="sm"
                          disabled={entry.active || busy || accountBusy}
                          aria-label={t('accountSwitchAria', { name })}
                          onClick={() => { void accountAction('activate-account', entry.id, name) }}
                        >
                          {t('accountSwitch')}
                        </QdpButton>
                        <QdpButton
                          variant="dangerQuiet"
                          size="sm"
                          disabled={busy || accountBusy}
                          aria-label={t('accountRemoveAria', { name })}
                          onClick={() => { setConfirmingRemoveId(entry.id) }}
                        >
                          {t('patRemove')}
                        </QdpButton>
                      </div>
                      {armed ? (
                        <div className="qdp-alert qdp-accountItemConfirm" role="alert">
                          <span>{t('accountRemoveConfirm')}</span>
                          <div className="qdp-actions">
                            <QdpButton
                              variant="danger"
                              disabled={busy || accountBusy}
                              onClick={() => { void accountAction('remove-account', entry.id, name) }}
                            >
                              {t('accountRemoveConfirmYes')}
                            </QdpButton>
                            <QdpButton disabled={accountBusy} onClick={() => { setConfirmingRemoveId(undefined) }}>
                              {t('cancel')}
                            </QdpButton>
                          </div>
                        </div>
                      ) : null}
                    </li>
                  )
                })}
              </ul>
              {innerErrorsSummary === undefined ? null : (
                <p className="qdp-caption">{t('innerErrorsHeading')} · {innerErrorsSummary}</p>
              )}
              {pool.lastFailoverAt === undefined ? null : (
                <p className="qdp-caption">
                  {t('accountsLastFailover', { time: formatTime(pool.lastFailoverAt) })}
                  {pool.lastFailoverReason === undefined
                    ? null
                    : ` · ${t('accountsLastFailoverReason', { reason: pool.lastFailoverReason })}`}
                </p>
              )}
            </div>
          )}
          {accountError === undefined ? null : (
            <div className="qdp-alert qdp-alertError" role="alert">{accountError}</div>
          )}
          {accountNotice === undefined ? null : <p className="qdp-body">{accountNotice}</p>}
          {pool !== undefined || signedInDoc?.pat === undefined || replacing ? null : (
            <div className="qdp-row">
              <div className="qdp-rowText">
                <span className="qdp-rowTitle">{t('patHeading')}</span>
                {credentialMeta === undefined ? null : <span className="qdp-rowDesc">{credentialMeta}</span>}
              </div>
              <div className="qdp-rowControl">
                <QdpButton variant="outline" size="sm" disabled={busy || patBusy} onClick={() => { setReplacing(true) }}>
                  {t('patReplace')}
                </QdpButton>
                <QdpButton
                  variant="dangerQuiet"
                  size="sm"
                  disabled={busy || patBusy}
                  onClick={() => { setConfirmingClear(true) }}
                >
                  {t('patRemove')}
                </QdpButton>
              </div>
            </div>
          )}
          {confirmingClear && signedInDoc?.pat !== undefined ? (
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
          {signedOutStatus !== undefined ? (
            <p className={signedOutStatus.reason === undefined ? 'qdp-body' : 'qdp-error'}>
              {signedOutStatus.reason ?? t(currentVariant.signedOutKey)}
            </p>
          ) : null}
          {patEntryOpen && authKey !== undefined ? patEntry() : null}
          {signedInDoc !== undefined && signedInDoc.jobTokenRefreshedAt !== undefined ? (
            <p className="qdp-caption">{t('jobTokenRefreshed', { time: formatTime(signedInDoc.jobTokenRefreshedAt) })}</p>
          ) : null}
          {/* A failed revalidation keeps the last document on screen, so its
              reason is shown here; when the card has nothing but the failure
              (no document at all) the error body below already carries it. */}
          {readFailure === undefined || status?.status === 'error' ? null : (
            <div className="qdp-alert qdp-alertError" role="alert">
              <span>{t('statusRefreshFailed', { message: readFailure })}</span>
              <div className="qdp-actions">
                <QdpButton disabled={busy} onClick={() => { void manualRefresh() }}>
                  {busy ? t('refreshing') : t('refresh')}
                </QdpButton>
              </div>
            </div>
          )}
          {status?.status === 'error' ? (
            <div className="qdp-alert qdp-alertError" role="alert">{status.message}</div>
          ) : null}
        </div>
      </section>

      {/* ── 2. 模型: provenance + refresh in the head, the pane body below ── */}
      {signedInDoc === undefined ? null : (
        <section className="qdp-card">
          <div className="qdp-sectionHead">
            <h2 className="qdp-sectionTitle">{t('paneModels')}</h2>
            {catalogCaption === undefined ? null : <span className="qdp-caption">{catalogCaption}</span>}
            <QdpButton
              variant="outline"
              size="sm"
              disabled={busy}
              onClick={() => { void refreshModels() }}
            >
              {busy ? t('refreshingModels') : t('refreshModels')}
            </QdpButton>
          </div>
          <div className="qdp-sectionBody">
            {signedInDoc.catalog?.error === undefined ? null : (
              <p className="qdp-error">{t('catalogError', { message: signedInDoc.catalog.error })}</p>
            )}
            <ModelsPane
              models={signedInDoc.models}
              disabledModels={signedInDoc.disabledModels}
              catalog={signedInDoc.catalog}
              t={t}
              busy={busy === true}
              saving={savingModels}
              saveError={modelsSaveError}
              onSave={draft => { void saveModelDraft(draft) }}
              onRefreshModels={() => { void refreshModels() }}
            />
          </div>
        </section>
      )}

      {/* ── 3. 高级设置: readout switch, auto check-in + its shared time, poll ── */}
      <section className="qdp-card">
        <div className="qdp-sectionHead">
          <h2 className="qdp-sectionTitle">{t('quotaSectionAdvanced')}</h2>
        </div>
        <div className="qdp-sectionBody">
          {/* The face has not answered yet: the controls below show the schema
              defaults and are disabled, so say so instead of leaving the user
              to click a switch that cannot take. A read that failed outright
              says why — "loading…" forever is indistinguishable from broken. */}
          {settings.status !== 'loading' ? null : settings.writeError === '' ? (
            <p className="qdp-note" role="status" data-settings-state="loading">
              {t('settingsLoading')}
            </p>
          ) : (
            <p className="qdp-note qdp-noteDanger" role="alert" data-settings-state="unreadable">
              {t('settingsUnavailable', { message: settings.writeError })}
            </p>
          )}
          {/* The host refused the last write: the value on screen is not the
              one it holds, so the refusal is shown rather than swallowed. */}
          {settings.status === 'loading' || settings.writeError === '' ? null : (
            <p className="qdp-note qdp-noteDanger" role="alert" data-settings-state="write-failed">
              {t('settingsWriteFailed', { message: settings.writeError })}
            </p>
          )}
          <div className="qdp-row">
            <div className="qdp-rowText">
              <span className="qdp-rowTitle">{t('quotaReadoutEnabledLabel')}</span>
              <span className="qdp-rowDesc">{t('quotaReadoutEnabledDesc')}</span>
            </div>
            <div className="qdp-rowControl">
              <QdpSwitch
                checked={readoutEnabled}
                label={t('quotaReadoutEnabledLabel')}
                onChange={writeReadoutEnabled}
              />
            </div>
          </div>
          {/* The poll interval drives the composer's remaining-credit label
              itself, so it sits right under the readout switch it serves. */}
          {settings.status === 'unavailable' ? null : (
            <div className="qdp-row">
              <div className="qdp-rowText">
                <span className="qdp-rowTitle">{t('quotaPollLabel')}</span>
                <span className="qdp-rowDesc">{t('quotaPollHint')}</span>
              </div>
              <div className="qdp-rowControl">
                <QdpNumberField
                  marker="quota-poll-minutes"
                  min={1}
                  max={POLL_MINUTES_MAX}
                  value={pollMinutes}
                  label={t('quotaPollLabel')}
                  disabled={!settingsReady}
                  onCommit={minutes => { writePollMinutes(minutes) }}
                />
                <span className="qdp-caption">{t('quotaPollUnit')}</span>
              </div>
            </div>
          )}
          <div className="qdp-row">
            <div className="qdp-rowText">
              <span className="qdp-rowTitle">{t('paneUsage')}</span>
              <span className="qdp-rowDesc">
                {settingsSignedIn
                  ? (settingsVariant === 'cn' ? t('autoCheckInHintCN') : t('autoCheckInHintGlobal'))
                  : t('quotaSignInRequired')}
              </span>
            </div>
            <div className="qdp-rowControl">
              <QdpSwitch
                checked={autoCheckInOn}
                disabled={!settingsSignedIn}
                label={t('paneUsage')}
                onChange={writeAutoCheckIn}
              />
            </div>
          </div>
          <div className="qdp-row">
            <div className="qdp-rowText">
              <span className="qdp-rowTitle">{t('checkInTime')}</span>
              <span className="qdp-rowDesc">{t('checkInTimeHint')}</span>
            </div>
            <div className="qdp-rowControl">
              <CheckInTimeRow
                label={t('checkInTime')}
                value={checkInMinute}
                disabled={!anySignedIn}
                onPick={writeCheckInMinute}
              />
            </div>
          </div>
          {/*
            ── Daily check-in ──
            Above the failover block on purpose: check-in is a once-a-day
            housekeeping action, while the rows below change how a running
            conversation is served. Reading the card top to bottom should put
            the routine first and the routing policy second.
          */}
          {/*
            ── Failover and routing ──
            These rows write the host Config's own fields. They are omitted
            entirely on a settings face that does not carry them, because a
            control the host silently drops is worse than no control: the user
            would set a policy and only find out at the next failover that
            nothing recorded it.
          */}
          {settings.status === 'unavailable' ? null : (
            <>
              <div className="qdp-row">
                <div className="qdp-rowText">
                  <span className="qdp-rowTitle">{t('autoFailoverLabel')}</span>
                  <span className="qdp-rowDesc">{t('autoFailoverHint')}</span>
                </div>
                <div className="qdp-rowControl">
                  <QdpSwitch
                    checked={settings.autoFailoverEnabled}
                    label={t('autoFailoverLabel')}
                    disabled={!settingsReady}
                    onChange={next => { writeSetting('autoFailoverEnabled', next) }}
                  />
                </div>
              </div>
              <div className="qdp-row">
                <div className="qdp-rowText">
                  <span className="qdp-rowTitle">{t('queueWaitAttemptsLabel')}</span>
                  <span className="qdp-rowDesc">{t('queueWaitAttemptsHint')}</span>
                </div>
                <div className="qdp-rowControl">
                  <QdpNumberField
                    marker="queue-wait-attempts"
                    min={0}
                    max={QUEUE_WAIT_ATTEMPTS_MAX}
                    value={settings.queueWaitAttempts}
                    label={t('queueWaitAttemptsLabel')}
                    disabled={!settingsReady}
                    // 0 is meaningful — report the queue answer at once — so the
                    // bound is 0..MAX, never a truthiness check.
                    onCommit={attempts => { writeSetting('queueWaitAttempts', attempts) }}
                  />
                </div>
              </div>
              <div className="qdp-row">
                <div className="qdp-rowText">
                  <span className="qdp-rowTitle">{t('queueWaitSecondsLabel')}</span>
                  <span className="qdp-rowDesc">{t('queueWaitSecondsHint')}</span>
                </div>
                <div className="qdp-rowControl">
                  <QdpNumberField
                    marker="queue-wait-seconds"
                    min={QUEUE_WAIT_SECONDS_MIN}
                    max={QUEUE_WAIT_SECONDS_MAX}
                    value={settings.queueWaitSeconds}
                    label={t('queueWaitSecondsLabel')}
                    disabled={!settingsReady}
                    onCommit={seconds => { writeSetting('queueWaitSeconds', seconds) }}
                  />
                  <span className="qdp-caption">{t('queueWaitSecondsUnit')}</span>
                </div>
              </div>
              <div className="qdp-row">
                <div className="qdp-rowText">
                  <span className="qdp-rowTitle">{t('routingStrategyLabel')}</span>
                  <span className="qdp-rowDesc">{t('routingStrategyHint')}</span>
                </div>
                <div className="qdp-rowControl">
                  {/*
                    A select rather than the card's segmented control: that
                    control is a tablist, and the variant switcher has to stay
                    the card's only level of tabs. Routing strategy is a plain
                    settings choice, and a select says exactly that.
                  */}
                  <select
                    className="qdp-select"
                    value={routingStrategy}
                    disabled={!routingWritable || !settingsReady}
                    aria-label={t('routingStrategyLabel')}
                    onChange={event => {
                      chooseRoutingStrategy(event.target.value === 'custom' ? 'custom' : 'save-order')
                    }}
                  >
                    <option value="save-order">{t('routingStrategySaveOrder')}</option>
                    <option value="custom">{t('routingStrategyCustom')}</option>
                  </select>
                </div>
              </div>
              {/* The order list only exists for the custom strategy: on save
                  order the list IS the account list above, and showing a
                  second, uneditable copy of it would only invite the user to
                  try reordering something that cannot move. */}
              {routingStrategy !== 'custom' ? null : (
                <div className="qdp-row qdp-rowStack">
                  <div className="qdp-rowText">
                    <span className="qdp-rowTitle">{t('routingOrderHeading')}</span>
                    <span className="qdp-rowDesc">{t('routingOrderHint')}</span>
                  </div>
                  <RoutingOrderList
                    ids={routingOrderIds}
                    nameOf={routingNameOf}
                    variantOf={routingVariantOf}
                    accountOf={id => routing.accounts.find(entry => entry.id === id)}
                    disabled={!routingWritable || !settingsReady}
                    t={t}
                    onMove={moveRoutingAccount}
                  />
                </div>
              )}
              {routingMixed ? (
                <MixedRoutingWarning
                  offendersCN={routingOffenders.cn}
                  offendersGlobal={routingOffenders.global}
                  t={t}
                />
              ) : null}
              <div className="qdp-row">
                <div className="qdp-rowText">
                  <span className="qdp-rowTitle">{t('stickinessLabel')}</span>
                  <span className="qdp-rowDesc">{t('stickinessHint')}</span>
                </div>
                <div className="qdp-rowControl">
                  <QdpNumberField
                    marker="stickiness-rounds"
                    min={0}
                    max={STICKINESS_ROUNDS_MAX}
                    value={settings.stickinessRounds}
                    label={t('stickinessRoundsLabel')}
                    disabled={!settingsReady}
                    onCommit={rounds => { writeSetting('stickinessRounds', rounds) }}
                  />
                  <span className="qdp-caption">{t('stickinessRoundsLabel')}</span>
                  <QdpNumberField
                    marker="stickiness-requests"
                    min={0}
                    max={STICKINESS_REQUESTS_MAX}
                    value={settings.stickinessRequests}
                    label={t('stickinessRequestsLabel')}
                    disabled={!settingsReady}
                    onCommit={requests => { writeSetting('stickinessRequests', requests) }}
                  />
                  <span className="qdp-caption">{t('stickinessRequestsLabel')}</span>
                  <QdpNumberField
                    marker="stickiness-minutes"
                    min={0}
                    max={STICKINESS_MINUTES_MAX}
                    value={settings.stickinessMinutes}
                    label={t('stickinessMinutesLabel')}
                    disabled={!settingsReady}
                    onCommit={minutes => { writeSetting('stickinessMinutes', minutes) }}
                  />
                  <span className="qdp-caption">{t('stickinessMinutesLabel')}</span>
                </div>
              </div>
            </>
          )}
          {settings.status === 'ready' && !settings.writable ? (
            <p className="qdp-error">{t('quotaSettingsSaveFailed')}</p>
          ) : null}
        </div>
      </section>
    </div>
  )
}
