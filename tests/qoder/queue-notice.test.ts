import test from 'node:test'
import assert from 'node:assert/strict'
import { qoderQueueFacts, qoderQueueSignal } from '../../src/qoder/errors.ts'
import { formatQueueNotice, formatQueueWaitNotice, parseQueueFacts } from '../../src/qoder/queue-notice.ts'

/**
 * The body the user pasted, byte for byte: the upstream nests its own JSON
 * inside `message` as a string, and the innermost payload is escaped a second
 * time. `String.raw` keeps the backslashes literal, so this fixture IS the wire
 * shape rather than a reconstructed object that could drift from it.
 */
const PASTED_BODY = String.raw`{"code":"403","message":"{\"code\":\"10605\",\"message\":\"{\\\"isQueued\\\":true,\\\"modelKey\\\":\\\"qfmodel\\\",\\\"queueCount\\\":8887,\\\"queueType\\\":\\\"p3\\\",\\\"retryAfterSeconds\\\":30,\\\"serviceAvailable\\\":false}\",\"subCode\":\"RESOURCE_LIMIT\"}"}`

/** The innermost fact object, in the order the upstream wrote it. */
const QUEUED = {
  isQueued: true,
  modelKey: 'qfmodel',
  queueCount: 8887,
  queueType: 'p3',
  retryAfterSeconds: 30,
  serviceAvailable: false,
}

/** The same nesting, built through `JSON.stringify` so variants stay honest. */
function nestedBody(outerCode: string, innermost: object = QUEUED): string {
  const envelope = JSON.stringify({
    code: '10605',
    message: JSON.stringify(innermost),
    subCode: 'RESOURCE_LIMIT',
  })
  return JSON.stringify({ code: outerCode, message: envelope })
}

test('parseQueueFacts reads the doubly escaped body the user pasted', () => {
  const facts = parseQueueFacts(PASTED_BODY)
  assert.ok(facts !== undefined)
  assert.equal(facts.isQueued, true)
  assert.equal(facts.serviceAvailable, false)
  assert.equal(facts.modelKey, 'qfmodel')
  assert.equal(facts.queueCount, 8887)
  assert.equal(facts.queueType, 'p3')
  assert.equal(facts.retryAfterSeconds, 30)
  assert.equal(facts.subCode, 'RESOURCE_LIMIT')
  // The innermost `message` is the upstream's own words: with two wrappers the
  // middle one holds the JSON facts, and the user can quote exactly that.
  assert.equal(facts.upstreamMessage, JSON.stringify(QUEUED))
  // The wrapper is not the signal; a plain parse of it would have found none of
  // these fields.
  assert.equal(JSON.parse(PASTED_BODY).message === undefined, false)
  assert.equal(parseObjectKeys(PASTED_BODY).includes('isQueued'), false)
})

test('parseQueueFacts is blind to the HTTP status that carried the body', () => {
  // 200 / 401 / 403 all carry this body; the status never reaches the parser
  // because it is not the signal (the 2026-09-26 incident was reading it as one).
  for (const status of ['200', '401', '403']) {
    const facts = parseQueueFacts(nestedBody(status))
    assert.equal(facts?.retryAfterSeconds, 30, `status ${status}`)
    assert.equal(facts?.serviceAvailable, false, `status ${status}`)
    assert.equal(facts?.subCode, 'RESOURCE_LIMIT', `status ${status}`)
    assert.deepEqual(qoderQueueFacts(nestedBody(status)), facts)
    assert.deepEqual(qoderQueueSignal(nestedBody(status)), { retryAfterMs: 30_000 })
  }
})

test('parseQueueFacts reads single-layer nesting and flat bodies too', () => {
  const single = JSON.stringify({ code: '10605', message: JSON.stringify(QUEUED) })
  const facts = parseQueueFacts(single)
  assert.equal(facts?.isQueued, true)
  assert.equal(facts?.retryAfterSeconds, 30)
  assert.equal(facts?.upstreamMessage, JSON.stringify(QUEUED))

  const flat = parseQueueFacts(JSON.stringify(QUEUED))
  assert.equal(flat?.isQueued, true)
  assert.equal(flat?.serviceAvailable, false)
  assert.equal(flat?.modelKey, 'qfmodel')
  // No wrapper carried a message, so the body itself is what the user quotes.
  assert.equal(flat?.upstreamMessage, JSON.stringify(QUEUED))
})

test('parseQueueFacts defaults the flags the upstream did not send', () => {
  // Each of these is a queue marker on its own, and each must read as the
  // plain meaning of what arrived — never as an invented outage.
  const isQueuedOnly = parseQueueFacts('{"isQueued":true}')
  assert.equal(isQueuedOnly?.isQueued, true)
  assert.equal(isQueuedOnly?.serviceAvailable, true)

  const unavailableOnly = parseQueueFacts('{"serviceAvailable":false}')
  assert.equal(unavailableOnly?.isQueued, false)
  assert.equal(unavailableOnly?.serviceAvailable, false)

  const countOnly = parseQueueFacts('{"queueCount":42}')
  assert.equal(countOnly?.queueCount, 42)
  assert.equal(countOnly?.isQueued, false)
  assert.equal(countOnly?.serviceAvailable, true)

  const codeOnly = parseQueueFacts('{"code":"10605","retryAfterSeconds":45}')
  assert.equal(codeOnly?.retryAfterSeconds, 45)
  assert.equal(codeOnly?.isQueued, false)
})

test('parseQueueFacts accepts quoted numbers and booleans', () => {
  const facts = parseQueueFacts('{"isQueued":true,"serviceAvailable":"false","retryAfterSeconds":"45","queueCount":"7"}')
  assert.equal(facts?.isQueued, true)
  assert.equal(facts?.serviceAvailable, false)
  assert.equal(facts?.retryAfterSeconds, 45)
  assert.equal(facts?.queueCount, 7)
})

test('parseQueueFacts keeps waitTime separate from retryAfterSeconds', () => {
  // Observed in the wild: the retry advice (30s) was far shorter than the
  // queue window (86s), so a wait built only on retryAfterSeconds returns to
  // the same queue. The transport needs both numbers to take the larger one.
  const inner = { ...QUEUED, retryAfterSeconds: 30, waitTime: 86 }
  const facts = parseQueueFacts(nestedBody('403', inner))
  assert.ok(facts !== undefined)
  assert.equal(facts.retryAfterSeconds, 30)
  assert.equal(facts.waitTime, 86)
  // The classification/retry hint must NOT silently become the queue window:
  // the host's retry policy is a different consumer with a different contract.
  assert.deepEqual(qoderQueueSignal(nestedBody('403', inner)), { retryAfterMs: 30_000 })

  // Quoted numbers are read like the other numeric facts…
  assert.equal(parseQueueFacts('{"isQueued":true,"waitTime":"86"}')?.waitTime, 86)
  // …and an absent waitTime stays absent rather than being invented.
  assert.equal(parseQueueFacts('{"isQueued":true}')?.waitTime, undefined)
})

test('parseQueueFacts returns undefined when the body is not a queue answer', () => {
  const junk = [
    '',
    '   ',
    'not json at all',
    'null',
    '[]',
    '42',
    '{"message":"invalid job token"}',
    '{"error":"unauthorized"}',
    '{"code":"403","message":"invalid job token"}',
    '{"code":"403","message":"{\\"code\\":\\"403\\",\\"message\\":\\"invalid job token\\"}"}',
    '{"message":"quota exhausted"}',
    '{"retryAfterSeconds":30}',
    '{"isQueued":false}',
    '{"isQueued":false,"serviceAvailable":true}',
    '{"serviceAvailable":true}',
    // A quoted boolean is not one of the markers the classifier tests for, so
    // this parser must not read a queue answer out of it: the two paths would
    // otherwise contradict each other about the same body.
    '{"isQueued":"true"}',
    '{"serviceAvailable":"false"}',
  ]
  for (const body of junk) {
    assert.equal(parseQueueFacts(body), undefined, `junk body: ${body}`)
  }
})

test('parseQueueFacts stays total on malformed and hostile nesting', () => {
  // None of these may throw into an error path that is already reporting a
  // failure, and a self-referential chain must not become unbounded work.
  const hostile = [
    '{',
    '{"message"',
    '{"message":null}',
    '{"message":123}',
    '{"message":{"isQueued":true}}',
    '{"message":"[1,2,3]"}',
    'data: {"isQueued":true,"retryAfterSeconds":30}',
    `{"retryAfterSeconds":30,"message":${JSON.stringify('{"isQueued":true}')}} trailing junk`,
  ]
  for (const body of hostile) {
    assert.doesNotThrow(() => parseQueueFacts(body), `hostile body: ${body}`)
  }
  // A nest deeper than the walk visits still terminates rather than hanging.
  // Eight layers is past the cap and still only a few KB of escapes: building
  // forty would re-escape the body into a JSON.stringify length overflow, which
  // tests the runner, not the parser.
  let deep = '{"isQueued":true}'
  for (let i = 0; i < 8; i += 1) deep = JSON.stringify({ message: deep })
  assert.doesNotThrow(() => parseQueueFacts(deep))
})

test('parseQueueFacts and qoderQueueSignal agree on the queue boundary', () => {
  // The classifier and the explanation must not disagree about whether a body
  // is a queue answer at all; a RATE_LIMIT with no facts is a throttled request
  // the user cannot act on.
  const bodies = [
    PASTED_BODY,
    nestedBody('401'),
    '{"isQueued":true}',
    '{"serviceAvailable":false}',
    '{"queueCount":42}',
    '{"code":"10605"}',
    '{"isQueued":true,"retryAfterSeconds":"45"}',
    '{"isQueued":"true","retryAfterSeconds":"45"}',
    '{"serviceAvailable":"false"}',
    '{"code":"403","message":"invalid job token"}',
    '{"message":"quota exhausted"}',
    '{"error":"unauthorized"}',
    '{"isQueued":false}',
    '{"serviceAvailable":true}',
    'not json at all',
    '',
  ]
  for (const body of bodies) {
    assert.equal(
      parseQueueFacts(body) !== undefined,
      qoderQueueSignal(body) !== undefined,
      `disagreement on: ${body}`,
    )
  }
})

test('parseQueueFacts bounds the quoted upstream message', () => {
  const long = 'x'.repeat(900)
  const facts = parseQueueFacts(JSON.stringify({ code: '10605', isQueued: true, serviceAvailable: false, message: long }))
  assert.equal(facts?.upstreamMessage?.length, 401)
  assert.equal(facts?.upstreamMessage, `${'x'.repeat(400)}…`)

  const collapsed = parseQueueFacts('{"isQueued":true,"message":"line one\\n\\nline   two"}')
  assert.equal(collapsed?.upstreamMessage, 'line one line two')
})

test('formatQueueNotice states the parsed facts and never hardcodes them', () => {
  const facts = parseQueueFacts(nestedBody('403'))
  assert.ok(facts !== undefined)
  const text = formatQueueNotice(facts, { waited: true, occurrences: 1 })
  assert.equal(
    text,
    '上游模型排队中（模型暂不可服务，上游建议 30 秒后重试）：这不是登录态或额度问题，'
      + '已按上游建议等待 30 秒仍不可服务（上游原文：{"isQueued":true,"modelKey":"qfmodel",'
      + '"queueCount":8887,"queueType":"p3","retryAfterSeconds":30,"serviceAvailable":false}）',
  )

  // The numbers come from the facts: a different upstream delay must move both
  // the suggestion and the claim.
  const other = formatQueueNotice({ isQueued: true, serviceAvailable: false, retryAfterSeconds: 45 }, { waited: true, occurrences: 1 })
  assert.match(other, /上游建议 45 秒后重试/u)
  assert.match(other, /已按上游建议等待 45 秒仍不可服务/u)
  assert.doesNotMatch(other, /30 秒/u)
  assert.doesNotMatch(other, /上游原文/u)
})

test('formatQueueNotice claims a wait only when one happened', () => {
  const facts = parseQueueFacts(nestedBody('403'))
  assert.ok(facts !== undefined)

  const waited = formatQueueNotice(facts, { waited: true, occurrences: 1 })
  assert.match(waited, /已按上游建议等待 30 秒仍不可服务/u)

  // The defect this guards: a notice that announced a 30-second wait on a
  // request that returned immediately, so the user waited for nothing.
  const immediate = formatQueueNotice(facts, { waited: false, occurrences: 1 })
  assert.doesNotMatch(immediate, /已按上游建议等待/u)
  assert.match(immediate, /本次未按上游建议等待即返回此结果/u)
  // The SUGGESTION still shows — it is the upstream's advice, not our claim.
  assert.match(immediate, /上游建议 30 秒后重试/u)
})

test('formatQueueNotice reports a completed configured wait in its own words', () => {
  // The upstream advised nothing, so the configured fallback drove the wait and
  // there is no advice seconds to quote: the row must say what was configured
  // and how long it actually held the request (rounded from the measured total).
  const facts = parseQueueFacts('{"isQueued":true,"modelKey":"qfmodel","serviceAvailable":true}')
  assert.ok(facts !== undefined)
  const text = formatQueueNotice(facts, {
    waited: false,
    occurrences: 1,
    waits: { attempts: 1, totalWaitMs: 2_400, lastBasis: { source: 'configured', configuredSeconds: 1 } },
  })
  assert.match(text, /已按配置等待 2 秒，重试后仍不可服务/u)
  assert.doesNotMatch(text, /本次未按上游建议等待即返回此结果/u)
  assert.doesNotMatch(text, /已按上游建议等待/u)
  // No advice was given, so the head must not invent one either.
  assert.match(text, /上游未给出建议重试时间/u)
})

test('formatQueueNotice quotes the real advisory seconds of a completed upstream wait', () => {
  const facts = parseQueueFacts(nestedBody('403'))
  assert.ok(facts !== undefined)
  const text = formatQueueNotice(facts, {
    waited: false,
    occurrences: 1,
    waits: { attempts: 1, totalWaitMs: 31_000, lastBasis: { source: 'upstream', advisedSeconds: 30, configuredSeconds: 5 } },
  })
  assert.match(text, /已按上游建议等待 30 秒仍不可服务/u)
  assert.doesNotMatch(text, /本次未按上游建议等待即返回此结果/u)
})

test('formatQueueNotice treats a reported zero-wait request as never having waited', () => {
  const facts = parseQueueFacts(nestedBody('403'))
  assert.ok(facts !== undefined)
  // `attempts: 0` is the transport saying it never slept — not a wait of 0
  // seconds, which the sentence would otherwise have to claim.
  const text = formatQueueNotice(facts, { waited: false, occurrences: 1, waits: { attempts: 0, totalWaitMs: 0 } })
  assert.match(text, /本次未按上游建议等待即返回此结果/u)
})

test('formatQueueNotice mentions risk control only when the answer recurs', () => {
  const facts = parseQueueFacts(nestedBody('403'))
  assert.ok(facts !== undefined)
  assert.doesNotMatch(formatQueueNotice(facts, { waited: false, occurrences: 1 }), /风控/u)
  const second = formatQueueNotice(facts, { waited: false, occurrences: 2 })
  assert.match(second, /如果频繁返回此结果可能代表当前账号已被风控/u)
  assert.match(formatQueueNotice(facts, { waited: true, occurrences: 3 }), /风控/u)
})

test('formatQueueNotice does not invent a delay the upstream omitted', () => {
  const text = formatQueueNotice({ isQueued: true, serviceAvailable: false }, { waited: true, occurrences: 1 })
  assert.match(text, /上游未给出建议重试时间/u)
  assert.match(text, /已按上游建议等待后仍不可服务/u)
  assert.doesNotMatch(text, /\d/u)
})

test('formatQueueNotice keeps the milder queued state distinct from an outage', () => {
  // The 2026-09-26 body carried serviceAvailable:true: the model was queued but
  // still serving, and the wording must not upgrade that into an outage.
  const text = formatQueueNotice({ isQueued: true, serviceAvailable: true, retryAfterSeconds: 30 }, { waited: false, occurrences: 1 })
  assert.match(text, /上游模型排队中（模型排队中，上游建议 30 秒后重试）/u)
  assert.doesNotMatch(text, /模型暂不可服务/u)
})

test('formatQueueWaitNotice reports the wait that is happening, not the failure', () => {
  const facts = parseQueueFacts(nestedBody('403'))
  assert.ok(facts !== undefined)
  const first = formatQueueWaitNotice(facts, { waitMs: 31_000, attempt: 1, remaining: 1 })
  assert.match(first, /正在等待约 31 秒后重试/u)
  assert.match(first, /第 1 次等待/u)
  assert.match(first, /本次请求还可再等 1 次/u)
  assert.match(first, /这不是登录态或额度问题/u)
  // The queue depth the body carried is worth showing while waiting.
  assert.match(first, /当前排队约 8887 个请求/u)

  // A later wait must READ differently: the host suppresses identical notices
  // within one turn, so a copy-identical row would leave a second wait silent.
  const second = formatQueueWaitNotice(facts, { waitMs: 31_000, attempt: 2, remaining: 0 })
  assert.match(second, /第 2 次等待/u)
  assert.match(second, /这是本次请求的最后一次等待/u)
  assert.notEqual(first, second)

  // Facts-only: no invented countdown and no claim of an outage.
  const bare = formatQueueWaitNotice({ isQueued: true, serviceAvailable: true }, { waitMs: 1_500, attempt: 1, remaining: 0 })
  assert.match(bare, /正在等待约 2 秒后重试/u)
  assert.doesNotMatch(bare, /当前排队/u)
  assert.doesNotMatch(bare, /暂不可服务/u)
})

test('formatQueueWaitNotice names which value governed the wait', () => {
  const facts = parseQueueFacts(nestedBody('403'))
  assert.ok(facts !== undefined)

  // The bug this closes: the setting said 30 but the row waited 86 (the queue
  // advised 85 + padding + jitter), and beside an unexplained 86 the setting
  // looked ignored. The row now states the upstream advice won and the setting
  // is only the no-advice fallback.
  const advised = formatQueueWaitNotice(facts, {
    waitMs: 86_000,
    attempt: 1,
    remaining: 4,
    basis: { source: 'upstream', advisedSeconds: 85, configuredSeconds: 30 },
  })
  assert.match(advised, /正在等待约 86 秒后重试/u)
  assert.match(advised, /上游建议 85 秒，设置仅作无建议时的回退/u)
  assert.doesNotMatch(advised, /按设置的 30 秒/u)

  // The fallback branch: no advice, so the configured seconds ARE in force —
  // and the row must not pretend the upstream said anything.
  const fallback = formatQueueWaitNotice(facts, {
    waitMs: 31_000,
    attempt: 1,
    remaining: 4,
    basis: { source: 'configured', configuredSeconds: 30 },
  })
  assert.match(fallback, /上游未给出建议，按设置的 30 秒/u)
  assert.doesNotMatch(fallback, /上游建议/u)

  // A hand-built progress record without the basis still renders the old
  // wording untouched — the clause is additive, never mandatory.
  const legacy = formatQueueWaitNotice(facts, { waitMs: 31_000, attempt: 1, remaining: 1 })
  assert.doesNotMatch(legacy, /回退|按设置/u)
  assert.match(legacy, /正在等待约 31 秒后重试/u)
})

/** The property names of the outermost object, for the "did not dig" assertion. */
function parseObjectKeys(body: string): string[] {
  return Object.keys(JSON.parse(body) as Record<string, unknown>)
}