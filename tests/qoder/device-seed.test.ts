import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readDeviceSeed, rotateDeviceSeed } from '../../src/qoder/transport/device-seed.ts'

function scratch(): { dir: string; path: string; done: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'qoder-seed-'))
  return {
    dir,
    path: join(dir, 'nested', 'device_seed'),
    done: () => { rmSync(dir, { recursive: true, force: true }) },
  }
}

test('readDeviceSeed answers undefined when nothing was ever rotated', () => {
  const { path, done } = scratch()
  try {
    // The normal state of every install: no seed, so identities stay derived
    // from the account alone and an upgrade cannot move anyone.
    assert.equal(readDeviceSeed(path), undefined)
  } finally {
    done()
  }
})

test('readDeviceSeed answers undefined for an empty or whitespace-only file', () => {
  const { dir, path, done } = scratch()
  try {
    mkdirSync(join(dir, 'nested'), { recursive: true })
    writeFileSync(path, '', 'utf8')
    assert.equal(readDeviceSeed(path), undefined)
    writeFileSync(path, '   \n', 'utf8')
    assert.equal(readDeviceSeed(path), undefined)
  } finally {
    done()
  }
})

test('readDeviceSeed answers undefined for a directory instead of throwing', () => {
  const { dir, path, done } = scratch()
  try {
    // A read that fails must read as "no seed": the caller derives identities on
    // a request path and cannot handle an exception here.
    mkdirSync(path, { recursive: true })
    assert.equal(readDeviceSeed(path), undefined)
    assert.ok(dir.length > 0)
  } finally {
    done()
  }
})

test('rotateDeviceSeed writes a fresh 32-hex seed that readDeviceSeed then returns', () => {
  const { path, done } = scratch()
  try {
    const seed = rotateDeviceSeed(path)
    assert.match(seed, /^[0-9a-f]{32}$/u)
    assert.equal(readDeviceSeed(path), seed)
    assert.equal(readFileSync(path, 'utf8'), seed)
  } finally {
    done()
  }
})

test('rotateDeviceSeed mints a different seed every time, overwriting the file', () => {
  const { path, done } = scratch()
  try {
    const first = rotateDeviceSeed(path)
    const second = rotateDeviceSeed(path)
    assert.notEqual(second, first)
    // The file holds only the latest: rotation is replacement, not a history.
    assert.equal(readDeviceSeed(path), second)
  } finally {
    done()
  }
})

test('rotateDeviceSeed creates the parent directory', () => {
  const { path, done } = scratch()
  try {
    // `~/.dsh/qoder` may not exist on a fresh install.
    assert.doesNotThrow(() => { rotateDeviceSeed(path) })
    assert.match(readDeviceSeed(path) ?? '', /^[0-9a-f]{32}$/u)
  } finally {
    done()
  }
})
