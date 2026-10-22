import { describe, expect, it, vi } from 'vitest'
import { createUserMessage, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { QoderLlmError } from '../src/qoder/errors.ts'
import {
  createQoderTransport,
  type QoderFailoverHooks,
  type QoderTransport,
  type QoderTransportOptions,
} from '../src/qoder/transport/index.ts'

/**
 * Offline tests for queue waiting (排队等待次数 / 排队等待秒数) in the chat path.
 *
 * A queue answer is the upstream saying "the model is busy". The recovery the
 * user asked for is time — the pool is deliberately NOT consulted for it — so
 * what these cases pin down is the boundary between waiting and giving up:
 * how long, in whose window, how often, and what happens to an abort that lands
 * in the middle of the sleep.
 */

const AMBIENT_PAT = 'pt-ambient'

const ALPHA = { id: 'acct-a', pat: 'pt-a' }
const BETA = { id: 'acct-b', pat: 'pt-b' }

// ---------------------------------------------------------------------------
// Fake upstream
// ---------------------------------------------------------------------------

interface FakeUpstream {
  fetch: typeof fetch
  /** PAT whose credentials signed each chat call, in order. */
  chatPats: string[]
}

interface UpstreamSpec {
  /** The answer for the `call`-th (1-based) chat of the account holding `pat`. */
  chat(pat: string, call: number): Response | Promise<Response>
}

function fakeUpstream(spec: UpstreamSpec): FakeUpstream {
  const chatPats: string[] = []
  const chatCounts = new Map<string, number>()
  const patOfUser = new Map<string, string>()

  const fetchImpl = (async (input: URL | Request | string, init?: RequestInit): Promise<Response> => {
    const url = String(input)
    if (url.includes('/jobToken/exchange')) {
      const body = JSON.parse(String(init?.body ?? '{}')) as { personal_token?: string }
      return new Response(JSON.stringify({ token: `jt-${body.personal_token ?? ''}` }))
    }
    if (url.includes('/userinfo')) {
      const bearer = new Headers(init?.headers).get('authorization') ?? ''
      const pat = bearer.replace(/^Bearer\s+/u, '').replace(/^jt-/u, '')
      patOfUser.set(`user-${pat}`, pat)
      return new Response(JSON.stringify({ id: `user-${pat}` }))
    }
    if (url.includes('/agent_chat_generation')) {
      const pat = patOfUser.get(new Headers(init?.headers).get('Cosy-User') ?? '') ?? ''
      const call = (chatCounts.get(pat) ?? 0) + 1
      chatCounts.set(pat, call)
      chatPats.push(pat)
      return await spec.chat(pat, call)
    }
    throw new Error(`unexpected URL: ${url}`)
  }) as typeof fetch

  return { fetch: fetchImpl, chatPats }
}

/** One accepted chat, as the upstream sends it: an envelope carrying a delta. */
function accepted(text: string): Response {
  const body = JSON.stringify({ choices: [{ delta: { content: text }, finish_reason: 'stop' }] })
  return new Response(`data: ${JSON.stringify({ statusCodeValue: 200, body })}\n\ndata: [DONE]\n\n`, {
    headers: { 'content-type': 'text/event-stream' },
  })
}

/**
 * The user's own report of a busy model (m00001), as the upstream sends it: a
 * 403 whose body nests the queue answer one level deeper.
 *
 * `retryAfterSeconds: 0` is the "no advice" shape: the classifier refuses to
 * turn it into a retry window (there is nothing to wait for), which is exactly
 * what makes it the right input for exercising the configured fallback.
 */
function queued(retryAfterSeconds: number): Response {
  const inner = JSON.stringify({
    isQueued: true,
    modelKey: 'qmodel',
    queueCount: 0,
    queueType: 'p3',
    retryAfterSeconds,
    serviceAvailable: false,
    subCode: 'RESOURCE_LIMIT',
    waitTime: retryAfterSeconds,
  })
  const body = JSON.stringify({ code: '403', message: JSON.stringify({ code: '10605', message: inner, subCode: '' }) })
  return new Response(body, { status: 403, headers: { 'content-type': 'application/json' } })
}

// ---------------------------------------------------------------------------
// Fake credential pool
// ---------------------------------------------------------------------------

interface Pool {
  hooks: QoderFailoverHooks
  switches: Array<{ fromId: string; toId: string; reason: string }>
  /** Accounts `nextAccount` was asked about, in order. */
  nextCalls: string[]
}

function pool(): Pool {
  const accounts = [ALPHA, BETA]
  const switches: Array<{ fromId: string; toId: string; reason: string }> = []
  const nextCalls: string[] = []
  return {
    switches,
    nextCalls,
    hooks: {
      enabled: () => true,
      activeAccount: async () => ALPHA,
      async nextAccount(id) {
        nextCalls.push(id)
        const index = accounts.findIndex(candidate => candidate.id === id)
        return index === -1 ? undefined : accounts[index + 1]
      },
      async switched(info) {
        switches.push(info)
      },
    },
  }
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

interface QueueObservation {
  facts: { isQueued: boolean; retryAfterSeconds?: number }
  accountId: string | undefined
}

function harness(spec: UpstreamSpec & {
  failover?: QoderFailoverHooks
  queueWait?: QoderTransportOptions['queueWait']
  random?: () => number
}): { transport: QoderTransport; upstream: FakeUpstream; notices: QueueObservation[] } {
  const upstream = fakeUpstream(spec)
  const notices: QueueObservation[] = []
  const options: QoderTransportOptions = {
    region: 'global',
    resolvePat: async () => AMBIENT_PAT,
    resolveMachineId: () => 'machine-test',
    fetch: upstream.fetch,
    ...spec.failover === undefined ? {} : { failover: spec.failover },
    ...spec.queueWait === undefined ? {} : { queueWait: spec.queueWait },
    ...spec.random === undefined ? {} : { random: spec.random },
    onUpstreamQueue: (facts, accountId) => {
      notices.push({ facts: { isQueued: facts.isQueued, ...facts.retryAfterSeconds === undefined ? {} : { retryAfterSeconds: facts.retryAfterSeconds } }, accountId })
    },
  }
  return { transport: createQoderTransport(options), upstream, notices }
}

function request(signal?: AbortSignal): GenerateOptions {
  return {
    provider: 'qoder-official',
    model: 'cmodel',
    messages: [createUserMessage({ content: [{ type: 'text', text: 'Hello' }], source: { kind: 'user' } })],
    ...signal === undefined ? {} : { signal },
  }
}

async function drain(transport: QoderTransport, signal?: AbortSignal): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = []
  for await (const chunk of transport.stream(request(signal))) chunks.push(chunk)
  return chunks
}

async function drainError(transport: QoderTransport, signal?: AbortSignal): Promise<unknown> {
  try {
    await drain(transport, signal)
    return undefined
  } catch (error: unknown) {
    return error
  }
}

// ---------------------------------------------------------------------------

describe('QoderTransport queue waiting', () => {
  it('leaves attempts = 0 exactly as it was: the first queue answer is terminal', async () => {
    const poolState = pool()
    const { transport, upstream, notices } = harness({
      failover: poolState.hooks,
      queueWait: { attempts: () => 0, seconds: () => 0.01 },
      chat: () => queued(30),
    })

    const error = await drainError(transport)

    // The default configuration. One attempt, one explanation — waiting zero
    // times must not grow a hidden retry, and the notice still carries the
    // upstream's own advice for the host's retry policy to use.
    expect(upstream.chatPats).toEqual([ALPHA.pat])
    expect(notices).toEqual([{ facts: { isQueued: true, retryAfterSeconds: 30 }, accountId: ALPHA.id }])
    expect((error as QoderLlmError).code).toBe('RATE_LIMIT')
    expect(poolState.switches).toEqual([])
  })

  it('waits and retries the same account, and a late success is never announced', async () => {
    const poolState = pool()
    const { transport, upstream, notices } = harness({
      failover: poolState.hooks,
      queueWait: { attempts: () => 1, seconds: () => 0.02 },
      // No advice in the body, so the configured fallback is the only window.
      chat: (_pat, call) => call === 1 ? queued(0) : accepted('served-after-wait'),
    })

    const chunks = await drain(transport)

    // Same account both times: a busy model cannot be jumped by another
    // identity, so the retry re-signs with the credential that was already
    // spending its subscription.
    expect(upstream.chatPats).toEqual([ALPHA.pat, ALPHA.pat])
    expect(chunks.some(chunk => chunk.type === 'text-delta' && chunk.text === 'served-after-wait')).toBe(true)
    // The user never saw the queue, so there is nothing to explain.
    expect(notices).toEqual([])
    expect(poolState.switches).toEqual([])
    expect(poolState.nextCalls).toEqual([])
  })

  it('spends the budget, then explains the queue without spending another account', async () => {
    const poolState = pool()
    const { transport, upstream, notices } = harness({
      failover: poolState.hooks,
      queueWait: { attempts: () => 2, seconds: () => 0.01 },
      // Pin the jitter to its floor: each wait is then the 1000ms margin plus
      // 10ms of configured fallback, keeping two waits inside the test timeout
      // instead of straddling it at random.
      random: () => 0,
      chat: () => queued(0),
    })

    const error = await drainError(transport)

    // Two waits means three attempts in total (the first, plus one per wait) —
    // bounded, and still all on Alpha. The pool was never consulted, because a
    // saturated model says nothing about the account.
    expect(upstream.chatPats).toEqual([ALPHA.pat, ALPHA.pat, ALPHA.pat])
    expect(notices).toHaveLength(1)
    expect(notices[0]?.accountId).toBe(ALPHA.id)
    expect(poolState.switches).toEqual([])
    expect(poolState.nextCalls).toEqual([])
    expect((error as QoderLlmError).code).toBe('RATE_LIMIT')
  })

  it("prefers the upstream's own window over the configured fallback", async () => {
    const poolState = pool()
    const { transport, upstream, notices } = harness({
      failover: poolState.hooks,
      // The fallback is deliberately enormous: if the configured seconds were
      // used instead of the advised one second, this test would run for minutes
      // and fail on its timeout rather than quietly pass.
      queueWait: { attempts: () => 1, seconds: () => 300 },
      chat: (_pat, call) => call === 1 ? queued(1) : accepted('waited-the-advised-second'),
    })

    const startedAt = Date.now()
    const chunks = await drain(transport)
    const elapsed = Date.now() - startedAt

    expect(chunks.some(chunk => chunk.type === 'text-delta' && chunk.text === 'waited-the-advised-second')).toBe(true)
    expect(upstream.chatPats).toEqual([ALPHA.pat, ALPHA.pat])
    expect(notices).toEqual([])
    // The advice is computed from the queue it describes, so it wins — the
    // configured number is only a fallback for answers that carry no advice.
    expect(elapsed).toBeGreaterThanOrEqual(900)
    expect(elapsed).toBeLessThan(60_000)
  })

  it('aborts out of the wait immediately instead of sleeping to the end', async () => {
    const poolState = pool()
    const { transport, upstream, notices } = harness({
      failover: poolState.hooks,
      // Advice far past any test timeout: only an abort can end this wait.
      queueWait: { attempts: () => 3, seconds: () => 0.01 },
      chat: () => queued(300),
    })
    const controller = new AbortController()
    const startedAt = Date.now()
    const pending = drainError(transport, controller.signal)
    setTimeout(() => controller.abort(), 30)
    const error = await pending
    const elapsed = Date.now() - startedAt

    // A cancel has to break the sleep itself, not wait for its deadline: the
    // caller gave up, so the request must end at once and say so honestly.
    expect((error as QoderLlmError).code).toBe('ABORTED')
    expect(elapsed).toBeLessThan(3_000)
    expect(upstream.chatPats).toEqual([ALPHA.pat])
    expect(notices).toEqual([])
    expect(poolState.switches).toEqual([])
  })

  it('keeps a zero-second advice from turning into a busy retry loop', async () => {
    const poolState = pool()
    const logger = { warn: vi.fn() }
    const upstream = fakeUpstream({ chat: () => queued(0) })
    const transport = createQoderTransport({
      region: 'global',
      resolvePat: async () => AMBIENT_PAT,
      resolveMachineId: () => 'machine-test',
      fetch: upstream.fetch,
      failover: poolState.hooks,
      queueWait: { attempts: () => 2, seconds: () => 0.01 },
      // Same as above: the margin is real, so pin the spread and keep the two
      // waits comfortably inside the timeout.
      random: () => 0,
      logger,
    })

    const error = await drainError(transport)

    // "Retry after 0 seconds" is not a wait window: the classifier drops it, so
    // the configured fallback governs and each retry is a real attempt with a
    // real pause — never an unthrottled spin.
    expect(upstream.chatPats).toHaveLength(3)
    expect(logger.warn).toHaveBeenCalledTimes(2)
    expect((error as QoderLlmError).code).toBe('RATE_LIMIT')
  })
})
