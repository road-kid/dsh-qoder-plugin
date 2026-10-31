# Qoder transport review follow-up

Date: 2026-11-01  
Reviewed release baseline: `v1.1.2` (`5ae4194`)  
Implementation branches: `fix/qoder-p1-transport`, `fix/qoder-p2-queue-contracts`

This record closes the actionable transport findings from the 1.1.1/1.1.2 review and separates verified defects from findings disproved by runtime evidence. It is a maintenance record, not a release announcement.

## Verified outcomes

| Finding | Verdict | Evidence | Commit |
| --- | --- | --- | --- |
| A delayed initial reroute could overwrite a newer session pin and reset its counters | Fixed | `tests/transport-stickiness.spec.ts` reproduces two concurrent requests around a gated account walk; the delayed request may no longer replace the newer pin | `1cb7adb fix(qoder): reject stale rerouted pin writes` |
| A completed empty response was believed to lose its retryable code | Not a defect in the current host contract | The wire emits a finish failure with `EMPTY_RESPONSE_CODE`; the host retry policy retries structured finish failures by code. Text classification applies to thrown errors, not this finish path | `e9960c3 test(qoder): cover empty response retry contract` |
| Queue notices inferred a wait from elapsed host time and quoted the last upstream advice as the total wait | Fixed | `waited` now requires completed transport waits; upstream and configured wording both use measured `totalWaitMs`, while outage recurrence remains clock-based | `b5dc363 fix(qoder): report measured queue waits` |
| Default queue retry budget lacked direct host/runtime coverage | Covered without changing defaults | Schema and settings-face tests pin enabled/5/30; a real-plugin fake-timer end-to-end test proves six upstream chats and five measured configured waits | `ee9a4ee test(qoder): cover queue notice contracts` |

The pin fix captures the dispatch-time pin object and compares object identity after the asynchronous account walk. Comparing against the value returned by `pinnedAccount()` would be incorrect because that method returns a copy.

The empty-response regression test deliberately preserves the existing production message and code. It locks the actual structured retry contract rather than changing wording to satisfy the superseded review hypothesis.

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

## Deferred items

The following remain outside P2 because they are low-severity hardening or design work, not demonstrated functional regressions in the reviewed release:

- turn-token cleanup and bounded lifecycle storage;
- stable title-request identification;
- host support for richer cross-layer error contracts;
- queue defaults documentation for worst-case waiting time;
- broader test deduplication and classifier drift monitoring.

Deferral does not assert that these items are impossible to reproduce; it records that this slice does not change them without new functional evidence and a dedicated design.
