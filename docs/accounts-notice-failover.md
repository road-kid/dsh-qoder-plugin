# Accounts, upstream notices, and automatic failover — design and contract

What the account pool, the upstream not-serviceable notice and automatic
failover actually do in 1.0.0, and which interface each part owns. It is the
reference for anyone changing that behaviour: the signatures below are the
stable seam between the transport, the host wiring and the browser half, and
`src/status-paths.ts` carries the browser-safe types every side compiles
against (`QoderAuthAction`, `QoderAuthRequest.accountId`, `QoderAccountSummary`,
`QoderWebAccounts`, `QoderWebUpstreamNotice`, `QoderWebStatus.accounts`,
`QoderWebStatus.upstreamNotice`).

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
  subCode?: string
  /** The upstream's own message text, unescaped and bounded. */
  upstreamMessage?: string
}

export function parseQueueFacts(body: string): QoderQueueFacts | undefined
export function formatQueueNotice(facts: QoderQueueFacts, options: {
  waited: boolean
  occurrences: number
}): string
```

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

## Feature 3 — switch to the next account on connection failure

### `src/qoder/transport/`

```ts
export interface QoderFailoverHooks {
  enabled(): boolean
  activeAccount(): Promise<{ id: string; pat: string } | undefined>
  nextAccount(id: string): Promise<{ id: string; pat: string } | undefined>
  switched(info: { fromId: string; toId: string; reason: string }): void | Promise<void>
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
  is a short redacted string.
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
the one-hour rule is testable without a fake timer.

- `noteQueue(accountId, atMs)` — a queued answer. The second queue in a streak
  that is at least `limitedQueueGapMs` (1 h) after the first promotes the
  account to `limited`; a shorter gap keeps it `queued`.
- `noteFailure(accountId, atMs)` — a failure that advanced the walk.
  `limitedFailureStreak` (3) consecutive failures promote to `limited`.
- `noteConnected(accountId, atMs)` — an accepted chat. Clears `limited`, the
  failure streak and the queue counters. This is the only path back to `normal`.
- `healthOf(accountId)` — `limited` → `queued` → `normal` → `undefined`, where
  `undefined` means "nothing observed yet" and must render as no chip at all
  rather than an invented 正常.

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
| `stickinessRounds` | 0..100 | 1 | completed rounds before the conversation moves on |
| `stickinessRequests` | 0..1000 | 60 | requests before the conversation moves on |
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
