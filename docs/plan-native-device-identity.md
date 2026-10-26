# 执行方案：国际版签到摆脱桌面客户端依赖（UMID 原生身份）

状态：**已废弃（被取代）** —— 本文件是 v1 提案，其 §6 的 6 个开放问题已在
[`docs/spec-native-device-identity.md`](spec-native-device-identity.md)（SPEC-UMID-003）中全部决议，
并按 [`docs/review-native-device-identity.md`](review-native-device-identity.md) 逐条修正。
实施请以该规范为准，本文件仅保留作决策过程记录。
参考实现：`E:\Workspace\zcode\agent2apisum\qoder2api-hub`（MIT，本机已有克隆）
涉及版本：v1.0.5 → v1.1.0

---

## 0. 目标与非目标

### 目标

1. **国际版签到不再要求本机安装 Qoder 桌面客户端**：从官方 npm 包提取官方 `runtime-info` 组件，用同一个组件产身份。
2. **修掉一个独立 bug**：客户端装在非默认目录时，插件误判「没装客户端」。
3. **把参考实现验证过的细节补齐**：身份缓存、抖动表决、种子语义、六头形态。
4. 全过程**零新增运行时依赖**（保持 `package.json` 现在的零 deps 形态）。

### 非目标（明确不做）

- ❌ 不伪造多台设备身份去绕「同人只领一次」——组件是机器级的，这条路技术上存在但违背上游意图，且我们的取舍与参考实现一致。
- ❌ 不默认删除官方客户端的 `~/.config/.locale_cfg`（那是另一个应用的状态文件）。
- ❌ 不内嵌/再分发官方二进制（运行时按需从 npm 下载，不构成再分发）。
- ❌ 不代做兑换码类活动的任务、不绕过虚拟机检测。

---

## 1. 现状（代码事实，已核对）

| 事实 | 位置 |
|---|---|
| 只从客户端安装目录找组件，找不到 → `undefined` | `src/qoder/transport/risk-identity.ts:118` (`findRuntimeInfoBinary`) |
| 安装根目录是**硬编码**的 6 个路径，不读 launcher 的 state.ini | `src/qoder/transport/risk-identity.ts:75` (`installRoots`) |
| spawn 未设置 `cwd`（组件需要同目录 dll） | `src/qoder/transport/risk-identity.ts:157` |
| 国际版无身份 → 硬失败 `reasonCode:'no-client'` | `src/qoder/transport/checkin.ts:274` |
| 活动族只发 3 个机器头 | `src/qoder/transport/checkin.ts:119` (`riskHeaders`) |
| 活动族 fingerprint 锁死 1.0.0 的 UA/version（rot-guard T3） | `src/qoder/transport/checkin.ts:204` |
| 已有 host 级身份目录惯例：`~/.dsh/qoder/`（machine_id、device_seed） | `src/qoder/transport/machine-id.ts:24-27`、`src/qoder/transport/device-seed.ts:32` |
| 已有「重置」路由的安全范式（loopback + settings key + 200/ok:false） | `src/device-reset-route.ts` |
| 已有派生设备指纹：`deriveMachineId` / `deriveMachineHostname` | `src/qoder/transport/device-identity.ts:67,80` |
| `cosy-machineos` 常量已存在但**未导出**，取值 `x86_64_windows`（注意不是 `x86_64_win32`） | `src/qoder/transport/wire/cosy.ts:36-42` |

测试基建：`tests/*.spec.ts`（vitest，经 `tests/sandbox-shim.cjs`）+ `tests/qoder/*.test.ts`（`node --test --experimental-strip-types`）。已有 `tests/risk-identity.spec.ts`、`tests/checkin.spec.ts`、`tests/device-reset-route.spec.ts` 可扩展。

---

## 2. 设计决策（含备选与理由）

### D1 组件落位：`~/.dsh/qoder/umid/`（host 级），`QODER_UMID_DIR` 可覆盖

理由：身份是**机器级**的，同一台机器上两个 DSH profile 若各装一份、各用一份，等于向上游声称两台设备——正是 `device-seed.ts` 头部论证过要避免的那种不一致。故与 `machine_id` / `device_seed` 同处 host 级目录。

备选（不采用）：放 profile 数据目录（`paths.ts` 的 `qoderPluginDataDir()`）——会重复下载 31MB 且可能身份不一致。

Windows 需要 **两个文件**（`runtime-info.exe` + 同目录 `sgsdk.dll`）；POSIX 一个。安装前两个文件都校验，缺一个视为未安装。

### D2 安装是**显式动作**，不在请求路径里偷偷下载

理由：31MB 下载 + 解压，绝不能在签到请求里隐式发生（用户会看到 25s 超时，还查不出原因）。

三个入口：`dsh-qoder-plugin umid install`、卡片按钮、`QODER_UMID_TARBALL=<path>` / `--from-tarball`（离线）。

**离线通道是硬需求**：本机当前 shell 实测无 HTTPS 出口（`curl`/`git` 均 `schannel: SEC_E_NO_CREDENTIALS`）。若宿主进程也被同样限制，在线安装必然失败，必须有「我自己下好 tgz 喂给你」的路径。

### D3 提取算法遵循参考实现，但**按规则识别而非按出现顺序**

- 只扫 `package/bundle/qoder-worker-runtime.mjs`（找不到再退 `package/bundle/*.mjs`，再退全包的 `*.mjs`）。
- 长 base64 字面量：`/(['"])([A-Za-z0-9+/=]{4000,})\1/g`。
- **按魔数**判定格式与架构（ELF `e_machine@18`、Mach-O `cputype@4`、PE `e_lfanew@0x3C → machine@+4`）。
- 体积启发式（默认 400KB–2MB 选 `runtime-info`；DLL 需 `Characteristics & 0x2000` 且 >2MB），**阈值做成可注入**以便测试用 KB 级样本。
- Windows 成对选择；失败就报错，不猜。

改进（相对参考实现）：**装完立即执行一次自检**（`runtime-info <env>` → 解析 JSON 是否含 `machineToken`）。启发式万一被上游改包打破，自检会当场失败，而不是等到用户签到才发现。自检结果写进 `umid/manifest.json`（版本号、tarball sha512、被选中的 entry 名与 blob 序号、自检时间），供 `doctor` 输出。

### D4 tarball 完整性：按 `dist.integrity` 校验 sha512

GET `https://registry.npmjs.org/@qoder-ai%2Fqodercli` → `dist-tags.latest` → `versions[v].dist.tarball` + `dist.integrity`。下载后 `sha512` base64 比对，**不符即中止**。同时：限制响应体 ≤ 64MB、只接受 `https:`、最终响应 URL 的 host 必须是 `registry.npmjs.org`（防重定向到任意源）。

流式处理：`fetch → ReadableStream → zlib.createGunzip → 增量 tar 扫描`，找到目标 entry 即停止解压，不把 31MB 全解在内存里。

### D5 无身份时的语义：硬报错 → 可解释降级

现状 `checkin.ts:274` 直接 `error/no-client`。改为：先尝试解析；若仍无身份，返回 `status:'error'` 但 `reasonCode:'no-client'` 文案升级为**可执行**的（告诉用户跑 `umid install`，或装客户端）。**行为不变**（仍不发请求），只是把「为什么/怎么办」说清楚，并在卡片上给按钮。

不做的变更：不自动降级为「发部分机器头」（见 D7）。

### D6 身份缓存 + 抖动表决

- 路径：`~/.dsh/qoder/machine-identity.json`，`{"version":1,"realm":{"global":{...},"china":{...}}}`，写 0600，tmp+rename。
- 三元组 `machineToken/machineType/machineCode` + `vmInfo` + `cachedAt` + `source`。
- **内存 TTL 30 分钟**（避免一次签到为 N 个账号各 spawn 一次 3.7 秒的组件）；磁盘默认**不过期**（与参考实现一致），`QODER_UMID_IDENTITY_TTL` 可设。
- **首次落盘做多数表决**：3 轮一致直接采纳；有分歧再补 2 轮（上限 5）；唯一多数取该分支首样本；平票/全不同取第一样本。表决键 `(machineToken, machineType, machineCode, isVm, brand, vmTypeCode)`，**不含** `vmInfo.percentage`（该字段天然抖动）。
- 依据：参考实现实测 `machineToken` 恒定但 `machineType/machineCode/vmInfo` 会在 `KVM/13` ↔ `Docker/50` 间抖（报告 1.56%，本地复现 10.29%），而 `vmTypeCode` 正是喂风险画像的字段——单次采样会把用户永久钉在少数派分支。

### D7 六头对齐：只在**真身份存在**时发全部六个

参考实现 issue #10 的逐头隔离结论是硬约束：

- 六头**全部为派生假值** → 服务端把 `CLAIMABLE` 活动整条过滤（实测）；
- 其中任一个单独出现 → 活动可见；
- 去掉 `machinetoken` 或 `machineid` → 可见。

因此规则是二元的：**有真身份 → 六个都发；无真身份 → 一个都不发**。中间态（发三个派生头）恰好是最危险的组合，现有代码在国际版走不到这条路（无身份时直接报错），改动后也要保持这个不变量，并用测试锁死。

新增的三个头：

| 头 | 值 | 说明 |
|---|---|---|
| `cosy-machineid` | `deriveMachineId(uid)` | 与推理链路**同一个值**，保持插件内部自洽 |
| `cosy-machineos` | 见开放问题 Q3 | 复用 `cosy.ts` 常量（需导出） |
| `cosy-machinehostname` | 见开放问题 Q4 | 官方用真实 hostname，插件当前刻意不发 |

### D8 种子语义：区分「插件自己的种子」和「官方客户端的种子」

- `~/.dsh/qoder/device_seed`：插件自己的（影响**派生**指纹，即推理链路）。现有按钮已覆盖。
- `~/.config/.locale_cfg`：**官方组件的**身份种子（影响**原生**身份，即签到）。删它 = 换一台"设备"，但也**同时改变已安装的官方客户端**的身份。

结论：不把它并进现有「设备码重置」按钮。新增独立动作 `umid reset-native`（CLI + 卡片二次确认），文案明确写「会影响本机已安装的 Qoder 客户端」。参考实现里 `QD_MACHINE_IDENTITY_RESET` 就是这个语义，但它是个纯签到网关，不持有客户端；我们不一样，必须显式。

### D9 许可与合规

- 提取算法源自 qoder2api-hub（MIT）：在 `NOTICE` 追加署名 + 许可证原文引用，并在 `umid-extract.ts` 头部注明出处。
- 二进制不入库、不进 npm 包（`package.json` 的 `files` 不变），运行时下载 → 不构成再分发。
- README「已知限制」保留并扩写：同机多账号仍只领一次、VM 误报、仅 win32-x64 有组件。

---

## 3. 任务分解

每个任务独立可合并、可回滚。顺序即依赖顺序。

### P0｜安装目录发现 + 运行时 cwd（独立 bugfix，零风险）

**文件**
- `src/qoder/transport/risk-identity.ts`：新增 `desktopInstallDirs(region, home, os)`；
  - Windows：先读 launcher `state.ini` —— `<LOCALAPPDATA>\Qoder\Qoder Launcher\state.ini`、`<LOCALAPPDATA>\Qoder\Launcher\state.ini`（CN 同理，名字含 `Qoder CN` / `QoderCN`），键 `installDir`；解码顺序 `utf-8-sig` → `utf-16`（按 BOM 判定，无 BOM 先 utf8）；再退 `<LOCALAPPDATA>\Programs\<name>`、`%ProgramFiles%\...`，最后是现有的硬编码 `C:` / `D:` 兜底。
  - darwin / linux：补上参考实现的 `/Applications`、`~/Applications`、`/usr/share/<name lower>` 变体。
  - 保持「产品名不匹配也能用」的现状语义（注释已说明理由）。
- `risk-identity.ts:157`：spawn 增加 `cwd: dirname(exe)`（组件要加载同目录 dll；POSIX 不一定需要，但无害）。
- `src/qoder/transport/risk-identity.ts`：`QoderRiskIdentityOptions` 增加 `readFileImpl?` 便于测试注入。

**测试**（`tests/risk-identity.spec.ts` 扩展）
1. state.ini 指向自定义目录 → 能找到组件（UTF-8 与 UTF-16LE+BOM 两个用例）。
2. state.ini 存在但没有 `installDir` 键 → 继续沿候选链走，不崩。
3. 自定义 `installRoots` 仍优先于 launcher 推断。
4. spawn 收到的 options 含 `cwd === dirname(exe)`。

**验收**：`pnpm run typecheck && pnpm run test` 通过；既有 `risk-identity` 用例不改语义。

**回滚**：单文件改动，revert 即恢复。

---

### P1｜UMID 提取器 + 安装入口（核心，最大一块）

**新文件 `src/qoder/transport/umid-extract.ts`**（预计 320–400 行）

导出：

```ts
export interface UmidExtractOptions {
  platform?: NodeJS.Platform
  arch?: string
  destDir?: string                    // 默认 ~/.dsh/qoder/umid
  registry?: string                   // 默认 https://registry.npmjs.org
  packageName?: string                // 默认 @qoder-ai/qodercli
  version?: string                    // 默认 dist-tags.latest
  tarballPath?: string                // 离线通道
  fetchImpl?: typeof fetch
  sizeHints?: { fileMin; fileMax; dllMin }   // 测试注入
  signal?: AbortSignal
  logger?
}
export interface UmidInstallResult {
  ok: boolean
  version: string
  destDir: string
  files: { name: string; bytes: number; sha256: string }[]
  blobEntries: string[]               // 命中来源，写进 manifest
  selfCheck: { ok: boolean; reason?: string; machineTokenTail?: string }
}
export function umidDir(): string
export function umidBinaryPath(platform?: NodeJS.Platform): string
export async function installUmid(options?: UmidExtractOptions): Promise<UmidInstallResult>
export function readUmidManifest(dir?: string): UmidManifest | undefined
```

内部管线：`fetchPackument → chooseVersion → fetchTarball(限 64MB) → verify sha512 → gunzip 流 → tar 增量扫描 → 抽 .mjs 文本 → base64 扫描 → 魔数识别 → 选择候选 → 原子落盘(.staging → rename) → 自检 → 写 manifest`。

tar 解析细节（手写，~70 行）：512 字节头；magic `ustar\0`；`typeflag` `'0'`/`'\0'` 才是文件；`'x'`(PAX)、`'g'`(global PAX)、`'L'`(GNU longname) 跳过其 payload；size 取八进制字段（偏移 124，12 字节）；内容按 512 向上取整；两个全零块结束。

**改 `src/qoder/transport/risk-identity.ts`**
- `findRuntimeInfoBinary` 候选链末尾追加提取目录（`QODER_UMID_DIR` → `~/.dsh/qoder/umid`），**排在客户端安装目录之后**（装了客户端的用户行为不变）。
- Windows 要求 exe 与 dll 同时存在。

**新文件 `src/umid-install-route.ts`**（~130 行，**照抄** `device-reset-route.ts` 的安全范式：POST + loopback host/origin + `x-qoder-settings-key` + 4KB body 上限 + `200 {ok:false}` 表达失败）。
- 副作用要与请求生命周期解耦：路由立即返回 `{ok:true, started:true, jobId}`，后台跑安装，进度写进 status 文档（31MB 下载 + 解压可能 >10s，不能占着 HTTP 连接）。
- 并发保护：进程内单飞（已有 job 时返回 `{ok:true, alreadyRunning:true}`）。

**改 `src/status-paths.ts`**：新增 `QODER_UMID_INSTALL_PATH = '/plugins/dsh-qoder-plugin/umid-install'`、`QODER_UMID_STATUS_PATH`（或并入现有 status 文档，更省事——见下）。

**改 `src/bin.ts`**：新增 action `umid`，子命令 `install` / `status` / `reset-native`。
- `umid status`：路径、是否可执行、manifest、`runtime-info` 自检结果；`--json` 输出。
- `umid install [--from-tarball <path>] [--version <v>] [--force]`。
- `umid reset-native [--yes]`：删 `~/.config/.locale_cfg` + 清身份缓存（见 D8）。

**改 `src/index.ts`**（只在 `:2595` 附近那块 reset 注册旁边加）：
- 注册 `umid-install` 路由；
- 把 umid 状态并入现有 status 文档（卡片读它，避免新增一条轮询通道）。

**改客户端**：`src/client/QoderPluginCard.tsx`（136KB，只加一小节）+ `src/client/locales.ts`（中英文案）+ `src/client/status-document.ts`（类型）。
- 设备码卡片下并列显示「原生设备组件：已安装 v1.1.75 · 自检通过 / 未安装」+ 按钮「安装组件」；失败时展示原因与「选择离线 tgz」提示。
- 不做文件选择器（Web 端拿不到本地路径）；离线通道只在 CLI 提供，卡片文案指过去。

**测试**
- 新增 `tests/qoder/umid-extract.test.ts`（`node --test`）：
  1. 用内存构造的 tar.gz（含伪造 ELF/PE/DLL/WASM blob，体积阈值压到 1KB）→ 正确识别并落盘。
  2. PE 无 `IMAGE_FILE_DLL` 标志 → 不被当作 dll。
  3. sha512 不符 → 抛错且**不落任何文件**。
  4. 半截 tarball / 非 gzip → 干净失败，`destDir` 仍是旧内容（原子性）。
  5. 已有安装 + `force:false` → 跳过下载（用 mock fetch 断言零请求）。
- 新增 `tests/umid-install-route.spec.ts`：方法/Host/Origin/key/body 超限/单飞/失败形状（照 `tests/device-reset-route.spec.ts` 抄）。
- `tests/risk-identity.spec.ts`：提取目录候选优先级、win32 必须双文件。

**验收**
- 在一台**没装 Qoder** 的机器（或改 `QODER_UMID_DIR` 指向空目录 + 临时 `HOME`）上，`umid install` 后 `umid status` 显示自检通过。
- 装了客户端的机器上行为完全不变（候选顺序保证）。
- `pnpm run check` 通过。

**风险**
- 上游改包结构 → 自检兜底 + 明确报错文案（"组件自检失败，可能是上游包结构变化，请报告"）。
- 启发式选错文件（多个候选同体积）→ manifest 记录，可在 issue 里一眼定位。
- 微软 Defender 对刚下载的可执行文件可能拦截 → 安装时给出提示；失败不重试。

**回滚**：新增文件为主；`risk-identity.ts` 的候选追加可一行 revert。安装按钮对未安装用户无副作用。

---

### P2｜身份缓存 + 抖动表决

**新文件 `src/qoder/transport/risk-identity-cache.ts`**（~150 行）
- `readIdentityCache(region)` / `writeIdentityCache(region, entry)` / `clearIdentityCache()`，0600 + tmp/rename。
- `sampleWithVote(region, uid, sample, opts)`：3+2 轮表决，阈值与轮数可注入。

**改 `risk-identity.ts`**：`resolveRiskIdentity` 增加可选 `cache` 行为（默认开启，`QODER_UMID_IDENTITY_CACHE=0` 关闭）。派生的**内存**缓存 30 分钟；`QODER_UMID_IDENTITY_TTL` 控制磁盘过期（默认 0 = 不过期）。

**测试** `tests/risk-identity.spec.ts` 扩展：缓存命中不 spawn；过期重新采样；分歧时补样；平票取首样本；表决键忽略 `percentage`；坏 JSON 视为无缓存。

**验收**：一次签到多账号只 spawn 一次；同一 region 反复签到的 `vmTypeCode` 稳定。

---

### P3｜六头对齐（**行为变更，需单独验证**）

**改 `src/qoder/transport/checkin.ts:119`**：`riskHeaders` 改为接收「真身份 + 派生值」，产出六头；无身份时返回 `{}`（不变量见 D7）。

**改 `wire/cosy.ts`**：导出 `qoderMachineOs`（或新增 `campaignMachineOs`）。

**开关**：`QODER_CAMPAIGN_MACHINE_HEADERS=six|three`（默认值见开放问题 Q1）。

**不改** `fingerprint:'campaign'` 的 UA/version 锁（rot-guard T3 明确要求字节不变，动了要重跑一轮全量验证——不在本方案内）。

**测试** `tests/checkin.spec.ts`：
- 有身份 → 恰好 6 个 `cosy-machine*` 头，且 `cosy-machineid` 与推理链路的派生值相同；
- 无身份 → 0 个机器头（且国际版不发出 campaigns 请求）；
- 断言不出现「3 个派生头」这种中间态（防止未来改动回退）。

**验收**：用真实账号对比 3 头 / 6 头两个变体，看 `campaigns` 是否多出 `CLAIMABLE` 活动。**这一步必须真机验证后再定默认值**——参考实现明确写了「真头是否额外解锁设备定向活动未验证」。

---

### P4｜收尾

- `NOTICE` 署名、`README.md` / `README.en.md` 已知限制扩写、`CHANGELOG.md` 记 v1.1.0。
- `doctor` 输出增加 umid 段（路径/版本/自检/身份缓存状态）。
- 版本号 1.0.5 → 1.1.0（新功能，非补丁）。

---

## 4. 测试矩阵

| 层 | 命令 | 覆盖 |
|---|---|---|
| 类型 | `pnpm run typecheck`（host + client 两份 tsconfig） | 新增 API |
| 单测 | `pnpm run test`（vitest） | 路由/卡片/checkin/risk-identity 缓存与候选链 |
| 纯 Node 单测 | `pnpm run test:qoder` | umid-extract（tar/gzip/base64/魔数） |
| 构建 | `pnpm run build`（tsdown） | 产物体积（lib/ 会多 ~20KB，可接受） |
| 手工 | 见下 | 端到端 |

手工验收清单：
1. 无客户端 + 有网：`umid install` → `umid status` 自检通过 → 卡片按钮出现 → 国际版签到拿到 `CLAIMABLE`。
2. 无客户端 + 无网：`umid install` 报可读错误；`umid install --from-tarball x.tgz` 成功。
3. 有客户端：行为不变（回归）。
4. 自定义安装目录（临时把客户端拷到 `E:\Apps\Qoder` 并改 state.ini）：P0 修复后能识别。
5. 两个 profile 同时存在：只下载一份到 `~/.dsh/qoder/umid`。

---

## 5. 风险与回滚

| 风险 | 影响 | 缓解 | 回滚 |
|---|---|---|---|
| 上游改 npm 包结构 | 提取失败 | 自检 + 明确错误；manifest 留证 | 组件已落盘的继续可用 |
| 无网络/被墙 | 装不上 | 离线 `--from-tarball` 为一等公民 | — |
| 启发式选错二进制 | 自检失败 | 装完即自检，失败不写 manifest、不覆盖旧件 | 重装 `--force` |
| 六头导致活动反而消失 | 签到退化 | 开关可立刻回 `three`；P3 单独提交 | 环境变量回退 |
| 删 `.locale_cfg` 影响官方客户端 | 用户侧意外 | 独立动作 + 二次确认 + 文案警告 | 无法回滚（种子不可恢复）——所以必须显式 |
| lib/ 体积增长 | 包变大 | 提取器纯 JS 约 20KB | — |

---

## 6. 需要你拍板的开放问题

**Q1 六头的默认值**：`six`（对齐官方，但要真机验证）还是先 `three`（零风险，等验证后再翻）？我建议**先 `three` 发布，你验证通过后一行改默认**。

**Q2 无身份时的行为**：保持「不发请求 + 报错」（现状，我倾向）还是允许「发仅 UA/clienttype/version 的请求，把结果当参考」？后者能区分"这天真没活动"和"身份缺失"，但会多一次无效请求，且**不能**因此判断活动是否存在（服务端静默过滤），信息价值有限。

**Q3 `cosy-machineos` 取值**：这里有两个互相冲突的既有值——参考实现默认 `x86_64_win32`，本插件推理链路用 `x86_64_windows`。必须二选一。我倾向**沿用本插件推理链路的 `x86_64_windows`**（插件内部自洽优先，且该值在推理链路上已被线上验证过），但这与参考实现不一致，需你确认是否要为了"对齐官方"改成 `win32`。

**Q4 `cosy-machinehostname` 用真机名还是派生值**：官方桌面端发**真实主机名**；插件当前**刻意从不发真机名**（隐私）。发真机名能更像官方，但会把用户机器名泄给上游。我建议**默认派生值**（`DESKTOP-` + 7 位 hex，与推理链路同源），加 `QODER_CAMPAIGN_REAL_HOSTNAME=1` 供实验。

**Q5 是否要 P3 全做**：如果 Q1 选 `three` + Q4 选派生，那 P3 的实际收益只剩 `cosy-machineid` / `cosy-machineos` 两个头，可以并入 P1 一起提交，省一轮验证。

**Q6 落地范围**：要不要一次性做完 P0–P4，还是先只做 P0+P1（能签到就行），P2/P3 另开一轮？

---

## 7. 建议顺序与工作量

| 阶段 | 内容 | 估计 | 可独立发布 |
|---|---|---|---|
| P0 | 安装目录发现 + cwd | 0.5 天 | ✅ 值得单独发补丁 |
| P1 | umid-extract + 离线通道 + CLI + 路由 + 卡片 | 1.5–2 天 | ✅ 核心价值 |
| P2 | 缓存 + 表决 | 0.5 天 | ✅ |
| P3 | 六头对齐（待 Q1/Q4 决定） | 0.5 天 + 真机验证 | ⚠️ 需验证后发 |
| P4 | 文档/CHANGELOG/版本 | 0.25 天 | — |

合计约 3.5–4 个工作日（不含上游变动带来的返工与真机验证等待）。
