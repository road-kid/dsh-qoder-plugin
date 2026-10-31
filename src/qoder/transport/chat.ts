/** Qoder chat request encoding, timeout lifecycle, and SSE streaming. */

import {
  attributionHeaders,
  type GenerateOptions,
  type StreamChunk,
  type TokenUsage,
} from '@deepseek-ai/dsh-llm'
import type { QoderCatalogModel } from '../catalog.ts'
import { QoderLlmError, qoderHttpError, qoderRequestId } from '../errors.ts'
import type { QoderRegion } from '../region.ts'
import { getQoderChatUrl } from './endpoints.ts'
import { redactLogValue, type QoderLogger } from './logging.ts'
import { defaultMaxErrorBytes, readLimitedText } from './request.ts'
import { buildAuthHeaders, type CosyCredentials } from './wire/cosy.ts'
import { qoderEncodeBody } from './wire/encoding.ts'
import { buildQoderRequestBody } from './wire/serialize.ts'
import { parseQoderSse } from './wire/sse.ts'
import type { QoderWireMessage } from './wire/wire-types.ts'

export interface QoderChatDependencies {
  fetch: typeof fetch
  logger?: QoderLogger | undefined
  region: QoderRegion
  responseHeaderTimeoutMs: number
  streamIdleTimeoutMs: number
}

function aborted(message: string): QoderLlmError {
  return new QoderLlmError(message, 'ABORTED')
}

/** Longest cause text carried into a user-facing failure message. */
const maxCauseChars = 300

/** How many links of a `cause` chain are rendered. */
const maxCauseDepth = 4

/**
 * Render a thrown value's cause chain into one bounded, redacted line.
 *
 * The rendering exists for the harness's error classifier, not for the log:
 * `dsh-llm-pi-ai`'s `classifyPiAiError` is a text matcher over the failure
 * MESSAGE alone, and it recognizes a transport failure by words like `fetch`,
 * `network`, `connection`, `terminated` or `ECONN*`. The undici `TypeError`
 * that actually explains a mid-stream break lives on `error.cause`, so a
 * message that names nothing ("Qoder transport request failed.") reached that
 * matcher with no evidence at all and fell through to its `PI_AI_ERROR`
 * fallback — a code outside every provider's default `retryableCodes` set.
 * The turn then ended after the first drop instead of retrying, which is
 * exactly the failure this helper prevents.
 *
 * The cause is redacted through the transport's own log policy first: a cause
 * chain descends into `fetch` internals, and this text reaches the session log
 * and the UI, where a credential must never appear.
 */
function describeCause(value: unknown): string {
  const parts: string[] = []
  let current: unknown = value
  for (let depth = 0; depth < maxCauseDepth; depth += 1) {
    if (current === undefined || current === null) break
    const raw = current instanceof Error ? current.message : String(current)
    const redacted = redactLogValue(raw)
    const text = typeof redacted === 'string' ? redacted : ''
    if (text !== '' && !parts.includes(text)) parts.push(text)
    current = current instanceof Error ? current.cause : undefined
  }
  const joined = parts.join(': ')
  return joined.length > maxCauseChars ? `${joined.slice(0, maxCauseChars)}…` : joined
}

export async function* streamQoderChat(
  options: GenerateOptions,
  model: QoderCatalogModel | undefined,
  credentials: CosyCredentials,
  messages: QoderWireMessage[],
  dependencies: QoderChatDependencies,
): AsyncGenerator<StreamChunk> {
  const request = await buildQoderRequestBody(options, credentials.userID, messages, model)
  const encodedBody = qoderEncodeBody(JSON.stringify(request))
  const encodedBytes = Buffer.from(encodedBody, 'utf8')
  const chatUrl = getQoderChatUrl(dependencies.region)
  const requestController = new AbortController()
  let headerTimedOut = false
  let idleTimedOut = false
  let idleTimer: ReturnType<typeof setTimeout> | undefined
  let chunkCount = 0
  let reqId: ReturnType<typeof qoderRequestId> | undefined
  const startedAt = performance.now()
  let lastActivityAt = startedAt
  const onCallerAbort = (): void => requestController.abort(options.signal?.reason)
  options.signal?.addEventListener('abort', onCallerAbort, { once: true })
  const headerTimer = setTimeout(() => {
    headerTimedOut = true
    requestController.abort('response header timeout')
  }, dependencies.responseHeaderTimeoutMs)
  const resetIdleTimer = (): void => {
    lastActivityAt = performance.now()
    if (idleTimer !== undefined) clearTimeout(idleTimer)
    idleTimer = setTimeout(() => {
      idleTimedOut = true
      requestController.abort('stream idle timeout')
    }, dependencies.streamIdleTimeoutMs)
  }

  try {
    const response = await dependencies.fetch(chatUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'accept': 'text/event-stream',
        'cache-control': 'no-cache',
        'accept-encoding': 'identity',
        'x-model-key': options.model || 'cmodel',
        'x-model-source': model?.source || 'system',
        ...attributionHeaders(),
        // The inference stream is the one request the official desktop client
        // tags with `Cosy-Machinehostname`; every other COSY request must not.
        ...buildAuthHeaders(encodedBytes, chatUrl, credentials, { includeMachineHostname: true }),
      },
      body: encodedBytes,
      signal: requestController.signal,
    })
    clearTimeout(headerTimer)
    reqId = qoderRequestId(response.headers)
    dependencies.logger?.debug?.('[Qoder Stream] Response headers received', {
      region: dependencies.region,
      status: response.status,
      durationMs: Math.round(performance.now() - startedAt),
      ...reqId === undefined ? {} : { requestId: reqId },
    })
    resetIdleTimer()
    if (!response.ok) {
      // Read the (bounded) error body before failing: a 401/403 the upstream
      // used to announce its queue carries code 10605 / isQueued /
      // retryAfterSeconds, and only the body separates a throttle from a real
      // authorization rejection. Without it every such answer looked like a
      // dead credential and triggered a job-token exchange that cannot jump
      // a queue.
      let errorBody: string | undefined
      try {
        errorBody = await readLimitedText(response, defaultMaxErrorBytes, 'Qoder chat error response')
      } catch {
        // A body that cannot be read (or that exceeds the cap) still fails the
        // request; it just classifies from status and headers alone.
        errorBody = undefined
      }
      throw qoderHttpError(`Qoder upstream service returned HTTP ${response.status}.`, response, errorBody)
    }
    if (!response.body) {
      // Same classifier constraint as the catch-all below: a bare noun phrase
      // matches nothing in `classifyPiAiError` and would end the turn as
      // `PI_AI_ERROR`. "connection" is the word that classifier maps to
      // TRANSPORT, and it is accurate — a 200 with no body is a broken
      // connection, not a bad request.
      throw new QoderLlmError('Qoder connection returned no readable body stream.', 'EMPTY_RESPONSE')
    }

    let firstChunkDurationMs: number | undefined
    let tokenUsage: TokenUsage | undefined
    let finishReason: string | undefined
    const streamStartedAt = performance.now()

    for await (const chunk of parseQoderSse(response.body, {
      onActivity: resetIdleTimer,
      // A 200 stream can still carry the upstream's real complaint as an inner
      // chunk. The decoder counts them; logging only the first per class keeps
      // one broken answer from repeating the same line hundreds of times.
      onInnerError: report => {
        dependencies.logger?.warn?.('[Qoder Stream] Inner error in stream', redactLogValue({
          ...report,
          ...reqId === undefined ? {} : { requestId: reqId },
        }))
      },
    })) {
      chunkCount++
      if (firstChunkDurationMs === undefined) {
        firstChunkDurationMs = Math.round(performance.now() - startedAt)
        dependencies.logger?.debug?.('[Qoder Stream] First chunk received', {
          durationMs: firstChunkDurationMs,
          ...reqId === undefined ? {} : { requestId: reqId },
        })
      }
      if (chunk.type === 'usage') {
        tokenUsage = chunk.usage
      }
      if (chunk.type === 'finish') {
        finishReason = chunk.reason.kind
      }
      yield chunk
    }

    dependencies.logger?.debug?.('[Qoder Stream] Stream completed', {
      durationMs: Math.round(performance.now() - startedAt),
      streamDurationMs: Math.round(performance.now() - streamStartedAt),
      chunkCount,
      ...finishReason === undefined ? {} : { finishReason },
      ...tokenUsage === undefined ? {} : { usage: tokenUsage },
      ...reqId === undefined ? {} : { requestId: reqId },
    })
  } catch (error: unknown) {
    if (options.signal?.aborted) throw aborted('Request was aborted.')
    const elapsedMs = Math.round(performance.now() - startedAt)
    if (headerTimedOut) {
      const failure = new QoderLlmError('Qoder model request exceeded its response header timeout.', 'TIMEOUT')
      dependencies.logger?.error?.('[Qoder Stream] Request failed', redactLogValue(failure), {
        phase: 'header',
        elapsedMs,
        timeoutMs: dependencies.responseHeaderTimeoutMs,
      })
      throw failure
    }
    if (idleTimedOut) {
      const failure = new QoderLlmError('Qoder model stream exceeded its idle timeout.', 'TIMEOUT')
      dependencies.logger?.error?.('[Qoder Stream] Request failed', redactLogValue(failure), {
        phase: 'stream-idle',
        chunkCount,
        idleDurationMs: Math.round(performance.now() - lastActivityAt),
        elapsedMs,
        ...reqId === undefined ? {} : { requestId: reqId },
      })
      throw failure
    }
    if (error instanceof QoderLlmError) {
      dependencies.logger?.error?.('[Qoder Stream] Request failed', redactLogValue(error), {
        chunkCount,
        elapsedMs,
        ...reqId === undefined ? {} : { requestId: reqId },
      })
      throw error
    }
    // `dsh-llm-pi-ai` classifies an adapter failure by matching TEXT in the
    // failure MESSAGE, and `dsh-llm-retry` retries only the codes in the
    // provider's `retryableCodes` set. The bare "Qoder transport request
    // failed." this used to say matched no classifier token and fell through to
    // `PI_AI_ERROR`, which is outside that set — so a mid-stream break (the
    // observed 30-40s case: headers arrived, then the upstream socket died)
    // ended the turn on the first drop with no retry.
    //
    // The LEAD phrase now carries "connection", a token the classifier maps to
    // TRANSPORT, so retryability does not depend on what the cause chain
    // happens to say. Enumerating socket spellings instead is a losing game:
    // `write EPIPE` matches none of the classifier's transport tokens. The
    // cause still rides along for diagnosis.
    const cause = describeCause(error)
    const failure = new QoderLlmError(
      cause === ''
        ? 'Qoder connection failed with no reported cause.'
        : `Qoder connection failed: ${cause}`,
      'TRANSPORT',
      { cause: error },
    )
    dependencies.logger?.error?.('[Qoder Stream] Request failed', redactLogValue(failure), {
      chunkCount,
      elapsedMs,
      ...reqId === undefined ? {} : { requestId: reqId },
      cause: redactLogValue(error),
    })
    throw failure
  } finally {
    clearTimeout(headerTimer)
    if (idleTimer !== undefined) clearTimeout(idleTimer)
    options.signal?.removeEventListener('abort', onCallerAbort)
    requestController.abort('request complete')
  }
}
