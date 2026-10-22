/** Qoder subscriber profile and quota usage querying. */

import type { QoderAuthService } from './auth.ts'
import {
  getQoderUsageUrl,
  getQoderUserPlanUrl,
  getQoderUserStatusUrl,
  type QoderRegion,
} from './endpoints.ts'
import { QODER_UNKNOWN_SUBSCRIBER_NAME } from '../account.ts'
import type {
  QoderAccountInfo,
  QoderQuota,
  QoderQuotaUsage,
  QoderSubscriberFeatureAllowed,
  QoderSubscriberOrganization,
  QoderSubscriberPlan,
  QoderSubscriberProfile,
  QoderSubscriberStatus,
} from '../account.ts'
import { QoderLlmError, isQoderAuthRejection } from '../errors.ts'
import type { QoderLogger } from './logging.ts'
import {
  opaqueCredentialKey,
  openApiJsonRequest,
  retryMetadataRead,
  SingleFlight,
} from './request.ts'

const defaultUsageTtlMs = 60_000
const defaultUsageTimeoutMs = 15_000

export interface QoderUsageReaderOptions {
  authService: QoderAuthService
  fetch?: typeof fetch | undefined
  ttlMs?: number | undefined
  timeoutMs?: number | undefined
  region?: QoderRegion | undefined
  logger?: QoderLogger | undefined
}


interface RawQuota {
  total?: number
  cap?: number
  used?: number
  remaining?: number
  percentage?: number
  unit?: string
  available?: boolean
}

interface RawUsageInfo {
  userQuota?: RawQuota
  orgResourcePackage?: RawQuota
  /** Bonus credits granted beside the plan (the daily campaign's 100). */
  addOnQuota?: RawQuota
  totalUsagePercentage?: number
  isQuotaExceeded?: boolean
  expiresAt?: number | string
  userType?: string
  upgradeUrl?: string
}

function normalizeQuota(raw?: RawQuota): QoderQuota | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const total = typeof raw.total === 'number' && Number.isFinite(raw.total)
    ? raw.total
    : (typeof raw.cap === 'number' && Number.isFinite(raw.cap)
      ? raw.cap
      : (typeof raw.remaining === 'number' && typeof raw.used === 'number'
        ? raw.used + raw.remaining
        : 0))
  const used = typeof raw.used === 'number' && Number.isFinite(raw.used) ? raw.used : 0
  const remaining = typeof raw.remaining === 'number' && Number.isFinite(raw.remaining)
    ? raw.remaining
    : Math.max(0, total - used)

  let percentage: number
  if (typeof raw.percentage === 'number' && Number.isFinite(raw.percentage)) {
    percentage = raw.percentage <= 1 && total > 1 ? raw.percentage * 100 : raw.percentage
  } else {
    percentage = total > 0 ? (used / total) * 100 : 0
  }

  const unit = typeof raw.unit === 'string' && raw.unit.length > 0 ? raw.unit : 'credits'

  return { total, used, remaining, percentage, unit }
}


/**
 * Qoder 表示「无到期」的哨兵值：9999-12-31T00:00:00Z。
 * 实测于 GET /api/v2/quota/usage：`expiresAt: 253402214400000`（毫秒），
 * 在 Asia/Shanghai 渲染成「9999年12月31日 08:00」—— 这正是要修的 bug。
 * 该值是完全合法的日期，会通过一切 `> 0` 检查，所以必须在日期层面识别：
 * UTC 年份 ≥ 9999 即哨兵，归一化为 undefined（渲染为「无到期」），绝不打印成截止日。
 */
function isPerpetualSentinel(ms: number): boolean {
  return new Date(ms).getUTCFullYear() >= 9999
}

/** 数字纪元统一为毫秒：秒级(< 1e12)×1000，毫秒级原样。读错单位会把秒当 1970 年。 */
function epochToMs(value: number): number {
  return value < 1e12 ? value * 1000 : value
}

function normalizeExpiresAt(rawExpires?: number | string): string | undefined {
  if (rawExpires === undefined || rawExpires === null) return undefined
  if (typeof rawExpires === 'number' && rawExpires > 0) {
    const ms = epochToMs(rawExpires)
    if (isPerpetualSentinel(ms)) return undefined
    return new Date(ms).toISOString()
  }
  if (typeof rawExpires === 'string' && rawExpires.length > 0) {
    const parsed = Date.parse(rawExpires)
    if (!Number.isNaN(parsed) && parsed > 0) {
      if (isPerpetualSentinel(parsed)) return undefined
      return new Date(parsed).toISOString()
    }
  }
  return undefined
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined
}

function asBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined
}

function asNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim().length > 0) {
    const num = Number(value)
    if (Number.isFinite(num)) return num
  }
  return undefined
}

function normalizeOrganization(raw: unknown): QoderSubscriberOrganization | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const obj = raw as Record<string, unknown>
  const orgId = asString(obj.org_id) ?? asString(obj.orgId) ?? asString(obj.id)
  const orgName = asString(obj.org_name) ?? asString(obj.orgName) ?? asString(obj.name)
  if (!orgId || !orgName) return undefined
  return {
    orgId,
    orgName,
    ...asString(obj.role_name) ?? asString(obj.roleName) !== undefined
      ? { roleName: asString(obj.role_name) ?? asString(obj.roleName) }
      : {},
    isSuspended: asBoolean(obj.is_suspended) ?? asBoolean(obj.isSuspended) ?? false,
    canManageSubscriptions: asBoolean(obj.can_manage_subscriptions) ?? asBoolean(obj.canManageSubscriptions) ?? false,
    resourcePackageFeatureEnabled: asBoolean(obj.resource_package_feature_enabled) ?? asBoolean(obj.resourcePackageFeatureEnabled) ?? false,
  }
}

function normalizeFeatureAllowed(raw: unknown): QoderSubscriberFeatureAllowed | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const obj = raw as Record<string, unknown>
  return {
    quest: asBoolean(obj.quest) ?? false,
    wiki: asBoolean(obj.wiki) ?? false,
    codeReview: asBoolean(obj.code_review) ?? asBoolean(obj.codeReview) ?? false,
  }
}

function normalizePlan(raw: unknown): QoderSubscriberPlan | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const obj = raw as Record<string, unknown>
  const userType = asString(obj.user_type) ?? asString(obj.userType)
  const planTierName = asString(obj.plan_tier_name) ?? asString(obj.planTierName) ?? asString(obj.plan_name) ?? asString(obj.planName)
  if (!userType || !planTierName) return undefined

  const organization = normalizeOrganization(obj.organization)
  const isPersonalVersion = asBoolean(obj.is_personal_version) ?? asBoolean(obj.isPersonalVersion) ?? (organization === undefined)
  const startDate = normalizeExpiresAt(obj.start_date as number | string ?? obj.startDate as number | string)
  const endDate = normalizeExpiresAt(obj.end_date as number | string ?? obj.endDate as number | string)
  const planTier = asString(obj.plan_tier) ?? asString(obj.planTier)
  const isHighestTier = asBoolean(obj.is_highest_tier) ?? asBoolean(obj.isHighestTier)
  const isRenewed = asBoolean(obj.is_renewed) ?? asBoolean(obj.isRenewed)
  const featureAllowed = normalizeFeatureAllowed(obj.feature_allowed ?? obj.featureAllowed)

  return {
    userType,
    planTierName,
    ...planTier !== undefined ? { planTier } : {},
    isPersonalVersion,
    ...isHighestTier !== undefined ? { isHighestTier } : {},
    ...isRenewed !== undefined ? { isRenewed } : {},
    ...startDate !== undefined ? { startDate } : {},
    ...endDate !== undefined ? { endDate } : {},
    ...organization !== undefined ? { organization } : {},
    ...featureAllowed !== undefined ? { featureAllowed } : {},
    raw,
  }
}

function normalizeStatus(raw: unknown): QoderSubscriberStatus | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const obj = raw as Record<string, unknown>
  const featureSwitches = (obj.featureSwitches ?? obj.feature_switches) as Record<string, unknown> | undefined
  const teamSwitches = (obj.teamSwitches ?? obj.team_switches) as Record<string, unknown> | undefined
  const allowByok = asNumber(featureSwitches?.allow_byok ?? featureSwitches?.allowByok) ?? 0
  const teamAllowByok = asNumber(teamSwitches?.allow_byok ?? teamSwitches?.allowByok)
  const isPrivacyPolicyModifiable = asBoolean(obj.isPrivacyPolicyModifiable ?? obj.is_data_policy_modifiable)

  return {
    allowByok,
    ...teamAllowByok !== undefined ? { teamAllowByok } : {},
    ...isPrivacyPolicyModifiable !== undefined ? { isPrivacyPolicyModifiable } : {},
    raw,
  }
}

export class QoderUsageReader {
  private readonly authService: QoderAuthService
  private readonly fetchImpl: typeof fetch
  private readonly ttlMs: number
  private readonly timeoutMs: number
  private readonly region: QoderRegion
  private readonly logger: QoderLogger | undefined
  private readonly cache = new Map<string, { info: QoderAccountInfo; expiresAt: number; fetchedAtMs: number }>()
  private readonly flights = new SingleFlight<QoderAccountInfo>()

  constructor(options: QoderUsageReaderOptions) {
    this.authService = options.authService
    this.fetchImpl = options.fetch ?? globalThis.fetch
    this.ttlMs = options.ttlMs ?? defaultUsageTtlMs
    this.timeoutMs = options.timeoutMs ?? defaultUsageTimeoutMs
    this.region = options.region ?? 'global'
    this.logger = options.logger
  }

  async readAccount(
    pat: string,
    options?: { force?: boolean | undefined; signal?: AbortSignal | undefined; minIntervalMs?: number | undefined },
  ): Promise<QoderAccountInfo> {
    if (!pat || typeof pat !== 'string') {
      throw new QoderLlmError(
        'Qoder Personal Access Token is missing or invalid.',
        'MISSING_CREDENTIAL',
      )
    }

    const cacheKey = `${this.region}:${opaqueCredentialKey(pat)}`
    const cached = this.cache.get(cacheKey)
    const now = Date.now()

    if (!options?.force) {
      if (cached && cached.expiresAt > now) {
        return cached.info
      }
    } else if (options?.minIntervalMs !== undefined && cached !== undefined
      && now - cached.fetchedAtMs < options.minIntervalMs) {
      /*
       * A forced read that is already this recent is reused.
       *
       * The status route is read by a page that mounts, prefetches the other
       * variant, and polls; forcing every one of those reads spent a billing
       * round trip each, and the page then painted identical numbers. The
       * cache key carries the credential, so an account switch never reuses
       * the previous account's answer — only a burst of the same read does.
       */
      return cached.info
    }

    return this.flights.run(
      cacheKey,
      options?.signal,
      sharedSignal => this.loadAccount(pat, sharedSignal, cacheKey),
      () => new QoderLlmError('Qoder account request was aborted.', 'ABORTED'),
    )
  }

  private async loadAccount(
    pat: string,
    signal: AbortSignal,
    cacheKey: string,
  ): Promise<QoderAccountInfo> {
    try {
      return await this.loadAccountWith(pat, signal, cacheKey)
    } catch (error) {
      // The cached job token can outlive the upstream's acceptance of it; one
      // fresh exchange self-heals that window instead of surfacing the card's
      // quota read as an auth failure until the next credential save.
      if (!isQoderAuthRejection(error) || signal.aborted) throw error
      this.logger?.warn?.('[Qoder Account] Usage read rejected as unauthorized; exchanging a fresh job token and retrying once')
    }
    this.authService.clear(pat)
    return this.loadAccountWith(pat, signal, cacheKey)
  }

  private async loadAccountWith(
    pat: string,
    signal: AbortSignal,
    cacheKey: string,
  ): Promise<QoderAccountInfo> {
    const creds = await this.authService.getCredentials(pat, signal)
    const profile: QoderSubscriberProfile = {
      id: creds.userID,
      // Qoder substitutes a placeholder when an account carries no name. It is
      // a wire value, not an identity: blank it here so every reader treats the
      // account as unnamed, instead of the card announcing a subscriber called
      // "Qoder User". `upstream.fetchCredits` maps '' to "no name to show".
      name: creds.name === QODER_UNKNOWN_SUBSCRIBER_NAME ? '' : creds.name,
      email: creds.email || '',
    }

    /*
     * Every member of the metadata family carries the device identity, not just
     * the status probe. The desktop client sends one fingerprint across the
     * whole family; a plan or quota call that omits `Cosy-MachineToken` is a
     * device the backend has never seen signed in, which is exactly the shape a
     * shared-credential observer filters for. `wire/cosy.ts` and `auth.ts` both
     * document that promise; until now only the status call kept it.
     */
    const machineId = creds.machineID
    const [usage, plan, status] = await Promise.all([
      retryMetadataRead(signal, () => this.fetchUsage(creds.authToken, machineId, signal)),
      this.safeFetchPlan(creds.authToken, machineId, signal),
      this.safeFetchStatus(creds.authToken, machineId, signal),
    ])

    const accountInfo: QoderAccountInfo = {
      profile,
      usage,
      ...plan !== undefined ? { plan } : {},
      ...status !== undefined ? { status } : {},
      updatedAt: new Date().toISOString(),
    }

    this.cache.set(cacheKey, {
      info: accountInfo,
      expiresAt: Date.now() + this.ttlMs,
      fetchedAtMs: Date.now(),
    })

    return accountInfo
  }

  clear(pat?: string): void {
    if (pat) {
      this.cache.delete(`${this.region}:${opaqueCredentialKey(pat)}`)
    } else {
      this.cache.clear()
    }
  }

  private async fetchUsage(
    jobToken: string,
    machineId?: string,
    signal?: AbortSignal,
  ): Promise<QoderQuotaUsage> {
    const data = await openApiJsonRequest<RawUsageInfo>(this.fetchImpl, {
      url: getQoderUsageUrl(this.region),
      token: jobToken,
      machineId,
      signal,
      timeoutMs: this.timeoutMs,
      logger: this.logger,
      operation: 'Usage',
      logCategory: 'account.usage',
    })

    return {
      userQuota: normalizeQuota(data.userQuota),
      orgResourcePackage: normalizeQuota(data.orgResourcePackage),
      addOnQuota: normalizeQuota(data.addOnQuota),
      totalUsagePercentage: typeof data.totalUsagePercentage === 'number' ? data.totalUsagePercentage : undefined,
      isQuotaExceeded: typeof data.isQuotaExceeded === 'boolean' ? data.isQuotaExceeded : false,
      expiresAt: normalizeExpiresAt(data.expiresAt),
      raw: data,
    }
  }

  private async fetchPlan(
    jobToken: string,
    machineId?: string,
    signal?: AbortSignal,
  ): Promise<QoderSubscriberPlan | undefined> {
    const data = await openApiJsonRequest<unknown>(this.fetchImpl, {
      url: getQoderUserPlanUrl(this.region),
      token: jobToken,
      machineId,
      signal,
      timeoutMs: this.timeoutMs,
      logger: this.logger,
      operation: 'Plan',
      logCategory: 'account.plan',
    })
    return normalizePlan(data)
  }

  private async safeFetchPlan(
    jobToken: string,
    machineId: string | undefined,
    signal: AbortSignal,
  ): Promise<QoderSubscriberPlan | undefined> {
    try {
      return await this.fetchPlan(jobToken, machineId, signal)
    } catch (error) {
      if (signal.aborted) throw error
      this.logger?.warn?.('[Qoder Plan] Failed to load user plan (degraded)', error instanceof Error ? error.message : error)
      return undefined
    }
  }

  private async fetchStatus(
    jobToken: string,
    machineId?: string,
    signal?: AbortSignal,
  ): Promise<QoderSubscriberStatus | undefined> {
    const data = await openApiJsonRequest<unknown>(this.fetchImpl, {
      url: getQoderUserStatusUrl(this.region),
      token: jobToken,
      machineId,
      signal,
      timeoutMs: this.timeoutMs,
      logger: this.logger,
      operation: 'Status',
      logCategory: 'account.status',
    })
    return normalizeStatus(data)
  }

  private async safeFetchStatus(
    jobToken: string,
    machineId?: string,
    signal?: AbortSignal,
  ): Promise<QoderSubscriberStatus | undefined> {
    try {
      return await this.fetchStatus(jobToken, machineId, signal)
    } catch (error) {
      if (signal?.aborted) throw error
      this.logger?.warn?.('[Qoder Status] Failed to load user status (degraded)', error instanceof Error ? error.message : error)
      return undefined
    }
  }
}
