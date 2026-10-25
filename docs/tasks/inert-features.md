# Inert features audit — account selection, routing, stickiness, health

> **状态：已被后续实现取代。** 本文记录的是 `937a8ca` 时刻的审计结论，其中的行号与接线描述（例如 finish chunk 之后才做的轮数记账、池不跨版本）反映的是**当时**的代码：「终块计轮」由 `cb3b4c4` 修复、「池跨两个凭证文件」由 `f52102f` 修复，粘性/排队的总开关由 1.0.3 补上。当前实现请以 `src/qoder/transport/default-transport.ts` 与 `src/index.ts` 为准；文中行号也不再对应现在的文件。

Read-only audit of `dsh-qoder-plugin` at **HEAD `937a8ca`**. All line numbers below are
HEAD's. Two working-tree changes exist and are *not* mine: a pre-existing formatting diff in
`src/qoder/transport/account-limiter.ts` (`266→267` lines, shifts that file by +1), and the
lead's in-progress fix in `src/qoder/transport/default-transport.ts` (adds `isServedFinish`
at `:132`, 15 insertions after `:121`, so everything from `:190` on is shifted by +15 in the
working tree — e.g. HEAD's dead block `:711-713` currently reads `:726-728`).

**Root cause class (single):** `src/upstream.ts:980-1023` `bodyStream` stops pulling the
transport generator once the SSE encoder has seen the finish chunk
(`encoderRef.terminal` set at `:624`, body closed at `:1014`); `iterator.return()` is only
called from `cancel` (`:1019-1021`). So anything a generator does *after* it yields the
finish chunk never runs. `attempt` already works around this for the traffic lease
(`default-transport.ts:805`), but the walk's bookkeeping at `:711-713` was left after the
`yield*` at `:698` and is dead in production.

**Consequence for this user:** live settings are
`stickinessRequests: 0` (request bound disabled), `stickinessRounds` absent → default `1`,
`stickinessMinutes` absent → default `180`. The only bound that can fire is the *dead*
round bound or the 3-hour minute bound — which is exactly "no rotation every round".

Legend: **LIVE** works in production · **PARTIAL** works but not as advertised ·
**INERT** wired but never executes · **NOT-WIRED** no producer/consumer at all.

## 1. Verdict table

| # | Feature | Verdict | Evidence | User-visible consequence |
|---|---|---|---|---|
| 1 | Failover walk on a pre-emit account error | LIVE | `default-transport.ts:715-745`; catch runs inside `iterator.next()`, before any byte | 5xx/401/418 on the first token really does move to the next account |
| 2 | Retry after a byte was emitted | LIVE (by design) | `:716` `if (options.signal?.aborted \|\| state.emitted) throw error` | A mid-stream failure is reported, not silently re-signed |
| 3 | `failover.switched` hook: adopt + log + in-chat notice | LIVE | `:734` → `src/index.ts:986-1012` (`emitUpstreamNotice` :1011) | User sees "已自动切换到下一个账号重试" and the active pointer moves |
| 4 | `failover.failed` → `health.noteFailure` | LIVE | `:729` → `src/index.ts:980-985` | Failing accounts can reach the `限流` badge |
| 5 | Account health badge (normal/queued/limited) | LIVE | producers `src/index.ts:984,1018,1076`; consumer `:1915`; render `QoderPluginCard.tsx:2205-2211` | Badges reflect real observations |
| 6 | Penalty ledger escalation (cooldown / breaker / downweight) | **INERT** | only writers are `:711` `noteSuccess` and `:712` `noteFailure`, both after the dead `yield*` (`:698`); `src/account-health.ts:257-301` | An account that keeps failing is never cooled down, and a recovered account is never cleared |
| 7 | Cooling-aware start ("skip the cooking account") | **INERT** | `:634`/`:637-663` gated on `isCooling`, which can never be true (see #6); `src/account-health.ts:233-236` | Requests keep starting on an account the ledger *would* have cooled |
| 8 | Silent adoption on a cooling skip (`failover.adopted`) | **INERT** | `:644`, only reachable from #7; `src/index.ts:967-979` | Dead hook: metadata reads are never re-pointed after a cooldown |
| 9 | Deprioritized ordering inside the walk | **INERT** | `:1004-1008` gated on `isDeprioritized` (`src/account-health.ts:245-248`), never set | No "try the healthy one first" ordering |
| 10 | Round-bound stickiness (`stickinessRounds`) | **INERT** | `completeRound` has exactly one caller: `:713`; `:1155-1160` | **The headline bug**: "一轮换一个账号" never triggers |
| 11 | Request-bound stickiness (`stickinessRequests`) | LIVE | `noteRequest` at `:671` and `:744`, both pre-yield | Works — but live settings set it to `0` (off) |
| 12 | Minute-bound stickiness (`stickinessMinutes`) | LIVE | `:1112` `this.now() - pin.pinnedAtMs >= minutes * 60_000`, evaluated at `:1079` | Works; with rounds dead this is the *only* default bound left (180 min) |
| 13 | Session pinning / pin table / eviction | LIVE | `pinSession` `:1172-1195` (`sessionPinCapacity = 512`, `:76`), called `:667`, `:739`, `:1130` | Same session keeps the same account *until* a live bound fires |
| 14 | Stickiness rotation target order | **PARTIAL** | `rotatePin` calls `this.failover?.nextAccount` (`:1128`), bypassing the unified `nextAccount` (`:1024-1047`) | Under `custom` strategy the session rotates in **save order**, not the user's order |
| 15 | Custom routing order for the failover walk | LIVE | `nextWalkAccount` `:992` → `nextAccount` `:1024-1047`; env `routingStrategy: 'custom'` + 4-entry `routingOrder` | Failover does follow the custom priority list |
| 16 | Custom routing order picks the request's **starting** account | NOT-WIRED (by design) | `:606` `let first = pinned ?? active`; comment `:1026-1030` | The 1st account of a turn is always the active/pinned one; custom order only shapes retries |
| 17 | `routingOrder` ids resolve to credentials | LIVE | ids are `pat:<sha256^16>` (`src/auth.ts:151-153`), resolved by `store.byId` (`:434-437`) via `accountById` (`src/index.ts:949-966`) | Reordering in the UI really does take effect on retries |
| 18 | Parked account (`enabled:false`) exclusion | LIVE | `nextAfter` `src/auth.ts:407-419`; `accountById` returns `undefined` for parked (`src/index.ts:964`); UI checkbox `QoderPluginCard.tsx:2181-2189` | Unticking an account removes it from both save-order and custom-order paths |
| 19 | `autoFailoverEnabled` master switch | LIVE | `src/index.ts:930`; early exit `default-transport.ts:586-591` | Turning it off pins every request to the active account |
| 20 | Empty-response treated as an account fault | **PARTIAL** | `isAccountFailure` includes `EMPTY_RESPONSE` (`:201`) but `wire/sse.ts:396-404` **yields** a finish instead of throwing | A blank answer ends the request as a success; the walk never advances and #6 never blames it |
| 21 | Traffic limiter (400 ms gap + 0-100 ms jitter, fail-open) | LIVE | `account-limiter.ts:171`, `:258`; wiring `default-transport.ts:331-343` | Account pacing and the fail-open warning both work |
| 22 | Queue-wait retry budget / 1-3 s jitter / 5 min ceiling | LIVE | `default-transport.ts:583`, `:1246-1258`, `:861-884`; UI `queueWaitAttempts/Seconds` | Queue notices are waited out and retried as configured |
| 23 | Penalty state observability (`snapshot()`) | NOT-WIRED | declared `src/account-health.ts:314`, **zero callers** in `src/` | No API, log or UI can ever show a cooldown |
| 24 | `accountsFailoverIdle` / `accountsLastFailover` copy | LIVE | `failoverAt` set `src/index.ts:1000`, projected `:1959-1960` | Last-switch line is real |
| 25 | Health `normal` for a freshly used account | LIVE | `onChatAccepted` → `src/index.ts:1076` fires from `streamChat:511-512`, i.e. before the freeze | "正常" appears after a successful first byte |

Counts out of 25 rows: **LIVE 16 · PARTIAL 2 · INERT 5 · NOT-WIRED 2** (#16 is a design
boundary rather than a defect, so the real defect count is INERT 5 + PARTIAL 1 (#14) +
NOT-WIRED 1 (#23) = **7 broken**, with #20 the classification-only gap).

## 2. What the in-flight fix repairs, and what it does not

The lead's fix targets the generator freeze: settle the post-finish bookkeeping where the
finish chunk is *produced* (the way `release()` already does at `:805`) instead of after the
`yield*` at `:698`. As of this audit the working tree contains only the first piece — an
`isServedFinish(chunk)` helper at `:132` distinguishing a served answer (`stop` /
`tool-calls` / `max-tokens`) from `error` / `aborted`.

**Repaired by that class of fix**
- #6 penalty escalation, #7 cooling skip, #8 `adopted`, #9 deprioritized ordering — the
  ledger finally has a live writer *and* a live reader.
- #10 round-bound stickiness — `completeRound` fires, so `stickinessRounds: 1` once again
  moves a session every finished round, independent of `stickinessRequests: 0`.
- #20 partly: an `EMPTY_RESPONSE` finish carries `reason.kind === 'error'`, so
  `isServedFinish` (`:132`) correctly returns false and the ledger *could* blame it — but
  only if the fix also blames non-served finishes. The walk still will not advance, because
  the chunk is yielded rather than thrown.

**Not repaired**
- #14 `rotatePin` still calls `failover.nextAccount` (`:1128`); a fix to the freeze leaves
  "sticky rotation ignores custom order" untouched. Needs `rotatePin` to go through the
  shared `nextAccount`.
- #20 fully needs `wire/sse.ts:396-404` to *throw* `EMPTY_RESPONSE` (or the walk to inspect
  the finish reason), not merely to be classified as an account fault.
- #23 `snapshot()` still has no consumer; penalty state stays invisible.
- #16 is a design boundary (`:1026-1030`), not a bug.
- UI copy: `locales.ts:291`/`:591` promise "达到下面任一条限制后自动换到下一个账号" — true only
  once #10 is fixed *and* the user leaves at least one bound enabled.

## 3. Measured evidence

- `tests/_scratch-round.spec.ts` (untracked, not mine) — **1 failed | 1 passed**.
  `bodyStream-style consumption still rotates on the round bound` fails with
  `expected [ 'pt-a', 'pt-a' ] to deeply equal [ 'pt-a', 'pt-b' ]` (`:110`); its
  `drainLikeBodyStream` (`:73-85`) reproduces `bodyStream`. The passing case
  (`full drain rotates on the round bound`) drains to `done`. **This is the production
  bug, reproduced.**
- `tests/transport-failover.spec.ts` + `transport-stickiness.spec.ts` +
  `transport-routing-order.spec.ts` + `account-health.spec.ts` → **4 files, 43/43 pass,
  6.97 s**. All of them drain the generator with `for await` (`transport-stickiness.spec.ts:163-167`),
  which is why **green tests coexist with a dead feature** — no spec consumes the stream
  the way `bodyStream` does.
- Baseline failures (unchanged by me): `adapter.spec.ts` 1, `catalog-lifecycle.spec.ts` 1,
  `reasoning-merge.spec.ts` 4 (lead's note said 5; measured 4, several `timed out in 5000ms`).
- Live settings `~/.dsh/profiles/desktop/.dsh-qoder-plugin/settings.json` (22 keys,
  `__writes: 124`): `autoFailoverEnabled: true`, `routingStrategy: "custom"`,
  `routingOrder: [4 × pat:…]`, `queueWaitAttempts: 2`, `queueWaitSeconds: 32`,
  `stickinessRequests: 0`; **`stickinessRounds` and `stickinessMinutes` are absent**
  (defaults 1 / 180 apply via `DEFAULT_FOR_FIELD`, `src/index.ts:1490-1492`).

## 状态更新（2026-10-23 收口轮，本文件为 HEAD `937a8ca` 快照）

- R1（plan/quota 缺 `Cosy-MachineToken`）：**已修**。`account-reader.ts` 的 usage/plan/status
  三条元数据请求统一带 host UMID（`request.ts` 的 `machineId` → `Cosy-MachineToken` + `machineType`），
  并由 `tests/qoder/usage.test.ts` 对三份请求头逐一套断言守护。
- R2（host UMID 与官方客户端不同源）：**已修**。`src/index.ts` 改走 `getMachineId()` 默认链，
  官方客户端 `~/.qoder/.auth/machine_id` 优先；`qoderMachineIdPath()`（profile 级种子）删除，
  回退种子移到主机级 `~/.dsh/qoder/machine_id`；`tests/qoder/machine-id.test.ts` 3 例守护。
- #3（起点优先级语义，本文件未单列）：**已改**。`custom` 策略下新会话从 `routing.order()` 首个
  可解析账号开始，`pinned ?? preferredStart(...) ?? active`；README 双语同步。
- #20（空响应是否算账号故障）：**已回退，仍是遗留**。抛错会让 `tests/qoder/transport.test.ts`
  19/20 例（把 `data: [DONE]` 当「正常空流」夹具）全红，属传输契约决策，需产品结论后再动。
- #23（冷却状态无出口）：**已修**。冷却/忙跳过时的 warn 日志附带 `penalties.snapshot(id)`。
- 其余仍为设计边界：#16（`machineID` 字段名与实际用途不一致，改名成本高于收益）、
  #20 之外的 `EMPTY_RESPONSE` 分类不变。
