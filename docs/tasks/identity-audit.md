# 设备指纹 / 随机抖动 生效审计

审计范围：`dsh-qoder-plugin` @ HEAD `937a8ca`。只读审计，未改动任何源码。
审计方式：源码通读 + 本机实测（跑测试、直接调用导出函数、直接执行客户端 helper）。

> 行号约定：下文行号对应**当前工作区**文件。工作区的 `src/qoder/transport/account-limiter.ts` 存在一处与本次审计无关的既有格式改动（`gateFor` 的 `const existing` 被换行，行数 266→267），因此该文件 ≥214 行的引用比 HEAD 多 1：`reportFailOpen` 在 HEAD 是 `:257`、`clampRandom` 在 HEAD 是 `:263`。本审计未修改该文件。


---

## 一、判定总表

### 设备指纹（per-account device identity）

| # | 功能点 | 判定 | 关键证据 |
|---|---|---|---|
| 1 | `deriveMachineId(userID, salt)` 确定性 + per-account 区分 | ✅ 正常 | `src/qoder/transport/device-identity.ts:43-53`（`MD5(\`${salt}:${userID}\`)` → 铸 UUIDv4 版本位 `4`/变体位 `a`）；`machineIdSalt='machine'` `:22`。实测同一 userID 两次调用完全一致，两个 userID 不同，且 100% 匹配 UUIDv4 正则 |
| 2 | `deriveMachineHostname(userID)` 确定性 + per-account 区分 | ✅ 正常 | `src/qoder/transport/device-identity.ts:64-66`（`DESKTOP-` + `MD5('hostname:'+uid)` 前 7 位大写 hex）；salt 与 machineid 不同（`:28` vs `:22`），二者不可互推。实测 `DESKTOP-DCF49F6` 稳定、另一账号 `DESKTOP-CF689F0` |
| 3 | 每次 PAT 交换后写入 `CosyCredentials`（含自愈 `exchangeFresh`） | ✅ 正常 | `src/qoder/transport/auth.ts:176` → `:225-240`：`machineID: this.resolveMachineId()`(`:230`) + `derivedMachineID`/`machineHostname`(`:231-236`)，随后 `:239` 写缓存。`exchangeFresh`(`:114-128`) 也走同一个 `exchangeAndResolve`，自愈后同样是新派生的 creds |
| 4 | 缓存 `cacheKey = region + opaqueCredentialKey(pat)` 是否跨账号污染 | ✅ 正常 | `src/qoder/transport/auth.ts:238`、`:89`、`:142`；`opaqueCredentialKey = sha256(value)` `src/qoder/transport/request.ts:16-18`。PAT 与账号一一对应且 key 含 PAT 哈希 → 不同账号不同 key。`clear(pat)` 也只删自己那条。无 userID 时不进 creds（`fetchUserInfo` 直接抛 `QoderLlmError(...,'AUTH')` `auth.ts:261-263`）→ 不会出现「空身份被缓存」 |
| 5 | `Cosy-Machineid`/`Cosy-Machinetoken` 取值顺序 `derivedMachineID \|\| machineID \|\| getMachineId()` | ✅ 正常（派生优先） | `src/qoder/transport/wire/cosy.ts:182`、`:190-191`（同一值成对下发）。三个调用点全部走 here：`src/qoder/transport/chat.ts:80`、`src/qoder/transport/catalog-reader.ts:41`、`src/qoder/transport/image-upload.ts:342` |
| 6 | `Cosy-Machinehostname` 仅在 `includeMachineHostname === true` 时出现 | ✅ 正常，且传参方唯一 | `src/qoder/transport/wire/cosy.ts:78`、`:194-196`。全仓**唯一**传 true 的是 chat/inference：`src/qoder/transport/chat.ts:80`。model list(`catalog-reader.ts:41`) 与 image upload(`image-upload.ts:342`) 均不传 → 与 `chat.ts:78-80` 注释「只有 inference 流带 hostname」完全一致 |
| 7 | 元数据 status 请求带 host UMID 作 `Cosy-MachineToken` | ✅ 正常 | `src/qoder/transport/account-reader.ts:315`（`safeFetchStatus(creds.authToken, creds.machineID, signal)`）→ `:396 machineId` → `src/qoder/transport/request.ts:218-221`（`Cosy-MachineToken` + `Cosy-MachineType: 'host'`） |
| 8 | **元数据 plan / quota 请求带 `Cosy-MachineToken`** | ❌ **未生效** | `src/qoder/transport/account-reader.ts:343-352`（fetchUsage）与 `:365-374`（fetchPlan）**都不传 `machineId`**。全仓唯一传 machineId 的调用点是 `:315`。与三处文字承诺矛盾：`cosy.ts:177-180`「metadata requests (status/plan/quota) keep sending this host's real UMID」、`auth.ts:211-214` 同义、`docs/tasks/rot-guard.md:163`「status/plan/quota/campaign 仍真机 UMID」 |
| 9 | host 级 UMID（`machine-id.ts`）是否仍被正确使用 | ✅ 正常（生产路径清晰） | 生产接线 `src/index.ts:905`：`resolveMachineId: () => getMachineId([qoderMachineIdPath()])`；`paths.ts:151` → `:138-140` → `:126-131`。本机四份文件都在（见「实测证据」）。`getMachineId` 先读后建：`machine-id.ts:14-23` 读，`:25-33` 生成并 `writeFileSync(..., { flag: 'wx' })` 落盘 |
| 10 | 落盘失败退化路径是否会导致每次进程启动指纹变化 | ⚠️ 部分生效 | `src/qoder/transport/machine-id.ts:33-38`：`wx` 失败 → 重读 savePath；重读**也失败**则 `:38 return machineId` 返回**未落盘的临时随机值**。触发条件 = 目录不可写且首次启动 → 每次进程 host UMID 都变。正常情形不自触发（本机已稳定落盘）。该退化路径**无任何测试覆盖** |
| 11 | host UMID 与真实 Qoder 客户端同源 | ⚠️ 不同源 | 插件读/写的是 profile 级 `…/.dsh-qoder-plugin/state/.qoder-machine-id`，`defaultMachineIdPaths()`（`machine-id.ts:6-11`）里的 `~/.qoder/.auth/machine_id` 在生产接线中被单元素数组覆盖，**永不读取**。本机实测：`~/.qoder/.auth/machine_id`=`7f8262e2-…`，而三个 profile 的插件 UMID 分别是 `8673b2a6-…`/`58e03c0d-…`/`4ac5f6e6-…`，四个值互不相同 |
| 12 | `account-reader.ts:380-415` 附近 machineId 实际传值 | ✅ 有传但值是 profile 级 UMID | `:312-316` 的 `Promise.all` 里 `:315` 传 `creds.machineID`；`creds.machineID` 来自 `auth.ts:230 this.resolveMachineId()` → `index.ts:905` → profile 级文件。即 status 请求携带的是「插件自称的主机身份」，不是 Qoder 客户端写入的真实 UMID。`safeFetchStatus`(`:406-418`) 失败只 `logger.warn` 并返回 undefined（降级静默，card 少一个字段） |
| 13 | 签到/风险身份（`risk-identity.ts`）本机能否拿到身份 | ✅ 本机能拿到 | installRoots 命中 `D:\Program Files\Qoder`（`risk-identity.ts:83`）。实测该 helper 可执行并返回完整 machineToken/machineCode/machineType（见「实测证据」）。env 映射 `riskEnvForRegion = { global: '3', china: '0' }`(`:63`) 实测有效——同一 uid 在两个 env 下返回两组不同身份 |
| 14 | 签到失败时是否静默失效 | ⚠️ 部分生效（china 区静默） | `src/qoder/transport/checkin.ts:273` 取 identity；`:274-283` **只在 `region === 'global'` 且 identity undefined 时**报 `reasonCode:'no-client'`。china 区 identity undefined 时直接 `:284 fetchCampaigns(...)` → 上游对无身份请求回 200+空列表 → `:287-294` 报 `status:'no-campaign'`，把「本机没有客户端」伪装成「今天没有活动」，用户无从得知 |

### 随机抖动

| # | 功能点 | 判定 | 关键证据 |
|---|---|---|---|
| 15 | `400ms + Math.floor(clampRandom(random()) * 100)` 是否落在 [0,100)ms | ✅ 正常 | `src/qoder/transport/account-limiter.ts:28`、`:37`、`:171`；`clampRandom` `:264-267`（`Math.max(0, Math.min(0.999, v))`）→ `Math.random()∈[0,1)` ⇒ `floor(r*100)∈[0,99]`。实测 20 万次采样：`gapMs ∈ [400, 499]`，均值 449.49 |
| 16 | fail-open 路径是否可见（onFailOpen 接 logger） | ✅ 正常 | limiter：`accountAcquireTimeoutMs=30_000`(`:46`)、超时分支 `:159-165`、pacing 超预算分支 `:178-185`、`reportFailOpen` `:258-260`。transport：`default-transport.ts:331-343` 构造时注入 `onFailOpen: (info) => this.logger?.warn?.('[Qoder Stream] Account traffic guard timed out waiting for its turn; letting the request through', { accountId, waitedMs })` → 已接 logger，fail-open 会在日志里留痕（但无指标/计数，只有一条 warn） |
| 17 | `default-transport.ts:330-345` 构造 limiter 是否覆盖 jitter/now/random | ✅ 正常（有意只继承时钟与随机） | `:324 this.now = options.now ?? Date.now`、`:325 this.random = options.random ?? Math.random`；`:331-343` 只传 `now`/`random`/`onFailOpen`。`minStartGapMs`/`jitterMs`/`acquireTimeoutMs` **不覆盖** → 用生产常量（`account-limiter.ts:135-137`） |
| 18 | `queueWaitJitterMs=2000` + `queueWaitPaddingMs=1000` 计算是否正确 | ✅ 正常 | `default-transport.ts:65`、`:66`、`:1246-1258`；`:1256 jitterMs ∈ [0,1999]`、`:1257 base + 1000 + jitter`。实测 20 万次采样：额外量 `∈ [1000, 2998]`，均值 1998.51 → 即「1–3 秒」而非「1–2 秒」，与 UI 文案一致 |
| 19 | 上限 `queueWaitCeilingMs = 5*60_000` 是否生效 | ✅ 正常 | `default-transport.ts:54`；base 侧 `:1254-1255` 各自 `Math.min(..., ceiling)`；最终 `:1257 Math.min(base + padding + jitter, queueWaitCeilingMs)` 再夹一次 → padding/jitter 无法把总等待顶过 5 分钟。`tests/transport-queue-budget.spec.ts:238` 有专门用例守护 |
| 20 | 抖动参数的配置入口 | ⚠️ 部分生效 | 可调：`queueWaitAttempts`（0–10，默认 0）/`queueWaitSeconds`（1–300，默认 30）——`src/index.ts:294`/`:296`、`:457-467` 字段、`:1104-1107` 注入、`:1486-1487` 默认、`:1611-1616` 校验；UI `src/client/QoderPluginCard.tsx:2497-2529`；文案 `src/client/locales.ts:277`(en)/`:577`(zh)。**不可调**：400ms 间隔、100ms 抖动、30s acquire 超时、2000ms queue jitter、1000ms padding、5 分钟上限——在 `src/index.ts`、`src/settings-store.ts`、`src/client/*` 中**无字段、无 UI、无文案承诺** |
| 21 | 「承诺了但没生效」的文案核对 | ✅ 无此问题 | UI 唯一与抖动相关的承诺是 `queueWaitSecondsHint`（`locales.ts:277/577`）：「实际再加 1–3 秒随机抖动，总等待不超过 5 分钟」→ 与 `default-transport.ts:1257` 实现一致。其余抖动参数**未在 UI 承诺可调**，因此「写死」属于未承诺项，不构成失约；但它与 queueWait 可调形成不对称，用户无法降低账号级节流强度 |
| 22 | 测试覆盖与实跑 | ✅ 正常（含缺口） | 实跑 3 个 spec：21/21 通过，exit 0。另跑 2 组：18/18、23/23 通过。缺口见「风险」R9/R10 |

---

## 二、实测证据

### 2.1 指定命令实跑（两次，结论一致）

```
node -r ./tests/sandbox-shim.cjs ./node_modules/vitest/vitest.mjs run \
  tests/transport-account-limiter.spec.ts tests/transport-queue-wait.spec.ts tests/risk-identity.spec.ts
```

| 文件 | 用例数 | 耗时 | 结果 |
|---|---|---|---|
| `tests/risk-identity.spec.ts` | 7 | 104ms | ✅ 全过 |
| `tests/transport-account-limiter.spec.ts` | 6 | 2598ms | ✅ 全过（含「spaces starts by at least the gap」「paces three concurrent requests … >=400ms apart」「releases the account slot when a request fails」） |
| `tests/transport-queue-wait.spec.ts` | 8 | 10909ms | ✅ 全过（含「prefers the upstream's own window over the configured fallback」「keeps a zero-second advice from turning into a busy retry loop」） |
| **合计** | **21** | **11.97s** | **Test Files 3 passed / Tests 21 passed / exit code 0** |

### 2.2 补充实跑

| 命令 | 结果 |
|---|---|
| `node -r ./tests/sandbox-shim.cjs --test --test-isolation=none --experimental-strip-types tests/qoder/device-identity.test.ts tests/qoder/cosy.test.ts tests/qoder/auth.test.ts` | **18 tests / 18 pass / 0 fail**，381.8ms。含「gives two accounts on this host different device identities」「buildAuthHeaders emits the per-account hostname only where the client does」 |
| `node -r ./tests/sandbox-shim.cjs ./node_modules/vitest/vitest.mjs run tests/checkin.spec.ts` | **23 tests / 23 pass**，127ms。含「sends the client machine identity with the campaign request」「reports a missing client instead of claiming the account has no campaign」「keeps the China region working without any client identity」 |

### 2.3 本机 runtime-info.exe 是否存在 → **存在，且可执行**

| 路径 | 大小 | mtime |
|---|---|---|
| `D:\Program Files\Qoder\resources\umid\runtime-info.exe` | 480,752 | Sep 26 10:06 |
| `D:\Program Files\Qoder CN\resources\umid\runtime-info.exe` | 480,752 | Oct 21 15:48 |

`installRoots` 的其余四项在本机**均不存在**：`%LOCALAPPDATA%\Programs\Qoder`、`%LOCALAPPDATA%\Programs\Qoder CN`、`C:\Program Files\Qoder`、`C:\Program Files\Qoder CN` —— 本机身份完全依赖 `risk-identity.ts:83-84` 硬编码的 D 盘两项。

直接执行（只读探测，未落任何文件），env=`3`（global），stdin `{"account":"audit-probe"}`：

```json
{"machineToken":"P1gAUOBYEfSnhf8oQhEeWMaLqsARyRkOXhiN8kL2WQbl4tx411qnAFKElyRqlBwwXlwxIxs4vZpjScljwARtXLVj",
 "machineType":"4e89870e14e8b5f340","machineCode":"f6756d6e763e0cfc85",
 "vmInfo":{"isVm":true,"brand":"Hyper-V","percentage":77,"vmTypeCode":14},"accountOutcome":"success"}
```

两个重要事实：

1. **该 helper 的机器身份与 account 无关**：`{"account":"audit-probe"}` 与 `{"account":"audit-probe-2"}` 两次调用返回的 machineToken/machineType/machineCode **完全相同**。这与 `risk-identity.ts:133-136` 注释「It is the account that is being fingerprinted」不符——实际是**主机级**身份。
2. **env 参数确实改变身份**：env=`0`（china）返回 `machineToken: P1gAKMvCPtNFz0FNQBczsdd1ZcFCQ2yo2duJWsTq5y0hRjC7kJvGJ9b6VAV5SByuRQGcUcMdRf0073JDE9PWmEpv` / `machineType: a6a92cee14ef07133e` / `machineCode: a12cce30763e760062`，与 env=3 不同 → `riskEnvForRegion` 映射生效。
3. **本机是 Hyper-V 虚拟机**（`isVm:true, percentage:77, vmTypeCode:14`），且 helper 主动上报该事实。

### 2.4 本机 machine-id 落盘状态（4 个不同值）

| 文件 | 内容 | mtime |
|---|---|---|
| `~/.qoder/.auth/machine_id`（Qoder 客户端自己写的真机 UMID） | `7f8262e2-5468-46c5-9609-d41ecff7b035` | Sep 28 15:19 |
| `~/.dsh/.dsh-qoder-plugin/state/.qoder-machine-id` | `8673b2a6-2e9a-4a3e-8a38-20620680ce91` | Oct 2 02:46 |
| `~/.dsh/profiles/desktop/.dsh-qoder-plugin/state/.qoder-machine-id` | `58e03c0d-a135-41b1-a5c9-dd2722240a2e` | Oct 1 16:26 |
| `~/.dsh/profiles/web/.dsh-qoder-plugin/state/.qoder-machine-id` | `4ac5f6e6-030f-40e4-8605-4cdffae2f064` | Sep 27 18:16 |

`~/.dsh/qoder/machine_id`（`machine-id.ts:6-11` 的第二个默认路径）**不存在**——生产接线不读它。

### 2.5 抖动分布实测（按源码公式复刻采样，20 万次）

```
gapMs            = 400 + floor(clamp(random()) * 100)   → 观测 [400, 499]，均值 449.49
queue extra      = 1000 + floor(clamp(random()) * 2000) → 观测 [1000, 2998]，均值 1998.51
ceiling clamp    base=299000 + 2998 → 300000（被 5 分钟上限截断）
```

结论：账号间隔抖动严格落在 `[400, 500)`，queue 等待额外量严格落在 `[1000, 3000)`，上限生效。**但仓库内所有相关测试都用 `random: () => 0` 把抖动钉在下限**（`tests/transport-account-limiter.spec.ts:127/161/184/211`、`tests/transport-queue-wait.spec.ts:253/276/369`），从未断言分布形状或上界——随机性本身无测试守护（见 R9）。

---

## 三、可疑点 / 风险（按严重度排序）

### R1（高）plan / quota 请求丢失设备身份，与三处文字承诺矛盾

- 机制：`account-reader.ts:312-316` 三个元数据请求并发发出，只有 status 那一路把 `creds.machineID` 传给了 `openApiJsonRequest`（`:315`）；`request.ts:218-221` 只有收到 `options.machineId` 才写 `Cosy-MachineToken` + `Cosy-MachineType: 'host'`。于是同一批请求里 status 自称「host 设备」而 plan/quota 完全不带机器头。
- 影响：若上游按「有无机器身份」给配额/套餐响应打不同分支（campaign 端点已被实测证明会这么做：带身份才回真实列表，不带回 200+空数组），plan/quota 可能拿到降级或异常数据；且同一账号在同一时刻对上游呈现三种身份状态（chat=派生 per-account、status=profile 级 host、plan/quota=无）。
- 为什么没被发现：`tests/qoder/usage.test.ts:305-317` 断言了 `statusHeaders['Cosy-MachineToken'] === 'umid-fingerprint-test'` 与 `Cosy-MachineType === 'host'`，也断言了 plan 的 user-agent/cosy-clienttype，**但从未断言 plan/quota 有没有 machineToken** → 缺陷无测试守护，且注释与实现相反使得读代码的人会先信注释。
- 证据：`src/qoder/transport/account-reader.ts:343-352`、`:365-374`；`src/qoder/transport/wire/cosy.ts:177-180`；`src/qoder/transport/auth.ts:211-214`；`docs/tasks/rot-guard.md:163`；`tests/qoder/usage.test.ts:309-317`。

### R2（高）插件自称的 host UMID 与真实 Qoder 客户端不同源，且按 profile 分裂

- 机制：`index.ts:905` 用单元素数组 `[qoderMachineIdPath()]` 调 `getMachineId`，把 `machine-id.ts:6-11` 的默认候选链（含真实客户端 `~/.qoder/.auth/machine_id`）**整体短路**。于是插件在 profile 级私有目录里自铸一个 UUID 并永久使用。
- 影响：(a) status 请求携带的「host UMID」并不是装了 Qoder 客户端的那台机器的真实 UMID；(b) 同一台机器、同一个账号，在 desktop profile 与 web profile 下呈现**两个不同的 host UMID**；(c) 上游若把 status 的 UMID 与 risk-identity 输出（真机 machineCode/Token）或与 Qoder 客户端自身行为的 UMID 做交叉，会看到三个互不相干的值。
- 证据：`src/index.ts:905`；`src/paths.ts:151`、`:138-140`、`:126-131`；`src/qoder/transport/machine-id.ts:6-11`；本机四个不同值的实测（2.4 节）。`machine-id.ts` 的注释「Read Qoder's machine id or create the DSH-owned fallback」描述的意图（优先复用客户端 id）在生产接线下并不成立。

### R3（中）campaign 与 chat 是两套语义不同的机器身份，且 campaign 身份实为主机级

- 机制：chat/model-list 用 `device-identity.ts` 的 **per-account MD5 派生**；campaign 用 `risk-identity.ts` 从客户端 helper 取 **主机级** 真机身份。这是 T3/T4 的显式设计（`rot-guard.md:76-77`、`:163`），但两侧身份**无法互相对应**：同一账号在 chat 里是 `5ec90ffc-…`，在 campaign 里是 `f6756d6e763e0cfc85`，而上游可能正是靠「同一账号的设备一致性」做风控。
- 附加事实：helper 输出与 account 无关（2.3 节实测），因此「按账号区分」在 campaign 侧**完全不成立**——一个账号池里所有账号签到都用同一个真机身份。这与 `risk-identity.ts:133-136` 注释冲突，需确认是设计还是 helper 行为超出注释预期。
- 证据：`src/qoder/transport/checkin.ts:120-126`、`:196-210`；`src/qoder/transport/device-identity.ts:43-53`；`src/qoder/transport/risk-identity.ts:133-136`。

### R4（中）china 区签到失败静默：把「没有客户端」伪装成「今天没有活动」

- 机制：`checkin.ts:274` 的 `no-client` 判定带 `&& this.region === 'global'`。china 区 identity 为 undefined 时继续走 `:284 fetchCampaigns`；campaign 端点对无身份请求回 HTTP 200 + 空 `campaigns`，于是 `:287-294` 落到 `status:'no-campaign'`，message「No claimable benefit campaign found for this region」。
- 影响：china 用户机器上没有 Qoder 客户端（或 installRoots 没命中）时，UI 会长期显示「今天没有可领活动」，用户不会去装客户端，问题永远自愈不了。global 区则能正确报 `no-client`（有 `tests/checkin.spec.ts` 用例守护）。
- 证据：`src/qoder/transport/checkin.ts:273-294`；对比 global 分支 `:274-283`。

### R5（中）installRoots 硬编码盘符，D 盘以外的安装拿不到身份

- 机制：`risk-identity.ts:78-85` 的 win32 候选是写死的 6 条：`%LOCALAPPDATA%\Programs\Qoder{ CN}`、`C:\Program Files\Qoder{ CN}`、`D:\Program Files\Qoder{ CN}`。本机**只有** D 盘两项命中，E:/F: 盘或自定义安装目录一律不识别。
- 影响：这些用户 global 区签到直接 `no-client`（可解释），china 区则落到 R4 的静默路径。
- 副作用（正面）：`.qoder-versions/<ver>/resources` 优先于顶层 `resources`（`:103-115`），已考虑 0.3+ 启动器的版本目录布局；本机三个版本目录的 helper 都存在。
- 证据：`src/qoder/transport/risk-identity.ts:75-91`、`:103-128`。

### R6（中）本机被 helper 自报为 Hyper-V 虚拟机

- 事实：`vmInfo.isVm=true, percentage=77, vmTypeCode=14, brand=Hyper-V`，随每次 campaign 请求的 helper 输出产生（插件只取 machineToken/Code/Type 三个字段，vmInfo 被丢弃，但**helper 是否另有上报通道不由本仓库控制**）。
- 影响：如果上游以 VM 标识做风控分级，账号池在多账号高并发下的暴露面比预期大。这是环境风险，不是代码缺陷，但它会放大 R2/R3 的不一致后果。
- 证据：2.3 节实测输出；插件侧未消费 `vmInfo`（`risk-identity.ts:174-181` 只 `pick` 三个 key）。

### R7（低-中）`cosy.ts:182` 的 `|| getMachineId()` 兜底可能把真实客户端 UMID 泄到 chat 请求

- 机制：`const machineID = creds.derivedMachineID || creds.machineID || getMachineId()`。第三级兜底走的是**默认路径链**（含 `~/.qoder/.auth/machine_id`，即真实客户端 UMID）。
- 影响：正常路径下 `auth.ts:231-236` 保证 `derivedMachineID` 一定存在，所以兜底不可达；但一旦将来 creds 构造路径变更（如新增无 userID 的凭据来源、或 `machine-id.ts` 被改成返回空串），chat 请求会直接泄露真实主机 UMID，**恰好与 T3 的隐私意图相反**（T3 的目的是让 chat 不再暴露共享 host id）。这是一个「静默失败方向错误」的兜底。
- 证据：`src/qoder/transport/wire/cosy.ts:182`、`:11`（`import { getMachineId }`）；`src/qoder/transport/auth.ts:225-237`。

### R8（低）machine-id 落盘退化的三重失败路径无测试、无日志

- 机制：`machine-id.ts:25-41` 三级——(1) `writeFileSync(flag:'wx')` 失败 → (2) 重读 savePath → (3) 仍失败则返回未落盘的 `crypto.randomUUID()`。第 (3) 步完全静默，无 warn、无标记。
- 影响：容器/只读挂载/权限受限场景下，每次进程启动 host UMID 都变，且从日志看不出发生过退化；上游侧表现为「这台机器每小时换一次设备」。
- 为什么风险有限：`wx` 失败的最常见原因是目录权限，此时第 (2) 步重读通常也失败，但只要文件**曾**成功写入过就不会退化；本机已稳定落盘 3 个 profile。
- 未覆盖：`tests/qoder/cosy.test.ts:13-18` 只测「同路径两次取值相同」，`tests/qoder/device-identity.test.ts:44-50` 只测派生 id ≠ host id；**无任何用例覆盖 wx 失败/重读/临时值三条退化分支**。
- 证据：`src/qoder/transport/machine-id.ts:25-41`。

### R9（低）抖动测试全部把 `random` 钉死，随机性本身无守护

- 机制：所有 limiter/queue-wait 用例都传 `random: () => 0`（`tests/transport-account-limiter.spec.ts:127/161/184/211`、`tests/transport-queue-wait.spec.ts:253/276/369`），只验证「抖动取下限时恰好等于常量」，从未断言抖动上界、分布或 `clampRandom` 的越界钳制。
- 影响：若有人把 `Math.floor(...*jitterMs)` 写成 `Math.round(...)`、把 `0.999` 改成 `1.0`、或把 `+` 写成 `-`，现有测试**全部仍会通过**。本次审计用 20 万次采样手工补验（2.5 节），但仓库内无回归保护。
- 证据：同上；`account-limiter.ts:264-267`（`clampRandom` 本身无直接单测）。

### R10（低）六个抖动常量不可配置，与 queueWait 可调不对称

- 事实：`accountMinStartGapMs=400`、`accountStartGapJitterMs=100`、`accountAcquireTimeoutMs=30_000`、`queueWaitJitterMs=2_000`、`queueWaitPaddingMs=1_000`、`queueWaitCeilingMs=5*60_000` 在 `src/index.ts`、`src/settings-store.ts`、`src/client/*` 中**均无入口**。UI 只暴露 `queueWaitAttempts`/`queueWaitSeconds`。
- 判定：**不构成「承诺了但没生效」** —— locale 文案（`locales.ts:277/577`）只承诺了「1–3 秒抖动 + 总等待 ≤5 分钟」，该承诺已由 `default-transport.ts:1257` 实现。
- 保留意见：账号级 400ms 间隔在单账号、上游排队严重时无法被用户调低，且 fail-open 只有一条 warn（`default-transport.ts:334-342`）而没有计数指标，运维上无法判断「守卫正在频繁放行」。
- 证据：`src/qoder/transport/account-limiter.ts:28/37/46`、`src/qoder/transport/default-transport.ts:54/65/66`、`src/index.ts:294/296/457-467/1104-1107/1611-1616`。

### R11（低）`Cosy-Machinetype` 与 `Cosy-MachineType` 两套语义混用

- 机制：COSY 请求固定发 `Cosy-Machinetype: '5'`（`wire/cosy.ts:43`、`:192`，客户端类型魔法值）；元数据请求发 `Cosy-MachineType: 'host'`（`request.ts:220`，主机标记）。两者只差大小写（HTTP header 名不区分大小写），但值语义完全不同，同一套代码里出现两种「machine type」。
- 影响：维护风险 —— 排障时容易把两者当成同一字段的两种取值；若将来有人「统一」它们，会同时破坏两条链路（COSY 签名头和 host 标记）。
- 证据：`src/qoder/transport/wire/cosy.ts:21/43/192`；`src/qoder/transport/request.ts:218-221`。

### R12（信息）文档与测试计数漂移

- `docs/tasks/rot-guard.md:163` 声称「status/plan/quota/campaign 仍真机 UMID」，与实现不符（plan/quota 无 machineToken，见 R1）。
- `docs/tasks/rot-guard.md:170` 记录「tests/transport-account-limiter.spec.ts 5」，实际 6 个用例。
- `docs/tasks/rot-guard.md:163` 记录 T3「仅 chat/infer 使用派生 id」，与实现基本一致（model list 也用派生 id，但这是 `buildAuthHeaders` 统一行为，非缺陷）。

---

## 四、总体结论

- **per-account 派生指纹本身（device-identity.ts + auth.ts + cosy.ts）实现正确、确定、按账号区分，且 chat/inference 是唯一携带 hostname 的请求 —— 这三层 ✅。**
- **「指纹是否完整生效」的答案是：不完整。** 元数据族的 plan/quota 两个请求完全没有设备身份头（R1），status 的 UMID 又不是真实客户端的 UMID（R2），campaign 用的是另一套主机级身份（R3）——上游在同一时刻能从同一账号看到三种不同的设备画像。
- **随机抖动全部按设计工作**：账号间隔抖动严格 `[400,499]ms`、fail-open 有 logger.warn 留痕、queue 额外等待严格 `[1000,2998)ms` 且 5 分钟上限确实生效、UI 承诺的「1–3 秒抖动 + ≤5 分钟」与实现一致。**唯一的缺口是这些参数全部写死、抖动随机性本身无测试守护（R9/R10）。**

最值得先处理的三件事：R1（补 plan/quota 的 machineToken 并加断言）、R2（决定 host UMID 要不要复用真实客户端 id）、R4（china 区签到失败不要静默）。
