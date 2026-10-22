/**
 * Observability for errors the upstream reports *inside* a 200 SSE stream.
 *
 * Qoder accepts the chat request (HTTP 200) and then narrates the real failure
 * as an inner chunk: a content-policy refusal, a queue/throttle notice, or an
 * auth complaint. The decoder used to read those frames only for `choices`, so
 * the error text was silently dropped — the request simply ended without an
 * answer and nothing in the log named the reason. This module makes that
 * failure mode visible by classifying and counting the inner errors.
 *
 * It observes and counts, it never decides. A stream that has already delivered
 * bytes has handed content to the host, so it must not be retried or turned
 * into an error by the transport; only the classes and counts are exposed. The
 * same classification also feeds the first (and only) WARN that a stream emits
 * for a class, which keeps a repetitive error from flooding the log.
 *
 * Counters are process-wide and in memory, on purpose: they describe this
 * process's recent traffic, and a restart genuinely has no observations.
 *
 * @module dsh-qoder-plugin/qoder/transport/wire/inner-errors
 */

import { bearerValue, tokenValue } from '../logging.ts'

export type QoderInnerErrorClass =
  | 'content_policy'
  | 'rate_limit'
  | 'invalid_request'
  | 'auth'
  | 'other'

/** Every class the ledger reports, in a fixed order so snapshots are stable. */
export const qoderInnerErrorClasses: readonly QoderInnerErrorClass[] = [
  'content_policy',
  'rate_limit',
  'invalid_request',
  'auth',
  'other',
]

/** One observed inner error, already classified and safe to log. */
export interface QoderInnerErrorReport {
  classification: QoderInnerErrorClass
  /** Upstream code, when the payload carried one. */
  code?: string | number | undefined
  /** Bounded, credential-stripped message text. */
  message: string
}

const counters: Record<QoderInnerErrorClass, number> = {
  content_policy: 0,
  rate_limit: 0,
  invalid_request: 0,
  auth: 0,
  other: 0,
}

const maxMessageLength = 300

function sanitize(text: string): string {
  const bounded = text.length > maxMessageLength ? `${text.slice(0, maxMessageLength)}…` : text
  return bounded.replace(tokenValue, '[REDACTED]').replace(bearerValue, 'Bearer [REDACTED]')
}

/** Record one occurrence. Called for every chunk, including repeats. */
export function recordQoderInnerError(classification: QoderInnerErrorClass): void {
  counters[classification] += 1
}

/** Read-only process-wide snapshot, for health/status channels and tests. */
export function qoderInnerErrorSnapshot(): Readonly<Record<QoderInnerErrorClass, number>> {
  return { ...counters }
}

/** Clear the counters. Only tests should need this. */
export function resetQoderInnerErrors(): void {
  for (const classification of qoderInnerErrorClasses) counters[classification] = 0
}

interface ErrorFields {
  code?: string | number | undefined
  message: string
  type?: string | undefined
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function pickCode(value: unknown): string | number | undefined {
  if (typeof value === 'string' || typeof value === 'number') return value
  return undefined
}

/**
 * Pull the error facts out of an inner chunk.
 *
 * Qoder's payloads are not uniform: the same failure arrives as `error` (string
 * or object), as `errorCode`/`code` with an optional `message`, or folded into
 * a JSON string inside `message`. All of those shapes are read here so the
 * classification downstream is about the failure, not about which spelling it
 * used.
 */
export function readQoderInnerError(chunk: Record<string, unknown>): ErrorFields | undefined {
  const errorValue = chunk.error
  const errorObject = asRecord(errorValue) ?? asRecord(asRecord(chunk.detail)?.error)
  // Only a non-empty string or a non-empty object is an `error`; a falsy
  // sentinel (`error: false`, `error: {}`) is how some frames say "no error".
  const hasError = typeof errorValue === 'string'
    ? errorValue.trim() !== ''
    : errorObject !== undefined && Object.keys(errorObject).length > 0
  const code = pickCode(chunk.errorCode) ?? pickCode(chunk.code) ?? pickCode(errorObject?.code)
  const rawMessage = typeof errorValue === 'string'
    ? errorValue
    : errorObject?.message ?? chunk.message ?? chunk.msg ?? chunk.error_msg
  const message = typeof rawMessage === 'string' ? rawMessage : ''
  const codeSignal = code !== undefined && code !== 0 && code !== '0'
  if (!hasError && !codeSignal) return undefined
  // A normal completion chunk carries only id/model/choices/usage. Some frames
  // travel with a zero code or a stray message, so a frame that still parses as
  // a completion must never be read as an inner error.
  if (!hasError && chunk.choices !== undefined) return undefined
  return {
    ...code === undefined ? {} : { code },
    message: sanitize(message),
    ...typeof errorObject?.type === 'string' ? { type: errorObject.type } : {},
  }
}

function numericCode(code: string | number | undefined): number | undefined {
  if (typeof code === 'number') return code
  if (code === undefined) return undefined
  const parsed = Number(code)
  return Number.isFinite(parsed) ? parsed : undefined
}

/**
 * Classify one inner error.
 *
 * Order matters: an auth-looking word inside a content-policy refusal should
 * still read as a refusal, and the queue code 10605 is the upstream's throttle
 * marker even though it travels in a 200 stream. Unknown spellings land in
 * `other` rather than being guessed into a class that would trigger a retry.
 */
export function classifyQoderInnerError(fields: ErrorFields): QoderInnerErrorClass {
  const code = numericCode(fields.code)
  const text = `${fields.type ?? ''} ${fields.message}`.toLowerCase()
  // The key lists mirror the reference proxy's inner-error vocabulary, with
  // rate limiting before auth so "rate limit: token bucket exhausted" is not
  // read as a credential problem.
  if (fields.type === 'content_filter'
    || /content[_ -]?polic|content[_ -]?filter|moderation|data[_ -]?inspection|inappropriate content|sensitive[_ -]?content|敏感|违规/u.test(text)) {
    return 'content_policy'
  }
  if (code === 10605 || code === 429
    || /rate.?limit|too many requests|throttl|is[_ -]?queued|"queued"|queue|quota|saturat|overloaded/u.test(text)) {
    return 'rate_limit'
  }
  if (code === 401 || code === 403
    || /unauthor|forbidden|permission|expired|token|invalid api key|api key/u.test(text)) {
    return 'auth'
  }
  if (code === 400 || code === 404 || code === 405 || code === 422
    || /invalid|unsupported|malformed|missing (?:required )?parameter|must be a response|provider[_ -]?error|not found|参数/u.test(text)) {
    return 'invalid_request'
  }
  return 'other'
}

/** Detect, classify, and sanitize one inner chunk. Returns `undefined` when clean. */
export function detectQoderInnerError(chunk: Record<string, unknown>): QoderInnerErrorReport | undefined {
  const fields = readQoderInnerError(chunk)
  if (fields === undefined) return undefined
  return {
    classification: classifyQoderInnerError(fields),
    ...fields.code === undefined ? {} : { code: fields.code },
    message: fields.message,
  }
}
