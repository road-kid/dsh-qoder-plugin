import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  CAMPAIGN_DERIVED_HOSTNAME_ENV,
  CAMPAIGN_MACHINE_HEADERS_ENV,
  QoderCheckInService,
  type QoderCheckInResult,
} from '../src/qoder/transport/checkin.ts'
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
import { campaignCosyVersion, campaignUserAgent, metadataCosyVersion } from '../src/qoder/transport/wire/version.ts'
import {
  buildAuthHeaders,
  campaignMachineOs,
  qoderDesktopClientType,
  QODER_COSY_MACHINE_OS_ENV,
} from '../src/qoder/transport/wire/cosy.ts'
import { campaignHostname } from '../src/qoder/transport/risk-identity.ts'
import { deriveMachineHostname, deriveMachineId } from '../src/qoder/transport/device-identity.ts'

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
   * The `cosy-machine*` names a request actually carries, lowercased and sorted.
   *
   * A SET comparison is what the invariants are stated in (exactly three, or
   * exactly six), and it is the only form that catches a header added by
   * accident as well as one dropped.
   */
  function machineHeaderNames(headers: Record<string, string> | undefined): string[] {
    return Object.keys(headers ?? {})
      .map(name => name.toLowerCase())
      .filter(name => name.startsWith('cosy-machine'))
      .sort()
  }

  /** The component-minted identity every campaign test starts from. */
  const nativeIdentity = {
    machineToken: 'native-token',
    machineCode: 'native-code',
    machineType: 'native-type',
  }

  /** A campaign list with one claimable benefit, the shape the claim path needs. */
  const claimableCampaign = {
    campaignId: 'camp-1',
    campaignKey: 'daily-100',
    actionType: 'CLAIM_BENEFIT',
    claimStatus: 'CLAIMABLE',
    benefit: { amount: 100 },
  }

  /** A fetch that answers the campaign list and the claim, recording every header set. */
  function captureRequests(
    campaigns: unknown = { campaigns: [] },
    claim: unknown = { status: 'CLAIMED', benefit: { amount: 100 } },
  ): { fetchImpl: typeof fetch; seen: (Record<string, string> | undefined)[] } {
    const seen: (Record<string, string> | undefined)[] = []
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      seen.push(init?.headers as Record<string, string> | undefined)
      const body = String(url).includes('/claim') ? claim : campaigns
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }) as unknown as typeof fetch
    return { fetchImpl, seen }
  }

  /** The platform word the campaign family is expected to use (§6.7, R3). */
  function expectedCampaignMachineOs(platform = process.platform, arch = process.arch): string {
    const archWord = arch === 'arm64' ? 'aarch64' : 'x86_64'
    const platformWord = platform === 'win32' ? 'win32' : platform === 'darwin' ? 'darwin' : 'linux'
    return `${archWord}_${platformWord}`
  }

  /** The value the INFERENCE path sends; must not move (I-11). */
  function inferenceMachineOs(platform = process.platform, arch = process.arch): string {
    const archWord = arch === 'arm64' ? 'aarch64' : 'x86_64'
    const platformWord = platform === 'win32' ? 'windows' : 'linux'
    return `${archWord}_${platformWord}`
  }

  afterEach(() => {
    // The mode switch and the machine-os override are process-wide: a leaked
    // stub would silently turn the six-header experiment on for every later
    // test in this file.
    vi.unstubAllEnvs()
    vi.resetModules()
  })

  /**
   * The identity headers are what make an international check-in possible at
   * all: the upstream withholds the daily campaign from a request that does
   * not carry a client-minted machine identity. These tests pin the request
   * SHAPE, so a future refactor of the header merge cannot silently drop them
   * again — the failure mode is invisible (HTTP 200, no error, no campaign).
   */
  it('T-M4-4 sends the client machine identity with the campaign request (three mode)', async () => {
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
    // The campaign family must stay byte-identical to the 1.0.0 wire format
    // (rot-guard T3): a build bump on the inference/metadata paths must not
    // move either header here, because the endpoint is risk-gated on it.
    expect(headers['cosy-version']).toBe(campaignCosyVersion)
    expect(headers['user-agent']).toBe(campaignUserAgent)
    // The per-account derived device id/hostname of the inference path must
    // never appear here: the campaign upstream only honours the real client
    // identity, so substituting a derived one would silently empty the list.
    //
    // Stated in the lowercase spelling this merge actually writes (a plain
    // object literal, not a `Headers` instance): the previous check named
    // 'Cosy-Machineid'/'Cosy-Machinehostname', which this code path can never
    // produce, so it passed no matter what was merged in.
    //
    // These three assertions are NOT relaxed by the six-header experiment — the
    // default is still the three native headers, and `six` is a branch that is
    // off unless `QODER_CAMPAIGN_MACHINE_HEADERS=six`. What changed is that the
    // branch is now reachable, so the absence is pinned as a set below instead
    // of one property at a time.
    expect(machineHeaderNames(headers)).toEqual([
      'cosy-machinecode',
      'cosy-machinetoken',
      'cosy-machinetype',
    ])
    expect(headers).not.toHaveProperty('cosy-machineid')
    expect(headers).not.toHaveProperty('cosy-machineos')
    expect(headers).not.toHaveProperty('cosy-machinehostname')
    // And still refuse the inference path's capitalised spelling, which is how
    // a derived identity would arrive if those wire headers were spread in.
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

  /**
   * T-M4-1: the default set is EXACTLY the three native headers (I-01).
   *
   * Pinned as a set, on both requests of a check-in, because the invariant is
   * about what the upstream receives: one extra machine header changes the
   * device fingerprint, and the failure mode of a wrong fingerprint is a silent
   * empty list rather than an error.
   */
  it('T-M4-1 sends exactly the three native machine headers by default (I-01)', async () => {
    vi.stubEnv(CAMPAIGN_MACHINE_HEADERS_ENV, '')
    const { fetchImpl, seen } = captureRequests({ campaigns: [claimableCampaign] })
    const service = new QoderCheckInService({
      authService: createMockAuth(),
      variantId: 'qoder-global',
      region: 'global',
      fetch: fetchImpl,
      riskIdentity: async () => nativeIdentity,
    })
    const result = await service.checkIn('pt-test')

    expect(result.status).toBe('claimed')
    // The list and the claim must present the same identity.
    expect(seen).toHaveLength(2)
    for (const headers of seen) {
      expect(machineHeaderNames(headers)).toEqual([
        'cosy-machinecode',
        'cosy-machinetoken',
        'cosy-machinetype',
      ])
      expect(headers?.['cosy-machinetoken']).toBe('native-token')
      expect(headers?.['cosy-machinecode']).toBe('native-code')
      expect(headers?.['cosy-machinetype']).toBe('native-type')
    }

    // An unrecognised value must fall back to the measured shape. A typo
    // (`six-headers`, `SIX!`) silently enabling the experiment would be the
    // worst of both worlds: unverified headers and nobody knowing why.
    vi.stubEnv(CAMPAIGN_MACHINE_HEADERS_ENV, 'six-headers')
    const second = captureRequests({ campaigns: [claimableCampaign] })
    const typoService = new QoderCheckInService({
      authService: createMockAuth(),
      variantId: 'qoder-global',
      region: 'global',
      fetch: second.fetchImpl,
      riskIdentity: async () => nativeIdentity,
    })
    await typoService.checkIn('pt-test')
    expect(machineHeaderNames(second.seen[0])).toEqual([
      'cosy-machinecode',
      'cosy-machinetoken',
      'cosy-machinetype',
    ])
  })

  /**
   * T-M4-2: `six` mode sends the mixed six-header shape, off by default (I-03).
   *
   * The derived pair is checked against the same derivation the inference path
   * uses, so the two cannot drift apart silently, and the native three are
   * checked to be UNCHANGED: the experiment adds headers, it does not replace
   * the identity that is known to work.
   */
  it('T-M4-2 sends the six-header shape in the experimental mode, id derived from the account (I-03)', async () => {
    vi.stubEnv(CAMPAIGN_MACHINE_HEADERS_ENV, 'six')
    const { fetchImpl, seen } = captureRequests({ campaigns: [claimableCampaign] })
    const service = new QoderCheckInService({
      authService: createMockAuth(),
      variantId: 'qoder-global',
      region: 'global',
      fetch: fetchImpl,
      riskIdentity: async () => nativeIdentity,
      // A real seed file must never decide what a test sends.
      resolveDeviceSeed: () => undefined,
    })
    const result = await service.checkIn('pt-test')

    expect(result.status).toBe('claimed')
    expect(seen).toHaveLength(2)
    for (const headers of seen) {
      expect(machineHeaderNames(headers)).toEqual([
        'cosy-machinecode',
        'cosy-machinehostname',
        'cosy-machineid',
        'cosy-machineos',
        'cosy-machinetoken',
        'cosy-machinetype',
      ])
      // Derived from the ACCOUNT, exactly as the inference path derives it.
      expect(headers?.['cosy-machineid']).toBe(deriveMachineId('u1'))
      // The desktop vocabulary, never the CLI's `windows` spelling.
      expect(headers?.['cosy-machineos']).toBe(campaignMachineOs)
      // Real hostname by default (R4); the derived form is opt-in.
      expect(headers?.['cosy-machinehostname']).toBe(campaignHostname())
      // The native three are untouched by the experiment.
      expect(headers?.['cosy-machinetoken']).toBe('native-token')
      expect(headers?.['cosy-machinecode']).toBe('native-code')
      expect(headers?.['cosy-machinetype']).toBe('native-type')
    }
  })

  /**
   * T-M4-2b: the privacy switch swaps the real hostname for a derived one (R4).
   *
   * The default carries the machine's real hostname because that is the only
   * shape observed working; users who object can opt into the derived value,
   * which the README documents as unverified rather than as equivalent.
   */
  it('T-M4-2b derives the hostname instead when the privacy switch is on (R4)', async () => {
    vi.stubEnv(CAMPAIGN_MACHINE_HEADERS_ENV, 'six')
    vi.stubEnv(CAMPAIGN_DERIVED_HOSTNAME_ENV, '1')
    const { fetchImpl, seen } = captureRequests({ campaigns: [claimableCampaign] })
    const service = new QoderCheckInService({
      authService: createMockAuth(),
      variantId: 'qoder-global',
      region: 'global',
      fetch: fetchImpl,
      riskIdentity: async () => nativeIdentity,
      // A real seed file must never decide what a test sends.
      resolveDeviceSeed: () => undefined,
    })
    await service.checkIn('pt-test')

    const headers = seen[0]
    expect(headers?.['cosy-machinehostname']).toBe(deriveMachineHostname('u1'))
    expect(headers?.['cosy-machinehostname']).toMatch(/^DESKTOP-[0-9A-F]{7}$/u)
    // Only the hostname moves; the other five stay put.
    expect(headers?.['cosy-machineid']).toBe(deriveMachineId('u1'))
    expect(headers?.['cosy-machineos']).toBe(campaignMachineOs)
  })

  /**
   * T-M4-8: the reset seed retires the campaign fingerprint too (R12).
   *
   * `umid reset-native` rotates a host-level seed so that every account gets a
   * fresh derived fingerprint. The campaign path derives its own `machineid` and
   * hostname from that same seed, so a rotated seed must move them — otherwise
   * the reset would leave the campaign request presenting exactly the identity
   * the user just retired, which is the one thing the reset exists to prevent.
   * The three native headers are NOT seeded: they are what the signed component
   * minted, and a reset does not re-mint them.
   */
  it('T-M4-8 derives the campaign fingerprint from the reset seed (R12)', async () => {
    vi.stubEnv(CAMPAIGN_MACHINE_HEADERS_ENV, 'six')
    const unseeded = captureRequests({ campaigns: [] })
    const before = new QoderCheckInService({
      authService: createMockAuth(),
      variantId: 'qoder-global',
      region: 'global',
      fetch: unseeded.fetchImpl,
      riskIdentity: async () => nativeIdentity,
      resolveDeviceSeed: () => undefined,
    })
    await before.checkIn('pt-test')

    const seededRun = captureRequests({ campaigns: [] })
    const after = new QoderCheckInService({
      authService: createMockAuth(),
      variantId: 'qoder-global',
      region: 'global',
      fetch: seededRun.fetchImpl,
      riskIdentity: async () => nativeIdentity,
      resolveDeviceSeed: () => 'a-rotated-seed',
    })
    await after.checkIn('pt-test')

    const seeded = seededRun.seen[0]
    expect(seeded?.['cosy-machineid']).toBe(deriveMachineId('u1', undefined, 'a-rotated-seed'))
    expect(seeded?.['cosy-machineid']).not.toBe(unseeded.seen[0]?.['cosy-machineid'])
    expect(seeded?.['cosy-machinetoken']).toBe('native-token')
    expect(seeded?.['cosy-machinecode']).toBe('native-code')
  })

  /**
   * T-M4-3: no identity means no machine headers at all (I-02).
   *
   * Two halves, because they are two different guarantees: the international
   * region must not send the request (its answer would be indistinguishable
   * from "no campaign today"), while the China region sends it without any
   * machine header — and must keep doing so with the experiment switched on.
   */
  it('T-M4-3 sends no machine headers when this machine has no identity (I-02)', async () => {
    const unreachable = vi.fn(async () => {
      throw new Error('the campaign endpoint must not be reached without an identity')
    }) as unknown as typeof fetch
    const globalService = new QoderCheckInService({
      authService: createMockAuth(),
      variantId: 'qoder-global',
      region: 'global',
      fetch: unreachable,
      riskIdentity: async () => undefined,
    })
    const globalResult = await globalService.checkIn('pt-test')
    expect(globalResult.status).toBe('error')
    expect(globalResult.reasonCode).toBe('no-client')
    expect(unreachable).not.toHaveBeenCalled()

    // China does not gate on the identity, so it still asks — with zero machine
    // headers, even in `six` mode: the mode decides WHICH headers accompany a
    // real identity, never whether a missing one can be invented.
    vi.stubEnv(CAMPAIGN_MACHINE_HEADERS_ENV, 'six')
    const { fetchImpl, seen } = captureRequests({ campaigns: [] })
    const chinaService = new QoderCheckInService({
      authService: createMockAuth(),
      variantId: 'qoder',
      region: 'china',
      fetch: fetchImpl,
      riskIdentity: async () => undefined,
    })
    const chinaResult = await chinaService.checkIn('pt-test')
    expect(chinaResult.status).toBe('no-campaign')
    expect(seen).toHaveLength(1)
    expect(machineHeaderNames(seen[0])).toEqual([])
  })

  /**
   * T-M4-5: the risk-gated fingerprint is byte-identical to 1.0.0 (I-09).
   *
   * These four values are what the upstream's risk check looks at. They are
   * asserted as literals rather than as the constants that feed them, because a
   * refactor that changes both the constant and the assertion would otherwise
   * pass while the wire format moved.
   */
  it('T-M4-5 keeps the frozen campaign wire constants byte-identical (I-09)', async () => {
    expect(qoderDesktopClientType).toBe('10')
    expect(campaignUserAgent).toBe('qoder/1.1.47')
    expect(campaignCosyVersion).toBe('1.0.1')

    const { fetchImpl, seen } = captureRequests({ campaigns: [] })
    const service = new QoderCheckInService({
      authService: createMockAuth(),
      variantId: 'qoder-global',
      region: 'global',
      fetch: fetchImpl,
      riskIdentity: async () => nativeIdentity,
    })
    await service.checkIn('pt-test')

    const headers = seen[0]
    expect(headers?.['cosy-clienttype']).toBe('10')
    expect(headers?.['user-agent']).toBe('qoder/1.1.47')
    expect(headers?.['cosy-version']).toBe('1.0.1')
    // The metadata/inference build is a DIFFERENT pair; a shared constant here
    // is the regression this asserts against.
    expect(headers?.['cosy-version']).not.toBe(metadataCosyVersion)
  })

  /**
   * T-M4-5b: the campaign platform word follows the desktop vocabulary (R3).
   *
   * On Windows the CLI spells the platform `windows` and the desktop app spells
   * it `win32`. A request that claims to be the desktop client (`clienttype 10`
   * + the desktop `cosy-version`) must use the desktop spelling; carrying the
   * CLI's is the cross-field inconsistency a fingerprint check exists to find.
   */
  it('T-M4-5b spells the campaign platform in the desktop vocabulary, with an override (R3)', async () => {
    expect(campaignMachineOs).toBe(expectedCampaignMachineOs())
    if (process.platform === 'win32') {
      expect(campaignMachineOs.endsWith('_win32')).toBe(true)
      expect(campaignMachineOs).not.toContain('windows')
    }

    // `QODER_COSY_MACHINE_OS` replaces the whole value, for a machine whose
    // platform we detect wrongly.
    vi.stubEnv(QODER_COSY_MACHINE_OS_ENV, 'aarch64_darwin')
    vi.resetModules()
    const overridden = await import('../src/qoder/transport/wire/cosy.ts')
    expect(overridden.campaignMachineOs).toBe('aarch64_darwin')

    // `auto` (and an empty value) means detect.
    vi.stubEnv(QODER_COSY_MACHINE_OS_ENV, 'auto')
    vi.resetModules()
    const detected = await import('../src/qoder/transport/wire/cosy.ts')
    expect(detected.campaignMachineOs).toBe(expectedCampaignMachineOs())
  })

  /**
   * T-M4-6: nothing on the inference path moves (I-11).
   *
   * Installing a component, or flipping the campaign vocabulary, must not
   * change one inference header — those are live fingerprints on every existing
   * account. The check is behavioural: build the inference headers twice, once
   * with the campaign override in the environment, and compare.
   */
  it('T-M4-6 leaves the inference headers byte-identical when the campaign vocabulary moves (I-11)', async () => {
    const creds = {
      userID: 'u1',
      authToken: 'token',
      name: 'User',
      email: 'user@example.invalid',
      derivedMachineID: 'derived-id',
      machineHostname: 'DESKTOP-ABC1234',
    }
    const url = 'https://api.example.invalid/algo/v1/chat'
    const before = buildAuthHeaders('{}', url, creds, { includeMachineHostname: true })

    expect(before['Cosy-Machineos']).toBe(inferenceMachineOs())
    expect(before['Cosy-Clienttype']).toBe('5')
    expect(before['Cosy-Machineid']).toBe('derived-id')
    expect(before['Cosy-Machinehostname']).toBe('DESKTOP-ABC1234')

    vi.stubEnv(QODER_COSY_MACHINE_OS_ENV, 'aarch64_darwin')
    vi.resetModules()
    const fresh = await import('../src/qoder/transport/wire/cosy.ts')
    // The campaign constant DID move...
    expect(fresh.campaignMachineOs).toBe('aarch64_darwin')
    // ...and not one inference header did.
    const after = fresh.buildAuthHeaders('{}', url, creds, { includeMachineHostname: true })
    for (const name of [
      'Cosy-Machineos',
      'Cosy-Clienttype',
      'Cosy-Machineid',
      'Cosy-Machinetoken',
      'Cosy-Machinetype',
      'Cosy-Machinehostname',
      'Cosy-Version',
    ]) {
      expect(after[name]).toBe(before[name])
    }
    // `qoderMachineOs` stays module-private on purpose: an export is the
    // invitation for the campaign path to reuse the CLI's vocabulary, which is
    // the exact mistake R3 exists to prevent.
    expect(Object.keys(fresh)).not.toContain('qoderMachineOs')
  })
})
