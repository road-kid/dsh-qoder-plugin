import test from 'node:test'
import assert from 'node:assert/strict'
import {
  classifyQoderInnerError,
  detectQoderInnerError,
  qoderInnerErrorSnapshot,
  resetQoderInnerErrors,
} from '../../src/qoder/transport/wire/inner-errors.ts'
import { parseQoderSse } from '../../src/qoder/transport/wire/sse.ts'

function streamOf(lines: readonly string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()
  return new ReadableStream({
    start(controller) {
      for (const line of lines) controller.enqueue(encoder.encode(`${line}\n`))
      controller.close()
    },
  })
}

function data(body: unknown): string {
  return `data: ${JSON.stringify({ statusCodeValue: 200, body: JSON.stringify(body) })}`
}

const done = `data: ${JSON.stringify({ statusCodeValue: 200, body: '[DONE]' })}`

test('classifyQoderInnerError separates policy, throttle, auth, and invalid requests', () => {
  assert.equal(classifyQoderInnerError({ code: 10605, message: 'busy' }), 'rate_limit')
  assert.equal(classifyQoderInnerError({ code: 429, message: '' }), 'rate_limit')
  assert.equal(classifyQoderInnerError({ message: 'too many requests, slow down' }), 'rate_limit')
  assert.equal(classifyQoderInnerError({ code: 401, message: '' }), 'auth')
  assert.equal(classifyQoderInnerError({ code: 403, message: 'no access' }), 'auth')
  assert.equal(classifyQoderInnerError({ message: 'invalid api key' }), 'auth')
  assert.equal(classifyQoderInnerError({ message: 'This request violates the content policy.' }), 'content_policy')
  assert.equal(classifyQoderInnerError({ type: 'content_filter', message: '' }), 'content_policy')
  assert.equal(classifyQoderInnerError({ code: 400, message: '' }), 'invalid_request')
  assert.equal(classifyQoderInnerError({ message: 'unsupported model qfmodel' }), 'invalid_request')
  assert.equal(classifyQoderInnerError({ message: 'something unusual happened' }), 'other')
})

test('detectQoderInnerError ignores ordinary content frames', () => {
  assert.equal(detectQoderInnerError({ id: 'x', choices: [{ delta: { content: 'hi' } }] }), undefined)
  assert.equal(detectQoderInnerError({ usage: { prompt_tokens: 1 } }), undefined)
})

test('detectQoderInnerError reads object errors and bounds/redacts their text', () => {
  const report = detectQoderInnerError({
    error: { code: 429, message: `slow down Bearer abc.def and pt-abcdef123456 ${'x'.repeat(400)}` },
  })
  assert.equal(report?.classification, 'rate_limit')
  assert.equal(report?.code, 429)
  assert.ok(report !== undefined)
  assert.ok(!report.message.includes('abcdef123456'))
  assert.ok(!report.message.includes('Bearer abc.def'))
  assert.ok(report.message.length <= 301)
})

test('parseQoderSse counts inner errors once per class per stream and keeps streaming', async () => {
  resetQoderInnerErrors()
  const reports: string[] = []
  const chunks: unknown[] = []
  for await (const chunk of parseQoderSse(streamOf([
    data({ error: { code: 10605, message: 'model is queued, retry later' } }),
    data({ error: { code: 10605, message: 'model is queued, retry later' } }),
    data({ choices: [{ delta: { content: 'later answer' }, finish_reason: 'stop' }] }),
    done,
  ]), { onInnerError: report => reports.push(report.classification) })) {
    chunks.push(chunk)
  }
  // Counting is per occurrence; the WARN callback is per class per stream.
  assert.deepEqual(qoderInnerErrorSnapshot().rate_limit, 2)
  assert.deepEqual(reports, ['rate_limit'])
  // The stream still completes normally: observation must not turn into retry.
  assert.ok(chunks.some(chunk => (chunk as { type: string }).type === 'finish'))
})

test('parseQoderSse reports each distinct class once in one stream', async () => {
  resetQoderInnerErrors()
  const reports: string[] = []
  for await (const _chunk of parseQoderSse(streamOf([
    data({ error: 'the request violates the content policy' }),
    data({ errorCode: 401, message: 'token expired' }),
    data({ choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] }),
    done,
  ]), { onInnerError: report => reports.push(report.classification) })) {
    // Drain.
  }
  assert.deepEqual(reports, ['content_policy', 'auth'])
  const snapshot = qoderInnerErrorSnapshot()
  assert.equal(snapshot.content_policy, 1)
  assert.equal(snapshot.auth, 1)
})

test('clean streams leave the ledger untouched', async () => {
  resetQoderInnerErrors()
  const reports: string[] = []
  for await (const _chunk of parseQoderSse(streamOf([
    data({ choices: [{ delta: { content: 'hello' }, finish_reason: 'stop' }] }),
    done,
  ]), { onInnerError: report => reports.push(report.classification) })) {
    // Drain.
  }
  assert.deepEqual(reports, [])
  assert.deepEqual(qoderInnerErrorSnapshot(), {
    content_policy: 0,
    rate_limit: 0,
    invalid_request: 0,
    auth: 0,
    other: 0,
  })
})

test('classifies the reference proxy vocabulary, not just its own spellings', () => {
  // These are the samples the reference implementation calls out by name; a
  // misclassification here would make the ledger disagree with the proxy's.
  const cases: [Parameters<typeof classifyQoderInnerError>[0], string][] = [
    [{ message: "Messages with role 'tool' must be a response to a preceding message with 'tool_calls'" }, 'invalid_request'],
    [{ type: 'provider_error', message: 'upstream blew up' }, 'invalid_request'],
    [{ message: 'DataInspectionFailed' }, 'content_policy'],
    [{ message: 'SensitiveContent detected' }, 'content_policy'],
    [{ message: 'Forbidden' }, 'auth'],
    [{ message: 'Access expired' }, 'auth'],
    [{ message: 'invalid_parameter: model' }, 'invalid_request'],
  ]
  for (const [fields, expected] of cases) {
    assert.equal(classifyQoderInnerError(fields), expected, JSON.stringify(fields))
  }
})

test('falsy error sentinels and completion frames are not inner errors', () => {
  assert.equal(detectQoderInnerError({ error: false, choices: [{ delta: { content: 'hi' } }] }), undefined)
  assert.equal(detectQoderInnerError({ error: {}, choices: [{ delta: { content: 'hi' } }] }), undefined)
  assert.equal(detectQoderInnerError({ code: 0 }), undefined)
  assert.equal(detectQoderInnerError({ choices: [{ delta: { content: 'hi' } }], message: 'hello' }), undefined)
  assert.equal(detectQoderInnerError({ choices: [{ delta: { content: 'hi' } }], code: 10605 }), undefined)
})

test('redacts every token shape the logger hides', () => {
  const report = detectQoderInnerError({
    error: { message: 'bad jrt-abc.def_123 / jt-zzz / PT-UP / Bearer tok.en' },
  })
  assert.ok(report !== undefined)
  for (const secret of ['jrt-abc.def_123', 'jt-zzz', 'PT-UP', 'tok.en']) {
    assert.ok(!report.message.includes(secret), secret)
  }
})

test('a throwing observer cannot turn a clean stream into a retry', async () => {
  resetQoderInnerErrors()
  const chunks: unknown[] = []
  for await (const chunk of parseQoderSse(streamOf([
    data({ error: { code: 10605, message: 'queued' } }),
    data({ choices: [{ delta: { content: 'still here' }, finish_reason: 'stop' }] }),
    done,
  ]), { onInnerError: () => { throw new Error('logger exploded') } })) {
    chunks.push(chunk)
  }
  assert.equal(qoderInnerErrorSnapshot().rate_limit, 1)
  assert.ok(chunks.some(chunk => (chunk as { type: string }).type === 'finish'))
})

test('a repeated class in a new stream warns again while the counter accumulates', async () => {
  resetQoderInnerErrors()
  const reports: string[] = []
  for (const _ of [1, 2]) {
    for await (const _chunk of parseQoderSse(streamOf([
      data({ error: { code: 429, message: 'slow down' } }),
      data({ choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] }),
      done,
    ]), { onInnerError: report => reports.push(report.classification) })) {
      // Drain.
    }
  }
  assert.deepEqual(reports, ['rate_limit', 'rate_limit'])
  assert.equal(qoderInnerErrorSnapshot().rate_limit, 2)
})
