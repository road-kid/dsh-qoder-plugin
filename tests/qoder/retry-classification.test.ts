/**
 * The retry contract between this transport and the harness's error classifier.
 *
 * The harness never sees this plugin's structured error code: `dsh-llm-pi-ai`
 * derives the code by matching TEXT in the failure message, and `dsh-llm-retry`
 * retries only the codes in the provider's `retryableCodes` set. A message the
 * matcher cannot classify falls back to `PI_AI_ERROR`, which is outside that
 * set — so a dropped response would end the turn instead of being retried.
 *
 * These tests therefore assert the CONTRACT that was violated, against the REAL
 * code paths (the SSE decoder and the chat stream), not against a copy of the
 * message strings: a future rewording that drops the classifier token fails
 * here even if nobody remembers this file exists. The classifier itself is a
 * verbatim copy of the host build, because the plugin cannot import host
 * internals.
 *
 * @module dsh-qoder-plugin/tests/qoder/retry-classification
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { createUserMessage, type GenerateOptions } from '@deepseek-ai/dsh-llm'
import { streamQoderChat, type QoderChatDependencies } from '../../src/qoder/transport/chat.ts'
import { parseQoderSse } from '../../src/qoder/transport/wire/sse.ts'
import { validateQoderRequest } from '../../src/qoder/transport/wire/serialize.ts'
import type { CosyCredentials } from '../../src/qoder/transport/wire/cosy.ts'

/* ------------------------------------------------------------------------- *
 * Host contract, copied verbatim from the desktop build (2026-11-01):
 * `dsh-llm-pi-ai`'s `classifyPiAiError` + `isQuotaExceededError`, and
 * `dsh-llm`'s `DEFAULT_RETRYABLE_CODES`.
 * ------------------------------------------------------------------------- */

function isQuotaExceededError(detail: string): boolean {
  return /\binsufficient[\s_-]+(?:quota|balance|credits?)\b/i.test(detail)
    || /\b(?:quota|usage[\s_-]+limit)[\s_-]+(?:exceeded|exhausted|reached)\b/i.test(detail)
    || /\bexceed(?:ed|s)?[\s_-]+(?:(?:your|the)[\s_-]+)?(?:current[\s_-]+)?quota\b/i.test(detail)
    || /\b(?:balance|credits?)[\s_-]+(?:exhausted|depleted)\b/i.test(detail)
    || /\bout[\s_-]+of[\s_-]+(?:credits?|budget)\b/i.test(detail)
}

function classifyPiAiError(message: string): string {
  if (/\b(?:401|403)\b/.test(message)) return 'AUTH'
  if (isQuotaExceededError(message)) return 'QUOTA'
  if (/\b429\b|rate.?limit/i.test(message)) return 'RATE_LIMIT'
  if (/\b413\b|failed to buffer the request body:\s*length limit exceeded|payload too large|request body too large/i.test(message)) return 'INVALID_REQUEST'
  if (/\b400\b|invalid.?request/i.test(message)) return 'INVALID_REQUEST'
  if (/\b5\d\d\b/.test(message)) return 'SERVER'
  if (/\btime(?:d)?\s*out\b|timeout/i.test(message)) return 'TIMEOUT'
  if (/stream ended (?:before|without)\b/i.test(message)) return 'TRANSPORT'
  if (/\b(?:network|connection|socket|fetch)\b|\bECONN[A-Z]+\b/i.test(message)
    || /\b(?:other side closed|HTTP2 request did not get a response|WebSocket closed unexpectedly)\b/i.test(message)
    || /\bterminated\b|premature close/i.test(message)) return 'TRANSPORT'
  return 'PI_AI_ERROR'
}

const DEFAULT_RETRYABLE_CODES: ReadonlySet<string> = new Set([
  'EMPTY_RESPONSE',
  'RATE_LIMIT',
  'SERVER',
  'TIMEOUT',
  'TRANSPORT',
])

/** Whether the harness would retry a failure carrying this message. */
function wouldRetry(message: string): boolean {
  return DEFAULT_RETRYABLE_CODES.has(classifyPiAiError(message))
}

/* ------------------------------------------------------------------------- *
 * Fixtures
 * ------------------------------------------------------------------------- */

const options: GenerateOptions = {
  provider: 'qoder-official',
  model: 'cmodel',
  messages: [createUserMessage({ content: [{ type: 'text', text: 'Hello' }], source: { kind: 'user' } })],
}

const credentials: CosyCredentials = {
  userID: 'user-retry-classification',
  authToken: 'jrt-job-token-secret',
  name: 'Subscriber',
  email: 'subscriber@example.test',
  machineID: 'machine-real',
  derivedMachineID: 'machine-derived',
  machineHostname: 'DESKTOP-ABC1234',
}

function streamOf(text: string): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()
  return new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(text))
      controller.close()
    },
  })
}

/** One `data:` envelope the way Qoder wraps an inner model chunk. */
function frame(body: unknown): string {
  return `data: ${JSON.stringify({ statusCodeValue: 200, body: JSON.stringify(body) })}\n\n`
}

/**
 * A response that begins a valid stream and then dies: the same shape as a
 * mid-stream connection drop (the headers arrived, content started, then the
 * socket went away).
 */
function droppedResponse(): Response {
  const encoder = new TextEncoder()
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(frame({ choices: [{ delta: { content: 'partial answer' } }] })))
      controller.error(new TypeError('socket hang up'))
    },
  })
  return new Response(body, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  })
}

/* ------------------------------------------------------------------------- *
 * Tests
 * ------------------------------------------------------------------------- */

test('a mid-stream connection drop is classified retryable by the host classifier', async () => {
  const messages = await validateQoderRequest(options)
  const dependencies: QoderChatDependencies = {
    fetch: (async () => droppedResponse()) as typeof fetch,
    region: 'global',
    responseHeaderTimeoutMs: 5_000,
    streamIdleTimeoutMs: 5_000,
  }

  await assert.rejects(
    async () => {
      for await (const _chunk of streamQoderChat(options, undefined, credentials, messages, dependencies)) {
        // Drain: the failure is raised after the first chunk, which is the case
        // the status could no longer carry.
      }
    },
    (error: unknown) => {
      assert.ok(error instanceof Error)
      assert.equal(
        classifyPiAiError(error.message),
        'TRANSPORT',
        `the harness would not retry this failure: ${JSON.stringify(error.message)}`,
      )
      assert.equal(wouldRetry(error.message), true)
      return true
    },
  )
})

test('a truncated event stream is classified retryable by the host classifier', async () => {
  // Content arrived, but the source ended before `[DONE]`: a dropped
  // connection, not a bad request.
  const truncated = frame({ choices: [{ delta: { content: 'partial answer' } }] })

  await assert.rejects(
    async () => {
      for await (const _chunk of parseQoderSse(streamOf(truncated))) {
        // Drain.
      }
    },
    (error: unknown) => {
      assert.ok(error instanceof Error)
      assert.equal(
        classifyPiAiError(error.message),
        'TRANSPORT',
        `the harness would not retry this failure: ${JSON.stringify(error.message)}`,
      )
      return true
    },
  )
})

test('the phrases this transport used to emit would NOT have been retried', () => {
  // Negative control: it fixes what the two tests above are guarding. If either
  // of these ever starts classifying retryably, the copy of the classifier in
  // this file no longer matches the host and must be re-extracted.
  assert.equal(classifyPiAiError('Qoder transport request failed.'), 'PI_AI_ERROR')
  assert.equal(classifyPiAiError('SSE stream ended prematurely without [DONE].'), 'PI_AI_ERROR')
  assert.equal(wouldRetry('Qoder transport request failed.'), false)
  assert.equal(wouldRetry('SSE stream ended prematurely without [DONE].'), false)
})
