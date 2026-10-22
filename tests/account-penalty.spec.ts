import { describe, expect, it } from 'vitest'
import { QoderAccountPenaltyLedger } from '../src/account-health.ts'

/**
 * The in-process penalty ledger: how much repeated failures cost an account.
 *
 * The numbers are the user's own (rot-guard T5): a soft rate limit starts at ten
 * minutes and doubles, a breaker needs three landed hard failures and starts at
 * thirty minutes, and an unknown fault shape never blocks an account — it only
 * pushes it behind its siblings for a while. Escalation is bounded because an
 * unbounded ladder would let one bad afternoon retire an account for a day.
 *
 * A fake clock is passed in so a test can age a window out without waiting.
 */

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const T0 = 1_700_000_000_000

function ledgerAt(now: { value: number }): QoderAccountPenaltyLedger {
  return new QoderAccountPenaltyLedger(() => now.value)
}

/** Once a failure lands, how long until the account is selectable again. */
function cooldownMs(ledger: QoderAccountPenaltyLedger, accountId: string, now: number): number {
  const until = ledger.snapshot(accountId)?.cooldownUntilMs
  return until === undefined ? 0 : until - now
}

describe('account penalty ledger', () => {
  it('cools a softly rate-limited account for ten minutes, doubling each time up to two hours', () => {
    const now = { value: T0 }
    const ledger = ledgerAt(now)

    ledger.noteFailure('a', 'rate-limit')
    expect(ledger.isCooling('a')).toBe(true)
    expect(cooldownMs(ledger, 'a', T0)).toBe(10 * MINUTE)

    // The window actually expires: the ledger is a claim about the present, not
    // a permanent label.
    now.value = T0 + 10 * MINUTE
    expect(ledger.isCooling('a')).toBe(false)

    ledger.noteFailure('a', 'rate-limit')
    expect(cooldownMs(ledger, 'a', now.value)).toBe(20 * MINUTE)
    ledger.noteFailure('a', 'rate-limit')
    expect(cooldownMs(ledger, 'a', now.value)).toBe(40 * MINUTE)
    ledger.noteFailure('a', 'rate-limit')
    expect(cooldownMs(ledger, 'a', now.value)).toBe(80 * MINUTE)
    ledger.noteFailure('a', 'rate-limit')
    expect(cooldownMs(ledger, 'a', now.value)).toBe(2 * HOUR)
    // …and it stays bounded rather than doubling without limit.
    ledger.noteFailure('a', 'rate-limit')
    expect(cooldownMs(ledger, 'a', now.value)).toBe(2 * HOUR)
  })

  it('trips a breaker only on the third consecutive hard failure and starts at thirty minutes', () => {
    const now = { value: T0 }
    const ledger = ledgerAt(now)

    ledger.noteFailure('a', 'hard')
    ledger.noteFailure('a', 'hard')
    // Two failures are not a verdict: a single flaky minute must not stop the
    // account from being asked again.
    expect(ledger.isCooling('a')).toBe(false)
    expect(ledger.snapshot('a')?.consecutiveHardFailures).toBe(2)

    ledger.noteFailure('a', 'hard')
    expect(ledger.isCooling('a')).toBe(true)
    expect(cooldownMs(ledger, 'a', T0)).toBe(30 * MINUTE)
    // The streak is spent on the trip, so the next trip needs three more.
    expect(ledger.snapshot('a')?.consecutiveHardFailures).toBe(0)

    ledger.noteFailure('a', 'hard')
    ledger.noteFailure('a', 'hard')
    expect(cooldownMs(ledger, 'a', T0)).toBe(30 * MINUTE)
    ledger.noteFailure('a', 'hard')
    expect(cooldownMs(ledger, 'a', T0)).toBe(1 * HOUR)
  })

  it('caps the breaker at six hours', () => {
    const now = { value: T0 }
    const ledger = ledgerAt(now)
    for (let trip = 0; trip < 12; trip++) {
      ledger.noteFailure('a', 'hard')
      ledger.noteFailure('a', 'hard')
      ledger.noteFailure('a', 'hard')
    }
    expect(cooldownMs(ledger, 'a', T0)).toBe(6 * HOUR)
  })

  it('never blocks an account for an unknown fault shape: five of them only deprioritise it', () => {
    const now = { value: T0 }
    const ledger = ledgerAt(now)

    for (let failure = 0; failure < 4; failure++) ledger.noteFailure('a', 'unknown')
    expect(ledger.isCooling('a')).toBe(false)
    expect(ledger.isDeprioritized('a')).toBe(false)

    ledger.noteFailure('a', 'unknown')
    expect(ledger.isCooling('a')).toBe(false)
    expect(ledger.isDeprioritized('a')).toBe(true)

    now.value = T0 + 10 * MINUTE
    expect(ledger.isDeprioritized('a')).toBe(false)

    // The next five round the same window up to twenty minutes.
    for (let failure = 0; failure < 5; failure++) ledger.noteFailure('a', 'unknown')
    expect(ledger.isDeprioritized('a')).toBe(true)
    expect(ledger.snapshot('a')?.downweightUntilMs).toBe(now.value + 20 * MINUTE)
  })

  it('shares one escalation ladder across kinds, starting from each kind’s own base', () => {
    const now = { value: T0 }
    const ledger = ledgerAt(now)

    ledger.noteFailure('a', 'rate-limit')
    expect(cooldownMs(ledger, 'a', T0)).toBe(10 * MINUTE)
    // Second penalty on this account is a tripped breaker: its base is thirty
    // minutes, doubled once by the shared level.
    ledger.noteFailure('a', 'hard')
    ledger.noteFailure('a', 'hard')
    ledger.noteFailure('a', 'hard')
    expect(cooldownMs(ledger, 'a', T0)).toBe(1 * HOUR)
  })

  it('clears every penalty and counter once the account serves a request', () => {
    const now = { value: T0 }
    const ledger = ledgerAt(now)

    ledger.noteFailure('a', 'rate-limit')
    ledger.noteFailure('a', 'hard')
    ledger.noteFailure('a', 'hard')
    ledger.noteFailure('a', 'hard')
    expect(ledger.isCooling('a')).toBe(true)

    ledger.noteSuccess('a')
    expect(ledger.isCooling('a')).toBe(false)
    expect(ledger.isDeprioritized('a')).toBe(false)
    expect(ledger.snapshot('a')).toBeUndefined()

    // The fresh start includes the streak: two failures after a success are not
    // a trip.
    ledger.noteFailure('a', 'hard')
    ledger.noteFailure('a', 'hard')
    expect(ledger.isCooling('a')).toBe(false)
  })

  it('forgets one removed account without touching the others', () => {
    const now = { value: T0 }
    const ledger = ledgerAt(now)
    ledger.noteFailure('a', 'rate-limit')
    ledger.noteFailure('b', 'rate-limit')

    ledger.forget('a')
    expect(ledger.isCooling('a')).toBe(false)
    expect(ledger.isCooling('b')).toBe(true)

    ledger.clear()
    expect(ledger.isCooling('b')).toBe(false)
  })
})
