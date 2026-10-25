/**
 * 「模型」 pane: per-model visibility and context-window preferences.
 *
 * The pane never writes. Every checkbox and slider mutates a local draft, a
 * sticky save bar appears once that draft differs from the props, and only its
 * 「保存设置」 button hands the whole change set to `onSave` so the page can
 * batch the individual network writes behind one click. The draft re-bases from
 * the props whenever their signature changes (a refreshed catalogue, a new
 * disabled set, or the applied result of a previous save), which is also why
 * there is no explicit reset signal in the props.
 *
 * The row is three grid columns — checkbox, copy, axis — so the sliders line up
 * across rows. The axes are independent controls but share one absolute token
 * scale (the same min/max for every row), so 200K sits in the same column
 * everywhere and windows are comparable at a glance.
 *
 * Catalogue provenance and the refresh control live in the page's section head,
 * not here; `catalog`, `busy` and `onRefreshModels` stay on the props so the
 * page writer can keep passing the state it already owns.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { QoderCatalogModelSnapshot, QoderWebCatalog } from '../status-paths.ts'
import type { QoderPluginCardInjected } from './QoderPluginCard.tsx'
import { QdpButton, QdpSlider, QdpTag } from './controls.tsx'

/**
 * One staged edit, applied by a single save: the full disabled-id set plus the
 * window overrides (only models whose window differs from the catalogue).
 */
export interface ModelsDraft {
  disabled: string[]
  windows: Record<string, number>
}

export interface ModelsPaneProps {
  models: readonly QoderCatalogModelSnapshot[] | undefined
  disabledModels?: readonly string[] | undefined
  /**
   * Accepted for call-site compatibility, not rendered: the section head owns
   * the catalogue provenance line.
   */
  catalog?: QoderWebCatalog | undefined
  t: QoderPluginCardInjected['t']
  /** Accepted for call-site compatibility, not rendered (see `catalog`). */
  busy?: boolean | undefined
  saving?: boolean | undefined
  saveError?: string | undefined
  onSave: (draft: ModelsDraft) => void
  /** Accepted for call-site compatibility, not rendered (see `catalog`). */
  onRefreshModels: () => void
}

/*
 * Display order IS upstream order.
 *
 * The catalogue arrives in the same order the official Qoder GUI lists models
 * (the discovery answer preserves it end to end: upstream payload →
 * `normalizeQoderModels` → catalog store → status document), and that order is
 * what users match against the official app — Auto first, then the product
 * families. No local re-sort: any sort here would detach the pane from the GUI
 * the user is comparing against, and would also reshuffle rows whenever the
 * upstream introduces a model this file never heard of.
 */
function orderModels(models: readonly QoderCatalogModelSnapshot[] | undefined): QoderCatalogModelSnapshot[] {
  return [...(models ?? [])]
}

/** Current/preferred window from the catalogue; an override already replaced `contextWindow`. */
function baselineWindow(model: QoderCatalogModelSnapshot): number | undefined {
  const value = model.contextWindow ?? model.defaultContextWindow
  return value !== undefined && Number.isFinite(value) && value > 0 ? value : undefined
}

/** Upstream-declared windows, deduped, positive and ascending; `[]` when none are known. */
function declaredWindows(model: QoderCatalogModelSnapshot): number[] {
  const current = baselineWindow(model)
  const source = model.supportedContextWindows ?? (current === undefined ? [] : [current])
  return [...new Set(source)].filter(value => Number.isFinite(value) && value > 0).sort((a, b) => a - b)
}

/** The value a row shows before the draft touches it (declared first window as fallback). */
function rowWindow(model: QoderCatalogModelSnapshot): number | undefined {
  return baselineWindow(model) ?? declaredWindows(model)[0]
}

/** Same notation as the card's token labels: 200K / 400K / 1M, bare number otherwise. */
function formatTokens(tokens: number): string {
  if (tokens >= 1_000_000 && tokens % 1_000_000 === 0) return `${tokens / 1_000_000}M`
  if (tokens >= 1_000 && tokens % 1_000 === 0) return `${tokens / 1_000}K`
  return String(tokens)
}

function formatRate(factor: number): string {
  return `${factor.toFixed(1)}x`
}

/**
 * The reasoning-effort tag's text: the levels the model can reason at, plus the
 * upstream default.
 *
 * The tag speaks the upstream's English wire vocabulary (`low`, `high`,
 * `xhigh`, `max`, …) in every UI language — the words are model parameters, and
 * the official Qoder app lists them untranslated. A model that advertises no
 * selectable effort says so instead of drawing an empty tag.
 */
function effortsTagText(
  model: QoderCatalogModelSnapshot,
  t: QoderPluginCardInjected['t'],
): string {
  const efforts = (model.reasoningEfforts ?? []).filter(id => id !== '')
  if (efforts.length === 0) return t('effortsUnsupported')
  const nameOf = (id: string): string =>
    id === 'low' ? t('effortLow')
      : id === 'medium' ? t('effortMedium')
        : id === 'high' ? t('effortHigh')
          : id === 'xhigh' ? t('effortXhigh')
            : id === 'max' ? t('effortMax')
              : id === 'minimal' ? t('effortMinimal')
                : id
  const levels = efforts.map(nameOf).join(' · ')
  const fallback = model.defaultReasoningEffort !== undefined && efforts.includes(model.defaultReasoningEffort)
    ? ` (${t('modelEffortsDefault', { name: nameOf(model.defaultReasoningEffort) })})`
    : ''
  return levels + fallback
}

/** Round an axis end up to a clean K/M boundary so tick labels stay readable. */
function roundUpAxis(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 1_000_000
  const unit = value >= 1_000_000 ? 1_000_000 : value >= 1_000 ? 1_000 : 1
  return Math.ceil(value / unit) * unit
}

/** Global right end of every row's axis: the widest declared/default window, rounded up. */
function axisMaximum(list: readonly QoderCatalogModelSnapshot[]): number {
  return roundUpAxis(
    list.reduce((best, model) => {
      const declared = declaredWindows(model)
      const rowMax = declared.length > 0 ? declared[declared.length - 1] : rowWindow(model)
      return rowMax !== undefined && rowMax > best ? rowMax : best
    }, 0),
  )
}

/** Global left end of every row's axis: the narrowest window any model declares. */
function minimumWindow(list: readonly QoderCatalogModelSnapshot[], axisMax: number): number {
  const lowest = list.reduce((best, model) => {
    const candidate = declaredWindows(model)[0] ?? baselineWindow(model)
    return candidate !== undefined && candidate > 0 && candidate < best ? candidate : best
  }, Number.POSITIVE_INFINITY)
  if (!Number.isFinite(lowest) || lowest <= 0) return Math.min(1_000, axisMax)
  return Math.min(lowest, axisMax)
}

const clampWindow = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value))

const uniqueSorted = (ids: readonly string[]): string[] => [...new Set(ids)].sort((a, b) => a.localeCompare(b))

/**
 * The windows this row offers as tiers, clipped to the shared axis.
 *
 * These are exactly the values the slider lands on and the marks it draws; the
 * shared axis ENDS are deliberately not added. On a row whose narrowest offer
 * sits close to the global minimum (the international roster's Performance
 * offers 272K while the shared minimum is 200K) the extra minimum label
 * overlapped the row's own first label. The scale is still shared, so a 400K on
 * one row keeps lining up with a 400K on the next.
 */
function rowTiers(model: QoderCatalogModelSnapshot, min: number, max: number): number[] {
  return declaredWindows(model).filter(value => value >= min && value <= max)
}

/**
 * Signature of everything the draft is based on. When it changes the draft is
 * discarded and re-seeded from the props: a model appearing/disappearing, its
 * upstream window/price changing, or the persisted disabled set changing (e.g.
 * the request that a save triggered has landed).
 */
function modelSignature(list: readonly QoderCatalogModelSnapshot[], disabled: readonly string[]): string {
  return JSON.stringify({
    models: list.map(model => [
      model.id,
      model.name,
      model.contextWindow ?? null,
      model.defaultContextWindow ?? null,
      model.supportedContextWindows === undefined ? null : [...model.supportedContextWindows],
      model.priceFactor ?? null,
      model.reasoningEfforts === undefined ? null : [...model.reasoningEfforts],
      model.defaultReasoningEffort ?? null,
    ]),
    disabled: [...disabled],
  })
}

export function ModelsPane({
  models,
  disabledModels = [],
  t,
  saving = false,
  saveError,
  onSave,
}: ModelsPaneProps): ReactNode {
  const list = orderModels(models)
  const baselineDisabled = uniqueSorted(disabledModels)
  const signature = modelSignature(list, baselineDisabled)
  const [draft, setDraft] = useState<ModelsDraft>(() => ({ disabled: uniqueSorted(disabledModels), windows: {} }))
  const signatureRef = useRef(signature)

  useEffect(() => {
    if (signatureRef.current === signature) return
    signatureRef.current = signature
    setDraft({ disabled: uniqueSorted(disabledModels), windows: {} })
  }, [signature, disabledModels])

  const axisMax = axisMaximum(list)
  const minWindow = minimumWindow(list, axisMax)
  const byId = new Map(list.map(model => [model.id, model]))

  /*
   * The saved payload is a diff, not a snapshot: only models whose window
   * differs from the catalogue are sent, so the page can write exactly those
   * and leave the untouched rows alone. A window dragged back to its baseline
   * drops out of the draft entirely (see `changeWindow`).
   */
  const windowDiff: Record<string, number> = {}
  for (const [id, value] of Object.entries(draft.windows)) {
    const model = byId.get(id)
    if (model === undefined) continue
    if (rowWindow(model) !== value) windowDiff[id] = value
  }
  const disabledAdded = draft.disabled.filter(id => !baselineDisabled.includes(id)).length
  const disabledRemoved = baselineDisabled.filter(id => !draft.disabled.includes(id)).length
  const changeCount = disabledAdded + disabledRemoved + Object.keys(windowDiff).length
  const dirty = changeCount > 0
  const controlsDisabled = saving

  const toggleModel = (id: string, enabled: boolean): void => {
    setDraft(current => {
      const disabled = new Set(current.disabled)
      if (enabled) disabled.delete(id)
      else disabled.add(id)
      return { disabled: [...disabled].sort((a, b) => a.localeCompare(b)), windows: current.windows }
    })
  }

  const changeWindow = (model: QoderCatalogModelSnapshot, value: number): void => {
    const base = rowWindow(model)
    setDraft(current => {
      const windows: Record<string, number> = { ...current.windows }
      if (base !== undefined && base === value) delete windows[model.id]
      else windows[model.id] = value
      return { disabled: current.disabled, windows }
    })
  }

  const resetDraft = (): void => {
    setDraft({ disabled: [...baselineDisabled], windows: {} })
  }

  const saveDraft = (): void => {
    onSave({ disabled: [...draft.disabled], windows: { ...windowDiff } })
  }

  return (
    <div className="qdp-stack">
      {list.length === 0 ? (
        <p className="qdp-empty">{t('modelsNoModels')}</p>
      ) : (
        /* A bounded scroll region keeps a long roster from pushing the section
           head off screen. The column header is sticky inside it so the columns
           stay labelled while the rows scroll; the save bar and the empty state
           stay outside it. */
        <div className="qdp-modelScroll">
          {/* One column header for the whole list; the first column (checkbox)
              has no title, so the empty span keeps the grid aligned. */}
          <div className="qdp-modelColumns">
            <span aria-hidden="true" />
            <span>{t('modelNameColumn')}</span>
            <span>{t('effortsHeading')}</span>
            <span>{t('contextHeading')}</span>
          </div>
          {list.map(model => {
            const inputId = `qdp-model-${model.id}` // model ids are unique
            const enabled = !draft.disabled.includes(model.id)
            const baseline = rowWindow(model)
            const staged = draft.windows[model.id]
            const value = staged ?? baseline
            const current = value === undefined ? undefined : clampWindow(value, minWindow, axisMax)
            const effortsText = effortsTagText(model, t)
            const tiers = rowTiers(model, minWindow, axisMax)
            return (
              <div
                key={model.id}
                className="qdp-modelRow"
                data-model-id={model.id}
                aria-disabled={enabled ? undefined : true}
              >
                <label className="qdp-modelEnable">
                  <input
                    id={inputId}
                    type="checkbox"
                    checked={enabled}
                    disabled={controlsDisabled}
                    aria-label={model.name}
                    onChange={event => toggleModel(model.id, event.currentTarget.checked)}
                  />
                </label>
                <span className="qdp-modelCopy">
                  {/* Clicking the name toggles the same checkbox as the box itself. */}
                  <label htmlFor={inputId}>
                    <span className="qdp-modelName">{model.name}</span>
                  </label>
                  {/* Points multiplier straight from the upstream; nothing is
                      invented when it is unknown (a guessed 1x would claim the
                      model is baseline-priced). */}
                  {model.priceFactor === undefined ? null : <QdpTag>{formatRate(model.priceFactor)}</QdpTag>}
                  {/* Wire id, right where the upstream GUI shows it. */}
                  <span className="qdp-modelMeta">{model.id}</span>
                </span>
                {/* The effort levels the model can reason at, under the column
                    header; the upstream default is called out and a model with
                    no selectable effort says so. The wire vocabulary stays
                    English in every UI language, like the official GUI. */}
                <span className="qdp-modelEfforts">{effortsText}</span>
                <div className="qdp-modelAxis">
                  {current === undefined ? (
                    <span className="qdp-modelMeta">—</span>
                  ) : (
                    /* One slide, one offered size: a pointer move lands on the
                       neighbouring tier instead of an interpolated window, and
                       the label of the tier in force is the dark one. A row
                       whose catalogue offers a single window still draws the
                       rail — the official GUI does, and the lone tier anchors
                       the drag, so no interpolated size can be staged. */
                    <QdpSlider
                      label={t('contextWindowAria')}
                      value={current}
                      min={minWindow}
                      max={axisMax}
                      step={1000}
                      disabled={controlsDisabled}
                      onChange={next => changeWindow(model, next)}
                      valueText={formatTokens(current)}
                      snapTo={tiers}
                      ticks={tiers}
                      format={formatTokens}
                      testId={`qdp-window-${model.id}`}
                    />
                  )}
                </div>
              </div>
            )
          })}
        </div>
      )}
      {dirty || saveError !== undefined ? (
        <div className="qdp-saveBar" data-testid="qdp-models-savebar">
          <div className="qdp-saveBarText">
            {changeCount > 0 ? (
              <>
                <span className="qdp-num">{t('modelsUnsavedCount', { count: changeCount })}</span>{' '}
                <span className="qdp-muted">{t('modelsBatchSaveHint')}</span>
              </>
            ) : null}
            {saveError === undefined ? null : (
              <div className="qdp-alert qdp-alertError" role="alert">
                {t('modelsSaveFailed', { message: saveError })}
              </div>
            )}
          </div>
          <div className="qdp-saveBarActions">
            {/* The dismissive action is borderless: the strip carries one
                control that commits, and a hairline next to it would read as a
                second, equally weighted decision. */}
            <QdpButton
              data-testid="qdp-models-cancel"
              variant="ghost"
              disabled={saving}
              onClick={resetDraft}
            >
              {t('cancelChanges')}
            </QdpButton>
            <QdpButton
              data-testid="qdp-models-save"
              variant="primary"
              disabled={saving}
              onClick={saveDraft}
            >
              {saving ? t('savingChanges') : t('saveChanges')}
            </QdpButton>
          </div>
        </div>
      ) : null}
    </div>
  )
}
