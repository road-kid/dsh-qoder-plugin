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
 * Derive an account's device id as `MD5(salt:userID)` forged into UUIDv4 shape.
 *
 * The upstream accepts (and the reference clients send) a UUIDv4-shaped value,
 * so version nibble `4` is written at position 12 and the RFC 4122 variant
 * nibble at 16; the digest is otherwise untouched. Being derived rather than
 * random is what makes the id stable for an account forever, and distinct per
 * account even when several accounts share this host.
 */
export function deriveMachineId(userID: string, salt: string = machineIdSalt): string {
  const hash = md5Hex(`${salt}:${userID}`)
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
 * characters of `MD5(hostname:userID)`.
 *
 * This is the Windows-computer-name shape of `Cosy-Machinehostname`, which the
 * official desktop client sends on the inference stream only. Deriving it from
 * the account id keeps it stable across restarts and per account, and avoids
 * leaking this host's real run name to the upstream.
 */
export function deriveMachineHostname(userID: string): string {
  const digest = md5Hex(`${machineHostnameSalt}:${userID}`)
  return `DESKTOP-${digest.slice(0, 7).toUpperCase()}`
}
