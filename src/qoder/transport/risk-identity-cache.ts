/**
 * The on-disk copy of the machine identity the native component minted.
 *
 * Asking the component is neither free nor always possible. Not free: one
 * resolution spawns the signed helper three times and votes the answers
 * together, because the identity it reports jitters between virtualisation
 * profiles on the same machine (see `risk-identity.ts` §6.5). Not always
 * possible: anti-virus software quarantines the helper, and a user may clean
 * `~/.dsh` without meaning to lose their check-in. Remembering the last answer
 * is what keeps a check-in working in both situations — inside the TTL the
 * component is never asked at all (I-04), and outside it an unusable component
 * still falls back to the remembered identity instead of degrading to
 * "no client" (I-13).
 *
 * Host level, next to the device seed and for the same reason spelled out in
 * `machine-id.ts`: two DSH profiles on one machine are one machine, and two
 * cache files would let them drift into two identities (I-12).
 *
 * The file is a CACHE, so every failure here is silent and every write is
 * best-effort. A cache that could make a check-in fail would be worse than no
 * cache: the identity in hand is already sufficient, and this module only
 * decides whether the next request has to spawn for it again.
 *
 * @module dsh-qoder-plugin/qoder/transport/risk-identity-cache
 */

import { randomBytes } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import type { QoderRegion } from '../region.ts'

/** Schema version of `machine-identity.json` (SPEC-UMID-003 §5.5). */
export const identityCacheSchema = 1

/**
 * The virtualisation facts the component reports alongside the identity.
 *
 * Kept because the upstream's risk view includes them and because they are
 * part of what the vote compares — but `percentage` is deliberately NOT part of
 * the vote: it is a floating-point estimate that changes between two spawns of
 * the same machine, so including it would make every vote disagree.
 */
export interface QoderCachedVmInfo {
  isVm?: boolean
  brand?: string
  vmTypeCode?: number
  percentage?: number
}

/** One realm's remembered identity. */
export interface QoderCachedIdentity {
  machineToken: string
  machineType: string
  machineCode: string
  /** Virtualisation facts of the sample that won the vote. */
  vmInfo?: QoderCachedVmInfo
  /** Product selector the identity was minted for (`3` global, `0` china). */
  environment?: string
  /** Where the identity came from; only the native component can mint one. */
  source: 'runtime-info'
  /** When the sample was taken, epoch milliseconds. */
  cachedAt: number
  /**
   * How the sample was chosen, for diagnosis: how many rounds were spent and
   * how the answers clustered (keyed by a hash of the vote key, never by the
   * token itself — see §5.5's "no plaintext machineToken" rule).
   */
  votes?: { rounds: number; distribution: Record<string, number> }
}

/** The file's shape, before any per-realm entry has been validated. */
interface IdentityCacheDocument {
  schema: number
  realm: Record<string, unknown>
}

/**
 * Where the cache lives: `~/.dsh/qoder/machine-identity.json`.
 *
 * Not under the profile directory, for the reason in this module's header.
 */
export function identityCachePath(home: string = homedir()): string {
  return join(home, '.dsh', 'qoder', 'machine-identity.json')
}

/**
 * Read one realm's cached identity, or `undefined` when there is none.
 *
 * A missing file is the normal state on a machine that has never checked in.
 * A file that is not a schema-1 document is treated as absent AND deleted: it
 * cannot be migrated (there is no older schema), and leaving it in place would
 * make every future read repeat the same failure.
 *
 * A single malformed realm entry is dropped from the answer without deleting
 * the file: the other realm's identity is still good data, and deleting it
 * because a sibling entry went bad would lose the very fallback this file
 * exists to provide.
 *
 * @param realm - Which product's identity to read (`global` / `china`).
 * @param path - Cache file location; overridable so tests stay hermetic.
 */
export function readCachedIdentity(realm: QoderRegion, path: string = identityCachePath()): QoderCachedIdentity | undefined {
  const document = readDocument(path)
  if (document === undefined) return undefined
  return entryFrom(document.realm[realm])
}

/**
 * Store one realm's identity, leaving every other realm untouched.
 *
 * Read-modify-write rather than a blind overwrite: two regions can resolve
 * concurrently in one process (a pool spans both) and two processes can resolve
 * at once (the host plus a CLI invocation). A blind overwrite would let the
 * slower writer erase the other realm's identity, which is exactly the fallback
 * the next check-in needs.
 *
 * Never throws: a cache write that fails costs one extra component spawn later,
 * which is not worth failing a check-in over.
 *
 * @returns whether the file on disk now holds the entry.
 */
export function writeCachedIdentity(
  realm: QoderRegion,
  identity: QoderCachedIdentity,
  path: string = identityCachePath(),
): boolean {
  const document = readDocument(path) ?? { schema: identityCacheSchema, realm: {} }
  document.realm[realm] = identity
  return writeDocument(document, path)
}

/**
 * Forget one realm's identity, leaving the other realm in place.
 *
 * Only a deliberate reset reaches here (`QODER_UMID_SELF_HEAL=1` self-heal or
 * the CLI's `reset-native`): the TTL expiring must re-sample, never forget, so
 * that a machine that cannot reach the component keeps the identity it already
 * proved (I-14).
 *
 * @returns whether anything was removed.
 */
export function clearCachedIdentity(realm: QoderRegion, path: string = identityCachePath()): boolean {
  const document = readDocument(path)
  if (document === undefined) return false
  if (!(realm in document.realm)) return false
  delete document.realm[realm]
  return writeDocument(document, path)
}

/** Where to clear the cache from, and the environment the caller resolved with. */
export interface QoderMachineIdentityCacheClearOptions {
  /** Home directory holding `.dsh`; defaults to the running user's home. */
  home?: string | undefined
  /**
   * The environment the caller resolved with.
   *
   * Accepted so a reset path can hand over exactly the environment it resolved
   * with, and deliberately not consulted: clearing is unconditional because a
   * cache file may predate the user turning `QODER_UMID_IDENTITY_CACHE` off, and
   * leaving that file behind would let a pre-reset identity outlive the reset.
   */
  env?: NodeJS.ProcessEnv | undefined
}

/**
 * Delete the on-disk identity cache entirely, for an explicit reset.
 *
 * A reset replaces the seed the component fingerprints (`umid reset-native`), so
 * the component would mint a NEW identity on the next spawn — but the cache
 * still holds the old one, and with `QODER_UMID_IDENTITY_TTL` defaulting to
 * "never expires" the stale entry is served forever. The reset would look like
 * it did nothing. I-14 forbids clearing the seed when the TTL merely expires;
 * it says nothing about a user asking for a reset, and a user-requested reset
 * must not be silently undone by a cache.
 *
 * Both realms go: the seed is machine-wide, so one reset changes the identity
 * for every product the component is asked about.
 *
 * Never throws. A reset that cannot delete this file is still worth completing
 * (the seed is already replaced) and a failed delete must not surface as a
 * command error, so the failure is reported as a plain `false`.
 *
 * @returns whether a cache file was removed; `false` when there was none or it
 * could not be removed.
 */
export function clearMachineIdentityCache(options: QoderMachineIdentityCacheClearOptions = {}): boolean {
  const path = identityCachePath(options.home ?? homedir())
  try {
    // Not `force: true`: the caller needs to know whether anything was actually
    // removed, and a missing file is the ordinary case on a fresh machine.
    rmSync(path)
    return true
  } catch {
    return false
  }
}

/**
 * How long a cached identity stays fresh, milliseconds (`QODER_UMID_IDENTITY_TTL`).
 *
 * Milliseconds, matching every other timeout in this plugin and the `cachedAt`
 * field it is compared against. `0` — the default, and the value used when the
 * variable is unset or unparsable — means "never expires".
 *
 * Lives here, next to the file it governs, because BOTH the resolution path in
 * `risk-identity.ts` and the status the host reports have to agree on what
 * "stale" means. Two copies of this rule would drift apart, and a status that
 * calls an identity stale while the resolution path happily serves it is worse
 * than no status at all.
 */
export function identityTtlMs(env: NodeJS.ProcessEnv): number {
  const raw = env['QODER_UMID_IDENTITY_TTL']?.trim()
  if (raw === undefined || raw === '') return 0
  const parsed = Number(raw)
  if (!Number.isFinite(parsed) || parsed <= 0) return 0
  return parsed
}

/**
 * Whether an entry is past its TTL.
 *
 * An unlimited TTL (`ttlMs <= 0`) never expires anything — the default, because
 * re-sampling costs three spawns of a signed helper and a machine's identity
 * does not change on its own (I-14: expiry re-samples, never forgets).
 */
export function identityExpired(entry: QoderCachedIdentity, ttlMs: number, now: number): boolean {
  if (ttlMs <= 0) return false
  return now - entry.cachedAt >= ttlMs
}

/** Where to read the status from; every field is injectable so tests stay hermetic. */
export interface QoderIdentityCacheStatusOptions {
  /** Home directory holding `.dsh`; defaults to the running user's home. */
  home?: string | undefined
  /** Environment carrying `QODER_UMID_IDENTITY_TTL`; defaults to the process's. */
  env?: NodeJS.ProcessEnv | undefined
  /** Clock, epoch milliseconds; defaults to `Date.now()`. */
  now?: number | undefined
}

/**
 * What the on-disk cache currently holds for one realm, for the host's status.
 *
 * Deliberately narrow: when the identity was taken and whether it has aged past
 * its TTL. It does NOT read the in-process memory cache — that cache belongs to
 * one process, and a status document whose answer depended on which process
 * asked would be untrustworthy. It does not spawn anything either: reporting
 * status must never cost three helper runs.
 *
 * `stale` is decided by the very rule the resolution path uses
 * ({@link identityTtlMs} + {@link identityExpired}), so status can never call an
 * identity stale while check-in is still serving it, or vice versa.
 *
 * @returns `undefined` when this realm has no cached identity — including when
 * the file is unreadable or corrupt, which reads as "no cache" and is cleaned up
 * on the way through.
 */
export function identityCacheStatus(
  realm: QoderRegion,
  options: QoderIdentityCacheStatusOptions = {},
): { cachedAt: number; stale: boolean } | undefined {
  const entry = readCachedIdentity(realm, identityCachePath(options.home ?? homedir()))
  if (entry === undefined) return undefined
  const ttlMs = identityTtlMs(options.env ?? process.env)
  return { cachedAt: entry.cachedAt, stale: identityExpired(entry, ttlMs, options.now ?? Date.now()) }
}

/** Parse the file, deleting it when it is not a schema-1 document. */
function readDocument(path: string): IdentityCacheDocument | undefined {
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch {
    // Absent (the normal case) or unreadable (permissions). Both mean "no
    // cache"; neither is worth reporting to a check-in that can still work.
    return undefined
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    discard(path)
    return undefined
  }
  if (!isRecord(parsed) || parsed['schema'] !== identityCacheSchema) {
    discard(path)
    return undefined
  }
  const realm = parsed['realm']
  if (!isRecord(realm)) {
    discard(path)
    return undefined
  }
  return { schema: identityCacheSchema, realm: { ...realm } }
}

/**
 * Write the document atomically, with `0600` (I-07).
 *
 * tmp + rename, like every other file this plugin owns: a reader must see the
 * old identity or the new one, never a half-written document that would parse
 * as corrupt and be deleted. The temporary name carries a random suffix so two
 * concurrent writers never share a temporary file — the loser of the rename
 * then reports a failed write instead of corrupting the winner's bytes.
 */
function writeDocument(document: IdentityCacheDocument, path: string): boolean {
  const tmp = `${path}.${randomBytes(6).toString('hex')}.tmp`
  try {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(tmp, `${JSON.stringify(document, undefined, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
    renameSync(tmp, path)
    return true
  } catch {
    try {
      rmSync(tmp, { force: true })
    } catch {
      // A leftover temporary file is inert; the authoritative file is intact.
    }
    return false
  }
}

/** Delete a file that cannot be read as a cache document. */
function discard(path: string): void {
  try {
    rmSync(path, { force: true })
  } catch {
    // The next read reports the same absence; a deletion that fails cannot be
    // retried into success here.
  }
}

/** Validate one realm entry out of the untyped document. */
function entryFrom(value: unknown): QoderCachedIdentity | undefined {
  if (!isRecord(value)) return undefined
  const machineToken = value['machineToken']
  const machineType = value['machineType']
  const machineCode = value['machineCode']
  const cachedAt = value['cachedAt']
  if (!isNonEmptyString(machineToken) || !isNonEmptyString(machineType) || !isNonEmptyString(machineCode)) return undefined
  if (typeof cachedAt !== 'number' || !Number.isFinite(cachedAt) || cachedAt <= 0) return undefined
  const entry: QoderCachedIdentity = {
    machineToken,
    machineType,
    machineCode,
    source: 'runtime-info',
    cachedAt,
  }
  const environment = value['environment']
  if (isNonEmptyString(environment)) entry.environment = environment
  const vmInfo = vmInfoFrom(value['vmInfo'])
  if (vmInfo !== undefined) entry.vmInfo = vmInfo
  const votes = votesFrom(value['votes'])
  if (votes !== undefined) entry.votes = votes
  return entry
}

function vmInfoFrom(value: unknown): QoderCachedVmInfo | undefined {
  if (!isRecord(value)) return undefined
  const info: QoderCachedVmInfo = {}
  const isVm = value['isVm']
  if (typeof isVm === 'boolean') info.isVm = isVm
  const brand = value['brand']
  if (isNonEmptyString(brand)) info.brand = brand
  const vmTypeCode = value['vmTypeCode']
  if (typeof vmTypeCode === 'number' && Number.isFinite(vmTypeCode)) info.vmTypeCode = vmTypeCode
  const percentage = value['percentage']
  if (typeof percentage === 'number' && Number.isFinite(percentage)) info.percentage = percentage
  return Object.keys(info).length === 0 ? undefined : info
}

function votesFrom(value: unknown): { rounds: number; distribution: Record<string, number> } | undefined {
  if (!isRecord(value)) return undefined
  const rounds = value['rounds']
  if (typeof rounds !== 'number' || !Number.isFinite(rounds) || rounds <= 0) return undefined
  const distribution: Record<string, number> = {}
  const raw = value['distribution']
  if (isRecord(raw)) {
    for (const [key, count] of Object.entries(raw)) {
      if (typeof count === 'number' && Number.isFinite(count) && count > 0) distribution[key] = count
    }
  }
  return { rounds, distribution }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== ''
}
