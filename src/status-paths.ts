/** Node-free constants and types shared by the Host and browser halves. */

import type { QoderQueueWaitSummary } from './qoder/queue-notice.ts'
import type { QoderRegion } from './qoder/region.ts'

/** The two Qoder product variants this plugin serves, by provider id. */
export type QoderVariantId = 'qoder' | 'qoder-global'

/** Plugin-owned status endpoint consumed by its browser half. */
export const QODER_STATUS_PATH = '/plugins/dsh-qoder-plugin/status'

/**
 * Plugin-owned settings endpoint consumed by its browser half.
 *
 * GET answers the whole entry configuration as three layers (value/base/user)
 * plus the write key; POST applies one patch. This is the plugin's own settings
 * surface, replacing writes through the host's settings service — see
 * {@link ./settings-store.ts} for why.
 */
export const QODER_SETTINGS_FACE_PATH = '/plugins/dsh-qoder-plugin/settings'

/**
 * Plugin-owned probe control endpoint.
 *
 * Separate from the status route because it accepts writes: the status route's
 * loopback Host/Origin guard protects against a DNS-rebinding *page*, which is
 * not the same as authorizing a state-changing action. This route therefore
 * also requires the in-process key the browser half receives with the status
 * document.
 */
export const QODER_PROBE_PATH = '/plugins/dsh-qoder-plugin/probe'

/**
 * Plugin-owned PAT endpoint, one per variant.
 *
 * A POST here saves (validates and persists) a Personal Access Token, or
 * clears the stored one. Unlike the read-only status GET it is a write —
 * it persists a credential — so it also requires the in-process key the
 * browser half receives with the status document.
 */
export const QODER_AUTH_PATH = '/plugins/dsh-qoder-plugin/auth'

/**
 * The international (Qoder Global) variant's own triple of routes.
 *
 * Kept as separate constants rather than a computed suffix so both halves
 * reference literal strings: the browser bundle and the host bundle are built
 * independently, and a shared expression is one build-config drift away from
 * the desk asking a route the host never mounted.
 */
export const QODER_GLOBAL_STATUS_PATH = '/plugins/dsh-qoder-plugin/global/status'
export const QODER_GLOBAL_PROBE_PATH = '/plugins/dsh-qoder-plugin/global/probe'
export const QODER_GLOBAL_AUTH_PATH = '/plugins/dsh-qoder-plugin/global/auth'

/**
 * Plugin-owned device-code reset endpoint.
 *
 * One POST rotates the host-level device seed and drops every cached job token,
 * which is what makes each saved account present a new `Cosy-Machineid` /
 * `Cosy-Machinehostname` on its next request. A write (it changes what every
 * account claims to be), so it carries the same loopback Host/Origin guard and
 * the in-process settings key as the other control routes.
 */
export const QODER_DEVICE_RESET_PATH = '/plugins/dsh-qoder-plugin/device-reset'

/**
 * Plugin-owned native-component (UMID) install endpoint.
 *
 * One POST starts a background job that installs the official `runtime-info`
 * component into the host-level component directory, which is what lets the
 * international daily campaign be requested on a machine with no Qoder desktop
 * client. A write (it puts an executable on disk), so it carries the same
 * loopback Host/Origin guard and the in-process settings key as the other
 * control routes.
 */
export const QODER_UMID_INSTALL_PATH = '/plugins/dsh-qoder-plugin/umid-install'

/**
 * One action the PAT route accepts.
 *
 * `save-pat` validates the pasted token against the variant's region and, only
 * on success, persists it (an already-stored token is re-selected rather than
 * duplicated); `activate-account` switches which stored token signs requests;
 * `remove-account` drops one stored token; `set-account-enabled` parks one
 * stored token without deleting it — the failover walk skips it and the
 * composer panel leaves its credits out, yet it stays saved and stays
 * hand-signable; `clear` removes every stored credential. There is no device
 * flow and no credential import: the token is the whole auth surface.
 */
export type QoderAuthAction = 'save-pat' | 'clear' | 'activate-account' | 'remove-account' | 'set-account-enabled'

/** Request body accepted by the PAT route. */
export interface QoderAuthRequest {
  action: QoderAuthAction
  /** The token to validate and store; required for `save-pat`. */
  pat?: string
  /**
   * The stable id of the stored account to act on; required for
   * `activate-account`, `remove-account` and `set-account-enabled`.
   *
   * Never the token itself: the id is the credential's one-way hash
   * (`qoderCredentialIdentity`), which is what the status document hands the
   * card, so a card can only ever name an account the host told it about.
   */
  accountId?: string
  /**
   * The new enablement for `set-account-enabled`.
   *
   * Required for that action and rejected for every other one: a missing value
   * there is a malformed request, not "keep it as it is", because a card that
   * lost the value would otherwise silently re-enable an account the user had
   * just parked.
   */
  enabled?: boolean
}

/**
 * One stored account, as the card lists it.
 *
 * A variant may hold several PATs (the user's own, a colleague's, a spare), and
 * which one signs a request is a choice rather than a constant. This is the
 * browser-safe projection of one entry: the display facts plus the two pieces
 * of identity the card needs to act on it — never the token.
 */
export interface QoderAccountSummary {
  /** Stable account id: the credential's one-way hash, safe to display. */
  id: string
  /** Last four characters of the token, enough to tell two of them apart. */
  patTail?: string
  /** The subscriber name the upstream reported for this account, when known. */
  accountName?: string
  /** When this token was saved, epoch milliseconds. */
  savedAtMs?: number
  /** Where this credential came from when it was stored. */
  source: QoderCredentialSource
  /** Whether this is the account that currently signs requests. */
  active: boolean
  /**
   * 1-based position in the order automatic failover walks.
   *
   * The switch order is the order the accounts were saved in, which is the
   * only ordering the plugin can honestly claim: it has no per-account health
   * ranking to sort by, and inventing one would reorder a user's list behind
   * their back.
   */
  order: number
  /**
   * This account's own plan, when the host could read it.
   *
   * The composer panel prices every pooled account, not just the one that
   * signs; each row carries the plan its credits belong to so a spare seat's
   * tier is visible before the user switches to it.
   */
  plan?: QoderWebPlan
  /** This account's own credits, from that account's billing answer. */
  credits?: QoderWebCredits
  /**
   * Why this account's billing answer is missing, when the read failed.
   *
   * A failed price must not hide an account the user can still switch to, so
   * the row survives with an explanation instead of disappearing or showing a
   * stale figure borrowed from another account.
   */
  creditsError?: string
  /**
   * Whether automatic switching may pick this account.
   *
   * A disabled account stays saved and stays signable when the user activates
   * it by hand; it is simply never chosen by the failover walk, and the
   * composer panel leaves its credits out. Absent means enabled — documents
   * written before this field existed must keep every account usable.
   */
  enabled?: boolean
  /**
   * This account's observed service state, from its own request outcomes.
   *
   * `normal`: the last state was a successful connection. `queued`: the last
   * upstream answer was its per-model queue notice, still fresh (the queue is a
   * per-model fact, so this is a short-lived observation, not a verdict about
   * the credential). `limited`: repeated connection failures cooled the account
   * down. Absent when the plugin has observed nothing yet.
   */
  health?: QoderAccountHealth
}

/** One account's observed service state (see {@link QoderAccountSummary.health}). */
export type QoderAccountHealth = 'normal' | 'queued' | 'limited'

/**
 * The account pool and its failover policy, as the card displays them.
 *
 * `autoFailover` is a derived fact, not the user's preference: it answers
 * "could a connection failure be absorbed right now", which needs both the
 * switch on ({@link autoFailoverEnabled}) and a second usable seat in the walk.
 * Switching accounts changes which subscription pays for a request, so the
 * preference itself stays opt-out-able even though it is on by default.
 */
export interface QoderWebAccounts {
  entries: readonly QoderAccountSummary[]
  /**
   * Whether a connection failure could be absorbed right now: the switch is on
   * and at least two accounts are usable (parked ones are out of the walk).
   */
  autoFailover: boolean
  /**
   * The last automatic switch, epoch ms; absent when none has happened in this
   * process. The card renders it so an otherwise silent account change shows.
   */
  lastFailoverAt?: number
  /** Why the last automatic switch happened, a short redacted reason. */
  lastFailoverReason?: string
  /**
   * Whether the user enabled automatic switching at all.
   *
   * Distinct from {@link autoFailover}: that one reports whether a failure
   * COULD be absorbed right now (two or more usable accounts, switching on).
   * This one is the raw preference, which the advanced settings render as a
   * switch even when only one account is saved.
   */
  autoFailoverEnabled?: boolean
  /**
   * The account ids in the order the walk tries them, as configured.
   *
   * Empty when the user never reordered anything, in which case the walk uses
   * save order. Ids that name accounts of the other variant are carried here
   * too: one list spans both variants, and each variant's walk simply skips
   * the ids that are not its own.
   */
  routingOrder?: readonly string[]
  /** Which strategy the walk follows: the save order, or {@link routingOrder}. */
  routingStrategy?: 'save-order' | 'custom'
}

/** Where the credential in effect came from. */
export type QoderCredentialSource = 'card' | 'env' | 'cli'

/**
 * Redacted summary of one variant's PAT.
 *
 * Never the token itself: the browser half displays where the credential came
 * from, when it was saved, and the last four characters — enough to tell two
 * tokens apart, not enough to misuse one.
 */
export interface QoderPatSummary {
  source: QoderCredentialSource
  /** When the stored token was saved, epoch milliseconds; absent for env fallback. */
  savedAtMs?: number
  /** Last four characters of the token. */
  patTail?: string
  /** The subscriber name the credential belongs to, when the upstream reported one. */
  accountName?: string
}

/**
 * The subscriber's coding plan, as the card displays it.
 *
 * The upstream's `/api/v2/user/plan` answer is fetched on every account read
 * but had no consumer: the card could show how many credits were left without
 * ever naming the plan those credits belong to, so a paid seat looked exactly
 * like a free one. This is the browser-safe projection of that answer — only
 * the facts the card renders, with the raw payload and the organization's
 * management flags left behind on the host side.
 *
 * Only `planTierName` is required. The upstream omits dates and organization
 * for personal seats, and a plan the upstream did not describe is absent
 * entirely rather than invented; renderers show what is present and omit the
 * rest instead of guessing a tier or a date.
 */
export interface QoderWebPlan {
  /** The plan's display name, e.g. "Pro". */
  planTierName: string
  /** The organization the seat belongs to, when it is not a personal one. */
  organizationName?: string
  /** When the current plan term ends, verbatim from the upstream. */
  endDate?: string
}

/** One model's recorded probe observation, as the card displays it. */
export interface QoderWebProbeModel {
  id: string
  name: string
  /** `validating` results carry efforts; the other states never do. */
  validation: 'validating' | 'non-validating' | 'unknown'
  efforts: readonly string[]
  probedAt: number
}

/** Probe section of the status document. */
export interface QoderWebProbeSection {
  /** Whether the user has authorized probing. */
  consent: boolean
  /** Whether a sweep is in flight right now. */
  running: boolean
  /** Models the user could probe by hand (undeclared yet reasoning-capable). */
  candidates: readonly string[]
  /** Recorded observations. */
  results: readonly QoderWebProbeModel[]
}

/** Action requested from the probe control route. */
export interface QoderProbeAction {
  /**
   * `probe` spends credit on one model; `clear` drops recorded observations;
   * `refresh` re-reads the credential and re-fetches the model catalog;
   * `set-maximum-context-window` persists the card's maximum-window
   * preference (one per variant section).
   *
   * All are writes, which is why they share this route's in-process key
   * and loopback guards rather than the read-only status GET.
   */
  action: 'probe' | 'clear' | 'refresh' | 'set-maximum-context-window' | 'checkin' | 'set-models-enabled' | 'set-model-context-window'
  /** Target model id; required for `probe` and `set-model-context-window`. */
  model?: string
  /** Requested value for `set-maximum-context-window` or `set-models-enabled`. */
  enabled?: boolean
  /** Requested per-model window tokens; 0 clears the override. */
  window?: number
  /** Target model ids for `set-models-enabled` (supports single, batch, or all). */
  models?: readonly string[]
}

/**
 * Where the models a card is currently showing came from.
 *
 * The plan requires the card to distinguish a live catalog from the built-in
 * fallback, and to say when the last attempt failed — otherwise a stale list is
 * indistinguishable from an offline one, and a user cannot tell whether the
 * models they see still match the upstream.
 */
export interface QoderWebCatalog {
  /**
   * Where the models on screen came from, in degradation order:
   * `live` (fetched now) → `saved` (this account's last successful fetch,
   * restored after a restart or a failed fetch) → `fallback` (the roster
   * compiled into the plugin). The card distinguishes them because "stale" and
   * "offline with a saved list" are different situations for the user.
   */
  source: 'live' | 'saved' | 'fallback'
  /** When the live catalog last succeeded, epoch ms. */
  fetchedAt?: number
  /** Why the most recent fetch failed, when it did, redacted for display. */
  error?: string
}

/** One quota package and its remaining credit. */
export interface QoderWebCreditAccount {
  packageName: string
  remain: number
  size: number
  unlimited?: true
  /**
   * When the package's credit expires, carried through in whatever form the
   * upstream reported it (an ISO string or a numeric epoch-millisecond value
   * normalized to an ISO string). Absent when the upstream reported no
   * expiry — rendered as "no expiry", never guessed into a date.
   */
  packageEndTime?: string
}

/** Aggregated credit answer rendered by the plugin card. */
export interface QoderWebCredits {
  /**
   * Usage percentage across the account (0..100), taken from the Qoder quota
   * answer's `userQuota.percentage`. The card renders its headline from this.
   */
  total: number
  /** Summed per-package totals — the denominator of the dashboard's bar. */
  totalSize?: number
  accounts: readonly QoderWebCreditAccount[]
  /** The account's quota is uncapped; renderers test this flag first. */
  unlimited?: true
  /** When the current quota cycle ends, verbatim from the upstream. */
  cycleResetTime?: string
}

/**
 * One catalog model as the status document snapshots it.
 *
 * A plain-Qoder mirror of `src/qoder/catalog.ts`'s `QoderCatalogModel` (the
 * WorkBuddy-era billing/promotion/free fields are gone): the browser half
 * renders reasoning, price factor, and context capacity from these fields and
 * nothing else. Field names follow the Qoder catalog vocabulary so the two
 * halves cannot drift on spelling.
 */
export interface QoderCatalogModelSnapshot {
  id: string
  name: string
  /** Effective input budget in tokens. */
  contextWindow?: number
  /** The upstream's preferred window before a larger one is selected. */
  defaultContextWindow?: number
  /** Selectable window sizes the upstream declares, ascending. */
  supportedContextWindows?: readonly number[]
  /** Whether the model reasons at all. */
  isReasoning?: boolean
  /** Effort ids the model advertises (wire spellings). */
  reasoningEfforts?: readonly string[]
  /** The model's default effort id, when the upstream names one. */
  defaultReasoningEffort?: string
  /** Price multiplier vs the baseline (1 = base rate); absent means unknown. */
  priceFactor?: number
  /** Whether the model accepts image input. */
  supportsImages?: boolean
  /** Upstream provenance marker (`system` / `user`), when reported. */
  source?: string
}

/**
 * One upstream "this model is not serviceable" answer, as the card shows it.
 *
 * Qoder answers a saturated per-model queue (or a region whose service is off)
 * with HTTP 401/403/200 whose body carries `code: 10605`, `isQueued`,
 * `serviceAvailable`, and `retryAfterSeconds`. That answer is emphatically NOT
 * a credential or quota problem, and the two ways it used to be misreported
 * were both actively misleading: as `AUTH` it sent the user to replace a
 * perfectly good token, and as a bare `RATE_LIMIT` it said "throttled" while
 * hiding the one fact that matters — the model is unavailable, and coming back
 * later is the whole remedy. This carries the explanation, and the upstream's
 * own words, to the surfaces that show it.
 */
export interface QoderWebUpstreamNotice {
  /** `queued`: a saturated per-model queue. `unavailable`: the service is off. */
  kind: 'queued' | 'unavailable'
  /** The upstream's own message, verbatim and bounded, for the user to quote. */
  upstreamMessage?: string
  /** The delay the upstream asked for, milliseconds. */
  retryAfterMs?: number
  /**
   * Whether the plugin actually waited that delay and retried before
   * reporting. The notice's own wording claims a wait, so the claim is carried
   * as a fact rather than assumed by the renderer.
   */
  waited: boolean
  /** When the notice was recorded, epoch milliseconds. */
  at: number
  /** How many times this same notice has recurred in this process. */
  occurrences: number
  /**
   * The waits the failed request itself completed, when the transport reported
   * them.
   *
   * `waited` above stays the coarse card flag; this is the evidence behind it.
   * A configured-fallback wait has no advised seconds to quote, so the row needs
   * the measured total to say how long the request really sat — and the card
   * needs to distinguish "waited the upstream's window" from "waited the
   * configured fallback". Absent for a request that never waited.
   */
  waits?: QoderQueueWaitSummary
}

/**
 * State of the official native device-identity component.
 *
 * The international daily campaign is gated on machine-identity headers that
 * only the official `runtime-info` component can produce, so whether that
 * component is present on this host is the difference between "today's credits
 * can be requested" and "they cannot, and here is the one action that fixes
 * it". Carried on every status arm — a signed-out card and a failed card are
 * exactly the two places a user needs the install entry point, and a field
 * present only on the signed-in arm would hide it there.
 */
export interface QoderNativeDeviceStatus {
  /**
   * Whether this concept applies at all — i.e. the host serves the
   * international variant, the only one whose campaign is identity-gated.
   * A China-only install renders nothing rather than an empty section.
   */
  applicable: boolean
  /** Whether a usable component is present in {@link dir}. */
  installed: boolean
  /** The host-level component directory, whether or not it is populated. */
  dir: string
  /** Package version the component was extracted from, when recorded. */
  version?: string
  /** The post-install self-check result, when one was recorded. */
  selfCheck?: { ok: boolean; at?: string; reason?: string }
  /** Whether an install job is running right now. */
  installing: boolean
  /** Identifier of the running install job, when one is running. */
  jobId?: string
  /** The last install failure, redacted, for the card to show verbatim. */
  lastError?: string
  /**
   * Where the machine identity in effect came from.
   *
   * `cache-stale` is the case worth surfacing: the component is gone (deleted
   * by antivirus, or `~/.dsh` cleaned) but a previously sampled identity is
   * still usable, so check-in keeps working while a re-sample is retried in the
   * background. Without this the card cannot distinguish that from a fresh
   * read.
   */
  identity?: {
    /** When the identity was sampled, epoch milliseconds. */
    cachedAt: number
    /** Whether it is past its configured TTL. */
    stale: boolean
    source: 'component' | 'cache' | 'cache-stale'
  }
}

/** The JSON document the plugin card renders. */
export type QoderWebStatus =
  | {
    status: 'signed-in'
    /** Which upstream region the stored token belongs to. */
    region?: QoderRegion
    /** Redacted summary of the PAT in effect. */
    pat?: QoderPatSummary
    /**
     * The account pool and its failover policy.
     *
     * Present even with a single account (`entries.length === 1`): the card
     * renders the list from this alone, so a separate single-account shape
     * would be a second code path that only ever shows one row.
     */
    accounts?: QoderWebAccounts
    /**
     * The most recent upstream "not serviceable" answer, when one is in effect.
     * Absent when the upstream has not refused a model on this variant.
     */
    upstreamNotice?: QoderWebUpstreamNotice
    /**
     * The subscriber's coding plan, when the upstream described one.
     *
     * Absent for an account whose plan read failed or reported nothing —
     * renderers omit the line rather than guess a tier.
     */
    plan?: QoderWebPlan
    credits?: QoderWebCredits
    creditsError?: string
    /** The models the plugin serves, as catalog snapshots. */
    models?: readonly QoderCatalogModelSnapshot[]
    /** Where those models came from, and whether the last fetch failed. */
    catalog?: QoderWebCatalog
    /** Reasoning-effort probe state, consent, and recorded observations. */
    probe?: QoderWebProbeSection
    /** Card preference selecting larger declared context windows. */
    useMaximumContextWindow?: boolean
    /** Disabled model IDs (blacklist) for this variant. */
    disabledModels?: readonly string[]
    /**
     * The last automatic job-token refresh the self-heal performed, epoch ms.
     * Absent when no refresh has happened in this process. The card renders
     * this as a visible "token auto-refreshed" notice, so an otherwise
     * invisible recovery is observable.
     */
    jobTokenRefreshedAt?: number
    /**
     * Inner-stream error counts observed by this process, per class.
     *
     * A 200 stream can still fail with the upstream's real reason inside an
     * inner chunk (content policy, queue/throttle, auth, invalid request).
     * Those failures are counted by the wire decoder and surfaced here through
     * the status channel, which is the existing read-only health view; the
     * card's account-pool section renders the non-zero classes as a caption,
     * so a failure that never reached the status code is still visible to the
     * user. Counters are per process and reset on restart.
     */
    innerErrors?: Partial<Record<
      'content_policy' | 'rate_limit' | 'invalid_request' | 'auth' | 'other',
      number
    >>
    /**
     * In-process key authorizing probe control writes. Handed to the card with
     * the status document (the card is same-origin and already had to pass the
     * loopback guard); it is never persisted and rotates per process.
     */
    probeKey?: string
    /**
     * Daily check-in status record for this variant.
     */
    checkIn?: {
      lastDate: string
      /**
       * Today's date in UTC+8, computed host-side.
       *
       * The card must compare `lastDate` against today before calling a day
       * settled, and it must NOT do that comparison with the browser's clock:
       * the plugin standardizes on UTC+8 deliberately, while the browser sits
       * in whatever timezone the user is in. Shipping the host's own UTC+8
       * answer means both halves read one clock, and the browser never has to
       * reimplement the offset arithmetic.
       */
      today: string
      lastAt: number
      status: 'claimed' | 'already-claimed' | 'no-campaign' | 'error'
      amount?: number | undefined
      message?: string | undefined
      /** When today's claimed grant lapses, epoch ms; absent when unreported. */
      expiresAtMs?: number | undefined
      /**
       * When the scheduler's timer is next due, epoch ms.
       *
       * A day already claimed goes deliberately quiet, so without this the
       * card cannot tell "scheduled and waiting" from "no timer at all" —
       * which is exactly the doubt a missing timer created.
       */
      nextRunAt?: number | undefined
    }
    /**
     * In-process key authorizing PAT writes, including clearing. Travels with
     * the document for the same reason `probeKey` does.
     */
    authKey?: string
    /** Native device-identity component state; see {@link QoderNativeDeviceStatus}. */
    nativeDevice?: QoderNativeDeviceStatus
  }
  | {
    /**
     * No usable token, and the card may save one.
     *
     * Its own arm rather than an optional field on the signed-in document,
     * because the PAT key below is exactly what a signed-out card needs and a
     * signed-in one does not: the two states ask for different actions, and a
     * single arm would let a card offer clear and save at once.
     */
    status: 'signed-out'
    /**
     * Why no credential is usable, when that is diagnosable rather than simply
     * "nobody signed in" — a stale WorkBuddy-era credential file being the
     * case that matters. The card renders it in place of the generic hint.
     */
    reason?: string
    /**
     * In-process key authorizing PAT writes; see the signed-in arm's
     * `probeKey` for why it travels with the document.
     */
    authKey?: string
    /**
     * Native device-identity component state.
     *
     * Carried on this arm too: a signed-out card is one of the two places the
     * install entry point is most needed — the international campaign cannot be
     * requested at all without the component, so the reason a newly signed-in
     * user sees no credits would otherwise be invisible until after sign-in.
     */
    nativeDevice?: QoderNativeDeviceStatus
  }
  | {
    status: 'error'
    message: string
    /** Native device-identity component state; see the signed-in arm. */
    nativeDevice?: QoderNativeDeviceStatus
  }
