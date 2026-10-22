import { describe, expect, it } from 'vitest'
import { createUserMessage, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { sessionPinCapacity } from '../src/qoder/transport/default-transport.ts'
import {
  createQoderTransport,
  type QoderFailoverHooks,
  type QoderTransport,
  type QoderTransportOptions,
} from '../src/qoder/transport/index.ts'

/**
 * Offline tests for session stickiness (会话粘性: rounds + requests + minutes).
 *
 * Stickiness is a ROTATION, not a lock: one account serves a conversation until
 * any of its three bounds is reached, and the next request of that conversation
 * then starts on the NEXT account of the walk order. The cases here check both
 * halves — that a bound really moves the session on, and that reaching a bound
 * never strands the session on the account it just outgrew.
 */

const AMBIENT_PAT = 'pt-ambient'

const ALPHA = { id: 'acct-a', pat: 'pt-a' }
const BETA = { id: 'acct-b', pat: 'pt-b' }
const GAMMA = { id: 'acct-c', pat: 'pt-c' }

type Session = GenerateOptions['sessionId']

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

/** The account refuses to serve, which is what makes the walk move on. */
function unavailable(): Response {
  return new Response('', { status: 503 })
}

// ---------------------------------------------------------------------------
// Fake credential pool
// ---------------------------------------------------------------------------

interface Pool {
  hooks: QoderFailoverHooks
  switches: Array<{ fromId: string; toId: string; reason: string }>
}

function pool(accounts: readonly { id: string; pat: string }[], active: { id: string; pat: string }): Pool {
  const switches: Array<{ fromId: string; toId: string; reason: string }> = []
  return {
    switches,
    hooks: {
      enabled: () => true,
      activeAccount: async () => active,
      /*
       * Wraps around the pool, exactly like the host's `nextAfter`: it returns
       * the id AFTER `id` in a circular list, so the walk can reach every
       * account including the ones saved before it. A pool of one has no
       * successor at all.
       */
      async nextAccount(id) {
        const index = accounts.findIndex(candidate => candidate.id === id)
        if (index === -1) return accounts[0]
        if (accounts.length < 2) return undefined
        return accounts[(index + 1) % accounts.length]
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
  failover: QoderFailoverHooks
  stickiness?: QoderTransportOptions['stickiness']
  now?: () => number
}): { transport: QoderTransport; upstream: FakeUpstream } {
  const upstream = fakeUpstream(spec)
  return {
    transport: createQoderTransport({
      region: 'global',
      resolvePat: async () => AMBIENT_PAT,
      resolveMachineId: () => 'machine-test',
      fetch: upstream.fetch,
      failover: spec.failover,
      ...spec.stickiness === undefined ? {} : { stickiness: spec.stickiness },
      ...spec.now === undefined ? {} : { now: spec.now },
    }),
    upstream,
  }
}

function request(sessionId?: Session): GenerateOptions {
  return {
    provider: 'qoder-official',
    model: 'cmodel',
    messages: [createUserMessage({ content: [{ type: 'text', text: 'Hello' }], source: { kind: 'user' } })],
    ...sessionId === undefined ? {} : { sessionId },
  }
}

async function drain(transport: QoderTransport, sessionId?: Session): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = []
  for await (const chunk of transport.stream(request(sessionId))) chunks.push(chunk)
  return chunks
}

const SESSION = 'session-1' as Session

// ---------------------------------------------------------------------------

describe('QoderTransport session stickiness', () => {
  it('is off when all three bounds are zero, so every request starts on the active account', async () => {
    const poolState = pool([ALPHA, BETA], ALPHA)
    const { transport, upstream } = harness({
      failover: poolState.hooks,
      stickiness: { rounds: () => 0, requests: () => 0, minutes: () => 0 },
      chat: pat => pat === ALPHA.pat ? unavailable() : accepted('from-b'),
    })

    await drain(transport, SESSION)
    await drain(transport, SESSION)

    // All-zero is the host's way of saying "no stickiness": no pin is written,
    // so every request starts on the active account and walks like before.
    expect(upstream.chatPats).toEqual([ALPHA.pat, BETA.pat, ALPHA.pat, BETA.pat])
  })

  it('rotates the session to the next account once the round bound is reached', async () => {
    const poolState = pool([ALPHA, BETA], ALPHA)
    const { transport, upstream } = harness({
      failover: poolState.hooks,
      stickiness: { rounds: () => 1, requests: () => 0, minutes: () => 0 },
      chat: pat => pat === ALPHA.pat ? unavailable() : accepted('from-b'),
    })

    await drain(transport, SESSION)
    await drain(transport, SESSION)
    await drain(transport, SESSION)

    // Request 1: Alpha refuses, the walk lands on Beta, and Beta's answer is
    // read to the end — one completed round.
    // Request 2: the round bound is reached, so the session MOVES ON to the
    // next account, which is Alpha; Alpha refuses again and Beta serves.
    // Request 3: same rotation, one step further round the two-account pool.
    //
    // The point is the SECOND chat of requests 2 and 3: the session left Beta
    // on its own and came back through the walk, instead of staying there
    // forever because the bound only dropped the pin.
    expect(upstream.chatPats).toEqual([ALPHA.pat, BETA.pat, ALPHA.pat, BETA.pat, ALPHA.pat, BETA.pat])
  })

  /**
   * A failed request is not a round.
   *
   * The round counter is the one thing stickiness must not inflate: a request
   * that produced no output and no output consumed to the end cannot have
   * served a conversation, so it must not spend the round bound. The walk
   * still moves the session when an account fails (that is failover, not
   * stickiness) — so the observable difference is which account the NEXT
   * request starts on after a bound would have been reached.
   */
  it('does not count a failed request as a completed round', async () => {
    const failing = pool([ALPHA, BETA], ALPHA)
    const failingHarness = harness({
      failover: failing.hooks,
      stickiness: { rounds: () => 1, requests: () => 0, minutes: () => 0 },
      // Nobody serves: every request exhausts the whole pool and throws.
      chat: () => unavailable(),
    })

    await expect(drain(failingHarness.transport, SESSION)).rejects.toThrow()
    const before = failingHarness.upstream.chatPats.length
    await expect(drain(failingHarness.transport, SESSION)).rejects.toThrow()

    // Both requests fail on Alpha, so the walk moves the session to Beta — and
    // nothing ever completes a round, so the round bound never fires. The
    // second request therefore starts on Beta (where failover left it) and
    // still walks back round to Alpha. Were the failed attempt counted as a
    // round, the rotation would have moved the session OFF Beta first.
    expect(failingHarness.upstream.chatPats.slice(before)).toEqual([BETA.pat, ALPHA.pat])
  })

  it('rotates on the request bound even when no round has been completed', async () => {
    const poolState = pool([ALPHA, BETA], ALPHA)
    const { transport, upstream } = harness({
      failover: poolState.hooks,
      stickiness: { rounds: () => 0, requests: () => 2, minutes: () => 0 },
      chat: pat => pat === ALPHA.pat ? unavailable() : accepted('from-b'),
    })

    await drain(transport, SESSION)
    await drain(transport, SESSION)
    await drain(transport, SESSION)

    // Request 1: Alpha refuses, the walk lands on Beta, and the pin moves with
    // it — its counters start at zero on Beta, because the request that ran on
    // Alpha was Alpha's, not Beta's.
    // Request 2: the second request against Beta, so the request bound of 2 is
    // now spent.
    // Request 3: the pin is exhausted, so the session rotates to the next
    // account — Alpha — which refuses again and hands back to Beta.
    expect(upstream.chatPats).toEqual([ALPHA.pat, BETA.pat, BETA.pat, ALPHA.pat, BETA.pat])
  })

  it('rotates on the wall-clock minute bound', async () => {
    const poolState = pool([ALPHA, BETA], ALPHA)
    let clock = 1_000_000
    const { transport, upstream } = harness({
      failover: poolState.hooks,
      stickiness: { rounds: () => 0, requests: () => 0, minutes: () => 5 },
      now: () => clock,
      chat: pat => pat === ALPHA.pat ? unavailable() : accepted('from-b'),
    })

    await drain(transport, SESSION)
    clock += 4 * 60_000
    await drain(transport, SESSION)
    clock += 2 * 60_000
    await drain(transport, SESSION)

    // Four minutes later the pin still holds, so request 2 starts on Beta. By
    // minute six the bound is reached: request 3 rotates to the next account,
    // which is Alpha, and the walk recovers to Beta again.
    expect(upstream.chatPats).toEqual([ALPHA.pat, BETA.pat, BETA.pat, ALPHA.pat, BETA.pat])
  })

  it('follows a failover switch instead of dragging the session back to the dead account', async () => {
    const poolState = pool([ALPHA, BETA, GAMMA], ALPHA)
    const { transport, upstream } = harness({
      failover: poolState.hooks,
      stickiness: { rounds: () => 5, requests: () => 0, minutes: () => 0 },
      // Alpha never serves; Beta fails once, then serves. The walk therefore
      // ends this session on Gamma, two accounts away from where it started.
      chat: (pat, call) => {
        if (pat === ALPHA.pat) return unavailable()
        if (pat === BETA.pat && call === 1) return unavailable()
        return accepted('from-c')
      },
    })

    await drain(transport, SESSION)
    await drain(transport, SESSION)

    // Request 2 starts on Gamma — the account the walk actually reached — not
    // on the pinned Alpha it began with. A pin that ignored the switch would
    // send every later turn back to a dead account, once per request.
    expect(upstream.chatPats).toEqual([ALPHA.pat, BETA.pat, GAMMA.pat, GAMMA.pat])
    expect(poolState.switches.map(info => [info.fromId, info.toId])).toEqual([
      [ALPHA.id, BETA.id],
      [BETA.id, GAMMA.id],
    ])
  })

  it('keeps the session where it is when the pool has nobody to rotate to', async () => {
    const poolState = pool([ALPHA], ALPHA)
    const { transport, upstream } = harness({
      failover: poolState.hooks,
      stickiness: { rounds: () => 1, requests: () => 0, minutes: () => 0 },
      chat: () => accepted('from-a'),
    })

    await drain(transport, SESSION)
    await drain(transport, SESSION)
    await drain(transport, SESSION)

    // A pool of one has no successor, so the bound is reached and there is
    // nowhere to go. The session must stay on its account, and must not spend
    // every later request re-examining a bound it can never satisfy.
    expect(upstream.chatPats).toEqual([ALPHA.pat, ALPHA.pat, ALPHA.pat])
  })

  it('never pins a request that carries no session id', async () => {
    const poolState = pool([ALPHA, BETA], ALPHA)
    const { transport, upstream } = harness({
      failover: poolState.hooks,
      stickiness: { rounds: () => 5, requests: () => 0, minutes: () => 0 },
      chat: pat => pat === ALPHA.pat ? unavailable() : accepted('from-b'),
    })

    await drain(transport)
    await drain(transport)

    // There is no session to be sticky for, so both requests start on the
    // active account. Pinning under a synthetic id would silently make every
    // sessionless caller share one account.
    expect(upstream.chatPats).toEqual([ALPHA.pat, BETA.pat, ALPHA.pat, BETA.pat])
  })

  it('evicts the oldest session once the pin table is full', async () => {
    const poolState = pool([ALPHA, BETA], ALPHA)
    const { transport, upstream } = harness({
      failover: poolState.hooks,
      stickiness: { rounds: () => 100, requests: () => 0, minutes: () => 0 },
      chat: pat => pat === ALPHA.pat ? unavailable() : accepted('from-b'),
    })

    // One more live session than the table can hold, so the very first one is
    // evicted. Each request's two chats (Alpha, then Beta) are what re-pins it.
    for (let index = 0; index <= sessionPinCapacity; index++) {
      await drain(transport, `session-${index}` as Session)
    }

    // Control first: a session still inside the table goes straight to Beta.
    const beforeControl = upstream.chatPats.length
    await drain(transport, 'session-1' as Session)
    const pinned = upstream.chatPats.slice(beforeControl)

    // The first session was pushed out by the ones that followed it, so it has
    // to rediscover its account from the active one.
    const beforeRevisit = upstream.chatPats.length
    await drain(transport, 'session-0' as Session)
    const evicted = upstream.chatPats.slice(beforeRevisit)

    // The bound costs memory, never correctness — and a host that runs for
    // months cannot grow the table without limit. (Revisiting the evicted
    // session re-enters it and costs the next-oldest its pin; that is what a
    // bounded table does, and it is why the control is read first.)
    expect(pinned).toEqual([BETA.pat])
    expect(evicted).toEqual([ALPHA.pat, BETA.pat])
  })
})
