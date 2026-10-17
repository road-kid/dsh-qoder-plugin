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
 * to ask an installed Qoder client to produce it, which is what this module
 * does. When no client is installed, the campaign request simply cannot be
 * made to qualify, and the caller is told so instead of being handed a
 * fabricated identity that the upstream will ignore.
 *
 * @module dsh-qoder-plugin/qoder/transport/risk-identity
 */

import { spawn } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import { homedir, platform } from 'node:os'
import { join } from 'node:path'
import type { QoderRegion } from '../region.ts'

/** The three headers the campaign family expects from a real client. */
export interface QoderRiskIdentity {
  machineToken: string
  machineCode: string
  machineType: string
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

/** The helper ships inside the client's `resources/umid` directory. */
const runtimeInfoName = platform() === 'win32' ? 'runtime-info.exe' : 'runtime-info'

/**
 * Where a Qoder client may be installed, newest naming first.
 *
 * Both products are listed because the helper for either product can mint
 * either identity (see {@link riskEnvForRegion}); requiring the *matching*
 * product would fail on a machine that only installed one of them.
 */
function installRoots(home: string, os: NodeJS.Platform): string[] {
  if (os === 'win32') {
    const local = process.env['LOCALAPPDATA'] ?? join(home, 'AppData', 'Local')
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
    return ['/Applications/Qoder.app/Contents/Resources', '/Applications/Qoder CN.app/Contents/Resources']
  }
  return ['/opt/Qoder/resources', '/opt/qoder/resources', join(home, '.qoder', 'resources')]
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
  return dirs
}

/** Locate the client's risk-identity helper, or undefined when none exists. */
export function findRuntimeInfoBinary(options: QoderRiskIdentityOptions = {}): string | undefined {
  const home = options.home ?? homedir()
  const os = options.platform ?? platform()
  for (const root of options.installRoots ?? installRoots(home, os)) {
    for (const resources of resourcesDirs(root)) {
      const candidate = join(resources, 'umid', runtimeInfoName)
      if (existsSync(candidate)) return candidate
    }
  }
  return undefined
}

/**
 * Ask the client's helper for this machine's identity.
 *
 * The helper takes the account uid on stdin as `{"account":"<uid>"}` and
 * answers one JSON line on stdout. It is the account that is being
 * fingerprinted, so a uid is required: without one there is nothing to ask
 * about, and the caller must not invent one.
 *
 * Never throws: an absent client, a timeout, a crash, or malformed output all
 * resolve to `undefined`, because every one of them means the same thing to
 * the caller — this request cannot carry a real identity.
 */
export async function resolveRiskIdentity(
  region: QoderRegion,
  uid: string,
  options: QoderRiskIdentityOptions = {},
): Promise<QoderRiskIdentity | undefined> {
  const account = uid.trim()
  if (account === '') return undefined
  const exe = findRuntimeInfoBinary(options)
  if (exe === undefined) return undefined
  const spawnImpl = options.spawnImpl ?? spawn
  const env = riskEnvForRegion[region] ?? riskEnvForRegion.global

  return await new Promise<QoderRiskIdentity | undefined>(resolve => {
    let out = ''
    let settled = false
    const child = spawnImpl(exe, [env, '--account-stdin'], {
      stdio: ['pipe', 'pipe', 'ignore'],
      windowsHide: true,
    })
    const finish = (value: QoderRiskIdentity | undefined): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (child.exitCode === null) child.kill()
      resolve(value)
    }
    const timer = setTimeout(() => finish(undefined), 25_000)
    const tryParse = (): void => {
      const newline = out.indexOf('\n')
      if (newline < 0) return
      try {
        const parsed = JSON.parse(out.slice(0, newline)) as Record<string, unknown>
        const pick = (key: string): string => {
          const value = parsed[key]
          if (typeof value !== 'string' || value.trim() === '' || value.length > 4096) {
            throw new Error(`runtime-info did not report ${key}`)
          }
          return value.trim()
        }
        finish({ machineToken: pick('machineToken'), machineCode: pick('machineCode'), machineType: pick('machineType') })
      } catch {
        finish(undefined)
      }
    }
    child.stdout?.on('data', (chunk: Buffer) => {
      out += chunk.toString('utf8')
      // A helper that floods stdout is malfunctioning, not authoritative.
      if (out.length > 1024 * 1024) return finish(undefined)
      tryParse()
    })
    child.once('error', () => finish(undefined))
    child.once('close', () => { if (!settled) tryParse(); finish(undefined) })
    child.stdin?.on('error', () => undefined)
    child.stdin?.end(`${JSON.stringify({ account })}\n`)
  })
}
