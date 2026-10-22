/**
 * In-process per-account health, observed from what the upstream did.
 *
 * The card shows one of three words after each account's credits — 正常 / 排队 /
 * 限流 — and every one of them is a claim about the *account*, so it has to be
 * built from that account's own answers rather than from a global error string.
 * The plugin already had the failure facts (the queue detector, the transport's
 * classified failures); what it lacked was somewhere to keep them per account.
 *
 * Nothing here is persisted. Health describes the last few minutes of a running
 * process, and a restart genuinely does not know what the upstream would say
 * now: a stale "限流" carried across a restart would accuse an account nobody
 * has asked anything of yet. `undefined` therefore means "no observation", and
 * the card renders nothing for it — not "正常", which would be an invented
 * verdict.
 *
 * @module dsh-qoder-plugin/account-health
 */

import type { QoderAccountHealth } from './status-paths.ts'

/**
 * How far apart two queue answers must be before they describe a pattern.
 *
 * The user's own rule: two queued answers more than an hour apart mean the
 * account is not merely waiting out one saturated model, it keeps coming back
 * to a queue. One hour is short enough that a genuinely rate-limited
 * subscription shows up within a working session, and long enough that a single
 * burst of retries inside one outage cannot produce it.
 */
export const limitedQueueGapMs = 60 * 60 * 1000

/**
 * Consecutive connection failures that read as "this account is rate-limited".
 *
 * Three, because one is a blip and two is a coincidence the network can produce:
 * a dropped socket, a DNS hiccup, a proxy restart. Three in a row without a
 * single successful exchange in between is the first count that is worth
 * telling the user about, and it is still small enough to surface while they
 * are looking at the screen.
 */
export const limitedFailureStreak = 3

/** What one account has shown, as the tracker remembers it. */
interface AccountObservation {
  /** First queue answer of the current streak. */
  firstQueueAtMs?: number | undefined
  /** Most recent queue answer. */
  lastQueueAtMs?: number | undefined
  /** Queue answers seen in the current streak. */
  queueCount: number
  /** Consecutive connection failures since the last accepted request. */
  failureStreak: number
  /** Whether the observations have described this account as limited. */
  limited: boolean
  /** Most recent accepted request, for "did it recover" bookkeeping. */
  lastConnectedAtMs?: number | undefined
}

/**
 * Per-variant, per-account health tracker.
 *
 * Deliberately takes explicit timestamps instead of reading the clock: the
 * hour-long rule is untestable otherwise, and the caller (the transport's
 * failover and queue hooks) already knows the moment the answer arrived.
 */
export class QoderAccountHealthTracker {
  private readonly observations = new Map<string, AccountObservation>()

  /**
   * Record one upstream "model not serviceable" (queued) answer.
   *
   * The second answer an hour or more after the first promotes the account to
   * `limited` and keeps it there until something shows the account works — the
   * point of the label is to outlast the queue it was inferred from.
   */
  noteQueue(accountId: string, atMs: number): void {
    const observation = this.observations.get(accountId) ?? this.fresh()
    if (observation.firstQueueAtMs === undefined) {
      observation.firstQueueAtMs = atMs
      observation.queueCount = 1
    } else {
      observation.queueCount += 1
    }
    observation.lastQueueAtMs = atMs
    /*
     * The promotion rule, stated exactly: a SECOND queue answer that lands at
     * least an hour after the first one in this streak. The first answer alone
     * is one saturated model; two an hour apart is an account that keeps
     * arriving at a queue. `queueCount >= 2` is what keeps a single answer that
     * merely happens to arrive an hour after an old one from qualifying.
     */
    if (
      !observation.limited
      && observation.queueCount >= 2
      && atMs - (observation.firstQueueAtMs ?? atMs) >= limitedQueueGapMs
    ) {
      observation.limited = true
    }
    this.observations.set(accountId, observation)
  }

  /**
   * Record one accepted request: the account demonstrably works.
   *
   * This is the only observation that clears `limited`, because it is the only
   * one that proves the condition it described is over. Clearing on a mere
   * absence of failures would silently forgive an account that simply has not
   * been asked anything since.
   */
  noteConnected(accountId: string, atMs: number): void {
    const observation = this.observations.get(accountId)
    if (observation === undefined) {
      this.observations.set(accountId, { ...this.fresh(), lastConnectedAtMs: atMs })
      return
    }
    observation.failureStreak = 0
    observation.queueCount = 0
    observation.firstQueueAtMs = undefined
    observation.lastQueueAtMs = undefined
    observation.limited = false
    observation.lastConnectedAtMs = atMs
    this.observations.set(accountId, observation)
  }

  /**
   * Record one failure to reach the upstream at all (transport error, timeout,
   * dropped stream) — not a refused request.
   *
   * The distinction matters: a 400 means the upstream answered and judged the
   * request, which says nothing bad about the account, while a connection that
   * never produced an answer may well be the network rather than the
   * subscription. Only the latter accumulates toward `limited`.
   */
  noteFailure(accountId: string, atMs: number): void {
    const observation = this.observations.get(accountId) ?? this.fresh()
    observation.failureStreak += 1
    if (observation.failureStreak >= limitedFailureStreak) observation.limited = true
    this.observations.set(accountId, observation)
  }

  /** What this account has shown, or `undefined` when it has shown nothing. */
  healthOf(accountId: string): QoderAccountHealth | undefined {
    const observation = this.observations.get(accountId)
    if (observation === undefined) return undefined
    if (observation.limited) return 'limited'
    if (observation.lastQueueAtMs !== undefined && observation.queueCount > 0) return 'queued'
    if (observation.lastConnectedAtMs !== undefined) return 'normal'
    return undefined
  }

  /** Forget one account (it was removed) so a re-saved token starts clean. */
  forget(accountId: string): void {
    this.observations.delete(accountId)
  }

  /** Forget everything for this variant. */
  clear(): void {
    this.observations.clear()
  }

  private fresh(): AccountObservation {
    return { queueCount: 0, failureStreak: 0, limited: false }
  }
}
