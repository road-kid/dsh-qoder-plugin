/**
 * Per-model reasoning-effort entry beside the Composer's model selector.
 *
 * Interaction follows the Fast Mode control `dsh-codex-connect` ships in this
 * same seat, which is the established shape for composer chrome here:
 *
 * - a **static inline label** next to the icon names the feature ("Reasoning
 *   levels"), set smaller and dimmer than the surrounding chrome so it reads as
 *   an annotation on the icon. It never carries state: the verified levels
 *   already appear in the model dropdown (the adapter exposes them as
 *   selectable efforts), so repeating them here would duplicate the real answer
 *   and make the label's width jump as results change.
 * - a **hover/focus tooltip** carries the state and the click's purpose, the way
 *   Fast Mode's tooltip explains its current speed.
 * - the **confirmation** is a small bubble anchored to the control, not a
 *   `window.confirm`. Probing spends real credit, so a confirmation stays — but
 *   it belongs next to the thing it acts on, sized to one line plus two small
 *   buttons.
 *
 * @module dsh-qoder-plugin/client/probe-control
 */

import { useCallback, useEffect, useId, useRef, useState, useSyncExternalStore } from 'react'
import type { ModelDirectory } from '@deepseek-ai/dsh-client-ui-model-selection/client'
import { QODER_CARD_VARIANTS, type QoderCardVariant, type QoderPluginCardInjected } from './QoderPluginCard.tsx'
import { QdpButton } from './controls.tsx'
import { isQoderWebStatus } from './status-document.ts'
import type { QoderWebProbeModel, QoderWebStatus } from '../status-paths.ts'

/** Injected props; `directory` resolves the session's current model selection. */
export interface QoderProbeControlProps extends QoderPluginCardInjected {
  directory: ModelDirectory['store']
}

/**
 * The card (and therefore the routes) a selected provider belongs to.
 *
 * The control serves both Qoder providers from one seat, so the provider id
 * is what selects the status and probe endpoints. Returning `undefined` for any
 * other provider is what keeps the icon off every non-Qoder model.
 */
export function cardVariantFor(provider: string): QoderCardVariant | undefined {
  return QODER_CARD_VARIANTS.find(card => card.id === provider)
}

/** How often the control re-checks state when the window regains focus. */
const RECONCILE_MS = 60_000


/*
 * All surface styling lives in quota-styles.ts (`qdp-probe*`): the seat's job
 * is the two-part shape — a compact pill button with a dim annotation label,
 * and one popover anchored above it. No inline colours, radii or font sizes
 * here; only the state-dependent `disabled` attribute and aria wiring.
 */

/**
 * The feature's static inline label. Deliberately not a state readout — see the
 * module comment.
 */
function useLabel(t: QoderPluginCardInjected['t']): string {
  return t('probeLabel')
}

/** Pick the model's recorded observation out of the probe section. */
function resultFor(status: QoderWebStatus, model: string): QoderWebProbeModel | undefined {
  if (status.status !== 'signed-in') return undefined
  return status.probe?.results.find(result => result.id === model)
}

/**
 * The one-line tooltip: current state first, then what a click does — the same
 * two-part shape Fast Mode uses.
 *
 * A recorded result outranks a remembered failure. `failed` only means "the last
 * run from this control did not complete"; the host can record a result for the
 * same model at any time (a detection started from the settings card, another
 * conversation, or a finished sweep), and the levels the user paid for are the
 * more useful answer than the stale failure. Failure copy is what remains when
 * there is no result to report.
 */
function tooltipText(
  t: QoderPluginCardInjected['t'],
  model: string,
  state: { busy: boolean; failed: boolean; result?: QoderWebProbeModel | undefined },
): string {
  if (state.busy) return t('probeRunning', { model })
  const result = state.result
  if (result !== undefined) {
    if (result.validation === 'validating' && result.efforts.length > 0) {
      return t('probeTooltipVerified', { levels: result.efforts.join(' / ') })
    }
    if (result.validation === 'non-validating') return t('probeTooltipNotValidating')
    return t('probeTooltipRetry')
  }
  if (state.failed) return t('probeTooltipRetry')
  return t('probeTooltipIdle', { model })
}

/** Model-independent shell: resolves the selection, then delegates per model. */
export function QoderProbeControl({ directory, t }: QoderProbeControlProps) {
  const subscribe = useCallback((listener: () => void) => directory.subscribe(listener), [directory])
  const snapshot = useCallback(() => directory.getSnapshot(), [directory])
  // `current` is `ModelSelection | null` (the directory contract), so the guard
  // must cover null too — `=== undefined` let a null selection through and the
  // `.provider` read crashed the seat on every load ("slot entry crashed in
  // 'conversation.input.right'").
  const selection = useSyncExternalStore(subscribe, snapshot, snapshot).current
  const card = selection == null ? undefined : cardVariantFor(selection.provider)
  // `card` identifies both the variant and its routes: a selection under either
  // provider resolves to exactly one card's status/probe pair, so the control
  // can never read one variant's state while probing the other.
  const key = card === undefined || selection == null ? undefined : `${card.id}:${selection.model}`
  // A new selection gets fresh state; a late response cannot target the new model.
  return card === undefined || selection == null || key === undefined
    ? null
    : <ModelProbe key={key} model={selection.model} card={card} label={useLabel(t)} t={t} />
}

function ModelProbe({ model, card, label, t }: {
  model: string
  card: QoderCardVariant
  label: string
} & QoderPluginCardInjected) {
  const [status, setStatus] = useState<QoderWebStatus>()
  const [busy, setBusy] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const [tooltipVisible, setTooltipVisible] = useState(false)
  const [failed, setFailed] = useState(false)
  // Only an explicit detection response opens a note. Background reads and
  // remounts never replay stored results; no persisted "seen" marks are needed.
  const [note, setNote] = useState<QoderWebProbeModel>()
  const inFlight = useRef(false)
  const mounted = useRef(false)
  const readSeq = useRef(0)
  const tooltipId = useId()

  const refresh = useCallback(async (signal?: AbortSignal) => {
    const seq = ++readSeq.current
    const response = await fetch(card.statusPath, {
      credentials: 'same-origin',
      headers: { accept: 'application/json' },
      ...(signal === undefined ? {} : { signal }),
    })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    /*
     * A 200 does not promise a status document: the body may be empty, literal
     * `null`, or a non-JSON page. Storing that unchecked would put a value in
     * state that `resultFor` dereferences on the next render, so it is validated
     * here with the same predicate the settings card uses. A rejection is left to
     * the callers below, which already degrade quietly.
     */
    const value: unknown = await response.json().catch(() => undefined)
    if (!isQoderWebStatus(value)) throw new Error(t('statusResponseInvalid'))
    if (mounted.current && !signal?.aborted && seq === readSeq.current) setStatus(value)
  }, [card.statusPath, t])

  useEffect(() => {
    mounted.current = true
    const controller = new AbortController()
    const load = (): void => {
      void refresh(controller.signal).catch(() => { /* the icon still works without state */ })
    }
    load()
    // Reconcile detections performed in another conversation or in the card.
    const timer = window.setInterval(load, RECONCILE_MS)
    window.addEventListener('focus', load)
    return () => {
      mounted.current = false
      controller.abort()
      window.clearInterval(timer)
      window.removeEventListener('focus', load)
    }
  }, [refresh])

  const probe = status?.status === 'signed-in' ? status.probe : undefined
  const key = status?.status === 'signed-in' ? status.probeKey : undefined
  const result = status === undefined ? undefined : resultFor(status, model)
  const eligible = probe?.candidates.includes(model) === true
  // Once a model has been detected it leaves the candidate list, so keep the
  // entry visible for it: that is the case the tooltip reports a result in.
  const visible = eligible || result !== undefined

  // A recorded result answers the question a remembered failure was about, so
  // the flag is dropped with it rather than lingering into the next render.
  useEffect(() => {
    if (result !== undefined) setFailed(false)
  }, [result])

  // A selection change must not strand an open bubble.
  useEffect(() => { setConfirming(false); setNote(undefined) }, [model])

  const detect = async (): Promise<void> => {
    if (key === undefined || inFlight.current || probe?.running === true) return
    inFlight.current = true
    setNote(undefined)
    setConfirming(false)
    setBusy(true)
    setFailed(false)
    try {
      const response = await fetch(card.probePath, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', 'X-Qoder-Probe-Key': key },
        body: JSON.stringify({ action: 'probe', model }),
      })
      const body = await response.json() as {
        state?: string; validation?: string; efforts?: unknown
      }
      if (!response.ok || body.state !== 'ok'
        || (body.validation !== 'validating' && body.validation !== 'non-validating')
        || !Array.isArray(body.efforts) || !body.efforts.every(effort => typeof effort === 'string')) {
        throw new Error('probe failed')
      }
      // This response belongs to the explicit click, even when the host reused
      // an older cached result. Do not wait for /status (which fetches credit),
      // or infer completion from wall-clock timestamps and background polls.
      if (mounted.current) {
        const completed: QoderWebProbeModel = {
          id: model, name: model, validation: body.validation,
          efforts: body.efforts, probedAt: Date.now(),
        }
        setNote(completed)
      }
      void refresh().catch(() => { /* Credit/status failure does not undo a completed probe. */ })
    } catch {
      if (mounted.current) setFailed(true)
    } finally {
      inFlight.current = false
      if (mounted.current) setBusy(false)
    }
  }

  if (!visible) return null

  const text = tooltipText(t, model, { busy, result, failed })
  const disabled = busy || probe?.running === true || key === undefined
  // Both bubbles and the tooltip anchor to the same spot above the control, so
  // only one may be open at a time. The confirmation and the result note both
  // suppress the tooltip: leaving it visible would overlap them, and the note
  // already states the same outcome the tooltip would.
  const showTooltip = tooltipVisible && !confirming && note === undefined

  return (
    <span
      className="qdp-probeWrap"
      onMouseEnter={() => { setTooltipVisible(true) }}
      onMouseLeave={() => { setTooltipVisible(false) }}
    >
      <button
        type="button"
        aria-label={text}
        aria-describedby={showTooltip ? tooltipId : undefined}
        aria-busy={busy}
        aria-expanded={confirming}
        disabled={disabled}
        onClick={() => { setConfirming(true) }}
        onFocus={() => { setTooltipVisible(true) }}
        onBlur={() => { setTooltipVisible(false) }}
        className="qdp-probe"
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"
          strokeWidth="1.6" aria-hidden="true" focusable="false">
          <circle cx="12" cy="12" r="9" />
          <circle cx="12" cy="12" r="4" />
          <path d="M12 12 20 4" />
          <circle cx="12" cy="12" r="1" />
        </svg>
        <span className="qdp-probeLabel">{label}</span>
      </button>

      {showTooltip && (
        <span id={tooltipId} role="tooltip" className="qdp-probeTip">{text}</span>
      )}

      {confirming && (
        <span className="qdp-probeBubble">
          <span>{t('probeBubbleBody')}</span>
          <span className="qdp-probeBubbleRow">
            <QdpButton onClick={() => { setConfirming(false) }}>
              {t('cancel')}
            </QdpButton>
            <QdpButton variant="primary" onClick={() => { void detect() }}>
              {t('probeConfirmAction')}
            </QdpButton>
          </span>
        </span>
      )}

      {note === undefined ? null : (
        <span role="status" aria-live="polite" className="qdp-probeNote">
          <span>{noteText(t, note)}</span>
          <QdpButton
            onClick={() => {
              setNote(undefined)
            }}
          >
            {t('probeNoteDismiss')}
          </QdpButton>
        </span>
      )}
    </span>
  )
}

/** Compose the one-line outcome string the note bubble shows. */
function noteText(t: QoderPluginCardInjected['t'], result: QoderWebProbeModel): string {
  if (result.validation === 'validating' && result.efforts.length > 0) {
    return t('probeNoteVerified', { levels: result.efforts.join(' / ') })
  }
  if (result.validation === 'non-validating') return t('probeNoteNotValidating')
  return t('probeNoteUnknown')
}
