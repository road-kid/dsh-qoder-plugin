import { createServer, request as httpRequest, type Server } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import { qoderDeviceResetHandler, type QoderDeviceResetRouteOptions } from '../src/device-reset-route.ts'
import { QODER_DEVICE_RESET_PATH } from '../src/status-paths.ts'

/**
 * Offline tests for the device-code reset route.
 *
 * Same guard shape as the PAT and settings routes: this is a WRITE (it rotates
 * the host-level seed and drops every cached job token), any local process can
 * address 127.0.0.1, and a reset the user did not ask for changes the identity
 * every account presents upstream.
 */

const KEY = 'reset-key-under-test'

let server: Server | undefined

afterEach(async () => {
  if (server !== undefined) {
    await new Promise<void>(resolve => server?.close(() => resolve()))
    server = undefined
  }
})

/** Mount the handler on an ephemeral port and return its origin. */
async function mount(deps: Partial<QoderDeviceResetRouteOptions> = {}): Promise<{ origin: string }> {
  const handler = qoderDeviceResetHandler({
    reset: async () => ({ accounts: 2 }),
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
): Promise<{ status: number; body: Record<string, unknown> }> {
  const url = new URL(origin)
  return await new Promise((resolve, reject) => {
    const request = httpRequest({
      host: url.hostname,
      port: url.port,
      path: QODER_DEVICE_RESET_PATH,
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

describe('device reset route guards', () => {
  it('rejects anything but POST', async () => {
    const { origin } = await mount()
    const response = await fetch(origin, { headers: { 'X-Qoder-Settings-Key': KEY } })
    expect(response.status).toBe(405)
  })

  it('rejects a request whose Host is not loopback', async () => {
    const { origin } = await mount()
    // A DNS-rebinding page arrives addressed to the attacker's domain.
    const { status, body } = await postRaw(origin, { Host: 'evil.example', 'X-Qoder-Settings-Key': KEY })
    expect(status).toBe(403)
    expect(body['error']).toBe('request-not-trusted')
  })

  it('rejects a cross-site Origin even on a loopback Host', async () => {
    const { origin } = await mount()
    const { status } = await postRaw(origin, {
      Host: '127.0.0.1',
      Origin: 'https://evil.example',
      'X-Qoder-Settings-Key': KEY,
    })
    expect(status).toBe(403)
  })

  it('rejects a missing or wrong key', async () => {
    const { origin } = await mount()
    expect((await postRaw(origin, { Host: '127.0.0.1' })).status).toBe(403)
    expect((await postRaw(origin, { Host: '127.0.0.1', 'X-Qoder-Settings-Key': 'nope' })).status).toBe(403)
    expect((await postRaw(origin, { Host: '127.0.0.1', 'X-Qoder-Settings-Key': `${KEY}x` })).status).toBe(403)
  })

  it('rejects an oversized body', async () => {
    const { origin } = await mount()
    const { status } = await postRaw(origin, { Host: '127.0.0.1', 'X-Qoder-Settings-Key': KEY }, 'x'.repeat(8 * 1024))
    expect(status).toBe(413)
  })
})

describe('device reset route answer', () => {
  it('reports how many accounts were re-identified', async () => {
    const { origin } = await mount()
    const { status, body } = await postRaw(origin, { Host: '127.0.0.1', 'X-Qoder-Settings-Key': KEY })
    expect(status).toBe(200)
    expect(body['ok']).toBe(true)
    expect(body['accounts']).toBe(2)
    expect(typeof body['at']).toBe('number')
  })

  it('reports a failed reset as 200 with ok:false, so the card can show why', async () => {
    const { origin } = await mount({
      reset: async () => { throw new Error('EACCES: permission denied') },
    })
    const { status, body } = await postRaw(origin, { Host: '127.0.0.1', 'X-Qoder-Settings-Key': KEY })
    // Not a 5xx: the card reads the verdict, and a refused write must render as
    // a failed reset rather than as a broken card.
    expect(status).toBe(200)
    expect(body['ok']).toBe(false)
    expect(String(body['error'])).toContain('permission denied')
  })

  it('does not leak a token-shaped string in the failure message', async () => {
    // Built from parts so the literal never appears in this file as a token.
    const token = ['eyJhbGciOiJIUzI1NiJ9', 'eyJzdWIiOiIxIn0', 'c2lnbmF0dXJl'].join('.')
    const { origin } = await mount({
      reset: async () => {
        // A realistic failure can quote the header value it choked on.
        throw new Error(`rejected ${token}`)
      },
    })
    const { body } = await postRaw(origin, { Host: '127.0.0.1', 'X-Qoder-Settings-Key': KEY })
    expect(String(body['error'])).not.toContain(token)
    expect(String(body['error'])).toContain('[redacted token]')
  })

  it('runs the reset exactly once per accepted request', async () => {
    let calls = 0
    const { origin } = await mount({
      reset: async () => {
        calls += 1
        return { accounts: 1 }
      },
    })
    await postRaw(origin, { Host: '127.0.0.1', 'X-Qoder-Settings-Key': KEY })
    // A refused request above must not have reached the operation; this one did.
    expect(calls).toBe(1)
  })
})
