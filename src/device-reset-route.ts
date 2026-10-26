/**
 * Guarded write routes: the device-code reset and the native-component install.
 *
 * Both are the same kind of thing — one user-facing button, one host-side write,
 * one verdict back — so they share one guard implementation instead of two
 * copies that could drift apart. The guard shape is the PAT route's: a loopback
 * Host and Origin plus the in-process key the card receives with its settings
 * document. Any local process can address `127.0.0.1`, and these routes change
 * the identity every account presents to the upstream and download code from
 * the network respectively.
 *
 * Be precise about what the key buys: it stops a CROSS-SITE page from driving
 * the routes, which is the threat a browser can deliver. It is not a secret from
 * local processes — the settings face hands the same key to any loopback caller
 * that asks, by design, because the card needs it without a login. A local
 * process that wants to rotate the seed can therefore do so; it could already
 * edit the seed file directly. The guards raise the bar, they do not close the
 * local door.
 *
 * Both routes deliberately report failures as 200 with `ok: false`: the card is
 * same-origin and reads the verdict, and a failed write (a read-only home
 * directory being the realistic case) must show as a failed action, not as a
 * broken card.
 *
 * @module dsh-qoder-plugin/device-reset-route
 */

import { timingSafeEqual } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { hostIsLoopback, originIsLoopback } from './loopback.ts'
import { QODER_DEVICE_RESET_PATH, QODER_UMID_INSTALL_PATH } from './status-paths.ts'

/** Largest body accepted; neither action carries more than a flag. */
const MAX_BODY_BYTES = 4 * 1024

/**
 * What one guarded action gets to see of the request.
 *
 * Only the body: the guards have already run, so the action has nothing left to
 * verify and nothing to read from the headers. Kept as an object rather than a
 * bare `unknown` so a later action can gain a field without changing every
 * caller's signature.
 */
export interface GuardedActionRequest {
  /**
   * The parsed JSON body, or `undefined` when the body was empty or not JSON.
   *
   * Unparseable is not an error here: every action carries optional fields
   * only, and refusing a body the action would have ignored anyway would turn a
   * malformed-but-harmless request into a failed button.
   */
  body: unknown
}

/** What one guarded action does; its return value becomes the 200 body. */
export interface GuardedActionOptions {
  /**
   * The in-process settings key this route requires.
   *
   * Compared in constant time. A route whose key is the empty string accepts
   * every caller that can reach the loopback port, so callers must mint one.
   */
  key: string
  /**
   * Perform the action and return the JSON body sent with 200.
   *
   * Rejects to report failure; the guard turns that into
   * `{ ok: false, error }` rather than a 5xx.
   */
  handler: (request: GuardedActionRequest) => Promise<unknown>
}

/** A guarded action plus where to mount it. */
export interface GuardedActionRouteOptions extends GuardedActionOptions {
  /** Route path to mount. */
  path: string
  /**
   * `ctx.effect` label, e.g. `'dsh-qoder-plugin: device reset route'`.
   *
   * Distinct per route because it is what the host prints when the effect is
   * disposed or fails, and two routes sharing a label would make a teardown
   * message ambiguous.
   */
  effectLabel: string
}

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

/** One drained request body. */
interface DrainedBody {
  /** Whether the body stayed within {@link MAX_BODY_BYTES}. */
  withinLimit: boolean
  /** The body text; empty once the ceiling was passed. */
  text: string
}

/**
 * Drain the request body and keep it, up to the ceiling.
 *
 * The body is read to the END even after the ceiling is passed. Bailing out of
 * the `for await` early destroys the stream mid-body, and the 413 written
 * afterwards can then be lost — the client sees a reset connection instead of
 * the reason. Reaching this at all means the caller already passed the loopback
 * and key checks, so there is no unauthenticated party to drain for.
 *
 * The text is DROPPED once the ceiling is crossed rather than buffered and then
 * rejected: a caller that sends a gigabyte would otherwise be held in memory by
 * the very code that is about to refuse it, and the only thing wanted from an
 * oversized body is its length.
 */
async function drainBody(req: IncomingMessage): Promise<DrainedBody> {
  let total = 0
  const chunks: Buffer[] = []
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string)
    total += buffer.length
    if (total <= MAX_BODY_BYTES) chunks.push(buffer)
    else chunks.length = 0
  }
  return { withinLimit: total <= MAX_BODY_BYTES, text: Buffer.concat(chunks).toString('utf8') }
}

/** Parse a drained body; `undefined` when it is empty or not JSON. */
function parseJson(text: string): unknown {
  if (text.length === 0) return undefined
  try {
    return JSON.parse(text) as unknown
  } catch {
    return undefined
  }
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
 * The guard every write route in this plugin runs behind.
 *
 * Order matters and is deliberate: the method is checked before the loopback
 * guard (a `GET` from anywhere is answered as the wrong method, which says
 * nothing about the caller), the loopback guard before the key (an off-host
 * caller must not learn whether a key it guessed was right), and the key before
 * the body is read (an unauthenticated caller must not be able to make the host
 * buffer anything).
 *
 * Extracted so the two actions cannot drift: a guard bug fixed here is fixed
 * for both, and the tests can mount either one on a bare server with a known
 * key.
 *
 * @param options - the key to require and the action to run.
 * @returns the Node request handler.
 */
export function guardedActionHandler(
  options: GuardedActionOptions,
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
    if (!keyMatches(options.key, req.headers['x-qoder-settings-key'] as string | undefined)) {
      json(res, 403, { error: 'invalid-settings-key' })
      return
    }
    const body = await drainBody(req)
    if (!body.withinLimit) {
      json(res, 413, { error: 'body too large' })
      return
    }
    // The verdict is computed before the response is written so a failure can
    // never arrive after a success has already been committed: `json` writes the
    // head, and a second write on the same response is a lost error.
    let verdict: unknown
    try {
      verdict = await options.handler({ body: parseJson(body.text) })
    } catch (error: unknown) {
      json(res, 200, { ok: false, error: safeMessage(error) })
      return
    }
    json(res, 200, verdict)
  }
}

/** Mount a guarded action on an optional webServer context. */
export function registerGuardedActionRoute(ctx: Context, options: GuardedActionRouteOptions): void {
  ctx.effect(() => {
    const dispose = ctx.webServer.register({
      kind: 'exact',
      path: options.path,
      handler: guardedActionHandler({ key: options.key, handler: options.handler }),
    })
    return () => {
      dispose()
    }
  }, options.effectLabel)
}

/**
 * The action behind the reset route.
 *
 * `at` is stamped after the write, not before: the card shows it as the moment
 * the reset took effect, and a timestamp taken before a slow disk write would
 * claim the reset happened earlier than it did.
 */
function deviceResetAction(
  deps: QoderDeviceResetRouteOptions,
): (request: GuardedActionRequest) => Promise<unknown> {
  return async () => {
    const outcome = await deps.reset()
    return { ok: true, accounts: outcome.accounts, at: Date.now() }
  }
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
  return guardedActionHandler({ key, handler: deviceResetAction(deps) })
}

/** Mount the POST device-reset route on an optional webServer context. */
export function registerQoderDeviceResetRoute(
  ctx: Context,
  deps: QoderDeviceResetRouteOptions,
  key: string,
): void {
  registerGuardedActionRoute(ctx, {
    path: deps.path ?? QODER_DEVICE_RESET_PATH,
    key,
    effectLabel: 'dsh-qoder-plugin: device reset route',
    handler: deviceResetAction(deps),
  })
}

/** Result of one install attempt, as the job runner needs it. */
export interface QoderUmidInstallOutcome {
  /** Whether the component is now present and self-checked. */
  ok: boolean
  /** Why it failed, for the card; absent on success. */
  error?: string
}

/** What the status document needs to know about the install job. */
export interface QoderUmidInstallJobState {
  /** Whether an install is running right now. */
  installing: boolean
  /** Identifier of the running job, when one is running. */
  jobId?: string
  /** The last failure, redacted, still in effect. */
  lastError?: string
}

/** The in-process install job: one at a time, never awaited by a request. */
export interface QoderUmidInstallRunner {
  /**
   * Begin an install unless one is already running.
   *
   * @param force - reinstall even when a usable component is present.
   * @returns whether this call started the job, and the job's identifier.
   */
  start: (force: boolean) => { started: boolean, jobId: string }
  /** @returns the current job state, for the status document. */
  state: () => QoderUmidInstallJobState
}

/**
 * Single-flight wrapper around the install.
 *
 * The install downloads a tarball, extracts it, and runs a self-check — tens of
 * seconds on a good connection, and unbounded on a bad one. A request must not
 * wait for that: the browser would time out long before the answer and the card
 * would show a failure for an install that is still going. So the request
 * starts the job and answers with its id; the card then polls the status
 * document, which is a route it already polls.
 *
 * Single-flight because the work is idempotent but expensive and
 * non-reentrant: two overlapping installs would race on the staging directory
 * and could promote a half-written component. The second caller is told
 * `alreadyRunning` with the SAME job id, so it can watch the job it did not
 * start rather than being told it failed.
 *
 * A synchronous throw from `install` is deliberately NOT caught: it propagates
 * to the route's guard, which reports `{ ok: false, error }` in the response.
 * That is the only failure the caller can still be told about directly, and
 * swallowing it would leave a request answered `started: true` for a job that
 * never existed. Asynchronous rejections cannot reach the response — it is
 * already sent — so they land in {@link QoderUmidInstallJobState.lastError},
 * where the card reads them from the next status poll.
 *
 * @param install - the install itself.
 * @param now - clock for job ids; injected so tests can pin it.
 * @returns the runner.
 */
export function createQoderUmidInstallRunner(
  install: (force: boolean) => Promise<QoderUmidInstallOutcome>,
  now: () => number = Date.now,
): QoderUmidInstallRunner {
  let running: { jobId: string } | undefined
  let lastError: string | undefined
  // Monotonic per process so two jobs started in the same millisecond cannot
  // share an id; the card compares ids to decide whether "installing" is its
  // own job.
  let sequence = 0
  return {
    start(force) {
      if (running !== undefined) return { started: false, jobId: running.jobId }
      sequence += 1
      const job: { jobId: string } = { jobId: `umid-${now()}-${sequence}` }
      running = job
      // A fresh attempt clears the previous verdict: the card must not show
      // "last install failed" beside a job that is running right now.
      lastError = undefined
      /*
       * Floating on purpose. Nothing awaits this promise: the request has
       * already been answered by the time the install could finish, and the
       * outcome is observed through `state()` on the next status poll. The
       * rejection handler is attached here rather than at the call site so an
       * unhandled rejection can never escape from a background job.
       */
      void install(force).then(
        outcome => {
          if (!outcome.ok) lastError = outcome.error ?? 'the native component install failed'
        },
        (error: unknown) => {
          lastError = safeMessage(error)
        },
      ).finally(() => {
        // Only the job that is still registered may clear the slot: a job that
        // somehow outlived a newer one must not report the newer one as done.
        if (running === job) running = undefined
      })
      return { started: true, jobId: job.jobId }
    },
    state() {
      return {
        installing: running !== undefined,
        ...running === undefined ? {} : { jobId: running.jobId },
        ...lastError === undefined ? {} : { lastError },
      }
    },
  }
}

/** Constructor dependencies for {@link registerQoderUmidInstallRoute}. */
export interface QoderUmidInstallRouteOptions {
  /** The install job this route starts. */
  runner: QoderUmidInstallRunner
  /** Route path to mount; defaults to {@link QODER_UMID_INSTALL_PATH}. */
  path?: string
}

/** Read the `force` flag from a request body; anything else is "no". */
function readForce(body: unknown): boolean {
  if (typeof body !== 'object' || body === null) return false
  return (body as Record<string, unknown>)['force'] === true
}

/**
 * The action behind the install route.
 *
 * `alreadyRunning` is an ANSWER, not an error: the user pressed the button
 * twice, or a second card asked, and the honest reply is "a job is already
 * running, watch this one" — the card then polls the status document. Reporting
 * it as a failure would show an error for the state the user asked for.
 */
function umidInstallAction(
  runner: QoderUmidInstallRunner,
): (request: GuardedActionRequest) => Promise<unknown> {
  return async request => {
    const { started, jobId } = runner.start(readForce(request.body))
    return started
      ? { ok: true, started: true, jobId }
      : { ok: true, alreadyRunning: true, jobId }
  }
}

/**
 * The install route's handler, extracted so tests can mount it on a bare server
 * with a known key and a fake install.
 *
 * @param deps - the install job.
 * @param key - the in-process settings key this route requires.
 * @returns the Node request handler.
 */
export function qoderUmidInstallHandler(
  deps: QoderUmidInstallRouteOptions,
  key: string,
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  return guardedActionHandler({ key, handler: umidInstallAction(deps.runner) })
}

/** Mount the POST native-component install route on an optional webServer context. */
export function registerQoderUmidInstallRoute(
  ctx: Context,
  deps: QoderUmidInstallRouteOptions,
  key: string,
): void {
  registerGuardedActionRoute(ctx, {
    path: deps.path ?? QODER_UMID_INSTALL_PATH,
    key,
    effectLabel: 'dsh-qoder-plugin: native component install route',
    handler: umidInstallAction(deps.runner),
  })
}
