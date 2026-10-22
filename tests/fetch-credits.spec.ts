import { describe, expect, it, vi } from 'vitest'
import { QoderUpstreamClient } from '../src/upstream.ts'
import { webPlan } from '../src/web-status.ts'
import type { QoderAccountInfo } from '../src/qoder/account.ts'
import type { QoderTransport } from '../src/qoder/transport/index.ts'

/**
 * The credit parse in all its shapes: how `fetchCredits` maps one
 * `readAccount` answer onto the card's `QoderCredits`, and what the expiry
 * fields do. `expiresAt` is the account's cycle boundary: it reaches
 * `cycleResetTime` only. Package rows never borrow it — the live 2026-09-27
 * account showed one year-9999 "no expiry" sentinel copied onto all three
 * rows that way. Rows carry no expiry until the upstream reports a real
 * per-package one (today's `quota/usage` has no such field).
 */

function clientFor(account: QoderAccountInfo | undefined, readAccount?: QoderTransport['readAccount']) {
  const reader = readAccount ?? (vi.fn(async () => {
    if (account === undefined) throw new Error('account scripted absent')
    return account
  }) as never)
  const transport = {
    stream: () => { throw new Error('not used') },
    discoverModels: async () => [],
    readAccount: reader,
  } as unknown as QoderTransport
  return new QoderUpstreamClient({
    region: 'china',
    providerId: 'qoder',
    getPat: async () => 'pt-test',
    transport,
  })
}

function account(usage: QoderAccountInfo['usage']): QoderAccountInfo {
  return {
    profile: { id: 'u1', name: 'Qoder User', email: 'u@example.com' },
    ...(usage === undefined ? {} : { usage }),
    updatedAt: '2026-09-18T00:00:00Z',
  }
}

describe('fetchCredits shapes', () => {
  it('answers an account with no usage as zero credits and no packages', async () => {
    await expect(clientFor(account(undefined)).fetchCredits()).resolves.toEqual({
      total: 0, totalSize: 0, accounts: [],
    })
  })

  it('renders a personal quota as one package row without expiry fields', async () => {
    const credits = await clientFor(account({
      userQuota: { total: 100, used: 25, remaining: 75, percentage: 25, unit: 'credits' },
    })).fetchCredits()
    expect(credits).toEqual({
      total: 25,
      totalSize: 100,
      accounts: [{ packageName: '个人额度', remain: 75, size: 100 }],
    })
  })

  it('appends the organization package; the cycle field rides only cycleResetTime', async () => {
    const credits = await clientFor(account({
      userQuota: { total: 100, used: 30, remaining: 70, percentage: 30, unit: 'credits' },
      orgResourcePackage: { total: 500, used: 100, remaining: 400, percentage: 20, unit: 'credits' },
      totalUsagePercentage: 33,
      isQuotaExceeded: true,
      expiresAt: '2026-10-01T00:00:00Z',
    })).fetchCredits()
    expect(credits.accounts).toEqual([
      { packageName: '个人额度', remain: 70, size: 100 },
      { packageName: '组织资源包', remain: 400, size: 500 },
    ])
    expect(credits.total).toBe(33)
    expect(credits.totalSize).toBe(600)
    expect(credits.cycleResetTime).toBe('2026-10-01T00:00:00Z')
    expect('unlimited' in credits).toBe(false)
  })

  it('reads an uncapped personal allowance as unlimited', async () => {
    const credits = await clientFor(account({
      userQuota: { total: 0, used: 5, remaining: 0, percentage: 0, unit: 'credits' },
      isQuotaExceeded: false,
    })).fetchCredits()
    expect(credits.unlimited).toBe(true)
  })

  it('passes the cycle string through verbatim, even an empty one', async () => {
    // The WorkBuddy parser dropped empty PackageEndTime strings; the Qoder
    // answer has one expiresAt field checked for presence only. Locking the
    // difference so a "cleanup" here is a visible decision, not a silent one.
    const credits = await clientFor(account({
      userQuota: { total: 10, used: 1, remaining: 9, percentage: 10, unit: 'credits' },
      expiresAt: '',
    })).fetchCredits()
    expect(credits.accounts[0]).toEqual({ packageName: '个人额度', remain: 9, size: 10 })
    expect(credits.cycleResetTime).toBe('')
  })

  it('lists bonus credits as their own package beside the plan', async () => {
    // Observed live: the account holds userQuota (300) and addOnQuota (100, the
    // daily campaign's credits). Mapping only the first made the card list one
    // package where the web listed two.
    const credits = await clientFor(account({
      userQuota: { total: 300, used: 0, remaining: 300, percentage: 0.01, unit: 'credits' },
      addOnQuota: { total: 100, used: 0, remaining: 100, percentage: 0, unit: 'credits' },
    })).fetchCredits()
    expect(credits.accounts.map(entry => entry.packageName)).toEqual(['个人额度', '赠送额度'])
    expect(credits.accounts[1]).toMatchObject({ remain: 100, size: 100 })
    // The cycle total now counts every bucket the account holds.
    expect(credits.totalSize).toBe(400)
  })

  it('omits the bonus package entirely when the upstream does not report one', async () => {
    const credits = await clientFor(account({
      userQuota: { total: 300, used: 0, remaining: 300, percentage: 0.01, unit: 'credits' },
    })).fetchCredits()
    expect(credits.accounts.map(entry => entry.packageName)).toEqual(['个人额度'])
  })

  it('always asks the transport for a fresh read', async () => {
    const readAccount = vi.fn(async () => account(undefined))
    await clientFor(undefined, readAccount as never).fetchCredits()
    expect(readAccount).toHaveBeenCalledWith({ force: true })
  })

  it('forwards the caller\'s coalescing window without softening the force', async () => {
    const readAccount = vi.fn(async () => account(undefined))
    await clientFor(undefined, readAccount as never).fetchCredits(undefined, { maxAgeMs: 5_000 })
    // Force still says "this is the read the user is looking at"; the window
    // only lets the reader answer a same-credential burst from its last read.
    expect(readAccount).toHaveBeenCalledWith({ force: true, minIntervalMs: 5_000 })
  })

  it('omits the window entirely when the caller did not ask for one', async () => {
    const readAccount = vi.fn(async () => account(undefined))
    const controller = new AbortController()
    await clientFor(undefined, readAccount as never).fetchCredits(controller.signal)
    expect(readAccount).toHaveBeenCalledWith({ force: true, signal: controller.signal })
  })

  it('propagates an upstream failure for the status route to classify', async () => {
    const reader = vi.fn(async () => { throw new Error('AUTH 401') })
    await expect(clientFor(undefined, reader as never).fetchCredits()).rejects.toThrow('AUTH 401')
  })
})

/**
 * `fetchAccountBilling` prices a SPECIFIC pooled token — the composer panel
 * shows what every saved account still holds, not just the one that signs.
 *
 * The invariant under test is that reading a spare account is a pure read: it
 * must not relabel the ambient credential the headline row describes, and it
 * must not force a fresh upstream call (the panel re-reads on every status
 * poll, so the account reader's per-token cache is what keeps that bounded).
 */
describe('fetchAccountBilling: per-account pricing without adoption', () => {
  function clientWith(reader: QoderTransport['readAccount']) {
    const transport = {
      stream: () => { throw new Error('not used') },
      discoverModels: async () => [],
      readAccount: reader,
    } as unknown as QoderTransport
    return new QoderUpstreamClient({
      region: 'china',
      providerId: 'qoder',
      getPat: async () => 'pt-ambient',
      transport,
    })
  }

  it('names the account it reads and lets the reader cache answer', async () => {
    const readAccount = vi.fn(async () => account({
      userQuota: { total: 100, used: 25, remaining: 75, percentage: 25, unit: 'credits' },
    }))
    await clientWith(readAccount as never).fetchAccountBilling('pt-spare')
    // `pat` names the account; no `force`, so the reader's TTL cache and
    // single-flight absorb the panel's repeated polls.
    expect(readAccount).toHaveBeenCalledWith({ pat: 'pt-spare' })
  })

  it('reports the spare account name without relabelling the ambient one', async () => {
    const reader = vi.fn(async (options?: { pat?: string }) => ({
      profile: {
        id: 'u1',
        name: options?.pat === 'pt-spare' ? 'Spare Saver' : 'Ambient Owner',
        email: 'u@example.com',
      },
      updatedAt: '2026-09-18T00:00:00Z',
    }))
    const client = clientWith(reader as never)
    // The ambient read is what the card's headline row describes.
    await client.fetchCredits()
    expect(client.accountName).toBe('Ambient Owner')

    const billing = await client.fetchAccountBilling('pt-spare')
    expect(billing.accountName).toBe('Spare Saver')
    // Load-bearing: the spare account's name must not become the ambient
    // credential's name, or the card would relabel the account in use.
    expect(client.accountName).toBe('Ambient Owner')
  })

  it('omits a name the upstream did not report and keeps the plan beside it', async () => {
    const reader = vi.fn(async () => ({
      profile: { id: 'u1', name: '', email: 'u@example.com' },
      plan: { planTierName: 'Pro', endDate: '2026-12-31T00:00:00Z' },
      usage: { userQuota: { total: 100, used: 0, remaining: 100, percentage: 0, unit: 'credits' } },
      updatedAt: '2026-09-18T00:00:00Z',
    }))
    const billing = await clientWith(reader as never).fetchAccountBilling('pt-spare')
    expect(billing.accountName).toBeUndefined()
    expect(billing.plan?.planTierName).toBe('Pro')
    expect(billing.credits).toMatchObject({ totalSize: 100 })
  })

  it('propagates a failure so one broken account can be priced as unknown', async () => {
    const reader = vi.fn(async () => { throw new Error('AUTH 401') })
    await expect(clientWith(reader as never).fetchAccountBilling('pt-dead')).rejects.toThrow('AUTH 401')
  })
})

/**
 * `webPlan` is the one projection both the headline row and every pooled row
 * use; two projections would let the same subscription appear under two names.
 */
describe('webPlan projection', () => {
  it('carries only the rendered fields and reduces the organization to a name', () => {
    expect(webPlan({
      userType: 'personal',
      planTierName: 'Pro',
      isPersonalVersion: true,
      organization: { orgName: 'Acme', orgId: 'org-1' },
      endDate: '2026-12-31T00:00:00Z',
    })).toEqual({ planTierName: 'Pro', organizationName: 'Acme', endDate: '2026-12-31T00:00:00Z' })
  })

  it('omits fields the upstream did not send instead of inventing them', () => {
    expect(webPlan({ userType: 'personal', planTierName: 'Free', isPersonalVersion: true }))
      .toEqual({ planTierName: 'Free' })
  })

  it('answers undefined for an account with no plan', () => {
    expect(webPlan(undefined)).toBeUndefined()
  })
})
