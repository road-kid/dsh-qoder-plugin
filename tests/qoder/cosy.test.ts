import test from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { buildAuthHeaders, computeSigPath } from '../../src/qoder/transport/wire/cosy.ts'
import { getQoderChatUrl } from '../../src/qoder/transport/endpoints.ts'
import { getMachineId } from '../../src/qoder/transport/machine-id.ts'

test('computeSigPath strips the /algo prefix', () => {
  assert.equal(computeSigPath('https://api3.qoder.sh/algo/api/v2/service'), '/api/v2/service')
})

test('getMachineId accepts an isolated storage location', () => {
  const path = join(tmpdir(), `qoder-machine-${crypto.randomUUID()}`, 'machine_id')
  const machineId = getMachineId([path])
  assert.ok(machineId.length > 0)
  assert.equal(getMachineId([path]), machineId)
})

test('buildAuthHeaders creates the required bounded COSY headers', () => {
  const body = Buffer.from('encoded-body')
  const headers = buildAuthHeaders(body, getQoderChatUrl(), {
    userID: 'user-123',
    authToken: 'jt-token',
    name: 'User',
    email: 'user@example.com',
    machineID: 'machine-123',
  })
  assert.ok(headers.Authorization!.startsWith('Bearer COSY.'))
  assert.equal(headers['Cosy-User'], 'user-123')
  assert.equal(headers['Cosy-Bodylength'], String(body.length))
  assert.equal(headers['Cosy-Sigpath'], '/api/v2/service/pro/sse/agent_chat_generation')
})

test('buildAuthHeaders prefers the account-derived machine id over the host id', () => {
  // The real host id must stay available for the metadata requests that send
  // it as Cosy-MachineToken, so the COSY wire selects the derived id explicitly
  // and falls back to the host id only when no derivation was supplied.
  const derived = buildAuthHeaders(null, getQoderChatUrl(), {
    userID: 'user-123',
    authToken: 'jt-token',
    name: '',
    email: '',
    machineID: 'host-machine-id',
    derivedMachineID: 'derived-machine-id',
  })
  assert.equal(derived['Cosy-Machineid'], 'derived-machine-id')
  assert.equal(derived['Cosy-Machinetoken'], 'derived-machine-id')

  const fallback = buildAuthHeaders(null, getQoderChatUrl(), {
    userID: 'user-123',
    authToken: 'jt-token',
    name: '',
    email: '',
    machineID: 'host-machine-id',
  })
  assert.equal(fallback['Cosy-Machineid'], 'host-machine-id')
})

test('buildAuthHeaders emits the per-account hostname only where the client does', () => {
  // `Cosy-Machinehostname` is an inference-stream-only header: the model list,
  // status and campaign requests must not carry it, so the caller opts in.
  const credentials = {
    userID: 'user-123',
    authToken: 'jt-token',
    name: '',
    email: '',
    machineID: 'machine-123',
    machineHostname: 'DESKTOP-ABC1234',
  }
  assert.equal(buildAuthHeaders(null, getQoderChatUrl(), credentials)['Cosy-Machinehostname'], undefined)
  assert.equal(
    buildAuthHeaders(null, getQoderChatUrl(), credentials, { includeMachineHostname: true })['Cosy-Machinehostname'],
    'DESKTOP-ABC1234',
  )
  // No hostname to send and the option on: an absent value must not become an
  // empty header, which the upstream would treat as a malformed identity.
  assert.equal(buildAuthHeaders(null, getQoderChatUrl(), {
    userID: 'user-123', authToken: 'jt-token', name: '', email: '',
  }, { includeMachineHostname: true })['Cosy-Machinehostname'], undefined)
})
