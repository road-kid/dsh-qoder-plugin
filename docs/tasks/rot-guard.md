# 任务：dsh-qoder-plugin 防风控 / 调度健壮性改造（8 项）

> 本文件是任务规格，供本仓库的开发者（人或多代理）直接执行。只改本仓库，不依赖会话上下文。
>
> **状态：T1–T8 已全部实施完毕。** 文中「新增开关改 `src/client/QuotaSettingsCard.tsx`」这类指导已过时——该文件现在只剩类型定义，设置卡的界面在 `src/client/QoderPluginCard.tsx`，配置 schema 在 `src/index.ts`。文末的历史验证记录引用的是 1.0.2 时刻的产物文件名，产物名随后续构建变化。

## 角色与背景
你是 dsh-qoder-plugin（DSH 宿主插件，TypeScript ESM）的开发者。插件通过
PAT→jobToken 换 cosy 签名，向 Qoder 上游发 chat/completions 请求，支持多账号池、
自动换号、排队等待。现状问题：多账号共用同一设备指纹；惩罚不记账（一次上游抖动
可能让整池同时冷却）；418 等瞬态 4xx 被当成不可重试的 INVALID_REQUEST；排队等待
无抖动、预算按每次尝试重置；并发请求会同时压到同一账号；200 SSE 里的内层错误
被静默丢弃，无法观测。本任务按下面 8 项改造，要求行为可测、有单测、不破坏既有
行为。

## 环境与硬约束
- 仓库：`D:\Workspace\workspace-dsh\projects\dsh-qoder-plugin`（只改这个仓库）。
- 不要动已安装 profile、不要改 DSH 宿主、不要执行 `pnpm install` 之外的安装动作。
- 禁止 `pnpm run build` / `pnpm install`（会改写 pnpm-lock.yaml）。类型检查用：
  - `node ./node_modules/typescript/bin/tsc -p tsconfig.json`
  - `node ./node_modules/typescript/bin/tsc -p tsconfig.client.json`
  - 如需产物重建（通常不需要）：`node ./node_modules/tsdown/dist/run.mjs`
- 测试：
  - vitest：`node -r ./tests/sandbox-shim.cjs ./node_modules/vitest/vitest.mjs run tests/...`
  - qoder 单测：`node --test tests/qoder/*.test.ts`
  - 已知基线失败（不要试图修、也不许变多）：`tests/adapter.spec.ts` 1 个、
    `tests/catalog-lifecycle.spec.ts` 1 个、`tests/reasoning-merge.spec.ts` 5 个超时。
- 不新增运行时依赖；不提交 git（除非另有指示）；保持 diff 聚焦。
- 代码注释沿用现有风格：英文、解释「为什么」；用户可见文案走 `t()`/locale JSON。

## 必读代码地图（先读再改）
- `src/qoder/errors.ts:155-166`
- `src/qoder/transport/default-transport.ts:52`（queueWaitCeilingMs）、`:128-146`
  （isAccountFailure）、`:451-540`（walk/换号）、`:577-620`（queue wait 与 attempt）
- `src/qoder/transport/account-reader.ts:240-320`（force/TTL 缓存）
- `src/qoder/transport/auth.ts:205-215`（creds 组装）、`wire/cosy.ts:143-170`（头）
- `src/qoder/transport/wire/sse.ts`（envelope + parseInner）、`wire/wire-types.ts`
- `src/qoder/transport/wire/serialize.ts:57`（effort 硬抛）
- `src/account-health.ts`（现有 正常/排队/限流 标签，仅供参考，不要改成路由依据的
  唯一来源）
- `src/index.ts:846-905`（health、transport 构造、failover 钩子）
- `src/settings-store.ts` + `src/client/QuotaSettingsCard.tsx` + `src/client/locales.ts`
  （设置项如何读写；新增开关要同时改这三处并补 locale 键）
- 参考实现（只读）：`E:\Workspace\zcode\agent2apisum\qoder2api-hub`
  `qoder_proxy.py` / `qoder_accounts.py` / `qoder_fingerprint.py` / `docs/*.md`

## T1 报错分类：418 与瞬态 4xx（S）
现状：`errors.ts:155-166` 把未列名 4xx 全归 INVALID_REQUEST；`default-transport.ts:130`
对 INVALID_REQUEST 直接 `return false`，导致 418 既不换号也不重试。
要求：
- 418 归类为可切换/可重试的瞬态错误（新增 `'TRANSIENT'` 码或复用 SERVER，二者择一
  并说明理由）；`isAccountFailure` 同步纳入。
- 400/404/405/422 等明确的客户端错误保持不换号（换号只会重复同样的错）。
- 未列名 4xx 的归类按参考实现 `TRANSIENT_HTTP_CODES=(418,500,502,503,504)` 对齐，
  并在注释里写清依据；若判断需要把更多 4xx 变成可重试，先列为「待确认」不要擅自改。
测试：418→换号并重试；400→不换号；5xx 保持现状；错误消息/日志不泄露 token。

## T2 排队抖动 + 请求级预算（S）
现状：`queueWaitBudget()` 在 `attempt()` 内初始化，换号后预算重置；等待时间无抖动。
要求：
- 等待时长 = 上游建议值 + 1000ms + random(0,2000)ms（RNG 可注入以便测试）。
- 预算改为「每请求一次」：`walk()` 计算剩余预算并传入 `attempt()`，换号不重置；
  上限仍受 `queueWaitCeilingMs=5min` 约束。
- 排队仍不换号、不解绑会话 pin（保持现有语义）。
测试：两账号依次排队时总等待次数等于配置值且只算一次；抖动落在区间内且可注入
固定值；预算耗尽后按现有路径返回。

## T3 设备身份按账号派生（M，最高优先级之一）
现状：`auth.ts:211` machineID = `resolveMachineId()`（全局一个文件，`index.ts:855` 注入），
`wire/cosy.ts:143` 兜底 `getMachineId()` → 全池共用，属「多号=同一台设备」反模式；
且无 `Cosy-Machinehostname`。
要求：
- 新增 `deriveMachineId(userID, salt)`：`MD5(salt:uid)` 生成，设置 UUIDv4 版本/变体位，
  36 字符稳定输出；同 uid 恒定，不同 uid 不同，不等于全局 machine id。
- `auth.ts` 组装 creds 时按 `userInfo.userID` 派生；无 uid 时回退原 `resolveMachineId`。
- 补 `Cosy-Machinehostname`（派生 `DESKTOP-XXXXXXXX`），仅 chat/infer 请求携带，
  模型列表与状态请求不带（对齐参考：hostname 仅 infer-sse）。
- 严禁改动 `src/qoder/transport/risk-identity.ts` 与签到链路：campaign/签到必须继续
  使用真机 UMID（该模块注释已说明原因）。签到请求头保持字节级不变。
测试：两账号同机 chat 的 `Cosy-Machineid` 不同；campaign 请求仍带真机身份；
模型列表带派生 id；派生函数单测（稳定性/形状/差异性）。

## T4 账号流量守卫（S~M）
现状：无任何按账号限流，多个并发请求可同秒压到同一账号。
要求：每账号并发上限 1、两次启动最小间隔 400ms + 0~100ms 抖动；获取许可最多等
30s，超时 fail-open（放行并 WARN），避免把宿主卡死。放在 transport 内按
`account.id` 维护的 keyed limiter 里，`finally` 释放。
测试：3 个并发请求到同一账号，启动时间间隔 ≥400ms 且不并发；不同账号互不阻塞；
30s fail-open 路径可注入时钟验证。

## T5 防自伤：blame 延迟记账（S）
现状：health 标签只展示；一旦引入惩罚就会「一次上游抖动烧掉全池」。
要求：
- 新增惩罚账本（进程内 `Map<accountId, {cooldownUntilMs, level}>` 即可，不落盘，
  注释写明重启即忘是有意为之）：
  · 软限流：base 600s，每次 ×2，封顶 7200s；
  · 熔断：连续 3 次硬失败 → 1800s 起，×2，封顶 21600s；
  · 降权：未知错误 5 次 → 600s 起，封顶 7200s，不阻止 ready，仅选号时后置。
- blame 语义：请求失败时把惩罚放进「待定 blame」，只有换号后另一个账号成功才落账；
  整轮全败（走完池子仍失败）则丢弃这些 blame，不惩罚任何账号。
- 选号时跳过仍在冷却的账号；全部冷却时按原路径抛错（不要自造等待）。
- `note_success`（成功请求）清空该账号全部惩罚与连续计数。
测试：A 失败→B 成功则 A 进入冷却；A、B 都失败则两者都不冷却；冷却中的账号被选号
跳过；成功后惩罚清空。

## T6 内层错误观测（S）
现状：200 响应里 SSE 内层 payload 的错误被静默丢弃（transport 内 grep 无处理）。
要求：
- 在 `wire/sse.ts` 解析内层 chunk 时识别错误形态（error/errorCode/code + message 等），
  按 content_policy / rate_limit / invalid_request / auth / other 五类计数。
- 每类每条流首次 WARN 一次（含脱敏摘要），后续只计数；不得把已开始输出的流变成
  可重试（字节已交给宿主）。
- 计数通过现有 health/status 通道暴露一个只读快照（进程内），供后续 RISK_STATS 使用；
  本轮不做 UI。
测试：构造 200 流内层错误 fixture，断言分类、计数、一次 WARN、不重复换号。

## T7 多并发调度防重（S~M）
现状：并发请求都从 `activeAccount()` 出发，换号路径无保留机制，可能重复选中同一账号。
要求：
- 派发前「先占后用」（reservation）：`walk` 中按 `account.id` 预留，结束/异常/abort
  时 `finally` 释放；`nextAccount` 跳过已被其他请求预留的账号（有界尝试，池空则抛原错）。
- 与 T4 的 limiter 分工：reservation 解决「别选同一个」，limiter 解决「同一账号的
  节奏」。
- 保证不改变单请求、单账号池的行为。
测试：两个并发请求不同时选中同一账号；异常与 abort 后预留释放；单账号池行为不变。

## T8 客户端指纹对齐官方当前版本（S）
现状：`wire/cosy.ts:20` `qoderIdeVersion='1.1.47'`（UA 同源），`request.ts:190` 另有
`'cosy-version': '1.0.1'`，两处不一致且落后官方。
要求：
- 从参考仓库确认官方当前版本值，集中到单处导出（如 `wire/version.ts`：
  `qoderIdeVersion` / `qoderUserAgent` / `metadataCosyVersion`），消除硬编码散落；
- UA 与 `Cosy-Version` 由同一常量派生；metadata 请求头的版本按参考实现的语义处理
  （若确认应为同值则统一，若确为不同头则注释写明依据）；
- 支持环境变量覆盖（如 `QODER_IDE_VERSION`）便于灰度，默认用官方当前版本。
测试：UA/Cosy-Version 一致性；覆盖生效；无残留字面量。

## 顺序与交付
顺序：T1 → T5 → T3 → T6 → T2 → T4 → T7 → T8（T1/T5/T3 是本周必须；若时间紧，
T6 与 T2 可拆下一批）。每项独立可回滚，测试与实现同批提交到工作区。
逐项汇报：改了哪些文件与行为、新增测试名、验证命令与输出摘要、遗留/待确认项。
完成后给出：typecheck 结果（两个 tsconfig 均 0 错误）、新增测试全过、全量 vitest
与 test:qoder 与基线对比（只允许出现基线那 7 个失败）。
禁止：改动 profile 安装目录、改 DSH 宿主、动 pnpm-lock.yaml、提交 git、修基线失败。

## 团队分工（本仓库当前执行方式）
- 并行车道（文件写域不重叠）：
  - `transport-scheduling`：T1、T5、T2、T4、T7（都落在
    `src/qoder/transport/default-transport.ts`、`src/qoder/errors.ts`、
    `src/account-health.ts`、`src/index.ts` 及新增模块）。
  - `identity-version`：T3、T8（`src/qoder/transport/auth.ts`、
    `src/qoder/transport/wire/cosy.ts`、`src/qoder/transport/wire/version.ts`、
    `src/qoder/transport/request.ts`）。
  - Lead：T6（`src/qoder/transport/wire/sse.ts` 及新增观测模块）＋ 验收。
- 车道内按上面顺序串行，完成一项即跑该项测试并汇报。
- 共享任务板上的任务与依赖为准；跨车道只通过 Lead 协调。

## 实施结果（2026-10-22，全部完成）
- T1 errors.ts `TRANSIENT`（418 等瞬态 4xx）→ default-transport `isAccountFailure` 换号；
  tests/qoder/errors.test.ts 8、tests/transport-failover.spec.ts 新增 418 用例。
- T5 account-health.ts 新增 `QoderAccountPenaltyLedger`（soft 600s×2≤7200s / breaker 3 次→1800s×2≤21600s /
  unknown 5 次→downweight≤7200s，成功清空），transport `pendingBlame` 只在换号后他号成功才落账；
  tests/account-penalty.spec.ts 7 + failover 3。
- T3 device-identity.ts 按 userID 派生 `derivedMachineID`/`machineHostname`，仅 chat/infer 使用；
  status/plan/quota/campaign 仍真机 UMID；tests/qoder/device-identity.test.ts 等。
- T6 wire/inner-errors.ts 内层错误分类计数 + sse.ts 每流每类一次 WARN（回调有 try/catch），
  status 文档新增只读 `innerErrors` 快照；tests/qoder/inner-errors.test.ts 11、
  tests/qoder/inner-error-warn.test.ts 4、tests/inner-error-failover.spec.ts 3。
- T2 queueWait 预算每请求一次（换号不重置），等待 = 建议值 +1000ms + random(0,2000)，总 ≤5min；
  tests/transport-queue-budget.spec.ts 4。
- T4 transport/account-limiter.ts：账号级并发 1、启动间隔 400+0~100ms、30s fail-open + WARN、
  finish/finally 双路径释放；tests/transport-account-limiter.spec.ts 5。
- T7 `reservedAccounts` reservation：派发前占号、nextAccount 跳过、finish/abort/finally 释放，
  单账号池行为不变；tests/transport-reservation.spec.ts 4。（后被单闸门方案取代，见下节。）
- T8 wire/version.ts 唯一版本字面量：qoderIdeVersion=1.1.75（QODER_IDE_VERSION）、
  metadataCosyVersion=0.4.8（QODER_DESKTOP_VERSION）；UA 与 Cosy-Version 同源；tests/qoder/version.test.ts 5。
- 验证：两个 tsconfig 0 错误；test:qoder 179/179；全量 vitest 707 passed / 7 failed（恰为基线 7 个）；
  lib 已用 tsdown 重建。
- 遗留：无（campaign 指纹已在后续轮次解决，见下节）。T5 的 unknown 分类在 transport 路径暂不可达
  （账本惰性路径，留待 RISK_STATS）。

## 后续修复轮次（2026-10-22 晚）
用户报告「调用不了模型：已自动切换到下一个账号重试（原因：account is already serving another request）」。
根因：并发请求（宿主新会话首条消息必然触发的 title 请求）持有 reservation 时，第二个请求把
「主账号忙」当成真实故障转移播报并持久化，随后备用账号 PAT 失效，走查又跳过被占用的主账号 → 硬失败。

- 提交 `fb74579`（P0）：派发跳过（cooling/reserved）改为静默，不再走 `switched` 播报/持久化；
  失败走查允许兜底到 busy 账号；`release` 提前到 acquire 之前；`queueWaitMs` 取
  `max(retryAfter, waitTime)`（5min 封顶）；`autoFailover` 尊重开关与 parked；健康标签未观测渲染
  「尚未观测」；`switched` 的 activate 失败只 warn。
- 提交 `03b015e`（可观测性 + 指纹）：排队等待开始即通过 `onQueueWait` 播报「正在等待约 N 秒后重试
  （第 X 次等待）」，请求级编号避免同轮去重；campaign/签到请求钉死 legacy 头
  `qoder/1.1.47` + `cosy-version: 1.0.1`（`campaignUserAgent`/`campaignCosyVersion`），
  与 1.0.0 字节级一致，推理/metadata 仍 1.1.75/0.4.8。
- 本轮（items 3–7）：
  · 单闸门：删除 reservation Set，`QoderAccountTrafficLimiter.isBusy()` 成为唯一派发闸门；走查单遍
    收集 busy/deprioritized 作兜底，删除 `walkAfterFailure` 二轮。
  · active 指针：冷却跳过时通过 `adopted` 钩子静默把 active 迁到备用账号（无 notice、无 failoverAt），
    busy 跳过不 adopt（另一请求正在使用，不是账号问题）。
  · 健康语义：`queuedHealthTtlMs=5min` 的短 TTL，排队永不升级 `limited`；`healthOf(id, nowMs)`；
    `limited` 只由连续失败产生。
  · innerErrors 上卡片：非零类别渲染为一行 caption（全部为 0 或缺失时不渲染）。
  · 文案三态：已开启 / 自动切换待命（仅 1 个可用账号）/ 已关闭；composer 与卡片统一「尚未观测」。
- 验证：tsc 两个 tsconfig 0 错误；vitest 全量与 test:qoder 见提交说明；lib 用
  `node ./node_modules/tsdown/dist/run.mjs` 重建。

## 轮换逻辑统一轮次（2026-10-22 夜）
用户报告（m00001 / m00331）：「路由策略和会话粘性，每轮切换没有生效」。
根因不是配置没生效，而是三套选中机制各自为政，且最关键的记账代码在生产形态下不可达。

- 根因 A（轮次计数失效，最致命）：`src/upstream.ts:980-1023` 的 `bodyStream` 在看到 `finish`
  分块后就关闭 body，**不再拉取、也不调用 `iterator.return()`**（`cancel` 才调用，`:1019-1021`）；
  而 `src/qoder/transport/default-transport.ts` 走查里 `noteSuccess` / blame 落地 /
  `completeRound` 三件事原先写在 `yield* this.attempt(...)` **之后**，于是生产环境永不执行。
  后果：粘性「轮数」永不计数 → 用户设置 rounds=1 也永不换号；同时 `QoderAccountPenaltyLedger`
  的 `noteFailure` 全仓仅此一处调用 → 整条冷却/熔断/降权阶梯（`src/account-health.ts:151-323`）
  完全惰性，`isCooling`/`isDeprioritized` 恒为 false。
- 根因 B（自定义顺序只在失败路径生效）：`rotatePin` 调的是**原始钩子** `failover.nextAccount`
  （保存顺序），而失败走查调的是统一解析器 `nextAccount`（自定义顺序优先），两者答案不同。
- 修法（统一为一个「谁承接下一位」解析器）：新增模块级 `isServedFinish()` 与 `AttemptState.onServed`
  回调，在 `attempt` 的 `finish` 分块处一次性触发记账（`noteSuccess` → blame 落地 →
  `completeRound`），与既有的 `release()` 同一处——因为那里是分块被交付的唯一确定时刻；
  回调内部 try/catch，记账异常不影响流。`rotatePin` 改为先 `nextWalkAccount(...)`（跳过冷却/忙）
  再兜底 `nextAccount(...)`（自定义顺序），与失败走查完全同一套顺序。
  起点优先级改为 `pinned ?? preferredStart(failover, active)`：粘性会话优先，其次自定义列表
  首个可用账号，最后才是保存的当前账号（见下方「剩余三项」轮的修正）。
- 顺带修复的审计项 #23 冷却状态可见——冷却跳过时的 warn 日志附带 `penalties.snapshot(id)`，
  此前该状态无任何出口。
- **已回退**：#20「空响应改抛错」曾在此轮实现后又撤回。`tests/qoder/transport.test.ts` 整个文件
  （20 例中的 19 例）用 `data: [DONE]

` 作为「正常完成的空流」夹具，抛错会让它们全红；
  空回答是否算账号故障属于传输契约决策，不应在无产品结论时改动，故 `streamChat` 保持原样。
  现状：`isServedFinish` 仍不把 `EMPTY_RESPONSE` 计入轮次/免责，但走查不会因此换号——已知遗留。
- 回归测试（关键：用生产消费形态，否则旧代码也能通过）：`tests/transport-stickiness.spec.ts`
  「rotates on the round bound when the caller stops at the finish chunk」；
  `tests/transport-routing-order.spec.ts`「rotates a bound-reached session along the custom list」；
  `tests/transport-failover.spec.ts`「lands the deferred blame when the caller stops at the finish chunk」
  （「空回答换号」条已随 #20 回退一并删除）。
  三条新增用例在 HEAD 源码上逐一失败、在修复后通过（已做反向验证）。
- 验证：两个 tsconfig 0 错误；vitest 全量 735 tests，728 passed / 7 failed，恰为既有基线
  （adapter 1、catalog-lifecycle 1、reasoning-merge 5 的超时抖动）；test:qoder 182/182。
- 未修（需产品决策）：`docs/tasks/inert-features.md` 的 R1/R2——plan/quota 请求缺失
  `Cosy-MachineToken`、host UMID 与官方客户端不同源；以及「空响应」的语义是否应计入轮次。
- 遗留：`lib` 未重建（本轮未改导出签名，仅内部实现；若需发版按 `node ./node_modules/tsdown/dist/run.mjs`）。

## 剩余三项收口轮次（2026-10-23 凌晨）
用户（m01865）要求解决 `docs/tasks/inert-features.md` 剩下的三项，并允许参考
`E:\Workspace\zcodegent2apisum\qoder2api-hub`。三项均已落地，全程只读参考、未复制其代码。

- ① plan/quota 缺设备令牌（审计 R1）：`src/qoder/transport/account-reader.ts` 的 `loadAccountWith`
  原先只把 `creds.machineID` 交给 `safeFetchStatus`，`fetchUsage` / `safeFetchPlan` 不带任何机器头。
  现在三处元数据读取统一带上 host UMID（`Cosy-MachineToken` + `Cosy-MachineType: host`），
  与 `wire/cosy.ts:177-180`、`auth.ts:211-214` 的注释承诺一致；`tests/qoder/usage.test.ts` 的
  用例改为对 quota/plan/status 三份请求头逐一套断言，防回归。
- ② host UMID 与官方客户端不同源（审计 R2）：`machine-id.ts` 的默认候选列表本已按
  `[~/.qoder/.auth/machine_id, ~/.dsh/qoder/machine_id]` 排序，但 `src/index.ts` 在宿主侧显式只传了
  `[qoderMachineIdPath()]`（`<profile>/state/.qoder-machine-id`），于是官方 id 永远读不到、每个 profile
  各生成一份。现在 `resolveMachineId: () => getMachineId()` 走默认链：官方客户端存过的 id 优先命中
  （本机实测 `~/.qoder/.auth/machine_id` = `7f8262e2-5468-46c5-9609-d41ecff7b035`），否则在整个 DSH
  主机级种子一次；`src/paths.ts` 的 `qoderMachineIdPath()` 随其唯一用途删除。
  **不**把原生 `runtime-info` 桥接结果用于元数据：它是 campaign 家族（clienttype 10）的身份、异步且
  最多等 25s，而 plan/quota 属 CLI 家族（clienttype 5），CLI 自己存下的 id 才是同源答案。
  新增 `tests/qoder/machine-id.test.ts`（3 例）覆盖「官方 id 优先 / 无官方 id 时落到主机级种子 /
  只在最后一级创建且绝不伪造官方文件」。
- ③ 起点优先级语义：`src/qoder/transport/default-transport.ts` 的走查起点
  `let first = pinned ?? active` 改为 `pinned ?? await this.preferredStart(failover, active)`。
  新私有方法 `preferredStart` 在 `custom` 策略下取 `routing.order()` 中首个能解析出的账号，
  解析不出任何人则退回 `active`（笔误不是策略）。理由：自定义顺序是一份**优先级**，
  它必须决定会话**从哪里开始**，否则只在失败时才显现，用户看到的就是「列表没生效」；
  保存顺序没有声明优先级，故仍以当前账号起步。冷却/忙不在 `preferredStart` 里跳过，
  因为紧随其后的派发块对任何起点都统一应用这两项临时事实。
  `tests/transport-routing-order.spec.ts` 相应扩到 7 例（首例即「新会话从列表头开始」，
  并覆盖「头部不可服务时沿列表下走」「跳过已删除账号」「列表成环只走一圈」）。
- README 同步：`README.md:42` 与 `README.en.md:40` 说明自定义顺序是优先级、新会话从首个可用账号开始；
  两个 README 的 `routingOrder` 表格行同步（`README.md:231`、`README.en.md:252`）。
- 验证：`tsc -p tsconfig.json` 与 `-p tsconfig.client.json` 均 0 错误；vitest 全量
  734 tests / 728 passed / 6 failed（adapter 1、catalog-lifecycle 1、reasoning-merge 4~5 的超时抖动 = 既有基线）；
  `node --test tests/qoder/*.test.ts` 185/185 通过；`tests/qoder/usage.test.ts` 8/8、
  `tests/qoder/machine-id.test.ts` 3/3。
- 遗留（需产品决策）：空响应是否算账号故障（#20，已回退，见上一轮说明）；审计 #16（`machineID`
  字段名与实际用途不一致）属命名问题，#23 已有日志出口。
- 本轮 `lib/` 已按 `node ./node_modules/tsdown/dist/run.mjs` 重建。

## 会话粘性默认值与发版（2026-10-23）

用户决定不再讨论取值依据，直接指定默认值：**轮数 3 / 请求次数 200 / 分钟 180**，版本号 1.0.1。

- 默认值落点（五处必须一致）：`src/index.ts` 的传输接线 `rounds/requests/minutes`（`?? 3 / ?? 200 / ?? 180`）
  与 `DEFAULT_FOR_FIELD`；`src/client/QoderPluginCard.tsx:174-178` 的 `STICKINESS_ROUNDS_DEFAULT = 3`、
  `STICKINESS_REQUESTS_DEFAULT = 200`、`STICKINESS_MINUTES_DEFAULT = 180`；`README.md:42` 与其表格行、
  `README.en.md:40` 与其表格行；`docs/accounts-notice-failover.md:306-308`（顺带把 `stickinessRequests`
  的上限从笔误的 `0..1000` 校正为代码实际的 `0..10000`）；`tests/plugin-card.spec.ts` 的「三个控件显示宿主默认值」
  断言（'3' / '200' / '180'）。
- 卡片只显示宿主的默认值、不自己发明数字，所以这三项改动必须成对：源码默认值变了而卡片常量没变，
  控件就会显示一个宿主并未使用的数字（该测试的注释正是为此写的）。
- `package.json` 版本 1.0.0 → 1.0.1；`CHANGELOG.md` 新增 `## 1.0.1 — 2026-10-23` 段，
  按既有体例写「用户可见行为」：粘性与轮换真正生效（轮数在终止 chunk 计数、罚分阶梯复活、
  粘性换号与失败换号共用同一份顺序、新会话按自定义优先级起点）、默认值调整及理由、
  plan/quota 带上设备令牌、机器号回到官方客户端来源、冷却跳过可被日志看见。
- 验证：`tsc -p tsconfig.json` 与 `-p tsconfig.client.json` 均 0 错误；`lib/` 重新构建通过；
  vitest 全量 734 tests / 728 passed / 6 failed = 既有基线（adapter 1、catalog-lifecycle 1、reasoning-merge 4 超时）；
  `node --test tests/qoder/*.test.ts` 185/185 通过。
- 发版：提交到 `origin`（`road-kid/dsh-qoder-plugin`）并用 `npm pack` 出 1.0.1 的 tarball；未执行 `npm publish`。

## 跨版本账号池收口（2026-10-24，版本 1.0.2）

用户报告的感知是「轮换坏了」：UI 与文档从 1.0.0 起就承诺自定义顺序「可跨国内/国际版混排」，
但宿主侧从未实现，混排列表会静默退化成「本版本文件里恰好有的账号」。

- 根因（审计 `docs/tasks/` 记录的六条失败点，全部落地修复）：
  1. 池 hooks 闭包在单一 store（`src/index.ts` 的 `activeAccount`/`nextAccount`/`accountById`
     只读 `store`），transport 永远拿不到兄弟文件的 PAT；
  2. `accountById` 把外来 id 解析成 `undefined`，于是 custom 顺序与 pin 里的跨区 id 被静默跳过；
  3. `auth.ts` 的 `nextAfter` 在 `index === -1` 时重置到本地首行，save-order 在文件末尾绕回自己；
  4. transport 级 `region` 钉死：即便外来 PAT 到达，也会用本 variant 端点交换 job token
     （china `gateway.qoder.com.cn` vs global `api3.qoder.sh`），必然 AUTH 失败；
  5. `switched`/`adopted` 调 `store.activate(toId)`，外来 id 抛错只 warn，指针永不移动，
     卡片「当前账号」与实际签名者分叉；
  6. 计价与 `autoFailoverActive` 按文件判定，1+1 拆分池读起来「只有一个可用账号」。
- 修复落点（不变量：region X 的账号只被 region X 的端点调用，跨区只发生在池层，绝不搬行，
  `auth.ts` 的读时重盖章保持不动）：
  - `src/qoder/transport/index.ts`：新增 `QoderPooledAccount { id, pat, region? }`，
    `QoderFailoverHooks` 三处返回与 `switched`/`adopted` 的载荷都带上 region（optional，
    单区宿主与旧宿主继续编译）。
  - `src/qoder/transport/default-transport.ts`：`authByRegion`/`uploaderByRegion` 两个懒建 map
    （`authFor`/`uploaderFor`），`attemptRegion(account) = account.region ?? this.region`；
    `attempt`/`attemptPaced`/`streamChat` 全部按 attempt 的 region 取服务与端点；
    `SessionPin` 带 region 并在 `pinnedAccount`/`pinSession`/`rotatePin` 里贯穿。
    缓存键本来就是 `${region}:${pat}`，所以两个 auth/usage 实例天然隔离。
  - `src/index.ts`：池层抽出可测试的纯函数 `poolOrder`/`poolOwner`/`pooledAccount`/
    `pooledAccountById`/`poolRing`/`pooledNextAccount`/`adoptPooledAccount`/`poolSeatFlags`
    （`PoolMember` 只要求 `variant.id` 与 `store` 的 `byId`/`list`/`activate`）；
    hooks 全部改走池；`apply` 改两阶段接线（先建 `runtimes` 再传 `pool()`）；
    `activeAccount` 仍只读本文件（起点不跨区，避免「本地请求被兄弟 PAT 签名」），
    但跳过 parked 的 active 行；`autoFailoverActive` 改用 `poolSeatFlags(pool())`；
    health tracker 上提为池级共享（id 是 PAT 单向哈希，不会串号，修复跨区交接时
    「失败记在不拥有该行的文件里，标签仍是正常」）。
  - `src/client/QoderPluginCard.tsx`：统一页的 60s 轮询从「只轮当前 variant」改为
    「当前 variant force + 兄弟 variant 非 force」，同一个 timer（`tests/plugin-card.spec.ts`
    的 `intervalHandles` 断言仍为 1）。
  - 回退项：`poolAuthPathOf` 死代码已删——池行只来自当前 variant 自己的 status 文档，
    跨区行从不渲染，该反查永不命中。
- 收尾修正：`STICKINESS_ROUNDS_FIELD`/`STICKINESS_REQUESTS_FIELD` 的 schema 默认值
  由 1/60 改回 3/200，与 transport 接线（`current().stickinessRounds ?? 3` 等）、
  `DEFAULT_FOR_FIELD` 字面回退表和卡片常量三处对齐——此前 `view()` 的 `base` 靠字面
  回退表碰巧显示正确值，settings 文档的 `default` 却写着旧值。
- 遗留（记录，未改）：`QoderImageUploader` 的 `refreshCredentials` 走 `this.requirePat()`，
  跨区 attempt 首次上传失败重试时会拿到本 variant 的 PAT；只在 retryable 首次失败后触发。
  status 路由对跨区行仍用本 variant 的 `usage` reader 计价，会得到 `creditsError`
  （卡片合并两文档的池渲染未做）。
- 测试：新增 `tests/cross-variant-pool.spec.ts`（8 例，两个真实 `QoderCredentialStore` 于 tmpdir）：
  `poolOrder` 对称、`poolRing` 跨文件续走、`pooledAccountById` 跨区解析 + parked 拒绝、
  未知 id 重启环、`adoptPooledAccount` 只动 owning 文件、无 owner 时 warn 不抛、
  `poolSeatFlags` 让 1+1 拆分池 `autoFailoverActive === true`（park 后 false）、
  真实 `createQoderTransport({region:'china'})` 下 CN 503 → Global 服务且
  `chatUrls = [getQoderChatUrl('china'), getQoderChatUrl('global')]`、
  `chatPats = [CN_PAT, GLOBAL_PAT]`、exchange 只打两个 region 端点、两个文件 activeId 各自正确。
  `tests/plugin-card.spec.ts` 新增「统一页两个 variant 都轮询」1 例。
- 验证：`tsc -p tsconfig.json` 与 `-p tsconfig.client.json` 均 0 错误；
  `node --test --test-isolation=none --experimental-strip-types tests/qoder/*.test.ts` 186/186；
  vitest 全量 **754 tests / 747 passed / 7 failed** = 既有基线（`tests/adapter.spec.ts` 1、
  `tests/catalog-lifecycle.spec.ts` 1、`tests/reasoning-merge.spec.ts` 5，均为 5000ms 超时抖动）。
- `package.json` 1.0.1 → 1.0.2；`CHANGELOG.md` 新增 `## 1.0.2 — 2026-10-24` 段（按既有体例写用户可见行为：
  轮换跨文件续走、账号按自己 region 的端点签名、跨区切换落到拥有它的文件、健康标签与自动切换徽章按整池、
  统一页两侧都保持新鲜）；`lib/` 已用 `node ./node_modules/tsdown/dist/run.mjs` 重建（产物
  `lib/variants-DNfQrvDC.js` 带 `QODER_CONNECT_VERSION = "1.0.2"`）。
- 未做：git 提交（工作区保留全部改动）。
