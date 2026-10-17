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
  QoderCredentialSource,
  QoderProbeAction,
  QoderVariantId,
  QoderWebCatalog,
  QoderWebStatus,
} from '../status-paths.ts'
import { isQoderWebStatus } from './status-document.ts'
import {
  QdpButton,
  QdpIconButton,
  QdpInput,
  QdpSegmented,
  QdpStateDot,
  QdpSwitch,
  QdpTag,
} from './controls.tsx'
import type { QdpDotState } from './controls.tsx'
import { ModelsPane, type ModelsDraft } from './ModelsPane.tsx'
import type { QoderSettingsKey } from './locales.ts'
import type { QuotaSection, QuotaSettingsScope } from './QuotaSettingsCard.tsx'
import {
  noteQuotaSignIn,
  noteQuotaStatus,
  onQuotaSettingsChange,
  quotaReadout,
  quotaSignInState,
  setQuotaReadout,
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
/**
 * Manual grants carry no upstream expiry; the campaign's own rule is 30 days
 * from the claim. Kept as one constant so a campaign-rule change is one edit.
 */
const MANUAL_GRANT_VALIDITY_MS = 30 * 24 * 60 * 60 * 1000
/** 10:00 UTC+8, the upstream campaign's reset moment (mirrors QuotaSettingsCard). */
const CHECK_IN_MINUTE_DEFAULT = 600
/** Default billing-endpoint poll period, in milliseconds (mirrors the settings face). */
const POLL_DEFAULT_MS = 300_000
/** The face clamps the poll interval at one minute. */
const POLL_MIN_MS = 60_000

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

/** One variant's automatic check-in settings, projected from the settings face. */
interface CheckInSettings {
  autoCN: boolean
  autoGlobal: boolean
  minuteCN: number
  minuteGlobal: number
  pollMs: number
  status: 'loading' | 'ready' | 'unavailable'
  writable: boolean
}

const UNAVAILABLE_SETTINGS: CheckInSettings = {
  autoCN: false,
  autoGlobal: false,
  minuteCN: CHECK_IN_MINUTE_DEFAULT,
  minuteGlobal: CHECK_IN_MINUTE_DEFAULT,
  pollMs: POLL_DEFAULT_MS,
  status: 'unavailable',
  writable: false,
}

/**
 * Read the check-in half of the settings face as a STABLE STRING.
 *
 * `useSyncExternalStore`'s getSnapshot must return the same reference between
 * renders unless the store changed. The face's value is a fresh object per
 * accepted document, so projecting it directly would re-render forever
 * (React #185); the JSON string below is stable by construction, and is parsed
 * back into the fields the card actually renders.
 *
 * The readout switches are deliberately NOT projected here: they are a
 * client-side preference (the shipped host's settings face rejects the field),
 * so they live in the shared store and are read directly by the advanced card.
 */
function settingsKeyOf(scope: QuotaSettingsScope<QuotaSection> | undefined): string {
  if (scope === undefined) return 'unavailable'
  const snapshot = scope.getSnapshot()
  const value = snapshot.value ?? {}
  return JSON.stringify([
    value.autoCheckInCN === true,
    value.autoCheckInGlobal === true,
    typeof value.checkInMinuteCN === 'number' ? value.checkInMinuteCN : CHECK_IN_MINUTE_DEFAULT,
    typeof value.checkInMinuteGlobal === 'number' ? value.checkInMinuteGlobal : CHECK_IN_MINUTE_DEFAULT,
    snapshot.status,
    snapshot.writable,
    typeof value.quotaPollMs === 'number' ? value.quotaPollMs : POLL_DEFAULT_MS,
  ])
}

function parseSettingsKey(raw: string): CheckInSettings {
  if (raw === 'unavailable') return UNAVAILABLE_SETTINGS
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed) || parsed.length < 6) return UNAVAILABLE_SETTINGS
    const autoCN = parsed[0] === true
    const autoGlobal = parsed[1] === true
    const minuteCN = typeof parsed[2] === 'number' ? parsed[2] : CHECK_IN_MINUTE_DEFAULT
    const minuteGlobal = typeof parsed[3] === 'number' ? parsed[3] : CHECK_IN_MINUTE_DEFAULT
    const status = parsed[4] === 'ready' || parsed[4] === 'loading' ? parsed[4] : 'unavailable'
    const pollMs = typeof parsed[6] === 'number' ? parsed[6] : POLL_DEFAULT_MS
    return {
      autoCN,
      autoGlobal,
      minuteCN,
      minuteGlobal,
      pollMs,
      status,
      writable: parsed[5] === true,
    }
  } catch {
    return UNAVAILABLE_SETTINGS
  }
}

/**
 * Render the Qoder account, check-in, model and advanced-settings sections as
 * the Plugins page's configuration page (or its one-liner, when the owner asks
 * for `summary`).
 *
 * On `page` this component renders the configuration BODY only: the Plugins
 * page draws the breadcrumb, icon, title, version and description, so no shell
 * chrome or second title lives here. The page is a grid of four cards:
 *
 * 1. 账号 — variant switcher, one compact status row, credential row, PAT entry
 * 2. 签到 — today's claim row + recent-grants row + a capped ledger list
 * 3. 模型 — catalogue provenance + refresh, then the models pane body
 * 4. 高级设置 — auto check-in, its UTC+8 time, quota-readout switches, poll interval
 *
 * A signed-out account renders 账号 (with the PAT entry) and 高级设置 only:
 * check-in and model preferences for an account nobody is signed into would be
 * settings the user cannot exercise yet.
 */
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
  /** The check-in half of the settings face, as a stable projection string. */
  const settingsSubscribe = useCallback((onStoreChange: () => void) => {
    return scope?.subscribe(onStoreChange) ?? (() => {})
  }, [scope])
  const settingsRaw = useSyncExternalStore(settingsSubscribe, () => settingsKeyOf(scope))
  const settings = parseSettingsKey(settingsRaw)

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
  /** 「删除 PAT」的内联确认：点一次进入确认，再点一次才真正清除。 */
  const [confirmingClear, setConfirmingClear] = useState(false)
  /** The model pane's batched save: its own busy flag, separate from a refresh. */
  const [savingModels, setSavingModels] = useState(false)
  const [modelsSaveError, setModelsSaveError] = useState<string>()
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
    setConfirmingClear(false)
    setCheckInNotice(undefined)
    setCheckInNotice(undefined)
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
     * `{state:'failed', reason}` — checking `response.ok` alone would treat
     * every failure as a success: no throw, no message, just the old model list
     * still on screen. The body is parsed the same way `manualCheckIn` parses
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
  const settingsVariant: 'cn' | 'global' = isUnified
    ? (activeVariantId === 'qoder' ? 'cn' : 'global')
    : (currentVariant.id === 'qoder' ? 'cn' : 'global')
  const signedInDoc = status?.status === 'signed-in' ? status : undefined
  const settingsSignedIn = reported !== undefined
    ? Boolean(reported[settingsVariant])
    : Boolean(liveSignIn[settingsVariant])
  const autoCheckInOn = settingsVariant === 'cn' ? settings.autoCN : settings.autoGlobal
  const checkInMinute = settingsVariant === 'cn' ? settings.minuteCN : settings.minuteGlobal
  const readoutEnabled = readout.enabled
  const readoutCN = readout.cn
  const readoutGlobal = readout.global
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
   * The automatic check-in controls write the same fields the advanced card
   * always wrote; a variant with no PAT cannot arm a timer it could never fire,
   * so the switch stays disabled until that variant signs in.
   */
  const writeAutoCheckIn = (next: boolean): void => {
    if (!settingsSignedIn) return
    writeSetting(settingsVariant === 'cn' ? 'autoCheckInCN' : 'autoCheckInGlobal', next)
  }
  const writeCheckInMinute = (minutes: number): void => {
    if (!settingsSignedIn) return
    writeSetting(settingsVariant === 'cn' ? 'checkInMinuteCN' : 'checkInMinuteGlobal', minutes)
  }
  /**
   * The three readout switches are NOT gated on sign-in: they describe what the
   * composer chip should show, and a user configuring the plugin before signing
   * in must still be able to hide a variant they never signed into. Only the
   * master switch gates the two variant switches.
   *
   * They write the shared STORE, not the settings scope: the shipped host's
   * settings face rejects `quotaReadoutEnabled` (HTTP 400 unknown field), and a
   * host restart is not available. `setQuotaReadout` bumps the store's revision
   * synchronously, so the card re-renders from the store; the master toggle
   * carries the two per-variant values through unchanged.
   */
  const writeReadoutEnabled = (next: boolean): void => {
    setQuotaReadout(next, readout.cn, readout.global)
  }
  const writeReadoutCN = (next: boolean): void => {
    // The switch carries `disabled` while the master is off; this guard makes a
    // programmatic click (tests, assistive tech) obey the same rule.
    if (!readout.enabled) return
    setQuotaReadout(readout.enabled, next, readout.global)
  }
  const writeReadoutGlobal = (next: boolean): void => {
    if (!readout.enabled) return
    setQuotaReadout(readout.enabled, readout.cn, next)
  }
  const writePollMinutes = (minutes: number): void => {
    writeSetting('quotaPollMs', Math.max(POLL_MIN_MS, minutes * 60_000))
  }

  // ── check-in card data ────────────────────────────────────────────────
  const checkIn = signedInDoc?.checkIn
  const now = Date.now()
  /**
   * Today's benefit is already in — whether this process granted it or merely
   * found the upstream reporting it as claimed.
   *
   * `already-claimed` must count: the upstream answers that way for every later
   * request on a claimed day, so treating only `claimed` as "done" re-armed the
   * button and invited the repeat click that appended a phantom ledger row. The
   * DATE must count too — `checkIn` is the persisted record, not a live reading,
   * and `today` is stamped host-side in UTC+8 (the day the scheduler uses), so a
   * `claimed` row from three days ago no longer disables today's button.
   */
  const claimedToday = checkIn !== undefined
    && checkIn.lastDate === checkIn.today
    && (checkIn.status === 'claimed' || checkIn.status === 'already-claimed')
  const effectiveExpiryOf = (entry: { timestamp: number; expiresAtMs?: number | undefined }): number =>
    entry.expiresAtMs ?? entry.timestamp + MANUAL_GRANT_VALIDITY_MS
  /*
   * Only grants that actually landed are listed. `already-claimed` is an
   * observation that the upstream had already granted today, not a grant: its
   * timestamp is that request's clock, not a payout moment (the upstream does
   * not report one), so counting it would invent a grant that never happened.
   */
  const claimedLogs = (checkIn?.logs ?? [])
    .filter(entry => entry.status === 'claimed')
    .sort((a, b) => b.timestamp - a.timestamp)
  const latestLog = claimedLogs[0]
  const latestExpiry = latestLog === undefined ? undefined : effectiveExpiryOf(latestLog)
  const ledgerExpiryText = latestLog === undefined
    ? t('ledgerEmpty')
    : latestExpiry === undefined
      ? ''
      : latestExpiry <= now
        ? t('ledgerExpired')
        : t('ledgerExpiresAt', { date: formatDate(latestExpiry) })
  const ledgerSummary = claimedLogs.length === 0
    ? t('ledgerEmpty')
    : `${t('ledgerCount', { count: claimedLogs.length })} · ${ledgerExpiryText}`
  const nextRunCaption = autoCheckInOn && checkIn?.nextRunAt !== undefined
    ? t('checkInNextRun', { time: formatTime(checkIn.nextRunAt) })
    : undefined
  const catalogCaption = signedInDoc === undefined ? undefined : catalogCaptionOf(signedInDoc.catalog, t)

  // ── account card data ─────────────────────────────────────────────────
  const credentialMeta = signedInDoc?.pat === undefined
    ? undefined
    : [
      patSourceText(signedInDoc.pat.source, t),
      signedInDoc.pat.savedAtMs === undefined ? null : t('patSavedAt', { time: formatTime(signedInDoc.pat.savedAtMs) }),
      signedInDoc.pat.patTail === undefined ? null : t('patTail', { tail: `****${signedInDoc.pat.patTail}` }),
    ].filter(part => part !== null).join(' · ')
  const signedOutStatus = status?.status === 'signed-out' ? status : undefined
  const patEntryOpen = replacing || signedOutStatus !== undefined

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
                },
                {
                  value: 'qoder-global',
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
          {signedInDoc?.pat === undefined || replacing ? null : (
            <div className="qdp-row">
              <div className="qdp-rowText">
                <span className="qdp-rowTitle">{t('patHeading')}</span>
                {credentialMeta === undefined ? null : <span className="qdp-rowDesc">{credentialMeta}</span>}
              </div>
              <div className="qdp-rowControl">
                <QdpButton variant="ghost" size="sm" disabled={busy || patBusy} onClick={() => { setReplacing(true) }}>
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
          {status?.status === 'error' ? (
            <div className="qdp-alert qdp-alertError" role="alert">{status.message}</div>
          ) : null}
        </div>
      </section>

      {/* ── 2. 签到: today's claim, recent grants, capped ledger list ── */}
      {signedInDoc === undefined ? null : (
        <section className="qdp-card">
          <div className="qdp-sectionHead">
            <h2 className="qdp-sectionTitle">{t('quotaSectionUsage')}</h2>
          </div>
          <div className="qdp-sectionBody">
            <div className="qdp-row">
              <div className="qdp-rowText">
                <span className="qdp-rowTitle">
                  <QdpStateDot state={claimedToday ? 'done' : 'idle'} />
                  <span>{t('checkInTodayTitle')}</span>
                </span>
                {nextRunCaption === undefined ? null : <span className="qdp-rowDesc">{nextRunCaption}</span>}
              </div>
              <div className="qdp-rowControl">
                {claimedToday ? (
                  <QdpTag tone="success">{t('checkInClaimedToday')}</QdpTag>
                ) : (
                  <QdpButton
                    variant="primary"
                    disabled={busy || checkingIn}
                    onClick={() => { void manualCheckIn() }}
                  >
                    {checkingIn ? t('checkInChecking') : t('checkInNow')}
                  </QdpButton>
                )}
              </div>
            </div>
            <div className="qdp-row">
              <div className="qdp-rowText">
                <span className="qdp-rowTitle">{t('ledgerHeading')}</span>
                <span className="qdp-rowDesc">{ledgerSummary}</span>
              </div>
              <div className="qdp-rowControl">
                <QdpButton
                  variant="ghost"
                  size="sm"
                  disabled={clearingLogs || claimedLogs.length === 0}
                  onClick={() => { void clearCheckInLogs() }}
                >
                  {clearingLogs ? t('checkInClearing') : t('checkInClear')}
                </QdpButton>
              </div>
            </div>
            {claimedLogs.length === 0 ? null : (
              <div className="qdp-logList">
                {claimedLogs.map(entry => {
                  const expiry = effectiveExpiryOf(entry)
                  const expired = expiry <= now
                  return (
                    <div key={entry.id} className="qdp-logRow">
                      <span className="qdp-muted">{formatTime(entry.timestamp)}</span>
                      <span className="qdp-num">{entry.amount === undefined ? '—' : `+${String(entry.amount)}`}</span>
                      <span className={expired ? 'qdp-error' : 'qdp-caption'}>
                        {expired ? t('ledgerExpired') : t('ledgerExpiresAt', { date: formatDate(expiry) })}
                      </span>
                    </div>
                  )
                })}
              </div>
            )}
            {checkInNotice === undefined ? null : <p className="qdp-body">{checkInNotice}</p>}
          </div>
        </section>
      )}

      {/* ── 3. 模型: provenance + refresh in the head, the pane body below ── */}
      {signedInDoc === undefined ? null : (
        <section className="qdp-card">
          <div className="qdp-sectionHead">
            <h2 className="qdp-sectionTitle">{t('paneModels')}</h2>
            {catalogCaption === undefined ? null : <span className="qdp-caption">{catalogCaption}</span>}
            <QdpButton
              variant="ghost"
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

      {/* ── 4. 高级设置: auto check-in + time, readout switches, poll interval ── */}
      <section className="qdp-card">
        <div className="qdp-sectionHead">
          <h2 className="qdp-sectionTitle">{t('quotaSectionAdvanced')}</h2>
        </div>
        <div className="qdp-sectionBody">
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
              <span className="qdp-rowTitle">
                {settingsVariant === 'cn' ? t('checkInTimeCN') : t('checkInTimeGlobal')}
              </span>
              <span className="qdp-rowDesc">{t('checkInTimeHint')}</span>
            </div>
            <div className="qdp-rowControl">
              <CheckInTimeRow
                label={settingsVariant === 'cn' ? t('checkInTimeCN') : t('checkInTimeGlobal')}
                value={checkInMinute}
                disabled={!settingsSignedIn || !autoCheckInOn}
                onPick={writeCheckInMinute}
              />
            </div>
          </div>
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
          <div className="qdp-row">
            <div className="qdp-rowText">
              <span className="qdp-rowTitle">{t('quotaReadoutCNLabel')}</span>
              <span className="qdp-rowDesc">{t('quotaReadoutCNDesc')}</span>
            </div>
            <div className="qdp-rowControl">
              <QdpSwitch
                checked={readoutCN}
                disabled={!readoutEnabled}
                label={t('quotaReadoutCNLabel')}
                onChange={writeReadoutCN}
              />
            </div>
          </div>
          <div className="qdp-row">
            <div className="qdp-rowText">
              <span className="qdp-rowTitle">{t('quotaReadoutGlobalLabel')}</span>
              <span className="qdp-rowDesc">{t('quotaReadoutGlobalDesc')}</span>
            </div>
            <div className="qdp-rowControl">
              <QdpSwitch
                checked={readoutGlobal}
                disabled={!readoutEnabled}
                label={t('quotaReadoutGlobalLabel')}
                onChange={writeReadoutGlobal}
              />
            </div>
          </div>
          {settings.status === 'unavailable' ? null : (
            <div className="qdp-row">
              <div className="qdp-rowText">
                <span className="qdp-rowTitle">{t('quotaPollLabel')}</span>
                <span className="qdp-rowDesc">{t('quotaPollHint')}</span>
              </div>
              <div className="qdp-rowControl">
                <QdpInput
                  className="qdp-inputShort"
                  type="number"
                  min={1}
                  step={1}
                  value={pollMinutes}
                  aria-label={t('quotaPollLabel')}
                  onChange={event => {
                    const minutes = Number.parseInt(event.target.value, 10)
                    if (Number.isFinite(minutes) && minutes >= 1) writePollMinutes(minutes)
                  }}
                />
                <span className="qdp-caption">{t('quotaPollUnit')}</span>
              </div>
            </div>
          )}
          {settings.status === 'ready' && !settings.writable ? (
            <p className="qdp-error">{t('quotaSettingsSaveFailed')}</p>
          ) : null}
        </div>
      </section>
    </div>
  )
}
