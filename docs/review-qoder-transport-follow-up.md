# Qoder transport review follow-up

Date: 2026-11-01  
Reviewed release baseline: `v1.1.2` (`5ae4194`)  
Implementation branches: `fix/qoder-p1-transport`, `fix/qoder-p2-queue-contracts`

This record closes the actionable transport findings from the 1.1.1/1.1.2 review and separates verified defects from findings disproved by runtime evidence. It is a maintenance record, not a release announcement.

## Verified outcomes

| Finding | Verdict | Evidence | Commit |
| --- | --- | --- | --- |
| A delayed initial reroute could overwrite a newer session pin and reset its counters | Fixed | `tests/transport-stickiness.spec.ts` reproduces two concurrent requests around a gated account walk; the delayed request may no longer replace the newer pin | `1cb7adb fix(qoder): reject stale rerouted pin writes` |
| A completed empty response was believed to lose its retryable code | Not a defect in the current host contract — though not for the reason first recorded | The wire does emit a finish failure with `EMPTY_RESPONSE_CODE`, but that code never crosses the process boundary: `chatStream` sees a terminal first chunk, classifies it `server` and answers HTTP 502, so the host only has a 5xx thrown-error text and `classifyPiAiError` maps it to `SERVER`, which the default retry table retries. Retry is bought by the status, not by the structured code | `e9960c3 test(qoder): cover empty response retry contract` |
| Queue notices inferred a wait from elapsed host time and quoted the last upstream advice as the total wait | Fixed | `waited` now requires completed transport waits; upstream and configured wording both use measured `totalWaitMs`, while outage recurrence remains clock-based | `b5dc363 fix(qoder): report measured queue waits` |
| Default queue retry budget lacked direct host/runtime coverage | Covered without changing defaults | Schema and settings-face tests pin enabled/5/30; a real-plugin fake-timer end-to-end test proves six upstream chats and five measured configured waits | `ee9a4ee test(qoder): cover queue notice contracts` |
| A new conversation's first queue showed two progress lines | Fixed at the host layer | The session-title request shares the upstream queue but is bookkeeping, not a turn. The transport now reports its real conversation id PLUS a `bookkeeping` flag, and the host drops the conversation row for flagged requests while still recording the wait on the card. Dropping the session id — the first attempt — did not suppress anything: the printer treats a missing id as "print into whichever agent was last running" | `ed0122a` + host-layer fix in `src/index.ts` |

The pin fix captures the dispatch-time pin object and compares object identity after the asynchronous account walk. Comparing against the value returned by `pinnedAccount()` would be incorrect because that method returns a copy.

The empty-response regression test deliberately preserves the existing production message and code, and pins the wire contract rather than the host's reading of it: the code does not survive the HTTP boundary, so the retry that actually happens comes from the 502 status the shim answers with.

## Verification

### P1

`pnpm run check` passed at `5e6767d`:

- TypeScript host and client checks passed.
- Vitest: 55 files, 897 tests passed.
- `node:test`: 228 tests passed.
- Build passed; generated output was committed in `5e6767d chore(build): regenerate lib for pin race fix`.

### P2

`pnpm run check` passed after the P2 source, integration and regression changes:

- TypeScript host and client checks passed.
- Vitest: 55 files, 899 tests passed.
- `node:test`: 231 tests passed.
- Build passed; generated output was committed in `97bebcb chore(build): regenerate lib for queue notices`.

The default-budget end-to-end test advances virtual time in bounded steps so the stream's 300-second idle timeout cannot win before mocked upstream continuations deliver their responses. It verifies the production defaults without a real multi-minute sleep.

## P2 outcome

Both supported P2 findings are closed:

1. Queue notices use transport wait evidence rather than inferring a plugin wait from elapsed wall-clock time. Conversation text and the status card describe the same measured wait.
2. The default queue budget remains enabled with `5` retries and a `30`-second fallback, now covered from schema through runtime.

The empty-response wording change is explicitly excluded: it would not change retry behavior.

## Title queue notice fix

The first attempt at this fix (`ed0122a`) changed one line: the pending id for queue progress became `undefined` for title requests. That did not work, and a review caught it. `emitUpstreamNotice` treats a missing session id as "print into whichever agent was last running" (`src/job-token-hint.ts`), a fallback the module itself documents as the source of cross-conversation leakage — so the row still printed, and when the last-running agent belonged to another conversation it printed there. The final notice was not touched at all: `onUpstreamQueue` passes `sessionIdOf(options)` and never looked at the pending id, so a title request whose budget ran out still wrote its row. The regression test added with the fix asserted the transport's callback arguments and never reached the printer, which is why it stayed green while users still saw the row.

The fix now separates the two facts the transport was conflating:

- **Attribution stays truthful.** The title request belongs to the conversation that triggered it, and the transport reports that real id, so the printer's strict rule ("a row for session X goes to session X, or nowhere") applies as it does for every other request. Restoring the id also restores the deferred rotation row, which had been filed under the session-less bucket while its own acceptance flushed the real session.
- **Visibility is the host's decision.** Both queue hooks gained a trailing `bookkeeping` flag (`src/qoder/transport/index.ts`), set from the same `isTitleRequest(options)` predicate. The host (`src/index.ts`) still records the wait on the status card, still counts the outage and still logs, but returns before `emitUpstreamNotice` when the flag is set — for the progress row and for the terminal notice alike.

Internal queue budget, waiting and retry behavior are unchanged: the title request still waits and retries exactly as before.

Identification is still by request SHAPE (`isTitleRequest`: one user message, one text block, one of the two title prefixes), the same predicate the stickiness code already uses at `src/qoder/transport/default-transport.ts`'s turn-tracking sites. So a genuine user turn whose text happens to begin with a title prefix is treated as bookkeeping — as it already was for stickiness, and it now also loses its queue row. The flag is applied in the host, so this stays a display-level consequence rather than a routing one. "Stable title-request identification" remains the deferred item that would remove the heuristic.

Coverage is now at the layer that decides what the user sees. `tests/queue-notice-recovery.spec.ts` boots the real plugin, keeps a conversation running so the last-running-agent fallback would actually deliver a stray row, and asserts that a queued title request appends nothing — both when it recovers after a wait and when its budget runs out — while the same conversation's user-facing chat still prints its row. Reverting the host-layer change makes four of those five cases fail. `tests/transport-queue-wait.spec.ts` keeps the transport-level contract: the real session id plus the flag, for both hooks.

`pnpm run check` passed after this fix: typecheck, Vitest 55 files / 908 tests, `node:test` 231 tests, and the build. Generated output was committed in `76aaf21 chore(build): regenerate lib for bookkeeping queue notice fix`, and a second build reproduces the same file hashes.

## Deferred items

The following remain outside P2 because they are low-severity hardening or design work, not demonstrated functional regressions in the reviewed release:

- turn-token cleanup and bounded lifecycle storage;
- stable title-request identification;
- host support for richer cross-layer error contracts;
- queue defaults documentation for worst-case waiting time;
- broader test deduplication and classifier drift monitoring.

Deferral does not assert that these items are impossible to reproduce; it records that this slice does not change them without new functional evidence and a dedicated design.
