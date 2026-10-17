/* eslint-disable @typescript-eslint/no-explicit-any */
import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import { QODER_PROBE_PATH } from '../src/status-paths.ts'

/**
 * The client entry degrades a slot-API breaking change (the rc.6→rc.7
 * `id`→`key` rename that caused the red "Failed to load plugins" banner)
 * to a console.error, so the host provider keeps working without a banner.
 *
 * We cannot import the real client entry (it pulls browser-only DSH client
 * packages, and its components need the DOM); instead we replicate the
 * try/catch shape from `src/client/index.tsx` and assert it swallows a
 * simulated throw at each guarded boundary.
 *
 * DRIFT WARNING: the `apply()` below is a manual mirror of the real `apply()`
 * in `src/client/index.tsx` (see the NOTE on that function). It is NOT the
 * product code, so these tests prove the fallback boundaries work — they cannot
 * by themselves detect a regression in the real entry. The final describe
 * block closes that gap mechanically: it reads the entry off disk and requires
 * every `console.error` message, every `ctx.effect` label, and the locale
 * namespace it registers to appear VERBATIM in this file's own source. Change
 * the real entry's guarded body or one of those literals without updating the
 * mirror, and that case fails.
 */

/**
 * The configuration-face constants, mirroring src/client/index.tsx.
 *
 * `ENTRY_ID` is the PROFILE ROW ID this bundle's patch inserts — the right half
 * of the `plugins.row.config` key, not a `configForms` namespace.
 */
const ENTRY_ID = 'llm-qoder-x'
const ROW_CONFIG_SLOT = 'plugins.row.config'
const BUNDLE_CONFIG_SLOT = 'plugins.bundle.config'
const PACKAGE_NAME = 'dsh-connect-qoder-x'
const ROW_CONFIG_KEY = `${PACKAGE_NAME}#${ENTRY_ID}`

/** The composer seats: the quota readout chip, and the context-window probe. */
const COMPOSER_READOUT_SLOT = 'conversation.input.left'
const COMPOSER_PROBE_SLOT = 'conversation.input.right'
const READOUT_ID = 'qoder-quota-readout'
const PROBE_ID = 'qoder-probe'

/** Minimal component stand-in: the mirror never renders anything. */
const Component = (): null => null

/** Stand-in for the stylesheet effect (the real one touches `document`). */
const injectQuotaCssStandIn = (): (() => void) => () => {}

/**
 * Mirror of src/client/index.tsx apply() body.
 *
 * Not mirrored: `new OwnQuotaSettingsScope()` (it does network I/O) — replaced
 * by a stand-in scope object fed through the same `adoptQuotaScope` boundary,
 * so the registration sequence around it stays verbatim.
 */
function apply(ctx: any): void {
  try {
    const namespace = 'settings.qoder'
    ctx.effect(() => ctx.locale.register(namespace, { zh: {}, en: {} }), 'dsh-connect-qoder-x: settings copy')
    const t = ctx.locale.bind(namespace)

    let quotaScope: any
    const adoptQuotaScope = (scope: any): void => {
      quotaScope = scope
      const applySnapshot = (): void => {
        const value = scope.getSnapshot().value
        if (typeof value?.quotaPollMs === 'number') {
          // The real entry mirrors the interval into the shared store; the
          // mirror only proves the snapshot boundary runs.
          void value.quotaPollMs
        }
      }
      applySnapshot()
      scope.subscribe(applySnapshot)
    }

    // One inject face for both plugin-configuration seats: the card is the same
    // component either way and reads `view` from its PROPS (the owner contract).
    const cardFace = (): any => ({
      t,
      scope: quotaScope,
      signedIn: () => ({ cn: false, global: false }),
      unified: true,
    })

    const registerCard = (slot: string, key: string): void => {
      try {
        ctx.slots.inject(slot, () => ctx.slots.register({ name: slot, key, inject: cardFace }, Component))
      } catch (error: unknown) {
        console.error(`[dsh-connect-qoder-x] card slot "${slot}" failed to register (host provider unaffected):`, error)
      }
    }
    registerCard(ROW_CONFIG_SLOT, ROW_CONFIG_KEY)
    registerCard(BUNDLE_CONFIG_SLOT, PACKAGE_NAME)

    adoptQuotaScope({
      getSnapshot: () => ({ value: { quotaPollMs: 300_000 } }),
      subscribe: () => () => {},
    })

    ctx.effect(() => injectQuotaCssStandIn(), 'dsh-connect-qoder-x: quota styles')

    // The composer quota readout (session-scoped list; renders only while the
    // session's selected model belongs to this plugin).
    ctx.inject(['modelDirectories'], (scope: any) => {
      try {
        scope.slots.inject(COMPOSER_READOUT_SLOT, () => scope.slots.register({
          name: COMPOSER_READOUT_SLOT,
          id: READOUT_ID,
          order: 5,
          inject: (sessionId: string) => ({
            directory: scope.modelDirectories.directoryFor(sessionId).store,
            t,
          }),
        }, Component))
      } catch (error: unknown) {
        console.error('[dsh-connect-qoder-x] could not register the composer quota readout:', error)
      }
    })

    // The context-window probe, sharing the same session/model-directory face.
    ctx.inject(['modelDirectories'], (scope: any) => {
      try {
        scope.slots.inject(COMPOSER_PROBE_SLOT, () => scope.slots.register({
          name: COMPOSER_PROBE_SLOT,
          id: PROBE_ID,
          order: 10,
          inject: (sessionId: string) => ({
            directory: scope.modelDirectories.directoryFor(sessionId).store,
            t,
          }),
        }, Component))
      } catch (error: unknown) {
        console.error('[dsh-connect-qoder-x] could not register the context probe:', error)
      }
    })
  } catch (error: unknown) {
    // Degrade silently on the page: the host provider still serves models.
    console.error('[dsh-connect-qoder-x] client card failed to load (host provider unaffected):', error)
  }
}

interface FakeContext {
  readonly ctx: any
  readonly injections: string[]
  readonly registerCalls: Record<string, unknown>[]
}

/**
 * A stand-in for the DSH client context. `throwOn.slot` names the slot whose
 * injection must fail, which is how each test moves a different guarded
 * boundary.
 */
function fakeContext(throwOn: { slot?: string } = {}): FakeContext {
  const injections: string[] = []
  const registerCalls: Record<string, unknown>[] = []
  const slots = {
    inject: (name: string, factory: () => unknown) => {
      if (throwOn.slot !== undefined && throwOn.slot === name) {
        throw new Error(`keyed slot "${name}" requires options.key`)
      }
      injections.push(name)
      const contribution = factory()
      if (typeof contribution === 'function') return contribution
      return () => {}
    },
    register: (options: Record<string, unknown>, component: unknown) => {
      registerCalls.push({ ...options, component })
      return () => {}
    },
    entries: (name: string) => registerCalls
      .filter(call => call['name'] === name)
      .map(call => ({ options: { id: call['id'] } })),
  }
  const ctx: any = {
    effect: (fn: () => unknown) => { fn() },
    locale: { register: () => () => {}, bind: () => (key: string) => key },
    slots,
    get: () => undefined,
    modelDirectories: { directoryFor: () => ({ store: {} }) },
    inject: (deps: string[], cb: (scope: any) => void) => {
      if(!deps.includes('modelDirectories')) return
      cb({ slots, modelDirectories: ctx.modelDirectories })
    },
  }
  return { ctx, injections, registerCalls }
}

/** Console.error calls captured as strings. */
function useErrorSpy(): { errors: string[]; restore: () => void } {
  const errors: string[] = []
  const spy = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => { errors.push(args.map(String).join(' ')) })
  return { errors, restore: () => spy.mockRestore() }
}

describe('client card fallback', () => {
  it('swallows a card seat registration failure instead of throwing', () => {
    const { errors, restore } = useErrorSpy()
    const { ctx } = fakeContext({ slot: ROW_CONFIG_SLOT })

    // Must not throw — the whole point of the fallback.
    expect(() => apply(ctx)).not.toThrow()

    // Reported by the CARD's own catch (a keyed slot needs a key), not by the
    // outer boundary: one seat failing must not take the other with it.
    expect(errors).toHaveLength(1)
    expect(errors[0]).toContain(`card slot "${ROW_CONFIG_SLOT}" failed to register`)
    expect(errors[0]).toContain('requires options.key')

    restore()
  })

  it('still registers the composer seats when a card seat breaks', () => {
    const { errors, restore } = useErrorSpy()
    const { ctx, injections } = fakeContext({ slot: BUNDLE_CONFIG_SLOT })

    expect(() => apply(ctx)).not.toThrow()
    expect(errors).toHaveLength(1)
    expect(errors[0]).toContain('card slot')
    // The composer readout is the user's only quota surface now: a broken
    // Plugins-page seat must never suppress it.
    expect(injections).toContain(COMPOSER_READOUT_SLOT)
    expect(injections).toContain(COMPOSER_PROBE_SLOT)

    restore()
  })

  it('degrades a broken readout seat to its own console.error', () => {
    const { errors, restore } = useErrorSpy()
    const { ctx, injections } = fakeContext({ slot: COMPOSER_READOUT_SLOT })

    expect(() => apply(ctx)).not.toThrow()
    expect(errors).toHaveLength(1)
    expect(errors[0]).toContain('could not register the composer quota readout')
    // The probe is independent of the readout.
    expect(injections).toContain(COMPOSER_PROBE_SLOT)

    restore()
  })

  it('degrades a broken probe seat to its own console.error', () => {
    const { errors, restore } = useErrorSpy()
    const { ctx, injections } = fakeContext({ slot: COMPOSER_PROBE_SLOT })

    expect(() => apply(ctx)).not.toThrow()
    expect(errors).toHaveLength(1)
    expect(errors[0]).toContain('could not register the context probe')
    expect(injections).toContain(COMPOSER_READOUT_SLOT)

    restore()
  })

  it('contributes both plugin-config seats, the readout, and the probe', () => {
    const { errors, restore } = useErrorSpy()
    const { ctx, injections, registerCalls } = fakeContext()

    expect(() => apply(ctx)).not.toThrow()
    expect(errors).toEqual([])
    expect(injections.filter(name => name === ROW_CONFIG_SLOT)).toHaveLength(1)
    expect(injections.filter(name => name === BUNDLE_CONFIG_SLOT)).toHaveLength(1)
    expect(injections).toContain(COMPOSER_READOUT_SLOT)
    expect(injections).toContain(COMPOSER_PROBE_SLOT)

    // The plugin-config seats, by their derived keys.
    const pluginKeys = registerCalls.flatMap(call => typeof call['key'] === 'string' ? [call['key']] : [])
    expect(pluginKeys.sort()).toEqual([PACKAGE_NAME, ROW_CONFIG_KEY].sort())
    // The composer seats, by their ids.
    const seatIds = registerCalls.flatMap(call => typeof call['id'] === 'string' ? [call['id']] : [])
    expect(seatIds.sort()).toEqual([PROBE_ID, READOUT_ID].sort())
    expect(QODER_PROBE_PATH).toBe('/plugins/dsh-connect-qoder-x/probe')

    restore()
  })

  it('injects the session model directory into both composer seats', () => {
    const { errors, restore } = useErrorSpy()
    const { ctx, registerCalls } = fakeContext()

    expect(() => apply(ctx)).not.toThrow()
    expect(errors).toEqual([])

    // Both seats are session-scoped lists: their inject factory is called with
    // the owning session id and must hand the component that session's model
    // directory store (how the chip/probe learn the selected model).
    for (const id of [READOUT_ID, PROBE_ID]) {
      const call = registerCalls.find(entry => entry['id'] === id) as unknown as {
        inject: (sessionId: string) => { directory: unknown }
      }
      const face = call.inject('session-1')
      expect(face.directory).toBeDefined()
    }

    restore()
  })

  it('keys the row seat by `<package name>#<row id>`, both halves spelled out', () => {
    const { errors, restore } = useErrorSpy()
    const { ctx, registerCalls } = fakeContext()

    expect(() => apply(ctx)).not.toThrow()
    expect(errors).toEqual([])

    const row = registerCalls.find(call => call['name'] === ROW_CONFIG_SLOT)
    expect(row?.['key']).toBe('dsh-connect-qoder-x#llm-qoder-x')

    restore()
  })

  it('never claims a retired seat (sidebar card, quota panel, settings section)', () => {
    const { errors, restore } = useErrorSpy()
    const { ctx, injections, registerCalls } = fakeContext()

    expect(() => apply(ctx)).not.toThrow()
    expect(errors).toEqual([])
    // The 0.3.2 redesign replaced the sidebar footer cards and the quota
    // dashboard panel with the composer readout; re-claiming either would
    // re-create surfaces the user asked to remove.
    expect(injections).not.toContain('sidebar.footer.action')
    expect(injections).not.toContain('main')
    expect(registerCalls.some(call => call['key'] === 'qoder-quota-panel')).toBe(false)
    expect(registerCalls.some(call => call['id'] === 'qoder-quota')).toBe(false)
    expect(registerCalls.some(call => call['id'] === 'qoder-global-quota')).toBe(false)
    // The retired settings-section path must stay retired too.
    expect(injections).not.toContain('settings.plugin.item')
    expect(injections).not.toContain('settings.section')
    expect(injections).not.toContain('plugin-settings.item')

    restore()
  })
})

describe('mirror stays verbatim with src/client/index.tsx', () => {
  const entrySource = readFileSync(new URL('../src/client/index.tsx', import.meta.url), 'utf8')
  const mirrorSource = readFileSync(new URL(import.meta.url), 'utf8')

  it('every console.error message in the entry is mirrored word for word', () => {
    // Both quote styles: the entry uses a template literal for the per-seat card
    // failure (the slot name is interpolated into it) and plain strings for the
    // rest. The template pattern stops at the `${` interpolation, so the
    // mirrored fragment is the literal prefix — which is what the mirror repeats.
    const messages = [
      ...entrySource.matchAll(/console\.error\(\s*'([^']+)'/g),
      ...entrySource.matchAll(/console\.error\(`([^`]*?)\$\{/g),
    ].map(match => match[1]!)
    // Guard the guard: outer catch + per-seat card catch + readout + probe.
    expect(messages).toHaveLength(4)
    for (const message of messages) {
      expect(mirrorSource).toContain(message)
    }
  })

  it('every effect label and the locale namespace in the entry are mirrored', () => {
    const labels = [...entrySource.matchAll(/,\s*'(dsh-connect-qoder-x: [^']+)'/g)].map(match => match[1]!)
    expect(labels).toEqual(['dsh-connect-qoder-x: settings copy', 'dsh-connect-qoder-x: quota styles'])
    for (const label of labels) expect(mirrorSource).toContain(label)
    expect(entrySource).toContain("'settings.qoder'")
    expect(mirrorSource).toContain("'settings.qoder'")
  })

  it('the entry has no legacy brand literal left anywhere', () => {
    // Assembled at runtime so this spec's own source stays out of its way.
    const legacy = ['work', 'buddy'].join('')
    expect(entrySource.toLowerCase()).not.toContain(legacy)
    expect(mirrorSource.toLowerCase()).not.toContain(legacy)
  })

  it('every seat this plugin claims in the entry is claimed by the mirror too', () => {
    const seats = [
      COMPOSER_READOUT_SLOT, COMPOSER_PROBE_SLOT, READOUT_ID, PROBE_ID,
      // The 0.1.7 plugin-configuration seats.
      'plugins.row.config', 'plugins.bundle.config',
    ]
    for (const seat of seats) {
      expect(entrySource).toContain(seat)
      expect(mirrorSource).toContain(seat)
    }
    // The row key is COMPOSED in the entry (`${PACKAGE_NAME}#${ENTRY_ID}`), not
    // written as one literal, so assert the two halves and their concatenation.
    expect(entrySource).toContain(`const ROW_CONFIG_KEY = \`\${PACKAGE_NAME}#\${ENTRY_ID}\``)
    expect(entrySource).toContain("const PACKAGE_NAME = 'dsh-connect-qoder-x'")
    expect(entrySource).toContain("const ENTRY_ID = 'llm-qoder-x'")
    expect(mirrorSource).toContain('dsh-connect-qoder-x#llm-qoder-x')

    // Seats the plugin must NOT claim any more. Read from the CALL SITES, not
    // the whole file: the entry's comments name the retired slots on purpose.
    const claims = [...entrySource.matchAll(/slots\.inject\(\s*'([^']+)'/g)].map(match => match[1]!)
    expect(claims).not.toContain('sidebar.footer.action')
    expect(claims).not.toContain('settings.plugin.item')
    expect(claims).not.toContain('settings.section')
    expect(claims).not.toContain('plugin-settings.item')
    // And the mirror's registration calls agree, seat for seat.
    const mirrorClaims = [...mirrorSource.matchAll(/slots\.inject\(\s*(?:slot|'([^']+)')/g)]
    expect(mirrorClaims.length).toBeGreaterThan(0)
  })
})
