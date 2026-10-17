import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  clearHostHeartbeat,
  isHeartbeatProcessAlive,
  processStartTimeMs,
  qoderHostHeartbeatPath,
  QODER_HOST_HEARTBEAT_FILENAME,
  readHostHeartbeat,
  writeHostHeartbeat,
  type QoderHostHeartbeat,
} from '../src/host-heartbeat.ts'
import { QODER_DATA_DIR_ENV } from '../src/paths.ts'
import { QODER_CONNECT_VERSION } from '../src/version.ts'

/**
 * The host heartbeat lives inside the plugin's *state* subdirectory
 * (`<DSH_QODER_DATA_DIR>/state/.qoder-host-heartbeat.json`): `writeHostHeartbeat`
 * is documented best-effort and creates nothing itself — the state stores
 * (probe/catalog) own the directory. The cases below stub `DSH_QODER_DATA_DIR`
 * so nothing ever touches a real profile.
 */

let root: string | undefined

afterEach(async () => {
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
  vi.unstubAllEnvs()
})

/** A temporary data dir with the state subdirectory the runtime creates. */
async function tempStateRoot(): Promise<string> {
  root = await mkdtemp(join(tmpdir(), 'qoder-heartbeat-'))
  vi.stubEnv(QODER_DATA_DIR_ENV, root)
  await mkdir(join(root, 'state'), { recursive: true })
  return root
}

describe('host heartbeat', () => {
  it('writes, reads, and clears a heartbeat under the state directory', async () => {
    const dir = await tempStateRoot()

    // Before write: absent.
    expect(await readHostHeartbeat()).toBeUndefined()

    await writeHostHeartbeat()

    // After write: present and well-formed.
    const heartbeat = await readHostHeartbeat()
    expect(heartbeat).toBeDefined()
    expect(heartbeat!.package).toBe('dsh-qoder-plugin')
    expect(heartbeat!.version).toBe(1)
    expect(heartbeat!.pid).toBe(process.pid)
    expect(typeof heartbeat!.registeredAt).toBe('number')
    expect(heartbeat!.pluginVersion).toBe(QODER_CONNECT_VERSION)

    // The file lives at the expected path: the data dir's `state/` subfolder.
    expect(qoderHostHeartbeatPath()).toBe(join(dir, 'state', QODER_HOST_HEARTBEAT_FILENAME))

    // Live PID is detectable.
    expect(isHeartbeatProcessAlive(heartbeat!)).toBe(true)

    // A fake PID that cannot exist is detected as dead.
    const fakeHeartbeat = { ...heartbeat!, pid: 999_999 }
    expect(isHeartbeatProcessAlive(fakeHeartbeat)).toBe(false)

    // Clear removes the file.
    await clearHostHeartbeat()
    expect(await readHostHeartbeat()).toBeUndefined()
  })

  it('writes the documented v1 document verbatim', async () => {
    const dir = await tempStateRoot()
    const before = Date.now()
    await writeHostHeartbeat()
    const raw = JSON.parse(
      await import('node:fs/promises').then(fs => fs.readFile(join(dir, 'state', QODER_HOST_HEARTBEAT_FILENAME), 'utf8')),
    ) as Record<string, unknown>
    expect(raw).toMatchObject({
      version: 1,
      package: 'dsh-qoder-plugin',
      pluginVersion: QODER_CONNECT_VERSION,
      pid: process.pid,
    })
    expect(typeof raw.registeredAt).toBe('number')
    expect(raw.registeredAt as number).toBeGreaterThanOrEqual(before)
  })

  it('a write with the state directory missing creates it and lands the file', async () => {
    // `writeHostHeartbeat` is non-fatal by contract (it never throws), and it
    // owns creating the state/ directory: a host that registers before the
    // catalog/probe stores first touch the dir must still leave a readable
    // heartbeat rather than silently dropping the file.
    root = await mkdtemp(join(tmpdir(), 'qoder-heartbeat-nodir-'))
    vi.stubEnv(QODER_DATA_DIR_ENV, root)
    await expect(writeHostHeartbeat()).resolves.toBeUndefined()
    const heartbeat = await readHostHeartbeat()
    expect(heartbeat).toBeDefined()
    expect(heartbeat?.package).toBe('dsh-qoder-plugin')
  })

  it('detects a recycled PID as dead when the process start time is readable', async () => {
    // If a stale heartbeat claims a `registeredAt` *older* than this process's
    // own start time, the PID cannot be the original host — it has been
    // recycled by an unrelated process. Even though `kill(pid, 0)` says the
    // PID is alive, the age check must report dead.
    const startAtMs = processStartTimeMs(process.pid)
    const recycled: QoderHostHeartbeat = {
      version: 1,
      package: 'dsh-qoder-plugin',
      pluginVersion: '0.0.0-test',
      // 1 min before this process started (the recycled-PID case).
      registeredAt: (startAtMs ?? Date.now()) - 60_000,
      pid: process.pid,
    }
    if (startAtMs === undefined) {
      // Documented degradation: platforms (or restricted environments) whose
      // process start time cannot be read fall back to plain PID liveness.
      expect(isHeartbeatProcessAlive(recycled)).toBe(true)
    } else {
      expect(isHeartbeatProcessAlive(recycled)).toBe(false)
    }

    // A heartbeat registered *after* this process started (a genuine host on
    // this very PID) is alive either way.
    const genuine: QoderHostHeartbeat = { ...recycled, registeredAt: Date.now() }
    expect(isHeartbeatProcessAlive(genuine)).toBe(true)
  })

  it('treats a malformed heartbeat file as absent', async () => {
    const dir = await tempStateRoot()
    const { writeFile: write } = await import('node:fs/promises')
    await write(join(dir, 'state', QODER_HOST_HEARTBEAT_FILENAME), '{ not json', 'utf8')
    expect(await readHostHeartbeat()).toBeUndefined()
  })

  it('rejects a heartbeat with the wrong format version', async () => {
    const dir = await tempStateRoot()
    await writeFile(
      join(dir, 'state', QODER_HOST_HEARTBEAT_FILENAME),
      JSON.stringify({ version: 99, package: 'dsh-qoder-plugin', registeredAt: Date.now(), pid: process.pid }),
      'utf8',
    )
    expect(await readHostHeartbeat()).toBeUndefined()
  })

  it('rejects a WorkBuddy-era heartbeat (wrong package name)', async () => {
    // The old plugin's file — same directory, same format version — must read
    // as absent rather than be adopted by the Qoder reader.
    const dir = await tempStateRoot()
    await writeFile(
      join(dir, 'state', QODER_HOST_HEARTBEAT_FILENAME),
      JSON.stringify({ version: 1, package: 'dsh-workbuddy-connect', registeredAt: Date.now(), pid: process.pid }),
      'utf8',
    )
    expect(await readHostHeartbeat()).toBeUndefined()
  })

  it('reads a missing pluginVersion as the honest "unknown"', async () => {
    const dir = await tempStateRoot()
    await writeFile(
      join(dir, 'state', QODER_HOST_HEARTBEAT_FILENAME),
      JSON.stringify({ version: 1, package: 'dsh-qoder-plugin', registeredAt: 5, pid: process.pid }),
      'utf8',
    )
    const heartbeat = await readHostHeartbeat()
    expect(heartbeat).toEqual({
      version: 1,
      package: 'dsh-qoder-plugin',
      pluginVersion: 'unknown',
      registeredAt: 5,
      pid: process.pid,
    })
  })
})
