/**
 * The quota-settings face this plugin shares across its client files.
 *
 * This module owns types only: the DSH settings-controller face restated
 * structurally (`QuotaSettingsScope`), its snapshot shape, the section this
 * plugin stores (`QuotaSection`) and the injected props every surface binds.
 * The 0.4.0 composer chip replaced the sidebar quota widgets, and the plugin
 * page renders its own 高级设置 rows, so the old card component and its
 * projection helpers are gone — a single owner per surface keeps the DOM and
 * the write path from drifting apart.
 */

import type { QoderSettingsKey } from "./locales.ts"

/**
 * The settings-controller face this bundle consumes, restated locally.
 *
 * DSH 0.1.5 hands a `SettingsScope<T>` (`SettingsScopeController`) to a plugin
 * that binds a namespace it registered on the Host; DSH 0.1.7 hands a
 * `ConfigFormController<T>` to a plugin that asks for its profile entry's form.
 * The two are field-for-field identical — `getSnapshot` / `subscribe` / `set` /
 * `unset` / `mutate`, over the same
 * `status`/`value`/`base`/`user`/`revision`/`writable`/`mode` snapshot — which
 * is what lets every caller below stay branch-free.
 *
 * The type is restated rather than imported: naming either host type would tie
 * this bundle's compilation to one version's settings package graph, and 0.1.7
 * does not declare the 0.1.5 name at all. A type-only import would still be a
 * cross-version dependency; a structural restatement is not (client bundle
 * purity: cross-plugin collaboration goes through services, never imports).
 */
export interface QuotaSettingsScope<T> {
  /** @returns the current sync snapshot (stable reference until the next change). */
  getSnapshot: () => QuotaSettingsSnapshot<T>
  /**
   * Observe snapshot replacements.
   * @param listener - invoked after each snapshot change.
   * @returns the disposer removing this listener.
   */
  subscribe: (listener: () => void) => () => void
  /**
   * Queue one field write.
   * @param field - scalar field inside the section.
   * @param value - JSON-shaped value selected by the user.
   * @returns the host-specific settlement, which this card does not read.
   */
  set: (field: string, value: unknown) => Promise<unknown>
  /**
   * Queue one field clear, so the field re-inherits the composition layer.
   * @param field - scalar field inside the section.
   * @returns the host-specific settlement, which this card does not read.
   */
  unset: (field: string) => Promise<unknown>
  /**
   * Load the host document unless it is already loaded or loading.
   *
   * Optional: a scope whose first read failed (the host route was not mounted
   * yet, or the host plugin was being replaced) can recover without a page
   * reload. A scope that never serves documents simply omits it.
   */
  ensureLoaded?: (() => void) | undefined
  /**
   * Give every saved account a new device code, then report what happened.
   *
   * Optional: the action is a host write, and a host that serves no reset route
   * must leave the card without a button rather than with one that cannot work.
   * A resolved `ok: false` is an ANSWER (the host refused or the write failed)
   * and is shown as such; only a thrown error means the card could not ask.
   */
  resetDeviceCodes?: (() => Promise<QuotaDeviceResetResult>) | undefined
}

/** What one device-code reset did, as the card reports it. */
export interface QuotaDeviceResetResult {
  ok: boolean
  /** How many saved accounts were re-identified; absent when the host omitted it. */
  accounts?: number
  /** Why the reset failed, as a message for the user. */
  error?: string
}

/** One settings form's sync state, identical in both hosts. */
export interface QuotaSettingsSnapshot<T> {
  /** `loading` until the first accepted section, `ready` while one stands, `unavailable` when no such form is served. */
  status: 'loading' | 'ready' | 'unavailable'
  /** Last accepted section; undefined before the first acceptance. */
  value: T | undefined
  /** Whether the host document accepts writes. */
  writable: boolean
  /**
   * The last write the host refused, as a message to show the user.
   *
   * Absent while the last write (or read) succeeded. Present means the value
   * on screen is NOT what the host holds, so the card must say so rather than
   * leave a control looking applied.
   */
  error?: string | undefined
}

/** Everything the registration binds into the card. */
export interface QuotaSettingsCardInjected {
  /** Translator bound to the settings namespace. */
  t: (key: QoderSettingsKey, params?: Record<string, unknown>) => string
  /** Sign-in state per variant; a gated write is skipped when its variant is out. */
  signedIn?: (() => { cn: boolean; global: boolean }) | undefined
  /** The bound quota settings face, when the host serves one. */
  scope?: QuotaSettingsScope<QuotaSection> | undefined
}

/** The section this card edits (mirrors the host Config's advanced fields). */
export interface QuotaSection {
  sidebarQuotaCN?: boolean
  sidebarQuotaGlobal?: boolean
  autoCheckInCN?: boolean
  autoCheckInGlobal?: boolean
  /** The one moment both variants check in at. */
  checkInMinute?: number
  quotaPollMs?: number
  /** The whole China variant's master switch (on by default). */
  variantEnabledCN?: boolean
  /** The whole global variant's master switch (on by default). */
  variantEnabledGlobal?: boolean
  /*
   * The failover and routing policy.
   *
   * These are the host Config's own field names, so the settings face can store
   * them verbatim; the card only decides how to present them. They are optional
   * because an older host serves a face without them, and a control whose
   * backing field the host does not own must not be rendered as if it wrote.
   */
  /** Whether a connection failure walks on to the next account at all. */
  autoFailoverEnabled?: boolean
  /** The queue-retry master switch (on by default; off reports a queue at once). */
  queueWaitEnabled?: boolean
  /** How many times a queued answer is retried (0 = report at once). */
  queueWaitAttempts?: number
  /** How long each queue retry waits, in seconds. */
  queueWaitSeconds?: number
  /** Which order the walk follows: the save order, or the user's own list. */
  routingStrategy?: 'save-order' | 'custom'
  /** The user's own routing order, account ids, highest priority first. */
  routingOrder?: string[]
  /** Master switch: when off, no session is pinned and the bounds are ignored. */
  stickinessEnabled?: boolean
  /** How many completed rounds one account serves before the session moves on. */
  stickinessRounds?: number
  /** How many requests one account serves before the session moves on. */
  stickinessRequests?: number
  /** How many minutes one account serves before the session moves on. */
  stickinessMinutes?: number
}

