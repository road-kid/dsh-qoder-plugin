/**
 * DSH-compatible LLM error representation.
 *
 * @module dsh-qoder-plugin/qoder/errors
 */

import { LlmError, ProviderRequestId, type LlmErrorOptions } from '@deepseek-ai/dsh-llm'
import { parseQueueFacts, type QoderQueueFacts } from './queue-notice.ts'

export type { QoderQueueFacts }

export class QoderLlmError extends LlmError {
  /**
   * The parsed queue answer, when this error IS the upstream's "model not
   * serviceable" reply.
   *
   * It rides the error because the body is the only place the distinction
   * lives, and the body is read exactly once, here, while classifying. Every
   * layer above gets the explanation without re-reading or re-parsing a body
   * it never had: the host builds the user-facing notice from this, and the
   * notice can therefore never disagree with the classification that decided
   * the request failed.
   */
  qoderQueue?: QoderQueueFacts

  constructor(message: string, code: string = 'UNKNOWN_ERROR', options?: LlmErrorOptions) {
    super(message, code, options)
  }
}

/**
 * The queue/limit markers Qoder puts in a rejection body (observed 2026-09-26).
 *
 * `./queue-notice.ts` keeps its own copy of this list on purpose: this one
 * drives the AUTH-versus-RATE_LIMIT classification shared with `src/upstream.ts`
 * and the transport, and it must keep reading observed bodies exactly as they
 * are even if the richer parser next door changes. Tests on both sides hold the
 * two in step.
 */
const QUEUE_BODY_MARKERS: readonly RegExp[] = [
  /"code"\s*:\s*"?10605"?/u,
  /"isQueued"\s*:\s*true/u,
  /"queueCount"/u,
  /"serviceAvailable"\s*:\s*false/u,
] as const

/**
 * Whether an upstream rejection body is Qoder's **queue/limit** answer rather
 * than an authorization failure.
 *
 * Qoder answers a saturated per-model queue (and a region whose service is not
 * available) with an HTTP 401/403 — or a 200 SSE envelope carrying
 * `statusCodeValue: 403` — whose body says `code: 10605`, `isQueued: true`,
 * `queueCount`, `retryAfterSeconds` and sometimes `serviceAvailable: false`.
 * Observed verbatim on 2026-09-26:
 *
 *     {"code":"10605","message":"{\"isQueued\":true,\"modelKey\":\"qfmodel\",
 *      \"queueCount\":8887,\"queueType\":\"p3\",\"retryAfterSeconds\":30,
 *      \"serviceAvailable\":true,\"waitTime\":274}"}
 *
 * Reading that status as AUTH made the self-heal exchange fresh job tokens
 * against a queue no token can jump, and — because the host retries
 * `RATE_LIMIT` but deliberately not `AUTH` — it also suppressed the automatic
 * retry that would have sailed through the 30-second window. The body is the
 * only place the distinction is visible, so it gets the last say over status.
 */
export function qoderQueueSignal(body: string | undefined): { retryAfterMs?: number } | undefined {
  if (body === undefined || body === '') return undefined
  // The body often arrives JSON-nested inside the SSE envelope's own JSON,
  // which escapes every inner quote (`\"retryAfterSeconds\":30`). Dropping the
  // escapes keeps the markers readable at any nesting depth; for detection
  // this only removes ASCII backslashes, which no marker depends on.
  const text = body.replace(/\\/gu, '')
  if (!QUEUE_BODY_MARKERS.some(marker => marker.test(text))) return undefined
  const match = /"retryAfterSeconds"\s*:\s*(\d+)/u.exec(text)
  return match === null ? {} : { retryAfterMs: Number(match[1]) * 1000 }
}

/**
 * The parsed facts of Qoder's queue/unserviceable answer, or `undefined` when
 * the body is not that answer at all.
 *
 * {@link qoderQueueSignal} answers the classification question — "is this a
 * throttle rather than a dead credential?" — with the minimum it needs. This
 * answers the explanation question — "what should the user be told?" — from the
 * same body, so a call site can classify an error and describe it without
 * parsing the nesting twice, and the two can never disagree about what the
 * upstream said. The re-export lives here because this module owns the
 * upstream-error surface callers already import.
 */
export function qoderQueueFacts(body: string | undefined): QoderQueueFacts | undefined {
  return parseQueueFacts(body ?? '')
}

/**
 * Replace status digits that read as authorization failure with a neutral
 * word, for messages the upstream used to announce a queue.
 *
 * `dsh-llm-pi-ai`'s error classifier is a text matcher whose first test is
 * `/\b(?:401|403)\b/` — ahead of its 429/rate-limit test — so any message
 * carrying those digits classifies AUTH no matter the structured code
 * travelling beside it. A queue answer quoting the upstream's 403 (in the
 * message prefix, the envelope status, or the body's `"code":"403"`) must not
 * reach that matcher as-is, or the user sees "API 密钥无效" for a throttle
 * (observed verbatim on 2026-09-26 23:30 and again at 23:40).
 */
function deauthorizeDigits(message: string): string {
  return message.replace(/\b(?:401|403)\b/gu, 'throttled')
}

export function qoderHttpError(
  message: string,
  response: { status: number; headers?: Pick<Headers, 'get'> },
  body?: string,
): QoderLlmError {
  const { status } = response
  const headerRetryAfterMs = retryAfterMs(response.headers?.get('retry-after') ?? null)
  const requestId = qoderRequestId(response.headers)
  // A 401/403 the upstream used to announce a queue is a throttle, not an
  // authorization failure. The body is passed in by the caller when it was
  // read; when it was not, the message often embeds it (the SSE envelope
  // path formats the body into the message), so fall back to the message.
  const queue = status === 401 || status === 403 || status === 429
    ? qoderQueueSignal(body ?? message)
    : undefined
  if (queue !== undefined) {
    // A "0 seconds" advice means "retry now", which is no window to wait on.
    // The host's `LlmError` rejects a non-positive `providerRetryAfterMs` by
    // throwing from its own constructor, and that throw arrives at the caller
    // as a transport failure — replacing the queue classification (and the
    // notice built from it) with a wrong reason and a spent retry. Only a real,
    // positive window is forwarded; a header value may still supply one.
    const advisedMs = queue.retryAfterMs !== undefined && queue.retryAfterMs > 0 ? queue.retryAfterMs : undefined
    const retryAfterMs = advisedMs ?? headerRetryAfterMs
    // The message must not carry the upstream's 401/403 digits. The harness's
    // pi-ai error classifier matches those numbers in message TEXT ahead of
    // every other signal (`/\b(?:401|403)\b/` before `/\b429\b|rate.?limit/`),
    // so an answer that is really a queue read as a dead credential two layers
    // up — "API 密钥无效" in the UI — even with code RATE_LIMIT intact. The
    // facts survive: status stays 403 in `failure.status`, the body still
    // names 10605 / isQueued / retryAfterSeconds, and the retry hint rides
    // on providerRetryAfterMs.
    const rejection = new QoderLlmError(deauthorizeDigits(message), 'RATE_LIMIT', {
      status,
      ...retryAfterMs === undefined ? {} : { providerRetryAfterMs: retryAfterMs },
      ...requestId === undefined ? {} : { requestId },
    })
    // `qoderQueueSignal` above only answered "is this a queue"; the facts the
    // notice needs come from the richer parser reading the same body. It is
    // given the same input so the two can never describe different answers.
    const facts = qoderQueueFacts(body ?? message)
    if (facts !== undefined) rejection.qoderQueue = facts
    return rejection
  }
  const code = status === 401 || status === 403
    ? 'AUTH'
    : status === 408
      ? 'TIMEOUT'
      : status === 429
        ? 'RATE_LIMIT'
        : status >= 500 && status <= 599
          ? 'SERVER'
          : status >= 400 && status <= 499
            ? 'INVALID_REQUEST'
            : 'PROVIDER_ERROR'
  return new QoderLlmError(message, code, {
    status,
    ...headerRetryAfterMs === undefined ? {} : { providerRetryAfterMs: headerRetryAfterMs },
    ...requestId === undefined ? {} : { requestId },
  })
}

export function qoderRequestId(headers?: Pick<Headers, 'get'>): ReturnType<typeof ProviderRequestId> | undefined {
  const value = headers?.get('x-request-id')
    ?? headers?.get('request-id')
    ?? headers?.get('x-amzn-requestid')
  const normalized = value?.trim()
  return normalized ? ProviderRequestId(normalized) : undefined
}

/**
 * Whether this failure is an upstream authorization rejection worth one
 * re-auth retry.
 *
 * The job token the transport signs requests with is cached in memory; an
 * upstream that invalidates it mid-lifetime (gateway rotation or a fault
 * window) answers HTTP 401/403 before any payload is produced. That state is
 * distinguishable from a genuinely revoked PAT only by trying a fresh
 * exchange, so callers clear their credential cache and retry once before
 * reporting `AUTH` to the user.
 *
 * A `RATE_LIMIT` code is never a re-auth candidate, **even when its status is
 * 401/403**: that is the upstream's queue answer (code 10605 / isQueued /
 * retryAfterSeconds in the body), which keeps the status but says the
 * credential was not the problem. Healing it exchanged job tokens against a
 * queue no token can jump (observed 2026-09-26) and, by consuming the retry,
 * suppressed the rate-limit retry that would have ridden out the window.
 */
export function isQoderAuthRejection(error: unknown): error is LlmError {
  if (!(error instanceof LlmError)) return false
  if (error.code === 'RATE_LIMIT') return false
  return error.code === 'AUTH' || error.failure.status === 401 || error.failure.status === 403
}

export function retryAfterMs(value: string | null, nowMs = Date.now()): number | undefined {
  const normalized = value?.trim()
  if (!normalized) return undefined
  if (/^\d+$/u.test(normalized)) {
    const delayMs = Number(normalized) * 1000
    return Number.isFinite(delayMs) && delayMs > 0 ? delayMs : undefined
  }
  const retryAt = Date.parse(normalized)
  if (Number.isNaN(retryAt)) return undefined
  const delayMs = retryAt - nowMs
  return delayMs > 0 ? delayMs : undefined
}
