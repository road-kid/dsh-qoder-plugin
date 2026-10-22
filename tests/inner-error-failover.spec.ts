import { describe, expect, it, vi } from 'vitest'
import { createUserMessage, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import {
  createQoderTransport,
  type QoderFailoverHooks,
  type QoderTransport,
  type QoderTransportOptions,
} from '../src/qoder/transport/index.ts'
import {
  qoderInnerErrorSnapshot,
  resetQoderInnerErrors,
} from '../src/qoder/transport/wire/inner-errors.ts'

/**
 * Transport-level ownership tests for the two error layers that share a chat
 * response.
 *
 * An HTTP status and an inner SSE chunk are different contracts:
 *
 * - HTTP 429 is the UPSTREAM refusing the request before any body arrived, so
 *   a different account may get a different answer — the pool must walk.
 * - A 200 stream whose body carries an inner error is a COMPLETED upstream
 *   response that merely narrates a model/provider failure inside it. The bytes
 *   were already accepted, the request was not rejected, and another account
 *   would have produced the same inner answer. Failover must not fire, and the
 *   stream's own terminal chunk must still be the single `finish`.
 *
 * T6 added the observer that counts these inner answers. Because the observer
 * sits in the SSE decoder, it is exactly the kind of change that could "help"
 * by turning a narrated error into a retryable rejection — these tests pin that
 * it does not, while the envelope-level rejection keeps its old semantics.
 */

const AMBIENT_PAT = 'pt-ambient'

function account(id: string, pat: string): { id: string; pat: string } {
  return { id, pat }
}

const ALPHA = account('acct-a', 'pt-a')
const BETA = account('acct-b', 'pt-b')

// ---------------------------------------------------------------------------
// Fake upstream
// ---------------------------------------------------------------------------

interface Upstream {
  fetch: typeof fetch
  chatPats: string[]
  exchanges: string[]
}

interface UpstreamSpec {
  chat(pat: string, call: number): Response | Promise<Response>
}

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
      return await spec.chat(pat, call)
    }
    throw new Error(`unexpected URL: ${url}`)
  }) as typeof fetch

  return { fetch: fetchImpl, chatPats, exchanges }
}

/** SSE envelope carrying one decoded inner chunk. */
function envelope(body: unknown): string {
  return `data: ${JSON.stringify({ statusCodeValue: 200, body: JSON.stringify(body) })}\n\n`
}

const done = 'data: [DONE]\n\n'

/**
 * A chat that COMPLETES successfully (HTTP 200) while its body narrates an
 * inner model failure, then streams content and the terminal chunk.
 */
function sseChatWithInnerError(error: unknown, text: string, requestId: string): Response {
  const content = JSON.stringify({ choices: [{ delta: { content: text } }] })
  const finish = JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })
  return new Response(
    [envelope(error), envelope(JSON.parse(content)), envelope(JSON.parse(finish)), done].join(''),
    { headers: { 'content-type': 'text/event-stream', 'x-request-id': requestId } },
  )
}

function sseChat(text: string): Response {
  const body = JSON.stringify({ choices: [{ delta: { content: text }, finish_reason: 'stop' }] })
  return new Response(`data: ${JSON.stringify({ statusCodeValue: 200, body })}\n\ndata: [DONE]\n\n`, {
    headers: { 'content-type': 'text/event-stream' },
  })
}

// ---------------------------------------------------------------------------
// Fake credential pool / harness (mirrors tests/transport-failover.spec.ts)
// ---------------------------------------------------------------------------

interface Pool {
  hooks: QoderFailoverHooks
  switches: Array<{ fromId: string; toId: string; reason: string }>
  nextCalls: string[]
}

function pool(accounts: readonly { id: string; pat: string }[]): Pool {
  const switches: Pool['switches'] = []
  const nextCalls: string[] = []
  return {
    switches,
    nextCalls,
    hooks: {
      enabled: () => true,
      activeAccount: async () => accounts[0],
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

interface Harness {
  transport: QoderTransport
  upstream: Upstream
  logs: { debug: unknown[][]; warn: unknown[][]; error: unknown[][] }
}

function harness(spec: UpstreamSpec, failover: QoderFailoverHooks): Harness {
  const fake = upstream(spec)
  const logs = { debug: [] as unknown[][], warn: [] as unknown[][], error: [] as unknown[][] }
  const logger = {
    debug: (...args: unknown[]) => logs.debug.push(args),
    warn: (...args: unknown[]) => logs.warn.push(args),
    error: (...args: unknown[]) => logs.error.push(args),
  }
  const options: QoderTransportOptions = {
    region: 'global',
    resolvePat: vi.fn(async () => AMBIENT_PAT),
    resolveMachineId: () => 'machine-test',
    fetch: fake.fetch,
    failover,
    logger,
  }
  return { transport: createQoderTransport(options), upstream: fake, logs }
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

function countLedger(classification: keyof ReturnType<typeof qoderInnerErrorSnapshot>): number {
  return qoderInnerErrorSnapshot()[classification]
}

const innerErrorWarnMessage = '[Qoder Stream] Inner error in stream'

// ---------------------------------------------------------------------------

describe('inner errors vs account failover', () => {
  it('does not fail over on a 200 stream that narrates an inner throttle', async () => {
    resetQoderInnerErrors()
    const before = countLedger('rate_limit')
    const poolState = pool([ALPHA, BETA])
    const { transport, upstream: fake, logs } = harness({
      chat: pat => pat === ALPHA.pat
        ? sseChatWithInnerError({ error: { code: 10605, message: 'queued behind a busy model' } }, 'partial', 'req-inner-1')
        : sseChat('from-b'),
    }, poolState.hooks)

    const chunks = await drain(transport)

    // The inner error was narrated INSIDE an accepted response: same account,
    // no second exchange, no walk, and the success still completes normally.
    expect(fake.chatPats).toEqual([ALPHA.pat])
    expect(fake.exchanges).toEqual([ALPHA.pat])
    expect(poolState.nextCalls).toEqual([])
    expect(poolState.switches).toEqual([])

    // Exactly one terminal chunk, and the content that preceded the failure is
    // still delivered — the observer must not swallow or fail the stream.
    expect(chunks.filter(chunk => chunk.type === 'finish')).toHaveLength(1)
    expect(chunks.some(chunk => chunk.type === 'text-delta' && chunk.text === 'partial')).toBe(true)

    // The ledger still saw the answer, and the WARN carried classification +
    // request id through the same production wiring.
    expect(countLedger('rate_limit')).toBe(before + 1)
    const warns = logs.warn.filter(args => args[0] === innerErrorWarnMessage)
    expect(warns).toHaveLength(1)
    expect(warns[0]?.[1]).toMatchObject({ classification: 'rate_limit', requestId: 'req-inner-1' })
  })

  it('does not fail over on a 200 stream that narrates a content-policy stop', async () => {
    resetQoderInnerErrors()
    const before = countLedger('content_policy')
    const poolState = pool([ALPHA, BETA])
    const { transport, upstream: fake } = harness({
      chat: pat => pat === ALPHA.pat
        ? sseChatWithInnerError({ error: { type: 'content_filter', message: 'sensitive content blocked' } }, 'refused', 'req-inner-2')
        : sseChat('from-b'),
    }, poolState.hooks)

    const chunks = await drain(transport)

    // A policy stop is a model-level verdict, not an account fault. Spending
    // Beta on the identical prompt would just burn a subscription.
    expect(fake.chatPats).toEqual([ALPHA.pat])
    expect(poolState.switches).toEqual([])
    expect(chunks.filter(chunk => chunk.type === 'finish')).toHaveLength(1)
    expect(countLedger('content_policy')).toBe(before + 1)
  })

  it('still fails over on an envelope-level 429 and leaves the inner ledger cold', async () => {
    resetQoderInnerErrors()
    const before = qoderInnerErrorSnapshot()
    const poolState = pool([ALPHA, BETA])
    const { transport, upstream: fake } = harness({
      chat: pat => pat === ALPHA.pat ? new Response('', { status: 429 }) : sseChat('from-b'),
    }, poolState.hooks)

    const chunks = await drain(transport)

    // The control case: a rejection OUTSIDE the stream is unchanged by T6 — it
    // walks the pool and succeeds on the next identity.
    expect(fake.chatPats).toEqual([ALPHA.pat, BETA.pat])
    expect(fake.exchanges).toEqual([ALPHA.pat, BETA.pat])
    expect(poolState.switches).toHaveLength(1)
    expect(poolState.switches[0]).toMatchObject({ fromId: ALPHA.id, toId: BETA.id })
    expect(poolState.switches[0]?.reason).toBe('upstream RATE_LIMIT (HTTP 429)')
    expect(chunks.filter(chunk => chunk.type === 'finish')).toHaveLength(1)
    expect(chunks.some(chunk => chunk.type === 'text-delta' && chunk.text === 'from-b')).toBe(true)
    expect({ ...qoderInnerErrorSnapshot() }).toEqual({ ...before })
  })
})
