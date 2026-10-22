/**
 * Per-account traffic pacing for the Qoder transport.
 *
 * Multiple conversations can land on the same account in the same instant —
 * the host calls `stream()` once per conversation, and a pool with one active
 * account is the common case. Qoder's own client is a desktop app that talks to
 * its backend one conversation at a time with a visible gap between requests;
 * a burst of same-second requests from one credential is a shape it never sees
 * from its real users, which is exactly the kind of shape account protection is
 * looking for. This guard reproduces the client's traffic shape instead of
 * trying to explain ours.
 *
 * The guard is deliberately NOT a global lock: it is keyed by `account.id`, so
 * the accounts of a pool never wait for each other's traffic. It also fails
 * open. A host deadlock caused by our own pacing would be a worse outcome than
 * the burst the guard exists to avoid, so a request that cannot get its turn
 * within {@link accountAcquireTimeoutMs} is let through with a warning — the
 * warning exists so the fail-open is visible instead of silent.
 */

/**
 * Shortest wall-clock gap between two request STARTS on one account.
 *
 * Two requests whose starts are this far apart cannot overlap their initial
 * bursts even if their streams are long, because the guard also keeps at most
 * one attempt in flight per account.
 */
export const accountMinStartGapMs = 400

/**
 * Random spread added to the minimum gap.
 *
 * A fixed gap would produce an exactly periodic request pattern, which is its
 * own signal. Spreading each gap over a tenth of a second keeps the floor this
 * guard promises while making the cadence look like a person's.
 */
export const accountStartGapJitterMs = 100

/**
 * Longest a request may wait for its turn before the guard fails open.
 *
 * Thirty seconds is longer than any healthy queueing delay (the gap is under
 * half a second) and shorter than the point where the caller would conclude the
 * plugin hung; past it, letting the request through is the safer failure.
 */
export const accountAcquireTimeoutMs = 30_000

/** A granted turn on one account. Releasing it is idempotent. */
export interface QoderAccountLease {
  release(): void
}

/** Facts reported when the guard gives up waiting and lets a request through. */
export interface QoderAccountFailOpenInfo {
  accountId: string
  /** How long the request waited before being let through. */
  waitedMs: number
}

export interface QoderAccountTrafficLimiterOptions {
  minStartGapMs?: number
  jitterMs?: number
  acquireTimeoutMs?: number
  /**
   * Clock used to measure the gap between starts.
   *
   * Injectable for the same reason the transport's own clock is: a test can
   * simulate a request that waited the full timeout without sleeping, and the
   * transport shares one clock so pacing and stickiness agree on "now".
   */
  now?: () => number
  /**
   * Randomness for the gap jitter. Injectable so tests can pin it; production
   * shares `Math.random`.
   */
  random?: () => number
  /**
   * Sleep implementation, cancellable through the signal.
   *
   * Injectable so tests can advance their fake clock instantly. Resolving on
   * abort rather than rejecting is intentional: the only abort this sleep ever
   * receives is the guard cancelling the side of a race it lost, which is not
   * an error.
   */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>
  /** Called once per fail-open so the transport can log the warning. */
  onFailOpen?: (info: QoderAccountFailOpenInfo) => void
}

interface AccountGate {
  /** Waiters not yet holding the gate, in FIFO order. */
  waiters: Array<() => void>
  /** Whether some request currently holds the one slot for this account. */
  held: boolean
  /** When the last request on this account actually started. */
  lastStartMs: number | undefined
}

function defaultSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise<void>(resolve => {
    if (signal.aborted) {
      resolve()
      return
    }
    const timer = setTimeout(resolve, ms)
    signal.addEventListener('abort', () => {
      clearTimeout(timer)
      resolve()
    }, { once: true })
  })
}

/**
 * A keyed mutex with a minimum spacing between grants.
 *
 * Concurrency and spacing solve two different halves of the same problem: the
 * mutex guarantees a single in-flight attempt per account, while the spacing
 * guarantees that even back-to-back requests (where the previous one finished
 * quickly) still start no closer than {@link accountMinStartGapMs}. Measuring
 * from the previous START rather than the previous END is what makes the gap a
 * property of the account's traffic rather than of how long a chat happened to
 * take.
 */
export class QoderAccountTrafficLimiter {
  private readonly accounts = new Map<string, AccountGate>()
  private readonly minStartGapMs: number
  private readonly jitterMs: number
  private readonly acquireTimeoutMs: number
  private readonly now: () => number
  private readonly random: () => number
  private readonly sleep: (ms: number, signal: AbortSignal) => Promise<void>
  private readonly onFailOpen: ((info: QoderAccountFailOpenInfo) => void) | undefined

  constructor(options: QoderAccountTrafficLimiterOptions = {}) {
    this.minStartGapMs = Math.max(0, options.minStartGapMs ?? accountMinStartGapMs)
    this.jitterMs = Math.max(0, options.jitterMs ?? accountStartGapJitterMs)
    this.acquireTimeoutMs = Math.max(0, options.acquireTimeoutMs ?? accountAcquireTimeoutMs)
    this.now = options.now ?? Date.now
    this.random = options.random ?? Math.random
    this.sleep = options.sleep ?? defaultSleep
    this.onFailOpen = options.onFailOpen
  }

  /**
   * Wait for this account's turn, then mark the attempt as started.
   *
   * Never rejects and never waits past the acquire timeout: a request that
   * cannot get its turn is let through with a warning instead (see the module
   * comment). Callers must release the returned lease in a `finally`.
   */
  async acquire(accountId: string): Promise<QoderAccountLease> {
    const gate = this.gateFor(accountId)
    const startedWaitingAtMs = this.now()
    const deadlineMs = startedWaitingAtMs + this.acquireTimeoutMs

    if (gate.held) {
      const turn = this.waitForTurn(gate)
      const granted = await this.waitAtMost(turn, deadlineMs - this.now())
      if (!granted) {
        // The turn may still be handed over later; pass it straight on so the
        // account does not stay locked by a request that already gave up.
        void turn.then(() => this.handOver(gate))
        this.reportFailOpen(accountId, startedWaitingAtMs)
        return { release() {} }
      }
    } else {
      gate.held = true
    }

    // Once the slot is ours, honour the minimum gap before the attempt starts.
    const gapMs = this.minStartGapMs + Math.floor(clampRandom(this.random()) * this.jitterMs)
    const sinceLastStartMs = gate.lastStartMs === undefined
      ? Number.POSITIVE_INFINITY
      : this.now() - gate.lastStartMs
    const pauseMs = gapMs - sinceLastStartMs
    if (pauseMs > 0) {
      const remainingBudgetMs = deadlineMs - this.now()
      if (pauseMs >= remainingBudgetMs) {
        // The pacing gap alone would outlast the caller's patience: fail open
        // now, but release the slot first so waiting requests are not blocked
        // behind a request that never started.
        this.handOver(gate)
        this.reportFailOpen(accountId, startedWaitingAtMs)
        return { release() {} }
      }
      await this.sleep(pauseMs, new AbortController().signal)
    }

    gate.lastStartMs = this.now()
    let released = false
    return {
      release: () => {
        if (released) return
        released = true
        this.handOver(gate)
      },
    }
  }

  private gateFor(accountId: string): AccountGate {
    const existing = this.accounts.get(accountId)
    if (existing !== undefined) return existing
    const gate: AccountGate = { waiters: [], held: false, lastStartMs: undefined }
    this.accounts.set(accountId, gate)
    return gate
  }

  private waitForTurn(gate: AccountGate): Promise<void> {
    return new Promise<void>(resolve => {
      gate.waiters.push(resolve)
    })
  }

  /**
   * Release the slot, handing it to the next waiter if there is one.
   *
   * Handing over directly (instead of clearing `held` and letting a waiter
   * re-check) keeps the FIFO order and removes a wake-up race between two
   * requests that were both waiting.
   */
  private handOver(gate: AccountGate): void {
    const next = gate.waiters.shift()
    if (next === undefined) {
      gate.held = false
      return
    }
    gate.held = true
    next()
  }

  /** Resolve `true` when `work` finishes inside `timeoutMs`, `false` when not. */
  private async waitAtMost(work: Promise<void>, timeoutMs: number): Promise<boolean> {
    if (timeoutMs <= 0) return false
    const controller = new AbortController()
    const granted = work.then(() => true)
    const expired = this.sleep(timeoutMs, controller.signal).then(() => false)
    const won = await Promise.race([granted, expired])
    // Cancel the losing side so a test with a fake sleep does not leave a
    // pending timer behind and production does not hold a timer for 30s.
    controller.abort()
    return won
  }

  private reportFailOpen(accountId: string, startedWaitingAtMs: number): void {
    this.onFailOpen?.({ accountId, waitedMs: this.now() - startedWaitingAtMs })
  }
}

/** Keep a jitter multiplier inside `[0, 1)`; an injected `random` may stray. */
function clampRandom(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.max(0, Math.min(0.999, value))
}
