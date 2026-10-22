import { describe, expect, it } from 'vitest'
import {
  limitedFailureStreak,
  limitedQueueGapMs,
  QoderAccountHealthTracker,
} from '../src/account-health.ts'

/**
 * Per-account health: the three words the card puts after each account's
 * credits, and the observations each one is allowed to be claimed from.
 *
 * The rules under test are the user's own: 排队 is "the last thing we saw was
 * the queue answer", 限流 is "it keeps queueing (two answers an hour apart) or
 * it keeps failing to connect", and an account nobody has asked anything of yet
 * has NO verdict rather than "正常".
 */

const HOUR = 60 * 60 * 1000
const T0 = 1_700_000_000_000

describe('account health tracking', () => {
  it('has no verdict before anything is observed', () => {
    const tracker = new QoderAccountHealthTracker()
    expect(tracker.healthOf('a')).toBeUndefined()
  })

  it('is normal once a request was accepted, and after a connection failure alone', () => {
    const tracker = new QoderAccountHealthTracker()
    tracker.noteConnected('a', T0)
    expect(tracker.healthOf('a')).toBe('normal')

    tracker.noteFailure('a', T0 + 1000)
    // One dropped connection is not a verdict about the subscription.
    expect(tracker.healthOf('a')).toBe('normal')
  })

  it('reports queued after a single queue answer', () => {
    const tracker = new QoderAccountHealthTracker()
    tracker.noteQueue('a', T0)
    expect(tracker.healthOf('a')).toBe('queued')
  })

  it('promotes to limited on a second queue answer an hour later', () => {
    const tracker = new QoderAccountHealthTracker()
    tracker.noteQueue('a', T0)
    tracker.noteQueue('a', T0 + HOUR)
    expect(tracker.healthOf('a')).toBe('limited')
  })

  it('does not promote when the two answers are closer than an hour', () => {
    const tracker = new QoderAccountHealthTracker()
    tracker.noteQueue('a', T0)
    tracker.noteQueue('a', T0 + HOUR - 1)
    expect(tracker.healthOf('a')).toBe('queued')
  })

  it('promotes on repeated connection failures', () => {
    const tracker = new QoderAccountHealthTracker()
    for (let attempt = 0; attempt < limitedFailureStreak; attempt += 1) {
      tracker.noteFailure('a', T0 + attempt)
    }
    expect(tracker.healthOf('a')).toBe('limited')
  })

  it('does NOT promote on failures fewer than the threshold', () => {
    const tracker = new QoderAccountHealthTracker()
    for (let attempt = 0; attempt < limitedFailureStreak - 1; attempt += 1) {
      tracker.noteFailure('a', T0 + attempt)
    }
    expect(tracker.healthOf('a')).not.toBe('limited')
  })

  it('clears both the queue streak and the failure streak on an accepted request', () => {
    const tracker = new QoderAccountHealthTracker()
    tracker.noteQueue('a', T0)
    tracker.noteQueue('a', T0 + HOUR)
    expect(tracker.healthOf('a')).toBe('limited')

    tracker.noteConnected('a', T0 + HOUR + 1)
    expect(tracker.healthOf('a')).toBe('normal')

    tracker.noteFailure('a', T0 + HOUR + 2)
    tracker.noteFailure('a', T0 + HOUR + 3)
    // The pre-recovery failures must not count toward the new streak.
    expect(tracker.healthOf('a')).toBe('normal')
  })

  it('keeps accounts independent', () => {
    const tracker = new QoderAccountHealthTracker()
    tracker.noteQueue('a', T0)
    tracker.noteQueue('a', T0 + HOUR)
    tracker.noteConnected('b', T0)

    expect(tracker.healthOf('a')).toBe('limited')
    expect(tracker.healthOf('b')).toBe('normal')
    expect(tracker.healthOf('c')).toBeUndefined()
  })

  it('forgets an account on request and everything on clear', () => {
    const tracker = new QoderAccountHealthTracker()
    tracker.noteConnected('a', T0)
    tracker.forget('a')
    expect(tracker.healthOf('a')).toBeUndefined()

    tracker.noteConnected('b', T0)
    tracker.clear()
    expect(tracker.healthOf('b')).toBeUndefined()
  })

  it('is deterministic: the same observations always give the same verdict', () => {
    const run = (): string[] => {
      const tracker = new QoderAccountHealthTracker()
      tracker.noteQueue('a', T0)
      const first = tracker.healthOf('a') ?? 'none'
      tracker.noteQueue('a', T0 + limitedQueueGapMs)
      const second = tracker.healthOf('a') ?? 'none'
      tracker.noteConnected('a', T0 + limitedQueueGapMs + 1)
      const third = tracker.healthOf('a') ?? 'none'
      return [first, second, third]
    }
    expect(run()).toEqual(['queued', 'limited', 'normal'])
    expect(run()).toEqual(run())
  })
})
