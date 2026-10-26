# 规范：原生设备身份（UMID）— 国际版签到摆脱桌面客户端依赖

| | |
|---|---|
| 文档编号 | SPEC-UMID-003（修订 R2，已并入审查意见） |
| 状态 | **规范（已决议，可据此实施）** |
| 取代 | `docs/plan-native-device-identity.md`（v1 提案，已废弃）、`docs/spec-native-device-identity.md` 旧修订 R1 |
| 审查依据 | `docs/review-native-device-identity.md`（183 行，逐条已核对源码，**全部成立**） |
| 目标版本 | v1.0.5 → **v1.1.0** |
| 参考实现 | `E:\Workspace\zcode\agent2apisum\qoder2api-hub`（MIT） |
| 代码状态 | **尚未改动任何代码**；本文件是唯一实施依据 |

约定：**必须**（MUST）/ **禁止**（MUST NOT）/ **应当**（SHOULD）为规范性用语，可直接转成断言；`I-xx` 不变量，`T-xx-y` 测试用例，`M0–M4` 里程碑，`Rxx` 决议。

---

## 0. 审查意见处理总表

审查提出的每一条都**成立**（已逐条回源码核对）。下表是处理结果；"采纳"指按审查意见改，不是折中。

| 审查条目 | 处理 | 落点 |
|---|---|---|
| §1.1「三头最危险」是把单调证据用成非单调结论；3 头这一档从未被测 | **采纳**。删除该断言，降级为「证据只支持：六头全派生=被过滤；单头/缺头=可见；对 3 头无断言」 | §3 R1、§2 事实基线 |
| §1.2 插件根本没有「发三个派生头」这条路径 | **采纳**。D7 不再表述为「规则」，只保留真正的二元不变量 | §4 I-01/I-02 |
| §1.3 装上客户端时插件今天就在发 3 个**原生**头，且这是 0.3.0 以来线上工作形态 | **采纳**。改判：默认维持 3 原生头；六头降为实验分支；A/B 判据改为**非劣性** | §3 R1、§7 M4 |
| §1.4-a 参考实现六头是混合的（machineid 派生 / hostname 真实 / machineos 常量 / token·type·code 原生） | **采纳**。`six` 模式复刻该**组合**，不造「3 原生 + 3 派生」的自创组合 | §3 R1、§6.7 |
| §1.4-b 参考实现逐字段兜底，插件要求三者齐全（插件更严） | **采纳**为已知行为差异，不修改解析器（更严是安全的） | §2 事实基线 |
| §1.4-c 加 `cosy-machinehostname` 会反转既有锁 `tests/checkin.spec.ts:693-698` | **采纳**。M4 必须显式改写该断言并写明理由 | §7 M4、T-M4-4 |
| §1.4-d 插件指纹是 `qoder/1.1.47` + `1.0.1`，与参考实现 `Qoder` + `0.4.8` 不同，测的是新组合 | **采纳**。验收口径加限定，不声称「逐字复刻已验证请求」 | §3 R1、§7 M4 清单 |
| §2 Q3 不是二选一；正确落点是「只改 campaign，取 `win32`」 | **采纳**。campaign 用桌面端词汇 `x86_64_win32`；推理链路**一个字不改** | §3 R3、§6.7 |
| §3 Q4 默认应真实 hostname（唯一被验证过的形状） | **采纳**。默认真实 hostname；派生值降为隐私开关 `QODER_CAMPAIGN_DERIVED_HOSTNAME=1`，README 注明未验证 | §3 R4 |
| §4.1 卡片不会 fetch 新路由，漏了 `QuotaSettingsScope` 与 `http-settings-scope.ts`，会**静默不渲染** | **采纳**。卡片改走 `scope.installUmid()`，两处文件列入交付物 | §3 R10、§7 M2 |
| §4.2 缺 key 轮换愈合；且头名是 `x-qoder-settings-key`、值是 `controlKeys().probe` | **采纳**。`installUmid()` 复用 stale-key 重读重试；注册必须照 `index.ts:2607` 同法 | §5.7、§7 M2 |
| §4.3 删掉新路由文件与 route 测试，共用 handler | **采纳（有一处必要偏离，见 §12）**：不新增路由文件、不新增安全面测试，守卫抽成共享工厂 | §3 R11、§5.8 |
| §4.4-1 `.staging` 残留清理 | **采纳** | §6.1 步骤 0、T-M1-9 |
| §4.4-2 `QoderWebStatus` 三个 arm 都要加 `umid` 字段 | **采纳** | §5.6、T-M2-6 |
| §4.4-3 `alreadyRunning` 应触发轮询而非报错 | **采纳** | §5.9、T-M2-7 |
| §5-a D5 文案升级被 `reasonCode==='no-client'` 短路，卡片看不到 | **采纳**。新增 `no-native-component` + locale key，并用 status 字段驱动按钮 | §3 R12、§9 |
| §5-b D6 漏自愈（force→清种子→重采） | **部分采纳**：能力实现，但默认**关**（`QODER_UMID_SELF_HEAL=1` 开启），理由见 R8 | §3 R8 |
| §5-c 磁盘 TTL 到期 = 换种子（参考实现语义） | **不采纳该语义**，只写清差异：我们的 TTL 到期只重采样，不清种子 | §3 R9 |
| §5-d 组件不可用时回退过期缓存（与 D5 硬失败冲突） | **采纳**，并据此重排解析顺序，冲突消解 | §3 R7、§6.6 |
| §5-e P0 的 4 条测试只能跑在 Windows（`runtimeInfoName` 是模块级 const、`installRoots` 直读 `process.env`） | **采纳**。M0 第一步就是可注入化，否则测试写不出来 | §7 M0 |
| §5-f P1 规模偏乐观，约 500 行 | **采纳**。排期按 4–5 天 | §7 工期 |

---

## 1. 目标与验收总则

### 1.1 目标（Definition of Done）

1. 未安装 Qoder 桌面客户端的机器上，仅通过 `dsh-qoder-plugin umid install`（或卡片按钮）即可完成国际版每日签到领取。
2. 客户端安装在非默认目录时，插件能正确发现并使用它（现状误判为「没装」）。
3. **零新增运行时依赖**；不内嵌、不再分发官方二进制。
4. 已装客户端用户的行为**零变化**（含推理链路全部请求头，见 I-11）。
5. `pnpm run check` 全绿。

### 1.2 非目标（禁止）

- **禁止**伪造多台设备身份绕开「同人每轮只领一次」。
- **禁止**在签到/推理请求路径中隐式下载组件。
- **禁止**默认删除 `~/.config/.locale_cfg`。
- **禁止**内嵌/再分发官方二进制。
- **禁止**修改活动族 wire 常量（I-09）。
- **禁止**为 campaign 端点改动推理链路的 `cosy-machineos`（会让所有既有账号指纹漂移）。

---

## 2. 事实基线（已逐条核对，勿再争论）

**插件侧**

- `src/qoder/transport/risk-identity.ts:118` 只在客户端安装目录找组件，找不到 → `undefined`。
- 同文件 `:75` `installRoots` 硬编码 6 条路径，且 `:77` 直读 `process.env['LOCALAPPDATA']`；`:66` `runtimeInfoName` 是**模块级 const**，由真实 `process.platform` 决定 → **当前不可注入，P0 测试在非 Windows 上跑不了**。
- `:157` spawn 未设 `cwd`。
- 解析器要求 token/type/code **三者齐全**（比参考实现逐字段兜底更严）。
- `src/qoder/transport/checkin.ts:119-126` `riskHeaders()` 只从**真身份**取值，`undefined` 时返回 `{}` —— **不存在「派生值兜底」分支**。
- `checkin.ts:274` 国际版无身份 → `status:'error'`、`reasonCode:'no-client'`。
- `src/client/QoderPluginCard.tsx:1396-1397` 按 code 本地化并**忽略 `reason`**：`reasonCode === 'no-client' ? t('checkInNeedsClient') : ...` → 改 transport 文案用户看不到。
- `src/client/QoderPluginCard.tsx:1429-1440` 重置按钮走 **scope 方法** `active.resetDeviceCodes()`；声明在 `QuotaSettingsCard.tsx:70`；实现在 `http-settings-scope.ts:295-301`（`:284-292` 注释写明 stale-key 需「重读一次再重试一次」）；`sendReset` 在 `:304-321` POST `${ROUTE_BASE}/device-reset`（`ROUTE_BASE = '/plugins/dsh-qoder-plugin'`，`:25`），头 `X-Qoder-Settings-Key`。
- 卡片渲染守卫为 `scope?.xxx === undefined ? null : ...` → scope 方法缺失时**静默不渲染**。
- `src/index.ts:2607` 用 `controlKeys().probe` 注册 device-reset 路由；`src/device-reset-route.ts:129` 校验的头名是 `x-qoder-settings-key`（**头名 settings-key、值 probe key**）。
- `src/status-paths.ts:428-554` `QoderWebStatus` 是**三个互不共享字段的 arm**：`signed-in` / `signed-out` / `error`。
- `tests/checkin.spec.ts:693-698` 断言 campaign 请求**不得**出现 `cosy-machineid` / `cosy-machinehostname`（小写与大写两种拼写都断言）。
- `src/qoder/transport/wire/cosy.ts:36-42` `qoderMachineOs` = `x86_64_windows` / `aarch64_windows` / `x86_64_linux` / `aarch64_linux`（Go 风格词汇，**未导出**，源码无依据注释）；`:74-76` 注释只说明 COSY metadata/status 家族不带 hostname，**未对 campaign 端点表态**。
- `src/qoder/transport/wire/version.ts:68,74` `campaignUserAgent = 'qoder/1.1.47'`、`campaignCosyVersion = '1.0.1'`，rot-guard T3 冻结，不可环境变量覆盖。
- `CHANGELOG.md:555-562`（0.3.0）：国际版只对有桌面客户端的机器下发每日 100 Credits；插件从已装客户端取三头并在 campaign + claim 上发送 → **3 原生头是线上工作形态**。

**参考实现侧**

- `qoder_accounts.py:1958-1966` 逐头隔离实测：六头全派生 → `CLAIMABLE` 被整条过滤；任一头单独出现 → 可见；缺 `machinetoken` 或 `machineid` → 可见。**没有测过 3 头这一档**。
- `CHANGELOG.md:1107`：「真机器头是否额外解锁设备定向活动**未验证**」。
- `qoder_accounts.py:1980-1989` 原生六头是**混合**的：`machineid = derive_id(uid,"machine")`（派生）、`machinehostname` 真实、`machineos` 常量、`token/type/code` 来自组件。
- `:1971-1974` 其请求指纹为 `User-Agent: Qoder` + `cosy-version: 0.4.8` + `cosy-clienttype: 10`。
- `qoder_sign.py:544-555` `_detect_machine_os()` docstring 是仓库里**唯一**对官方词汇的断言：`{arch}_{platform}`，platform ∈ `win32` / `darwin` / `linux`，共 6 种。
- `qoder_sign.py:558-567` `_resolve_machine_os()` 默认 `x86_64_win32` 是**为防指纹漂移冻结的历史值**（macOS 上返回 `x86_64_linux`，显然非官方值）→ 不能据此推断官方取值。
- `qoder_sign.py:537-541` 派生的 `DESKTOP-1A2B3C4` 是**推理链路**在用；`qoder_accounts.py:160` campaign 用**真实** hostname，`tests/_test_risk_identity.py:105,110` 专门断言。
- 组件身份是机器级：不同 `--account-stdin`、不同 `HOME` 的 `machineToken` 逐字节相同。
- 抖动：`machineToken` 恒定，`machineType`/`machineCode`/`vmInfo`(brand/vmTypeCode) 在 `KVM/13` ↔ `Docker/50` 间抖（报告 1.56%，本机复现 10.29%）。

---

## 3. 决议表

### R1 活动族机器头：默认 3 原生头，六头是**实验分支**

- **不变量**（真正的规则，当前代码已满足）：无真身份 → 0 个机器头；有真身份 → **至少**发原有 3 个原生头（`cosy-machinetoken` / `cosy-machinecode` / `cosy-machinetype`）。
- 六头**不写成规则**，写成开关：`QODER_CAMPAIGN_MACHINE_HEADERS=six`，**默认 `three`**。
- `six` 模式的组合**必须**复刻参考实现的混合形态：`machineid` = `deriveMachineId(uid)`（派生）、`machinehostname` = 真实 hostname（见 R4）、`machineos` = 桌面端词汇常量（见 R3）、`token/type/code` = 组件原生值。**禁止**造「3 原生 + 3 派生」的自创组合。
- **A/B 判据 = 非劣性**：`six` 是否仍能看到 `three` 能看到**全部**活动（不是「是否多出 CLAIMABLE」）。理由：多解锁是收益，丢活动是事故，而 v1.2.1 记录的事故形态正是「列表只剩详情类活动 + 面板显示签到成功」的沉默失败。
- **禁止**在本文档或注释中声称「3 头比 6 头危险」：证据只覆盖 1 / 5 / 6 头三档，且方向单调（越少越安全）；3 头这一档从未被测。
- 验收口径限定：插件发的是 `qoder/1.1.47` + `1.0.1`，与参考实现的 `Qoder` + `0.4.8` 不同 → **测的是一个新组合**，不声称逐字复刻已验证请求。

### R2 无身份时不发请求

国际版在「组件不可用 **且** 无可用缓存」时：**不**发出 campaigns/claim 请求，返回 `status:'error'`。理由：服务端静默过滤，空头请求的结果无法区分「今天真没活动」与「被过滤」，无信息增量。

### R3 `cosy-machineos`：只改 campaign，取桌面端词汇

- 新增独立常量 `campaignMachineOs`（`src/qoder/transport/wire/cosy.ts`，与 `qoderMachineOs` 并存）：
  `{x86_64|aarch64}_{win32|darwin|linux}`，按 R1 依据取桌面端词汇；win32 x64 → `x86_64_win32`，darwin arm64 → `aarch64_darwin`，linux x64 → `x86_64_linux`。
- **推理链路的 `qoderMachineOs` 一个字不改、也不导出**（campaign 用新常量，无需动旧常量）→ 既有账号指纹零漂移。
- 依据：按「该请求在冒充哪个客户端」取值。campaign 声明桌面端（`cosy-clienttype: 10` + 桌面版 `cosy-version`）；推理链路声明 CLI（`cosy-clienttype: 5` + `qoder/1.1.75`）。同一台机器同时装 CLI 与桌面端完全正常，「跨端点相同」不等于「指纹自洽」。
- `QODER_COSY_MACHINE_OS` 可覆盖（`auto` = 按当前平台探测）。

### R4 `cosy-machinehostname`：默认**真实** hostname

- 默认 `headerSafeHostname(os.hostname())`（见 §6.8）。依据：唯一被验证可用的原生六头形状里 hostname 是真实的（参考实现 + 其测试断言）。
- 隐私敏感用户用**反向**开关 `QODER_CAMPAIGN_DERIVED_HOSTNAME=1` 降到派生值 `deriveMachineHostname(uid)`；README 已知限制**必须**写明「派生形态未经真机验证」。
- 注：`six` 模式下若选派生值，A/B 验收**必须**额外覆盖「派生 hostname 下活动仍可见」。

### R5 取消独立阶段

六头机制并入 M4，与开关一起落地，默认走三头；验证降级为发布前清单项。

### R6 一次做完 M0–M4，发布 v1.1.0

各里程碑独立可合并、可回滚。

### R7 身份解析顺序（消解「硬失败 vs 过期缓存」冲突）

按序尝试，命中即用：

1. 进程内记忆（30 分钟）；
2. 磁盘缓存且未过期；
3. 组件（`QODER_UMID_DIR` → 客户端安装目录 → `~/.dsh/qoder/umid`）；
4. **磁盘缓存已过期** → 仍然使用（标记 `stale: true`），并**异步**触发一次后台重采（不阻塞本次签到）；
5. 都没有 → `no-client` / `no-native-component` 失败（R12）。

依据：Defender 删掉二进制、或用户清理了 `~/.dsh` 时，手里明明有可用身份却退化成硬失败是明显的坏行为。

> **实施修正（M0/M3 落地时）**：本节初版把「组件」排在第 1 位，与 I-04（缓存命中禁止 spawn）直接矛盾——只要缓存有效就永远不该 spawn，所以组件只能排在两个缓存之后。已按实施结果改序，行为以本列表为准。
> 另有两条实测约束：`umid reset-native` 必须**同时**清磁盘缓存与进程内记忆（否则重置是空操作），且 in-flight 的后台重采在写回前要校验「期间没有发生过重置」，避免把旧身份写回去、把重置撤销。


### R8 上游拒绝后的自愈：能力实现，默认关闭

- 实现 `force` 语义：清 `~/.config/.locale_cfg` → 清身份缓存 → 重采。
- **默认不自动执行**；`QODER_UMID_SELF_HEAL=1` 才允许在「campaigns 返回 0 个 `CLAIMABLE` 且身份来源为组件」时自动 `force` 一次（每 realm 每 24h 至多一次）。
- 默认关闭的理由：清种子会**同时改变本机官方客户端的身份**且不可恢复，与「不得默认删除他人状态文件」的原则冲突；且自动换身份会让「今天真没活动」变成一次不可见的设备身份变更。
- 显式入口：`umid reset-native --yes`（CLI）+ 卡片提示（文案引导到 CLI）。

### R9 磁盘 TTL 语义：只重采样，不换种子

`QODER_UMID_IDENTITY_TTL` 到期 → 重新采样，**不清种子**。与参考实现（TTL 到期 = 换种子）**不同**，差异必须在 README 与 `umid status` 输出中写清。理由同 R8。

> **实施修正**：单位是**毫秒**（初版未写单位，参考实现用秒；落地时按毫秒实现并已写入 README，`0` = 永不过期）。


### R10 卡片调用链：必须走 scope 方法

- 在 `QuotaSettingsScope`（`src/client/QuotaSettingsCard.tsx:70` 附近）新增可选成员：
  `installUmid?: (() => Promise<QuotaUmidInstallResult>) | undefined`
- 在 `HttpSettingsScope`（`src/client/http-settings-scope.ts`）实现，**必须**复用 `resetDeviceCodes` 的 stale-key 范式（`:295-301`：`send → stale ? tryRead() → send 一次`）。
- 卡片**禁止**直接 `fetch` 安装端点；渲染守卫沿用 `scope?.installUmid === undefined ? null : ...`。
- 结果类型：`{ ok: boolean; started?: boolean; alreadyRunning?: boolean; jobId?: string; error?: string }`。

### R11 路由形态：不新增路由文件，守卫抽成共享工厂

- 在 `src/device-reset-route.ts` 内抽出 `registerGuardedActionRoute(ctx, { path, key, handler, effectLabel })`（现有守卫逻辑原样搬入：POST 校验、`hostIsLoopback`/`originIsLoopback`、`timingSafeEqual` key 比较、`MAX_BODY_BYTES=4*1024` 全量 drain、失败 `200 {ok:false}` + `safeMessage` 脱敏）。
- device-reset 与 umid-install **共用**该工厂；**禁止**复制第二套守卫。
- 因守卫只有一份，**不新增**安全面测试套（既有 `tests/device-reset-route.spec.ts` 覆盖守卫）；umid-install 只加「挂载成功 + 走同一守卫 + 单飞 + 后台 job 形状」的少量用例。
- 路径常量 `QODER_UMID_INSTALL_PATH` **必须**新增一行（见 §12 偏离说明）。

### R12 无组件时的可区分原因

| reasonCode | 含义 | 卡片文案键 |
|---|---|---|
| `no-client`（既有，语义不变） | 无组件且**无法**通过安装获得（不支持平台，或已尝试仍失败） | `checkInNeedsClient`（既有） |
| `no-native-component`（**新增**） | 无组件但**可安装**（平台受支持） | `checkInNeedsUmid`（新增） |

卡片同时用 status 的 `nativeDevice` 字段决定是否显示「安装组件」按钮（R10），文案只是次要信息。

### R13 P0 先做可注入化

- `runtimeInfoName` 由模块级 const 改为 `runtimeInfoName(platform: NodeJS.Platform)` 函数（保留同名导出以减小 diff，调用点加参数）。
- `installRoots(home, os, env)` 增加 `env` 参数（`LOCALAPPDATA` 从注入的 env 读，**禁止**直读 `process.env`）。
- `QoderRiskIdentityOptions` 增加 `readFileImpl?`、`existsImpl?`、`env?`、`hostnameImpl?`。

### R14 status 文档与轮询

- `QoderWebStatus` 的**两个服务端 arm**（`signed-in` / `signed-out`）都新增可选字段 `nativeDevice?: QoderNativeDeviceStatus`；`signed-in` / `signed-out` / `error` 三个 arm 的**类型**都带该可选字段。
- 卡片收到 `alreadyRunning` 后**必须**轮询 status（复用现有 refresh），**禁止**当失败提示。

> **实施修正**：初版写「三个 arm 都接线」，但 `qoderWebStatus` 服务端只产出 `signed-in` / `signed-out` 两个 arm，`status:'error'` 是客户端在 `QoderPluginCard.tsx:1188` 合成的，没有服务端数据可携带。故接线为 2 个臂，`status-paths.ts` 的类型保留 3 个臂的可选字段（客户端合成时不会凭空造值）。


---

## 4. 不变量

| ID | 不变量 |
|---|---|
| I-01 | `three` 模式下，campaign/claim 请求的 `cosy-machine*` 头**恰好** 3 个：`cosy-machinetoken`/`cosy-machinecode`/`cosy-machinetype`；**禁止**出现 `cosy-machineid`/`cosy-machineos`/`cosy-machinehostname` |
| I-02 | 无真身份且无可用缓存时，campaign/claim 请求 `cosy-machine*` 头数量为 **0**，且**不发出**请求 |
| I-03 | `six` 模式下 `cosy-machineid` **恒等于** `deriveMachineId(uid)`；头总数恰好 6 |
| I-04 | 身份来自有效缓存时**禁止** spawn 组件；TTL 内多次签到 spawn 次数 ≤ 1 |
| I-05 | 安装失败时组件目录内容**字节不变**（含「原本不存在」的情形） |
| I-06 | win32 下组件目录缺 `sgsdk.dll` 时**必须**视为未安装 |
| I-07 | `manifest.json` 与身份缓存权限 `0600`（POSIX） |
| I-08 | 二进制**禁止**入库、**禁止**进 npm 包 |
| I-09 | 活动族 wire 常量字节不变：`qoderDesktopClientType='10'`、`campaignUserAgent='qoder/1.1.47'`、`campaignCosyVersion='1.0.1'`、`fingerprint:'campaign'` |
| I-10 | 对外错误文案不含 token/uid 明文（`eyJ` JWT、`pt-` 前缀脱敏，截 500 字） |
| I-11 | 安装组件**不改变推理链路任何请求头**（`cosy-machineos` 仍为 `x86_64_windows`，`cosy-machineid`/`cosy-machinehostname` 仍为派生值） |
| I-12 | 组件目录与身份缓存均为 **host 级**（`~/.dsh/qoder/`），禁止写入 profile 目录 |
| I-13 | 组件不可用但存在**过期**缓存时，**必须**用缓存身份继续，**禁止**退化为 `no-client` |
| I-14 | `QODER_UMID_IDENTITY_TTL` 到期**禁止**清 `~/.config/.locale_cfg`；清种子只能由 `umid reset-native` 或 `QODER_UMID_SELF_HEAL=1` 触发 |

---

## 5. 接口规范

### 5.1 路径

| 用途 | 路径 | 级别 |
|---|---|---|
| 组件目录 | `<QODER_UMID_DIR> \|\| <home>/.dsh/qoder/umid` | host |
| 组件可执行 | `<组件目录>/runtime-info.exe`（win32）/ `runtime-info`（其它） | host |
| Windows 依赖 | `<组件目录>/sgsdk.dll`（必需） | host |
| 安装清单 | `<组件目录>/manifest.json` | host |
| staging | `<组件目录>/.staging-<random>/`（**必须**在安装开始与成功结束时清理残留） | host |
| 身份缓存 | `<home>/.dsh/qoder/machine-identity.json` | host |
| 插件派生种子 | `<home>/.dsh/qoder/device_seed`（既有，不动） | host |
| 原生身份种子 | `<home>/.config/.locale_cfg`（外部资产，只在 R8/`reset-native` 时删除） | host |

`QODER_UMID_DIR` 一旦设置 → **只用它，不回落**（便于测试与用户显式接管）。

### 5.2 环境变量

| 变量 | 默认 | 语义 |
|---|---|---|
| `QODER_UMID_DIR` | `~/.dsh/qoder/umid` | 组件目录覆盖（设置后不回落） |
| `QODER_UMID_TARBALL` | — | 离线 tgz 路径（等价 `--from-tarball`） |
| `QODER_UMID_REGISTRY` | `https://registry.npmjs.org` | registry 覆盖；**仅接受 `https:`** |
| `QODER_UMID_IDENTITY_CACHE` | `1` | `0` 关闭身份缓存 |
| `QODER_UMID_IDENTITY_TTL` | `0`（不过期） | 到期**重采样**，不清种子（R9） |
| `QODER_UMID_SELF_HEAL` | `0` | `1` 开启 R8 自动自愈（每 realm 每 24h ≤1 次） |
| `QODER_CAMPAIGN_MACHINE_HEADERS` | `three` | `three` \| `six`（R1） |
| `QODER_CAMPAIGN_DERIVED_HOSTNAME` | 未设 | `1` → campaign 用派生 hostname（R4） |
| `QODER_COSY_MACHINE_OS` | 平台推导 | 覆盖 `campaignMachineOs`；`auto` = 探测 |

### 5.3 新模块 `src/qoder/transport/umid-extract.ts`

```ts
export interface UmidSizeHints { fileMin: number; fileMax: number; dllMin: number }

export interface UmidInstallOptions {
  platform?: NodeJS.Platform
  arch?: string                        // 'x64' | 'arm64'
  destDir?: string
  registry?: string
  packageName?: string                 // 默认 '@qoder-ai/qodercli'
  version?: string                     // 默认 dist-tags.latest
  tarballPath?: string                 // 离线通道，优先于 registry
  force?: boolean
  fetchImpl?: typeof fetch
  spawnImpl?: SpawnLike                // 自检注入
  sizeHints?: UmidSizeHints
  signal?: AbortSignal
  logger?: { info(m: string): void; warn(m: string): void }
}

export interface UmidFileRecord { name: string; bytes: number; sha256: string }

export interface UmidInstallResult {
  ok: boolean
  skipped: boolean                     // 已安装且未 force
  version: string
  destDir: string
  files: UmidFileRecord[]
  source: UmidManifest['source']
  selfCheck: { ok: boolean; reason?: string; machineTokenSha256Prefix?: string }
  error?: string
}

export function umidDir(env?: NodeJS.ProcessEnv, home?: string): string
export function umidBinaryPath(platform?: NodeJS.Platform, dir?: string): string
export function umidInstalled(dir?: string, platform?: NodeJS.Platform): boolean
export function readUmidManifest(dir?: string): UmidManifest | undefined
export async function installUmid(options?: UmidInstallOptions): Promise<UmidInstallResult>
```

### 5.4 `manifest.json`（schema 1）

```json
{
  "schema": 1,
  "installedAt": "<ISO8601>",
  "platform": "win32",
  "arch": "x64",
  "source": {
    "kind": "registry | tarball",
    "package": "@qoder-ai/qodercli",
    "version": "1.1.75",
    "tarballSha512": "<base64>",
    "tarballBytes": 31000000,
    "entry": "package/bundle/qoder-worker-runtime.mjs",
    "blobIndexes": [7, 8]
  },
  "files": [{ "name": "runtime-info.exe", "bytes": 480752, "sha256": "<hex>" }],
  "selfCheck": { "ok": true, "at": "<ISO8601>", "machineTokenSha256Prefix": "<hex8>" }
}
```

**禁止**存 `machineToken` 明文，只存 sha256 前 8 位。

### 5.5 身份缓存 `machine-identity.json`（schema 1）

```json
{
  "schema": 1,
  "realm": {
    "global": {
      "machineToken": "...", "machineType": "KVM", "machineCode": "13",
      "vmInfo": { "isVm": true, "brand": "KVM", "vmTypeCode": 13, "percentage": 0.42 },
      "environment": "3", "source": "runtime-info",
      "cachedAt": 1790000000000,
      "votes": { "rounds": 3, "distribution": { "<keyHash>": 3 } }
    }
  }
}
```

`0600` + tmp + `rename`。损坏 JSON → 视为无缓存并删除。并发写保留磁盘既值（读-改-写，不抛错）。

### 5.6 status 文档扩展（三个 arm 都要）

```ts
export interface QoderNativeDeviceStatus {
  applicable: boolean        // 是否存在国际版 provider（R12 按钮显示条件）
  installed: boolean
  dir: string
  version?: string
  selfCheck?: { ok: boolean; at?: string; reason?: string }
  installing: boolean
  jobId?: string
  lastError?: string
  identity?: { cachedAt: number; stale: boolean; source: 'component' | 'cache' | 'cache-stale' }
}
```

`QoderWebStatus` 的 `signed-in` / `signed-out` / `error` 三处**都要**加 `nativeDevice?: QoderNativeDeviceStatus`。

### 5.7 scope 方法（R10）

- `src/client/QuotaSettingsCard.tsx`：`QuotaSettingsScope<T>` 增加 `installUmid?`；新增 `export interface QuotaUmidInstallResult { ok: boolean; started?: boolean; alreadyRunning?: boolean; jobId?: string; error?: string }`。
- `src/client/http-settings-scope.ts`：实现 `installUmid()`，`POST ${ROUTE_BASE}/umid-install`，头 `X-Qoder-Settings-Key`（值取自 `this.document?.key`），body `{"force":false}`；失败路径照 `sendReset`（`:304-329`）；stale-key 照 `resetDeviceCodes`（`:295-301`）重读重试一次。

### 5.8 路由（R11）

`POST /plugins/dsh-qoder-plugin/umid-install`

- 守卫由 `registerGuardedActionRoute` 统一提供（POST / loopback Host+Origin / settings key 定时安全比较 / 4KB body 全量 drain / 失败 `200 {ok:false,error}` 脱敏）。
- 注册方式**必须**照 `src/index.ts:2607`：`registerGuardedActionRoute(webCtx, { path, key: controlKeys().probe, handler }, ...)`。
- 请求体：`{ "force"?: boolean }`
- 响应：`{ok:true,started:true,jobId}` / `{ok:true,alreadyRunning:true,jobId}` / `{ok:false,error}`。
- **禁止**在请求内同步等待下载；安装作为后台 job，进程内**单飞**。

### 5.9 卡片行为（R14）

- `applicable && !installed` → 显示「安装原生设备组件」按钮。
- 点击 → `scope.installUmid()`；`alreadyRunning` → **轮询 status**（复用现有 refresh），**不**报错。
- 安装中显示进度态（`installing`）；失败显示 `lastError`（脱敏文案）。
- 不做文件选择器；离线 tgz 只在 CLI（卡片文案指过去）。

### 5.10 CLI（`src/bin.ts`）

| 命令 | 行为 |
|---|---|
| `umid install [--from-tarball <path>] [--version <v>] [--force] [--json]` | 安装 + 自检；打印版本/路径/自检结论 |
| `umid status [--json]` | 路径、是否安装、manifest、自检、身份缓存（含 `stale`、TTL 语义说明 R9） |
| `umid reset-native [--yes]` | 清 `~/.config/.locale_cfg` + 清身份缓存；**必须** `--yes`，否则只打印将执行的动作与影响 |

退出码 `0` / `1` / `2`（用法错误）。既有 action 语义不变。

### 5.11 组件发现（`risk-identity.ts`）

候选链顺序：`QODER_UMID_DIR`（设了就不回落）→ 客户端安装目录（M0 增强）→ `<home>/.dsh/qoder/umid`。win32 每级**必须**同时存在 `runtime-info.exe` 与 `sgsdk.dll`。spawn **必须**带 `cwd: dirname(exe)`。

---

## 6. 算法规范

### 6.1 安装管线

```
0. 清理 <destDir>/.staging-* 残留（启动即清，失败也清）
1. tarballPath / QODER_UMID_TARBALL 存在 → source.kind='tarball'，跳过 registry
2. 否则 fetchPackument(registry, packageName) → dist-tags.latest（或指定 version）
   → versions[v].dist.tarball + dist.integrity
3. umidInstalled() && !force → { ok:true, skipped:true }
4. 下载 tarball：流式，≤64MB，每请求 30s 超时，仅 https，最终响应 URL host 必须等于 registry host
5. 校验 sha512(dist.integrity)，不符立即中止，不写盘
6. gunzip 流 → 增量 tar 扫描，只保留 .mjs entry 字节（单 entry ≤64MB）
7. 扫长 base64 字面量 → 解码 → 魔数识别
8. 按 6.3 选候选
9. 写入 <destDir>/.staging-<random>/（0600/0755）
10. 自检（6.4）；失败 → 删 staging，返回 ok:false（I-05）
11. 原子提升：staging 内文件 rename 到 destDir；写 manifest.json（0600）
12. 清理 staging；返回 ok:true
```

**禁止**在 `destDir` 外解压；**禁止**把 31MB 全文读入内存（必须流式）。

### 6.2 tar / base64 / 魔数

tar（手写）：512 字节块；`magic` = `ustar\0`；`typeflag` 仅 `'0'` 与 `'\0'` 视为文件；`'x'`/`'g'`/`'L'` 跳过 payload；size 取偏移 124 的 12 字节八进制；内容按 512 向上取整；连续两个全零块结束。

base64：**手写单趟扫描，禁止用回溯正则**。`BLOB_MIN_LEN = 4000`。判定规则与 `/(['"])([A-Za-z0-9+/=]{4000,})\1/g` 等价：命中 `"`(0x22) 或 `'`(0x27) 后量取 base64 字符连续段，长度 ≥ `BLOB_MIN_LEN` 且紧随字符是**同一**引号才算候选；无论成败都把扫描位置推进到该段末尾（`index = end`），不得 `index += 1`。

> **实施修正（M1 真实包验证）**：上面那个正则写法在真实 `qoder-worker-runtime.mjs`（31,074,050 B，单条 base64 字面量以 MB 计）上抛出 `RangeError: Maximum call stack size exceeded`（栈在 `RegExpStringIterator.next`），**网络安装 100% 失败**。KB 级内存 fixture 永远触发不到这个量级，所以单元测试全绿而真实链路不可用。现行实现见 `src/qoder/transport/umid-extract.ts` 的 `scanUmidBlobs`：`Uint8Array(128)` 查表 + 段尾跳进，实测 8 MB 单字面量 93 ms、4 MB 全失败候选 20 ms、10 MB 引号错配 63 ms。回归测试要求见 T-M1-10..12。

魔数（**按内容判定，禁止按出现顺序猜测**）：

| 格式 | 判据 | 架构 |
|---|---|---|
| ELF | `\x7fELF`，`EI_CLASS=2`，`EI_DATA=1` | `e_machine`@18：`0x3E`=x86-64，`0xB7`=aarch64 |
| Mach-O | `\xcf\xfa\xed\xfe` | `cputype`@4：`0x01000007`=x86-64，`0x0100000C`=arm64 |
| PE | `MZ`，`e_lfanew`@0x3C → `PE\0\0` → machine@+4 | `0x8664`=x86-64，`0xAA64`=aarch64；`Characteristics`@+22 的 `0x2000` = DLL |
| WASM | `\0asm` | — |

### 6.3 候选选择

| 常量 | 默认 |
|---|---|
| `FILE_SIZE_MIN` | 400 × 1024 |
| `FILE_SIZE_MAX` | 2 × 1024 × 1024 |
| `DLL_SIZE_MIN` | 2 × 1024 × 1024 |
| `MAX_TARBALL_BYTES` | 64 × 1024 × 1024 |
| `BLOB_MIN_LEN` | 4000 |

- win32 + x64：**必须**选一对——exe = `pe-x86_64` 非 DLL 且体积在区间；dll = `pe-x86_64` 且含 `IMAGE_FILE_DLL` 且体积 ≥ `DLL_SIZE_MIN`。任一缺失 → `ok:false`，文案指向「上游包结构可能已变化」。
- darwin / linux：按 `arch` 选 `macho-*` / `elf-*`，体积在区间。
- win32 + arm64：`unsupported-platform`。
- 同槽位多候选：体积最小者；相同取 blob 序号最小（确定性）；全部记入 manifest 的 `blobIndexes`。
- 阈值**必须**可注入（测试用 KB 级样本）。

### 6.4 安装后自检

`cwd = staging`，执行 `<staging>/runtime-info <env>`，不传 `--account-stdin`，超时 25s；stdout 首行 `JSON.parse` **必须**含非空 `machineToken`。通过才允许提升。

> **实施修正（`<env>` 恒为 `'3'`）**：本节原先写「global `3` / china `0`」，但 `UmidInstallOptions` 没有 region 字段，实现也不应该加：组件目录与 manifest 都是 **host 级单份**，而一个 host 上可以同时存在国内版与国际版两个变体，让 manifest 的自检结论取决于「哪个变体先触发安装」是不可复现的状态。组件存在的理由就是服务国际版那件活动，所以自检固定用国际版 env `'3'`；区域差异由**采样时**的 `riskEnvForRegion`（`checkin.ts` → `resolveRiskIdentity`）承担，那才是真正按 realm 分流的地方（身份缓存也是按 realm 分条）。自检只证明「这个二进制能跑、能签出非空 token」，token 是机器级而非区域级（参考实现实测：换 account、换 HOME 均逐字节相同），所以 `'3'` 与 `'0'` 在自检目的上等价，选 `'3'` 是为可复现。

### 6.5 身份采样与表决

- 采样：`spawn(<exe>, [env, '--account-stdin'], { cwd: dirname(exe), stdio:['pipe','pipe','ignore'] })`（`--account-stdin` 仅 darwin/win32），stdin `{"account":"<uid>"}\n`；25s 超时；stdout > 1MB 或 JSON 缺任一必填字段 → 该轮无效。
- 表决：首轮 3 次；非全一致再补 2 次（**最多 5 次**）。表决键 = `machineToken|machineType|machineCode|vmInfo.isVm|vmInfo.brand|vmInfo.vmTypeCode`，**禁止**含 `vmInfo.percentage`。取严格多数；无多数取**首样本**。
- 内存缓存 30 分钟（按 realm 分键）；磁盘按 `QODER_UMID_IDENTITY_TTL`（默认不过期）。
- 缓存命中**禁止** spawn（I-04）。

### 6.6 解析顺序（R7）

`组件 → 未过期缓存 → 过期缓存（stale，异步重采） → 失败`。过期缓存命中时 status `identity.stale = true`，`source = 'cache-stale'`。

### 6.7 活动族头集合

| 模式 | 头集合 |
|---|---|
| 无身份（且无缓存） | `{}`，且不发请求（I-02） |
| `three`（默认） | `cosy-machinetoken`、`cosy-machinecode`、`cosy-machinetype` |
| `six` | 上述三头 + `cosy-machineid`=`deriveMachineId(uid)`、`cosy-machineos`=`campaignMachineOs`、`cosy-machinehostname`=真实 hostname（R4） |

`cosy-clienttype` / `cosy-version` / `User-Agent` / `fingerprint:'campaign'` **字节不变**（I-09）。

### 6.8 hostname 规整（`headerSafeHostname`）

1. 原值若已是合法 header 值（无控制字符、无前导/尾随空白、长度 ≤ 96）→ 直接用；
2. 否则尝试 IDNA（`new URL('http://' + name)` 的 `hostname`）；
3. 仍不合法 → `<slug>-<sha256(name)[:8]>`（`slug` = 小写、非 `[a-z0-9-]` 折成 `-`、去首尾 `-`、截 32）；
4. 最终截断到 96。

---

## 7. 里程碑

每阶段独立可合并、可回滚，结束即 `pnpm run check` 全绿。

### M0｜可注入化 + 安装目录发现 + spawn cwd（约 0.75 天）

**文件**：`src/qoder/transport/risk-identity.ts`、`tests/risk-identity.spec.ts`

1. **先做 R13 可注入化**（否则后续测试无法跨平台跑）：`runtimeInfoName(platform)` 函数化；`installRoots(home, os, env)` 注入 `env`；`QoderRiskIdentityOptions` 增 `readFileImpl?`/`existsImpl?`/`env?`/`hostnameImpl?`。
2. 新增 `desktopInstallDirs(region, home, os, env, deps)`：win32 先读 launcher `state.ini`（`<LOCALAPPDATA>\<Name>\<Name> Launcher\state.ini`、`<LOCALAPPDATA>\<Name>\Launcher\state.ini`，`<Name>` ∈ {`Qoder`,`Qoder CN`,`QoderCN`}，键 `installDir`；BOM 判定 `utf-8-sig` → `utf-16`，无 BOM 先 utf8），再退 `<LOCALAPPDATA>\Programs\<Name>`、`%ProgramFiles%\<Name>`、既有 `C:`/`D:` 兜底；darwin 加 `/Applications`、`~/Applications`；linux 加 `/usr/share/<name lower>`。
3. spawn 增加 `cwd: dirname(exe)`。

**测试**：T-M0-1 state.ini 自定义目录（UTF-8）、T-M0-2 同上（UTF-16LE+BOM）、T-M0-3 无 `installDir` 键时沿候选链继续、T-M0-4 spawn 收到正确 `cwd`、T-M0-5 注入非 win32 平台时 `runtimeInfoName` 返回无扩展名、T-M0-6 注入 `env` 的 `LOCALAPPDATA` 生效（不读真实环境）。

**验收**：上述 6 例在 Windows 与 Linux CI 均可跑；既有用例语义不变。

### M1｜提取器 + CLI（约 2 天）

**新增**：`src/qoder/transport/umid-extract.ts`（预计 **500 行上下**，零依赖：`node:zlib`/`node:crypto`/`node:fs`/`node:path`/`node:os`/`node:stream`）
**改**：`risk-identity.ts`（候选链追加 `QODER_UMID_DIR` 与 `~/.dsh/qoder/umid`；win32 双文件校验）、`bin.ts`（`umid install`/`status`/`reset-native`）

**测试** `tests/qoder/umid-extract.test.ts`：
T-M1-1 内存构造 tar.gz（伪造 ELF/PE/DLL/WASM，阈值压到 1KB）正确识别并落盘；T-M1-2 PE 无 DLL 标志不被当作 dll；T-M1-3 sha512 不符 → 中止且不落文件（I-05）；T-M1-4 半截 tarball / 非 gzip → 干净失败、旧内容不变；T-M1-5 已安装 + `!force` → 零网络请求；T-M1-6 manifest 0600（I-07）；T-M1-7 `unsupported-platform`（win32-arm64）；T-M1-8 自检失败不提升且 staging 清理；**T-M1-9 `.staging-*` 残留被清理**（审查 §4.4-1）。

**追加（真实包验证后，见 §6.2 实施修正）**：T-M1-10 单条 **6 MiB** base64 字面量被正确识别（旧正则在旧实现上必栈溢出，是这条缺陷的回归锁）；T-M1-11 400 万字符全失败候选在 <10 s 内返回 0 条（锁 O(n)，防 `index += 1` 退化）；T-M1-12 被拒候选不得遮蔽紧随其后的合法字面量。全部压进 `tests/qoder/umid-extract.test.ts`。

**验收**：`umid status` 在无组件机器上 `installed:false` 且退出码 0；`umid install --from-tarball <fixture>` 在临时 `HOME` + `QODER_UMID_DIR` 下成功并自检通过。

### M2｜共享守卫路由 + scope 方法 + status 字段 + 卡片（约 1 天）

**改**：
- `src/device-reset-route.ts`：抽出 `registerGuardedActionRoute`，device-reset 改用它（**行为零变化**，既有 `tests/device-reset-route.spec.ts` 必须原样通过）。
- `src/status-paths.ts`：新增 `QODER_UMID_INSTALL_PATH`；`QoderWebStatus` **三个 arm** 加 `nativeDevice`（§5.6）。
- `src/index.ts`：在 `:2595-2607` 旁注册 umid-install 路由（key 用 `controlKeys().probe`）、注入安装 job 与 status 字段。
- `src/client/QuotaSettingsCard.tsx`：`QuotaSettingsScope` 加 `installUmid?` + `QuotaUmidInstallResult`。
- `src/client/http-settings-scope.ts`：实现 `installUmid()`（stale-key 重读重试）。
- `src/client/QoderPluginCard.tsx`：新增小节（条件 R12），`alreadyRunning` → 轮询。
- `src/client/locales.ts`：`umidHeading`、`umidInstalled`、`umidNotInstalled`、`umidInstallButton`、`umidInstalling`、`umidSelfCheckFailed`、`umidOfflineHint`、`checkInNeedsUmid`。

**测试**：
`tests/umid-install-route.spec.ts`（**少量**，守卫由既有套覆盖）：T-M2-1 挂载成功且走同一守卫（缺 key → 403）；T-M2-2 单飞（第二次 `alreadyRunning`）；T-M2-3 失败形状 `200 {ok:false}`；T-M2-4 后台 job 不阻塞响应。
`tests/*.spec.ts`：T-M2-5 scope 方法存在性（缺失时卡片不渲染按钮）；T-M2-6 **三个 arm** 都带 `nativeDevice`；T-M2-7 `alreadyRunning` 触发轮询而非错误提示；T-M2-8 stale-key 重读重试一次。

**验收**：卡片三态（未安装/安装中/已装自检通过）渲染正确；纯国内版用户看不到该小节。

### M3｜身份缓存 + 表决 + 过期回退（约 1 天）

**新增**：`src/qoder/transport/risk-identity-cache.ts`（约 150 行）
**改**：`risk-identity.ts`（接入 R7 解析顺序、表决、`QODER_UMID_IDENTITY_CACHE`/`_TTL`/`_SELF_HEAL`）

**测试**：T-M3-1 缓存命中不 spawn（I-04）；T-M3-2 过期重采；T-M3-3 分歧补样至 5 轮；T-M3-4 平票取首样本；T-M3-5 表决键忽略 `percentage`；T-M3-6 坏 JSON 视为无缓存并删除；T-M3-7 并发写保留磁盘既值；**T-M3-8 组件不可用时用过期缓存继续，不退化为 `no-client`**（I-13）；**T-M3-9 TTL 到期不清种子**（I-14）；T-M3-10 `QODER_UMID_SELF_HEAL=1` 时自愈至多一次/24h。

**验收**：一次签到多账号只 spawn 一次；同 realm 反复签到 `vmTypeCode` 稳定。

### M4｜头集合 + reasonCode + 文档发布（约 1 天）

**改**：
- `checkin.ts:119`：`riskHeaders` 接收真身份 + 派生值，按 `QODER_CAMPAIGN_MACHINE_HEADERS` 产 3/6 头；无身份 `{}`。
- `wire/cosy.ts`：新增 `campaignMachineOs`（R3），`qoderMachineOs` 保持原样不导出。
- `checkin.ts:274` 附近：按 R12 产出 `no-client` / `no-native-component`。
- **改写 `tests/checkin.spec.ts:693-698`**：`three` 模式仍断言 `not.toHaveProperty('cosy-machineid')` / `not.toHaveProperty('cosy-machinehostname')`；新增 `six` 模式断言二者**存在**且 `machineid === deriveMachineId(uid)`。**必须在测试注释里写明：这不是放宽，是新增一个默认关闭的分支**（审查 §1.4-c）。
- 文档：`NOTICE`（qoder2api-hub MIT 署名 + 出处注释）、`README.md`/`README.en.md`（已知限制：同机多账号仍只领一次、VM 误报、仅 win32-x64 有组件、离线安装、**派生 hostname 形态未验证**、**TTL 语义与参考实现不同**）、`CHANGELOG.md`（v1.1.0）、`package.json`（1.0.5 → 1.1.0）、`doctor` 增加 umid 段。

**测试**：T-M4-1 `three` 恰好 3 头（I-01）；T-M4-2 `six` 恰好 6 头且 `machineid` 同源（I-03）；T-M4-3 无身份 0 头且不发请求（I-02）；T-M4-4 既有断言改写后仍覆盖 `three` 模式；T-M4-5 wire 常量快照不变（I-09）；T-M4-6 安装前后推理头一致（I-11）；T-M4-7 `no-native-component` 映射到新 locale key。

**发布前手工清单**（不阻塞合并）：
1. 无客户端 + 有网：`umid install` → `status` 自检通过 → 卡片显示已安装 → 国际版签到拿到 `CLAIMABLE` 并成功领取。
2. 无客户端 + 无网：`umid install` 报可读错误；`--from-tarball` 成功。
3. 有客户端：签到与推理均无回归。
4. 自定义安装目录（拷客户端到非默认路径 + 改 state.ini）：M0 后能识别。
5. `QODER_CAMPAIGN_MACHINE_HEADERS=six` vs `three`：按**非劣性**判据记录（six 是否仍能看到 three 的全部活动），结论写进 CHANGELOG（供 R1 复核）。
6. 两个 profile 并存：只下载一份到 `~/.dsh/qoder/umid`（I-12）。

---

## 8. 测试矩阵

| 层 | 命令 | 覆盖 |
|---|---|---|
| 类型 | `pnpm run typecheck` | host + client 两份 tsconfig |
| vitest | `pnpm run test` | 路由复用、scope 方法、卡片三态、checkin 头集合、risk-identity 缓存与候选链 |
| node:test | `pnpm run test:qoder` | umid-extract（tar/gzip/base64/魔数/选择/自检/staging 清理） |
| 构建 | `pnpm run build` | lib/ 体积增幅 ≤ 30KB |
| 包内容 | `npm pack --dry-run` | I-08 |
| 全量 | `pnpm run check` | 每阶段结束必跑 |

---

## 9. 错误与文案

| 场景 | 对外形态 | 要求 |
|---|---|---|
| 国际版无组件且**可安装** | `status:'error'`、`reasonCode:'no-native-component'` | 卡片显示「安装原生设备组件」按钮 + `checkInNeedsUmid`；CLI 提示 `umid install` |
| 国际版无组件且**不可安装**（不支持平台） | `reasonCode:'no-client'`（语义不变） | 提示安装 Qoder 国际版客户端 |
| 组件不可用但有过期缓存 | **不报错**，正常签到 | status `identity.stale = true` |
| 组件未安装且用户主动查询 | CLI `umid status` → `installed:false`，退出码 0 | 不视为错误 |
| 安装失败（网络/校验/结构/自检） | `200 {ok:false,error}`；CLI 退出码 1 | 脱敏（I-10）+ 可执行下一步；结构变化类提示「上游包结构可能已变化，请反馈 issue」 |
| 不支持平台 | `unsupported-platform` | 列出支持范围：win32-x64 / darwin-{x64,arm64} / linux-{x64,arm64} |
| `reset-native` 未加 `--yes` | 只打印将删除的文件与影响 | 明确警告会影响本机已安装的 Qoder 客户端且不可恢复 |

---

## 10. 兼容、回滚与风险

| 场景 | 保证 | 回滚 |
|---|---|---|
| 已装客户端用户 | 候选链顺序 + 推理头不变（I-11） | 无需回滚 |
| 六头实验 | 默认 `three`，仅环境变量开启 | 取消环境变量 |
| 提取器出错 | 失败不触碰既有组件目录（I-05） | `--force` 重装或删除 `~/.dsh/qoder/umid` |
| 上游改包 | 自检兜底 + 明确文案 + manifest 留证 | 手动把客户端里的组件拷到 `QODER_UMID_DIR` |
| 里程碑回滚 | M0–M4 各自独立提交 | 逐提交 revert |

| # | 风险 | 缓解 |
|---|---|---|
| K1 | 本机命令行实测无 HTTPS 出口（`schannel: SEC_E_NO_CREDENTIALS`） | 离线 `--from-tarball` / `QODER_UMID_TARBALL` 一等公民（M1 必交付） |
| K2 | 上游改包结构或 base64 排布 | 魔数识别 + 装后自检 + manifest `blobIndexes` |
| K3 | 启发式选错二进制 | 体积区间 + 确定性选择 + 自检拦截，不覆盖旧件 |
| K4 | 杀软拦截新下载的可执行文件 | 文案提示；不自动重试；有缓存则继续（R7） |
| K5 | `six` 反而丢活动 | 默认 `three`；非劣性判据；开关即时回退 |
| K6 | 身份抖动致风险画像偏移 | 3+2 表决 + 磁盘缓存默认不过期 |
| K7 | 误用 `reset-native` | 仅 CLI + `--yes` + 明确警告 |
| K8 | 守卫抽取改坏 device-reset | 既有 `tests/device-reset-route.spec.ts` 必须原样通过（M2 验收硬条件） |

---

## 11. 交付物

**新增**：`src/qoder/transport/umid-extract.ts`、`src/qoder/transport/risk-identity-cache.ts`、`tests/qoder/umid-extract.test.ts`、`tests/umid-install-route.spec.ts`。

**修改**：`src/qoder/transport/risk-identity.ts`、`src/qoder/transport/checkin.ts`、`src/qoder/transport/wire/cosy.ts`、`src/device-reset-route.ts`、`src/bin.ts`、`src/index.ts`、`src/status-paths.ts`、`src/client/{QoderPluginCard.tsx,QuotaSettingsCard.tsx,http-settings-scope.ts,locales.ts}`、`tests/{risk-identity.spec.ts,checkin.spec.ts}`、`NOTICE`、`README.md`、`README.en.md`、`CHANGELOG.md`、`package.json`。

**不交付**：任何二进制；任何 reset-native 的 HTTP 路由；任何隐式下载路径；第二套守卫实现。

**工期**：M0 0.75d + M1 2d + M2 1d + M3 1d + M4 1d ≈ **4–5 个工作日**（不含真机 A/B 等待）。

---

## 12. 与审查意见的偏离（仅一处）

审查 §4.3 要求「删掉 `QODER_UMID_INSTALL_PATH`」。本规范保留该**一行路径常量**，其余（路由文件、独立 handler、安全面测试套）全部按审查意见删除。

理由：安装端点必须可寻址，`ctx.webServer.register({ path })` 需要一个路径值；该常量与 `QODER_DEVICE_RESET_PATH` 同处 `src/status-paths.ts`，是全仓路径常量的既有归口。若改为字面量内联，反而破坏「路径只在 `status-paths.ts` 声明」的既有约定，也让客户端与服务端的路径一致性失去单一来源。

除这一行外，审查的其余要求全部落地：卡片走 scope 方法（R10）、不新增路由文件与安全面测试（R11）、后台 job 保留但补 staging 清理与轮询（R14）。
