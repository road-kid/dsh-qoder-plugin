import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { getMachineId } from '../../src/qoder/transport/machine-id.ts'

/**
 * The machine-id chain decides which device identity every request presents.
 *
 * Two properties matter and neither is obvious from the code alone:
 *
 * 1. The official client's stored id wins. When a Qoder client is installed,
 *    the upstream already knows this machine by that value; picking anything
 *    else makes the plugin look like a second, unrelated device.
 * 2. The fallback is HOST-scoped. A per-profile seed made one computer report
 *    several device identities, one per DSH profile.
 *
 * The helper takes its candidate list as an argument precisely so these can be
 * exercised without touching the real `$HOME`.
 */

function isolated(dirs: string[]): { paths: string[]; dir: string } {
  const root = mkdtempSync(join(tmpdir(), 'qoder-machine-id-'))
  const paths = dirs.map(name => join(root, name))
  return { paths, dir: root }
}

function write(path: string, value: string): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, value, 'utf8')
}

test('prefers the official client id over the DSH fallback', () => {
  const { paths } = isolated(['client/machine_id', 'dsh/machine_id'])
  write(paths[0]!, 'client-issued-id')
  write(paths[1]!, 'dsh-seed')

  assert.equal(getMachineId(paths), 'client-issued-id')
})

test('falls back to the host-level seed when no client stored an id', () => {
  const { paths } = isolated(['client/machine_id', 'dsh/machine_id'])
  write(paths[1]!, 'host-seed')

  assert.equal(getMachineId(paths), 'host-seed')
})

test('creates one stable id at the host location and never invents a client file', () => {
  const { paths } = isolated(['client/machine_id', 'dsh/machine_id'])

  const first = getMachineId(paths)

  assert.ok(first.length > 0)
  assert.equal(getMachineId(paths), first)
  // The created seed must land in the LAST trusted location: writing a file
  // where the official client keeps its own id would forge that client's
  // identity, and a second profile would then disagree with the first.
  assert.equal(readFileSync(paths[1]!, 'utf8').trim(), first)
  assert.throws(() => readFileSync(paths[0]!, 'utf8'))
})
