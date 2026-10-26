# 审查意见：`docs/plan-native-device-identity.md`

审查对象：`docs/plan-native-device-identity.md`（337 行）
审查方式：逐条对照插件源码与参考实现 `E:\Workspace\zcode\agent2apisum\qoder2api-hub`（Python, MIT）核对，未改任何代码。
结论粒度：只写会影响「能不能按这份方案开工」的部分；未提到的条目我认同原方案。

---

## 0. 总览

| 条目 | 结论 | 处理建议 |
|---|---|---|
| §2 D7 六头发送规则 | **依据与结论之间有跳跃，且会把一条已验证可用的路径换成未验证路径** | 保留「无真身份 → 0 头」不变量；「六头」改为开关 + 真机 A/B，默认维持现状 3 原生头 |
| §6 Q3 `cosy-machineos` | **不是二选一，而是三选一；正确落点是「只改 campaign，取 `win32`」** | 按被冒充的客户端取词汇，推理链路不动 |
| §6 Q4 `cosy-machinehostname` | 计划的推荐值偏离唯一被验证过的形状 | 默认真实 hostname，派生值降为隐私开关 |
| §3 P1 路由 | **文件清单缺两处，照抄会在编译期/运行期各挂一次** | 删掉新 HTTP 路由，改走 scope 方法；卡片按钮保留 |
| §2 D5 | 文案升级在卡片上不生效（被 reasonCode 短路） | 新增 reasonCode + locale key，或改用状态字段驱动 UI |
| §2 D6 | 漏了参考实现三个行为，其中「组件不可用回退过期缓存」与 D5 硬失败直接冲突 | 至少补③，建议同时补① |
| §3 P0 | 4 条测试在本项目当前代码上只能跑在 Windows | 先做两处可注入化，否则 CI 上跑不了 |
| §3 P3 验收口径 | 「参考实现验证过」需要加限定 | 见 §1.4 |

---

## 1. §2 D7 —— 三个问题，按严重度排序

### 1.1 证据没有被测过的那个点，正好是结论依赖的那个点

方案 `docs/plan-native-device-identity.md:98-100` 引用的三条实测，与参考实现原文一致（`qoder_accounts.py:1958-1966`、`CHANGELOG.md:1106`）：

- 六头全为派生假值 → `CLAIMABLE` 活动整条被过滤；
- 六头中**任一个单独**出现 → 活动可见；
- 去掉 `machinetoken` 或 `machineid` → 恢复可见。

但 `:102` 的结论写的是：

> 中间态（发三个派生头）恰好是最危险的组合

**「三个」这一档从来没有被测过。** 实测覆盖的是 `1`、`6`、`5（去掉 token）`、`5（去掉 id）` 四档，且方向是「越少越安全」——单独一个头可见，去掉一个头也可见。把它外推成「三个是最危险的组合」，是把一条单调的证据用成了非单调的结论；如果服务端判据是「是否构成完整客户端特征」，那么 3 头恰恰比 6 头更安全，结论方向会反过来。

这条不妨降级为：**证据支持「六头派生 = 被过滤」和「单头/缺头 = 可见」，不支持对 3 头的任何断言。**

### 1.2 插件根本没有「发三个派生头」这条路径

`src/qoder/transport/checkin.ts:119-126` 的 `riskHeaders()` 只从真身份取值，`identity === undefined` 时返回 `{}`——campaign 路径上没有任何「拿派生值兜底」的分支。也就是说，方案担心的那个中间态在插件里不存在，它是从参考实现的 `derived` 兜底分支（`qoder_accounts.py:1965-1966` 明确「derived 分支一律不发」）移植过来的想象。

所以 D7 作为「规则」几乎是空的：它唯一实际的内容就是「再加三个头」。

### 1.3 真正严重的问题：装上客户端时，插件今天就在发 3 个**原生**头，而且这条路径是验证过的

`CHANGELOG.md:555-562`（0.3.0）：

> The international service only serves the daily 100-Credit campaign to a machine that has the Qoder **desktop client** installed. … The plugin now takes what it needs from the installed client and sends it on both the campaign and the claim request.

即：`cosy-machinetoken` / `cosy-machinecode` / `cosy-machinetype` 三个**原生**头 + `cosy-clienttype: 10`，是 0.3.0 之后线上国际版签到的实际工作形态。方案 `:102` 说「现有代码在国际版走不到这条路」——在「无客户端」这一支上是对的，但在「有客户端」这一支上是**反的**：插件不但走到了，而且靠它工作。

于是 D7 的实际效果是：**把一条已验证可用的 3 原生头路径，换成一条从未在插件侧验证过的 6 头路径**，而这条 6 头路径的唯一实测行为（被过滤）是在派生值下观测到的。参考实现自己写得很清楚（`CHANGELOG.md:1107`「真机器头是否额外解锁设备定向活动**未验证**」）。

改写建议：

- **不变量**保留，但改成：「无真身份 → 0 个机器头；有真身份 → 至少发原有 3 个原生头」。这一条才是真正需要锁死的（并且当前代码已经满足）。
- 「六个都发」不写成规则，写成**实验分支**：`QODER_CAMPAIGN_MACHINE_HEADERS=six` 打开，默认 `three`（即方案 Q1 自己建议的默认值）。
- A/B 的判据要从「是否多出 `CLAIMABLE`」改成**非劣性**：6 头是否仍能看到 3 头能看到的活动。把 working 路径换掉的代价不对称——多解锁是收益，丢活动是事故，而 v1.2.1 记录的事故形态正是「列表只剩详情类活动 + 面板显示签到成功」这种沉默失败。

### 1.4 另外三条与 D7 直接相关的事实

- **参考实现的原生六头是混合的**（`qoder_accounts.py:1980-1989`）：`machineid = derive_id(uid, "machine")`（**派生**）、`machinehostname` 真实、`machineos` 常量、只有 token/type/code 来自组件。所以「混合原生 + 派生」是被验证过的——但那是**参考实现的那个组合**，不等于方案要造的「3 原生 + 3 派生」组合。方案表格里 `cosy-machineid = deriveMachineId(uid)` 这一格恰好与参考实现一致，是 D7 里唯一有直接证据支撑的一格，值得在文档里写明依据。
- **参考实现对身份字段是逐字段兜底的**（`:1981-1986`，`ident.get("machineToken") or derive_machine_token(uid)` 等，门槛只有一个：`machineToken` 非空）；插件的解析器要求 token/type/code **三者齐全**才认（`src/qoder/transport/risk-identity.ts` 的 JSON 解析），缺一个就整体判「无客户端」→ 国际版硬失败。这是行为差异，不是方案错误，但方案没意识到自己是更严的那一侧。
- **加 `cosy-machinehostname` 会反转一条现有的锁**：`tests/checkin.spec.ts:691-698` 现在断言 campaign 请求**不得**出现该头（`not.toHaveProperty('cosy-machinehostname')`）。D7/P3 必须显式改这条断言并写明理由，否则实现者会以为是回归。
- **验证口径要加限定**：参考实现的六头是在它自己的请求指纹下验证的（`qoder_accounts.py:1971-1974`：`User-Agent: Qoder` + `cosy-version: 0.4.8` + `cosy-clienttype: 10`），插件发的是 `qoder/1.1.47` + `1.0.1`（`src/qoder/transport/wire/version.ts:68-74`，rot-guard T3 冻结）。P3 不动指纹是对的，但要承认：**插件要测的是一个新组合，不是逐字复刻参考实现的已验证请求。**

---

## 2. §6 Q3 —— 不是二选一，是三个选项；建议只改 campaign

现状：

- 参考实现默认 `x86_64_win32`（Windows）/ `x86_64_linux`（其余），见 `qoder_sign.py:558-567`；
- 插件的 `qoderMachineOs` 是 `x86_64_windows` / `aarch64_windows`（`src/qoder/transport/wire/cosy.ts:36-42`，Go 风格词汇）。

关键事实：**参考实现那个 `x86_64_win32` 不是「官方实测值」**。它自己的 docstring 写明默认值是为了「避免 ARM/macOS 存量账号升级后设备指纹漂移」——是为了不改变既有指纹而冻结的历史值，而且在 macOS 上它返回的是 `x86_64_linux`，显然不可能是官方的真实取值。所以「参考实现用 win32 所以官方就是 win32」这个推论不成立。

真正把「官方词汇」写成结论的是同一个文件的 `_detect_machine_os()`（`qoder_sign.py:544-555`）：docstring 写「返回官方同款 `{arch}_{platform}`（共 6 种组合）」，platform 取 `win32` / `darwin` / `linux`。这是仓库里唯一一处对官方词汇的断言，且方向与插件的 `_windows` 相反。而插件的 `x86_64_windows` 在源码里**没有任何注释说明依据**——它怎么来的无法追溯。

据此我的建议是：

**按「这个请求在冒充哪个客户端」取值，而不是按「插件内部要一致」取值。**

- campaign 路径声明的是桌面端身份：`cosy-clienttype: 10` + 桌面版 `cosy-version`（`checkin.ts:194-204`）。桌面端的词汇应是 `x86_64_win32`。
- 推理链路声明的是 CLI 身份：`cosy-clienttype: 5` + `qoder/1.1.75`（`src/qoder/transport/wire/version.ts:34-45`）。CLI 保留 `x86_64_windows`。

所以「同一台机器在两个端点发不同的 `cosy-machineos`」**不是不自洽**：两个请求声明的是两个不同的客户端，一台机器同时装 CLI 和桌面端完全正常。真正的不自洽是「声称自己是桌面端，却用 CLI 的操作系统词汇」。方案 Q3 里「为了内部一致保持 `x86_64_windows`」这个理由，是把「跨端点相同」误当成了「指纹自洽」——而服务端做特征比对时看的是一次请求内部的自洽，不是跨端点的相同。

风险也支持这个落点：campaign 路径**从来没发过** `machineos`，改它不会让任何既有用户的指纹漂移；改推理链路的则会让所有既有账号的指纹一次性漂移（rot-guard 相关）。所以正确落点是「只动 campaign，取 `win32`，推理链路一个字不改」，而不是「两边都不动」或「两边一起动」。

---

## 3. §6 Q4 —— 计划推荐的派生值偏离了唯一被验证过的形状

参考实现在 campaign 分支发的是**真实 hostname**：`qoder_accounts.py:160` `MACHINE_HOSTNAME = _header_safe_hostname(socket.gethostname())`，`:1988-1989` 直接放进 `cosy-machinehostname`，并且 `tests/_test_risk_identity.py:105,110` 专门断言「原生桌面头里的 hostname == 真实 hostname」。它自己派生的 `DESKTOP-1A2B3C4`（`qoder_sign.py:537-541`）是**推理链路**在用的。

也就是说：**唯一被验证可用的原生六头形状里，hostname 是真实的。** 方案的推荐值（派生 + `QODER_CAMPAIGN_REAL_HOSTNAME=1` 逃生开关）等于让 P3 的 A/B 去测一个从未出现过的组合。

顺带纠正方案 `:110` 的一句表述：「官方用真实 hostname，插件当前刻意不发」——插件侧的依据是 `cosy.ts:74-76` 的注释「The official desktop client sends it on the **inference SSE request only**」，那条注释讲的是 COSY metadata/status 家族，并没有对 campaign 端点表态。所以「官方在 campaign 也发真实 hostname」这个前提，纯粹来自参考实现的代码，没有插件侧实测支撑。

建议：

- 默认**真实 hostname**（对上唯一验证过的形状）；
- 隐私敏感的用户用反向开关降到派生值（`QODER_CAMPAIGN_DERIVED_HOSTNAME=1`），并在 README 已知限制里写明「派生形态未经真机验证」；
- 若坚持默认派生，那 P3 的验收必须**同时**覆盖「派生 hostname 下活动仍可见」，否则这条设计是在赌。

---

## 4. §3 P1 —— 我建议保留卡片入口，但删掉那条新路由

先回答你的问题：**不建议整段删掉**。D5 已经承认「无组件」在国际版是硬失败，如果再不给 GUI 用户一个安装入口，这个失败对非 CLI 用户就是死胡同。按钮值得保留。

但方案里的实现路径不是最短的那条，照 P1 的文件清单写会在两处直接挂：

### 4.1 卡片根本不会 fetch 这个路由

重置按钮的调用链是：

1. `src/client/QoderPluginCard.tsx:1429-1440` → `active.resetDeviceCodes()`（**scope 方法**，注释还专门写了「Called ON the scope, never as a detached function」）；
2. 成员声明在 `src/client/QuotaSettingsCard.tsx:70`：`resetDeviceCodes?: (() => Promise<QuotaDeviceResetResult>) | undefined`；
3. 实现是 `src/client/http-settings-scope.ts:295-301` → `sendReset()`（`:304-319`）POST `${ROUTE_BASE}/device-reset`，头是 `X-Qoder-Settings-Key`，值取自 settings face 文档的 `key`。

P1 的文件清单（`plan:210-212`）只列了 route + 卡片 + locales + status-document，**漏了 `QuotaSettingsScope` 和 `http-settings-scope.ts`**。照这份清单实现，卡片拿不到 `scope.installUmid`，而卡片的渲染守卫是 `scope?.xxx === undefined ? null : ...`（见 `:1966`、`:2873`）——结果是按钮**静默不渲染**，不是报错，最难查。

### 4.2 少了 key 轮换愈合，按钮会「看起来坏了直到刷新」

`http-settings-scope.ts:284-292` 的注释把失败模式写得很清楚：host 插件重载会重新 mint key，此时请求 403；`resetDeviceCodes` 的处理是「重读一次，再重试一次」（`:295-301`）。方案里没有这一条，安装按钮会遇到同样的 403 且不自愈。

另外顺带记一笔：那个路由注册时用的是 `controlKeys().probe`（`src/index.ts:2607`），而路由校验的头名是 `x-qoder-settings-key`（`src/device-reset-route.ts:129`）——**头名是 settings-key，值是 probe key**。这个巧合今天成立，新路由必须照同一方式注册，否则要么 403 要么等于换了个更弱的鉴权，方案里没写这一层。

### 4.3 建议的最小形态

- 新增 `scope.installUmid()`（声明在 `QuotaSettingsScope`，实现放 `HttpSettingsScope`，带 stale-key 重读重试）；
- 状态走现有 status 文档，**删掉** `src/umid-install-route.ts`、`QODER_UMID_INSTALL_PATH` 和那份 route 测试（约 130 行 + 一套安全面测试）；
- CLI `umid install` 保留（`bin.ts` 直接调 `installUmid()`），离线 tgz 通道只在这里；
- 如果确实要留 HTTP 路由（给外部脚本/设置面），那它和 scope 方法必须**共用同一个 handler**，不要写两套。

这样 P1 的体积和风险都实打实少一半，而「卡片能装、CLI 能装、离线能装」三件事都不丢。

### 4.4 后台 job 本身是对的，但要补三处

31MB 下载 + 解压确实不能占着 HTTP 连接，拆 job 合理。补：

1. 进程重启后 `.staging` 残留的清理策略（否则第二次安装可能撞上不完整的目录）；
2. 进度要进 status 文档 ⇒ `QoderWebStatus` 是**三个互不共享字段的 arm**（`signed-in` / `signed-out` / `error`，见 `src/status-paths.ts`），`umid` 字段必须三个都加。否则「未登录」和「上游报错」这两个 arm 恰好是最需要安装入口的时候却看不到它；
3. `alreadyRunning` 返回给卡片后，卡片应当去轮询 status，而不是把它当成一次失败提示。

---

## 5. 其余（不属于你点的三处，但会影响开工）

**D5 的「文案升级」在卡片上不生效。** `QoderPluginCard.tsx:1396-1397` 是按 code 本地化并**忽略 `reason`** 的：

```ts
: result.reasonCode === 'no-client'
  ? t('checkInNeedsClient')
  : result.reason === undefined ? undefined : t('autoCheckInStatusError', {message: result.reason})
```

只要 code 还是 `no-client`，改 transport 里的 message 用户一个字都看不到。要么新增一个 reasonCode（例如区分「组件缺失但可安装」vs「完全没有客户端」）+ 新 locale key，要么干脆让卡片按 §4 的 `umid` 状态字段决定展示（「未安装」+ 按钮），文字反而是次要的。

**D6 漏了参考实现的三个行为。** D6 的参数都对（`NATIVE_IDENTITY_TTL = 1800`、缓存 TTL 默认 0 = 不过期、表决 3+2 上限 5，见 `qoder_accounts.py:187`、`:194-195`、`:476-483`），但漏了：

1. **服务端明确拒绝后的自愈**：`force=True` → 清种子 → 重采（`qoder_accounts.py:837-850`）。理由很硬：同一种子下组件只会返回同一个**被拒**的身份，不清种子等于自愈空转。计划里没有任何「身份被上游拒绝」的恢复路径——考虑到目标的整个动机就是身份有效性，这条建议补。
2. **磁盘 TTL 到期 = 换种子轮换**（`:834-836`、`:842-847`）。计划默认不过期所以少触发，但一旦用户设了 `QODER_UMID_IDENTITY_TTL`，语义就从「重采样」变成了「换设备」，这个差异要写清楚。
3. **组件不可用时回退到已过期的磁盘缓存**（`:862-868`）。这条和 D5 直接冲突：Defender 删掉二进制、或用户清理了 `~/.dsh`，有过真身份的用户会退回 `no-client` 硬失败，而手里的缓存里明明有可用身份。建议明确采用这条。

**P0 的 4 条测试在当前代码上只能跑在 Windows。** `src/qoder/transport/risk-identity.ts:66` 的 `runtimeInfoName` 是**模块级 const**，由真实 `process.platform` 决定，不受 `options.platform` 影响；`installRoots()` 也直接读 `process.env['LOCALAPPDATA']`。要在非 Windows 上测 state.ini 与 `.exe` 名称，P0 必须先把这两处改成可注入——否则方案里那 4 条测试写出来也只能在本机跑。

**P1 规模偏乐观。** 手写 tar（70 行）+ base64 扫描 + 魔数识别 + 自检 + manifest，加上 5 + 5 条测试，320–400 行估计不够，更像是 500 行上下。不影响结论，排期按 4–5 天更稳。

---

## 6. 建议的处理顺序

1. 先改文档三处措辞：D7（把「六个都发」降为开关 + 非劣性 A/B 判据）、Q3（改为 campaign 取 `win32`，推理链路不动）、Q4（默认真实 hostname）；
2. P1 改成「scope 方法 + CLI」形态，删掉新路由那一节，补 `QuotaSettingsScope` / `http-settings-scope.ts` 两个文件；
3. P0 先做可注入化（`runtimeInfoName`、`LOCALAPPDATA`）再写测试；
4. P2 可并行；P3 等真机 A/B，不阻塞前面的合并。
