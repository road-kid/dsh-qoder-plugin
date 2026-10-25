/**
 * Device-code reset route.
 *
 * The one user-facing action behind it: "these accounts should stop looking
 * like the device they have been". Rotating the host-level seed
 * (`qoder/transport/device-seed.ts`) and dropping the cached job tokens is the
 * whole mechanism; this route is only the guarded door to it.
 *
 * Same guard shape as the PAT route — a loopback Host and Origin plus the
 * in-process key the card receives with its settings document — because this is
 * a write: any local process can address `127.0.0.1`, and this one changes the
 * identity every account presents to the upstream.
 *
 * Be precise about what the key buys: it stops a CROSS-SITE page from driving
 * the route, which is the threat a browser can deliver. It is not a secret from
 * local processes — the settings face hands the same key to any loopback caller
 * that asks, by design, because the card needs it without a login. A local
 * process that wants to rotate the seed can therefore do so; it could already
 * edit the seed file directly. The guards raise the bar, they do not close the
 * local door.
 *
 * It deliberately reports failures as 200 with `ok: false`: the card is
 * same-origin and reads the verdict, and a failed write (a read-only home
 * directory being the realistic case) must show as a failed reset, not as a
 * broken card.
 *
 * @module dsh-qoder-plugin/device-reset-route
 */

import { timingSafeEqual } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { hostIsLoopback, originIsLoopback } from './loopback.ts'
import { QODER_DEVICE_RESET_PATH } from './status-paths.ts'

/** Largest body accepted; this action carries no fields at all. */
const MAX_BODY_BYTES = 4 * 1024

/** What a reset actually did, for the card's confirmation line. */
export interface QoderDeviceResetOutcome {
  /**
   * How many saved accounts were re-identified.
   *
   * The count of distinct account ids across both variants: the user asked for
   * "every account", and a number is the only evidence the action reached more
   * than the one card it was clicked on.
   */
  accounts: number
}

/** Constructor dependencies. */
export interface QoderDeviceResetRouteOptions {
  /**
   * Rotate the seed and forget the cached credentials.
   *
   * Rejects when the seed cannot be written; the route turns that into its
   * failure shape rather than reporting a reset that did not happen.
   */
  reset: () => Promise<QoderDeviceResetOutcome>
  /** Route path to mount; defaults to {@link QODER_DEVICE_RESET_PATH}. */
  path?: string
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) })
  res.end(payload)
}

/**
 * Drain the request body; the content is ignored, only its size matters.
 *
 * The body is read to the END even after the ceiling is passed. Bailing out of
 * the `for await` early destroys the stream mid-body, and the 413 written
 * afterwards can then be lost — the client sees a reset connection instead of
 * the reason. Reaching this at all means the caller already passed the loopback
 * and key checks, so there is no unauthenticated party to drain for.
 *
 * @returns whether the body stayed within {@link MAX_BODY_BYTES}.
 */
async function drainBody(req: IncomingMessage): Promise<boolean> {
  let total = 0
  for await (const chunk of req) {
    total += Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(chunk as string)
  }
  return total <= MAX_BODY_BYTES
}

/** Constant-time key comparison; a length mismatch is a failure, not a crash. */
function keyMatches(expected: string, presented: string | undefined): boolean {
  if (presented === undefined || presented.length !== expected.length) return false
  const a = Buffer.from(expected)
  const b = Buffer.from(presented)
  return a.length === b.length && timingSafeEqual(a, b)
}

/** Strip anything token-like from a message before it reaches the browser. */
function safeMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error))
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/gu, '[redacted token]')
    // A filesystem error quotes the path it failed on, and a path can carry a
    // credential when the user pointed the plugin at one.
    .replace(/\bpt-[A-Za-z0-9_-]{8,}/gu, '[redacted token]')
    .slice(0, 500)
}

/**
 * The reset route's handler, extracted so tests can mount it on a bare server
 * with a known key.
 *
 * @param deps - the reset operation.
 * @param key - the in-process settings key this route requires.
 * @returns the Node request handler.
 */
export function qoderDeviceResetHandler(
  deps: QoderDeviceResetRouteOptions,
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
    if (!keyMatches(key, req.headers['x-qoder-settings-key'] as string | undefined)) {
      json(res, 403, { error: 'invalid-settings-key' })
      return
    }
    if (!await drainBody(req)) {
      json(res, 413, { error: 'body too large' })
      return
    }
    try {
      const outcome = await deps.reset()
      json(res, 200, { ok: true, accounts: outcome.accounts, at: Date.now() })
    } catch (error: unknown) {
      json(res, 200, { ok: false, error: safeMessage(error) })
    }
  }
}

/** Mount the POST device-reset route on an optional webServer context. */
export function registerQoderDeviceResetRoute(
  ctx: Context,
  deps: QoderDeviceResetRouteOptions,
  key: string,
): void {
  const path = deps.path ?? QODER_DEVICE_RESET_PATH
  ctx.effect(() => {
    const dispose = ctx.webServer.register({
      kind: 'exact',
      path,
      handler: qoderDeviceResetHandler(deps, key),
    })
    return () => {
      dispose()
    }
  }, 'dsh-qoder-plugin: device reset route')
}
