# Qoder 插件审核问题与修复实施计划

> **For agentic workers:** 按本文任务顺序执行，使用 TDD；每个任务先写失败测试，再做最小实现，最后运行指定测试并提交。不要通过降低默认值或删除断言来掩盖失败。

**Goal:** 修复本轮审核发现的粘性账号状态、完整轮次计数、队列通知、跨 Context 缓存和 Windows 子进程清理问题，使完整检查稳定通过。

**Architecture:** 保留现有单传输层账号池和按 session 粘性的架构，不重写账号池。粘性修复以“实际服务账号获得计数、同一 turn 不拆号、异步旧状态不得覆盖新状态”为不变量；目录缓存以数据根为隔离边界；排队通知显式传递真实等待记录；UMID 自检在清理前完成子进程收尾。

**Tech Stack:** TypeScript、Node.js 22.19+ 或 24+、Vitest、node:test、Cordis Context、Windows/Unix 文件系统。

---

## 1. 交接信息

- 工作区：`D:\Workspace\workspace-dsh\projects\dsh-qoder-plugin`
- 审核基线：`HEAD=3de92fd`
- 最新修改范围：`2e9d7a0..3de92fd`
  - `32c7e73`：默认值调整为 `queueWaitAttempts=5`、`stickinessRounds=0`、`stickinessRequests=0`、`stickinessMinutes=240`。
  - `ecef54e`：粘性改为只在 turn 之间轮换，并排除自动标题请求。
  - `3de92fd`：重建 `lib`。
- 审核期间未修改源码。本计划文档是交接时唯一新增文件。
- 默认值在 schema、runtime fallback、UI、初始配置和生成 `lib` 中已同步。**不要把 `queueWaitAttempts` 改回 0 来修复测试。**

### 1.1 已验证结果

- `npm run typecheck`：通过。
- `npm run test:qoder`：221/221 通过。
- 配置、UI、队列、粘性等 7 个靶向 Vitest 文件：142/142 通过。
- 临时目录构建成功，构建产物与审核时的 `lib` 一致。
- 完整 `npm run check` 的一次结果为 853/869 通过、16 失败；另一轮因 UMID 瞬时清理问题减少而得到 856/869。失败分类如下：

| 数量 | 文件/领域 | 归因 |
|---:|---|---|
| 6 | queue-notice-recovery | 新默认 5 次等待与旧 fail-fast 测试夹具冲突 |
| 5 | reasoning-merge | 模块级身份/抓取缓存跨独立测试根污染，dispose 未完整等待 |
| 1 | catalog-lifecycle | 同一全局身份缓存误清新 root 的 probe |
| 1 | adapter | 陈旧且自相矛盾的文案断言 |
| 3 | UMID | Windows EBUSY 不稳定复现；代码另有 kill/close 清理竞态风险 |

## 2. 问题总表与优先级

| ID | 严重度 | 问题 | 主要位置 | 修复任务 |
|---|---|---|---|---|
| Q-01 | 中 | busy/cooling 重路由后，B 实际服务但不计数，A 未服务却增加 round | `src/qoder/transport/default-transport.ts:901-943,982-990,1537-1558` | Task 4 |
| Q-02 | 中 | await 后写回旧 pin，可撤销另一请求完成的 A→B 轮转 | `src/qoder/transport/default-transport.ts:1447-1474,1516-1527` | Task 5 |
| Q-03 | 低-中 | opening 收到 tool-calls 即消耗 round，工具链失败/中止仍计完成轮 | `src/qoder/transport/default-transport.ts:196-209,978-990,1544-1558` | Task 6 |
| Q-04 | 高（检查阻断） | 6 个 queue 测试因默认 5×约 31–33 秒等待而超时 | `tests/queue-notice-recovery.spec.ts:70-78,172-192,300-395` | Task 1 |
| Q-05 | 低 | configured fallback 实际等待后，最终通知仍称未等待 | `src/index.ts:1357-1369`、`src/qoder/queue-notice.ts:115-144` | Task 7 |
| Q-06 | 中（多实例/测试隔离） | `lastIdentities`/`lastLiveFetchAt` 跨数据根共享 | `src/index.ts:1972-1982,2133-2155,2975-2993` | Task 2 |
| Q-07 | 中低（Windows） | 自检 kill 后立即 resolve 和删 staging，未等待 close | `src/qoder/transport/umid-extract.ts:1132-1169,1420-1429,1467-1473` | Task 8 |
| Q-08 | 低 | adapter 测试同时设置 rateUnknown=true 和期望纯 Unknown | `tests/adapter.spec.ts:120-131` | Task 3 |
| Q-09 | 低 | 注释仍称大 turn 不会越过 round/request 边界 | `src/index.ts:1443-1446` | Task 9 |

### 归因边界

- Q-04 是 `32c7e73` 直接暴露的测试集成回归，不是队列传输等待算法本身回归。
- Q-06、Q-08 不是最新提交引入，但会破坏完整检查和多 Context 隔离，应一并修复。
- Q-07 的代码竞态可以静态确认；本次 3 个 EBUSY 未稳定复现，**不能断言每个 EBUSY 都由它造成**。
- 普通顺序 failover、标题请求识别、默认值传播未发现新的顺序路径错误。

## 3. 必须保持的行为不变量

1. 同一用户 turn 的 opening 和后续 tool continuation 使用同一账号；只有新 turn 检查粘性边界。
2. 自动标题请求不创建、不刷新、不消耗 session 粘性计数。
3. request 和 round 只能记到实际开始/完成服务的账号，不能记到被 busy/cooling 跳过的账号。
4. 任何 await 之后，旧请求不得覆盖另一请求已经写入的新 pin。
5. 一个完整 turn 最多增加一次 round；tool-calls 本身不是最终回答。
6. `stop`、最终回答形式的 `max-tokens` 可以完成 round；`tool-calls`、`error`、`aborted` 不可以。
7. 同一数据根的热重载继续复用目录 freshness；不同数据根即使使用同一 PAT 也不得互相命中缓存。
8. 队列通知必须区分“未等待”“按上游建议等待”“按配置等待”。
9. UMID staging 清理前，自检子进程必须完成退出/关闭收尾。

## 4. 文件变更地图

| 文件 | 责任 | 任务 |
|---|---|---|
| `tests/queue-notice-recovery.spec.ts` | 恢复通知测试的 fail-fast 前提；增加 configured-wait 通知覆盖 | 1、7 |
| `src/index.ts` | 目录缓存按数据根隔离；最终 queue 通知消费真实等待记录；更新陈旧注释 | 2、7、9 |
| `tests/reasoning-merge.spec.ts` | 验证不同 root 不共享 freshness，并 await Context 清理 | 2 |
| `tests/catalog-lifecycle.spec.ts` | 验证不同 root 不错误清 probe，同 root 重载仍复用状态 | 2 |
| `tests/adapter.spec.ts` | 使价格未知文案断言与实现契约一致 | 3 |
| `src/qoder/transport/default-transport.ts` | 修正实际账号计数、pin 并发写回和完整 turn 计数 | 4、5、6、7 |
| `tests/transport-stickiness.spec.ts` | 增加重路由、并发和工具链完成/中止测试 | 4、5、6 |
| `src/qoder/transport/index.ts` | 扩展最终 queue 回调的真实等待摘要类型 | 7 |
| `src/qoder/queue-notice.ts` | 渲染上游等待与配置等待的不同文案 | 7 |
| `src/qoder/transport/umid-extract.ts` | 自检子进程 kill 后等待 close，再允许 staging 清理 | 8 |
| `tests/umid-install-route.spec.ts` | 增加真实或可控子进程超时/输出过量收尾覆盖 | 8 |
| `lib/index.js`、`lib/client.js` 及构建输出 | 仅由最终构建同步，不手改 | 10 |

---

### Task 1: 修复 queue 通知测试的默认等待回归（Q-04）

**Files:**
- Modify: `tests/queue-notice-recovery.spec.ts:172-192`
- Modify: `tests/plugin-card.spec.ts:1211-1220`
- Test: `tests/queue-notice-recovery.spec.ts`, `tests/plugin-card.spec.ts`

- [ ] **Step 1: 先复现一个失败用例**

Run:

```bash
npx vitest run tests/queue-notice-recovery.spec.ts
```

Expected: 6 个通知用例出现 `Test timed out in 30000ms`，因为空配置采用 5 次等待。

- [ ] **Step 2: 将通知生命周期夹具显式设为 fail-fast**

这些用例测试通知生命周期，不测试默认重试。把 `bootSignedIn` 的插件启动从：

```ts
await ctx.plugin(Qoder, {})
```

改为：

```ts
await ctx.plugin(Qoder, { queueWaitAttempts: 0 })
```

保留现有 `waited:false` 断言：在显式不等待的夹具中，它重新成为正确前提。

- [ ] **Step 3: 增加独立的默认值契约测试**

不要用真实 30 秒等待。在现有 UI 默认值测试旁增加以下用例，防止默认值再次无意漂移；运行时 fallback 仍由完整集成检查覆盖：

```ts
it('shows the queue retry bounds with the host defaults', async () => {
  const scope = fakeSettingsScope({ queueWaitEnabled: true })
  await mountWithSettings(scope)
  expect(inputFor(en.queueWaitAttemptsLabel).props.value).toBe('5')
  expect(inputFor(en.queueWaitSecondsLabel).props.value).toBe('30')
})
```

- [ ] **Step 4: 运行文件并确认快速通过**

Run:

```bash
npx vitest run tests/queue-notice-recovery.spec.ts tests/plugin-card.spec.ts
```

Expected: 两文件全部通过，不再发生 30 秒超时。

- [ ] **Step 5: 提交**

```bash
git add tests/queue-notice-recovery.spec.ts tests/plugin-card.spec.ts
git commit -m "test: keep queue notice fixtures fail-fast"
```

### Task 2: 按数据根隔离目录身份和 freshness（Q-06）

**Files:**
- Modify: `src/index.ts:1972-1982,2133-2155,2975-2993`
- Modify: `tests/reasoning-merge.spec.ts:26-32,98-162`
- Modify: `tests/catalog-lifecycle.spec.ts`

**设计决定：**继续使用模块级 Map 以支持同数据根热重载，但 key 必须包含规范化后的凭据文件目录。推荐通过 `dirname(runtime.store.ownAuthPath())` 获得数据根，而不是直接读环境变量；这样自定义 store 路径也遵循同一隔离边界。

- [ ] **Step 1: 写不同 root、相同 PAT 的失败测试**

在 reasoning 测试中连续启动两个独立临时 root，二者使用相同 PAT 和各自 fetch spy。第二个 root 必须再次请求 live catalog：

```ts
const first = await boot({})
await first.fiber.dispose()
const second = await boot({})
expect(await second.llm.listModels('qoder')).toContainEqual(
  expect.objectContaining({ id: UNDECLARED_ID }),
)
await second.fiber.dispose()
```

修复前第二个 root 会因旧 `lastLiveFetchAt` 跳过 fetch，只得到 fallback。

- [ ] **Step 2: 写不同 root、不同 PAT 不清新 root probe 的失败测试**

复用现有 catalog 场景：第一个 root 使用 PAT_B 并销毁；第二个新 root 预置 PAT_A 的 probe。启动第二个 root 后：

```ts
expect(probe.results.map(result => result.model)).toContain('acct-a-model')
```

修复前旧 PAT_B 使新 root 被误判为账号切换，触发 `probeStore.clear()`。

- [ ] **Step 3: 实现作用域 key**

在 `VariantRuntime` 增加派生字段，避免多次计算和键规则漂移：

```ts
interface VariantRuntime {
  // 现有字段保持不动
  cacheScope: string
}
```

创建 runtime 时使用：

```ts
import { dirname, resolve } from 'node:path'

const cacheScope = resolve(dirname(store.ownAuthPath()))
```

增加两个 helper，并替换所有直接以 variant id 或 identity 为 key 的读写：

```ts
function identityCacheKey(runtime: VariantRuntime): string {
  return `${runtime.cacheScope}\0${runtime.variant.id}`
}

function liveFetchCacheKey(runtime: VariantRuntime, identity: string): string {
  return `${runtime.cacheScope}\0${identity}`
}
```

`adoptIdentity` 使用 `identityCacheKey(runtime)`；`syncVariant` 的 `lastLiveFetchAt` 使用 `liveFetchCacheKey(runtime, identity)`。delete/set/get 必须全部使用相同 helper。

- [ ] **Step 4: 修复 reasoning 测试清理**

将 `CLEANUP` 从仅保存路径改为保存异步 disposer；`boot` 注册 `await ctx.fiber.dispose()`，afterEach 先 await 所有 Context，再删除目录、恢复环境。移除测试尾部的 `void ctx.fiber.dispose()`，避免重复清理。

同时把 `tests/reasoning-merge.spec.ts:144-146` 的 `vi.waitFor` 超时调整为小于外层测试超时，或给该测试显式更长的外层 timeout，保证真实断言错误不会被外层超时掩盖。

- [ ] **Step 5: 验证隔离与热重载兼容性**

Run:

```bash
npx vitest run tests/reasoning-merge.spec.ts tests/catalog-lifecycle.spec.ts
```

Expected: 两文件全部通过；现有同 root 热重载测试仍通过，不能出现每次 settings 写入都重新 fetch 的回归。

- [ ] **Step 6: 提交**

```bash
git add src/index.ts tests/reasoning-merge.spec.ts tests/catalog-lifecycle.spec.ts
git commit -m "fix: scope catalog lifecycle caches by data root"
```

### Task 3: 修正 adapter 陈旧断言（Q-08）

**Files:**
- Modify: `tests/adapter.spec.ts:120-131`

- [ ] **Step 1: 将期望改为当前公开契约**

该用例已经构造 `rateUnknown:true`，实现正确输出价格未知说明。把期望从 `Unknown` 改为：

```ts
expect(result).toBe('Unknown · 价格暂不可用')
```

如果断言对象不是字符串，则只修改对应 display/name 字段，保留其他字段断言。

- [ ] **Step 2: 验证并提交**

```bash
npx vitest run tests/adapter.spec.ts
git add tests/adapter.spec.ts
git commit -m "test: align unknown rate label assertion"
```

Expected: adapter 文件全部通过，不修改 `src/adapter.ts`。

### Task 4: 让 busy/cooling 重路由计数归属实际服务账号（Q-01）

**Files:**
- Modify: `src/qoder/transport/default-transport.ts:901-943,978-990`
- Test: `tests/transport-stickiness.spec.ts`

**设计决定：**采用最小且一致的方案：当请求实际从 alternative 账号开始时，将 session pin 移到该账号。这样同一 turn 后续步骤不会回到被跳过的 A，B 的 request/round 也自然进入现有计数路径。busy 重路由仍不得调用 `adopted` 或修改全局 active 指针；这里只修改该 session 的 pin。

- [ ] **Step 1: 写 busy/cooling + stickiness 失败测试**

构造 pin=A、A busy 或 cooling、B 可服务，opening 正常 finish。断言：

```ts
expect(pinSnapshot(transport)).toEqual([
  expect.objectContaining({ id: 'b', requests: 1, rounds: 1 }),
])
expect(nextContinuationAccount).toBe('b')
```

测试应分别覆盖 busy 和 cooling；cooling 仍允许 `adopted(A→B)`，busy 不允许。

- [ ] **Step 2: 运行并确认修复前失败**

```bash
npx vitest run tests/transport-stickiness.spec.ts
```

Expected: 修复前 pin 仍为 A，B 无计数，A 错误增加 round。

- [ ] **Step 3: 对实际 start 账号统一建立 pin**

把当前只在 `!rerouted` 时 pin 的逻辑改为：只要 `sessionId` 有效、stickiness 启用且 `first` 与当前 pin 不同，就对实际 `first` 调用 `pinSession`。保留现有无 pin 时的首次选择逻辑。

核心方向：

```ts
if (pinned === undefined || first.id !== pinned.id) {
  this.pinSession(sessionId, first)
}
this.noteRequest(sessionId, first.id)
```

删除“rerouted 永不写 pin”的旧注释，明确区分 **session pin** 与 **全局 active adoption**。

- [ ] **Step 4: 验证并提交**

```bash
npx vitest run tests/transport-stickiness.spec.ts
git add src/qoder/transport/default-transport.ts tests/transport-stickiness.spec.ts
git commit -m "fix: attribute rerouted stickiness usage to serving account"
```

### Task 5: 防止异步旧 pin 覆盖新轮转（Q-02）

**Files:**
- Modify: `src/qoder/transport/default-transport.ts:1447-1474,1516-1527`
- Test: `tests/transport-stickiness.spec.ts`

**设计决定：**使用 SessionPin 对象身份作为乐观并发令牌。任何 `accountById`、`nextWalkAccount` 或 `nextAccount` await 之后，在 mutate/delete/set/pinSession 之前检查 `this.sessionPins.get(sessionId) === pin`。若不相等，丢弃旧结果并重新读取最新 pin；不能把 `undefined` 同时解释为“无下一账号”和“状态已过期”。

- [ ] **Step 1: 写可控 accountById 竞态测试**

用 deferred Promise 阻塞 continuation 的 `accountById(A)`。随后让 opening 完成 A→B 轮转，再释放 deferred。最终必须保持：

```ts
expect(pinSnapshot(transport)).toEqual([
  expect.objectContaining({ id: 'b' }),
])
```

并断言 continuation 不使用被旧 A 写回的凭据。

- [ ] **Step 2: 运行并确认修复前回到 A**

Expected: 修复前最终 pin=A，旧 requests 被恢复。

- [ ] **Step 3: 在 pinnedAccount 中加入重读循环**

把单路径函数改为 `for (;;)`：每次取得当前 pin；await 后若对象身份变化则 `continue`。账号被删除时也必须先确认旧 pin 仍是当前对象，才能 delete。

身份 guard：

```ts
const current = this.sessionPins.get(sessionId)
if (current !== pin) continue
```

- [ ] **Step 4: 将 rotatePin 的“选择”和“提交”分开**

让选择函数返回 discriminated result，避免 stale 被当作单账号：

```ts
type PinRotation =
  | { kind: 'moved'; account: QoderPooledAccount }
  | { kind: 'none' }
  | { kind: 'stale' }
```

`rotatePin` 在两个异步选择结束后、`pinSession` 前检查对象身份；过期返回 `{kind:'stale'}`，调用方 `continue`；`none` 才允许重置当前 pin 的计数；`moved` 才返回新账号。最终 LRU delete/set 之前再做一次身份检查。

- [ ] **Step 5: 运行完整粘性测试并提交**

```bash
npx vitest run tests/transport-stickiness.spec.ts
git add src/qoder/transport/default-transport.ts tests/transport-stickiness.spec.ts
git commit -m "fix: prevent stale async session pin writes"
```

### Task 6: 只在最终回答完成时提交 round（Q-03）

**Files:**
- Modify: `src/qoder/transport/default-transport.ts:196-209,978-990,1544-1558`
- Test: `tests/transport-stickiness.spec.ts`

**设计决定：**保留 `isServedFinish` 用于账号 exoneration，但新增专门用于轮次的终止判断。另加按 session 的 pending-turn 状态，记录 opening 的 tool-calls 已出现、正在等待最终回答。新 opening 覆盖旧 pending；失败或 abort 不计 round，但保留 pending 以允许同 turn 重试最终完成。

建议类型：

```ts
interface PendingTurn {
  accountId: string
}

function completesAnswer(chunk: StreamChunk): boolean {
  return chunk.type === 'finish'
    && (chunk.reason.kind === 'stop' || chunk.reason.kind === 'max-tokens')
}

function requestsMoreTools(chunk: StreamChunk): boolean {
  return chunk.type === 'finish' && chunk.reason.kind === 'tool-calls'
}
```

- [ ] **Step 1: 写 opening tool-calls 后中止的失败测试**

opening 返回 `finish:tool-calls`；随后 continuation abort/error；开启下一 turn。断言旧 turn 的 `rounds` 为 0，不能因旧 opening 已加一而提前轮换。

- [ ] **Step 2: 写正常工具链只计一次的测试**

opening tool-calls → 一个或多个 continuation tool-calls → 最终 continuation stop。断言：

```ts
expect(pin.rounds).toBe(1)
```

再覆盖无工具 opening stop 直接计 1、title 不计、opening max-tokens 计 1、error/aborted 不计。

- [ ] **Step 3: 将 round 完成从 onServed 中拆出**

`state.onServed` 继续清理 penalty；轮次逻辑按 finish 类型处理：

- opening + stop/max-tokens：立即 `completeRound(sessionId, servedId)`，清 pending。
- opening + tool-calls：写 `pendingTurns.set(sessionId,{accountId:servedId})`，不加 round。
- continuation + tool-calls：保留 pending，不加 round。
- continuation + stop/max-tokens：仅当 pending 存在且属于同 session 时，对实际 `servedId` 完成 round，并清 pending。
- 新 opening：先清除该 session 的旧 pending，避免已放弃工具链后来又被计完成。

不要把 round 逻辑放到 `yield*` 之后；HTTP 层在 terminal chunk 关闭流，必须在 finish 回调内处理。

- [ ] **Step 4: 验证并提交**

```bash
npx vitest run tests/transport-stickiness.spec.ts
git add src/qoder/transport/default-transport.ts tests/transport-stickiness.spec.ts
git commit -m "fix: count stickiness rounds at final answers"
```

### Task 7: 用真实等待记录生成最终 queue 通知（Q-05）

**Files:**
- Modify: `src/qoder/transport/index.ts:143-220`
- Modify: `src/qoder/transport/default-transport.ts:765-799,1184-1228,1659-1681`
- Modify: `src/index.ts:1341-1381`
- Modify: `src/qoder/queue-notice.ts:105-144`
- Test: `tests/queue-notice-recovery.spec.ts`

**设计决定：**不再通过两次通知的时间差猜测是否等待。每次 `waitOutQueue` 成功返回后，把实际 `waitMs` 和 `basis` 写入该请求自己的等待摘要；最终 `onUpstreamQueue` 回调携带摘要。请求级数据必须放在 attribution/queueBudget 等 per-request 对象中，不能放 transport 全局“last wait”。

建议公开类型：

```ts
export interface QoderQueueWaitSummary {
  attempts: number
  totalWaitMs: number
  lastBasis?: QoderQueueWaitBasis
}
```

将回调扩展为第四参数，保持旧调用兼容：

```ts
onUpstreamQueue?: (
  facts: QoderQueueFacts,
  accountId?: string,
  sessionId?: string,
  waits?: QoderQueueWaitSummary,
) => void
```

- [ ] **Step 1: 写 configured fallback 最终通知失败测试**

上游不提供正数 `retryAfterSeconds/waitTime`，设置一次 configured wait，使用 fake timers 完成等待后再次失败。断言最终通知包含：

```text
已按配置等待
```

且不包含：

```text
本次未按上游建议等待即返回此结果
```

- [ ] **Step 2: 保留另外两条通知契约测试**

- `queueWaitAttempts=0`：仍显示未等待。
- 有正数上游建议且实际等待完成：仍显示按上游建议等待，并保留正确秒数。

- [ ] **Step 3: 记录已完成的等待，而非计划等待**

在 `await this.waitOutQueue(...)` 成功之后才累加 `attempts/totalWaitMs` 并记录 `lastBasis`。如果 wait 被 abort，不得声称完成等待。`onQueueWait` 进度通知仍在等待开始前发出，不改变其语义。

- [ ] **Step 4: 渲染三种状态**

扩展 `formatQueueNotice` 的 options：

```ts
options: {
  occurrences: number
  waits?: QoderQueueWaitSummary
}
```

规则：
- `attempts=0/undefined`：现有“未等待”文案。
- `lastBasis.source='upstream'`：现有“按上游建议等待”文案。
- `lastBasis.source='configured'`：使用“已按配置等待 X 秒，重试后仍不可服务”，X 由 `totalWaitMs` 四舍五入为秒；不要使用不存在的上游建议秒数。

`occurrences` 仍由 host 的同一次 outage 生命周期维护，不能移到 per-request summary。

- [ ] **Step 5: 验证并提交**

```bash
npx vitest run tests/queue-notice-recovery.spec.ts tests/transport-stickiness.spec.ts
git add src/qoder/transport/index.ts src/qoder/transport/default-transport.ts src/qoder/queue-notice.ts src/index.ts tests/queue-notice-recovery.spec.ts
git commit -m "fix: report configured queue waits accurately"
```

### Task 8: 等待 UMID 自检子进程关闭后再清理（Q-07）

**Files:**
- Modify: `src/qoder/transport/umid-extract.ts:1132-1169`
- Test: `tests/umid-install-route.spec.ts`

- [ ] **Step 1: 写超时/输出过量收尾测试**

不要继续只 mock 整个 `selfCheck` 返回值。使用可控 child helper 或真实短生命周期 Node 子进程，分别触发 timeout 和 stdout flood；断言 runner settle 前已经收到 `close`，随后安装失败返回且 staging 不存在。

核心事件顺序断言：

```ts
expect(events).toEqual(['kill', 'close', 'self-check-settled', 'staging-removed'])
```

Windows CI/本机额外运行真实子进程用例；Unix 仍验证同样事件契约。

- [ ] **Step 2: 重构 finish 的 settle 路径**

`finish` 仍用 `settled` 防重入，但如果 `child.exitCode === null && child.signalCode === null`，先注册一次性 close 监听，再 kill；只有 close 后才 `resolve(outcome)`。已经退出时可以直接 resolve，但仍需确保 stdio 已关闭；最稳妥是统一等待一次 close。

要求：
- timeout 被 clear，不能二次 settle。
- 已注册的原 close listener 不得因 `settled=true` 阻止额外的“等待关闭后 resolve”listener。
- kill 抛错或返回 false 时记录原因，但仍按 close/error 路径完成，不引入永久挂起。
- 如增加 kill 后的有界兜底，兜底必须同时配合 staging 删除重试；不能又回到“未 close 就立即 rm”。

- [ ] **Step 3: 验证安装与完整 Qoder 测试**

```bash
npx vitest run tests/umid-install-route.spec.ts
npm run test:qoder
```

Expected: 靶向文件和 Qoder node:test 全部通过；失败路径无 `.staging-*` 遗留；重复运行不出现 EBUSY。

- [ ] **Step 4: 提交**

```bash
git add src/qoder/transport/umid-extract.ts tests/umid-install-route.spec.ts
git commit -m "fix: await umid self-check process shutdown"
```

### Task 9: 更新轮间换号注释（Q-09）

**Files:**
- Modify: `src/index.ts:1443-1446`
- Modify: `src/qoder/transport/default-transport.ts` 中受 Task 4/6 影响的旧注释

- [ ] **Step 1: 让注释描述实际语义**

将“single big turn cannot pin...”改为：三个 bound 只在新 turn 开始时检查；当前 turn 内的后续步骤继续沿用原账号，因此大 turn 可以越过 round/request 边界，边界在下一 turn 生效。

- [ ] **Step 2: 检查不再存在旧语义注释**

```bash
git diff --check
```

Expected: 无 whitespace 错误；注释不再声称 opening tool-calls 就是完整最终回答，也不再声称 transient reroute 不写 session pin。

### Task 10: 全量验证、构建与交付

**Files:**
- Generate: `lib/*`，只能通过项目构建生成。

- [ ] **Step 1: 运行所有靶向测试**

```bash
npx vitest run tests/transport-stickiness.spec.ts tests/queue-notice-recovery.spec.ts tests/reasoning-merge.spec.ts tests/catalog-lifecycle.spec.ts tests/adapter.spec.ts tests/umid-install-route.spec.ts
npm run test:qoder
```

Expected: 全部通过，无真实 30 秒队列等待，无清理超时。

- [ ] **Step 2: 运行完整检查**

```bash
npm run check
```

Expected: typecheck、全部 Vitest、node:test、build 全通过。若 UMID 仅在完整并发套件出现 EBUSY，保留失败日志和堆栈，不得以单文件通过代替修复。

- [ ] **Step 3: 验证生成物和工作树**

```bash
git diff --check
git status --short
git diff --stat
```

Expected: 无 whitespace 错误；`lib` 与源码变更一起生成；没有临时脚本、临时构建目录或测试状态文件进入提交。

- [ ] **Step 4: 重复运行易竞态部分**

```bash
npx vitest run tests/transport-stickiness.spec.ts tests/reasoning-merge.spec.ts tests/catalog-lifecycle.spec.ts tests/umid-install-route.spec.ts
npx vitest run tests/transport-stickiness.spec.ts tests/reasoning-merge.spec.ts tests/catalog-lifecycle.spec.ts tests/umid-install-route.spec.ts
```

Expected: 连续两轮结果一致。

## 5. 验收清单

- [ ] busy 和 cooling 重路由后，request/round 均属于实际 B，continuation 不回跳 A。
- [ ] deferred accountById 不再把新 B pin 覆盖成旧 A。
- [ ] 无工具 turn、正常工具链、多个工具步骤均只消耗一个 round。
- [ ] 工具链失败/中止、title、error/aborted 不消耗 round。
- [ ] queue 通知测试快速通过，默认 5 次等待仍有独立测试覆盖。
- [ ] configured wait、upstream wait、no wait 三种最终通知文案准确。
- [ ] 不同数据根的同 PAT 不共享 freshness；不同 PAT 不误清新 root probe。
- [ ] 同数据根热重载仍避免无意义重复 fetch。
- [ ] reasoning 测试所有 Context 均 await dispose。
- [ ] UMID 自检 kill 后 close 才 settle，staging 不遗留。
- [ ] adapter 断言与 `rateUnknown=true` 一致。
- [ ] `npm run check` 和 `npm run test:qoder` 全绿，构建产物同步。

## 6. 执行注意事项

1. Task 4–7 都修改 `default-transport.ts`，必须顺序执行，不要派多个代理并行改同一文件。
2. 每个任务先确认测试在修复前因目标原因失败，再实施最小修改；不要只写“修复后也会通过”的测试。
3. 不改变默认值，不删除完整轮次语义测试，不用单纯延长 timeout 掩盖 queue 或 reasoning 问题。
4. 不手改 `lib`；最终通过 `npm run check` 中的 build 或 `npm run build` 生成。
5. 若实际代码结构与计划中的示例字段名不同，保持既有风格，但必须保住第 3 节的不变量和相同测试覆盖。
6. 完成后向用户报告：各项修复、测试总数、完整 check 结果、生成物变化，以及仍不可稳定复现的问题（若有）。
