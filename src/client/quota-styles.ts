/**
 * Stylesheet for the Qoder quota surfaces: the plugin configuration page, its
 * plugins-list summary line, the sidebar footer card (wide + 56px rail) and the
 * quota dashboard panel.
 *
 * Design contract (DSH web UI, 0.2.1-rc.1):
 * - every colour, radius, font role and stroke comes from a `--dsw-*` token
 *   (docs/web-styling.md); no literal palette values, no dark-theme selectors;
 * - radii follow the role table (docs/ui-radius.md): 20px cards (`xl`), 16px
 *   nested groups (`lg`), 12px controls (`md`), 8px
 *   compact (`sm`), 999px capsules paired with `corner-shape: round`;
 * - flat neutral borders draw at 0.5px; elevated/floating surfaces would use
 *   `--dsw-elevation-*` (these surfaces are flat, so they keep a real hairline);
 * - typography uses the composed `--dsw-font-*` roles so size and line height
 *   never drift apart; numbers are tabular;
 * - focus rings come from the global `:focus-visible` rule (2px, theme colour),
 *   never from a hardcoded outline colour.
 *
 * Classes are `qdp-` prefixed: several plugins inject GLOBAL CSS into the same
 * document, so prefixes must not collide. The stylesheet is returned as a
 * string (no DOM side effects at import time), installed once by the client
 * entry keyed by `data-plugin-css`, and removed when the plugin's fiber
 * unwinds.
 */

/** Stylesheet id (the `data-plugin-css` value that makes injection idempotent). */
export const QUOTA_CSS_ID = 'dsh-connect-qoder-x/QuotaPanel.module.css'

/** Install the stylesheet once; returns its disposer. */
export function injectQuotaCss(): () => void {
  if (typeof document === 'undefined') return () => {}
  if (document.querySelector(`style[data-plugin-css="${QUOTA_CSS_ID}"]`) !== null) return () => {}
  const tag = document.createElement('style')
  tag.dataset.plugin = 'dsh-connect-qoder-x'
  tag.dataset.pluginCss = QUOTA_CSS_ID
  tag.textContent = QUOTA_CSS
  document.head.appendChild(tag)
  return () => {
    tag.remove()
  }
}

/** The quota surfaces stylesheet. */
export const QUOTA_CSS = `
/* ------------------------------------------------- sidebar footer card */
/* The shell's foot area renders this list ABOVE the Settings seat, inside a
   flex ROW container whose occupants each declare a full-width line, so as a
   row it overflows the column. Force the sidebar's footer-action container into
   a column, anchored to "_footArea" because "footerActions" is also used by the
   ask-user-question dialog — an unanchored rule would stack THAT dialog's
   buttons too. Anchoring keeps the fix scoped to the sidebar; the descendant
   combinator survives a wrapper appearing between the two. The rule is
   idempotent when another plugin ships the same fix. */
[class*="_footArea"] [class*="_footerActions"]{flex-direction:column}

/* The wide card: the shell supplies no chrome, the occupant owns its surface.
   Settings-card material, radius xl, and a quiet one-step hover. */
.qdp-foot{box-sizing:border-box;flex:0 0 auto;width:100%;min-width:0;display:flex;flex-direction:column;gap:8px;margin:0 0 4px;padding:10px 12px;font:var(--dsw-font-xs-13);color:var(--dsw-alias-label-secondary);text-align:left;cursor:pointer;border:0.5px solid var(--dsw-alias-settings-card-stroke);border-radius:var(--dsw-radius-xl);background:var(--dsw-alias-settings-card-fill);transition:background .16s var(--ds-ease-in-out),border-color .16s var(--ds-ease-in-out)}
.qdp-foot:hover{background:var(--dsw-alias-interactive-bg-hover-solid);border-color:var(--dsw-alias-border-l3)}
.qdp-foot:active{background:var(--dsw-alias-interactive-bg-active)}
.qdp-foot:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:2px}
.qdp-footTop{align-items:center;gap:8px;min-width:0;display:flex}
.qdp-footName{white-space:nowrap;text-overflow:ellipsis;color:var(--dsw-alias-label-primary);min-width:0;overflow:hidden;font:var(--dsw-font-s-strong-14)}
.qdp-updated{flex:none;margin-left:auto;color:var(--dsw-alias-label-caption);font:var(--dsw-font-xxxs-11);font-variant-numeric:tabular-nums;white-space:nowrap}
/* One block per merged package group: a head line carrying the group's own
   remain/total, then the FULL-WIDTH bar under it. */
.qdp-footRow{display:flex;flex-direction:column;gap:4px;min-width:0}
.qdp-footHead{align-items:baseline;gap:8px;min-width:0;display:flex}
.qdp-footLabel{flex:1;color:var(--dsw-alias-label-tertiary);font:var(--dsw-font-xxs-12);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.qdp-footAmount{flex:none;color:var(--dsw-alias-label-secondary);font:var(--dsw-font-xxs-12);font-variant-numeric:tabular-nums;white-space:nowrap}
/* The card's markup must stay PHRASING content — it can render inside a host
   button — so these bars are spans, not divs. display:block is load-bearing:
   an inline box ignores width and height. */
.qdp-footBar{display:block;background:var(--dsw-alias-bg-module-platform);border-radius:999px;corner-shape:round;height:4px;overflow:hidden}
.qdp-footFill{display:block;background:var(--dsw-alias-state-business-primary);border-radius:999px;corner-shape:round;height:100%;transition:width .3s var(--ds-ease-in-out)}
.qdp-footFillWarn{background:var(--dsw-alias-state-error-primary)}
.qdp-footPct{flex:none;width:34px;color:var(--dsw-alias-label-secondary);text-align:right;font:var(--dsw-font-xxs-12);font-variant-numeric:tabular-nums}

/* The 56px rail: one icon button on the shell's own rail geometry (36px cell). */
.qdp-railButton{box-sizing:border-box;width:36px;height:36px;flex:none;display:inline-flex;justify-content:center;align-items:center;margin:0 0 4px;padding:0;color:var(--dsw-alias-label-secondary);cursor:pointer;background:0 0;border:0;border-radius:var(--dsw-radius-sm)}
.qdp-railButton:hover{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-interactive-bg-hover)}
.qdp-railButton:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:2px}

/* The ring glyph: sized by its own width/height attribute. */
.qdp-glyph{flex:none;display:inline-flex;justify-content:center;align-items:center;color:var(--dsw-alias-state-business-primary)}

/* ------------------------------------------------- shared primitives */
/* Sections are settings cards on the plugin page and plain groups inside the
   dashboard. fill/stroke tokens are bound on body by ui-theme (base.css). */
.qdp-section{box-sizing:border-box;display:flex;flex-direction:column;gap:16px;padding:20px 22px;border:0.5px solid var(--dsw-alias-settings-card-stroke);border-radius:var(--dsw-radius-xl);background:var(--dsw-alias-settings-card-fill)}
.qdp-sectionHead{display:flex;align-items:center;justify-content:space-between;gap:12px;min-width:0}
.qdp-sectionTitle{margin:0;color:var(--dsw-alias-label-primary);font:var(--dsw-font-s-strong-14)}
.qdp-sectionMeta{color:var(--dsw-alias-label-caption);font:var(--dsw-font-xxs-12);font-variant-numeric:tabular-nums}
.qdp-sectionBody{display:flex;flex-direction:column;gap:12px;min-width:0}

/* A settings row: text block left, control flush right, hairline under. */
.qdp-row{display:flex;align-items:center;justify-content:space-between;gap:24px;padding:12px 0;border-bottom:0.5px solid var(--dsw-alias-border-l2)}
.qdp-row:last-child{border-bottom:0;padding-bottom:0}
.qdp-row:first-child{padding-top:0}
.qdp-rowText{display:flex;flex-direction:column;gap:2px;min-width:0;flex:1}
.qdp-rowTitle{color:var(--dsw-alias-label-primary);font:var(--dsw-font-s-14)}
.qdp-rowDesc{margin:0;color:var(--dsw-alias-label-secondary);font:var(--dsw-font-xxs-12)}
.qdp-rowControl{display:flex;align-items:center;gap:8px;flex:none}
.qdp-stack{display:flex;flex-direction:column;gap:12px;min-width:0}
.qdp-inline{display:flex;align-items:center;gap:8px;min-width:0;flex-wrap:wrap}
.qdp-muted{margin:0;color:var(--dsw-alias-label-tertiary);font:var(--dsw-font-xxs-12)}
.qdp-caption{margin:0;color:var(--dsw-alias-label-caption);font:var(--dsw-font-xxxs-11)}
.qdp-num{font-variant-numeric:tabular-nums}
.qdp-link{color:var(--dsw-alias-link);font:var(--dsw-font-s-strong-14);font-weight:500;text-decoration:none;border-radius:var(--dsw-radius-xs)}
.qdp-link:hover,.qdp-link:focus-visible{text-decoration:underline;text-decoration-style:dotted;text-underline-offset:3px}
.qdp-empty{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:6px;padding:24px 16px;color:var(--dsw-alias-label-tertiary);font:var(--dsw-font-xs-13);text-align:center}
.qdp-alert{display:flex;flex-direction:column;gap:4px;padding:10px 12px;border:1px solid var(--dsw-alias-state-warn-primary);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-state-warn-tertiary);color:var(--dsw-alias-state-warn-label);font:var(--dsw-font-xs-13)}
.qdp-alertError{border-color:var(--dsw-alias-state-error-primary);background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-state-error-primary)}
.qdp-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.qdp-iconButton{box-sizing:border-box;width:28px;height:28px;flex:none;display:inline-flex;justify-content:center;align-items:center;padding:0;color:var(--dsw-alias-label-secondary);cursor:pointer;background:0 0;border:0;border-radius:var(--dsw-radius-sm)}
.qdp-iconButton:hover{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-interactive-bg-hover)}
.qdp-iconButton:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:2px}
.qdp-iconButton:disabled{color:var(--dsw-alias-label-tertiary);cursor:default}
.qdp-skeleton{display:block;height:8px;border-radius:var(--dsw-radius-xs);background:var(--dsw-alias-bg-skeleton);animation:qdp-pulse 1.4s var(--ds-ease-in-out) infinite}
@keyframes qdp-pulse{0%,100%{opacity:.6}50%{opacity:1}}

/* ------------------------------------------------------------ dashboard */
/* The center column in the layout frame: fill it, scroll the content column,
   and cap the reading width like the harness's own panels. */
.qdp-main{display:block;width:100%;height:100%;overflow:auto;background:var(--dsw-alias-bg-layer-1)}
.qdp-mainInner{display:flex;flex-direction:column;gap:20px;max-width:720px;margin:0 auto;padding:28px 24px 48px;color:var(--dsw-alias-label-primary)}
.qdp-header{display:flex;align-items:center;gap:12px;flex-wrap:wrap;min-width:0}
.qdp-headerText{display:flex;flex-direction:column;gap:2px;min-width:0;flex:1}
.qdp-title{margin:0;color:var(--dsw-alias-label-primary);font:var(--dsw-font-l-20)}
.qdp-subtitle{margin:0;color:var(--dsw-alias-label-tertiary);font:var(--dsw-font-xs-13)}
.qdp-spacer{flex:1}
.qdp-meta{color:var(--dsw-alias-label-tertiary);font:var(--dsw-font-xxs-12);font-variant-numeric:tabular-nums}
.qdp-close,.qdp-refresh{box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center;gap:6px;height:28px;padding:0 10px;color:var(--dsw-alias-label-secondary);cursor:pointer;font:var(--dsw-font-xxs-12);background:0 0;border:0.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-sm)}
.qdp-close{min-width:28px;padding:0}
.qdp-close:hover,.qdp-refresh:hover:not(:disabled){color:var(--dsw-alias-label-primary);background:var(--dsw-alias-interactive-bg-hover)}
.qdp-close:focus-visible,.qdp-refresh:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:2px}
.qdp-refresh:disabled{color:var(--dsw-alias-label-tertiary);cursor:default}
.qdp-close span{font-size:16px;line-height:1}

/* Notices (signed-out / error). */
.qdp-notice{display:flex;flex-direction:column;gap:6px;padding:16px 18px;border:0.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-lg);background:var(--dsw-alias-bg-module-platform)}
.qdp-noticeError{border-color:var(--dsw-alias-state-error-primary)}
.qdp-noticeTitle{margin:0;color:var(--dsw-alias-label-primary);font:var(--dsw-font-s-strong-14)}

/* One card per variant on the dashboard. Flat settings-card material. */
.qdp-dashCard{list-style:none;display:flex;flex-direction:column;gap:16px;padding:20px 22px;border:0.5px solid var(--dsw-alias-settings-card-stroke);border-radius:var(--dsw-radius-xl);background:var(--dsw-alias-settings-card-fill)}
.qdp-dashCardHead{display:flex;flex:1;flex-direction:column;align-items:flex-start;gap:4px;min-width:0;flex-wrap:wrap}
.qdp-avatar{flex:none;display:inline-flex;justify-content:center;align-items:center;width:32px;height:32px;color:var(--dsw-alias-label-primary-foreground);background:var(--dsw-alias-state-business-primary);border-radius:50%;corner-shape:round;font:var(--dsw-font-xxs-strong-12)}
.qdp-cardIdentity{display:flex;flex-direction:column;gap:1px;min-width:0}
.qdp-dashCardTitle{color:var(--dsw-alias-label-primary);text-align:left;font:var(--dsw-font-base-strong-16)}
.qdp-cardOwner{max-width:220px;color:var(--dsw-alias-label-tertiary);font:var(--dsw-font-xxxs-11);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}

/* Quota blocks: each merged group is a label row plus the track. */
.qdp-bar{height:6px;overflow:hidden;background:var(--dsw-alias-bg-module-platform);border-radius:999px;corner-shape:round}
.qdp-barFill{height:100%;background:var(--dsw-alias-state-business-primary);border-radius:999px;corner-shape:round;transition:width .3s var(--ds-ease-in-out)}
.qdp-barFillWarn{background:var(--dsw-alias-state-error-primary)}
.qdp-barFillIndeterminate{width:100%;opacity:.25}
.qdp-windowReset{margin:0;color:var(--dsw-alias-label-tertiary);font:var(--dsw-font-xxs-12)}

/* Read-only badges. */
.qdp-badge{display:inline-flex;align-items:center;height:20px;padding:0 8px;white-space:nowrap;background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-secondary);border-radius:999px;corner-shape:round;font:var(--dsw-font-xxxs-strong-11)}

/* Overall remaining + share line, ahead of the detail table. */
.qdp-totalLine{margin:0;display:flex;align-items:baseline;gap:6px;flex-wrap:wrap;color:var(--dsw-alias-label-secondary);font:var(--dsw-font-s-14)}
.qdp-totalValue{margin-left:auto;color:var(--dsw-alias-label-primary);font:var(--dsw-font-l-20);font-variant-numeric:tabular-nums}
.qdp-totalSub{margin:0;color:var(--dsw-alias-label-tertiary);font:var(--dsw-font-xxs-12);font-variant-numeric:tabular-nums}
.qdp-blockTitle{margin:0;color:var(--dsw-alias-label-primary);font:var(--dsw-font-s-strong-14)}

/* Detail table: every package, unmerged. Hairlines, tabular numbers, quiet
   column heads. */
.qdp-table{width:100%;border-collapse:collapse;color:var(--dsw-alias-label-secondary);font:var(--dsw-font-xxs-12)}
.qdp-table th{padding:6px 10px;color:var(--dsw-alias-label-caption);text-align:left;font:var(--dsw-font-xxxs-strong-11);letter-spacing:.02em;border-bottom:0.5px solid var(--dsw-alias-border-l2)}
.qdp-table td{padding:9px 10px;vertical-align:top;border-bottom:0.5px solid var(--dsw-alias-border-l2)}
.qdp-table tbody tr:last-child td{border-bottom:0}
.qdp-num{min-width:140px}
.qdp-numText{display:block;margin-bottom:4px;color:var(--dsw-alias-label-primary);font-variant-numeric:tabular-nums}
.qdp-miniBar{display:block;height:4px;overflow:hidden;background:var(--dsw-alias-bg-module-platform);border-radius:999px;corner-shape:round}
.qdp-expiry{white-space:nowrap;color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums}

/* Variant switcher on the dashboard: text tabs (kept quiet next to the cards). */
.qdp-tabs{display:flex;flex-wrap:wrap;gap:2px;padding:4px;border-radius:var(--dsw-radius-md);background:var(--dsw-alias-interactive-bg-hover)}
.qdp-tab{display:inline-flex;align-items:center;gap:6px;padding:4px 12px;color:var(--dsw-alias-label-tertiary);cursor:pointer;font:var(--dsw-font-xxs-strong-12);background:0 0;border:0;border-radius:var(--dsw-radius-sm)}
.qdp-tab:hover:not(.qdp-tabActive){color:var(--dsw-alias-label-primary)}
.qdp-tabActive{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-1);box-shadow:var(--dsw-elevation-soft)}
.qdp-tab:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:1px}

/* ------------------------------------------------- plugin card (page) */
/* The page body: the host detail page already draws the crumb, icon, title,
   version and description, so this is a plain column of sections — no outer
   card chrome, no second heading. */
.qdp-card{display:flex;flex-direction:column;gap:20px;min-width:0;padding:0;margin:0;background:none;border:0;list-style:none}
.qdp-cardOpen{background:none}
.qdp-cardBody{display:flex;flex-direction:column;gap:20px;margin:0;padding:0;min-width:0}
/* Legacy disclosure header (kept for the bundle-config seat and for the
   summary-line anatomy; the page seat renders body-only). */
.qdp-cardHeader{display:flex;align-items:flex-start;gap:12px;width:100%;padding:14px 16px;color:inherit;cursor:pointer;text-align:left;background:none;border:0;border-radius:var(--dsw-radius-xl)}
.qdp-cardHeader:hover{background:var(--dsw-alias-interactive-bg-hover)}
.qdp-cardHead{display:flex;flex:1;flex-direction:column;align-items:flex-start;gap:2px;min-width:0;flex-wrap:wrap}
.qdp-cardTitle{color:var(--dsw-alias-label-primary);text-align:left;font:var(--dsw-font-base-strong-16)}
.qdp-cardDescription{color:var(--dsw-alias-label-tertiary);text-align:left;font:var(--dsw-font-xs-13)}
.qdp-cardIcon{flex:none;display:block;width:36px;height:36px;border-radius:var(--dsw-radius-sm)}
.qdp-cardChevron{flex:none;width:7px;height:7px;margin:6px 4px 0 0;border-right:1.5px solid var(--dsw-alias-label-tertiary);border-bottom:1.5px solid var(--dsw-alias-label-tertiary);transform:rotate(45deg);transition:transform .16s var(--ds-ease-in-out)}
.qdp-cardChevronOpen{transform:rotate(225deg)}

/* Status header inside the account section. */
.qdp-accountBox{display:flex;align-items:center;justify-content:space-between;gap:16px;min-width:0}
.qdp-accountState{display:flex;align-items:center;gap:8px;color:var(--dsw-alias-label-primary);font:var(--dsw-font-base-strong-16)}
.qdp-accountExpiry{color:var(--dsw-alias-label-tertiary);font:var(--dsw-font-xxs-12)}
.qdp-accountMain{display:flex;flex-direction:column;gap:3px;min-width:0}

/* PAT (credential) group. */
.qdp-patBox{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;padding:12px 0;border-top:0.5px solid var(--dsw-alias-border-l2)}
.qdp-patBoxCopy{display:flex;flex-direction:column;gap:2px;min-width:0}
.qdp-patBoxMeta{color:var(--dsw-alias-label-tertiary);font:var(--dsw-font-xxs-12);font-variant-numeric:tabular-nums}
.qdp-body{margin:0;color:var(--dsw-alias-label-tertiary);font:var(--dsw-font-xs-13)}
.qdp-error{margin:0;color:var(--dsw-alias-state-error-primary);font:var(--dsw-font-xs-13)}
.qdp-rate{color:var(--dsw-alias-label-tertiary);font:var(--dsw-font-xxs-12)}

/* Buttons: the local 'QdpButton' control (src/client/controls.tsx) renders
   these classes on the official small-button geometry (28px / R8 / 12-18). */
.qdp-btn{box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center;gap:4px;height:28px;padding:0 10px;color:var(--dsw-alias-label-secondary);cursor:pointer;font:var(--dsw-font-xxs-strong-12);background:0 0;border:0.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-sm)}
.qdp-btn:hover:not(:disabled){color:var(--dsw-alias-label-primary);background:var(--dsw-alias-interactive-bg-hover)}
.qdp-btn:disabled{color:var(--dsw-alias-label-tertiary);background:var(--dsw-alias-interactive-bg-hover);border-color:transparent;cursor:default}
.qdp-btn:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:2px}
.qdp-btnPrimary{color:var(--dsw-alias-label-primary-foreground);background:var(--dsw-alias-button-primary-fill);border-color:var(--dsw-alias-button-primary-fill)}
.qdp-btnPrimary:hover:not(:disabled){color:var(--dsw-alias-label-primary-foreground);background:var(--dsw-alias-button-primary-hover);border-color:var(--dsw-alias-button-primary-hover)}
.qdp-btnDanger{color:var(--dsw-alias-label-primary-foreground);background:var(--dsw-alias-state-error-primary);border-color:var(--dsw-alias-state-error-primary)}
.qdp-btnDangerQuiet{color:var(--dsw-alias-state-error-primary)}
.qdp-btnDangerQuiet:hover:not(:disabled){color:var(--dsw-alias-state-error-primary);background:var(--dsw-alias-interactive-bg-hover-danger)}
.qdp-btnGhost{border-color:transparent}

/* Medium action button (36px / R12) for the one CTA that deserves emphasis. */
.qdp-btnMd{height:36px;padding:0 14px;font:var(--dsw-font-s-strong-14);border-radius:var(--dsw-radius-md)}

/* Toggle: 36x20 capsule with a 16px thumb — the official switch geometry. */
.qdp-switch{box-sizing:border-box;position:relative;display:inline-flex;flex:none;align-items:center;width:36px;height:20px;padding:2px;cursor:pointer;background:var(--dsw-alias-border-l3);border:0;border-radius:999px;corner-shape:round;transition:background .12s var(--ds-ease-in-out)}
.qdp-switch[aria-checked="true"]{background:var(--dsw-alias-brand-primary)}
.qdp-switch:disabled{opacity:.5;cursor:default}
.qdp-switch:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:2px}
.qdp-switchThumb{display:block;width:16px;height:16px;background:var(--dsw-alias-switch-thumb);border-radius:50%;corner-shape:round;transition:transform .12s var(--ds-ease-in-out)}
.qdp-switch[aria-checked="true"] .qdp-switchThumb{background:var(--dsw-alias-label-primary-foreground)}
.qdp-switch[aria-checked="true"] .qdp-switchThumb{transform:translateX(16px)}

/* Status dot (8px), the shell's own state vocabulary. */
.qdp-dot{display:inline-flex;flex:none;width:8px;height:8px;border-radius:50%;corner-shape:round;background:var(--dsw-alias-state-idle-primary)}
.qdp-dotDone{background:var(--dsw-alias-state-success-primary)}
.qdp-dotOngoing{background:var(--dsw-alias-state-business-primary);animation:qdp-pulse 1.4s var(--ds-ease-in-out) infinite}
.qdp-dotWarn{background:var(--dsw-alias-state-warn-primary)}
.qdp-dotError{background:var(--dsw-alias-state-error-primary)}

/* Read-only tag/capsule. */
.qdp-tag{display:inline-flex;align-items:center;gap:4px;height:20px;padding:0 8px;color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-module-platform);border-radius:999px;corner-shape:round;font:var(--dsw-font-xxxs-strong-11);white-space:nowrap}
.qdp-tagSuccess{color:var(--dsw-alias-state-success-primary);background:var(--dsw-alias-state-success-tertiary)}
.qdp-tagWarn{color:var(--dsw-alias-state-warn-label);background:var(--dsw-alias-state-warn-tertiary)}
.qdp-tagError{color:var(--dsw-alias-state-error-primary);background:var(--dsw-alias-interactive-bg-hover-danger)}

/* Single-line text input (local 'QdpInput'): 32px / R12, hairline at rest. */
.qdp-input{box-sizing:border-box;display:flex;flex:1;min-width:200px;height:32px;padding:0 10px;color:var(--dsw-alias-label-primary);font:var(--dsw-font-s-14);background:var(--dsw-alias-bg-module-platform);border:0.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-md)}
.qdp-input::placeholder{color:var(--dsw-alias-label-caption)}
.qdp-input:hover:not(:disabled){border-color:var(--dsw-alias-border-l3)}
.qdp-input:focus-visible{border-color:var(--dsw-alias-state-business-primary);outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:1px}
.qdp-input:disabled{opacity:.5;cursor:default}
.qdp-inputShort{flex:0 0 auto;width:56px;min-width:0;padding:0 8px;text-align:center;font-variant-numeric:tabular-nums}

/* Credential input row (local 'QdpInput'): 32px / R12, hairline at rest. */
.qdp-patRow{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.qdp-patInput{box-sizing:border-box;flex:1;min-width:200px;height:32px;padding:0 8px;color:var(--dsw-alias-label-primary);font:var(--dsw-font-s-14);background:var(--dsw-alias-bg-module-platform);border:0.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-md)}
.qdp-patInput::placeholder{color:var(--dsw-alias-label-caption)}
.qdp-patInput:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:1px}

/* Segmented control: 4px inset track, R12 outer / R8 segments (local control). */
.qdp-seg{display:flex;align-items:center;gap:2px;padding:4px;background:var(--dsw-alias-interactive-bg-hover);border-radius:var(--dsw-radius-md)}
.qdp-segItem{flex:1;display:flex;align-items:center;justify-content:center;gap:6px;height:28px;padding:0 16px;color:var(--dsw-alias-label-secondary);cursor:pointer;font:var(--dsw-font-xs-strong-13);background:0 0;border:0;border-radius:var(--dsw-radius-sm);transition:background .16s var(--ds-ease-in-out),color .16s var(--ds-ease-in-out)}
.qdp-segItem:hover{color:var(--dsw-alias-label-primary)}
.qdp-segItem:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:1px}
.qdp-segItemActive{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-1);box-shadow:var(--dsw-elevation-soft)}
.qdp-segCell{display:flex;align-items:center;gap:2px;flex:1;min-width:0}
.qdp-segSwitch{display:inline-flex;flex:none;align-items:center;padding:0 8px 0 2px;cursor:pointer}
.qdp-segSwitch input{margin:0;cursor:pointer;accent-color:var(--dsw-alias-state-business-primary)}
.qdp-segSwitch input:disabled{opacity:.4;cursor:default}
.qdp-contextPicker{display:flex;align-items:center;justify-content:flex-end;gap:8px;flex-wrap:wrap}

/* Usage & check-in group: one surfaced block, usage above a hairline, check-in
   below. Nested group radius = outer card 20 − inset 4 → 16. */
.qdp-panel{display:flex;flex-direction:column;gap:14px;padding:16px;background:var(--dsw-alias-bg-module-platform);border:0;border-radius:var(--dsw-radius-lg)}
.qdp-panel + .qdp-panel{margin-top:-4px}
.qdp-panelHead{display:flex;align-items:baseline;justify-content:space-between;gap:12px}
.qdp-panelTitle{margin:0;color:var(--dsw-alias-label-primary);font:var(--dsw-font-s-strong-14)}
.qdp-panelMeta{color:var(--dsw-alias-label-tertiary);font:var(--dsw-font-xxs-12);font-variant-numeric:tabular-nums}
.qdp-list{display:flex;flex-direction:column;gap:10px;min-width:0}
.qdp-group{display:flex;flex-direction:column;gap:10px;min-width:0}
.qdp-label{display:flex;justify-content:space-between;gap:12px;color:var(--dsw-alias-label-secondary);font:var(--dsw-font-xxs-12)}
.qdp-logList{display:flex;flex-direction:column;gap:4px}
.qdp-track{height:6px;overflow:hidden;background:var(--dsw-alias-bg-layer-1);border-radius:999px;corner-shape:round}
.qdp-settingsFlat{display:flex;flex-direction:column;gap:4px;padding-top:14px;border-top:0.5px solid var(--dsw-alias-border-l2)}
.qdp-twoUp{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:12px;align-items:stretch}
@media (max-width:760px){.qdp-twoUp{grid-template-columns:1fr}}

/* Pane tabs: underline strip like the plugins settings tabs. */
.qdp-paneTabs{display:flex;gap:20px;margin-top:2px;border-bottom:0.5px solid var(--dsw-alias-border-l2)}
.qdp-paneTab{margin-bottom:-1px;padding:7px 1px 9px;color:var(--dsw-alias-label-tertiary);cursor:pointer;font:var(--dsw-font-xs-13);background:0 0;border:0;border-bottom:2px solid transparent}
.qdp-paneTab:hover{color:var(--dsw-alias-label-primary)}
.qdp-paneTab:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:2px;border-radius:2px}
.qdp-paneTabActive{color:var(--dsw-alias-label-primary);font-weight:500;border-bottom-color:var(--dsw-alias-label-primary)}

/* Model list: one framed list (R16) whose rows own the hairline dividers. */
.qdp-modelHead{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap}
.qdp-modelColumns{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:0 2px 2px;color:var(--dsw-alias-label-caption);font:var(--dsw-font-xxxs-11)}
.qdp-modelList{overflow:hidden;background:var(--dsw-alias-settings-card-fill);border:0.5px solid var(--dsw-alias-settings-card-stroke);border-radius:var(--dsw-radius-lg)}
.qdp-modelRow{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;padding:12px 14px}
.qdp-modelRow + .qdp-modelRow{border-top:0.5px solid var(--dsw-alias-border-l2)}
.qdp-modelEnable{display:flex;flex:1;align-items:center;gap:10px;min-width:0;cursor:pointer}
.qdp-modelEnable input{flex:none;width:16px;height:16px;margin:0;cursor:pointer;accent-color:var(--dsw-alias-state-business-primary)}
.qdp-modelCopy{display:flex;flex-direction:column;gap:1px;min-width:0}
.qdp-modelName{overflow:hidden;color:var(--dsw-alias-label-primary);text-overflow:ellipsis;white-space:nowrap;font:var(--dsw-font-s-14)}
.qdp-modelRate{margin-left:6px;color:var(--dsw-alias-label-tertiary);font:var(--dsw-font-xxxs-11);font-variant-numeric:tabular-nums}
.qdp-modelMeta{white-space:nowrap;color:var(--dsw-alias-label-tertiary);font:var(--dsw-font-xxxs-11)}

/* Per-model context-window slider (Qoder's own control: success-toned). */
.qdp-windowSlider{display:flex;flex:none;flex-direction:column;gap:4px;width:170px}
.qdp-windowTrack{position:relative;display:flex;align-items:center;height:18px}
.qdp-windowTrack::before{content:"";position:absolute;left:0;right:0;height:6px;background:var(--dsw-alias-bg-module-platform);border-radius:999px;corner-shape:round}
.qdp-windowFill{position:absolute;left:0;height:6px;background:var(--dsw-alias-state-business-primary);opacity:.22;border-radius:999px;corner-shape:round}
.qdp-windowKnob{position:absolute;width:2px;height:14px;background:var(--dsw-alias-state-business-primary);border-radius:1px;corner-shape:round;transform:translateX(-1px)}
.qdp-windowInput{position:absolute;left:0;right:0;width:100%;height:18px;margin:0;opacity:0;cursor:pointer;-webkit-appearance:none;appearance:none}
.qdp-windowInput:disabled{cursor:default}
.qdp-windowTicks{position:relative;height:14px;color:var(--dsw-alias-label-tertiary);font:var(--dsw-font-xxxs-11);font-variant-numeric:tabular-nums}
.qdp-windowTick{position:absolute;white-space:nowrap;transform:translateX(-50%)}
.qdp-windowTickMark{display:inline-block;width:1px;height:4px;background:var(--dsw-alias-border-l4)}

/* Check-in ledger. */
.qdp-ledgerRow{display:flex;align-items:baseline;justify-content:space-between;gap:10px;color:var(--dsw-alias-label-secondary);font:var(--dsw-font-xxs-12)}
.qdp-ledgerList{max-height:216px;overflow-y:auto}
.qdp-ledgerDate{white-space:nowrap;color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums}
.qdp-ledgerAmount{flex:none;color:var(--dsw-alias-label-primary);font-weight:500;font-variant-numeric:tabular-nums}
.qdp-ledgerExpiry{margin-left:auto;white-space:nowrap;color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums}
.qdp-ledgerExpired{color:var(--dsw-alias-state-error-primary)}
.qdp-claimBtn{width:100%;justify-content:center}
.qdp-ledgerFoot{display:flex;align-items:baseline;justify-content:space-between;gap:10px;padding-top:10px;border-top:0.5px solid var(--dsw-alias-border-l2)}
.qdp-ledgerFootValue{color:var(--dsw-alias-label-primary);font-weight:500;font-variant-numeric:tabular-nums}

/* The composer probe control: a compact pill button. */
.qdp-probe{box-sizing:border-box;display:inline-flex;align-items:center;gap:6px;height:28px;padding:0 10px;color:var(--dsw-alias-label-secondary);cursor:pointer;font:var(--dsw-font-xxs-strong-12);background:0 0;border:0.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-sm)}
.qdp-probe:hover{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-interactive-bg-hover)}
.qdp-probe:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:2px}
.qdp-probe:disabled{opacity:.4;cursor:default}
.qdp-probeDot{flex:none;width:6px;height:6px;border-radius:50%;corner-shape:round;background:var(--dsw-alias-state-idle-primary)}
.qdp-probeDotOn{background:var(--dsw-alias-state-success-primary)}
.qdp-probeDotWarn{background:var(--dsw-alias-state-warn-primary)}
.qdp-probeDotError{background:var(--dsw-alias-state-error-primary)}
.qdp-probeWrap{display:inline-flex;position:relative;align-items:center;transform:translateY(2px);margin-right:-8px}
.qdp-probeLabel{color:var(--dsw-alias-label-tertiary);font:var(--dsw-font-xxxs-11);white-space:nowrap}
/* Tooltip: dark capsule, elevation carries the edge (no border + shadow pairing). */
.qdp-probeTip{position:absolute;left:50%;bottom:calc(100% + 8px);z-index:1000;transform:translateX(-50%);padding:4px 8px;white-space:nowrap;pointer-events:none;color:var(--dsw-alias-label-primary-foreground);background:var(--dsw-alias-tooltip-bg);border-radius:var(--dsw-radius-sm);box-shadow:var(--dsw-elevation-soft);font:var(--dsw-font-xxs-12)}
/* Confirmation/result surface: light elevated popover, same anchor. */
.qdp-probeBubble{position:absolute;right:0;bottom:calc(100% + 8px);z-index:1001;display:flex;flex-direction:column;gap:10px;width:260px;padding:12px 14px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-1);border-radius:var(--dsw-radius-md);box-shadow:var(--dsw-elevation-panel);font:var(--dsw-font-xxs-12)}
.qdp-probeBubbleRow{display:flex;justify-content:flex-end;gap:8px}
.qdp-probeNote{position:absolute;right:0;bottom:calc(100% + 8px);z-index:1001;display:flex;align-items:center;gap:12px;padding:8px 10px;white-space:nowrap;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-1);border-radius:var(--dsw-radius-md);box-shadow:var(--dsw-elevation-panel);font:var(--dsw-font-xxs-12)}
.qdp-bubble{position:absolute;z-index:120;display:flex;flex-direction:column;gap:6px;min-width:200px;max-width:320px;padding:10px 12px;background:var(--dsw-alias-tooltip-bg);border-radius:var(--dsw-radius-md);box-shadow:var(--dsw-elevation-panel);color:var(--dsw-alias-label-primary-foreground);font:var(--dsw-font-xxs-12)}
.qdp-bubbleTitle{font:var(--dsw-font-xxs-strong-12)}
.qdp-bubbleNote{opacity:.85}

@media (prefers-reduced-motion:reduce){
  .qdp-foot,.qdp-footFill,.qdp-barFill,.qdp-skeleton,.qdp-cardChevron,.qdp-segItem{transition:none;animation:none}
}
`
