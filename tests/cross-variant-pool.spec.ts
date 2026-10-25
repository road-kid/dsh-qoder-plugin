import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createUserMessage, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import {
  adoptPooledAccount,
  autoFailoverActive,
  poolOrder,
  pooledAccountById,
  pooledNextAccount,
  poolRing,
  poolSeatFlags,
  type PoolMember,
} from '../src/index.ts'
import { QoderCredentialStore, qoderCredentialIdentity } from '../src/auth.ts'
import { createQoderTransport, type QoderFailoverHooks, type QoderTransport } from '../src/qoder/transport/index.ts'
import { getQoderChatUrl, getQoderExchangeUrl } from '../src/qoder/transport/endpoints.ts'
import { CHINA_VARIANT, GLOBAL_VARIANT } from '../src/variants.ts'

/**
 * The cross-variant account pool: one walk that spans BOTH credential files.
 *
 * Each variant keeps its own document and its own endpoints, and a row is only
 * ever signed by the endpoint set of the region it was saved under. What these
 * cases pin is the pool's contract on top of that: the walk continues from one
 * file into the other, the owning file's active pointer moves on a switch, and
 * no PAT is ever presented to the other region's host — the mechanical wall the
 * old per-file pool hit at every cross-region hand-off.
 */

const CLEANUP: (() => Promise<void>)[] = []

afterEach(async () => {
  await Promise.all(CLEANUP.splice(0).map(clean => clean()))
  vi.restoreAllMocks()
})

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'qoder-pool-'))
  CLEANUP.push(() => rm(dir, { recursive: true, force: true }))
  return dir
}

const CN_PAT = 'pt-cn-0000000000000000aaaa'
const GLOBAL_PAT = 'pt-global-000000000000bbbb'
const CN_SPARE_PAT = 'pt-cn-spare-0000000000cccc'

interface TwoFiles {
  members: readonly PoolMember[]
  cn: QoderCredentialStore
  global: QoderCredentialStore
}

/**
 * Two real credential stores over their own temp files, as one pool.
 *
 * The real stores are used rather than stand-ins because the whole point of
 * the pool is the two files' own semantics — the region stamp on each row, the
 * per-file active pointer, the park flag — and a fake would let a bug in those
 * semantics pass.
 */
async function twoFiles(seed: {
  cn?: readonly string[]
  global?: readonly string[]
  activeCN?: string
  activeGlobal?: string
} = {}): Promise<TwoFiles> {
  const dir = await tempDir()
  const cn = new QoderCredentialStore({ variant: CHINA_VARIANT, ownPath: join(dir, 'cn.json') })
  const global = new QoderCredentialStore({ variant: GLOBAL_VARIANT, ownPath: join(dir, 'global.json') })
  for (const pat of seed.cn ?? [CN_PAT]) await cn.save(pat)
  for (const pat of seed.global ?? [GLOBAL_PAT]) await global.save(pat)
  if (seed.activeCN !== undefined) await cn.activate(qoderCredentialIdentity({ pat: seed.activeCN }))
  if (seed.activeGlobal !== undefined) await global.activate(qoderCredentialIdentity({ pat: seed.activeGlobal }))
  const members: readonly PoolMember[] = [
    { variant: { id: CHINA_VARIANT.id }, store: cn },
    { variant: { id: GLOBAL_VARIANT.id }, store: global },
  ]
  return { members, cn, global }
}

// ---------------------------------------------------------------------------
// Pool shape
// ---------------------------------------------------------------------------

describe('cross-variant pool: order and reach', () => {
  it('walks its own file first, then the sibling', async () => {
    const { members } = await twoFiles()

    const fromChina = poolOrder(() => members, { id: CHINA_VARIANT.id })
    const fromGlobal = poolOrder(() => members, { id: GLOBAL_VARIANT.id })

    expect(fromChina.map(member => member.variant.id)).toEqual([CHINA_VARIANT.id, GLOBAL_VARIANT.id])
    // The pool is symmetric: each side sees itself first, which is what keeps a
    // single-region install resolving exactly the store it always did.
    expect(fromGlobal.map(member => member.variant.id)).toEqual([GLOBAL_VARIANT.id, CHINA_VARIANT.id])
  })

  it('continues from the end of one file into the other instead of wrapping home', async () => {
    const { members } = await twoFiles({ cn: [CN_PAT], global: [GLOBAL_PAT] })
    const order = poolOrder(() => members, { id: CHINA_VARIANT.id })
    const cnId = qoderCredentialIdentity({ pat: CN_PAT })
    const globalId = qoderCredentialIdentity({ pat: GLOBAL_PAT })

    const ring = await poolRing(order)
    expect(ring.map(account => account.id)).toEqual([cnId, globalId])
    // The region stamp rides each seat: it is what tells the transport which
    // endpoint set may sign the credential.
    expect(ring.map(account => account.region)).toEqual(['china', 'global'])

    // The save-order leg used to wrap inside its own document here, so the
    // sibling account was never reached at all.
    expect((await pooledNextAccount(order, cnId))?.id).toBe(globalId)
    expect((await pooledNextAccount(order, globalId))?.id).toBe(cnId)
  })

  it('resolves an id held by the other file, and refuses a parked one', async () => {
    const { members, global } = await twoFiles()
    const order = poolOrder(() => members, { id: CHINA_VARIANT.id })
    const globalId = qoderCredentialIdentity({ pat: GLOBAL_PAT })

    const resolved = await pooledAccountById(order, globalId)
    expect(resolved).toEqual({ id: globalId, pat: GLOBAL_PAT, region: 'global' })

    await global.setEnabled(globalId, false)
    // Parked means "skip this id", the same answer the save-order walk gives:
    // custom routing and pinned sessions must not be able to reach it either.
    expect(await pooledAccountById(order, globalId)).toBeUndefined()
  })

  it('restarts the ring for an id no file holds', async () => {
    const { members } = await twoFiles()
    const order = poolOrder(() => members, { id: CHINA_VARIANT.id })

    // A row removed in another tab leaves the transport holding an id that
    // resolves nowhere; the walk restarts rather than dead-ending.
    expect((await pooledNextAccount(order, 'pat:gone'))?.id).toBe(qoderCredentialIdentity({ pat: CN_PAT }))
  })
})

// ---------------------------------------------------------------------------
// Adoption and the derived badge
// ---------------------------------------------------------------------------

describe('cross-variant pool: adoption and the 「自动切换」 fact', () => {
  it('moves the active pointer in the file that owns the account', async () => {
    const { members, cn, global } = await twoFiles()
    const order = poolOrder(() => members, { id: CHINA_VARIANT.id })
    const globalId = qoderCredentialIdentity({ pat: GLOBAL_PAT })
    const cnId = qoderCredentialIdentity({ pat: CN_PAT })
    const warn = vi.fn()

    expect(await adoptPooledAccount(order, globalId, warn)).toBe(true)
    expect(warn).not.toHaveBeenCalled()
    // The owning file records the switch; the other file is untouched.
    expect((await global.current())?.pat).toBe(GLOBAL_PAT)
    expect((await cn.current())?.pat).toBe(CN_PAT)
    expect((await cn.list()).map(row => row.id)).toEqual([cnId])
  })

  it('warns instead of throwing when no file stores the account', async () => {
    const { members } = await twoFiles()
    const order = poolOrder(() => members, { id: CHINA_VARIANT.id })
    const warn = vi.fn()

    // Adoption failure must never turn a recovered request into an error.
    expect(await adoptPooledAccount(order, 'pat:gone', warn)).toBe(false)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('no variant stores it'))
  })

  it('advertises automatic switching for a pool split one seat per file', async () => {
    const { members } = await twoFiles()

    // Each card reads only its own file, so a 1+1 pool used to look like a
    // single-seat pool on both sides and the badge claimed failover was idle.
    expect(autoFailoverActive(true, await poolSeatFlags(members))).toBe(true)

    // A parked spare is not a seat the walk can use: it is still a row in the
    // file, but the badge must not count it as somewhere the walk could go.
    const parked = await twoFiles()
    await parked.global.setEnabled(qoderCredentialIdentity({ pat: GLOBAL_PAT }), false)
    expect(autoFailoverActive(true, await poolSeatFlags(parked.members))).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Transport: the region wall
// ---------------------------------------------------------------------------

interface Signed {
  /** URL of every chat the transport attempted. */
  chatUrls: string[]
  /** PAT whose job token signed each chat, in order. */
  chatPats: string[]
  /** URL of every job-token exchange. */
  exchangeUrls: string[]
}

/**
 * A Qoder stand-in that records which host each credential was presented to.
 *
 * The exchange body carries the PAT, so pairing the exchange URL with the token
 * is the direct observation of "was this PAT presented to its own region's
 * host?" — the exact question the per-file pool answered wrongly by signing a
 * sibling's PAT against the arrival region's endpoints.
 */
function signedUpstream(chat: (pat: string) => Response | Promise<Response>): {
  fetch: typeof fetch
  signed: Signed
} {
  const signed: Signed = { chatUrls: [], chatPats: [], exchangeUrls: [] }
  const patOfUser = new Map<string, string>()
  const fetchImpl = (async (input: URL | Request | string, init?: RequestInit): Promise<Response> => {
    const url = String(input)
    if (url.includes('/jobToken/exchange')) {
      const body = JSON.parse(String(init?.body ?? '{}')) as { personal_token?: string }
      const pat = body.personal_token ?? ''
      signed.exchangeUrls.push(url)
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
      signed.chatUrls.push(url)
      signed.chatPats.push(pat)
      return await chat(pat)
    }
    throw new Error(`unexpected URL: ${url}`)
  }) as typeof fetch
  return { fetch: fetchImpl, signed }
}

function sseChat(text: string): Response {
  const body = JSON.stringify({ choices: [{ delta: { content: text }, finish_reason: 'stop' }] })
  return new Response(`data: ${JSON.stringify({ statusCodeValue: 200, body })}\n\ndata: [DONE]\n\n`, {
    headers: { 'content-type': 'text/event-stream' },
  })
}

function request(): GenerateOptions {
  return {
    provider: 'qoder',
    model: 'cmodel',
    messages: [createUserMessage({ content: [{ type: 'text', text: 'Hello' }], source: { kind: 'user' } })],
  }
}

async function drain(transport: QoderTransport): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = []
  for await (const chunk of transport.stream(request())) chunks.push(chunk)
  return chunks
}

/**
 * Hooks over the two real stores, as the host assembles them.
 *
 * This is the production wiring reduced to its shape: the start is this file's
 * own active row, the walk is the merged ring, and a switch moves the owning
 * file's pointer.
 */
function hooksOver(files: TwoFiles, region: 'china' | 'global'): QoderFailoverHooks {
  const variant = region === 'china' ? CHINA_VARIANT : GLOBAL_VARIANT
  const own = region === 'china' ? files.cn : files.global
  const order = poolOrder(() => files.members, { id: variant.id })
  const switches: Array<{ fromId: string; toId: string; reason: string }> = []
  return {
    enabled: () => true,
    async activeAccount() {
      const credential = await own.current()
      if (credential === undefined) return undefined
      return {
        id: qoderCredentialIdentity(credential),
        pat: credential.pat,
        region: credential.region,
      }
    },
    async nextAccount(id) {
      return await pooledNextAccount(order, id)
    },
    async accountById(id) {
      return await pooledAccountById(order, id)
    },
    async switched(info) {
      switches.push(info)
      await adoptPooledAccount(order, info.toId, () => {})
    },
  }
}

describe('cross-variant pool: the transport signs each account on its own region', () => {
  it('fails over from a China seat to a Global seat on the Global endpoints', async () => {
    const files = await twoFiles()
    const cnId = qoderCredentialIdentity({ pat: CN_PAT })
    const globalId = qoderCredentialIdentity({ pat: GLOBAL_PAT })
    const { fetch, signed } = signedUpstream(pat => pat === CN_PAT
      ? new Response('', { status: 503 })
      : sseChat('from-global'))
    const transport = createQoderTransport({
      region: 'china',
      resolvePat: async () => CN_PAT,
      resolveMachineId: () => 'machine-test',
      fetch,
      failover: hooksOver(files, 'china'),
    })

    const chunks = await drain(transport)

    expect(chunks.some(chunk => chunk.type === 'text-delta' && chunk.text === 'from-global')).toBe(true)
    expect(signed.chatPats).toEqual([CN_PAT, GLOBAL_PAT])

    // The China seat is signed on the China host, the Global seat on the Global
    // host — the PAT never crosses over, which is the wall the old pool hit.
    expect(signed.chatUrls[0]).toBe(getQoderChatUrl('china'))
    expect(signed.chatUrls[1]).toBe(getQoderChatUrl('global'))

    // Every exchange paired a PAT with its own region's host.
    const globalExchange = getQoderExchangeUrl('global')
    const chinaExchange = getQoderExchangeUrl('china')
    expect(signed.exchangeUrls).toContain(chinaExchange)
    expect(signed.exchangeUrls).toContain(globalExchange)
    expect(signed.exchangeUrls.every(url => url === chinaExchange || url === globalExchange)).toBe(true)

    // The switch moved the GLOBAL file's pointer and left China's alone.
    expect((await files.global.current())?.pat).toBe(GLOBAL_PAT)
    expect((await files.cn.current())?.pat).toBe(CN_PAT)
    expect(cnId).not.toBe(globalId)
  })
})
