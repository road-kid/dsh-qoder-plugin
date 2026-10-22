import test from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { metadataCosyVersion, qoderIdeVersion, qoderUserAgent } from '../../src/qoder/transport/wire/version.ts'
import { buildAuthHeaders, qoderDesktopClientType, qoderClientType } from '../../src/qoder/transport/wire/cosy.ts'
import { openApiJsonRequest } from '../../src/qoder/transport/request.ts'

const transportDir = fileURLToPath(new URL('../../src/qoder/transport', import.meta.url))

function readTransportSources(dir = transportDir): Map<string, string> {
  const sources = new Map<string, string>()
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) {
      for (const [name, source] of readTransportSources(path)) sources.set(name, source)
    } else if (entry.name.endsWith('.ts')) {
      sources.set(path, readFileSync(path, 'utf8'))
    }
  }
  return sources
}

test('client versions are the ones the reference implementation confirms', () => {
  // qoder_sign.py: COSY_VERSION default 1.1.75 (cosy-version header + signed
  // payload cosyVersion). qoder_accounts.py: DESKTOP_CLIENT_VERSION default
  // 0.4.8 for the desktop/campaign request family. These are wire fingerprints,
  // so the defaults matter and must not silently drift with a package bump.
  assert.equal(qoderIdeVersion, '1.1.75')
  assert.equal(metadataCosyVersion, '0.4.8')
  // The user agent is derived from the same constant, so UA and cosy-version
  // cannot disagree on the inference path.
  assert.equal(qoderUserAgent, `qoder/${qoderIdeVersion}`)
})

test('the COSY wire signs and labels requests with the CLI version', () => {
  const headers = buildAuthHeaders(null, 'https://api3.qoder.sh/algo/api/v2/service/pro/sse/agent_chat_generation', {
    userID: 'user-1',
    authToken: 'jt-token',
    name: '',
    email: '',
    machineID: 'machine-1',
  })
  assert.equal(headers['Cosy-Version'], qoderIdeVersion)
  assert.match(headers.Authorization!, /^Bearer COSY\./u)
})

test('metadata requests derive the user agent from the version and use the desktop Cosy-Version', async () => {
  let requestHeaders: Record<string, string> | undefined
  await openApiJsonRequest((async (_input: URL | Request, init?: RequestInit) => {
    requestHeaders = init?.headers as Record<string, string>
    return new Response('{}')
  }) as typeof fetch, {
    url: 'https://api3.qoder.sh/algo/api/v2/userinfo',
    token: 'jt-token',
    operation: 'UserInfo',
    logCategory: 'account.userinfo',
  })
  assert.equal(requestHeaders?.['user-agent'], qoderUserAgent)
  assert.equal(requestHeaders?.['cosy-version'], metadataCosyVersion)
  assert.equal(requestHeaders?.['cosy-clienttype'], qoderClientType)
  // The campaign family overrides the client type to the desktop one but keeps
  // the same desktop build version.
  assert.equal(qoderDesktopClientType, '10')
})

test('environment overrides let a roll-out pin another build', async () => {
  const previousIde = process.env.QODER_IDE_VERSION
  const previousDesktop = process.env.QODER_DESKTOP_VERSION
  process.env.QODER_IDE_VERSION = '  9.9.9  '
  process.env.QODER_DESKTOP_VERSION = '8.8.8'
  try {
    // Re-import under a fresh specifier so the module re-evaluates the env at
    // load time, exactly like a process started with the override set.
    const version = await import('../../src/qoder/transport/wire/version.ts?override=1') as typeof import('../../src/qoder/transport/wire/version.ts')
    assert.equal(version.qoderIdeVersion, '9.9.9')
    assert.equal(version.qoderUserAgent, 'qoder/9.9.9')
    assert.equal(version.metadataCosyVersion, '8.8.8')
  } finally {
    if (previousIde === undefined) delete process.env.QODER_IDE_VERSION
    else process.env.QODER_IDE_VERSION = previousIde
    if (previousDesktop === undefined) delete process.env.QODER_DESKTOP_VERSION
    else process.env.QODER_DESKTOP_VERSION = previousDesktop
  }
})

test('client version literals live only in wire/version.ts', () => {
  // T8 acceptance: no scattered literals. Scans the transport sources so a
  // later edit cannot reintroduce a header value next to its usage.
  for (const [path, source] of readTransportSources()) {
    if (path.endsWith(join('wire', 'version.ts'))) continue
    for (const literal of ['1.1.47', '1.1.75', '0.4.8', "'1.0.1'"]) {
      assert.equal(source.includes(literal), false, `${literal} must not appear in ${path}`)
    }
  }
})
