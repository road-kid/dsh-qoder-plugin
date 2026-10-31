# Qoder transport review follow-up

Date: 2026-11-01  
Reviewed release baseline: `v1.1.2` (`5ae4194`)  
Implementation branch: `fix/qoder-p1-transport`

This record closes the actionable transport findings from the 1.1.1/1.1.2 review and separates verified defects from findings disproved by runtime evidence. It is a maintenance record, not a release announcement.

## Verified outcomes

| Finding | Verdict | Evidence | Commit |
| --- | --- | --- | --- |
| A delayed initial reroute could overwrite a newer session pin and reset its counters | Fixed | `tests/transport-stickiness.spec.ts` reproduces two concurrent requests around a gated account walk; the delayed request may no longer replace the newer pin | `1cb7adb fix(qoder): reject stale rerouted pin writes` |
| A completed empty response was believed to lose its retryable code | Not a defect in the current host contract | The wire emits a finish failure with `EMPTY_RESPONSE_CODE`; the host retry policy retries structured finish failures by code. Text classification applies to thrown errors, not this finish path | `e9960c3 test(qoder): cover empty response retry contract` |

The pin fix captures the dispatch-time pin object and compares object identity after the asynchronous account walk. Comparing against the value returned by `pinnedAccount()` would be incorrect because that method returns a copy.

The empty-response regression test deliberately preserves the existing production message and code. It locks the actual structured retry contract rather than changing wording to satisfy the superseded review hypothesis.

## Verification

`pnpm run check` passed at `5e6767d`:

- TypeScript host and client checks passed.
- Vitest: 55 files, 897 tests passed.
- `node:test`: 228 tests passed.
- Build passed; generated output was committed in `5e6767d chore(build): regenerate lib for pin race fix`.

## P2 scope

The next maintenance slice is limited to findings that remain supported by code evidence:

1. Queue notices must use transport wait evidence rather than inferring a plugin wait from elapsed wall-clock time. Conversation text and the status card must describe the same measured wait.
2. The default queue budget (`5` retries, `30` seconds fallback) needs direct schema/runtime coverage and a deterministic end-to-end test. Existing UI-only assertions are not a host-runtime contract.

The empty-response wording change is explicitly excluded: it would not change retry behavior.

## Deferred items

The following remain outside P2 because they are low-severity hardening or design work, not demonstrated functional regressions in the reviewed release:

- turn-token cleanup and bounded lifecycle storage;
- stable title-request identification;
- host support for richer cross-layer error contracts;
- queue defaults documentation for worst-case waiting time;
- broader test deduplication and classifier drift monitoring.

Deferral does not assert that these items are impossible to reproduce; it records that this slice does not change them without new functional evidence and a dedicated design.
