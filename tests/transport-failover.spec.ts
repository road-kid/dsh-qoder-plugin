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
 * Offline tests for automatic next-account failover in the chat path.
 *
 * Everything here is scripted through an injected fake fetch: the pool, the
 * per-account chat answers, and the exact point in the request path where a
 * switch is (or is not) allowed to happen. What these cases pin down is the
 * COMPOSITION the user asked for — the account's own job-token self-heal runs
 * first, and only a failure it could not rescue spends a second identity.
 */

const AMBIENT_PAT = 'pt-ambient'

function account(id: string, pat: string): { id: string; pat: string } {
  return { id, pat }
}

const ALPHA = account('acct-a', 'pt-a')
const BETA = account('acct-b', 'pt-b')
const GAMMA = account('acct-c', 'pt-c')

// ---------------------------------------------------------------------------
// Fake upstream
// ---------------------------------------------------------------------------

interface Upstream {
  fetch: typeof fetch
  /** PAT whose credentials signed each chat call, in order. */
  chatPats: string[]
  /** PAT sent to the job-token exchange, in order. */
  exchanges: string[]
}

interface UpstreamSpec {
  /** The answer for the `call`-th (1-based) chat of the account holding `pat`. */
  chat(pat: string, call: number, init?: RequestInit): Response | Promise<Response>
}

/**
 * A Qoder stand-in that answers credentials and chat, and records which account
 * each chat was signed as.
 *
 * The chat is identified by the `Cosy-User` header, which is the job token's
 * owner — that is the only way to see, from outside the transport, which
 * account actually made the retry.
 */
function upstream(spec: UpstreamSpec): Upstream {
  const chatPats: string[] = []
  const exchanges: string[] = []
  const chatCounts = new Map<string, number>()
  const patOfUser = new Map<string, string>()

  const fetchImpl = (async (input: URL | Request | string, init?: RequestInit): Promise<Response> => {
    const url = String(input)
    if (url.includes('/jobToken/exchange')) {
      const body = JSON.parse(String(init?.body ?? '{}')) as { personal_token?: string }
      const pat = body.personal_token ?? ''
      exchanges.push(pat)
      return new Response(JSON.stringify({ token: `jt-${pat}` }))
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
      return await spec.chat(pat, call, init)
    }
    throw new Error(`unexpected URL: ${url}`)
  }) as typeof fetch

  return { fetch: fetchImpl, chatPats, exchanges }
}

/** One accepted chat, as the upstream sends it: an envelope carrying a delta. */
function sseChat(text: string): Response {
  const body = JSON.stringify({ choices: [{ delta: { content: text }, finish_reason: 'stop' }] })
  return new Response(`data: ${JSON.stringify({ statusCodeValue: 200, body })}\n\ndata: [DONE]\n\n`, {
    headers: { 'content-type': 'text/event-stream' },
  })
}

/**
 * The user's own report of a busy model (m00001), as the upstream sends it: a
 * 403 whose body nests the queue answer one level deeper.
 *
 * It is here because it classifies as `RATE_LIMIT` — the same code and status a
 * throttled ACCOUNT produces — which is precisely why the two must be told
 * apart before a pool walk spends a second identity on a busy model.
 */
function queueBody(retryAfterSeconds: number): string {
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
  return JSON.stringify({ code: '403', message: JSON.stringify({ code: '10605', message: inner, subCode: '' }) })
}

/**
 * A chat that delivers one delta and then stops speaking, without closing.
 *
 * Real fetch ties the body to the request signal, so the transport's idle
 * timeout can tear the read down; the fake has to do the same or the stall
 * would last until the test itself gives up.
 */
function chatThatStallsAfterFirstChunk(text: string, signal?: AbortSignal | null): Response {
  const body = JSON.stringify({ choices: [{ delta: { content: text } }] })
  const encoder = new TextEncoder()
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(`data: ${JSON.stringify({ statusCodeValue: 200, body })}\n\n`))
      signal?.addEventListener('abort', () => {
        controller.error(new DOMException('aborted', 'AbortError'))
      }, { once: true })
    },
  })
  return new Response(stream, { headers: { 'content-type': 'text/event-stream' } })
}

// ---------------------------------------------------------------------------
// Fake credential pool
// ---------------------------------------------------------------------------

interface Pool {
  hooks: QoderFailoverHooks
  switches: Array<{ fromId: string; toId: string; reason: string }>
  nextCalls: string[]
  /** How often the transport consulted the pool at all. */
  enabledCalls: () => number
  activeCalls: () => number
}

interface PoolSpec {
  /** Accounts in save order. */
  accounts: readonly { id: string; pat: string }[]
  /** Whether `nextAccount` wraps past the last account, as the store's list does. */
  wrap?: boolean
  enabled?: boolean
  /** Omit to model a signed-out/env-only variant, which has no pooled identity. */
  active?: { id: string; pat: string } | undefined
}

function pool(spec: PoolSpec): Pool {
  const switches: Array<{ fromId: string; toId: string; reason: string }> = []
  const nextCalls: string[] = []
  let enabledCalls = 0
  let activeCalls = 0
  const active = 'active' in spec ? spec.active : spec.accounts[0]

  return {
    switches,
    nextCalls,
    enabledCalls: () => enabledCalls,
    activeCalls: () => activeCalls,
    hooks: {
      enabled() {
        enabledCalls++
        return spec.enabled ?? true
      },
      async activeAccount() {
        activeCalls++
        return active
      },
      async nextAccount(id) {
        nextCalls.push(id)
        const index = spec.accounts.findIndex(candidate => candidate.id === id)
        if (index === -1) return undefined
        return spec.accounts[index + 1] ?? (spec.wrap === true ? spec.accounts[0] : undefined)
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

interface Harness {
  transport: QoderTransport
  upstream: Upstream
  /** The ambient credential source, which failover must bypass while a pool exists. */
  resolvePat: ReturnType<typeof vi.fn>
}

function harness(spec: UpstreamSpec & { failover?: QoderFailoverHooks; options?: Partial<QoderTransportOptions> }): Harness {
  const fake = upstream(spec)
  const resolvePat = vi.fn(async () => AMBIENT_PAT)
  const options: QoderTransportOptions = {
    region: 'global',
    resolvePat,
    resolveMachineId: () => 'machine-test',
    fetch: fake.fetch,
    ...spec.failover === undefined ? {} : { failover: spec.failover },
    ...spec.options ?? {},
  }
  return { transport: createQoderTransport(options), upstream: fake, resolvePat }
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

async function drainError(transport: QoderTransport): Promise<unknown> {
  try {
    await drain(transport)
    return undefined
  } catch (error: unknown) {
    return error
  }
}

// ---------------------------------------------------------------------------

describe('QoderTransport account failover', () => {
  it('retries the chat on the next account when the active one answers 5xx', async () => {
    const poolState = pool({ accounts: [ALPHA, BETA] })
    const { transport, upstream: fake, resolvePat } = harness({
      failover: poolState.hooks,
      chat: pat => pat === ALPHA.pat ? new Response('', { status: 503 }) : sseChat('from-b'),
    })

    const chunks = await drain(transport)

    expect(fake.chatPats).toEqual([ALPHA.pat, BETA.pat])
    expect(chunks.some(chunk => chunk.type === 'text-delta' && chunk.text === 'from-b')).toBe(true)
    expect(poolState.switches).toHaveLength(1)
    expect(poolState.switches[0]).toMatchObject({ fromId: ALPHA.id, toId: BETA.id })
    // The reason is a redacted classification, never the message and never the token.
    expect(poolState.switches[0]?.reason).toBe('upstream SERVER (HTTP 503)')
    expect(poolState.switches[0]?.reason).not.toContain(ALPHA.pat)
    // The hook owns the credential, so the ambient store was never consulted.
    expect(resolvePat).not.toHaveBeenCalled()
  })

  it('gives the failing account its own job-token self-heal before switching', async () => {
    const poolState = pool({ accounts: [ALPHA, BETA] })
    const { transport, upstream: fake } = harness({
      failover: poolState.hooks,
      chat: pat => pat === ALPHA.pat ? new Response('', { status: 401 }) : sseChat('from-b'),
    })

    const chunks = await drain(transport)

    // Initial call plus TWO paced self-heal rounds on the same account, and only
    // then the next identity: the heal is a property of the account, not of the
    // request, so switching first would spend a healthy account on a fault the
    // rejected one can still recover from.
    expect(fake.chatPats).toEqual([ALPHA.pat, ALPHA.pat, ALPHA.pat, BETA.pat])
    expect(chunks.some(chunk => chunk.type === 'text-delta' && chunk.text === 'from-b')).toBe(true)
    expect(poolState.switches[0]?.reason).toBe('upstream AUTH (HTTP 401)')
  }, 15_000)

  it('does not leave a self-heal success notice behind when the account is abandoned', async () => {
    const poolState = pool({ accounts: [ALPHA, BETA] })
    const refreshed = vi.fn()
    const { transport } = harness({
      failover: poolState.hooks,
      chat: pat => pat === ALPHA.pat ? new Response('', { status: 401 }) : sseChat('from-b'),
      options: { onJobTokenRefreshed: refreshed },
    })

    await drain(transport)

    // Alpha's rotation did not rescue Alpha's chat, so "the token was rotated
    // and the chat recovered" would be a lie even though the request as a whole
    // succeeded on the account that came next.
    expect(refreshed).not.toHaveBeenCalled()
  }, 15_000)

  it('switches and retries on a transient 418 that wraps an upstream provider fault', async () => {
    const poolState = pool({ accounts: [ALPHA, BETA] })
    const { transport, upstream: fake } = harness({
      failover: poolState.hooks,
      chat: pat => pat === ALPHA.pat ? new Response('', { status: 418 }) : sseChat('from-b'),
    })

    const chunks = await drain(transport)

    // 418 is the upstream packaging its own provider fault, not a request
    // error: another identity can clear it, so it must walk the pool. Before
    // the T1 fix every unlisted 4xx coded INVALID_REQUEST, which the transport
    // treats as "switching cannot help", so the second account was never tried.
    expect(fake.chatPats).toEqual([ALPHA.pat, BETA.pat])
    expect(chunks.some(chunk => chunk.type === 'text-delta' && chunk.text === 'from-b')).toBe(true)
    expect(poolState.switches).toHaveLength(1)
    expect(poolState.switches[0]).toMatchObject({ fromId: ALPHA.id, toId: BETA.id })
    expect(poolState.switches[0]?.reason).toBe('upstream TRANSIENT (HTTP 418)')
  })

  it('surfaces a persistently transient 418 without self-healing or leaking a token', async () => {
    // A realistic PAT length on purpose: the logger masks identifiers by
    // keeping their last four characters, which for a short fixture token would
    // reveal the whole secret and make the leak assertion meaningless.
    const secret = account('acct-secret', 'pt-very-secret-token-123456')
    const poolState = pool({ accounts: [secret] })
    const logger = { debug: vi.fn(), warn: vi.fn(), error: vi.fn() }
    const { transport, upstream: fake } = harness({
      failover: poolState.hooks,
      options: { logger },
      // The body is echoed verbatim into the diagnostic path when it is read;
      // nothing built from this failure may carry the job token that signed it.
      chat: () => new Response(`{"code":"provider_error","message":"Error in upstream response","token":"jt-${secret.pat}"}`, {
        status: 418,
        headers: { 'content-type': 'application/json' },
      }),
    })

    const error = await drainError(transport)

    expect(error).toBeInstanceOf(QoderLlmError)
    expect((error as QoderLlmError).code).toBe('TRANSIENT')
    expect((error as QoderLlmError).failure.status).toBe(418)
    // A transient fault is not an authorization rejection, so no job-token
    // exchange is spent on it: one strategy per failure class.
    expect(fake.exchanges).toEqual([secret.pat])
    expect(fake.chatPats).toEqual([secret.pat])
    // Single-account pool: the walk has nowhere to go, so the honest status is
    // thrown as-is rather than turned into a synthetic wait.
    expect(poolState.switches).toEqual([])
    expect((error as QoderLlmError).message).not.toContain(secret.pat)
    const logs = JSON.stringify([...logger.debug.mock.calls, ...logger.warn.mock.calls, ...logger.error.mock.calls])
    expect(logs).not.toContain(secret.pat)
  })

  it('switches on a rate-limit rejection, which the self-heal never claims', async () => {
    const poolState = pool({ accounts: [ALPHA, BETA] })
    const { transport, upstream: fake } = harness({
      failover: poolState.hooks,
      chat: pat => pat === ALPHA.pat ? new Response('', { status: 429 }) : sseChat('from-b'),
    })

    await drain(transport)

    expect(fake.chatPats).toEqual([ALPHA.pat, BETA.pat])
    // One exchange per account: a queue rejection is not an auth rejection, so
    // the second exchange is Beta's credentials, not a self-heal of Alpha's.
    expect(fake.exchanges).toEqual([ALPHA.pat, BETA.pat])
    expect(poolState.switches[0]?.reason).toBe('upstream RATE_LIMIT (HTTP 429)')
  })

  it('switches when the request never completed at all', async () => {
    const poolState = pool({ accounts: [ALPHA, BETA] })
    const { transport, upstream: fake } = harness({
      failover: poolState.hooks,
      chat: pat => pat === ALPHA.pat ? Promise.reject(new TypeError('fetch failed')) : sseChat('from-b'),
    })

    await drain(transport)

    // A dead connection is the class of failure another endpoint can survive;
    // the transport's own wrapper reports it as TRANSPORT, which is what makes
    // it failover-worthy rather than a request-level error.
    expect(fake.chatPats).toEqual([ALPHA.pat, BETA.pat])
    expect(poolState.switches[0]?.reason).toBe('upstream TRANSPORT')
  })

  it('does not switch on a queued model, so the notice is not swallowed by the pool', async () => {
    const poolState = pool({ accounts: [ALPHA, BETA] })
    const { transport, upstream: fake } = harness({
      failover: poolState.hooks,
      chat: () => new Response(queueBody(30), { status: 403, headers: { 'content-type': 'application/json' } }),
    })

    const error = await drainError(transport)

    // A second account cannot queue-jump a busy model. Walking the pool here
    // would spend Beta's subscription on the same answer and — since a switch
    // reports the previous condition over — delete the notice the answer is
    // supposed to produce. One attempt, no switch, facts intact.
    expect(error).toBeInstanceOf(QoderLlmError)
    expect((error as QoderLlmError).code).toBe('RATE_LIMIT')
    expect((error as QoderLlmError).qoderQueue?.isQueued).toBe(true)
    expect(fake.chatPats).toEqual([ALPHA.pat])
    expect(poolState.nextCalls).toEqual([])
    expect(poolState.switches).toEqual([])
  })

  it('keeps a zero-second queue advice from arriving as a transport failure', async () => {
    const poolState = pool({ accounts: [ALPHA, BETA] })
    const { transport, upstream: fake } = harness({
      failover: poolState.hooks,
      chat: () => new Response(queueBody(0), { status: 403, headers: { 'content-type': 'application/json' } }),
    })

    const error = await drainError(transport)

    // "retry after 0 seconds" is advice to retry now, not a wait window. Sent
    // on as providerRetryAfterMs it made the host's own error constructor
    // throw, which the transport then reported as a connection failure: wrong
    // reason, no notice, and a second account spent on a classified answer.
    expect(error).toBeInstanceOf(QoderLlmError)
    expect((error as QoderLlmError).code).toBe('RATE_LIMIT')
    expect((error as QoderLlmError).failure.providerRetryAfterMs).toBeUndefined()
    expect(fake.chatPats).toEqual([ALPHA.pat])
    expect(poolState.switches).toEqual([])
  })

  it('does not switch on a rejected request', async () => {
    const poolState = pool({ accounts: [ALPHA, BETA] })
    const { transport, upstream: fake } = harness({
      failover: poolState.hooks,
      chat: () => new Response('', { status: 400 }),
    })

    const error = await drainError(transport)

    // A malformed request fails identically on every account: switching would
    // only obscure the real error and adopt an identity nobody needed.
    expect(error).toBeInstanceOf(QoderLlmError)
    expect((error as QoderLlmError).code).toBe('INVALID_REQUEST')
    expect(fake.chatPats).toEqual([ALPHA.pat])
    expect(poolState.nextCalls).toEqual([])
    expect(poolState.switches).toEqual([])
  })

  it('does not switch once a chunk has been forwarded', async () => {
    const poolState = pool({ accounts: [ALPHA, BETA] })
    const { transport, upstream: fake } = harness({
      failover: poolState.hooks,
      options: { streamIdleTimeoutMs: 50 },
      chat: (pat, _call, init) => pat === ALPHA.pat
        ? chatThatStallsAfterFirstChunk('partial', init?.signal)
        : sseChat('from-b'),
    })

    const chunks: StreamChunk[] = []
    let failure: unknown
    try {
      for await (const chunk of transport.stream(request())) chunks.push(chunk)
    } catch (error: unknown) {
      failure = error
    }

    // Beta is healthy and would have answered, but Alpha already handed bytes to
    // the consumer: those cannot be unsent, so a switch would duplicate output
    // rather than recover the stream.
    expect(chunks.length).toBeGreaterThan(0)
    expect(failure).toBeInstanceOf(QoderLlmError)
    expect((failure as QoderLlmError).code).toBe('TIMEOUT')
    expect(fake.chatPats).toEqual([ALPHA.pat])
    expect(poolState.switches).toEqual([])
  })

  it('walks the pool once and surfaces the last failure instead of cycling', async () => {
    const poolState = pool({ accounts: [ALPHA, BETA, GAMMA], wrap: true })
    const { transport, upstream: fake } = harness({
      failover: poolState.hooks,
      chat: () => new Response('', { status: 503 }),
    })

    const error = await drainError(transport)

    expect(fake.chatPats).toEqual([ALPHA.pat, BETA.pat, GAMMA.pat])
    expect(poolState.switches.map(info => [info.fromId, info.toId])).toEqual([
      [ALPHA.id, BETA.id],
      [BETA.id, GAMMA.id],
    ])
    // The third consultation asks for the account after Gamma; the wrap hands
    // back Alpha, which has already been tried, and the walk stops there.
    expect(poolState.nextCalls).toEqual([ALPHA.id, BETA.id, GAMMA.id])
    expect((error as QoderLlmError).code).toBe('SERVER')
  })

  it('stops when the pool has no further account', async () => {
    const poolState = pool({ accounts: [ALPHA, BETA] })
    const { transport, upstream: fake } = harness({
      failover: poolState.hooks,
      chat: () => new Response('', { status: 502 }),
    })

    const error = await drainError(transport)

    expect(fake.chatPats).toEqual([ALPHA.pat, BETA.pat])
    expect(poolState.switches).toHaveLength(1)
    expect((error as QoderLlmError).code).toBe('SERVER')
  })

  it('leaves the request path untouched when there is no pooled account', async () => {
    const poolState = pool({ accounts: [ALPHA, BETA], active: undefined })
    const { transport, upstream: fake, resolvePat } = harness({
      failover: poolState.hooks,
      chat: () => new Response('', { status: 503 }),
    })

    const error = await drainError(transport)

    // An env-only credential has no identity to advance FROM, so `nextAccount`
    // has nothing to be given: the ambient resolution is the whole answer.
    expect(fake.chatPats).toEqual([AMBIENT_PAT])
    expect(resolvePat).toHaveBeenCalled()
    expect(poolState.nextCalls).toEqual([])
    expect((error as QoderLlmError).code).toBe('SERVER')
  })

  it('reproduces the pre-failover failure exactly when switching is off or absent', async () => {
    const disabledPool = pool({ accounts: [ALPHA, BETA], enabled: false })
    const disabled = harness({
      failover: disabledPool.hooks,
      chat: () => new Response('', { status: 503 }),
    })
    const absent = harness({ chat: () => new Response('', { status: 503 }) })

    const disabledError = await drainError(disabled.transport)
    const absentError = await drainError(absent.transport)

    expect(disabled.upstream.chatPats).toEqual([AMBIENT_PAT])
    expect(disabled.resolvePat).toHaveBeenCalledTimes(1)
    // Off is not "consult the pool and decline"; it is the old path, so the pool
    // is never even asked which account is active.
    expect(disabledPool.activeCalls()).toBe(0)
    expect(disabledPool.switches).toEqual([])
    expect((disabledError as QoderLlmError).code).toBe((absentError as QoderLlmError).code)
    expect((disabledError as QoderLlmError).message).toBe((absentError as QoderLlmError).message)
  })
})

describe('QoderTransport account penalties (blame deferred)', () => {
  it('cools the failing account once another account serves the request', async () => {
    const poolState = pool({ accounts: [ALPHA, BETA] })
    const { transport, upstream: fake } = harness({
      failover: poolState.hooks,
      // A soft rate limit is a penalty on the first offence: the account was
      // throttled while another identity served the same request, so there is
      // no need to collect three failures before cooling it.
      chat: pat => pat === ALPHA.pat ? new Response('', { status: 429 }) : sseChat('from-b'),
    })

    const chunks = await drain(transport)
    expect(chunks.some(chunk => chunk.type === 'text-delta' && chunk.text === 'from-b')).toBe(true)

    // Beta serving the very same request is the evidence that Alpha's failure
    // was Alpha's problem, so the walk that just ended is allowed to blame it.
    // The next request must not start on the account the ledger is cooling down.
    await drain(transport)

    expect(fake.chatPats).toEqual([ALPHA.pat, BETA.pat, BETA.pat])
    expect(poolState.switches.map(info => [info.fromId, info.toId, info.reason])).toEqual([
      [ALPHA.id, BETA.id, 'upstream RATE_LIMIT (HTTP 429)'],
      [ALPHA.id, BETA.id, 'account cooling down after repeated failures'],
    ])
  })

  it('punishes nobody when the whole pool fails', async () => {
    const poolState = pool({ accounts: [ALPHA, BETA] })
    const { transport, upstream: fake } = harness({
      failover: poolState.hooks,
      chat: () => new Response('', { status: 503 }),
    })

    const firstError = await drainError(transport)
    expect((firstError as QoderLlmError).code).toBe('SERVER')
    // No account served the request, so neither failure has been exonerated:
    // the pending blame is discarded rather than burning both accounts.
    const secondError = await drainError(transport)
    expect((secondError as QoderLlmError).code).toBe('SERVER')

    expect(fake.chatPats).toEqual([ALPHA.pat, BETA.pat, ALPHA.pat, BETA.pat])
    // No proactive "cooling" switch: the second walk starts on Alpha exactly as
    // the first one did.
    expect(poolState.switches.map(info => info.reason)).toEqual([
      'upstream SERVER (HTTP 503)',
      'upstream SERVER (HTTP 503)',
    ])
  })

  it('clears the penalty once the account serves a request again', async () => {
    const switches: Array<{ fromId: string; toId: string; reason: string }> = []
    let accounts: Array<{ id: string; pat: string }> = [ALPHA, BETA]
    let active: { id: string; pat: string } = ALPHA
    // A small host stand-in that adopts the switch like the real one does, and
    // whose pool the test can reshape between requests.
    const failover: QoderFailoverHooks = {
      enabled: () => true,
      async activeAccount() {
        return active
      },
      async nextAccount(id) {
        const index = accounts.findIndex(candidate => candidate.id === id)
        if (index === -1) return undefined
        return accounts[index + 1]
      },
      async switched(info) {
        switches.push(info)
        active = accounts.find(candidate => candidate.id === info.toId) ?? active
      },
    }
    const { transport, upstream: fake } = harness({
      failover,
      // Alpha is refused on the first request, then serves the later ones.
      chat: (pat, call) => pat === ALPHA.pat && call === 1
        ? new Response('', { status: 429 })
        : sseChat(`from-${pat}`),
    })

    await drain(transport)
    expect(fake.chatPats).toEqual([ALPHA.pat, BETA.pat])

    // Alpha is left alone in the pool, so the cooling skip has no alternative:
    // the request runs on Alpha anyway, its success clears the ledger, and the
    // following two-account request must start on it again.
    accounts = [ALPHA]
    active = ALPHA
    await drain(transport)
    accounts = [ALPHA, BETA]
    await drain(transport)

    expect(fake.chatPats).toEqual([ALPHA.pat, BETA.pat, ALPHA.pat, ALPHA.pat])
    expect(switches).toHaveLength(1)
  })
})
