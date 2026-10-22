import { describe, expect, it } from 'vitest'
import {
  createUserMessage,
  type GenerateOptions,
  type StreamChunk,
} from '@deepseek-ai/dsh-llm'
import {
  createQoderTransport,
  type QoderFailoverHooks,
  type QoderTransport,
} from '../src/qoder/transport/index.ts'

/**
 * Offline tests for per-request account reservations.
 *
 * The transport only walks the account pool after a failure, so two requests
 * that start in the same instant both read the same active account and land on
 * the same credential — even though the pool has capacity. The reservation is
 * the dispatch-time claim that makes "this account is already serving someone"
 * visible to the walk's account choice. These cases pin the whole contract: a
 * concurrent request is steered elsewhere, claims are released after success,
 * failure and abort, and a one-account pool keeps behaving exactly as before.
 */

const ALPHA = { id: 'acct-a', pat: 'pt-a' }
const BETA = { id: 'acct-b', pat: 'pt-b' }
const GAMMA = { id: 'acct-c', pat: 'pt-c' }

type ChatOutcome = 'ok' | 'fail' | 'hold'

interface ChatCall {
  pat: string
}

interface FakeUpstream {
  fetch: typeof fetch
  chats: ChatCall[]
  /** Let every held chat answer. */
  releaseAll(): void
}

/**
 * Fake upstream with a per-account scripted answer.
 *
 * The script is the test's way of staging a real interleaving without sleeping
 * on timers: the first call for an account may be held open (so the request
 * visibly keeps its reservation) while the test starts another request, and a
 * later call for the same account can be told to answer normally.
 */
function fakeUpstream(scripts: Record<string, ChatOutcome[]> = {}): FakeUpstream {
  const patOfUser = new Map<string, string>()
  const remaining = new Map<string, ChatOutcome[]>(
    Object.entries(scripts).map(([pat, outcomes]) => [pat, [...outcomes]]),
  )
  const chats: ChatCall[] = []
  const held: Array<() => void> = []

  const hold = (signal: AbortSignal | null | undefined): Promise<void> => new Promise<void>((resolve, reject) => {
    const answer = (): void => resolve()
    held.push(answer)
    if (signal !== null && signal !== undefined) {
      signal.addEventListener('abort', () => {
        held.splice(held.indexOf(answer), 1)
        reject(new DOMException('Aborted', 'AbortError'))
      }, { once: true })
    }
  })

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
      chats.push({ pat })
      const outcome = (remaining.get(pat) ?? []).shift() ?? 'ok'
      if (outcome === 'hold') await hold(init?.signal)
      if (outcome === 'fail') return new Response('', { status: 503 })
      const body = JSON.stringify({ choices: [{ delta: { content: 'served' }, finish_reason: 'stop' }] })
      return new Response(`data: ${JSON.stringify({ statusCodeValue: 200, body })}\n\ndata: [DONE]\n\n`, {
        headers: { 'content-type': 'text/event-stream' },
      })
    }
    throw new Error(`unexpected URL: ${url}`)
  }) as typeof fetch

  return {
    fetch: fetchImpl,
    chats,
    releaseAll(): void {
      const pending = held.splice(0)
      for (const answer of pending) answer()
    },
  }
}

/** A pool whose walk follows the given save order, recording every switch. */
function pool(accounts: Array<{ id: string; pat: string }>, switches: Array<{ fromId: string; toId: string; reason: string }>): QoderFailoverHooks {
  return {
    enabled: () => true,
    activeAccount: async () => accounts[0],
    nextAccount: async (id) => {
      const index = accounts.findIndex((account) => account.id === id)
      return accounts[index + 1]
    },
    switched: async (info) => {
      switches.push(info)
    },
  }
}

function transportWith(upstream: FakeUpstream, failover: QoderFailoverHooks): QoderTransport {
  return createQoderTransport({
    region: 'global',
    resolvePat: async () => 'pt-ambient',
    resolveMachineId: () => 'machine-test',
    fetch: upstream.fetch,
    failover,
    // The per-account pacing is not the subject here; pin its jitter so the
    // 400ms floor is the only thing between two attempts on one account.
    random: () => 0,
  })
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

async function waitFor(predicate: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 3_000
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`)
    await new Promise<void>((resolve) => setTimeout(resolve, 5))
  }
}

describe('QoderTransport account reservations', () => {
  it('steers a second concurrent request away from the account already serving', async () => {
    const upstream = fakeUpstream({ [ALPHA.pat]: ['hold'] })
    const switches: Array<{ fromId: string; toId: string; reason: string }> = []
    const transport = transportWith(upstream, pool([ALPHA, BETA], switches))

    // First request: pinned to Alpha and visibly in flight, so its reservation
    // is held for the whole time the test stage matters.
    const first = drain(transport)
    await waitFor(() => upstream.chats.length === 1, 'the first chat to start')

    const second = drain(transport)
    await waitFor(() => upstream.chats.length === 2, 'the second chat to start')

    const firstChat = upstream.chats[0]!
    const secondChat = upstream.chats[1]!
    // The reserved account is skipped exactly like a cooling one is: the second
    // request is answered by the next pool account, not by the same credential.
    expect(firstChat.pat).toBe(ALPHA.pat)
    expect(secondChat.pat).toBe(BETA.pat)
    expect(switches).toEqual([{
      fromId: ALPHA.id,
      toId: BETA.id,
      reason: 'account is already serving another request',
    }])

    upstream.releaseAll()
    const [firstChunks, secondChunks] = await Promise.all([first, second])
    expect(firstChunks.some((chunk) => chunk.type === 'text-delta')).toBe(true)
    expect(secondChunks.some((chunk) => chunk.type === 'text-delta')).toBe(true)
  })

  it('releases the claim when a failed attempt moves the walk on', async () => {
    // r1 fails on Alpha and on Beta, then streams from Gamma while it is held.
    // By then Alpha's failed attempt must have released its claim: r2 has to be
    // able to start on Alpha instead of walking past it.
    const upstream = fakeUpstream({
      [ALPHA.pat]: ['fail', 'ok'],
      [BETA.pat]: ['fail'],
      [GAMMA.pat]: ['hold'],
    })
    const switches: Array<{ fromId: string; toId: string; reason: string }> = []
    const transport = transportWith(upstream, pool([ALPHA, BETA, GAMMA], switches))

    const first = drain(transport)
    await waitFor(() => upstream.chats.length === 3, 'the walk to reach Gamma')

    const second = drain(transport)
    await waitFor(() => upstream.chats.length === 4, 'the second request to start')
    expect(upstream.chats[3]!.pat).toBe(ALPHA.pat)
    // Only the two failure switches: Alpha is not skipped as "already serving".
    expect(switches.map((row) => row.reason)).toEqual([
      'upstream SERVER (HTTP 503)',
      'upstream SERVER (HTTP 503)',
    ])

    upstream.releaseAll()
    const [firstChunks, secondChunks] = await Promise.all([first, second])
    expect(firstChunks.some((chunk) => chunk.type === 'text-delta')).toBe(true)
    expect(secondChunks.some((chunk) => chunk.type === 'text-delta')).toBe(true)
  })

  it('releases the claim when the request is aborted mid-stream', async () => {
    const upstream = fakeUpstream({ [ALPHA.pat]: ['hold', 'ok'] })
    const switches: Array<{ fromId: string; toId: string; reason: string }> = []
    const transport = transportWith(upstream, pool([ALPHA, BETA], switches))

    const controller = new AbortController()
    const first = drain(transport, controller.signal)
    await waitFor(() => upstream.chats.length === 1, 'the first chat to start')

    controller.abort()
    await expect(first).rejects.toBeDefined()

    // The aborted request must not keep Alpha claimed: a fresh request starts
    // there again, with no "already serving" switch in between.
    const second = await drain(transport)
    expect(upstream.chats[1]!.pat).toBe(ALPHA.pat)
    expect(switches).toEqual([])
    expect(second.some((chunk) => chunk.type === 'text-delta')).toBe(true)
  })

  it('leaves a single-account pool unchanged: both requests still use that account', async () => {
    // With nowhere else to go the reservation falls back to today's behaviour:
    // the request is queued behind the traffic guard rather than refused.
    const upstream = fakeUpstream({ [ALPHA.pat]: ['hold', 'ok'] })
    const switches: Array<{ fromId: string; toId: string; reason: string }> = []
    const transport = transportWith(upstream, pool([ALPHA], switches))

    const first = drain(transport)
    await waitFor(() => upstream.chats.length === 1, 'the first chat to start')

    const second = drain(transport)
    // Give the second request time to reach the traffic guard, then end the
    // first one so the queued attempt can actually run.
    await new Promise<void>((resolve) => setTimeout(resolve, 100))
    upstream.releaseAll()

    const [firstChunks, secondChunks] = await Promise.all([first, second])
    expect(upstream.chats.map((chat) => chat.pat)).toEqual([ALPHA.pat, ALPHA.pat])
    expect(switches).toEqual([])
    expect(firstChunks.some((chunk) => chunk.type === 'text-delta')).toBe(true)
    expect(secondChunks.some((chunk) => chunk.type === 'text-delta')).toBe(true)
  })
})
