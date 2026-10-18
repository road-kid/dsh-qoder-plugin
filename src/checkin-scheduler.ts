/** Scheduling and catch-up orchestration for daily 10:00 (UTC+8) check-in. */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { QoderCheckInResult } from './qoder/transport/checkin.ts'
import { qoderPluginDataDir } from './paths.ts'
import { DEFAULT_CLAIM_WINDOW_MINUTE, getClaimWindowDateString } from './claim-window.ts'

export interface VariantCheckInTarget {
  variantId: string
  /**
   * Claim today's benefit for this variant.
   *
   * The variant's own transport owns credential resolution, so this takes no
   * token: a missing or unusable credential surfaces as an `error` result
   * rather than a throw, which keeps one signed-out variant from stopping the
   * sweep for the other.
   */
  checkIn: (signal?: AbortSignal) => Promise<QoderCheckInResult>
  /**
   * The moment this variant checks in, as minutes past midnight in UTC+8.
   *
   * A getter rather than a value: the user can retime it on the card, and the
   * scheduler must observe the new value on its next pass without being
   * rebuilt.
   */
  minuteOfDay: () => number
  onClaimed?: () => void
}

export interface CheckInRecord {
  lastDate: string
  lastAt: number
  status: 'claimed' | 'already-claimed' | 'no-campaign' | 'error'
  amount?: number | undefined
  message?: string | undefined
  expiresAtMs?: number | undefined
}

export interface CheckInStatusStore {
  read(variantId: string): CheckInRecord | undefined
  write(variantId: string, record: CheckInRecord): void
}

export class JsonFileCheckInStore implements CheckInStatusStore {
  private readonly filePath: string

  constructor(filePath?: string) {
    this.filePath = filePath ?? join(qoderPluginDataDir(), 'checkin-status.json')
  }

  private readAll(): Record<string, CheckInRecord> {
    try {
      if (!existsSync(this.filePath)) return {}
      const raw = readFileSync(this.filePath, 'utf-8')
      return JSON.parse(raw) as Record<string, CheckInRecord>
    } catch {
      return {}
    }
  }

  read(variantId: string): CheckInRecord | undefined {
    return this.readAll()[variantId]
  }

  write(variantId: string, record: CheckInRecord): void {
    try {
      const all = this.readAll()
      all[variantId] = record
      mkdirSync(dirname(this.filePath), { recursive: true })
      writeFileSync(this.filePath, JSON.stringify(all, null, 2), 'utf-8')
    } catch {
      // Best-effort persistence
    }
  }
}

/**
 * Which daily CLAIM WINDOW an instant belongs to, as `YYYY-MM-DD` in UTC+8.
 *
 * Re-exported from the shared module so callers that already depend on the
 * scheduler keep one import; see `claim-window.ts` for why the window is not
 * the calendar day.
 */
export { getClaimWindowDateString } from './claim-window.ts'

/**
 * The moment a variant checks in, as minutes past midnight in UTC+8.
 *
 * 600 is 10:00, which is when the upstream resets the daily campaign; it is
 * also the default a variant falls back to when its setting is absent or
 * malformed, so a bad stored value can never leave the day unscheduled.
 *
 * Aliased to the claim-window constant rather than restated: this moment IS
 * the window opening, and two literals would let the timer and the window
 * comparison drift apart the day someone edits one of them.
 */
export const DEFAULT_CHECK_IN_MINUTE = DEFAULT_CLAIM_WINDOW_MINUTE

/** Clamp any stored/typed value onto a real minute of the day. */
export function normalizeCheckInMinute(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_CHECK_IN_MINUTE
  const whole = Math.trunc(value)
  if (whole < 0 || whole > 1439) return DEFAULT_CHECK_IN_MINUTE
  return whole
}

/**
 * Calculates milliseconds until the next occurrence of `minuteOfDay` (UTC+8).
 *
 * Five seconds past the configured minute are used so the request lands after
 * the upstream has flipped the day over rather than on the boundary itself.
 */
export function msUntilNextCheckIn(minuteOfDay: number, nowMs: number = Date.now()): number {
  const minute = normalizeCheckInMinute(minuteOfDay)
  const d = new Date(nowMs)
  // Calculate current UTC+8 wall clock
  const utc8Time = new Date(d.getTime() + (d.getTimezoneOffset() + 480) * 60_000)
  const targetUtc8 = new Date(utc8Time.getTime())
  targetUtc8.setHours(Math.floor(minute / 60), minute % 60, 5, 0)

  let diff = targetUtc8.getTime() - utc8Time.getTime()
  if (diff <= 0) {
    // Today's moment has passed, schedule for tomorrow
    targetUtc8.setDate(targetUtc8.getDate() + 1)
    diff = targetUtc8.getTime() - utc8Time.getTime()
  }
  return diff
}

/**
 * Whether today's configured check-in moment (UTC+8) has already passed.
 */
export function isPastCheckInTime(minuteOfDay: number, nowMs: number = Date.now()): boolean {
  const minute = normalizeCheckInMinute(minuteOfDay)
  const d = new Date(nowMs)
  const utc8 = new Date(d.getTime() + (d.getTimezoneOffset() + 480) * 60_000)
  return utc8.getHours() * 60 + utc8.getMinutes() >= minute
}

export interface CheckInSchedulerOptions {
  targets: VariantCheckInTarget[]
  isEnabled: (variantId: string) => boolean
  store?: CheckInStatusStore | undefined
  onResult?: ((result: QoderCheckInResult) => void) | undefined
  now?: (() => number) | undefined
}

export class CheckInScheduler {
  private readonly targets: VariantCheckInTarget[]
  private readonly isEnabled: (variantId: string) => boolean
  private readonly store: CheckInStatusStore
  private readonly onResult: ((result: QoderCheckInResult) => void) | undefined
  private readonly now: () => number
  /**
   * One timer per enabled variant, keyed by variant id.
   *
   * Per-variant rather than one shared timer because the two products may be
   * configured to different moments; a single timer would have to wake for the
   * earliest and then decide who was due, which is the same bookkeeping with a
   * worse failure mode.
   */
  private readonly timers = new Map<string, NodeJS.Timeout>()
  /**
   * Variants with a sweep in progress, so concurrent callers cannot double-claim.
   */
  private readonly inFlight = new Set<string>()
  /** When each variant's timer is next due, epoch ms, for the card to show. */
  private readonly nextRuns = new Map<string, number>()
  private disposed = false

  constructor(options: CheckInSchedulerOptions) {
    this.targets = options.targets
    this.isEnabled = options.isEnabled
    this.store = options.store ?? new JsonFileCheckInStore()
    this.onResult = options.onResult
    this.now = options.now ?? Date.now
  }

  start(): void {
    if (this.disposed) return
    // Immediate catch-up evaluation on startup
    void this.sweepAll(true)
    this.rearm()
  }

  /**
   * Re-run the startup catch-up once the toggles are actually readable.
   *
   * `start()` runs while the plugin is still assembling, before the settings
   * section that owns these toggles has handed over its stored values, so that
   * first sweep sees the raw plugin config and skips the day. The host calls
   * this again from the section's source callback; the sweep is idempotent, so
   * a day already handled costs nothing.
   */
  catchUp(): void {
    if (this.disposed) return
    void this.sweepAll(true)
  }

  dispose(): void {
    this.disposed = true
    for (const timer of this.timers.values()) clearTimeout(timer)
    this.timers.clear()
  }

  /**
   * Re-place every variant's timer.
   *
   * Called after each fire and whenever configuration lands or changes, so a
   * user editing the time on the card does not have to restart DSH for it to
   * take effect.
   *
   * A timer is placed for every target, including variants whose toggle is
   * currently off. `start()` runs while the plugin is still assembling, when
   * the stored toggles are not readable yet, so gating placement on
   * `isEnabled` left a variant with NO timer at all — and nothing re-armed it
   * afterwards, which is precisely how a configured 12:13 check-in never
   * fired. Whether the work is due is decided inside the sweep, where the
   * configuration is current; the timer only decides when to look.
   */
  rearm(): void {
    if (this.disposed) return
    for (const timer of this.timers.values()) clearTimeout(timer)
    this.timers.clear()
    this.nextRuns.clear()
    const nowMs = this.now()
    for (const target of this.targets) {
      const delay = msUntilNextCheckIn(target.minuteOfDay(), nowMs)
      // Published so the card can say when the next automatic run is due. That
      // is the only way a user can tell a scheduled timer from a missing one:
      // a day already claimed goes quiet by design, and silence looks
      // identical to a broken scheduler.
      this.nextRuns.set(target.variantId, nowMs + delay)
      const timer = setTimeout(() => {
        this.timers.delete(target.variantId)
        void this.sweepAll(false, target.variantId).finally(() => { this.rearm() })
      }, delay)
      timer.unref?.()
      this.timers.set(target.variantId, timer)
    }
  }

  /** When this variant's timer is next due, epoch ms; absent before first arm. */
  nextRunAt(variantId: string): number | undefined {
    return this.nextRuns.get(variantId)
  }

  async sweepAll(isCatchUp: boolean, only?: string): Promise<void> {
    if (this.disposed) return
    const nowMs = this.now()

    for (const target of this.targets) {
      if (only !== undefined && target.variantId !== only) continue
      if (!this.isEnabled(target.variantId)) continue
      // One variant is never swept twice at once. `start()` and the settings
      // section's first catch-up are both in the air during assembly, and
      // without this latch both claimed — the live log caught two rows five
      // milliseconds apart for a single action.
      if (this.inFlight.has(target.variantId)) continue
      this.inFlight.add(target.variantId)
      try {
        await this.sweepOne(target, isCatchUp, nowMs)
      } finally {
        this.inFlight.delete(target.variantId)
      }
    }
  }

  private async sweepOne(
    target: VariantCheckInTarget,
    isCatchUp: boolean,
    nowMs: number,
  ): Promise<void> {
    const record = this.store.read(target.variantId)
    /*
     * Only an actually claimed WINDOW is settled — and it is the window, not
     * the calendar day, that must be compared.
     *
     * The upstream's window opens at this variant's configured moment (10:00
     * by default) and runs until the same moment the next day, so between
     * midnight and 10:00 a claimed window still has hours left to run. A
     * calendar-day comparison called that window unclaimed and sent a second
     * request the upstream could only refuse — observed as the card offering
     * "立即领取" again at 00:44 for a benefit claimed at 23:11.
     *
     * A window whose attempt ended in "no campaign" (the upstream had not
     * released it yet) or in an error must stay retryable, otherwise one early
     * failure burns the whole window.
     */
    const currentWindow = getClaimWindowDateString(nowMs, target.minuteOfDay())
    const settledToday = record?.lastDate === currentWindow
      && (record.status === 'claimed' || record.status === 'already-claimed')
    if (settledToday) {
      // A scheduled run that finds the day already handled still leaves a row.
      // The claim itself is correctly skipped (one benefit per day), but total
      // silence is indistinguishable from a timer that never fired — which is
      // exactly how a user concludes the scheduler is broken.
      if (!isCatchUp) {
        this.store.write(target.variantId, {
          // The WINDOW, not the calendar day: this row is what the next
          // settle check compares against, so writing a different notion
          // here would make the record disagree with its own guard.
          lastDate: currentWindow,
          lastAt: nowMs,
          status: 'already-claimed',
          ...record.amount === undefined ? {} : { amount: record.amount },
          message: 'Scheduled check-in ran; this window was already claimed',
        })
      }
      return
    }
    // A catch-up run only makes sense once this variant's configured moment
    // has passed; before it, the variant's own timer still owns today.
    if (isCatchUp && !isPastCheckInTime(target.minuteOfDay(), nowMs)) return

    let result: QoderCheckInResult
    try {
      result = await target.checkIn()
    } catch {
      // A transport-level throw (no credential at all, a rejection) is not a
      // settled day: leave the record alone so a later sweep can retry.
      return
    }
    try {
      if (result.status !== 'error') {
        /*
         * The WINDOW label is stamped from this sweep's own configured moment
         * rather than taken from `result.date`.
         *
         * The transport does not know the user's configured window (it is
         * built once, while the window minute is read per sweep), so it labels
         * a claim with the documented default. Storing that would let the
         * record and the guard above disagree whenever a user retimes the
         * window, which is the same mismatch this change exists to remove.
         */
        this.store.write(target.variantId, {
          lastDate: currentWindow,
          lastAt: result.timestamp,
          status: result.status,
          amount: result.amount,
          message: result.message,
          ...result.expiresAtMs === undefined ? {} : { expiresAtMs: result.expiresAtMs },
        })
        if (result.status === 'claimed') {
          target.onClaimed?.()
        }
      }
      this.onResult?.(result)
    } catch {
      // Ignored to protect loop
    }
  }
}
