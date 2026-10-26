/**
 * Installing the official native device-identity component.
 *
 * The international daily campaign ("每日领取 100 Credits") is gated on machine
 * -identity headers that only the official `runtime-info` component produces.
 * That component ships inside the Qoder desktop client, so a machine without
 * the client cannot request the campaign at all — which is the dependency this
 * module exists to remove.
 *
 * The component is also published, verbatim, inside the official npm package
 * `@qoder-ai/qodercli`: its bundle embeds each platform's binary as one long
 * base64 literal. Extraction is therefore a pure local transformation — fetch
 * the tarball, verify it, walk the archive, identify the embedded binaries by
 * their magic bytes, write the one this platform needs. No official binary is
 * vendored here and none is redistributed: what lands on disk is downloaded
 * from the vendor's own registry on the user's own machine, at the user's own
 * request.
 *
 * This module owns the install pipeline. {@link ./risk-identity.ts} owns
 * finding and running the result.
 *
 * ## Shape of the pipeline
 *
 * The tarball is ~31 MB and the bundle inside it is ~25 MB, so neither may be
 * buffered whole: the download is hashed, decompressed and tar-scanned in one
 * pass, and only the bytes of the one `.mjs` entry that carries the binaries
 * are kept. Nothing is written to the component directory until the archive
 * has been verified, decompressed and scanned, which is what makes a failed
 * install leave the previous one byte-identical (invariant I-05).
 *
 * Two sources are supported and they are not equal citizens: a local tarball
 * (`tarballPath` / `QODER_UMID_TARBALL`) bypasses the network entirely, because
 * on machines behind an intercepting proxy — the developer machine this was
 * built on included — the registry is simply unreachable.
 *
 * @module dsh-qoder-plugin/qoder/transport/umid-extract
 */

import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { chmodSync, createReadStream, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import type { Dirent } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { createGunzip } from 'node:zlib'

/** The npm package that carries the component. */
export const umidPackageName = '@qoder-ai/qodercli'

/** The registry used when no override is supplied. */
export const umidDefaultRegistry = 'https://registry.npmjs.org'

/**
 * Size windows used to tell the component apart from the other embedded
 * binaries.
 *
 * The bundle embeds a dozen blobs: WebAssembly modules plus one native binary
 * per (platform, arch). Magic bytes say *what* a blob is; these windows say
 * *which* of the several same-format blobs is the component. They are
 * deliberately loose (the component is ~470KB today, the next PE in the same
 * archive is ~7MB) and are injectable so tests can use kilobyte fixtures
 * instead of megabyte ones.
 */
export interface UmidSizeHints {
  /** Smallest accepted size for the main executable, bytes. */
  fileMin: number
  /** Largest accepted size for the main executable, bytes. */
  fileMax: number
  /** Smallest accepted size for the companion DLL, bytes. */
  dllMin: number
}

/** Defaults for {@link UmidSizeHints}, measured against the published package. */
export const umidDefaultSizeHints: UmidSizeHints = {
  fileMin: 400 * 1024,
  fileMax: 2 * 1024 * 1024,
  dllMin: 2 * 1024 * 1024,
}

/** Largest tarball this module will accept, bytes. */
export const umidMaxTarballBytes = 64 * 1024 * 1024

/** Shortest base64 literal treated as an embedded binary, characters. */
export const umidMinBlobChars = 4000

/**
 * Product selector handed to the component as its only argument.
 *
 * Measured on an installed client: `3` mints the international identity and `0`
 * the China one. This installer exists for the international campaign, so `3`
 * is the identity the self-check must see — a component that answers for the
 * other product is not the install that was asked for.
 */
export const umidSelfCheckEnv = '3'

/** How long the post-install self-check may run before it is killed, ms. */
export const umidSelfCheckTimeoutMs = 25_000

/** How long any single registry request may take, ms. */
export const umidDownloadTimeoutMs = 30_000

/** Identifies this installer to the registry, as npm's own clients do. */
export const umidUserAgent = 'dsh-qoder-plugin/umid-installer'

/** Targets the published package carries a component for, for error messages. */
export const umidSupportedTargets: readonly string[] = [
  'win32-x64',
  'darwin-x64',
  'darwin-arm64',
  'linux-x64',
  'linux-arm64',
]

/** Where the tarball came from, recorded in the manifest for later diagnosis. */
export interface UmidManifestSource {
  kind: 'registry' | 'tarball'
  /** Package name, e.g. `@qoder-ai/qodercli`. */
  package: string
  /** Package version the tarball belongs to. */
  version: string
  /** The tarball's sha512, base64, as the registry publishes it. */
  tarballSha512?: string
  /** The tarball's size, bytes. */
  tarballBytes?: number
  /** Archive path of the bundle the blobs were found in. */
  entry?: string
  /** Indexes of the chosen blobs within that bundle, in discovery order. */
  blobIndexes?: readonly number[]
}

/** One file this module wrote. */
export interface UmidFileRecord {
  /** File name within the component directory. */
  name: string
  /** Size, bytes. */
  bytes: number
  /** sha256 of the bytes written, hex. */
  sha256: string
}

/** The post-install self-check result. */
export interface UmidSelfCheck {
  ok: boolean
  /** When the check ran, ISO 8601. */
  at?: string
  /**
   * First 8 hex characters of sha256(machineToken).
   *
   * Deliberately not the token: the manifest is a diagnostic artifact, and the
   * identity it proves must not be recoverable from it.
   */
  machineTokenSha256Prefix?: string
  /** Why the check failed, in the component's or the spawn's own words. */
  reason?: string
}

/** `manifest.json`, written next to the installed component. */
export interface UmidManifest {
  /** Schema version of this document. */
  schema: 1
  /** When the install completed, ISO 8601. */
  installedAt: string
  /** Platform the installed binaries target. */
  platform: string
  /** Architecture the installed binaries target. */
  arch: string
  /** Provenance of the tarball. */
  source: UmidManifestSource
  /** Files written, with sizes and digests. */
  files: readonly UmidFileRecord[]
  /** The self-check that gated the install. */
  selfCheck: UmidSelfCheck
}

/** Outcome of {@link installUmid}. */
export interface UmidInstallResult {
  ok: boolean
  /** True when a usable component was already present and `force` was unset. */
  skipped: boolean
  /** Version of the package the component came from. */
  version: string
  /** The component directory. */
  destDir: string
  /** Files present after a successful install. */
  files: readonly UmidFileRecord[]
  /** Provenance, when the install got far enough to know it. */
  source?: UmidManifestSource
  /** The self-check that gated the install. */
  selfCheck: UmidSelfCheck
  /** Why the install failed, for the user, already redacted. */
  error?: string
}

/** What one self-check process run produced. */
export interface UmidSelfCheckOutcome {
  /** Exit code, or `null` when the process never ran to completion. */
  code: number | null
  /** Everything the component printed on stdout, bounded. */
  stdout: string
  /** Set when the process could not be started, or was killed at the deadline. */
  spawnError?: string
}

/** Everything a self-check runner needs in order to run the component. */
export interface UmidSelfCheckRequest {
  /** Absolute path of the executable inside the staging directory. */
  binary: string
  /** Working directory for the child; the staging directory. */
  cwd: string
  /** Arguments; exactly the product selector, see {@link umidSelfCheckEnv}. */
  args: readonly string[]
  /** Deadline, ms. */
  timeoutMs: number
}

/**
 * Runs the component once.
 *
 * Injectable because the component is a native executable that only exists for
 * the target platform: a test on any other host could never run the real one,
 * and a test that quietly skipped the gate would stop proving that a bad
 * component is refused. The default implementation spawns the real binary.
 */
export type UmidSelfCheckRunner = (request: UmidSelfCheckRequest) => Promise<UmidSelfCheckOutcome>

/** Injection points; production passes nothing and gets the real ones. */
export interface UmidInstallOptions {
  /** Platform to install for; defaults to the running one. */
  platform?: NodeJS.Platform
  /** Architecture to install for; defaults to the running one. */
  arch?: string
  /** Component directory; defaults to {@link umidDir}. */
  destDir?: string
  /** Registry base URL; must be `https:`. Defaults to {@link umidDefaultRegistry}. */
  registry?: string
  /** Package name; defaults to {@link umidPackageName}. */
  packageName?: string
  /** Exact version; defaults to the registry's `dist-tags.latest`. */
  version?: string
  /** Local tarball to use instead of the registry (offline path). */
  tarballPath?: string
  /** Reinstall even when a usable component is present. */
  force?: boolean
  /** `fetch` replacement. */
  fetchImpl?: typeof fetch
  /** Environment to read overrides from; defaults to `process.env`. */
  env?: NodeJS.ProcessEnv
  /** Size windows; defaults to {@link umidDefaultSizeHints}. */
  sizeHints?: UmidSizeHints
  /** Shortest base64 literal that counts as a binary; defaults to {@link umidMinBlobChars}. */
  minBlobChars?: number
  /** Self-check runner; defaults to spawning the staged component. */
  selfCheck?: UmidSelfCheckRunner
  /** Aborts the install. */
  signal?: AbortSignal
  /** Progress sink; production passes the plugin logger. */
  logger?: { info(message: string): void; warn(message: string): void }
}

/**
 * The host-level component directory.
 *
 * Host level, not profile level, for the same reason the device seed is: two
 * profiles on one machine are one machine, and downloading the component twice
 * would be two copies of one fact. `QODER_UMID_DIR` overrides it and, when set,
 * is used alone — a test or a user who points this at a directory means that
 * directory, not "that directory, then fall back".
 */
export function umidDir(env: NodeJS.ProcessEnv = process.env, home: string = homedir()): string {
  const override = env['QODER_UMID_DIR']?.trim()
  if (override !== undefined && override.length > 0) return override
  return join(home, '.dsh', 'qoder', 'umid')
}

/** Name of the component executable on `platform`. */
export function umidBinaryName(platform: NodeJS.Platform = process.platform): string {
  return platform === 'win32' ? 'runtime-info.exe' : 'runtime-info'
}

/**
 * Companion library the Windows component needs next to it.
 *
 * `runtime-info.exe` links against it, so an executable without the DLL is not
 * a usable install; {@link umidInstalled} treats the pair as the unit.
 */
export const umidWindowsLibraryName = 'sgsdk.dll'

/** Absolute path of the component executable. */
export function umidBinaryPath(platform: NodeJS.Platform = process.platform, dir: string = umidDir()): string {
  return join(dir, umidBinaryName(platform))
}

/**
 * Whether a usable component is present in `dir`.
 *
 * On Windows both files must exist: an executable alone fails to load, and
 * reporting it as installed would turn a missing DLL into a confusing spawn
 * failure at check-in time instead of an install prompt.
 */
export function umidInstalled(dir: string = umidDir(), platform: NodeJS.Platform = process.platform): boolean {
  if (!existsSync(umidBinaryPath(platform, dir))) return false
  if (platform !== 'win32') return true
  return existsSync(join(dir, umidWindowsLibraryName))
}

/** Path of the manifest within a component directory. */
export function umidManifestPath(dir: string = umidDir()): string {
  return join(dir, 'manifest.json')
}

/**
 * Read the manifest, or `undefined` when there is none or it is unreadable.
 *
 * A corrupt manifest is not an error: the binaries are the install, the
 * manifest is a record of it.
 */
export function readUmidManifest(dir: string = umidDir()): UmidManifest | undefined {
  return readManifestFrom(umidManifestPath(dir))
}

/** Implementation of {@link readUmidManifest} over an explicit path. */
export function readManifestFrom(path: string): UmidManifest | undefined {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
    if (typeof parsed !== 'object' || parsed === null) return undefined
    const candidate = parsed as Partial<UmidManifest>
    if (candidate.schema !== 1) return undefined
    return candidate as UmidManifest
  } catch {
    return undefined
  }
}

// ---------------------------------------------------------------------------
// Binary identification
// ---------------------------------------------------------------------------

/**
 * What a decoded blob is, by magic bytes.
 *
 * The label is the join key between "what the archive contains" and "what this
 * platform needs"; nothing else in this module may decide that from the blob's
 * position in the bundle, because the upstream order is not part of any
 * contract and has already changed once.
 */
export type UmidBlobKind =
  | 'elf-x86_64'
  | 'elf-aarch64'
  | 'macho-x86_64'
  | 'macho-arm64'
  | 'pe-x86_64'
  | 'pe-aarch64'
  | 'wasm'
  | 'unknown'

const peDllCharacteristic = 0x2000

/**
 * Offset of the COFF header inside a PE image, or `undefined` when `data` is not
 * one.
 *
 * Every read is bounds-checked: the blobs come from a downloaded file, so a
 * short or lying header must answer "unknown", never throw.
 */
function peCoffOffset(data: Buffer): number | undefined {
  if (data.length < 0x40) return undefined
  const offset = data.readUInt32LE(0x3C)
  // `PE\0\0` plus a 20-byte COFF header, and 2 more for Characteristics.
  if (offset + 24 > data.length) return undefined
  if (data[offset] !== 0x50 || data[offset + 1] !== 0x45) return undefined
  if (data[offset + 2] !== 0x00 || data[offset + 3] !== 0x00) return undefined
  return offset
}

/** Identify a decoded blob by its magic bytes. */
export function identifyUmidBlob(data: Buffer): UmidBlobKind {
  if (data.length < 4) return 'unknown'
  if (data[0] === 0x00 && data[1] === 0x61 && data[2] === 0x73 && data[3] === 0x6D) return 'wasm'
  if (data[0] === 0x7F && data[1] === 0x45 && data[2] === 0x4C && data[3] === 0x46) {
    // EI_CLASS=2 (64-bit), EI_DATA=1 (little endian), e_machine at offset 18.
    if (data.length < 20 || data[4] !== 2 || data[5] !== 1) return 'unknown'
    const machine = data.readUInt16LE(18)
    if (machine === 0x3E) return 'elf-x86_64'
    if (machine === 0xB7) return 'elf-aarch64'
    return 'unknown'
  }
  if (data[0] === 0xCF && data[1] === 0xFA && data[2] === 0xED && data[3] === 0xFE) {
    // 64-bit little-endian Mach-O; cputype at offset 4.
    if (data.length < 8) return 'unknown'
    const cpu = data.readUInt32LE(4)
    if (cpu === 0x01000007) return 'macho-x86_64'
    if (cpu === 0x0100000C) return 'macho-arm64'
    return 'unknown'
  }
  if (data[0] === 0x4D && data[1] === 0x5A) {
    const offset = peCoffOffset(data)
    if (offset === undefined) return 'unknown'
    const machine = data.readUInt16LE(offset + 4)
    if (machine === 0x8664) return 'pe-x86_64'
    if (machine === 0xAA64) return 'pe-aarch64'
    return 'unknown'
  }
  return 'unknown'
}

/**
 * Whether a PE image carries `IMAGE_FILE_DLL`.
 *
 * The Windows pair is the one place where magic bytes are not enough: the
 * executable and its companion library are both x86-64 PE images, and the only
 * thing that tells them apart in the archive is this flag.
 */
export function isUmidPeDll(data: Buffer): boolean {
  const offset = peCoffOffset(data)
  if (offset === undefined) return false
  return (data.readUInt16LE(offset + 22) & peDllCharacteristic) !== 0
}

/** One long base64 literal found in the bundle, decoded and identified. */
export interface UmidBlobRecord {
  /** Position in the bundle, in discovery order. */
  index: number
  kind: UmidBlobKind
  /** Size of the decoded blob, bytes. */
  bytes: number
  /** Whether the blob is a PE DLL image. */
  isDll: boolean
  /**
   * The decoded bytes, kept only for native formats.
   *
   * WebAssembly blobs are the bulk of the bundle and are never selectable, so
   * they are identified and dropped: keeping them would triple peak memory for
   * bytes that cannot be written to disk.
   */
  data?: Buffer
}

/**
 * Which character codes are base64 alphabet, indexed by code point.
 *
 * A table rather than a regex character class because the scan below runs over
 * every byte of a ~31 MB bundle; `charCodeAt` plus one array read is the
 * cheapest test available without a dependency.
 */
const umidBase64Code = new Uint8Array(128)
for (let code = 0; code < 128; code += 1) {
  umidBase64Code[code] =
    code >= 0x30 && code <= 0x39 // 0-9
    || code >= 0x41 && code <= 0x5a // A-Z
    || code >= 0x61 && code <= 0x7a // a-z
    || code === 0x2b // +
    || code === 0x2f // /
    || code === 0x3d // =
      ? 1
      : 0
}

/**
 * Decode every long base64 literal in `text` and identify it.
 *
 * The indexes are the manifest's `blobIndexes` vocabulary, so a later diagnosis
 * can say "the archive changed shape at slot N" instead of "it broke".
 *
 * Hand-written single pass, NOT `/(['"])([A-Za-z0-9+/=]{4000,})\1/g`. That
 * pattern looks equivalent and is not: on the real bundle, whose base64
 * literals run to megabytes, the engine's backtracking stack overflowed
 * (`RangeError: Maximum call stack size exceeded`) and every network install
 * died there. The small in-memory fixtures used by the tests never reached that
 * size, which is exactly why this was found only against the real package.
 *
 * The loop is linear: a candidate run is measured once and `index` then jumps to
 * its end, so no byte is re-scanned. Advancing by one on a failed candidate
 * would make the scan quadratic on a bundle made of long unclosed runs.
 */
export function scanUmidBlobs(text: string, minChars: number = umidMinBlobChars): UmidBlobRecord[] {
  const records: UmidBlobRecord[] = []
  const threshold = Math.max(4, Math.floor(minChars))
  const length = text.length
  let index = 0
  while (index < length) {
    const quote = text.charCodeAt(index)
    // 0x22 `"` and 0x27 `'`: the bundle wraps its assets in one of the two.
    if (quote !== 0x22 && quote !== 0x27) {
      index += 1
      continue
    }
    // Measure the run of base64 characters that follows the opening quote.
    const start = index + 1
    let end = start
    while (end < length) {
      const code = text.charCodeAt(end)
      if (code >= 128 || umidBase64Code[code] !== 1) break
      end += 1
    }
    // A candidate is a literal only when the same quote closes it; `=` padding
    // means a run may legitimately end on a character that is also base64.
    if (end - start >= threshold && text.charCodeAt(end) === quote) {
      const data = Buffer.from(text.slice(start, end), 'base64')
      const kind = identifyUmidBlob(data)
      const isDll = kind === 'pe-x86_64' || kind === 'pe-aarch64' ? isUmidPeDll(data) : false
      const native = kind !== 'wasm' && kind !== 'unknown'
      records.push({
        index: records.length,
        kind,
        bytes: data.length,
        isDll,
        ...native ? { data } : {},
      })
    }
    // Jump past the measured run. A base64 run cannot contain a quote, so no
    // candidate can start inside it, and `end` is always > `index`.
    index = end
  }
  return records
}

// ---------------------------------------------------------------------------
// Candidate selection
// ---------------------------------------------------------------------------

interface UmidTarget {
  platform: NodeJS.Platform
  arch: 'x86_64' | 'arm64'
  /** Windows needs the executable and its companion library as a pair. */
  pair: boolean
}

/** The selected files, ready to be written. */
export interface UmidSelection {
  /** File name within the component directory, and the bytes to write. */
  files: readonly { name: string; data: Buffer }[]
  /** Indexes of the chosen blobs, in the order of {@link files}. */
  blobIndexes: readonly number[]
}

/** Either a selection or the reason the archive cannot serve this platform. */
export type UmidSelectionResult =
  | { ok: true; selection: UmidSelection }
  | { ok: false; error: string }

function normalizeUmidArch(arch: string): 'x86_64' | 'arm64' | undefined {
  const value = arch.trim().toLowerCase()
  if (value === 'x64' || value === 'x86_64' || value === 'amd64') return 'x86_64'
  if (value === 'arm64' || value === 'aarch64') return 'arm64'
  return undefined
}

function resolveUmidTarget(platform: NodeJS.Platform, arch: string): UmidTarget | undefined {
  const normalized = normalizeUmidArch(arch)
  if (normalized === undefined) return undefined
  if (platform === 'win32') return normalized === 'x86_64' ? { platform, arch: normalized, pair: true } : undefined
  if (platform === 'darwin' || platform === 'linux') return { platform, arch: normalized, pair: false }
  return undefined
}

/** The single-file blob kind `target` needs, or undefined for the Windows pair. */
function kindForTarget(target: UmidTarget): UmidBlobKind | undefined {
  if (target.pair) return undefined
  if (target.platform === 'linux') return target.arch === 'x86_64' ? 'elf-x86_64' : 'elf-aarch64'
  return target.arch === 'x86_64' ? 'macho-x86_64' : 'macho-arm64'
}

/**
 * The smallest candidate, breaking ties by the lower blob index.
 *
 * Smallest rather than largest because the component is the small binary in
 * this archive (the 7 MB PE is the DLL), and index order because a selection
 * that depends on the order of an untrusted file is not reproducible.
 */
function smallestBlob<T extends UmidBlobRecord>(candidates: readonly T[]): T | undefined {
  let best: T | undefined
  for (const candidate of candidates) {
    if (best === undefined || candidate.bytes < best.bytes) best = candidate
  }
  return best
}

/**
 * Pick the blobs this platform needs out of everything the bundle embeds.
 *
 * Magic bytes decide format and architecture; the size windows only separate
 * the component from other same-format blobs; the PE DLL flag separates the
 * Windows executable from its library. Nothing here may fall back to "the first
 * blob that looked close", because the failure mode of a wrong pick is a
 * component that installs and then cannot mint an identity — the silent
 * failure this whole milestone exists to remove.
 */
export function selectUmidBlobs(
  blobs: readonly UmidBlobRecord[],
  target: { platform: NodeJS.Platform; arch: string },
  hints: UmidSizeHints = umidDefaultSizeHints,
): UmidSelectionResult {
  const resolved = resolveUmidTarget(target.platform, target.arch)
  if (resolved === undefined) {
    return {
      ok: false,
      error: `unsupported-platform: ${target.platform}-${target.arch} has no published component; supported: ${umidSupportedTargets.join(', ')}`,
    }
  }
  const withData = blobs.filter((blob): blob is UmidBlobRecord & { data: Buffer } => blob.data !== undefined)

  if (resolved.pair) {
    const pe = withData.filter(blob => blob.kind === 'pe-x86_64')
    const exe = smallestBlob(pe.filter(blob => !blob.isDll && blob.bytes >= hints.fileMin && blob.bytes <= hints.fileMax))
    const dll = smallestBlob(pe.filter(blob => blob.isDll && blob.bytes >= hints.dllMin))
    if (exe === undefined || dll === undefined) {
      const missing = exe === undefined ? 'runtime-info.exe' : 'sgsdk.dll'
      return {
        ok: false,
        error: `the package does not contain a usable ${missing} for win32-x64 (${pe.length} PE x86-64 blob(s) found); the upstream package layout may have changed, please report an issue`,
      }
    }
    return {
      ok: true,
      selection: {
        files: [
          { name: umidBinaryName('win32'), data: exe.data },
          { name: umidWindowsLibraryName, data: dll.data },
        ],
        blobIndexes: [exe.index, dll.index],
      },
    }
  }

  const kind = kindForTarget(resolved)
  const hit = smallestBlob(withData.filter(blob => blob.kind === kind && blob.bytes >= hints.fileMin && blob.bytes <= hints.fileMax))
  if (hit === undefined) {
    return {
      ok: false,
      error: `the package does not contain a usable ${String(kind)} component for ${resolved.platform}-${resolved.arch}; the upstream package layout may have changed, please report an issue`,
    }
  }
  return {
    ok: true,
    selection: {
      files: [{ name: umidBinaryName(resolved.platform), data: hit.data }],
      blobIndexes: [hit.index],
    },
  }
}

// ---------------------------------------------------------------------------
// tar / gzip
// ---------------------------------------------------------------------------

const tarBlockBytes = 512

/** A FIFO of byte chunks with cheap front-draining. */
class UmidByteQueue {
  readonly #chunks: Buffer[] = []
  #offset = 0
  #length = 0

  get length(): number {
    return this.#length
  }

  push(chunk: Buffer): void {
    if (chunk.length === 0) return
    this.#chunks.push(chunk)
    this.#length += chunk.length
  }

  /** Copy exactly `count` bytes from the front, leaving them in place. */
  peek(count: number): Buffer {
    const first = this.#chunks[0]
    if (first === undefined || this.#length < count) throw new Error('umid: read past the end of the tar buffer')
    const available = first.length - this.#offset
    if (available >= count) return first.subarray(this.#offset, this.#offset + count)
    const out = Buffer.allocUnsafe(count)
    let written = 0
    for (const chunk of this.#chunks) {
      const start = chunk === first ? this.#offset : 0
      const take = Math.min(chunk.length - start, count - written)
      if (take > 0) {
        chunk.copy(out, written, start, start + take)
        written += take
      }
      if (written === count) break
    }
    return out
  }

  /** Remove up to `count` bytes, handing each slice to `sink`. Returns bytes removed. */
  drain(count: number, sink?: (chunk: Buffer) => void): number {
    let remaining = count
    while (remaining > 0) {
      const first = this.#chunks[0]
      if (first === undefined) break
      const available = first.length - this.#offset
      if (available === 0) {
        this.#chunks.shift()
        this.#offset = 0
        continue
      }
      const take = Math.min(available, remaining)
      if (sink !== undefined) sink(first.subarray(this.#offset, this.#offset + take))
      this.#offset += take
      this.#length -= take
      remaining -= take
      if (this.#offset === first.length) {
        this.#chunks.shift()
        this.#offset = 0
      }
    }
    return count - remaining
  }
}

/** What the scanner does with the entries it walks past. */
interface UmidTarFileHandler {
  /**
   * Called once per regular file, before its bytes arrive.
   *
   * Returning a sink keeps the bytes; returning `undefined` discards them, which
   * is what every entry except the bundle gets.
   */
  start(name: string, size: number): ((chunk: Buffer) => void) | undefined
}

function isZeroBlock(block: Buffer): boolean {
  for (const byte of block) {
    if (byte !== 0) return false
  }
  return true
}

function readTarString(block: Buffer, offset: number, length: number): string {
  const raw = block.subarray(offset, offset + length)
  const end = raw.indexOf(0)
  return (end < 0 ? raw : raw.subarray(0, end)).toString('utf8')
}

/**
 * Decode a tar size field.
 *
 * Plain 12-byte octal is what npm produces. GNU's base-256 form (high bit set)
 * is decoded rather than ignored: a size read as 0 would mis-parse every
 * following header, and the resulting failure would look like a corrupt
 * download instead of an unsupported archive.
 */
function readTarSize(block: Buffer): number {
  const raw = block.subarray(124, 136)
  if (((raw[0] ?? 0) & 0x80) !== 0) {
    let value = 0
    for (let index = 1; index < raw.length; index += 1) value = value * 256 + (raw[index] ?? 0)
    return value
  }
  const text = raw.toString('latin1').replace(/[\0 ]+$/u, '').trim()
  const size = Number.parseInt(text, 8)
  return Number.isFinite(size) && size >= 0 ? size : 0
}

function normalizeEntryName(name: string): string {
  let value = name
  while (value.startsWith('./')) value = value.slice(2)
  while (value.startsWith('/')) value = value.slice(1)
  return value
}

/**
 * A streaming ustar reader.
 *
 * Hand-written because this module is not allowed a dependency and `node:tar`
 * does not exist. It implements exactly the subset npm tarballs use: 512-byte
 * blocks, `ustar\0` magic, octal sizes, `'0'`/`'\0'` as regular files, and
 * every other typeflag's payload skipped. It never buffers more than one block
 * plus whatever the handler chooses to keep.
 */
class UmidTarScanner {
  readonly #queue = new UmidByteQueue()
  readonly #handler: UmidTarFileHandler
  #mode: 'header' | 'body' | 'pad' | 'done' = 'header'
  #bodyRemaining = 0
  #padRemaining = 0
  #zeroBlocks = 0
  #sink: ((chunk: Buffer) => void) | undefined

  constructor(handler: UmidTarFileHandler) {
    this.#handler = handler
  }

  feed(chunk: Buffer): void {
    this.#queue.push(chunk)
    this.#pump()
  }

  /**
   * Assert the archive ended on an entry boundary.
   *
   * A tar that stops mid-file is truncated, and accepting the entries read so
   * far would install a component assembled from a partial download.
   */
  finish(): void {
    if (this.#mode === 'body' || this.#mode === 'pad') {
      throw new Error('the tarball ended in the middle of a file entry')
    }
  }

  #pump(): void {
    for (;;) {
      if (this.#mode === 'done') return
      if (this.#mode === 'body') {
        if (this.#bodyRemaining === 0) {
          this.#mode = 'pad'
          this.#sink = undefined
          continue
        }
        if (this.#queue.length === 0) return
        this.#bodyRemaining -= this.#queue.drain(Math.min(this.#bodyRemaining, this.#queue.length), this.#sink)
        continue
      }
      if (this.#mode === 'pad') {
        if (this.#padRemaining === 0) {
          this.#mode = 'header'
          continue
        }
        if (this.#queue.length === 0) return
        this.#padRemaining -= this.#queue.drain(Math.min(this.#padRemaining, this.#queue.length))
        continue
      }
      if (this.#queue.length < tarBlockBytes) return
      const block = this.#queue.peek(tarBlockBytes)
      this.#queue.drain(tarBlockBytes)
      if (isZeroBlock(block)) {
        this.#zeroBlocks += 1
        // Two zero blocks end the archive; one is just the first half of the
        // terminator arriving in its own chunk.
        if (this.#zeroBlocks >= 2) {
          this.#mode = 'done'
          return
        }
        continue
      }
      this.#zeroBlocks = 0
      const name = normalizeEntryName(
        (() => {
          const base = readTarString(block, 0, 100)
          const prefix = readTarString(block, 345, 155)
          return prefix === '' ? base : `${prefix}/${base}`
        })(),
      )
      const size = readTarSize(block)
      const typeflag = block[156] ?? 0
      // '0' and '\0' are regular files. '5' (directory), '2' (symlink),
      // 'x'/'g' (pax) and 'L' (GNU long name) carry no bytes we can use.
      const isFile = typeflag === 0x30 || typeflag === 0x00
      this.#sink = isFile ? this.#handler.start(name, size) : undefined
      this.#bodyRemaining = size
      this.#padRemaining = (tarBlockBytes - (size % tarBlockBytes)) % tarBlockBytes
      this.#mode = 'body'
    }
  }
}

/** One entry kept from the archive. */
interface UmidCollectedEntry {
  name: string
  bytes: number
  chunks: Buffer[]
}

/**
 * Keeps the bundle and the package manifest, drops everything else.
 *
 * The archive is ~31 MB of mostly-irrelevant files; only the one `.mjs` bundle
 * that embeds the binaries is needed, plus the tiny `package.json` that names
 * the version for an offline install (where there is no packument to ask).
 */
class UmidTarCollector implements UmidTarFileHandler {
  readonly #entries: UmidCollectedEntry[] = []
  #keptBytes = 0

  get entries(): readonly UmidCollectedEntry[] {
    return this.#entries
  }

  start(name: string, size: number): ((chunk: Buffer) => void) | undefined {
    const isBundle = name.toLowerCase().endsWith('.mjs')
    const isPackageJson = name === 'package/package.json'
    if (!isBundle && !isPackageJson) return undefined
    // One entry may not exceed the whole-tarball ceiling, and neither may all
    // kept entries together: the point of streaming is a bounded footprint.
    if (size > umidMaxTarballBytes || this.#keptBytes + size > umidMaxTarballBytes) return undefined
    this.#keptBytes += size
    const entry: UmidCollectedEntry = { name, bytes: 0, chunks: [] }
    this.#entries.push(entry)
    return (chunk: Buffer) => {
      entry.chunks.push(chunk)
      entry.bytes += chunk.length
    }
  }
}

/** Everything the streaming pass learned about a tarball. */
interface UmidHarvest {
  tarballBytes: number
  /** sha512 of the compressed tarball, base64 — the same form npm publishes. */
  tarballSha512: string
  entries: readonly UmidCollectedEntry[]
}

/**
 * Gunzip and tar-scan one compressed stream, hashing it on the way through.
 *
 * The compressed bytes are hashed as they arrive rather than after the fact,
 * because the whole tarball is never held in memory. The consequence is that an
 * integrity failure is discovered after the archive was decompressed, not
 * before — acceptable, since nothing is written to disk until verification has
 * passed, and cheaper than buffering 31 MB to re-read it.
 */
async function harvestTarball(chunks: AsyncIterable<Buffer>): Promise<UmidHarvest> {
  const hash = createHash('sha512')
  let total = 0
  const sized = (async function* (): AsyncGenerator<Buffer> {
    for await (const chunk of chunks) {
      total += chunk.length
      if (total > umidMaxTarballBytes) {
        throw new Error(`the tarball is larger than ${formatBytes(umidMaxTarballBytes)}; refusing to continue`)
      }
      hash.update(chunk)
      yield chunk
    }
  })()

  const collector = new UmidTarCollector()
  const scanner = new UmidTarScanner(collector)
  const gunzip = createGunzip()
  const scan = (async (): Promise<void> => {
    for await (const chunk of gunzip) scanner.feed(chunk as Buffer)
  })()
  // Mark the scan as handled immediately: if it rejects while the write loop is
  // still running, the rejection must not surface as unhandled.
  void scan.catch(() => undefined)
  try {
    for await (const chunk of sized) {
      if (!gunzip.write(chunk)) await once(gunzip, 'drain')
    }
    gunzip.end()
    await scan
  } catch (error: unknown) {
    gunzip.destroy()
    throw error
  }
  scanner.finish()
  return { tarballBytes: total, tarballSha512: hash.digest('base64'), entries: collector.entries }
}

// ---------------------------------------------------------------------------
// Sources
// ---------------------------------------------------------------------------

function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KiB`
  return `${Math.round(bytes / (1024 * 1024))} MiB`
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  return value as Record<string, unknown>
}

function asNonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

/** Redact anything token-shaped before a message reaches a user or a log. */
function redactUmidMessage(text: string): string {
  return text
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/gu, '[redacted token]')
    .replace(/(\b(?:code|token|pat)=)[^&\s]+/giu, '$1[redacted]')
    .replace(/\bpt-[A-Za-z0-9_-]{8,}\b/gu, '[redacted token]')
}

function umidErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return redactUmidMessage(message).slice(0, 500)
}

/** Parse a URL that must be `https:`. */
function requireHttpsUrl(raw: string, what: string): URL {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new Error(`${what} is not a URL: ${raw}`)
  }
  if (url.protocol !== 'https:') throw new Error(`${what} must use https:, not ${url.protocol}`)
  return url
}

/**
 * One registry request, bounded by a deadline and by the caller's abort signal.
 *
 * The deadline covers the body read as well as the headers: a registry that
 * answers and then stalls would otherwise hold the install open forever.
 */
async function requestWithDeadline(
  fetchImpl: typeof fetch,
  url: string,
  signal: AbortSignal | undefined,
  accept: string,
): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => {
    controller.abort(new Error(`the request to ${new URL(url).host} timed out after ${Math.round(umidDownloadTimeoutMs / 1000)}s`))
  }, umidDownloadTimeoutMs)
  const combined = signal === undefined ? controller.signal : AbortSignal.any([controller.signal, signal])
  try {
    return await fetchImpl(url, {
      signal: combined,
      redirect: 'follow',
      headers: { 'user-agent': umidUserAgent, accept },
    })
  } finally {
    // The body may still be streaming; the caller owns the timer from here on.
    clearTimeout(timer)
  }
}

/** The tarball location and expected digest a registry packument advertises. */
interface UmidRegistryDist {
  version: string
  tarballUrl: string
  integrity: string | undefined
}

async function resolveRegistryDist(options: {
  registry: URL
  packageName: string
  version: string | undefined
  fetchImpl: typeof fetch
  signal: AbortSignal | undefined
}): Promise<UmidRegistryDist> {
  const base = options.registry.href.replace(/\/+$/u, '')
  // The conventional scoped form; registry.npmjs.org serves it unencoded.
  const packumentUrl = `${base}/${options.packageName}`
  const response = await requestWithDeadline(options.fetchImpl, packumentUrl, options.signal, 'application/json')
  if (!response.ok) throw new Error(`the registry answered ${response.status} for ${options.packageName}`)
  const parsed: unknown = await response.json()
  const packument = asRecord(parsed)
  if (packument === undefined) throw new Error('the registry answered with something that is not a packument')

  const version = options.version ?? asNonEmptyString(asRecord(packument['dist-tags'])?.['latest'])
  if (version === undefined) {
    throw new Error('the registry did not report dist-tags.latest; pass --version to choose one')
  }
  const dist = asRecord(asRecord(asRecord(packument['versions'])?.[version])?.['dist'])
  if (dist === undefined) throw new Error(`the registry has no version ${version} of ${options.packageName}`)
  const tarballUrl = asNonEmptyString(dist['tarball'])
  if (tarballUrl === undefined) throw new Error(`version ${version} advertises no dist.tarball`)
  return { version, tarballUrl, integrity: asNonEmptyString(dist['integrity']) }
}

/** Stream the registry tarball, refusing anything that leaves the registry's host. */
async function* registryTarballChunks(request: {
  url: URL
  registryHost: string
  fetchImpl: typeof fetch
  signal: AbortSignal | undefined
}): AsyncGenerator<Buffer> {
  const response = await requestWithDeadline(request.fetchImpl, request.url.href, request.signal, 'application/octet-stream')
  if (!response.ok) throw new Error(`the registry answered ${response.status} for the tarball`)
  // A redirect that changes host would let a compromised or misconfigured
  // registry hand us bytes that the advertised integrity no longer covers.
  const finalUrl = response.url
  if (finalUrl === '') throw new Error('the tarball response did not report a final URL; refusing to trust it')
  let final: URL
  try {
    final = new URL(finalUrl)
  } catch {
    throw new Error('the tarball response reported an unparseable final URL')
  }
  if (final.protocol !== 'https:') throw new Error(`the tarball was served over ${final.protocol}, not https:`)
  if (final.host !== request.registryHost) {
    throw new Error(`the tarball was served from ${final.host}, not the registry host ${request.registryHost}`)
  }
  const body = response.body
  if (body === null) throw new Error('the tarball response had no body')
  const reader = body.getReader()
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    if (value !== undefined) yield Buffer.from(value)
  }
}

/** Stream a tarball the user already has on disk. */
async function* fileTarballChunks(path: string): AsyncGenerator<Buffer> {
  const stream = createReadStream(path)
  try {
    for await (const chunk of stream) yield chunk as Buffer
  } catch (error: unknown) {
    throw new Error(`cannot read the tarball at ${path}: ${umidErrorMessage(error)}`)
  }
}

/** Compare a computed sha512 against an npm `integrity` string. */
function integrityMatches(integrity: string, digestBase64: string): boolean | undefined {
  const separator = integrity.indexOf('-')
  if (separator <= 0) return undefined
  const algorithm = integrity.slice(0, separator).trim().toLowerCase()
  const expected = integrity.slice(separator + 1).trim()
  if (algorithm !== 'sha512' || expected === '') return undefined
  return expected === digestBase64
}

/** Read `package/package.json` out of the archive, for offline version reporting. */
function versionFromCollected(entries: readonly UmidCollectedEntry[]): string | undefined {
  const entry = entries.find(candidate => candidate.name === 'package/package.json')
  if (entry === undefined) return undefined
  try {
    const parsed: unknown = JSON.parse(Buffer.concat(entry.chunks).toString('utf8'))
    return asNonEmptyString(asRecord(parsed)?.['version'])
  } catch {
    return undefined
  }
}

// ---------------------------------------------------------------------------
// Self-check
// ---------------------------------------------------------------------------

/**
 * Run the component once and collect its first JSON line.
 *
 * The child is given the staging directory as its working directory because a
 * component that resolves its companion library relative to the CWD would
 * otherwise fail here and succeed nowhere.
 */
async function runSelfCheckProcess(request: UmidSelfCheckRequest): Promise<UmidSelfCheckOutcome> {
  return await new Promise<UmidSelfCheckOutcome>(resolve => {
    let stdout = ''
    let stderr = ''
    let settled = false
    const child = spawn(request.binary, [...request.args], {
      cwd: request.cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
    const finish = (outcome: UmidSelfCheckOutcome): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (child.exitCode === null) child.kill()
      resolve(outcome)
    }
    const timer = setTimeout(() => {
      finish({ code: null, stdout, spawnError: `the component did not answer within ${Math.round(request.timeoutMs / 1000)}s` })
    }, request.timeoutMs)
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8')
      // A component that floods stdout is malfunctioning, not authoritative.
      if (stdout.length > 1024 * 1024) finish({ code: null, stdout, spawnError: 'the component flooded stdout' })
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      if (stderr.length < 64 * 1024) stderr += chunk.toString('utf8')
    })
    child.once('error', (error: Error) => finish({ code: null, stdout, spawnError: `cannot run the component: ${error.message}` }))
    child.once('close', (code: number | null) => {
      const detail = stderr.trim()
      finish({
        code,
        stdout,
        ...detail === '' ? {} : { spawnError: `the component exited ${String(code)}: ${detail.slice(0, 200)}` },
      })
    })
  })
}

/** Decide whether the component answered with a usable identity. */
function judgeSelfCheck(outcome: UmidSelfCheckOutcome): { ok: true; machineToken: string } | { ok: false; reason: string } {
  if (outcome.spawnError !== undefined) return { ok: false, reason: redactUmidMessage(outcome.spawnError) }
  const firstLine = outcome.stdout.split('\n')[0] ?? ''
  if (firstLine.trim() === '') {
    return { ok: false, reason: `the component printed nothing (exit code ${String(outcome.code)})` }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(firstLine)
  } catch {
    return { ok: false, reason: 'the component did not print a JSON line on stdout' }
  }
  const token = asNonEmptyString(asRecord(parsed)?.['machineToken'])
  if (token === undefined) return { ok: false, reason: 'the component reported no machineToken' }
  return { ok: true, machineToken: token }
}

// ---------------------------------------------------------------------------
// Files
// ---------------------------------------------------------------------------

/**
 * Remove leftover `.staging-*` directories.
 *
 * A crash or a kill during an install leaves one behind, and a stale staging
 * directory that is never cleaned would slowly accumulate copies of the
 * component. Installs are single-flight by construction (the route runs one
 * background job, and the CLI is a human action), so a staging directory found
 * here is always abandoned.
 */
function removeStagingLeftovers(destDir: string): void {
  let entries: Dirent[]
  try {
    entries = readdirSync(destDir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    if (!entry.name.startsWith('.staging-')) continue
    try {
      rmSync(join(destDir, entry.name), { recursive: true, force: true })
    } catch {
      // A leftover we cannot remove must not fail the install that follows.
    }
  }
}

function writeStagedFile(path: string, bytes: Buffer, platform: NodeJS.Platform): void {
  // 0755 on POSIX: the component is executed. On Windows the mode is ignored
  // and the ACLs inherited from the component directory apply.
  writeFileSync(path, bytes, { mode: platform === 'win32' ? 0o644 : 0o755 })
  if (platform !== 'win32') chmodSync(path, 0o755)
}

/**
 * Write `manifest.json` at mode 0600.
 *
 * The manifest names the tarball, its digest and the chosen blob indexes; on a
 * shared machine that is a record of what the user installed, not something
 * every local account needs to read.
 */
function writeUmidManifest(destDir: string, manifest: UmidManifest): void {
  const path = umidManifestPath(destDir)
  const temporary = `${path}.tmp`
  writeFileSync(temporary, `${JSON.stringify(manifest, undefined, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
  if (process.platform !== 'win32') chmodSync(temporary, 0o600)
  renameSync(temporary, path)
}

function sha256Hex(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex')
}

// ---------------------------------------------------------------------------
// Install
// ---------------------------------------------------------------------------

/** Build a failed result, keeping the optional fields truly absent. */
function failure(
  destDir: string,
  error: string,
  extra: { version?: string; source?: UmidManifestSource; selfCheck?: UmidSelfCheck } = {},
): UmidInstallResult {
  return {
    ok: false,
    skipped: false,
    version: extra.version ?? '',
    destDir,
    files: [],
    selfCheck: extra.selfCheck ?? { ok: false, reason: error },
    error,
    ...extra.source === undefined ? {} : { source: extra.source },
  }
}

/**
 * Install the component.
 *
 * Implemented by the extraction pipeline; see `docs/spec-native-device-identity.md`
 * (SPEC-UMID-003) §6.1 for the required step order. Nothing is downloaded
 * unless this is called explicitly — the check-in path never reaches here.
 *
 * Ordering note: the "already installed" short-circuit runs before the registry
 * is contacted, although the spec numbers it after the packument fetch. A
 * machine that already has a working component must not make a network request
 * to find that out, and T-M1-5 asserts exactly that.
 */
export async function installUmid(options: UmidInstallOptions = {}): Promise<UmidInstallResult> {
  const env = options.env ?? process.env
  const platform = options.platform ?? process.platform
  const arch = options.arch ?? process.arch
  const destDir = options.destDir ?? umidDir(env, undefined)
  const hints = options.sizeHints ?? umidDefaultSizeHints
  const minBlobChars = options.minBlobChars ?? umidMinBlobChars
  const packageName = options.packageName ?? umidPackageName
  const logger = options.logger
  const signal = options.signal

  // Step 0: a previous crash must not leave a half-written staging directory
  // behind for this install to trip over.
  removeStagingLeftovers(destDir)

  // A platform with no published component fails here, before any network work:
  // there is nothing to download, and the user needs the message immediately.
  const target = resolveUmidTarget(platform, arch)
  if (target === undefined) {
    return failure(
      destDir,
      `unsupported-platform: ${platform}-${arch} has no published component; supported: ${umidSupportedTargets.join(', ')}`,
    )
  }

  if (options.force !== true && umidInstalled(destDir, platform)) {
    const manifest = readUmidManifest(destDir)
    return {
      ok: true,
      skipped: true,
      version: manifest?.source.version ?? '',
      destDir,
      files: manifest?.files ?? [],
      selfCheck: manifest?.selfCheck ?? { ok: false, reason: 'installed before this manifest schema' },
      ...manifest?.source === undefined ? {} : { source: manifest.source },
    }
  }

  if (signal?.aborted === true) return failure(destDir, 'the install was cancelled')

  // Source resolution. The offline tarball wins outright: it is the only path
  // that works on a machine whose registry is unreachable, and a user who names
  // a file means that file.
  const tarballPath = options.tarballPath ?? asNonEmptyString(env['QODER_UMID_TARBALL'])
  const registryRaw = options.registry ?? asNonEmptyString(env['QODER_UMID_REGISTRY']) ?? umidDefaultRegistry

  let harvest: UmidHarvest
  let version: string
  let source: UmidManifestSource
  try {
    if (tarballPath !== undefined) {
      logger?.info(`umid: reading the offline tarball ${tarballPath}`)
      harvest = await harvestTarball(fileTarballChunks(tarballPath))
      version = options.version ?? versionFromCollected(harvest.entries) ?? 'unknown'
      source = {
        kind: 'tarball',
        package: packageName,
        version,
        tarballSha512: harvest.tarballSha512,
        tarballBytes: harvest.tarballBytes,
      }
    } else {
      const registry = requireHttpsUrl(registryRaw, 'the registry URL')
      logger?.info(`umid: asking ${registry.host} for ${packageName}`)
      const dist = await resolveRegistryDist({
        registry,
        packageName,
        version: options.version,
        fetchImpl: options.fetchImpl ?? fetch,
        signal,
      })
      version = dist.version
      const tarballUrl = requireHttpsUrl(dist.tarballUrl, 'dist.tarball')
      if (tarballUrl.host !== registry.host) {
        throw new Error(`dist.tarball points at ${tarballUrl.host}, not the registry host ${registry.host}`)
      }
      logger?.info(`umid: downloading ${packageName}@${version}`)
      harvest = await harvestTarball(registryTarballChunks({
        url: tarballUrl,
        registryHost: registry.host,
        fetchImpl: options.fetchImpl ?? fetch,
        signal,
      }))
      if (dist.integrity !== undefined) {
        const matched = integrityMatches(dist.integrity, harvest.tarballSha512)
        if (matched === false) {
          // Nothing has been written yet, so this is the whole cost of a
          // tampered or corrupted download.
          return failure(destDir, 'sha512 mismatch: the tarball does not match the registry integrity; nothing was written', { version })
        }
        if (matched === undefined) logger?.warn('umid: the registry published no usable sha512 integrity; the tarball was not verified')
      }
      source = {
        kind: 'registry',
        package: packageName,
        version,
        tarballSha512: harvest.tarballSha512,
        tarballBytes: harvest.tarballBytes,
      }
    }
  } catch (error: unknown) {
    return failure(destDir, umidErrorMessage(error))
  }

  // Scan the bundle(s) the archive carried. The bundle is decoded as latin1:
  // it is ASCII base64 literals plus JavaScript, so a lossy UTF-8 decode could
  // only mangle bytes that the regex does not match anyway.
  const bundles = harvest.entries.filter(entry => entry.name.toLowerCase().endsWith('.mjs'))
  let blobs: UmidBlobRecord[] = []
  let entryName: string | undefined
  for (const bundle of bundles) {
    const scanned = scanUmidBlobs(Buffer.concat(bundle.chunks).toString('latin1'), minBlobChars)
    const hasNative = scanned.some(blob => blob.kind !== 'wasm' && blob.kind !== 'unknown')
    if (hasNative) {
      blobs = scanned
      entryName = bundle.name
      break
    }
  }
  if (entryName === undefined) {
    return failure(
      destDir,
      'the package contains no .mjs bundle with embedded native binaries; the upstream package layout may have changed, please report an issue',
      { version },
    )
  }
  logger?.info(`umid: ${blobs.length} embedded blob(s) in ${entryName}`)

  const selection = selectUmidBlobs(blobs, { platform, arch }, hints)
  if (!selection.ok) return failure(destDir, selection.error, { version })
  const sourceWithBlobs: UmidManifestSource = { ...source, entry: entryName, blobIndexes: selection.selection.blobIndexes }

  // Step 9: everything from here on happens inside the staging directory, so a
  // failure can be undone by deleting one directory.
  const stagingDir = join(destDir, `.staging-${randomUUID().slice(0, 8)}`)
  try {
    mkdirSync(stagingDir, { recursive: true })
    for (const file of selection.selection.files) writeStagedFile(join(stagingDir, file.name), file.data, platform)

    // Step 10: a component that cannot mint an identity is not an install.
    const runner = options.selfCheck ?? runSelfCheckProcess
    const outcome = await runner({
      binary: join(stagingDir, umidBinaryName(platform)),
      cwd: stagingDir,
      args: [umidSelfCheckEnv],
      timeoutMs: umidSelfCheckTimeoutMs,
    })
    const judged = judgeSelfCheck(outcome)
    if (!judged.ok) {
      return failure(destDir, `self-check failed: ${judged.reason}`, { version, source: sourceWithBlobs })
    }
    const selfCheck: UmidSelfCheck = {
      ok: true,
      at: new Date().toISOString(),
      // Only the prefix: the manifest is a diagnostic, not a copy of the secret.
      machineTokenSha256Prefix: sha256Hex(Buffer.from(judged.machineToken, 'utf8')).slice(0, 8),
    }

    // Step 11: promote file by file. Renaming into place means a reader never
    // observes a half-written executable, and the previous files stay intact
    // until the replacements are ready.
    const files: UmidFileRecord[] = []
    for (const file of selection.selection.files) {
      renameSync(join(stagingDir, file.name), join(destDir, file.name))
      files.push({ name: file.name, bytes: file.data.length, sha256: sha256Hex(file.data) })
    }
    const manifest: UmidManifest = {
      schema: 1,
      installedAt: new Date().toISOString(),
      platform,
      arch,
      source: sourceWithBlobs,
      files,
      selfCheck,
    }
    writeUmidManifest(destDir, manifest)
    return {
      ok: true,
      skipped: false,
      version,
      destDir,
      files,
      source: sourceWithBlobs,
      selfCheck,
    }
  } catch (error: unknown) {
    return failure(destDir, umidErrorMessage(error), { version, source: sourceWithBlobs })
  } finally {
    // Step 12, and the failure path too: staging never survives an attempt.
    try {
      rmSync(stagingDir, { recursive: true, force: true })
    } catch {
      // Nothing else can be done about a directory we cannot remove.
    }
  }
}
