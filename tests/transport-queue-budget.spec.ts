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
 * Offline tests for the two T2 rules that a queue wait must satisfy: the wait
 * is padded and jittered, and its budget belongs to the REQUEST rather than to
 * each account the walk tries.
 *
 * The reason the budget moved is the one measured in the reference
 * implementation: a request that walked an N-account pool waited N times the
 * configured number of rounds, so a caller who asked for one wait sat through
 * N. These cases pin the budget to the request and pin the padding so the
 * "sleep longer than advised" behaviour cannot silently disappear.
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
 * A queue answer with the upstream's own advice.
 *
 * `waitTime` is a separate hint and can exceed `retryAfterSeconds` (the
 * reported incident: 30 vs 86); it defaults to the retry advice only for the
 * tests that are not about the difference.
 */
function queued(retryAfterSeconds: number, waitTime = retryAfterSeconds): Response {
  const inner = JSON.stringify({
    isQueued: true,
    modelKey: 'qmodel',
    queueCount: 0,
    queueType: 'p3',
    retryAfterSeconds,
    serviceAvailable: false,
    subCode: 'RESOURCE_LIMIT',
    waitTime,
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

function harness(spec: UpstreamSpec & {
  failover?: QoderFailoverHooks
  queueWait?: QoderTransportOptions['queueWait']
  random?: () => number
  logger?: QoderTransportOptions['logger']
}): { transport: QoderTransport; upstream: FakeUpstream } {
  const upstream = fakeUpstream(spec)
  const options: QoderTransportOptions = {
    region: 'global',
    resolvePat: async () => AMBIENT_PAT,
    resolveMachineId: () => 'machine-test',
    fetch: upstream.fetch,
    ...spec.failover === undefined ? {} : { failover: spec.failover },
    ...spec.queueWait === undefined ? {} : { queueWait: spec.queueWait },
    ...spec.random === undefined ? {} : { random: spec.random },
    ...spec.logger === undefined ? {} : { logger: spec.logger },
  }
  return { transport: createQoderTransport(options), upstream }
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

/** Drain until the queue wait begins, capture the logged wait, then abort. */
async function loggedWait(
  spec: UpstreamSpec & {
    queueWait: QoderTransportOptions['queueWait']
    random: () => number
  },
): Promise<number> {
  const logger = { warn: vi.fn() }
  const { transport } = harness({ ...spec, logger })
  const controller = new AbortController()
  const startedAt = Date.now()
  setTimeout(() => controller.abort(), 150)
  await drainError(transport, controller.signal)
  // The wait has to start promptly; this also keeps a broken (uncapped) wait
  // from silently sleeping for the advised minutes instead of failing.
  expect(Date.now() - startedAt).toBeLessThan(3_000)
  const call = logger.warn.mock.calls.find(entry => entry[0] === '[Qoder Stream] Upstream queue is saturated; waiting before retrying the same account')
  if (call === undefined) throw new Error('the queue wait was never logged')
  return (call[1] as { waitMs: number }).waitMs
}

// ---------------------------------------------------------------------------

describe('QoderTransport queue wait padding', () => {
  it('waits the advised window plus one second and an injectable jitter', async () => {
    // random() = 0 pins the bottom of the spread: advice + the one-second margin.
    const low = await loggedWait({
      queueWait: { attempts: () => 1, seconds: () => 300 },
      random: () => 0,
      chat: () => queued(1),
    })
    expect(low).toBe(1_000 + 1_000)

    // random() near 1 pins the top: advice + margin + just under two seconds.
    const high = await loggedWait({
      queueWait: { attempts: () => 1, seconds: () => 300 },
      random: () => 0.9999,
      chat: () => queued(1),
    })
    expect(high).toBe(1_000 + 1_000 + 1_998)
  })

  it('waits the longer of retryAfterSeconds and the queue waitTime', async () => {
    // The reported incident: retryAfterSeconds=30 but waitTime=86. A wait built
    // only on the retry advice returned to the same queue 30s later, so two
    // waits of ~32s still never covered the 86s window and the request died
    // before the model was free.
    const waitMs = await loggedWait({
      queueWait: { attempts: () => 2, seconds: () => 0 },
      random: () => 0,
      chat: () => queued(30, 86),
    })
    expect(waitMs).toBe(86_000 + 1_000)
  })

  it('keeps the padded wait under the five-minute ceiling', async () => {
    // Advice far past the ceiling, and a jitter that would otherwise push the
    // total past it: the cap is the caller's time bound, so it wins.
    const waitMs = await loggedWait({
      queueWait: { attempts: () => 1, seconds: () => 0 },
      random: () => 0.9999,
      chat: () => queued(600),
    })
    expect(waitMs).toBe(5 * 60 * 1000)
  })
})

describe('QoderTransport per-request queue budget', () => {
  it('spends the configured waits once for the request, not once per account', async () => {
    const poolState = pool()
    const logger = { warn: vi.fn() }
    const { transport, upstream } = harness({
      failover: poolState.hooks,
      queueWait: { attempts: () => 1, seconds: () => 0.01 },
      random: () => 0,
      logger,
      // Alpha queues, then fails in a way the walk switches on; Beta queues
      // again. The request is owed a total of ONE wait.
      chat: (pat, call) => {
        if (pat === ALPHA.pat) return call === 1 ? queued(0) : new Response('', { status: 503 })
        return queued(0)
      },
    })

    const error = await drainError(transport)

    expect(upstream.chatPats).toEqual([ALPHA.pat, ALPHA.pat, BETA.pat])
    // Exactly one wait, even though the request used two accounts.
    expect(logger.warn).toHaveBeenCalledTimes(1)
    // The walk switched for the account failure, never for the queue answer.
    expect(poolState.switches.map(info => info.reason)).toEqual(['upstream SERVER (HTTP 503)'])
    expect(poolState.nextCalls).toEqual([ALPHA.id])
    // Budget exhausted on Beta: the queue now leaves the transport as the
    // honest answer instead of being waited out a second time.
    expect((error as QoderLlmError).code).toBe('RATE_LIMIT')
  })

  it('gives the request a single budget even when an account self-heals first', async () => {
    const poolState = pool()
    const logger = { warn: vi.fn() }
    const { transport, upstream } = harness({
      failover: poolState.hooks,
      queueWait: { attempts: () => 1, seconds: () => 0.01 },
      random: () => 0,
      logger,
      // Same-request walk: Alpha queues once, then is refused in a way that
      // switches to Beta, which serves.
      chat: (pat, call) => {
        if (pat === ALPHA.pat) return call === 1 ? queued(0) : new Response('', { status: 503 })
        return accepted('served-by-beta')
      },
    })

    const chunks = await drain(transport)

    expect(upstream.chatPats).toEqual([ALPHA.pat, ALPHA.pat, BETA.pat])
    expect(chunks.some(chunk => chunk.type === 'text-delta' && chunk.text === 'served-by-beta')).toBe(true)
    expect(logger.warn).toHaveBeenCalledTimes(1)
  })
})
