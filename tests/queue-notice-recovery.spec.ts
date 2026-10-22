import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context, Service } from '@deepseek-ai/cordis'
import LlmRuntime, { createUserMessage } from '@deepseek-ai/dsh-llm'
import * as Qoder from '../src/index.ts'
import { installJobTokenHint } from '../src/job-token-hint.ts'
import { formatQueueNotice, parseQueueFacts } from '../src/qoder/queue-notice.ts'

/**
 * The live queue notice, end to end.
 *
 * These boot the real plugin and drive real chats through the adapter, the
 * loopback shim and the transport, because what is under test is the WIRING
 * between them: only the transport knows a chat was accepted, only the host
 * knows what the card is currently being told, and the notice is the one place
 * those two facts have to agree. Re-mounting any of it by hand would test the
 * re-mount instead.
 */

const CLEANUP: (() => Promise<void>)[] = []
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  for (const dispose of CLEANUP.splice(0)) await dispose()
  vi.useRealTimers()
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

async function tempDir(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'qoder-notice-'))
  CLEANUP.push(() => rm(root, { recursive: true, force: true }))
  return root
}

const PAT = 'pt-notice-aaaaaaaaaaaaaaaaaaaaaa'
const USER = 'uid-notice'

function credentialDocument(pat: string): string {
  return JSON.stringify({ version: 2, pat, region: 'china', savedAt: Date.now() })
}

/** The model-list envelope the transport's catalog parser understands. */
function catalogEnvelope(modelId: string, name: string): string {
  return JSON.stringify({
    assistant: [{
      key: modelId,
      enable: true,
      display_name: name,
      max_input_tokens: 100_000,
      max_output_tokens: 1_000,
      is_vl: false,
      price_factor: 1,
    }],
  })
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

/** The verbatim queue answer Qoder sends when a model's queue is saturated. */
const QUEUE_BODY = JSON.stringify({
  isQueued: true,
  modelKey: 'live-model',
  queueCount: 8887,
  queueType: 'p3',
  retryAfterSeconds: 30,
  serviceAvailable: true,
})

/** How the fake upstream answers the next chat. */
type ChatAnswer = () => Response

interface UpstreamState {
  chat: ChatAnswer
}

/**
 * A Qoder stand-in: PAT exchange, userinfo, model list, and chat.
 *
 * Loopback URLs (the plugin's own routes and its shim) go to the real fetch, so
 * the shim really does carry the chat the adapter handed it.
 */
function qoderFetch(state: UpstreamState): typeof fetch {
  const realFetch = globalThis.fetch
  return (async (input: URL | Request | string, init?: RequestInit): Promise<Response> => {
    const href = String(input)
    if (href.startsWith('http://127.0.0.1')) return await realFetch(input, init)
    const headers = new Headers(init?.headers)
    if (href.includes('/api/v1/jobToken/exchange')) {
      const body = JSON.parse(String(init?.body ?? '{}')) as { personal_token?: string }
      if ((body.personal_token ?? '') !== PAT) return jsonResponse({ message: 'invalid token' }, 401)
      return jsonResponse({ token: `jt-${USER}`, expires_in: 86_400_000 })
    }
    if (href.includes('/api/v1/userinfo')) {
      return headers.get('authorization')?.replace(/^Bearer jt-/u, '') === USER
        ? jsonResponse({ id: USER, email: `${USER}@example.invalid`, name: USER })
        : jsonResponse({ message: 'no such user' }, 404)
    }
    if (href.includes('/algo/api/v2/model/list')) {
      return jsonResponse(JSON.parse(catalogEnvelope('live-model', 'Live Model')))
    }
    if (href.includes('/api/v2/quota/usage')) {
      return jsonResponse({
        userQuota: { total: 1_000, used: 200, remaining: 800, unit: 'credits' },
        totalUsagePercentage: 20,
        isQuotaExceeded: false,
        expiresAt: Date.now() + 3_600_000,
      })
    }
    if (href.includes('/api/v2/user/plan') || href.includes('/api/v3/user/status')) return jsonResponse({})
    if (href.includes('/agent_chat_generation')) return state.chat()
    return jsonResponse({ message: 'not found' }, 404)
  }) as typeof fetch
}

/** One queue answer, as Qoder streams it: an SSE envelope carrying a 403 body. */
function queueChat(): Response {
  return new Response(
    `data: ${JSON.stringify({ statusCodeValue: 403, body: QUEUE_BODY })}\n\n`,
    { headers: { 'content-type': 'text/event-stream' } },
  )
}

/** One accepted chat, as Qoder streams it: an envelope carrying a delta. */
function acceptedChat(text = 'hello'): Response {
  const body = JSON.stringify({ choices: [{ delta: { content: text }, finish_reason: 'stop' }] })
  return new Response(
    `data: ${JSON.stringify({ statusCodeValue: 200, body })}\n\ndata: [DONE]\n\n`,
    { headers: { 'content-type': 'text/event-stream' } },
  )
}

/** Stands in for the host's webServer service so `apply()`'s routes are callable. */
class FakeWebServer extends Service {
  static current: FakeWebServer | undefined
  readonly routes = new Map<string, (req: IncomingMessage, res: ServerResponse) => Promise<void>>()
  constructor(ctx: Context) {
    super(ctx, 'webServer')
    FakeWebServer.current = this
  }
  register(route: {
    path: string
    handler: (req: IncomingMessage, res: ServerResponse) => Promise<void>
  }): () => void {
    this.routes.set(route.path, route.handler)
    return () => { this.routes.delete(route.path) }
  }
}

async function serve(routes: Map<string, (req: IncomingMessage, res: ServerResponse) => Promise<void>>): Promise<number> {
  const server = createServer((req, res) => {
    const handler = routes.get(new URL(req.url ?? '/', 'http://127.0.0.1').pathname)
    if (handler === undefined) { res.writeHead(404).end('{}'); return }
    void handler(req, res)
  })
  await new Promise<void>(resolve => { server.listen(0, '127.0.0.1', resolve) })
  CLEANUP.push(() => new Promise<void>(resolve => { server.close(() => resolve()) }))
  return (server.address() as { port: number }).port
}

/** A signed-in plugin served by `state`'s fake upstream, with the catalog read. */
async function bootSignedIn(state: UpstreamState): Promise<Context> {
  const root = await tempDir()
  vi.stubEnv('DSH_QODER_POLL_MS', '100')
  vi.stubEnv('DSH_HOME', root)
  vi.stubEnv(Qoder.QODER_DATA_DIR_ENV, root)
  vi.stubEnv('HOME', root)
  vi.stubEnv('USERPROFILE', root)
  vi.stubEnv('QODER_PERSONAL_ACCESS_TOKEN', '')
  vi.stubEnv('QODER_CN_PERSONAL_ACCESS_TOKEN', '')
  await writeFile(join(root, Qoder.CHINA_VARIANT.ownFilename), credentialDocument(PAT))
  vi.stubGlobal('fetch', qoderFetch(state))
  const ctx = new Context()
  context = ctx
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(FakeWebServer)
  await ctx.plugin(Qoder, {})
  await vi.waitFor(async () => {
    expect((await ctx.llm.listModels('qoder')).map(model => model.id)).toEqual(['live-model'])
  }, { timeout: 15_000 })
  return ctx
}

/** Drive one chat the way the agent loop does, and report the text it produced. */
async function chat(ctx: Context): Promise<string> {
  let text = ''
  try {
    for await (const chunk of ctx.llm.stream({
      provider: 'qoder',
      model: 'live-model',
      messages: [createUserMessage({
        content: [{ type: 'text', text: 'Hello' }],
        source: { kind: 'user' },
      })],
    })) {
      // Visible text arrives as `text-delta` chunks; a turn the upstream refused
      // ends on an error finish instead, so an empty string is the signature of
      // "no chunk was ever accepted".
      const delta = chunk as { type?: string; text?: unknown }
      if (delta.type === 'text-delta' && typeof delta.text === 'string') text += delta.text
    }
  } catch (error: unknown) {
    // The adapter reports a failed turn through the stream's error path; the
    // notice is asserted from the status document either way.
    void error
  }
  return text
}

/** The current status document, through the route `apply()` really registered. */
async function statusDocument(): Promise<Record<string, unknown>> {
  // undici refuses to fetch a handful of reserved ports, and an ephemeral bind
  // can land on one — so a fresh port is asked for rather than failing a test on
  // the draw. Earlier servers stay until cleanup; they are only sockets.
  for (let attempt = 0; ; attempt += 1) {
    const server = await serve(FakeWebServer.current!.routes)
    try {
      const response = await fetch(`http://127.0.0.1:${server}/plugins/dsh-qoder-plugin/status`, {
        headers: { host: `127.0.0.1:${server}` },
      })
      return JSON.parse(await response.text()) as Record<string, unknown>
    } catch (error: unknown) {
      if (attempt >= 4) throw error
    }
  }
}

function noticeIn(document: Record<string, unknown>): Record<string, unknown> | undefined {
  return document.upstreamNotice as Record<string, unknown> | undefined
}

interface AppendedRow {
  type: string
  data: Record<string, unknown>
}

/**
 * A conversation the notice printer can print into.
 *
 * The printer attributes a row to the agent whose `agent/status` was last
 * `running` (src/job-token-hint.ts:84-92), so a context that only captures that
 * one listener is enough to see what a real session would have received — and
 * the module state is process-wide, so the row the plugin prints lands here.
 */
function conversation(): { appended: AppendedRow[]; running: (id: string) => void } {
  const appended: AppendedRow[] = []
  let listener: ((payload: { agent?: unknown; status?: string }) => void) | undefined
  installJobTokenHint({
    on: (_event: string, handler: (payload: { agent?: unknown; status?: string }) => void) => {
      listener = handler
    },
  } as unknown as Context)
  return {
    appended,
    running: id => {
      listener?.({
        status: 'running',
        agent: {
          id,
          session: {
            append: (type: string, data: unknown) => {
              appended.push({ type, data: data as Record<string, unknown> })
            },
          },
        },
      })
    },
  }
}

/** The notice lines a conversation received, in the order they were printed. */
function noticeLines(appended: AppendedRow[]): string[] {
  return appended.filter(row => row.type === 'command/done').map(row => String(row.data['text']))
}

/** The sentence the conversation row prints for the record the card is showing. */
function rowSentence(notice: Record<string, unknown>): string {
  // Built from the body the record itself carries, through the plugin's own
  // parser: the sentence follows the facts that were stored, not facts the test
  // reconstructed.
  const facts = parseQueueFacts(String(notice.upstreamMessage))
  if (facts === undefined) throw new Error('the recorded notice carries no parseable upstream body')
  return formatQueueNotice(facts, {
    waited: notice.waited === true,
    occurrences: notice.occurrences as number,
  })
}

describe('queue notice lifecycle', () => {
  it('records a notice for a chat the upstream queued, and claims no wait', async () => {
    const session = conversation()
    const ctx = await bootSignedIn({ chat: () => queueChat() })
    session.running('agent-notice-first')
    const text = await chat(ctx)
    // A failed turn yields no text, which is what makes "the next chat streamed"
    // a usable signal in the tests below.
    expect(text).toBe('')
    const notice = noticeIn(await statusDocument())
    expect(notice).toMatchObject({
      kind: 'queued',
      retryAfterMs: 30_000,
      waited: false,
      occurrences: 1,
    })
    const sentence = rowSentence(notice!)
    expect(sentence).toContain('本次未按上游建议等待即返回此结果')
    // The row the user actually sees: one log-only pair carrying that sentence,
    // and nothing about a retry the plugin never waited out.
    expect(session.appended.map(row => row.type)).toEqual(['command/run', 'command/done'])
    expect(noticeLines(session.appended)).toEqual([sentence])
  }, 30_000)

  it('clears the notice as soon as a later chat is accepted', async () => {
    let answer: ChatAnswer = () => queueChat()
    const ctx = await bootSignedIn({ chat: () => answer() })
    expect((await chat(ctx))).toBe('')
    expect(noticeIn(await statusDocument())).toBeDefined()
    answer = () => acceptedChat()
    expect(await chat(ctx)).toContain('hello')
    expect(noticeIn(await statusDocument())).toBeUndefined()
  }, 30_000)

  it('counts a second answer inside the window as the same outage, still without a wait', async () => {
    let answer: ChatAnswer = () => queueChat()
    const ctx = await bootSignedIn({ chat: () => answer() })
    await chat(ctx)
    const first = noticeIn(await statusDocument())!
    // Anchored on the recorded answer, not on the test's own clock: the elapsed
    // time the plugin sees is the whole assertion.
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime((first.at as number) + 5_000)
    await chat(ctx)
    const notice = noticeIn(await statusDocument())
    // Same outage, so the recurrence is real — but five seconds is not the
    // thirty the upstream advised, so the wait sentence must stay silent.
    expect(notice).toMatchObject({ waited: false, occurrences: 2 })
    expect(rowSentence(notice!)).not.toContain('已按上游建议等待')
    expect(rowSentence(notice!)).toContain('可能代表当前账号已被风控')
  }, 30_000)

  it('claims the advised wait once the elapsed time really covers it', async () => {
    const session = conversation()
    let answer: ChatAnswer = () => queueChat()
    const ctx = await bootSignedIn({ chat: () => answer() })
    session.running('agent-notice-waited')
    await chat(ctx)
    const first = noticeIn(await statusDocument())!
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime((first.at as number) + 31_000)
    await chat(ctx)
    const notice = noticeIn(await statusDocument())
    expect(notice).toMatchObject({ waited: true, occurrences: 2 })
    const sentence = rowSentence(notice!)
    expect(sentence).toContain('已按上游建议等待 30 秒仍不可服务')
    // The approved sentence is not just reachable in a formatter: it is the line
    // the second answer prints into the conversation.
    expect(noticeLines(session.appended).at(-1)).toBe(sentence)
  }, 30_000)

  it('starts a fresh outage at one occurrence after an accepted chat', async () => {
    const base = Date.now()
    let answer: ChatAnswer = () => queueChat()
    const ctx = await bootSignedIn({ chat: () => answer() })
    await chat(ctx)
    answer = () => acceptedChat()
    expect(await chat(ctx)).toContain('hello')
    answer = () => queueChat()
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(base + 2_000)
    await chat(ctx)
    const notice = noticeIn(await statusDocument())
    // The accepted chat ended the outage, so the answer two seconds later is the
    // first of a new one — not a recurrence of the one the user already cleared.
    expect(notice).toMatchObject({ waited: false, occurrences: 1 })
    expect(rowSentence(notice!)).not.toContain('可能代表当前账号已被风控')
  }, 30_000)

  it('ages the notice out once it describes nothing current', async () => {
    const base = Date.now()
    const ctx = await bootSignedIn({ chat: () => queueChat() })
    await chat(ctx)
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(base + 5 * 60 * 1000 + 60_000)
    expect(noticeIn(await statusDocument())).toBeUndefined()
  }, 30_000)
})
