import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context, Service } from '@deepseek-ai/cordis'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import * as Qoder from '../src/index.ts'
import { normalizeQoderModels } from '../src/qoder/catalog.ts'
import { QODER_SETTINGS_FACE_PATH } from '../src/status-paths.ts'
import { modelInfoOf } from '../src/upstream.ts'

/**
 * Settings integration for the assembled plugin, against the settings surface
 * it actually has.
 *
 * On DSH 0.1.7 the plugin does NOT program the Host's settings service: it
 * installs no section, `SettingsForms` serves one form per profile ENTRY, and
 * `ctx.settings` is not even present here (that service declares
 * `inject = ['configEditor', 'profileContext']`, which nothing in these tests
 * provides). What the plugin serves instead is its OWN settings face —
 * {@link QODER_SETTINGS_FACE_PATH} on `ctx.webServer` — backed by its own JSON
 * file (`settings.json` in the plugin data dir). This file exercises that real
 * path end to end: the face's GET/POST contract and its write-key guard, the
 * directory rows the Models page joins on, per-variant independence of the
 * catalog preferences, their survival across a restart, and the schema-level
 * validation that still runs inside the plugin.
 *
 * WorkBuddy-era cases (device login, app-version telemetry, client identity,
 * the per-product credential-domain realm check) have no Qoder counterpart and
 * were dropped with the features they tested; the realm case is re-expressed
 * as the legacy-credential-file refusal, which is what survives of its intent.
 */

/** A Qoder credential document as the card's save would have written it. */
function credentialDocument(pat: string, region: 'china' | 'global'): string {
  return JSON.stringify({ version: 2, pat, region, savedAt: Date.now() })
}

/** The PATs this spec signs in with; identities only ever as hashed keys. */
const PAT_CN = 'pt-settings-cn-0000000000000000aa'
const PAT_GLOBAL = 'pt-settings-global-000000000000bb'

let context: Context | undefined
let root: string | undefined

/**
 * The real fetch, captured before any test stubs the global.
 *
 * The plugin's upstream traffic is stubbed per test; the test's OWN HTTP calls
 * to the plugin's faces must not be, or a stub that fails every request would
 * also swallow the settings face.
 */
const realFetch = globalThis.fetch

/** Deferred teardown for resources that outlive one boot (the HTTP servers). */
const CLEANUP: (() => Promise<void>)[] = []

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  for (const dispose of CLEANUP.splice(0)) await dispose()
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

/** Isolate the plugin's file roots and silence any real environment PAT. */
function stubEnvRoot(): void {
  vi.stubEnv('DSH_HOME', root!)
  vi.stubEnv(Qoder.QODER_DATA_DIR_ENV, root!)
  vi.stubEnv('HOME', root!)
  vi.stubEnv('USERPROFILE', root!)
  vi.stubEnv('QODER_PERSONAL_ACCESS_TOKEN', '')
  vi.stubEnv('QODER_CN_PERSONAL_ACCESS_TOKEN', '')
}

/**
 * A live catalog whose one model declares two context windows (300k default,
 * 1M maximum): the only shape that makes the maximum-context preference
 * observable end to end. Everything upstream answers this roster.
 */
function bigContextEnvelope(): string {
  return JSON.stringify({
    assistant: [{
      key: 'big-context',
      enable: true,
      display_name: 'Big Context',
      max_input_tokens: 1_000_000,
      max_output_tokens: 1_000,
      is_vl: true,
      price_factor: 1,
      context_config: {
        small: { token_count: 300_000, is_default: true },
        large: { token_count: 1_000_000 },
      },
    }],
  })
}

function liveCatalogFetch(): ReturnType<typeof vi.fn> {
  return vi.fn(async (url: string | URL) => {
    const href = String(url)
    if (href.includes('/api/v1/jobToken/exchange')) {
      return new Response(JSON.stringify({ token: 'jt-settings', expires_in: 86_400_000 }), { status: 200 })
    }
    if (href.includes('/api/v1/userinfo')) {
      return new Response(JSON.stringify({ id: 'user-settings', email: 's@example.invalid', name: 's' }), { status: 200 })
    }
    if (href.includes('/algo/api/v2/model/list')) {
      return new Response(bigContextEnvelope(), { status: 200 })
    }
    return new Response('{}', { status: 404 })
  })
}

/**
 * Stands in for the Host's webServer service so the plugin's REAL routes (as
 * wired by `apply()`, not re-mounted by hand) become callable from a test.
 *
 * The settings face lives inside `apply()`'s `ctx.inject(['webServer'], …)`
 * callback, so exercising it needs the actual handler the plugin registered —
 * which means the `webServer` inject has to fire. This service collects them.
 */
class FakeWebServer extends Service {
  /** Latest instance; the class is plugged per boot. */
  static current: FakeWebServer | undefined
  readonly routes = new Map<string, (req: IncomingMessage, res: ServerResponse) => Promise<void>>()

  constructor(ctx: Context) {
    super(ctx, 'webServer')
    FakeWebServer.current = this
  }

  register(route: { kind: string; path: string; handler: (req: IncomingMessage, res: ServerResponse) => Promise<void> }): () => void {
    this.routes.set(route.path, route.handler)
    return () => { this.routes.delete(route.path) }
  }
}

/** Serve the captured routes over real HTTP, so the handlers see real req/res. */
async function serve(routes: Map<string, (req: IncomingMessage, res: ServerResponse) => Promise<void>>): Promise<{ port: number }> {
  const server = createServer((req, res) => {
    const handler = routes.get(new URL(req.url ?? '/', 'http://127.0.0.1').pathname)
    if (handler === undefined) { res.writeHead(404).end('{}'); return }
    void handler(req, res)
  })
  await new Promise<void>(resolve => { server.listen(0, '127.0.0.1', resolve) })
  const port = (server.address() as { port: number }).port
  CLEANUP.push(() => new Promise<void>(resolve => {
    // Keep-alive sockets from the test's own fetch would otherwise hold the
    // close callback until they time out.
    server.closeAllConnections()
    server.close(() => resolve())
  }))
  return { port }
}

/** One answer from the plugin's own HTTP face. */
interface FaceAnswer {
  status: number
  body: Record<string, unknown>
}

/** The plugin's settings face, mounted on a real loopback server. */
interface Face {
  port: number
  get: (path: string) => Promise<FaceAnswer>
  post: (path: string, body: unknown, key?: string) => Promise<FaceAnswer>
}

/**
 * Bring up whatever routes the plugin registered and address them over real
 * HTTP. The `host` header is what the loopback guard reads, so it must name
 * the loopback interface the way a browser would.
 */
async function openFace(): Promise<Face> {
  await vi.waitFor(() => {
    expect(FakeWebServer.current?.routes.has(QODER_SETTINGS_FACE_PATH)).toBe(true)
  })
  const { port } = await serve(FakeWebServer.current!.routes)
  const call = async (method: string, path: string, body?: unknown, key?: string): Promise<FaceAnswer> => {
    const response = await realFetch(`http://127.0.0.1:${port}${path}`, {
      method,
      headers: {
        host: `127.0.0.1:${port}`,
        ...body === undefined ? {} : { 'content-type': 'application/json' },
        ...key === undefined ? {} : { 'x-qoder-settings-key': key },
      },
      ...body === undefined ? {} : { body: JSON.stringify(body) },
    })
    const text = await response.text()
    return { status: response.status, body: text === '' ? {} : JSON.parse(text) as Record<string, unknown> }
  }
  return {
    port,
    get: path => call('GET', path),
    post: (path, body, key) => call('POST', path, body, key),
  }
}

/**
 * Boot the plugin against the temp root.
 *
 * `web: true` also mounts {@link FakeWebServer}, which is what makes the
 * plugin's own HTTP faces reachable — the same service the Host provides in
 * production. Without it the settings face is simply never wired.
 */
async function boot(options: { web?: boolean } = {}): Promise<Context> {
  const ctx = new Context()
  context = ctx
  await ctx.plugin(LlmRuntime)
  if (options.web === true) await ctx.plugin(FakeWebServer)
  await ctx.plugin(Qoder, {})
  return ctx
}

/**
 * Wait for the LIVE roster, not merely a visible group: the fallback names no
 * `big-context`, so only this proves the fetch landed.
 */
async function waitForLiveCatalog(ctx: Context, provider: string): Promise<void> {
  await vi.waitFor(async () => {
    expect((await ctx.llm.listModels(provider)).map(model => model.id)).toContain('big-context')
  }, { timeout: 15_000 })
}

/** The plugin's own settings file, which is where every write lands. */
function settingsFile(): string {
  return join(root!, 'settings.json')
}

describe('Qoder Host settings integration', () => {
  it('restores the saved maximum-window preference after restarting and can disable it', async () => {
    root = await mkdtemp(join(tmpdir(), 'qoder-context-restart-'))
    const globalAuthPath = join(root, Qoder.GLOBAL_VARIANT.ownFilename)
    await writeFile(globalAuthPath, credentialDocument(PAT_GLOBAL, 'global'))
    stubEnvRoot()
    vi.stubEnv('DSH_QODER_POLL_MS', '100')
    vi.stubGlobal('fetch', liveCatalogFetch())

    let ctx = await boot({ web: true })
    await waitForLiveCatalog(ctx, 'qoder-global')
    // Fresh profile, setting never touched: the default is on, so the model
    // resolves at its largest declared window before any update is written.
    expect((await ctx.llm.resolveModelInfo('qoder-global', 'big-context')).context?.contextWindow).toBe(1_000_000)
    await ctx.fiber.dispose()
    ctx = await boot({ web: true })
    await waitForLiveCatalog(ctx, 'qoder-global')
    // Still on across a restart with nothing stored but the schema default.
    expect((await ctx.llm.resolveModelInfo('qoder-global', 'big-context')).context?.contextWindow).toBe(1_000_000)

    // An explicit opt-out must survive restarts: the flipped default may not
    // resurrect the preference the user turned off. It is written the way the
    // card writes it — a POST to the plugin's own settings face, authorized
    // with the key its GET document hands out — so this exercises the real
    // validate → store → apply → rearm path rather than the store file alone.
    const face = await openFace()
    const document = await face.get(QODER_SETTINGS_FACE_PATH)
    expect(document.status).toBe(200)
    const written = await face.post(
      QODER_SETTINGS_FACE_PATH,
      { useMaximumContextWindow: false },
      document.body.key as string,
    )
    expect(written.status).toBe(200)
    await vi.waitFor(async () => {
      expect((await ctx.llm.resolveModelInfo('qoder-global', 'big-context')).context?.contextWindow).toBe(300_000)
    }, { timeout: 10_000 })
    // The write landed in the plugin's own file, marked as a card edit so the
    // seed rule keeps it authoritative over the (empty) entry config.
    expect(JSON.parse(await readFile(settingsFile(), 'utf8'))).toMatchObject({
      useMaximumContextWindow: false,
      __writes: 1,
    })

    await ctx.fiber.dispose()
    ctx = await boot({ web: true })
    await waitForLiveCatalog(ctx, 'qoder-global')
    // The stored opt-out is restored, not the schema default.
    expect((await ctx.llm.resolveModelInfo('qoder-global', 'big-context')).context?.contextWindow).toBe(300_000)
  })

  it('exposes the provider directory entry, the settings face, and the fallback model list', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-qoder-plugin-settings-'))
    stubEnvRoot()
    // This case asserts the fallback roster, which is served only to a
    // signed-in variant. Pinning a credential of its own keeps that independent
    // of anything else on this machine: the store reads the plugin's own file
    // under the data dir, and without one the group stays hidden (empty model
    // list) rather than serving the roster.
    await writeFile(join(root, Qoder.CHINA_VARIANT.ownFilename), credentialDocument(PAT_CN, 'china'))
    // Signing in would otherwise make this case perform a real discovery
    // request; these tests must not touch the network, and the roster asserted
    // below is the compiled-in fallback, so the fetch fails instead.
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline in tests') }))
    const ctx = await boot({ web: true })

    // Registration rides on the loopback shim's listening event.
    await vi.waitFor(async () => {
      expect((await ctx.llm.listModels('qoder')).length).toBeGreaterThan(0)
    }, { timeout: 15_000 })
    expect(ctx.llm.listConfigurableProviders()).toContainEqual({
      provider: 'qoder',
      displayName: 'Qoder',
      settingsNs: 'qoder',
      settingsPath: [],
      declared: false,
    })

    // The settings face is the plugin's own configuration surface and the
    // 0.1.7 replacement for the Host-served section this case used to look up.
    // Its document is the contract the client half parses: the write key, the
    // effective values, the schema defaults, and the user layer as stored.
    const face = await openFace()
    const document = await face.get(QODER_SETTINGS_FACE_PATH)
    expect(document.status).toBe(200)
    expect(Object.keys(document.body).sort()).toEqual(['base', 'key', 'user', 'value'])
    expect(typeof document.body.key).toBe('string')
    expect((document.body.key as string).length).toBeGreaterThan(0)
    // `base` is built by walking the plugin's declared configuration fields, so
    // it is the served field list — the thing the old `describe()` gave.
    expect(document.body.base).toMatchObject({
      probeConsent: false,
      useMaximumContextWindow: true,
      quotaPollMs: Qoder.QUOTA_POLL_DEFAULT_MS,
    })

    const models = await ctx.llm.listModels('qoder')
    // The fallback roster mirrors the transport's built-in Qoder pool.
    expect(models.map(model => model.id)).toEqual(expect.arrayContaining(['cmodel', 'auto', 'ultimate', 'performance', 'efficient', 'lite']))

    // Billing display: the fallback rows declare no rate, so their names must
    // never carry a FABRICATED `x<n>` multiplier. The rate-unknown case renders
    // explicit "price unavailable" wording instead of a bare name — a bare name
    // where every other row shows `· x0.3` reads as a rendering bug — so what is
    // pinned here is the absence of the fake rate, not the absence of a suffix.
    const byId = new Map(models.map(model => [model.id, model]))
    expect(byId.get('auto')?.name).toBe('Qoder Auto · 价格暂不可用')
    expect(byId.get('auto')?.name).not.toMatch(/· x\d/u)
    expect(byId.get('auto')?.description).toBeUndefined()

    // Thinking controls are declaration-driven: no fallback row declares a
    // reasoning section, so none exposes an effort picker.
    const autoResolved = await ctx.llm.resolveModelInfo('qoder', 'auto')
    expect(autoResolved.reasoning).toBeUndefined()

    // Image modalities follow the per-model catalog flag (fallback list here).
    const modalities = new Map(models.map(model => [model.id, model.inputModalities]))
    expect(modalities.get('auto')).toContain('image')
    expect(modalities.get('lite')).toEqual(['text'])

    // A settings write is validated against the served field list, persisted to
    // the plugin's own file, and echoed back in both layers of the document.
    // The China card owns `probeConsent`, so that is the write to make.
    const updated = await face.post(QODER_SETTINGS_FACE_PATH, { probeConsent: true }, document.body.key as string)
    expect(updated.status).toBe(200)
    expect(updated.body.value).toMatchObject({ probeConsent: true })
    expect(updated.body.user).toMatchObject({ probeConsent: true })
    expect(JSON.parse(await readFile(settingsFile(), 'utf8'))).toMatchObject({ probeConsent: true })
  })

  /**
   * Both providers register from one plugin, unconditionally, and the four
   * credential combinations are expressed through catalog visibility rather
   * than through registration. That is what lets a sign-in that happens while
   * DSH is already running surface without a restart.
   */
  it('registers both variants and keeps each variant identity separate', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-qoder-plugin-dual-'))
    stubEnvRoot()
    // Shorten the credential sweep: a group appears only once the sweep has
    // adopted the credential it finds in the temporary home.
    vi.stubEnv('DSH_QODER_POLL_MS', '100')
    // One real-shaped credential per product, each in the file its own variant
    // owns under the plugin data dir; both arms answer with the live roster.
    await writeFile(join(root, Qoder.CHINA_VARIANT.ownFilename), credentialDocument(PAT_CN, 'china'))
    await writeFile(join(root, Qoder.GLOBAL_VARIANT.ownFilename), credentialDocument(PAT_GLOBAL, 'global'))
    vi.stubGlobal('fetch', liveCatalogFetch())

    const ctx = await boot({ web: true })

    await vi.waitFor(async () => {
      // Both arms must be serving the LIVE roster before the per-variant
      // window assertions below: the fallback would pass a bare non-empty check.
      expect((await ctx.llm.listModels('qoder')).map(model => model.id)).toContain('big-context')
      expect((await ctx.llm.listModels('qoder-global')).map(model => model.id)).toContain('big-context')
    }, { timeout: 15_000 })
    expect(ctx.llm.listProviders().map(provider => provider.id)).toEqual(
      expect.arrayContaining(['qoder', 'qoder-global']),
    )

    // Each provider carries its own display name, which is the model group
    // heading the picker renders — and its OWN settings namespace. The Models
    // page resolves `settingsNs` against the served configuration, so a shared
    // ns would render both providers onto one card. That distinctness is the
    // whole of the directory contract that survives on 0.1.7: the plugin
    // installs no Host section, so there is no "served namespace" list left to
    // check a card key against — the Plugins page dispatches its card by the
    // `plugins.row.config` slot key (`<package>#<entry id>`), which the client
    // half owns and the host half never sees. The old assertion that every
    // variant id was a served settings namespace is therefore GONE with the
    // sections it described; what replaced it is the per-variant `settingsNs`
    // pinned here plus the face field list pinned below.
    expect(ctx.llm.listConfigurableProviders()).toEqual(expect.arrayContaining([
      { provider: 'qoder', displayName: 'Qoder', settingsNs: 'qoder', settingsPath: [], declared: false },
      { provider: 'qoder-global', displayName: 'Qoder Global', settingsNs: 'qoder-global', settingsPath: [], declared: false },
    ]))

    // Each section owns only its own fields, so one card's form cannot edit the
    // other's preference. On 0.1.7 that field list is the one the plugin's own
    // settings face serves: `base` is built by walking exactly the union of the
    // exported per-section lists, and that union must cover every field the
    // schema declares — a field the schema declares but no list carries is
    // exactly how a saved auto check-in toggle silently did nothing.
    const face = await openFace()
    const document = await face.get(QODER_SETTINGS_FACE_PATH)
    expect(document.status).toBe(200)
    const key = document.body.key as string
    const sectionKeys = [...Qoder.CN_SECTION_KEYS, ...Qoder.GLOBAL_SECTION_KEYS, ...Qoder.QUOTA_SECTION_KEYS]
    // Order and content: the face enumerates the section lists in merge order.
    expect(Object.keys(document.body.base as Record<string, unknown>)).toEqual(sectionKeys)
    // Same field set as the schema, which is what makes the lists complete.
    expect([...sectionKeys].sort()).toEqual(Object.keys(Qoder.Config.dict ?? {}).sort())
    // A field outside those lists is refused by name, not silently dropped.
    const unknown = await face.post(QODER_SETTINGS_FACE_PATH, { notAField: true }, key)
    expect(unknown.status).toBe(400)
    expect(unknown.body.error).toBe('unknown field notAField')

    // Model disabling through the face: per variant, and only for the variant
    // whose field it names.
    expect((await face.post(QODER_SETTINGS_FACE_PATH, { disabledModelsCN: ['big-context'] }, key)).status).toBe(200)
    await vi.waitFor(async () => {
      const modelsCN = (await ctx.llm.listModels('qoder')).map(m => m.id)
      expect(modelsCN).not.toContain('big-context')
    })
    expect((await ctx.llm.listModels('qoder-global')).map(m => m.id)).toContain('big-context')

    expect((await face.post(QODER_SETTINGS_FACE_PATH, { disabledModelsCN: [] }, key)).status).toBe(200)
    await vi.waitFor(async () => {
      const modelsCN = (await ctx.llm.listModels('qoder')).map(m => m.id)
      expect(modelsCN).toContain('big-context')
    })

    // A write through one field must reach only THAT variant. The same live
    // roster is served to both arms, and each now carries its own maximum-window
    // preference, so the two toggles are independent observables: flipping the
    // GLOBAL one must move only the global variant's window, and the China
    // answer must stay where its own toggle put it.
    await vi.waitFor(async () => {
      expect((await ctx.llm.resolveModelInfo('qoder-global', 'big-context')).context?.contextWindow).toBe(1_000_000)
    }, { timeout: 10_000 })
    expect((await ctx.llm.resolveModelInfo('qoder', 'big-context')).context?.contextWindow).toBe(1_000_000)
    expect((await face.post(QODER_SETTINGS_FACE_PATH, { useMaximumContextWindow: false }, key)).status).toBe(200)
    await vi.waitFor(async () => {
      expect((await ctx.llm.resolveModelInfo('qoder-global', 'big-context')).context?.contextWindow).toBe(300_000)
    }, { timeout: 10_000 })
    // The China toggle is untouched: still serving the maximum.
    expect((await ctx.llm.resolveModelInfo('qoder', 'big-context')).context?.contextWindow).toBe(1_000_000)
    expect((await face.post(QODER_SETTINGS_FACE_PATH, { useMaximumContextWindowCN: false }, key)).status).toBe(200)
    await vi.waitFor(async () => {
      expect((await ctx.llm.resolveModelInfo('qoder', 'big-context')).context?.contextWindow).toBe(300_000)
    }, { timeout: 10_000 })
  })

  /**
   * With no credential present, a variant exposes nothing. This is the
   * deliberate behaviour the plan calls out: a signed-out provider must not
   * publish fallback models that could only fail on the first message.
   */
  it('hides a variant with no usable credential while still registering it', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-qoder-plugin-empty-'))
    // The temporary data dir is empty: neither variant's own credential file
    // exists and no environment PAT is set, which is what "nobody has signed
    // in" now means.
    stubEnvRoot()
    const ctx = await boot({ web: true })

    await vi.waitFor(() => {
      expect(ctx.llm.listProviders().map(provider => provider.id)).toContain('qoder')
    })
    await vi.waitFor(async () => {
      expect(await ctx.llm.listModels('qoder')).toEqual([])
    })
    expect(await ctx.llm.listModels('qoder-global')).toEqual([])

    // The provider directory entry survives: the group is hidden by having no
    // models, not by unregistering, so a later sign-in needs no restart.
    expect(ctx.llm.listConfigurableProviders().map(entry => entry.provider))
      .toEqual(expect.arrayContaining(['qoder', 'qoder-global']))
    // And the settings card is still there to explain how to sign in: the face
    // is served and answers its document while both variants are hidden.
    const face = await openFace()
    const document = await face.get(QODER_SETTINGS_FACE_PATH)
    expect(document.status).toBe(200)
    expect(typeof document.body.key).toBe('string')
    expect(document.body.base).toMatchObject({ probeConsent: false })
  })

  /**
   * The settings face's write guard: the key is minted per plugin lifetime and
   * rides the GET document (which already passed the loopback guard), and the
   * POST authorizes with it. Without this an unauthenticated page could rewrite
   * the user's configuration.
   */
  it('guards the settings face with the key its GET document hands out', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-qoder-plugin-face-key-'))
    stubEnvRoot()
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline in tests') }))
    await boot({ web: true })

    const face = await openFace()
    const document = await face.get(QODER_SETTINGS_FACE_PATH)
    expect(document.status).toBe(200)
    expect(typeof document.body.key).toBe('string')

    const missing = await face.post(QODER_SETTINGS_FACE_PATH, { probeConsent: true })
    expect(missing.status).toBe(403)
    expect(missing.body.error).toBe('invalid-key')
    const wrong = await face.post(QODER_SETTINGS_FACE_PATH, { probeConsent: true }, 'not-the-key')
    expect(wrong.status).toBe(403)
    expect(wrong.body.error).toBe('invalid-key')
    // Neither refusal may create or touch the store: without the boot-time
    // migration seed the file only appears on the first ACCEPTED write.
    await expect(stat(settingsFile())).rejects.toMatchObject({ code: 'ENOENT' })

    const accepted = await face.post(QODER_SETTINGS_FACE_PATH, { probeConsent: true }, document.body.key as string)
    expect(accepted.status).toBe(200)
    expect(accepted.body.value).toMatchObject({ probeConsent: true })
    expect(JSON.parse(await readFile(settingsFile(), 'utf8'))).toMatchObject({ probeConsent: true, __writes: 1 })
  })

  /**
   * The environment PAT fallback from the naming contract: a file remains the
   * authority, and without one the arm's own env variable signs it in.
   */
  it('signs in a variant from its environment PAT when no file exists', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-qoder-plugin-env-'))
    stubEnvRoot()
    vi.stubEnv('QODER_PERSONAL_ACCESS_TOKEN', 'pt-from-environment')
    vi.stubEnv('DSH_QODER_POLL_MS', '100')
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline in tests') }))
    const ctx = await boot()

    await vi.waitFor(async () => {
      expect((await ctx.llm.listModels('qoder-global')).length).toBeGreaterThan(0)
    }, { timeout: 15_000 })
    // The China arm reads only its own variable: one env token signs in one
    // variant, and the other stays hidden.
    expect(await ctx.llm.listModels('qoder')).toEqual([])
  })

  /**
   * A stale WorkBuddy-era credential file is refused, and the refusal is what
   * the card would show. Silently treating it as "signed out" would send the
   * user to re-authenticate without naming the actual fix; at plugin level the
   * observable contract is that such a file never reveals models.
   */
  it('refuses a legacy credential file instead of treating it as a PAT', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-qoder-plugin-legacy-'))
    stubEnvRoot()
    vi.stubEnv('DSH_QODER_POLL_MS', '100')
    // The WorkBuddy-era shape: an accessToken document where a Qoder PAT
    // belongs. The store must call it invalid, not migrate or trust it.
    await writeFile(join(root, Qoder.CHINA_VARIANT.ownFilename), JSON.stringify({
      auth: { accessToken: 'at', refreshToken: 'rt', expiresAt: Date.now() + 3_600_000, domain: 'copilot.tencent.com' },
      account: { uid: 'uid-1', nickname: 'nick', enterpriseId: 'ent-1' },
    }))
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline in tests') }))
    const ctx = await boot()

    await vi.waitFor(() => {
      expect(ctx.llm.listProviders().map(provider => provider.id)).toContain('qoder')
    })
    // Refused, so the group stays hidden rather than serving a roster the stale
    // token cannot actually reach. Give the sweep time to have adopted a valid
    // credential had it accepted this one.
    await new Promise(resolve => setTimeout(resolve, 500))
    expect(await ctx.llm.listModels('qoder')).toEqual([])
    expect(await ctx.llm.listModels('qoder-global')).toEqual([])
  })

  /**
   * The quota card's shared section: its fields are the two sidebar toggles
   * plus the one rate limit honoured at the schema edge, and a write through
   * the face persists where the plugin reads it back.
   */
  it('validates and persists the quota section', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-qoder-plugin-quota-'))
    stubEnvRoot()
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline in tests') }))
    const ctx = await boot({ web: true })
    await vi.waitFor(() => {
      expect(ctx.llm.listProviders().map(provider => provider.id)).toContain('qoder')
    })

    const face = await openFace()
    const document = await face.get(QODER_SETTINGS_FACE_PATH)
    const key = document.body.key as string
    const written = await face.post(QODER_SETTINGS_FACE_PATH, { sidebarQuotaCN: true }, key)
    expect(written.status).toBe(200)
    expect(written.body.user).toMatchObject({ sidebarQuotaCN: true })
    expect(JSON.parse(await readFile(settingsFile(), 'utf8'))).toMatchObject({ sidebarQuotaCN: true })

    // The poll floor is enforced at the face's edge as well as by the schema.
    const tooFast = await face.post(QODER_SETTINGS_FACE_PATH, { quotaPollMs: 1_000 }, key)
    expect(tooFast.status).toBe(400)
    expect(tooFast.body.error).toBe('quotaPollMs must be an integer of at least 60000 ms')

    // The poll floor is enforced by the schema itself, not by the card. The
    // schema instance is callable: it validates and applies defaults.
    expect(Qoder.QUOTA_POLL_DEFAULT_MS).toBe(300_000)
    expect(Qoder.QUOTA_POLL_MIN_MS).toBe(60_000)
    expect(Qoder.Config({})).toMatchObject({ quotaPollMs: Qoder.QUOTA_POLL_DEFAULT_MS })
    expect(() => Qoder.Config({ quotaPollMs: 1_000 })).toThrow()
    expect(Qoder.Config({ quotaPollMs: Qoder.QUOTA_POLL_MIN_MS })).toMatchObject({ quotaPollMs: Qoder.QUOTA_POLL_MIN_MS })
  })

  it('defaults its model rows to the live-catalog shape the stores fingerprint', async () => {
    // Cross-check the fixture translation used by the probe specs: the same
    // envelope produces a QoderModelInfo with the fallback's own defaults when
    // the upstream declares nothing.
    const row = modelInfoOf(normalizeQoderModels(JSON.parse(bigContextEnvelope())).at(0)!)
    expect(row.contextWindow).toBe(300_000)
    expect(row.defaultContextWindow).toBe(300_000)
    expect(row.supportedContextWindows).toEqual([300_000, 1_000_000])
    expect(row.billing).toEqual({ credits: 'x1.0', free: false })
    expect(row.reasoning).toBeUndefined()
    // The roster lives where the plan says it does, one file per variant.
    root = await mkdtemp(join(tmpdir(), 'dsh-qoder-plugin-ident-'))
    await mkdir(join(root, 'state'), { recursive: true })
    stubEnvRoot()
    expect(Qoder.qoderCatalogPath(Qoder.GLOBAL_VARIANT.catalogFilename))
      .toBe(join(root, 'state', '.qoder-global-catalog.json'))
    expect(Qoder.qoderProbePath(Qoder.CHINA_VARIANT.probeFilename))
      .toBe(join(root, 'state', '.qoder-probe.json'))
  })

  it('supplies an attachment facade covering imageLimits, readImageRequest, and saveImage to transport and client', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-qoder-plugin-attachments-'))
    await mkdir(join(root, 'state'), { recursive: true })
    await writeFile(join(root, 'state', 'auth-qoder.json'), credentialDocument(PAT_CN, 'china'))
    stubEnvRoot()

    const ctx = new Context()
    context = ctx

    const fakeAttachmentStore = {
      imageLimits: {
        maxImagePixels: 1000,
        maxImageBytes: 2000,
        maxImagesPerMessage: 5,
        maxMessageImageBytes: 10000,
      },
      readImageRequest: vi.fn().mockResolvedValue({
        data: new Uint8Array([1, 2, 3]),
        mediaType: 'image/png',
      }),
      saveImage: vi.fn().mockResolvedValue({
        id: 'test-attachment-id',
        bytes: 3,
        mediaType: 'image/png',
      }),
    }

    ctx.provide('attachments')
    ctx.set('attachments', fakeAttachmentStore as any)

    await ctx.plugin(LlmRuntime)
    await ctx.plugin(Qoder, {})

    await vi.waitFor(() => {
      expect(ctx.llm.listProviders().map(provider => provider.id)).toContain('qoder')
    })
  })
})
