/**
 * Per-account device fingerprints for the Qoder wire protocol.
 *
 * The upstream groups traffic by the `Cosy-Machineid` / `Cosy-Machinehostname`
 * headers. Reporting one process-wide machine id therefore makes every account
 * driven from this host look like a single device — the exact pattern the
 * anti-abuse layer treats as a shared/scripted client. The official clients
 * mint these values per account instead, and both are deterministic hashes of
 * the account id (no random component), so a restart never changes an account's
 * fingerprint. This module reproduces that derivation.
 *
 * The optional `seed` is the one escape hatch from "forever": the plugin's
 * reset control rotates a host-level seed (see `device-seed.ts`), which gives
 * every account a fresh fingerprint without touching its PAT, its login, or
 * this host's real machine id. An absent seed contributes no bytes at all, so
 * the derivation stays byte-for-byte what it always was and upgrading changes
 * nobody's identity.
 *
 * @module dsh-qoder-plugin/qoder/transport/device-identity
 */

import { createHash } from 'node:crypto'

/**
 * Salt the reference client prepends to the account id before hashing the
 * machine id. Kept as an exported default so callers can name the salt they
 * rely on while the derivation stays one function.
 */
export const machineIdSalt = 'machine'

/**
 * Salt the reference client uses for the per-account hostname label. It is a
 * separate salt so the hostname cannot be cross-referenced with the machine id.
 */
const machineHostnameSalt = 'hostname'

function md5Hex(value: string): string {
  return createHash('md5').update(value).digest('hex')
}

/**
 * The seed's contribution to the hashed input, `''` when there is none.
 *
 * One helper so both derivations splice it identically: the seed sits between
 * the salt and the account id. Empty and absent are the same thing on purpose —
 * a seed file that exists but is blank must not silently change identities.
 */
function seedPrefix(seed: string | undefined): string {
  return seed === undefined || seed === '' ? '' : `${seed}:`
}

/**
 * Derive an account's device id as `MD5(salt:[seed:]userID)` forged into UUIDv4
 * shape.
 *
 * The upstream accepts (and the reference clients send) a UUIDv4-shaped value,
 * so version nibble `4` is written at position 12 and the RFC 4122 variant
 * nibble at 16; the digest is otherwise untouched. Being derived rather than
 * random is what makes the id stable for an account across restarts, and
 * distinct per account even when several accounts share this host.
 *
 * @param userID - the account's upstream user id.
 * @param salt - the salt to prepend; defaults to the reference client's.
 * @param seed - host-level seed from the reset control; omitted means the
 *   historical derivation.
 */
export function deriveMachineId(userID: string, salt: string = machineIdSalt, seed?: string): string {
  const hash = md5Hex(`${salt}:${seedPrefix(seed)}${userID}`)
  const forged = `${hash.slice(0, 12)}4${hash.slice(13, 16)}a${hash.slice(17)}`
  return [
    forged.slice(0, 8),
    forged.slice(8, 12),
    forged.slice(12, 16),
    forged.slice(16, 20),
    forged.slice(20),
  ].join('-')
}

/**
 * Derive an account's machine hostname as `DESKTOP-` plus seven uppercase hex
 * characters of `MD5(hostname:[seed:]userID)`.
 *
 * This is the Windows-computer-name shape of `Cosy-Machinehostname`, which the
 * official desktop client sends on the inference stream only. Deriving it from
 * the account id keeps it stable across restarts and per account, and avoids
 * leaking this host's real run name to the upstream.
 *
 * @param userID - the account's upstream user id.
 * @param seed - host-level seed from the reset control; omitted means the
 *   historical derivation.
 */
export function deriveMachineHostname(userID: string, seed?: string): string {
  const digest = md5Hex(`${machineHostnameSalt}:${seedPrefix(seed)}${userID}`)
  return `DESKTOP-${digest.slice(0, 7).toUpperCase()}`
}
