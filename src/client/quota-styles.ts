/**
 * The plugin's single stylesheet (one global <style> injected once).
 *
 * Every value is a DSH 0.2.1 theme token: semantic `--dsw-alias-*` colours,
 * `--dsw-radius-*` role radii, composed `--dsw-font-*` typography roles and
 * `--dsw-elevation-*` for floating surfaces. No literal colours, no palette
 * copies, no theme selectors — the theme owns both light and dark. Neutral
 * hairline borders draw at 0.5px; state-coloured borders stay 1px; compact
 * capsules pair `corner-shape: round` with the 999px radius.
 *
 * Two surfaces share these classes:
 *   - the plugin page (`.qdp-page` → four `.qdp-card` sections), and
 *   - the composer quota readout chip + its anchored panel (`.qdp-chip`,
 *     `.qdp-pop`), which replaces the old sidebar cards and dashboard.
 *
 * Classes are `qdp-` prefixed: several plugins inject GLOBAL CSS into the same
 * document, so prefixes must not collide. The stylesheet is returned as a
 * string (no DOM side effects at import time), installed once by the client
 * entry keyed by `data-plugin-css`, and removed when the plugin's fiber
 * unwinds.
 */

/** Stylesheet id (the `data-plugin-css` value that makes injection idempotent). */
export const QUOTA_CSS_ID = 'dsh-qoder-plugin/QuotaPanel.module.css'

/** Install the stylesheet once; returns its disposer. */
export function injectQuotaCss(): () => void {
  if (typeof document === 'undefined') return () => {}
  if (document.querySelector(`style[data-plugin-css="${QUOTA_CSS_ID}"]`) !== null) return () => {}
  const tag = document.createElement('style')
  tag.dataset.plugin = 'dsh-qoder-plugin'
  tag.dataset.pluginCss = QUOTA_CSS_ID
  tag.textContent = QUOTA_CSS
  document.head.appendChild(tag)
  return () => {
    tag.remove()
  }
}

/** The quota + settings surfaces stylesheet. */
export const QUOTA_CSS = `
/* ------------------------------------------------------------------ base */

.qdp-page {
  box-sizing: border-box;
  display: grid;
  gap: 12px;
  font: var(--dsw-font-s-14);
  color: var(--dsw-alias-label-primary);
}
.qdp-page *,
.qdp-pop *,
.qdp-chip,
.qdp-pop {
  box-sizing: border-box;
}
.qdp-page :focus-visible,
.qdp-pop :focus-visible,
.qdp-chip:focus-visible,
.qdp-slider:focus-visible {
  outline: var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary));
  outline-offset: 2px;
}

/* ----------------------------------------------------------- page sections */

.qdp-card {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 16px;
  border: 0.5px solid var(--dsw-alias-settings-card-stroke);
  border-radius: var(--dsw-radius-xl);
  background: var(--dsw-alias-settings-card-fill);
}
.qdp-sectionHead {
  display: flex;
  align-items: center;
  gap: 12px;
  min-height: 28px;
  margin-bottom: 4px;
}
.qdp-sectionTitle {
  flex: 1 1 auto;
  min-width: 0;
  margin: 0;
  font: var(--dsw-font-xs-strong-13);
  color: var(--dsw-alias-label-secondary);
}
.qdp-sectionBody {
  display: flex;
  flex-direction: column;
  min-width: 0;
}
.qdp-row {
  display: flex;
  align-items: center;
  gap: 10px;
  min-height: 36px;
  padding: 10px 0;
}
.qdp-row + .qdp-row {
  border-top: 0.5px solid var(--dsw-alias-border-l2);
}
.qdp-rowText {
  display: flex;
  flex: 1 1 auto;
  flex-direction: column;
  gap: 1px;
  min-width: 0;
}
.qdp-rowTitle {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  font: var(--dsw-font-s-strong-14);
  color: var(--dsw-alias-label-primary);
}
.qdp-rowDesc {
  font: var(--dsw-font-xxs-12);
  color: var(--dsw-alias-label-tertiary);
}
.qdp-rowControl {
  display: flex;
  flex: 0 0 auto;
  align-items: center;
  gap: 6px;
}
.qdp-actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
}
/*
 * The account card's summary strip: remaining credit, check-in state, the
 * account in use, and the one-click check-in at the trailing edge.
 */
.qdp-accountSummary {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px 18px;
  padding: 10px 0;
  border-top: 0.5px solid var(--dsw-alias-border-l2);
}
.qdp-accountStat {
  display: flex;
  align-items: baseline;
  gap: 6px;
  min-width: 0;
}
.qdp-accountStatLabel {
  font: var(--dsw-font-xxxs-11, var(--dsw-font-xxs-12));
  color: var(--dsw-alias-label-tertiary);
  white-space: nowrap;
}
.qdp-accountStatValue {
  display: inline-flex;
  align-items: center;
  min-width: 0;
  font: var(--dsw-font-xxs-strong-12);
  color: var(--dsw-alias-label-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.qdp-accountActions {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-left: auto;
}
.qdp-metaRow {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px 8px;
  padding-top: 2px;
  font: var(--dsw-font-xxs-12);
  color: var(--dsw-alias-label-caption);
}
.qdp-caption {
  font: var(--dsw-font-xxs-12);
  color: var(--dsw-alias-label-tertiary);
}
.qdp-muted {
  color: var(--dsw-alias-label-tertiary);
}
.qdp-num {
  font: var(--dsw-font-xxs-strong-12);
  font-variant-numeric: tabular-nums;
  color: var(--dsw-alias-label-primary);
}
.qdp-stack {
  display: flex;
  flex-direction: column;
}
.qdp-inline {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
}
.qdp-spacer {
  flex: 1 1 auto;
}
.qdp-empty {
  padding: 12px 0;
  text-align: center;
  font: var(--dsw-font-xxs-12);
  color: var(--dsw-alias-label-tertiary);
}
.qdp-skeleton {
  border-radius: var(--dsw-radius-sm);
  background: var(--dsw-alias-bg-skeleton);
}
.qdp-link {
  color: var(--dsw-alias-link);
  font-weight: 500;
  text-decoration: none;
}
.qdp-link:hover {
  text-decoration: underline dotted;
  text-underline-offset: 3px;
}

/* ---------------------------------------------------------------- notices */

.qdp-body {
  font: var(--dsw-font-xxs-12);
  color: var(--dsw-alias-label-tertiary);
}
.qdp-error {
  font: var(--dsw-font-xxs-12);
  color: var(--dsw-alias-state-error-primary);
}
.qdp-alert {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  padding: 8px 10px;
  border-radius: var(--dsw-radius-sm);
  background: var(--dsw-alias-bg-layer-2);
  font: var(--dsw-font-xxs-12);
  color: var(--dsw-alias-label-secondary);
}
.qdp-alertError {
  border: 1px solid var(--dsw-alias-state-error-primary);
  background: transparent;
  color: var(--dsw-alias-state-error-primary);
}

/* ---------------------------------------------------------------- buttons */

/*
 * Geometry from the host's own Button (ui-primitives): sm 28px/R8, md 36px/R12,
 * no icon padding, hairline border. The DEFAULT button is the official
 * outline style (transparent on the card, 0.5px border-l3, primary label),
 * which is what the other plugin's white buttons are: a thin frame, never a
 * bare label floating on the card. The primary fill is the official filled CTA
 * — black in the light theme, white in the dark one, because it reads
 * --dsw-alias-button-primary-fill (= brand-primary), not a literal colour.
 */
.qdp-btn {
  display: inline-flex;
  flex: 0 0 auto;
  align-items: center;
  justify-content: center;
  gap: 4px;
  height: 28px;
  padding: 0 10px;
  border: 0.5px solid var(--dsw-alias-border-l3);
  border-radius: var(--dsw-radius-sm);
  background: transparent;
  color: var(--dsw-alias-label-primary);
  font: var(--dsw-font-xxs-strong-12);
  white-space: nowrap;
  cursor: pointer;
  transition: color .2s var(--ds-ease-in-out, ease), background-color .2s var(--ds-ease-in-out, ease);
}
.qdp-btn:hover:not(:disabled) {
  color: var(--dsw-alias-label-primary);
  background: var(--dsw-alias-interactive-bg-hover);
}
.qdp-btn:disabled {
  border-color: var(--dsw-alias-border-l2);
  background: transparent;
  color: var(--dsw-alias-label-tertiary);
  opacity: 0.5;
  cursor: default;
}
.qdp-btnMd {
  height: 36px;
  padding: 0 14px;
  border-radius: var(--dsw-radius-md);
  font: var(--dsw-font-s-strong-14);
}
.qdp-btnPrimary {
  border-color: transparent;
  background: var(--dsw-alias-button-primary-fill);
  color: var(--dsw-alias-label-primary-foreground);
}
.qdp-btnPrimary:hover:not(:disabled) {
  border-color: transparent;
  background: var(--dsw-alias-button-primary-hover);
  color: var(--dsw-alias-label-primary-foreground);
}
.qdp-btnPrimary:disabled {
  border-color: transparent;
  background: var(--dsw-alias-button-primary-fill);
  color: var(--dsw-alias-label-primary-foreground);
  opacity: 0.4;
}
/* The destructive confirm: the official danger fill (a red primary). */
.qdp-btnDanger {
  border-color: transparent;
  background: var(--dsw-alias-state-error-primary);
  color: var(--dsw-alias-label-primary-foreground);
}
.qdp-btnDanger:hover:not(:disabled) {
  border-color: transparent;
  background: var(--dsw-alias-state-error-primary);
  color: var(--dsw-alias-label-primary-foreground);
  opacity: 0.9;
}
/*
 * 删除: the official UNINSTALL button (PluginManagerPage's danger rule), minus its
 * trash icon: red ink on transparent, red border at 30% so it recedes until
 * hovered, red wash on hover. Deliberately not the danger FILL — an uninstall
 * does not shout until clicked, and neither does removing a PAT.
 */
.qdp-btnDangerQuiet {
  border-color: color-mix(in srgb, var(--dsw-alias-state-error-primary) 30%, transparent);
  background: transparent;
  color: var(--dsw-alias-state-error-primary);
}
.qdp-btnDangerQuiet:hover:not(:disabled) {
  background: color-mix(in srgb, var(--dsw-alias-state-error-primary) 8%, transparent);
  color: var(--dsw-alias-state-error-primary);
}
/* A deliberately frameless button; only for inline actions that already sit in
   a framed control group (e.g. a text-ish "cancel"). */
.qdp-btnGhost {
  border-color: transparent;
  background: transparent;
  color: var(--dsw-alias-label-secondary);
}
.qdp-btnGhost:hover:not(:disabled) {
  color: var(--dsw-alias-label-primary);
  background: var(--dsw-alias-interactive-bg-hover);
}
.qdp-iconButton {
  display: inline-flex;
  flex: 0 0 auto;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  padding: 0;
  border: 0;
  border-radius: var(--dsw-radius-sm);
  background: none;
  color: var(--dsw-alias-label-tertiary);
  cursor: pointer;
}
.qdp-iconButton:hover:not(:disabled) {
  background: var(--dsw-alias-interactive-bg-hover);
  color: var(--dsw-alias-label-primary);
}
.qdp-iconButton:disabled {
  opacity: 0.5;
  cursor: default;
}

/* ----------------------------------------------------------------- switch */

.qdp-switch {
  position: relative;
  flex: 0 0 auto;
  width: 36px;
  height: 20px;
  padding: 0;
  border: 0;
  border-radius: 999px;
  corner-shape: round;
  background: var(--dsw-alias-border-l3);
  cursor: pointer;
  transition: background-color .1s var(--ds-ease-in-out, ease);
}
.qdp-switch[aria-checked='true'] {
  background: var(--dsw-alias-brand-primary);
}
.qdp-switch:disabled {
  opacity: 0.5;
  cursor: default;
}
.qdp-switchThumb {
  position: absolute;
  top: 2px;
  left: 2px;
  width: 16px;
  height: 16px;
  border-radius: 50%;
  background: var(--dsw-alias-switch-thumb, var(--dsw-alias-bg-layer-1));
  transition: transform .1s var(--ds-ease-in-out, ease);
}
.qdp-switch[aria-checked='true'] .qdp-switchThumb {
  background: var(--dsw-alias-label-primary-foreground);
  transform: translateX(16px);
}

/* -------------------------------------------------------------- segmented */

.qdp-seg {
  display: inline-flex;
  flex: 0 0 auto;
  gap: 2px;
  padding: 4px;
  border-radius: var(--dsw-radius-md);
  background: var(--dsw-alias-interactive-bg-hover);
}
.qdp-segItem {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 28px;
  padding: 0 10px;
  border: 0;
  border-radius: var(--dsw-radius-sm);
  background: transparent;
  color: var(--dsw-alias-label-secondary);
  font: var(--dsw-font-xs-strong-13);
  white-space: nowrap;
  cursor: pointer;
}
.qdp-segItemActive {
  background: var(--dsw-alias-bg-layer-1);
  color: var(--dsw-alias-label-primary);
  box-shadow: var(--dsw-elevation-soft);
}
.qdp-segItem:disabled {
  opacity: 0.5;
  cursor: default;
}
/* Cell wrapper when an option carries a trailing control (the variant enable
   checkbox): the cell becomes the track's flex child so the tab inside keeps
   its own geometry, and the checkbox sits beside it without actuating it. */
.qdp-segCell {
  display: inline-flex;
  align-items: center;
  gap: 2px;
}
.qdp-segCheck {
  width: 14px;
  height: 14px;
  margin: 0 6px 0 0;
  accent-color: var(--dsw-alias-label-primary);
  cursor: pointer;
}
.qdp-segCheck:disabled {
  opacity: 0.4;
  cursor: default;
}

/* ------------------------------------------------------------------- dots */

.qdp-dot {
  flex: 0 0 auto;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--dsw-alias-state-idle-primary);
}
.qdp-dotDone {
  background: var(--dsw-alias-state-success-primary);
}
.qdp-dotOngoing {
  box-sizing: border-box;
  background: transparent;
  border: 1.5px solid var(--dsw-alias-state-business-primary);
  border-right-color: transparent;
  animation: qdp-spin .8s linear infinite;
}
.qdp-dotWarn {
  background: var(--dsw-alias-state-warn-primary);
}
.qdp-dotError {
  background: var(--dsw-alias-state-error-primary);
}
@keyframes qdp-spin {
  to {
    transform: rotate(360deg);
  }
}

/* ------------------------------------------------------------------- tags */

.qdp-tag {
  display: inline-flex;
  flex: 0 0 auto;
  align-items: center;
  height: 20px;
  padding: 0 8px;
  border-radius: 999px;
  corner-shape: round;
  background: var(--dsw-alias-bg-layer-2);
  color: var(--dsw-alias-label-secondary);
  font: var(--dsw-font-xxxs-strong-11);
  white-space: nowrap;
}
.qdp-tagSuccess {
  background: var(--dsw-alias-state-success-tertiary);
  color: var(--dsw-alias-state-success-primary);
}
.qdp-tagWarn {
  background: var(--dsw-alias-state-warn-tertiary);
  color: var(--dsw-alias-state-warn-label);
}
.qdp-tagError {
  background: var(--dsw-alias-interactive-bg-hover-danger);
  color: var(--dsw-alias-state-error-primary);
}

/* ------------------------------------------------------------------ input */

.qdp-input {
  box-sizing: border-box;
  display: inline-flex;
  align-items: center;
  height: 32px;
  min-width: 200px;
  padding: 0 8px;
  border: 0.5px solid var(--dsw-alias-border-l2);
  border-radius: var(--dsw-radius-md);
  background: var(--dsw-alias-bg-base);
  color: var(--dsw-alias-label-primary);
  font: var(--dsw-font-s-14);
  outline: none;
}
.qdp-input::placeholder {
  color: var(--dsw-alias-label-caption);
}
.qdp-input:hover:not(:disabled) {
  border-color: var(--dsw-alias-border-l3);
}
.qdp-input:focus {
  border-color: var(--dsw-alias-state-business-primary);
  box-shadow: 0 0 0 1px var(--dsw-alias-state-business-primary);
}
.qdp-input:disabled {
  opacity: 0.5;
  cursor: default;
}
.qdp-inputShort {
  min-width: 0;
  flex: 0 0 auto;
  width: 56px;
  padding: 0 8px;
  text-align: center;
  font-variant-numeric: tabular-nums;
}
.qdp-patInput {
  flex: 1 1 auto;
  min-width: 200px;
}

/* ---------------------------------------------------------------- sliders */

/* The official Qoder model-settings slider: a 56 px field, an 18 px rail on the
   vertical centre, a 2 × 12 px grab tick at the fill's edge and a 12 px label
   row hanging 40 px below the field's top. The rail is a soft neutral and the
   fill a 42 % brand tint, so the grab tick reads as the only strong mark. */
.qdp-slider {
  position: relative;
  width: 100%;
  max-width: 252px;
  height: 56px;
  border-radius: var(--dsw-radius-xs);
  cursor: pointer;
  touch-action: none;
  user-select: none;
}
.qdp-slider[aria-disabled='true'] {
  opacity: 0.55;
  cursor: default;
}
.qdp-sliderTrack {
  position: absolute;
  top: 50%;
  right: 0;
  left: 0;
  height: 18px;
  transform: translateY(-50%);
}
.qdp-sliderRail,
.qdp-sliderFill {
  position: absolute;
  top: 0;
  left: 0;
  height: 100%;
  border-radius: var(--dsw-radius-xs);
}
.qdp-sliderRail {
  background: var(--dsw-alias-interactive-bg-hover);
}
/* The chosen stretch is a quiet neutral, exactly like the upstream rail: the
   strong mark on the control is the grab tick, not a saturated fill. */
.qdp-sliderFill {
  background: var(--dsw-alias-border-l3);
}
.qdp-sliderThumb {
  position: absolute;
  top: 3px;
  width: 2px;
  height: 12px;
  border-radius: 1px;
  background: var(--dsw-alias-state-business-primary);
}

/* ----------------------------------------------------------------- models */

.qdp-modelScroll {
  max-height: 420px;
  /* Vertical scrolling only: a horizontal bar under the roster was pure noise,
     and the extra right padding keeps the scrollbar off the context slider. */
  overflow-x: hidden;
  overflow-y: auto;
  padding-right: 12px;
  overscroll-behavior: contain;
}
.qdp-modelColumns {
  position: sticky;
  top: 0;
  z-index: 1;
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) minmax(0, 1.15fr) 232px;
  gap: 12px;
  align-items: center;
  padding: 4px 0 4px;
  border-bottom: 0.5px solid var(--dsw-alias-border-l2);
  background: var(--dsw-alias-settings-card-fill);
  font: var(--dsw-font-xxxs-11);
  color: var(--dsw-alias-label-tertiary);
}
.qdp-modelRow {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) minmax(0, 1.15fr) 232px;
  gap: 12px;
  align-items: center;
  min-height: 44px;
  padding: 6px 0;
}
.qdp-modelRow + .qdp-modelRow {
  border-top: 0.5px solid var(--dsw-alias-border-l2);
}
.qdp-modelRow[aria-disabled='true'] {
  opacity: 0.55;
}
.qdp-modelEnable {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  cursor: pointer;
}
.qdp-modelEnable input {
  flex: 0 0 auto;
  width: 16px;
  height: 16px;
  margin: 0;
  accent-color: var(--dsw-alias-brand-primary);
}
.qdp-modelCopy {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px 8px;
  min-width: 0;
}
.qdp-modelName {
  font: var(--dsw-font-xs-strong-13);
  color: var(--dsw-alias-label-primary);
}
.qdp-modelMeta {
  font: var(--dsw-font-xxs-12);
  color: var(--dsw-alias-label-caption);
  font-variant-numeric: tabular-nums;
}
.qdp-modelRate {
  flex: 0 0 auto;
  font: var(--dsw-font-xxxs-11);
  color: var(--dsw-alias-label-caption);
  font-variant-numeric: tabular-nums;
}
/* The effort column: the tiers themselves, no "Efforts:" prefix — the column
   header says what they are. */
.qdp-modelEfforts {
  min-width: 0;
  font: var(--dsw-font-xxs-12);
  color: var(--dsw-alias-label-secondary);
  font-variant-numeric: tabular-nums;
  overflow-wrap: anywhere;
}
.qdp-modelAxis {
  min-width: 0;
}
.qdp-sliderField {
  position: relative;
  min-width: 0;
}
.qdp-windowTicks {
  position: absolute;
  top: 40px;
  right: 0;
  left: 0;
  height: 12px;
  pointer-events: none;
}
/* Hairline ruler under the rail: 33 marks across the field, every eighth one
   taller and a step darker, matching the official scale. */
.qdp-windowTickMark {
  position: absolute;
  top: 50%;
  width: 1px;
  height: 7px;
  border-radius: 999px;
  background: var(--dsw-alias-label-caption);
  transform: translate(-50%, -50%);
}
.qdp-windowTickMarkMajor {
  height: 10px;
  background: var(--dsw-alias-label-tertiary);
}
/* Tier labels sit on the field colour so the ruler passes behind them. */
.qdp-windowTick {
  position: absolute;
  top: 50%;
  padding: 0 4px;
  background: var(--dsw-alias-settings-card-fill);
  font: var(--dsw-font-xxxs-11);
  font-size: 9px;
  line-height: 12px;
  color: var(--dsw-alias-label-tertiary);
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}
/* The window in force is the only dark number: the other tiers are offers the
   user has not selected, so they keep the tertiary (grey) tone. */
.qdp-windowTickActive {
  color: var(--dsw-alias-label-primary);
  font-weight: 500;
}
/* A disabled slider greys every label, the active one included. */
.qdp-slider[aria-disabled='true'] .qdp-windowTick {
  color: var(--dsw-alias-label-caption);
}

/* --------------------------------------------------------------- save bar */

.qdp-saveBar {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-top: 10px;
  padding: 10px 0 0;
  border-top: 0.5px solid var(--dsw-alias-border-l2);
  background: var(--dsw-alias-settings-card-fill);
}
.qdp-saveBarText {
  flex: 1 1 auto;
  min-width: 0;
  font: var(--dsw-font-xxs-12);
  color: var(--dsw-alias-label-secondary);
}
.qdp-saveBarActions {
  display: flex;
  flex: 0 0 auto;
  align-items: center;
  gap: 6px;
}

/* ------------------------------------------------- chip + anchored panel */

.qdp-chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 24px;
  max-width: 220px;
  padding: 0 8px;
  border: 0;
  border-radius: 999px;
  corner-shape: round;
  background: transparent;
  color: var(--dsw-alias-label-secondary);
  font: var(--dsw-font-xxs-strong-12);
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
  cursor: pointer;
  transition: background-color .2s var(--ds-ease-in-out, ease), color .2s var(--ds-ease-in-out, ease);
}
.qdp-chip:hover,
.qdp-chip[aria-expanded='true'] {
  background: var(--dsw-alias-interactive-bg-hover);
  color: var(--dsw-alias-label-primary);
}
.qdp-chipName {
  overflow: hidden;
  max-width: 96px;
  text-overflow: ellipsis;
}
.qdp-chipValue {
  color: var(--dsw-alias-label-primary);
}

.qdp-pop {
  position: fixed;
  z-index: 60;
  width: 300px;
  padding: 12px;
  border: 0;
  border-radius: var(--dsw-radius-lg);
  background: var(--dsw-alias-bg-layer-1);
  box-shadow: var(--dsw-elevation-prominent);
  font: var(--dsw-font-s-14);
  color: var(--dsw-alias-label-primary);
}
.qdp-popHead {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 4px;
}
.qdp-popTitle {
  flex: 1 1 auto;
  min-width: 0;
  font: var(--dsw-font-s-strong-14);
  color: var(--dsw-alias-label-primary);
}
.qdp-popTime {
  font: var(--dsw-font-xxxs-11);
  color: var(--dsw-alias-label-tertiary);
  font-variant-numeric: tabular-nums;
}
.qdp-popList {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.qdp-popVariant {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 8px;
  border-radius: var(--dsw-radius-sm);
}
.qdp-popVariantActive {
  background: var(--dsw-alias-interactive-bg-hover);
}
.qdp-popVariantHead {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}
.qdp-popName {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font: var(--dsw-font-xs-strong-13);
  color: var(--dsw-alias-label-primary);
}
.qdp-popValue {
  flex: 0 0 auto;
  font: var(--dsw-font-xxs-strong-12);
  color: var(--dsw-alias-label-primary);
  font-variant-numeric: tabular-nums;
}
.qdp-popBar {
  position: relative;
  height: 5px;
  overflow: hidden;
  border-radius: 999px;
  corner-shape: round;
  background: var(--dsw-alias-interactive-bg-hover);
}
.qdp-popBarFill {
  height: 100%;
  border-radius: 999px;
  corner-shape: round;
  background: var(--dsw-alias-state-business-primary);
}
.qdp-popWarn {
  background: var(--dsw-alias-state-warn-primary);
}
.qdp-popCaption {
  font: var(--dsw-font-xxxs-11);
  color: var(--dsw-alias-label-tertiary);
  font-variant-numeric: tabular-nums;
}
.qdp-popFoot {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 8px;
  padding-top: 8px;
  border-top: 0.5px solid var(--dsw-alias-border-l2);
  font: var(--dsw-font-xxxs-11);
  color: var(--dsw-alias-label-caption);
}
.qdp-popRefresh {
  flex: 0 0 auto;
}

/* ----------------------------------------------------- context probe chip */

.qdp-probeWrap {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  min-width: 0;
}
.qdp-probe {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  height: 24px;
  padding: 0 6px;
  border: 0;
  border-radius: 999px;
  corner-shape: round;
  background: transparent;
  color: var(--dsw-alias-label-secondary);
  font: var(--dsw-font-xxs-strong-12);
  white-space: nowrap;
  cursor: pointer;
}
.qdp-probe:hover:not(:disabled) {
  background: var(--dsw-alias-interactive-bg-hover);
  color: var(--dsw-alias-label-primary);
}
.qdp-probe:disabled {
  opacity: 0.5;
  cursor: default;
}
.qdp-probeLabel {
  max-width: 120px;
  overflow: hidden;
  text-overflow: ellipsis;
}
.qdp-probeDot {
  flex: 0 0 auto;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--dsw-alias-state-idle-primary);
}
.qdp-probeDotOn {
  background: var(--dsw-alias-state-success-primary);
}
.qdp-probeDotWarn {
  background: var(--dsw-alias-state-warn-primary);
}
.qdp-probeDotError {
  background: var(--dsw-alias-state-error-primary);
}
.qdp-probeTip {
  position: fixed;
  z-index: 70;
  max-width: 240px;
  padding: 6px 8px;
  border-radius: var(--dsw-radius-sm);
  background: var(--dsw-alias-tooltip-bg, var(--dsw-alias-label-primary));
  color: var(--dsw-alias-label-primary-foreground);
  font: var(--dsw-font-xxxs-11);
  box-shadow: var(--dsw-elevation-soft);
  pointer-events: none;
}
.qdp-probeBubble {
  position: fixed;
  z-index: 70;
  width: 260px;
  padding: 12px;
  border: 0;
  border-radius: var(--dsw-radius-lg);
  background: var(--dsw-alias-bg-layer-1);
  box-shadow: var(--dsw-elevation-panel);
  font: var(--dsw-font-xxs-12);
  color: var(--dsw-alias-label-secondary);
}
.qdp-probeBubbleRow {
  display: flex;
  justify-content: flex-end;
  gap: 6px;
  margin-top: 10px;
}
.qdp-probeNote {
  position: fixed;
  z-index: 70;
  display: flex;
  align-items: center;
  gap: 8px;
  width: 260px;
  padding: 8px 10px;
  border-radius: var(--dsw-radius-sm);
  background: var(--dsw-alias-bg-layer-1);
  box-shadow: var(--dsw-elevation-panel);
  font: var(--dsw-font-xxs-12);
  color: var(--dsw-alias-label-secondary);
}
.qdp-glyph {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 16px;
  height: 16px;
  color: currentColor;
}

/* ------------------------------------------------------------- aesthetics */

@media (prefers-reduced-motion: reduce) {
  .qdp-btn,
  .qdp-switch,
  .qdp-switchThumb,
  .qdp-chip,
  .qdp-dotOngoing {
    transition: none;
    animation: none;
  }
}
`
