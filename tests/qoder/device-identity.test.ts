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

test('no seed leaves the derivation byte-for-byte unchanged', () => {
  // The seed is an ADDED input: an install that never rotated one must keep the
  // fingerprints its accounts already registered upstream, so `undefined` and an
  // empty string have to be the same derivation as the pre-seed code.
  const hash = createHash('md5').update('machine:user-1').digest('hex')
  const expected = [
    hash.slice(0, 8),
    hash.slice(8, 12),
    `4${hash.slice(13, 16)}`,
    `a${hash.slice(17, 20)}`,
    hash.slice(20),
  ].join('-')
  assert.equal(deriveMachineId('user-1', undefined, undefined), expected)
  assert.equal(deriveMachineId('user-1', undefined, ''), expected)
  assert.equal(deriveMachineId('user-1', undefined, undefined), deriveMachineId('user-1'))
  assert.equal(deriveMachineHostname('user-1', ''), deriveMachineHostname('user-1'))
})

test('a seed re-derives both headers, and a different seed derives differently', () => {
  // This is what the reset control buys: same account, new device.
  const plain = deriveMachineId('user-1')
  const seeded = deriveMachineId('user-1', undefined, 'seed-a')
  const other = deriveMachineId('user-1', undefined, 'seed-b')
  assert.notEqual(seeded, plain)
  assert.notEqual(seeded, other)
  // Still client-shaped, and still stable for the same seed — a reset must not
  // make the id drift on every request.
  assert.match(seeded, uuidV4Shape)
  assert.equal(deriveMachineId('user-1', undefined, 'seed-a'), seeded)
  assert.notEqual(deriveMachineHostname('user-1', 'seed-a'), deriveMachineHostname('user-1'))
  assert.match(deriveMachineHostname('user-1', 'seed-a'), /^DESKTOP-[0-9A-F]{7}$/u)
})

test('a seed keeps two accounts on distinct devices', () => {
  // The seed perturbs the input, it does not replace the account: collapsing two
  // accounts onto one id here would undo the whole per-account derivation.
  assert.notEqual(deriveMachineId('user-1', undefined, 'seed-a'), deriveMachineId('user-2', undefined, 'seed-a'))
  assert.notEqual(
    deriveMachineHostname('user-1', 'seed-a'),
    deriveMachineHostname('user-2', 'seed-a'),
  )
})
