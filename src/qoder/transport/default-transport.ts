/** Deep module owning all communication with Qoder. */

import { LlmError, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import type { AttachmentStore } from '@deepseek-ai/dsh-attachment'
import { QoderAuthService } from './auth.ts'
import type { QoderCatalogModel } from '../catalog.ts'
import type { QoderRegion } from './endpoints.ts'
import { QoderLlmError, isQoderAuthRejection } from '../errors.ts'
import { QoderAccountPenaltyLedger, type QoderAccountPenaltyKind } from '../../account-health.ts'
import { QoderAccountTrafficLimiter } from './account-limiter.ts'
import type { QoderLogger } from './logging.ts'
import { fetchQoderModels } from './catalog-reader.ts'
import {
  defaultResponseHeaderTimeoutMs,
  opaqueCredentialKey,
  retryMetadataRead,
  SingleFlight,
} from './request.ts'
import { translateQoderMessages, validateQoderRequestShape } from './wire/serialize.ts'
import { QoderImageUploader } from './image-upload.ts'
import { QoderUsageReader } from './account-reader.ts'
import { QoderCheckInService, type QoderCheckInResult } from './checkin.ts'
import type { QoderAccountInfo } from '../account.ts'
import type { QoderTransport, QoderTransportOptions } from './index.ts'
import { streamQoderChat } from './chat.ts'
import type { CosyCredentials } from './wire/cosy.ts'
import type { QoderWireMessage } from './wire/wire-types.ts'

export const defaultStreamIdleTimeoutMs = 5 * 60 * 1000

/**
 * How long a rotated-token notice may wait for an accepting chat.
 *
 * The heal's own retry can lose a race with a transient fault and be rescued
 * by a later attempt, so the notice is deferred until some chat is accepted.
 * That deferral has to be bounded: an unbounded one let a rotation from
 * minutes earlier surface as a fresh-looking row whose timestamp named a
 * moment the user could not connect to the row appearing now. Five minutes
 * comfortably covers the host's own retry cycle (its backoff caps at 10s)
 * while keeping the row adjacent to the event it describes.
 */
const jobTokenNoticeMaxAgeMs = 5 * 60 * 1000

/**
 * Longest single queue wait the transport will honour.
 *
 * A queue answer can carry a retry window the upstream computed, and nothing
 * stops that window from naming hours. Holding a request open for hours is not
 * a wait, it is a hang: the caller's own retry cycle is shorter than that, and
 * the user would rather see the queue explained than a spinner that outlives
 * their patience. Waits longer than this are capped and the queue is reported
 * on the next failure.
 */
const queueWaitCeilingMs = 5 * 60 * 1000

/**
 * The fixed margin and the jitter spread added to every queue wait.
 *
 * The upstream's advice names the moment IT will let the next request in, and
 * every client that received the same answer will wake at that same moment —
 * a stampede the queue then has to answer again. A one-second margin plus a
 * spread of up to two seconds turns that synchronised wake-up into a trickle,
 * which is why the wait is not simply the advised window.
 */
const queueWaitPaddingMs = 1_000
const queueWaitJitterMs = 2_000

/**
 * Most session pins the transport remembers at once.
 *
 * A host process can carry thousands of sessions, and each pin is small but not
 * free. The cap only ever costs an evicted session its stickiness — it picks an
 * account again on its next request — so it is a memory bound, not a
 * correctness one. Exported so the bound itself can be tested.
 */
export const sessionPinCapacity = 512

/**
 * How many `nextAccount` hops one selection may take while looking for an
 * account that is not cooling down.
 *
 * The host owns the walk order, so this cannot be derived from a pool size; it
 * only has to be larger than any realistic pool and finite, so a host whose
 * `nextAccount` wraps or echoes ids cannot trap selection in a loop.
 */
const maxWalkSearchSteps = 64

/**
 * How a failure is recorded in the penalty ledger.
 *
 * Kept next to `isAccountFailure` because it is the same judgment one level
 * deeper: the walk has already decided the failure says something about the
 * account, and this decides how much it costs. A rate limit is an upstream
 * pacing the subscription; everything else the account could not serve at all.
 * The status fallback mirrors `isAccountFailure` so an untyped failure that the
 * walk accepted is still classified consistently.
 */
function penaltyKind(error: unknown): QoderAccountPenaltyKind {
  if (error instanceof LlmError) {
    const status = error.failure.status
    if (error.code === 'RATE_LIMIT' || status === 429) return 'rate-limit'
    if (
      error.code === 'AUTH'
      || error.code === 'SERVER'
      || error.code === 'TIMEOUT'
      || error.code === 'TRANSIENT'
      || error.code === 'TRANSPORT'
      || error.code === 'EMPTY_RESPONSE'
      || status === 401
      || status === 403
      || status === 418
      || (status !== undefined && status >= 500 && status <= 599)
    ) {
      return 'hard'
    }
  }
  // Anything the walk accepted but this function cannot name is a fault shape
  // the plugin does not understand yet: too weak to stop the account, strong
  // enough to prefer its siblings for the next while.
  return 'unknown'
}

/**
 * One session's claim on one account, with the two counters its bounds read.
 *
 * The credential is remembered beside the id because a pinned session may start
 * while its account is not the active one, and re-resolving it on every request
 * would need a store lookup per turn. When the host does expose `accountById`
 * the pin is re-resolved through it, so an account the user removed can never
 * keep signing requests.
 *
 * The counters are what let a bound be reached EXACTLY: a pin that merely
 * counted down "further rounds" could not also honour a request bound, and one
 * that stored an absolute expiry could not start counting from the instant the
 * account actually took over the session.
 */
interface SessionPin {
  id: string
  pat: string
  /** Wall-clock instant this account took over the session. */
  pinnedAtMs: number
  /** Conversations this account served to the end while holding the pin. */
  rounds: number
  /** Requests this account started while holding the pin. */
  requests: number
}

/**
 * The pooled account one request is currently being attempted on.
 *
 * Created per request and threaded down into the walk rather than kept as a
 * transport field, because one transport serves concurrent requests: a shared
 * "current account" would let one request's terminal failure be reported
 * against another request's account.
 */
interface AttemptAttribution {
  accountId: string | undefined
}

function aborted(message: string): QoderLlmError {
  return new QoderLlmError(message, 'ABORTED')
}

/**
 * Whether a failure says something about the ACCOUNT rather than the request.
 *
 * A malformed request fails identically on every account, so switching would
 * only trade a clear error for a slower identical one — and adopt an identity
 * nothing needed. `INVALID_REQUEST` is therefore excluded explicitly, and the
 * remaining signals are the connection-level family (the fetch never completed,
 * the handshake or stream timed out, the response carried no body to stream)
 * plus the account-level classifications. `TRANSIENT` belongs to that last
 * family: it is the code `qoderHttpError` gives HTTP 418, which upstream uses
 * to wrap its own provider fault, and another identity can clear it. `QUOTA` is
 * deliberately not one of them: the frozen spec enumerates what failover
 * answers to, and a depleted quota is an account fact the user resolves by
 * choosing another account.
 *
 * A queue answer is excluded for the same reason one step removed. It is the
 * upstream's statement about a busy MODEL (`isQueued`, `serviceAvailable:false`)
 * that merely travels wearing `RATE_LIMIT` and the upstream's 403 — see
 * `qoderHttpError`. No credential queue-jumps a model, so the walk would only
 * spend a second subscription on the same answer, and because a switch reports
 * the previous condition over, it would also erase the explanation this plugin
 * owes the user for exactly that answer (observed end to end: a two-account
 * pool answered the queue on B, `upstreamNotice` came back undefined, and the
 * stored active account had moved). The queue is reported, never retried
 * against another identity.
 */
function isAccountFailure(error: unknown): boolean {
  if (!(error instanceof LlmError)) return false
  if (error.code === 'INVALID_REQUEST') return false
  if (error instanceof QoderLlmError && error.qoderQueue !== undefined) return false
  if (
    error.code === 'AUTH'
    || error.code === 'RATE_LIMIT'
    || error.code === 'SERVER'
    || error.code === 'TIMEOUT'
    || error.code === 'TRANSIENT'
    || error.code === 'TRANSPORT'
    || error.code === 'EMPTY_RESPONSE'
  ) {
    return true
  }
  const status = error.failure.status
  return status !== undefined
    && (status === 401 || status === 403 || status === 418 || status === 429 || (status >= 500 && status <= 599))
}

/**
 * A short, redacted account-switch reason for the host's `switched` record.
 *
 * It names the classification and status only: the upstream's message can quote
 * request content, and the credential must never travel into a notice.
 */
function switchReason(error: unknown): string {
  if (error instanceof LlmError) {
    const status = error.failure.status
    return status === undefined ? `upstream ${error.code}` : `upstream ${error.code} (HTTP ${status})`
  }
  return 'connection failure'
}

export class DefaultQoderTransport implements QoderTransport {
  private readonly region: QoderRegion
  private readonly resolvePat: () => Promise<string>
  private readonly fetchImpl: typeof fetch
  private readonly logger: QoderLogger | undefined
  private readonly streamIdleTimeoutMs: number
  private readonly responseHeaderTimeoutMs: number
  private readonly metadataTimeoutMs: number | undefined
  private readonly auth: QoderAuthService
  private readonly usage: QoderUsageReader
  private readonly checkInService: QoderCheckInService
  private readonly modelFlights = new SingleFlight<readonly QoderCatalogModel[]>()
  private readonly attachments: Pick<AttachmentStore, 'imageLimits' | 'readImageRequest'> | undefined
  private readonly imageUploader: QoderImageUploader
  private readonly preserveThinking: boolean | undefined
  private readonly failover: QoderTransportOptions['failover']
  private readonly onUpstreamQueue: QoderTransportOptions['onUpstreamQueue']
  /**
   * The accepted-chat callback, named apart from `onChatAccepted` because that
   * name is the seam this transport fires it from.
   */
  private readonly chatAccepted: QoderTransportOptions['onChatAccepted']
  private readonly onJobTokenRefreshed: QoderTransportOptions['onJobTokenRefreshed']
  private readonly onJobTokenRefreshFailed: QoderTransportOptions['onJobTokenRefreshFailed']
  private readonly queueWait: QoderTransportOptions['queueWait']
  private readonly stickiness: QoderTransportOptions['stickiness']
  private readonly routing: QoderTransportOptions['routing']
  private readonly now: () => number
  /**
   * Randomness for the queue wait's jitter, injectable so a test can pin the
   * spread instead of asserting on a distribution.
   */
  private readonly random: () => number
  /**
   * Per-account traffic guard, keyed by `account.id` (see `account-limiter.ts`).
   *
   * It lives on the transport rather than on the host because only the
   * transport knows which account each attempt actually signs with; the host
   * sees one stream call, not the pool walk behind it.
   */
  private readonly traffic: QoderAccountTrafficLimiter
  /**
   * Accounts a request has claimed for dispatch but not yet finished with.
   *
   * Two requests that both start on the active account would otherwise land on
   * the same credential in the same instant — the pool walk only runs after a
   * failure, so nothing before it knows another request is already there. The
   * reservation makes "who is already serving" visible to the walk's account
   * choice, exactly the way a cooldown already is.
   */
  private readonly reservedAccounts = new Set<string>()
  /**
   * What repeated failures have cost each pooled account (T5).
   *
   * Per transport, hence per variant and per process, and never persisted: a
   * cooldown describes the upstream's current treatment of an account, which a
   * restart does not know. The ledger carries only facts the transport itself
   * observed, and only once another account has exonerated the failure's
   * request — see `generateWithAccounts`.
   */
  private readonly penalties: QoderAccountPenaltyLedger
  /**
   * Session → account pins, least recently used first.
   *
   * Stickiness cannot live in the host's stored account state: that state names
   * one active account for the whole plugin, and the point of a pin is that two
   * sessions may legitimately sit on two accounts at the same time. A bounded
   * map keyed by the session id the caller already supplies is therefore the
   * storage, ordered by Map insertion so the oldest pin is the one evicted.
   */
  private readonly sessionPins = new Map<string, SessionPin>()
  /**
   * Set when the self-heal exchanged a fresh job token, cleared when a chat
   * afterwards succeeds. The notice reports "the token was rotated because the
   * old one was rejected", which is true from that exchange on — so it must
   * not be tied to the heal's OWN retry, which can still lose a race with a
   * transient upstream timeout and be rescued by a later attempt.
   */
  private pendingRefreshAt: number | undefined
  /**
   * Whether the current unresolved heal failure has already been reported.
   *
   * One upstream rejection can outlive many host-level retries (an observed
   * storm ran 59 of them across 75 steps), and the transport re-heals inside
   * every one of them. Without this latch the failure notice would print once
   * per retry; with it, the user is told once per outage. Cleared as soon as
   * any chat is accepted, so the next outage announces itself again.
   */
  private refreshFailureAnnounced = false

  constructor(options: QoderTransportOptions) {
    this.region = options.region
    this.resolvePat = options.resolvePat
    this.fetchImpl = options.fetch ?? globalThis.fetch
    this.logger = options.logger
    this.streamIdleTimeoutMs = options.streamIdleTimeoutMs ?? defaultStreamIdleTimeoutMs
    this.responseHeaderTimeoutMs = options.responseHeaderTimeoutMs ?? defaultResponseHeaderTimeoutMs
    this.metadataTimeoutMs = options.metadataTimeoutMs
    this.attachments = options.attachments
    this.preserveThinking = options.preserveThinking
    this.failover = options.failover
    this.onUpstreamQueue = options.onUpstreamQueue
    this.chatAccepted = options.onChatAccepted
    this.onJobTokenRefreshed = options.onJobTokenRefreshed
    this.onJobTokenRefreshFailed = options.onJobTokenRefreshFailed
    this.queueWait = options.queueWait
    this.stickiness = options.stickiness
    this.routing = options.routing
    this.now = options.now ?? Date.now
    this.random = options.random ?? Math.random
    // The ledger reads the same injectable clock as the rest of the transport,
    // so a test can age a cooldown out without waiting ten real minutes.
    this.penalties = new QoderAccountPenaltyLedger(this.now)
    // The guard shares the transport's clock and randomness so pacing, queue
    // waits and penalty cooldowns all agree on the same timeline in a test.
    this.traffic = new QoderAccountTrafficLimiter({
      now: this.now,
      random: this.random,
      onFailOpen: (info) => {
        // The fail-open is a safety valve, not a normal path: if it fires the
        // account is more contended than the guard was tuned for, and silently
        // letting the burst through would hide exactly that.
        this.logger?.warn?.('[Qoder Stream] Account traffic guard timed out waiting for its turn; letting the request through', {
          accountId: info.accountId,
          waitedMs: info.waitedMs,
        })
      },
    })
    this.auth = new QoderAuthService({
      fetch: this.fetchImpl,
      logger: this.logger,
      region: this.region,
      resolveMachineId: options.resolveMachineId,
    })
    this.imageUploader = new QoderImageUploader({
      fetch: this.fetchImpl,
      logger: this.logger,
      region: this.region,
      ...options.imageUploadTimeoutMs === undefined ? {} : { timeoutMs: options.imageUploadTimeoutMs },
      ...options.imageUrlCacheTtlMs === undefined ? {} : { cacheTtlMs: options.imageUrlCacheTtlMs },
      refreshCredentials: async (signal) => {
        const pat = await this.requirePat(signal)
        this.auth.clear(pat)
        return this.auth.getCredentials(pat, signal)
      },
    })
    this.usage = new QoderUsageReader({
      authService: this.auth,
      fetch: this.fetchImpl,
      logger: this.logger,
      region: this.region,
      timeoutMs: this.metadataTimeoutMs,
    })
    this.checkInService = new QoderCheckInService({
      authService: this.auth,
      fetch: this.fetchImpl,
      logger: this.logger,
      region: this.region,
      timeoutMs: this.metadataTimeoutMs,
    })
  }

  stream(options: GenerateOptions, model?: QoderCatalogModel): AsyncIterable<StreamChunk> {
    return this.generate(options, model)
  }

  /**
   * Report the pending self-heal once a chat is accepted, then clear it.
   *
   * The notice means "the stale token was rejected, so it was rotated, and the
   * chat works again" — all three are true by the time a chat is accepted
   * after the refresh, no matter which attempt delivered it.
   */
  private flushPendingRefreshNotice(): void {
    if (this.pendingRefreshAt === undefined) return
    const at = this.pendingRefreshAt
    this.pendingRefreshAt = undefined
    // A rotation whose acceptance took this long is no longer news. Printing
    // it would drop a row into the conversation long after the fact, and its
    // timestamp would name a moment the user has no reason to connect to now —
    // which reads exactly like a clock bug (observed: a 16:56 rotation
    // reported at 17:47). Dropping it keeps the notice meaningful.
    if (Date.now() - at > jobTokenNoticeMaxAgeMs) return
    this.logger?.warn?.('[Qoder Stream] Job token was auto-refreshed after an upstream rejection; the chat has recovered')
    this.onJobTokenRefreshed?.({ region: this.region, at })
  }

  /**
   * Drop a pending rotation notice whose heal did not rescue anything.
   *
   * The heal's own retry was rejected too, so "the rotation fixed it" is not
   * what happened. Leaving the notice pending made a LATER, unrelated chat
   * acceptance flush it — printing a success row that contradicts the failure
   * row already shown, stamped with the old rotation time.
   */
  private discardPendingRefreshNotice(): void {
    this.pendingRefreshAt = undefined
  }

  /**
   * Note that the upstream accepted a chat, ending any unresolved heal failure.
   *
   * `streamChat` calls this the moment its first chunk arrives — the only point
   * at which "the credential was accepted" is actually known. A rejected chat
   * throws before that, so this never fires on a failing attempt.
   *
   * Acceptance is equally proof that the condition an earlier failure announced
   * is over, so the host is told here as well: it owns that notice's wording and
   * lifetime, and nothing in the transport can retract it later.
   */
  private onChatAccepted(accountId?: string): void {
    this.refreshFailureAnnounced = false
    this.flushPendingRefreshNotice()
    this.chatAccepted?.(accountId)
  }

  async discoverModels(signal?: AbortSignal): Promise<readonly QoderCatalogModel[]> {
    const pat = await this.requirePat(signal)
    const key = opaqueCredentialKey(pat)
    return this.modelFlights.run(
      key,
      signal,
      async (sharedSignal) => {
        const credentials = await this.auth.getCredentials(pat, sharedSignal)
        return retryMetadataRead(sharedSignal, () => fetchQoderModels(credentials, {
          fetch: this.fetchImpl,
          signal: sharedSignal,
          logger: this.logger,
          region: this.region,
          timeoutMs: this.metadataTimeoutMs,
        }))
      },
      () => aborted('Qoder model discovery was aborted.'),
    )
  }

  async readAccount(options?: { force?: boolean | undefined; signal?: AbortSignal | undefined; pat?: string | undefined; minIntervalMs?: number | undefined }): Promise<QoderAccountInfo> {
    // An explicit token reads THAT account; the ambient credential is only the
    // fallback. Reading a pooled account must never adopt it — the active
    // pointer moves through the store, not through a billing read.
    const pat = options?.pat ?? await this.requirePat(options?.signal)
    return this.usage.readAccount(pat, {
      force: options?.force,
      signal: options?.signal,
      ...options?.minIntervalMs === undefined ? {} : { minIntervalMs: options.minIntervalMs },
    })
  }

  async checkIn(signal?: AbortSignal): Promise<QoderCheckInResult> {
    const pat = await this.requirePat(signal)
    return this.checkInService.checkIn(pat, signal)
  }

  private async requirePat(signal?: AbortSignal): Promise<string> {
    if (signal?.aborted) throw aborted('Qoder request was aborted.')
    const pat = (await this.resolvePat()).trim()
    if (!pat) {
      throw new QoderLlmError(
        'Qoder Personal Access Token is missing. Configure Qoder in the Qoder settings page.',
        'MISSING_CREDENTIAL',
      )
    }
    if (signal?.aborted) throw aborted('Qoder request was aborted.')
    return pat
  }

  /**
   * Stream one chat, reporting acceptance as soon as the FIRST chunk arrives.
   *
   * `streamQoderChat` throws before yielding anything when the upstream rejects
   * the request, so a first chunk means the credential was accepted. Reporting
   * at that moment — rather than after the whole stream drains — matters
   * because the consumer may close the stream early, and code after a
   * completed `yield*` would then never run.
   *
   * @param onAccepted - Called once, before the first chunk is forwarded.
   * @param onFirstByte - Called only when there is a chunk to forward, so a
   *   caller can tell "the upstream accepted this credential" apart from "the
   *   consumer has already seen bytes", which an empty stream would conflate.
   */
  private async * streamChat(
    options: GenerateOptions,
    model: QoderCatalogModel | undefined,
    credentials: CosyCredentials,
    messages: QoderWireMessage[],
    onAccepted: () => void,
    onFirstByte?: () => void,
  ): AsyncGenerator<StreamChunk> {
    const stream = streamQoderChat(options, model, credentials, messages, {
      fetch: this.fetchImpl,
      logger: this.logger,
      region: this.region,
      responseHeaderTimeoutMs: this.responseHeaderTimeoutMs,
      streamIdleTimeoutMs: this.streamIdleTimeoutMs,
    })
    const first = await stream.next()
    onAccepted()
    if (!first.done) {
      onFirstByte?.()
      yield first.value
    }
    yield* stream
  }

  private async * generate(
    options: GenerateOptions,
    model?: QoderCatalogModel,
  ): AsyncGenerator<StreamChunk> {
    if (options.signal?.aborted) throw aborted('Request was aborted prior to generation.')

    // Phase 1: static validation finishes before credential resolution or any
    // provider I/O, so an unusable request never consumes a subscription.
    validateQoderRequestShape(options, model)
    // The attribution carrier: the walk fills in the account each attempt signs
    // with, and the handlers below read it AFTER the walk has finished, so the
    // id they report is the one that actually produced the outcome.
    const attribution: AttemptAttribution = { accountId: undefined }
    try {
      yield* this.generateWithAccounts(options, model, attribution)
    } catch (error: unknown) {
      /*
       * The final failure of a request is where the queue explanation belongs.
       *
       * Every recovery this transport owns has already run by here — the
       * same-account job-token self-heal, then the next-account walk — so a
       * failure still in hand is one the user is about to see. A request that
       * recovered throws nothing, which is exactly why a queue that another
       * account absorbed stays silent: there is nothing to explain.
       *
       * The facts ride the error from the classifier, so the notice is built
       * from the body that decided the classification. An abort is never a
       * queue and is not reported.
       */
      const facts = error instanceof QoderLlmError ? error.qoderQueue : undefined
      if (facts !== undefined && options.signal?.aborted !== true) {
        this.onUpstreamQueue?.(facts, attribution.accountId)
      }
      throw error
    }
  }

  /**
   * Walk the account pool once, retrying a connection-level failure on the next
   * account, and yield the first account's successful stream.
   *
   * This sits OUTSIDE the per-account self-heal (see `attempt`) on purpose: a
   * stale job token belongs to the account that holds it, so that account gets
   * its one fresh-token retry before the transport spends a second identity.
   * Only a failure the account could not be rescued from advances the walk.
   *
   * The `switched` hook is awaited before the retry because it is also what
   * points the host at the new account: the image publisher's own credential
   * refresh resolves the ambient active PAT, so that adoption must have landed
   * before the retry can reach it.
   */
  private async * generateWithAccounts(
    options: GenerateOptions,
    model: QoderCatalogModel | undefined,
    attribution: AttemptAttribution,
  ): AsyncGenerator<StreamChunk> {
    /*
     * One wait budget per request, shared by every attempt of the walk below.
     *
     * A queue wait is the caller choosing to wait for a busy model, so switching
     * accounts must not hand the same caller a second full budget — see
     * `queueWaitBudget`.
     */
    const queueBudget = { waitsLeft: this.queueWaitBudget() }
    const failover = this.failover
    if (failover === undefined || !failover.enabled()) {
      // No pool to walk, or the user turned switching off: resolve the ambient
      // credential and behave exactly as before the hooks existed.
      yield* this.attempt(options, model, await this.requirePat(options.signal), { emitted: false }, undefined, queueBudget)
      return
    }
    const active = await failover.activeAccount()
    if (active === undefined) {
      // An env-only credential is not a pooled account, so there is no identity
      // to advance FROM and nothing for `nextAccount` to be given; the ambient
      // resolution is the whole answer. `attribution` stays empty, which is how
      // the host learns that no pooled account is answerable for this request.
      yield* this.attempt(options, model, await this.requirePat(options.signal), { emitted: false }, undefined, queueBudget)
      return
    }
    const sessionId = options.sessionId === undefined ? undefined : String(options.sessionId)
    // Stickiness chooses where a request STARTS, never whether the walk runs: a
    // pinned account that fails still advances like any other, because a pin is
    // a statement about identity, not a promise about health.
    const pinned = await this.pinnedAccount(sessionId)
    let first = pinned ?? active
    /*
     * Do not spend the request on an account the ledger is cooling down.
     *
     * A cooldown is the transport's own conclusion that this account kept
     * failing while another one served the same traffic, so starting on it
     * again would be the self-harm T5 exists to prevent. Announcing the move
     * through `switched` (rather than silently picking someone else) is what
     * keeps the host's active pointer and the credential that actually signs
     * from drifting apart. When nothing else is selectable the account is kept
     * as the only option: the pool being all-cooling is not a reason to invent
     * a wait or to refuse a request that account may well serve now.
     */
    const firstCooling = this.penalties.isCooling(first.id)
    const firstReserved = this.reservedAccounts.has(first.id)
    if (firstCooling || firstReserved) {
      const alternative = await this.nextWalkAccount(failover, first.id, new Set([first.id]))
      if (alternative !== undefined) {
        await failover.switched({
          fromId: first.id,
          toId: alternative.id,
          // The host stores this reason on the switch row, so it has to say why
          // the request did not start where the active pointer said it would:
          // the account is either unhealthy (T5) or already serving someone
          // else (T7). One wording each keeps the two causes distinguishable.
          reason: firstCooling
            ? 'account cooling down after repeated failures'
            : 'account is already serving another request',
        })
        first = alternative
      }
    }
    if (pinned === undefined || first.id !== pinned.id) this.pinSession(sessionId, first)
    // Count the request against whichever account it actually starts on. This
    // is the request bound of stickiness; the ROUND bound is counted only when
    // an answer is consumed to the end, below.
    this.noteRequest(sessionId, first.id)
    // An id already tried ends the walk. That is what bounds a `nextAccount`
    // that wraps around the pool: at most one pass, never a cycle.
    const tried = new Set<string>([first.id])
    /*
     * Failures seen during this walk that have not been blamed yet.
     *
     * The T5 rule: a failure moves into "pending blame" when the walk advances
     * past it, and only a later account serving the request turns that pending
     * blame into a landed penalty. If the walk ends without anyone succeeding
     * (or the caller aborts, or bytes were already emitted) this local list is
     * simply dropped, so a whole-pool outage punishes nobody. Keeping it on the
     * walk's stack rather than on the transport is also what keeps concurrent
     * requests from blaming each other's accounts.
     */
    const pendingBlame: Array<{ accountId: string; kind: QoderAccountPenaltyKind }> = []
    let account = first
    for (;;) {
      // Per attempt: whether a chunk has already left this transport. Once it
      // has, the bytes cannot be unsent, and a retry on another account would
      // duplicate them rather than recover anything.
      const state = { emitted: false }
      // Set before the attempt, not after it: `attempt` reads it when it fires
      // the acceptance handler, and on a failure that escapes the walk it must
      // already name the account whose attempt failed last.
      attribution.accountId = account.id
      try {
        yield* this.attempt(options, model, account.pat, state, account.id, queueBudget)
        // Reached only when the attempt's stream finished normally: an abort, a
        // failure, or a caller that stopped reading all leave this line
        // unexecuted. That is exactly the "output completed" definition of a
        // round, and it is what the stickiness round bound counts.
        /*
         * The account served the request to the end, which is the exoneration
         * pending blame was waiting for: land every earlier account's failure
         * now, and clear anything still held against THIS account. Order
         * matters so that a request that starts on a penalised account (the
         * all-cooling fallback) clears it before any new penalty could apply to
         * it.
         */
        this.penalties.noteSuccess(account.id)
        for (const blame of pendingBlame) this.penalties.noteFailure(blame.accountId, blame.kind)
        this.completeRound(sessionId, account.id)
        return
      } catch (error: unknown) {
        if (options.signal?.aborted || state.emitted) throw error
        if (!isAccountFailure(error)) throw error
        const next = await this.nextWalkAccount(failover, account.id, tried)
        // `undefined` is the end of the pool — every remaining candidate is
        // either tried or cooling. The failure in hand is the honest answer,
        // and the pending blame dies with the walk: nobody is punished for a
        // request that no account could serve.
        if (next === undefined || tried.has(next.id)) throw error
        tried.add(next.id)
        // Report the account that failed before announcing the switch: the host
        // counts these per account to decide the card's 限流 label, and the
        // observation must belong to `account`, not to the one taking over.
        const reason = switchReason(error)
        failover.failed?.({ accountId: account.id, reason, at: this.now() })
        // Defer the penalty until the walk proves the failure was this
        // account's: a later success on `next` (or a later account) is the
        // evidence, and the walk's exhaustion discards it.
        pendingBlame.push({ accountId: account.id, kind: penaltyKind(error) })
        await failover.switched({ fromId: account.id, toId: next.id, reason })
        account = next
        // The session follows the walk. A pin left pointing at the account that
        // just failed would send the very next turn straight back to it, once
        // per request for as long as the pin lives — the opposite of recovery.
        this.pinSession(sessionId, next)
        // The retry is a request served by the account taking over, so it has
        // to count against that account's request bound. `pinSession` started
        // the counters at zero; without this line the account that rescued the
        // request would get one request of bound back.
        this.noteRequest(sessionId, next.id)
      }
    }
  }

  /**
   * Run one account's whole request: credentials, wire translation, the chat,
   * and the same-account job-token self-heal.
   *
   * @param pat - The PAT this attempt signs with. A failover retry passes the
   *   next account's PAT instead of re-resolving the ambient credential.
   * @param state - Flipped before the first chunk is forwarded, so the caller
   *   knows a retry would duplicate bytes already handed to the consumer.
   */
  private async * attempt(
    options: GenerateOptions,
    model: QoderCatalogModel | undefined,
    pat: string,
    state: { emitted: boolean } = { emitted: false },
    accountId?: string,
    queueBudget: { waitsLeft: number } = { waitsLeft: 0 },
  ): AsyncGenerator<StreamChunk> {
    /*
     * Hold one account's traffic slot for the whole attempt.
     *
     * The slot is taken before the credential exchange, so the pace covers the
     * entire request the upstream will see rather than just its chat call. Only
     * pooled accounts are paced: an ambient PAT has no `account.id` for the
     * guard to key on (and no pool walk that could rotate it), so there is
     * nothing to protect or coordinate there.
     */
    /*
     * Claim the account before anything else.
     *
     * This is the dispatch-time half of T7: `nextWalkAccount` skips accounts
     * someone else reserved, and taking the reservation here makes that check
     * true for the whole time this attempt is being served. When the claim
     * fails — a race with another request, or a pool in which every account is
     * already serving — the attempt proceeds WITHOUT the claim rather than
     * refusing a request the user made: the traffic guard below still paces it,
     * so the fallback is a slower request instead of a failed one.
     */
    const reserved = accountId === undefined ? false : this.reserveAccount(accountId)
    const lease = accountId === undefined
      ? undefined
      : await this.traffic.acquire(accountId)
    let released = false
    const release = (): void => {
      if (released) return
      released = true
      if (reserved && accountId !== undefined) this.releaseAccount(accountId)
      lease?.release()
    }
    try {
      for await (const chunk of this.attemptPaced(options, model, pat, state, accountId, queueBudget)) {
        /*
         * Release at the terminal chunk, not only in `finally`.
         *
         * The HTTP layer in front of this transport stops pulling once its SSE
         * encoder sees the finish chunk (it closes the body stream there
         * instead of calling `iterator.return()`), so a successful request's
         * generator can stay suspended forever after that yield and its
         * `finally` would never run — leaking the account's slot and making
         * every later request sit out the 30s fail-open timeout. The finish
         * chunk is terminal by contract, so nothing after it needs the slot.
         */
        if (chunk.type === 'finish') release()
        yield chunk
      }
    } finally {
      // Every other exit — failure, abort, consumer cancellation — returns the
      // slot too; a leaked slot would starve that account for good.
      release()
    }
  }

  private async * attemptPaced(
    options: GenerateOptions,
    model: QoderCatalogModel | undefined,
    pat: string,
    state: { emitted: boolean },
    accountId: string | undefined,
    queueBudget: { waitsLeft: number },
  ): AsyncGenerator<StreamChunk> {
    // Phase 2: credentials, which the center image exchange must be able to sign with.
    const credentials = await this.auth.getCredentials(pat, options.signal)
    // Phase 3: read attachments, publish images, and assemble wire messages.
    const messages = await translateQoderMessages(options, this.attachments, {
      uploader: this.imageUploader,
      credentials,
      preserveThinking: this.preserveThinking,
    })
    // Image publication may have refreshed a rejected job token, so the chat
    // credential is read once more: it must be the token that actually signs.
    let chatCredentials = await this.auth.getCredentials(pat, options.signal)
    const onFirstByte = (): void => { state.emitted = true }
    // Wait out a queue answer instead of failing the request.
    //
    // A queue is the upstream saying "the model is busy", so the honest
    // recovery is time, not another identity: the account walk below is skipped
    // for it entirely (`isAccountFailure`), and because the wait happens here —
    // inside the attempt, before the failure can leave it — a wait that
    // succeeds is invisible to both the user and the host's retry policy. Only
    // bytes already handed to the consumer make a retry pointless, which is the
    // same rule the account walk follows.
    let healRound = 0
    let noticeAt: number | undefined
    for (;;) {
      try {
        // A pending notice from an earlier heal is reported as soon as this
        // request is accepted (see `streamChat`).
        yield* this.streamChat(options, model, chatCredentials, messages, () => {
          this.onChatAccepted(accountId)
        }, onFirstByte)
        return
      } catch (error: unknown) {
        // A queue is resolved by waiting, never by another account and never by
        // a fresh token — so it is checked BEFORE the self-heal, whose exchange
        // would otherwise burn a job token on a model that was merely busy (a
        // queue answer classifies as RATE_LIMIT, not AUTH, so the heal would
        // in fact decline it — but the ordering makes that explicit rather than
        // incidental).
        if (queueBudget.waitsLeft > 0 && !state.emitted && options.signal?.aborted !== true) {
          const waitMs = this.queueWaitMs(error)
          if (waitMs !== undefined) {
            queueBudget.waitsLeft -= 1
            this.logger?.warn?.('[Qoder Stream] Upstream queue is saturated; waiting before retrying the same account', {
              waitMs,
              attemptsLeft: queueBudget.waitsLeft,
            })
            await this.waitOutQueue(waitMs, options.signal)
            continue
          }
        }
        // A cached job token the upstream has started rejecting (a gateway-side
        // invalidation or its own rotation) reads as HTTP 401 before any stream
        // byte is produced. One fresh exchange self-heals that window; a
        // genuinely revoked PAT fails the retry identically, and the retry
        // trades one extra exchange call against turning a transient gateway
        // state into a false "sign in again" report for the user.
        //
        // Note what is NOT healed: a 401/403 the upstream used to announce a
        // saturated queue (body carries code 10605 / isQueued / retryAfterSeconds)
        // now classifies as RATE_LIMIT, not AUTH — see qoderQueueSignal. A fresh
        // token cannot jump a queue, so those rejections surface immediately and
        // let the host's retry policy (which retries RATE_LIMIT, never AUTH)
        // ride out the window instead.
        if (!isQoderAuthRejection(error) || options.signal?.aborted) throw error
        if (healRound >= 2) {
          // Both paced rounds exhausted on authorization rejections: the honest
          // answer is the last rejection, not a silently empty stream.
          //
          // The rotation did NOT rescue this chat, so the deferred success
          // notice it would otherwise have qualified for is void. Dropping it
          // here is what stops a later, unrelated chat acceptance from printing
          // "已自动重换并恢复" with a stale rotation time — the row that made the
          // notice look broken. Only this request's own notice is void, though:
          // a concurrent heal that armed the pending slot after ours keeps it.
          if (this.pendingRefreshAt === noticeAt) this.discardPendingRefreshNotice()
          // Report the failed heal once per outage. The success notice covers
          // "the rotation rescued the chat"; without this, a rejection the
          // rotation could NOT rescue was announced nowhere at all, and the user
          // was left reading a bare authorization failure with no hint that
          // recovery had been attempted.
          if (!this.refreshFailureAnnounced) {
            this.refreshFailureAnnounced = true
            this.logger?.warn?.('[Qoder Stream] Job token refresh did not recover the chat; the upstream still rejects it', {
              status: error.failure.status,
            })
            this.onJobTokenRefreshFailed?.({
              region: this.region,
              at: Date.now(),
              ...(error.failure.status === undefined ? {} : { status: error.failure.status }),
            })
          }
          throw error
        }
        if (healRound === 0) {
          this.logger?.warn?.(
            '[Qoder Stream] Chat rejected as unauthorized; exchanging a fresh job token and retrying once',
            { status: error.failure.status },
          )
        } else {
          // A gateway fault window outlives one immediate retry (observed
          // 2026-09-20: ~09:49-11:27 local, 401s lasting minutes), so the second
          // exchange is deliberately late; a revoked PAT still terminates
          // honestly at the last round's failure, just two exchanges later.
          this.logger?.warn?.('[Qoder Stream] Fresh job token also rejected; waiting 2s and retrying once more', {
            status: error.failure.status,
            round: healRound,
          })
          await this.pauseBeforeNextHeal(options)
        }
        // Each retry exchanges OUTSIDE the shared single-flight
        // (exchangeFresh): the flight can be aborted by a departing concurrent
        // waiter (quota poll, catalog sweep), and a retry joined to it would be
        // cancelled by a path unrelated to the chat.
        const refreshed = await this.auth.exchangeFresh(pat, options.signal)
        // The rotation has happened; the first chat accepted afterwards — this
        // round's retry or any subsequent one — is what makes it reportable.
        this.pendingRefreshAt = Date.now()
        noticeAt = this.pendingRefreshAt
        chatCredentials = refreshed
        healRound += 1
      }
    }
  }

  /**
   * The account the walk should visit next, skipping cooling accounts (T5).
   *
   * "Skip" is a statement about this request, not about the pool: cooling
   * accounts are left untried so a known-bad guess cannot spend the request,
   * but they stay in the walk order for when the ledger forgets them. Accounts
   * that are merely deprioritised are collected and used as a fallback — the
   * whole point of a downweight is "prefer others", not "refuse" — and only a
   * walk with no un-cooled candidate at all returns `undefined`, which ends the
   * walk and lets the original failure surface.
   *
   * The search is bounded and never revisits an id, so a host `nextAccount`
   * that wraps the pool cannot make selection loop.
   */
  /** Claim an account for dispatch; `false` means someone else holds it. */
  private reserveAccount(accountId: string): boolean {
    if (this.reservedAccounts.has(accountId)) return false
    this.reservedAccounts.add(accountId)
    return true
  }

  private releaseAccount(accountId: string): void {
    this.reservedAccounts.delete(accountId)
  }

  private async nextWalkAccount(
    failover: NonNullable<QoderTransportOptions['failover']>,
    currentId: string,
    tried: ReadonlySet<string>,
  ): Promise<{ id: string; pat: string } | undefined> {
    const considered = new Set<string>([currentId])
    const deprioritized: Array<{ id: string; pat: string }> = []
    let id = currentId
    for (let step = 0; step < maxWalkSearchSteps; step++) {
      const candidate = await this.nextAccount(failover, id, tried)
      if (candidate === undefined || tried.has(candidate.id) || considered.has(candidate.id)) break
      considered.add(candidate.id)
      if (this.penalties.isCooling(candidate.id)) {
        id = candidate.id
        continue
      }
      // Another request is already dispensing this account: walking onto it
      // would hand two concurrent conversations the same identity, which is
      // the duplicate selection the reservation exists to prevent.
      if (this.reservedAccounts.has(candidate.id)) {
        id = candidate.id
        continue
      }
      if (this.penalties.isDeprioritized(candidate.id)) {
        deprioritized.push(candidate)
        id = candidate.id
        continue
      }
      return candidate
    }
    return deprioritized[0]
  }

  /**
   * The account the walk visits after `currentId`.
   *
   * With no custom routing this is exactly the host's own save order. A custom
   * order is a statement about which accounts the user wants used first, so it
   * is followed while it can serve and abandoned the moment it cannot: ids the
   * user has since removed resolve to nothing, and a list that names nobody
   * would otherwise turn a routing typo into an outage.
   */
  private async nextAccount(
    failover: NonNullable<QoderTransportOptions['failover']>,
    currentId: string,
    tried: ReadonlySet<string>,
  ): Promise<{ id: string; pat: string } | undefined> {
    const routing = this.routing
    const resolve = failover.accountById
    if (routing === undefined || resolve === undefined || routing.strategy() !== 'custom') {
      return await failover.nextAccount(currentId)
    }
    const order = routing.order()
    if (order.length === 0) return await failover.nextAccount(currentId)
    // Start just after the current account, so a walk that begins on the
    // active account still visits the user's first choice before its own
    // predecessor.
    const start = order.indexOf(currentId)
    for (let offset = 1; offset <= order.length; offset++) {
      const id = order[(start + offset + order.length) % order.length]
      if (id === undefined || tried.has(id)) continue
      const account = await resolve(id)
      if (account !== undefined) return account
    }
    return await failover.nextAccount(currentId)
  }

  /**
   * The account a session should start on, or `undefined` when it should start
   * over on the active account.
   *
   * A live pin is re-resolved through `accountById` whenever the host exposes
   * it, so an account the user removed can never keep signing: the pin is
   * dropped and the session starts over on the active account. Without that
   * hook the credential captured when the session was pinned is the best
   * available answer.
   *
   * When the pin has reached one of its bounds the session is moved to the next
   * account in the walk order — reaching a bound means "change account", not
   * "stop remembering one". Only a session that has nobody to move to stays
   * where it is, with its counters restarted so the same bound is not examined
   * and rejected on every following request.
   */
  private async pinnedAccount(sessionId: string | undefined): Promise<{ id: string; pat: string } | undefined> {
    const policy = this.stickiness
    if (sessionId === undefined || policy === undefined || !this.stickinessEnabled(policy)) return undefined
    const pin = this.sessionPins.get(sessionId)
    if (pin === undefined) return undefined
    const resolve = this.failover?.accountById
    if (resolve !== undefined) {
      const account = await resolve(pin.id)
      if (account === undefined) {
        this.sessionPins.delete(sessionId)
        return undefined
      }
      pin.pat = account.pat
    }
    if (this.pinExhausted(pin, policy)) {
      const moved = await this.rotatePin(sessionId, pin)
      if (moved !== undefined) return moved
      // A pool of one, or a walk that has nobody after this account: the
      // session cannot move, so restart its counters. Without this the bound
      // would be re-examined and re-rejected on every request of the session.
      pin.pinnedAtMs = this.now()
      pin.rounds = 0
      pin.requests = 0
    }
    // Re-inserting moves the pin to the young end of the eviction order.
    this.sessionPins.delete(sessionId)
    this.sessionPins.set(sessionId, pin)
    return { id: pin.id, pat: pin.pat }
  }

  /**
   * Whether one bound of the stickiness policy has been reached.
   *
   * The three bounds are independent and all are counts of work this account
   * actually did, so the comparison is `>=`: with a round bound of 1, the
   * account serves exactly one completed conversation and the next request
   * moves on.
   */
  private pinExhausted(
    pin: SessionPin,
    policy: NonNullable<QoderTransportOptions['stickiness']>,
  ): boolean {
    const rounds = policy.rounds()
    if (Number.isFinite(rounds) && rounds > 0 && pin.rounds >= Math.floor(rounds)) return true
    const requests = policy.requests()
    if (Number.isFinite(requests) && requests > 0 && pin.requests >= Math.floor(requests)) return true
    const minutes = policy.minutes()
    if (Number.isFinite(minutes) && minutes > 0 && this.now() - pin.pinnedAtMs >= minutes * 60_000) return true
    return false
  }

  /**
   * Move a session to the next account of the walk order, and pin it there.
   *
   * `nextAccount` is the host's own answer to "who comes after this one", so
   * stickiness rotates through exactly the order routing and failover use —
   * including a parked account being skipped. `undefined`, or the same account
   * back again (a pool of one), means there is nowhere to go.
   */
  private async rotatePin(
    sessionId: string,
    pin: SessionPin,
  ): Promise<{ id: string; pat: string } | undefined> {
    const next = await this.failover?.nextAccount(pin.id)
    if (next === undefined || next.id === pin.id) return undefined
    this.pinSession(sessionId, next)
    return { id: next.id, pat: next.pat }
  }

  /**
   * Count one request against the account its session is pinned to.
   *
   * Called once per request, after the account has been chosen: counting at
   * choice time would let a request that never signed anything (the walk ended
   * before any attempt) spend the request bound of an account it never asked.
   */
  private noteRequest(sessionId: string | undefined, accountId: string): void {
    if (sessionId === undefined) return
    const pin = this.sessionPins.get(sessionId)
    if (pin === undefined || pin.id !== accountId) return
    pin.requests += 1
  }

  /**
   * Count one completed conversation against the account that served it.
   *
   * Fired only when the stream finished normally, which is the definition of a
   * round the host asked for: a request that failed, or that the caller stopped
   * reading, did not produce an output, so it must not move the session on.
   */
  private completeRound(sessionId: string | undefined, accountId: string): void {
    if (sessionId === undefined) return
    const pin = this.sessionPins.get(sessionId)
    if (pin === undefined || pin.id !== accountId) return
    pin.rounds += 1
  }

  /**
   * Record that a session now belongs to an account.
   *
   * Called both when a session first picks an account and when the walk moves
   * it, so the pin always names an account this session actually reached. The
   * counters start at zero: the account has served no completed round yet, and
   * the request about to run is counted by `noteRequest`, not here.
   * Insertion order is the eviction order, and the cap only ever costs the
   * oldest session its stickiness.
   */
  private pinSession(sessionId: string | undefined, account: { id: string; pat: string }): void {
    const policy = this.stickiness
    if (sessionId === undefined || policy === undefined) return
    if (!this.stickinessEnabled(policy)) return
    // Only a session the table has not seen yet needs room. Re-pinning an
    // existing one (the walk moves a session, then the next turn touches it
    // again) must not evict anybody: the table would spend its whole cap
    // throwing away the sessions it was asked to remember.
    if (!this.sessionPins.has(sessionId)) {
      while (this.sessionPins.size >= sessionPinCapacity) {
        const oldest = this.sessionPins.keys().next()
        if (oldest.done === true) break
        this.sessionPins.delete(oldest.value)
      }
    }
    this.sessionPins.delete(sessionId)
    this.sessionPins.set(sessionId, {
      id: account.id,
      pat: account.pat,
      pinnedAtMs: this.now(),
      rounds: 0,
      requests: 0,
    })
  }

  /**
   * Whether stickiness has any bound to honour at all.
   *
   * All three providers returning zero is how the host says "off", and off has
   * to mean fully off: a pin written with no bound would never move on, which is
   * the one outcome worse than having no stickiness.
   */
  private stickinessEnabled(policy: NonNullable<QoderTransportOptions['stickiness']>): boolean {
    const minutes = policy.minutes()
    const rounds = policy.rounds()
    const requests = policy.requests()
    return (Number.isFinite(minutes) && minutes > 0)
      || (Number.isFinite(rounds) && rounds > 0)
      || (Number.isFinite(requests) && requests > 0)
  }

  /**
   * How many queue waits ONE REQUEST may spend.
   *
   * The budget belongs to the request, not to an attempt: a request that walks
   * from one account to the next is still one caller waiting, and refreshing
   * the budget on every switch would let an N-account pool hold that caller for
   * N times the configured number of waits (the reference implementation hit
   * exactly that and saw a single request take 197s). It is computed once in
   * `generateWithAccounts` and shared by every attempt of the walk.
   */
  private queueWaitBudget(): number {
    const policy = this.queueWait
    if (policy === undefined) return 0
    const attempts = policy.attempts()
    return Number.isFinite(attempts) ? Math.max(0, Math.floor(attempts)) : 0
  }

  /**
   * How long to wait out a queue answer, or `undefined` when the error is not a
   * queue at all.
   *
   * The upstream's own advice wins over the configured fallback because it is
   * computed from the queue it describes, but both are capped: a window long
   * enough to outlive the caller's patience is a hang dressed up as a wait. On
   * top of the window comes the padding and jitter described at
   * `queueWaitPaddingMs`, and the total is capped again so the padding can
   * never push a five-minute wait past the ceiling that exists to bound the
   * caller's time.
   */
  private queueWaitMs(error: unknown): number | undefined {
    if (!(error instanceof QoderLlmError) || error.qoderQueue === undefined) return undefined
    const advised = error.failure.providerRetryAfterMs
    const baseMs = advised !== undefined && Number.isFinite(advised) && advised > 0
      ? Math.min(advised, queueWaitCeilingMs)
      : Math.min(Math.max(0, this.queueWait?.seconds() ?? 0) * 1000, queueWaitCeilingMs)
    const jitterMs = Math.floor(Math.max(0, Math.min(0.999, this.random())) * queueWaitJitterMs)
    return Math.min(baseMs + queueWaitPaddingMs + jitterMs, queueWaitCeilingMs)
  }

  /**
   * Sleep out an advised queue window, aborting with the request.
   *
   * The abort has to CLEAR the timer rather than race it: a plain timeout would
   * hold the request open until its deadline even after the caller had given
   * up.
   */
  private async waitOutQueue(waitMs: number, signal: AbortSignal | undefined): Promise<void> {
    if (waitMs <= 0) return
    const cancelled = (): QoderLlmError => aborted('Request was aborted while waiting out the upstream queue.')
    if (signal?.aborted === true) throw cancelled()
    await new Promise<void>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined
      const onAbort = (): void => {
        if (timer !== undefined) clearTimeout(timer)
        reject(cancelled())
      }
      timer = setTimeout(() => {
        signal?.removeEventListener('abort', onAbort)
        resolve()
      }, waitMs)
      signal?.addEventListener('abort', onAbort, { once: true })
    })
  }

  /**
   * The pause between the two paced self-heal rounds.
   *
   * Extracted from the heal itself because both the wait and the queue wait
   * above must behave the same way under an abort: `setTimeout` never fires for
   * a request whose signal is already aborted, and it must not leave a pending
   * promise behind either.
   */
  private async pauseBeforeNextHeal(options: GenerateOptions): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, 2_000)
      options.signal?.addEventListener('abort', () => {
        clearTimeout(timer)
        reject(aborted('Request was aborted during the re-auth backoff.'))
      }, { once: true })
    })
  }
}
