/**
 * Qoder models for DeepSeek Harness, driven by Personal Access Tokens.
 * Registers one provider per product variant — `qoder` for the China region
 * and `qoder-global` for the international one — while streaming, tool calls,
 * compaction, and permissions stay Harness-owned.
 *
 * The two variants are assembled by the same factory and differ only in their
 * {@link QoderVariant} descriptor: each gets its own credential store,
 * transport, catalog, upstream client, shim, adapter, probe state, and routes.
 * Neither variant's startup, catalog fetch, or credential state can stop the
 * other from registering — a user with only one token sees only that group.
 *
 * @module dsh-qoder-plugin
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { SettingsNamespace } from '@deepseek-ai/dsh-settings'
import type { AttachmentStore } from '@deepseek-ai/dsh-attachment'
import { QoderCredentialStore, qoderCredentialIdentity, type QoderStoredAccount } from './auth.ts'
import { createAuthKey, registerQoderAuthRoute } from './auth-route.ts'
import { FALLBACK_QODER_MODELS, QoderCatalog } from './catalog.ts'
import { qoderCatalogPath, QoderCatalogStore } from './catalog-store.ts'
import { createQoderAdapter } from './adapter.ts'
import { createQoderShim } from './shim.ts'
import { QoderProbeService } from './probe-service.ts'
import { newestFirst, QoderProbeStore, qoderProbePath } from './probe-store.ts'
import { QoderUpstreamClient, validateApiKey } from './upstream.ts'
import { createQoderTransport, type QoderCheckInResult, type QoderPooledAccount, type QoderTransport } from './qoder/transport/index.ts'
import type { QoderRegion } from './qoder/region.ts'
import { getMachineId } from './qoder/transport/machine-id.ts'
import { readDeviceSeed, rotateDeviceSeed } from './qoder/transport/device-seed.ts'
import { registerQoderDeviceResetRoute, type QoderDeviceResetOutcome } from './device-reset-route.ts'
import { registerQoderStatusRoute, webPlan } from './web-status.ts'
import { createProbeKey, registerQoderProbeRoute } from './probe-route.ts'
import { CheckInScheduler, DEFAULT_CHECK_IN_MINUTE, JsonFileCheckInStore, normalizeCheckInMinute } from './checkin-scheduler.ts'
import { getClaimWindowDateString } from './claim-window.ts'
import type { QoderModelInfo } from './catalog.ts'
import type { QoderAccountHealth, QoderWebCatalog, QoderWebProbeSection, QoderWebUpstreamNotice } from './status-paths.ts'
import { QODER_SETTINGS_FACE_PATH } from './status-paths.ts'
import { clearHostHeartbeat, writeHostHeartbeat } from './host-heartbeat.ts'
import { emitJobTokenHint, emitJobTokenRefreshFailedHint, emitUpstreamNotice, installJobTokenHint } from './job-token-hint.ts'
import { formatQueueNotice, formatQueueWaitNotice } from './qoder/queue-notice.ts'
import { QoderAccountHealthTracker } from './account-health.ts'
import { SettingsStore } from './settings-store.ts'
import { QODER_CONNECT_VERSION } from './version.ts'
import { CHINA_VARIANT, GLOBAL_VARIANT, QODER_VARIANTS, type QoderVariant } from './variants.ts'

export { QODER_PROVIDER, QODER_STREAM_IDLE_TIMEOUT_MS, createQoderAdapter, type QoderAdapter } from './adapter.ts'
export { createQoderShim, type QoderShim, type ShimLogger } from './shim.ts'
export {
  FALLBACK_QODER_MODELS,
  QoderCatalog,
  type QoderModelBilling,
  type QoderModelInfo,
  type QoderModelReasoning,
} from './catalog.ts'
export { qoderCatalogPath, QoderCatalogStore, type QoderCatalogStoreOptions } from './catalog-store.ts'
export {
  fingerprintModel,
  QoderProbeStore,
  qoderProbePath,
  QODER_PROBE_FILENAME,
  type QoderProbeRecord,
  type QoderProbeValidation,
} from './probe-store.ts'
export {
  PROBE_EFFORT_CANDIDATES,
  randomSentinel,
  probeModel,
  type ProbeAttempt,
  type ProbeOutcome,
  type ProbeSender,
} from './probe.ts'
export { QoderProbeService, type QoderProbeStatus } from './probe-service.ts'
export {
  CHINA_VARIANT,
  GLOBAL_VARIANT,
  QODER_VARIANTS,
  variantFor,
  type QoderVariant,
  type QoderVariantId,
} from './variants.ts'
export {
  patTail,
  qoderCredentialIdentity,
  QoderCredentialStore,
  qoderOwnAuthPath,
  qoderPluginDataDir,
  QODER_AUTH_FILENAME,
  QODER_DATA_DIR_ENV,
  QODER_DATA_DIR_NAME,
  QODER_PAT_ENV_CN,
  QODER_PAT_ENV_GLOBAL,
  type QoderAuthStatus,
  type QoderCredential,
} from './auth.ts'
export {
  createAuthKey,
  qoderAuthHandler,
  registerQoderAuthRoute,
  type QoderAuthRouteOptions,
  type QoderAuthSaveResult,
} from './auth-route.ts'
export {
  QODER_AUTH_PATH,
  QODER_GLOBAL_AUTH_PATH,
  QODER_GLOBAL_PROBE_PATH,
  QODER_GLOBAL_STATUS_PATH,
  QODER_PROBE_PATH,
  QODER_STATUS_PATH,
  type QoderAuthRequest,
  type QoderCatalogModelSnapshot,
  type QoderPatSummary,
  type QoderProbeAction,
  type QoderWebCatalog,
  type QoderWebCredits,
  type QoderWebCreditAccount,
  type QoderWebProbeModel,
  type QoderWebProbeSection,
  type QoderWebStatus,
} from './status-paths.ts'
export {
  classifyUpstreamError,
  kindFromQoderFailure,
  KIND_STATUS,
  modelInfoOf,
  normalizeCredits,
  QoderUpstreamClient,
  type QoderCatalogFetch,
  type QoderChatResult,
  type QoderCredits,
  type QoderCreditAccount,
  type QoderEffort,
  type UpstreamErrorKind,
} from './upstream.ts'
export {
  QODER_HOST_HEARTBEAT_FILENAME,
  clearHostHeartbeat,
  isHeartbeatProcessAlive,
  processStartTimeMs,
  readHostHeartbeat,
  qoderHostHeartbeatPath,
  type QoderHostHeartbeat,
} from './host-heartbeat.ts'

/** Stable Cordis plugin name (matches the profile row id in cordis.patch.yml). */
export const name = 'qoder-plugin'

/** The model registry required before the provider can register. */
export const inject = ['llm']

/**
 * Settings namespace owning the China card's section.
 *
 * DSH 0.1.2 dropped the `settingsNamespace()` branding function: a namespace is
 * now a nominal string, validated by the type system where it is used rather
 * than at runtime by a function call. The brand is compile-time only, so this
 * stays the plain string it always was — every comparison, descriptor lookup,
 * and `dsh` config file still sees `'qoder'`. It is cast once here so the
 * public constant carries the seam's type without pulling the brand helper
 * into this package (upstream DSH plugins, `dsh-llm-pi-ai` included, pass
 * their namespaces as plain string literals).
 */
export const QODER_SETTINGS_NS = 'qoder' as SettingsNamespace

/**
 * Settings namespace owning the global card's section.
 *
 * One namespace per card, not one shared: the settings Plugins tab dispatches a
 * card by rendering `settings.plugin.item` with `entryKey = ns` for each
 * namespace the Host serves, and skips an entry whose key names no served
 * namespace. With a single installed section, the global card registers
 * into the slot but is never rendered — the card list is built from the Host's
 * sections, not from the slot's entries. Each card therefore needs its own
 * installed section whose namespace equals the card's slot key.
 */
export const QODER_GLOBAL_SETTINGS_NS = 'qoder-global' as SettingsNamespace

/**
 * How often the credential files are re-checked, in milliseconds.
 *
 * A startup-only catalog fetch cannot notice a token saved while DSH is
 * already running, so the model group would not appear until a restart. This
 * poll is a cheap existence/parse read of at most a few local files: it never
 * contacts the network and never runs a reasoning probe.
 *
 * `DSH_QODER_POLL_MS` overrides it. That exists so the sweep can be
 * exercised end to end in tests and shortened while diagnosing a slow
 * sign-in on a real machine; it is not a product setting and no UI exposes it.
 * The value is clamped to a sane range so a mistaken override cannot turn the
 * poll into a busy loop.
 */
const CREDENTIAL_POLL_MS = 30_000

/** Floor and ceiling for the overridable poll interval. */
const MIN_POLL_MS = 100
const MAX_POLL_MS = 24 * 60 * 60 * 1000

/** Resolve the sweep interval, honoring the override when it is usable. */
function credentialPollMs(): number {
  const override = Number(process.env['DSH_QODER_POLL_MS'])
  if (!Number.isFinite(override) || override < MIN_POLL_MS) return CREDENTIAL_POLL_MS
  return Math.min(override, MAX_POLL_MS)
}

/**
 * How long to wait before retrying a catalog fetch that failed.
 *
 * The credential sweep deliberately does not re-fetch a catalog it already has
 * (the same token carries no new model information). But a *failed* fetch must
 * not be treated the same way: without a retry, one transient network blip at
 * startup would leave the group on the built-in fallback roster until the user
 * noticed and pressed refresh. This bound keeps that recovery automatic while
 * still honoring the "not every round" rule — at most one attempt per
 * interval, and none at all once a live catalog lands.
 *
 * Expressed as a multiple of the sweep rather than a fixed duration so the two
 * stay in proportion under the `DSH_QODER_POLL_MS` override.
 */
const CATALOG_RETRY_SWEEPS = 10

/** Plugin configuration. */
export interface Config {
  /**
   * Whether the user has authorized sending probe requests about reasoning
   * efforts. Off by default: a probe spends real credit, so nothing is sent
   * until the user explicitly agrees.
   */
  probeConsent?: boolean
  /** Use the largest context window the global catalog explicitly offers. */
  useMaximumContextWindow?: boolean
  /** The China variant's own maximum-window preference, persisted in its section. */
  useMaximumContextWindowCN?: boolean
  /**
   * Per-model context-window overrides for the global variant (model id →
   * tokens). Kept for schema compatibility; the card no longer writes
   * per-model overrides because the upstream honours only the default and
   * the maximum, nothing between.
   */
  modelContextWindows?: Record<string, number>
  /** The China variant's per-model overrides; see {@link Config.modelContextWindows}. */
  modelContextWindowsCN?: Record<string, number>
  /** Models disabled for the global variant (blacklist). */
  disabledModels?: string[]
  /** Models disabled for the China variant (blacklist). */
  disabledModelsCN?: string[]
  /**
   * Master switch for the whole China variant (on by default).
   *
   * Off means the provider serves NO China model at all — the model picker
   * hides the group — while the plugin card keeps listing the roster so the
   * switch can be turned back on. Distinct from {@link Config.disabledModelsCN},
   * which is a per-model blacklist.
   */
  variantEnabledCN?: boolean
  /** The global variant's master switch; see {@link Config.variantEnabledCN}. */
  variantEnabledGlobal?: boolean
  /**
   * Legacy sidebar-quota toggle, kept so older settings files still parse.
   *
   * The sidebar card was removed in 0.4.0 and the composer readout replaced it,
   * so this field has no effect. It stays declared because dropping a field from
   * the schema would make an existing file's value unreadable rather than inert.
   */
  sidebarQuotaCN?: boolean
  /** Legacy global-variant sidebar toggle; see {@link Config.sidebarQuotaCN}. */
  sidebarQuotaGlobal?: boolean
  /** Automatically check in daily at 10:00 (UTC+8) to claim credits for China variant. */
  autoCheckInCN?: boolean
  /** Automatically check in daily at 10:00 (UTC+8) to claim credits for Global variant. */
  autoCheckInGlobal?: boolean
  /**
   * When BOTH variants check in, as minutes past midnight in UTC+8 (600 = 10:00).
   *
   * One shared setting: the two products' campaigns reset at the same moment,
   * so the card edits this field alone.
   */
  checkInMinute?: number
  /**
   * Sidebar quota refresh interval in milliseconds. One shared value (both
   * cards poll on it) because the two widgets hit the same rate-limited
   * billing family; the floor guards against a typo hammering the quota
   * endpoint, which serves no cache.
   */
  quotaPollMs?: number
  /**
   * Whether a failure may move the request to the next account.
   *
   * On by default, but a real setting rather than an implicit constant: with
   * one account it changes nothing, yet the user must be able to turn the
   * behaviour off without deleting accounts.
   */
  autoFailoverEnabled?: boolean
  /**
   * The queue-retry master switch.
   *
   * On by default so an existing document keeps the behaviour it already had;
   * off makes the transport treat every queue answer as final, whatever the
   * two bounds below say. The switch exists because "0 retries" and "retries
   * off" are different statements: the first is a bound the user can move, the
   * second is a decision to stop waiting for a busy model at all.
   */
  queueWaitEnabled?: boolean
  /**
   * How many times a queued answer is retried before it is reported.
   *
   * 0 means "report immediately" (the pre-existing behaviour); each retry
   * waits {@link Config.queueWaitSeconds} first. Bounded so a typo cannot pin
   * a request in the transport for hours.
   */
  queueWaitAttempts?: number
  /** How long each queue retry waits, in seconds. */
  queueWaitSeconds?: number
  /** Which order the failover walk follows. */
  routingStrategy?: 'save-order' | 'custom'
  /**
   * Account ids in the walk order, when `routingStrategy` is `custom`.
   *
   * One list spans BOTH variants: an id names its own variant, and each
   * variant's walk skips ids that are not its own. That is what "mixed
   * ordering" means here — the list can express "global account first, China
   * account second", while a single request still has to be served by the
   * region its model belongs to.
   */
  routingOrder?: string[]
  /**
   * Conversation stickiness master switch. When off (explicitly `false`), no
   * account is ever pinned: every request picks one fresh, whatever the three
   * bounds below say. Defaults to on.
   */
  stickinessEnabled?: boolean
  /**
   * Conversation stickiness: how many completed rounds one account serves
   * before the session moves to the next account. 0 disables round counting.
   */
  stickinessRounds?: number
  /**
   * Conversation stickiness: how many requests one account serves before the
   * session moves to the next account. 0 disables request counting.
   */
  stickinessRequests?: number
  /** Conversation stickiness: how many minutes one account serves. 0 disables. */
  stickinessMinutes?: number
}

/**
 * Mark one configuration field as a live projected setting, when the host has
 * that concept at all.
 *
 * DSH 0.1.7 projects a `.volatile()` field into the profile's settings form and
 * hands the plugin a STABLE REFERENCE instead of the value; a field without the
 * mark never reaches the form — `dsh-settings`' `describe()` skips an entry
 * whose schema has no volatile field (`lib/index.js:411-421`), which is exactly
 * what makes the browser-side `configForms` namespace exist. DSH 0.1.5's
 * schemastery has no `volatile` at all, so calling it there is a `TypeError`
 * that would take the whole plugin down with it. The method is therefore
 * probed, never assumed.
 *
 * Only TOP-LEVEL fields are marked: a volatile field may not sit inside another
 * volatile field, and schemastery rejects a volatile node reached through a
 * collection (`validateVolatileSchema`), while the 0.1.7 client writes a single
 * path segment (`ConfigFormController.set` → `path: [field]`). Every field this
 * plugin exposes is already a top-level member of {@link Config}, so marking
 * the field itself is both legal and the only granularity the write path can
 * address.
 *
 * @param field - the field's schema.
 * @returns the projected schema on a host that supports projection, else the field itself.
 */
function volatileField<T extends object>(field: T): T {
  const probe = field as unknown as { volatile?: () => T; extra?: (key: string, value: unknown) => T; meta?: Record<string, unknown> }
  if (typeof probe.volatile === 'function') return probe.volatile()
  if (typeof probe.extra === 'function') return probe.extra('volatile', true)
  if (probe && typeof probe === 'object') {
    probe.meta = { ...probe.meta, volatile: true }
    return probe as T
  }
  return field
}

/**
 * Read one configuration field through the volatile indirection.
 *
 * On DSH 0.1.7 a `.volatile()` field arrives as a reference object whose value
 * is read with `.get()` (`@deepseek-ai/dsh-agent-default-model`,
 * `lib/index.js:38-41`); on DSH 0.1.5 the plain value arrives directly. Every
 * read of a projected field goes through here, so both hosts yield the value
 * itself.
 *
 * @param config - the raw plugin configuration, in either host's shape.
 * @param field - field name inside the configuration object.
 * @returns the field's value, or undefined when the field is absent.
 */
function readField(config: Config | undefined, field: keyof Config): unknown {
  const value = (config as Record<string, unknown> | undefined)?.[field]
  return value !== null && typeof value === 'object' && typeof (value as { get?: unknown }).get === 'function'
    ? (value as { get: () => unknown }).get()
    : value
}

/**
 * Read one declared field with its declared type.
 *
 * The typed face of {@link readField}, for the few call sites that want a
 * single field rather than a whole {@link readConfig}.
 *
 * @param config - the raw plugin configuration, in either host's shape.
 * @param field - field name inside the configuration object.
 * @returns the field's plain value, or undefined when it is absent.
 */
function readConfigField<K extends keyof Config>(config: Config | undefined, field: K): Config[K] {
  return readField(config, field) as Config[K]
}

/** Probe authorization (shared by the plugin schema and the China section). */
const PROBE_CONSENT_FIELD = volatileField(z.boolean().default(false)
  .description('Authorize reasoning-effort probes (each probe sends real requests that may consume credit)'))
const MAXIMUM_CONTEXT_WINDOW_FIELD = volatileField(z.boolean().default(true)
  .description('Use the largest context window declared by Qoder Global when alternatives are available (on by default)'))
/** The China variant's own maximum-window preference. */
const MAXIMUM_CONTEXT_WINDOW_CN_FIELD = volatileField(z.boolean().default(true)
  .description('Use the largest context window declared by Qoder (China) when alternatives are available (on by default)'))
/**
 * Per-model window overrides (model id → tokens). The card writes one entry
 * per selector change; the field is optional so an absent map means "no
 * overrides" rather than a default object the host must keep in sync.
 */
const MODEL_CONTEXT_WINDOWS_FIELD = volatileField(z.dict(z.number().min(1), z.string())
  .description('Per-model context-window overrides for Qoder Global (model id → tokens)'))
/** Disabled models list (blacklist) */
const DISABLED_MODELS_FIELD = volatileField(z.array(z.string()).default([])
  .description('Models hidden from the provider catalog and picker'))
/**
 * The whole-variant master switch (one per variant).
 *
 * On by default: an existing profile keeps serving both products. Off makes
 * the provider expose none of that variant's models, while the card still
 * lists them (see `QoderCatalog.setEnabled`).
 */
const VARIANT_ENABLED_FIELD = volatileField(z.boolean().default(true)
  .description('启用该版本的全部模型（默认开启）'))
/**
 * Legacy sidebar-quota toggle (one per variant).
 *
 * The sidebar card no longer exists — the composer readout shows credits — so
 * this field is declared only so older settings files keep validating. The
 * description says as much, because the settings reference documents it as a
 * no-op and a promise of a sidebar card here would contradict that.
 */
const QUOTA_TOGGLE_FIELD = volatileField(z.boolean().default(false)
  .description('历史字段：侧栏额度卡已取消，此开关不再有任何效果（保留仅为兼容旧配置文件）'))
/** Automatic check-in toggle. */
const AUTO_CHECK_IN_FIELD = volatileField(z.boolean().default(false)
  .description('每天自动签到领取算力额度（默认关闭）'))
/**
 * The SHARED check-in moment (one control for both variants), as minutes past
 * midnight in UTC+8.
 *
 * Stored as a plain minute count rather than a "HH:mm" string so the schema
 * itself rejects an impossible time: a browser time input yields 0–1439, and
 * anything outside that range fails Host validation instead of silently
 * scheduling a request at a moment that never arrives.
 */
const CHECK_IN_MINUTE_FIELD = volatileField(z.number()
  .default(DEFAULT_CHECK_IN_MINUTE)
  .min(0)
  .max(1439)
  .description('国内版与国际版共用的每日自动签到时刻（自 UTC+8 午夜起的分钟数，600 = 10:00）'))
/**
 * Quota poll interval: default 5 minutes, floor 1 minute. The status route
 * performs a live upstream billing call per request with no cache, so an
 * aggressively small interval translates directly into upstream load; the
 * floor is the smallest value the UI offers rather than a silent clamp —
 * smaller staged values fail Host validation and refuse to save.
 */
export const QUOTA_POLL_DEFAULT_MS = 300_000
export const QUOTA_POLL_MIN_MS = 60_000
const QUOTA_POLL_FIELD = volatileField(z.number()
  .default(QUOTA_POLL_DEFAULT_MS)
  .min(QUOTA_POLL_MIN_MS)
  .description('Sidebar quota card refresh interval in milliseconds (default 300000, minimum 60000)'))

/** Automatic failover master switch (on by default; one account makes it inert). */
const AUTO_FAILOVER_FIELD = volatileField(z.boolean().default(true)
  .description('账号连接失败时自动切换到下一个账号（默认开启）'))
/** Queue wait master switch: off reports a queued answer at once (on by default). */
const QUEUE_WAIT_ENABLED_FIELD = volatileField(z.boolean()
  .default(true)
  .description('排队重试总开关：关闭后上游排队直接报错，不再等待重试（默认开启）'))
/** Queue wait retry count: 0 = report at once, 1..10 retries. */
const QUEUE_WAIT_ATTEMPTS_FIELD = volatileField(z.number()
  .default(0)
  .min(0)
  .max(10)
  .description('上游排队时的重试次数（0 = 不重试，最多 10 次）'))
/** Queue wait seconds per retry: 1..300. */
const QUEUE_WAIT_SECONDS_FIELD = volatileField(z.number()
  .default(30)
  .min(1)
  .max(300)
  .description('每次排队重试前等待的秒数（1–300）'))
/** Routing strategy: save order, or the user's own order. */
const ROUTING_STRATEGY_FIELD = volatileField(z.union([
  z.const('save-order'),
  z.const('custom'),
]).default('save-order')
  .description('账号试用顺序：save-order = 保存顺序，custom = 自定义优先级'))
/** The user's own account order (ids across both variants). */
const ROUTING_ORDER_FIELD = volatileField(z.array(z.string()).default([])
  .description('自定义账号优先级（可跨国内/国际版混排，顺序即试用顺序）'))
/** Stickiness master switch: off hides the three bounds and disables stickiness. */
const STICKINESS_ENABLED_FIELD = volatileField(z.boolean()
  .default(true)
  .description('会话粘性总开关：关闭后不再保持同一账号，每次请求都重新选择账号'))
/** Stickiness rounds: 0 disables. Default 3 — three rounds per account. */
const STICKINESS_ROUNDS_FIELD = volatileField(z.number()
  .default(3)
  .min(0)
  .max(100)
  .description('会话粘性：同一账号连续服务多少轮对话后自动换到下一个账号（0 = 不限制）'))
/** Stickiness requests: 0 disables. Default 200. */
const STICKINESS_REQUESTS_FIELD = volatileField(z.number()
  .default(200)
  .min(0)
  .max(10_000)
  .description('会话粘性：同一账号连续服务多少次请求后自动换到下一个账号（0 = 不限制）'))
/** Stickiness minutes: 0 disables. Default 180. */
const STICKINESS_MINUTES_FIELD = volatileField(z.number()
  .default(180)
  .min(0)
  .max(1440)
  .description('会话粘性：同一账号连续服务多少分钟后自动换到下一个账号（0 = 不限制）'))

export const Config: z<Config> = z.object({
  probeConsent: PROBE_CONSENT_FIELD,
  useMaximumContextWindow: MAXIMUM_CONTEXT_WINDOW_FIELD,
  useMaximumContextWindowCN: MAXIMUM_CONTEXT_WINDOW_CN_FIELD,
  modelContextWindows: MODEL_CONTEXT_WINDOWS_FIELD,
  modelContextWindowsCN: MODEL_CONTEXT_WINDOWS_FIELD,
  // The disabled-model lists live at the TOP level, and they must: DSH 0.1.7
  // projects an entry's settings form from this schema (its `describe()` reads
  // `entry.fiber.runtime.Config`), so a field that is not declared here reaches
  // neither the settings document nor the Models page's provider directory —
  // which is exactly how "设置-模型 里看不到模型开关" happened. They used to
  // live only in the 0.1.5 per-card sections (CHINA_SECTION/GLOBAL_SECTION),
  // which 0.1.7 has no concept of.
  disabledModels: DISABLED_MODELS_FIELD,
  disabledModelsCN: DISABLED_MODELS_FIELD,
  variantEnabledCN: VARIANT_ENABLED_FIELD,
  variantEnabledGlobal: VARIANT_ENABLED_FIELD,
  sidebarQuotaCN: QUOTA_TOGGLE_FIELD,
  sidebarQuotaGlobal: QUOTA_TOGGLE_FIELD,
  autoCheckInCN: AUTO_CHECK_IN_FIELD,
  autoCheckInGlobal: AUTO_CHECK_IN_FIELD,
  checkInMinute: CHECK_IN_MINUTE_FIELD,
  quotaPollMs: QUOTA_POLL_FIELD,
  autoFailoverEnabled: AUTO_FAILOVER_FIELD,
  queueWaitEnabled: QUEUE_WAIT_ENABLED_FIELD,
  queueWaitAttempts: QUEUE_WAIT_ATTEMPTS_FIELD,
  queueWaitSeconds: QUEUE_WAIT_SECONDS_FIELD,
  routingStrategy: ROUTING_STRATEGY_FIELD,
  routingOrder: ROUTING_ORDER_FIELD,
  stickinessEnabled: STICKINESS_ENABLED_FIELD,
  stickinessRounds: STICKINESS_ROUNDS_FIELD,
  stickinessRequests: STICKINESS_REQUESTS_FIELD,
  stickinessMinutes: STICKINESS_MINUTES_FIELD,
})

/**
 * Every field each settings section owns, and therefore every field the live
 * configuration has to carry through.
 *
 * One list per section, shared by the merge and by the test that pins it to
 * the schema. Writing the merge out by hand is what broke auto check-in: the
 * `qoder-quota` section grew four fields (`autoCheckInCN`, `autoCheckInGlobal`,
 * `checkInMinute`, `quotaPollMs`) while the merge kept copying only the three
 * that predated them, so `current().autoCheckInCN` read `undefined` forever and
 * the scheduler saw the toggle as permanently off. The card saved it, the file
 * held it, and nothing ever acted on it.
 */
export const CN_SECTION_KEYS = [
  'probeConsent',
  'useMaximumContextWindowCN',
  'modelContextWindowsCN',
  'disabledModelsCN',
  'variantEnabledCN',
] as const satisfies readonly (keyof Config)[]

export const GLOBAL_SECTION_KEYS = [
  'useMaximumContextWindow',
  'modelContextWindows',
  'disabledModels',
  'variantEnabledGlobal',
] as const satisfies readonly (keyof Config)[]

export const QUOTA_SECTION_KEYS = [
  'sidebarQuotaCN',
  'sidebarQuotaGlobal',
  'autoCheckInCN',
  'autoCheckInGlobal',
  'checkInMinute',
  'quotaPollMs',
  'autoFailoverEnabled',
  'queueWaitEnabled',
  'queueWaitAttempts',
  'queueWaitSeconds',
  'routingStrategy',
  'routingOrder',
  'stickinessEnabled',
  'stickinessRounds',
  'stickinessRequests',
  'stickinessMinutes',
] as const satisfies readonly (keyof Config)[]

/** Every declared configuration field, in the order the sections are merged. */
const CONFIG_KEYS = [
  ...CN_SECTION_KEYS,
  ...GLOBAL_SECTION_KEYS,
  ...QUOTA_SECTION_KEYS,
] as const satisfies readonly (keyof Config)[]

/** Copy the declared fields off one section's source, skipping absent ones. */
function pickFields<K extends keyof Config>(
  source: () => Config | undefined,
  keys: readonly K[],
): Partial<Config> {
  const value = source()
  const picked: Partial<Config> = {}
  for (const key of keys) {
    // Through `readField`: on 0.1.7 the source's projected fields are
    // references, and a reference must never be copied into the merged
    // configuration the rest of the plugin compares against.
    const field = readField(value, key)
    if (field !== undefined) (picked as Record<string, unknown>)[key] = field
  }
  return picked
}

/**
 * Unwrap a whole configuration object into plain values.
 *
 * The merged configuration is read through {@link pickFields}/{@link readField}
 * everywhere else, but the plugin also reads its initial config directly while
 * it assembles its runtimes — before any settings section has handed over a
 * source. On 0.1.7 those direct reads would otherwise compare a reference
 * object against `true`/`undefined` and silently see "not set" for every field.
 *
 * @param config - the raw plugin configuration, in either host's shape.
 * @returns the same configuration with every declared field read out.
 */
function readConfig(config: Config | undefined): Config {
  return pickFields(() => config, CONFIG_KEYS)
}

/** One variant's live runtime, assembled by {@link createVariantRuntime}. */
interface VariantRuntime {
  variant: QoderVariant
  store: QoderCredentialStore
  client: QoderUpstreamClient
  transport: QoderTransport
  catalog: QoderCatalog
  probeStore: QoderProbeStore
  probeService: QoderProbeService
  /**
   * The last catalogs that loaded, keyed by account.
   *
   * Sits between the live fetch and the built-in roster in the degradation
   * order: a restart, or a fetch that fails while offline, serves what this
   * token was last actually shown instead of the one-off snapshot compiled
   * into the plugin.
   */
  savedCatalogs: QoderCatalogStore
  /** The static roster this variant falls back to. */
  fallback: readonly QoderModelInfo[]
  /**
   * Where the served models came from, in degradation order:
   * `live` (fetched now) → `saved` (this account's last successful fetch) →
   * `fallback` (the roster compiled into the plugin).
   */
  catalogSource: 'live' | 'saved' | 'fallback'
  /** When the served catalog was fetched, for `live` and `saved`. */
  catalogFetchedAtMs: number | undefined
  /** Why the last catalog attempt failed, when it did. */
  catalogError: string | undefined
  /** When the last catalog attempt started, for the retry backoff. */
  lastFetchAtMs: number
  /**
   * Bumped whenever this variant's catalog generation changes — a token
   * switch, a sign-out, or a new fetch superseding an older one. A request
   * carries the generation it started under and refuses to write back if the
   * generation has moved on, so a slow answer can never resurrect data the
   * plugin has since decided to drop (spec §5: late responses are discarded).
   */
  catalogGeneration: number
  /**
   * The in-flight catalog fetch, scoped to the identity and generation it began
   * under. A caller may only join the same scope; a token change cancels the
   * old request and immediately starts one for the newly adopted account.
   */
  inflightFetch: CatalogFetch | undefined
  /** Notify the model directory that this variant's answers changed. */
  invalidate: () => void
  /** Whether the provider registered successfully. */
  registered: boolean
  /**
   * When the self-heal last auto-refreshed this variant's job token, epoch ms.
   * Recorded by the transport's `onJobTokenRefreshed` callback and surfaced on
   * the card's status document, so the otherwise invisible recovery shows.
   */
  jobTokenRefreshedAt: () => number | undefined
  /**
   * Claim today's daily benefit for this variant's account.
   *
   * A capability the check-in scheduler and the card's manual button both
   * need, surfaced as a named field rather than read out of the transport with
   * an `as unknown as` cast: such a cast fails silently (a renamed private
   * field turns every check-in into a no-op) instead of failing to compile.
   */
  checkIn: (signal?: AbortSignal) => Promise<QoderCheckInResult>
  /**
   * The last upstream "not serviceable" answer for this variant.
   *
   * Recorded when a chat ends on the upstream's own saturated-queue reply, and
   * cleared when a later chat is accepted: the notice describes a live
   * condition, so it must not outlive the condition it explains. `occurrences`
   * counts how many times the answer has come back since the last success,
   * which is what separates a one-off queue from an account that upstream keeps
   * refusing.
   */
  upstreamNotice: () => QoderWebUpstreamNotice | undefined
  /**
   * When the pool last moved off a failed account, and why. Epoch ms.
   *
   * Surfaced on the card so an automatic switch is visible after the fact: the
   * request that triggered it failed, so nothing in the conversation says which
   * subscription ended up paying for the retry.
   */
  failoverAt: () => number | undefined
  failoverReason: () => string | undefined
  /**
   * What one pooled account has shown lately, for the card's health label.
   *
   * Read through the recognizer rather than exposing the tracker itself, so the
   * status route cannot accidentally record an observation while rendering —
   * health is fed from upstream answers only.
   */
  healthOf: (accountId: string) => QoderAccountHealth | undefined
  /**
   * Drop one account's health observations.
   *
   * Called when the user parks or removes an account: the label describes the
   * last few minutes of a running process, and an account that was out of
   * rotation for a while has had nothing asked of it, so the previous verdict
   * no longer describes anything real.
   */
  forgetHealth: (accountId: string) => void
}

/** One catalog request plus the identity state it is allowed to update. */
interface CatalogFetch {
  identity: string
  generation: number
  controller: AbortController
  promise: Promise<void>
}

/** Stable identity key used by credentials, probe records, and catalog entries. */
const credentialIdentity = qoderCredentialIdentity

/** The settings namespace a variant's card and provider directory entry use. */
function settingsNamespaceFor(variant: QoderVariant): SettingsNamespace {
  return variant.id === CHINA_VARIANT.id ? QODER_SETTINGS_NS : QODER_GLOBAL_SETTINGS_NS
}

/**
 * The static catalog a variant serves before its first successful fetch.
 *
 * Both regions share one roster transcribed from the transport's built-in
 * model defaults: unlike the WorkBuddy-era endpoints, the Qoder pools are
 * region-specific only in what discovery lists, and inventing a second roster
 * from nothing would misdescribe whichever variant it was not captured from.
 */
function fallbackFor(_variant: QoderVariant): readonly QoderModelInfo[] {
  return FALLBACK_QODER_MODELS
}

/**
 * The hint row's summary line: what happened, and when.
 *
 * Named here rather than in the hint module because the text is this plugin's
 * user-facing wording, and the transport callback that produces it runs before
 * the plugin's own scope exists.
 */
function jobTokenHintText(at: number): string {
  const time = new Date(at).toLocaleTimeString('zh-CN', { hour12: false })
  return `jobToken 已自动刷新（${time}）— 旧令牌被上游拒绝，已自动重换并恢复`
}

/**
 * The failed-heal row's summary line.
 *
 * Deliberately does not name a cause: the upstream rejection that survived a
 * fresh token is not necessarily an authorization problem at all, and the real
 * reason travels in the failure message itself (see the SSE envelope body).
 * Claiming "quota" or "revoked" here would be a guess presented as a finding.
 *
 * It also must not point the reader at "the error above": the failed heal does
 * not always belong to a chat whose failure renders a card in this
 * conversation. A heal inside the session-title request — same transport,
 * same shared notice state — fails silently there, so the row used to send
 * users looking for an error card that does not exist. The row states only
 * what is known: the retry ran, it did not recover, the request failed.
 */
function jobTokenRefreshFailedHintText(at: number): string {
  const time = new Date(at).toLocaleTimeString('zh-CN', { hour12: false })
  return `jobToken 已重换但仍被上游拒绝（${time}）— 自愈未恢复，该请求已失败`
}

/**
 * The conversation row written when an automatic account switch happens.
 *
 * The row carries the visible copy (the card's tag only reports the state
 * afterwards), and it says what actually happened rather than naming the
 * account: the row is appended to whichever conversation was running, and this
 * module has only the redacted reason the transport classified — never a token,
 * never an upstream body. A switch caused by a queue answer is reported by
 * {@link formatQueueNotice} instead; this one is the connection/interruption
 * case, where there is no upstream explanation to quote.
 */
function failoverNoticeText(reason: string): string {
  return `已自动切换到下一个账号重试（原因：${reason}）— 当前请求由备用账号继续`
}

/**
 * Whether a connection failure could be absorbed by switching accounts.
 *
 * This is the derived fact the card's 「自动切换」 tag reports, and it is not the
 * same claim as the user's setting: the walk needs somewhere to go, so a pool
 * with no second usable seat cannot fail over even with the switch on. Parked
 * seats are out of the walk (`accountById` refuses them), so they must not
 * count towards "another account exists" — otherwise a two-seat pool with the
 * spare parked would still advertise automatic switching.
 *
 * Kept as a named function because the host's status document is assembled
 * inline, and this is the one part of it a test can pin without booting a
 * whole fiber.
 */
export function autoFailoverActive(
  enabled: boolean | undefined,
  entries: readonly { readonly enabled?: boolean }[],
): boolean {
  if (enabled === false) return false
  return entries.filter(entry => entry.enabled !== false).length > 1
}

/**
 * Every seat in the pool, flattened into the shape {@link autoFailoverActive}
 * reads: one flag per row, `enabled: false` for a parked one.
 *
 * Reading both files is what makes the derived 「自动切换」 fact honest for a
 * mixed pool. It costs two file reads per status request — the same reads the
 * walk itself does, and the document is assembled on demand rather than polled
 * in a tight loop.
 */
export async function poolSeatFlags(
  members: readonly PoolMember[],
): Promise<readonly { readonly enabled?: boolean }[]> {
  /*
   * One seat per account id, and a seat is usable when ANY copy of it is.
   *
   * Both rules follow {@link poolRing}: the same PAT saved in both files is one
   * account, not two, and because the ring skips a parked row and takes the
   * other file's copy, a parked duplicate must not make the seat count as
   * unusable either. Without this the derived 「自动切换」 fact could advertise
   * failover on the strength of a duplicate row — and a duplicate row is
   * exactly the configuration that used to break the walk.
   */
  const seats = new Map<string, boolean>()
  for (const member of members) {
    for (const account of await member.store.list()) {
      seats.set(account.id, (seats.get(account.id) ?? false) || account.enabled !== false)
    }
  }
  return [...seats.values()].map(usable => (usable ? {} : { enabled: false }))
}

/**
 * Move the stored active pointer to the account a failover just switched to.
 *
 * The retry itself is already answering with the successor's PAT, so this move
 * only decides which account every LATER read (catalog, credits, the card)
 * resolves. A refusal is therefore harmless to the request in flight: the id
 * can go stale between the transport's walk and this write when the account is
 * removed in another tab, and a failed adoption must not turn a recovered
 * request into an error. The caller still records the switch and still reports
 * it — the switch did happen, only its stored pointer is behind. Returns
 * whether the pointer moved; warns with the reason when it did not.
 */
export async function adoptFailoverAccount(
  store: Pick<QoderCredentialStore, 'activate'>,
  accountId: string,
  warn: (message: string) => void,
): Promise<boolean> {
  try {
    await store.activate(accountId)
    return true
  } catch (error: unknown) {
    warn(
      `dsh-qoder-plugin: could not adopt the failover account (${accountId}): ${error instanceof Error ? error.message : String(error)}`,
    )
    return false
  }
}

/**
 * One account as the cross-variant walk sees it, with the variant that stores it.
 *
 * An account is always OWNED by exactly one variant's credential file: that is
 * where its row lives, that is the region stamped on it, and that is the only
 * endpoint set that may sign it. The pool layer never moves a row between
 * files — it only decides which of the two files the walk visits next, and
 * carries the owning variant's region along so the transport can sign with the
 * endpoints the account was saved under.
 */
export interface PoolMember {
  /** Only the id is read: the pool never asks a member about its own routes. */
  readonly variant: Pick<QoderVariant, 'id'>
  /** The three reads/writes the pool performs on a member's credential file. */
  readonly store: Pick<QoderCredentialStore, 'byId' | 'list' | 'activate'>
}

/**
 * The walk's view of the pool: this variant's file first, then its siblings.
 *
 * Local-first is not cosmetic — it is what keeps a single-region install
 * byte-for-byte unchanged. The sibling contributes no rows there, so every
 * resolution lands on the same store the walk always used, and the extra reads
 * are two cheap file misses. For a mixed pool it also gives the save-order walk
 * a sane continuation: this file ends, and the walk resumes in the other one
 * instead of looping back to an account it has already tried.
 */
export function poolOrder(pool: () => readonly PoolMember[], variant: Pick<QoderVariant, 'id'>): readonly PoolMember[] {
  const all = pool()
  const own = all.filter(runtime => runtime.variant.id === variant.id)
  const siblings = all.filter(runtime => runtime.variant.id !== variant.id)
  return [...own, ...siblings]
}

/**
 * The variant whose credential file stores `accountId`, if any file holds it.
 *
 * The same PAT can be saved in both files (the copy-paste case {@link poolRing}
 * collapses), and one copy can be parked while the other is usable. The pool
 * decides a seat is usable when ANY copy is, so the file named here is the one
 * holding a usable copy: moving the active pointer in the parked file would
 * leave the account that actually serves requests unpinned.
 */
export async function poolOwner(
  order: readonly PoolMember[],
  accountId: string,
): Promise<PoolMember | undefined> {
  for (const runtime of order) {
    const found = await runtime.store.byId(accountId)
    if (found === undefined || found.enabled === false) continue
    return runtime
  }
  // Every copy is parked: the id names no usable seat, which is the same answer
  // the ring gives, and a switch to it must warn rather than adopt.
  return undefined
}

/**
 * Project one stored row the way the transport consumes it: id, PAT, region.
 *
 * The region is the row's OWN stamp (written by whichever file stores it, never
 * trusted from disk), and it is the only thing that tells the transport which
 * endpoint set may sign this credential. Dropping it here is what used to make
 * every cross-variant hand-off an AUTH failure.
 */
function pooledAccount(account: QoderStoredAccount): QoderPooledAccount {
  return { id: account.id, pat: account.pat, region: account.region }
}

/**
 * By-id resolution across the pool, for custom routing and pinned sessions.
 *
 * The id is a hash of the PAT, so a row normally lives in one file — but the
 * same PAT saved in both files gives the id two copies, and one copy can be
 * parked while the other is usable. {@link poolRing} seats the id when ANY copy
 * is usable, so resolution has to agree: a parked copy must not hide the usable
 * one, or a seat the ring hands the walk becomes one the walk cannot name. A row
 * no file holds resolves to nothing, which is how the walk skips an account
 * removed in another tab.
 */
export async function pooledAccountById(
  order: readonly PoolMember[],
  accountId: string,
): Promise<QoderPooledAccount | undefined> {
  for (const runtime of order) {
    const found = await runtime.store.byId(accountId)
    if (found === undefined || found.enabled === false) continue
    return pooledAccount(found)
  }
  return undefined
}

/**
 * The pool as one ordered ring: every file's usable rows, local file first.
 *
 * Each file keeps its own save order, and the pool is their concatenation —
 * the same local-first order {@link poolOrder} gives the walk. Parked rows are
 * dropped here rather than skipped later, because the ring's answer must not
 * depend on which file it happens to look in: the transport treats "not in the
 * pool" and "parked" identically, and building the ring once is what lets the
 * walk continue into the sibling file at exactly the point its own file ends.
 *
 * Reading the files costs one `list()` per variant per step. That is the same
 * on-demand read the store already does for every `nextAfter` call, and the
 * pool has two files at most.
 */
export async function poolRing(order: readonly PoolMember[]): Promise<readonly QoderPooledAccount[]> {
  const ring: QoderPooledAccount[] = []
  /*
   * ONE seat per account id, even when both files hold the same row.
   *
   * The id is a hash of the PAT, so the same PAT saved in both files — a
   * copy-paste misconfiguration, and the only way one row can appear twice —
   * arrives here as the same id twice. That used to reach the transport as two
   * seats, and the walk reads a repeated id as "already tried" and STOPS the
   * whole lap, so every account after the duplicate became unreachable rather
   * than just the duplicate's twin. Dropping the copy keeps the ring's promise
   * that each id names one seat; the first file to hold it wins, which is the
   * same precedence {@link pooledAccountById} resolves the id with.
   */
  const seen = new Set<string>()
  for (const runtime of order) {
    for (const account of await runtime.store.list()) {
      if (account.enabled === false) continue
      if (seen.has(account.id)) continue
      seen.add(account.id)
      ring.push(pooledAccount(account))
    }
  }
  return ring
}

/**
 * How many accounts the pool has SAVED, parked ones included.
 *
 * Distinct ids across every file, so a PAT stored in both files counts once —
 * the same identity rule {@link poolRing} uses, minus the usability filter. The
 * device-code reset rotates one host-level seed, which re-identifies a parked
 * account exactly like a serving one, so this is the number the card reports.
 */
export async function savedAccountCount(pool: () => readonly PoolMember[]): Promise<number> {
  const saved = new Set<string>()
  for (const runtime of pool()) {
    for (const account of await runtime.store.list()) saved.add(account.id)
  }
  return saved.size
}

/**
 * The account after `accountId`, continuing across the pool's files.
 *
 * This is the save-order leg. Within one file it is exactly the store's own
 * `nextAfter`; at the end of a file the walk continues with the NEXT file's
 * first row, and only after the last file does it wrap to the pool's first
 * row. That is the difference from the per-file walk: it used to wrap inside
 * its own document, so an account in the other variant's file was never
 * reached by save order at all — the very leg the two-file pool was supposed
 * to extend.
 *
 * An id no file holds (removed in another tab, or the step after a pin to a
 * since-deleted account) restarts the ring at its first row instead of
 * dead-ending, which is the same "one silent extra lap" the per-file walk
 * always had, now spanning the pool. The transport's own `tried` set is what
 * stops a lap from repeating.
 */
export async function pooledNextAccount(
  order: readonly PoolMember[],
  accountId: string,
): Promise<QoderPooledAccount | undefined> {
  const ring = await poolRing(order)
  if (ring.length === 0) return undefined
  const index = ring.findIndex(account => account.id === accountId)
  if (index === -1) return ring[0]
  return ring[(index + 1) % ring.length]
}

/**
 * Move the active pointer in whichever file stores the account a switch chose.
 *
 * The pointer that has to move is the OWNING variant's — the card, the catalog
 * and the credits all resolve "the active account" out of their own file, so a
 * cross-region switch that only warned would leave the card pointing at the
 * account that just failed while the request signs as the sibling's. The
 * per-file semantics stay intact: a variant's file still records exactly one
 * active row, it is just chosen by whoever owns the row.
 */
export async function adoptPooledAccount(
  order: readonly PoolMember[],
  accountId: string,
  warn: (message: string) => void,
): Promise<boolean> {
  const owner = await poolOwner(order, accountId)
  if (owner === undefined) {
    warn(`dsh-qoder-plugin: could not adopt the failover account (${accountId}): no variant can serve it`)
    return false
  }
  return await adoptFailoverAccount(owner.store, accountId, warn)
}

/** Build one variant's stores, transport, and probe state. */
function createVariantRuntime(
  ctx: Context,
  config: Config,
  variant: QoderVariant,
  current: () => Config,
  identityOf: (variantId: string) => string | undefined,
  pool: () => readonly VariantRuntime[],
  health: QoderAccountHealthTracker,
): VariantRuntime {
  const store = new QoderCredentialStore({ variant, logger: ctx.logger })
  // The self-heal's auto-refresh record, surfaced on the card. Per variant:
  // each region's transport reports its own refreshes.
  let jobTokenRefreshedAt: number | undefined
  /**
   * How long an upstream "not serviceable" answer keeps describing the present.
   *
   * The upstream's own answer is transient by construction — it names a retry
   * delay, typically 30 s — so a notice older than this bound is no longer a
   * description of anything the user is about to hit, and keeping it on the
   * card would report a stale condition as a live one. Same convention (and the
   * same five minutes) as the job-token notice, which is the other notice about
   * a condition that clears itself.
   */
  const queueNoticeMaxAgeMs = 5 * 60 * 1000
  /**
   * The live queue notice: the last answer, when it arrived, and how many times
   * it has come back within the same outage window.
   */
  let queueNotice: QoderWebUpstreamNotice | undefined
  /** The last automatic account switch, for the card. */
  let failoverAt: number | undefined
  let failoverReason: string | undefined
  // The attachment service may not exist when the client and transport are
  // constructed (and a headless profile never has one), so both get a stable
  // facade that resolves the real store per request.
  const resolveAttachmentService = (): AttachmentStore => {
    const service = ctx.get('attachments')
    if (service === undefined) {
      throw new Error('dsh-qoder-plugin: no attachment service is available')
    }
    return service
  }
  const attachments: Pick<AttachmentStore, 'imageLimits' | 'readImageRequest' | 'saveImage'> = {
    get imageLimits() {
      return resolveAttachmentService().imageLimits
    },
    readImageRequest: async (attachment, policy, signal) =>
      await resolveAttachmentService().readImageRequest(attachment, policy, signal),
    saveImage: async request => await resolveAttachmentService().saveImage(request),
  }
  const transport = createQoderTransport({
    region: variant.region,
    resolvePat: () => store.patPromise(),
    /*
     * The DEFAULT chain, deliberately: it reads the official client's own
     * `~/.qoder/.auth/machine_id` first and only falls back to a host-level DSH
     * seed. Pinning a profile-scoped path here made every DSH profile a
     * different "machine" and ignored the identity the client had already
     * registered with the upstream — see `machine-id.ts`.
     */
    resolveMachineId: () => getMachineId(),
    /*
     * The host-level seed each account's derived device id is built from. Read
     * on every credential mint (a file read that only happens when a job token
     * is exchanged), so the settings card's reset reaches the very next
     * request. Absent means the historical derivation — see `device-seed.ts`.
     */
    resolveDeviceSeed: () => readDeviceSeed(),
    attachments,
    /*
     * Automatic next-account failover.
     *
     * Always enabled: with a single stored account `nextAccount` answers
     * `undefined` and the walk ends by rethrowing the original failure, which
     * is byte-for-byte the pre-failover behavior. So "on" has no way to change
     * what a one-account pool does, and there is no reason to gate it behind a
     * setting the user would have to find first.
     */
    failover: {
      /*
       * The user's switch, not a constant.
       *
       * It used to be `() => true` on the argument that a one-account pool is
       * unaffected either way. That held while the walk was invisible, but the
       * walk now moves the stored active pointer and announces itself in the
       * conversation, so a user who wants one account to be the only one that
       * ever signs needs a way to say so — and the only honest thing "off" can
       * mean is that no retry ever runs on another account.
       *
       * Defaulted to ON for every document written before the setting existed:
       * absent must not silently turn off a behaviour the previous version had.
       */
      enabled: () => current().autoFailoverEnabled !== false,
      /*
       * The walk's start: this variant's own file, always.
       *
       * "The active account" is a fact about THIS document, and the endpoint set
       * that signs it is fixed by the variant the request arrived on. Borrowing
       * a sibling's credential here would sign a Global PAT against the China
       * gateway before the walk had even begun, so the pool's reach begins at
       * `nextAccount`, not at the start.
       */
      activeAccount: async () => {
        const credential = await store.current()
        if (credential !== undefined) {
          const id = qoderCredentialIdentity(credential)
          const row = await store.byId(id)
          /*
           * A PARKED active row is not a start.
           *
           * The store deliberately leaves `activeId` pointing at an account the
           * user parks (parking means "do not route here", not "switch away"),
           * and `nextAfter`/`accountById` both skip it. Reading `current()`
           * directly would quietly reintroduce the parked account as the FIRST
           * attempt of every walk — the checkbox would stop affecting the one
           * seat it was set on. Fall through to the first usable row instead,
           * which is the same answer the rest of the walk gives.
           */
          if (row === undefined || row.enabled !== false) {
            return { id, pat: credential.pat, region: credential.region }
          }
        }
        /*
         * Nothing usable here: start where the POOL starts.
         *
         * This is not "borrowing a sibling's credential to sign a local
         * endpoint" — the transport signs each account with the endpoints of
         * the region it was saved under, so a pool whose local file is empty
         * (or entirely parked) starts on the sibling's first usable row and the
         * walk proceeds normally. For a single-region install the sibling
         * contributes no rows and this is exactly the old local answer.
         */
        const ring = await poolRing(poolOrder(pool, variant))
        return ring[0]
      },
      /*
       * The save-order leg, across both files.
       *
       * Within one file this is exactly `store.nextAfter`; the difference is at
       * the end of a file, where the walk continues with the NEXT file's first
       * usable row instead of wrapping back into the file it just finished.
       * That continuation is the whole point of a mixed pool: save order is the
       * default strategy, and it used to be confined to the document the
       * request arrived on.
       *
       * `region` rides along because the transport must sign the successor with
       * the endpoints it was saved under — a China row through the global
       * gateway is a guaranteed AUTH failure, not a fallback.
       */
      nextAccount: async id => await pooledNextAccount(poolOrder(pool, variant), id),
      /*
       * By-id resolution, for custom routing and pinned sessions.
       *
       * Both name an account directly instead of "whoever comes next", so they
       * need the credential — and neither may fall back to the active pointer,
       * because that would quietly sign as a different account than the one the
       * user ordered or the session remembered. A removed account resolves to
       * `undefined`, which is how the walk skips it.
       *
       * A PARKED account resolves to nothing too, and that has to hold across
       * the pool as well: the checkbox must stop an account being reached by its
       * position in a custom order, or keep signing a session it was pinned to
       * before the pause. `pooledAccountById` gives the same "skip this id"
       * answer the save-order walk gives, so a parked row cannot be reached by
       * either leg.
       */
      accountById: async id => await pooledAccountById(poolOrder(pool, variant), id),
      adopted: async info => {
        // A quiet move, not a failover: the account kept failing, so the chat
        // path starts elsewhere while nothing in this request failed. The store
        // still has to move — the catalog, credits and the card resolve the
        // active account, and leaving the cooling one active would keep those
        // reads on the credential the transport just decided to avoid. No
        // notice and no `failoverAt`/`failoverReason`: there is nothing to
        // announce and the card's "last switched" time must not lie.
        await adoptPooledAccount(poolOrder(pool, variant), info.toId, message => { ctx.logger.warn(message) })
        ctx.logger.warn(
          `dsh-qoder-plugin: ${variant.displayName} adopted ${info.toId} after the previous account entered a cooldown (${info.reason})`,
        )
      },
      failed: info => {
        // The card's 限流 label. Only connection-level failures reach here
        // (the transport filters out refused requests and queue answers), so
        // the streak it counts is exactly "this account could not serve".
        health.noteFailure(info.accountId, info.at)
      },
      switched: async info => {
        // Adopting the account is what makes the switch stick. The retry itself
        // signs with the PAT the transport already holds, but every later read
        // — the catalog, credits, the card — resolves the ACTIVE account, so
        // the stored pointer has to move with the request or the next refresh
        // would authenticate as the account that just failed.
        //
        // A refusal here must not escape: this hook runs on the success path of
        // a request that has already recovered, and an account removed in
        // another tab (or re-keyed while the walk ran) would otherwise turn that
        // recovery into an unhandled rejection and kill the request. Record the
        // switch and announce it below either way — the retry did switch, only
        // the pointer move did not, and that is a warning, not a failure.
        await adoptPooledAccount(poolOrder(pool, variant), info.toId, message => { ctx.logger.warn(message) })
        failoverAt = Date.now()
        failoverReason = info.reason
        // A different identity pays from here on, so the previous account's
        // queue answer no longer describes the account in effect.
        queueNotice = undefined
        ctx.logger.warn(
          `dsh-qoder-plugin: ${variant.displayName} switched accounts after a connection failure (${info.reason})`,
        )
        // The visible channel: without it the failed request and the recovered
        // retry are indistinguishable from a plain success, and nothing would
        // say that a different subscription paid for it. The walk names the
        // conversation it moved, so the row lands in that chat and not in
        // whichever one started most recently.
        emitUpstreamNotice(failoverNoticeText(info.reason), info.sessionId)
      },
    },
    onUpstreamQueue: (facts, accountId, sessionId) => {
      const at = Date.now()
      // Health is per account and outlives one notice: recorded before the
      // document-wide notice, which is replaced on every answer.
      if (accountId !== undefined) health.noteQueue(accountId, at)
      const previous = queueNotice
      // Reports inside one window are the same outage recurring; a report after
      // the window is a new one, and the risk-control sentence — which is only
      // honest about a REPEATED answer — must start counting again.
      const sameOutage = previous !== undefined && at - previous.at <= queueNoticeMaxAgeMs
      // A "0 seconds" advice is the upstream saying "retry now", which is no
      // window at all. Carried as a number it would make `waited` true on a
      // zero-length gap and print "已按上游建议等待 0 秒仍不可服务" — a claim
      // about waiting that the advice never supported. Treated as absent, the
      // notice falls back to its no-delay sentence, while the head still quotes
      // the upstream's own advice verbatim.
      const advisedMs = facts.retryAfterSeconds === undefined || facts.retryAfterSeconds <= 0
        ? undefined
        : facts.retryAfterSeconds * 1000
      // Elapsed time is the only evidence this seam can have for the wait
      // sentence: the transport refuses to sit the upstream's window out (that
      // would hold the stream open) and the harness retries the turn itself, so
      // what is left is the clock, and an accepted chat clears the record —
      // meaning an answer that arrives at least one advised window after the
      // previous one can only describe a user who really waited that long and
      // was refused again. A shorter gap supports no such claim, and `waited:
      // true` there would print "已按上游建议等待 30 秒仍不可服务" to someone
      // whose wait was seconds.
      const waited = sameOutage && advisedMs !== undefined && at - previous.at >= advisedMs
      queueNotice = {
        kind: facts.serviceAvailable === false ? 'unavailable' : 'queued',
        ...facts.upstreamMessage === undefined ? {} : { upstreamMessage: facts.upstreamMessage },
        ...advisedMs === undefined ? {} : { retryAfterMs: advisedMs },
        waited,
        at,
        occurrences: sameOutage ? previous.occurrences + 1 : 1,
      }
      ctx.logger.warn(
        `dsh-qoder-plugin: ${variant.displayName} upstream model is not serviceable (${facts.subCode ?? 'no sub-code'}, retry after ${facts.retryAfterSeconds ?? 'unknown'}s)`,
      )
      emitUpstreamNotice(formatQueueNotice(facts, { waited, occurrences: queueNotice.occurrences }), sessionId)
    },
    onQueueWait: (facts, accountId, wait, sessionId) => {
      // Progress, not the explanation: this row is printed when the wait
      // starts, so a request that waits out one or two windows is visibly
      // working instead of indistinguishable from a hang. The final-failure
      // row (`onUpstreamQueue`) still follows if the retries never succeed.
      ctx.logger.warn(
        `dsh-qoder-plugin: ${variant.displayName} upstream model is queued; waiting ${Math.round(wait.waitMs / 1000)}s before retry ${wait.attempt}/${wait.attempt + wait.remaining} (account ${accountId ?? 'ambient'}, wait driven by ${wait.basis?.source ?? 'unknown'})`,
      )
      emitUpstreamNotice(formatQueueWaitNotice(facts, wait), sessionId)
    },
    onChatAccepted: (accountId, sessionId) => {
      // The upstream took a chat, so the condition the last notice described is
      // over — and "over" has to take the streak with it, not just the
      // timestamp. A record kept past this point would first re-describe an
      // outage the user stopped hitting, then count the NEXT answer as a
      // recurrence of it and print the risk-control sentence over a chat that
      // succeeded in between. Dropping the record resets both facts at once.
      queueNotice = undefined
      // Same reasoning for this account's health, and the only observation that
      // can clear 限流: an accepted request proves the account serves.
      if (accountId !== undefined) health.noteConnected(accountId, Date.now())
    },
    onJobTokenRefreshed: info => {
      jobTokenRefreshedAt = info.at
      ctx.logger.warn(
        `dsh-qoder-plugin: ${variant.displayName} job token was auto-refreshed after an upstream rejection`,
      )
      // The visible channel: one line in the conversation that triggered the
      // refresh (the request this heal happened inside). The transport names it,
      // because one shared job token can heal a request in only one conversation
      // at a time — printing it "wherever the user is" put the row in a chat that
      // never healed.
      emitJobTokenHint(info.at, jobTokenHintText(info.at), info.sessionId)
    },
    onJobTokenRefreshFailed: info => {
      // The heal ran and lost. Announced at most once per outage by the
      // transport, so a long rejection storm prints one row, not one per retry.
      ctx.logger.warn(
        `dsh-qoder-plugin: ${variant.displayName} job token refresh did not recover the chat (upstream status ${info.status ?? 'unknown'})`,
      )
      emitJobTokenRefreshFailedHint(info.at, jobTokenRefreshFailedHintText(info.at), info.sessionId)
    },
    /*
     * The three settings that shape a request's account walk, read live.
     *
     * All three are functions rather than values for the same reason the
     * failover switch is: `apply()` mints this transport once and a settings
     * write never re-mints it, so a captured value would freeze at whatever the
     * document held at startup — the card would report a change the transport
     * never saw.
     */
    queueWait: {
      // Retries to sit out INSIDE one request when the upstream names a delay.
      // The master switch collapses the count to zero rather than hiding the
      // two bounds: the transport's budget is the ONE place that decides how
      // long a caller waits, so "off" has to be visible there and nowhere else.
      attempts: () => (current().queueWaitEnabled === false ? 0 : current().queueWaitAttempts ?? 0),
      seconds: () => current().queueWaitSeconds ?? 30,
    },
    stickiness: {
      // How long one account serves a conversation before the session moves to
      // the next account. All three are bounds: whichever is reached first
      // moves the conversation on, so a single big turn cannot pin a session to
      // one account for longer than the round or request bound allows.
      // The master switch is read live too: turning it off means no account
      // is ever pinned, and the three bounds stop mattering until it returns.
      enabled: () => current().stickinessEnabled !== false,
      rounds: () => current().stickinessRounds ?? 3,
      requests: () => current().stickinessRequests ?? 200,
      minutes: () => current().stickinessMinutes ?? 180,
    },
    routing: {
      // The user's own order, spanning both variants, with save order as the
      // fallback for accounts the list does not name.
      strategy: () => current().routingStrategy ?? 'save-order',
      order: () => current().routingOrder ?? [],
    },
    now: () => Date.now(),
  })
  const client = new QoderUpstreamClient({
    region: variant.region,
    providerId: variant.id,
    getPat: () => store.patPromise(),
    transport,
    attachments,
  })
  const fallback = fallbackFor(variant)
  const catalog = new QoderCatalog(fallback)
  // Read the initial preferences through the caller's LIVE configuration view
  // (`current()`), never the bare entry config: the plugin-owned settings file
  // is the live source, and reading the entry here made every restart forget
  // the disabled-model list — the entry is empty by then (its row was cleaned
  // up), so the catalog came back "all models enabled" and the picker offered
  // models the user had switched off. `readField` unwraps the volatile
  // references on 0.1.7.
  const initial = current()
  if (variant.id !== CHINA_VARIANT.id) {
    catalog.setUseMaximumContextWindow(initial.useMaximumContextWindow === true)
    if (initial.disabledModels !== undefined) catalog.setDisabledModels(initial.disabledModels)
    catalog.setEnabled(initial.variantEnabledGlobal !== false)
  } else {
    catalog.setUseMaximumContextWindow(initial.useMaximumContextWindowCN === true)
    if (initial.modelContextWindowsCN !== undefined) catalog.setModelContextWindows(initial.modelContextWindowsCN)
    if (initial.disabledModelsCN !== undefined) catalog.setDisabledModels(initial.disabledModelsCN)
    catalog.setEnabled(initial.variantEnabledCN !== false)
  }
  // Start hidden: a variant must serve no models until a token has actually
  // been adopted, so a signed-out variant is empty rather than showing a roster
  // whose models could only fail. `adoptIdentity` is what reveals it, and it
  // treats "never seen, still signed out" as no change — which is only correct
  // if the pre-adoption state is already hidden.
  catalog.setVisible(false)
  const probeStore = new QoderProbeStore({
    pluginVersion: QODER_CONNECT_VERSION,
    path: qoderProbePath(variant.probeFilename),
  })
  // One file per variant, for the same reason the probe records are split: the
  // two regions can disagree about rates and windows for shared model ids, so
  // a saved China roster must never be served as a global one.
  const savedCatalogs = new QoderCatalogStore({ path: qoderCatalogPath(variant.catalogFilename) })
  const probeService = new QoderProbeService({
    store: probeStore,
    catalog,
    credentials: store,
    client,
    consent: () => current().probeConsent === true,
    // Observations are per account: the service reads and writes its records
    // against this identity, so one token's detected levels never answer for
    // another's, and an in-flight sweep cannot store under a new token.
    account: () => identityOf(variant.id),
  })
  return {
    variant,
    store,
    client,
    transport,
    catalog,
    probeStore,
    probeService,
    savedCatalogs,
    fallback,
    catalogSource: 'fallback',
    catalogFetchedAtMs: undefined,
    catalogError: undefined,
    lastFetchAtMs: 0,
    catalogGeneration: 0,
    inflightFetch: undefined,
    invalidate: () => {},
    registered: false,
    jobTokenRefreshedAt: () => jobTokenRefreshedAt,
    upstreamNotice: () => {
      // Read through the same bound the report uses, so a notice that stopped
      // describing the present cannot be revived by a page refresh: the card
      // pulls this document on every open, and a stale notice kept forever
      // would tell the user a cleared condition is still in effect.
      if (queueNotice === undefined) return undefined
      if (Date.now() - queueNotice.at > queueNoticeMaxAgeMs) {
        queueNotice = undefined
        return undefined
      }
      return queueNotice
    },
    failoverAt: () => failoverAt,
    failoverReason: () => failoverReason,
    healthOf: accountId => health.healthOf(accountId, Date.now()),
    forgetHealth: accountId => { health.forget(accountId) },
    checkIn: (signal?: AbortSignal) => transport.checkIn(signal),
  }
}

/** The catalog provenance the card displays. */
function catalogSection(runtime: VariantRuntime): QoderWebCatalog {
  return {
    // The source is what the models on screen actually came from, so the card
    // can distinguish a fresh fetch from a saved one from the built-in roster —
    // "stale" and "offline" are different problems for the user.
    source: runtime.catalogSource,
    // The served catalog's own fetch time, which for a saved list is when it
    // was fetched, not when the process started.
    ...runtime.catalogFetchedAtMs === undefined ? {} : { fetchedAt: runtime.catalogFetchedAtMs },
    ...runtime.catalogError === undefined ? {} : { error: runtime.catalogError },
  }
}

/**
 * Whether a model can be probed by hand: it reasons and the upstream declares
 * no effort set for it.
 *
 * Deliberately *not* filtered by whether a result already exists. Dropping a
 * model once it has been detected made the list shrink with use, so
 * re-detecting one model — after an upstream change, say — meant clearing every
 * other result first. The list stays stable and the card marks which entries
 * already have an answer.
 */
function isProbeCandidate(info: QoderModelInfo): boolean {
  if (info.reasoning?.supports !== true) return false
  return (info.reasoning.supportedEfforts?.length ?? 0) === 0
}

/** Compact probe state for one card: consent, candidates, observations. */
function probeSection(runtime: VariantRuntime, consent: boolean): QoderWebProbeSection {
  const models = runtime.catalog.current()
  // Read results through the *same* judgement the adapter uses, rather than
  // straight from the store. A raw record can be stale in ways the adapter
  // already discounts — its catalog row changed, it aged past the TTL, or the
  // upstream has since declared an effort set (which always wins) — and showing
  // one would have the card promise levels the model picker does not offer. A
  // model the upstream dropped leaves the catalog entirely, so it drops out
  // here too.
  const results = models.flatMap(info => {
    const record = runtime.probeService.recordFor(info.id)
    if (record === undefined) return []
    return [{
      id: info.id,
      name: info.name,
      validation: record.validation,
      efforts: record.efforts,
      probedAt: record.probedAtMs,
    }]
  })
  return {
    consent,
    running: runtime.probeService.isRunning(),
    candidates: models.filter(isProbeCandidate).map(info => info.id),
    // Newest first: a detection the user just ran belongs at the top, not
    // appended below every earlier one.
    results: newestFirst(results),
  }
}

/**
 * Run a detached promise without letting its failure kill the host.
 *
 * Node terminates the whole process on an unhandled rejection (exit code 1),
 * which the desktop shell reports as the backend having "exited unexpectedly"
 * — so a failing heartbeat write, loopback close, or background sweep in this
 * plugin would take the entire Harness down with it. Every fire-and-forget
 * call therefore carries a handler; a failure is a diagnostic, never a reason
 * for the host to die.
 */
function detach(ctx: Context, work: Promise<unknown>, what: string): void {
  void work.catch((error: unknown) => {
    ctx.logger.warn(`dsh-qoder-plugin: ${what} failed`, error)
  })
}

/**
 * Start one variant: its loopback endpoint, provider registration, and
 * configuration-card wiring.
 *
 * Registration waits for the shim to hold a port, because the provider's
 * models read the shim origin at construction time. A failure here is
 * contained to this variant: the caller logs it and the other keeps working.
 *
 * @param seedCatalog - adopt the current credential into this runtime's
 *   catalog immediately; supplied by `apply` (it owns `adoptIdentity`).
 * @returns whether the provider registered.
 */
async function startVariant(ctx: Context, runtime: VariantRuntime, seedCatalog: () => Promise<void>): Promise<boolean> {
  const { variant, store, client, catalog, probeService } = runtime
  const shim = createQoderShim({
    store,
    client,
    catalog,
    providerId: variant.id,
    logger: ctx.logger,
  })
  try {
    await shim.ready
  } catch (error: unknown) {
    ctx.logger.error(`dsh-qoder-plugin: ${variant.displayName} loopback endpoint failed to start`, error)
    return false
  }

  try {
    // Constructed only once the listener holds a port: the provider's models
    // read the shim origin at construction time.
    const qoder = createQoderAdapter({
      providerId: variant.id,
      displayName: variant.displayName,
      shim,
      store,
      catalog,
      resolveAttachments: () => ctx.get('attachments'),
      observe: modelId => probeService.recordFor(modelId),
    })
    runtime.invalidate = () => {
      qoder.invalidate()
      ctx.emit('llm/adapters-updated')
    }

    let releaseAdapter: (() => void) | undefined
    let releaseDirectory: (() => void) | undefined
    try {
      releaseAdapter = ctx.llm.registerAdapter([variant.id], qoder.adapter)
      // The settings namespace the Models page resolves this directory row
      // against is the profile ENTRY's id: 0.1.7 serves one settings form per
      // entry, keyed by `entry.options.id` (dsh-settings `describe()`), so the
      // row must name that id — naming the pre-0.1.7 namespace (`qoder` /
      // `qoder-global`) makes the page resolve a name the Host never served and
      // the row renders with no configuration at all.
      //
      // The namespace fallback below is not a host-version branch: it covers a
      // context built without a profile entry (the tests, and any embedding
      // that applies the plugin directly), where there is no entry id to name.
      const entryId = (ctx as unknown as { fiber?: { entry?: { options?: { id?: string } } } }).fiber?.entry?.options?.id
      const settingsNs = entryId !== undefined ? (entryId as SettingsNamespace) : settingsNamespaceFor(variant)
      releaseDirectory = ctx.llm.registerConfigurableProviders([{
        provider: variant.id,
        displayName: variant.displayName,
        // Each variant's directory entry joins its own settings form; the
        // Models settings page resolves `settingsNs` against the served forms,
        // so the name must be the one THIS host serves (see above).
        settingsNs,
        settingsPath: [],
        declared: false,
      }])
    } finally {
      if (releaseAdapter === undefined || releaseDirectory === undefined) {
        // Registration threw; release whichever half landed.
        releaseAdapter?.()
        releaseDirectory?.()
      }
    }
    try {
      ctx.effect(() => () => {
        releaseAdapter?.()
        releaseDirectory?.()
        detach(ctx, shim.close(), 'loopback endpoint close')
      })
    } catch {
      // The plugin was disposed during registration; release immediately — the
      // plugin-level disposer already closed every shim.
      releaseAdapter?.()
      releaseDirectory?.()
      detach(ctx, shim.close(), 'loopback endpoint close')
    }
    runtime.registered = true
    // Seed the catalog BEFORE returning, not in the later sweep.
    //
    // A 0.1.7 settings write hot-reloads this fiber; the fresh runtime's
    // catalog starts hidden, and until the sweep runs `adoptIdentity` the
    // status route answers with zero models — the card's post-write refresh
    // lands exactly in that window and shows "暂无可配置的模型" until the user
    // presses refresh. Seeding here closes the window: by the time the routes
    // are live the catalog already holds the saved/fallback roster.
    detach(ctx, seedCatalog(), `${variant.id} catalog seed`)
    return true
  } catch (error: unknown) {
    ctx.logger.error(`dsh-qoder-plugin: ${variant.displayName} provider registration failed`, error)
    detach(ctx, shim.close(), 'loopback endpoint close')
    return false
  }
}

/**
 * State that MUST survive a fiber reload, module-level on purpose.
 *
 * DSH 0.1.7's configuration write (`configEditor.edit`) reconciles the profile
 * tree, which hot-reloads the entry's fiber — `apply()` runs again with a fresh
 * closure. Anything re-minted per apply is therefore invalidated by every
 * settings write: the browser cards hold the keys the status document handed
 * them, so a per-apply key turns each write into a wave of 403s ("刷新失败"),
 * and a per-apply identity map makes the sweep re-fetch the catalog from
 * upstream on every write (the burst of requests and most of the latency).
 *
 * Keys and identity/fetch bookkeeping are per-PROCESS secrets and caches, not
 * per-instance state, so they live here once. A reload keeps the same keys (no
 * 403 storm) and a same-account, freshly-fetched sweep (no refetch burst).
 */
/** The in-process control keys, minted once per process. */
let processKeys: { probe: string; auth: string } | undefined
function controlKeys(): { probe: string; auth: string } {
  processKeys ??= { probe: createProbeKey(), auth: createAuthKey() }
  return processKeys
}

/** The loopback guard the probe and status routes use, restated for settings. */
function trustedSettingsRequest(req: { method?: string | undefined; headers: Record<string, string | string[] | undefined> }): boolean {
  const host = req.headers.host ?? ''
  const origin = req.headers.origin
  if (!/^(localhost|127(?:\.\d{1,3}){3}|\[::1\])(?::\d+)?$/i.test(String(host))) return false
  return origin === undefined || /^https?:\/\/(localhost|127(?:\.\d{1,3}){3}|\[::1\])(?::\d+)?$/i.test(String(origin))
}

/**
 * The schema defaults, READ off each field's own `meta.default`.
 *
 * Two ways this was got wrong before, both silent and both destructive: a
 * hand-written table drifted from the schema (so the schema's own defaults
 * were classified as real overrides and the legacy settings document could
 * never win), and `validate({})` was then tried instead — which on this
 * schemastery answers with hollow `{}` per field instead of applying the
 * defaults, which is worse than nothing because it looks like it worked.
 * Walking `Config.dict` for `meta.default` is the only honest source: it is
 * the value schemastery itself substituted during validation.
 */
const DEFAULT_FOR_FIELD: Partial<Record<keyof Config, unknown>> = (() => {
  const out: Partial<Record<keyof Config, unknown>> = {}
  try {
    for (const [key, field] of Object.entries(Config.dict ?? {})) {
      const fallback = (field as { meta?: { default?: unknown } } | undefined)?.meta?.default
      if (fallback !== undefined) (out as Record<string, unknown>)[key] = fallback
    }
  } catch {
    // An unreadable schema leaves the map partial: every field then reads as
    // "no default", which keeps the entry authoritative — the pre-migration
    // behaviour — rather than guessing.
  }
  if (Object.keys(out).length === 0) {
    // A schema that cannot be walked keeps the literal table below.
    return {
      probeConsent: false,
      useMaximumContextWindow: true,
      useMaximumContextWindowCN: true,
      modelContextWindows: {},
      modelContextWindowsCN: {},
      disabledModels: [],
      disabledModelsCN: [],
      variantEnabledCN: true,
      variantEnabledGlobal: true,
      sidebarQuotaCN: false,
      sidebarQuotaGlobal: false,
      autoCheckInCN: false,
      autoCheckInGlobal: false,
      checkInMinute: 600,
      quotaPollMs: 300_000,
      autoFailoverEnabled: true,
      queueWaitEnabled: true,
      queueWaitAttempts: 0,
      queueWaitSeconds: 30,
      routingStrategy: 'save-order',
      routingOrder: [],
      stickinessEnabled: true,
      stickinessRounds: 3,
      stickinessRequests: 200,
      stickinessMinutes: 180,
    }
  }
  return out
})()

/** One settings-face write: type-checked, then persisted and applied. */
interface QoderSettingsWriteTarget {
  store: SettingsStore
  config: Config
  current: () => Config
  apply: (next: Config) => void
  rearm: () => void
}

/**
 * Register the settings face (GET/POST) the browser cards read and write
 * through, answering the whole entry configuration as three layers.
 *
 * `value` carries every declared field, so a card rendering the quota section
 * sees the same merged view the host itself reads; `user` is the settings file
 * exactly as stored (presence marks an override), which is what the staged-edit
 * form's "written/reset" display needs. A POST validates the fields it is
 * allowed to touch, writes the file, applies the new view in memory, and
 * re-arms the check-in scheduler (the old 0.1.5 section `onChange` behaviour).
 */
function registerQoderSettingsFace(
  ctx: Context,
  deps: QoderSettingsWriteTarget,
): void {
  const { store, config, current, apply, rearm } = deps
  const key = controlKeys().probe
  /** The document both routes answer with. */
  const view = () => {
    const merged = current()
    const value: Record<string, unknown> = {}
    const base: Record<string, unknown> = {}
    for (const field of CONFIG_KEYS) {
      if (merged[field] !== undefined) value[field] = merged[field]
      base[field] = readConfig(config)[field] ?? DEFAULT_FOR_FIELD[field]
    }
    return { key, value, base, user: store.values() }
  }
  ctx.effect(() => {
    const dispose = ctx.webServer.register({
      kind: 'exact',
      path: QODER_SETTINGS_FACE_PATH,
      handler: async (req, res) => {
        if (!trustedSettingsRequest(req)) { jsonFace(res, 403, { error: 'request-not-trusted' }); return }
        if (req.method === 'GET') { jsonFace(res, 200, view()); return }
        if (req.method !== 'POST') { jsonFace(res, 405, { error: 'method not allowed' }); return }
        if (req.headers['x-qoder-settings-key'] !== key) { jsonFace(res, 403, { error: 'invalid-key' }); return }
        const body = await readFaceBody(req)
        if (body === undefined) { jsonFace(res, 413, { error: 'body too large' }); return }
        let patch: unknown
        try { patch = JSON.parse(body || '{}') } catch { jsonFace(res, 400, { error: 'invalid json' }); return }
        if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) {
          jsonFace(res, 400, { error: 'invalid patch' }); return
        }
        const invalid = validateSettingsPatch(patch as Record<string, unknown>)
        if (invalid !== undefined) { jsonFace(res, 400, { error: invalid }); return }
        // A card write: the file holds live user edits from here on (see the
        // seed rule on `apply`), so a stale profile row can never regress it.
        store.patch(patch as Record<string, unknown>, true)
        apply(current())
        rearm()
        jsonFace(res, 200, view())
      },
    })
    return () => { dispose() }
  }, 'dsh-qoder-plugin: settings face')
}

/** JSON response helper for the settings face. */
function jsonFace(res: { writeHead: (status: number, headers: Record<string, string>) => void; end: (body: string) => void }, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(payload)
}

/** Read the request body, or undefined when absent or oversized. */
function readFaceBody(req: { on: (event: string, handler: (chunk?: unknown) => void) => void }): Promise<string | undefined> {
  return new Promise(resolve => {
    let body = ''
    req.on('data', (chunk: unknown) => {
      body += String(chunk)
      if (body.length > 1e6) { resolve(undefined) }
    })
    req.on('end', () => resolve(body))
    req.on('error', () => resolve(undefined))
  })
}

/** Schema-level validation of one settings patch; the reason, or undefined. */
function validateSettingsPatch(patch: Record<string, unknown>): string | undefined {
  for (const [field, value] of Object.entries(patch)) {
    if (!(CONFIG_KEYS as readonly string[]).includes(field)) return `unknown field ${field}`
    if (value === null) continue
    switch (field) {
      case 'probeConsent':
      case 'useMaximumContextWindow':
      case 'useMaximumContextWindowCN':
      case 'variantEnabledCN':
      case 'variantEnabledGlobal':
      case 'sidebarQuotaCN':
      case 'sidebarQuotaGlobal':
      case 'autoCheckInCN':
      case 'autoCheckInGlobal':
      case 'autoFailoverEnabled':
      case 'queueWaitEnabled':
        if (typeof value !== 'boolean') return `${field} must be a boolean`
        break
      case 'disabledModels':
      case 'disabledModelsCN':
      case 'routingOrder':
        if (!Array.isArray(value) || value.some(item => typeof item !== 'string')) return `${field} must be an array of strings`
        break
      case 'routingStrategy':
        if (value !== 'save-order' && value !== 'custom') return `${field} must be "save-order" or "custom"`
        break
      case 'queueWaitAttempts':
        if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 10) return `${field} must be an integer 0..10`
        break
      case 'queueWaitSeconds':
        if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 300) return `${field} must be an integer 1..300`
        break
      case 'stickinessEnabled':
        if (typeof value !== 'boolean') return `${field} must be a boolean`
        break
      case 'stickinessRounds':
        if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 100) return `${field} must be an integer 0..100`
        break
      case 'stickinessRequests':
        if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 10_000) return `${field} must be an integer 0..10000`
        break
      case 'stickinessMinutes':
        if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 1440) return `${field} must be an integer 0..1440`
        break
      case 'checkInMinute':
        if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 1439) return `${field} must be an integer minute 0..1439`
        break
      case 'quotaPollMs':
        if (typeof value !== 'number' || !Number.isInteger(value) || value < 60_000) return `${field} must be an integer of at least 60000 ms`
        break
      case 'modelContextWindows':
      case 'modelContextWindowsCN':
        if (typeof value !== 'object' || value === null || Array.isArray(value)) return `${field} must be an object`
        break
    }
  }
  return undefined
}

/** The account identity each variant last published a catalog for, across reloads. */
const lastIdentities = new Map<string, string>()

/**
 * When a variant's catalog was last fetched LIVE from upstream, per identity.
 *
 * A reload reseeds the catalog from the saved file; without this record the
 * sweep's retry rule (`stale && due`) sees `lastFetchAtMs = 0` and re-fetches
 * immediately — one upstream round trip per variant per settings write.
 */
const lastLiveFetchAt = new Map<string, number>()

/**
 * Start both variants: their loopback endpoints, the `qoder` and
 * `qoder-global` providers, their configuration cards, and their
 * credential-driven catalog lifecycles.
 *
 * Each variant registers unconditionally; what varies is whether its catalog is
 * *visible*. An empty catalog is how DSH hides a model group (the host filters
 * out groups with no models), which keeps a token saved after startup working
 * without re-registering the provider.
 */
export function apply(ctx: Context, config: Config): void {
  // Live configuration source: the composition entry (the profile row, read
  // through the volatile indirection — on 0.1.7 every projected field is a
  // reference object whose value comes from `.get()`) with the plugin-owned
  // settings file layered on top. `current()` — the one reader the whole
  // plugin consults — hands out plain values on both hosts.
  //
  // The entry stays as the fallback layer so a hand-edited profile row still
  // seeds a fresh install; the file is where every write lands (see the
  // `settings-store` module for why: a profile-patch write costs a full tree
  // reconcile and a fiber reload on every switch).
  const store = new SettingsStore()
  const current = (): Config => ({ ...readConfig(config), ...store.values() }) as Config

  /** Timers and in-flight work belonging to this plugin instance. */
  let stopped = false
  const timers: NodeJS.Timeout[] = []

  /*
   * Two-phase construction: the pool has to be readable from inside each
   * variant's hooks, but a runtime is only built once its own hooks exist.
   * The array is filled as the map runs, so a hook invoked later (never during
   * construction) always sees the finished pool.
   */
  const runtimes: VariantRuntime[] = []
  const pool = (): readonly VariantRuntime[] => runtimes
  /*
   * ONE health tracker for the whole pool, not one per variant.
   *
   * Health is keyed by account id, and ids are globally unique (a hash of the
   * PAT), so a shared tracker cannot confuse two accounts. What it does fix is
   * the cross-region hand-off: a switch from a China seat to a Global seat
   * reports its failure through the China runtime's hook but the card reads the
   * Global account's 正常/排队/限流 label out of the Global document — with a
   * tracker per variant the failure streak would land in the file that no
   * longer owns the row being displayed, and the label would stay 正常 after
   * three failures.
   */
  const health = new QoderAccountHealthTracker()
  for (const variant of QODER_VARIANTS) {
    runtimes.push(createVariantRuntime(
      ctx,
      config,
      variant,
      () => current(),
      id => lastIdentities.get(id),
      pool,
      health,
    ))
  }

  const checkInStore = new JsonFileCheckInStore()
  /**
   * When one variant's daily claim window opens, in minutes past midnight UTC+8.
   *
   * One definition, used by both the scheduler's timer and the status route's
   * `today` stamp. They must agree: the scheduler decides whether a window was
   * already claimed using this moment, and the card decides whether to offer
   * the button using the same notion of "now" — if the two drifted, the card
   * could offer an action the sweep considered done, or hide one it considered
   * due.
   *
   * A missing or out-of-range stored value must never leave a variant
   * unscheduled, so it falls back to the documented default rather than to
   * "now" or to an instant that never comes.
   */
  const variantWindowMinute = (): number => {
    const cfg = current()
    return normalizeCheckInMinute(cfg.checkInMinute ?? DEFAULT_CHECK_IN_MINUTE)
  }

  const checkInScheduler = new CheckInScheduler({
    targets: runtimes.map(runtime => ({
      variantId: runtime.variant.id,
      checkIn: (signal?: AbortSignal) => runtime.checkIn(signal),
      minuteOfDay: () => variantWindowMinute(),
      onClaimed: () => {
        void runtime.client.fetchCredits().catch(() => undefined)
      },
    })),
    isEnabled: variantId => {
      const cfg = current()
      if (variantId === CHINA_VARIANT.id) return cfg.autoCheckInCN === true
      return cfg.autoCheckInGlobal === true
    },
    store: checkInStore,
  })
  checkInScheduler.start()
  /**
   * The startup catch-up, run once more from the settings source callback.
   *
   * `start()` above runs while the plugin is still assembling: the section
   * that stores these toggles has not handed over its values yet, so that
   * sweep reads the raw plugin config, sees no toggle, and skips the day. The
   * retry is what makes "boot after 10:00" actually claim.
   */
  let startupCatchUpDone = false
  const runStartupCatchUpOnce = (): void => {
    if (startupCatchUpDone) return
    startupCatchUpDone = true
    checkInScheduler.catchUp()
  }

  // The session-visible hint row for a self-heal: appends the harness's own
  // log-only `command/run` + `command/done` pair to the running conversation,
  // so the recovery shows as one line and registers nothing globally.
  installJobTokenHint(ctx)

  // Same-origin routes backing each Plugin-configuration card; the webServer
  // service is optional (a headless profile serves no browser).
  // Keys are per-process (see {@link controlKeys}): a 0.1.7 settings write
  // reloads this fiber, and per-apply keys would invalidate every card's key.
  const { probe: probeKey, auth: authKey } = controlKeys()
  let setMaximumContextWindow: ((enabled: boolean) => Promise<{ state: string; reason?: string }>) | undefined
  let setMaximumContextWindowCN: ((enabled: boolean) => Promise<{ state: string; reason?: string }>) | undefined
  let setModelsEnabled: ((options: { models: readonly string[]; enabled: boolean }) => Promise<{ state: string; reason?: string }>) | undefined
  let setModelsEnabledCN: ((options: { models: readonly string[]; enabled: boolean }) => Promise<{ state: string; reason?: string }>) | undefined
  let setModelContextWindow: ((options: { model: string; window: number }) => Promise<{ state: string; reason?: string }>) | undefined
  let setModelContextWindowCN: ((options: { model: string; window: number }) => Promise<{ state: string; reason?: string }>) | undefined
  /**
   * Point a variant at an account identity, invalidating whatever the previous
   * one left behind.
   *
   * One helper for all four transitions (sweep sign-in, sweep sign-out, manual
   * refresh, card save) because each of them used to do its own partial
   * version, and the manual path forgot pieces the sweep did. Every transition
   * bumps {@link VariantRuntime.catalogGeneration}, which is what makes an
   * in-flight request from before the change refuse to write back.
   *
   * Probe observations are dropped whenever the account actually changes —
   * including sign-out, and including the "signed out, then in as someone else"
   * sequence that used to look like a first sighting and let the new account
   * inherit the old one's detected levels. They are deliberately NOT cleared on
   * a first sign-in: no previous account's data could leak there, and clearing
   * would delete records this very account owns (written before a restart, or
   * seeded while all of this is running).
   *
   * @param identity - the account now in effect, or `undefined` when signed out.
   */
  const adoptIdentity = (runtime: VariantRuntime, identity: string | undefined): void => {
    const id = runtime.variant.id
    const known = lastIdentities.get(id)
    // "Same identity" may only short-circuit when THIS runtime has already
    // adopted: a fresh catalog starts hidden (`createVariantRuntime` sets
    // `visible=false`), and DSH 0.1.7's configuration write hot-reloads the
    // fiber, so every settings write produces exactly such a fresh runtime.
    // Short-circuiting on identity alone there skips the seeding AND the
    // `setVisible(true)`, the provider registers with zero models, and the
    // card's model list and context-window section go empty — and stay empty,
    // because `all()` answers nothing while hidden even after a later fetch
    // succeeds, and the refresh button routes through this same function.
    if (known === identity && runtime.catalog.isVisible()) return
    const hadCredential = known !== undefined
    if (identity === undefined) lastIdentities.delete(id)
    else lastIdentities.set(id, identity)
    // Any change of identity invalidates in-flight work and recorded answers.
    runtime.catalogGeneration += 1
    runtime.inflightFetch?.controller.abort()
    runtime.inflightFetch = undefined
    if (hadCredential && known !== identity) {
      runtime.probeStore.clear()
      runtime.invalidate()
    }
    if (identity === undefined) {
      // Signed out: hide the group, and drop the models so they are not left
      // registered-but-invisible if visibility ever flips back. The signed-out
      // account's saved catalog is forgotten as well — it is that account's
      // data, and it is keyed by identity so nothing else can serve it, but
      // keeping it would only be useful if that same account returned, and the
      // file is not a place to accumulate departed accounts' catalogs.
      if (known !== undefined) runtime.savedCatalogs.delete(known)
      runtime.catalog.set(runtime.fallback)
      runtime.catalogSource = 'fallback'
      runtime.catalogFetchedAtMs = undefined
      runtime.catalogError = undefined
      if (runtime.catalog.setVisible(false)) runtime.invalidate()
      return
    }
    // Serve this account's best-known catalog until a fetch lands. The saved
    // catalog is preferred over the built-in roster: the roster is a snapshot
    // taken once, while the saved one is what this account (from this source)
    // was actually served. This covers both a switch and a restart — on a
    // restart `hadCredential` is false, and the saved catalog is exactly what
    // stops the group from falling back to the compiled-in list.
    const saved = runtime.savedCatalogs.get(identity)
    if (saved !== undefined) {
      runtime.catalog.set([...saved.models])
      runtime.catalogSource = 'saved'
      runtime.catalogFetchedAtMs = saved.fetchedAtMs
    } else {
      runtime.catalog.set(runtime.fallback)
      runtime.catalogSource = 'fallback'
      runtime.catalogFetchedAtMs = undefined
    }
    runtime.catalogError = undefined
    runtime.catalog.setVisible(true)
    runtime.invalidate()
  }

  /**
   * Apply catalog preferences from a configuration view, in memory.
   *
   * Shared by the probe-route setters and the settings face's POST: both write
   * the plugin-owned settings file and then land the new view here, which is
   * what the cards see on their next status read.
   */
  const applyCatalogSettings = (next: Config): void => {
    let changed = false
    for (const runtime of runtimes) {
      const isChina = runtime.variant.id === CHINA_VARIANT.id
      const preference = isChina ? next.useMaximumContextWindowCN : next.useMaximumContextWindow
      if (runtime.catalog.setUseMaximumContextWindow(preference === true)) changed = true
      const overrides = isChina ? next.modelContextWindowsCN : next.modelContextWindows
      if (overrides !== undefined && runtime.catalog.setModelContextWindows(overrides)) changed = true
      const disabled = isChina ? next.disabledModelsCN : next.disabledModels
      if (runtime.catalog.setDisabledModels(disabled ?? [])) changed = true
      const variantEnabled = isChina ? next.variantEnabledCN !== false : next.variantEnabledGlobal !== false
      if (runtime.catalog.setEnabled(variantEnabled)) changed = true
    }
    if (changed) {
      for (const runtime of runtimes) runtime.invalidate()
    }
  }

  ctx.inject(['webServer'], webCtx => {
    for (const runtime of runtimes) {
      registerQoderStatusRoute(webCtx, {
        path: runtime.variant.statusPath,
        store: runtime.store,
        client: runtime.client,
        accountName: () => runtime.client.accountName,
        plan: () => runtime.client.accountPlan,
        models: () => runtime.catalog.all(),
        catalog: () => catalogSection(runtime),
        probe: () => probeSection(runtime, current().probeConsent === true),
        probeKey,
        authKey,
        ...(runtime.variant.id === CHINA_VARIANT.id
          ? {
            useMaximumContextWindow: () => current().useMaximumContextWindowCN === true,
            disabledModels: () => current().disabledModelsCN ?? [],
          }
          : {
            useMaximumContextWindow: () => current().useMaximumContextWindow === true,
            disabledModels: () => current().disabledModels ?? [],
          }),
        jobTokenRefreshedAt: runtime.jobTokenRefreshedAt,
        accounts: async () => {
          const [summaries, stored] = await Promise.all([
            runtime.store.accounts(),
            runtime.store.list(),
          ])
          /*
           * Price every pooled account from that account's OWN billing answer.
           *
           * The composer panel has to show what each account still holds before
           * the user switches to it, and only that account's token can say. The
           * reads go out in parallel through the account reader's per-token
           * cache, so a poll that repeats within the TTL costs no upstream
           * request. The active account is also priced below by `fetchCredits`,
           * which forces a fresh read and then caches it — so this row reuses
           * that answer on the next poll, and the only duplicate call is the
           * very first poll after a reload, when nothing is cached yet. A
           * failure prices one row as unknown rather than failing the document:
           * an account whose billing answer is down is exactly the one the user
           * may need to switch to.
           */
          const tokens = new Map(stored.map(account => [account.id, account.pat]))
          const entries = await Promise.all(summaries.map(async entry => {
            /*
             * Health rides every row, priced or not.
             *
             * It is read from this process's own observations, so a row whose
             * billing read fails still shows 限流/排队 — and that is exactly the
             * row where the label matters most, because "no credits answer" and
             * "cannot connect" are the two halves of the same story.
             */
            const health = runtime.healthOf(entry.id)
            const withHealth = health === undefined ? entry : { ...entry, health }
            const pat = tokens.get(entry.id)
            if (pat === undefined) return withHealth
            try {
              const billing = await runtime.client.fetchAccountBilling(pat)
              const plan = webPlan(billing.plan)
              return {
                ...withHealth,
                ...billing.accountName === undefined ? {} : { accountName: billing.accountName },
                ...plan === undefined ? {} : { plan },
                credits: billing.credits,
              }
            } catch (error: unknown) {
              return {
                ...withHealth,
                creditsError: error instanceof Error ? error.message.slice(0, 300) : String(error),
              }
            }
          }))
          const lastFailoverAt = runtime.failoverAt()
          const lastFailoverReason = runtime.failoverReason()
          return {
            entries,
            /*
             * The tag reports whether a failure could actually be absorbed, not
             * whether some policy bit is set: the walk needs a second seat it
             * may try AND the user's permission to try it. With one account (or
             * one usable account left after parking) there is nowhere to go,
             * and with the switch off the walk never runs — either way the
             * honest reading of 「自动切换」 is off, and it turns itself on the
             * moment both conditions hold.
             */
            /*
             * Counted across the whole pool, not just this variant's file.
             *
             * The walk now continues into the sibling's file, so a 1+1 split
             * pool (one account saved in each variant) can absorb a failure
             * even though each document lists a single seat. Reading only the
             * local rows would make both cards claim 「自动切换」 is idle while
             * the transport would happily switch — the tag would be lying in
             * the one configuration the feature was built for. The ROWS stay
             * per-variant (each document lists its own file, and the card
             * merges the two documents for its list), only this derived fact
             * is pool-wide.
             */
            autoFailover: autoFailoverActive(
              current().autoFailoverEnabled,
              await poolSeatFlags(pool()),
            ),
            /*
             * The switch as the user set it, which is a different claim from
             * `autoFailover` above: that one answers "could a failure be
             * absorbed", this one answers "did the user allow it". The card
             * needs both — a two-account pool with the switch off must not look
             * like it will fail over.
             */
            autoFailoverEnabled: current().autoFailoverEnabled !== false,
            routingStrategy: current().routingStrategy ?? 'save-order',
            routingOrder: current().routingOrder ?? [],
            ...lastFailoverAt === undefined ? {} : { lastFailoverAt },
            ...lastFailoverReason === undefined ? {} : { lastFailoverReason },
          }
        },
        upstreamNotice: runtime.upstreamNotice,
        checkIn: () => {
          const record = checkInStore.read(runtime.variant.id)
          if (record === undefined) return undefined
          const nextRunAt = checkInScheduler.nextRunAt(runtime.variant.id)
          return {
            ...record,
            // Rides the record so the card can show the pending moment: a day
            // already claimed stays silent by design, and without this the
            // user cannot tell a waiting timer from a missing one.
            ...nextRunAt === undefined ? {} : { nextRunAt },
          }
        },
        /*
         * The card asks whether the record describes the claim window that is
         * open RIGHT NOW, and it must not answer that with the browser's clock
         * or with the calendar date.
         *
         * Calendar date was the bug: the upstream's window opens at 10:00
         * UTC+8 and closes at 10:00 the next morning, so a benefit claimed at
         * 23:11 belongs to a window that is still running at 00:44 — yet the
         * calendar had rolled over, the comparison failed, and the card
         * offered 「立即领取」 for a benefit already granted.
         *
         * Computed per request, so a host left running across the 10:00
         * boundary starts reporting the next window without a restart. The
         * minute is the variant's own configured moment, the same one the
         * scheduler fires on, so the two halves cannot drift apart.
         */
        today: () => getClaimWindowDateString(Date.now(), variantWindowMinute()),
      })
      registerQoderAuthRoute(webCtx, {
        path: runtime.variant.authPath,
        save: async pat => {
          // Validate against the region this variant owns *before* anything is
          // written: a token that cannot answer discovery is refused with a
          // stable code, and the file never holds a credential the plugin has
          // not seen work.
          //
          // "Refused" and "could not ask" are different answers, and they were
          // previously collapsed into `qoder_invalid_pat` — which told a user
          // with a perfectly good token to go replace it whenever the endpoint
          // was slow or unreachable. The unreachable case keeps its own code so
          // the card can say "try again" instead of "your token is wrong".
          const validation = await validateApiKey(pat, runtime.variant.region)
          if (!validation.ok) {
            return validation.error === 'invalid'
              ? { ok: false, error: 'qoder_invalid_pat' as const, reason: validation.reason }
              : { ok: false, error: 'qoder_unreachable' as const, reason: validation.reason }
          }
          const credential = await runtime.store.save(pat)
          // Saving a token is the one transition the sweep would otherwise only
          // notice on its next tick; adopt it here so the model group appears
          // at once.
          const identity = credentialIdentity(credential)
          adoptIdentity(runtime, identity)
          // AWAIT the fetch: the card re-reads the status the moment this answer
          // lands, so returning first left it rendering the built-in roster
          // until the next poll or a manual refresh. `fetchCatalog` contains
          // its own failures (they surface as `catalog.error`), so a slow or
          // failing upstream can never turn a valid save into an error.
          await fetchCatalog(runtime, identity)
          return { ok: true, status: await runtime.store.status() }
        },
        activate: async accountId => {
          /*
           * Switching accounts changes which subscription pays, so the model
           * group must follow it in the same round trip: the card re-reads the
           * status the moment this answer lands, and an identity adopted a tick
           * later would render the previous account's roster and credits.
           */
          const credential = await runtime.store.activate(accountId)
          const identity = credentialIdentity(credential)
          adoptIdentity(runtime, identity)
          await fetchCatalog(runtime, identity)
          return await runtime.store.status()
        },
        remove: async accountId => {
          /*
           * The store decides what removal means for the active pointer (it
           * adopts the next account, or reports signed-out when the last one
           * goes); this only makes the consequence visible. Re-adopting the
           * identity unconditionally is what covers the case the store cannot
           * report through a credential: the removed account WAS the active
           * one, so the group and its cached catalog belong to a credential the
           * plugin no longer holds.
           */
          const removed = await runtime.store.remove(accountId)
          if (removed) {
            const credential = await runtime.store.current()
            adoptIdentity(runtime, credential === undefined ? undefined : credentialIdentity(credential))
          }
          return await runtime.store.status()
        },
        clear: async () => {
          await runtime.store.clear()
          adoptIdentity(runtime, undefined)
        },
        setEnabled: async (accountId, enabled) => {
          /*
           * Parking an account never moves the active pointer.
           *
           * The checkbox says "do not route here", not "switch away from
           * here": a user parking the account they are using keeps reading the
           * card with it selected, and the store deliberately leaves
           * `activeId` alone. The walk and the pool both ask
           * `enabled`/`nextAfter`, which already skip a parked row, so the
           * effect reaches requests without this route touching identity.
           *
           * Forgetting the account's health too: a row that comes back from
           * parked is a fresh start, and a 限流 label earned before the pause
           * would accuse an account nothing has asked anything of since.
           */
          const found = await runtime.store.setEnabled(accountId, enabled)
          if (found) runtime.forgetHealth(accountId)
          return await runtime.store.status()
        },
      }, authKey)
      registerQoderProbeRoute(webCtx, {
        path: runtime.variant.probePath,
        probe: async modelId => {
          // The authenticated manual endpoint is called only after per-model confirmation.
          const result = await runtime.probeService.probe(modelId, true)
          if (result.state === 'ok') runtime.invalidate()
          return result
        },
        clear: () => { runtime.probeStore.clear(); runtime.invalidate() },
        refresh: async () => {
          if (stopped) return { state: 'failed', reason: 'plugin is stopping' }
          // Re-read the credential first: the user pressed this because the list
          // looks wrong, and a token saved since the last sweep is the common
          // cause. Re-registering is unnecessary — visibility is what changes,
          // and the sweep owns that.
          let credential
          try {
            credential = await runtime.store.current()
          } catch (error: unknown) {
            // A refused credential (wrong region, unreadable file) is a report,
            // not a crash out of the route.
            return {
              state: 'failed',
              reason: error instanceof Error ? error.message.slice(0, 300) : String(error),
            }
          }
          if (credential === undefined) {
            adoptIdentity(runtime, undefined)
            return { state: 'signed-out' }
          }
          const identity = credentialIdentity(credential)
          // Same transition the sweep performs: a switch reached through the
          // manual path must drop the previous account's data *now*, not when
          // the fetch lands, or a failed fetch leaves those models pickable.
          adoptIdentity(runtime, identity)
          await fetchCatalog(runtime, identity)
          return runtime.catalogError === undefined
            ? { state: 'refreshed', reason: `${runtime.catalog.current().length} models` }
            : { state: 'failed', reason: runtime.catalogError }
        },
        checkIn: async () => {
          const result = await runtime.checkIn()
          if (result.status !== 'error') {
            /*
             * A day already settled by a GENUINE grant is not written again.
             *
             * The upstream answers `already-claimed` for every later request on
             * a claimed day, and that answer carries the CLICK clock rather
             * than the grant's, so re-writing the record would restamp the day
             * with a time the grant never happened at. The honest move is to
             * keep the original settlement and report the fresh answer.
             */
            // The window this click landed in, from the variant's own
            // configured moment — the same label the scheduler and the card
            // use. Taking `result.date` instead would let a retimed window's
            // record and its guard disagree.
            const window = getClaimWindowDateString(Date.now(), variantWindowMinute())
            const settled = (() => {
              const record = checkInStore.read(runtime.variant.id)
              return record?.lastDate === window
                && (record.status === 'claimed' || record.status === 'already-claimed')
            })()
            if (!settled) {
              checkInStore.write(runtime.variant.id, {
                lastDate: window,
                lastAt: result.timestamp,
                status: result.status,
                ...result.amount === undefined ? {} : { amount: result.amount },
                ...result.message === undefined ? {} : { message: result.message },
                // The granted package's own window when the upstream reported
                // one; absent leaves the card's documented 30-day convention
                // for a manual grant rather than a guessed date.
                ...result.expiresAtMs === undefined ? {} : { expiresAtMs: result.expiresAtMs },
              })
            }
            if (result.status === 'claimed') {
              void runtime.client.fetchCredits().catch(() => undefined)
            }
          }
          return {
            state: result.status,
            ...result.amount === undefined ? {} : { amount: result.amount },
            ...result.reasonCode === undefined ? {} : { reasonCode: result.reasonCode },
            ...result.message === undefined ? {} : { reason: result.message },
          }
        },
        ...runtime.variant.id === CHINA_VARIANT.id
          ? {
              setMaximumContextWindow: async enabled => {
                if (setMaximumContextWindowCN === undefined) return { state: 'failed', reason: 'settings are unavailable' }
                return setMaximumContextWindowCN(enabled)
              },
              setModelsEnabled: async opts => {
                if (setModelsEnabledCN === undefined) return { state: 'failed', reason: 'settings are unavailable' }
                return setModelsEnabledCN(opts)
              },
              setModelContextWindow: async opts => {
                if (setModelContextWindowCN === undefined) return { state: 'failed', reason: 'settings are unavailable' }
                return setModelContextWindowCN(opts)
              },
            }
          : {
              setMaximumContextWindow: async enabled => {
                if (setMaximumContextWindow === undefined) return { state: 'failed', reason: 'settings are unavailable' }
                return setMaximumContextWindow(enabled)
              },
              setModelsEnabled: async opts => {
                if (setModelsEnabled === undefined) return { state: 'failed', reason: 'settings are unavailable' }
                return setModelsEnabled(opts)
              },
              setModelContextWindow: async opts => {
                if (setModelContextWindow === undefined) return { state: 'failed', reason: 'settings are unavailable' }
                return setModelContextWindow(opts)
              },
            },
      }, probeKey)
    }

    // The settings face the browser cards read and write through. It answers
    // the whole entry's configuration as three layers (value = effective,
    // base = schema defaults, user = the settings file), which is exactly the
    // shape the 0.1.7 configForm used to mirror — the client-side cards keep
    // their staged-edit form untouched.
    //
    // The key is minted per plugin lifetime and rides the GET response (that
    // response already passed the loopback guard, like the probe routes); the
    // POST authorizes with it. Both guards are re-checked here: these routes
    // spend nothing upstream but they do rewrite the user's configuration.
    registerQoderSettingsFace(webCtx, {
      store, config, current,
      apply: applyCatalogSettings,
      rearm: () => { runStartupCatchUpOnce(); checkInScheduler.rearm() },
    })

    /*
     * The device-code reset: rotate the host-level seed, then forget every
     * cached job token so the next request re-derives its fingerprint.
     *
     * Order matters twice. Every transport is checked for the capability
     * BEFORE the seed is written, so a host that cannot honour the reset leaves
     * the seed (and therefore every identity) untouched rather than landing in a
     * half-rotated state. And the seed is written before the caches are
     * dropped: a write failure must not clear tokens that would then be re-minted
     * from the OLD seed.
     *
     * The count is every SAVED account, parked ones included, deduplicated by id:
     * the reset rotates one host-level seed, so it really does re-identify an
     * account the user parked as well as one that is serving. Counting only the
     * usable seats ({@link poolRing}) would report a smaller number than the
     * account list the user is looking at.
     */
    const resetDeviceCodes = async (): Promise<QoderDeviceResetOutcome> => {
      for (const runtime of runtimes) {
        if (typeof runtime.transport.resetDeviceIdentity !== 'function') {
          throw new Error('this host cannot reset device codes')
        }
      }
      rotateDeviceSeed()
      for (const runtime of runtimes) runtime.transport.resetDeviceIdentity?.()
      return { accounts: await savedAccountCount(pool) }
    }
    // Same key as the settings face: both are control writes the browser card
    // performs, and the card already holds that key from its settings document.
    registerQoderDeviceResetRoute(webCtx, { reset: resetDeviceCodes }, controlKeys().probe)
  })

  // Each settings section is what makes its namespace "served" — which is how
  // both the Plugins tab (card dispatch) and the Models settings page (provider
  // directory join) find this plugin's halves. One section per card, because the
  // tab renders a card by `entryKey = ns` and never interprets one: a section
  // that is not installed leaves its card registered but undispatched, and a
  // provider whose `settingsNs` names no section joins nothing.
  //
  // 两条宿主线共用一个写入口：插件自有文件（见 settings-store.ts）。
  //
  // 曾经这里按宿主形态分岔——0.1.5 用 `installSection` + `settings.update`
  // （watch 回调原地生效、毫秒级），0.1.7 用 `configEditor.edit`（每次写入都
  // reconcile 整棵 loader 树 + fiber 热重载，约 1~1.5 秒，并刷新所有客户端
  // 镜像）。现在两侧都不再向宿主编程配置：写落自有 JSON 文件，随后原地
  // apply（catalog 偏好、签到定时器重排、invalidate），0.1.5/0.1.7 行为一致。
  //
  // `configure({auto:false})` 保留：它只关掉宿主为这个 entry 自动生成的表单页
  // （本插件自带卡片），与持久化通路无关。
  ctx.inject(['settings'], settingsCtx => {
    /**
     * `auto: false` turns OFF the host's generated form page for this entry —
     * the plugin ships its own card, which is now the only editor. It must be
     * called as a METHOD: on 0.1.7 `configure` is a SettingsForms class method
     * (it reads `this.presentations`), and extracting it as a free function
     * throws a TypeError that used to kill the whole settings callback.
     */
    const settingsService = settingsCtx.settings as unknown as {
      configure?: (presentation: { auto: boolean }, owner?: unknown) => unknown
    }
    if (typeof settingsService.configure === 'function') {
      try {
        settingsCtx.effect((): (() => void) => {
          const dispose = settingsService.configure!({ auto: false }, ctx.fiber)
          return typeof dispose === 'function' ? (dispose as () => void) : () => {}
        })
      } catch (error: unknown) {
        console.error('[dsh-qoder-plugin] settings.configure failed (own settings file still serves):', error)
      }
    }

    /**
     * The four setters, now one implementation on both hosts: write the
     * plugin-owned settings file, then apply the new view in memory. No
     * profile-patch write means no tree reconcile, no fiber reload, and no
     * client-mirror storm per toggle.
     */
    const write = (patch: Record<string, unknown>): void => {
      // A card-originated write (every caller here is a user action on the
      // settings card), so the file becomes authoritative from this point on.
      store.patch(patch, true)
      applyCatalogSettings(current())
      checkInScheduler.rearm()
    }
    setMaximumContextWindow = async enabled => {
      write({ useMaximumContextWindow: enabled })
      return { state: 'updated' }
    }
    setMaximumContextWindowCN = async enabled => {
      write({ useMaximumContextWindowCN: enabled })
      return { state: 'updated' }
    }
    /**
     * Per-model window write, landed in the same settings field the multi
     * variant already reads (`modelContextWindows[CN]`) — the catalog honours
     * an override over the account-wide preference, so one model can take the
     * larger declared window while the rest keep the default.
     *
     * `window === 0` deletes the key rather than storing a zero: the catalog
     * skips non-positive overrides, and an absent key is the honest spelling
     * of 「no override」.
     */
    setModelContextWindow = async ({ model, window }) => {
      const windows = { ...((readConfigField(current(), 'modelContextWindows') as Record<string, number> | undefined) ?? {}) }
      if (window > 0) windows[model] = window
      else delete windows[model]
      write({ modelContextWindows: windows })
      return { state: 'updated' }
    }
    setModelContextWindowCN = async ({ model, window }) => {
      const windows = { ...((readConfigField(current(), 'modelContextWindowsCN') as Record<string, number> | undefined) ?? {}) }
      if (window > 0) windows[model] = window
      else delete windows[model]
      write({ modelContextWindowsCN: windows })
      return { state: 'updated' }
    }
    setModelsEnabled = async ({ models, enabled }) => {
      const currentDisabled = new Set((readConfigField(current(), 'disabledModels') as readonly string[] | undefined) ?? [])
      for (const m of models) {
        if (enabled) currentDisabled.delete(m)
        else currentDisabled.add(m)
      }
      write({ disabledModels: Array.from(currentDisabled) })
      return { state: 'updated' }
    }
    setModelsEnabledCN = async ({ models, enabled }) => {
      const currentDisabled = new Set((readConfigField(current(), 'disabledModelsCN') as readonly string[] | undefined) ?? [])
      for (const m of models) {
        if (enabled) currentDisabled.delete(m)
        else currentDisabled.add(m)
      }
      write({ disabledModelsCN: Array.from(currentDisabled) })
      return { state: 'updated' }
    }
  })

  ctx.effect(() => () => {
    stopped = true
    checkInScheduler.dispose()
    for (const timer of timers) clearInterval(timer)
    timers.length = 0
    /*
     * Abort any catalog fetch still in flight. `stopped` is set first, so the
     * fetch's own catch reports nothing (a disposed plugin has no card left to
     * warn) and its promise resolves rather than rejecting; what this buys is
     * the socket — a disposed fiber must not leave an upstream request open,
     * and the request may outlive the plugin by the whole fetch timeout.
     */
    for (const runtime of runtimes) {
      runtime.inflightFetch?.controller.abort()
      runtime.inflightFetch = undefined
    }
    detach(ctx, clearHostHeartbeat(), 'host heartbeat cleanup')
  })

  /**
   * Fetch one variant's catalog for the current credential.
   *
   * Shared by the credential sweep and the card's manual refresh, and written
   * so that concurrent callers cost one request and cannot interleave badly:
   *
   * - **One request at a time.** A second caller joins the in-flight fetch
   *   instead of starting its own (spec §5: one catalog request per variant at
   *   a time).
   * - **Generation-checked write-back.** The request records the generation it
   *   started under and writes nothing if the generation moved on — which is
   *   what a slow answer from a superseded account must not do. Checking only
   *   the *identity* was not enough: two refreshes for the same account can
   *   still finish out of order, and the older one would win.
   * - **`resolve()`, not `current()`.** A catalog fetch demands a usable token;
   *   the difference from `current()` is that its absence surfaces as the same
   *   classified `MISSING_CREDENTIAL` failure every other request path reports,
   *   rather than as a silent "no credential" that would hide a bad file on
   *   disk behind an env override.
   */
  const fetchCatalog = async (runtime: VariantRuntime, identity: string): Promise<void> => {
    const inflight = runtime.inflightFetch
    const generation = runtime.catalogGeneration
    if (inflight !== undefined && inflight.identity === identity && inflight.generation === generation) {
      return inflight.promise
    }
    // A caller should normally reach this only after `adoptIdentity()` has
    // already cancelled a previous generation. Keep this guard local as well:
    // no stale request may prevent the current account from fetching now.
    inflight?.controller.abort()
    const controller = new AbortController()
    let run: Promise<void>
    run = (async (): Promise<void> => {
      let models: readonly QoderModelInfo[]
      try {
        // Establish the identity that owns this fetch from the file-backed
        // credential; discovery itself reads the token through the same store.
        const credential = await runtime.store.resolve()
        const resolvedIdentity = credentialIdentity(credential)
        if (resolvedIdentity !== identity) {
          adoptIdentity(runtime, resolvedIdentity)
          await fetchCatalog(runtime, resolvedIdentity)
          return
        }
        models = await runtime.client.fetchModels(controller.signal)
        // The token can also change while the upstream request is in flight.
        // Re-read before publishing so the just-finished roster still belongs
        // to the credential that is currently in effect.
        const latest = await runtime.store.current()
        const latestIdentity = latest === undefined ? undefined : credentialIdentity(latest)
        if (latestIdentity !== identity) {
          adoptIdentity(runtime, latestIdentity)
          if (latestIdentity !== undefined) await fetchCatalog(runtime, latestIdentity)
          return
        }
      } catch (error: unknown) {
        // Report only if this attempt is still the current one; a failure from
        // a superseded attempt must not overwrite the newer state's error.
        if (stopped || runtime.catalogGeneration !== generation) return
        runtime.lastFetchAtMs = Date.now()
        runtime.catalogError = error instanceof Error ? error.message.slice(0, 300) : String(error)
        ctx.logger.warn(
          `dsh-qoder-plugin: ${runtime.variant.displayName} catalog unavailable; serving the fallback list`,
          error,
        )
        runtime.invalidate()
        return
      }
      if (stopped || runtime.catalogGeneration !== generation) return
      runtime.lastFetchAtMs = Date.now()
      // Shared across fiber reloads: a 0.1.7 settings write re-applies this
      // plugin, and the new instance must not re-fetch what was just fetched.
      lastLiveFetchAt.set(identity, runtime.lastFetchAtMs)
      runtime.catalog.set([...models])
      runtime.catalogSource = 'live'
      runtime.catalogFetchedAtMs = runtime.client.lastCatalog?.fetchedAtMs ?? Date.now()
      runtime.catalogError = undefined
      // Remember it for this account, so a restart — or a later fetch that
      // fails — can serve what this account was actually shown rather than the
      // snapshot compiled into the plugin. A failure to persist is reported and
      // swallowed: the live catalog is already serving, and `fetchCatalog`
      // promises its callers that it never rejects (an escaped rejection from a
      // background sweep would terminate the host).
      if (lastIdentities.get(runtime.variant.id) === identity) {
        try {
          runtime.savedCatalogs.set(identity, {
            source: runtime.client.lastCatalog?.source ?? 'unknown',
            fetchedAtMs: runtime.client.lastCatalog?.fetchedAtMs ?? Date.now(),
            models: [...models],
          })
        } catch (error: unknown) {
          ctx.logger.warn(
            `dsh-qoder-plugin: ${runtime.variant.displayName} catalog could not be saved for this account`,
            error,
          )
        }
      }
      runtime.invalidate()
    })().finally(() => {
      if (runtime.inflightFetch?.promise === run) runtime.inflightFetch = undefined
    })
    runtime.inflightFetch = { identity, generation, controller, promise: run }
    return run
  }

  /**
   * Reconcile one variant with its credentials.
   *
   * Four transitions matter, and each is a different action:
   *
   * - **none → some** (first sighting): reveal the group and fetch a catalog.
   * - **none → some, identity changed**: additionally drop the previous
   *   account's observations, so another token's probe answers cannot be read
   *   as the new one's.
   * - **some → none**: hide the group and stop serving its models.
   * - **same identity**: nothing to do — a PAT neither rotates nor expires, so
   *   re-fetching on every sweep would hit the catalog endpoint for no new
   *   information.
   */
  const syncVariant = async (runtime: VariantRuntime): Promise<void> => {
    if (stopped || !runtime.registered) return
    const credential = await runtime.store.current().catch((error: unknown) => {
      // A region mismatch or an unreadable file is reported, not swallowed as
      // "signed out": the user needs to know which file to fix.
      ctx.logger.warn(`dsh-qoder-plugin: ${runtime.variant.displayName} credential read failed`, error)
      return undefined
    })
    if (stopped) return

    if (credential === undefined) {
      adoptIdentity(runtime, undefined)
      return
    }

    const identity = credentialIdentity(credential)
    const known = lastIdentities.get(runtime.variant.id)
    if (known === identity && runtime.catalog.isVisible()) {
      // Same account, already showing something. One case still needs a fetch:
      // an earlier attempt failed, so the group is on the fallback roster and
      // nothing else will ever replace it. Retry on a slow backoff rather than
      // every sweep, so a persistent outage does not become a request loop.
      // Any non-live source is stale: both the saved catalog and the built-in
      // roster are worth replacing with a fresh fetch on the same backoff.
      //
      // The freshness read is per-IDENTITY and survives a fiber reload: a 0.1.7
      // settings write reloads this plugin, and the new instance's
      // `lastFetchAtMs` starts at 0 — without the shared record every write
      // would immediately re-fetch both variants from upstream.
      const stale = runtime.catalogSource !== 'live'
      const fetchedAt = lastLiveFetchAt.get(identity) ?? 0
      const due = Date.now() - fetchedAt >= credentialPollMs() * CATALOG_RETRY_SWEEPS
      if (stale && due) await fetchCatalog(runtime, identity)
      return
    }

    adoptIdentity(runtime, identity)
    await fetchCatalog(runtime, identity)
  }

  /** Run one reconcile sweep across both variants. */
  const syncAll = async (): Promise<void> => {
    for (const runtime of runtimes) await syncVariant(runtime)
  }

  /**
   * Start both variants, then begin the credential sweep.
   *
   * The chain carries its own failure handler: without one, a rejection here
   * would be an unhandled rejection — which Node turns into process
   * termination, taking the whole Harness down over one plugin's startup.
   */
  detach(ctx, Promise.all(runtimes.map(async runtime => startVariant(ctx, runtime, async () => {
    // The immediate seed: adopt whatever credential is in effect right now, so
    // a reloaded fiber never serves an empty catalog while the sweep catches up.
    if (stopped) return
    let credential
    try {
      credential = await runtime.store.current()
    } catch {
      return
    }
    if (credential === undefined) return
    const identity = credentialIdentity(credential)
    if (lastIdentities.get(runtime.variant.id) !== identity || !runtime.catalog.isVisible()) {
      adoptIdentity(runtime, identity)
    }
  }))).then(() => {
    if (stopped) return
    // The host bundle is live: write a heartbeat so the status CLI can report
    // host health without a browser. Cleared on disposal; a stale heartbeat
    // after a crash is detected by PID in the reader. Written when at least one
    // variant registered, since that is what "the host bundle serves models"
    // means for this plugin.
    if (runtimes.some(runtime => runtime.registered)) detach(ctx, writeHostHeartbeat(), 'host heartbeat write')

    detach(ctx, syncAll(), 'credential sweep')
    const timer = setInterval(() => { detach(ctx, syncAll(), 'credential sweep') }, credentialPollMs())
    timer.unref?.()
    timers.push(timer)
  }), 'variant startup')
}
