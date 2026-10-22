/**
 * PAT route: saves (validate-then-persist), selects, removes, or clears one
 * variant's stored tokens.
 *
 * The state-changing endpoints the plugin exposes share one guard shape — a
 * loopback Host and Origin, plus the in-process key the card receives with its
 * status document — because loopback alone is *not* authentication: any local
 * process can address `127.0.0.1`, and this route writes a credential to disk.
 *
 * The region is never taken from the request. It is fixed by the route the
 * browser called (one route per variant), so a card for one product can never
 * steer a token into the other's upstream — a token pasted into the Qoder
 * Global card is validated against, and stored for, Qoder Global only.
 *
 * @module dsh-qoder-plugin/auth-route
 */

import { randomBytes, timingSafeEqual } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { hostIsLoopback, originIsLoopback } from './loopback.ts'
import { QODER_AUTH_PATH } from './status-paths.ts'
import type { QoderAuthRequest } from './status-paths.ts'
import type { QoderAuthStatus } from './auth.ts'

/** Largest control body accepted; a Personal Access Token is a short string. */
const MAX_BODY_BYTES = 16 * 1024

/** Outcome of a save attempt: stored, or refused with a stable reason. */
export type QoderAuthSaveResult =
  | { ok: true; status: QoderAuthStatus }
  /**
   * `qoder_invalid_pat` — the upstream answered and refused this token.
   * `qoder_unreachable` — no answer came (timeout, transport, 5xx), so the
   * token's validity is simply unknown; the card must offer a retry rather
   * than telling the user to replace a credential that was never judged.
   * `qoder_missing_pat` — nothing was submitted.
   */
  | {
    ok: false
    error: 'qoder_invalid_pat' | 'qoder_missing_pat' | 'qoder_unreachable'
    /** Upstream detail for the message; absent when there is nothing to say. */
    reason?: string | undefined
  }

/** Constructor dependencies. */
export interface QoderAuthRouteOptions {
  /**
   * Validate one pasted token against this variant's region and, only on
   * success, persist it. The route never decides validity itself.
   */
  save: (pat: string) => Promise<QoderAuthSaveResult>
  /**
   * Make one stored account the one that signs requests.
   *
   * Resolves to the status *after* the switch so the card can re-render the
   * list from one round trip; rejecting an unknown id is the caller's job,
   * and the route turns that rejection into its ordinary failure shape.
   */
  activate: (accountId: string) => Promise<QoderAuthStatus>
  /**
   * Drop one stored account, resolving to the status after the removal.
   *
   * Removal is by id, never by position: the card's list may be a poll behind
   * the file, and acting on "the second row" would delete whichever account
   * happened to be second by the time the request landed.
   */
  remove: (accountId: string) => Promise<QoderAuthStatus>
  /**
   * Park or un-park one stored account, resolving to the status after the write.
   *
   * Optional so the two halves can land independently: a host that has not been
   * wired for parking yet answers the request with the route's ordinary failure
   * shape instead of crashing or silently reporting success.
   */
  setEnabled?: (accountId: string, enabled: boolean) => Promise<QoderAuthStatus>
  /** Remove the stored credential. */
  clear: () => Promise<void>
  /**
   * Route path to mount. Defaults to the China variant's path so callers that
   * only serve it keep their behaviour; the global variant passes its own.
   */
  path?: string
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) })
  res.end(payload)
}

/** Read the request body with a hard ceiling. */
async function readBody(req: IncomingMessage): Promise<string | undefined> {
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string)
    total += buffer.length
    if (total > MAX_BODY_BYTES) return undefined
    chunks.push(buffer)
  }
  return Buffer.concat(chunks).toString('utf8')
}

/** Parse and shape-check a PAT request; unknown fields are ignored, not trusted. */
function parseRequest(text: string): QoderAuthRequest | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined
  const wrapped = parsed as Record<string, unknown>
  const action = wrapped['action']
  if (action === 'clear') return { action }
  if (action === 'save-pat') {
    const pat = wrapped['pat']
    if (typeof pat !== 'string' || pat.trim() === '') return undefined
    return { action, pat }
  }
  // Account-scoped actions carry an id, and an absent or blank one is a
  // malformed request rather than a request about "no account": answering it
  // with the 400 the route already uses keeps a card that lost its id from
  // silently acting on whichever account happens to be first.
  if (action === 'activate-account' || action === 'remove-account') {
    const accountId = wrapped['accountId']
    if (typeof accountId !== 'string' || accountId.trim() === '') return undefined
    return { action, accountId: accountId.trim() }
  }
  /*
   * Parking is the one account action that carries a value, and the value is
   * required rather than defaulted: a request that lost its `enabled` field
   * must not be read as "false" (silently parking an account the user just
   * switched back on) nor as "true" (silently un-parking one they just took
   * out of the walk). Both guesses are destructive, so the request is answered
   * as malformed instead.
   */
  if (action === 'set-account-enabled') {
    const accountId = wrapped['accountId']
    const enabled = wrapped['enabled']
    if (typeof accountId !== 'string' || accountId.trim() === '') return undefined
    if (typeof enabled !== 'boolean') return undefined
    return { action, accountId: accountId.trim(), enabled }
  }
  return undefined
}

/**
 * Strip token-like content from a message before it reaches the browser.
 *
 * The route reports failures to a same-origin card, and a validation error
 * body is the one input here that is not the plugin's own prose.
 * Belt-and-braces: everything this route produces is already a summary, and
 * this keeps a future one from carrying a credential across.
 */
function safeMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error))
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/gu, '[redacted token]')
    .replace(/(\b(?:code|token|pat)=)[^&\s]+/giu, '$1[redacted]')
    .slice(0, 500)
}

/** Mint the per-process PAT control key. */
export function createAuthKey(): string {
  return randomBytes(24).toString('hex')
}

/** Constant-time key comparison; a length mismatch is a failure, not a crash. */
function keyMatches(expected: string, presented: string | undefined): boolean {
  if (presented === undefined || presented.length !== expected.length) return false
  const a = Buffer.from(expected)
  const b = Buffer.from(presented)
  return a.length === b.length && timingSafeEqual(a, b)
}

/**
 * The PAT route's handler, extracted so tests can mount it on a bare server
 * with a known key.
 *
 * @param deps - the save/clear operations for one variant.
 * @param key - the in-process control key this route requires.
 * @returns the Node request handler.
 */
export function qoderAuthHandler(
  deps: QoderAuthRouteOptions,
  key: string,
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  return async (req, res) => {
    if (req.method !== 'POST') {
      json(res, 405, { error: 'method not allowed' })
      return
    }
    if (!hostIsLoopback(req.headers.host) || !originIsLoopback(req.headers.origin)) {
      json(res, 403, { error: 'request-not-trusted' })
      return
    }
    if (!keyMatches(key, req.headers['x-qoder-auth-key'] as string | undefined)) {
      json(res, 403, { error: 'invalid-auth-key' })
      return
    }
    const body = await readBody(req)
    if (body === undefined) {
      json(res, 413, { error: 'body too large' })
      return
    }
    const request = parseRequest(body)
    if (request === undefined) {
      json(res, 400, { error: 'invalid action' })
      return
    }
    try {
      if (request.action === 'clear') {
        await deps.clear()
        json(res, 200, { ok: true })
        return
      }
      if (request.action === 'activate-account') {
        json(res, 200, { ok: true, status: await deps.activate(request.accountId as string) })
        return
      }
      if (request.action === 'remove-account') {
        json(res, 200, { ok: true, status: await deps.remove(request.accountId as string) })
        return
      }
      if (request.action === 'set-account-enabled') {
        const setEnabled = deps.setEnabled
        if (setEnabled === undefined) {
          // Honest failure rather than a pretend success: the card would
          // otherwise show the checkbox flipped while the file still says
          // otherwise, and the next poll would flip it back with no
          // explanation.
          json(res, 200, { ok: false, error: 'set-account-enabled is not available on this host' })
          return
        }
        json(res, 200, {
          ok: true,
          status: await setEnabled(request.accountId as string, request.enabled as boolean),
        })
        return
      }
      // A refused token is an answer, not a transport failure: the card reads
      // the stable `qoder_invalid_pat` code and re-prompts, so both outcomes
      // travel as 200 with `ok` carrying the verdict.
      json(res, 200, await deps.save(request.pat as string))
    } catch (error: unknown) {
      json(res, 200, { ok: false, error: safeMessage(error) })
    }
  }
}

/** Mount the POST PAT route on an optional webServer context. */
export function registerQoderAuthRoute(
  ctx: Context,
  deps: QoderAuthRouteOptions,
  key: string,
): void {
  const path = deps.path ?? QODER_AUTH_PATH
  ctx.effect(() => {
    const dispose = ctx.webServer.register({
      kind: 'exact',
      path,
      handler: qoderAuthHandler(deps, key),
    })
    return () => {
      dispose()
    }
  }, 'dsh-qoder-plugin: PAT route')
}
