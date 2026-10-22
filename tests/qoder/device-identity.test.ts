import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { deriveMachineHostname, deriveMachineId } from '../../src/qoder/transport/device-identity.ts'
import { getMachineId } from '../../src/qoder/transport/machine-id.ts'

const uuidV4Shape = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u

test('deriveMachineId forges a stable UUIDv4-shaped id per account', () => {
  const id = deriveMachineId('user-1')
  assert.match(id, uuidV4Shape)
  assert.equal(id.length, 36)
  // Stability is the point: a restart must not look like a new device.
  assert.equal(deriveMachineId('user-1'), id)
  assert.notEqual(deriveMachineId('user-2'), id)
  // The salt participates in the derivation, so it is not a constant prefix.
  assert.notEqual(deriveMachineId('user-1', 'other-salt'), id)
})

test('deriveMachineId rewrites only the version and variant nibbles of the digest', () => {
  // Cross-check against the plain MD5 the reference client uses: if this ever
  // diverges, the upstream stops recognising the id as client-shaped.
  const hash = createHash('md5').update('machine:user-1').digest('hex')
  const expected = [
    hash.slice(0, 8),
    hash.slice(8, 12),
    `4${hash.slice(13, 16)}`,
    `a${hash.slice(17, 20)}`,
    hash.slice(20),
  ].join('-')
  assert.equal(deriveMachineId('user-1'), expected)
})

test('deriveMachineHostname is a stable DESKTOP label unique per account', () => {
  const hostname = deriveMachineHostname('user-1')
  assert.match(hostname, /^DESKTOP-[0-9A-F]{7}$/u)
  assert.equal(hostname.length, 15)
  assert.equal(deriveMachineHostname('user-1'), hostname)
  assert.notEqual(deriveMachineHostname('user-2'), hostname)
})

test('derived identities differ from the process-wide machine id', () => {
  // The fallback id is random per install; a derived one must never be able to
  // collapse back onto it, or two accounts would share one device again.
  const globalId = getMachineId([join(tmpdir(), `qoder-machine-${randomUUID()}`, 'machine_id')])
  assert.notEqual(deriveMachineId('user-1'), globalId)
  assert.notEqual(deriveMachineId('user-2'), globalId)
})
