import { EventEmitter } from 'node:events'
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer, request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { gzipSync } from 'node:zlib'
import { Context, Service } from '@deepseek-ai/cordis'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { installUmid, runSelfCheckProcess } from '../src/qoder/transport/umid-extract.ts'
import * as Qoder from '../src/index.ts'
import { QODER_PAT_ENV_CN, QODER_PAT_ENV_GLOBAL, QoderCredentialStore } from '../src/auth.ts'
import {
  createQoderUmidInstallRunner,
  qoderUmidInstallHandler,
  type QoderUmidInstallOutcome,
  type QoderUmidInstallRouteOptions,
} from '../src/device-reset-route.ts'
import { QODER_GLOBAL_PROBE_PATH, QODER_GLOBAL_STATUS_PATH, QODER_PROBE_PATH, QODER_STATUS_PATH, QODER_UMID_INSTALL_PATH } from '../src/status-paths.ts'
import type { QoderNativeDeviceStatus, QoderWebStatus } from '../src/status-paths.ts'
import { QoderCheckInService, type QoderCheckInResult } from '../src/qoder/transport/checkin.ts'
import { qoderWebStatus, type QoderStatusRouteOptions } from '../src/web-status.ts'
import { CHINA_VARIANT } from '../src/variants.ts'
import { OwnQuotaSettingsScope } from '../src/client/http-settings-scope.ts'
import { QoderPluginCard } from '../src/client/QoderPluginCard.tsx'
import type { QuotaUmidInstallResult } from '../src/client/QuotaSettingsCard.tsx'
import { en } from '../src/client/locales.ts'
import {
  resetAdvancedSettings,
  resetQuotaSignIn,
  resetQuotaStatusDocuments,
  setAdvancedSettingsOpen,
} from '../src/client/quota-settings-store.ts'

/**
 * What the on-disk identity cache currently holds, as the boot cases script it.
 *
 * The cache's real location is `os.homedir()/.dsh/qoder/machine-identity.json` —
 * a test must never write there, because that is the developer's own cache. The
 * accessor is therefore replaced, and what these cases then check is the part
 * this change owns: the projection from the cache's `stale` flag onto the
 * document's `source`, and the field being absent when there is no cache.
 */
const identityProbe = vi.hoisted(() => ({ value: undefined as { cachedAt: number, stale: boolean } | undefined }))

vi.mock('../src/qoder/transport/risk-identity-cache.ts', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/qoder/transport/risk-identity-cache.ts')>()
  return {
    ...actual,
    identityCacheStatus: (): { cachedAt: number, stale: boolean } | undefined => identityProbe.value,
  }
})

/**
 * The real fetch, captured before any test stubs the global: the test's own
 * calls to the plugin's faces must never be swallowed by a stub.
 */
const realFetch = globalThis.fetch

/**
 * M2 of SPEC-UMID-003: the native-component install, end to end.
 *
 * Three layers are covered here because the feature only works when all three
 * agree: the guarded route (a POST starts a BACKGROUND job and answers with its
 * id), the browser scope (the card's only way in — it holds the settings key
 * and heals a rotated one), and the status document (where the job's progress
 * and the component's presence are read back).
 *
 * `installUmid` is a placeholder in the transport layer, so every case injects
 * a fake install: these tests must never touch the network.
 */

const KEY = 'umid-key-under-test'

let server: Server | undefined

afterEach(async () => {
  if (server !== undefined) {
    await new Promise<void>(resolve => server?.close(() => resolve()))
    server = undefined
  }
})

// ─────────────────────────────── the route ───────────────────────────────

/** A runner over a scripted install, plus the hook to settle it later. */
function runnerWith(install: (force: boolean) => Promise<QoderUmidInstallOutcome>) {
  const calls: boolean[] = []
  const runner = createQoderUmidInstallRunner(force => {
    calls.push(force)
    return install(force)
  }, () => 1_700_000_000_000)
  return { runner, calls }
}

/** Mount the install handler on an ephemeral port and return its origin. */
async function mount(deps: Partial<QoderUmidInstallRouteOptions> = {}): Promise<{ origin: string }> {
  const handler = qoderUmidInstallHandler({
    runner: runnerWith(async () => ({ ok: true })).runner,
    ...deps,
  }, KEY)
  server = createServer((req, res) => { void handler(req, res) })
  await new Promise<void>(resolve => server?.listen(0, '127.0.0.1', () => resolve()))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('no port')
  return { origin: `http://127.0.0.1:${address.port}` }
}

/** POST with full control over the headers, including `Host`. */
async function postRaw(
  origin: string,
  headers: Record<string, string>,
  body = '{}',
): Promise<{ status: number, body: Record<string, unknown> }> {
  const url = new URL(origin)
  return await new Promise((resolve, reject) => {
    const request = httpRequest({
      host: url.hostname,
      port: url.port,
      path: QODER_UMID_INSTALL_PATH,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), ...headers },
    }, response => {
      const chunks: Buffer[] = []
      response.on('data', chunk => chunks.push(chunk as Buffer))
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8')
        resolve({ status: response.statusCode ?? 0, body: text === '' ? {} : JSON.parse(text) as Record<string, unknown> })
      })
    })
    request.on('error', reject)
    request.end(body)
  })
}

describe('native component install route', () => {
  it('T-M2-1 mounts and refuses a caller without the settings key', async () => {
    const { origin } = await mount()
    // No key at all: the guard answers before the action runs.
    const anonymous = await postRaw(origin, {})
    expect(anonymous.status).toBe(403)
    expect(anonymous.body['error']).toBe('invalid-settings-key')
    // A key that is merely close is still wrong.
    const nearMiss = await postRaw(origin, { 'X-Qoder-Settings-Key': `${KEY}x` })
    expect(nearMiss.status).toBe(403)
    // The real key starts the job.
    const accepted = await postRaw(origin, { 'X-Qoder-Settings-Key': KEY })
    expect(accepted.status).toBe(200)
    expect(accepted.body['ok']).toBe(true)
    expect(accepted.body['started']).toBe(true)
    expect(typeof accepted.body['jobId']).toBe('string')
  })

  it('T-M2-1 keeps the shared guard: method and origin are checked first', async () => {
    const { origin } = await mount()
    // A GET is answered as the wrong method, which says nothing about the caller.
    const url = new URL(origin)
    const methodStatus = await new Promise<number>(resolve => {
      const request = httpRequest({ host: url.hostname, port: url.port, path: QODER_UMID_INSTALL_PATH, method: 'GET' }, response => {
        response.resume()
        resolve(response.statusCode ?? 0)
      })
      request.on('error', () => resolve(0))
      request.end()
    })
    expect(methodStatus).toBe(405)
    // A cross-site page is refused even when it somehow holds the key.
    const crossSite = await postRaw(origin, { Origin: 'https://evil.example', 'X-Qoder-Settings-Key': KEY })
    expect(crossSite.status).toBe(403)
    expect(crossSite.body['error']).toBe('request-not-trusted')
  })

  it('T-M2-2 answers a second press with the running job instead of a second install', async () => {
    let settle: ((outcome: QoderUmidInstallOutcome) => void) | undefined
    const { runner, calls } = runnerWith(async () => await new Promise<QoderUmidInstallOutcome>(resolve => {
      settle = resolve
    }))
    const { origin } = await mount({ runner })
    const first = await postRaw(origin, { 'X-Qoder-Settings-Key': KEY })
    const second = await postRaw(origin, { 'X-Qoder-Settings-Key': KEY })
    expect(first.body['started']).toBe(true)
    expect(second.body['ok']).toBe(true)
    expect(second.body['alreadyRunning']).toBe(true)
    // The SAME job: the second caller watches the one that is already going.
    expect(second.body['jobId']).toBe(first.body['jobId'])
    // One download, not two.
    expect(calls).toHaveLength(1)
    settle?.({ ok: true })
  })

  it('T-M2-3 reports a failed install as 200 {ok:false} and keeps the reason for the next poll', async () => {
    const { runner } = runnerWith(async () => ({ ok: false, error: 'EACCES: permission denied, open /root/.dsh' }))
    const { origin } = await mount({ runner })
    const started = await postRaw(origin, { 'X-Qoder-Settings-Key': KEY })
    // The request cannot wait for the download, so it answers "started" even for
    // an install that will fail a second later.
    expect(started.status).toBe(200)
    expect(started.body['started']).toBe(true)
    // The failure is then visible where the card looks: the job state.
    await vi.waitFor(() => { expect(runner.state().lastError).toContain('permission denied') })
    expect(runner.state().installing).toBe(false)
  })

  it('T-M2-3 turns a synchronous throw into the route failure shape', async () => {
    // A runner that throws before it can start anything: the only failure the
    // caller can still be told about directly.
    const { origin } = await mount({
      runner: {
        start: () => { throw new Error('the install directory is not writable') },
        state: () => ({ installing: false }),
      },
    })
    const refused = await postRaw(origin, { 'X-Qoder-Settings-Key': KEY })
    expect(refused.status).toBe(200)
    expect(refused.body['ok']).toBe(false)
    expect(String(refused.body['error'])).toContain('not writable')
  })

  it('T-M2-4 does not block the response on the install', async () => {
    // An install that never settles: the response must still arrive, because a
    // browser times out long before a slow download does.
    const { runner } = runnerWith(async () => await new Promise<QoderUmidInstallOutcome>(() => {}))
    const { origin } = await mount({ runner })
    const answered = await postRaw(origin, { 'X-Qoder-Settings-Key': KEY })
    expect(answered.status).toBe(200)
    expect(answered.body['started']).toBe(true)
    // And the job is still reported as running afterwards.
    expect(runner.state().installing).toBe(true)
  })
})

// ─────────────────────────────── the scope ───────────────────────────────

describe('settings scope installUmid', () => {
  const FACE = '/plugins/dsh-qoder-plugin/settings'
  const INSTALL = '/plugins/dsh-qoder-plugin/umid-install'

  interface Call { method: string, url: string, key: string | undefined, body: unknown }

  /** A fake settings face whose answers each test scripts. */
  function face(script: {
    get: Array<() => { ok: boolean, status: number, body: unknown }>
    post?: Array<() => { ok: boolean, status: number, body: unknown }>
  }) {
    const calls: Call[] = []
    const gets = [...script.get]
    const posts = [...(script.post ?? [])]
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      const headers = (init?.headers ?? {}) as Record<string, string>
      calls.push({
        method: init?.method ?? 'GET',
        url,
        key: headers['X-Qoder-Settings-Key'],
        body: init?.body === undefined ? undefined : JSON.parse(String(init.body)),
      })
      const answer = (init?.method === 'POST' ? posts.shift() : gets.shift())?.() ?? { ok: false, status: 404, body: { error: 'no script' } }
      return { ok: answer.ok, status: answer.status, json: async () => answer.body }
    })
    vi.stubGlobal('fetch', fetchMock)
    return { calls, fetchMock }
  }

  const document = (key: string, value: Record<string, unknown>) => ({ key, value, base: {}, user: {} })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.useRealTimers()
    resetQuotaStatusDocuments()
    resetQuotaSignIn()
  })

  it('T-M2-8 heals a stale key by re-reading and retrying exactly once', async () => {
    vi.useFakeTimers()
    const { calls } = face({
      get: [
        () => ({ ok: true, status: 200, body: document('old-key', {}) }),
        // The re-read after the refusal hands back the re-minted key.
        () => ({ ok: true, status: 200, body: document('new-key', {}) }),
      ],
      post: [
        () => ({ ok: false, status: 403, body: { error: 'invalid-settings-key' } }),
        () => ({ ok: true, status: 200, body: { ok: true, started: true, jobId: 'umid-1-1' } }),
      ],
    })
    const scope = new OwnQuotaSettingsScope()
    const loading = scope.load()
    await vi.advanceTimersByTimeAsync(0)
    await loading

    const result = await scope.installUmid()
    expect(result).toEqual({ ok: true, started: true, alreadyRunning: false, jobId: 'umid-1-1' })
    // First POST with the stale key, then the re-read, then the retry with the
    // fresh one: exactly one heal, never a loop.
    const posts = calls.filter(call => call.method === 'POST')
    expect(posts.map(call => call.key)).toEqual(['old-key', 'new-key'])
    expect(posts.every(call => call.url === INSTALL)).toBe(true)
  })

  it('T-M2-8 does not re-read for a refusal that the key cannot fix', async () => {
    vi.useFakeTimers()
    const { calls } = face({
      get: [() => ({ ok: true, status: 200, body: document('k1', {}) })],
      post: [() => ({ ok: false, status: 403, body: { error: 'request-not-trusted' } })],
    })
    const scope = new OwnQuotaSettingsScope()
    const loading = scope.load()
    await vi.advanceTimersByTimeAsync(0)
    await loading

    const result = await scope.installUmid()
    expect(result.ok).toBe(false)
    expect(result.error).toBe('request-not-trusted')
    // A cross-site or non-loopback refusal is not a stale key: one attempt.
    expect(calls.filter(call => call.method === 'GET')).toHaveLength(1)
    expect(calls.filter(call => call.method === 'POST')).toHaveLength(1)
  })

  it('T-M2-8 passes alreadyRunning through as a success', async () => {
    vi.useFakeTimers()
    const { calls } = face({
      get: [() => ({ ok: true, status: 200, body: document('k1', {}) })],
      post: [() => ({ ok: true, status: 200, body: { ok: true, alreadyRunning: true, jobId: 'umid-9-3' } })],
    })
    const scope = new OwnQuotaSettingsScope()
    const loading = scope.load()
    await vi.advanceTimersByTimeAsync(0)
    await loading

    const result = await scope.installUmid()
    expect(result.ok).toBe(true)
    expect(result.alreadyRunning).toBe(true)
    expect(result.started).toBe(false)
    expect(result.jobId).toBe('umid-9-3')
    // A press means "install it", so the request never asks for a reinstall.
    expect(calls.find(call => call.method === 'POST')?.body).toEqual({ force: false })
  })

  it('T-M2-8 reads the key itself when nothing has loaded yet', async () => {
    vi.useFakeTimers()
    const { calls } = face({
      // No `load()` call: the button was pressed before the face was read.
      get: [() => ({ ok: true, status: 200, body: document('late-key', {}) })],
      post: [() => ({ ok: true, status: 200, body: { ok: true, started: true, jobId: 'umid-2-1' } })],
    })
    const scope = new OwnQuotaSettingsScope()
    const result = await scope.installUmid()
    expect(result.ok).toBe(true)
    expect(calls[0]?.url).toBe(FACE)
    expect(calls.find(call => call.method === 'POST')?.key).toBe('late-key')
  })
})

// ──────────────────────────── the status document ────────────────────────────

describe('status arms carry the native component', () => {
  const CLEANUP: (() => Promise<void>)[] = []

  beforeEach(() => {
    vi.stubEnv(QODER_PAT_ENV_CN, '')
    vi.stubEnv(QODER_PAT_ENV_GLOBAL, '')
  })

  afterEach(async () => {
    await Promise.all(CLEANUP.splice(0).map(clean => clean()))
    vi.unstubAllEnvs()
  })

  async function tempDir(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'qoder-umid-status-'))
    CLEANUP.push(() => rm(dir, { recursive: true, force: true }))
    return dir
  }

  function baseDeps(ownPath: string): QoderStatusRouteOptions {
    return {
      store: new QoderCredentialStore({ variant: CHINA_VARIANT, ownPath }),
      client: { fetchCredits: async () => ({ total: 0, accounts: [] }) },
      models: () => [],
    }
  }

  const NATIVE: QoderNativeDeviceStatus = {
    applicable: true,
    installed: false,
    dir: '/home/user/.dsh/qoder/umid',
    installing: false,
  }

  it('T-M2-6 puts the component on the signed-out arm', async () => {
    const own = join(await tempDir(), 'qoder.json')
    const status = await qoderWebStatus({ ...baseDeps(own), nativeDevice: () => NATIVE })
    expect(status.status).toBe('signed-out')
    expect(status.nativeDevice).toEqual(NATIVE)
  })

  it('T-M2-6 puts the component on the signed-in arm', async () => {
    const own = join(await tempDir(), 'qoder.json')
    await writeFile(own, JSON.stringify({ version: 2, pat: 'pt-secret-abcd', region: 'china', savedAt: 1_792_128_236_868 }))
    const status = await qoderWebStatus({ ...baseDeps(own), nativeDevice: () => NATIVE })
    expect(status.status).toBe('signed-in')
    expect(status.nativeDevice).toEqual(NATIVE)
  })

  it('T-M2-6 leaves the document byte-identical when the host injects nothing', async () => {
    const own = join(await tempDir(), 'qoder.json')
    const status = await qoderWebStatus(baseDeps(own))
    // Not "undefined after serialization": the key must not exist at all, so a
    // host without the component produces exactly the document it did before.
    expect(Object.keys(status)).not.toContain('nativeDevice')
  })
})

// ─────────────────────────────── the card ───────────────────────────────

describe('native component card section', () => {
  let view: ReactTestRenderer | undefined
  let statusBody: QoderWebStatus
  let reads = 0
  const intervalHandles = new Map<number, () => void>()
  let nextHandle = 1

  const t = (key: keyof typeof en, params: Record<string, unknown> = {}): string =>
    Object.entries(params).reduce(
      (text, [name, value]) => text.replace(`{${name}}`, String(value)),
      en[key] as string,
    )

  function native(overrides: Partial<QoderNativeDeviceStatus> = {}): QoderNativeDeviceStatus {
    return { applicable: true, installed: false, dir: '/tmp/umid', installing: false, ...overrides }
  }

  function signedIn(nativeDevice: QoderNativeDeviceStatus | undefined): void {
    statusBody = {
      status: 'signed-in',
      pat: { source: 'card', savedAtMs: 1_700_000_000_000, patTail: 'abcd' },
      credits: { total: 40, totalSize: 100, accounts: [] },
      probeKey: 'test-probe-key',
      authKey: 'test-auth-key',
      probe: { consent: true, running: false, candidates: ['hy3'], results: [] },
      ...nativeDevice === undefined ? {} : { nativeDevice },
    }
  }

  /**
   * The signed-out arm, which is where a missing component is usually first
   * seen: the user installs it so that signing in can work at all.
   */
  function signedOut(nativeDevice: QoderNativeDeviceStatus | undefined): void {
    statusBody = {
      status: 'signed-out',
      ...nativeDevice === undefined ? {} : { nativeDevice },
    }
  }

  /** The card's settings face, optionally carrying the install method. */
  function cardScope(installUmid?: () => Promise<QuotaUmidInstallResult>) {
    return {
      getSnapshot: () => ({ status: 'ready' as const, writable: true, value: {} }),
      subscribe: () => () => {},
      set: async () => true,
      ...installUmid === undefined ? {} : { installUmid },
    }
  }

  async function mountCard(scope?: unknown): Promise<void> {
    act(() => view?.unmount())
    const props = {
      t,
      ...scope === undefined ? {} : { scope },
    } as unknown as Parameters<typeof QoderPluginCard>[0]
    await act(async () => { view = create(createElement(QoderPluginCard, props)) })
  }

  const rendered = (): string => JSON.stringify(view!.toJSON())
  const buttonLabels = (): string[] =>
    view!.root.findAllByType('button').map(node => String(node.children.join('')))
  /**
   * Fire every interval the component has armed — all of them, whatever their
   * period, because the stub does not model time. What the poll tests care about
   * is how many timers exist and that firing them re-reads the document.
   */
  async function tickIntervals(): Promise<number> {
    const handlers = [...intervalHandles.values()]
    await act(async () => {
      for (const handler of handlers) handler()
    })
    return handlers.length
  }

  beforeEach(() => {
    // The component lives in 高级设置, which ships folded.
    setAdvancedSettingsOpen(true)
    reads = 0
    intervalHandles.clear()
    signedIn(native())
    vi.stubGlobal('fetch', vi.fn(async () => {
      reads += 1
      return { ok: true, status: 200, json: async () => statusBody }
    }))
    vi.stubGlobal('window', {
      setInterval: (handler: () => void) => {
        const handle = nextHandle++
        intervalHandles.set(handle, handler)
        return handle
      },
      clearInterval: (handle: number) => { intervalHandles.delete(handle) },
    })
    vi.stubGlobal('requestAnimationFrame', (cb: (time: number) => void) => cb(0))
  })

  afterEach(() => {
    act(() => view?.unmount())
    view = undefined
    resetAdvancedSettings()
    resetQuotaStatusDocuments()
    resetQuotaSignIn()
    vi.unstubAllGlobals()
  })

  it('T-M2-5 draws the install button only when the scope carries the method', async () => {
    await mountCard(cardScope(async () => ({ ok: true, started: true })))
    expect(buttonLabels()).toContain(en.umidInstallButton)

    await mountCard(cardScope())
    // A host that serves no install route must not offer the action (R10).
    expect(buttonLabels()).not.toContain(en.umidInstallButton)
    // The state is still described, so the user knows what is missing.
    expect(rendered()).toContain(en.umidHeading)
  })

  it('T-M2-5 draws nothing when the component does not apply to this variant', async () => {
    signedIn(native({ applicable: false }))
    await mountCard(cardScope(async () => ({ ok: true, started: true })))
    expect(rendered()).not.toContain(en.umidHeading)
    expect(buttonLabels()).not.toContain(en.umidInstallButton)
  })

  it('T-M2-7 treats alreadyRunning as a running job and re-reads the status', async () => {
    const installUmid = vi.fn(async () => ({ ok: true, alreadyRunning: true, jobId: 'umid-1-1' }))
    await mountCard(cardScope(installUmid))
    const before = reads
    await act(async () => {
      const button = view!.root.findAllByType('button')
        .find(node => String(node.children.join('')) === en.umidInstallButton)
      button?.props.onClick()
    })
    expect(installUmid).toHaveBeenCalledTimes(1)
    // The state the user asked for is reported as progress, never as an error.
    expect(rendered()).toContain(en.umidInstallRunning)
    expect(rendered()).not.toContain('Install failed')
    // Polling: the card re-reads the document instead of waiting for a new route.
    expect(reads).toBeGreaterThan(before)
  })

  it('T-M2-7 keeps the button disabled while the host reports a running job', async () => {
    signedIn(native({ installing: true, jobId: 'umid-7-1' }))
    await mountCard(cardScope(async () => ({ ok: true, started: true })))
    const label = en.umidInstalling
    expect(buttonLabels()).toContain(label)
    const button = view!.root.findAllByType('button').find(node => String(node.children.join('')) === label)
    expect(button?.props.disabled).toBe(true)
  })

  it('T-M2-10 arms the short install poll only while a job is running', async () => {
    // Idle: the page poll is the only timer on the card, so a finished job is
    // not polled at 3s forever.
    signedIn(native({ installing: false }))
    await mountCard(cardScope(async () => ({ ok: true, started: true })))
    expect(intervalHandles.size).toBe(1)
    expect(await tickIntervals()).toBe(1)

    // Running: one extra timer, and it re-reads the document — this is the read
    // that turns the button back on when the job ends.
    act(() => view?.unmount())
    intervalHandles.clear()
    signedIn(native({ installing: true, jobId: 'umid-10-1' }))
    await mountCard(cardScope(async () => ({ ok: true, started: true })))
    expect(intervalHandles.size).toBe(2)
    const before = reads
    expect(await tickIntervals()).toBe(2)
    expect(reads).toBeGreaterThanOrEqual(before + 2)

    // The job ends: the next read carries installing:false, and the short timer
    // must be torn down right there rather than left ticking every 3s.
    signedIn(native({ installing: false }))
    expect(await tickIntervals()).toBe(2)
    expect(intervalHandles.size).toBe(1)
  })

  it('T-M2-10 keeps polling a signed-out card, where the component is usually missing', async () => {
    // The page poll bails out for a variant known to be signed out; the install
    // poll must not, or a job started before sign-in would never be seen to end.
    signedOut(native({ installing: true, jobId: 'umid-10-2' }))
    await mountCard(cardScope(async () => ({ ok: true, started: true })))
    // One timer: the install poll. The page poll has already stood itself down.
    expect(intervalHandles.size).toBe(1)
    const before = reads
    expect(await tickIntervals()).toBe(1)
    expect(reads).toBeGreaterThan(before)
    // And the section is offered on this arm too, so the job is visible at all.
    expect(rendered()).toContain(en.umidHeading)
  })

  it('T-M2-7 reports a refusal where the button is', async () => {
    await mountCard(cardScope(async () => ({ ok: false, error: 'the install directory is not writable' })))
    await act(async () => {
      const button = view!.root.findAllByType('button')
        .find(node => String(node.children.join('')) === en.umidInstallButton)
      button?.props.onClick()
    })
    expect(rendered()).toContain('Install failed')
    expect(rendered()).toContain('not writable')
  })

  it('T-M2-7 shows the self-check failure and the last install error from the document', async () => {
    signedIn(native({
      installed: true,
      version: '1.2.3',
      selfCheck: { ok: false, reason: 'the component exited 3' },
      lastError: 'the download timed out',
    }))
    await mountCard(cardScope(async () => ({ ok: true, started: true })))
    expect(rendered()).toContain(en.umidInstalled)
    expect(rendered()).toContain('v1.2.3')
    expect(rendered()).toContain('the component exited 3')
    expect(rendered()).toContain('the download timed out')
  })
})

// ──────────────────────────── the assembled plugin ────────────────────────────

/**
 * The projection that builds {@link QoderNativeDeviceStatus} lives inside the
 * plugin's own `apply()`, so the only way to prove it is wired is to boot the
 * plugin and read the status route it registered.
 *
 * The identity cases matter most: `cache-stale` is the state worth surfacing —
 * the component is gone (deleted by antivirus, or `~/.dsh` cleaned) but a
 * previously sampled identity still serves check-in. Without it the card cannot
 * tell that apart from a machine that never had an identity at all.
 */
describe('assembled plugin reports the native component', () => {
  let context: Context | undefined
  let root: string | undefined

  /** Collects the routes `apply()` registers, the way the Host's service does. */
  class FakeWebServer extends Service {
    static current: FakeWebServer | undefined
    readonly routes = new Map<string, (req: IncomingMessage, res: ServerResponse) => Promise<void>>()

    constructor(ctx: Context) {
      super(ctx, 'webServer')
      FakeWebServer.current = this
    }

    register(route: { kind: string, path: string, handler: (req: IncomingMessage, res: ServerResponse) => Promise<void> }): () => void {
      this.routes.set(route.path, route.handler)
      return () => { this.routes.delete(route.path) }
    }
  }

  afterEach(async () => {
    await context?.fiber.dispose()
    context = undefined
    FakeWebServer.current = undefined
    if (root !== undefined) await rm(root, { recursive: true, force: true })
    root = undefined
    vi.restoreAllMocks()
    vi.unstubAllEnvs()
    vi.unstubAllGlobals()
  })

  /** Isolate every file root under a fresh temp dir and silence the real PATs. */
  async function isolate(): Promise<void> {
    root = await mkdtemp(join(tmpdir(), 'qoder-umid-boot-'))
    vi.stubEnv('DSH_HOME', root)
    vi.stubEnv(Qoder.QODER_DATA_DIR_ENV, root)
    vi.stubEnv('HOME', root)
    vi.stubEnv('USERPROFILE', root)
    // An empty component directory, so `installed` is false whatever this
    // machine happens to have. Without it the host would read the developer's
    // real `~/.dsh/qoder/umid` and the cases below would depend on it.
    vi.stubEnv('QODER_UMID_DIR', join(root, 'umid'))
    vi.stubEnv(QODER_PAT_ENV_CN, '')
    vi.stubEnv(QODER_PAT_ENV_GLOBAL, '')
    // Upstream traffic must not reach the network. Nothing here needs an
    // answer: these cases read local state only.
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 404 })))
  }

  async function boot(): Promise<void> {
    const ctx = new Context()
    context = ctx
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(FakeWebServer)
    await ctx.plugin(Qoder, {})
    await vi.waitFor(() => {
      expect(FakeWebServer.current?.routes.has(QODER_GLOBAL_STATUS_PATH)).toBe(true)
    })
  }

  /** Read one variant's status document over real HTTP. */
  async function statusDocument(path: string = QODER_GLOBAL_STATUS_PATH): Promise<QoderWebStatus> {
    const routes = FakeWebServer.current?.routes ?? new Map()
    const server = createServer((req, res) => {
      const handler = routes.get(new URL(req.url ?? '/', 'http://127.0.0.1').pathname)
      if (handler === undefined) { res.writeHead(404).end('{}'); return }
      void handler(req, res)
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    try {
      const port = (server.address() as { port: number }).port
      const response = await realFetch(`http://127.0.0.1:${port}${path}`, {
        headers: { host: `127.0.0.1:${port}` },
      })
      return await response.json() as QoderWebStatus
    } finally {
      server.closeAllConnections()
      await new Promise<void>(resolve => server.close(() => resolve()))
    }
  }

  /** Drive one probe-control action over real HTTP, as the card would. */
  async function probeAction(path: string, key: string, action: string): Promise<Record<string, unknown>> {
    const routes = FakeWebServer.current?.routes ?? new Map()
    const server = createServer((req, res) => {
      const handler = routes.get(new URL(req.url ?? '/', 'http://127.0.0.1').pathname)
      if (handler === undefined) { res.writeHead(404).end('{}'); return }
      void handler(req, res)
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    try {
      const port = (server.address() as { port: number }).port
      const response = await realFetch(`http://127.0.0.1:${port}${path}`, {
        method: 'POST',
        headers: {
          host: `127.0.0.1:${port}`,
          'content-type': 'application/json',
          'x-qoder-probe-key': key,
        },
        body: JSON.stringify({ action }),
      })
      return await response.json() as Record<string, unknown>
    } finally {
      server.closeAllConnections()
      await new Promise<void>(resolve => server.close(() => resolve()))
    }
  }

  it('T-M2-6 reports a fresh identity cache as the source of the identity', async () => {
    await isolate()
    identityProbe.value = { cachedAt: 1_700_000_000_000, stale: false }
    await boot()
    const status = await statusDocument()
    expect(status.nativeDevice?.identity?.source).toBe('cache')
    expect(status.nativeDevice?.identity?.stale).toBe(false)
    expect(status.nativeDevice?.identity?.cachedAt).toBe(1_700_000_000_000)
  })

  it('T-M2-6 reports an expired identity cache as stale, not as absent', async () => {
    await isolate()
    // The component is gone (antivirus, or `~/.dsh` cleaned) but the sampled
    // identity still serves check-in: the state this field exists to surface.
    identityProbe.value = { cachedAt: 1_600_000_000_000, stale: true }
    await boot()
    const status = await statusDocument()
    expect(status.nativeDevice?.identity?.source).toBe('cache-stale')
    expect(status.nativeDevice?.identity?.stale).toBe(true)
  })

  it('T-M2-6 omits the identity entirely when the realm has no cache', async () => {
    await isolate()
    identityProbe.value = undefined
    await boot()
    const status = await statusDocument()
    // A first-run machine has no identity to describe; the card must not be
    // told there is one.
    expect(status.nativeDevice).toBeDefined()
    expect(Object.keys(status.nativeDevice ?? {})).not.toContain('identity')
  })

  it('T-M2-1 registers the install route under the real apply', async () => {
    await isolate()
    await boot()
    // Registered, and deliberately never pressed here: the real handler would
    // run the real installer, which these tests must never do.
    expect(FakeWebServer.current?.routes.has(QODER_UMID_INSTALL_PATH)).toBe(true)
  })

  it('T-M2-9 rewrites no-client only where the component could be installed', async () => {
    await isolate()
    // Both variants signed in: `probeKey` rides a signed-in document, and it is
    // what unlocks the probe-control route this case drives.
    await writeFile(
      join(root ?? '', Qoder.GLOBAL_VARIANT.ownFilename),
      JSON.stringify({ version: 2, pat: 'pt-boot-global-0000000000000001', region: 'global', savedAt: Date.now() }),
    )
    await writeFile(
      join(root ?? '', CHINA_VARIANT.ownFilename),
      JSON.stringify({ version: 2, pat: 'pt-boot-china-00000000000000002', region: 'china', savedAt: Date.now() }),
    )
    // The transport's verdict is stubbed: whether a real machine can mint an
    // identity is the transport's business, and reaching it would need the
    // component itself. What this case owns is what the HOST does with the
    // verdict — which is exactly the R12 rule.
    vi.spyOn(QoderCheckInService.prototype, 'checkIn').mockResolvedValue({
      variantId: 'qoder-global',
      date: '2026-10-27',
      timestamp: Date.now(),
      status: 'error',
      reasonCode: 'no-client',
      message: 'No Qoder desktop client found on this machine.',
    } satisfies QoderCheckInResult)
    await boot()
    const document = await statusDocument()
    // Only a signed-in document carries `probeKey`; anything else means the
    // credentials this case wrote were not adopted, and the route cannot be
    // driven at all.
    expect(document.status).toBe('signed-in')
    const key = document.status === 'signed-in' ? document.probeKey : undefined
    expect(typeof key).toBe('string')
    const installable = await probeAction(QODER_GLOBAL_PROBE_PATH, key ?? '', 'checkin')
    const notInstallable = await probeAction(QODER_PROBE_PATH, key ?? '', 'checkin')
    // Installable-but-missing: the card must be able to offer the install.
    expect(installable['reasonCode']).toBe('no-native-component')
    // The China variant is not identity-gated, so its component is not a thing
    // this machine lacks — the honest reason stays `no-client`, whose hint does
    // not point at a button that would not help.
    expect(notInstallable['reasonCode']).toBe('no-client')
  })
})

// ---------------------------------------------------------------------------
// Q-07 — the self-check child is stopped, then awaited, then staging is removed
// ---------------------------------------------------------------------------

/**
 * The self-check child used to be killed and the install's staging directory
 * deleted in the same tick, without waiting for the child to close its stdio
 * pipes. On Windows that is an EBUSY race: the directory is still held by the
 * process that was just killed (or is still flushing its answer).
 *
 * These cases script the child's events so the contract is observable: the
 * child is killed, its `close` arrives, the runner settles, and only then is
 * the staging directory removed. A real short-lived Node child covers the
 * ordinary close path on whatever host runs the suite.
 */
describe('self-check process teardown', () => {
  type SpawnInjection = Parameters<typeof runSelfCheckProcess>[1]

  /** A `ChildProcess` stand-in whose kill → close ordering the case scripts. */
  class FakeSelfCheckChild extends EventEmitter {
    readonly stdout = new PassThrough()
    readonly stderr = new PassThrough()
    exitCode: number | null = null
    signalCode: NodeJS.Signals | null = null
    kills = 0
    /** Called when the runner kills this child; the case decides what follows. */
    onKill: (child: FakeSelfCheckChild) => void = () => {}
    kill(): boolean {
      this.kills += 1
      this.onKill(this)
      return true
    }
    /** End the child the way a real process does: exit, then close. */
    exit(code: number): void {
      this.exitCode = code
      this.emit('close', code, null)
    }
  }

  const cleanups: (() => void)[] = []

  afterEach(() => {
    for (const clean of cleanups.splice(0)) clean()
  })

  function tempDir(prefix = 'qoder-umid-teardown-'): string {
    const dir = mkdtempSync(join(tmpdir(), prefix))
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
    return dir
  }

  function stagingDirs(destDir: string): string[] {
    try {
      return readdirSync(destDir).filter(name => name.startsWith('.staging-'))
    } catch {
      return []
    }
  }

  // -------------------------------------------------------------------------
  // The smallest package shape installUmid accepts on any host: one ELF blob,
  // base64'd into a bundle, wrapped in a real gzip'd ustar tarball.
  // -------------------------------------------------------------------------

  const fixtureHints = { fileMin: 100, fileMax: 4096, dllMin: 1024 }
  const fixtureBlobMinChars = 60

  function fixtureElf(size = 512): Buffer {
    const bytes = Buffer.alloc(size)
    bytes[0] = 0x7F
    bytes[1] = 0x45
    bytes[2] = 0x4C
    bytes[3] = 0x46
    bytes[4] = 2 // ELFCLASS64
    bytes[5] = 1 // little endian
    bytes.writeUInt16LE(0x3E, 18) // EM_X86_64
    return bytes
  }

  function fixtureTarHeader(name: string, size: number): Buffer {
    const header = Buffer.alloc(512)
    header.write(name, 0, 'utf8')
    header.write(`${size.toString(8).padStart(11, '0')}\0`, 124, 'latin1')
    header[156] = 0x30 // typeflag '0'
    header.write('ustar\0', 257, 'latin1')
    header.write('00', 263, 'latin1')
    header.fill(0x20, 148, 156)
    let sum = 0
    for (const byte of header) sum += byte
    header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 'latin1')
    return header
  }

  function fixtureTarArchive(entries: readonly { name: string; data: Buffer }[]): Buffer {
    const parts: Buffer[] = []
    for (const entry of entries) {
      parts.push(fixtureTarHeader(entry.name, entry.data.length))
      parts.push(entry.data)
      const pad = (512 - (entry.data.length % 512)) % 512
      if (pad > 0) parts.push(Buffer.alloc(pad))
    }
    parts.push(Buffer.alloc(1024)) // end-of-archive marker
    return Buffer.concat(parts)
  }

  function fixtureTarball(): string {
    const bundle = `const asset0 = "${fixtureElf().toString('base64')}"\n`
    const archive = fixtureTarArchive([
      { name: 'package/package.json', data: Buffer.from(JSON.stringify({ name: '@qoder-ai/qodercli', version: '9.9.9' })) },
      { name: 'package/bundle/qoder-worker-runtime.mjs', data: Buffer.from(bundle, 'utf8') },
    ])
    const path = join(tempDir(), 'fixture.tgz')
    writeFileSync(path, gzipSync(archive))
    return path
  }

  it('T-Q07-1 settles a timed-out self-check only after the child closes', async () => {
    const events: string[] = []
    const child = new FakeSelfCheckChild()
    child.onKill = killed => {
      events.push('kill')
      // The killed component has not flushed its pipes yet. The runner must
      // wait for the close before it reports the timeout.
      setTimeout(() => {
        killed.stdout.write('{"machineToken":"too-late"}\n')
        events.push('close')
        killed.exit(3)
      }, 20)
    }
    const outcome = await runSelfCheckProcess(
      { binary: 'component', cwd: tempDir(), args: ['3'], timeoutMs: 5 },
      (() => child) as unknown as SpawnInjection,
    )
    events.push('self-check-settled')
    expect(events).toEqual(['kill', 'close', 'self-check-settled'])
    expect(child.kills).toBe(1)
    expect(outcome.code).toBeNull()
    expect(outcome.spawnError).toContain('did not answer within')
  })

  it('T-Q07-2 settles a flooding self-check only after the child closes', async () => {
    const events: string[] = []
    const child = new FakeSelfCheckChild()
    child.onKill = killed => {
      events.push('kill')
      // Exits non-zero, but only after flushing: the exact Windows case that
      // used to leave a busy staging directory behind.
      setTimeout(() => {
        killed.stdout.write('{"machineToken":"flushed"}\n')
        events.push('close')
        killed.exit(7)
      }, 20)
    }
    const outcome = await runSelfCheckProcess(
      { binary: 'component', cwd: tempDir(), args: ['3'], timeoutMs: 10_000 },
      (() => {
        child.stdout.write(Buffer.alloc(1024 * 1024 + 64, 'x'))
        return child
      }) as unknown as SpawnInjection,
    )
    events.push('self-check-settled')
    expect(events).toEqual(['kill', 'close', 'self-check-settled'])
    expect(outcome.spawnError).toContain('flooded stdout')
  })

  it('T-Q07-3 never removes staging before the self-check child has closed', async () => {
    const destDir = tempDir('qoder-umid-dest-')
    const tarballPath = fixtureTarball()
    const events: string[] = []
    let stagingAtKill = 0
    let stagingAtClose = 0
    const child = new FakeSelfCheckChild()
    child.onKill = killed => {
      events.push('kill')
      stagingAtKill = stagingDirs(destDir).length
      setTimeout(() => {
        killed.stdout.write('{"machineToken":"flushed"}\n')
        events.push('close')
        stagingAtClose = stagingDirs(destDir).length
        killed.exit(9)
      }, 30)
    }
    const result = await installUmid({
      destDir,
      tarballPath,
      platform: 'linux',
      arch: 'x64',
      sizeHints: fixtureHints,
      minBlobChars: fixtureBlobMinChars,
      selfCheck: async request => {
        const outcome = await runSelfCheckProcess(request, (() => {
          setImmediate(() => {
            child.stdout.write(Buffer.alloc(1024 * 1024 + 64, 'x'))
          })
          return child
        }) as unknown as SpawnInjection)
        events.push('self-check-settled')
        return outcome
      },
    })
    events.push('staging-removed')
    expect(events).toEqual(['kill', 'close', 'self-check-settled', 'staging-removed'])
    // The staging directory existed while the child was stopped, and it was
    // still there when the child closed: nothing was removed before the close.
    expect(stagingAtKill).toBe(1)
    expect(stagingAtClose).toBe(1)
    expect(stagingDirs(destDir)).toEqual([])
    expect(result.ok).toBe(false)
    expect(result.error).toContain('flooded stdout')
  })

  it('T-Q07-4 completes a real child through close and stays bounded on a kill', async () => {
    const answered = await runSelfCheckProcess({
      binary: process.execPath,
      cwd: tempDir(),
      args: ['-e', 'process.stdout.write(JSON.stringify({ machineToken: "real" }) + "\\n")'],
      timeoutMs: 15_000,
    })
    expect(answered.code).toBe(0)
    expect(answered.spawnError).toBeUndefined()
    expect(answered.stdout).toContain('"machineToken":"real"')

    const started = Date.now()
    const silent = await runSelfCheckProcess({
      binary: process.execPath,
      cwd: tempDir(),
      args: ['-e', 'setInterval(() => {}, 1000)'],
      timeoutMs: 150,
    })
    expect(silent.spawnError).toContain('did not answer within')
    // The kill path is bounded: the runner waited for the close, not for the
    // child's own lifetime.
    expect(Date.now() - started).toBeLessThan(5_000)
  })
})
