# Session rotation invariant audit

Date: 2026-11-01  
Audited baseline: `v1.1.3` (`4a54250`)  
Scope: account stickiness / rotation in `src/qoder/transport/default-transport.ts`

This record answers one question: does an account rotation ever split or truncate a
conversation? It is a maintenance record, not a release announcement. The conclusion is
that the implementation is **correct as written** — rotation happens only at a turn
boundary, and after any byte has been forwarded to the host the transport never switches
accounts (so a switch can never truncate an in-flight answer).

## The two "account switch" paths are different

There are two distinct ways an account can change, and only one of them is the routine
rotation the user cares about.

1. **Stickiness rotation** — the routine round-robin. It is evaluated *only at the next
   turn's opening request*, never mid-turn. See invariants 1–3 below.
2. **Failover** — the fallback used when an account errors out. It exists to *prevent*
   truncation, not cause it: it may continue the same turn on the next account **only
   before any byte has been emitted**; once a byte has been forwarded it throws instead
   of retrying. See invariants 5–6.

## Invariants and where they live

| # | Invariant | Mechanism | Anchor |
| --- | --- | --- | --- |
| 1 | A new turn is defined solely by "the last message is not a tool result" | `opensNewTurn()`: `const last = messages[messages.length-1]; return last === undefined || last.role !== 'tool'` | `src/qoder/transport/default-transport.ts:121` |
| 2 | Rotation is examined only when a turn opens | `generateWithAccounts()` passes `newTurn` into `pinnedAccount(sessionId, newTurn)`; `pinnedAccount` only calls `rotatePin` when `examineBounds` is true | `default-transport.ts:963`, `:979`, `:1635` |
| 3 | A round is credited only on a *final* answer, never on a tool step | `noteTurnProgress()` credits `completeRound()` only on finish kind `stop`/`max-tokens`; `tool-calls` merely sets `pendingTurns` | `default-transport.ts:1786`, `:1766` |
| 4 | The automatic session-title request neither pins nor spends any bound | `isTitleRequest()` recognizes the host's fixed title framing and yields `sessionId = undefined` | `default-transport.ts:98`, `:959` |
| 5 | After any byte is forwarded, the transport never switches accounts | `state.emitted` is set in `onFirstByte`; the mid-stream guard throws on `state.emitted` instead of failing over | `default-transport.ts:1172`, `:1335` |
| 6 | Failover before the first byte continues the turn and moves the pin with it | catch path runs `nextWalkAccount` → `pinSession(next)` → `noteRequest(next)` only when `!emitted` | `default-transport.ts:1174-1207` |
| 7 | A slow request cannot overwrite a newer pin | dispatch-time pin object compared by identity; `rotatePin` returns `stale` on concurrent change | `default-transport.ts:988`, `:1635`, `:1721` |
| 8 | The host's conversation id actually reaches the transport | adapter opts into `compat.sendSessionAffinityHeaders`; shim reads `x-session-affinity`/`session_id`; `toGenerateOptions` keeps tool results as role `tool` | `src/adapter.ts:223`, `src/shim.ts:82`, `src/upstream.ts:456` |

## Production chain

`host` → `pi-ai` (sends `x-session-affinity`) → loopback `shim` (`sessionIdOf`,
`src/shim.ts:82`) → `upstream.chatStream(bodyJson, signal, sessionId)`
(`src/upstream.ts:918`) → `toGenerateOptions` (`src/upstream.ts:371`, keeps the raw
OpenAI role `tool` on tool-result messages) → `transport.stream()` (`default-transport.ts:681`),
where `opensNewTurn` sees the trailing role `tool` on continuations. Without
`sendSessionAffinityHeaders` (default in `pi-ai`) the id would be dropped and every step
would look like a new turn, so the adapter explicitly enables it.

## Verification

Targeted regression suites were run on this baseline:

- `tests/transport-stickiness.spec.ts`
- `tests/transport-failover.spec.ts`

Result: **51 passed / 0 failed**. The cases that pin the behavior in question:

| Test | What it proves |
| --- | --- |
| `transport-stickiness.spec.ts:480` "keeps a multi-step turn on one account even after the round bound is reached mid-turn" | Crossing the round bound mid-turn does not rotate |
| `transport-stickiness.spec.ts:528` "waits for the next turn to rotate on the request bound, even when steps cross it" | The request bound is only applied at the next turn's opening |
| `transport-stickiness.spec.ts:513` "does not let the automatic session-title request pin or spend any bound" | Title requests are bookkeeping |
| `transport-failover.spec.ts:474` "does not switch once a chunk has been forwarded" | After a forwarded chunk there is no account switch (code times out; only the first account is ever contacted) |

The full Vitest suite was also run on this baseline: **55 files, 908 tests passed**
(`vitest run`, exit 0). Separately, full `pnpm run check` status for 1.1.3 — TypeScript
host + client, Vitest and `node:test` green, build committed — is recorded in
`docs/review-qoder-transport-follow-up.md`.

## Boundaries worth knowing

1. Invariant 1 depends on the host sending the tool result as the trailing
   `role = 'tool'` message **and** on the affinity header being present. If an upstream
   framework change stopped sending either, the model would degrade to "every step is a
   new turn". The adapter currently opts in, so this holds.
2. Once a byte has been emitted, a mid-stream upstream break can only surface as an
   error (invariant 5 forbids retrying, because a retry would duplicate already-forwarded
   output). That is an inherent limit of streaming, not a rotation bug; the host decides
   whether to retry the request.
3. Setting `rounds`/`requests` above `0` rotates more often, but still only at turn
   boundaries. Defaults are `rounds=0`, `requests=0`, `minutes=240`, stickiness enabled,
   so only the 240-minute bound rotates by default — and still at a turn boundary.

## Summary

Rotation is turn-aligned and failover is emission-gated. Neither path can switch accounts
in the middle of a partially delivered answer, so a switch cannot truncate a conversation.
The regression tests above lock both properties.
