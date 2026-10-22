import { describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { qoderQueueFacts, qoderQueueSignal } from '../src/qoder/errors.ts'
import { formatQueueNotice, parseQueueFacts } from '../src/qoder/queue-notice.ts'
import { emitUpstreamNotice, installJobTokenHint } from '../src/job-token-hint.ts'

/**
 * The body the user pasted, byte for byte: the upstream nests its own JSON
 * inside `message` as a string, and the innermost payload is escaped a second
 * time. `String.raw` keeps the backslashes literal, so this fixture IS the wire
 * shape rather than a reconstruction that could drift from it.
 */
const PASTED_BODY = String.raw`{"code":"403","message":"{\"code\":\"10605\",\"message\":\"{\\\"isQueued\\\":true,\\\"modelKey\\\":\\\"qfmodel\\\",\\\"queueCount\\\":8887,\\\"queueType\\\":\\\"p3\\\",\\\"retryAfterSeconds\\\":30,\\\"serviceAvailable\\\":false}\",\"subCode\":\"RESOURCE_LIMIT\"}"}`

/** The innermost fact object, in the order the upstream wrote it. */
const INNERMOST = '{"isQueued":true,"modelKey":"qfmodel","queueCount":8887,"queueType":"p3","retryAfterSeconds":30,"serviceAvailable":false}'

interface FakeSession {
  readonly rows: Array<{ type: string; data: unknown }>
  append(type: string, data: unknown): unknown
}

interface FakeAgent {
  id: string
  session?: FakeSession
}

/** A plugin context that records the `agent/status` listener it was given. */
function fakeContext(): { ctx: Context; running: (agent: FakeAgent) => void } {
  const listeners = new Map<string, (payload: unknown) => void>()
  const ctx = {
    on: (event: string, handler: (payload: unknown) => void): void => {
      listeners.set(event, handler)
    },
  } as unknown as Context
  return {
    ctx,
    running: (agent) => { listeners.get('agent/status')?.({ agent, status: 'running' }) },
  }
}

function fakeSession(fail = false): FakeSession {
  const rows: Array<{ type: string; data: unknown }> = []
  return {
    rows,
    append(type, data) {
      if (fail) throw new Error('projection rejected the append')
      rows.push({ type, data })
      return undefined
    },
  }
}

/** Arm the module with a fresh agent and return its session, ready to emit. */
function armed(session: FakeSession, id: string): void {
  const { ctx, running } = fakeContext()
  installJobTokenHint(ctx)
  running({ id, session })
}

describe('errors.ts classification contract', () => {
  it('still classifies a queue body as before and now exposes the parsed facts', () => {
    const nested = JSON.stringify({
      code: '403',
      message: JSON.stringify({ code: '10605', retryAfterSeconds: 30 }),
    })
    expect(qoderQueueSignal(nested)).toEqual({ retryAfterMs: 30_000 })
    expect(qoderQueueSignal('{"code":"403","message":"invalid job token"}')).toBeUndefined()
    // The richer parser is what the caller uses to explain the same rejection;
    // the two must not disagree about whether the body is a queue answer.
    expect(qoderQueueFacts(nested)).toEqual(parseQueueFacts(nested))
    expect(qoderQueueFacts('{"code":"403","message":"invalid job token"}')).toBeUndefined()
    expect(qoderQueueFacts(undefined)).toBeUndefined()
  })
})

describe('queue notice wording', () => {
  it('turns the pasted body into the approved notice', () => {
    const facts = parseQueueFacts(PASTED_BODY)
    expect(facts).toEqual({
      isQueued: true,
      serviceAvailable: false,
      modelKey: 'qfmodel',
      queueCount: 8887,
      queueType: 'p3',
      retryAfterSeconds: 30,
      subCode: 'RESOURCE_LIMIT',
      upstreamMessage: INNERMOST,
    })

    const text = formatQueueNotice(facts!, { waited: false, occurrences: 2 })
    // The user's approved template, with the placeholders filled from the body.
    expect(text).toMatch(/^上游模型排队中（模型暂不可服务，上游建议 30 秒后重试）：这不是登录态或额度问题，/u)
    expect(text).toContain('本次未按上游建议等待即返回此结果，如果频繁返回此结果可能代表当前账号已被风控')
    expect(text).toContain(`（上游原文：${INNERMOST}）`)
    expect(text.endsWith('）')).toBe(true)
  })

  it('never claims a wait that did not happen', () => {
    const facts = parseQueueFacts(PASTED_BODY)!
    expect(formatQueueNotice(facts, { waited: false, occurrences: 1 })).not.toContain('已按上游建议等待')
    // The upstream's SUGGESTION still shows: it is their advice, not our claim.
    expect(formatQueueNotice(facts, { waited: false, occurrences: 1 })).toContain('上游建议 30 秒后重试')
    expect(formatQueueNotice(facts, { waited: true, occurrences: 1 })).toContain('已按上游建议等待 30 秒仍不可服务')
  })

  it('mentions risk control only when the answer recurs', () => {
    const facts = parseQueueFacts(PASTED_BODY)!
    expect(formatQueueNotice(facts, { waited: false, occurrences: 1 })).not.toContain('风控')
    expect(formatQueueNotice(facts, { waited: false, occurrences: 2 })).toContain('可能代表当前账号已被风控')
  })

  it('says so when the upstream gave no retry delay', () => {
    const text = formatQueueNotice({ isQueued: true, serviceAvailable: false }, { waited: true, occurrences: 1 })
    expect(text).toContain('上游未给出建议重试时间')
    expect(text).toContain('已按上游建议等待后仍不可服务')
    expect(text).not.toMatch(/\d/u)
  })
})

describe('emitUpstreamNotice', () => {
  it('writes one log-only command pair into the running agent conversation', () => {
    const session = fakeSession()
    armed(session, 'agent-1')
    const text = formatQueueNotice(parseQueueFacts(PASTED_BODY)!, { waited: false, occurrences: 1 })

    emitUpstreamNotice(text)

    expect(session.rows).toHaveLength(2)
    const run = session.rows[0]!
    const done = session.rows[1]!
    expect(run.type).toBe('command/run')
    expect(done.type).toBe('command/done')
    expect(run.data).toMatchObject({ name: 'qoder', source: { kind: 'user' } })
    // The pair is joined by the fabricated id: that is what makes the two
    // log-only events render as a single row.
    expect((done.data as { commandId: string }).commandId).toBe((run.data as { commandId: string }).commandId)
    expect((done.data as { kind: string }).kind).toBe('error')
    expect((done.data as { text: string }).text).toBe(text)
  })

  it('collapses the host retries inside one turn but reports the next turn', () => {
    const session = fakeSession()
    armed(session, 'agent-2')
    const first = formatQueueNotice(parseQueueFacts(PASTED_BODY)!, { waited: false, occurrences: 1 })
    const second = formatQueueNotice(parseQueueFacts(PASTED_BODY)!, { waited: false, occurrences: 2 })

    emitUpstreamNotice(first)
    emitUpstreamNotice(first)
    expect(session.rows).toHaveLength(2)

    // Different facts in the same turn are a different thing to say.
    emitUpstreamNotice(second)
    expect(session.rows).toHaveLength(4)

    // The same notice in a later turn is the recurrence the wording reports.
    armed(session, 'agent-2')
    emitUpstreamNotice(first)
    expect(session.rows).toHaveLength(6)
  })

  it('is best effort: no session, no text, or a rejecting append never throws', () => {
    const { ctx, running } = fakeContext()
    installJobTokenHint(ctx)
    running({ id: 'agent-3' })
    expect(() => emitUpstreamNotice('上游模型排队中')).not.toThrow()

    const session = fakeSession()
    armed(session, 'agent-4')
    expect(() => emitUpstreamNotice('')).not.toThrow()
    expect(session.rows).toHaveLength(0)

    const rejecting = fakeSession(true)
    armed(rejecting, 'agent-5')
    expect(() => emitUpstreamNotice('上游模型排队中')).not.toThrow()
  })

  it('bounds the quoted upstream text in the row', () => {
    const session = fakeSession()
    armed(session, 'agent-6')
    const facts = parseQueueFacts(JSON.stringify({
      code: '10605',
      isQueued: true,
      serviceAvailable: false,
      message: 'x'.repeat(900),
    }))!
    emitUpstreamNotice(formatQueueNotice(facts, { waited: false, occurrences: 1 }))

    const text = (session.rows[1]!.data as { text: string }).text
    expect(text).toContain(`${'x'.repeat(400)}…`)
    expect(text).not.toContain('x'.repeat(401))
  })
})