/** The only external seam for communication with Qoder. */

import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import type { AttachmentStore } from '@deepseek-ai/dsh-attachment'
import type { QoderAccountInfo } from '../account.ts'
import type { QoderCatalogModel } from '../catalog.ts'
import type { QoderRegion } from '../region.ts'
import type { QoderCheckInResult } from './checkin.ts'
import type { QoderQueueFacts, QoderQueueWaitProgress, QoderQueueWaitSummary } from '../queue-notice.ts'
import { DefaultQoderTransport, defaultStreamIdleTimeoutMs } from './default-transport.ts'
import { defaultResponseHeaderTimeoutMs } from './request.ts'
import type { QoderLogger } from './logging.ts'

export { defaultResponseHeaderTimeoutMs, defaultStreamIdleTimeoutMs }
export type { QoderCheckInResult, QoderQueueWaitSummary }

export interface QoderTransport {
  stream(options: GenerateOptions, model?: QoderCatalogModel): AsyncIterable<StreamChunk>
  discoverModels(signal?: AbortSignal): Promise<readonly QoderCatalogModel[]>
  /**
   * Read one account's billing answer.
   *
   * `pat` names the account to read; without it the ambient credential signs,
   * which is what the card's single-account quota read does. With it, the host
   * can price every pooled account in one status document without switching the
   * active pointer — the read is a plain GET, it does not adopt the credential.
   */
  readAccount(options?: { force?: boolean | undefined; signal?: AbortSignal | undefined; pat?: string | undefined; minIntervalMs?: number | undefined }): Promise<QoderAccountInfo>
  checkIn(signal?: AbortSignal): Promise<QoderCheckInResult>
  /**
   * Drop every cached job token, so the next request re-derives its device id.
   *
   * Called after the host rotates the device seed: the per-account
   * `Cosy-Machineid`/`Cosy-Machinehostname` are minted during the token exchange
   * and cached with it, so this is the only way an already-signed-in account can
   * pick up a new fingerprint. Optional so a host or a test double that does not
   * model device identity stays a valid transport; the host reports the reset as
   * failed rather than pretending when it is missing.
   */
  resetDeviceIdentity?(): void
}

/**
 * One account the pool can hand to the transport.
 *
 * `region` is the region that account was SAVED under, and it is what makes a
 * pool able to span the two Qoder variants: the host keeps one credential file
 * per region, so a pooled account that lives in the other file must be signed
 * against the other region's endpoints. The transport uses `region` for exactly
 * that — it never writes an account's region anywhere, and the file's own
 * region stamp stays authoritative.
 *
 * Optional because a host that pools one region only (or an older host) can
 * leave it off; the transport then falls back to its own construction region.
 */
export interface QoderPooledAccount {
  readonly id: string
  readonly pat: string
  /** The region whose endpoints this account may sign against. */
  readonly region?: QoderRegion
}

/**
 * The credential pool's seam into the transport: which account signs now, which
 * one to try next, and how a switch is announced.
 *
 * The transport never reads the credential store itself — it asks. That keeps
 * "which account is active" a single decision owned by the host, and lets a
 * signed-out or env-only variant expose no pool at all.
 */
export interface QoderFailoverHooks {
  /** Whether automatic switching is on for this transport right now. */
  enabled(): boolean
  /** The pooled account that should sign the request, when there is one. */
  activeAccount(): Promise<QoderPooledAccount | undefined>
  /** The account after `id` in save order; `undefined` ends the walk. */
  nextAccount(id: string): Promise<QoderPooledAccount | undefined>
  /**
   * Resolve one stored account id to its credential, `undefined` when the id
   * names no account any more.
   *
   * `nextAccount` can only answer "who comes after this one in save order",
   * which is enough for a plain walk but not for the two features that name an
   * account directly: a custom `routing.order` picks ids in the user's order,
   * and a sticky session starts from the account the session was pinned to.
   * Both must also be able to find out that an id is gone — a removed account
   * would otherwise keep signing, because the pin remembered its credential.
   *
   * Optional so the plain walk keeps working without it: with no resolver the
   * transport falls back to save order (routing) and to the credential it
   * captured when the session was pinned (stickiness).
   */
  accountById?(id: string): Promise<QoderPooledAccount | undefined>
  /**
   * Announce a switch, before the retry is made.
   *
   * Awaiting it is load-bearing: the retry signs with the PAT this hook handed
   * over, but a mid-request credential refresh (the image publisher's) resolves
   * the store's active account, so the host's adoption has to have landed by
   * the time that path can run.
   */
  switched(info: {
    readonly fromId: string
    readonly toId: string
    readonly reason: string
    /** The conversation this switch belongs to; see `onUpstreamQueue`'s id. */
    readonly sessionId?: string
  }): void | Promise<void>
  /**
   * Adopt a dispatch decision that moved this request to another account for a
   * reason that is NOT a failure of the request (today: the active account is
   * cooling down after repeated failures).
   *
   * This must stay silent — no user-visible notice and no "last failover"
   * timestamp, because nothing about the request failed. It exists because the
   * host persists whichever account is active, and the host's metadata reads
   * (catalog, billing) sign with that account: leaving a cooling credential
   * active would move the chat path off it while the status card kept reading
   * through it. A merely busy account is never adopted; another request is just
   * using it this second.
   *
   * Awaiting is load-bearing for the same reason as `switched`: the adoption has
   * to have landed before another path resolves the active account.
   */
  adopted?(info: { fromId: string; toId: string; reason: 'cooling' }): void | Promise<void>
  /**
   * Report that one pooled account could not serve a request at all.
   *
   * Fired for the failures that advance the walk (a connection-level failure
   * the account could not self-heal: transport error, timeout, dropped stream,
   * an upstream 5xx or a rate limit) — never for a refused request, which says
   * the upstream answered and judged it, and never for a queue answer, which is
   * a busy model rather than a broken credential.
   *
   * The distinction is the host's evidence for the card's 限流 label: a pile of
   * these against one account is what "this account cannot connect" looks like
   * from inside the plugin, and there is nowhere else that observation exists.
   * Optional so a host that tracks no health simply does not listen.
   */
  failed?(info: { accountId: string; reason: string; at: number }): void
}

export interface QoderTransportOptions {
  region: QoderRegion
  resolvePat: () => Promise<string>
  fetch?: typeof fetch
  logger?: QoderLogger
  streamIdleTimeoutMs?: number
  responseHeaderTimeoutMs?: number
  metadataTimeoutMs?: number
  resolveMachineId?: () => string
  /**
   * The host-level seed that perturbs each account's derived device id.
   *
   * Read once per credential mint; rotating the seed (and calling
   * {@link QoderTransport.resetDeviceIdentity}) is how the reset control gives
   * every account a new fingerprint. Absent means the historical derivation,
   * which is what keeps an upgrade from changing anyone's identity.
   */
  resolveDeviceSeed?: (() => string | undefined) | undefined
  attachments?: Pick<AttachmentStore, 'imageLimits' | 'readImageRequest'>
  /** Deadline for one center image publication attempt. */
  imageUploadTimeoutMs?: number
  /** Lifetime of a remembered center image URL. */
  imageUrlCacheTtlMs?: number
  /** Whether prior assistant reasoning content is preserved across turns. */
  preserveThinking?: boolean
  /**
   * Automatic next-account failover for the chat path.
   *
   * Absent, or present with `enabled()` false, is exactly the pre-failover
   * behavior: the ambient credential signs, and a failure propagates untouched.
   */
  failover?: QoderFailoverHooks
  /**
   * Called when a request ends on the upstream's "model not serviceable"
   * answer (a saturated per-model queue), with the facts the body carried.
   *
   * Reported on the *final* failure of a request, after any same-account
   * self-heal and any account failover have had their chance: a request that
   * recovered needs no explanation, and a queue the user never saw resolved
   * itself. The host turns this into the visible notice, so the explanation is
   * built from the body that actually caused the failure rather than from a
   * status code guessed at the surface.
   *
   * @param accountId - The pooled account whose attempt produced this terminal
   *   failure, `undefined` when no pooled account signed (an env-only
   *   credential, or switching turned off). The id travels WITH the attempt
   *   rather than being remembered on the transport: requests run concurrently,
   *   and a shared "last account" field would let one request's failure be
   *   blamed on another request's account.
   * @param sessionId - The conversation the failed request belongs to, taken
   *   from the request itself rather than from any remembered "current" agent:
   *   several conversations run at once, and a notice printed into whichever one
   *   most recently looked busy is a notice about someone else's request (this
   *   is what made rows land in the wrong conversation). Absent when the request
   *   carries no session, in which case the host falls back to its best guess.
   * @param waits - The waits THIS request completed before the final answer,
   *   accumulated per request rather than remembered on the transport: requests
   *   run concurrently, and a transport-wide "last wait" would let one request's
   *   wait be reported beside another request's failure. Absent (or `attempts`
   *   0) when the request never waited, which the host needs to keep the "no
   *   wait" sentence honest.
   */
  onUpstreamQueue?: (
    facts: QoderQueueFacts,
    accountId?: string,
    sessionId?: string,
    waits?: QoderQueueWaitSummary,
  ) => void
  /**
   * Called right before this transport waits out a queue answer, once per wait.
   *
   * `onUpstreamQueue` only fires on the request's FINAL failure, so a request
   * that waited one or two advise windows used to sit silent until it either
   * recovered or gave up — a 30–90 second empty conversation that looked like a
   * hang. This hook reports the wait as it starts (its duration and its place in
   * the request's budget), which is what lets the host show progress instead of
   * explaining the queue only after the retry has already failed.
   *
   * Not fired when `queueWait.attempts` is 0: no wait happens then, and the
   * final-failure notice already covers the terminal answer.
   *
   * @param accountId - The account the waiting attempt signs with, `undefined`
   *   for the ambient credential.
   * @param wait - The wait about to start; see
   *   {@link QoderQueueWaitProgress}.
   * @param sessionId - The conversation whose request is waiting, for the same
   *   reason {@link onUpstreamQueue} carries it: the row must print where the
   *   wait actually happened.
   */
  onQueueWait?: (facts: QoderQueueFacts, accountId: string | undefined, wait: QoderQueueWaitProgress, sessionId?: string) => void
  /**
   * Called when the upstream accepted a chat — its first chunk is about to be
   * forwarded — so any condition an earlier failure notice described is over.
   *
   * The counterpart of `onUpstreamQueue`: that one announces a saturated queue
   * on the request's final failure, and this one is the only honest way to take
   * the announcement back, because acceptance is the one moment "the model
   * serves requests again" is actually known. The host turns it into the end of
   * the visible notice. A rejected chat throws before any chunk exists, so this
   * never fires on a failing attempt.
   *
   * @param accountId - The pooled account whose attempt the upstream accepted,
   *   `undefined` when no pooled account signed. Carried per attempt for the
   *   same reason as `onUpstreamQueue`'s id, and it is what lets the host mark
   *   the right account healthy while other requests are failing on others.
   * @param sessionId - The conversation whose request the upstream accepted. The
   *   host uses it to report a deferred job-token rotation only to the
   *   conversation that actually earned it: one rotation is shared by every
   *   concurrent request, so an acceptance elsewhere must not claim a recovery
   *   this conversation never waited for.
   */
  onChatAccepted?: (accountId?: string, sessionId?: string) => void
  /**
   * Called once per successful re-auth refresh, right after a fresh job token
   * was exchanged and accepted following a 401 rejection. The plugin host
   * surfaces this as a visible "token auto-refreshed" notice on its card.
   */
  onJobTokenRefreshed?: (info: { region: QoderRegion; at: number; sessionId?: string }) => void
  /**
   * Called once per unresolved self-heal failure: the transport exchanged a
   * fresh job token, retried the chat, and the upstream rejected it anyway.
   *
   * The success notice alone left this case silent — the user saw only a bare
   * authorization failure with no sign that the plugin had already tried to
   * recover. Reported at most once per outage (reset when a later chat is
   * accepted), so a long rejection storm does not print a row per retry.
   */
  onJobTokenRefreshFailed?: (info: {
    region: QoderRegion
    at: number
    status?: number
    /** The conversation whose heal failed; see {@link onChatAccepted}'s id. */
    sessionId?: string
  }) => void
  /**
   * Retry a queued chat on the same account instead of giving up on it.
   *
   * A queue answer is not an account failure — the credential behind it is
   * fine — so switching identity would neither shorten the wait nor be fair to
   * the account that would receive the request. The wait *is* the recovery, so
   * it happens inside the attempt and before any failover decision, and a retry
   * that succeeds leaves no notice behind, because no error ever escapes.
   *
   * Both values are providers rather than plain numbers so the host can project
   * the live settings of each request instead of freezing them at construction.
   */
  queueWait?: {
    /**
     * How many times one REQUEST may wait a queue answer out.
     *
     * The budget is spent on the request, not refreshed per account: a request
     * that walks the pool is still one caller waiting, and resetting the budget
     * on a switch would multiply the caller's wait by the pool size.
     */
    attempts: () => number
    /**
     * Fallback wait in seconds, used only when the queue answer advertises no
     * window of its own: the upstream's advice is the better estimate of when
     * the line moves, so it wins and is capped at five minutes.
     */
    seconds: () => number
  }
  /**
   * Keep a session on one account, and change account when a bound is reached.
   *
   * The three bounds are independent: whichever a conversation reaches first
   * moves it on. "Moves it on" means the next request of that session starts on
   * the NEXT account of the walk order — a rotation, not just losing the pin,
   * because a lapsed pin that fell back to the active account would keep the
   * conversation on the same account forever and the setting would look
   * ignored.
   *
   * All three providers returning zero disables stickiness, which is the only
   * way to get the pre-stickiness behaviour of always using the active account.
   */
  stickiness?: {
    /**
     * Whether stickiness is on at all.
     *
     * When false the transport never pins a session to an account, regardless
     * of what the bounds say. This is the master switch the settings UI owns;
     * the three bounds below are only read while it is on.
     */
    enabled: () => boolean
    /**
     * Conversation rounds one account serves before the session moves on.
     *
     * A round is one chat whose output the host consumed to the end: a request
     * that fails, or that the caller abandons mid-stream, is not a round.
     */
    rounds: () => number
    /** Requests one account serves before the session moves on. */
    requests: () => number
    /** Wall-clock minutes one account serves before the session moves on. */
    minutes: () => number
  }
  /**
   * The order the failover walk visits the remaining accounts in.
   *
   * `order` is consulted only for `'custom'`. Ids it names that resolve to no
   * account (through `failover.accountById`) are skipped, and an order that can
   * serve nobody falls back to save order rather than ending the walk on a list
   * the user has since edited.
   */
  routing?: {
    strategy: () => 'save-order' | 'custom'
    order: () => readonly string[]
  }
  /**
   * Clock used for the stickiness windows. Injectable so a test can age a pin
   * out without waiting for real minutes, and so the host can share one clock.
   */
  now?: () => number
  /**
   * Randomness for the queue wait's jitter.
   *
   * Injectable so a test can pin the spread instead of asserting on a
   * distribution; production leaves it to `Math.random`.
   */
  random?: () => number
}

export function createQoderTransport(options: QoderTransportOptions): QoderTransport {
  return new DefaultQoderTransport(options)
}
