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

/**
 * The kinds of failure that can earn an account a penalty.
 *
 * They are separated because they earn different treatment: a throttled account
 * is a subscription the upstream is pacing (wait it out), a hard failure is an
 * account that could not serve at all (stop asking it for a while), and an
 * unknown shape must not be trusted enough to stop the walk entirely — it only
 * moves the account down the preference order.
 */
export type QoderAccountPenaltyKind = 'rate-limit' | 'hard' | 'unknown'

/** One account's penalty state, as a read-only view for tests and diagnostics. */
export interface QoderAccountPenaltySnapshot {
  /** Instant the cooling window ends; `undefined` when the account is not cooling. */
  cooldownUntilMs: number | undefined
  /** Instant the downweight window ends; `undefined` when not downweighted. */
  downweightUntilMs: number | undefined
  /** How many penalties have landed on this account, across all kinds. */
  level: number
  /** Consecutive landed hard failures since the last success. */
  consecutiveHardFailures: number
  /** Landed unknown failures since the last success or the last downweight. */
  unknownFailures: number
}

/** Soft rate-limit cooldown for the first offence: ten minutes. */
const rateLimitBaseCooldownMs = 10 * 60 * 1000
/** Ceiling for soft rate-limit cooldowns: two hours. */
const rateLimitMaxCooldownMs = 2 * 60 * 60 * 1000
/** Consecutive hard failures before the circuit breaker trips. */
const breakerThreshold = 3
/** Circuit-breaker cooldown for the first trip: thirty minutes. */
const breakerBaseCooldownMs = 30 * 60 * 1000
/** Ceiling for circuit-breaker cooldowns: six hours. */
const breakerMaxCooldownMs = 6 * 60 * 60 * 1000
/** Unknown failures before the account is merely deprioritised. */
const downweightThreshold = 5
/** First downweight window: ten minutes. */
const downweightBaseCooldownMs = 10 * 60 * 1000
/** Ceiling for downweight windows: two hours. */
const downweightMaxCooldownMs = 2 * 60 * 60 * 1000

/**
 * In-process penalty ledger: what repeated failures have cost each account.
 *
 * Nothing here is persisted, and that is intentional rather than an omission. A
 * cooldown is a claim about how the upstream is treating an account RIGHT NOW;
 * carrying it across a restart would punish an account for an outage the new
 * process never observed, and the restart itself is often the user's response
 * to that outage (their first fix attempt would appear to do nothing). A fresh
 * process starts with a clean, if uninformed, ledger.
 *
 * Escalation is per account, not per kind: one account-level `level` ladder
 * makes any repeated misbehaviour — throttling, hard failures, unknown faults —
 * cost more each time, which is the property "this account keeps causing
 * trouble" that the ledger is trying to express. The first rung of each kind is
 * what differs (ten minutes for a soft throttle, thirty for a tripped breaker).
 *
 * The ledger is deliberately silent about WHO gets punished and WHEN: the
 * transport holds the failures in a pending-blame list for the duration of one
 * request walk and only calls {@link noteFailure} once a different account has
 * demonstrably served the request. A whole-pool failure therefore punishes
 * nobody, which is the single most important rule here — the upstream going
 * down must not burn every account in the pool.
 */
export class QoderAccountPenaltyLedger {
  private readonly accounts = new Map<string, QoderAccountPenaltySnapshot>()
  /**
   * The clock, injected so tests can age a cooldown out.
   *
   * Declared as an explicit field instead of a constructor parameter property:
   * the repository's `node --test` path runs Node's strip-only type erasure,
   * which rejects parameter properties (they emit runtime assignments, not just
   * type syntax).
   */
  private readonly now: () => number

  constructor(now: () => number = Date.now) {
    this.now = now
  }

  /** Whether the account is inside a penalty window and should be skipped. */
  isCooling(accountId: string): boolean {
    const cooldownUntilMs = this.accounts.get(accountId)?.cooldownUntilMs
    return cooldownUntilMs !== undefined && cooldownUntilMs > this.now()
  }

  /**
   * Whether the account should be tried only after the other candidates.
   *
   * Downweighting never blocks the account: five unknown failures make it a
   * worse guess than its siblings, not an unusable one, and the pool may have
   * nothing else.
   */
  isDeprioritized(accountId: string): boolean {
    const downweightUntilMs = this.accounts.get(accountId)?.downweightUntilMs
    return downweightUntilMs !== undefined && downweightUntilMs > this.now()
  }

  /**
   * Land one failure's blame on the account it belongs to.
   *
   * Called only after another account has succeeded (the transport defers it),
   * so this method is free to count the failure as evidence against the
   * account. A success resets every counter here — see {@link noteSuccess}.
   */
  noteFailure(accountId: string, kind: QoderAccountPenaltyKind): void {
    const account = this.accounts.get(accountId) ?? {
      cooldownUntilMs: undefined,
      downweightUntilMs: undefined,
      level: 0,
      consecutiveHardFailures: 0,
      unknownFailures: 0,
    }
    const at = this.now()
    if (kind === 'rate-limit') {
      account.cooldownUntilMs = at + this.escalated(account.level, rateLimitBaseCooldownMs, rateLimitMaxCooldownMs)
      account.level += 1
    } else if (kind === 'hard') {
      account.consecutiveHardFailures += 1
      if (account.consecutiveHardFailures >= breakerThreshold) {
        account.cooldownUntilMs = at + this.escalated(account.level, breakerBaseCooldownMs, breakerMaxCooldownMs)
        account.level += 1
        // The breaker just tripped for this streak; the next trip needs three
        // fresh failures, so a single outage cannot ratchet the account to the
        // six-hour ceiling in a handful of retries.
        account.consecutiveHardFailures = 0
      }
    } else {
      account.unknownFailures += 1
      if (account.unknownFailures >= downweightThreshold) {
        account.downweightUntilMs = at + this.escalated(account.level, downweightBaseCooldownMs, downweightMaxCooldownMs)
        account.level += 1
        // Start counting again after each downweight, so five more unknown
        // failures are needed before the window escalates again.
        account.unknownFailures = 0
      }
    }
    this.accounts.set(accountId, account)
  }

  /**
   * The account served a request to the end: clear everything held against it.
   *
   * One completed request is proof that the conditions the ledger described are
   * over, and a partially forgiven penalty would keep punishing an account that
   * is demonstrably serving — the exact self-harm this ledger exists to avoid.
   */
  noteSuccess(accountId: string): void {
    this.accounts.delete(accountId)
  }

  /** Forget one account (it was removed), so a re-saved token starts clean. */
  forget(accountId: string): void {
    this.accounts.delete(accountId)
  }

  /** Forget every account (settings reset, or a test fixture). */
  clear(): void {
    this.accounts.clear()
  }

  /** Read-only view of one account's penalty state, for tests and diagnostics. */
  snapshot(accountId: string): QoderAccountPenaltySnapshot | undefined {
    const account = this.accounts.get(accountId)
    return account === undefined ? undefined : { ...account }
  }

  /** Duration for the `level`-th escalation of one penalty kind. */
  private escalated(level: number, baseMs: number, maxMs: number): number {
    return Math.min(baseMs * 2 ** level, maxMs)
  }
}
