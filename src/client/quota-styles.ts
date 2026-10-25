/**
 * The plugin's single stylesheet (one global <style> injected once).
 *
 * Every value is a DSH 0.2.1 theme token: semantic `--dsw-alias-*` colours,
 * `--dsw-radius-*` role radii, composed `--dsw-font-*` typography roles and
 * `--dsw-elevation-*` for floating surfaces. No literal colours, no palette
 * copies, no theme selectors — the theme owns both light and dark. Neutral
 * hairline borders draw at 0.5px; state-coloured borders stay 1px; compact
 * capsules pair `corner-shape: round` with the 999px radius, and every true
 * circle (dots, the switch knob) pairs it with 50% — the theme's global
 * superellipse otherwise deforms both into squircles.
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
/*
 * A row that only exists because the master switch above it is on.
 *
 * Indented so the hierarchy is visible without a second heading: the switch
 * says what the group is, and these rows are the group's contents. The indent
 * is the ONLY difference from a normal row — an extra rule down the left edge
 * was tried and removed: the card already separates rows with a hairline, so a
 * second vertical border turned a quiet sub-menu into a boxed panel.
 */
.qdp-subRow {
  padding-left: 16px;
}

/*
 * A heading for a group inside a card (the device codes), one level below the
 * card's own title. The rule above it is what separates it from the rows it
 * follows without opening a second card for three lines of content.
 */
.qdp-subHeading {
  margin: 12px 0 0;
  padding-top: 12px;
  border-top: 0.5px solid var(--dsw-alias-settings-card-stroke);
  font: var(--dsw-font-xs-strong-13);
  color: var(--dsw-alias-label-secondary);
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
/*
 * The saved-account pool: one row per stored PAT, in failover order.
 *
 * Rows are a list rather than a table: the facts are a variable-width sentence
 * (source · saved · tail) and the only per-row choice is which one signs, so a
 * grid would add alignment rules that carry no information.
 */
.qdp-accountPool {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 10px 0;
  border-top: 0.5px solid var(--dsw-alias-border-l2);
}
.qdp-accountList {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin: 0;
  padding: 0;
  list-style: none;
}
.qdp-accountItem {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px 12px;
  padding: 6px 8px;
  border: 0.5px solid var(--dsw-alias-border-l2);
  border-radius: var(--dsw-radius-sm);
}
.qdp-accountItemInfo {
  display: flex;
  flex: 1 1 auto;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}
.qdp-accountItemName {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  min-width: 0;
  font: var(--dsw-font-xxs-strong-12);
  color: var(--dsw-alias-label-primary);
}
/*
 * The seat's balance, inline after its name.
 *
 * Same line as the name on purpose: the account list is scanned to answer
 * "which seat still has credits", and a figure on its own line below the name
 * made every row two glances tall. Quieter than the name so the name stays the
 * row's identity.
 */
.qdp-accountItemCredits {
  font: var(--dsw-font-xxxs-11, var(--dsw-font-xxs-12));
  color: var(--dsw-alias-label-secondary);
  font-variant-numeric: tabular-nums;
}
.qdp-accountItemMeta {
  font: var(--dsw-font-xxxs-11, var(--dsw-font-xxs-12));
  color: var(--dsw-alias-label-tertiary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
/* The inline remove confirmation belongs to its row, not to the whole card. */
.qdp-accountItemConfirm {
  flex: 1 1 100%;
  margin: 0;
}
/*
 * The park checkbox, before the row's facts.
 *
 * It carries no visible label of its own: the aria label names it for
 * assistive tech, and the 「已停用」 tag beside the account name is what tells a
 * sighted user which way the box is set — a second label would only repeat it.
 */
.qdp-accountCheck {
  display: flex;
  flex: 0 0 auto;
  align-items: center;
  padding: 2px;
  cursor: pointer;
}
.qdp-accountCheck input {
  width: 14px;
  height: 14px;
  margin: 0;
  cursor: inherit;
}
/* A parked seat keeps its row — it is still saved and still switchable — but
   it no longer takes part in the walk, and it has to look that way. */
.qdp-accountItem.is-off .qdp-accountItemInfo {
  opacity: 0.6;
}
.qdp-accountItemFacts {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  font: var(--dsw-font-xxxs-11, var(--dsw-font-xxs-12));
  color: var(--dsw-alias-label-secondary);
}
/*
 * The custom routing order: a numbered priority list.
 *
 * It is deliberately NOT the account list repeated. The number in the gutter is
 * the priority the failover walk uses, and it is the only thing this list says
 * that the account list above does not.
 */
.qdp-rowStack {
  flex-direction: column;
  align-items: stretch;
}
.qdp-routingList {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin: 0;
  padding: 0;
  list-style: none;
  counter-reset: qdp-routing;
}
.qdp-routingItem {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 8px;
  border: 0.5px solid var(--dsw-alias-border-l2);
  border-radius: var(--dsw-radius-sm);
}
.qdp-routingItem::before {
  counter-increment: qdp-routing;
  content: counter(qdp-routing);
  min-width: 14px;
  font: var(--dsw-font-xxs-strong-12);
  color: var(--dsw-alias-label-tertiary);
}
.qdp-routingWho {
  display: flex;
  flex: 1 1 auto;
  align-items: center;
  gap: 8px;
  min-width: 0;
}
.qdp-routingName {
  flex: 0 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font: var(--dsw-font-xxs-12);
  color: var(--dsw-alias-label-primary);
}
.qdp-routingCredits {
  flex: 0 0 auto;
  font: var(--dsw-font-xxxs-11, var(--dsw-font-xxs-12));
  color: var(--dsw-alias-label-secondary);
  font-variant-numeric: tabular-nums;
}
.qdp-routingItemActions {
  display: flex;
  flex: 0 0 auto;
  align-items: center;
  gap: 4px;
}
/*
 * The mixed-variant order warning.
 *
 * Warn tone and a left rule, never the error red: the order becomes usable the
 * moment the user consents, so this is a condition to resolve rather than a
 * failure to fix.
 */
.qdp-routingWarning {
  flex-direction: column;
  align-items: stretch;
  gap: 4px;
  border-left: 3px solid var(--dsw-alias-state-warn-primary);
}
.qdp-routingWarningTitle {
  font: var(--dsw-font-xxs-strong-12);
  color: var(--dsw-alias-label-primary);
}
.qdp-routingOffenders {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding-left: 8px;
}
/*
 * The upstream "model not serviceable" notice.
 *
 * Warn-toned and framed, never the alert's red: this condition clears by
 * waiting, and dressing it as a credential failure is exactly the mistake this
 * block exists to prevent. The left rule is what makes it read as a quoted
 * upstream report rather than another plugin error.
 */
.qdp-notice {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin: 8px 0;
  padding: 8px 10px;
  border-left: 3px solid var(--dsw-alias-state-warn-primary);
  border-radius: var(--dsw-radius-sm);
  background: var(--dsw-alias-bg-layer-2);
}
.qdp-noticeHead {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
}
.qdp-noticeTitle {
  font: var(--dsw-font-xxs-strong-12);
  color: var(--dsw-alias-label-primary);
}
.qdp-noticeAt {
  margin-left: auto;
  font: var(--dsw-font-xxxs-11, var(--dsw-font-xxs-12));
  color: var(--dsw-alias-label-tertiary);
}
.qdp-noticeQuote {
  margin: 0;
  padding-left: 8px;
  border-left: 2px solid var(--dsw-alias-border-l2);
  font: var(--dsw-font-xxs-12);
  color: var(--dsw-alias-label-secondary);
  overflow-wrap: anywhere;
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
/*
 * An inline explanation attached to a settings surface: the face is still
 * loading, or the host refused the last write.
 *
 * Deliberately quieter than the upstream notice block: it explains a control the user is
 * looking at, it is not an upstream report. The danger tone is only for a
 * refusal, where the value on screen is known not to be the stored one.
 */
.qdp-note {
  margin: 0 0 8px;
  padding: 6px 8px;
  border-radius: var(--dsw-radius-sm);
  background: var(--dsw-alias-bg-layer-2);
  color: var(--dsw-alias-label-secondary);
  font: var(--dsw-font-xxs-12);
  line-height: 1.5;
  word-break: break-word;
}
.qdp-noteDanger {
  border-left: 3px solid var(--dsw-alias-state-error-primary);
  color: var(--dsw-alias-label-primary);
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

/*
 * The 'qoder' command row in the conversation flow (the queue notices and the
 * job-token heal lines). The host's generic command card ellipsizes its summary
 * to one nowrap line, which cut the notice's tail — the queue length and retry
 * count — off. This is the plugin's own renderer (QoderQueueNoticeRow): the
 * text wraps, and the tone matches the generic row's caption so the line still
 * reads as the host's own. Backtick-free: this file is one template literal.
 */
.qdp-noticeRow {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 4px;
  padding: 2px 0;
  font: var(--dsw-font-xxs-12);
  color: var(--dsw-alias-label-secondary);
}
.qdp-noticeRowName {
  color: var(--dsw-alias-label-tertiary);
  font-variant-numeric: tabular-nums;
}
.qdp-noticeRowDot {
  color: var(--dsw-alias-label-tertiary);
}
.qdp-noticeRowText {
  flex: 1 1 40ch;
  min-width: 0;
  line-height: 1.5;
  white-space: normal;
  overflow-wrap: anywhere;
}
.qdp-noticeRowError,
.qdp-noticeRowError .qdp-noticeRowText {
  color: var(--dsw-alias-state-error-primary);
}

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
  /* The theme rounds corners with a superellipse, which deforms a 50% radius
     into a squircle. The official control's knob is a true circle, so this
     shape opts out — a switch knob that is visibly not round reads as a
     different control than the ones beside it. */
  corner-shape: round;
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
  corner-shape: round;
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
/*
 * The routing-strategy select. It follows the input geometry above rather than
 * the segmented control, because the card may keep only one level of tabs.
 */
.qdp-select {
  box-sizing: border-box;
  height: 32px;
  padding: 0 8px;
  border: 0.5px solid var(--dsw-alias-border-l2);
  border-radius: var(--dsw-radius-md);
  background: var(--dsw-alias-bg-base);
  font: var(--dsw-font-xxs-12);
  color: var(--dsw-alias-label-primary);
}
.qdp-select:hover:not(:disabled) {
  border-color: var(--dsw-alias-border-l3);
}
.qdp-select:focus {
  border-color: var(--dsw-alias-state-business-primary);
  box-shadow: 0 0 0 1px var(--dsw-alias-state-business-primary);
}
.qdp-select:disabled {
  opacity: 0.5;
  cursor: default;
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
  corner-shape: round;
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

/*
 * The dirty-models strip. It is a footnote under a dense list, not a dialog
 * footer: one hairline, one line of 11px copy and two compact controls, so the
 * strip reads lighter than the rows it follows instead of outshouting them.
 */
.qdp-saveBar {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 8px;
  padding: 8px 0 0;
  border-top: 0.5px solid var(--dsw-alias-border-l2);
  background: var(--dsw-alias-settings-card-fill);
}
.qdp-saveBarText {
  flex: 1 1 auto;
  min-width: 0;
  font: var(--dsw-font-xxxs-11);
  color: var(--dsw-alias-label-secondary);
}
.qdp-saveBarActions {
  display: flex;
  flex: 0 0 auto;
  align-items: center;
  gap: 4px;
}
/* Row-scale controls inside the strip: 24px tall, 11px label. */
.qdp-saveBarActions .qdp-btn {
  height: 24px;
  padding: 0 10px;
  font: var(--dsw-font-xxxs-strong-11);
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
  width: 340px;
  padding: 10px 10px 8px;
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
  margin-bottom: 6px;
}
.qdp-popTitle {
  flex: 1 1 auto;
  min-width: 0;
  font: var(--dsw-font-xs-strong-13);
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
  /*
   * A stored pool makes the row count unbounded (the user can save as many
   * tokens as they like), and the panel opens upward from the composer — so it
   * scrolls here instead of growing off the top of the window. The bound is
   * generous: a compact row is ~48px, so five accounts fit without a scrollbar,
   * and the thin bar only appears for a pool past that.
   */
  max-height: 360px;
  overflow-y: auto;
  overscroll-behavior: contain;
  scrollbar-width: thin;
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
/*
 * The pooled-account section (m01197).
 *
 * Rows are framed like the settings card's pool, so one account reads the same
 * in both surfaces — but here the NAME is the switch. The panel is the fast path
 * for "price my other accounts and move to one", and a separate switch button
 * would spend a control's width on a 300px panel to say what clicking the
 * username already says.
 */
.qdp-popAccounts {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.qdp-popAccountsHead {
  display: flex;
  align-items: baseline;
  gap: 6px;
  padding: 0 2px;
}
.qdp-popAccountsTitle {
  font: var(--dsw-font-xxs-strong-12);
  color: var(--dsw-alias-label-secondary);
}
.qdp-popAccountsSwitchHint {
  margin-left: auto;
  font: var(--dsw-font-xxxs-11);
  color: var(--dsw-alias-label-tertiary);
}
.qdp-popAccountList {
  display: flex;
  flex-direction: column;
  gap: 2px;
  margin: 0;
  padding: 0;
  list-style: none;
}
.qdp-popAccount {
  display: flex;
  flex-direction: column;
  gap: 3px;
  padding: 6px 6px;
  border-radius: var(--dsw-radius-sm);
}
.qdp-popAccountActive {
  background: var(--dsw-alias-interactive-bg-hover);
}
.qdp-popAccountHead {
  display: flex;
  align-items: center;
  gap: 4px;
  min-width: 0;
}
/*
 * The name keeps the row's own typography whether it is the active seat's text
 * or the switch; a raw <button> only gets box-sizing from the shared reset, so
 * the switch rule below flattens the browser's chrome and restores the pointer.
 */
.qdp-popAccountName {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font: var(--dsw-font-xs-strong-13);
  color: var(--dsw-alias-label-primary);
  text-align: left;
}
.qdp-popAccountSwitch {
  border: 0;
  padding: 0;
  background: transparent;
  cursor: pointer;
}
.qdp-popAccountSwitch:hover:not(:disabled) {
  text-decoration: underline;
}
.qdp-popAccountSwitch:disabled {
  cursor: default;
}
.qdp-popAccountUnavailable {
  display: flex;
  align-items: center;
  gap: 6px;
}
/*
 * A parked seat still appears (it is saved, and still switchable — parking is
 * "do not route here", not "forget this"), but it is out of the walk and out of
 * the panel's arithmetic, so it steps back visually the same way the card's
 * account list does.
 */
.qdp-popAccountParked .qdp-popAccountHead {
  opacity: 0.6;
}
/*
 * The health tag is a WORD, not a control: as a pill it repeated four times a
 * row's worth of filled shapes and competed with the name for attention. It
 * keeps the tag element (assistive tech and the tests read the same node) and
 * loses the fill, so the row's only filled marks are the in-use and plan pills.
 */
.qdp-popAccountHealth {
  display: inline-flex;
  flex: 0 0 auto;
}

/* Separates the service state from the credit caption it follows, so the two
   muted runs never read as one sentence. Decorative only: the DOM text is
   unchanged. */
.qdp-popAccountHealth::before {
  content: '·';
  margin-right: 4px;
  color: var(--dsw-alias-label-tertiary);
}
.qdp-popAccountHealth .qdp-tag {
  height: auto;
  padding: 0;
  background: transparent;
  font: var(--dsw-font-xxxs-11);
  color: var(--dsw-alias-label-tertiary);
}
.qdp-popAccountHealth .qdp-tagSuccess {
  color: var(--dsw-alias-state-success-primary);
}
.qdp-popAccountHealth .qdp-tagWarn {
  color: var(--dsw-alias-state-warn-primary);
}
/* Bar and caption share one line: the rail takes the slack, the numbers sit
   at the end of it. */
.qdp-popAccountMeter {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}
.qdp-popAccountMeter .qdp-popMeter,
.qdp-popAccountMeter .qdp-popAccountUnavailable {
  flex: 1 1 auto;
  min-width: 0;
}
.qdp-popMeter {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}
.qdp-popMeter .qdp-popBar {
  flex: 1 1 auto;
  min-width: 56px;
}
.qdp-popMeter .qdp-popCaption {
  flex: 0 0 auto;
  white-space: nowrap;
}
.qdp-popFoot {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 6px;
  padding-top: 6px;
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
  corner-shape: round;
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
