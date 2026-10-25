import test from 'node:test'
import assert from 'node:assert/strict'
import { QoderAuthService } from '../../src/qoder/transport/auth.ts'
import { deriveMachineHostname, deriveMachineId } from '../../src/qoder/transport/device-identity.ts'
import { buildAuthHeaders } from '../../src/qoder/transport/wire/cosy.ts'
import { QoderLlmError } from '../../src/qoder/errors.ts'
import { qoderUserAgent } from '../../src/qoder/transport/wire/version.ts'

test('QoderAuthService exchanges once, resolves identity, and caches credentials', async () => {
  let exchangeCalls = 0
  let userInfoCalls = 0
  let exchangeHeaders: Record<string, string> | undefined
  let userInfoHeaders: Record<string, string> | undefined
  const fetchMock = async (input: URL | Request, init?: RequestInit): Promise<Response> => {
    const url = String(input)
    if (url.includes('/jobToken/exchange')) {
      exchangeCalls++
      exchangeHeaders = init?.headers as Record<string, string>
      assert.deepEqual(JSON.parse(String(init?.body)), { personal_token: 'pt-test-token' })
      return new Response(JSON.stringify({ token: 'jt-token', expires_in: 3_600_000 }), { status: 200 })
    }
    if (url.includes('/userinfo')) {
      userInfoCalls++
      userInfoHeaders = init?.headers as Record<string, string>
      return new Response(JSON.stringify({ id: 'user-999', email: 'user@qoder.sh', name: 'Subscriber' }))
    }
    throw new Error(`unexpected URL: ${url}`)
  }
  const service = new QoderAuthService({
    fetch: fetchMock as typeof fetch,
    resolveMachineId: () => 'machine-test',
  })

  const first = await service.getCredentials('pt-test-token')
  const second = await service.getCredentials('pt-test-token')
  assert.equal(first.authToken, 'jt-token')
  assert.equal(first.userID, 'user-999')
  // The real host id stays on the credentials for the metadata requests
  // (status sends it as Cosy-MachineToken), while the COSY client requests get
  // an id derived from THIS account instead of the shared host-wide one.
  assert.equal(first.machineID, 'machine-test')
  assert.equal(first.derivedMachineID, deriveMachineId('user-999'))
  assert.equal(first.machineHostname, deriveMachineHostname('user-999'))
  assert.equal(second, first)
  assert.equal(exchangeCalls, 1)
  assert.equal(userInfoCalls, 1)
  assert.equal(exchangeHeaders?.['user-agent'], qoderUserAgent)
  assert.equal(exchangeHeaders?.['cosy-clienttype'], '5')
  assert.equal(userInfoHeaders?.['user-agent'], qoderUserAgent)
  assert.equal(userInfoHeaders?.['cosy-clienttype'], '5')
})

test('QoderAuthService gives two accounts on this host different device identities', async () => {
  // One host, one `resolveMachineId`, two accounts: the real id is shared by
  // necessity, so the COSY client identity has to be derived per account —
  // otherwise both accounts present as the same device upstream.
  const accounts = ['account-a', 'account-b'] as const
  const services = accounts.map((account) => new QoderAuthService({
    fetch: (async (input: URL | Request) => String(input).includes('/jobToken/exchange')
      ? new Response(JSON.stringify({ token: `jt-${account}`, expires_in: 3_600_000 }))
      : new Response(JSON.stringify({ id: account, name: account }))) as typeof fetch,
    resolveMachineId: () => 'shared-host-machine-id',
  }))
  const [first, second] = await Promise.all(accounts.map(
    (account, index) => services[index]!.getCredentials(`pt-${account}`),
  ))

  assert.equal(first!.machineID, 'shared-host-machine-id')
  assert.equal(second!.machineID, 'shared-host-machine-id')
  assert.equal(first!.derivedMachineID, deriveMachineId('account-a'))
  assert.equal(second!.derivedMachineID, deriveMachineId('account-b'))
  assert.notEqual(first!.derivedMachineID, second!.derivedMachineID)
  assert.equal(first!.machineHostname, deriveMachineHostname('account-a'))
  assert.notEqual(first!.machineHostname, second!.machineHostname)

  // The chat/inference request is where the derived values must actually land.
  const firstChat = buildAuthHeaders(null, 'https://api3.qoder.sh/algo/api/v2/service/pro/sse/agent_chat_generation', first!)
  const secondChat = buildAuthHeaders(null, 'https://api3.qoder.sh/algo/api/v2/service/pro/sse/agent_chat_generation', second!)
  assert.equal(firstChat['Cosy-Machineid'], deriveMachineId('account-a'))
  assert.notEqual(firstChat['Cosy-Machineid'], secondChat['Cosy-Machineid'])
})

test('QoderAuthService shares one exchange between concurrent callers', async () => {
  let exchangeCalls = 0
  const fetchMock = async (input: URL | Request): Promise<Response> => {
    if (String(input).includes('/jobToken/exchange')) {
      exchangeCalls++
      await new Promise(resolve => setTimeout(resolve, 20))
      return new Response(JSON.stringify({ token: 'jt-shared', expires_in: 3_600_000 }))
    }
    return new Response(JSON.stringify({ id: 'user-shared' }))
  }
  const service = new QoderAuthService({
    fetch: fetchMock as typeof fetch,
    resolveMachineId: () => 'machine-test',
  })
  const credentials = await Promise.all([
    service.getCredentials('pt-shared'),
    service.getCredentials('pt-shared'),
    service.getCredentials('pt-shared'),
  ])
  assert.equal(exchangeCalls, 1)
  assert.ok(credentials.every(value => value.authToken === 'jt-shared'))
})

test('QoderAuthService aborts a caller and the unobserved exchange', async () => {
  let providerAborted = false
  const fetchMock = (_input: URL | Request, init?: RequestInit): Promise<Response> => new Promise((_, reject) => {
    init?.signal?.addEventListener('abort', () => {
      providerAborted = true
      reject(new DOMException('aborted', 'AbortError'))
    }, { once: true })
  })
  const service = new QoderAuthService({ fetch: fetchMock as typeof fetch })
  const controller = new AbortController()
  const request = service.getCredentials('pt-abort', controller.signal)
  controller.abort()
  await assert.rejects(request, (error: Error) => {
    assert.ok(error instanceof QoderLlmError)
    assert.equal((error as QoderLlmError).code, 'ABORTED')
    return true
  })
  await new Promise(resolve => setTimeout(resolve, 0))
  assert.equal(providerAborted, true)
})

test('QoderAuthService rejects missing identity without leaking provider bodies', async () => {
  const diagnostics: string[] = []
  const fetchMock = async (input: URL | Request): Promise<Response> => {
    if (String(input).includes('/jobToken/exchange')) {
      return new Response(JSON.stringify({ token: 'jt-secret', expires_in: 3_600_000 }))
    }
    return new Response(JSON.stringify({ email: 'secret@example.com', token: 'pt-secret' }))
  }
  const service = new QoderAuthService({
    fetch: fetchMock as typeof fetch,
    logger: {
      debug: (message, ...details) => diagnostics.push(JSON.stringify([message, ...details])),
      error: (message, ...details) => diagnostics.push(JSON.stringify([message, ...details])),
    },
  })
  await assert.rejects(service.getCredentials('pt-secret'), (error: Error) => {
    assert.ok(error instanceof QoderLlmError)
    assert.equal((error as QoderLlmError).code, 'AUTH')
    assert.ok(!error.message.includes('pt-secret'))
    assert.ok(!error.message.includes('secret@example.com'))
    return true
  })
  assert.doesNotMatch(diagnostics.join('\n'), /pt-secret|secret@example\.com/)
  assert.match(diagnostics.join('\n'), /auth\.exchange/)
  assert.match(diagnostics.join('\n'), /auth\.user-info/)
})

test('QoderAuthService targets region-specific OpenAPI endpoints and caches separately', async () => {
  const requests: string[] = []
  const fetchMock = async (input: URL | Request): Promise<Response> => {
    const url = String(input)
    requests.push(url)
    if (url.includes('/jobToken/exchange')) {
      const isChina = url.includes('openapi.qoder.com.cn')
      return new Response(JSON.stringify({
        token: isChina ? 'jt-china' : 'jt-global',
        expires_in: 3_600_000,
      }))
    }
    if (url.includes('/userinfo')) {
      const isChina = url.includes('openapi.qoder.com.cn')
      return new Response(JSON.stringify({
        id: isChina ? 'user-cn' : 'user-global',
        name: isChina ? 'CN User' : 'Global User',
      }))
    }
    throw new Error(`unexpected URL: ${url}`)
  }
  const globalService = new QoderAuthService({
    fetch: fetchMock as typeof fetch,
    resolveMachineId: () => 'machine-test',
    region: 'global',
  })
  const chinaService = new QoderAuthService({
    fetch: fetchMock as typeof fetch,
    resolveMachineId: () => 'machine-test',
    region: 'china',
  })

  const globalCreds = await globalService.getCredentials('pt-test')
  assert.equal(globalCreds.authToken, 'jt-global')
  assert.equal(globalCreds.userID, 'user-global')
  assert.ok(requests.some(url => url.includes('openapi.qoder.sh/api/v1/jobToken/exchange')))

  const chinaCreds = await chinaService.getCredentials('pt-test')
  assert.equal(chinaCreds.authToken, 'jt-china')
  assert.equal(chinaCreds.userID, 'user-cn')
  assert.ok(requests.some(url => url.includes('openapi.qoder.com.cn/api/v1/jobToken/exchange')))
})

test('QoderAuthService classifies malformed exchange JSON as a protocol failure', async () => {
  const service = new QoderAuthService({
    fetch: (async () => new Response('{')) as typeof fetch,
  })
  await assert.rejects(service.getCredentials('pt-malformed'), (error: Error) => (
    error instanceof QoderLlmError && error.code === 'MALFORMED_RESPONSE'
  ))
})

test('QoderAuthService shares one exchange between overlapping heal attempts', async () => {
  // Two chats rejected at the same moment used to run two overlapping
  // exchangeFresh calls; each one's cache clear/set raced the other and, with
  // an upstream retiring the previous job token on a new exchange, they
  // invalidated each other's credentials — one chat recovered, the other
  // failed (observed 2026-09-26 22:36). Overlapping heals must share one
  // exchange.
  let exchangeCalls = 0
  const fetchMock = async (input: URL | Request): Promise<Response> => {
    if (String(input).includes('/jobToken/exchange')) {
      exchangeCalls++
      await new Promise(resolve => setTimeout(resolve, 20))
      return new Response(JSON.stringify({ token: 'jt-heal-shared', expires_in: 3_600_000 }))
    }
    return new Response(JSON.stringify({ id: 'user-heal' }))
  }
  const service = new QoderAuthService({
    fetch: fetchMock as typeof fetch,
    resolveMachineId: () => 'machine-test',
  })

  const [first, second] = await Promise.all([
    service.exchangeFresh('pt-heal'),
    service.exchangeFresh('pt-heal'),
  ])
  assert.equal(exchangeCalls, 1, 'overlapping heal exchanges collapse into one upstream call')
  assert.equal(first.authToken, 'jt-heal-shared')
  assert.equal(second, first)
})

test('QoderAuthService keeps a shared heal exchange alive when one healer aborts', async () => {
  // The heal exchange must not run on any caller's signal: the initiating
  // chat going away (user stop, host cancel) used to cancel the exchange that
  // the other healers — and the cache refresh after it — were waiting on.
  const fetchMock = async (input: URL | Request): Promise<Response> => {
    if (String(input).includes('/jobToken/exchange')) {
      await new Promise(resolve => setTimeout(resolve, 20))
      return new Response(JSON.stringify({ token: 'jt-survivor', expires_in: 3_600_000 }))
    }
    return new Response(JSON.stringify({ id: 'user-survivor' }))
  }
  const service = new QoderAuthService({
    fetch: fetchMock as typeof fetch,
    resolveMachineId: () => 'machine-test',
  })

  const controller = new AbortController()
  const initiator = service.exchangeFresh('pt-survivor', controller.signal)
  const joiner = service.exchangeFresh('pt-survivor')
  controller.abort()
  await assert.rejects(initiator, (error: Error) => (
    error instanceof QoderLlmError && error.code === 'ABORTED'
  ))
  const joinerCredentials = await joiner
  assert.equal(joinerCredentials.authToken, 'jt-survivor')
  // and the refreshed credential is cached for the next getCredentials caller.
  const cached = await service.getCredentials('pt-survivor')
  assert.equal(cached.authToken, 'jt-survivor')
})

test('QoderAuthService mints the device id from the seed it is given', async () => {
  // The reset control's whole mechanism: the seed is read at mint time, so
  // rotating it and dropping the cache is all it takes to change the
  // fingerprint an account presents.
  const fetchMock = async (input: URL | Request): Promise<Response> => {
    if (String(input).includes('/jobToken/exchange')) {
      return new Response(JSON.stringify({ token: 'jt-seeded', expires_in: 3_600_000 }))
    }
    return new Response(JSON.stringify({ id: 'user-seeded' }))
  }
  let seed: string | undefined = 'seed-a'
  const service = new QoderAuthService({
    fetch: fetchMock as typeof fetch,
    resolveMachineId: () => 'machine-test',
    resolveDeviceSeed: () => seed,
  })

  const first = await service.getCredentials('pt-seeded')
  assert.equal(first.derivedMachineID, deriveMachineId('user-seeded', undefined, 'seed-a'))
  assert.equal(first.machineHostname, deriveMachineHostname('user-seeded', 'seed-a'))
  // Not the unseeded derivation, and not the shared host id.
  assert.notEqual(first.derivedMachineID, deriveMachineId('user-seeded'))
  assert.notEqual(first.derivedMachineID, 'machine-test')

  // Rotate: the cached credential still holds the old id (nothing re-derives on
  // its own) — that is exactly why the reset also clears the cache.
  seed = 'seed-b'
  const cached = await service.getCredentials('pt-seeded')
  assert.equal(cached, first)
  service.clear()
  const reminted = await service.getCredentials('pt-seeded')
  assert.equal(reminted.derivedMachineID, deriveMachineId('user-seeded', undefined, 'seed-b'))
  assert.notEqual(reminted.derivedMachineID, first.derivedMachineID)
  // Same device hostname epoch: both headers move together.
  assert.equal(reminted.machineHostname, deriveMachineHostname('user-seeded', 'seed-b'))
})

test('QoderAuthService without a seed resolver derives exactly as before', async () => {
  const fetchMock = async (input: URL | Request): Promise<Response> => {
    if (String(input).includes('/jobToken/exchange')) {
      return new Response(JSON.stringify({ token: 'jt-plain', expires_in: 3_600_000 }))
    }
    return new Response(JSON.stringify({ id: 'user-plain' }))
  }
  const service = new QoderAuthService({
    fetch: fetchMock as typeof fetch,
    resolveMachineId: () => 'machine-test',
  })
  const credentials = await service.getCredentials('pt-plain')
  assert.equal(credentials.derivedMachineID, deriveMachineId('user-plain'))
  assert.equal(credentials.machineHostname, deriveMachineHostname('user-plain'))
})
