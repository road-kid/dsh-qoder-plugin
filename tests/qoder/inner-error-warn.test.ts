import test from 'node:test'
import assert from 'node:assert/strict'
import { createUserMessage, type GenerateOptions } from '@deepseek-ai/dsh-llm'
import { streamQoderChat, type QoderChatDependencies } from '../../src/qoder/transport/chat.ts'
import { validateQoderRequest } from '../../src/qoder/transport/wire/serialize.ts'
import type { CosyCredentials } from '../../src/qoder/transport/wire/cosy.ts'
import {
  qoderInnerErrorSnapshot,
  resetQoderInnerErrors,
} from '../../src/qoder/transport/wire/inner-errors.ts'

/**
 * Wiring tests for the inner-error WARN emitted by the CHAT stream path.
 *
 * `wire/sse.ts` owns the detection and the once-per-class-per-stream rule, and
 * `tests/qoder/inner-errors.test.ts` covers the decoder in isolation. What is
 * NOT covered there is the step this file pins: chat.ts's `onInnerError`
 * callback — the only production consumer — must reach the injected logger
 * exactly once per class per stream, with an already-redacted summary and the
 * request id, while every occurrence still reaches the ledger. A regression in
 * that wiring would leave the observability feature dead without failing any
 * decoder test.
 *
 * The whole streaming entry point is used (not just a hand-shaped callback) so
 * the assertion is about the real composition: request headers -> SSE parse ->
 * counter -> logger.
 */

interface WarnEntry {
  message: string
  details: unknown
}

const innerErrorWarnMessage = '[Qoder Stream] Inner error in stream'

function captureLogger(entries: WarnEntry[]): NonNullable<QoderChatDependencies['logger']> {
  return {
    debug: () => {},
    warn: (message: string, ...details: unknown[]) => {
      entries.push({ message, details: details[0] })
    },
    error: () => {},
  }
}

/** One `data:` envelope the way Qoder wraps an inner model chunk. */
function frame(body: unknown): string {
  return `data: ${JSON.stringify({ statusCodeValue: 200, body: JSON.stringify(body) })}\n\n`
}

const done = 'data: [DONE]\n\n'

function sseResponse(frames: readonly string[], requestId?: string): Response {
  return new Response(frames.join(''), {
    status: 200,
    headers: {
      'content-type': 'text/event-stream',
      ...requestId === undefined ? {} : { 'x-request-id': requestId },
    },
  })
}

const options: GenerateOptions = {
  provider: 'qoder-official',
  model: 'cmodel',
  messages: [createUserMessage({ content: [{ type: 'text', text: 'Hello' }], source: { kind: 'user' } })],
}

const credentials: CosyCredentials = {
  userID: 'user-inner-warn',
  authToken: 'jrt-job-token-secret',
  name: 'Subscriber',
  email: 'subscriber@example.test',
  machineID: 'machine-real',
  derivedMachineID: 'machine-derived',
  machineHostname: 'DESKTOP-ABC1234',
}

async function generate(
  response: () => Response,
  logger: NonNullable<QoderChatDependencies['logger']>,
): Promise<{ chunks: ReadonlyArray<{ type: string; text?: string }> }> {
  const messages = await validateQoderRequest(options)
  const dependencies: QoderChatDependencies = {
    fetch: (async () => response()) as typeof fetch,
    logger,
    region: 'global',
    responseHeaderTimeoutMs: 5_000,
    streamIdleTimeoutMs: 5_000,
  }
  const chunks: Array<{ type: string; text?: string }> = []
  for await (const chunk of streamQoderChat(options, undefined, credentials, messages, dependencies)) {
    chunks.push(chunk as unknown as { type: string; text?: string })
  }
  return { chunks }
}

function warnings(entries: readonly WarnEntry[]): WarnEntry[] {
  return entries.filter(entry => entry.message === innerErrorWarnMessage)
}

test('chat warns once per class per stream, keeps counting, and redacts the summary', async () => {
  resetQoderInnerErrors()
  const entries: WarnEntry[] = []
  // Two occurrences of the same class (so the ledger must show 2 while only one
  // WARN is emitted), one finishing content frame, and a secret in the upstream
  // text to prove the logged summary is redacted.
  const { chunks } = await generate(() => sseResponse([
    frame({ error: { code: 10605, message: 'queue full for jrt-SECRETVALUE and Authorization: Bearer secret.bearer.value' } }),
    frame({ error: { code: '10605', message: 'queue full again' } }),
    frame({ choices: [{ delta: { content: 'partial answer' }, finish_reason: 'stop' }] }),
    done,
  ], 'req-warn-1'), captureLogger(entries))

  const warns = warnings(entries)
  assert.equal(warns.length, 1, 'one WARN per class per stream')
  const details = warns[0]?.details as Record<string, unknown>
  assert.equal(details.classification, 'rate_limit')
  assert.equal(details.code, 10605)
  assert.equal(details.requestId, 'req-warn-1')
  assert.match(String(details.message), /\[REDACTED\]/u)
  const summary = JSON.stringify(details)
  assert.doesNotMatch(summary, /SECRETVALUE|secret\.bearer\.value|jrt-SECRET/u)

  // Every occurrence still reaches the process-wide ledger.
  const snapshot = qoderInnerErrorSnapshot()
  assert.equal(snapshot.rate_limit, 2)
  assert.equal(snapshot.content_policy, 0)
  assert.equal(snapshot.auth, 0)

  // The error chunk is observation only: the stream still finishes and still
  // delivers the content the same request produced.
  assert.equal(chunks.filter(chunk => chunk.type === 'finish').length, 1)
  assert.ok(chunks.some(chunk => chunk.type === 'text-delta' && chunk.text === 'partial answer'))
})

test('chat warns once for each distinct class seen in one stream', async () => {
  resetQoderInnerErrors()
  const entries: WarnEntry[] = []
  await generate(() => sseResponse([
    frame({ error: { type: 'content_filter', message: 'blocked by policy' } }),
    frame({ error: { code: 401, message: 'token expired' } }),
    frame({ choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] }),
    done,
  ], 'req-warn-2'), captureLogger(entries))

  const classifications = warnings(entries).map(entry => (entry.details as Record<string, unknown>).classification)
  assert.deepEqual(classifications, ['content_policy', 'auth'])
  const snapshot = qoderInnerErrorSnapshot()
  assert.equal(snapshot.content_policy, 1)
  assert.equal(snapshot.auth, 1)
})

test('a clean stream logs no inner-error warning and leaves the ledger untouched', async () => {
  resetQoderInnerErrors()
  const entries: WarnEntry[] = []
  const { chunks } = await generate(() => sseResponse([
    frame({ choices: [{ delta: { content: 'hello' } }] }),
    frame({ choices: [{ delta: {}, finish_reason: 'stop' }] }),
    done,
  ]), captureLogger(entries))

  assert.equal(warnings(entries).length, 0)
  const snapshot = qoderInnerErrorSnapshot()
  assert.deepEqual({ ...snapshot }, {
    content_policy: 0,
    rate_limit: 0,
    invalid_request: 0,
    auth: 0,
    other: 0,
  })
  assert.equal(chunks.filter(chunk => chunk.type === 'finish').length, 1)
})

test('a later stream earns its own warning for the same class', async () => {
  resetQoderInnerErrors()
  const entries: WarnEntry[] = []
  const response = (): Response => sseResponse([
    frame({ error: { code: 10605, message: 'queued' } }),
    frame({ choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] }),
    done,
  ])
  await generate(response, captureLogger(entries))
  await generate(response, captureLogger(entries))

  // The de-duplication scope is the stream, not the process: a second request
  // deserves its own WARN even when the class repeats.
  assert.equal(warnings(entries).length, 2)
  assert.equal(qoderInnerErrorSnapshot().rate_limit, 2)
})
