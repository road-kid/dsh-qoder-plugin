import { afterEach, describe, expect, it } from 'vitest'
import {
  emitJobTokenHint,
  emitJobTokenRefreshFailedHint,
  emitUpstreamNotice,
  installJobTokenHint,
} from '../src/job-token-hint.ts'

/**
 * These rows are printed from inside a failing request, so a throw here does not
 * lose a diagnostics line — it replaces the upstream's real answer. That is
 * exactly what happened in production: the store was read as `ctx.sessions`, and
 * a Cordis context throws `cannot get property "sessions" without inject` for a
 * service the plugin never declared, which surfaced to the client as
 * `qoder upstream server (server) (http 502)`.
 *
 * The fake context below is therefore the important one: it behaves like the
 * proxy rather than like a plain object, because the plain object is what the
 * earlier tests (and the earlier reasoning) were written against.
 */

interface FakeSession {
  appended: { type: string, data: unknown }[]
  append(type: string, data: unknown): void
}

function fakeSession(): FakeSession {
  const appended: { type: string, data: unknown }[] = []
  return { appended, append: (type, data) => { appended.push({ type, data }) } }
}

/** A context that answers like a Cordis proxy: undeclared service reads throw. */
function proxyContext(store: Map<string, FakeSession> | undefined): {
  ctx: Parameters<typeof installJobTokenHint>[0]
  handler: Record<string, unknown>
  listener: (payload: unknown) => void
} {
  const handler: Record<string, unknown> = {}
  const target: Record<string, unknown> = {
    on: (_event: string, listener: (payload: unknown) => void) => {
      handler.listener = listener
    },
    // The soft lookup `ctx.get`, mixed in from the host's reflection layer.
    get: (name: string) => (name === 'sessions' ? store : undefined),
  }
  // The trap a Cordis context actually installs for an undeclared service.
  const proxy = new Proxy(target, {
    get: (obj, prop) => {
      if (typeof prop === 'string' && prop === 'sessions') {
        throw new Error(`cannot get property "${prop}" without inject`)
      }
      return Reflect.get(obj, prop)
    },
  })
  return {
    ctx: proxy as unknown as Parameters<typeof installJobTokenHint>[0],
    handler,
    listener: () => {},
  }
}

afterEach(() => {
  // The module keeps process-wide state (the installed context, the last
  // running agent); a stale install leaks into the next case.
  installJobTokenHint({ on: () => {} } as never)
})

describe('the session store read never throws', () => {
  it('does not throw when the context refuses an undeclared service', () => {
    const { ctx } = proxyContext(undefined)
    installJobTokenHint(ctx)

    // Every public emitter, because each one resolves the same store.
    expect(() => { emitUpstreamNotice('queued', 'chat-a') }).not.toThrow()
    expect(() => { emitUpstreamNotice('queued') }).not.toThrow()
    expect(() => { emitJobTokenHint(Date.now(), 'healed', 'chat-a') }).not.toThrow()
    expect(() => { emitJobTokenRefreshFailedHint(Date.now(), 'lost', 'chat-a') }).not.toThrow()
  })

  it('does not throw when the soft lookup itself throws', () => {
    const target = {
      on: () => {},
      get: () => { throw new Error('no reflect') },
    }
    const proxy = new Proxy(target, {
      get: (obj, prop) => {
        if (prop === 'sessions') throw new Error('cannot get property "sessions" without inject')
        return Reflect.get(obj, prop)
      },
    })
    installJobTokenHint(proxy as never)
    expect(() => { emitUpstreamNotice('queued', 'chat-a') }).not.toThrow()
  })

  it('does not throw when the store throws on get', () => {
    const store = { get: () => { throw new Error('store is closed') } }
    const target = { on: () => {}, get: (name: string) => (name === 'sessions' ? store : undefined) }
    installJobTokenHint(target as never)
    expect(() => { emitUpstreamNotice('queued', 'chat-a') }).not.toThrow()
  })

  it('does not throw before any install happened', () => {
    // A transport that emits before the host installed this module.
    expect(() => { emitUpstreamNotice('queued', 'chat-a') }).not.toThrow()
  })
})

describe('the store is still used when it can be read', () => {
  it('prints into the stored session for the issuing id, through the soft lookup', () => {
    const addressed = fakeSession()
    const bystander = fakeSession()
    const store = new Map<string, FakeSession>([['chat-a', addressed], ['chat-b', bystander]])
    const { ctx } = proxyContext(store)
    installJobTokenHint(ctx)

    emitUpstreamNotice('模型排队中', 'chat-a')

    expect(addressed.appended.map(entry => entry.type)).toEqual(['command/run', 'command/done'])
    expect(bystander.appended).toHaveLength(0)
  })

  it('prints into a session reached through a plain object context', () => {
    // The shape the other specs build (and the shape a bare host hands over).
    const session = fakeSession()
    const ctx = { on: () => {}, sessions: { get: (id: string) => (id === 'chat-a' ? session : undefined) } }
    installJobTokenHint(ctx as never)

    emitJobTokenHint(Date.now(), 'jobToken 已自动刷新', 'chat-a')

    expect(session.appended).toHaveLength(2)
    expect(session.appended[1]?.type).toBe('command/done')
  })
})
