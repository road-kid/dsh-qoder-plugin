/** Deep module owning all communication with Qoder. */

import { LlmError, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import type { AttachmentStore } from '@deepseek-ai/dsh-attachment'
import { QoderAuthService } from './auth.ts'
import type { QoderCatalogModel } from '../catalog.ts'
import type { QoderRegion } from './endpoints.ts'
import { QoderLlmError, isQoderAuthRejection } from '../errors.ts'
import { QoderAccountPenaltyLedger, type QoderAccountPenaltyKind } from '../../account-health.ts'
import { QoderAccountTrafficLimiter, type QoderAccountLease } from './account-limiter.ts'
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
import type { QoderPooledAccount, QoderTransport, QoderTransportOptions } from './index.ts'
import type { QoderQueueWaitBasis, QoderQueueWaitSummary } from '../queue-notice.ts'
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
 * The conversation one request belongs to, as the string every per-conversation
 * map keys on — or `undefined` when the host asked for no conversation.
 *
 * This is the identity the hint rows are attributed to. It comes from the
 * request itself rather than from a remembered "current agent", because requests
 * run concurrently (a chat and its session-title request at minimum) and only
 * the request knows which conversation its queue answer or its heal describes.
 */
function sessionIdOf(options: GenerateOptions): string | undefined {
  return options.sessionId === undefined ? undefined : String(options.sessionId)
}

/**
 * Whether one request is the host's automatic session-title call.
 *
 * The host derives a session title with a synthetic one-message request whose
 * single user message is framed by its `frameMessages` helper (seen verbatim in
 * the host build): the text is `Generate the session title from this JSON
 * array of human messages:` (first title) or `Update the session title from
 * this JSON object:` (title refresh) followed by the framed JSON. The message
 * source marker the session log carries (`dsh-session-title-llm`) is stamped
 * over by this plugin's own shim before the transport sees the request, so the
 * text prefix is the only surviving signal.
 *
 * A title call is bookkeeping, not a turn: it must neither pin a session nor
 * spend any stickiness bound, otherwise every new conversation burns one round
 * and one request of its first account before the user's turn even starts.
 */
function isTitleRequest(options: GenerateOptions): boolean {
  const messages = options.messages
  if (messages.length !== 1) return false
  const only = messages[0]
  if (only === undefined || only.role !== 'user') return false
  const blocks = only.content
  if (blocks.length !== 1) return false
  const block = blocks[0]
  if (block === undefined || block.type !== 'text') return false
  return block.text.startsWith('Generate the session title from this JSON array of human messages:')
    || block.text.startsWith('Update the session title from this JSON object:')
}

/**
 * Whether one request OPENS a new user turn rather than continuing one.
 *
 * The host runs one `generate` call per model step, and a turn's later steps
 * arrive with the previous step's tool results appended — their LAST message is
 * a tool result. The stickiness bounds are examined only at turn openings, and
 * the round bound is credited at the turn's FINAL answer, which is what keeps a
 * multi-step turn on one account: a bound reached mid-turn waits for the next
 * turn instead of splitting the turn across accounts.
 */
function opensNewTurn(options: GenerateOptions): boolean {
  const messages = options.messages
  const last = messages[messages.length - 1]
  return last === undefined || last.role !== 'tool'
}

/**
 * The pending-notice map key for one conversation.
 *
 * A request that carries no session id — a direct API call, a host that passes
 * none — still heals and still gets a row, so those requests share one bucket
 * and flush each other's notice. That is what the fallback target already means
 * for them: they are indistinguishable to this module, and none of them can be
 * printed into someone else's conversation.
 */
function pendingKeyOf(sessionId: string | undefined): string {
  return sessionId ?? '<sessionless>'
}

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
 * Whether a terminal chunk is the model finishing an ANSWER.
 *
 * The `finish` chunk is the single terminal signal of a stream, and it carries
 * a failure reason for the two kinds that did not produce an answer: an upstream
 * error and a caller abort. Everything else — `stop`, `tool-calls`, `max-tokens`
 * — means the step was served to the end, which exonerates the account in the
 * penalty ledger. Only `stop` and `max-tokens` are a turn's FINAL answer; see
 * `noteTurnProgress` for why `tool-calls` must not credit a round yet.
 */
function isServedFinish(chunk: StreamChunk): boolean {
  if (chunk.type !== 'finish') return false
  const kind = chunk.reason.kind
  return kind !== 'error' && kind !== 'aborted'
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
interface TurnObservation {
  /** Identity of the turn this request opened or continued. */
  token?: object
  /** Whether a terminal chunk already ran the finish bookkeeping. */
  terminal: boolean
}

interface SessionPin {
  id: string
  pat: string
  /**
   * The region this pinned account signs against; see `QoderPooledAccount`.
   * Undefined means "the transport's own region", which is what a single-region
   * pool leaves it as.
   */
  region?: QoderRegion | undefined
  /** Wall-clock instant this account took over the session. */
  pinnedAtMs: number
  /** Turns this account served through their final answer while pinning. */
  rounds: number
  /** Requests this account started while holding the pin. */
  requests: number
}

/**
 * Outcome of one attempt to rotate a session pin.
 *
 * `stale` means another request changed (or dropped) this session's pin while
 * this one was choosing the next account. The caller must re-read the pin, not
 * write back a choice computed from a pin that no longer exists: the account
 * just picked would otherwise be re-inserted under the counters of the account
 * the session left.
 */
type PinRotation =
  | { kind: 'moved'; account: QoderPooledAccount }
  | { kind: 'none' }
  | { kind: 'stale' }

/**
 * Per-attempt bookkeeping handed from the account walk down into `attempt`.
 *
 * `emitted` says bytes have already left this transport, so a retry would
 * duplicate rather than recover. `onFinish` is the answer to the other question
 * a walk asks: did this account finish a response? It has to be a callback
 * rather than a flag the walk checks afterwards, because the HTTP layer closes
 * the body stream at the terminal chunk instead of resuming the generator — see
 * `attempt` — so the walk's own code after `yield*` never runs in production.
 * The chunk is passed through because only the finish REASON distinguishes a
 * turn's final answer from a step that still owes a tool call.
 */
interface AttemptState {
  /**
   * Whether a chunk (or an error frame) has already been handed downstream.
   */
  emitted: boolean
  /**
   * Called once for this attempt's terminal `finish` chunk, whatever it says: a
   * served answer, an upstream failure or a caller abort. Optional so an ambient
   * attempt with no pool walk can pass none.
   *
   * The chunk is passed because the outcomes are not the same bookkeeping: only
   * a FINAL answer credits a stickiness round, while `tool-calls` means the turn
   * simply continues. Cleared by `attempt` after the first call, so a misbehaving
   * source that yields twice cannot credit anything twice.
   */
  onFinish?: ((chunk: StreamChunk) => void) | undefined
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

/**
 * One request's queue-wait budget AND its record of waits really completed.
 *
 * The budget half decides whether another wait may still happen; the record half
 * is what the final notice quotes. They live in the same per-request object on
 * purpose: a transport-wide "last wait" would let one request's wait be reported
 * beside another request's failure, and a wait that was aborted mid-sleep is not
 * a completed wait, so only `waitOutQueue` returning normally may add to it.
 */
interface QueueWaitLedger {
  /** Waits still allowed for this request. */
  waitsLeft: number
  /** The budget this request started with. */
  total: number
  /** Waits this request actually completed. */
  attempts: number
  /** Sum of the completed waits, milliseconds. */
  totalWaitMs: number
  /** What drove the last completed wait. */
  lastBasis: QoderQueueWaitBasis | undefined
}

/** The summary the host renders from: the ledger's completed-wait half. */
function queueWaitSummary(ledger: QueueWaitLedger): QoderQueueWaitSummary {
  return {
    attempts: ledger.attempts,
    totalWaitMs: ledger.totalWaitMs,
    ...(ledger.lastBasis === undefined ? {} : { lastBasis: ledger.lastBasis }),
  }
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
  private readonly resolveMachineId: (() => string) | undefined
  /**
   * The host-level seed every account's derived device id is built from.
   *
   * Held as a provider, not a value: the seed lives on disk, may be absent, and
   * changes when the user resets the device codes. Each credential mint reads it
   * once, so all headers of one job token belong to the same reset epoch.
   */
  private readonly resolveDeviceSeed: (() => string | undefined) | undefined
  private readonly imageUploadTimeoutMs: number | undefined
  private readonly imageUrlCacheTtlMs: number | undefined
  private readonly auth: QoderAuthService
  private readonly usage: QoderUsageReader
  private readonly checkInService: QoderCheckInService
  private readonly modelFlights = new SingleFlight<readonly QoderCatalogModel[]>()
  private readonly attachments: Pick<AttachmentStore, 'imageLimits' | 'readImageRequest'> | undefined
  private readonly imageUploader: QoderImageUploader
  /**
   * The per-region copies of the two services a CHAT attempt needs.
   *
   * `auth` and `imageUploader` are the only services whose endpoint is decided
   * per attempt rather than per variant: a pool may span both Qoder regions, and
   * an account saved in the other region has to be exchanged and signed against
   * THAT region's gateway (see `QoderPooledAccount`). One instance per region is
   * the whole trick — the auth cache is already keyed `${region}:${pat}`, and the
   * upload cache keys on the region's upload URL, so two instances never share
   * an entry they should not.
   *
   * The metadata services (`usage`, `checkInService`) stay on this transport's
   * own region: they are read through the host's per-variant runtime, which
   * always hands them an account from its own credential file.
   */
  private readonly authByRegion = new Map<QoderRegion, QoderAuthService>()
  private readonly uploaderByRegion = new Map<QoderRegion, QoderImageUploader>()
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
  private readonly onQueueWait: QoderTransportOptions['onQueueWait']
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
   * The turns currently in flight, keyed by conversation, with the account that
   * served their LATEST step.
   *
   * A turn that ends in `tool-calls` is not finished, so it earns no round until
   * its final answer arrives — which may be several steps and one failover
   * later. This record is what lets that final answer complete the turn it
   * belongs to instead of looking like the first step of something new. It is
   * dropped when the turn completes, when it dies without an answer, when a new
   * turn supersedes it, and when its session loses its pin.
   */
  private readonly pendingTurns = new Map<string, { accountId: string }>()
  /** Current turn identity per session; late requests may not mutate a newer turn. */
  private readonly sessionTurns = new Map<string, object>()
  /**
   * The conversations whose self-heal exchanged a fresh job token and whose
   * retry has not been accepted yet, with the time each rotation happened.
   *
   * Set by the heal, cleared when a chat from the SAME conversation succeeds.
   * The notice reports "the token was rotated because the old one was rejected",
   * which is true from that exchange on — so it must not be tied to the heal's
   * OWN retry, which can still lose a race with a transient upstream timeout and
   * be rescued by a later attempt.
   *
   * Keyed per conversation instead of being one shared slot, because one job
   * token is shared by every request the credential signs: a single slot let a
   * chat in a DIFFERENT conversation flush it, printing "已自动重换并恢复" into a
   * conversation whose own request never healed (observed: a rotation reported
   * an hour later, in another chat). A conversation now collects only its own
   * notice, and one that never comes back leaves nothing to print.
   */
  private readonly pendingRefreshBySession = new Map<string, number>()
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
    this.resolveMachineId = options.resolveMachineId
    this.resolveDeviceSeed = options.resolveDeviceSeed
    this.imageUploadTimeoutMs = options.imageUploadTimeoutMs
    this.imageUrlCacheTtlMs = options.imageUrlCacheTtlMs
    this.attachments = options.attachments
    this.preserveThinking = options.preserveThinking
    this.failover = options.failover
    this.onUpstreamQueue = options.onUpstreamQueue
    this.chatAccepted = options.onChatAccepted
    this.onJobTokenRefreshed = options.onJobTokenRefreshed
    this.onJobTokenRefreshFailed = options.onJobTokenRefreshFailed
    this.onQueueWait = options.onQueueWait
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
    this.auth = this.authFor(this.region)
    this.imageUploader = this.uploaderFor(this.region)
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

  /**
   * Forget every cached job token, so the next request re-derives its device id.
   *
   * The derived `Cosy-Machineid` / `Cosy-Machinehostname` are minted while a job
   * token is exchanged and then cached with it, so clearing the caches is the
   * only way a rotated seed can reach an account that is already signed in —
   * and it must cover EVERY region, because one transport serves a pool that may
   * span both.
   *
   * What this deliberately does NOT touch: the real machine id (a host fact, not
   * a per-account claim), the PATs, the account pins, and the penalty ledger.
   * Resetting a fingerprint is not a logout and not a clean slate for the
   * upstream's opinion of an account; it only changes what that account claims
   * to be.
   *
   * The cost is one extra token exchange per account on its next use.
   */
  resetDeviceIdentity(): void {
    for (const auth of this.authByRegion.values()) auth.clear()
  }

  /**
   * The auth service for one region, built once and reused.
   *
   * A chat attempt resolves the account's OWN region first (see
   * `attemptRegion`), so the same transport may exchange job tokens against
   * either gateway during one request walk. The service's cache is keyed
   * `${region}:${pat}`, which is exactly why one instance per region is safe:
   * a token exchanged for `api3.qoder.sh` can never be handed to
   * `gateway.qoder.com.cn`.
   */
  private authFor(region: QoderRegion): QoderAuthService {
    const cached = this.authByRegion.get(region)
    if (cached !== undefined) return cached
    const created = new QoderAuthService({
      fetch: this.fetchImpl,
      logger: this.logger,
      region,
      resolveMachineId: this.resolveMachineId,
      resolveDeviceSeed: this.resolveDeviceSeed,
    })
    this.authByRegion.set(region, created)
    return created
  }

  /**
   * The image uploader for one region, built once and reused.
   *
   * Publication is signed with the same region's job token, so the uploader has
   * to follow the account's region rather than the variant's: a China account's
   * image published to the global center would be signed by a gateway it never
   * authenticated against. Its credential-refresh callback re-reads through the
   * SAME region's auth service for the same reason.
   */
  private uploaderFor(region: QoderRegion): QoderImageUploader {
    const cached = this.uploaderByRegion.get(region)
    if (cached !== undefined) return cached
    const auth = this.authFor(region)
    const created = new QoderImageUploader({
      fetch: this.fetchImpl,
      logger: this.logger,
      region,
      ...this.imageUploadTimeoutMs === undefined ? {} : { timeoutMs: this.imageUploadTimeoutMs },
      ...this.imageUrlCacheTtlMs === undefined ? {} : { cacheTtlMs: this.imageUrlCacheTtlMs },
      refreshCredentials: async (signal) => {
        const pat = await this.requirePat(signal)
        auth.clear(pat)
        return auth.getCredentials(pat, signal)
      },
    })
    this.uploaderByRegion.set(region, created)
    return created
  }

  /**
   * The region one pooled account signs against.
   *
   * A pooled account carries the region it was saved under (the host keeps one
   * credential file per region, and the file's region stamp is authoritative —
   * see `QoderPooledAccount`). An account with no declared region, or an
   * ambient credential, signs against this transport's own region, which is the
   * single-region behavior this transport had before pools could span regions.
   */
  private attemptRegion(account: { readonly region?: QoderRegion | undefined } | undefined): QoderRegion {
    return account?.region ?? this.region
  }

  stream(options: GenerateOptions, model?: QoderCatalogModel): AsyncIterable<StreamChunk> {
    // Async-generator bodies do not run until the first next(). Bind the turn
    // now, at stream creation, so delayed consumption cannot adopt a newer
    // turn's identity (and an older opening cannot register after a newer one).
    const sessionId = isTitleRequest(options) ? undefined : sessionIdOf(options)
    const tracking = sessionId !== undefined && this.stickiness !== undefined && this.stickinessEnabled(this.stickiness)
    let turnToken: object | undefined
    if (tracking && sessionId !== undefined) {
      if (opensNewTurn(options)) {
        turnToken = {}
        this.sessionTurns.set(sessionId, turnToken)
      } else {
        turnToken = this.sessionTurns.get(sessionId)
      }
    }
    return this.generate(options, model, turnToken)
  }

  /**
   * Report THIS conversation's pending self-heal once its chat is accepted.
   *
   * The notice means "the stale token was rejected, so it was rotated, and the
   * chat works again" — all three are true by the time a chat is accepted
   * after the refresh, no matter which attempt delivered it. "This conversation"
   * is load-bearing: the rotated token is shared, so another conversation's
   * acceptance proves nothing about the request that actually healed, and
   * reporting there printed a recovery row in the wrong conversation.
   *
   * @param key - The pending-map key for the conversation whose chat landed
   *   (see {@link pendingKeyOf}).
   * @param sessionId - The same id as a string, reported so the host can print
   *   into that conversation; `undefined` when the request carried no session.
   */
  private flushPendingRefreshNotice(key: string, sessionId: string | undefined): void {
    const at = this.pendingRefreshBySession.get(key)
    if (at === undefined) return
    this.pendingRefreshBySession.delete(key)
    // A rotation whose acceptance took this long is no longer news. Printing
    // it would drop a row into the conversation long after the fact, and its
    // timestamp would name a moment the user has no reason to connect to now —
    // which reads exactly like a clock bug (observed: a 16:56 rotation
    // reported at 17:47). Dropping it keeps the notice meaningful.
    if (Date.now() - at > jobTokenNoticeMaxAgeMs) return
    this.logger?.warn?.('[Qoder Stream] Job token was auto-refreshed after an upstream rejection; the chat has recovered')
    this.onJobTokenRefreshed?.({
      region: this.region,
      at,
      ...(sessionId === undefined ? {} : { sessionId }),
    })
  }

  /**
   * Drop this conversation's pending rotation notice whose heal rescued nothing.
   *
   * The heal's own retry was rejected too, so "the rotation fixed it" is not
   * what happened. Leaving the notice pending made a LATER chat acceptance flush
   * it — printing a success row that contradicts the failure row already shown,
   * stamped with the old rotation time.
   */
  private discardPendingRefreshNotice(key: string, at: number): void {
    if (this.pendingRefreshBySession.get(key) === at) this.pendingRefreshBySession.delete(key)
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
  private onChatAccepted(accountId?: string, sessionId?: string): void {
    this.refreshFailureAnnounced = false
    this.flushPendingRefreshNotice(pendingKeyOf(sessionId), sessionId)
    this.chatAccepted?.(accountId, sessionId)
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
    region: QoderRegion,
    onFirstByte?: () => void,
  ): AsyncGenerator<StreamChunk> {
    const stream = streamQoderChat(options, model, credentials, messages, {
      fetch: this.fetchImpl,
      logger: this.logger,
      region,
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
    model: QoderCatalogModel | undefined,
    observedTurnToken: object | undefined,
  ): AsyncGenerator<StreamChunk> {
    if (options.signal?.aborted) {
      const sessionId = sessionIdOf(options)
      if (opensNewTurn(options)) {
        if (sessionId !== undefined && this.sessionTurns.get(sessionId) === observedTurnToken) {
          this.pendingTurns.delete(sessionId)
        }
      } else {
        this.abandonTurn(sessionId, observedTurnToken)
      }
      throw aborted('Request was aborted prior to generation.')
    }

    // Phase 1: static validation finishes before credential resolution or any
    // provider I/O, so an unusable request never consumes a subscription.
    validateQoderRequestShape(options, model)
    // The attribution carrier: the walk fills in the account each attempt signs
    // with, and the handlers below read it AFTER the walk has finished, so the
    // id they report is the one that actually produced the outcome.
    const attribution: AttemptAttribution = { accountId: undefined }
    /*
     * One wait budget per request, shared by every attempt of the walk below,
     * and the record of waits it really completed. Created here — outside the
     * walk — because the final-failure notice below is what quotes the record.
     */
    const queueBudget = this.newQueueWaitLedger()
    const turn: TurnObservation = {
      terminal: false,
      ...observedTurnToken === undefined ? {} : { token: observedTurnToken },
    }
    try {
      yield* this.generateWithAccounts(options, model, attribution, queueBudget, turn)
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
        // The real wait record beside the real failure: the notice's wait
        // sentence is a claim about THIS request, so it quotes the waits this
        // request completed rather than the clock between two reports.
        this.onUpstreamQueue?.(facts, attribution.accountId, sessionIdOf(options), queueWaitSummary(queueBudget))
      }
      throw error
    } finally {
      if (!turn.terminal) this.abandonTurn(sessionIdOf(options), turn.token)
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
    queueBudget: QueueWaitLedger,
    turn: TurnObservation,
  ): AsyncGenerator<StreamChunk> {
    const failover = this.failover
    if (failover === undefined || !failover.enabled()) {
      // No pool to walk, or the user turned switching off: resolve the ambient
      // credential and behave exactly as before the hooks existed.
      yield* this.attempt(options, model, { pat: await this.requirePat(options.signal) }, { emitted: false }, undefined, queueBudget)
      return
    }
    const active = await failover.activeAccount()
    if (active === undefined) {
      // An env-only credential is not a pooled account, so there is no identity
      // to advance FROM and nothing for `nextAccount` to be given; the ambient
      // resolution is the whole answer. `attribution` stays empty, which is how
      // the host learns that no pooled account is answerable for this request.
      yield* this.attempt(options, model, { pat: await this.requirePat(options.signal) }, { emitted: false }, undefined, queueBudget)
      return
    }
    const sessionId = isTitleRequest(options) ? undefined : sessionIdOf(options)
    // Rotation is examined only when a request OPENS a turn: a turn's later
    // steps keep the account their turn opened on, and a bound reached
    // mid-turn waits for the next turn.
    const newTurn = opensNewTurn(options)
    const tracking = sessionId !== undefined && this.stickiness !== undefined && this.stickinessEnabled(this.stickiness)
    const turnToken = turn.token
    if (!tracking && sessionId !== undefined) {
      this.sessionTurns.delete(sessionId)
      this.pendingTurns.delete(sessionId)
    }
    // A turn that never reached an answer leaves a pending record behind. A
    // current new opening supersedes it; an older opening that lost the
    // creation-order race must not delete the newer turn's pending record.
    if (newTurn && sessionId !== undefined && turnToken !== undefined && this.sessionTurns.get(sessionId) === turnToken) {
      this.pendingTurns.delete(sessionId)
    }
    // Stickiness chooses where a request STARTS, never whether the walk runs: a
    // pinned account that fails still advances like any other, because a pin is
    // a statement about identity, not a promise about health.
    const pinned = await this.pinnedAccount(sessionId, newTurn)
    /*
     * Precedence, and why it is exactly this order — this is the answer to
     * "轮换逻辑打架": one chain, no feature overriding another by accident.
     *
     * 1. A live session pin. This conversation already belongs to an account;
     *    stickiness is a claim about ownership, and re-deciding it per request
     *    would make it meaningless.
     * 2. Otherwise the head of the custom routing order. A custom order is a
     *    stated PRIORITY — the list reads "try these, top to bottom" — so it has
     *    to govern where a conversation STARTS, not only where it moves after a
     *    failure or a reached bound. Leaving it out here was the reason a saved
     *    list looked inert: every conversation opened on whatever account the
     *    host had stored, and the order only appeared once something went wrong.
     * 3. Otherwise the stored active account — the user's "now". The card's
     *    switch button writes it, and so do our own `switched`/`adopted` hooks,
     *    so it is the one pointer that reflects a real decision, and it stays
     *    the start for the save-order strategy, which states no priority.
     */
    let first = pinned ?? await this.preferredStart(failover, active)
    /*
     * Do not spend the request on an account the ledger is cooling down (T5) or
     * that the traffic guard is already serving (T7) — but do it SILENTLY, and
     * adopt the move when it is a verdict on the account rather than a transient
     * collision.
     *
     * Both are dispatch facts about THIS request, not failures of the request:
     * a cooldown is the transport's own conclusion that the account kept
     * failing while another served the same traffic, and a busy guard simply
     * means a concurrent request got there first (the DSH host always fires a
     * title request alongside the first message of a new session). Reporting
     * either through `switched` made the host treat a healthy skip as a
     * connection failure: it persisted a new active account, armed the
     * credential file for a rewrite, and told the user "已自动切换到下一个账号
     * 重试" 218ms into a request that never failed. So this branch only changes
     * where this request starts and never announces a failover.
     *
     * It DOES move the session pin, though — see the pin write below. A session
     * pin is this conversation's own "which account am I using", not the host's
     * global active pointer, and a conversation whose request was served by
     * another account is using that account from now on: its counters, its
     * continuation steps, and its next bound check all belong to the account
     * that ran the work. Leaving the pin on the skipped account would make the
     * next step of the same turn collide with the busy account again, and would
     * charge the skipped account for a request it never served.
     *
     * A cooldown IS a verdict on the account, though, and the host's metadata
     * reads (catalog, billing) sign with the store's active account. Leaving the
     * cooling credential active would move the chat path off it while the status
     * card kept reading through it, so the skip is adopted silently: `adopted`
     * changes the active pointer without a notice or a failover time. A busy
     * account must NOT be adopted — another request is just using it this
     * second, which says nothing about the account's health. When nothing else
     * is selectable the account is kept as the only option: the pool being
     * all-cooling or all-busy is not a reason to invent a wait or to refuse a
     * request that account may well serve now.
     */
    const firstCooling = this.penalties.isCooling(first.id)
    const firstBusy = this.traffic.isBusy(first.id)
    if (firstCooling || firstBusy) {
      const alternative = await this.nextWalkAccount(failover, first.id, new Set([first.id]))
      if (alternative !== undefined) {
        if (firstCooling) {
          try {
            // Awaiting is load-bearing: the adoption has to land before any
            // other path resolves the store's active account.
            await failover.adopted?.({ fromId: first.id, toId: alternative.id, reason: 'cooling' })
          } catch (error: unknown) {
            // Adoption only steers the host's metadata reads; a failing hook
            // must not cost this request its account selection.
            this.logger?.warn?.('[Qoder Stream] Could not adopt the account chosen after a cooldown', {
              fromId: first.id,
              toId: alternative.id,
              message: error instanceof Error ? error.message : String(error),
            })
          }
        }
        this.logger?.warn?.('[Qoder Stream] Starting this request on another account without failing over', {
          fromId: first.id,
          toId: alternative.id,
          cause: firstCooling ? 'cooling' : 'busy',
          // The ledger's own view of the skipped account. It is the only place
          // this state is ever reported, so without it a cooldown is invisible:
          // the request just starts somewhere else with no record of why, or of
          // when the account becomes eligible again.
          penalty: this.penalties.snapshot(first.id),
        })
        first = alternative
      }
    }
    /*
     * Pin the account this request ACTUALLY starts on — whichever way it was
     * chosen. Counters are statements about work an account did, so they must
     * follow the serving account: a reroute that left the pin behind charged the
     * skipped account for a request it never served and sent the next step of
     * the turn back into the busy one.
     *
     * This writes only the SESSION pin. The host's global active pointer is a
     * different thing, owned by `adopted`/`switched`, and a busy skip must not
     * touch it.
     */
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
      const state: AttemptState = { emitted: false }
      /*
       * The account served the request to the end, which is the exoneration
       * pending blame was waiting for: land every earlier account's failure now,
       * and clear anything still held against THIS account. Order matters so
       * that a request that starts on a penalised account (the all-cooling
       * fallback) clears it before any new penalty could apply to it.
       *
       * Wired as a callback rather than left after the `yield*` below because
       * the HTTP layer closes the body stream at the terminal chunk instead of
       * resuming this generator (see `attempt`): code after `yield*` is
       * unreachable in production, and the round bookkeeping plus this whole
       * exoneration path died with it.
       */
      state.onFinish = ((): ((chunk: StreamChunk) => void) => {
        // Captured by value: `account` is reassigned as the walk moves, and a
        // late callback must credit the account that actually served, not
        // whichever one the walk happens to hold when it fires.
        const servedId = account.id
        const servedTurn = newTurn
        return (chunk): void => {
          turn.terminal = true
          if (!isServedFinish(chunk)) {
            // No answer: an upstream error or a caller abort. It neither
            // exonerates the account nor completes a turn, and any turn that was
            // in flight ends here without a round.
            if (sessionId !== undefined) this.abandonTurn(sessionId, turnToken)
            return
          }
          this.penalties.noteSuccess(servedId)
          for (const blame of pendingBlame) this.penalties.noteFailure(blame.accountId, blame.kind)
          // The walk is over and every deferred penalty has landed, so nothing
          // may blame these accounts again if the caller keeps pulling.
          pendingBlame.length = 0
          this.noteTurnProgress(sessionId, servedId, chunk, servedTurn, turnToken)
        }
      })()
      // Set before the attempt, not after it: `attempt` reads it when it fires
      // the acceptance handler, and on a failure that escapes the walk it must
      // already name the account whose attempt failed last.
      attribution.accountId = account.id
      // Capture ownership before the attempt can await the network. Reading it
      // in catch would mistake a newer request's pin for this attempt's baseline.
      const pinBeforeAttempt = sessionId === undefined ? undefined : this.sessionPins.get(sessionId)
      try {
        yield* this.attempt(options, model, account, state, account.id, queueBudget)
        // Reached only when the source ended without a terminal chunk at all,
        // which the SSE layer treats as a failure. A normally finished stream
        // was already recorded by `state.onFinish` at its finish chunk.
        return
      } catch (error: unknown) {
        if (options.signal?.aborted || state.emitted) throw error
        if (!isAccountFailure(error)) throw error
        const next = await this.nextWalkAccount(failover, account.id, tried, true)
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
        await failover.switched({
          fromId: account.id,
          toId: next.id,
          reason,
          ...(sessionId === undefined ? {} : { sessionId }),
        })
        account = next
        // The session follows the walk. A pin left pointing at the account that
        // just failed would send the very next turn straight back to it, once
        // per request for as long as the pin lives — the opposite of recovery.
        if (sessionId === undefined || this.sessionPins.get(sessionId) === pinBeforeAttempt) {
          this.pinSession(sessionId, next)
        }
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
    account: { readonly pat: string; readonly region?: QoderRegion | undefined },
    state: AttemptState = { emitted: false },
    accountId?: string,
    queueBudget: QueueWaitLedger = this.newQueueWaitLedger(),
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
     * The traffic guard is the only gate between two concurrent requests and
     * one credential (T7): an account is busy exactly while this slot is held or
     * somebody is queued for it. The release closure is defined BEFORE
     * `traffic.acquire` because the acquire can throw (its documented contract
     * is "never rejects", but a failing guard or a test double can), and a slot
     * leaked on that path would make the account look busy forever. `release` is
     * idempotent, so the early definition costs nothing on the normal path.
     */
    let lease: QoderAccountLease | undefined
    let released = false
    const release = (): void => {
      if (released) return
      released = true
      lease?.release()
    }
    try {
      lease = accountId === undefined ? undefined : await this.traffic.acquire(accountId)
      for await (const chunk of this.attemptPaced(options, model, account, state, accountId, queueBudget)) {
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
        /*
         * Fire the finish hook at that same terminal chunk, for the same reason:
         * the walk never resumes after the finish chunk, so anything it wants to
         * record about the end of a step has to be recorded here, while the
         * transport is still being pulled. The hook receives the chunk because
         * the outcome matters — `stop`/`max-tokens` complete a turn, `tool-calls`
         * continues it, and an error or abort completes nothing.
         */
        if (chunk.type === 'finish' && state.onFinish !== undefined) {
          const onFinish = state.onFinish
          // One shot: a misbehaving source that yields twice must not credit the
          // round twice, and the callback must never be able to affect the
          // chunk stream by throwing.
          state.onFinish = undefined
          try {
            onFinish(chunk)
          } catch (error: unknown) {
            this.logger?.warn?.('[Qoder Stream] Finish bookkeeping threw; continuing the stream', {
              message: error instanceof Error ? error.message : String(error),
            })
          }
        }
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
    account: { readonly pat: string; readonly region?: QoderRegion | undefined },
    state: { emitted: boolean },
    accountId: string | undefined,
    queueBudget: QueueWaitLedger,
  ): AsyncGenerator<StreamChunk> {
    /*
     * Everything below signs against the ACCOUNT's region, not the variant's.
     *
     * A pool that spans both Qoder regions hands this transport an account
     * saved in the other file, and that account may only be exchanged and
     * signed against its own gateway: a China PAT sent to `api3.qoder.sh` is a
     * guaranteed rejection, and (worse) it would look like a broken credential
     * rather than a routing mistake. The region is a pure function of the
     * account the walk chose, so it is resolved once here and threaded through
     * the credential exchange, the image publication, the chat, and the
     * self-heal.
     */
    const region = this.attemptRegion(account)
    const auth = this.authFor(region)
    const uploader = this.uploaderFor(region)
    const pat = account.pat
    // Phase 2: credentials, which the center image exchange must be able to sign with.
    const credentials = await auth.getCredentials(pat, options.signal)
    // Phase 3: read attachments, publish images, and assemble wire messages.
    const messages = await translateQoderMessages(options, this.attachments, {
      uploader,
      credentials,
      preserveThinking: this.preserveThinking,
    })
    // Image publication may have refreshed a rejected job token, so the chat
    // credential is read once more: it must be the token that actually signs.
    let chatCredentials = await auth.getCredentials(pat, options.signal)
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
    // The conversation this attempt belongs to. Every notice it can produce —
    // the queue row, the deferred rotation row, the failed-heal row — is printed
    // here and nowhere else, and a pending rotation is filed under this key so
    // no other conversation can flush it.
    const pendingId = sessionIdOf(options)
    for (;;) {
      try {
        // A pending notice from an earlier heal is reported as soon as this
        // request is accepted (see `streamChat`).
        yield* this.streamChat(options, model, chatCredentials, messages, () => {
          this.onChatAccepted(accountId, sessionIdOf(options))
        }, region, onFirstByte)
        return
      } catch (error: unknown) {
        // A queue is resolved by waiting, never by another account and never by
        // a fresh token — so it is checked BEFORE the self-heal, whose exchange
        // would otherwise burn a job token on a model that was merely busy (a
        // queue answer classifies as RATE_LIMIT, not AUTH, so the heal would
        // in fact decline it — but the ordering makes that explicit rather than
        // incidental).
        if (queueBudget.waitsLeft > 0 && !state.emitted && options.signal?.aborted !== true) {
          const plan = this.queueWaitMs(error)
          if (plan !== undefined) {
            const waitMs = plan.waitMs
            queueBudget.waitsLeft -= 1
            const attempt = queueBudget.total - queueBudget.waitsLeft
            this.logger?.warn?.('[Qoder Stream] Upstream queue is saturated; waiting before retrying the same account', {
              waitMs,
              attempt,
              attemptsLeft: queueBudget.waitsLeft,
              basis: plan.basis.source,
            })
            /*
             * Report the wait BEFORE it starts, so the host can print a
             * progress row while the request would otherwise sit silent for
             * the whole advise window. A queue answer is the only evidence
             * that a wait is happening, and it rides this error.
             */
            const facts = error instanceof QoderLlmError ? error.qoderQueue : undefined
            if (facts !== undefined) {
              this.onQueueWait?.(facts, accountId, {
                waitMs,
                attempt,
                remaining: queueBudget.waitsLeft,
                basis: plan.basis,
              }, pendingId)
            }
            await this.waitOutQueue(waitMs, options.signal)
            // Only a wait that COMPLETED may be claimed: a thrown abort above
            // leaves the record untouched, so the final notice cannot describe a
            // sleep the caller cancelled.
            queueBudget.attempts += 1
            queueBudget.totalWaitMs += waitMs
            queueBudget.lastBasis = plan.basis
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
          if (noticeAt !== undefined) this.discardPendingRefreshNotice(pendingKeyOf(pendingId), noticeAt)
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
              region,
              at: Date.now(),
              ...(error.failure.status === undefined ? {} : { status: error.failure.status }),
              ...(pendingId === undefined ? {} : { sessionId: pendingId }),
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
        const refreshed = await auth.exchangeFresh(pat, options.signal)
        // The rotation has happened; the first chat accepted afterwards — this
        // round's retry or any subsequent one — is what makes it reportable.
        noticeAt = Date.now()
        this.pendingRefreshBySession.set(pendingKeyOf(pendingId), noticeAt)
        chatCredentials = refreshed
        healRound += 1
      }
    }
  }

  /**
   * The account the walk should visit next: cooling accounts (T5) are skipped
   * entirely, busy accounts (T7, the traffic guard is serving them) and
   * deprioritised accounts are collected as fallbacks, and a free candidate is
   * preferred over both.
   *
   * "Skip" is a statement about this request, not about the pool: cooling
   * accounts are left untried so a known-bad guess cannot spend the request,
   * but they stay in the walk order for when the ledger forgets them. Accounts
   * that are merely deprioritised are collected and used as a fallback — the
   * whole point of a downweight is "prefer others", not "refuse". A busy
   * account is the last resort, and only when `allowBusy` asks for it: a request
   * that would otherwise fail is better served by queueing behind the traffic
   * guard than by refusing the user, and the guard paces the two requests on
   * that identity. Dispatch-time selection (the cooling skip) leaves it out —
   * waiting for a busy account is worse than taking a merely cooling one now.
   *
   * Only a walk with no candidate at all returns `undefined`, which ends the
   * walk and lets the original failure surface. The search is bounded and never
   * revisits an id, so a host `nextAccount` that wraps the pool cannot make
   * selection loop.
   */
  private async nextWalkAccount(
    failover: NonNullable<QoderTransportOptions['failover']>,
    currentId: string,
    tried: ReadonlySet<string>,
    allowBusy = false,
  ): Promise<QoderPooledAccount | undefined> {
    const considered = new Set<string>([currentId])
    const deprioritized: QoderPooledAccount[] = []
    const busy: QoderPooledAccount[] = []
    let id = currentId
    for (let step = 0; step < maxWalkSearchSteps; step++) {
      const candidate = await this.nextAccount(failover, id, tried)
      if (candidate === undefined || tried.has(candidate.id) || considered.has(candidate.id)) break
      considered.add(candidate.id)
      if (this.penalties.isCooling(candidate.id)) {
        id = candidate.id
        continue
      }
      if (this.traffic.isBusy(candidate.id)) {
        if (allowBusy) busy.push(candidate)
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
    // A deprioritised but free account still beats queueing behind a busy one.
    return deprioritized[0] ?? (allowBusy ? busy[0] : undefined)
  }

  /**
   * The account an unpinned request starts on.
   *
   * Under the save-order strategy the stored active account is the whole
   * answer: nothing has been stated about priority, so "where the user left
   * off" is the only honest choice. Under a custom order the user has stated
   * one, so the first entry that still resolves is where a conversation opens;
   * the walk and the stickiness rotation then continue from there through the
   * same resolver, which is what turns the list into one policy instead of a
   * failure-only hint.
   *
   * A list that resolves to nobody is a typo, not a policy, so it falls back to
   * the active account rather than failing the request.
   *
   * Cooling and busy accounts are deliberately NOT skipped here: the dispatch
   * block that runs next applies those two transient facts to every start
   * whatever chose it, so this method stays a pure precedence decision.
   */
  private async preferredStart(
    failover: NonNullable<QoderTransportOptions['failover']>,
    active: QoderPooledAccount,
  ): Promise<QoderPooledAccount> {
    const routing = this.routing
    const resolve = failover.accountById
    if (routing === undefined || resolve === undefined || routing.strategy() !== 'custom') return active
    for (const id of routing.order()) {
      const account = await resolve(id)
      if (account !== undefined) return account
    }
    return active
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
  ): Promise<QoderPooledAccount | undefined> {
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
   * When `examineBounds` is true (a turn-opening request) and the pin has
   * reached one of its bounds the session is moved to the next account in the
   * walk order — reaching a bound means "change account", not "stop
   * remembering one". Only a session that has nobody to move to stays where
   * it is, with its counters restarted so the same bound is not examined and
   * rejected on every following request. Continuation steps pass `false`: the
   * pin is re-resolved but never rotated, so a turn can never be split across
   * accounts.
   */
  private async pinnedAccount(sessionId: string | undefined, examineBounds: boolean): Promise<QoderPooledAccount | undefined> {
    const policy = this.stickiness
    if (sessionId === undefined || policy === undefined || !this.stickinessEnabled(policy)) return undefined
    const resolve = this.failover?.accountById
    /*
     * Read the pin, then read it AGAIN after every await and act only on the pin
     * that is still in the table. Two requests of one session can run at once
     * (a continuation while the next turn opens), and either can rotate the
     * session while the other waits in a lookup. Writing back whatever the pin
     * said when a request started is how a rotated session is dragged back to
     * the account it just left, carrying that account's counters with it.
     */
    for (;;) {
      const pin = this.sessionPins.get(sessionId)
      if (pin === undefined) return undefined
      if (resolve !== undefined) {
        const account = await resolve(pin.id)
        if (this.sessionPins.get(sessionId) !== pin) continue
        if (account === undefined) {
          this.sessionPins.delete(sessionId)
          this.pendingTurns.delete(sessionId)
          this.sessionTurns.delete(sessionId)
          return undefined
        }
        pin.pat = account.pat
        pin.region = account.region
      }
      if (examineBounds && this.pinExhausted(pin, policy)) {
        const moved = await this.rotatePin(sessionId, pin)
        if (moved.kind === 'stale') continue
        if (moved.kind === 'moved') return moved.account
        // A pool of one, or a walk that has nobody after this account: the
        // session cannot move, so restart its counters. Without this the bound
        // would be re-examined and re-rejected on every request of the session.
        pin.pinnedAtMs = this.now()
        pin.rounds = 0
        pin.requests = 0
      }
      // A pin rotated away while this request read it must not be re-inserted:
      // that would resurrect a stale account AND the counters it made stale.
      if (this.sessionPins.get(sessionId) !== pin) continue
      // Re-inserting moves the pin to the young end of the eviction order.
      this.sessionPins.delete(sessionId)
      this.sessionPins.set(sessionId, pin)
      return { id: pin.id, pat: pin.pat, ...pin.region === undefined ? {} : { region: pin.region } }
    }
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
   * This goes through `nextWalkAccount` — the same resolver the failure walk
   * uses — instead of the raw `failover.nextAccount` hook, so a rotation follows
   * the user's custom `routing.order` and skips accounts the ledger is cooling
   * down or that the traffic guard is serving. Using the hook directly was the
   * second half of "每轮切换没有生效": the bound fired, but the session moved
   * along the host's SAVE order, so a custom priority list never took part in a
   * rotation at all.
   *
   * A pool whose every other account is cooling (or busy) must still rotate
   * rather than strand the session on the account it just outgrew, so the raw
   * hook is the fallback: a bound means "change account", and cooling is a
   * transient opinion, not a membership test. `undefined`, or the same account
   * back again (a pool of one), means there is nowhere to go.
   */
  private async rotatePin(
    sessionId: string,
    pin: SessionPin,
  ): Promise<PinRotation> {
    const failover = this.failover
    if (failover === undefined) return { kind: 'none' }
    const tried = new Set<string>([pin.id])
    const free = await this.nextWalkAccount(failover, pin.id, tried)
    // The walk awaits the host: the session may already have moved (or been
    // dropped) by the time it answers. Committing a choice computed from the
    // old pin would undo that newer decision.
    if (this.sessionPins.get(sessionId) !== pin) return { kind: 'stale' }
    const next = free ?? await this.nextAccount(failover, pin.id, tried)
    if (this.sessionPins.get(sessionId) !== pin) return { kind: 'stale' }
    if (next === undefined || next.id === pin.id) return { kind: 'none' }
    this.pinSession(sessionId, next)
    return {
      kind: 'moved',
      account: { id: next.id, pat: next.pat, ...next.region === undefined ? {} : { region: next.region } },
    }
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
   * Count one completed TURN against the account that served its final answer.
   *
   * A turn is the user's message through its final answer, tool steps included,
   * so it is worth exactly one round — credited when that answer arrives
   * (`stop` or `max-tokens`), never when an intermediate step merely asked for a
   * tool. A request that failed, or that the caller stopped reading, produced no
   * answer and must not move the session on.
   */
  private completeRound(sessionId: string | undefined, accountId: string): void {
    if (sessionId === undefined) return
    const pin = this.sessionPins.get(sessionId)
    if (pin === undefined || pin.id !== accountId) return
    pin.rounds += 1
  }

  /**
   * Record where a turn stands at the terminal chunk of one of its steps.
   *
   * A round is one COMPLETED turn, so it is credited only when the model's FINAL
   * answer arrives: `stop`, or `max-tokens` (a truncated answer is still an
   * answer). `tool-calls` means the model asked for tools and the SAME turn
   * continues in the next request, so the turn is only remembered as pending —
   * counting that step would spend the bound on a turn that has not finished.
   *
   * The final answer is credited to the account that actually served it. A turn
   * can be rerouted mid-way (the opening account fails and the walk lands
   * elsewhere), and the round belongs to the account that ran it to the end.
   */
  private noteTurnProgress(
    sessionId: string | undefined,
    accountId: string,
    chunk: StreamChunk,
    opening: boolean,
    turnToken: object | undefined,
  ): void {
    if (sessionId === undefined || chunk.type !== 'finish') return
    if (turnToken === undefined || this.sessionTurns.get(sessionId) !== turnToken) return
    const kind = chunk.reason.kind
    if (kind === 'stop' || kind === 'max-tokens') {
      // An opening request whose answer is already final completes its turn on
      // the spot; a continued step completes the turn its opening step started.
      // A continuation with no pending turn (the transport restarted mid-turn,
      // or was never told one started) credits nothing rather than inventing a
      // turn that this transport did not see open.
      if (opening || this.pendingTurns.has(sessionId)) this.completeRound(sessionId, accountId)
      this.pendingTurns.delete(sessionId)
      this.sessionTurns.delete(sessionId)
      return
    }
    // `tool-calls`: the turn is in flight and now belongs to the account that
    // served this step, which a failover may have changed. Without a pin there is
    // no stickiness to serve, so there is nothing worth remembering.
    if (this.sessionPins.has(sessionId)) this.pendingTurns.set(sessionId, { accountId })
  }

  /** Drop an unfinished turn only if no newer request has superseded it. */
  private abandonTurn(sessionId: string | undefined, turnToken: object | undefined): void {
    if (sessionId === undefined || turnToken === undefined) return
    if (this.sessionTurns.get(sessionId) !== turnToken) return
    this.sessionTurns.delete(sessionId)
    this.pendingTurns.delete(sessionId)
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
  private pinSession(sessionId: string | undefined, account: QoderPooledAccount): void {
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
        this.pendingTurns.delete(oldest.value)
        this.sessionTurns.delete(oldest.value)
      }
    }
    this.sessionPins.delete(sessionId)
    this.sessionPins.set(sessionId, {
      id: account.id,
      pat: account.pat,
      ...account.region === undefined ? {} : { region: account.region },
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
    // The master switch gates everything: off means no pinning regardless of
    // what the bounds say. This is the settings UI's toggle; the bounds below
    // are only read while it is on.
    if (!policy.enabled()) return false
    const minutes = policy.minutes()
    const rounds = policy.rounds()
    const requests = policy.requests()
    return (Number.isFinite(minutes) && minutes > 0)
      || (Number.isFinite(rounds) && rounds > 0)
      || (Number.isFinite(requests) && requests > 0)
  }

  /**
   * A fresh wait budget for ONE REQUEST, with nothing yet recorded against it.
   *
   * The budget belongs to the request, not to an attempt: a request that walks
   * from one account to the next is still one caller waiting, and refreshing
   * the budget on every switch would let an N-account pool hold that caller for
   * N times the configured number of waits (the reference implementation hit
   * exactly that and saw a single request take 197s). It is minted once in
   * `generate` and threaded through the whole walk.
   *
   * `attempts`/`totalWaitMs` start empty because they record what actually
   * happened: a wait the caller aborted mid-sleep must not be reported as one
   * the transport completed.
   */
  private newQueueWaitLedger(): QueueWaitLedger {
    const total = this.queueWaitBudget()
    return { waitsLeft: total, total, attempts: 0, totalWaitMs: 0, lastBasis: undefined }
  }

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
   * computed from the queue it describes, and the LARGER of its two hints is
   * used: `retryAfterSeconds` is a retry hint that can be far shorter than the
   * queue it describes (observed 30s against a `waitTime` of 86s), and a wait
   * that returns to the same queue is just a slower error. Both are capped: a
   * window long enough to outlive the caller's patience is a hang dressed up as
   * a wait. With no advice at all the configured seconds are the fallback. On
   * top of the window comes the padding and jitter described at
   * `queueWaitPaddingMs`, and the total is capped again so the padding can
   * never push a five-minute wait past the ceiling that exists to bound the
   * caller's time.
   *
   * The answer names WHICH value governed, not just the length. The host's row
   * used to print only the seconds, so a user reading "等待约 86 秒" next to a
   * 排队等待秒数 setting of 30 concluded the setting was ignored — when in fact
   * the setting is the fallback used only when the upstream advises nothing, and
   * the queue's own window plus the anti-stampede padding produced 86. Saying
   * which one drove the wait is the fix; changing the algorithm to obey the
   * setting would mean waiting out a queue the upstream said is longer, which
   * is a slower failure dressed up as obedience.
   */
  private queueWaitMs(error: unknown): { waitMs: number; basis: QoderQueueWaitBasis } | undefined {
    if (!(error instanceof QoderLlmError) || error.qoderQueue === undefined) return undefined
    const advised = error.failure.providerRetryAfterMs
    const advisedMs = advised !== undefined && Number.isFinite(advised) && advised > 0 ? advised : 0
    const waitTime = error.qoderQueue.waitTime
    const waitTimeMs = waitTime !== undefined && Number.isFinite(waitTime) && waitTime > 0 ? waitTime * 1000 : 0
    const queuedMs = Math.max(advisedMs, waitTimeMs)
    const configuredSeconds = Math.max(0, this.queueWait?.seconds() ?? 0)
    const baseMs = queuedMs > 0
      ? Math.min(queuedMs, queueWaitCeilingMs)
      : Math.min(configuredSeconds * 1000, queueWaitCeilingMs)
    const jitterMs = Math.floor(Math.max(0, Math.min(0.999, this.random())) * queueWaitJitterMs)
    const waitMs = Math.min(baseMs + queueWaitPaddingMs + jitterMs, queueWaitCeilingMs)
    // The advised seconds the queue answer actually named, if any: the larger
    // of its two hints, since that is the window the wait is built on.
    const advisedSeconds = queuedMs > 0 ? Math.round(queuedMs / 1000) : undefined
    return {
      waitMs,
      basis: {
        source: queuedMs > 0 ? 'upstream' : 'configured',
        ...(advisedSeconds === undefined ? {} : { advisedSeconds }),
        configuredSeconds,
      },
    }
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
