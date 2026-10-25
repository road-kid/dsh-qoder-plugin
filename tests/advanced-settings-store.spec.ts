import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  advancedSettings,
  onQuotaSettingsChange,
  resetAdvancedSettings,
  setAdvancedSettingsOpen,
} from '../src/client/quota-settings-store.ts'

/**
 * The 高级设置 disclosure is a browser preference, and `useSyncExternalStore`
 * reads it on every render of the settings card. That gives the store three
 * promises this file pins down, because breaking any of them is invisible in
 * the card tests (React only warns, and the warning is easy to lose in a busy
 * test run):
 *
 *  1. the shipped state is CLOSED — a row behind a switch must never appear
 *     before the user asked for it;
 *  2. the snapshot identity is stable between changes, or React re-renders
 *     forever;
 *  3. every change notifies subscribers exactly once, and a no-op write tells
 *     nobody.
 */
describe('advanced settings disclosure', () => {
  afterEach(() => {
    resetAdvancedSettings()
    vi.unstubAllGlobals()
  })

  it('ships closed', () => {
    resetAdvancedSettings()
    expect(advancedSettings().open).toBe(false)
  })

  it('keeps one snapshot object until the value actually changes', () => {
    resetAdvancedSettings()
    const before = advancedSettings()
    // Reading again must not mint a new object: React compares by identity.
    expect(advancedSettings()).toBe(before)

    setAdvancedSettingsOpen(true)
    const opened = advancedSettings()
    expect(opened).not.toBe(before)
    expect(opened.open).toBe(true)
    expect(advancedSettings()).toBe(opened)
  })

  it('notifies subscribers once per real change and never for a no-op', () => {
    resetAdvancedSettings()
    const listener = vi.fn()
    const unsubscribe = onQuotaSettingsChange(listener)
    try {
      setAdvancedSettingsOpen(true)
      expect(listener).toHaveBeenCalledTimes(1)

      // Same value again: nothing moved, so nothing is announced.
      setAdvancedSettingsOpen(true)
      expect(listener).toHaveBeenCalledTimes(1)

      setAdvancedSettingsOpen(false)
      expect(listener).toHaveBeenCalledTimes(2)
    } finally {
      unsubscribe()
    }
  })

  it('stops notifying a subscriber that unsubscribed', () => {
    resetAdvancedSettings()
    const listener = vi.fn()
    onQuotaSettingsChange(listener)()
    setAdvancedSettingsOpen(true)
    expect(listener).not.toHaveBeenCalled()
  })

  it('persists the choice to browser storage under its own key', () => {
    // A minimal storage stub: only the two methods the module touches.
    const stored = new Map<string, string>()
    vi.stubGlobal('window', {
      localStorage: {
        getItem: (key: string) => stored.get(key) ?? null,
        setItem: (key: string, value: string) => { stored.set(key, value) },
      },
    })

    setAdvancedSettingsOpen(true)
    // Its OWN key: the readout preference must not be overwritten by this one.
    expect(stored.get('dsh-qoder-plugin:advanced')).toBe('{"open":true}')

    setAdvancedSettingsOpen(false)
    expect(stored.get('dsh-qoder-plugin:advanced')).toBe('{"open":false}')
  })

  it('survives storage that refuses to write, because memory still holds it', () => {
    vi.stubGlobal('window', {
      localStorage: {
        getItem: () => null,
        setItem: () => { throw new Error('QuotaExceededError') },
      },
    })

    expect(() => { setAdvancedSettingsOpen(true) }).not.toThrow()
    expect(advancedSettings().open).toBe(true)
  })

  it('resets to the shipped default and says so once', () => {
    setAdvancedSettingsOpen(true)
    expect(advancedSettings().open).toBe(true)

    const listener = vi.fn()
    const unsubscribe = onQuotaSettingsChange(listener)
    try {
      resetAdvancedSettings()
      expect(advancedSettings().open).toBe(false)
      expect(listener).toHaveBeenCalledTimes(1)

      // Already closed: the reset is a no-op and must stay silent.
      resetAdvancedSettings()
      expect(listener).toHaveBeenCalledTimes(1)
    } finally {
      unsubscribe()
    }
  })
})
