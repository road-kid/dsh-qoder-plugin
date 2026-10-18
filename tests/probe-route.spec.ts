import { createServer, request as httpRequest, type Server } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import { createProbeKey, qoderProbeHandler, type QoderProbeRouteOptions } from '../src/probe-route.ts'

/**
 * Offline tests for the probe control route, the plugin's only state-changing
 * endpoint. Two guards must both hold before anything happens: the loopback
 * Host/Origin check (drops DNS-rebinding pages) and the in-process key (proves
 * the caller was the same-origin card, since any local process can write
 * `Host: 127.0.0.1`).
 */

let server: Server | undefined

afterEach(async () => {
  if (server !== undefined) {
    await new Promise<void>(resolve => server?.close(() => resolve()))
    server = undefined
  }
})

/** Mount the handler on an ephemeral port and return its origin + key. */
async function mount(deps?: Partial<QoderProbeRouteOptions>): Promise<{ origin: string; key: string; calls: string[] }> {
  const key = createProbeKey()
  const calls: string[] = []
  const handler = qoderProbeHandler({
    probe: async modelId => {
      calls.push(modelId)
      return { state: 'ok' }
    },
    clear: () => { calls.push('clear') },
    ...deps,
  }, key)
  server = createServer((req, res) => { void handler(req, res) })
  await new Promise<void>(resolve => server?.listen(0, '127.0.0.1', () => resolve()))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('no port')
  return { origin: `http://127.0.0.1:${address.port}`, key, calls }
}

/** POST one control action. */
async function post(
  origin: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(origin, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  })
  return { status: response.status, body: await response.json() as Record<string, unknown> }
}

/**
 * POST with full control over the request headers, including `Host`, which
 * `fetch` refuses to set. Needed to exercise the rebinding guard.
 */
async function postRaw(
  origin: string,
  body: unknown,
  headers: Record<string, string>,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const url = new URL(origin)
  const payload = JSON.stringify(body)
  return await new Promise((resolve, reject) => {
    const request = httpRequest({
      host: url.hostname,
      port: url.port,
      path: '/',
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload), ...headers },
    }, response => {
      const chunks: Buffer[] = []
      response.on('data', chunk => chunks.push(chunk as Buffer))
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8')
        let parsed: Record<string, unknown> = {}
        try { parsed = JSON.parse(text) as Record<string, unknown> } catch { /* leave empty */ }
        resolve({ status: response.statusCode ?? 0, body: parsed })
      })
    })
    request.on('error', reject)
    request.end(payload)
  })
}

describe('probe control route', () => {
  it('accepts a probe carrying the correct key', async () => {
    const { origin, key, calls } = await mount()
    const result = await post(origin, { action: 'probe', model: 'auto' }, { 'x-qoder-probe-key': key })
    expect(result.status).toBe(200)
    expect(result.body['state']).toBe('ok')
    expect(calls).toEqual(['auto'])
  })

  it('rejects a probe with no key', async () => {
    const { origin, calls } = await mount()
    const result = await post(origin, { action: 'probe', model: 'auto' })
    expect(result.status).toBe(403)
    expect(result.body['error']).toBe('invalid-probe-key')
    // Nothing was spent.
    expect(calls).toEqual([])
  })

  it('rejects a wrong key of the same length', async () => {
    const { origin, key, calls } = await mount()
    const wrong = `${key.slice(0, -1)}${key.endsWith('a') ? 'b' : 'a'}`
    const result = await post(origin, { action: 'probe', model: 'auto' }, { 'x-qoder-probe-key': wrong })
    expect(result.status).toBe(403)
    expect(calls).toEqual([])
  })

  it('rejects a non-loopback Host even with the right key', async () => {
    const { origin, key, calls } = await mount()
    // `fetch` refuses to set a `Host` header (it is a forbidden header name),
    // so a spoofed Host has to go through the raw HTTP client — which is
    // exactly what a DNS-rebinding page's request looks like on the wire.
    const result = await postRaw(origin, { action: 'probe', model: 'auto' }, {
      'x-qoder-probe-key': key,
      'Host': 'attacker.example',
    })
    expect(result.status).toBe(403)
    expect(result.body['error']).toBe('request-not-trusted')
    expect(calls).toEqual([])
  })

  it('rejects a non-loopback Origin even with the right key', async () => {
    const { origin, key, calls } = await mount()
    const result = await post(origin, { action: 'probe', model: 'auto' }, {
      'x-qoder-probe-key': key,
      'Origin': 'https://attacker.example',
    })
    expect(result.status).toBe(403)
    expect(calls).toEqual([])
  })

  it('refuses GET', async () => {
    const { origin, key } = await mount()
    const response = await fetch(origin, { headers: { 'x-qoder-probe-key': key } })
    expect(response.status).toBe(405)
  })

  it('rejects a malformed action, and a probe with no model', async () => {
    const { origin, key, calls } = await mount()
    const headers = { 'x-qoder-probe-key': key }
    expect((await post(origin, { action: 'nope' }, headers)).status).toBe(400)
    expect((await post(origin, { action: 'probe' }, headers)).status).toBe(400)
    expect((await post(origin, { action: 'probe', model: '   ' }, headers)).status).toBe(400)
    expect((await post(origin, 'not json', headers)).status).toBe(400)
    expect(calls).toEqual([])
  })

  it('rejects an oversized body', async () => {
    const { origin, key } = await mount()
    const result = await post(origin, { action: 'probe', model: 'x'.repeat(5000) }, { 'x-qoder-probe-key': key })
    expect(result.status).toBe(413)
  })

  it('accepts a clear action', async () => {
    const { origin, key, calls } = await mount()
    const result = await post(origin, { action: 'clear' }, { 'x-qoder-probe-key': key })
    expect(result.status).toBe(200)
    expect(calls).toEqual(['clear'])
  })

  it('refuses a refresh when the mount offers none', async () => {
    const { origin, key, calls } = await mount()
    const result = await post(origin, { action: 'refresh' }, { 'x-qoder-probe-key': key })
    expect(result.status).toBe(404)
    expect(result.body['error']).toBe('refresh-not-supported')
    expect(calls).toEqual([])
  })

  it('runs the refresh action when the mount provides one', async () => {
    const { origin, key } = await mount({
      refresh: async () => ({ state: 'refreshed', reason: '6 models' }),
    })
    const result = await post(origin, { action: 'refresh' }, { 'x-qoder-probe-key': key })
    expect(result).toMatchObject({ status: 200, body: { state: 'refreshed' } })
  })

  it('accepts the maximum-context preference only when the host supports it', async () => {
    let enabled: boolean | undefined
    const { origin, key } = await mount({
      setMaximumContextWindow: async value => {
        enabled = value
        return { state: 'updated' }
      },
    })
    const result = await post(origin, { action: 'set-maximum-context-window', enabled: true }, { 'x-qoder-probe-key': key })
    expect(result).toMatchObject({ status: 200, body: { state: 'updated' } })
    expect(enabled).toBe(true)
    // Without the dep wired in, the same request is a 404, not a silent ok.
    const { origin: plain, key: plainKey } = await mount()
    const refused = await post(plain, { action: 'set-maximum-context-window', enabled: true }, { 'x-qoder-probe-key': plainKey })
    expect(refused.status).toBe(404)
    expect(refused.body['error']).toBe('context-window-setting-not-supported')
  })

  it('accepts set-models-enabled action and forwards to handler', async () => {
    let handled: { models: readonly string[]; enabled: boolean } | undefined
    const { origin, key } = await mount({
      setModelsEnabled: async opts => {
        handled = opts
        return { state: 'updated' }
      },
    })
    const result = await post(
      origin,
      { action: 'set-models-enabled', models: ['model-a', 'model-b'], enabled: false },
      { 'x-qoder-probe-key': key },
    )
    expect(result).toMatchObject({ status: 200, body: { state: 'updated' } })
    expect(handled).toEqual({ models: ['model-a', 'model-b'], enabled: false })
  })

  it('accepts set-model-context-window and forwards the model with its window', async () => {
    let handled: { model: string; window: number } | undefined
    const { origin, key } = await mount({
      setModelContextWindow: async opts => {
        handled = opts
        return { state: 'updated' }
      },
    })
    const result = await post(
      origin,
      { action: 'set-model-context-window', model: 'm1', window: 1_000_000 },
      { 'x-qoder-probe-key': key },
    )
    expect(result).toMatchObject({ status: 200, body: { state: 'updated' } })
    expect(handled).toEqual({ model: 'm1', window: 1_000_000 })
  })

  it('reads a zero window as "clear the override" and rejects a missing model', async () => {
    let handled: { model: string; window: number } | undefined
    const { origin, key } = await mount({
      setModelContextWindow: async opts => {
        handled = opts
        return { state: 'updated' }
      },
    })
    const cleared = await post(
      origin,
      { action: 'set-model-context-window', model: 'm1', window: 0 },
      { 'x-qoder-probe-key': key },
    )
    expect(cleared.status).toBe(200)
    expect(handled).toEqual({ model: 'm1', window: 0 })

    // No model id: the route must refuse rather than write an unnamed override.
    const refused = await post(
      origin,
      { action: 'set-model-context-window', window: 1_000_000 },
      { 'x-qoder-probe-key': key },
    )
    expect(refused.status).toBe(400)
    expect(refused.body['error']).toBe('invalid action')
  })

  it('runs the checkin action when provided', async () => {
    let checkedIn = false
    const { origin, key } = await mount({
      checkIn: async () => {
        checkedIn = true
        return { state: 'claimed', amount: 100 }
      },
    })

    const checkInRes = await post(origin, { action: 'checkin' }, { 'x-qoder-probe-key': key })
    expect(checkInRes).toMatchObject({ status: 200, body: { state: 'claimed', amount: 100 } })
    expect(checkedIn).toBe(true)
  })

  it('mints a distinct key per call', () => {
    expect(createProbeKey()).not.toBe(createProbeKey())
  })
})
