/**
 * Qoder credential storage — a pool of Personal Access Tokens per variant.
 *
 * Every credential the plugin holds is a PAT the human pasted into the
 * variant's card (or exported into the environment, or saved by the CLI).
 * There is no device flow, no token refresh, and no expiry: a PAT is valid
 * until the user revokes it, so this store only reads, writes, and deletes a
 * small JSON document.
 *
 * One file per variant inside the plugin's data directory
 * (`<.dsh-qoder-plugin>/`). The on-disk schema is
 * `{version: 3, activeId, accounts: [{id, pat, region, savedAt}]}`.
 *
 * Why a *pool* rather than the single token the file used to hold: a user with
 * more than one account (their own, a colleague's, a spare bought for exactly
 * this) should not have to paste a token back in every time they want to use
 * the other one, and — more importantly — a request that cannot reach the
 * upstream on one account should be able to finish on the next without the
 * human in the loop. Both of those need the other tokens to still be here.
 *
 * Order is the order accounts were saved in. This store deliberately does not
 * rank them: it knows nothing about any account's health, and inventing an
 * order would silently reorder a user's own list.
 *
 * @module dsh-qoder-plugin/auth
 */

import { createHash } from 'node:crypto'
import { mkdir, readFile, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { qoderPluginDataDir, QODER_DATA_DIR_ENV, QODER_DATA_DIR_NAME } from './paths.ts'
import type { QoderRegion } from './qoder/region.ts'
import type { QoderAccountSummary, QoderCredentialSource, QoderPatSummary } from './status-paths.ts'
import type { QoderVariant } from './variants.ts'

// Re-exported for compatibility: existing callers import these from here.
export { qoderPluginDataDir, QODER_DATA_DIR_ENV, QODER_DATA_DIR_NAME }

/** The on-disk document version this writer produces. */
const AUTH_SCHEMA_VERSION = 3

/** Environment fallback for the global arm when no file exists. */
export const QODER_PAT_ENV_GLOBAL = 'QODER_PERSONAL_ACCESS_TOKEN'

/** Environment fallback for the China arm when no file exists. */
export const QODER_PAT_ENV_CN = 'QODER_CN_PERSONAL_ACCESS_TOKEN'

/** Basename of the China variant's credential file inside the data directory. */
export const QODER_AUTH_FILENAME = '.qoder-auth.json'

/** Minimal logger surface the plugin context already provides. */
export interface AuthLogger {
  warn?(...args: unknown[]): void
}

/** Runtime credential, timestamps in epoch milliseconds. */
export interface QoderCredential {
  pat: string
  region: QoderRegion
  /** When the stored token was saved; absent for environment-sourced tokens. */
  savedAtMs?: number
  source: QoderCredentialSource
}

/**
 * One token in the pool, named by the identity that survives across rewrites.
 *
 * `id` is derived from the token itself rather than assigned, so the same
 * token re-pasted later lands on the same row instead of accumulating
 * duplicates — and so the id can be shown, stored in probe records, and sent
 * to the card without carrying anything that could be replayed.
 */
export interface QoderStoredAccount {
  id: string
  pat: string
  region: QoderRegion
  /**
   * When the token was saved, epoch milliseconds.
   *
   * Optional because the FILE may legitimately lack it: a v2 document written
   * by a build that omitted it, or a hand-edited file, reads as "unknown" — and
   * unknown must stay absent all the way to the card rather than being
   * invented. Stamp 0 would render as 1970 and claim a save time nobody
   * recorded.
   */
  savedAtMs?: number
  /**
   * Whether this account may sign requests, when the user has parked it.
   *
   * Absent means ENABLED, and the distinction is load-bearing rather than
   * cosmetic: this file is user data written by earlier builds that knew no
   * such field, so reading "absent" as "disabled" would park every account of
   * every existing installation on upgrade. The writer therefore round-trips
   * the field as it found it — a row that never carried the flag is written
   * back without it, and only an explicit park materializes `false`. That
   * keeps the on-disk shape as small as it was for the overwhelmingly common
   * case while still letting the parked case survive a restart.
   */
  enabled?: boolean
}

/** Read-only sign-in summary for status, the PAT route, and doctor output. */
export interface QoderAuthStatus {
  state: 'configured' | 'missing'
  /** Redacted summary of the token in effect, when there is one. */
  pat?: QoderPatSummary
  /** Which upstream region the token is used against. */
  region?: QoderRegion
  /** Why no credential is usable, when diagnosable (a stale legacy file). */
  reason?: string
  /** Absolute path of the credential file this store owns. */
  filePath: string
}

/** Constructor options. */
export interface QoderStoreOptions {
  variant: QoderVariant
  /** Explicit plugin-owned credential path, defaulting under the data dir. */
  ownPath?: string
  /** Logger for the legacy-file warning; optional so tests stay quiet. */
  logger?: AuthLogger
}

/** The credential file's in-memory shape. */
interface AuthDocument {
  /**
   * Identity of the account that signs requests. Absent only when the pool is
   * empty; a file whose pointer names a row that is gone falls back to the
   * first account rather than reading as signed out.
   */
  activeId: string | undefined
  /** Accounts in save order — the order automatic failover walks. */
  accounts: QoderStoredAccount[]
}

/** Last four characters of a token, for display. */
export function patTail(pat: string): string | undefined {
  const trimmed = pat.trim()
  return trimmed.length >= 4 ? trimmed.slice(-4) : undefined
}

/**
 * Stable identity key for a credential, used by probe records and saved
 * catalogs.
 *
 * A PAT is a bearer secret, so the key is its one-way hash rather than any
 * suffix of it: surfaces that show the key (cards, JSON diagnostics) leak
 * nothing usable, while two reads of the same token still correlate locally.
 */
export function qoderCredentialIdentity(credential: Pick<QoderCredential, 'pat'>): string {
  return `pat:${createHash('sha256').update(credential.pat).digest('hex').slice(0, 16)}`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** A finite epoch-millisecond stamp, or `undefined` for anything else. */
function readTimestamp(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

export class QoderCredentialStore {
  private readonly variant: QoderVariant
  private readonly ownPath: string
  private readonly logger: AuthLogger | undefined
  /** The legacy-file warning is emitted once per process, not per read. */
  private legacyWarned = false
  /** Tail of the mutator queue; see {@link QoderCredentialStore.exclusive}. */
  private chain: Promise<unknown> = Promise.resolve()

  constructor(options: QoderStoreOptions) {
    this.variant = options.variant
    this.ownPath = options.ownPath ?? join(qoderPluginDataDir(), options.variant.ownFilename)
    this.logger = options.logger
  }

  /** Absolute path of this variant's credential file, for display and tests. */
  ownAuthPath(): string {
    return this.ownPath
  }

  /**
   * Every stored account, in save order.
   *
   * The pool without the projection: callers that must act on a token (the
   * transport's failover, the CLI) need the secret; callers that only render
   * it use {@link QoderCredentialStore.accounts}.
   */
  async list(): Promise<readonly QoderStoredAccount[]> {
    return (await this.readDocument()).accounts
  }

  /**
   * The browser-safe account list for the card.
   *
   * An environment-sourced token is deliberately absent: it is not a stored
   * account, cannot be switched away from or removed here, and listing it
   * beside removable rows would offer actions that cannot work. It still signs
   * requests when no file exists — that is `current()`'s job, not this list's.
   *
   * `source` is always `card`: the file does not record who typed the token,
   * because "card vs cli" only says which entry point ran the same save and a
   * file left by any other tool is indistinguishable from the card's.
   */
  async accounts(): Promise<readonly QoderAccountSummary[]> {
    const document = await this.readDocument()
    const activeId = activeIdOf(document)
    return document.accounts.map((account, index) => {
      const tail = patTail(account.pat)
      return {
        id: account.id,
        ...tail === undefined ? {} : { patTail: tail },
        ...account.savedAtMs === undefined ? {} : { savedAtMs: account.savedAtMs },
        source: 'card' as const,
        // The active row stays active even when parked: parking only removes an
        // account from the automatic walk, and the user may still hand-switch
        // back to it — reporting it as "not current" would make the card offer
        // a switch to the account that is already signing.
        active: account.id === activeId,
        order: index + 1,
        // Only an explicit park is projected, so a document written before the
        // field existed keeps rendering every row as enabled.
        ...account.enabled === false ? { enabled: false } : {},
      }
    })
  }

  /**
   * The credential currently in effect, or `undefined` when there is none.
   *
   * Resolution order: the active account in the plugin-owned file, then the
   * arm's environment variable (only when no file account exists — a saved
   * token always wins over a stray env), then nothing. There is no refresh and
   * no expiry check: a PAT lives until revoked.
   */
  async current(): Promise<QoderCredential | undefined> {
    const document = await this.readDocument()
    const active = activeAccountOf(document)
    if (active !== undefined) return credentialOf(active)
    return this.fromEnvironment()
  }

  /**
   * The credential, or a thrown `MISSING_CREDENTIAL` error.
   *
   * Callers that serve requests (the shim, the catalog sweep) use this so the
   * absence of a token surfaces as the same classified failure the transport
   * itself raises when a saved token turns out empty.
   */
  async resolve(): Promise<QoderCredential> {
    const credential = await this.current()
    if (credential === undefined || credential.pat.trim() === '') {
      throw new Error('qoder: MISSING_CREDENTIAL — no Personal Access Token is configured. Add one in the Qoder settings card.')
    }
    return credential
  }

  /** The token in effect as a bare string, rejecting when there is none. */
  async patPromise(): Promise<string> {
    return (await this.resolve()).pat
  }

  /**
   * Persist a token for this variant, and make it the active account.
   *
   * The caller is responsible for having validated it against the region first
   * (`validateApiKey` upstream). Saving a token that is already stored updates
   * it in place and selects it: pasting the same token again means "use this
   * one", not "add a second copy of it".
   */
  async save(pat: string, source: QoderCredentialSource = 'card'): Promise<QoderCredential> {
    const trimmed = pat.trim()
    if (trimmed === '') throw new Error('qoder: cannot save an empty Personal Access Token')
    return this.exclusive(async () => {
      const id = qoderCredentialIdentity({ pat: trimmed })
      const savedAtMs = Date.now()
      const document = await this.readDocument()
      const existing = document.accounts.find(account => account.id === id)
      if (existing === undefined) {
        document.accounts.push({ id, pat: trimmed, region: this.variant.region, savedAtMs })
      } else {
        existing.pat = trimmed
        existing.region = this.variant.region
        existing.savedAtMs = savedAtMs
        // Re-pasting a token is the user saying "this one should work again".
        // A parked row that is saved afresh is therefore un-parked: requiring a
        // second click on the checkbox after a re-save would resurrect the
        // exact confusion parking exists to avoid — a token that is visibly
        // saved yet never used.
        delete existing.enabled
      }
      document.activeId = id
      await this.writeDocument(document)
      return { pat: trimmed, region: this.variant.region, savedAtMs, source }
    })
  }

  /**
   * Make one stored account sign requests.
   *
   * Throws on an unknown id rather than quietly selecting something else: the
   * only caller is the card, whose id came from a status document that may
   * have gone stale (the row was removed in another tab), and silently
   * switching to a *different* account than the one asked for is exactly the
   * surprise this feature exists to remove.
   */
  async activate(accountId: string): Promise<QoderCredential> {
    return this.exclusive(async () => {
      const document = await this.readDocument()
      const account = document.accounts.find(entry => entry.id === accountId)
      if (account === undefined) {
        throw new Error(`qoder: no stored account matches ${accountId}`)
      }
      if (document.activeId !== accountId) {
        document.activeId = accountId
        await this.writeDocument(document)
      }
      return credentialOf(account)
    })
  }

  /**
   * Drop one stored account. Returns whether one was actually removed.
   *
   * Removing the active account hands the role to the account that followed it
   * in save order (falling back to the one before it when it was last), which
   * is the same successor automatic failover would have picked — so a user who
   * deletes a dead account lands on a usable one instead of being signed out
   * while other tokens sit in the file.
   */
  async remove(accountId: string): Promise<boolean> {
    return this.exclusive(async () => {
      const document = await this.readDocument()
      const index = document.accounts.findIndex(entry => entry.id === accountId)
      if (index === -1) return false
      document.accounts.splice(index, 1)
      if (document.accounts.length === 0) {
        // The last token is gone, so there is nothing left to remember: delete the
        // document rather than leave `{version: 3, accounts: []}` behind. An empty
        // pool file is indistinguishable from a configured store to anything that
        // inspects it (and to `status()`'s file path), while the user is in
        // exactly the state `clear()` produces — signed out.
        //
        // The deletion is inlined rather than delegated to `clear()`: this block
        // already holds the mutator queue, and `clear()` takes it again.
        await this.deleteDocument()
        return true
      }
      if (document.activeId === accountId) {
        document.activeId = document.accounts[index]?.id ?? document.accounts[index - 1]?.id
      }
      await this.writeDocument(document)
      return true
    })
  }

  /**
   * Park or un-park one stored account. Returns whether the id was found.
   *
   * An unknown id answers `false` rather than throwing: the caller is a card
   * acting on a row it read a moment ago, and the row may legitimately have
   * been removed in another tab — that is a stale click, not a broken request.
   *
   * Parking never touches `activeId`. The account in effect keeps signing until
   * the user (or a failover) moves the pointer, because a checkbox that
   * silently changed which subscription pays would be a much larger action
   * than the one word on it.
   */
  async setEnabled(accountId: string, enabled: boolean): Promise<boolean> {
    return this.exclusive(async () => {
      const document = await this.readDocument()
      const account = document.accounts.find(entry => entry.id === accountId)
      if (account === undefined) return false
      if (enabled) {
        // Back to the default shape: drop the field rather than store `true`,
        // so an account that was never parked and one that was parked and
        // restored are indistinguishable on disk.
        delete account.enabled
      } else {
        account.enabled = false
      }
      await this.writeDocument(document)
      return true
    })
  }

  /**
   * The account after `accountId` in save order, for automatic failover.
   *
   * Wraps, so a caller that tracks the ids it has already tried walks the whole
   * pool exactly once and then stops when the successor is one it has seen.
   * `undefined` means there is nothing else to try: no accounts at all, or only
   * the one that just failed.
   *
   * Parked accounts are skipped. That is the whole point of parking one: it
   * takes an account out of the automatic walk without deleting the token, so
   * a dead subscription stops absorbing half of every failover. The walk is
   * still bounded to one lap of the pool, and a starting id that is itself
   * parked still walks FORWARD from its position — otherwise parking the
   * account that just failed would end the walk instead of moving past it.
   */
  async nextAfter(accountId: string | undefined): Promise<QoderStoredAccount | undefined> {
    const { accounts } = await this.readDocument()
    if (accounts.length === 0) return undefined
    const parked = (account: QoderStoredAccount): boolean => account.enabled === false
    if (accountId === undefined) {
      return accounts.find(account => !parked(account))
    }
    const index = accounts.findIndex(entry => entry.id === accountId)
    if (index === -1) return accounts.find(account => !parked(account))
    // One lap at most: `accounts.length - 1` successors, starting after the
    // current account, so the walk can never answer with the id it was given.
    for (let step = 1; step < accounts.length; step += 1) {
      const candidate = accounts[(index + step) % accounts.length]
      if (candidate !== undefined && !parked(candidate)) return candidate
    }
    return undefined
  }

  /**
   * Resolve one stored account by id, token included.
   *
   * The custom routing order and a pinned session both name accounts by id
   * rather than by position, and both need the PAT to actually sign with. This
   * is the accessor that answers "which token is that id", the counterpart of
   * {@link QoderCredentialStore.accounts}, which deliberately carries no token.
   *
   * `undefined` for an id that names nothing — the card's order may be a poll
   * behind the file, and the walk must skip a removed account instead of
   * failing on it.
   */
  async byId(accountId: string): Promise<QoderStoredAccount | undefined> {
    const { accounts } = await this.readDocument()
    return accounts.find(account => account.id === accountId)
  }

  /** Remove every stored credential. A missing file is not an error. */
  async clear(): Promise<void> {
    await this.exclusive(async () => {
      await this.deleteDocument()
    })
  }

  /**
   * Delete the credential file, if any.
   *
   * Split out of {@link QoderCredentialStore.clear} because `remove` has to do
   * the same deletion from *inside* the mutator queue, and calling `clear` there
   * would wait on a queue its own caller already holds.
   */
  private async deleteDocument(): Promise<void> {
    try {
      await rm(this.ownPath, { force: true })
    } catch {
      // Best effort: a file that cannot be removed will fail validation later
      // and surface through `status()` the same way.
    }
    this.pendingLegacyReason = undefined
  }

  /**
   * Run one read-modify-write section with the file to itself.
   *
   * Every mutator here loads the document, edits the array in memory, and writes
   * it back. Two of them interleaving lose an account: both read the same list,
   * and whichever writes second drops the other's addition — the atomic rename
   * inside `writeDocument` makes each write whole, but says nothing about the
   * read that preceded it. The card can fire two saves from one click (a double
   * submit, or a second tab) and the PAT route holds no lock of its own, so the
   * exclusion lives here instead. Reads stay outside the queue: they either see
   * the old document or the new one, never a torn one, and serializing them
   * would make every status poll wait on someone else's save.
   */
  private async exclusive<T>(work: () => Promise<T>): Promise<T> {
    const result = this.chain.then(work, work)
    // The queue must survive a rejection: one failed save would otherwise poison
    // every later call with the same error, and the store would look dead.
    this.chain = result.then(
      () => undefined,
      () => undefined,
    )
    return result
  }

  /** Alias kept for call-site readability (`logout` is just clearing). */
  async logout(): Promise<void> {
    await this.clear()
  }

  /** Redacted summary for the card, the PAT route, and doctor output. */
  async status(): Promise<QoderAuthStatus> {
    const base: { filePath: string; region?: QoderRegion } = {
      filePath: this.ownPath,
      region: this.variant.region,
    }
    const credential = await this.current()
    if (credential === undefined) {
      return {
        state: 'missing',
        ...base,
        ...this.pendingLegacyReason === undefined ? {} : { reason: this.pendingLegacyReason },
      }
    }
    const tail = patTail(credential.pat)
    return {
      state: 'configured',
      ...base,
      pat: {
        source: credential.source,
        ...credential.savedAtMs === undefined ? {} : { savedAtMs: credential.savedAtMs },
        ...tail === undefined ? {} : { patTail: tail },
      },
    }
  }

  /** Set when a read found a stale WorkBuddy-era file; consumed once. */
  private pendingLegacyReason: string | undefined

  private async fromEnvironment(): Promise<QoderCredential | undefined> {
    const name = this.variant.region === 'china' ? QODER_PAT_ENV_CN : QODER_PAT_ENV_GLOBAL
    const value = process.env[name]?.trim()
    if (value === undefined || value === '') return undefined
    return { pat: value, region: this.variant.region, source: 'env' }
  }

  private async readDocument(): Promise<AuthDocument> {
    let text: string
    try {
      text = await readFile(this.ownPath, 'utf8')
    } catch {
      // An absent file means "not signed in". Any other read failure is treated
      // the same way rather than thrown: the only recovery either way is to
      // save the token again, and a status read must never break the card.
      this.pendingLegacyReason = undefined
      return { activeId: undefined, accounts: [] }
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      this.pendingLegacyReason = undefined
      return { activeId: undefined, accounts: [] }
    }
    if (!isRecord(parsed)) {
      this.pendingLegacyReason = undefined
      return { activeId: undefined, accounts: [] }
    }
    // A WorkBuddy-era document (it carries `accessToken` and no `pat`) is not a
    // credential this plugin can use in any form. Treat it as invalid — never a
    // fake migration — and say so, so the card points at the right fix.
    if (typeof parsed['accessToken'] === 'string' && parsed['pat'] === undefined) {
      this.pendingLegacyReason = 'stale WorkBuddy credential file; save a Qoder Personal Access Token instead'
      if (!this.legacyWarned) {
        this.legacyWarned = true
        this.logger?.warn?.(
          `qoder: ${this.variant.displayName}: ${this.ownPath} holds a WorkBuddy-era credential;`
          + ' it is ignored. Save a Qoder Personal Access Token to replace it.',
        )
      }
      return { activeId: undefined, accounts: [] }
    }
    this.pendingLegacyReason = undefined
    /*
     * Two shapes are readable here, and both must be.
     *
     * The v3 document lists accounts; the v2 document this plugin shipped
     * before held exactly one token at the top level. Reading the old shape is
     * not a courtesy — every existing installation has one, and refusing it
     * would sign those users out on upgrade. The next write rewrites the file
     * as v3, so the old shape disappears on first use.
     *
     * A malformed entry is skipped rather than failing the read: one bad row
     * must not make the other tokens unusable.
     */
    const raw = parsed['accounts']
    const accounts: QoderStoredAccount[] = []
    const seen = new Set<string>()
    const push = (pat: string, savedAt: unknown, enabled: unknown): void => {
      const trimmed = pat.trim()
      if (trimmed === '') return
      const id = qoderCredentialIdentity({ pat: trimmed })
      // Dedupe by identity: a hand-edited file (or a torn write from an older
      // build) must not produce two rows that fail over into each other.
      if (seen.has(id)) return
      seen.add(id)
      const savedAtMs = readTimestamp(savedAt)
      accounts.push({
        id,
        pat: trimmed,
        // Stamped from the variant, never trusted from the file. This store can
        // only ever present a token to its own region, so a row carrying the
        // other region's name — hand-copied between the two files, or written by
        // a build that stored it wrong — is corrected on read and re-stamped by
        // the next write, instead of keeping a claim the store never honours.
        region: this.variant.region,
        ...savedAtMs === undefined ? {} : { savedAtMs },
        // Only a literal `false` parks a row. Anything else — absent, null, a
        // string, a hand-edited `0` — reads as enabled, because the one
        // mistake this must never make is parking an account the user expects
        // to work.
        ...enabled === false ? { enabled: false as const } : {},
      })
    }
    if (Array.isArray(raw)) {
      for (const entry of raw) {
        if (!isRecord(entry)) continue
        if (typeof entry['pat'] !== 'string') continue
        push(entry['pat'], entry['savedAt'], entry['enabled'])
      }
    } else if (typeof parsed['pat'] === 'string') {
      // A v2 single-token document predates parking entirely, so it has no
      // `enabled` to carry: `undefined` here means "enabled", which is right.
      push(parsed['pat'], parsed['savedAt'], undefined)
    }
    const activeId = typeof parsed['activeId'] === 'string' ? parsed['activeId'] : undefined
    return { activeId, accounts }
  }

  private async writeDocument(document: AuthDocument): Promise<void> {
    const payload = {
      version: AUTH_SCHEMA_VERSION,
      activeId: document.activeId ?? document.accounts[0]?.id,
      accounts: document.accounts.map(account => ({
        id: account.id,
        pat: account.pat,
        region: account.region,
        savedAt: account.savedAtMs,
        // Round-tripped rather than always written: see `QoderStoredAccount`.
        // `enabled: undefined` disappears from the JSON, which is exactly the
        // on-disk shape a pre-parking build produced.
        enabled: account.enabled,
      })),
    }
    const directory = dirname(this.ownPath)
    try {
      await mkdir(directory, { recursive: true, mode: 0o700 })
    } catch {
      // An existing or uncreatable directory surfaces on the write below.
    }
    await writeFileAtomic(this.ownPath, `${JSON.stringify(payload, null, 2)}\n`, {
      mode: 0o600,
      dirMode: 0o700,
    })
    this.pendingLegacyReason = undefined
  }
}

/** The active account, falling back to the first when the pointer is stale. */
function activeAccountOf(document: AuthDocument): QoderStoredAccount | undefined {
  const active = activeIdOf(document)
  return active === undefined
    ? undefined
    : document.accounts.find(account => account.id === active)
}

/** The active account's identity, resolved against the accounts actually present. */
function activeIdOf(document: AuthDocument): string | undefined {
  const { activeId, accounts } = document
  if (activeId !== undefined && accounts.some(account => account.id === activeId)) return activeId
  return accounts[0]?.id
}

/** One stored account as the runtime credential the request path consumes. */
function credentialOf(account: QoderStoredAccount): QoderCredential {
  return {
    pat: account.pat,
    region: account.region,
    ...account.savedAtMs === undefined ? {} : { savedAtMs: account.savedAtMs },
    // A file this store wrote came from the card or the CLI; `source` is not
    // persisted because "card vs cli" only records who typed the command.
    source: 'card',
  }
}

/**
 * The plugin-owned credential path for one variant.
 * Kept as a free function for the CLI, which builds no store per display line.
 */
export function qoderOwnAuthPath(variant: QoderVariant): string {
  return join(qoderPluginDataDir(), variant.ownFilename)
}
