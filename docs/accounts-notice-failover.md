# Accounts, upstream notices, and automatic failover — design and contract

What the account pool, the upstream not-serviceable notice and automatic
failover actually do in 1.0.0 and its 1.0.x incident fixes, and which interface
each part owns. It is the
reference for anyone changing that behaviour: the signatures below are the
stable seam between the transport, the host wiring and the browser half, and
`src/status-paths.ts` carries the browser-safe types every side compiles
against (`QoderAuthAction`, `QoderAuthRequest.accountId`, `QoderAccountSummary`,
`QoderWebAccounts`, `QoderWebUpstreamNotice`, `QoderWebStatus.accounts`,
`QoderWebStatus.upstreamNotice`, `QoderWebStatus.innerErrors`).

## Feature 1 — multiple PATs per variant, with switching

### On-disk schema (v3)

```json
{
  "version": 3,
  "activeId": "pat:0123456789abcdef",
  "accounts": [
    { "id": "pat:0123456789abcdef", "pat": "<token>", "region": "china", "savedAt": 1730000000000 }
  ]
}
```

- `id` is `qoderCredentialIdentity({ pat })` — the one-way hash, never the token.
- A v2 document `{version: 2, pat, region, savedAt}` reads as one account whose
  `activeId` is its identity; the next write upgrades the file to v3.
- A WorkBuddy-era document (`accessToken`, no `pat`) stays invalid: never a fake
  migration, and `status().reason` keeps naming the real fix.
- `region` on every entry is `variant.region`; a file claiming another region
  for this variant is still read but re-stamped on the next write.
- Save order is the order accounts appear in `accounts`; nothing sorts them.

### `src/auth.ts`

```ts
export interface QoderStoredAccount {
  id: string
  pat: string
  region: QoderRegion
  savedAtMs: number
}

class QoderCredentialStore {
  ownAuthPath(): string
  current(): Promise<QoderCredential | undefined>   // active file account, else env
  resolve(): Promise<QoderCredential>
  patPromise(): Promise<string>
  list(): Promise<readonly QoderStoredAccount[]>              // file accounts, save order
  accounts(): Promise<readonly QoderAccountSummary[]>         // browser-safe projection
  save(pat: string, source?: QoderCredentialSource): Promise<QoderCredential>  // upsert + activate
  activate(accountId: string): Promise<QoderCredential>       // throws on unknown id
  remove(accountId: string): Promise<boolean>                 // true when one was dropped
  clear(): Promise<void>                                      // drops every account
  status(): Promise<QoderAuthStatus>
  nextAfter(accountId: string | undefined): Promise<QoderStoredAccount | undefined>
}
```

Rules:
- `save` upserts by identity: re-saving a stored token refreshes it and makes it
  active without creating a duplicate row.
- `remove` on the active account activates the next one in save order; removing
  the last account leaves the variant signed out.
- `activate`/`remove` with an unknown id must not silently no-op something else.
- `current()` keeps today's resolution order: active file account, else the
  region's env variable, else nothing.
- `accounts()` returns `[]` (never throws) when there is no file; an env-only
  credential is not a pooled account and does not appear.

### `src/auth-route.ts`

- Accepts `action: 'save-pat' | 'clear' | 'activate-account' | 'remove-account'`.
- `save-pat` keeps its guarantee: validate against the region first, persist only
  on success. Its response is unchanged in shape plus the new fields below.
- `activate-account` / `remove-account` require `accountId`; a missing or unknown
  id answers the route's existing error shape, never a 500.
- `clear` keeps meaning "remove every stored credential".

## Feature 2 — upstream "model not serviceable" notice

The upstream answers a saturated per-model queue with a body carrying
`code: 10605`, `isQueued`, `serviceAvailable: false`, `retryAfterSeconds`,
`modelKey`, `queueCount`, `queueType`, `subCode: RESOURCE_LIMIT`. It may arrive
as HTTP 200, 401, or 403, so the body — not the status — is the signal.

### `src/qoder/queue-notice.ts`

```ts
export interface QoderQueueFacts {
  isQueued: boolean
  serviceAvailable: boolean
  modelKey?: string
  queueCount?: number
  queueType?: string
  retryAfterSeconds?: number
  /** The upstream's own total wait estimate, in seconds, when it ships one. */
  waitTime?: number
  subCode?: string
  /** The upstream's own message text, unescaped and bounded. */
  upstreamMessage?: string
}

export interface QoderQueueWaitProgress {
  /** The wait that is starting, milliseconds. */
  waitMs: number
  /** 1-based place of this wait inside the request's own budget. */
  attempt: number
  /** How many further waits this request may still take (0 = last one). */
  remaining: number
}

export function parseQueueFacts(body: string): QoderQueueFacts | undefined
export function formatQueueNotice(facts: QoderQueueFacts, options: {
  waited: boolean
  occurrences: number
}): string
export function formatQueueWaitNotice(facts: QoderQueueFacts, wait: QoderQueueWaitProgress): string
```

`formatQueueNotice` is the terminal answer, printed when a request gives up
(or immediately, if waiting is disabled). `formatQueueWaitNotice` is the
progress row printed **before each wait starts**: without it a request that
sits out a 30–90 s queue window emits no bytes at all, which reads as a hang
and is what made users abort (and switch models) during the 2026-10 incident.
Each progress text carries its attempt number, so the host's per-turn
"same text once" guard cannot swallow the second wait.

### `src/qoder/errors.ts`

- `qoderQueueSignal(body)` stays and keeps its `{ retryAfterMs }` contract.
- Add `qoderQueueFacts(body): QoderQueueFacts | undefined` re-exported from
  `queue-notice.ts`.
- Classification is unchanged in code terms: this stays `RATE_LIMIT` so the
  host's retry policy rides it out. What changes is that the notice text and the
  facts travel on the error.

### Conversation insertion

Insertion follows this plugin's own established convention for conversation
notices — the log-only `command/run` + `command/done` row pair in
`src/job-token-hint.ts` — NOT a host slot. The live slot tree of this build has
no failure-row seat, and the reference project deliberately declined
`shell.quota-notice` because claiming it replaces the host's own surface.

Add to `src/job-token-hint.ts` (or a sibling it delegates to):

```ts
export function emitUpstreamNotice(text: string): void
```

It appends the same row pair, guarded so a repeated notice in one turn does not
stack rows; `installJobTokenHint(ctx)` keeps tracking the running agent.

The notice text follows the user's approved wording, filled from the parsed
facts rather than hardcoded numbers, and must never claim a wait that did not
happen (`waited` is a fact, and the sentence about waiting appears only when it
is true).

### Progress notification while waiting

The transport exposes the wait itself, not only its failure:

```ts
interface QoderTransportOptions {
  // ...existing...
  onQueueWait?: (
    facts: QoderQueueFacts,
    accountId: string | undefined,
    wait: QoderQueueWaitProgress,
  ) => void
}
```

It fires immediately before `waitOutQueue(...)`, only while the request still
has budget left (`queueWaitAttempts=0` therefore never fires it), and the host
wires it to `emitUpstreamNotice(formatQueueWaitNotice(...))`. The terminal
`formatQueueNotice` path is unchanged: a request that keeps being queued still
ends with the one-shot failure notice.

### `src/qoder/transport/wire/version.ts` — campaign fingerprint

Metadata requests were moved to the official current pair (1.1.75 / 0.4.8) in
the same change that added hostname/identity derivation. The campaign/check-in
family is exempt, because its headers are part of a byte-level-risk posture
documented in `risk-identity.ts`: `campaignUserAgent='qoder/1.1.47'` and
`campaignCosyVersion='1.0.1'` are literals (no env override) selected only by
`fingerprint: 'campaign'` on `openApiJsonRequest`, and only
`fetchCampaigns`/`claimCampaign` pass it. Inference, userinfo/usage/status,
model listing and panel reads keep the current pair.

## Feature 3 — switch to the next account on connection failure

### `src/qoder/transport/`

```ts
export interface QoderFailoverHooks {
  enabled(): boolean
  activeAccount(): Promise<{ id: string; pat: string } | undefined>
  nextAccount(id: string): Promise<{ id: string; pat: string } | undefined>
  switched(info: { fromId: string; toId: string; reason: string }): void | Promise<void>
  adopted?(info: { fromId: string; toId: string; reason: 'cooling' }): void | Promise<void>
  failed?(info: { accountId: string; reason: string; at: number }): void
}

interface QoderTransportOptions {
  // ...existing...
  failover?: QoderFailoverHooks
}
```

Rules:
- Try the active account first; on a **connection-level** failure (fetch threw,
  timeout, stream interrupted before the first chunk, or a classified
  `AUTH`/`RATE_LIMIT`/`SERVER` rejection) advance to the next account in save
  order and retry, at most one pass over the pool.
- Never switch on `INVALID_REQUEST` (a malformed request fails identically on
  every account) and never after the first chunk has been emitted — bytes
  already sent cannot be unsent.
- A switch calls `switched(...)` so the host adopts the new identity; the reason
  is a short redacted string. `switched` is reserved for **real failures**: the
  host persists a new active account and prints an error-coloured notice from
  it, so calling it for a local scheduling decision fabricates an outage.
- A cooling account is skipped silently for this request and announced through
  `adopted(...)` instead: the host moves the stored active pointer (the
  metadata reads sign with it) without a notice, a failover timestamp or a
  session re-pin. Too many adoptions would churn the pointer, so only the
  cooling reason adopts; a **busy** account (another request currently holds
  the traffic guard) is neither switched nor adopted — nothing is wrong with
  it.
- The failure walk treats every remaining candidate except cooling ones as
  usable, including busy accounts as a last resort (paced behind the guard).
  That fallback is what keeps a two-account pool with one dead PAT from
  turning "the healthy account is busy" into a hard failure.
- `enabled()` false means behave exactly as today: no switch, original error.

### `src/index.ts` / `src/web-status.ts`

- Wire the hooks to the pool (`activeAccount`/`nextAccount` from the store) and
  keep `adoptIdentity` as the only identity of record.
- Project `accounts` and `upstreamNotice` into the status document.

### `src/client/**`

- Accounts list with activate/remove, and the notice rendered in the card.
- Locale strings added to `src/client/locales.ts` in both zh and en.

## Round 3 — account health, parking, and the walk's settings

A later round added three more things on top of the interfaces above. They do
not replace anything here; they extend it.

### `src/account-health.ts`

`QoderAccountHealthTracker` turns upstream answers into the card's 正常 / 排队 /
限流 chip. It is deliberately clock-free (every method takes the timestamp), so
the TTL rule is testable without a fake timer.

- `noteQueue(accountId, atMs)` — the upstream reported its per-model queue.
  `queued` is a fresh observation, not a verdict about the credential: it holds
  for `queuedHealthTtlMs` (5 minutes, covering the transport's own wait ceiling)
  and then falls back to whatever was observed before. A queue answer never
  promotes an account to `limited` — the queue is a fact about the model, and
  conflating it with account trouble is what made a healthy seat look 限流.
- `noteFailure(accountId, atMs)` — a failure that advanced the walk.
  `limitedFailureStreak` (3) consecutive failures promote to `limited`.
- `noteConnected(accountId, atMs)` — an accepted chat. Clears `limited`, the
  failure streak and the queue observation. This is the only path back to
  `normal`.
- `healthOf(accountId, nowMs)` — `limited` → `queued` (still inside the TTL) →
  `normal` → `undefined`, where `undefined` means "nothing observed yet". Every
  surface (card account list, routing list, composer panel) renders it as the
  neutral 「尚未观测」 tag, never as an invented 正常; a parked account shows
  `accountParked` instead and no service state at all.

### Parking

`QoderStoredAccount` gained an optional `enabled?: false`. Absent means enabled —
parking deletes the field, so "never parked" and "restored" are deliberately
indistinguishable on disk. `QoderCredentialStore.setEnabled` writes it,
`nextAfter` skips parked rows, and `accounts()` projects `enabled: false` so the
card and the composer panel can honour it.

Every caller that names an account directly must honour it too, not just the
save-order walk: the custom routing order and a re-resolved pinned session both
go through `failover.accountById`, which therefore answers `undefined` for a
parked account. Without that, parking would only affect `nextAfter` and a route
that names the account would still spend it.

### Settings that shape a request

Seven Config fields, all under 高级设置, all read through functions of
`current()` — `apply()` mints the transport once and a settings write never
re-mints it, so a captured value would freeze at whatever the file held at
startup:

| field | range | default | effect |
|---|---|---|---|
| `autoFailoverEnabled` | bool | `true` | `failover.enabled()` |
| `queueWaitAttempts` | 0..10 | 0 | how many queue windows one request sits out |
| `queueWaitSeconds` | 1..300 | 30 | fallback window when the upstream names none |
| `routingStrategy` | `save-order` \| `custom` | `save-order` | walk order source |
| `routingOrder` | `string[]` | `[]` | account ids, may mix both variants |
| `stickinessRounds` | 0..100 | 3 | completed rounds before the conversation moves on |
| `stickinessRequests` | 0..10000 | 200 | requests before the conversation moves on |
| `stickinessMinutes` | 0..1440 | 180 | minutes before the conversation moves on |

All three stickiness bounds must be satisfied to stay put: any one of them
reaching zero remaining moves the conversation to the **next account of the
walk order** on the following request. A round is one chat whose model output
was consumed to the end, so a request that throws never spends a round.

A mixed `routingOrder` (accounts from both variants) lists the models absent
from one of them as an explanation. It does not gate the write: the walk skips
an account whose variant cannot serve the requested model, so the order the
user asked for is the order that is stored.

### Session stickiness needs the host's session id

Stickiness cannot work from the request body alone. The chain is
`x-session-affinity` (or a bare `session_id`) header → `chatStream(body, signal,
sessionId)` → `toGenerateOptions(..., { sessionId })` → `GenerateOptions.sessionId`
→ the transport's pin table. It was silently dropped before: the adapter did not
set `compat.sendSessionAffinityHeaders`, so pi-ai never emitted the header. All
three links are now in place, and `exactOptionalPropertyTypes` forces the
conditional spread at the last one.

## Round 4 — the 2026-10 incident and its fixes

The user-visible failure was: a new conversation's first request answered with
an error row "已自动切换到下一个账号重试（原因：account is already serving
another request）— 当前请求由备用账号继续", then the model call failed.

The chain: the host's session-title request is a second concurrent call on the
same transport; the first request's reservation made the second treat the
active account as busy, which was wired to `failover.switched`, so the host
persisted a new active account and printed a failover notice — 218 ms after the
request started, before any upstream byte could have failed. The request then
signed with the (stale) spare PAT, failed `AUTH`, and the walk refused to reuse
the "reserved" healthy account, so the original error surfaced.

Fixes, in order:
1. Dispatch decisions are not failovers: cooling and busy skips are silent, do
   not re-pin the session and never call `switched`. A cooling skip is adopted
   through `adopted(...)`; a busy skip is not (nothing is wrong with the seat).
2. The failure walk falls back to busy accounts as a last resort, paced by the
   traffic guard, instead of refusing to retry a healthy seat.
3. One gate for dispatch: the reservation Set is gone, and
   `QoderAccountTrafficLimiter.isBusy()` (held or queued) is the single source
   of "this seat is in use". The walk is a single pass that ranks free,
   deprioritized and busy candidates in that order; `walkAfterFailure` no longer
   exists.
4. The traffic guard releases its slot when the attempt ends, including an
   aborted or failed attempt; nothing is released that the attempt did not
   acquire.
5. Queue waits are announced as they start (`onQueueWait`, see Feature 2), so a
   request that sits out a queue window is visibly waiting rather than silent.
6. The campaign/check-in fingerprint is pinned back to its 1.0.0 bytes (see
   Feature 2 / wire/version.ts): the current metadata pair had leaked into the
   check-in family.
7. The active pointer follows a cooling adoption, so metadata/credits reads do
   not keep using the cooled credential; the failure notification path
   (`switched`) keeps its "persist first, then print" ordering, and a failed
   `activate` only warns.
8. Health labels stopped inventing verdicts: a queue answer is a 5-minute
   `queued` observation (never `limited`), and an unobserved seat renders
   「尚未观测」 everywhere instead of 正常 or nothing.
9. The failover badge distinguishes the user's preference from the pool's
   capability: 已开启 / 自动切换待命（仅 1 个可用账号） / 已关闭.
10. `QoderWebStatus.innerErrors` gained its first consumer: the card's account
    pool renders non-zero in-stream error classes as one caption line.

Regression tests: `tests/transport-reservation.spec.ts` (busy and cooling skips
stay silent, cooling is adopted, busy fallback serves a healthy seat, single
account queues behind the guard, guard failure leaks no slot),
`tests/transport-account-limiter.spec.ts` (`isBusy` window),
`tests/account-health.spec.ts` (TTL, no `limited` from queues),
`tests/plugin-card.spec.ts` (standby/off badge, innerErrors caption),
`tests/composer-quota.spec.ts` (unobserved vs parked seat),
`tests/transport-queue-wait.spec.ts` and `tests/qoder/queue-notice.test.ts`
(wait progress), `tests/qoder/version.test.ts` and `tests/checkin.spec.ts`
(campaign fingerprint).
