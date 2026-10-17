/**
 * Qoder's daily claim window, as a date string.
 *
 * The upstream opens a new claim window every day at 10:00 UTC+8 and closes it
 * just before 10:00 the following morning, so a window is NOT a calendar day:
 * the hours between midnight and 10:00 belong to the window that opened the
 * previous day. Anything that asks "is the current window already claimed?"
 * must compare window days, or it declares a live claim dead at midnight and
 * re-arms an action the upstream can only refuse.
 *
 * This lives on its own so both the scheduler and the transport can share one
 * definition without importing each other.
 *
 * @module dsh-qoder-plugin/claim-window
 */

/**
 * When the upstream resets the daily campaign: 10:00 UTC+8, as minutes past
 * midnight. The scheduler's default and the documented window opening.
 */
export const DEFAULT_CLAIM_WINDOW_MINUTE = 600

/** Minutes past midnight in UTC+8 for an instant, ignoring the host timezone. */
function utc8MinuteOfDay(nowMs: number): { date: Date; minuteOfDay: number } {
  const d = new Date(nowMs)
  // Shift by the timezone offset to UTC, then +8 hours (480 minutes).
  const utc8 = new Date(d.getTime() + (d.getTimezoneOffset() + 480) * 60_000)
  return { date: utc8, minuteOfDay: utc8.getHours() * 60 + utc8.getMinutes() }
}

/**
 * Which claim window an instant belongs to, as `YYYY-MM-DD` in UTC+8.
 *
 * The returned label is the date the window OPENED. So 2026-09-30 23:11 and
 * 2026-10-01 00:44 both answer `2026-09-30`: one window, still open, still
 * claimed.
 */
export function getClaimWindowDateString(
  nowMs: number = Date.now(),
  windowMinute: number = DEFAULT_CLAIM_WINDOW_MINUTE,
): string {
  const { date, minuteOfDay } = utc8MinuteOfDay(nowMs)
  // Before the window opens, this instant still belongs to yesterday's window.
  if (minuteOfDay < windowMinute) date.setDate(date.getDate() - 1)
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}
