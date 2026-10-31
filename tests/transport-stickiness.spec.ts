import { describe, expect, it } from 'vitest'
import {
  createToolResultMessage,
  createUserMessage,
  ToolCallId,
  type GenerateOptions,
  type StreamChunk,
} from '@deepseek-ai/dsh-llm'
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

/** A rate-limit refusal: one of these cools the account down in the ledger. */
function rateLimited(): Response {
  return new Response('', { status: 429 })
}

// ---------------------------------------------------------------------------
// Fake credential pool
// ---------------------------------------------------------------------------

interface Pool {
  hooks: QoderFailoverHooks
  switches: Array<{ fromId: string; toId: string; reason: string }>
  /** Silent adoptions: dispatch moves the host must know about but never report. */
  adopted: Array<{ fromId: string; toId: string; reason: 'cooling' }>
}

function pool(accounts: readonly { id: string; pat: string }[], active: { id: string; pat: string }): Pool {
  const switches: Array<{ fromId: string; toId: string; reason: string }> = []
  const adopted: Array<{ fromId: string; toId: string; reason: 'cooling' }> = []
  return {
    switches,
    adopted,
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
      async adopted(info) {
        adopted.push(info)
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

/**
 * A continuation STEP of the same turn: the previous step produced a tool call
 * and the host appended its result, so the last message is a tool result.
 */
function stepRequest(sessionId?: Session): GenerateOptions {
  return {
    provider: 'qoder-official',
    model: 'cmodel',
    messages: [
      createUserMessage({ content: [{ type: 'text', text: 'Hello' }], source: { kind: 'user' } }),
      createToolResultMessage({
        callId: ToolCallId('call-step'),
        content: [{ type: 'text', text: 'tool result' }],
        isError: false,
      }),
    ],
    ...sessionId === undefined ? {} : { sessionId },
  }
}

/**
 * The host's automatic session-title call, as its `frameMessages` helper
 * builds it: one user message framing the human messages as JSON. This exact
 * prefix is the only marker that survives the plugin's own shim translation.
 */
function titleRequest(sessionId?: Session): GenerateOptions {
  return {
    provider: 'qoder-official',
    model: 'cmodel',
    messages: [createUserMessage({
      content: [{ type: 'text', text: 'Generate the session title from this JSON array of human messages:\n[{"seq":1,"text":"Hello"}]' }],
      source: { kind: 'user' },
    })],
    ...sessionId === undefined ? {} : { sessionId },
  }
}

async function drain(transport: QoderTransport, sessionId?: Session): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = []
  for await (const chunk of transport.stream(request(sessionId))) chunks.push(chunk)
  return chunks
}

/** Run one continuation step of the current turn. */
async function drainStep(transport: QoderTransport, sessionId?: Session): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = []
  for await (const chunk of transport.stream(stepRequest(sessionId))) chunks.push(chunk)
  return chunks
}

/** Run the host's automatic session-title call. */
async function drainTitle(transport: QoderTransport, sessionId?: Session): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = []
  for await (const chunk of transport.stream(titleRequest(sessionId))) chunks.push(chunk)
  return chunks
}

/**
 * Consume a stream the way the production HTTP layer does.
 *
 * `src/upstream.ts` wraps the generator in an SSE encoder and closes the body
 * stream at the finish chunk instead of resuming the generator (or calling
 * `iterator.return()`), so the transport is never pulled past that chunk. A
 * plain `for await` — which every other test here uses — resumes the generator
 * after the terminal chunk, and that is the one code path production never
 * takes. Bookkeeping that only runs on resume is therefore invisible to
 * `for await`, which is exactly how a dead round counter passed review.
 */
async function drainLikeHttp(transport: QoderTransport, sessionId?: Session): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = []
  const iterator = transport.stream(request(sessionId))[Symbol.asyncIterator]()
  for (;;) {
    const step = await iterator.next()
    if (step.done === true) break
    chunks.push(step.value)
    if (step.value.type === 'finish') {
      await iterator.return?.()
      break
    }
  }
  return chunks
}

const SESSION = 'session-1' as Session

/**
 * The transport's pin table, as a value a test can assert on.
 *
 * The pin is the transport's own bookkeeping — there is no public accessor for
 * it, and there should not be: it is not part of the transport's contract. A
 * test still needs to distinguish "counted on the account that served" from
 * "counted on the account the request was pointed at", and the counters are the
 * only observable difference, so read the private table through a cast.
 */
function pinSnapshot(transport: QoderTransport): Array<{ id: string; requests: number; rounds: number }> {
  const table = (transport as unknown as {
    sessionPins: Map<string, { id: string; requests: number; rounds: number }>
  }).sessionPins
  return Array.from(table.values(), pin => ({ id: pin.id, requests: pin.requests, rounds: pin.rounds }))
}

/** Poll until `predicate` holds; a staged interleaving must never hang a test. */
async function waitFor(predicate: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 3_000
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`)
    await new Promise<void>(resolve => setTimeout(resolve, 5))
  }
}

// ---------------------------------------------------------------------------

describe('QoderTransport session stickiness', () => {
  it('is off when all three bounds are zero, so every request starts on the active account', async () => {
    const poolState = pool([ALPHA, BETA], ALPHA)
    const { transport, upstream } = harness({
      failover: poolState.hooks,
      stickiness: { enabled: () => true, rounds: () => 0, requests: () => 0, minutes: () => 0 },
      chat: pat => pat === ALPHA.pat ? unavailable() : accepted('from-b'),
    })

    await drain(transport, SESSION)
    await drain(transport, SESSION)

    // All-zero is the host's way of saying "no stickiness": no pin is written,
    // so every request starts on the active account and walks like before.
    expect(upstream.chatPats).toEqual([ALPHA.pat, BETA.pat, ALPHA.pat, BETA.pat])
  })

  it('is off when the master toggle is off, even with positive bounds', async () => {
    const poolState = pool([ALPHA, BETA], ALPHA)
    const { transport, upstream } = harness({
      failover: poolState.hooks,
      stickiness: { enabled: () => false, rounds: () => 5, requests: () => 200, minutes: () => 180 },
      chat: pat => pat === ALPHA.pat ? unavailable() : accepted('from-b'),
    })

    await drain(transport, SESSION)
    await drain(transport, SESSION)

    // The master switch gates everything: off means no pinning regardless of
    // the bounds, so every request starts on the active account as if the
    // three bounds were all zero.
    expect(upstream.chatPats).toEqual([ALPHA.pat, BETA.pat, ALPHA.pat, BETA.pat])
  })

  it('rotates the session to the next account once the round bound is reached', async () => {
    const poolState = pool([ALPHA, BETA], ALPHA)
    const { transport, upstream } = harness({
      failover: poolState.hooks,
      stickiness: { enabled: () => true, rounds: () => 1, requests: () => 0, minutes: () => 0 },
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
   * The round bound has to fire under the consumption shape production uses.
   *
   * `drainLikeHttp` stops at the finish chunk and abandons the generator, which
   * is what `src/upstream.ts` does in front of this transport. The counter used
   * to be incremented after `yield*`, so it only ever ran for a caller that
   * drained past the finish chunk — i.e. for tests, never for a real
   * conversation. This case fails if that regression comes back.
   */
  it('rotates on the round bound when the caller stops at the finish chunk, as the HTTP layer does', async () => {
    const poolState = pool([ALPHA, BETA], ALPHA)
    const { transport, upstream } = harness({
      failover: poolState.hooks,
      stickiness: { enabled: () => true, rounds: () => 1, requests: () => 0, minutes: () => 0 },
      chat: () => accepted('from-any'),
    })

    await drainLikeHttp(transport, SESSION)
    await drainLikeHttp(transport, SESSION)

    // Request 1 is Alpha's, and its answer really was consumed to the end: the
    // round bound of one is spent, so request 2 must start on the next account
    // of the walk. Before the fix this read [pt-a, pt-a].
    expect(upstream.chatPats).toEqual([ALPHA.pat, BETA.pat])
  })

  /**
   * ...and it must count exactly once, however the caller consumes the stream.
   *
   * A full `for await` resumes the generator after the finish chunk, so a
   * counter that ran both at the terminal chunk AND after `yield*` would charge
   * two rounds for one answer and rotate a request early.
   */
  it('counts one round per answer even when the caller drains past the finish chunk', async () => {
    const poolState = pool([ALPHA, BETA], ALPHA)
    const { transport, upstream } = harness({
      failover: poolState.hooks,
      stickiness: { enabled: () => true, rounds: () => 2, requests: () => 0, minutes: () => 0 },
      chat: () => accepted('from-any'),
    })

    await drain(transport, SESSION)
    await drain(transport, SESSION)
    await drain(transport, SESSION)

    // With a bound of two and one round per answer, the rotation lands on the
    // THIRD request. Doubling each answer would have rotated on the second.
    expect(upstream.chatPats).toEqual([ALPHA.pat, ALPHA.pat, BETA.pat])
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
      stickiness: { enabled: () => true, rounds: () => 1, requests: () => 0, minutes: () => 0 },
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

  /**
   * A turn is the user's message through its final answer, tool steps
   * included, so a bound reached MID-TURN must wait for the next turn. Before
   * the fix, "rounds" counted each completed model stream (each step), so a
   * multi-step turn rotated its session halfway through.
   */
  it('keeps a multi-step turn on one account even after the round bound is reached mid-turn', async () => {
    const poolState = pool([ALPHA, BETA], ALPHA)
    const { transport, upstream } = harness({
      failover: poolState.hooks,
      stickiness: { enabled: () => true, rounds: () => 1, requests: () => 0, minutes: () => 0 },
      chat: () => accepted('from-any'),
    })

    await drain(transport, SESSION) // turn 1, step 1: Alpha, one round spent
    await drainStep(transport, SESSION) // turn 1, step 2: same account
    await drainStep(transport, SESSION) // turn 1, step 3: same account
    await drain(transport, SESSION) // turn 2 opens: the bound is reached, rotate to Beta

    expect(upstream.chatPats).toEqual([ALPHA.pat, ALPHA.pat, ALPHA.pat, BETA.pat])
  })

  it('counts one round per turn regardless of how many steps it has', async () => {
    const poolState = pool([ALPHA, BETA], ALPHA)
    const { transport, upstream } = harness({
      failover: poolState.hooks,
      stickiness: { enabled: () => true, rounds: () => 2, requests: () => 0, minutes: () => 0 },
      chat: () => accepted('from-any'),
    })

    await drain(transport, SESSION) // turn 1, step 1 → round 1
    await drainStep(transport, SESSION)
    await drainStep(transport, SESSION)
    await drain(transport, SESSION) // turn 2 → round 2
    await drain(transport, SESSION) // turn 3: bound reached, rotate to Beta

    expect(upstream.chatPats).toEqual([ALPHA.pat, ALPHA.pat, ALPHA.pat, ALPHA.pat, BETA.pat])
  })

  it('does not let the automatic session-title request pin or spend any bound', async () => {
    const poolState = pool([ALPHA, BETA], ALPHA)
    const { transport, upstream } = harness({
      failover: poolState.hooks,
      stickiness: { enabled: () => true, rounds: () => 1, requests: () => 0, minutes: () => 0 },
      chat: () => accepted('from-any'),
    })

    await drainTitle(transport, SESSION) // bookkeeping: no pin, no round
    await drain(transport, SESSION) // turn 1: Alpha, round 1 spent
    await drain(transport, SESSION) // turn 2: bound reached, rotate to Beta

    expect(upstream.chatPats).toEqual([ALPHA.pat, ALPHA.pat, BETA.pat])
  })

  it('waits for the next turn to rotate on the request bound, even when steps cross it', async () => {
    const poolState = pool([ALPHA, BETA], ALPHA)
    const { transport, upstream } = harness({
      failover: poolState.hooks,
      stickiness: { enabled: () => true, rounds: () => 0, requests: () => 2, minutes: () => 0 },
      chat: () => accepted('from-any'),
    })

    await drain(transport, SESSION) // turn 1, step 1: requests = 1
    await drainStep(transport, SESSION) // turn 1, step 2: requests = 2
    await drainStep(transport, SESSION) // turn 1, step 3: requests = 3 — bound crossed mid-turn, no rotation
    await drain(transport, SESSION) // turn 2 opens: bound reached, rotate to Beta

    expect(upstream.chatPats).toEqual([ALPHA.pat, ALPHA.pat, ALPHA.pat, BETA.pat])
  })

  it('rotates on the request bound even when no round has been completed', async () => {
    const poolState = pool([ALPHA, BETA], ALPHA)
    const { transport, upstream } = harness({
      failover: poolState.hooks,
      stickiness: { enabled: () => true, rounds: () => 0, requests: () => 2, minutes: () => 0 },
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
      stickiness: { enabled: () => true, rounds: () => 0, requests: () => 0, minutes: () => 5 },
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
      stickiness: { enabled: () => true, rounds: () => 5, requests: () => 0, minutes: () => 0 },
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

  /**
   * A request dispatched to another account belongs to the account that ran it.
   *
   * The pin names the account the CONVERSATION is using, not the one it was
   * pointed at before dispatch. When the guard reports the pinned account busy,
   * the request starts elsewhere; leaving the pin behind would keep the skipped
   * account's request/round counters growing for work it never did, and the next
   * step of the same turn would walk straight back into the occupied account —
   * the exact collision the guard exists to avoid.
   */
  it('moves the session pin to the account that serves after a busy skip', async () => {
    const poolState = pool([ALPHA, BETA], ALPHA)
    let releaseHolder: () => void = () => {}
    const holderGate = new Promise<Response>((resolve) => {
      releaseHolder = (): void => resolve(accepted('holder'))
    })
    const { transport, upstream } = harness({
      failover: poolState.hooks,
      stickiness: { enabled: () => true, rounds: () => 5, requests: () => 0, minutes: () => 0 },
      chat: async (pat, call) => pat === ALPHA.pat && call === 2 ? await holderGate : accepted('from-any'),
    })

    await drain(transport, SESSION) // request 1: Alpha serves, the session pins there
    expect(pinSnapshot(transport)).toEqual([{ id: ALPHA.id, requests: 1, rounds: 1 }])

    // A concurrent request WITHOUT a session holds Alpha's traffic slot.
    const holder = drain(transport)
    await waitFor(() => upstream.chatPats.length === 2, 'the holder to occupy Alpha')

    // Request 2 of the session: pinned Alpha is busy, so it starts on Beta —
    // and the session must follow, because Beta is the account doing the work.
    await drain(transport, SESSION)
    expect(pinSnapshot(transport)).toEqual([{ id: BETA.id, requests: 1, rounds: 1 }])
    // The next step of the same turn stays on Beta instead of retrying the
    // occupied account.
    await drainStep(transport, SESSION)
    expect(upstream.chatPats.at(-1)).toBe(BETA.pat)
    // Still not a failover: nothing failed, so nothing is announced or adopted.
    expect(poolState.switches).toEqual([])
    expect(poolState.adopted).toEqual([])

    releaseHolder()
    await holder
  })

  /**
   * The same rule for a cooldown, which (unlike busy) IS a verdict on the
   * account: the session follows the serving account and the host is told to
   * adopt it silently, but no failover is reported.
   */
  it('moves the session pin to the account that serves after a cooling skip', async () => {
    const poolState = pool([ALPHA, BETA], ALPHA)
    const { transport, upstream } = harness({
      failover: poolState.hooks,
      stickiness: { enabled: () => true, rounds: () => 5, requests: () => 0, minutes: () => 0 },
      chat: (pat, call) => {
        // Alpha's second chat is a rate limit: the ledger cools it and the walk
        // recovers on Beta.
        if (pat === ALPHA.pat && call === 2) return rateLimited()
        return accepted('from-any')
      },
    })

    await drain(transport, SESSION) // request 1: Alpha serves, one round
    await drain(transport) // sessionless request: Alpha 429 → Beta serves, Alpha cools
    expect(poolState.switches.map(info => [info.fromId, info.toId])).toEqual([[ALPHA.id, BETA.id]])

    // Request 2 of the session: the pinned Alpha is cooling, so it starts on
    // Beta and the session follows.
    await drain(transport, SESSION)
    expect(pinSnapshot(transport)).toEqual([{ id: BETA.id, requests: 1, rounds: 1 }])
    // Cooling is a real verdict on the account, so the move is adopted — still
    // silently: a dispatch fact is not a failover.
    expect(poolState.adopted).toEqual([{ fromId: ALPHA.id, toId: BETA.id, reason: 'cooling' }])
    expect(poolState.switches).toHaveLength(1)
    await drainStep(transport, SESSION)
    expect(upstream.chatPats.at(-1)).toBe(BETA.pat)
  })

  it('keeps the session where it is when the pool has nobody to rotate to', async () => {
    const poolState = pool([ALPHA], ALPHA)
    const { transport, upstream } = harness({
      failover: poolState.hooks,
      stickiness: { enabled: () => true, rounds: () => 1, requests: () => 0, minutes: () => 0 },
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
      stickiness: { enabled: () => true, rounds: () => 5, requests: () => 0, minutes: () => 0 },
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
    /*
     * The transport's clock advances past any penalty window on every read.
     *
     * This test needs Alpha to keep being tried on every request (its subject
     * is pin eviction, and the Alpha→Beta walk is what re-pins each session),
     * while the T5 ledger would correctly retire Alpha for thirty minutes after
     * three landed hard failures. Advancing the clock keeps the ledger's
     * windows expired without touching the behaviour under test; a day per
     * read outruns even the six-hour ceiling the ladder reaches.
     */
    let clock = 1_700_000_000_000
    const { transport, upstream } = harness({
      failover: poolState.hooks,
      stickiness: { enabled: () => true, rounds: () => 100, requests: () => 0, minutes: () => 0 },
      now: () => (clock += 24 * 60 * 60 * 1000),
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
