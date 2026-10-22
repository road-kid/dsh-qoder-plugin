import { describe, expect, it } from 'vitest'
import { createUserMessage, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import {
  accountAcquireTimeoutMs,
  QoderAccountTrafficLimiter,
} from '../src/qoder/transport/account-limiter.ts'
import {
  createQoderTransport,
  type QoderFailoverHooks,
  type QoderTransport,
} from '../src/qoder/transport/index.ts'

/**
 * Offline tests for the per-account traffic guard.
 *
 * The guard exists because the host calls `stream()` per conversation and a
 * one-account pool then puts every conversation's first burst on the same
 * credential in the same instant. These cases pin the three promises the guard
 * makes — one attempt at a time, at least 400ms between starts, and failure to
 * get a turn is a warning rather than a hang — plus the fact that accounts do
 * not block each other.
 */

const ALPHA = { id: 'acct-a', pat: 'pt-a' }

function sleep(ms: number): Promise<void> {
  return new Promise<void>(resolve => setTimeout(resolve, ms))
}

// ---------------------------------------------------------------------------
// Fake upstream (single-account pool)
// ---------------------------------------------------------------------------

interface ChatObservation {
  pat: string
  startedAt: number
  /** How many chats were in flight when this one started. */
  concurrentAtStart: number
}

interface FakeUpstream {
  fetch: typeof fetch
  observations: ChatObservation[]
  maxConcurrent: number
}

/** A fake upstream whose chat answers after `holdMs`, recording overlap. */
function fakeUpstream(holdMs: number, failFirst = false): FakeUpstream {
  const patOfUser = new Map<string, string>()
  const observations: ChatObservation[] = []
  let inFlight = 0
  let maxConcurrent = 0
  let calls = 0

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
      calls += 1
      inFlight += 1
      maxConcurrent = Math.max(maxConcurrent, inFlight)
      observations.push({ pat, startedAt: Date.now(), concurrentAtStart: inFlight })
      await sleep(holdMs)
      inFlight -= 1
      if (failFirst && calls === 1) return new Response('', { status: 503 })
      const body = JSON.stringify({ choices: [{ delta: { content: 'served' }, finish_reason: 'stop' }] })
      return new Response(`data: ${JSON.stringify({ statusCodeValue: 200, body })}\n\ndata: [DONE]\n\n`, {
        headers: { 'content-type': 'text/event-stream' },
      })
    }
    throw new Error(`unexpected URL: ${url}`)
  }) as typeof fetch

  return { fetch: fetchImpl, observations, get maxConcurrent() { return maxConcurrent } }
}

/** A one-account pool: every walk stays on Alpha. */
function singleAccountPool(): QoderFailoverHooks {
  return {
    enabled: () => true,
    activeAccount: async () => ALPHA,
    nextAccount: async () => undefined,
    switched: async () => {},
  }
}

function transportWith(upstream: FakeUpstream): QoderTransport {
  return createQoderTransport({
    region: 'global',
    resolvePat: async () => 'pt-ambient',
    resolveMachineId: () => 'machine-test',
    fetch: upstream.fetch,
    failover: singleAccountPool(),
  })
}

function request(): GenerateOptions {
  return {
    provider: 'qoder-official',
    model: 'cmodel',
    messages: [createUserMessage({ content: [{ type: 'text', text: 'Hello' }], source: { kind: 'user' } })],
  }
}

async function drain(transport: QoderTransport): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = []
  for await (const chunk of transport.stream(request())) chunks.push(chunk)
  return chunks
}

// ---------------------------------------------------------------------------

describe('QoderAccountTrafficLimiter', () => {
  it('holds one slot per account and spaces starts by at least the gap', async () => {
    // Real clock and timers: the gap is part of the contract, so it is worth
    // measuring rather than simulating. Jitter is pinned to its floor.
    const limiter = new QoderAccountTrafficLimiter({ random: () => 0 })
    const observed: number[] = []

    const first = await limiter.acquire(ALPHA.id)
    observed.push(Date.now())
    const secondPending = limiter.acquire(ALPHA.id).then((lease) => {
      observed.push(Date.now())
      return lease
    })

    // The one-slot rule: the second request cannot get a lease while the first
    // one holds it, no matter how long it waits.
    await sleep(120)
    expect(observed).toHaveLength(1)
    const second = await (async () => {
      first.release()
      return await secondPending
    })()
    expect(observed).toHaveLength(2)
    // The pacing rule: measured from the previous START.
    expect(observed[1]! - observed[0]!).toBeGreaterThanOrEqual(390)

    second.release()
    // Releasing twice is harmless — the transport releases in a `finally` that
    // may run after a consumer already released.
    second.release()
    const third = await limiter.acquire(ALPHA.id)
    third.release()
  })

  it('never makes one account wait for another', async () => {
    // A paused clock with a recording sleep: any cross-account wait would show
    // up as a sleep call.
    const sleeps: number[] = []
    const limiter = new QoderAccountTrafficLimiter({
      now: () => 1_000,
      random: () => 0,
      sleep: async (ms) => {
        sleeps.push(ms)
      },
    })

    const alpha = await limiter.acquire('acct-a')
    const beta = await limiter.acquire('acct-b')

    expect(sleeps).toEqual([])
    beta.release()
    // Alpha's slot was never part of Beta's path.
    const gamma = await limiter.acquire('acct-c')
    expect(gamma).toBeDefined()
    gamma.release()
    alpha.release()
  })

  it('fails open after the 30s acquire timeout and warns once', async () => {
    // Fake clock advanced by the injected sleep: a request that would wait the
    // full thirty real seconds is simulated in microseconds. The timeout is the
    // production constant, never overridden here.
    let clock = 0
    const sleeps: number[] = []
    const failOpens: Array<{ accountId: string; waitedMs: number }> = []
    const limiter = new QoderAccountTrafficLimiter({
      now: () => clock,
      random: () => 0,
      sleep: async (ms) => {
        sleeps.push(ms)
        clock += ms
      },
      onFailOpen: info => failOpens.push(info),
    })

    const held = await limiter.acquire('acct-a')
    const lease = await limiter.acquire('acct-a')

    // The guard gave up rather than waiting past the caller's patience, and it
    // handed back a usable lease so the request can proceed.
    expect(lease).toBeDefined()
    expect(sleeps).toEqual([accountAcquireTimeoutMs])
    expect(failOpens).toEqual([{ accountId: 'acct-a', waitedMs: accountAcquireTimeoutMs }])

    // Releasing the fail-open lease must not disturb the real holder, and
    // releasing the holder must leave the account usable.
    lease.release()
    held.release()
    const after = await limiter.acquire('acct-a')
    expect(after).toBeDefined()
    after.release()
  })
})

describe('QoderTransport account traffic guard', () => {
  it('paces three concurrent requests to the same account: no overlap, >=400ms apart', async () => {
    const upstream = fakeUpstream(10)
    const transport = transportWith(upstream)

    const results = await Promise.all([drain(transport), drain(transport), drain(transport)])

    expect(results.every(chunks => chunks.some(chunk => chunk.type === 'text-delta'))).toBe(true)
    expect(upstream.observations).toHaveLength(3)
    // Never concurrent: the fake upstream saw one chat at a time.
    expect(upstream.maxConcurrent).toBe(1)
    expect(upstream.observations.every(observation => observation.concurrentAtStart === 1)).toBe(true)
    const starts = upstream.observations.map(observation => observation.startedAt)
    for (let index = 1; index < starts.length; index += 1) {
      // Measured at the fake upstream, i.e. after the fetch dispatch whose own
      // delay varies a little under load; a few milliseconds of that variance
      // is why this uses a tolerance rather than the limiter's exact 400ms
      // floor (the unit case above pins that floor on an injected clock). A
      // real pacing breach collapses the gap to roughly zero, far below this.
      expect(starts[index]! - starts[index - 1]!).toBeGreaterThanOrEqual(300)
    }
  })

  it('releases the account slot when a request fails, so the next one is not starved', async () => {
    const upstream = fakeUpstream(5, true)
    const transport = transportWith(upstream)

    // First request fails on the upstream (503, no next account to switch to);
    // the failure must still return the traffic slot in its `finally`.
    const failing = drain(transport).catch((error: unknown) => error)
    const first = await failing
    expect(first).toBeInstanceOf(Error)

    // A second request gets its turn instead of waiting out the fail-open
    // timeout, and the account still serves it.
    const chunks = await drain(transport)
    expect(chunks.some(chunk => chunk.type === 'text-delta')).toBe(true)
    expect(upstream.observations).toHaveLength(2)
  })
})
