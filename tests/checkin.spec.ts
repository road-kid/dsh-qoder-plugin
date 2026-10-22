import { describe, expect, it, vi } from 'vitest'
import { QoderCheckInService, type QoderCheckInResult } from '../src/qoder/transport/checkin.ts'
import type { QoderAuthService } from '../src/qoder/transport/auth.ts'
import {
  CheckInScheduler,
  DEFAULT_CHECK_IN_MINUTE,
  isPastCheckInTime,
  msUntilNextCheckIn,
  normalizeCheckInMinute,
  type CheckInStatusStore,
  type CheckInRecord,
} from '../src/checkin-scheduler.ts'
import { QoderLlmError } from '../src/qoder/errors.ts'
import { metadataCosyVersion } from '../src/qoder/transport/wire/version.ts'

describe('QoderCheckInService', () => {
  function createMockAuth(token = 'mock-job-token'): QoderAuthService {
    return {
      getCredentials: vi.fn(async () => ({ authToken: token, userID: 'u1', name: 'User', email: 'u@test.com', machineID: 'm1' })),
      exchangeFresh: vi.fn(async () => ({ authToken: token + '-fresh', userID: 'u1', name: 'User', email: 'u@test.com', machineID: 'm1' })),
      clear: vi.fn(),
    } as unknown as QoderAuthService
  }

  it('rejects with error result when PAT is empty', async () => {
    const auth = createMockAuth()
    const service = new QoderCheckInService({ authService: auth, variantId: 'qoder', region: 'china' })
    const result = await service.checkIn('')
    expect(result.status).toBe('error')
    expect(result.message).toContain('No PAT')
  })

  it('successfully claims daily benefit when campaign is claimable', async () => {
    const auth = createMockAuth('valid-token')
    const mockFetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const urlStr = String(url)
      if (urlStr.includes('/sash/api/v1/me/campaigns') && (!init?.method || init.method === 'GET')) {
        return new Response(JSON.stringify({
          claimable: true,
          campaigns: [
            {
              campaignId: 'camp-123',
              campaignKey: 'daily-100',
              actionType: 'CLAIM_BENEFIT',
              claimStatus: 'CLAIMABLE',
              benefit: { amount: 100, kind: 'CREDITS' },
            },
          ],
        }), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      if (urlStr.includes('/sash/api/v1/me/campaigns/camp-123/claim') && init?.method === 'POST') {
        return new Response(JSON.stringify({
          status: 'CLAIMED',
          benefit: { amount: 100, kind: 'CREDITS' },
        }), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      return new Response('Not found', { status: 404 })
    }) as unknown as typeof fetch

    const service = new QoderCheckInService({
      authService: auth,
      variantId: 'qoder',
      region: 'china',
      fetch: mockFetch,
      riskIdentity: async () => undefined,
      // China does not gate on the machine identity; stubbing it keeps the
      // suite hermetic instead of spawning the host's real client helper.
    })

    const result = await service.checkIn('pt-test')
    expect(result.status).toBe('claimed')
    expect(result.amount).toBe(100)
    expect(result.campaignKey).toBe('daily-100')
  })

  it('returns already-claimed when campaign status is already CLAIMED', async () => {
    const auth = createMockAuth()
    const mockFetch = vi.fn(async (url: string | URL | Request) => {
      return new Response(JSON.stringify({
        claimable: false,
        campaigns: [
          {
            campaignId: 'camp-123',
            campaignKey: 'daily-100',
            actionType: 'CLAIM_BENEFIT',
            claimStatus: 'CLAIMED',
            benefit: { amount: 100 },
          },
        ],
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    }) as unknown as typeof fetch

    const service = new QoderCheckInService({
      authService: auth,
      variantId: 'qoder',
      region: 'china',
      fetch: mockFetch,
      riskIdentity: async () => undefined,
      // China does not gate on the machine identity; stubbing it keeps the
      // suite hermetic instead of spawning the host's real client helper.
    })

    const result = await service.checkIn('pt-test')
    expect(result.status).toBe('already-claimed')
    expect(result.message).toContain('Already claimed')
  })

  it('returns no-campaign when no CLAIM_BENEFIT campaign exists (like current Global)', async () => {
    const auth = createMockAuth()
    const mockFetch = vi.fn(async () => {
      return new Response(JSON.stringify({
        claimable: true,
        campaigns: [
          {
            campaignId: 'camp-promo',
            actionType: 'VIEW_DETAILS',
            claimStatus: 'CLAIMABLE',
          },
        ],
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    }) as unknown as typeof fetch

    const service = new QoderCheckInService({
      authService: auth,
      variantId: 'qoder-global',
      region: 'global',
      fetch: mockFetch,
      // A stub identity, so this asserts about the campaign list rather than
      // about whether the machine running the suite has Qoder installed.
      riskIdentity: async () => ({ machineToken: 't', machineCode: 'c', machineType: 'y' }),
    })

    const result = await service.checkIn('pt-test')
    expect(result.status).toBe('no-campaign')
  })

  it('identifies as the desktop client, without which the upstream returns an empty campaign list', async () => {
    const auth = createMockAuth()
    const seenHeaders: (Record<string, string> | undefined)[] = []
    const mockFetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      seenHeaders.push(init?.headers as Record<string, string> | undefined)
      return new Response(JSON.stringify({ campaigns: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }) as unknown as typeof fetch

    const service = new QoderCheckInService({
      authService: auth,
      variantId: 'qoder',
      region: 'china',
      fetch: mockFetch,
      riskIdentity: async () => undefined,
      // China does not gate on the machine identity; stubbing it keeps the
      // suite hermetic instead of spawning the host's real client helper.
    })
    await service.checkIn('pt-test')

    // Measured against the live upstream: `cosy-clienttype: 5` answers HTTP
    // 200 with `campaigns: []`, while the desktop identifier `10` returns the
    // real campaign list. Sending `5` silently degrades every check-in into
    // "no campaign today", so nothing is ever claimed.
    expect(seenHeaders[0]?.['cosy-clienttype']).toBe('10')
  })

  it('self-heals with exchangeFresh when auth token is rejected with 401', async () => {
    let callCount = 0
    const auth = {
      getCredentials: vi.fn(async () => ({ authToken: 'expired-token', userID: 'u1', name: 'User', email: 'u@test.com', machineID: 'm1' })),
      exchangeFresh: vi.fn(async () => ({ authToken: 'fresh-token', userID: 'u1', name: 'User', email: 'u@test.com', machineID: 'm1' })),
    } as unknown as QoderAuthService

    const mockFetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const headers = init?.headers as Record<string, string> | undefined
      if (headers?.authorization === 'Bearer expired-token') {
        return new Response(JSON.stringify({ code: 'TOKEN_EXPIRE', message: 'token expired' }), {
          status: 401,
          headers: { 'content-type': 'application/json' },
        })
      }
      return new Response(JSON.stringify({
        campaigns: [
          {
            campaignId: 'c1',
            actionType: 'CLAIM_BENEFIT',
            claimStatus: 'CLAIMED',
          },
        ],
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    }) as unknown as typeof fetch

    const service = new QoderCheckInService({
      authService: auth,
      variantId: 'qoder',
      region: 'china',
      fetch: mockFetch,
      riskIdentity: async () => undefined,
      // China does not gate on the machine identity; stubbing it keeps the
      // suite hermetic instead of spawning the host's real client helper.
    })

    const result = await service.checkIn('pt-test')
    expect(auth.exchangeFresh).toHaveBeenCalled()
    expect(result.status).toBe('already-claimed')
  })
})

describe('CheckInScheduler', () => {
  it('schedules the next occurrence of the configured moment in UTC+8', () => {
    // 08:00 UTC+8 (00:00 UTC) -> 10:00 is 2 hours away
    const morningUtc8 = new Date('2026-09-21T00:00:00.000Z').getTime()
    const diffMorning = msUntilNextCheckIn(DEFAULT_CHECK_IN_MINUTE, morningUtc8)
    expect(diffMorning).toBeGreaterThan(7_100_000)
    expect(diffMorning).toBeLessThan(7_300_000)

    // 12:00 UTC+8 (04:00 UTC) -> tomorrow's 10:00, roughly 22 hours away
    const afternoonUtc8 = new Date('2026-09-21T04:00:00.000Z').getTime()
    const diffAfternoon = msUntilNextCheckIn(DEFAULT_CHECK_IN_MINUTE, afternoonUtc8)
    expect(diffAfternoon).toBeGreaterThan(21 * 3600 * 1000)
    expect(diffAfternoon).toBeLessThan(23 * 3600 * 1000)
  })

  it('honours a custom moment instead of the 10:00 default', () => {
    // 08:00 UTC+8; a 14:30 (870) moment is 6.5 hours away, not 2.
    const morningUtc8 = new Date('2026-09-21T00:00:00.000Z').getTime()
    const diff = msUntilNextCheckIn(870, morningUtc8)
    expect(diff).toBeGreaterThan(6.4 * 3600 * 1000)
    expect(diff).toBeLessThan(6.6 * 3600 * 1000)
  })

  it('falls back to 10:00 for a stored value that is not a real minute', () => {
    expect(normalizeCheckInMinute(undefined)).toBe(DEFAULT_CHECK_IN_MINUTE)
    expect(normalizeCheckInMinute(Number.NaN)).toBe(DEFAULT_CHECK_IN_MINUTE)
    expect(normalizeCheckInMinute(-1)).toBe(DEFAULT_CHECK_IN_MINUTE)
    expect(normalizeCheckInMinute(1440)).toBe(DEFAULT_CHECK_IN_MINUTE)
    // A real value passes through untouched.
    expect(normalizeCheckInMinute(870)).toBe(870)
    expect(normalizeCheckInMinute(0)).toBe(0)
  })

  it('reports the configured moment as passed only once it has actually passed', () => {
    // 09:00 UTC+8 (01:00 UTC)
    const before10 = new Date('2026-09-21T01:00:00.000Z').getTime()
    expect(isPastCheckInTime(DEFAULT_CHECK_IN_MINUTE, before10)).toBe(false)

    // 11:00 UTC+8 (03:00 UTC)
    const after10 = new Date('2026-09-21T03:00:00.000Z').getTime()
    expect(isPastCheckInTime(DEFAULT_CHECK_IN_MINUTE, after10)).toBe(true)

    // The same 11:00 wall clock has not reached a custom 14:30 (870) moment.
    expect(isPastCheckInTime(870, after10)).toBe(false)
    // ...and a midnight moment has already passed at 00:00 UTC+8 (16:00 UTC).
    const midnightUtc8 = new Date('2026-09-21T16:00:00.000Z').getTime()
    expect(isPastCheckInTime(0, midnightUtc8)).toBe(true)
  })

  it('arms a timer before the toggles are readable, and re-arms to a retimed moment', () => {
    const delays: number[] = []
    const spy = vi.spyOn(globalThis, 'setTimeout').mockImplementation(((
      _handler: () => void,
      delay?: number,
    ) => {
      delays.push(Number(delay))
      return 0 as unknown as NodeJS.Timeout
    }) as typeof setTimeout)

    let minute = 870 // 14:30
    const scheduler = new CheckInScheduler({
      targets: [{
        variantId: 'qoder',
        checkIn: async () => ({
          variantId: 'qoder',
          date: '2026-09-22',
          timestamp: 1,
          status: 'claimed' as const,
        }),
        minuteOfDay: () => minute,
      }],
      // The stored toggle is not readable yet at assembly time. Gating timer
      // placement on this is what left a configured 12:13 check-in with no
      // timer at all, so placement must not depend on it.
      isEnabled: () => false,
      now: () => new Date('2026-09-22T00:00:00.000Z').getTime(), // 08:00 UTC+8
    })

    scheduler.rearm()
    expect(delays).toHaveLength(1)
    // 08:00 -> 14:30 is 6.5 hours.
    expect(delays[0]).toBeGreaterThan(6.4 * 3600 * 1000)
    expect(delays[0]).toBeLessThan(6.6 * 3600 * 1000)

    minute = DEFAULT_CHECK_IN_MINUTE // retimed to 10:00
    scheduler.rearm()
    expect(delays).toHaveLength(2)
    // 08:00 -> 10:00 is 2 hours.
    expect(delays[1]).toBeGreaterThan(7_100_000)
    expect(delays[1]).toBeLessThan(7_300_000)

    scheduler.dispose()
    spy.mockRestore()
  })

  it('runs catchup and updates store when enabled', async () => {
    const storeRecords: Record<string, CheckInRecord> = {}
    const store: CheckInStatusStore = {
      read: (id) => storeRecords[id],
      write: (id, record) => { storeRecords[id] = record },
    }

    const checkIn = vi.fn(async () => ({
      variantId: 'qoder',
      date: '2026-09-21',
      timestamp: Date.now(),
      status: 'claimed' as const,
      amount: 100,
    }))

    const onClaimed = vi.fn()
    const after10 = new Date('2026-09-21T04:00:00.000Z').getTime()

    const scheduler = new CheckInScheduler({
      targets: [
        {
          variantId: 'qoder',
          checkIn,
          minuteOfDay: () => DEFAULT_CHECK_IN_MINUTE,
          onClaimed,
        },
      ],
      isEnabled: (id) => id === 'qoder',
      store,
      now: () => after10,
    })

    scheduler.start()
    // Wait microtasks
    await new Promise(r => setTimeout(r, 10))
    scheduler.dispose()

    expect(checkIn).toHaveBeenCalled()
    expect(onClaimed).toHaveBeenCalled()
    expect(storeRecords.qoder?.status).toBe('claimed')
    expect(storeRecords.qoder?.lastDate).toBe('2026-09-21')
  })

  it('retries later the same day when an earlier attempt claimed nothing', async () => {
    const records: Record<string, CheckInRecord> = {
      qoder: { lastDate: '2026-09-22', lastAt: 1, status: 'no-campaign' },
    }
    const store: CheckInStatusStore = {
      read: id => records[id],
      write: (id, record) => { records[id] = record },
    }
    const checkIn = vi.fn(async () => ({
      variantId: 'qoder',
      date: '2026-09-22',
      timestamp: 2,
      status: 'claimed' as const,
      amount: 100,
    }))

    const scheduler = new CheckInScheduler({
      targets: [{
        variantId: 'qoder',
        checkIn,
        minuteOfDay: () => DEFAULT_CHECK_IN_MINUTE,
      }],
      isEnabled: () => true,
      store,
      now: () => new Date('2026-09-22T04:00:00.000Z').getTime(),
    })

    scheduler.start()
    await new Promise(r => setTimeout(r, 10))
    scheduler.dispose()

    // "Nothing to claim yet" is not a settled day: a later attempt the same
    // day must still be allowed to claim it.
    expect(checkIn).toHaveBeenCalled()
    expect(records.qoder?.status).toBe('claimed')
  })

  it('skips the rest of the day once the day was actually claimed', async () => {
    const records: Record<string, CheckInRecord> = {
      qoder: { lastDate: '2026-09-22', lastAt: 1, status: 'claimed', amount: 100 },
    }
    const store: CheckInStatusStore = {
      read: id => records[id],
      write: (id, record) => { records[id] = record },
    }
    const checkIn = vi.fn(async () => ({
      variantId: 'qoder',
      date: '2026-09-22',
      timestamp: 2,
      status: 'claimed' as const,
      amount: 100,
    }))

    const scheduler = new CheckInScheduler({
      targets: [{
        variantId: 'qoder',
        checkIn,
        minuteOfDay: () => DEFAULT_CHECK_IN_MINUTE,
      }],
      isEnabled: () => true,
      store,
      now: () => new Date('2026-09-22T04:00:00.000Z').getTime(),
    })

    scheduler.start()
    await new Promise(r => setTimeout(r, 10))
    scheduler.dispose()

    expect(checkIn).not.toHaveBeenCalled()
  })

  it('stamps the record with the window it fired on, not the transport default', async () => {
    /*
     * The transport cannot know a user's retimed window (it is built once,
     * while the minute is read per sweep), so it labels claims with the 10:00
     * default. If the sweep stored that label, a 14:30 window would write
     * "today" for a 12:00 claim while comparing against "yesterday" — the
     * record and its own guard disagreeing, which is the bug being fixed.
     */
    const records: Record<string, CheckInRecord> = {}
    const store: CheckInStatusStore = {
      read: id => records[id],
      write: (id, record) => { records[id] = record },
    }
    const checkIn = vi.fn(async () => ({
      variantId: 'qoder',
      // The transport's own (default-window) label, which must NOT be stored.
      date: '2026-09-30',
      timestamp: 2,
      status: 'claimed' as const,
      amount: 100,
    }))

    const scheduler = new CheckInScheduler({
      targets: [{ variantId: 'qoder', checkIn, minuteOfDay: () => 870 }],
      isEnabled: () => true,
      store,
      // 12:00 UTC+8: before a 14:30 opening, so this belongs to Sep 29's window.
      now: () => new Date('2026-09-30T04:00:00.000Z').getTime(),
    })

    await scheduler.sweepAll(false)
    scheduler.dispose()

    expect(records.qoder?.lastDate).toBe('2026-09-29')
  })

  it('treats a window claimed last night as settled after midnight', async () => {
    /*
     * The reported bug: the user claimed at 23:11 and the card offered the
     * button again at 00:44, because "settled" was compared against the
     * CALENDAR day. The upstream's window runs 10:00 -> 10:00, so the claim
     * still belongs to the open window and a sweep must not re-claim it.
     */
    const records: Record<string, CheckInRecord> = {
      // 23:11 on Sep 30 belongs to the window that opened at 10:00 that day.
      qoder: { lastDate: '2026-09-30', lastAt: 1, status: 'claimed', amount: 100 },
    }
    const store: CheckInStatusStore = {
      read: id => records[id],
      write: (id, record) => { records[id] = record },
    }
    const checkIn = vi.fn(async () => ({
      variantId: 'qoder',
      date: '2026-10-01',
      timestamp: 2,
      status: 'claimed' as const,
      amount: 100,
    }))

    const scheduler = new CheckInScheduler({
      targets: [{
        variantId: 'qoder',
        checkIn,
        minuteOfDay: () => DEFAULT_CHECK_IN_MINUTE,
      }],
      isEnabled: () => true,
      store,
      // 00:44 UTC+8 on Oct 1: past midnight, but the 10:00 window is still open.
      now: () => new Date('2026-09-30T16:44:00.000Z').getTime(),
    })

    /*
     * `sweepAll` directly, not `start()`: a STARTUP catch-up returns early
     * before the settle check whenever the configured moment has not passed,
     * so it would pass here for the wrong reason. The scheduled (non-catch-up)
     * sweep is the path that consults the record.
     */
    await scheduler.sweepAll(false)
    scheduler.dispose()

    expect(checkIn).not.toHaveBeenCalled()
  })

  it('claims again once the next window has actually opened', async () => {
    // The mirror of the case above: at 10:00 the window really does turn over,
    // so the same record must no longer be treated as settled.
    const records: Record<string, CheckInRecord> = {
      qoder: { lastDate: '2026-09-30', lastAt: 1, status: 'claimed', amount: 100 },
    }
    const store: CheckInStatusStore = {
      read: id => records[id],
      write: (id, record) => { records[id] = record },
    }
    const checkIn = vi.fn(async () => ({
      variantId: 'qoder',
      date: '2026-10-01',
      timestamp: 2,
      status: 'claimed' as const,
      amount: 100,
    }))

    const scheduler = new CheckInScheduler({
      targets: [{
        variantId: 'qoder',
        checkIn,
        minuteOfDay: () => DEFAULT_CHECK_IN_MINUTE,
      }],
      isEnabled: () => true,
      store,
      // 10:00 UTC+8 on Oct 1 (02:00 UTC): the new window is open.
      now: () => new Date('2026-10-01T02:00:00.000Z').getTime(),
    })

    scheduler.start()
    await new Promise(r => setTimeout(r, 10))
    scheduler.dispose()

    expect(checkIn).toHaveBeenCalled()
  })

  it('never sweeps one variant twice at once', async () => {
    let settle: ((result: QoderCheckInResult) => void) | undefined
    const checkIn = vi.fn(() => new Promise<QoderCheckInResult>(resolve => { settle = resolve }))
    const writes: CheckInRecord[] = []
    const store: CheckInStatusStore = {
      read: () => undefined,
      write: (_id, record) => { writes.push(record) },
    }
    const scheduler = new CheckInScheduler({
      targets: [{
        variantId: 'qoder',
        checkIn,
        minuteOfDay: () => DEFAULT_CHECK_IN_MINUTE,
      }],
      isEnabled: () => true,
      store,
      now: () => new Date('2026-09-22T04:00:00.000Z').getTime(),
    })

    // `start()` and the settings section's first catch-up overlap during
    // assembly. Both used to claim, which the live log showed as two rows five
    // milliseconds apart for one action.
    const first = scheduler.sweepAll(true)
    const second = scheduler.sweepAll(true)
    await Promise.resolve()
    expect(checkIn).toHaveBeenCalledTimes(1)

    settle!({ variantId: 'qoder', date: '2026-09-22', timestamp: 1, status: 'claimed', amount: 100 })
    await Promise.all([first, second])
    expect(checkIn).toHaveBeenCalledTimes(1)
    expect(writes).toHaveLength(1)
    scheduler.dispose()
  })

  it('publishes when the next automatic run is due', () => {
    const scheduler = new CheckInScheduler({
      targets: [{
        variantId: 'qoder',
        checkIn: async () => ({ variantId: 'qoder', date: '2026-09-22', timestamp: 1, status: 'claimed' as const }),
        minuteOfDay: () => DEFAULT_CHECK_IN_MINUTE,
      }],
      isEnabled: () => true,
      store: { read: () => undefined, write: () => {} },
      now: () => new Date('2026-09-22T00:00:00.000Z').getTime(), // 08:00 UTC+8
    })

    scheduler.rearm()
    const due = scheduler.nextRunAt('qoder')
    expect(due).toBeDefined()
    // 08:00 -> 10:00 is 2 hours.
    expect(due! - new Date('2026-09-22T00:00:00.000Z').getTime()).toBeGreaterThan(7_100_000)
    expect(due! - new Date('2026-09-22T00:00:00.000Z').getTime()).toBeLessThan(7_300_000)
    scheduler.dispose()
  })

  it('records a visible row when the timer fires on an already-claimed day', async () => {
    const records: Record<string, CheckInRecord> = {
      qoder: { lastDate: '2026-09-22', lastAt: 1, status: 'claimed', amount: 100 },
    }
    const writes: CheckInRecord[] = []
    const store: CheckInStatusStore = {
      read: id => records[id],
      write: (id, record) => { writes.push(record); records[id] = record },
    }
    const checkIn = vi.fn(async () => ({
      variantId: 'qoder',
      date: '2026-09-22',
      timestamp: 2,
      status: 'claimed' as const,
    }))
    const scheduler = new CheckInScheduler({
      targets: [{
        variantId: 'qoder',
        checkIn,
        minuteOfDay: () => DEFAULT_CHECK_IN_MINUTE,
      }],
      isEnabled: () => true,
      store,
      now: () => new Date('2026-09-22T04:00:00.000Z').getTime(),
    })

    // The timer's own pass: no second claim, but the run is observable.
    await scheduler.sweepAll(false, 'qoder')
    expect(checkIn).not.toHaveBeenCalled()
    expect(writes).toHaveLength(1)
    expect(writes[0]?.status).toBe('already-claimed')

    // A catch-up stays silent, or every boot would pile on another row.
    writes.length = 0
    await scheduler.sweepAll(true, 'qoder')
    expect(writes).toHaveLength(0)
    scheduler.dispose()
  })
})

describe('QoderCheckInService risk identity', () => {
  function createMockAuth(token = 'mock-job-token'): QoderAuthService {
    return {
      getCredentials: vi.fn(async () => ({ authToken: token, userID: 'u1', name: 'User', email: 'u@test.com', machineID: 'm1' })),
      exchangeFresh: vi.fn(async () => ({ authToken: token + '-fresh', userID: 'u1', name: 'User', email: 'u@test.com', machineID: 'm1' })),
      clear: vi.fn(),
    } as unknown as QoderAuthService
  }

  /**
   * The identity headers are what make an international check-in possible at
   * all: the upstream withholds the daily campaign from a request that does
   * not carry a client-minted machine identity. These tests pin the request
   * SHAPE, so a future refactor of the header merge cannot silently drop them
   * again — the failure mode is invisible (HTTP 200, no error, no campaign).
   */
  it('sends the client machine identity with the campaign request', async () => {
    const auth = createMockAuth()
    const seen: (Record<string, string> | undefined)[] = []
    const mockFetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      seen.push(init?.headers as Record<string, string> | undefined)
      return new Response(JSON.stringify({ campaigns: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }) as unknown as typeof fetch

    const service = new QoderCheckInService({
      authService: auth,
      variantId: 'qoder-global',
      region: 'global',
      fetch: mockFetch,
      riskIdentity: async () => ({
        machineToken: 'P1g-test-token',
        machineCode: 'code-1',
        machineType: 'type-1',
      }),
    })
    await service.checkIn('pt-test')

    const headers = seen[0] ?? {}
    // Three headers, all present, none of them the self-made machine id the
    // transport used to substitute: the upstream only honours a token it can
    // verify against the account being fingerprinted.
    expect(headers['cosy-machinetoken']).toBe('P1g-test-token')
    expect(headers['cosy-machinecode']).toBe('code-1')
    expect(headers['cosy-machinetype']).toBe('type-1')
    expect(headers['cosy-clienttype']).toBe('10')
    // The campaign family presents the DESKTOP build, not the CLI one: the
    // reference implementation pins its Cosy-Version to the desktop client
    // version, and the measured header set depends on it.
    expect(headers['cosy-version']).toBe(metadataCosyVersion)
    // The per-account derived device id/hostname of the inference path must
    // never appear here: the campaign upstream only honours the real client
    // identity, so substituting a derived one would silently empty the list.
    expect(headers).not.toHaveProperty('Cosy-Machineid')
    expect(headers).not.toHaveProperty('Cosy-Machinehostname')
  })

  it('reports a missing client instead of claiming the account has no campaign', async () => {
    const auth = createMockAuth()
    const mockFetch = vi.fn(async () => {
      throw new Error('the campaign endpoint must not be reached without an identity')
    }) as unknown as typeof fetch

    const service = new QoderCheckInService({
      authService: auth,
      variantId: 'qoder-global',
      region: 'global',
      fetch: mockFetch,
      riskIdentity: async () => undefined,
    })
    const result = await service.checkIn('pt-test')
    // `no-campaign` would blame the ACCOUNT for what is really a missing local
    // client, which is exactly the misdiagnosis this guard exists to prevent.
    expect(result.status).toBe('error')
    expect(result.message).toContain('No Qoder desktop client')
    expect(mockFetch).not.toHaveBeenCalled()
  })

  it('keeps the China region working without any client identity', async () => {
    const auth = createMockAuth()
    const mockFetch = vi.fn(async () => new Response(JSON.stringify({
      campaigns: [{
        campaignId: 'camp-1',
        campaignKey: 'daily-100',
        actionType: 'CLAIM_BENEFIT',
        claimStatus: 'CLAIMABLE',
        benefit: { amount: 100 },
      }],
    }), { status: 200, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch

    const service = new QoderCheckInService({
      authService: auth,
      variantId: 'qoder',
      region: 'china',
      fetch: mockFetch,
      riskIdentity: async () => undefined,
    })
    const result = await service.checkIn('pt-test')
    // The China upstream does not gate on the machine identity, so its check-in
    // must not start failing on a machine without a client installed.
    expect(result.status).toBe('error')
    expect(result.message).toContain('Claim returned status')
  })
})
