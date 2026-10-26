/**
 * Tests for the native component installer (SPEC-UMID-003 M1).
 *
 * Every test here runs offline: the machine this was developed on has no HTTPS
 * egress (schannel refuses to negotiate), so a test that needed the real
 * registry could not run at all. The tarball is therefore built in memory —
 * a real gzip'd ustar archive containing fake ELF / PE / WASM blobs base64'd
 * into an `.mjs` bundle, which is exactly the shape the real package has — and
 * the registry path is driven through an injected `fetch`.
 *
 * The size windows are pressed down to the kilobyte scale so a fixture is a few
 * KB instead of ~25 MB; the windows are injectable precisely so this is possible
 * without weakening what the tests prove.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gzipSync } from 'node:zlib'
import {
  identifyUmidBlob,
  installUmid,
  isUmidPeDll,
  readUmidManifest,
  scanUmidBlobs,
  umidInstalled,
  umidSelfCheckEnv,
} from '../../src/qoder/transport/umid-extract.ts'
import type {
  UmidSelfCheckOutcome,
  UmidSelfCheckRequest,
  UmidSelfCheckRunner,
} from '../../src/qoder/transport/umid-extract.ts'

/** Size windows at kilobyte scale; see the file comment. */
const testHints = { fileMin: 200, fileMax: 4096, dllMin: 1024 }

/** Shortest literal treated as a blob, at kilobyte scale. */
const testBlobMinChars = 100

const elfMachineX64 = 0x3E
const elfMachineAarch64 = 0xB7

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function scratch(): string {
  return mkdtempSync(join(tmpdir(), 'dsh-umid-'))
}

function elfBinary(machine: number, size = 1024): Buffer {
  const buffer = Buffer.alloc(size)
  buffer[0] = 0x7F
  buffer[1] = 0x45
  buffer[2] = 0x4C
  buffer[3] = 0x46
  buffer[4] = 2 // ELFCLASS64
  buffer[5] = 1 // little endian
  buffer.writeUInt16LE(machine, 18)
  return buffer
}

function peBinary(options: { machine?: number; dll?: boolean; size?: number } = {}): Buffer {
  const size = options.size ?? 1024
  const buffer = Buffer.alloc(size)
  buffer.write('MZ', 0, 'latin1')
  const peOffset = 0x80
  buffer.writeUInt32LE(peOffset, 0x3C)
  buffer.write('PE\0\0', peOffset, 'latin1')
  buffer.writeUInt16LE(options.machine ?? 0x8664, peOffset + 4)
  // IMAGE_FILE_EXECUTABLE_IMAGE (0x0102's low bits) plus, when asked, the DLL flag.
  buffer.writeUInt16LE(options.dll === true ? 0x2102 : 0x0102, peOffset + 22)
  return buffer
}

function wasmBinary(size = 512): Buffer {
  const buffer = Buffer.alloc(size)
  buffer[0] = 0x00
  buffer[1] = 0x61
  buffer[2] = 0x73
  buffer[3] = 0x6D
  buffer.writeUInt32LE(1, 4)
  return buffer
}

function tarHeader(name: string, size: number): Buffer {
  const header = Buffer.alloc(512)
  header.write(name, 0, 'utf8')
  header.write(`${size.toString(8).padStart(11, '0')}\0`, 124, 'latin1')
  header[156] = 0x30 // typeflag '0'
  header.write('ustar\0', 257, 'latin1')
  header.write('00', 263, 'latin1')
  header.fill(0x20, 148, 156)
  let sum = 0
  for (const byte of header) sum += byte
  header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 'latin1')
  return header
}

function tarArchive(entries: readonly { name: string; data: Buffer }[]): Buffer {
  const parts: Buffer[] = []
  for (const entry of entries) {
    parts.push(tarHeader(entry.name, entry.data.length))
    parts.push(entry.data)
    const pad = (512 - (entry.data.length % 512)) % 512
    if (pad > 0) parts.push(Buffer.alloc(pad))
  }
  parts.push(Buffer.alloc(1024)) // end-of-archive marker
  return Buffer.concat(parts)
}

const bundleName = 'package/bundle/qoder-worker-runtime.mjs'

/** Build the published package's shape: a bundle of base64 literals in a tarball. */
function packageTarball(blobs: readonly Buffer[], options: { version?: string } = {}): Buffer {
  const version = options.version ?? '1.1.75'
  const bundle = blobs.map((blob, index) => `const asset${index} = "${blob.toString('base64')}"\n`).join('')
  return gzipSync(tarArchive([
    { name: 'package/package.json', data: Buffer.from(JSON.stringify({ name: '@qoder-ai/qodercli', version })) },
    { name: bundleName, data: Buffer.from(bundle, 'utf8') },
  ]))
}

function writeTarball(dir: string, bytes: Buffer): string {
  const path = join(dir, 'fixture.tgz')
  writeFileSync(path, bytes)
  return path
}

interface SelfCheckRecorder {
  runner: UmidSelfCheckRunner
  calls: UmidSelfCheckRequest[]
}

function selfCheckRunner(stdout: string): SelfCheckRecorder {
  const calls: UmidSelfCheckRequest[] = []
  return {
    calls,
    runner: async (request): Promise<UmidSelfCheckOutcome> => {
      calls.push(request)
      return { code: 0, stdout }
    },
  }
}

function okSelfCheck(token = 'machine-token-abc123'): SelfCheckRecorder {
  return selfCheckRunner(`${JSON.stringify({ machineToken: token, machineType: 'KVM' })}\n`)
}

interface FetchRecorder {
  fetchImpl: typeof fetch
  calls: string[]
}

/**
 * A `fetch` that answers the packument and then the tarball.
 *
 * The tarball body is delivered in three chunks so the tests also exercise the
 * reassembly of tar headers split across stream chunks.
 */
function registryFetch(config: {
  tarball: Buffer
  version?: string
  integrity?: string
  tarballUrl?: string
  responseUrl?: string
}): FetchRecorder {
  const version = config.version ?? '1.1.75'
  const tarballUrl = config.tarballUrl ?? `https://registry.npmjs.org/@qoder-ai/qodercli/-/qodercli-${version}.tgz`
  const packument = {
    'dist-tags': { latest: version },
    versions: {
      [version]: {
        dist: {
          tarball: tarballUrl,
          ...config.integrity === undefined ? {} : { integrity: config.integrity },
        },
      },
    },
  }
  const calls: string[] = []
  const fetchImpl = async (input: unknown): Promise<Response> => {
    const url = String(input)
    calls.push(url)
    if (url.endsWith('.tgz')) return fakeResponse(config.responseUrl ?? tarballUrl, config.tarball)
    return fakeResponse(url, Buffer.from(JSON.stringify(packument)))
  }
  return { fetchImpl: fetchImpl as unknown as typeof fetch, calls }
}

function fakeResponse(url: string, body: Buffer): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const step = Math.max(1, Math.ceil(body.length / 3))
      for (let offset = 0; offset < body.length; offset += step) {
        controller.enqueue(new Uint8Array(body.subarray(offset, offset + step)))
      }
      controller.close()
    },
  })
  return {
    ok: true,
    status: 200,
    url,
    body: stream,
    headers: new Headers(),
    json: async (): Promise<unknown> => JSON.parse(body.toString('utf8')),
    text: async (): Promise<string> => body.toString('utf8'),
  } as unknown as Response
}

function stagingLeftovers(destDir: string): string[] {
  try {
    return readdirSync(destDir).filter(name => name.startsWith('.staging-'))
  } catch {
    return []
  }
}

function componentFiles(destDir: string): string[] {
  try {
    return readdirSync(destDir).filter(name => !name.startsWith('.'))
  } catch {
    return []
  }
}

function sha512Integrity(bytes: Buffer): string {
  return `sha512-${createHash('sha512').update(bytes).digest('base64')}`
}

// ---------------------------------------------------------------------------
// T-M1-1 — identification and promotion
// ---------------------------------------------------------------------------

test('T-M1-1 an in-memory tarball installs the ELF component for linux-x64', async () => {
  const dir = scratch()
  try {
    const destDir = join(dir, 'umid')
    const smallElf = elfBinary(elfMachineX64, 1024)
    const largeElf = elfBinary(elfMachineX64, 2048)
    const armElf = elfBinary(elfMachineAarch64, 1024)
    const tarball = packageTarball([wasmBinary(), peBinary({ dll: true, size: 2048 }), armElf, largeElf, smallElf])
    const selfCheck = okSelfCheck()

    const result = await installUmid({
      platform: 'linux',
      arch: 'x64',
      destDir,
      tarballPath: writeTarball(dir, tarball),
      sizeHints: testHints,
      minBlobChars: testBlobMinChars,
      selfCheck: selfCheck.runner,
    })

    assert.equal(result.ok, true, result.error)
    assert.equal(result.skipped, false)
    assert.equal(result.version, '1.1.75')
    assert.equal(umidInstalled(destDir, 'linux'), true)
    // The smaller of the two x86-64 ELFs wins: the archive carries several
    // same-format blobs and only the size window separates them.
    assert.deepEqual(readFileSync(join(destDir, 'runtime-info')), smallElf)
    assert.equal(identifyUmidBlob(smallElf), 'elf-x86_64')

    const manifest = readUmidManifest(destDir)
    if (manifest === undefined) assert.fail('the install wrote no manifest')
    assert.equal(manifest.schema, 1)
    assert.equal(manifest.platform, 'linux')
    assert.equal(manifest.source.kind, 'tarball')
    assert.equal(manifest.source.entry, bundleName)
    assert.deepEqual(manifest.source.blobIndexes, [4])
    assert.equal(manifest.source.tarballBytes, tarball.length)
    assert.equal(manifest.source.tarballSha512, createHash('sha512').update(tarball).digest('base64'))

    // The self-check ran the staged binary, in the staging directory, with the
    // product selector as its only argument.
    assert.equal(selfCheck.calls.length, 1)
    const call = selfCheck.calls[0]
    if (call === undefined) assert.fail('the self-check never ran')
    assert.deepEqual(call.args, [umidSelfCheckEnv])
    assert.equal(call.binary, join(call.cwd, 'runtime-info'))
    assert.ok(call.cwd.startsWith(join(destDir, '.staging-')))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('T-M1-1 a tarball installs the executable plus library pair for win32-x64', async () => {
  const dir = scratch()
  try {
    const destDir = join(dir, 'umid')
    const exe = peBinary({ dll: false, size: 1024 })
    const dll = peBinary({ dll: true, size: 2048 })
    const tarball = packageTarball([wasmBinary(), exe, dll])

    const result = await installUmid({
      platform: 'win32',
      arch: 'x64',
      destDir,
      tarballPath: writeTarball(dir, tarball),
      sizeHints: testHints,
      minBlobChars: testBlobMinChars,
      selfCheck: okSelfCheck().runner,
    })

    assert.equal(result.ok, true, result.error)
    assert.deepEqual(readFileSync(join(destDir, 'runtime-info.exe')), exe)
    assert.deepEqual(readFileSync(join(destDir, 'sgsdk.dll')), dll)
    assert.equal(umidInstalled(destDir, 'win32'), true)
    const manifest = readUmidManifest(destDir)
    if (manifest === undefined) assert.fail('the install wrote no manifest')
    assert.deepEqual(manifest.source.blobIndexes, [1, 2])
    assert.deepEqual(manifest.files.map(file => file.name), ['runtime-info.exe', 'sgsdk.dll'])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// T-M1-2 — the DLL flag, not the format, separates the pair
// ---------------------------------------------------------------------------

test('T-M1-2 a PE without the DLL flag is never taken for the companion library', async () => {
  const dir = scratch()
  try {
    const destDir = join(dir, 'umid')
    assert.equal(isUmidPeDll(peBinary({ dll: false, size: 2048 })), false)
    assert.equal(isUmidPeDll(peBinary({ dll: true, size: 2048 })), true)

    // An executable and a second, larger non-DLL image: nothing here is the DLL.
    const tarball = packageTarball([wasmBinary(), peBinary({ dll: false, size: 1024 }), peBinary({ dll: false, size: 2048 })])
    const result = await installUmid({
      platform: 'win32',
      arch: 'x64',
      destDir,
      tarballPath: writeTarball(dir, tarball),
      sizeHints: testHints,
      minBlobChars: testBlobMinChars,
      selfCheck: okSelfCheck().runner,
    })

    assert.equal(result.ok, false)
    assert.match(result.error ?? '', /sgsdk\.dll/u)
    assert.match(result.error ?? '', /layout may have changed/u)
    assert.equal(umidInstalled(destDir, 'win32'), false)
    assert.deepEqual(componentFiles(destDir), [])
    assert.deepEqual(stagingLeftovers(destDir), [])

    // A DLL-flagged image below the size window is still not the library.
    const tinyDll = packageTarball([peBinary({ dll: false, size: 1024 }), peBinary({ dll: true, size: 512 })])
    const second = await installUmid({
      platform: 'win32',
      arch: 'x64',
      destDir,
      tarballPath: writeTarball(dir, tinyDll),
      sizeHints: testHints,
      minBlobChars: testBlobMinChars,
      selfCheck: okSelfCheck().runner,
    })
    assert.equal(second.ok, false)
    assert.equal(umidInstalled(destDir, 'win32'), false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// T-M1-3 — integrity
// ---------------------------------------------------------------------------

test('T-M1-3 a sha512 mismatch aborts the install and writes nothing', async () => {
  const dir = scratch()
  try {
    const destDir = join(dir, 'umid')
    const tarball = packageTarball([wasmBinary(), elfBinary(elfMachineX64, 1024)])
    const registry = registryFetch({
      tarball,
      integrity: sha512Integrity(Buffer.from('a different tarball')),
    })

    const result = await installUmid({
      platform: 'linux',
      arch: 'x64',
      destDir,
      registry: 'https://registry.npmjs.org',
      fetchImpl: registry.fetchImpl,
      sizeHints: testHints,
      minBlobChars: testBlobMinChars,
      selfCheck: okSelfCheck().runner,
    })

    assert.equal(result.ok, false)
    assert.match(result.error ?? '', /sha512 mismatch/u)
    assert.equal(existsSync(join(destDir, 'runtime-info')), false)
    assert.deepEqual(componentFiles(destDir), [])
    assert.deepEqual(stagingLeftovers(destDir), [])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// T-M1-4 — a broken tarball never damages a working install
// ---------------------------------------------------------------------------

test('T-M1-4 a truncated or non-gzip tarball fails cleanly and leaves the old install untouched', async () => {
  const dir = scratch()
  try {
    const destDir = join(dir, 'umid')
    mkdirSync(destDir, { recursive: true })
    writeFileSync(join(destDir, 'runtime-info'), 'OLD-CONTENT')

    const good = packageTarball([wasmBinary(), elfBinary(elfMachineX64, 1024)])
    const cases: { label: string; bytes: Buffer }[] = [
      { label: 'not gzip at all', bytes: Buffer.from('this is not a tarball') },
      { label: 'truncated gzip', bytes: good.subarray(0, Math.floor(good.length / 2)) },
    ]

    for (const testCase of cases) {
      const result = await installUmid({
        platform: 'linux',
        arch: 'x64',
        destDir,
        tarballPath: writeTarball(dir, testCase.bytes),
        force: true,
        sizeHints: testHints,
        minBlobChars: testBlobMinChars,
        selfCheck: okSelfCheck().runner,
      })
      assert.equal(result.ok, false, `${testCase.label} should not install`)
      assert.notEqual(result.error, undefined, `${testCase.label} should explain itself`)
      // Invariant I-05: a failed install leaves the component directory as it was.
      assert.equal(readFileSync(join(destDir, 'runtime-info'), 'utf8'), 'OLD-CONTENT', testCase.label)
      assert.deepEqual(stagingLeftovers(destDir), [], testCase.label)
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// T-M1-5 — reuse without touching the network
// ---------------------------------------------------------------------------

test('T-M1-5 an installed component is reused without a single network request', async () => {
  const dir = scratch()
  try {
    const destDir = join(dir, 'umid')
    mkdirSync(destDir, { recursive: true })
    writeFileSync(join(destDir, 'runtime-info'), 'ALREADY-INSTALLED')

    let networkCalls = 0
    const fetchImpl = (async (): Promise<Response> => {
      networkCalls += 1
      throw new Error('the network must not be used for an installed component')
    }) as unknown as typeof fetch

    const result = await installUmid({
      platform: 'linux',
      arch: 'x64',
      destDir,
      registry: 'https://registry.npmjs.org',
      fetchImpl,
      sizeHints: testHints,
      minBlobChars: testBlobMinChars,
      selfCheck: okSelfCheck().runner,
    })

    assert.equal(result.ok, true)
    assert.equal(result.skipped, true)
    assert.equal(networkCalls, 0)
    assert.equal(readFileSync(join(destDir, 'runtime-info'), 'utf8'), 'ALREADY-INSTALLED')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// T-M1-6 — the manifest is a diagnostic, not a copy of the identity
// ---------------------------------------------------------------------------

test('T-M1-6 the manifest records provenance and never the machine token', async () => {
  const dir = scratch()
  try {
    const destDir = join(dir, 'umid')
    const token = 'super-secret-machine-token'
    const elf = elfBinary(elfMachineX64, 1024)
    const tarball = packageTarball([wasmBinary(), elf])

    const result = await installUmid({
      platform: 'linux',
      arch: 'x64',
      destDir,
      tarballPath: writeTarball(dir, tarball),
      sizeHints: testHints,
      minBlobChars: testBlobMinChars,
      selfCheck: okSelfCheck(token).runner,
    })
    assert.equal(result.ok, true, result.error)

    const manifestPath = join(destDir, 'manifest.json')
    const text = readFileSync(manifestPath, 'utf8')
    assert.equal(text.includes(token), false, 'the manifest must not store the token')
    const manifest = JSON.parse(text) as {
      schema: number
      files: { name: string; bytes: number; sha256: string }[]
      selfCheck: { ok: boolean; at?: string; machineTokenSha256Prefix?: string }
    }
    assert.equal(manifest.schema, 1)
    assert.equal(manifest.selfCheck.ok, true)
    assert.equal(typeof manifest.selfCheck.at, 'string')
    assert.equal(
      manifest.selfCheck.machineTokenSha256Prefix,
      createHash('sha256').update(token).digest('hex').slice(0, 8),
    )
    assert.equal(manifest.files.length, 1)
    const file = manifest.files[0]
    if (file === undefined) assert.fail('the manifest lists no files')
    assert.equal(file.name, 'runtime-info')
    assert.equal(file.bytes, elf.length)
    assert.equal(file.sha256, createHash('sha256').update(elf).digest('hex'))

    if (process.platform !== 'win32') {
      assert.equal(statSync(manifestPath).mode & 0o777, 0o600, 'the manifest must be 0600')
      assert.equal(statSync(join(destDir, 'runtime-info')).mode & 0o777, 0o755, 'the component must be 0755')
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// T-M1-7 — unsupported targets
// ---------------------------------------------------------------------------

test('T-M1-7 win32-arm64 is refused before any download', async () => {
  const dir = scratch()
  try {
    const destDir = join(dir, 'umid')
    let networkCalls = 0
    const fetchImpl = (async (): Promise<Response> => {
      networkCalls += 1
      throw new Error('an unsupported platform must not reach the network')
    }) as unknown as typeof fetch

    const result = await installUmid({
      platform: 'win32',
      arch: 'arm64',
      destDir,
      registry: 'https://registry.npmjs.org',
      fetchImpl,
      sizeHints: testHints,
      minBlobChars: testBlobMinChars,
      selfCheck: okSelfCheck().runner,
    })

    assert.equal(result.ok, false)
    assert.match(result.error ?? '', /unsupported-platform: win32-arm64/u)
    // The message must say what IS supported, or the user cannot act on it.
    assert.match(result.error ?? '', /win32-x64/u)
    assert.match(result.error ?? '', /linux-arm64/u)
    assert.equal(networkCalls, 0)
    assert.equal(existsSync(destDir), false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// T-M1-8 — a component that cannot mint an identity is not an install
// ---------------------------------------------------------------------------

test('T-M1-8 a failed self-check promotes nothing and removes the staging directory', async () => {
  const dir = scratch()
  try {
    const destDir = join(dir, 'umid')
    const tarball = packageTarball([wasmBinary(), elfBinary(elfMachineX64, 1024)])
    // A component that answers, but not with an identity.
    const selfCheck = selfCheckRunner(`${JSON.stringify({ machineType: 'KVM', machineCode: 'abc' })}\n`)

    const result = await installUmid({
      platform: 'linux',
      arch: 'x64',
      destDir,
      tarballPath: writeTarball(dir, tarball),
      sizeHints: testHints,
      minBlobChars: testBlobMinChars,
      selfCheck: selfCheck.runner,
    })

    assert.equal(result.ok, false)
    assert.match(result.error ?? '', /self-check failed/u)
    assert.match(result.error ?? '', /machineToken/u)
    assert.equal(existsSync(join(destDir, 'runtime-info')), false)
    assert.equal(existsSync(join(destDir, 'manifest.json')), false)
    assert.deepEqual(componentFiles(destDir), [])
    assert.deepEqual(stagingLeftovers(destDir), [])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// T-M1-9 — abandoned staging directories
// ---------------------------------------------------------------------------

test('T-M1-9 leftover .staging-* directories are removed by the next install', async () => {
  const dir = scratch()
  try {
    const destDir = join(dir, 'umid')
    const leftover = join(destDir, '.staging-abandoned')
    mkdirSync(leftover, { recursive: true })
    writeFileSync(join(leftover, 'runtime-info'), 'half-written')

    const tarball = packageTarball([wasmBinary(), elfBinary(elfMachineX64, 1024)])
    const result = await installUmid({
      platform: 'linux',
      arch: 'x64',
      destDir,
      tarballPath: writeTarball(dir, tarball),
      sizeHints: testHints,
      minBlobChars: testBlobMinChars,
      selfCheck: okSelfCheck().runner,
    })

    assert.equal(result.ok, true, result.error)
    assert.equal(existsSync(leftover), false)
    assert.deepEqual(stagingLeftovers(destDir), [])
    assert.equal(umidInstalled(destDir, 'linux'), true)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// Registry path, offline
// ---------------------------------------------------------------------------

test('a registry install streams the tarball, verifies it and promotes it', async () => {
  const dir = scratch()
  try {
    const destDir = join(dir, 'umid')
    const elf = elfBinary(elfMachineX64, 1024)
    const tarball = packageTarball([wasmBinary(), elf], { version: '2.0.0' })
    const registry = registryFetch({ tarball, version: '2.0.0', integrity: sha512Integrity(tarball) })

    const result = await installUmid({
      platform: 'linux',
      arch: 'x64',
      destDir,
      registry: 'https://registry.npmjs.org',
      fetchImpl: registry.fetchImpl,
      sizeHints: testHints,
      minBlobChars: testBlobMinChars,
      selfCheck: okSelfCheck().runner,
    })

    assert.equal(result.ok, true, result.error)
    assert.equal(result.version, '2.0.0')
    assert.deepEqual(readFileSync(join(destDir, 'runtime-info')), elf)
    assert.equal(registry.calls.length, 2)
    assert.equal(registry.calls[0], 'https://registry.npmjs.org/@qoder-ai/qodercli')
    assert.ok(registry.calls[1]?.endsWith('.tgz') === true)
    const manifest = readUmidManifest(destDir)
    if (manifest === undefined) assert.fail('the install wrote no manifest')
    assert.equal(manifest.source.kind, 'registry')
    assert.equal(manifest.source.version, '2.0.0')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a tarball served from a host other than the registry is refused', async () => {
  const dir = scratch()
  try {
    const destDir = join(dir, 'umid')
    const tarball = packageTarball([wasmBinary(), elfBinary(elfMachineX64, 1024)])
    const registry = registryFetch({
      tarball,
      integrity: sha512Integrity(tarball),
      tarballUrl: 'https://evil.example/@qoder-ai/qodercli/-/qodercli-1.1.75.tgz',
    })

    const result = await installUmid({
      platform: 'linux',
      arch: 'x64',
      destDir,
      registry: 'https://registry.npmjs.org',
      fetchImpl: registry.fetchImpl,
      sizeHints: testHints,
      minBlobChars: testBlobMinChars,
      selfCheck: okSelfCheck().runner,
    })

    assert.equal(result.ok, false)
    assert.match(result.error ?? '', /registry host/u)
    assert.deepEqual(componentFiles(destDir), [])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a redirect that leaves the registry host is refused even when the bytes verify', async () => {
  const dir = scratch()
  try {
    const destDir = join(dir, 'umid')
    const tarball = packageTarball([wasmBinary(), elfBinary(elfMachineX64, 1024)])
    // The advertised URL is on the registry, but the response came from elsewhere.
    const registry = registryFetch({
      tarball,
      integrity: sha512Integrity(tarball),
      responseUrl: 'https://mirror.example/qodercli-1.1.75.tgz',
    })

    const result = await installUmid({
      platform: 'linux',
      arch: 'x64',
      destDir,
      registry: 'https://registry.npmjs.org',
      fetchImpl: registry.fetchImpl,
      sizeHints: testHints,
      minBlobChars: testBlobMinChars,
      selfCheck: okSelfCheck().runner,
    })

    assert.equal(result.ok, false)
    assert.match(result.error ?? '', /not the registry host/u)
    assert.deepEqual(componentFiles(destDir), [])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a non-https registry is refused', async () => {
  const dir = scratch()
  try {
    const destDir = join(dir, 'umid')
    let networkCalls = 0
    const fetchImpl = (async (): Promise<Response> => {
      networkCalls += 1
      throw new Error('an insecure registry must not be contacted')
    }) as unknown as typeof fetch

    const result = await installUmid({
      platform: 'linux',
      arch: 'x64',
      destDir,
      registry: 'http://registry.npmjs.org',
      fetchImpl,
      sizeHints: testHints,
      minBlobChars: testBlobMinChars,
      selfCheck: okSelfCheck().runner,
    })

    assert.equal(result.ok, false)
    assert.match(result.error ?? '', /https:/u)
    assert.equal(networkCalls, 0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('identifyUmidBlob names each supported format and rejects the rest', () => {
  assert.equal(identifyUmidBlob(elfBinary(elfMachineX64)), 'elf-x86_64')
  assert.equal(identifyUmidBlob(elfBinary(elfMachineAarch64)), 'elf-aarch64')
  assert.equal(identifyUmidBlob(peBinary({ dll: false })), 'pe-x86_64')
  assert.equal(identifyUmidBlob(peBinary({ machine: 0xAA64 })), 'pe-aarch64')
  assert.equal(identifyUmidBlob(wasmBinary()), 'wasm')

  const macho = Buffer.alloc(64)
  macho.writeUInt32LE(0xFEEDFACF, 0)
  macho.writeUInt32LE(0x0100000C, 4)
  assert.equal(identifyUmidBlob(macho), 'macho-arm64')
  macho.writeUInt32LE(0x01000007, 4)
  assert.equal(identifyUmidBlob(macho), 'macho-x86_64')

  assert.equal(identifyUmidBlob(Buffer.from('nope')), 'unknown')
  assert.equal(identifyUmidBlob(Buffer.alloc(0)), 'unknown')
})

// ---------------------------------------------------------------------------
// Blob scanning at the scale of the real bundle
// ---------------------------------------------------------------------------

/*
 * These two are regressions, not shape tests. The scanner was originally a
 * `matchAll` over `/(['"])([A-Za-z0-9+/=]{4000,})\1/g`, which is correct on the
 * kilobyte fixtures above and overflowed V8's backtracking stack on the real
 * ~31 MB bundle, where a single base64 literal is megabytes long: every network
 * install died with `RangeError: Maximum call stack size exceeded`. Only an
 * input of that scale can tell the two implementations apart.
 */

test('a single multi-megabyte base64 literal is scanned without exhausting the stack', () => {
  const binary = Buffer.alloc(6 * 1024 * 1024)
  binary.writeUInt32LE(0x464C457F, 0)
  binary[4] = 2
  binary[5] = 1
  binary.writeUInt16LE(elfMachineX64, 18)
  const text = `const asset = '${binary.toString('base64')}';\n`
  assert.ok(text.length > 8 * 1024 * 1024)

  const records = scanUmidBlobs(text, 4000)
  assert.equal(records.length, 1)
  assert.equal(records[0]?.kind, 'elf-x86_64')
  assert.equal(records[0]?.bytes, binary.length)
})

test('a long input of failing candidates is scanned in linear time', () => {
  // Hundreds of unclosed runs: a scanner that advanced one character at a time
  // instead of jumping past each measured run would be quadratic here and take
  // minutes rather than milliseconds. The bound is loose on purpose — it only
  // has to separate linear from quadratic.
  const run = 'A'.repeat(200_000)
  const text = '"'.repeat(500) + run.repeat(20)
  assert.ok(text.length > 4_000_000)

  const started = Date.now()
  const records = scanUmidBlobs(text, 4000)
  const elapsed = Date.now() - started
  assert.equal(records.length, 0)
  assert.ok(elapsed < 10_000, `scanning ${text.length} chars took ${elapsed} ms, which suggests a quadratic scan`)
})

test('a rejected candidate does not hide the literal that follows it', () => {
  const binary = elfBinary(elfMachineX64, 1024)
  // The long run is closed by the wrong quote, so it is not a candidate; the
  // scan must resume at the end of that run and still find the real literal.
  const text = `const a = "${'A'.repeat(5000)}';\nconst b = '${binary.toString('base64')}';\n`
  const records = scanUmidBlobs(text, testBlobMinChars)
  assert.deepEqual(records.map(record => record.kind), ['elf-x86_64'])
})

/*
 * The CLI is exercised through a real child process rather than by importing
 * `run()`: the parts worth testing here are the wiring (which flag reaches
 * which option, which exit code a failure produces) and the on-disk effects of
 * `reset-native`, none of which exist below `run()`.
 *
 * `HOME` and `USERPROFILE` are both overridden because `os.homedir()` reads the
 * former on POSIX and the latter on Windows; setting only one would make these
 * tests delete the real user's seed on the other platform.
 */

const repoRoot = fileURLToPath(new URL('../..', import.meta.url))

interface CliRun {
  status: number | null
  stdout: string
  stderr: string
}

function runCli(args: readonly string[], env: Readonly<Record<string, string>> = {}): CliRun {
  const result = spawnSync(process.execPath, ['--experimental-strip-types', 'src/bin.ts', ...args], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: { ...process.env, ...env },
  })
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
}

/** A throwaway home plus component directory, and the env that points the CLI at them. */
function cliSandbox(): { home: string; componentDir: string; env: Record<string, string> } {
  const home = mkdtempSync(join(tmpdir(), 'umid-cli-home-'))
  const componentDir = join(home, 'component')
  return {
    home,
    componentDir,
    env: { HOME: home, USERPROFILE: home, QODER_UMID_DIR: componentDir, QODER_UMID_IDENTITY_TTL: '0' },
  }
}

test('umid status reports an absent component as a normal state, not a failure', () => {
  const sandbox = cliSandbox()
  try {
    const run = runCli(['umid', 'status', '--json'], sandbox.env)
    assert.equal(run.status, 0)
    const report = JSON.parse(run.stdout) as {
      installed: boolean
      componentDir: string
      identityCache: { path: string; present: boolean; ttlMs: number }
      identityTtlNote: string
    }
    assert.equal(report.installed, false)
    assert.equal(report.componentDir, sandbox.componentDir)
    assert.equal(report.identityCache.present, false)
    assert.equal(report.identityCache.path, join(sandbox.home, '.dsh', 'qoder', 'machine-identity.json'))
    assert.match(report.identityTtlNote, /never clears the stored seed/u)
  } finally {
    rmSync(sandbox.home, { recursive: true, force: true })
  }
})

test('doctor carries the native component as diagnostics without changing its verdict', () => {
  const sandbox = cliSandbox()
  try {
    const run = runCli(['doctor', '--json'], sandbox.env)
    const report = JSON.parse(run.stdout) as {
      signIn: string
      nativeDevice: { componentDir: string; binary: string; installed: boolean; identityCache: { present: boolean } }
    }
    assert.equal(report.nativeDevice.componentDir, sandbox.componentDir)
    assert.equal(report.nativeDevice.installed, false)
    assert.equal(report.nativeDevice.identityCache.present, false)
    // The exit code still describes the credential only: a missing component is
    // not a doctor failure, which is what keeps `doctor` usable before setup.
    assert.equal(run.status, report.signIn === 'configured' ? 0 : 1)
  } finally {
    rmSync(sandbox.home, { recursive: true, force: true })
  }
})

test('umid reset-native deletes the seed and the identity cache only when confirmed', () => {
  const sandbox = cliSandbox()
  const seedPath = join(sandbox.home, '.dsh', 'qoder', 'device_seed')
  const cachePath = join(sandbox.home, '.dsh', 'qoder', 'machine-identity.json')
  try {
    mkdirSync(dirname(seedPath), { recursive: true })
    writeFileSync(seedPath, 'a-seed\n')
    writeFileSync(cachePath, JSON.stringify({
      schema: 1,
      realm: { china: { machineToken: 'token', machineType: 'm', machineCode: 'c', source: 'runtime-info', cachedAt: Date.now() } },
    }))

    const dry = runCli(['umid', 'reset-native'], sandbox.env)
    assert.equal(dry.status, 0)
    assert.ok(existsSync(seedPath), 'a dry run must not delete the seed')
    assert.ok(existsSync(cachePath), 'a dry run must not delete the cache')
    assert.match(dry.stdout, /Would delete device seed/u)
    assert.match(dry.stdout, /\.locale_cfg is untouched/u)

    const run = runCli(['umid', 'reset-native', '--yes'], sandbox.env)
    assert.equal(run.status, 0)
    assert.equal(existsSync(seedPath), false)
    // The cache must go too: its default TTL is 0, so leaving it would keep
    // serving the identity the deleted seed no longer backs.
    assert.equal(existsSync(cachePath), false)
    assert.match(run.stdout, /Removed device seed/u)
    assert.match(run.stdout, /Cleared identity cache/u)
  } finally {
    rmSync(sandbox.home, { recursive: true, force: true })
  }
})

test('umid without a subcommand and umid flags on another action are usage errors', () => {
  const bare = runCli(['umid'])
  assert.equal(bare.status, 2)
  assert.match(bare.stderr, /umid needs install, status, or reset-native/u)

  const misplaced = runCli(['doctor', '--force'])
  assert.equal(misplaced.status, 2)
  assert.match(misplaced.stderr, /--force applies to `umid install` only/u)
})
