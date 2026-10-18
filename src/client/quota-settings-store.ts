/**
 * Shared live flags for the quota cards, mirrored from the settings document.
 *
 * The settings scope lives in one place (the quota-settings card binds it),
 * but three surfaces read the derived values: the settings card itself, and
 * the two sidebar quota cards. This module is the meeting point — plain
 * mutable module state plus a revision counter, so React components can
 * subscribe through useSyncExternalStore and re-render when a saved toggle
 * flips, without prop-drilling through slot injections.
 *
 * Sign-in state: every surface that polls a status route (the settings card's
 * own lightweight probe, the sidebar cards, the dashboard) reports what it
 * saw through {@link noteQuotaSignIn}. The settings card polls on its own
 * because it must gate its toggles even while both sidebar cards are OFF —
 * the sidebar cards' polls do not run then.
 *
 * The composer-readout switches are different in kind: they are a BROWSER
 * preference persisted in localStorage (see {@link READOUT_STORAGE_KEY}), not
 * state mirrored from the settings file, because they must work against any
 * loaded host version. {@link setQuotaReadout} is the only write path.
 */

import type { QoderVariantId, QoderWebStatus } from '../status-paths.ts'

/** Whether each variant has a usable PAT, as far as the last status poll knows. */
export interface QuotaSignInState {
  cn: boolean
  global: boolean
}

let pollIntervalMs = 300_000
/**
 * The composer-readout switch: ONE preference for the whole chip.
 *
 * It used to be a master flag plus one flag per variant, but the card now
 * offers a single 「在对话框显示积分」 switch, so the per-variant halves were
 * redundant. The chip follows the session's own model directory, so there was
 * never a case where "hide China's readout but keep Global's" said anything a
 * user could act on.
 */
export interface QuotaReadoutState {
  enabled: boolean
}

/**
 * localStorage key holding the readout switches.
 *
 * These three preferences do NOT live in the settings file: the switches must
 * work against ANY loaded host, including one whose settings schema predates
 * them (a fresh host rejects unknown fields with HTTP 400). A browser
 * preference needs no host round trip, survives reloads, and keeps both halves
 * honest about where the value lives.
 */
const READOUT_STORAGE_KEY = 'dsh-qoder-plugin:readout'

/** The on state used when nothing (or nothing valid) was stored. */
function defaultQuotaReadout(): QuotaReadoutState {
  return { enabled: true }
}

/** A stored flag counts as on unless it was explicitly `false`. */
function readoutFlag(stored: unknown): boolean {
  return stored !== false
}

/**
 * The browser storage, or undefined when there is none or access is blocked
 * (non-browser runtime, private mode, disabled site data). Every access is
 * wrapped: `window.localStorage` itself can throw when storage is disabled.
 */
function readoutStorage(): Storage | undefined {
  try {
    if (typeof window === 'undefined' || window.localStorage === undefined) return undefined
    return window.localStorage
  } catch {
    return undefined
  }
}

/** Read the persisted switches once; missing/invalid storage means all-on. */
function loadQuotaReadout(): QuotaReadoutState {
  const storage = readoutStorage()
  if (storage === undefined) return defaultQuotaReadout()
  try {
    const raw = storage.getItem(READOUT_STORAGE_KEY)
    if (raw === null) return defaultQuotaReadout()
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null) return defaultQuotaReadout()
    const stored = parsed as { enabled?: unknown }
    // Only `enabled` is read: a value written by the pre-simplification
    // version may also carry `cn`/`global`, which no longer gate anything and
    // must not be resurrected into the single switch's state.
    return { enabled: readoutFlag(stored.enabled) }
  } catch {
    // Corrupt JSON is not a reason to hide the chip: fall back to all-on.
    return defaultQuotaReadout()
  }
}

/** Persist the switches; a blocked/full store only costs the preference. */
function persistQuotaReadout(state: QuotaReadoutState): void {
  const storage = readoutStorage()
  if (storage === undefined) return
  try {
    storage.setItem(READOUT_STORAGE_KEY, JSON.stringify(state))
  } catch {
    // Quota/blocked-storage errors are ignored: memory still carries the state.
  }
}

let readout: QuotaReadoutState = loadQuotaReadout()
let readoutSnapshot: QuotaReadoutState = { ...readout }
const toggles = { cn: false, global: false }
let togglesSnapshot: QuotaSignInState = { cn: false, global: false }
const signIn: QuotaSignInState = { cn: false, global: false }
let signInSnapshot: QuotaSignInState = { cn: false, global: false }
let revision = 0
const listeners = new Set<() => void>()

function bump(): void {
  revision += 1
  for (const listener of listeners) listener()
}

/** Update the shared poll interval (from the settings document). */
export function setQuotaPollMs(ms: number): void {
  if (Number.isFinite(ms) && ms >= 60_000 && pollIntervalMs !== ms) {
    pollIntervalMs = ms
    bump()
  }
}

/** Read the configured poll interval. */
export function quotaPollMs(): number {
  return pollIntervalMs
}

/** Update both sidebar toggles (from the settings document). */
export function setQuotaToggles(cn: boolean, global: boolean): void {
  if (toggles.cn !== cn || toggles.global !== global) {
    toggles.cn = cn
    toggles.global = global
    togglesSnapshot = { ...toggles }
    bump()
  }
}

/** Read the current toggles. */
export function quotaToggles(): QuotaSignInState {
  return togglesSnapshot
}

/**
 * Update the composer-readout switch.
 *
 * This is a CLIENT-SIDE preference (see {@link READOUT_STORAGE_KEY}), not a
 * settings-file write: it persists to localStorage, bumps the revision so
 * every composer chip re-renders, and never touches the host document.
 */
export function setQuotaReadout(enabled: boolean): void {
  if (readout.enabled !== enabled) {
    readout = { enabled }
    readoutSnapshot = { ...readout }
    persistQuotaReadout(readout)
    bump()
  }
}

/** Read the composer-readout switch. */
export function quotaReadout(): QuotaReadoutState {
  return readoutSnapshot
}

/** Record a variant's sign-in state from any successful status poll. */
export function noteQuotaSignIn(variantId: string, signedIn: boolean): void {
  if (variantId === 'qoder' && signIn.cn !== signedIn) {
    signIn.cn = signedIn
    signInSnapshot = { ...signIn }
    bump()
  } else if (variantId === 'qoder-global' && signIn.global !== signedIn) {
    signIn.global = signedIn
    signInSnapshot = { ...signIn }
    bump()
  }
}

/** Read the cached sign-in state. */
export function quotaSignInState(): QuotaSignInState {
  return signInSnapshot
}

/** Subscribe to any flag change; returns the disposer. */
export function onQuotaSettingsChange(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** The current revision — the useSyncExternalStore snapshot value. */
export function quotaSettingsRevision(): number {
  return revision
}

/** Which variant a status route belongs to, from the route path. */
export function variantOfStatusPath(statusPath: string): QoderVariantId {
  return statusPath.includes('/global/') ? 'qoder-global' : 'qoder'
}

/* ---- shared status documents ---- */

/**
 * The last status document per variant, shared by EVERY quota surface.
 *
 * The sidebar cards and the dashboard each used to fetch independently, so a
 * dashboard refresh updated the panel while the sidebar card kept showing its
 * previous read until its own next tick — two different numbers for one
 * account on one screen. One store, one write path
 * ({@link noteQuotaStatus}), and every subscriber re-renders through the
 * same revision: whatever surface refreshed last, all of them show it.
 *
 * Documents are kept by identity (never mutated), so reference comparisons
 * in useSyncExternalStore selectors stay cheap and stable.
 */
const statusDocuments: { cn: QoderWebStatus | undefined; global: QoderWebStatus | undefined } = { cn: undefined, global: undefined }

/**
 * Publish one variant's freshly fetched status document. Downstream
 * subscribers (both sidebar cards and the dashboard, through whichever
 * observable wraps this store) re-render on the revision bump.
 */
export function noteQuotaStatus(variantId: string, status: QoderWebStatus): void {
  if (variantId === 'qoder' && statusDocuments.cn !== status) {
    statusDocuments.cn = status
    statusFetchedAt.cn = Date.now()
    bump()
  } else if (variantId === 'qoder-global' && statusDocuments.global !== status) {
    statusDocuments.global = status
    statusFetchedAt.global = Date.now()
    bump()
  }
  // Also record the sign-in fact the toggles gate on.
  noteQuotaSignIn(variantId, status.status === 'signed-in')
}

/** Read one variant's latest status document. */
export function quotaStatus(variantId: QoderVariantId): QoderWebStatus | undefined {
  return variantId === 'qoder' ? statusDocuments.cn : statusDocuments.global
}

/** When each variant's document was last fetched (per publish, not per read). */
const statusFetchedAt: { cn: number | undefined; global: number | undefined } = { cn: undefined, global: undefined }

/** Read the time a variant's current document was fetched, if any. */
export function quotaStatusFetchedAt(variantId: QoderVariantId): number | undefined {
  return variantId === 'qoder' ? statusFetchedAt.cn : statusFetchedAt.global
}

/**
 * Whether ONE variant's shared document is fresh enough to skip a fetch:
 * the user's rule — a click/mount/interval tick within the configured
 * interval of the last successful read reuses the cached document, and only
 * a variant with NO result yet (or a failed read that never landed one)
 * forces the upstream call. The interval is a cache lifetime, not a metronome.
 *
 * A `maxAgeMs` of the poll interval comes from the settings document; a
 * failed last read is NOT tracked here (callers gate failures themselves),
 * because "the last read failed" still means "no usable result".
 *
 * @param variantId - which variant's freshness to test.
 * @param maxAgeMs - the configured poll interval (cache lifetime).
 */
export function quotaStatusIsFresh(variantId: QoderVariantId, maxAgeMs: number): boolean {
  const fetchedAt = variantId === 'qoder' ? statusFetchedAt.cn : statusFetchedAt.global
  const document = variantId === 'qoder' ? statusDocuments.cn : statusDocuments.global
  // No document yet = never a result = always stale, whatever the clock says.
  if (fetchedAt === undefined || document === undefined) return false
  return Date.now() - fetchedAt < maxAgeMs
}
