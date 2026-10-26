import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { EventEmitter } from 'node:events'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  campaignHostname,
  clearIdentityMemoryCache,
  desktopInstallDirs,
  findRuntimeInfoBinary,
  headerSafeHostname,
  resetRiskIdentityState,
  resolveRiskIdentity,
  resolveRiskIdentityDetail,
  runtimeInfoName,
  selfHealRiskIdentity,
  settleRiskIdentityBackgroundWork,
} from '../src/qoder/transport/risk-identity.ts'
import {
  clearMachineIdentityCache,
  identityCachePath,
  identityCacheStatus,
  readCachedIdentity,
  writeCachedIdentity,
  type QoderCachedIdentity,
} from '../src/qoder/transport/risk-identity-cache.ts'

/**
 * Every test drives the module through injected seams: a temporary home, an
 * empty environment and fixture install roots. Nothing here may consult the
 * machine running the suite — a developer with Qoder installed would otherwise
 * exercise their own client, and the identity cache would be written into their
 * real `~/.dsh` (clearing the memory copy in a test does not clear their disk).
 */
let home = ''

beforeEach(() => {
  resetRiskIdentityState()
  home = mkdtempSync(join(tmpdir(), 'qoder-identity-'))
})

afterEach(() => {
  resetRiskIdentityState()
  rmSync(home, { recursive: true, force: true })
})

/** A platform/environment pair every resolution test starts from. */
function win32(env: NodeJS.ProcessEnv = {}) {
  return { home, platform: 'win32' as NodeJS.Platform, env }
}

/**
 * A stand-in for the client's `runtime-info` helper.
 *
 * The real helper is a signed native binary that fingerprints the machine, so a
 * test cannot use it: it would make the suite depend on an installed Qoder
 * client and on the host's actual hardware. This double reproduces only the
 * CONTRACT the module depends on — argv carries the product selector, the
 * account arrives on stdin, one JSON line comes back on stdout — which is
 * exactly the part the module has to get right.
 *
 * `answer` may be a function of the call index, which is how the vote is driven
 * (round 1 answers differently from round 4).
 */
function fakeSpawn(answer: string | ((call: number) => string), options: { emitNothing?: boolean } = {}) {
  const calls: { exe: string; args: string[]; cwd: string | undefined; stdin: string }[] = []
  const spawnImpl = ((exe: string, args: string[], spawnOptions: { cwd?: string }) => {
    const child = new EventEmitter() as EventEmitter & {
      stdout: EventEmitter
      stderr: EventEmitter
      stdin: { on: () => void; end: (chunk: string) => void }
      exitCode: number | null
      kill: () => void
    }
    child.stdout = new EventEmitter()
    child.stderr = new EventEmitter()
    child.exitCode = null
    child.kill = () => undefined
    const call = { exe, args, cwd: spawnOptions.cwd, stdin: '' }
    calls.push(call)
    child.stdin = {
      on: () => undefined,
      end: (chunk: string) => { call.stdin = chunk },
    }
    const stdout = typeof answer === 'function' ? answer(calls.length - 1) : answer
    // Answer on the next tick so the caller has attached its listeners.
    setImmediate(() => {
      if (!options.emitNothing) child.stdout.emit('data', Buffer.from(stdout, 'utf8'))
      child.exitCode = 0
      child.emit('close', 0)
    })
    return child
  }) as never
  return { spawnImpl, calls }
}

/** One JSON answer line from the helper. */
function answerFor(machineToken: string, extra: Record<string, unknown> = {}): string {
  return `${JSON.stringify({ machineToken, machineCode: 'code-1', machineType: 'type-1', ...extra })}\n`
}

/** Write the two files a usable Windows component directory holds. */
function writeComponent(dir: string): void {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'runtime-info.exe'), 'stub')
  writeFileSync(join(dir, 'sgsdk.dll'), 'stub')
}

/** Build an install root holding a fake helper, and return the root. */
function fakeInstall(name = 'install'): string {
  const root = join(home, name)
  writeComponent(join(root, 'resources', 'umid'))
  writeFileSync(join(root, 'resources', 'build-manifest.json'), JSON.stringify({ productVersion: '0.4.3' }))
  return root
}

/** Write a launcher `state.ini`, optionally in the UTF-16LE the newer builds use. */
function writeStateIni(path: string, text: string, encoding: 'utf8' | 'utf16le' = 'utf8'): void {
  mkdirSync(dirname(path), { recursive: true })
  if (encoding === 'utf16le') {
    writeFileSync(path, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')]))
    return
  }
  writeFileSync(path, text, 'utf8')
}

/** A cache entry as the cache module stores it. */
function cachedEntry(machineToken: string, cachedAt: number): QoderCachedIdentity {
  return {
    machineToken,
    machineType: 'cached-type',
    machineCode: 'cached-code',
    source: 'runtime-info',
    cachedAt,
  }
}

describe('desktop install discovery', () => {
  it('T-M0-1 finds the install directory the Windows launcher recorded', () => {
    // A launcher that keeps its files outside the default directory is the case
    // a hardcoded candidate list cannot cover: only the file it wrote knows.
    const root = fakeInstall('custom-qoder')
    const local = join(home, 'localappdata')
    writeComponent(join(local, 'Programs', 'Qoder', 'resources', 'umid'))
    writeStateIni(join(local, 'Qoder', 'Qoder Launcher', 'state.ini'), `[launcher]\ninstallDir=${root}\n`)

    const env = { LOCALAPPDATA: local, ProgramFiles: join(home, 'program-files') }
    expect(findRuntimeInfoBinary(win32(env))).toBe(join(root, 'resources', 'umid', 'runtime-info.exe'))
  })

  it('T-M0-2 decodes a UTF-16LE state.ini written with a byte-order mark', () => {
    const root = fakeInstall('custom-qoder')
    const local = join(home, 'localappdata')
    writeComponent(join(local, 'Programs', 'Qoder', 'resources', 'umid'))
    writeStateIni(join(local, 'Qoder', 'Launcher', 'state.ini'), `installDir=${root}\n`, 'utf16le')

    const env = { LOCALAPPDATA: local, ProgramFiles: join(home, 'program-files') }
    expect(findRuntimeInfoBinary(win32(env))).toBe(join(root, 'resources', 'umid', 'runtime-info.exe'))
  })

  it('T-M0-3 walks on down the candidate chain when state.ini has no installDir', () => {
    // A state file that exists but records something else must not truncate the
    // search: the launcher may have written it before it knew where it lived.
    const local = join(home, 'localappdata')
    writeComponent(join(local, 'Programs', 'Qoder', 'resources', 'umid'))
    writeStateIni(join(local, 'Qoder', 'Qoder Launcher', 'state.ini'), '[launcher]\nversion=2\nchannel=stable\n')

    const env = { LOCALAPPDATA: local, ProgramFiles: join(home, 'program-files') }
    expect(findRuntimeInfoBinary(win32(env)))
      .toBe(join(local, 'Programs', 'Qoder', 'resources', 'umid', 'runtime-info.exe'))
  })

  it('T-M0-4 samples the helper with the component directory as its working directory', async () => {
    // The helper loads its companion library relative to the working directory,
    // not relative to the executable, so the default one (the caller's) breaks it.
    const root = fakeInstall()
    const { spawnImpl, calls } = fakeSpawn(answerFor('token-1'))
    await resolveRiskIdentityDetail('global', 'uid-1', { ...win32(), installRoots: [root], spawnImpl })

    const exe = join(root, 'resources', 'umid', 'runtime-info.exe')
    expect(calls[0]?.exe).toBe(exe)
    expect(calls[0]?.cwd).toBe(dirname(exe))
    expect(calls[0]?.args).toEqual(['3', '--account-stdin'])
    // The helper answers about an ACCOUNT, so the uid must be what we send.
    expect(calls[0]?.stdin).toBe('{"account":"uid-1"}\n')
  })

  it('T-M0-5 names the helper after the injected platform, not the running one', () => {
    expect(runtimeInfoName('win32')).toBe('runtime-info.exe')
    expect(runtimeInfoName('darwin')).toBe('runtime-info')
    expect(runtimeInfoName('linux')).toBe('runtime-info')

    const root = join(home, 'linux-install')
    mkdirSync(join(root, 'resources', 'umid'), { recursive: true })
    writeFileSync(join(root, 'resources', 'umid', 'runtime-info'), 'stub')
    expect(findRuntimeInfoBinary({ ...win32(), platform: 'linux', installRoots: [root] }))
      .toBe(join(root, 'resources', 'umid', 'runtime-info'))
  })

  it('T-M0-6 reads LOCALAPPDATA and ProgramFiles from the injected environment', () => {
    const injected = { LOCALAPPDATA: join(home, 'injected-local'), ProgramFiles: join(home, 'injected-pf') }
    const dirs = desktopInstallDirs('global', home, 'win32', injected, {
      exists: () => false,
      readFile: () => Buffer.alloc(0),
    })
    expect(dirs).toContain(join(injected.LOCALAPPDATA, 'Programs', 'Qoder'))
    expect(dirs).toContain(join(injected.ProgramFiles, 'Qoder'))
    // The home fallback is only for a session without LOCALAPPDATA.
    expect(dirs).not.toContain(join(home, 'AppData', 'Local', 'Programs', 'Qoder'))
    // And the real environment of the machine running the suite must not leak in.
    // Compared as a derived path, not a prefix: the temporary directory this
    // suite works in lives under the real LOCALAPPDATA on Windows.
    const realLocal = process.env['LOCALAPPDATA']
    if (realLocal !== undefined && realLocal !== injected.LOCALAPPDATA) {
      expect(dirs).not.toContain(join(realLocal, 'Programs', 'Qoder'))
    }
  })

  it('honours QODER_UMID_DIR without falling back to an installed client', () => {
    // An explicit pointer means "that directory": silently using the client's
    // helper instead would run a completely different binary than the one asked for.
    const installed = fakeInstall()
    const override = join(home, 'umid-override')
    writeComponent(override)
    expect(findRuntimeInfoBinary({ ...win32({ QODER_UMID_DIR: override }), installRoots: [installed] }))
      .toBe(join(override, 'runtime-info.exe'))
  })
})

describe('native identity cache', () => {
  it('T-M3-1 answers from the cache without spawning the component (I-04)', async () => {
    const path = identityCachePath(home)
    writeCachedIdentity('global', cachedEntry('cached-token', Date.now()), path)
    const { spawnImpl, calls } = fakeSpawn(answerFor('live-token'))

    const resolution = await resolveRiskIdentityDetail('global', 'uid-1', {
      ...win32(),
      installRoots: [fakeInstall()],
      spawnImpl,
    })
    expect(resolution?.identity.machineToken).toBe('cached-token')
    expect(resolution?.source).toBe('cache')
    expect(resolution?.stale).toBe(false)
    expect(calls).toHaveLength(0)
  })

  it('spawns at most once per TTL across repeated check-ins (I-04)', async () => {
    const { spawnImpl, calls } = fakeSpawn(answerFor('live-token'))
    const options = { ...win32(), installRoots: [fakeInstall()], spawnImpl }

    await resolveRiskIdentityDetail('global', 'uid-1', options)
    const afterFirst = calls.length
    expect(afterFirst).toBe(3)
    // A later check-in in a fresh process finds the identity on disk.
    for (let round = 0; round < 3; round += 1) {
      resetRiskIdentityState()
      const resolution = await resolveRiskIdentityDetail('global', 'uid-1', options)
      expect(resolution?.source).toBe('cache')
    }
    expect(calls).toHaveLength(afterFirst)
  })

  it('spawns once for a check-in that covers several accounts', async () => {
    // The identity is a property of the MACHINE (that is why the upstream only
    // lets one account claim per machine), so resolving for a second account in
    // the same realm must reuse what the first account's session produced
    // instead of paying for another sampling session per account.
    const { spawnImpl, calls } = fakeSpawn(answerFor('live-token'))
    const options = { ...win32(), installRoots: [fakeInstall()], spawnImpl }
    await resolveRiskIdentityDetail('global', 'account-a', options)
    const afterFirst = calls.length
    const second = await resolveRiskIdentityDetail('global', 'account-b', options)
    expect(second?.identity.machineToken).toBe('live-token')
    expect(calls).toHaveLength(afterFirst)
  })

  it('T-M3-2 re-samples once the cached identity is past its TTL', async () => {
    const path = identityCachePath(home)
    writeCachedIdentity('global', cachedEntry('stale-token', Date.now() - 60_000), path)
    const { spawnImpl, calls } = fakeSpawn(answerFor('fresh-token'))

    const before = Date.now()
    const resolution = await resolveRiskIdentityDetail('global', 'uid-1', {
      ...win32({ QODER_UMID_IDENTITY_TTL: '1000' }),
      installRoots: [fakeInstall()],
      spawnImpl,
    })
    expect(resolution?.identity.machineToken).toBe('fresh-token')
    expect(resolution?.source).toBe('component')
    expect(calls).toHaveLength(3)
    const refreshed = readCachedIdentity('global', path)
    expect(refreshed?.machineToken).toBe('fresh-token')
    expect(refreshed?.cachedAt).toBeGreaterThanOrEqual(before)
  })

  it('T-M3-3 spends the full five rounds when the first three disagree', async () => {
    // The identity jitters between virtualisation profiles on the same machine;
    // one sample would move the upstream's risk view for no reason.
    const { spawnImpl, calls } = fakeSpawn(call => answerFor(`token-${call}`))
    const resolution = await resolveRiskIdentityDetail('global', 'uid-1', {
      ...win32(),
      installRoots: [fakeInstall()],
      spawnImpl,
    })
    expect(calls).toHaveLength(5)
    // No majority, so the first sample stands — and it is the one this process
    // already acted on.
    expect(resolution?.identity.machineToken).toBe('token-0')
  })

  it('T-M3-4 keeps the first sample when the vote is tied', async () => {
    const answers = ['a', 'a', 'b', 'b', 'c']
    const { spawnImpl, calls } = fakeSpawn(call => answerFor(`token-${answers[call] ?? 'x'}`))
    const resolution = await resolveRiskIdentityDetail('global', 'uid-1', {
      ...win32(),
      installRoots: [fakeInstall()],
      spawnImpl,
    })
    expect(calls).toHaveLength(5)
    expect(resolution?.identity.machineToken).toBe('token-a')
  })

  it('T-M3-5 ignores vmInfo.percentage when voting', async () => {
    // The percentage is a floating-point estimate that differs between two
    // spawns of the same machine; voting on it would disagree forever.
    const { spawnImpl, calls } = fakeSpawn(call => answerFor('token-same', {
      vmInfo: { isVm: false, brand: 'none', vmTypeCode: 0, percentage: (call + 1) * 10 },
    }))
    const resolution = await resolveRiskIdentityDetail('global', 'uid-1', {
      ...win32(),
      installRoots: [fakeInstall()],
      spawnImpl,
    })
    expect(calls).toHaveLength(3)
    expect(resolution?.identity.machineToken).toBe('token-same')
    // The winning sample's own percentage is what gets remembered, not a blend.
    const entry = readCachedIdentity('global', identityCachePath(home))
    expect(entry?.vmInfo?.percentage).toBe(10)
    expect(entry?.votes?.rounds).toBe(3)
  })

  it('T-M3-6 treats a corrupt cache file as no cache and deletes it', () => {
    const path = identityCachePath(home)
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, 'not json{')
    expect(readCachedIdentity('global', path)).toBeUndefined()
    expect(existsSync(path)).toBe(false)

    // A schema this build does not know is equally unusable — and equally
    // must not be left behind to fail the same way on every read.
    writeFileSync(path, JSON.stringify({ schema: 2, realm: {} }))
    expect(readCachedIdentity('global', path)).toBeUndefined()
    expect(existsSync(path)).toBe(false)
  })

  it('T-M3-7 keeps the other realm in place when one realm is written', () => {
    // Read-modify-write: a blind overwrite would let one region's resolution
    // erase the identity the other region falls back to.
    const path = identityCachePath(home)
    const now = Date.now()
    expect(writeCachedIdentity('global', cachedEntry('g-1', now), path)).toBe(true)
    expect(writeCachedIdentity('china', cachedEntry('c-1', now), path)).toBe(true)
    expect(writeCachedIdentity('global', cachedEntry('g-2', now), path)).toBe(true)

    expect(readCachedIdentity('china', path)?.machineToken).toBe('c-1')
    expect(readCachedIdentity('global', path)?.machineToken).toBe('g-2')
  })

  it('T-M3-8 keeps checking in on an expired cache when the component is gone (I-13)', async () => {
    // The anti-virus case: the helper was quarantined, but this machine already
    // proved its identity yesterday. Degrading to "no client" would disable the
    // campaign for a machine that has every right to it.
    const path = identityCachePath(home)
    writeCachedIdentity('global', cachedEntry('survivor', Date.now() - 60_000), path)
    const { spawnImpl, calls } = fakeSpawn(answerFor('never-asked'))

    const resolution = await resolveRiskIdentityDetail('global', 'uid-1', {
      ...win32({ QODER_UMID_IDENTITY_TTL: '1000' }),
      installRoots: [],
      spawnImpl,
    })
    expect(resolution).toBeDefined()
    expect(resolution?.identity.machineToken).toBe('survivor')
    expect(resolution?.source).toBe('cache-stale')
    expect(resolution?.stale).toBe(true)

    await settleRiskIdentityBackgroundWork()
    expect(calls).toHaveLength(0)
  })

  it('T-M3-9 does not clear the seed when the TTL expires (I-14)', async () => {
    // Re-sampling is not re-enrolling. The seed the component fingerprints may
    // only be deleted by a deliberate reset, or every TTL expiry would silently
    // change this machine's identity.
    const seed = join(home, '.config', '.locale_cfg')
    mkdirSync(dirname(seed), { recursive: true })
    writeFileSync(seed, 'seed-bytes')
    writeCachedIdentity('global', cachedEntry('stale-token', Date.now() - 60_000), identityCachePath(home))
    const { spawnImpl } = fakeSpawn(answerFor('fresh-token'))

    await resolveRiskIdentityDetail('global', 'uid-1', {
      ...win32({ QODER_UMID_IDENTITY_TTL: '1000' }),
      installRoots: [fakeInstall()],
      spawnImpl,
    })
    expect(readFileSync(seed, 'utf8')).toBe('seed-bytes')
  })

  it('T-M3-10 self-heals at most once per realm per 24 hours', async () => {
    const seed = join(home, '.config', '.locale_cfg')
    mkdirSync(dirname(seed), { recursive: true })
    writeFileSync(seed, 'seed-bytes')
    const path = identityCachePath(home)
    writeCachedIdentity('global', cachedEntry('stale-token', Date.now()), path)
    const { spawnImpl, calls } = fakeSpawn(answerFor('token-healed'))
    const options = {
      ...win32({ QODER_UMID_SELF_HEAL: '1' }),
      installRoots: [fakeInstall()],
      spawnImpl,
    }

    expect(await selfHealRiskIdentity('global', 'uid-1', options)).toEqual({ performed: true })
    // A heal means: drop the seed, drop the cached identity, sample again.
    expect(existsSync(seed)).toBe(false)
    expect(calls.length).toBeGreaterThanOrEqual(1)
    expect(readCachedIdentity('global', path)?.machineToken).toBe('token-healed')

    // The window is the whole point: a broken campaign must not turn into a
    // heal loop that changes this machine's identity on every check-in.
    expect(await selfHealRiskIdentity('global', 'uid-1', options)).toEqual({ performed: false, reason: 'recent' })
  })

  it('refuses to heal when there is no component left to sample with', async () => {
    // Deleting the seed and then finding nothing to re-sample with would strip
    // this machine of its proven identity for nothing, so an absent component
    // refuses the heal and leaves the window unspent.
    const seed = join(home, '.config', '.locale_cfg')
    mkdirSync(dirname(seed), { recursive: true })
    writeFileSync(seed, 'seed-bytes')
    const { spawnImpl, calls } = fakeSpawn(answerFor('token-healed'))
    const options = { ...win32({ QODER_UMID_SELF_HEAL: '1' }), installRoots: [], spawnImpl }

    expect(await selfHealRiskIdentity('global', 'uid-1', options))
      .toEqual({ performed: false, reason: 'no-component' })
    expect(existsSync(seed)).toBe(true)
    expect(calls).toHaveLength(0)
  })

  it('never heals unless QODER_UMID_SELF_HEAL=1 asks for it', async () => {
    const seed = join(home, '.config', '.locale_cfg')
    mkdirSync(dirname(seed), { recursive: true })
    writeFileSync(seed, 'seed-bytes')
    const { spawnImpl, calls } = fakeSpawn(answerFor('token-healed'))
    const outcome = await selfHealRiskIdentity('global', 'uid-1', {
      ...win32(),
      installRoots: [fakeInstall()],
      spawnImpl,
    })
    expect(outcome).toEqual({ performed: false, reason: 'disabled' })
    expect(existsSync(seed)).toBe(true)
    expect(calls).toHaveLength(0)
  })
})

describe('identity cache status', () => {
  it('reports no status when this realm has never been cached', () => {
    expect(identityCacheStatus('global', { home })).toBeUndefined()
    // The other realm being present must not make an empty realm look cached.
    writeCachedIdentity('china', cachedEntry('cn-token', 1_000), identityCachePath(home))
    expect(identityCacheStatus('global', { home })).toBeUndefined()
    expect(identityCacheStatus('china', { home })).toEqual({ cachedAt: 1_000, stale: false })
  })

  it('marks the entry stale once it is past the TTL', () => {
    const cachedAt = 1_000
    writeCachedIdentity('global', cachedEntry('token', cachedAt), identityCachePath(home))

    expect(identityCacheStatus('global', { home, env: { QODER_UMID_IDENTITY_TTL: '1' }, now: cachedAt + 1 }))
      .toEqual({ cachedAt, stale: true })
    // One millisecond earlier it was still fresh: the bound is the same one the
    // resolution path uses, so status cannot disagree with what check-in serves.
    expect(identityCacheStatus('global', { home, env: { QODER_UMID_IDENTITY_TTL: '60000' }, now: cachedAt + 59_999 }))
      .toEqual({ cachedAt, stale: false })
  })

  it('never calls an entry stale while the TTL is unlimited', () => {
    const cachedAt = 1_000
    writeCachedIdentity('global', cachedEntry('token', cachedAt), identityCachePath(home))
    // The default: an identity a year old is still what this machine proves.
    expect(identityCacheStatus('global', { home, now: cachedAt + 365 * 24 * 60 * 60 * 1000 }))
      .toEqual({ cachedAt, stale: false })
    expect(identityCacheStatus('global', { home, env: { QODER_UMID_IDENTITY_TTL: '0' }, now: 2_000_000_000 }))
      .toEqual({ cachedAt, stale: false })
  })

  it('reports no status rather than failing on a corrupt file', () => {
    const path = identityCachePath(home)
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, '{ not json')
    expect(identityCacheStatus('global', { home })).toBeUndefined()
  })
})

describe('explicit identity reset', () => {
  it('samples the component again once the cache is cleared', async () => {
    // The seed is what the component fingerprints, so `reset-native` replaces it
    // and expects a new identity. With the TTL defaulting to "never expires" the
    // disk entry is the only thing that would keep handing back the old one —
    // a reset that leaves it in place silently does nothing.
    const { spawnImpl, calls } = fakeSpawn(answerFor('fresh-token'))
    const options = { ...win32(), installRoots: [fakeInstall()], spawnImpl }

    await resolveRiskIdentityDetail('global', 'uid-1', options)
    expect(calls.length).toBe(3)

    expect(clearMachineIdentityCache({ home })).toBe(true)
    clearIdentityMemoryCache()

    const resolution = await resolveRiskIdentityDetail('global', 'uid-1', options)
    expect(resolution?.identity.machineToken).toBe('fresh-token')
    expect(resolution?.source).toBe('component')
    expect(calls.length).toBe(6)
  })

  it('clears the memory copy even when the disk copy is already gone', async () => {
    // `reset-native` runs after the cache file was removed by hand, or after a
    // first reset. The 30-minute memory entry would still answer from the old
    // seed, so the reset has to drop it on its own.
    const { spawnImpl, calls } = fakeSpawn(answerFor('fresh-token'))
    const options = { ...win32(), installRoots: [fakeInstall()], spawnImpl }

    await resolveRiskIdentityDetail('global', 'uid-1', options)
    expect(calls.length).toBe(3)

    clearMachineIdentityCache({ home })
    clearIdentityMemoryCache()

    const resolution = await resolveRiskIdentityDetail('global', 'uid-1', options)
    expect(resolution?.source).toBe('component')
    expect(calls.length).toBe(6)
  })

  it('treats clearing an absent cache as a no-op', async () => {
    // Nothing has been cached in this fresh home; a reset path must not fail on
    // that, because the same code runs for users who never had a cache.
    expect(clearMachineIdentityCache({ home })).toBe(false)
    expect(() => clearIdentityMemoryCache()).not.toThrow()
    expect(clearMachineIdentityCache({ home: join(home, 'never-used') })).toBe(false)
  })
})

describe('risk identity resolution', () => {
  it('reports the client identity the helper returns', async () => {
    const { spawnImpl, calls } = fakeSpawn(`${JSON.stringify({ machineToken: 'token-1', machineCode: 'code-1', machineType: 'type-1' })}\n`)
    const identity = await resolveRiskIdentity('global', 'uid-1', { ...win32(), installRoots: [fakeInstall()], spawnImpl })
    expect(identity).toEqual({ machineToken: 'token-1', machineCode: 'code-1', machineType: 'type-1' })
    expect(calls[0]?.stdin).toBe('{"account":"uid-1"}\n')
  })

  it('selects the product with the env argument, not the binary', async () => {
    // Measured on an installed client: env 3 mints the international identity
    // and env 0 the China one, from the same binary. Asking with the wrong one
    // is indistinguishable from asking with none.
    const root = fakeInstall()
    const global = fakeSpawn(answerFor('token-1'))
    await resolveRiskIdentity('global', 'uid-1', { ...win32(), installRoots: [root], spawnImpl: global.spawnImpl })
    const china = fakeSpawn(answerFor('token-1'))
    await resolveRiskIdentity('china', 'uid-1', { ...win32(), installRoots: [root], spawnImpl: china.spawnImpl })
    expect(global.calls[0]?.args[0]).toBe('3')
    expect(china.calls[0]?.args[0]).toBe('0')
  })

  it('refuses to ask without an account to fingerprint', async () => {
    const { spawnImpl, calls } = fakeSpawn(answerFor('token-1'))
    expect(await resolveRiskIdentity('global', '   ', { ...win32(), installRoots: [fakeInstall()], spawnImpl }))
      .toBeUndefined()
    // Nothing may be spawned: an identity is per-account, so there is no
    // meaningful request to make and inventing a uid would fabricate one.
    expect(calls).toHaveLength(0)
  })

  it('answers undefined rather than throwing when the helper misbehaves', async () => {
    for (const stdout of ['not json\n', '{}\n', '{"machineToken":"only-one-field"}\n', '']) {
      const { spawnImpl } = fakeSpawn(stdout)
      await expect(resolveRiskIdentity('global', 'uid-1', { ...win32(), installRoots: [fakeInstall()], spawnImpl }))
        .resolves.toBeUndefined()
    }
  })

  it('answers undefined when no Qoder client is installed', () => {
    // The roots are injected so this asserts about the fixture rather than
    // about whether the machine running the suite happens to have Qoder.
    expect(findRuntimeInfoBinary({ ...win32(), installRoots: [] })).toBeUndefined()
  })

  it('finds the helper under a plain resources directory', () => {
    const root = fakeInstall()
    expect(findRuntimeInfoBinary({ ...win32(), installRoots: [root] }))
      .toBe(join(root, 'resources', 'umid', 'runtime-info.exe'))
  })

  it('prefers the versioned resources directory the launcher actually runs', () => {
    // 0.3+ keeps the live version under `.qoder-versions/<ver>/resources`, while
    // the top-level `resources` can be a stale leftover from the first install.
    const root = fakeInstall()
    const versioned = join(root, '.qoder-versions', '0.4.3', 'resources', 'umid')
    writeComponent(versioned)
    // The top-level candidate holds a helper too, so this only passes if the
    // versioned directory is genuinely searched and preferred.
    expect(findRuntimeInfoBinary({ ...win32(), installRoots: [root] }))
      .toBe(join(versioned, 'runtime-info.exe'))
  })

  it('treats a Windows component directory without sgsdk.dll as not installed (I-06)', () => {
    const root = join(home, 'exe-only')
    mkdirSync(join(root, 'resources', 'umid'), { recursive: true })
    writeFileSync(join(root, 'resources', 'umid', 'runtime-info.exe'), 'stub')
    expect(findRuntimeInfoBinary({ ...win32(), installRoots: [root] })).toBeUndefined()
  })
})

describe('campaign hostname', () => {
  it('keeps a header-safe hostname as it is', () => {
    expect(headerSafeHostname('workstation-7.corp.example')).toBe('workstation-7.corp.example')
  })

  it('punycodes a hostname that cannot go into a header', () => {
    // Node rejects a header value outside latin1, so a non-ASCII hostname must be
    // translated rather than truncated.
    expect(headerSafeHostname('büro-pc')).toBe('xn--bro-pc-3ya')
    expect(campaignHostname({ hostnameImpl: () => 'büro-pc' })).toBe('xn--bro-pc-3ya')
  })

  it('falls back to a stable slug when the name is not a hostname at all', () => {
    // A name that fails IDNA still has to produce something stable and safe:
    // the digest keeps two machines distinct without leaking their names.
    expect(headerSafeHostname('pc\u0000x')).toMatch(/^pc-x-[0-9a-f]{8}$/)
    expect(headerSafeHostname('pc\u0000x')).toBe(headerSafeHostname('pc\u0000x'))
  })
})
