/**
 * Plugin-owned settings scope over the Host's settings face.
 *
 * The configuration this plugin edits used to be written through the host's
 * settings service (`settingsScope` on 0.1.5, `configForms` on 0.1.7). On 0.1.7
 * every such write persists through the profile patch
 * (`configEditor.edit`), which reconciles the whole loader tree and hot-reloads
 * the plugin's fiber (~1–1.5 s) and refreshes every client mirror — so each
 * toggle of a sidebar-quota switch paid a full tree recompose.
 *
 * The host half now serves this plugin's configuration from its own settings
 * file over a loopback route; this module is the browser half of that contract,
 * implementing the same {@link QuotaSettingsScope} surface the card was written
 * against, so the card needs no change at all.
 */

import type {
  QuotaDeviceResetResult,
  QuotaSection,
  QuotaSettingsScope,
  QuotaSettingsSnapshot,
  QuotaUmidInstallResult,
} from './QuotaSettingsCard.tsx'

/** Base path of the host half's settings face. */
const ROUTE_BASE = '/plugins/dsh-qoder-plugin'

/**
 * How many times the initial read is attempted before the face is given up on.
 *
 * The read races the host plugin's own mount: on a fresh page the browser half
 * may activate while the host route is still being registered, and a host
 * reload disposes the old route before the new one answers. A single failed
 * read used to leave the card on its schema defaults forever — every control
 * enabled and inert — so the read retries instead of trusting one attempt.
 */
const LOAD_ATTEMPTS = 3

/** Delay before each retry of the initial read, in milliseconds. */
const LOAD_RETRY_DELAY_MS: readonly number[] = [400, 1200]

/** The document the host's GET and POST answer with. */
interface SettingsFaceDocument {
  /** Write authorizer, minted per host plugin lifetime. */
  key: string
  /** Effective values: the settings file over the composition entry. */
  value: Partial<QuotaSection>
  /** The schema defaults the host serves. */
  base: Partial<QuotaSection>
  /** The user layer exactly as stored (presence marks an override). */
  user: Partial<QuotaSection>
}

/**
 * A refused settings-face request, carrying the HTTP status so the caller can
 * tell a rotated write key (recoverable: re-read and retry) from a refused
 * value (not recoverable: report it).
 */
class SettingsFaceError extends Error {
  readonly status: number

  constructor(message: string, status: number) {
    super(message)
    this.name = 'SettingsFaceError'
    this.status = status
  }
}

/**
 * Fetch one settings face document.
 * @param init - the request init (method, headers, body).
 * @returns the parsed document.
 * @throws {SettingsFaceError} when the transport or the host refuses the request.
 */
async function request(init: RequestInit): Promise<SettingsFaceDocument> {
  const response = await fetch(`${ROUTE_BASE}/settings`, {
    credentials: 'same-origin',
    ...init,
  })
  const value: unknown = await response.json().catch(() => undefined)
  if (!response.ok) {
    const error = typeof value === 'object' && value !== null && 'error' in value
      ? String((value as Record<string, unknown>)['error'])
      : `HTTP ${response.status}`
    throw new SettingsFaceError(error, response.status)
  }
  if (typeof value !== 'object' || value === null || !('value' in value)) {
    throw new SettingsFaceError('qoder: settings face answered an invalid document', response.status)
  }
  return value as SettingsFaceDocument
}

/**
 * @param error - whatever a face request threw.
 * @returns whether the refusal means the write key went stale, not that the value was bad.
 */
function isStaleKeyRefusal(error: unknown): boolean {
  // 401/403: the key was re-minted by a host reload. 404/405: the route itself
  // was unmounted and re-registered underneath us. Neither says anything about
  // the value, so re-reading the document and retrying is the right response.
  return error instanceof SettingsFaceError
    && (error.status === 401 || error.status === 403 || error.status === 404 || error.status === 405)
}

/**
 * @param error - whatever a face request threw.
 * @returns a short message the card can show the user.
 */
function describeFailure(error: unknown): string {
  if (error instanceof SettingsFaceError) return error.message
  if (error instanceof Error && error.message !== '') return error.message
  return 'the settings service did not answer'
}

/**
 * The scope the card was written against, backed by this plugin's own file.
 *
 * A write optimistically adopts the value it just sent, then confirms with the
 * host's answer (which re-reads the file it wrote), so the card never renders a
 * value the host does not hold.
 */
export class OwnQuotaSettingsScope implements QuotaSettingsScope<QuotaSection> {
  private document: SettingsFaceDocument | undefined
  private readonly listeners = new Set<() => void>()
  private snapshot: QuotaSettingsSnapshot<QuotaSection> = { status: 'loading', value: undefined, writable: true }
  /** The last refusal, as a message for the card; absent once a write lands. */
  private error: string | undefined
  /** The last refusal, kept for the retry decision and the error report. */
  private lastFailure: string | undefined
  /** Whether the last refusal was a stale write key (recoverable by re-reading). */
  private lastFailureIsStaleKey = false
  /** The read in flight, so a second caller joins it instead of racing it. */
  private pending: Promise<QuotaSection | undefined> | undefined

  /**
   * Load the current document, retrying a read that raced the host's mount.
   *
   * Repeated calls are harmless and re-read the host.
   * @returns the effective values, or undefined when every attempt failed.
   */
  async load(): Promise<QuotaSection | undefined> {
    this.error = undefined
    const run = this.readWithRetries()
    this.pending = run
    try {
      return await run
    } finally {
      if (this.pending === run) this.pending = undefined
    }
  }

  /**
   * Load the document unless it is already loaded or being loaded.
   *
   * The card calls this on mount: the browser half can activate before the host
   * route exists, and a face that never answered must be retried rather than
   * left disabled for the lifetime of the page.
   */
  ensureLoaded(): void {
    if (this.document !== undefined || this.pending !== undefined) return
    void this.load()
  }

  /** @returns the effective values, or undefined when every attempt failed. */
  private async readWithRetries(): Promise<QuotaSection | undefined> {
    for (let attempt = 0; attempt < LOAD_ATTEMPTS; attempt += 1) {
      if (attempt > 0) await delay(LOAD_RETRY_DELAY_MS[attempt - 1] ?? 1200)
      try {
        this.document = await request({ headers: { accept: 'application/json' } })
        this.publish()
        return this.document.value
      } catch (error) {
        this.lastFailure = describeFailure(error)
      }
    }
    // An unreachable face is not a broken card: it stays on its defaults and
    // the controls stay inert. The reason rides the snapshot, because a card
    // that only says "loading…" forever is indistinguishable from a broken one.
    this.error = this.lastFailure ?? 'the settings service did not answer'
    this.publish()
    return undefined
  }

  /** @returns the stable snapshot the card reads (ready once loaded). */
  getSnapshot(): QuotaSettingsSnapshot<QuotaSection> {
    return this.snapshot
  }

  /** @param listener - invoked after every snapshot change. @returns the disposer. */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /**
   * Write one field.
   * @param field - field name inside the settings document.
   * @param value - the JSON-shaped value to store.
   * @returns whether the host accepted the write.
   */
  async set(field: string, value: unknown): Promise<boolean> {
    return this.patch({ [field]: value })
  }

  /**
   * Clear one field: the value falls back to the schema default.
   * @param field - field name inside the settings document.
   * @returns whether the host accepted the clear.
   */
  async unset(field: string): Promise<boolean> {
    return this.patch({ [field]: null })
  }

  /**
   * Send one patch and adopt the host's answer.
   *
   * A refusal that means the write key went stale (the host plugin was
   * reloaded, which re-mints the key and re-registers the route) is healed by
   * re-reading the document and retrying once: without that, every control
   * stayed inert until the page itself was reloaded.
   */
  private async patch(patch: Record<string, unknown>): Promise<boolean> {
    const sent = await this.send(patch)
    if (sent !== undefined) return this.adopt(sent)
    if (this.lastFailureIsStaleKey) {
      const refreshed = await this.tryRead()
      if (refreshed !== undefined) {
        const retried = await this.send(patch)
        if (retried !== undefined) return this.adopt(retried)
      }
    }
    // Report the refusal: the card must not leave a control looking applied
    // when the host holds the old value.
    this.error = this.lastFailure ?? 'the settings service refused the change'
    this.publish()
    return false
  }

  /** @returns the accepted document, or undefined (recording the failure). */
  private async send(patch: Record<string, unknown>): Promise<SettingsFaceDocument | undefined> {
    const key = this.document?.key
    if (key === undefined) {
      this.lastFailure = 'the settings service has not loaded yet'
      this.lastFailureIsStaleKey = false
      return undefined
    }
    try {
      return await request({
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Qoder-Settings-Key': key,
        },
        body: JSON.stringify(patch),
      })
    } catch (error) {
      this.lastFailure = describeFailure(error)
      this.lastFailureIsStaleKey = isStaleKeyRefusal(error)
      return undefined
    }
  }

  /** @returns one accepted read, or undefined (recording the failure). */
  private async tryRead(): Promise<SettingsFaceDocument | undefined> {
    try {
      const document = await request({ headers: { accept: 'application/json' } })
      this.document = document
      return document
    } catch (error) {
      this.lastFailure = describeFailure(error)
      return undefined
    }
  }

  /** Adopt an accepted document and clear the error. */
  private adopt(document: SettingsFaceDocument): boolean {
    this.document = document
    this.error = undefined
    this.lastFailure = undefined
    this.lastFailureIsStaleKey = false
    this.publish()
    return true
  }

  /**
   * Give every saved account a new device code.
   *
   * Not a settings write: the host rotates a seed file and drops its cached job
   * tokens, and the answer is a verdict rather than a document, so it is sent to
   * its own route. A rotated write key (the host plugin reloaded, which re-mints
   * the key) is healed the same way a settings write is: re-read, then retry
   * once. Without that the button would look broken until the page reloaded.
   *
   * @returns the host's verdict, or a failure carrying a message to show.
   */
  async resetDeviceCodes(): Promise<QuotaDeviceResetResult> {
    const sent = await this.sendReset()
    if (!sent.stale) return sent.result
    const refreshed = await this.tryRead()
    if (refreshed === undefined) return sent.result
    return (await this.sendReset()).result
  }

  /** @returns the host's verdict plus whether the key needs a re-read. */
  private async sendReset(): Promise<{ result: QuotaDeviceResetResult; stale: boolean }> {
    // The button can be pressed before anything else on the card has read the
    // settings face (a signed-out account never polls it). Read once here rather
    // than answering "not loaded yet" to a user who cannot act on that.
    if (this.document === undefined) await this.tryRead()
    const key = this.document?.key
    if (key === undefined) {
      return { result: { ok: false, error: 'the settings service has not loaded yet' }, stale: false }
    }
    try {
      const response = await fetch(`${ROUTE_BASE}/device-reset`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', 'X-Qoder-Settings-Key': key },
        // The action carries no fields; a body keeps the request a plain POST
        // that every proxy in front of the host already forwards.
        body: '{}',
      })
      const value: unknown = await response.json().catch(() => undefined)
      const record = typeof value === 'object' && value !== null ? value as Record<string, unknown> : undefined
      if (record !== undefined && record['ok'] === true) {
        const accounts = typeof record['accounts'] === 'number' ? record['accounts'] : undefined
        return { result: accounts === undefined ? { ok: true } : { ok: true, accounts }, stale: false }
      }
      const message = typeof record?.['error'] === 'string' ? record['error'] : `HTTP ${response.status}`
      // The route was unmounted or re-keyed underneath us, so the refusal says
      // nothing about the action itself. A 403 is only "re-keyed" when the host
      // names the key: `request-not-trusted` (a cross-site or non-loopback
      // caller) will not be fixed by re-reading, and retrying it would spend a
      // round trip to learn the same thing.
      const stale = response.status === 401
        || response.status === 404
        || response.status === 405
        || (response.status === 403 && message === 'invalid-settings-key')
      return { result: { ok: false, error: message }, stale }
    } catch (error) {
      return { result: { ok: false, error: describeFailure(error) }, stale: false }
    }
  }

  /**
   * Install the official native device-identity component.
   *
   * Same shape as {@link resetDeviceCodes}, and for the same reasons: this is
   * not a settings write, so it goes to its own route with the same key, and a
   * rotated write key (the host plugin reloaded, which re-mints the key) is
   * healed by re-reading and retrying once. Without that the button would look
   * broken until the page reloaded.
   *
   * The answer is a JOB, not an install. The host downloads, extracts, and
   * self-checks in the background because the request cannot wait for that, so
   * `ok` here means "a job is running" — the progress and the outcome are read
   * from the status document, which the card already polls. `alreadyRunning` is
   * a SUCCESS carrying the running job's id: the user pressed twice, or two
   * cards asked, and the card then watches the job it did not start.
   *
   * @returns the host's verdict, or a failure carrying a message to show.
   */
  async installUmid(): Promise<QuotaUmidInstallResult> {
    const sent = await this.sendInstall()
    if (!sent.stale) return sent.result
    const refreshed = await this.tryRead()
    if (refreshed === undefined) return sent.result
    return (await this.sendInstall()).result
  }

  /** @returns the host's verdict plus whether the key needs a re-read. */
  private async sendInstall(): Promise<{ result: QuotaUmidInstallResult; stale: boolean }> {
    // The same race the reset has: the button can be pressed before anything
    // else on the card has read the settings face (a signed-out account never
    // polls it). Read once here rather than answering "not loaded yet" to a
    // user who cannot act on that.
    if (this.document === undefined) await this.tryRead()
    const key = this.document?.key
    if (key === undefined) {
      return { result: { ok: false, error: 'the settings service has not loaded yet' }, stale: false }
    }
    try {
      const response = await fetch(`${ROUTE_BASE}/umid-install`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', 'X-Qoder-Settings-Key': key },
        /*
         * `force: false` on purpose. A press means "make sure the component is
         * installed", not "replace the copy that is working": a reinstall
         * spends a download and a self-check to reach the state the host is
         * already in, and a user who wants that can delete the directory. The
         * flag exists on the route so a future explicit action can set it.
         */
        body: JSON.stringify({ force: false }),
      })
      const value: unknown = await response.json().catch(() => undefined)
      const record = typeof value === 'object' && value !== null ? value as Record<string, unknown> : undefined
      if (record !== undefined && record['ok'] === true) {
        const jobId = typeof record['jobId'] === 'string' ? record['jobId'] : undefined
        return {
          result: {
            ok: true,
            started: record['started'] === true,
            alreadyRunning: record['alreadyRunning'] === true,
            ...jobId === undefined ? {} : { jobId },
          },
          stale: false,
        }
      }
      const message = typeof record?.['error'] === 'string' ? record['error'] : `HTTP ${response.status}`
      // Same rule as the reset: a 403 is only "re-keyed" when the host names
      // the key. `request-not-trusted` (a cross-site or non-loopback caller)
      // will not be fixed by re-reading, and retrying it would spend a round
      // trip to learn the same thing.
      const stale = response.status === 401
        || response.status === 404
        || response.status === 405
        || (response.status === 403 && message === 'invalid-settings-key')
      return { result: { ok: false, error: message }, stale }
    } catch (error) {
      return { result: { ok: false, error: describeFailure(error) }, stale: false }
    }
  }

  /** Rebuild the cached snapshot and notify the subscribers. */
  private publish(): void {
    this.snapshot = {
      status: this.document === undefined ? 'loading' : 'ready',
      value: this.document?.value,
      writable: true,
      ...(this.error === undefined ? {} : { error: this.error }),
    }
    for (const listener of this.listeners) listener()
  }
}

/**
 * @param milliseconds - how long to wait.
 * @returns a promise settled after the delay.
 */
function delay(milliseconds: number): Promise<void> {
  return new Promise<void>(resolve => { setTimeout(resolve, milliseconds) })
}
