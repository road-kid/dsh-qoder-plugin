/** Qoder campaign inquiry and daily benefit check-in service. */

import type { QoderAuthService } from './auth.ts'
import {
  getQoderCampaignsUrl,
  getQoderClaimCampaignUrl,
  resolveQoderEndpoints,
  type QoderRegion,
} from './endpoints.ts'
import { isQoderAuthRejection, QoderLlmError } from '../errors.ts'
import type { QoderLogger } from './logging.ts'
import { openApiJsonRequest } from './request.ts'
import { qoderDesktopClientType, campaignMachineOs } from './wire/cosy.ts'
import { campaignHostname, resolveRiskIdentity, type QoderRiskIdentity } from './risk-identity.ts'
import { deriveMachineHostname, deriveMachineId } from './device-identity.ts'
import { readDeviceSeed } from './device-seed.ts'
import { getClaimWindowDateString, DEFAULT_CLAIM_WINDOW_MINUTE } from '../../claim-window.ts'

export interface QoderCampaignBenefit {
  kind?: string
  amount?: number
  validity?: {
    mode?: string
    days?: number
  }
}

export interface QoderCampaign {
  campaignId: string
  campaignKey?: string
  actionType: string
  claimStatus: string
  startAt?: number
  endAt?: number
  benefit?: QoderCampaignBenefit
}

export interface QoderCampaignsResponse {
  uid?: string
  claimable?: boolean
  campaigns?: QoderCampaign[]
}

export interface QoderClaimResponse {
  status?: string
  replayed?: boolean
  benefit?: {
    kind?: string
    amount?: number
  }
  expiresAt?: string
}

export interface QoderCheckInResult {
  variantId: string
  date: string
  timestamp: number
  status: 'claimed' | 'already-claimed' | 'no-campaign' | 'error'
  amount?: number | undefined
  campaignKey?: string | undefined
  message?: string | undefined
  /**
   * When the claimed credits expire, epoch milliseconds.
   *
   * A claimed package is not permanent — Qoder grants it for a fixed window
   * (30 days for the daily 100-credit benefit) — and the card has to say so.
   * Resolution order: the claim's own `expiresAt`; failing that, the
   * campaign's stated `validity.days` counted from the claim moment. Absent
   * when the upstream said neither, and an absent value is rendered as
   * unknown rather than guessed.
   */
  expiresAtMs?: number | undefined
  /**
   * A stable reason code for a failed attempt, when one applies.
   *
   * Carried alongside `message` so the card can localize the one failure the
   * user can actually act on instead of matching on English prose:
   * - `no-client` — this machine has no Qoder client to mint the device
   *   identity the international campaign requires.
   * - `claim-conflict` — the claim endpoint answered HTTP 409 and the
   *   authoritative campaign read afterwards still says the benefit was not
   *   granted (window closed, or the campaign is not claimable right now).
   *   The card must not read that as a granted benefit.
   */
  reasonCode?: 'no-client' | 'claim-conflict' | undefined
}

export interface QoderCheckInServiceOptions {
  authService: QoderAuthService
  fetch?: typeof fetch | undefined
  region?: QoderRegion | undefined
  variantId?: string | undefined
  logger?: QoderLogger | undefined
  timeoutMs?: number | undefined
  /**
   * How this machine's risk identity is obtained. Injectable because the real
   * resolver shells out to a signed native binary that only exists where a
   * Qoder client is installed, which no test environment can rely on.
   */
  riskIdentity?: ((region: QoderRegion, uid: string) => Promise<QoderRiskIdentity | undefined>) | undefined
  /**
   * The host-level seed the per-account derived headers are built from.
   *
   * The same seed the inference path uses (`device-seed.ts`), read here rather
   * than injected from the transport so the campaign path cannot drift from it:
   * the reset control's whole promise is that every account gets a fresh
   * fingerprint, and a campaign `machineid` derived from the OLD seed after a
   * reset would keep presenting the identity the user just retired. Injectable
   * only so tests stay hermetic — the real value is a file under the user's
   * home directory.
   */
  resolveDeviceSeed?: (() => string | undefined) | undefined
  /**
   * When the daily claim window opens, in minutes past midnight UTC+8.
   *
   * The window runs from this moment until the same moment the next day, so it
   * decides which window an instant belongs to. The scheduler owns the user's
   * configured value; this default matches the documented 10:00 opening.
   */
  windowMinute?: number | undefined
}

const defaultCheckInTimeoutMs = 15_000

/**
 * Which machine-header set the campaign family sends (SPEC-UMID-003 §3 R1).
 *
 * `three` (default) is the shape this plugin has been shipping: the three
 * headers a real desktop client mints from its signed component. `six` is an
 * EXPERIMENT — the mixed shape a reference implementation uses (derived
 * `machineid`, real `machinehostname`, desktop-vocabulary `machineos`, plus the
 * same three native values) — and it is off unless this environment variable
 * says otherwise.
 *
 * Why a switch and not the default: the only measurements available cover one,
 * five and six headers, and they get safer as headers are removed — three was
 * never measured. Turning the extra headers on by default would therefore be an
 * unverified change to every international user's device fingerprint, while the
 * failure it risks is silent (the list comes back empty with HTTP 200, so the
 * user sees "no campaign today" and never an error). Flipping one variable is
 * also the whole rollback.
 */
export const CAMPAIGN_MACHINE_HEADERS_ENV = 'QODER_CAMPAIGN_MACHINE_HEADERS'

/**
 * Privacy switch that replaces the real hostname with a derived one (§3 R4).
 *
 * The only verified working six-header shape carries the machine's REAL
 * hostname, so that is the default. Users who consider the hostname identifying
 * can opt into the derived form, but it has never been observed working against
 * the upstream — the README says so, and this variable is why the alternative
 * exists at all.
 */
export const CAMPAIGN_DERIVED_HOSTNAME_ENV = 'QODER_CAMPAIGN_DERIVED_HOSTNAME'

type CampaignMachineHeaderMode = 'three' | 'six'

/**
 * The header mode for the next request.
 *
 * Read per request rather than once at module load: it decides how many headers
 * to send, not what the device is, so a long-running host may pick the switch up
 * without a re-import and tests can flip it. Anything other than `six` — unset,
 * empty, misspelled, `three` — means the shipped default, because a typo must
 * degrade to the measured shape and never to the experimental one.
 */
function campaignMachineHeaderMode(env: NodeJS.ProcessEnv = process.env): CampaignMachineHeaderMode {
  return env[CAMPAIGN_MACHINE_HEADERS_ENV]?.trim().toLowerCase() === 'six' ? 'six' : 'three'
}

function campaignDerivedHostnameEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const value = env[CAMPAIGN_DERIVED_HOSTNAME_ENV]?.trim().toLowerCase()
  return value === '1' || value === 'true'
}

/**
 * The identity headers a real desktop client sends, or an empty set.
 *
 * An absent identity is NOT silently equivalent to a present one: the
 * international upstream withholds the daily campaign from a request without
 * it, so the caller distinguishes the two and reports the absence rather than
 * letting it look like "there is no campaign today".
 *
 * `three` mode sends exactly the three component-minted headers. `six` mode
 * appends the mixed pair a reference implementation was observed using
 * (§6.7) — derived `machineid`, real hostname, desktop-vocabulary `machineos` —
 * and it must stay that exact combination: the point of the experiment is to
 * test a shape that is known to work somewhere, not to invent a "3 native +
 * 3 derived" hybrid nobody has ever sent.
 *
 * Without the account id the derived pair cannot be minted at all, so `six`
 * degrades to `three` instead of sending a half-filled set: a request carrying
 * `machineid` but not `machinehostname` is a combination with no evidence
 * behind it, which is precisely what R1 forbids.
 *
 * `seed` is the host-level reset seed. It only perturbs the two derived values,
 * so the three native headers keep the identity the signed component minted —
 * and a reset retires the campaign fingerprint at the same moment it retires
 * the inference one, instead of leaving the campaign path presenting the id the
 * user just rotated away from.
 */
function riskHeaders(
  identity: QoderRiskIdentity | undefined,
  uid: string | undefined,
  resolveSeed: () => string | undefined,
): Record<string, string> {
  if (identity === undefined) return {}
  const native: Record<string, string> = {
    'cosy-machinetoken': identity.machineToken,
    'cosy-machinecode': identity.machineCode,
    'cosy-machinetype': identity.machineType,
  }
  if (uid === undefined || campaignMachineHeaderMode() !== 'six') return native
  // Read only here: `three` mode never derives anything, and a request that
  // cannot use the seed must not pay for the file read on every check-in.
  const seed = resolveSeed()
  return {
    ...native,
    'cosy-machineid': deriveMachineId(uid, undefined, seed),
    'cosy-machineos': campaignMachineOs,
    'cosy-machinehostname': campaignDerivedHostnameEnabled()
      ? deriveMachineHostname(uid, seed)
      : campaignHostname(),
  }
}

/**
 * Whether a thrown failure is the claim endpoint refusing the write with HTTP 409.
 *
 * 409 is the upstream's way of saying "this benefit is already accounted for
 * or is no longer claimable", not "your request was malformed" and not "your
 * credential is bad". The transport renders any non-2xx as
 * `Failed to execute Qoder ClaimCampaign with status 409.`, which is the
 * mechanism of the failure rather than its meaning, so the claim path is the
 * only place that can turn it into an honest answer: the status is inspected
 * here and the campaign list — the authoritative record of whether the benefit
 * was granted — is re-read.
 *
 * Only 409 qualifies. Every other status keeps its existing behaviour
 * (401/403 still reach the single token-heal retry; 5xx/429 still surface).
 */
function isClaimConflict(error: unknown): boolean {
  return error instanceof QoderLlmError && error.failure.status === 409
}

/**
 * When a claimed package expires, in epoch milliseconds; undefined when the
 * upstream stated neither an absolute moment nor a validity window.
 *
 * Two sources, in order of authority: the claim's own `expiresAt` (an ISO
 * string, what the upstream returns for the grant it just made) and the
 * campaign's `validity.days` counted from the claim. Neither is invented — a
 * plugin that guessed a 30-day window would print a confident wrong date the
 * day Qoder changes its campaign.
 */
export function resolveExpiryMs(
  claimExpiresAt: string | undefined,
  validity: { mode?: string; days?: number } | undefined,
  claimedAtMs: number,
): number | undefined {
  if (typeof claimExpiresAt === 'string' && claimExpiresAt.trim() !== '') {
    const parsed = Date.parse(claimExpiresAt)
    if (!Number.isNaN(parsed) && parsed > 0) return parsed
  }
  const days = validity?.days
  if (typeof days === 'number' && Number.isFinite(days) && days > 0) {
    return claimedAtMs + days * 24 * 60 * 60 * 1000
  }
  return undefined
}

export class QoderCheckInService {
  private readonly authService: QoderAuthService
  private readonly fetchImpl: typeof fetch
  private readonly region: QoderRegion
  private readonly variantId: string
  private readonly logger: QoderLogger | undefined
  private readonly timeoutMs: number
  private readonly riskIdentity: (region: QoderRegion, uid: string) => Promise<QoderRiskIdentity | undefined>
  private readonly resolveDeviceSeed: () => string | undefined
  private readonly windowMinute: number

  constructor(options: QoderCheckInServiceOptions) {
    this.authService = options.authService
    this.fetchImpl = options.fetch ?? globalThis.fetch
    this.region = options.region ?? 'china'
    this.variantId = options.variantId ?? 'qoder'
    this.logger = options.logger
    this.timeoutMs = options.timeoutMs ?? defaultCheckInTimeoutMs
    this.riskIdentity = options.riskIdentity ?? resolveRiskIdentity
    this.resolveDeviceSeed = options.resolveDeviceSeed ?? readDeviceSeed
    this.windowMinute = options.windowMinute ?? DEFAULT_CLAIM_WINDOW_MINUTE
  }

  /**
   * @param identity the component-minted identity, or undefined when this machine has none
   * @param uid the signed-in account id; `six` mode needs it to derive `machineid`
   */
  async fetchCampaigns(
    token: string,
    signal?: AbortSignal,
    identity?: QoderRiskIdentity,
    uid?: string,
  ): Promise<QoderCampaign[]> {
    const url = getQoderCampaignsUrl(this.region)
    const data = await openApiJsonRequest<QoderCampaignsResponse>(this.fetchImpl, {
      url,
      token,
      // The campaign family gates on the desktop identifier; the generic one
      // answers 200 with an empty list (see `qoderDesktopClientType`).
      headers: {
        'cosy-clienttype': qoderDesktopClientType,
        ...riskHeaders(identity, uid, this.resolveDeviceSeed),
      },
      // Byte-identical 1.0.0 fingerprint: this family is risk-gated, so it must
      // not follow the inference build's version pair.
      fingerprint: 'campaign',
      signal,
      timeoutMs: this.timeoutMs,
      logger: this.logger,
      operation: 'Campaigns',
      logCategory: 'campaigns.list',
    })
    return Array.isArray(data?.campaigns) ? data.campaigns : []
  }

  /** @param uid the signed-in account id; `six` mode needs it to derive `machineid` */
  async claimCampaign(
    token: string,
    campaignId: string,
    signal?: AbortSignal,
    identity?: QoderRiskIdentity,
    uid?: string,
  ): Promise<QoderClaimResponse> {
    const url = getQoderClaimCampaignUrl(this.region, campaignId)
    const { openApiUrl } = resolveQoderEndpoints(this.region)
    return openApiJsonRequest<QoderClaimResponse>(this.fetchImpl, {
      url,
      method: 'POST',
      token,
      headers: {
        origin: openApiUrl,
        'cosy-clienttype': qoderDesktopClientType,
        ...riskHeaders(identity, uid, this.resolveDeviceSeed),
      },
      fingerprint: 'campaign',
      signal,
      timeoutMs: this.timeoutMs,
      logger: this.logger,
      operation: 'ClaimCampaign',
      logCategory: 'campaigns.claim',
    })
  }

  /**
   * Which daily claim window an instant belongs to, as `YYYY-MM-DD` in UTC+8.
   *
   * Deliberately NOT the calendar date. The upstream opens a window every day
   * at 10:00 UTC+8 and closes it just before 10:00 the next morning, so the
   * hours between midnight and 10:00 belong to the window that opened the
   * previous day. Stamping a claim made at 23:11 with the calendar date of the
   * following midnight made every date comparison disagree with the window the
   * claim actually belonged to, which re-armed the claim button hours before a
   * new benefit was available. The scheduler compares against the same rule.
   */
  private getTodayDateString(nowMs: number = Date.now()): string {
    return getClaimWindowDateString(nowMs, this.windowMinute)
  }

  async checkIn(pat: string, signal?: AbortSignal): Promise<QoderCheckInResult> {
    const today = this.getTodayDateString()
    const nowMs = Date.now()

    if (!pat || typeof pat !== 'string' || pat.trim() === '') {
      return {
        variantId: this.variantId,
        date: today,
        timestamp: nowMs,
        status: 'error',
        message: 'No PAT available',
      }
    }

    const executeWithToken = async (authToken: string, uid: string): Promise<QoderCheckInResult> => {
      /*
       * The machine identity is resolved BEFORE the campaign list is read, and
       * its absence is reported rather than papered over.
       *
       * Qoder's international service withholds the daily campaign from a
       * request that carries no client-minted machine identity, and answers
       * HTTP 200 with an innocuous list either way. Asking without one would
       * therefore produce `no-campaign` — a claim about the ACCOUNT that is
       * really a statement about this process. Only the international region
       * gates on it; the China region ignores it entirely, so a machine
       * without a client installed keeps working there.
       */
      const identity = await this.riskIdentity(this.region, uid)
      if (identity === undefined && this.region === 'global') {
        return {
          variantId: this.variantId,
          date: today,
          timestamp: nowMs,
          status: 'error',
          reasonCode: 'no-client',
          message: 'No Qoder desktop client found on this machine, so the daily campaign cannot be requested. Install Qoder (international) and retry.',
        }
      }
      const campaigns = await this.fetchCampaigns(authToken, signal, identity, uid)
      // Look for daily benefit campaign (actionType === 'CLAIM_BENEFIT')
      const benefitCampaign = campaigns.find(c => c.actionType === 'CLAIM_BENEFIT')
      if (!benefitCampaign) {
        return {
          variantId: this.variantId,
          date: today,
          timestamp: nowMs,
          status: 'no-campaign',
          message: 'No claimable benefit campaign found for this region',
        }
      }

      if (benefitCampaign.claimStatus === 'CLAIMED') {
        const expiresAtMs = resolveExpiryMs(undefined, benefitCampaign.benefit?.validity, nowMs)
        return {
          variantId: this.variantId,
          date: today,
          timestamp: nowMs,
          status: 'already-claimed',
          campaignKey: benefitCampaign.campaignKey,
          amount: benefitCampaign.benefit?.amount ?? 100,
          message: 'Already claimed today',
          ...expiresAtMs === undefined ? {} : { expiresAtMs },
        }
      }

      // Claim it. A 409 is handled inside: it is a refusal, not a transport
      // failure, and only the campaign list can say what it meant.
      let claimResult: QoderClaimResponse
      try {
        claimResult = await this.claimCampaign(authToken, benefitCampaign.campaignId, signal, identity, uid)
      } catch (claimError) {
        if (!isClaimConflict(claimError)) throw claimError
        // The upstream refused the write as a conflict. Re-read the campaign
        // list EXACTLY ONCE: it is the authoritative record of whether the
        // benefit exists in a granted state, and it is the only reading that can
        // distinguish "you already have it today" (the common, benign case —
        // a double click, a scheduled run that overlapped a manual one, or a
        // China account whose claim was already applied server-side) from "the
        // window closed / the campaign is not claimable". No second claim is
        // ever issued, so a 409 here cannot recurse.
        let settled: QoderCampaign | undefined
        let settledListRead = false
        try {
          const refreshed = await this.fetchCampaigns(authToken, signal, identity, uid)
          settled = refreshed.find(c => c.actionType === 'CLAIM_BENEFIT')
          settledListRead = true
        } catch (readError) {
          // The re-read itself failed. That does not change what is known: the
          // claim was refused and nothing says it was granted. Fall through to
          // the conflict answer rather than letting a diagnostic error replace
          // an honest one — and never retry, so this stays bounded.
          this.logger?.warn?.(
            `[Qoder CheckIn] Claim conflict, campaign re-read failed: ${readError instanceof Error ? readError.message : String(readError)}`,
          )
        }

        if (settledListRead && settled?.claimStatus === 'CLAIMED') {
          // Refused because it was already granted; report it as such, with the
          // same fields the ordinary already-claimed path carries.
          const expiresAtMs = resolveExpiryMs(undefined, settled.benefit?.validity, nowMs)
          this.logger?.warn?.('[Qoder CheckIn] Claim conflict resolved as already-claimed by the campaign read')
          return {
            variantId: this.variantId,
            date: today,
            timestamp: nowMs,
            status: 'already-claimed',
            campaignKey: settled.campaignKey ?? benefitCampaign.campaignKey,
            amount: settled.benefit?.amount ?? benefitCampaign.benefit?.amount ?? 100,
            message: 'Already claimed today',
            ...expiresAtMs === undefined ? {} : { expiresAtMs },
          }
        }

        // "Conflict" resolved against us: no granted benefit. Say what the
        // upstream did instead of echoing the transport string, and take care
        // not to imply the credits were granted.
        const observed = settled === undefined
          ? settledListRead
            ? 'the campaign is no longer listed'
            : 'the campaign list could not be re-read'
          : `the campaign still reports ${settled.claimStatus ?? 'an unknown status'}`
        this.logger?.warn?.(`[Qoder CheckIn] Claim refused with 409; ${observed}`)
        return {
          variantId: this.variantId,
          date: today,
          timestamp: nowMs,
          status: 'error',
          reasonCode: 'claim-conflict',
          campaignKey: settled?.campaignKey ?? benefitCampaign.campaignKey,
          message: `Qoder refused the daily benefit claim as a conflict and ${observed}, so no credits were granted. Retry once the campaign shows a claimable benefit.`,
        }
      }
      const isClaimed = claimResult.status === 'CLAIMED'
      const replayed = Boolean(claimResult.replayed)
      const amount = claimResult.benefit?.amount ?? benefitCampaign.benefit?.amount ?? 100

      if (isClaimed) {
        const expiresAtMs = resolveExpiryMs(claimResult.expiresAt, benefitCampaign.benefit?.validity, nowMs)
        return {
          variantId: this.variantId,
          date: today,
          timestamp: nowMs,
          status: replayed ? 'already-claimed' : 'claimed',
          amount,
          campaignKey: benefitCampaign.campaignKey,
          message: replayed ? 'Already claimed today' : `Successfully claimed ${amount} credits`,
          ...expiresAtMs === undefined ? {} : { expiresAtMs },
        }
      }

      return {
        variantId: this.variantId,
        date: today,
        timestamp: nowMs,
        status: 'error',
        campaignKey: benefitCampaign.campaignKey,
        message: `Claim returned status ${claimResult.status ?? 'unknown'}`,
      }
    }

    try {
      const creds = await this.authService.getCredentials(pat, signal)
      try {
        return await executeWithToken(creds.authToken, creds.userID)
      } catch (innerError) {
        // If 401 token rejection, attempt one fresh token rotation and retry
        if (isQoderAuthRejection(innerError)) {
          this.logger?.warn?.(`[Qoder CheckIn] Auth token rejected, retrying with fresh exchange`)
          const freshCreds = await this.authService.exchangeFresh(pat, signal)
          return await executeWithToken(freshCreds.authToken, freshCreds.userID)
        }
        throw innerError
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.logger?.error?.(`[Qoder CheckIn] Check-in failed: ${message}`)
      return {
        variantId: this.variantId,
        date: today,
        timestamp: nowMs,
        status: 'error',
        message,
      }
    }
  }
}
