import { describe, expect, it } from 'vitest'
import {
  limitedFailureStreak,
  queuedHealthTtlMs,
  QoderAccountHealthTracker,
} from '../src/account-health.ts'

/**
 * Per-account health: the three words the card puts after each account's
 * credits, and the observations each one is allowed to be claimed from.
 *
 * 排队 is a fresh fact about a MODEL's queue (the transport itself only waits
 * minutes, so the label does too); 限流 is the account-level verdict earned by
 * consecutive connection failures; an account nobody has asked anything of yet
 * has NO verdict rather than "正常".
 */

const T0 = 1_700_000_000_000

describe('account health tracking', () => {
  it('has no verdict before anything is observed', () => {
    const tracker = new QoderAccountHealthTracker()
    expect(tracker.healthOf('a', T0)).toBeUndefined()
  })

  it('is normal once a request was accepted, and after a connection failure alone', () => {
    const tracker = new QoderAccountHealthTracker()
    tracker.noteConnected('a', T0)
    expect(tracker.healthOf('a', T0)).toBe('normal')

    tracker.noteFailure('a', T0 + 1000)
    // One dropped connection is not a verdict about the subscription.
    expect(tracker.healthOf('a', T0 + 1000)).toBe('normal')
  })

  it('reports queued after a single queue answer, only while that answer is fresh', () => {
    const tracker = new QoderAccountHealthTracker()
    tracker.noteQueue('a', T0)
    expect(tracker.healthOf('a', T0)).toBe('queued')
    expect(tracker.healthOf('a', T0 + queuedHealthTtlMs)).toBe('queued')
    // The queue is the model's, not the account's: once the observation is
    // stale the honest verdict is "nothing observed", not 限流.
    expect(tracker.healthOf('a', T0 + queuedHealthTtlMs + 1)).toBeUndefined()
  })

  it('never promotes repeated queue answers to the account-level limited verdict', () => {
    const tracker = new QoderAccountHealthTracker()
    for (let hour = 0; hour < 4; hour += 1) {
      tracker.noteQueue('a', T0 + hour * queuedHealthTtlMs * 4)
    }
    expect(tracker.healthOf('a', T0 + 3 * queuedHealthTtlMs * 4)).toBe('queued')
    expect(tracker.healthOf('a', T0 + 4 * queuedHealthTtlMs * 4)).toBeUndefined()
    expect(tracker.healthOf('a', T0 + 5 * queuedHealthTtlMs * 4)).not.toBe('limited')
  })

  it('promotes on repeated connection failures', () => {
    const tracker = new QoderAccountHealthTracker()
    for (let attempt = 0; attempt < limitedFailureStreak; attempt += 1) {
      tracker.noteFailure('a', T0 + attempt)
    }
    expect(tracker.healthOf('a', T0 + limitedFailureStreak)).toBe('limited')
  })

  it('does NOT promote on failures fewer than the threshold', () => {
    const tracker = new QoderAccountHealthTracker()
    for (let attempt = 0; attempt < limitedFailureStreak - 1; attempt += 1) {
      tracker.noteFailure('a', T0 + attempt)
    }
    expect(tracker.healthOf('a', T0 + limitedFailureStreak - 1)).not.toBe('limited')
  })

  it('clears the queued observation and the failure streak on an accepted request', () => {
    const tracker = new QoderAccountHealthTracker()
    tracker.noteQueue('a', T0)
    expect(tracker.healthOf('a', T0 + 1)).toBe('queued')

    tracker.noteConnected('a', T0 + 2)
    expect(tracker.healthOf('a', T0 + 2)).toBe('normal')

    tracker.noteFailure('a', T0 + 3)
    tracker.noteFailure('a', T0 + 4)
    // The pre-recovery failures must not count toward the new streak.
    expect(tracker.healthOf('a', T0 + 4)).toBe('normal')
  })

  it('keeps accounts independent', () => {
    const tracker = new QoderAccountHealthTracker()
    tracker.noteQueue('a', T0)
    tracker.noteConnected('b', T0)

    expect(tracker.healthOf('a', T0)).toBe('queued')
    expect(tracker.healthOf('b', T0)).toBe('normal')
    expect(tracker.healthOf('c', T0)).toBeUndefined()
  })

  it('forgets an account on request and everything on clear', () => {
    const tracker = new QoderAccountHealthTracker()
    tracker.noteConnected('a', T0)
    tracker.forget('a')
    expect(tracker.healthOf('a', T0)).toBeUndefined()

    tracker.noteConnected('b', T0)
    tracker.clear()
    expect(tracker.healthOf('b', T0)).toBeUndefined()
  })

  it('is deterministic: the same observations and clock always give the same verdict', () => {
    const run = (): string[] => {
      const tracker = new QoderAccountHealthTracker()
      tracker.noteQueue('a', T0)
      const first = tracker.healthOf('a', T0) ?? 'none'
      const stale = tracker.healthOf('a', T0 + queuedHealthTtlMs + 1) ?? 'none'
      tracker.noteConnected('a', T0 + queuedHealthTtlMs + 2)
      const third = tracker.healthOf('a', T0 + queuedHealthTtlMs + 2) ?? 'none'
      return [first, stale, third]
    }
    expect(run()).toEqual(['queued', 'none', 'normal'])
    expect(run()).toEqual(run())
  })
})
