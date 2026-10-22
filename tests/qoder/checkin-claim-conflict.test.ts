/**
 * HTTP 409 from ClaimCampaign: a refusal, reported honestly and idempotently.
 *
 * Observed live on the China variant (`qoder`) while the Global variant
 * (`qoder-global`) reports 「今日已完成签到」: the claim endpoint answers 409 and
 * the transport renders that as
 * `Failed to execute Qoder ClaimCampaign with status 409.`, which the card then
 * prints verbatim as `自动签到出错：…`. That string names the mechanism, not the
 * meaning — the upstream uses 409 to say "this benefit is already accounted for
 * or is not claimable right now", and only the campaign list can tell the two
 * apart. These tests pin the resolution rule: re-read the campaign list exactly
 * once and answer from its authoritative `claimStatus`, never claiming a
 * benefit the upstream did not grant.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { QoderCheckInService } from '../../src/qoder/transport/checkin.ts'
import type { QoderAuthService } from '../../src/qoder/transport/auth.ts'

const campaignsPath = '/sash/api/v1/me/campaigns'
const claimPath = '/sash/api/v1/me/campaigns/camp-123/claim'

interface CampaignFixture {
  claimStatus: string
  campaignKey?: string
  amount?: number
}

function authService(token = 'mock-job-token'): QoderAuthService {
  return {
    getCredentials: async () => ({
      authToken: token,
      userID: 'u1',
      name: 'User',
      email: 'u@test.com',
      machineID: 'm1',
    }),
    exchangeFresh: async () => ({
      authToken: `${token}-fresh`,
      userID: 'u1',
      name: 'User',
      email: 'u@test.com',
      machineID: 'm1',
    }),
    clear: () => undefined,
  } as unknown as QoderAuthService
}

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

function campaignBody(campaign: CampaignFixture): unknown {
  return {
    claimable: campaign.claimStatus === 'CLAIMABLE',
    campaigns: [
      {
        campaignId: 'camp-123',
        campaignKey: campaign.campaignKey ?? 'daily-100',
        actionType: 'CLAIM_BENEFIT',
        claimStatus: campaign.claimStatus,
        benefit: { kind: 'CREDITS', amount: campaign.amount ?? 100, validity: { mode: 'DAYS', days: 30 } },
      },
    ],
  }
}

interface HarnessOptions {
  /** What the campaign list says on each successive read. */
  campaignReads: CampaignFixture[]
  /** Status of the claim POST; a 200 answers with `CLAIMED`. */
  claimStatus: number
  disabledToken?: string
}

function harness(options: HarnessOptions): {
  service: QoderCheckInService
  campaignReads: () => number
  claimCalls: () => number
} {
  let campaignIndex = 0
  let campaignCount = 0
  let claimCount = 0

  const fetchMock = async (input: URL | Request | string, init?: RequestInit): Promise<Response> => {
    const url = String(input)
    if (url.includes(campaignsPath) && !url.includes('/claim')) {
      campaignCount++
      const fixture = options.campaignReads[Math.min(campaignIndex, options.campaignReads.length - 1)]
      campaignIndex++
      if (fixture === undefined) throw new Error('campaign list read more often than scripted')
      return json(campaignBody(fixture))
    }
    if (url.includes(claimPath)) {
      claimCount++
      assert.equal(init?.method, 'POST')
      if (options.claimStatus === 200) {
        return json({ status: 'CLAIMED', benefit: { kind: 'CREDITS', amount: 100 } })
      }
      return new Response('{"code":"CONFLICT","message":"already claimed"}', {
        status: options.claimStatus,
        headers: { 'content-type': 'application/json' },
      })
    }
    throw new Error(`unexpected URL: ${url}`)
  }

  const service = new QoderCheckInService({
    authService: authService(),
    variantId: 'qoder',
    region: 'china',
    fetch: fetchMock as unknown as typeof fetch,
    // China does not gate on the machine identity; stubbing it keeps the suite
    // hermetic instead of shelling out to the host's real client helper.
    riskIdentity: async () => undefined,
  })

  return { service, campaignReads: () => campaignCount, claimCalls: () => claimCount }
}

test('409 followed by CLAIMED on the campaign list reads as already-claimed', async () => {
  const { service, campaignReads } = harness({
    campaignReads: [{ claimStatus: 'CLAIMABLE' }, { claimStatus: 'CLAIMED' }],
    claimStatus: 409,
  })

  const result = await service.checkIn('pt-test')

  assert.equal(result.status, 'already-claimed')
  assert.equal(result.message, 'Already claimed today')
  assert.equal(result.campaignKey, 'daily-100')
  assert.equal(result.amount, 100)
  // The validity window (30 days) is the only expiry source here; the claim
  // never returned one because it was refused.
  assert.equal(typeof result.expiresAtMs, 'number')
  assert.equal(result.reasonCode, undefined)
  // Exactly one re-read on top of the initial list read, and the refused claim
  // was never retried.
  assert.equal(campaignReads(), 2)
})

test('409 with the campaign still claimable is an error naming the conflict', async () => {
  const { service, campaignReads } = harness({
    campaignReads: [{ claimStatus: 'CLAIMABLE' }, { claimStatus: 'CLAIMABLE' }],
    claimStatus: 409,
  })

  const result = await service.checkIn('pt-test')

  assert.equal(result.status, 'error')
  assert.equal(result.reasonCode, 'claim-conflict')
  // The transport's own wording must not be what the card prints.
  assert.doesNotMatch(result.message ?? '', /Failed to execute Qoder/u)
  assert.doesNotMatch(result.message ?? '', /with status 409/u)
  // And it must not read as a granted benefit.
  assert.doesNotMatch(result.message ?? '', /Successfully claimed/u)
  assert.match(result.message ?? '', /no credits were granted/u)
  assert.equal(result.campaignKey, 'daily-100')
  assert.equal(result.amount, undefined)
  // One list read, one re-read — no retry loop, no second claim.
  assert.equal(campaignReads(), 2)
})

test('a 409 whose re-read no longer lists the campaign stays an error', async () => {
  // Nothing is granted when the campaign vanished between the two reads: the
  // re-read proves absence, not a claim.
  let campaignCount = 0
  let claimCount = 0
  const fetchMock = async (input: URL | Request | string): Promise<Response> => {
    const url = String(input)
    if (url.includes(campaignsPath) && !url.includes('/claim')) {
      campaignCount++
      // First read: claimable. Re-read: no CLAIM_BENEFIT campaign at all.
      return campaignCount === 1
        ? json(campaignBody({ claimStatus: 'CLAIMABLE' }))
        : json({ claimable: false, campaigns: [] })
    }
    if (url.includes(claimPath)) {
      claimCount++
      return new Response('{}', { status: 409, headers: { 'content-type': 'application/json' } })
    }
    throw new Error(`unexpected URL: ${url}`)
  }

  const service = new QoderCheckInService({
    authService: authService(),
    variantId: 'qoder',
    region: 'china',
    fetch: fetchMock as unknown as typeof fetch,
    riskIdentity: async () => undefined,
  })

  const result = await service.checkIn('pt-test')

  assert.equal(result.status, 'error')
  assert.equal(result.reasonCode, 'claim-conflict')
  assert.match(result.message ?? '', /no longer listed/u)
  assert.equal(campaignCount, 2)
  assert.equal(claimCount, 1)
})

test('a non-409 claim failure is unchanged', async () => {
  const { service, campaignReads } = harness({
    campaignReads: [{ claimStatus: 'CLAIMABLE' }],
    claimStatus: 500,
  })

  const result = await service.checkIn('pt-test')

  assert.equal(result.status, 'error')
  // No claim-conflict classification, and no extra campaign read: only a 409
  // triggers the re-read.
  assert.equal(result.reasonCode, undefined)
  assert.match(result.message ?? '', /Failed to execute Qoder ClaimCampaign with status 500\./u)
  assert.equal(campaignReads(), 1)
})

test('a 409 on the first claim is followed by exactly one campaign re-read', async () => {
  const { service, campaignReads, claimCalls } = harness({
    // A CLAIMED re-read makes the happy resolution the one under test here, so
    // the read count is attributable to the 409 rather than to a later step.
    campaignReads: [{ claimStatus: 'CLAIMABLE' }, { claimStatus: 'CLAIMED' }],
    claimStatus: 409,
  })

  const result = await service.checkIn('pt-test')

  assert.equal(result.status, 'already-claimed')
  assert.equal(campaignReads(), 2)
  assert.equal(claimCalls(), 1)

  // Scripting a third campaign fixture would let a runaway retry show up as an
  // exhausted script rather than a silent extra read; the counts above are the
  // exact guarantee: initial read + one re-read.
})
