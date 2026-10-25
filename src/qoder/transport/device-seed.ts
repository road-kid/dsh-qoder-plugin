/**
 * The host-level seed that perturbs every account's device fingerprint.
 *
 * Per-account device ids are derived from the account id alone (see
 * `device-identity.ts`), which is what makes them stable — and also what makes
 * them impossible to change: an account whose fingerprint the upstream has
 * learned keeps it forever. This file is the one input the user can rotate, and
 * it is deliberately HOST level, next to the machine id and for the same
 * reason spelled out in `machine-id.ts`: a profile-scoped seed would let two DSH
 * profiles present one account as two different devices, which is the exact
 * inconsistency that invites an anti-abuse flag rather than clearing one.
 *
 * Rotation is additive, never destructive: the file only ever holds a random
 * string, so losing it is the same as never having rotated. The plugin's reset
 * control writes it and then drops the cached job tokens, which is what makes
 * the next request re-derive a new `Cosy-Machineid` / `Cosy-Machinehostname`.
 *
 * @module dsh-qoder-plugin/qoder/transport/device-seed
 */

import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/**
 * Where the seed lives: `~/.dsh/qoder/device_seed`, beside the machine id.
 *
 * Not under the profile directory on purpose — see this module's header. A
 * missing file is the normal, never-rotated state.
 */
export function defaultDeviceSeedPath(): string {
  return join(homedir(), '.dsh', 'qoder', 'device_seed')
}

/**
 * Read the current seed, or `undefined` when there is none.
 *
 * An unreadable or blank file is reported as "no seed" rather than as an error:
 * a seed nobody can read must leave accounts on their historical fingerprints,
 * never move them to a different one. That keeps a permissions accident from
 * silently re-identifying every account.
 *
 * @param path - seed file location; overridable so tests stay hermetic.
 */
export function readDeviceSeed(path: string = defaultDeviceSeedPath()): string | undefined {
  try {
    if (!existsSync(path)) return undefined
    const value = readFileSync(path, 'utf8').trim()
    return value === '' ? undefined : value
  } catch {
    return undefined
  }
}

/**
 * Mint a fresh seed, store it, and return it.
 *
 * Throws when the file cannot be written: the caller is a user-initiated reset,
 * and reporting "reset done" while the next request would still derive the old
 * fingerprint would be a lie.
 *
 * The write is tmp + rename, like every other file this plugin owns. A plain
 * overwrite that dies mid-write leaves a zero-length seed, which reads back as
 * "no seed" — silently returning every account to its historical fingerprint
 * right after the user asked for a new one. The rename also makes a concurrent
 * reader see either the old seed or the new one, never a half-written file.
 * `0o600` because the seed is the one input that decides what the upstream is
 * told about this machine: it belongs to the user, not to other local accounts.
 *
 * @param path - seed file location; overridable so tests stay hermetic.
 * @returns the new seed, 32 lowercase hex characters.
 */
export function rotateDeviceSeed(path: string = defaultDeviceSeedPath()): string {
  const seed = randomBytes(16).toString('hex')
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.tmp`
  try {
    writeFileSync(tmp, seed, { encoding: 'utf8', mode: 0o600 })
    renameSync(tmp, path)
  } catch (error: unknown) {
    // A failed write must not leave the temporary file behind for the next run
    // to trip over; the previous seed (or none) stays authoritative.
    rmSync(tmp, { force: true })
    throw error
  }
  return seed
}
