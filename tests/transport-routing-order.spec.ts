import { describe, expect, it } from 'vitest'
import { createUserMessage, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { QoderLlmError } from '../src/qoder/errors.ts'
import {
  createQoderTransport,
  type QoderFailoverHooks,
  type QoderTransport,
  type QoderTransportOptions,
} from '../src/qoder/transport/index.ts'

/**
 * Offline tests for the routing strategy (路由策略: save order vs custom order).
 *
 * The custom list is user input, so the cases here are mostly about the ways it
 * can be wrong: it names an account that has been deleted, it names nobody at
 * all, it does not mention the account the request is currently on, or it
 * cycles. In every one of those the request has to keep going rather than turn
 * a typo into an outage.
 */

const AMBIENT_PAT = 'pt-ambient'

const ALPHA = { id: 'acct-a', pat: 'pt-a' }
const BETA = { id: 'acct-b', pat: 'pt-b' }
const GAMMA = { id: 'acct-c', pat: 'pt-c' }

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

interface PoolSpec {
  accounts: readonly { id: string; pat: string }[]
  active: { id: string; pat: string }
  /** Ids the host still knows about. Anything else has been removed. */
  known?: readonly string[]
}

interface Pool {
  hooks: QoderFailoverHooks
  switches: Array<{ fromId: string; toId: string; reason: string }>
  /** Ids `accountById` was asked to resolve, in order. */
  resolved: string[]
}

function pool(spec: PoolSpec): Pool {
  const known = new Set(spec.known ?? spec.accounts.map(account => account.id))
  const switches: Array<{ fromId: string; toId: string; reason: string }> = []
  const resolved: string[] = []
  return {
    switches,
    resolved,
    hooks: {
      enabled: () => true,
      activeAccount: async () => spec.active,
      async nextAccount(id) {
        // The host's own save order, one pass, no wrap: exactly the pre-routing
        // behaviour a custom strategy has to improve on without breaking.
        const index = spec.accounts.findIndex(account => account.id === id)
        return index === -1 ? undefined : spec.accounts[index + 1]
      },
      async switched(info) {
        switches.push(info)
      },
      async accountById(id) {
        resolved.push(id)
        return known.has(id) ? spec.accounts.find(account => account.id === id) : undefined
      },
    },
  }
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

function harness(spec: UpstreamSpec & {
  failover: QoderFailoverHooks
  strategy?: 'save-order' | 'custom'
  order?: string[]
}): { transport: QoderTransport; upstream: FakeUpstream } {
  const upstream = fakeUpstream(spec)
  return {
    transport: createQoderTransport({
      region: 'global',
      resolvePat: async () => AMBIENT_PAT,
      resolveMachineId: () => 'machine-test',
      fetch: upstream.fetch,
      failover: spec.failover,
      routing: { strategy: () => spec.strategy ?? 'save-order', order: () => spec.order ?? [] },
    }),
    upstream,
  }
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

describe('QoderTransport routing order', () => {
  it('ignores the configured list under the save-order strategy', async () => {
    const poolState = pool({ accounts: [ALPHA, BETA, GAMMA], active: ALPHA })
    const { transport, upstream } = harness({
      failover: poolState.hooks,
      strategy: 'save-order',
      // Present but not selected: a saved list must not leak into the strategy
      // the user actually chose.
      order: [GAMMA.id, BETA.id],
      chat: () => unavailable(),
    })

    const error = await drainError(transport)

    expect(upstream.chatPats).toEqual([ALPHA.pat, BETA.pat, GAMMA.pat])
    expect(poolState.resolved).toEqual([])
    expect((error as QoderLlmError).code).toBe('SERVER')
  })

  it('follows the custom list from just after the current account', async () => {
    const poolState = pool({ accounts: [ALPHA, BETA, GAMMA], active: ALPHA })
    const { transport, upstream } = harness({
      failover: poolState.hooks,
      strategy: 'custom',
      // Save order would say Beta; the user's list says Gamma next.
      order: [GAMMA.id, BETA.id, ALPHA.id],
      chat: pat => pat === ALPHA.pat ? unavailable() : accepted('from-c'),
    })

    const chunks = await drain(transport)

    expect(upstream.chatPats).toEqual([ALPHA.pat, GAMMA.pat])
    expect(chunks.some(chunk => chunk.type === 'text-delta' && chunk.text === 'from-c')).toBe(true)
    expect(poolState.switches.map(info => [info.fromId, info.toId])).toEqual([[ALPHA.id, GAMMA.id]])
  })

  it('starts at the head of the list when the current account is not in it', async () => {
    const poolState = pool({ accounts: [ALPHA, BETA, GAMMA], active: ALPHA })
    const { transport, upstream } = harness({
      failover: poolState.hooks,
      strategy: 'custom',
      // Alpha is absent, so there is nothing to be "after": the list head is
      // the honest answer, not the account following Alpha in save order.
      order: [GAMMA.id, BETA.id],
      chat: pat => pat === ALPHA.pat ? unavailable() : accepted('from-c'),
    })

    await drain(transport)

    expect(upstream.chatPats).toEqual([ALPHA.pat, GAMMA.pat])
  })

  it('skips an account the user has since removed', async () => {
    const poolState = pool({
      accounts: [ALPHA, BETA, GAMMA],
      active: BETA,
      // Gamma and Alpha survive; the deleted id is not in the known set.
      known: [ALPHA.id, GAMMA.id],
    })
    const { transport, upstream } = harness({
      failover: poolState.hooks,
      strategy: 'custom',
      order: ['ghost-removed', GAMMA.id, ALPHA.id],
      chat: pat => pat === BETA.pat ? unavailable() : accepted('from-c'),
    })

    await drain(transport)

    // The stale id is asked about once and then stepped over; the walk never
    // stops on a name the host cannot turn into a credential.
    expect(poolState.resolved).toEqual(['ghost-removed', GAMMA.id])
    expect(upstream.chatPats).toEqual([BETA.pat, GAMMA.pat])
  })

  it('falls back to save order when the list resolves to nobody', async () => {
    const poolState = pool({ accounts: [ALPHA, BETA], active: ALPHA, known: [] })
    const { transport, upstream } = harness({
      failover: poolState.hooks,
      strategy: 'custom',
      // A routing typo, not a policy: an unusable list must cost nothing.
      order: ['ghost-one', 'ghost-two'],
      chat: pat => pat === ALPHA.pat ? unavailable() : accepted('from-b'),
    })

    const chunks = await drain(transport)

    expect(upstream.chatPats).toEqual([ALPHA.pat, BETA.pat])
    expect(chunks.some(chunk => chunk.type === 'text-delta' && chunk.text === 'from-b')).toBe(true)
  })

  it('terminates on a list that cycles back to an account already tried', async () => {
    const poolState = pool({ accounts: [ALPHA, BETA], active: ALPHA })
    const { transport, upstream } = harness({
      failover: poolState.hooks,
      strategy: 'custom',
      // Names Alpha again after Beta. The walk must still make one pass and
      // stop: a custom order is a preference, never a licence to spin.
      order: [BETA.id, ALPHA.id],
      chat: () => unavailable(),
    })

    const error = await drainError(transport)

    expect(upstream.chatPats).toEqual([ALPHA.pat, BETA.pat])
    expect((error as QoderLlmError).code).toBe('SERVER')
  })
})
