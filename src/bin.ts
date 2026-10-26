#!/usr/bin/env node
/** Standalone status/diagnostics/PAT CLI for the dsh-qoder-plugin bundle. */

import { existsSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { QoderCredentialStore, qoderCredentialIdentity } from './auth.ts'
import { QoderUpstreamClient, validateApiKey } from './upstream.ts'
import { createQoderTransport } from './qoder/transport/index.ts'
import { installUmid, readUmidManifest, umidBinaryPath, umidDir, umidInstalled } from './qoder/transport/umid-extract.ts'
import type { UmidManifest, UmidSelfCheck } from './qoder/transport/umid-extract.ts'
import { defaultDeviceSeedPath } from './qoder/transport/device-seed.ts'
import { clearMachineIdentityCache, identityCachePath, identityTtlMs } from './qoder/transport/risk-identity-cache.ts'
import { clearIdentityMemoryCache } from './qoder/transport/risk-identity.ts'
import type { QoderRegion } from './qoder/region.ts'
import { FALLBACK_QODER_MODELS } from './catalog.ts'
import { QoderCatalogStore, qoderCatalogPath } from './catalog-store.ts'
import { QODER_CONNECT_VERSION } from './version.ts'
import { isHeartbeatProcessAlive, qoderHostHeartbeatPath, readHostHeartbeat } from './host-heartbeat.ts'
import { CHINA_VARIANT, QODER_VARIANTS, variantFor, type QoderVariant } from './variants.ts'

type Action = 'doctor' | 'status' | 'pat' | 'logout' | 'catalog' | 'umid'
type PatCommand = 'set' | 'clear'
type CatalogCommand = 'refresh'
type UmidCommand = 'install' | 'status' | 'reset-native'

const JSON_SCHEMA_VERSION = 1

/** Remove token-like strings from an unexpected diagnostic message. */
function safeMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return message
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/gu, '[redacted token]')
    .replace(/(\b(?:code|token|pat)=)[^&\s]+/giu, '$1[redacted]')
}

function printHelp(): void {
  process.stdout.write([
    'Usage: dsh-qoder-plugin <doctor|status|pat|logout|catalog|umid> [--provider <id>] [--json] [--file <path>]',
    '',
    '  doctor         secret-free environment diagnostics',
    '  status         credential state and remaining Qoder credit',
    '  pat set        validate and store a Personal Access Token (arg, --file, or stdin)',
    '  pat clear      remove the stored credential',
    '  logout         alias for `pat clear`',
    '  catalog refresh   re-fetch the model list and save it for this account',
    '',
    '  umid install      fetch and install the native device-identity component',
    '  umid status       show the component, its manifest and the identity cache',
    '  umid reset-native remove the identity seed so the next run mints a new one',
    '',
    '  --provider  which product to act on; defaults to qoder',
    `              one of: ${QODER_VARIANTS.map(variant => variant.id).join(', ')}`,
    '  --json      emit one secret-free JSON document (doctor/status/umid only)',
    '  --file      file to read the token from with `pat set`; "-" reads standard input',
    '',
    '  umid install flags:',
    '    --from-tarball <path>  install from a local tarball instead of the registry',
    '    --version <version>    pin a published version (default: dist-tags.latest)',
    '    --force                reinstall even when the component is already present',
    '  umid reset-native flags:',
    '    --yes                  actually delete; without it the command only lists the targets',
    '',
    '  A token can also arrive as the positional argument after `pat set`.',
    '  Environment fallback: QODER_CN_PERSONAL_ACCESS_TOKEN (qoder) or',
    '  QODER_PERSONAL_ACCESS_TOKEN (qoder-global) when no file is saved.',
    '',
  ].join('\n'))
}

function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`)
}

/** One variant's store. */
function makeStore(variant: QoderVariant): QoderCredentialStore {
  return new QoderCredentialStore({ variant })
}

/** One variant's store plus the upstream client riding its transport. */
function makeClient(store: QoderCredentialStore, variant: QoderVariant): QoderUpstreamClient {
  const transport = createQoderTransport({
    region: variant.region,
    resolvePat: () => store.patPromise(),
  })
  return new QoderUpstreamClient({
    region: variant.region,
    providerId: variant.id,
    getPat: () => store.patPromise(),
    transport,
  })
}

async function doctor(jsonOutput: boolean, variant: QoderVariant): Promise<number> {
  const store = makeStore(variant)
  const status = await store.status()
  const heartbeat = await readHostHeartbeat()
  const hostAlive = heartbeat !== undefined && isHeartbeatProcessAlive(heartbeat)
  const component = readUmidComponentReport()
  const identityCache = readIdentityCacheReport(variant.region)
  const report = {
    schemaVersion: JSON_SCHEMA_VERSION,
    package: 'dsh-qoder-plugin',
    version: QODER_CONNECT_VERSION,
    node: process.version,
    provider: variant.id,
    displayName: variant.displayName,
    region: variant.region,
    credentialFile: store.ownAuthPath(),
    hostHeartbeat: {
      path: qoderHostHeartbeatPath(),
      present: heartbeat !== undefined,
      ...heartbeat === undefined ? {} : { registeredAt: heartbeat.registeredAt, pid: heartbeat.pid },
      processAlive: hostAlive,
    },
    signIn: status.state,
    ...status.pat === undefined ? {} : { pat: status.pat },
    ...status.reason === undefined ? {} : { reason: status.reason },
    fallbackModels: FALLBACK_QODER_MODELS.length,
    // Diagnostics only: an absent component is the normal state before the
    // first install, so it never changes this command's exit code.
    nativeDevice: {
      componentDir: component.componentDir,
      binary: component.binary,
      installed: component.installed,
      ...component.manifest === undefined ? {} : { manifest: component.manifest },
      identityCache,
    },
    hints: [
      ...status.state === 'configured'
        ? []
        : [`Save a token with \`dsh-qoder-plugin pat set <token> --provider ${variant.id}\`, or from the plugin's settings card.`],
      ...hostAlive ? [] : ['Host bundle not running in this DSH profile (or the process exited). The browser card is unavailable until DSH starts the plugin; the pat command above still works.'],
    ],
  }
  if (jsonOutput) {
    printJson(report)
  } else {
    process.stdout.write([
      `${variant.displayName} Connect ${QODER_CONNECT_VERSION} on ${process.version}`,
      `Region: ${report.region}`,
      `Credential file: ${report.credentialFile}`,
      `Host bundle: ${hostAlive ? `running (pid ${heartbeat!.pid})` : heartbeat !== undefined ? 'stale heartbeat (process exited)' : 'not started'}`,
      `Credential: ${status.state === 'configured' ? `configured (${status.pat?.source ?? 'file'}${status.pat?.patTail === undefined ? '' : `, tail …${status.pat.patTail}`})` : 'missing'}`,
      ...status.reason === undefined ? [] : [`Note: ${status.reason}`],
      `Static fallback models: ${report.fallbackModels}`,
      `Native device: ${component.installed ? `component installed at ${component.componentDir}` : `component not installed (would live at ${component.componentDir})`}`,
      ...component.manifest === undefined ? [] : [`  ${describeUmidManifest(component.manifest)}`],
      `Identity cache: ${describeIdentityCache(identityCache)}`,
      ...report.hints.map(hint => `Hint: ${hint}`),
      '',
    ].join('\n'))
  }
  return status.state === 'configured' ? 0 : 1
}

async function status(jsonOutput: boolean, variant: QoderVariant): Promise<number> {
  const store = makeStore(variant)
  const auth = await store.status()
  const base = {
    schemaVersion: JSON_SCHEMA_VERSION,
    package: 'dsh-qoder-plugin',
    version: QODER_CONNECT_VERSION,
    provider: variant.id,
    region: variant.region,
    credentialFile: auth.filePath,
    signIn: auth.state,
    ...auth.pat === undefined ? {} : { pat: auth.pat },
    ...auth.reason === undefined ? {} : { reason: auth.reason },
  }
  if (auth.state !== 'configured') {
    if (jsonOutput) printJson({ ...base, credits: undefined })
    else {
      process.stdout.write([
        `${variant.displayName}: no credential configured at ${auth.filePath}`,
        ...auth.reason === undefined ? [] : [`Note: ${auth.reason}`],
        'Save a token with `pat set` or from the plugin\u2019s settings card.',
        '',
      ].join('\n'))
    }
    return 1
  }
  const client = makeClient(store, variant)
  try {
    const credits = await client.fetchCredits()
    if (jsonOutput) printJson({ ...base, credits })
    else {
      process.stdout.write([
        `${variant.displayName} (${variant.region}): token from ${auth.pat?.source ?? 'file'}${auth.pat?.patTail === undefined ? '' : `, tail …${auth.pat.patTail}`}`,
        credits.unlimited ? 'Quota: unlimited for the current cycle' : `Quota: ${Math.max(0, 100 - credits.total).toFixed(1)}% remaining of the cycle allowance`,
        ...credits.accounts.map(account => `  ${account.packageName}: ${account.remain}/${account.size}${account.unlimited ? ' (unlimited)' : ''}`),
        ...credits.cycleResetTime === undefined ? [] : [`  resets: ${credits.cycleResetTime}`],
        '',
      ].join('\n'))
    }
    return 0
  } catch (error: unknown) {
    if (jsonOutput) printJson({ ...base, creditsError: safeMessage(error) })
    else process.stdout.write(`${variant.displayName}: credential stored, but the quota call failed: ${safeMessage(error)}\n`)
    return 1
  }
}

/** Read a token from the positional arg, --file, or standard input. */
async function readPat(source: string | undefined, rest: readonly string[]): Promise<string> {
  const inline = rest.find(argument => !argument.startsWith('--'))
  const raw = source === undefined
    ? inline ?? await readStdin()
    : source === '-' ? await readStdin() : await readFile(source, 'utf8')
  const pat = raw?.trim() ?? ''
  if (pat === '') throw new Error('no token given: pass it as an argument, via --file <path>, or on standard input')
  return pat
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string))
  }
  return Buffer.concat(chunks).toString('utf8')
}

async function patSet(variant: QoderVariant, file: string | undefined, rest: readonly string[]): Promise<number> {
  const store = makeStore(variant)
  const pat = await readPat(file, rest)
  process.stdout.write(`Validating a token against ${variant.displayName} (${variant.region})…\n`)
  // Validate before writing: a file the plugin saved should always be a file
  // the plugin believes works. A refusal costs one discovery call, a bad save
  // costs every later request an opaque 401.
  //
  // A token the upstream REFUSED and an endpoint we could not REACH are
  // reported differently: the second is not the token's fault, and pointing a
  // user at `--provider` when the real problem was a timeout sends them after
  // the wrong thing.
  const validation = await validateApiKey(pat, variant.region)
  if (!validation.ok) {
    if (validation.error === 'unreachable') {
      process.stderr.write(`dsh-qoder-plugin: could not reach ${variant.displayName} to verify the token (${validation.reason}). Nothing was saved.\n`)
      process.stderr.write('This is a network or endpoint problem, not a rejected token — check connectivity and try again.\n')
      return 2
    }
    process.stderr.write(`dsh-qoder-plugin: the token was refused by ${variant.displayName} (${variant.region}). Nothing was saved.\n`)
    process.stderr.write('If this token belongs to the other Qoder product, use --provider for that one.\n')
    return 2
  }
  await store.save(pat, 'cli')
  const status = await store.status()
  process.stdout.write([
    `Saved to ${store.ownAuthPath()}${status.pat?.patTail === undefined ? '' : ` (tail …${status.pat.patTail})`}`,
    'The running plugin picks the token up on its next sweep; no restart needed.',
    '',
  ].join('\n'))
  return 0
}

async function patClear(variant: QoderVariant): Promise<number> {
  const store = makeStore(variant)
  // Only this variant's stored credential is removed, so signing out of
  // one product never affects the other. An environment token is not ours to
  // remove; say so rather than pretend the state is fully signed out.
  await store.clear()
  const status = await store.status()
  process.stdout.write(
    status.state === 'configured'
      ? `${variant.displayName} Connect: removed the stored file, but a token is still active from the environment (${status.pat?.source ?? 'env'}).\n`
      : `${variant.displayName} Connect: signed out; removed ${store.ownAuthPath()}\n`,
  )
  return 0
}

async function catalogRefresh(variant: QoderVariant): Promise<number> {
  const store = makeStore(variant)
  const credential = await store.resolve()
  const client = makeClient(store, variant)
  const models = await client.fetchModels()
  const identity = qoderCredentialIdentity(credential)
  const fetch = client.lastCatalog
  // The CLI writes the same saved-catalog file the host reads, so a refresh
  // here survives a restart of the plugin exactly like a live fetch would.
  new QoderCatalogStore({ path: qoderCatalogPath(variant.catalogFilename) }).set(identity, {
    source: fetch?.source ?? 'unknown',
    fetchedAtMs: fetch?.fetchedAtMs ?? Date.now(),
    models: [...models],
  })
  process.stdout.write(`${variant.displayName}: fetched ${models.length} models; saved for account ${identity}.\n`)
  return 0
}

/**
 * The seed the Qoder client itself fingerprints (SPEC-UMID-003 §5.10, R8).
 *
 * Not this plugin's file: it belongs to the user's real client, which is why
 * only `umid reset-native --yes` may delete it, and why nothing here recreates
 * it — the client writes it on its next run, from the machine it is on.
 */
function nativeSeedPath(home: string = homedir()): string {
  return join(home, '.config', '.locale_cfg')
}

/** What `doctor` and `umid status` report about the identity cache. */
interface UmidIdentityCacheReport {
  path: string
  present: boolean
  /** When the sample was taken, epoch milliseconds. */
  cachedAt?: number
  /** Age of the sample at the time of the read, milliseconds. */
  ageMs?: number
  /** True only when a TTL is set and the sample is older than it. */
  stale: boolean
  /** The TTL in force, milliseconds; `0` means never. */
  ttlMs: number
}

/**
 * Read the identity cache without changing it.
 *
 * Deliberately not {@link readCachedIdentity}: that function deletes a document
 * it cannot migrate, which is right for the transport (it would fail on every
 * check-in otherwise) but wrong for a diagnostics command — `doctor` must be
 * safe to run on a machine whose state is already broken. A malformed document
 * is therefore reported as absent rather than quietly repaired.
 */
function readIdentityCacheReport(region: QoderRegion, options: { home?: string; env?: NodeJS.ProcessEnv; now?: number } = {}): UmidIdentityCacheReport {
  const path = identityCachePath(options.home ?? homedir())
  const ttlMs = identityTtlMs(options.env ?? process.env)
  const now = options.now ?? Date.now()
  const absent: UmidIdentityCacheReport = { path, present: false, stale: false, ttlMs }
  let document: unknown
  try {
    document = JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    // Missing is the normal state before the first check-in; unreadable is not
    // worth a failure in a diagnostics command, and the next check-in rewrites it.
    return absent
  }
  if (typeof document !== 'object' || document === null) return absent
  const realm = (document as { realm?: unknown }).realm
  if (typeof realm !== 'object' || realm === null) return absent
  const entry = (realm as Record<string, unknown>)[region]
  if (typeof entry !== 'object' || entry === null) return absent
  const cachedAt = (entry as { cachedAt?: unknown }).cachedAt
  if (typeof cachedAt !== 'number' || !Number.isFinite(cachedAt)) return absent
  const ageMs = now - cachedAt
  return { path, present: true, cachedAt, ageMs, stale: ttlMs > 0 && ageMs >= ttlMs, ttlMs }
}

/** One line describing the identity cache, shared by `doctor` and `umid status`. */
function describeIdentityCache(report: UmidIdentityCacheReport): string {
  if (!report.present) return `absent at ${report.path}`
  const cachedAt = report.cachedAt === undefined ? 'unknown' : new Date(report.cachedAt).toISOString()
  const freshness = report.ttlMs <= 0
    ? 'TTL 0, never expires'
    : report.stale ? `stale, TTL ${report.ttlMs} ms` : `fresh, TTL ${report.ttlMs} ms`
  return `present at ${report.path} (cached ${cachedAt}, ${freshness})`
}

/** One line describing the self-check that gated an install. */
function describeSelfCheck(check: UmidSelfCheck): string {
  const prefix = check.machineTokenSha256Prefix
  return `${check.ok ? 'passed' : 'failed'}${prefix === undefined ? '' : ` (machine token sha256 …${prefix})`}`
}

/** One line describing an installed manifest. */
function describeUmidManifest(manifest: UmidManifest): string {
  return [
    `version ${manifest.source.version}`,
    `installed ${manifest.installedAt}`,
    `self-check ${describeSelfCheck(manifest.selfCheck)}`,
  ].join(', ')
}

/** What `doctor` and `umid status` report about the native component. */
interface UmidComponentReport {
  componentDir: string
  binary: string
  installed: boolean
  manifest?: UmidManifest
}

function readUmidComponentReport(): UmidComponentReport {
  const componentDir = umidDir()
  const manifest = readUmidManifest(componentDir)
  return {
    componentDir,
    binary: umidBinaryPath(process.platform, componentDir),
    installed: umidInstalled(componentDir),
    ...manifest === undefined ? {} : { manifest },
  }
}

/**
 * `umid install`: fetch, verify, self-check and promote the native component.
 *
 * Progress is written to stderr so `--json` still emits exactly one document on
 * stdout; both branches carry the same facts. A failure is exit 1, never 2 —
 * 2 is reserved for a malformed command line, which the caller detects before
 * reaching this function.
 */
async function umidInstall(options: { fromTarball?: string | undefined; version?: string | undefined; force: boolean; json: boolean }): Promise<number> {
  const result = await installUmid({
    force: options.force,
    ...options.fromTarball === undefined ? {} : { tarballPath: options.fromTarball },
    ...options.version === undefined ? {} : { version: options.version },
    logger: {
      info: (message: string) => process.stderr.write(`${message}\n`),
      warn: (message: string) => process.stderr.write(`warning: ${message}\n`),
    },
  })
  if (options.json) {
    printJson({ schemaVersion: JSON_SCHEMA_VERSION, package: 'dsh-qoder-plugin', command: 'umid install', ...result })
  } else if (result.ok) {
    process.stdout.write([
      `Native device component ${result.skipped ? 'already installed' : 'installed'}: ${result.version} in ${result.destDir}`,
      ...result.files.map(file => `  ${file.name} (${file.bytes} bytes)`),
      `Self-check: ${describeSelfCheck(result.selfCheck)}`,
      '',
    ].join('\n'))
  } else {
    process.stderr.write(`dsh-qoder-plugin: umid install failed: ${safeMessage(result.error ?? 'unknown error')}\n`)
  }
  return result.ok ? 0 : 1
}

/**
 * `umid status`: report the component, its manifest and the identity cache.
 *
 * Exit 0 even when nothing is installed: the command succeeded at reporting,
 * and "no component yet" is the normal state on a machine that has never run
 * the plugin. Failing here would make a status probe look like a fault.
 */
function umidStatus(jsonOutput: boolean, variant: QoderVariant): number {
  const component = readUmidComponentReport()
  const identity = readIdentityCacheReport(variant.region)
  const report = {
    schemaVersion: JSON_SCHEMA_VERSION,
    package: 'dsh-qoder-plugin',
    command: 'umid status',
    provider: variant.id,
    region: variant.region,
    componentDir: component.componentDir,
    binary: component.binary,
    installed: component.installed,
    ...component.manifest === undefined ? {} : { manifest: component.manifest },
    identityCache: identity,
    identityTtlNote: 'QODER_UMID_IDENTITY_TTL only decides when the identity is re-sampled; it never clears the stored seed (R9).',
  }
  if (jsonOutput) {
    printJson(report)
  } else {
    process.stdout.write([
      `Native device component: ${component.installed ? `installed at ${component.componentDir}` : `not installed (would live at ${component.componentDir})`}`,
      ...component.manifest === undefined ? [] : [`  ${describeUmidManifest(component.manifest)}`],
      `Identity cache: ${describeIdentityCache(identity)}`,
      `Note: ${report.identityTtlNote}`,
      ...component.installed ? [] : ['Hint: run `dsh-qoder-plugin umid install` to fetch the component.'],
      '',
    ].join('\n'))
  }
  return 0
}

/**
 * `umid reset-native`: forget this machine's device seed and cached identity.
 *
 * Without `--yes` this is a dry run that only prints what would happen, because
 * the seed is what the upstream has been told about this machine and its loss
 * is irreversible.
 *
 * The order inside `--yes` is load-bearing: the seed is deleted first, then the
 * disk cache, then the in-process cache. Deleting the cache first would leave a
 * window in which a concurrent check-in still finds the seed, re-samples the
 * identity the seed no longer backs, and writes it straight back — the reset
 * would silently undo itself. The identity cache also has a default TTL of 0
 * (never expires), so clearing it is not optional: without this step a reset
 * keeps returning the old identity forever.
 *
 * `~/.config/.locale_cfg` — the official Qoder client's own seed — is never
 * touched. It is the user's file, and rotating it would change the identity of
 * their real client, not of this plugin.
 *
 * Exit 1 only when the seed was present and is still there afterwards: that is
 * the one failure that makes the reset a lie. A cache clear that reports `false`
 * is reported in words but is not a failure — the cache may simply have been
 * empty already.
 */
function umidResetNative(options: { yes: boolean; json: boolean }): number {
  const home = homedir()
  const seedPath = defaultDeviceSeedPath()
  const cachePath = identityCachePath(home)
  const officialSeedPath = nativeSeedPath(home)
  const seedPresent = existsSync(seedPath)
  const cachePresent = existsSync(cachePath)

  let cacheCleared = false
  if (options.yes) {
    if (seedPresent) {
      try {
        rmSync(seedPath, { force: true })
      } catch {
        // Reported below from the file system rather than from this catch: the
        // fact that matters is whether the seed is gone, not whether rm threw.
      }
    }
    try {
      cacheCleared = clearMachineIdentityCache({ home })
    } catch {
      cacheCleared = false
    }
    clearIdentityMemoryCache()
  }

  const seedGone = !existsSync(seedPath)
  const impact = 'The next check-in mints a fresh device seed and samples a fresh identity; the previous identity cannot be recovered.'
  const officialNote = `Official client identity ${officialSeedPath} is untouched: only the Qoder client writes and rotates it.`
  const seedLine = options.yes
    ? seedPresent ? (seedGone ? `Removed device seed: ${seedPath}` : `Failed to remove device seed: ${seedPath}`) : `Device seed already absent: ${seedPath}`
    : seedPresent ? `Would delete device seed: ${seedPath}` : `Device seed already absent: ${seedPath}`
  const cacheLine = options.yes
    ? cacheCleared
      ? `Cleared identity cache: ${cachePath}`
      : cachePresent ? `Failed to clear identity cache: ${cachePath}` : `Identity cache already absent: ${cachePath}`
    : cachePresent ? `Would clear identity cache: ${cachePath}` : `Identity cache already absent: ${cachePath}`

  if (options.json) {
    printJson({
      schemaVersion: JSON_SCHEMA_VERSION,
      package: 'dsh-qoder-plugin',
      command: 'umid reset-native',
      dryRun: !options.yes,
      seed: { path: seedPath, present: seedPresent, removed: options.yes && seedGone },
      identityCache: { path: cachePath, present: cachePresent, cleared: cacheCleared },
      memoryCacheCleared: options.yes,
      officialClientSeed: { path: officialSeedPath, touched: false },
      impact,
    })
  } else {
    process.stdout.write([
      seedLine,
      cacheLine,
      options.yes ? 'Cleared the in-process identity memory cache' : 'Would clear the in-process identity memory cache',
      officialNote,
      `Impact: ${impact}`,
      ...options.yes ? [] : ['Re-run with --yes to perform this reset.'],
      '',
    ].join('\n'))
  }
  return !options.yes || seedGone ? 0 : 1
}

/** Execute one boot-free command. */
export async function run(argv: readonly string[]): Promise<number> {
  if (argv.length === 0 || argv[0] === '--help' || argv[0] === '-h') {
    printHelp()
    return 0
  }
  const [rawAction, ...flags] = argv
  const actions: readonly Action[] = ['doctor', 'status', 'pat', 'logout', 'catalog', 'umid']
  if (!actions.includes(rawAction as Action)) {
    process.stderr.write(`dsh-qoder-plugin: expected doctor, status, pat, logout, catalog, or umid; got ${JSON.stringify(rawAction)}\n`)
    return 1
  }
  const action = rawAction as Action
  const jsonOutput = flags.includes('--json')

  // `--provider <id>` (or `--provider=<id>`); absent means the China provider,
  // so every invocation without a flag keeps acting on `qoder`. `--file <path>`
  // names the file `pat set` reads the token from.
  let providerId: string | undefined
  let file: string | undefined
  let fromTarball: string | undefined
  let pinnedVersion: string | undefined
  let force = false
  let yes = false
  const rest: string[] = []
  for (let index = 0; index < flags.length; index += 1) {
    const flag = flags[index]!
    if (flag === '--provider') {
      providerId = flags[index + 1]
      index += 1
      continue
    }
    if (flag.startsWith('--provider=')) {
      providerId = flag.slice('--provider='.length)
      continue
    }
    if (flag === '--file') {
      file = flags[index + 1]
      index += 1
      continue
    }
    if (flag.startsWith('--file=')) {
      file = flag.slice('--file='.length)
      continue
    }
    // The umid flags are consumed here rather than left in `rest`: the hygiene
    // check below only inspects non-`--` arguments, so a stray `--force` would
    // otherwise pass silently for every other action.
    if (flag === '--from-tarball' || flag === '--version') {
      const value = flags[index + 1]
      if (value === undefined || value.startsWith('--')) {
        process.stderr.write(`dsh-qoder-plugin: ${flag} needs a value\n`)
        return 2
      }
      if (flag === '--from-tarball') fromTarball = value
      else pinnedVersion = value
      index += 1
      continue
    }
    if (flag.startsWith('--from-tarball=')) {
      fromTarball = flag.slice('--from-tarball='.length)
      continue
    }
    if (flag.startsWith('--version=')) {
      pinnedVersion = flag.slice('--version='.length)
      continue
    }
    if (flag === '--force') {
      force = true
      continue
    }
    if (flag === '--yes') {
      yes = true
      continue
    }
    rest.push(flag)
  }
  const variant = providerId === undefined ? CHINA_VARIANT : variantFor(providerId)
  if (variant === undefined) {
    process.stderr.write(
      `dsh-qoder-plugin: unknown provider ${JSON.stringify(providerId)}; expected one of ${QODER_VARIANTS.map(v => v.id).join(', ')}\n`,
    )
    return 1
  }
  // `pat` and `catalog` carry a subcommand; peel it off `rest` before the
  // flag hygiene below can mistake it for an unknown option.
  let patCommand: PatCommand | undefined
  let catalogCommand: CatalogCommand | undefined
  let umidCommand: UmidCommand | undefined
  if (action === 'pat') {
    const sub = rest.shift()
    patCommand = sub === 'set' || sub === 'clear' ? sub : undefined
    if (patCommand === undefined) {
      process.stderr.write(`dsh-qoder-plugin: pat needs set or clear; got ${JSON.stringify(sub ?? '')}\n`)
      return 1
    }
  }
  if (action === 'catalog') {
    const sub = rest.shift()
    catalogCommand = sub === 'refresh' ? sub : undefined
    if (catalogCommand === undefined) {
      process.stderr.write(`dsh-qoder-plugin: catalog needs refresh; got ${JSON.stringify(sub ?? '')}\n`)
      return 1
    }
  }
  if (action === 'umid') {
    const sub = rest.shift()
    umidCommand = sub === 'install' || sub === 'status' || sub === 'reset-native' ? sub : undefined
    if (umidCommand === undefined) {
      process.stderr.write(`dsh-qoder-plugin: umid needs install, status, or reset-native; got ${JSON.stringify(sub ?? '')}\n`)
      return 2
    }
  }
  const unknown = rest.filter(flag => flag !== '--json' && !flag.startsWith('--'))
  if (unknown.length > 0 || (jsonOutput && action !== 'doctor' && action !== 'status' && action !== 'umid')) {
    process.stderr.write(`dsh-qoder-plugin: invalid options for ${action}: ${flags.join(' ')}\n`)
    return 1
  }
  if (action !== 'pat' && file !== undefined) {
    process.stderr.write(`dsh-qoder-plugin: --file applies to pat set, not ${action}\n`)
    return 1
  }
  const umidOnlyFlags = [
    ...fromTarball === undefined ? [] : ['--from-tarball'],
    ...pinnedVersion === undefined ? [] : ['--version'],
    ...force ? ['--force'] : [],
  ]
  if (umidOnlyFlags.length > 0 && !(action === 'umid' && umidCommand === 'install')) {
    const verb = umidOnlyFlags.length === 1 ? 'applies' : 'apply'
    process.stderr.write(`dsh-qoder-plugin: ${umidOnlyFlags.join(', ')} ${verb} to \`umid install\` only\n`)
    return 2
  }
  if (yes && !(action === 'umid' && umidCommand === 'reset-native')) {
    process.stderr.write('dsh-qoder-plugin: --yes applies to `umid reset-native` only\n')
    return 2
  }
  try {
    switch (action) {
      case 'doctor':
        return await doctor(jsonOutput, variant)
      case 'status':
        return await status(jsonOutput, variant)
      case 'pat':
        return patCommand === 'set'
          ? await patSet(variant, file, rest)
          : await patClear(variant)
      case 'logout':
        return await patClear(variant)
      case 'catalog':
        return await catalogRefresh(variant)
      case 'umid':
        if (umidCommand === 'install') return await umidInstall({ fromTarball, version: pinnedVersion, force, json: jsonOutput })
        if (umidCommand === 'status') return umidStatus(jsonOutput, variant)
        return umidResetNative({ yes, json: jsonOutput })
    }
  } catch (error: unknown) {
    process.stderr.write(`dsh-qoder-plugin: ${action} failed: ${safeMessage(error)}\n`)
    return 1
  }
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === realpathSync(process.argv[1])) {
  process.exitCode = await run(process.argv.slice(2))
}
