/**
 * Device risk identity for the Qoder campaign endpoints.
 *
 * Qoder's international service only hands out the daily claim campaign to
 * requests that carry a machine identity minted by its OWN desktop client.
 * Measured against the live upstream: the same account, token and headers get
 * an empty/lifeless `campaigns` array without it, and the real
 * `CLAIM_BENEFIT` campaign with it — so a check-in built on a self-made
 * machine id reports "no campaign today" forever while looking healthy at the
 * transport layer (HTTP 200, no error).
 *
 * The identity cannot be synthesized: it is produced by the client's signed
 * `runtime-info` helper, which fingerprints the real machine (its hardware,
 * its VM status) and signs the answer. The only honest way to obtain one is
 * to ask an installed Qoder client — or the copy of that helper this plugin
 * downloaded from the vendor's own package (`umid-extract.ts`) — to produce it,
 * which is what this module does. When neither is available, the campaign
 * request simply cannot be made to qualify, and the caller is told so instead
 * of being handed a fabricated identity that the upstream will ignore.
 *
 * Three properties of that helper shape everything below:
 *
 * 1. It is not always installed where a naive guess would look. A launcher that
 *    keeps its files in a custom directory records that fact in its own
 *    `state.ini`, so discovery reads that file before falling back to the fixed
 *    locations the plugin used to hardcode (SPEC-UMID-003 §5.11).
 * 2. Its answer jitters. `machineToken` is stable per machine, but
 *    `machineType` / `machineCode` / `vmInfo` flip between virtualisation
 *    profiles across invocations of the same binary on the same machine
 *    (measured at 1.56%–10.29%). A single sample would therefore move the
 *    upstream's risk view for no reason, so a resolution takes three samples
 *    and extends to five when they disagree, then keeps the strict majority.
 * 3. It can disappear. Anti-virus software quarantines it and users clean
 *    `~/.dsh`; in both cases the identity already proven for this machine is
 *    still perfectly usable. Hence the disk cache, and hence the rule that an
 *    expired cache is better than a hard "no client" failure (I-13).
 *
 * Every platform- and filesystem-dependent decision goes through an injectable
 * seam (`options.platform` / `env` / `existsImpl` / `readFileImpl` /
 * `hostnameImpl`). That is not testability for its own sake: the Windows
 * launcher layout has to be exercised on a Linux CI runner, and reading the
 * real environment there would make the suite assert about the runner instead
 * of the fixture.
 *
 * @module dsh-qoder-plugin/qoder/transport/risk-identity
 */

import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { homedir, hostname as osHostname, platform as currentPlatform } from 'node:os'
import { dirname, join } from 'node:path'
import type { QoderRegion } from '../region.ts'
import {
  clearCachedIdentity,
  identityCachePath,
  identityExpired,
  identityTtlMs,
  readCachedIdentity,
  writeCachedIdentity,
  type QoderCachedIdentity,
  type QoderCachedVmInfo,
} from './risk-identity-cache.ts'
import { umidBinaryName, umidDir, umidWindowsLibraryName } from './umid-extract.ts'

/** The three headers the campaign family expects from a real client. */
export interface QoderRiskIdentity {
  machineToken: string
  machineCode: string
  machineType: string
}

/** The virtualisation facts the helper reports next to the identity. */
export type QoderRiskVmInfo = QoderCachedVmInfo

/**
 * One answer from the helper, plus the facts the vote compares.
 *
 * `environment` records which product the answer was minted for, so a cached
 * identity always says how it was obtained (see `riskEnvForRegion`).
 */
export interface QoderRiskIdentitySample extends QoderRiskIdentity {
  vmInfo?: QoderRiskVmInfo | undefined
  environment?: string | undefined
}

/** Where a resolved identity came from (SPEC-UMID-003 §6.6). */
export type QoderRiskIdentitySource = 'component' | 'cache' | 'cache-stale'

/**
 * A resolution with the provenance the status card needs.
 *
 * `stale` is not an error state: it says the component could not be asked right
 * now and a previously proven identity is being reused, which is exactly the
 * case that used to degrade into `no-client` (I-13).
 */
export interface QoderRiskIdentityResolution {
  identity: QoderRiskIdentity
  source: QoderRiskIdentitySource
  /** When the identity was sampled, epoch milliseconds. */
  cachedAt: number
  stale: boolean
}

export interface QoderRiskIdentityOptions {
  /** Home directory to search; injectable for tests. */
  home?: string | undefined
  /** Platform override; injectable for tests. */
  platform?: NodeJS.Platform | undefined
  /** Spawn implementation override; injectable for tests. */
  spawnImpl?: typeof spawn | undefined
  /**
   * Install roots to search, overriding the platform defaults.
   *
   * Injectable because the real roots are fixed system locations: a test on a
   * machine that genuinely has Qoder installed could otherwise never exercise
   * the "no client" path, and would silently pass by finding the host's own
   * client instead of the fixture it built.
   */
  installRoots?: readonly string[] | undefined
  /**
   * File reader for the launcher's `state.ini`.
   *
   * Returns bytes rather than text because the file's encoding is not fixed —
   * the BOM decides (see `readInstallDir`).
   */
  readFileImpl?: ((path: string) => Buffer) | undefined
  /** Existence check for every candidate path. */
  existsImpl?: ((path: string) => boolean) | undefined
  /**
   * Environment the overrides are read from.
   *
   * Injected rather than read from `process.env` so a test can prove which
   * environment a lookup used, and so one test's `QODER_UMID_DIR` cannot leak
   * into another's discovery.
   */
  env?: NodeJS.ProcessEnv | undefined
  /** Hostname source for the campaign hostname (§6.8). */
  hostnameImpl?: (() => string) | undefined
  /** Clock, injectable so TTL and rate-limit windows can be aged in a test. */
  now?: (() => number) | undefined
  /**
   * How long a resolution is remembered in memory, milliseconds.
   *
   * `0` disables the in-memory copy and leaves only the disk cache. The
   * default (30 minutes) covers the burst a single host produces — a check-in
   * plus a status refresh plus a retry — without letting a rotated identity
   * linger for a whole process lifetime.
   */
  memoryCacheTtlMs?: number | undefined
  /**
   * Which product's installation to prefer when both are present.
   *
   * Filled in by {@link resolveRiskIdentityDetail} from its own region argument;
   * callers of {@link findRuntimeInfoBinary} normally leave it unset. It only
   * orders the candidates — either product's helper can mint either identity
   * (see `riskEnvForRegion`), so a wrong value costs a later candidate, not a
   * failed lookup.
   */
  region?: QoderRegion | undefined
}

/**
 * The `env` argument selects which product's identity is minted.
 *
 * Measured on an installed client: env `3` yields the international identity
 * and env `0` the China one, from the same binary — the argument is the
 * product selector, not a version. Sending the wrong one asks the upstream
 * about the wrong product, which is indistinguishable from having no identity
 * at all.
 */
const riskEnvForRegion: Record<QoderRegion, string> = { global: '3', china: '0' }

/**
 * The product directory names a client install may use, preferred first.
 *
 * Both products are listed in every order because the helper for either product
 * can mint either identity (see `riskEnvForRegion`); requiring the *matching*
 * product would fail on a machine that only installed one of them.
 */
const productNames: Record<QoderRegion, readonly string[]> = {
  global: ['Qoder', 'Qoder CN', 'QoderCN'],
  china: ['Qoder CN', 'QoderCN', 'Qoder'],
}

/** Longest a single helper invocation may take before it is abandoned. */
const sampleTimeoutMs = 25_000

/**
 * Largest stdout accepted from one invocation, characters.
 *
 * A helper that floods stdout is malfunctioning, not authoritative; letting it
 * run would also let a broken binary grow this process's heap.
 */
const sampleMaxStdoutChars = 1024 * 1024

/** Rounds that must all agree before the vote is settled. */
const voteFirstPassRounds = 3

/** Hard ceiling on rounds: the first pass plus one extension (§6.5). */
const voteMaxRounds = 5

/** Longest header-safe hostname, characters (§6.8). */
const maxHostnameChars = 96

/** How long a resolution is reused in memory by default. */
export const defaultIdentityMemoryTtlMs = 30 * 60 * 1000

/** Shortest interval between two automatic self-heals of one realm (R8). */
export const selfHealIntervalMs = 24 * 60 * 60 * 1000

/**
 * The filesystem and environment seams one lookup reads through.
 *
 * Bundled so the many small helpers below cannot accidentally fall back to the
 * real `process.env` or `existsSync` halfway through a resolution.
 */
interface IdentityLookup {
  home: string
  platform: NodeJS.Platform
  env: NodeJS.ProcessEnv
  exists: (path: string) => boolean
  readFile: (path: string) => Buffer
  now: () => number
}

/** The seams {@link desktopInstallDirs} needs; a subset of {@link IdentityLookup}. */
export interface QoderInstallLookup {
  exists: (path: string) => boolean
  readFile: (path: string) => Buffer
}

/** Fill in the real seams for everything the caller did not inject. */
function lookupOf(options: QoderRiskIdentityOptions): IdentityLookup {
  return {
    home: options.home ?? homedir(),
    platform: options.platform ?? currentPlatform(),
    env: options.env ?? process.env,
    exists: options.existsImpl ?? existsSync,
    readFile: options.readFileImpl ?? (path => readFileSync(path)),
    now: options.now ?? Date.now,
  }
}

/**
 * Name of the client's helper on `platform`.
 *
 * A function rather than a constant because the name is platform-dependent and
 * the platform has to be injectable: a test exercising the Windows layout must
 * be able to ask for `runtime-info.exe` while running on Linux, which a
 * module-level constant derived from the real `process.platform` made
 * impossible (SPEC-UMID-003 R13).
 */
export function runtimeInfoName(platform: NodeJS.Platform = currentPlatform()): string {
  return umidBinaryName(platform)
}

/** The `state.ini` files a launcher may write for one product, best first. */
function launcherStateFiles(local: string, name: string): string[] {
  return [
    join(local, name, `${name} Launcher`, 'state.ini'),
    join(local, name, 'Launcher', 'state.ini'),
  ]
}

/**
 * Read the `installDir` a launcher recorded for one product.
 *
 * The launcher writes `state.ini` in whatever encoding its own runtime defaulted
 * to: UTF-8 on one build, UTF-16LE with a BOM on another (both observed). Rather
 * than guess, the BOM decides when there is one and the decoders are tried in
 * order when there is not — a UTF-16 file read as UTF-8 yields text with NUL
 * bytes and no `installDir` key, which is exactly the case the candidate chain
 * already has to fall through.
 *
 * An unreadable or key-less file is not an error: it means "no custom directory
 * recorded", and the fixed candidates still apply.
 */
function launcherInstallDir(local: string, name: string, deps: QoderInstallLookup): string | undefined {
  for (const file of launcherStateFiles(local, name)) {
    if (!deps.exists(file)) continue
    let bytes: Buffer
    try {
      bytes = deps.readFile(file)
    } catch {
      continue
    }
    const configured = installDirFromText(bytes)
    if (configured !== undefined) return configured
  }
  return undefined
}

/** Decode a `state.ini` and return its `installDir` value, if any. */
function installDirFromText(bytes: Buffer): string | undefined {
  for (const text of decodeStateIni(bytes)) {
    const value = installDirFromIniText(text)
    if (value !== undefined) return value
  }
  return undefined
}

/**
 * Candidate decodings of a `state.ini`, most likely first.
 *
 * A BOM is authoritative. Without one, UTF-8 comes first (what the current
 * launcher writes) and UTF-16LE second (what a UTF-16 file without a BOM looks
 * like). Callers stop at the first decoding that yields the key.
 */
function decodeStateIni(bytes: Buffer): string[] {
  if (startsWithBytes(bytes, [0xff, 0xfe])) return [bytes.subarray(2).toString('utf16le')]
  if (startsWithBytes(bytes, [0xfe, 0xff])) return [decodeUtf16BigEndian(bytes.subarray(2))]
  if (startsWithBytes(bytes, [0xef, 0xbb, 0xbf])) return [bytes.subarray(3).toString('utf8')]
  return [bytes.toString('utf8'), bytes.toString('utf16le')]
}

/** Decode UTF-16BE, which Node does not expose directly. */
function decodeUtf16BigEndian(bytes: Buffer): string {
  const even = bytes.subarray(0, bytes.length - (bytes.length % 2))
  const swapped = Buffer.from(even)
  swapped.swap16()
  return swapped.toString('utf16le')
}

/** Pull `installDir` out of INI text. */
function installDirFromIniText(text: string): string | undefined {
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim()
    // Comments and section headers carry no value; a line without `=` is not a
    // key/value pair in any INI dialect this file could be written in.
    if (line === '' || line.startsWith(';') || line.startsWith('#')) continue
    const separator = line.indexOf('=')
    if (separator < 0) continue
    if (line.slice(0, separator).trim().toLowerCase() !== 'installdir') continue
    const value = stripQuotes(line.slice(separator + 1).trim())
    if (value !== '') return value
  }
  return undefined
}

function stripQuotes(value: string): string {
  const match = /^"(.*)"$/.exec(value) ?? /^'(.*)'$/.exec(value)
  return (match?.[1] ?? value).trim()
}

/**
 * The fixed install locations, without any launcher configuration.
 *
 * These are the paths the plugin has always guessed, kept as the tail of the
 * candidate chain so a machine that never wrote a launcher state file behaves
 * exactly as it did before the launcher file was read. `env` is a parameter
 * rather than `process.env` so a lookup can be proven to have used the injected
 * environment (R13).
 */
function installRoots(home: string, os: NodeJS.Platform, env: NodeJS.ProcessEnv): string[] {
  if (os === 'win32') {
    const local = env['LOCALAPPDATA'] ?? join(home, 'AppData', 'Local')
    return [
      join(local, 'Programs', 'Qoder'),
      join(local, 'Programs', 'Qoder CN'),
      'C:\\Program Files\\Qoder',
      'C:\\Program Files\\Qoder CN',
      'D:\\Program Files\\Qoder',
      'D:\\Program Files\\Qoder CN',
    ]
  }
  if (os === 'darwin') {
    // `Contents` is the root: its `Resources` child is what holds the app's
    // payload, and `resourcesDirs` appends that. The old hardcoded
    // `Contents/Resources` entry appended a second `resources` segment and could
    // never match anything.
    return [
      '/Applications/Qoder.app/Contents',
      '/Applications/Qoder CN.app/Contents',
      join(home, 'Applications', 'Qoder.app', 'Contents'),
      join(home, 'Applications', 'Qoder CN.app', 'Contents'),
    ]
  }
  return ['/opt/Qoder', '/opt/qoder', join(home, '.qoder')]
}

/**
 * Every directory a Qoder desktop install may live in, best candidate first.
 *
 * Order is the point of this function, and it is what makes "client installed in
 * a non-default directory" work: the launcher records the directory it actually
 * uses, so that record beats every guess. Only then come the per-user and
 * per-machine defaults, then the drive-level fallbacks.
 *
 * Roots, not component directories: each entry is a directory that may contain
 * `resources/umid` (see {@link resourcesDirs}), which is how both the launcher
 * layout and the plain layout are covered by one list.
 *
 * @param region - Which product to try first (either can mint either identity).
 * @param home - Home directory, for the per-user locations.
 * @param os - Target platform; injected so the Windows layout is testable.
 * @param env - Environment to read `LOCALAPPDATA` / `ProgramFiles` from.
 * @param deps - Existence and read seams, injected for tests.
 */
export function desktopInstallDirs(
  region: QoderRegion,
  home: string,
  os: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
  deps: QoderInstallLookup,
): string[] {
  const names = productNames[region] ?? productNames.global
  const dirs: string[] = []
  if (os === 'win32') {
    const local = env['LOCALAPPDATA'] ?? join(home, 'AppData', 'Local')
    for (const name of names) {
      const configured = launcherInstallDir(local, name, deps)
      if (configured !== undefined) dirs.push(configured)
    }
    for (const name of names) dirs.push(join(local, 'Programs', name))
    // `ProgramFiles` is where a per-machine install goes; its default is the
    // drive the system booted from, which is what the hardcoded entries assume.
    const programFiles = env['ProgramFiles'] ?? 'C:\\Program Files'
    for (const name of names) dirs.push(join(programFiles, name))
  } else if (os === 'darwin') {
    for (const name of names) dirs.push(`/Applications/${name}.app/Contents`)
    for (const name of names) dirs.push(join(home, 'Applications', `${name}.app`, 'Contents'))
  } else {
    for (const name of names) dirs.push(join('/usr/share', name.toLowerCase()))
  }
  for (const root of installRoots(home, os, env)) dirs.push(root)
  return dedupe(dirs)
}

/**
 * Every `resources` directory a Qoder install might use, best candidate first.
 *
 * The 0.3+ launcher keeps the version actually running under
 * `.qoder-versions/<ver>/resources`, while the top-level `resources` may be a
 * stale leftover from the first install — so the versioned directories are
 * tried FIRST. Getting this order backwards pins the plugin to whatever build
 * happened to be installed first, whose helper can be older than the client
 * the user is actually running.
 *
 * `Resources` (capitalised) is offered as well because that is how the macOS app
 * bundle spells it and a case-sensitive volume would otherwise miss it; the
 * extra candidate costs one existence check and only ever matters on that
 * layout.
 */
function resourcesDirs(root: string): string[] {
  const dirs: string[] = []
  try {
    const versionRoot = join(root, '.qoder-versions')
    for (const entry of readdirSync(versionRoot, { withFileTypes: true })) {
      if (entry.isDirectory()) dirs.push(join(versionRoot, entry.name, 'resources'))
    }
  } catch {
    // No versioned layout; the plain `resources` candidate below still applies.
  }
  dirs.push(join(root, 'resources'))
  dirs.push(join(root, 'Resources'))
  return dirs
}

/**
 * Every directory that could hold a usable component, best candidate first.
 *
 * `QODER_UMID_DIR` is authoritative when set: a user or a test who points the
 * plugin at a directory means that directory, not "that directory, then
 * whatever else happens to be installed" (§5.1). Otherwise the client's own
 * installation comes first — an installed client is the verified shape and must
 * keep winning — and the plugin's own extracted copy is the last resort.
 */
function componentDirs(options: QoderRiskIdentityOptions, lookup: IdentityLookup): string[] {
  const override = lookup.env['QODER_UMID_DIR']?.trim()
  if (override !== undefined && override !== '') return [override]
  const region = options.region ?? 'global'
  const roots = options.installRoots
    ?? desktopInstallDirs(region, lookup.home, lookup.platform, lookup.env, {
      exists: lookup.exists,
      readFile: lookup.readFile,
    })
  const dirs: string[] = []
  for (const root of roots) {
    for (const resources of resourcesDirs(root)) dirs.push(join(resources, 'umid'))
  }
  dirs.push(umidDir(lookup.env, lookup.home))
  return dedupe(dirs)
}

/**
 * The component executable inside `dir`, or undefined when the directory does
 * not hold a usable component.
 *
 * On Windows the executable alone is not an install: it links against
 * `sgsdk.dll`, so a directory holding only the `.exe` would turn into a
 * confusing spawn failure at check-in time instead of a clear "not installed"
 * (I-06). This is the pair rule `umidInstalled` applies, restated over the
 * injectable existence check this module resolves through.
 */
function componentBinary(dir: string, lookup: IdentityLookup): string | undefined {
  const binary = join(dir, runtimeInfoName(lookup.platform))
  if (!lookup.exists(binary)) return undefined
  if (lookup.platform !== 'win32') return binary
  return lookup.exists(join(dir, umidWindowsLibraryName)) ? binary : undefined
}

/** Locate the client's risk-identity helper, or undefined when none exists. */
export function findRuntimeInfoBinary(options: QoderRiskIdentityOptions = {}): string | undefined {
  const lookup = lookupOf(options)
  for (const dir of componentDirs(options, lookup)) {
    const binary = componentBinary(dir, lookup)
    if (binary !== undefined) return binary
  }
  return undefined
}

/**
 * Whether this platform's helper takes the account on stdin.
 *
 * Only the desktop builds do (§6.5). The helper still gets its stdin closed on
 * the others so it can never wait on a pipe nobody will write to.
 */
function takesAccountOnStdin(platform: NodeJS.Platform): boolean {
  return platform === 'darwin' || platform === 'win32'
}

/**
 * Ask the helper once for this machine's identity.
 *
 * The helper takes the account uid on stdin as `{"account":"<uid>"}` and answers
 * one JSON line on stdout. It is the account that is being fingerprinted, so a
 * uid is required: without one there is nothing to ask about, and the caller
 * must not invent one.
 *
 * Never throws: an absent component, a timeout, a crash, or malformed output all
 * resolve to `undefined`, because every one of them means the same thing to the
 * caller — this round produced no usable sample.
 *
 * `cwd` is the component's own directory because the helper loads its companion
 * library relative to the working directory, not relative to the executable.
 */
async function sampleOnce(
  exe: string,
  region: QoderRegion,
  account: string,
  platform: NodeJS.Platform,
  spawnImpl: typeof spawn,
): Promise<QoderRiskIdentitySample | undefined> {
  const environment = riskEnvForRegion[region] ?? riskEnvForRegion.global
  const withAccount = takesAccountOnStdin(platform)
  return await new Promise<QoderRiskIdentitySample | undefined>(resolve => {
    let out = ''
    let settled = false
    // Declared before the handlers so a spawn implementation that answers
    // synchronously cannot reach `finish` while the timeout is still in its
    // temporal dead zone.
    let timer: NodeJS.Timeout | undefined
    const child = spawnImpl(exe, withAccount ? [environment, '--account-stdin'] : [environment], {
      cwd: dirname(exe),
      stdio: ['pipe', 'pipe', 'ignore'],
      windowsHide: true,
    })
    const finish = (value: QoderRiskIdentitySample | undefined): void => {
      if (settled) return
      settled = true
      if (timer !== undefined) clearTimeout(timer)
      if (child.exitCode === null) child.kill()
      resolve(value)
    }
    timer = setTimeout(() => finish(undefined), sampleTimeoutMs)
    const tryParse = (): void => {
      const newline = out.indexOf('\n')
      if (newline < 0) return
      try {
        finish(sampleFrom(JSON.parse(out.slice(0, newline)), environment))
      } catch {
        finish(undefined)
      }
    }
    child.stdout?.on('data', (chunk: Buffer) => {
      out += chunk.toString('utf8')
      // A helper that floods stdout is malfunctioning, not authoritative.
      if (out.length > sampleMaxStdoutChars) return finish(undefined)
      tryParse()
    })
    child.once('error', () => finish(undefined))
    child.once('close', () => { if (!settled) tryParse(); finish(undefined) })
    child.stdin?.on('error', () => undefined)
    if (withAccount) child.stdin?.end(`${JSON.stringify({ account })}\n`)
    else child.stdin?.end()
  })
}

/**
 * Turn one stdout line into a sample, or `undefined` when it is not one.
 *
 * All three identity fields are required. That is stricter than the reference
 * implementation, which falls back per field, and it is deliberate: a partial
 * identity is not something the campaign endpoints accept, so accepting it
 * would only move the failure from a clear "no client" report to a silent
 * empty campaign list.
 */
function sampleFrom(parsed: unknown, environment: string): QoderRiskIdentitySample | undefined {
  if (!isRecord(parsed)) return undefined
  const machineToken = stringField(parsed, 'machineToken')
  const machineType = stringField(parsed, 'machineType')
  const machineCode = stringField(parsed, 'machineCode')
  if (machineToken === undefined || machineType === undefined || machineCode === undefined) return undefined
  const sample: QoderRiskIdentitySample = { machineToken, machineType, machineCode, environment }
  const vmInfo = vmInfoFrom(parsed['vmInfo'])
  if (vmInfo !== undefined) sample.vmInfo = vmInfo
  return sample
}

function stringField(parsed: Record<string, unknown>, key: string): string | undefined {
  const value = parsed[key]
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  if (trimmed === '' || trimmed.length > 4096) return undefined
  return trimmed
}

function vmInfoFrom(value: unknown): QoderRiskVmInfo | undefined {
  if (!isRecord(value)) return undefined
  const info: QoderRiskVmInfo = {}
  const isVm = value['isVm']
  if (typeof isVm === 'boolean') info.isVm = isVm
  const brand = value['brand']
  if (typeof brand === 'string' && brand.trim() !== '') info.brand = brand.trim()
  const vmTypeCode = value['vmTypeCode']
  if (typeof vmTypeCode === 'number' && Number.isFinite(vmTypeCode)) info.vmTypeCode = vmTypeCode
  const percentage = value['percentage']
  if (typeof percentage === 'number' && Number.isFinite(percentage)) info.percentage = percentage
  return Object.keys(info).length === 0 ? undefined : info
}

/**
 * The value the vote compares (§6.5).
 *
 * `vmInfo.percentage` is deliberately absent: it is a floating-point estimate
 * that differs between two invocations of the same helper on the same machine,
 * so including it would make every vote disagree and buy nothing — the field is
 * not part of what the upstream uses to recognise a device.
 */
function voteKey(sample: QoderRiskIdentitySample): string {
  const vm = sample.vmInfo
  return [
    sample.machineToken,
    sample.machineType,
    sample.machineCode,
    vm?.isVm === undefined ? '' : String(vm.isVm),
    vm?.brand ?? '',
    vm?.vmTypeCode === undefined ? '' : String(vm.vmTypeCode),
  ].join('|')
}

/** A stable, non-reversible label for a vote key, for the cache's diagnostics. */
function voteKeyHash(sample: QoderRiskIdentitySample): string {
  return createHash('sha256').update(voteKey(sample)).digest('hex').slice(0, 16)
}

/** The outcome of one voted sampling session. */
interface VotedSample {
  sample: QoderRiskIdentitySample
  rounds: number
  distribution: Record<string, number>
}

/**
 * Sample the helper and vote the answers together.
 *
 * Three rounds is the measured minimum that resolves the jitter; two more are
 * spent only when those three disagree, so a healthy machine pays for three
 * spawns and a machine whose profile flips pays for five. The ceiling is five:
 * beyond that the vote is not converging, and a check-in is waiting.
 *
 * `undefined` means no round produced a usable sample — a different situation
 * from "the answers disagreed", and the caller falls back to the cache for it.
 */
async function sampleWithVote(
  exe: string,
  region: QoderRegion,
  account: string,
  platform: NodeJS.Platform,
  spawnImpl: typeof spawn,
): Promise<VotedSample | undefined> {
  const samples: QoderRiskIdentitySample[] = []
  for (let round = 0; round < voteMaxRounds; round += 1) {
    // Checked BEFORE spending a round, so an agreeing first pass stops at three.
    if (round >= voteFirstPassRounds && agreedKey(samples) !== undefined) break
    const sample = await sampleOnce(exe, region, account, platform, spawnImpl)
    if (sample !== undefined) samples.push(sample)
  }
  const first = samples[0]
  if (first === undefined) return undefined
  const distribution: Record<string, number> = {}
  for (const sample of samples) {
    const hash = voteKeyHash(sample)
    distribution[hash] = (distribution[hash] ?? 0) + 1
  }
  return { sample: pickWinner(samples, first), rounds: samples.length, distribution }
}

/** The single key all samples share, or undefined when they disagree. */
function agreedKey(samples: readonly QoderRiskIdentitySample[]): string | undefined {
  const first = samples[0]
  if (first === undefined) return undefined
  const key = voteKey(first)
  return samples.every(sample => voteKey(sample) === key) ? key : undefined
}

/**
 * The strict majority sample, or the first one when no key holds a majority.
 *
 * A tie is not resolved by preference: there is no evidence that either answer
 * is the machine's "real" one, and inventing a rule (newest, lowest code) would
 * be a rule the upstream never agreed to. The first sample is at least the
 * answer this process acted on when the vote started.
 */
function pickWinner(
  samples: readonly QoderRiskIdentitySample[],
  first: QoderRiskIdentitySample,
): QoderRiskIdentitySample {
  const counts = new Map<string, number>()
  for (const sample of samples) {
    const key = voteKey(sample)
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  let bestKey: string | undefined
  let bestCount = 0
  let tied = false
  for (const [key, count] of counts) {
    if (count > bestCount) {
      bestKey = key
      bestCount = count
      tied = false
    } else if (count === bestCount) {
      tied = true
    }
  }
  if (bestKey === undefined || tied || bestCount * 2 <= samples.length) return first
  return samples.find(sample => voteKey(sample) === bestKey) ?? first
}

/** The three header values out of a sample or a cache entry. */
function identityOf(source: QoderRiskIdentity): QoderRiskIdentity {
  return {
    machineToken: source.machineToken,
    machineCode: source.machineCode,
    machineType: source.machineType,
  }
}

/** Build the cache entry for a winning sample. */
function cacheEntryFrom(region: QoderRegion, voted: VotedSample, cachedAt: number): QoderCachedIdentity {
  const sample = voted.sample
  const entry: QoderCachedIdentity = {
    machineToken: sample.machineToken,
    machineType: sample.machineType,
    machineCode: sample.machineCode,
    environment: riskEnvForRegion[region] ?? riskEnvForRegion.global,
    source: 'runtime-info',
    cachedAt,
    votes: { rounds: voted.rounds, distribution: voted.distribution },
  }
  if (sample.vmInfo !== undefined) entry.vmInfo = sample.vmInfo
  return entry
}

/**
 * Whether the disk cache may be used at all (`QODER_UMID_IDENTITY_CACHE`).
 *
 * On by default. Turning it off makes every resolution spawn the component,
 * which is what the reference implementation does and what a debugging session
 * sometimes wants.
 */
function identityCacheEnabled(env: NodeJS.ProcessEnv): boolean {
  return env['QODER_UMID_IDENTITY_CACHE']?.trim() !== '0'
}

/**
 * How long a cached identity stays fresh, and whether one has aged past it, live
 * in the cache module: the host's status reports the same verdict, and two
 * copies of the rule would eventually disagree.
 */

/** Resolutions remembered for this process, keyed by realm. */
const memoryCache = new Map<QoderRegion, { resolution: QoderRiskIdentityResolution; at: number }>()

/** Background re-samples in flight, keyed by realm, so one realm never races itself. */
const backgroundRefreshes = new Map<QoderRegion, Promise<void>>()

/** When each realm last healed itself automatically. */
const selfHealAt = new Map<QoderRegion, number>()

/**
 * How many times the process memory has been dropped on purpose.
 *
 * A re-sample started before a reset describes the identity of the OLD seed, so
 * its answer must not be written back afterwards: it would re-create exactly the
 * cache entry the reset just deleted. Sampling is asynchronous, so the only way
 * to notice that is a counter captured when the sample started.
 */
let resetGeneration = 0

/**
 * Forget the identities this process resolved, so the next check-in resolves
 * again from disk and, if the disk copy is gone too, from the component.
 *
 * An explicit reset (`umid reset-native`) needs this: it replaces the seed, and
 * a 30-minute memory entry would otherwise keep serving the identity of the seed
 * that no longer exists. Nothing else may call it — the TTL expiring re-samples
 * through the cache path instead (I-14).
 */
export function clearIdentityMemoryCache(): void {
  resetGeneration += 1
  memoryCache.clear()
}

/**
 * Forget every in-process memory this module keeps.
 *
 * Only a test needs this: the memory cache is an optimisation, and a real
 * process either lives long enough to want it or exits. Exported rather than
 * made conditional so the reset is the same code path a test exercises.
 */
export function resetRiskIdentityState(): void {
  clearIdentityMemoryCache()
  backgroundRefreshes.clear()
  selfHealAt.clear()
}

function rememberedResolution(region: QoderRegion, ttlMs: number, now: number): QoderRiskIdentityResolution | undefined {
  if (ttlMs <= 0) return undefined
  const entry = memoryCache.get(region)
  if (entry === undefined) return undefined
  if (now - entry.at >= ttlMs) {
    memoryCache.delete(region)
    return undefined
  }
  return entry.resolution
}

function rememberResolution(
  region: QoderRegion,
  resolution: QoderRiskIdentityResolution,
  ttlMs: number,
  now: number,
): void {
  if (ttlMs <= 0) return
  memoryCache.set(region, { resolution, at: now })
}

/**
 * Resolve the identity and report where it came from.
 *
 * The order is the answer to "which source wins", and it is constrained from
 * two sides (SPEC-UMID-003 R7 and I-04):
 *
 * 1. A resolution this process already made (30 minutes, per realm).
 * 2. A disk-cached identity that is still within its TTL — the component is NOT
 *    spawned for it. This step has to come before the component, or I-04's
 *    "at most one spawn within the TTL" could not hold: with the component
 *    first, every check-in would spawn again even though a proven identity was
 *    sitting on disk. R7 lists the component first, which describes which
 *    source may PRODUCE an identity; I-04 says a cache that already has one is
 *    authoritative. Where they disagree, the invariant wins.
 * 3. The component, sampled and voted.
 * 4. An expired cached identity, used as-is and marked `stale` while a
 *    background re-sample runs. This is I-13: a quarantined helper or a cleaned
 *    `~/.dsh` must not turn into "no client" while a usable identity exists.
 * 5. Nothing.
 *
 * A component that is present but cannot answer falls through to step 4 rather
 * than failing: "installed but broken" is the Defender case, and the identity
 * already proven for this machine is still valid.
 */
export async function resolveRiskIdentityDetail(
  region: QoderRegion,
  uid: string,
  options: QoderRiskIdentityOptions = {},
): Promise<QoderRiskIdentityResolution | undefined> {
  const account = uid.trim()
  // No account, nothing to fingerprint. Spawning anyway would ask the helper
  // about an invented uid, which is the one thing this module must not do.
  if (account === '') return undefined
  const lookup = lookupOf(options)
  const now = lookup.now()
  const memoryTtlMs = options.memoryCacheTtlMs ?? defaultIdentityMemoryTtlMs

  const remembered = rememberedResolution(region, memoryTtlMs, now)
  if (remembered !== undefined) return remembered

  const cacheEnabled = identityCacheEnabled(lookup.env)
  const ttlMs = identityTtlMs(lookup.env)
  const cachePath = identityCachePath(lookup.home)
  const cached = cacheEnabled ? readCachedIdentity(region, cachePath) : undefined

  if (cached !== undefined && !identityExpired(cached, ttlMs, now)) {
    const resolution: QoderRiskIdentityResolution = {
      identity: identityOf(cached),
      source: 'cache',
      cachedAt: cached.cachedAt,
      stale: false,
    }
    rememberResolution(region, resolution, memoryTtlMs, now)
    return resolution
  }

  const resolvedOptions: QoderRiskIdentityOptions = { ...options, region }
  const exe = findRuntimeInfoBinary(resolvedOptions)
  if (exe !== undefined) {
    const voted = await sampleWithVote(exe, region, account, lookup.platform, options.spawnImpl ?? spawn)
    if (voted !== undefined) {
      const cachedAt = lookup.now()
      if (cacheEnabled) writeCachedIdentity(region, cacheEntryFrom(region, voted, cachedAt), cachePath)
      const resolution: QoderRiskIdentityResolution = {
        identity: identityOf(voted.sample),
        source: 'component',
        cachedAt,
        stale: false,
      }
      rememberResolution(region, resolution, memoryTtlMs, cachedAt)
      return resolution
    }
  }

  if (cached !== undefined) {
    const resolution: QoderRiskIdentityResolution = {
      identity: identityOf(cached),
      source: 'cache-stale',
      cachedAt: cached.cachedAt,
      stale: true,
    }
    rememberResolution(region, resolution, memoryTtlMs, now)
    scheduleBackgroundRefresh(region, account, resolvedOptions, cachePath, cacheEnabled, lookup, memoryTtlMs)
    return resolution
  }

  return undefined
}

/**
 * Resolve the identity, discarding the provenance.
 *
 * The shape the check-in service consumes. Kept as a thin wrapper so callers
 * that only need the three header values never learn about `stale`.
 */
export async function resolveRiskIdentity(
  region: QoderRegion,
  uid: string,
  options: QoderRiskIdentityOptions = {},
): Promise<QoderRiskIdentity | undefined> {
  const resolution = await resolveRiskIdentityDetail(region, uid, options)
  return resolution?.identity
}

/**
 * Re-sample in the background after a stale cache was used.
 *
 * Deliberately not awaited: the caller has an identity in hand and a check-in to
 * finish, and a re-sample that takes five spawns must not become a slower
 * check-in. One re-sample per realm at a time — a burst of check-ins on the same
 * machine is one reason to refresh, not ten.
 */
function scheduleBackgroundRefresh(
  region: QoderRegion,
  account: string,
  options: QoderRiskIdentityOptions,
  cachePath: string,
  cacheEnabled: boolean,
  lookup: IdentityLookup,
  memoryTtlMs: number,
): void {
  if (backgroundRefreshes.has(region)) return
  const work = refreshInBackground(region, account, options, cachePath, cacheEnabled, lookup, memoryTtlMs)
  backgroundRefreshes.set(region, work)
  // Cleanup runs after the promise settles, never before the entry is stored.
  void work.then(
    () => { backgroundRefreshes.delete(region) },
    () => { backgroundRefreshes.delete(region) },
  )
}

async function refreshInBackground(
  region: QoderRegion,
  account: string,
  options: QoderRiskIdentityOptions,
  cachePath: string,
  cacheEnabled: boolean,
  lookup: IdentityLookup,
  memoryTtlMs: number,
): Promise<void> {
  try {
    const exe = findRuntimeInfoBinary(options)
    if (exe === undefined) return
    // Captured before the spawn: a reset that lands while the helper is running
    // makes this answer describe a seed that is already gone.
    const generation = resetGeneration
    const voted = await sampleWithVote(exe, region, account, lookup.platform, options.spawnImpl ?? spawn)
    if (voted === undefined) return
    if (generation !== resetGeneration) return
    const cachedAt = lookup.now()
    if (cacheEnabled) writeCachedIdentity(region, cacheEntryFrom(region, voted, cachedAt), cachePath)
    rememberResolution(region, {
      identity: identityOf(voted.sample),
      source: 'component',
      cachedAt,
      stale: false,
    }, memoryTtlMs, cachedAt)
  } catch {
    // A background refresh must never surface as a check-in failure: the stale
    // identity has already been handed to the caller, and the next check-in
    // simply tries again.
  }
}

/**
 * Wait for every in-flight background re-sample to finish.
 *
 * A CLI wants this before exiting (a re-sample cut off by process exit leaves
 * the cache stale for the next run) and a test wants it to assert about what the
 * refresh wrote. Bounded so a refresh that never settles cannot hang the caller.
 */
export async function settleRiskIdentityBackgroundWork(): Promise<void> {
  for (let round = 0; round < 8 && backgroundRefreshes.size > 0; round += 1) {
    await Promise.allSettled([...backgroundRefreshes.values()])
  }
}

/** Why an automatic self-heal did or did not run. */
export type QoderSelfHealReason = 'disabled' | 'recent' | 'no-account' | 'no-component' | 'no-sample'

/** Outcome of {@link selfHealRiskIdentity}. */
export interface QoderSelfHealOutcome {
  /** Whether the identity was actually reset and re-sampled. */
  performed: boolean
  /** Why not, when it was not. */
  reason?: QoderSelfHealReason | undefined
}

/**
 * Reset this machine's native identity, at most once per realm per 24 hours.
 *
 * This is R8's `force` capability: delete the client's own seed
 * (`~/.config/.locale_cfg`), drop the cached identity, then sample again. It is
 * implemented but never automatic — the caller decides, and only when
 * `QODER_UMID_SELF_HEAL=1` is set does this function agree to run. The default
 * is off because deleting the seed changes the identity of the user's real Qoder
 * client on this machine, irreversibly, and an automatic identity change is
 * indistinguishable from a silent device swap.
 *
 * The 24-hour window is per process. It is not persisted because SPEC-UMID-003
 * §5.1 enumerates the state files this feature may own and a rate-limit marker
 * is not one of them; a restart re-arms the window, which is the lesser evil
 * compared with writing an undocumented file next to the user's credentials.
 */
export async function selfHealRiskIdentity(
  region: QoderRegion,
  uid: string,
  options: QoderRiskIdentityOptions = {},
): Promise<QoderSelfHealOutcome> {
  const lookup = lookupOf(options)
  if (lookup.env['QODER_UMID_SELF_HEAL']?.trim() !== '1') return { performed: false, reason: 'disabled' }
  const account = uid.trim()
  if (account === '') return { performed: false, reason: 'no-account' }
  const now = lookup.now()
  const last = selfHealAt.get(region)
  if (last !== undefined && now - last < selfHealIntervalMs) return { performed: false, reason: 'recent' }

  // Located BEFORE anything is deleted: clearing the seed and then discovering
  // there is nothing left to sample with would take away this machine's proven
  // identity and hand back nothing at all. That is strictly worse than not
  // healing, so an absent component refuses the heal outright — and does not
  // spend the 24h window either, since a component may still be installed later.
  const resolvedOptions: QoderRiskIdentityOptions = { ...options, region }
  const exe = findRuntimeInfoBinary(resolvedOptions)
  if (exe === undefined) return { performed: false, reason: 'no-component' }

  // Claimed before the work: a heal that fails half way still used up the
  // window, and retrying it in a loop is the behaviour this bound prevents.
  selfHealAt.set(region, now)

  // R8's order: the seed the component fingerprints, then our cached copy, then
  // a fresh sample. Nothing else may delete the seed (I-14).
  try {
    rmSync(join(lookup.home, '.config', '.locale_cfg'), { force: true })
  } catch {
    // A seed that cannot be removed is not a reason to skip the rest of the
    // heal; the re-sample below still produces a fresh identity for the cache.
  }
  // Memory goes through the same reset path an explicit reset uses: the seed has
  // just been replaced, so every identity this process remembers — and every
  // re-sample already in flight — describes a seed that no longer exists.
  clearIdentityMemoryCache()
  const cachePath = identityCachePath(lookup.home)
  clearCachedIdentity(region, cachePath)

  const voted = await sampleWithVote(exe, region, account, lookup.platform, options.spawnImpl ?? spawn)
  // The reset happened, so `performed` stays true: the caller must not be told
  // nothing was done when the machine's identity may well have changed.
  if (voted === undefined) return { performed: true, reason: 'no-sample' }
  const cachedAt = lookup.now()
  if (identityCacheEnabled(lookup.env)) writeCachedIdentity(region, cacheEntryFrom(region, voted, cachedAt), cachePath)
  rememberResolution(region, {
    identity: identityOf(voted.sample),
    source: 'component',
    cachedAt,
    stale: false,
  }, options.memoryCacheTtlMs ?? defaultIdentityMemoryTtlMs, cachedAt)
  return { performed: true }
}

/**
 * The real hostname in a form safe to put in an HTTP header (§6.8).
 *
 * The campaign family declares itself as the desktop client, and the only
 * verified working shape of that request carries the machine's REAL hostname —
 * a derived one is unverified (R4). Real hostnames are not header-safe though:
 * they can be non-ASCII, contain spaces, or carry control characters, any of
 * which turns into a malformed request rather than an error anyone can act on.
 * So: keep the value when it is already safe, else let IDNA translate it, else
 * fall back to a slug plus a digest — which stays stable for the same host
 * without leaking the name.
 */
export function headerSafeHostname(name: string): string {
  if (isHeaderSafeHostname(name)) return name
  const idna = idnaHostname(name)
  if (idna !== undefined && isHeaderSafeHostname(idna)) return idna.slice(0, maxHostnameChars)
  const slug = slugifyHostname(name)
  const digest = createHash('sha256').update(name).digest('hex').slice(0, 8)
  return (slug === '' ? digest : `${slug}-${digest}`).slice(0, maxHostnameChars)
}

/**
 * The campaign hostname for this machine (§6.8, R4).
 *
 * `QODER_CAMPAIGN_DERIVED_HOSTNAME=1` (the privacy switch) is not handled here:
 * it needs the account uid and the derived-id helpers, and it belongs to the
 * code that builds the header set, not to identity resolution.
 */
export function campaignHostname(options: QoderRiskIdentityOptions = {}): string {
  const hostname = options.hostnameImpl ?? osHostname
  return headerSafeHostname(hostname())
}

function isHeaderSafeHostname(value: string): boolean {
  if (value === '' || value.length > maxHostnameChars) return false
  // Leading/trailing whitespace is trimmed by intermediaries inconsistently, and
  // a control character can end the header value entirely. The character set is
  // printable ASCII rather than "no control characters": Node rejects a header
  // value with anything above latin1 outright (ERR_INVALID_CHAR), so a Chinese
  // hostname sent as-is would fail the whole request — which is precisely the
  // case the IDNA step below exists for.
  if (value !== value.trim()) return false
  return /^[\u0020-\u007e]+$/.test(value)
}

function idnaHostname(value: string): string | undefined {
  try {
    const host = new URL(`http://${value}`).hostname
    return host === '' ? undefined : host
  } catch {
    return undefined
  }
}

function slugifyHostname(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32)
}

/** Remove duplicates while keeping the first occurrence's position. */
function dedupe(values: readonly string[]): string[] {
  return [...new Set(values)]
}

function startsWithBytes(bytes: Buffer, prefix: readonly number[]): boolean {
  if (bytes.length < prefix.length) return false
  return prefix.every((byte, index) => bytes[index] === byte)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
