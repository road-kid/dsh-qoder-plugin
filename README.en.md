# dsh-qoder-plugin

**English** | [简体中文](./README.md)

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH) plugin that brings your **Qoder subscription** models into DSH through a Personal Access Token (PAT). One plugin serves both Qoder product lines — each with its own provider id, credential file and saved catalog, never mixed:

Release notes: [CHANGELOG.md](./CHANGELOG.md).

| Variant | Provider id | Where the PAT is minted |
|---|---|---|
| China (国内版) | `qoder` | qoder.com.cn |
| International (国际版) | `qoder-global` | qoder.com |

Configure only what you use: a variant with no saved PAT shows no model group and never interferes with the other one. Streaming, reasoning content and tool calls ride the plugin's built-in Qoder transport; the conversation loop, compaction and permissions stay Harness-owned.

---

## What this repository is

`dsh-qoder-plugin` is a community plugin for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH): it brings Qoder's models into DSH through a Personal Access Token (PAT), with China and Global served by separate credentials, providers and model catalogs that never mix.

**This plugin's identity** (what you need when installing, troubleshooting, or looking for its data):

| Item | Value |
|---|---|
| Package name | `dsh-qoder-plugin` |
| Profile row id | `qoder-plugin` |
| Data directory | `<profile>/.dsh-qoder-plugin/` |
| HTTP route prefix | `/plugins/dsh-qoder-plugin/*` |
| CLI command | `dsh-qoder-plugin` |

**Why the row id differs from the package name**: DSH keys a plugin-configuration seat by `` `${package name}#${row id}` `` — the package name comes from `package.json`, the row id from the `id` this plugin's patch declares. Spelling both out in full is what keeps that key unique in any profile and clear of other Qoder plugins. See [Settings surface and DSH versions](#settings-surface-and-dsh-versions).

---

## Features

- **PAT: save it and it works** — paste a PAT into the settings card and press *Save*; the token is validated live against that variant's region before anything is written, and the model group appears immediately — no DSH restart. Once signed in, *Replace PAT* (the new token overwrites only after it validates, so a mistyped paste can never strand a working credential) and *Clear PAT* are one click away.
- **Two independent variants** — `qoder` (china) and `qoder-global` (global) keep separate credential files, routes and saved catalogs: a token minted on qoder.com does not work against the China deployment and vice versa.
- **Account pool with automatic failover** — either variant can hold several PATs, listed row by row on the card (order, token tail, account name, plan, remaining credit); one click switches, and any row can be removed. Failover to the next account is **on by default**: when a request cannot reach the upstream on one account (network error, timeout, a stream that breaks before its first byte, an upstream 5xx, a rate limit) the next account in order is tried, at most one pass over the pool. A refused request (the request itself is invalid) does not switch — another account would answer the same thing — and neither does a *queued model*, because that is a fact about the model, not the account. *Advanced* lets you turn the switch off, set **queue wait attempts / queue wait seconds** (when the upstream says the model is queued, sit out the advised window inside that same request, up to N times for up to S seconds each), pick a **routing strategy** (save order, or a hand-ordered list that may mix both variants — the custom order is a *priority*: a new conversation starts on the first usable account of the list, and failures and stickiness rotations continue down it — mixing lists the models enabled in only one variant as an explanation without gating the save), and set **conversation stickiness** (one account serves a conversation until **rounds / requests / minutes** runs out, whichever comes first, and the conversation then **moves on to the next account in the order** — a round counts only when a chat's model output finished, the defaults are 3 rounds / 200 requests / 180 minutes, and 0 in a field turns that bound off).
- **Per-account park checkbox and health** — every account row carries a checkbox; unticking it *parks* the account: nothing is deleted and the token stays, it simply takes no part in routing or failover and the composer panel shows its credits as parked rather than as a spendable balance. Each row also carries a health chip — **normal / queued / limited**. A queued answer marks it queued; two queued answers more than an hour apart on the same account, or three connection failures in a row, escalate it to limited; one accepted chat clears it back to normal.
- **An explanation when the upstream cannot serve a model, instead of a bare error** — when the upstream answers *model queued / not serviceable*, the plugin inserts an explanation into the conversation (reusing the plugin's existing `command/run` + `command/done` notice row, the approach dsh-connect-workbuddy settled on). It states that this is neither a sign-in nor a quota problem, how many seconds the upstream advises waiting, and quotes the upstream's own message, and it raises the possibility of risk control when the same answer recurs inside one outage window. The sentence "waited the advised 30 seconds and it is still not serviceable" appears **only when the wait really happened** — the request actually sat out a full advised window and was refused again afterwards; otherwise it reports only the facts. The same notice is inserted once per turn rather than stacking rows, and a later accepted chat retires it, so it never hangs on screen after the condition is over.
- **Three-tier model catalog (live → saved → fallback)** — the card states where the list on screen came from: *“Model list updated …”* (fetched now), *“Showing the saved model list from …”* (this account's last successful fetch, restored after a restart or a failed fetch), or *“Showing the built-in model list (not yet updated from Qoder)”* (the roster compiled into the plugin). The reason of the most recent failed fetch is shown too, and a *Refresh model list* button sits right there.
- **Per-model context window (staged, one save)** — every model row carries a thick solid Qoder-style slider (tick labels under the track; releasing snaps to the windows the model declares — 200K / 400K / 1M). Dragging is continuous again — nothing quantises under the pointer — and only the release settles on the nearest allowed window. Dragging only edits a local draft — nothing is written per drag tick — and the enable switches plus window changes are committed together by one *Save*; a sticky *“N unsaved change(s)”* bar appears while the draft is dirty and *Cancel* restores the saved state. Requests carry the selected window; a row that declares none falls back to the plugin's conservative built-in default (180K). The two variants keep independent settings.
- **Model visibility toggles** — the *Models* card lists every model of the selected variant in Qoder's own order (no re-sorting — it matches the official GUI), with each model's reasoning efforts and the upstream default labelled. Disabled models are hidden from the DSH model picker, keeping it tidy. Toggles stage locally like the window sliders and are committed by the same *Save*.
- **Daily check-in (automatic + manual)** — 100 Credits are claimable every day. The claim window is **10:00 → 10:00 the next day (UTC+8)**, not a calendar day — the plugin judges "already claimed" strictly by the window: claim at 23:00 and the card still reads *Claimed today* at 00:44, flipping back to *Claim now* only when the next window opens at 10:00. Automatic check-in is **off by default** and lives in *Advanced*; **one** *Check-in time* row drives both the China and the Global scheduler (default 10:00 UTC+8, the moment Qoder resets the campaign, and a custom time moves both window boundaries), and once enabled it also catches up on startup so a missed window is not lost. The account card shows the figures directly — 剩余积分 / 签到状态 / 当前使用 — beside a one-click **一键签到** that claims on both variants. **The international variant requires the Qoder desktop app to be installed on this machine**: the international service only serves the daily campaign to requests carrying a client-minted device risk identity, and when none is found the plugin says so plainly instead of falsely reporting "no campaign today". The China variant has no such requirement.
- **Composer quota readout + credit panel** — a `Qoder · remaining` readout sits in the composer toolbar, and **only while this session uses a Qoder model** (switch to another model and it steps aside rather than occupying shared toolbar space). Clicking it opens a compact panel anchored above the readout: one row for the variant that owns the selected model, with plan tag, *remaining / total*, solid bar, percentage and expiry, a manual refresh and the auto-refresh note. The figures sum what the account really holds (`credits.unlimited` no longer hides real remaining credit). The readout is toggled by a single *Show credits in the composer* switch at the top of *Advanced* — one switch cannot contradict itself the way a per-variant pair could — and is stored as a per-browser preference rather than in the plugin settings file. The old sidebar widget and centre-column quota dashboard are gone; quota lives where it is used. Both share one refresh interval (default 5 min, minimum 1 min).
- **Rate display `x<priceFactor>`** — each model name is suffixed with the Qoder-reported price multiplier (in the model picker: `Some Model · x0.79`, free is `x0.0`), spelled `x<n>` from the catalog's `price_factor`. Whole factors are padded to one decimal (`x1.0`) so a zero rate reads as a rate beside its fractional neighbours; fractional factors keep Qoder's own value (`x0.79`, `x1.6`). Display only — it never changes the request; models whose rate Qoder does not report simply show no suffix. The card's own model list spells the same number as `0.5x`; the value is identical, only the layout direction differs.

---

## A look at the UI

The settings page is three compact cards: **Account** (sign-in state, plan, the remaining-credit / check-in / current-account strip and 一键签到, the variant switch with its whole-variant checkboxes, credential source, replace/clear PAT, and the **multi-account list** — one row per saved account with a park checkbox, switch, remove and a health chip), **Models** (catalog provenance + refresh, per-model switches, context-window sliders, one save) and **Advanced** (show credits in the composer, credit refresh interval, **auto check-in and its time**, the **auto-failover switch**, **queue wait attempts / seconds**, **routing strategy and order**, and **stickiness rounds / requests / minutes**). Nothing is collapsed behind tabs, and no card draws its own chrome. Both the account list and the custom-priority list now print each account's **remaining credit** and **health** (normal / queued / rate-limited) right next to its name, so you can see which seats are usable without opening anything.

The **China / Global** segmented switch sits at the top of the account card, and the checkbox on each tab enables or disables that whole variant's models; under it the summary strip carries the signed-in account's remaining credit, today's check-in state and the current account, with a *Check in all* button on the right:

![The account card: variant switch, remaining credit and check-in](assets/plugin-page.png)

The *Models* card lists models in Qoder's own order, labels their reasoning efforts, and sets each model's context window with a free-sliding slider that snaps on release; changes stay staged until *Save*, and a hidden model disappears from the DSH model picker:

![Model toggles and context windows](assets/model-toggles.png)

The quota readout in the composer toolbar (only while the session uses a Qoder model) opens an anchored panel with the selected variant's remaining credit, plan and expiry:

![Composer quota readout](assets/composer-quota.png)

![Quota panel](assets/quota-panel.png)

---

## Where to find the settings UI

DSH 0.1.7 gathers every plugin's configuration into the **Plugins page** (0.2.x keeps the same seats — verified). Once installed, the plugin appears under **Installed** on that page:

![The installed-plugins group on the Plugins page](assets/plugin-list.png)

Click it to open the package page; the settings body renders **inline** under the package description — that is this plugin's settings UI:

![Settings cards: three compact cards stacked in the page body](assets/plugin-page.png)

The card draws no disclosure shell of its own (the page supplies the title, the icon and the breadcrumb), so it renders the configuration body alone: three settings cards stacked top to bottom, nothing collapsed, no second-level tabs. Dark theme, compact sidebar and keyboard focus come from the DSH theme tokens — the plugin ships no palette of its own, and its buttons reuse the host's three official shapes: *Save* is a filled primary button (near-black on the light theme, near-white on the dark one), *Clear PAT* is the outlined danger button the Plugins page uses for uninstall (without the trash glyph, so the two remain distinguishable), and every other action is the borderless white button used across the other plugins.

> **Can't find the settings?** This plugin's card appears on the *Plugins* page only. There is no entry under *Settings* — plugin configuration has lived on the *Plugins* page since DSH 0.1.7.

---

## Install

Prerequisites:

- DSH core **`>=0.1.7-rc.1 <0.3.0`** (both 0.1.7 and 0.2.x are served; the range is declared in `peerDependencies`, which is the field DSH actually validates at install time — `app-boot`'s compatibility preflight reads peer dependencies only, never `engines.dsh`);
- Node.js `^22.19.0 || >=24.0.0` (per `package.json` engines);
- your own Qoder account and at least one Personal Access Token.

> **Supported DSH range**
>
> This plugin registers on the **plugin-configuration seats** introduced in
> DSH 0.1.7, so it **requires DSH ≥ 0.1.7**. On **0.1.5 / 0.1.6** the **host
> half still works** (models, PAT, catalog, check-in), but **the settings card
> does not appear**, because those versions have no `plugins.row.config` seat.
>
> The cap is `<0.3.0`: diffing the tags `dsh-v0.1.7-rc.2` → `dsh-v0.2.0-rc.1`
> shows **zero changed source files** across all nine packages this plugin
> imports, so 0.2.x runs with no code change. The range lives in
> `peerDependencies` — the field DSH validates at install time.

```sh
# From GitHub
dsh plugin --profile web add github:road-kid/dsh-qoder-plugin
```

Swap the `--profile` value for the profile you use (`web` / `desktop` / `tui`) — data stays inside that profile, so web / desktop / tui never collide.

> **Coexists with other Qoder plugins**: this plugin's package name, row id, route prefix and data directory are all independently named, so it can be installed alongside other Qoder plugins without either configuration touching the other. (Installing *this* plugin twice is a different matter — a profile should carry only one row of the same name.)

> **Upgrading from 0.4.x**: the plugin moved from `dsh-connect-qoder-x` to
> `dsh-qoder-plugin` (package name, module id, route prefix, data directory and
> repository all changed). **Since 0.6.0 the profile row id also moved, from
> `llm-qoder-x` to `qoder-plugin`** — after reinstalling, press *Configure* on the
> row once more; the providers (`qoder` / `qoder-global`) and existing model
> selections are unaffected, and `<profile>/.dsh-qoder-plugin/` stays where it is.
> Re-run the install command above.



### Distribution and market listings

- **Install from GitHub** (above, recommended): the repository ships the built
  `lib/`, so the sources are usable as-is with no build-script permission.
- **Install from npm**: `dsh plugin --profile web add dsh-qoder-plugin` installs
  prebuilt code and needs no build permission (see DSH's
  [publish guide](https://github.com/deepseek-ai/deepseek-harness/blob/main/docs/user/develop/basic/publish.md)).
  The npm package and the GitHub `v*` tags ship from the same commit, so
  `pnpm add dsh-qoder-plugin@<version>` pins a specific release.
- **Why doesn't the market find it by name?** DSH's plugin market searches the
  configured **market indexes** (`index.json`), not the npm registry directly, so
  an npm package that no index lists is still invisible there. To make it
  searchable, publish to npm and generate an index with DSH's
  `plugin-market-generator`, or add your own index URL under "Custom plugin
  markets".

---

## Configuration

### Mint a PAT

- **Qoder (China)**: sign in at qoder.com.cn → account settings → Personal Access Token, then copy it. [Open the page](https://qoder.cn/account/integrations)
- **Qoder Global**: sign in at qoder.com → account settings → Personal Access Token, then copy it. [Open the page](https://qoder.com/account/integrations)

### Save it on the card

Open the settings UI by the path above, paste the PAT into the password field and press *Save* (*“Validating and saving…”* while it runs). The token is validated against that variant's region first, and nothing is saved on a refusal. **The two kinds of refusal are reported apart**: Qoder rejected this token → *“That PAT was rejected — generate a new one in your account settings and try again.”*; Qoder could not be reached (timeout / network / 5xx) → *“Could not reach Qoder to verify the PAT (…). The token was not saved — check the network and try again.”* — a network problem is never blamed on a working token. Do this on both cards to run both groups side by side.

### Environment-variable fallback

For headless setups, the plugin reads an environment fallback **only when no credential file exists**:

| Variant | Environment variable |
|---|---|
| `qoder` (china) | `QODER_CN_PERSONAL_ACCESS_TOKEN` |
| `qoder-global` | `QODER_PERSONAL_ACCESS_TOKEN` |

The precedence is **file > env**: as soon as a valid credential file is saved, a stray environment token stops mattering.

---

## Data & privacy

### File layout

Everything the plugin owns lives in one data directory: `<profile>/.dsh-qoder-plugin/` — credentials at the root, rebuildable caches under `state/` (so “clear the cache” can never touch a credential):

```text
<profile>/.dsh-qoder-plugin/
├── .qoder-auth.json              # China account pool ({version:3, activeId, accounts:[{id, pat, region, savedAt, enabled?}]})
├── .qoder-global-auth.json       # Global account pool (same shape; the two never mix)
├── settings.json                 # refresh interval / check-in time / per-variant enable, own config
├── checkin-status.json           # check-in state (claimed today + when), no ledger
└── state/
    ├── .qoder-catalog.json       # China per-account saved catalog
    ├── .qoder-global-catalog.json
    ├── .qoder-probe.json         # China reasoning-effort probe records
    ├── .qoder-global-probe.json
    ├── .qoder-host-heartbeat.json
    └── .qoder-machine-id
```

`DSH_QODER_DATA_DIR` overrides the directory explicitly.

The two `auth.json` files now hold an **account pool**, not a single token: a
`version: 3` document stores several accounts plus one `activeId` pointer, and an
`enabled` field appears only while an account is parked (*not in use*). Removing
that field restores the account, so "never parked" and "restored" are
indistinguishable on disk — deliberately. Old `version: 2` single-token files
still read fine and upgrade to v3 in place on the next write, without losing the
token already saved.

**Device identity for the international check-in**: the international campaign
only reaches requests that carry a device risk identity, and that identity
cannot be synthesized — it is minted live by the signed `runtime-info` component
that ships inside the installed Qoder desktop client, fingerprinting
**this machine's real hardware/virtualization state**. The three risk headers it
returns (`Cosy-MachineToken/Code/Type`) travel only on the check-in's campaign
and claim requests, are never written to disk and never cached — every check-in
re-mints them on the spot. Without a client installed, the plugin reports the
missing dependency plainly and skips the international check-in (China is
unaffected). Note that the model catalog / chat / image requests keep carrying
the plugin's own stable machine id (`.qoder-machine-id`, a persisted random
UUID), which is separate from and not
derived from the check-in identity above.

---

## Settings surface and DSH versions

Since DSH 0.1.7, plugin configuration is carried by `ui-plugin-manager`'s **keyed slots**: `settings.section` no longer exposes a third-party plugin-settings child, the Built-in plugins page became a tab container that reads only `settings.plugins.tab`, and the old `settings.plugin.item` entry was removed from the `SlotMap`. This plugin therefore registers two slots:

| Slot | Key | Effect |
|---|---|---|
| `plugins.row.config` | `dsh-qoder-plugin#qoder-plugin` | the row gains a *Configure* control that opens this card |
| `plugins.bundle.config` | `dsh-qoder-plugin` | the same card renders inline on the package page |

The row key is `` `${package name}#${row id}` `` — the package name comes from `package.json`, the row id from the `id` this plugin's patch declares. **Spelling both out in full is what keeps that key unique in any profile**, clear of other Qoder plugins.

The card component follows the owner's `view` contract accordingly:

- `view === 'summary'` → the one-liner alone (the card row's description)
- `view === 'page'` → the settings body, drawing **no title and no disclosure shell** of its own

---

## Settings reference

Every control on the settings cards maps to one of the `Config` fields below (the schema in `src/index.ts` is the source of truth; the card only sends values inside the stated range and refuses out-of-range input instead of silently clamping it). Fields that exist per variant are stored separately for China and Global, except the check-in time and the stickiness bounds, which both variants share.

| Setting | Where | Type / range | Default | What it does |
|---|---|---|---|---|
| `variantEnabledCN` / `variantEnabledGlobal` | right of the account tabs | boolean | on | Enables or disables the whole variant's models; a disabled variant's models leave the DSH model picker |
| `disabledModelsCN` / `disabledModels` | Models card, per-row checkbox | string array | empty | Model ids that are switched off; the checkboxes write straight here |
| `useMaximumContextWindowCN` / `useMaximumContextWindow` | Models card | boolean | on | Prefer the largest context window Qoder declares, when alternatives exist |
| `modelContextWindowsCN` / `modelContextWindows` | Models card slider | dict (model id → tokens, ≥1) | empty | Per-model context-window overrides, written when the slider is released |
| `probeConsent` | Models card | boolean | off | Authorises reasoning-effort probes, which send real requests and can spend credit |
| `quotaPollMs` | Advanced: credit refresh interval | number (≥60000 ms) | 300000 | How often the composer credit readout refreshes |
| `autoCheckInCN` / `autoCheckInGlobal` | Advanced: auto check-in | boolean | off | Daily automatic check-in, independently per variant |
| `checkInMinute` | Advanced: check-in time | number 0–1439 (minutes past UTC+8 midnight) | 600 (10:00) | The single check-in time both variants share; it sets the 10:00 → next-day-10:00 claim window |
| `autoFailoverEnabled` | Advanced: automatic account switching | boolean | on | With it off, a failure is returned as-is and no account is switched |
| `queueWaitAttempts` | Advanced: queue wait attempts | number 0–10 | 0 | How many extra times a queued request retries inside the same turn (0 = report the queue fact immediately) |
| `queueWaitSeconds` | Advanced: queue wait seconds | number 1–300 | 30 | How long to wait before each retry; an upstream-advised delay wins over this |
| `routingStrategy` | Advanced: routing strategy | `save-order` \| `custom` | `save-order` | Which order accounts are tried in: save order, or the custom order below |
| `routingOrder` | Advanced: custom priority | string array (account ids) | empty | The custom order, may mix China and Global accounts. Under the custom strategy a **new conversation starts on the first usable account of the list**, and failures plus stickiness rotations continue down it; an empty list falls back to save order |
| `stickinessRounds` | Advanced: session stickiness | number 0–100 | 3 | Switch accounts after this many rounds with one account (0 = unlimited) |
| `stickinessRequests` | Advanced: session stickiness | number 0–10000 | 200 | Switch after this many requests with one account (0 = unlimited) |
| `stickinessMinutes` | Advanced: session stickiness | number 0–1440 | 180 | Switch after this many minutes with one account (0 = unlimited) |
| `sidebarQuotaCN` / `sidebarQuotaGlobal` | — (no UI) | boolean | off | Legacy: the sidebar quota card was removed; the plugin forces these off at boot and keeps them only to stay compatible with older settings files |

The three stickiness bounds are ORed: whichever is reached first switches the account, and setting all three to 0 turns stickiness off.

---

## Troubleshooting

**The card says "not signed in".** That variant has no usable credential. Paste a PAT on the card, or set the matching environment variable (see [environment-variable fallback](#environment-variable-fallback)). China and Global keep separate credential stores — filling in one does not light up the other.

**A message appears in the conversation saying the upstream model is queued.** That is not a sign-in or a quota problem: the upstream is temporarily not serving that model. The plugin inserts the explanation once per turn, naming the delay the upstream advised and quoting its own message. If the same answer recurs inside one outage it also mentions that the account may have been risk-controlled — switch accounts or wait it out. A later accepted chat clears the notice.

**An account is labelled queued or rate-limited.** A queued upstream answer marks 排队; two queued answers more than an hour apart, or three consecutive connection failures, escalate to 限流; the next successful chat resets it to normal. The label only informs you — no account is ever deleted automatically.

**One-click check-in reports a conflict.** The upstream refused the claim with a 409 (already claimed, or not claimable in this window). The plugin re-reads the campaign list and answers truthfully: it says the benefit was already granted, or says explicitly that nothing was granted this time — it no longer reports the 409 as a network error.

**Auto-failover is on but the request never switched accounts.** Switching only happens on account-level failures *before the first byte* reaches the client (connection drop, timeout, truncated stream, upstream 5xx, rate limit, auth rejection). An invalid request would fail on every account, and bytes already sent cannot be recalled — neither switches.

**A settings change does not stick.** Controls only accept values inside their range; out-of-range input is never written. Number fields commit on blur and on Enter, and a rejected commit reverts the control to the stored value.

**The model list is empty or short.** The card states where the current list came from (live fetch / saved catalog / built-in fallback) and offers a manual refresh. A disabled variant, or one with every model unchecked, legitimately shows nothing in the picker.

---

## Development

```sh
pnpm install
pnpm run build      # tsdown → lib/ (host bundle + client bundle)
pnpm test           # vitest run (tests/**/*.spec.ts)
pnpm run test:qoder # node --test (tests/qoder/*.test.ts, the Qoder transport suite)
pnpm run typecheck  # tsc across the host and client tsconfigs
pnpm run check      # typecheck + test + test:qoder + build in one gate
```

> **Known failures:** the full suite is **669** cases, and a run lands at **662 passed / 7 failed**. The failures sit in three files: `tests/adapter.spec.ts` (1 — the code and the test expectation contradict each other), `tests/catalog-lifecycle.spec.ts` (1 — module-level state leaks between cases), and `tests/reasoning-merge.spec.ts` (4 — 5-second-timeout flakes that fire after `boot()`, varying between 4 and 5 per run, which is why the failed count swings 6–7). These three files are long-standing baseline failures that also fail on the release before 1.0.0, so they are not introduced by this version. Separately, `test:qoder` (the node --test Qoder transport suite) is **150/150** green.

### Releasing

The version in `package.json` and the committed `lib/` are the single source of truth; a release is always these four steps:

```sh
pnpm run check                                       # gate: typecheck + test + test:qoder + build
npm version <patch|minor|major> --no-git-tag-version
npm publish --registry https://registry.npmjs.org    # prepack re-runs build; the tarball is the files whitelist
git tag -a v<version> -m "v<version>" && git push origin main --tags
```

- If your `.npmrc` points the default registry at a mirror (e.g. `registry.npmmirror.com`), publishing must name `--registry https://registry.npmjs.org` explicitly — mirrors are read-only and cannot be published to.
- The `prepack` script is pinned to `npm run build`, so publishing from a fresh clone still ships the current `lib/`, matching what the repository commits.
- Write the CHANGELOG entry first, tag afterwards: every `v*` tag maps 1:1 to an npm version, so a rollback is just a checkout of that tag.

---

## Acknowledgements

This project's implementation was informed by the following open-source projects — thanks to their authors:

- [dsh-qoder-connect](https://github.com/masknull/dsh-qoder-connect) — plugin skeleton and the connect mechanism
- [dsh-connect-workbuddy](https://github.com/masknull/dsh-workbuddy-connect) — the shape of the composer readout and its anchored panel; the insertion approach and wording strategy of the *upstream cannot service this model* notice are informed by this project too ([mirror](https://github.com/dingminhua/dsh-connect-workbuddy#readme))
- [dsh-provider-qoder](https://github.com/mo-n/dsh-provider-qoder) — Qoder transport protocol details

All of them are released under the MIT License, as is this project — see [LICENSE](./LICENSE). This is a community adapter — not affiliated with, authorized by, or endorsed by Qoder or DeepSeek, and not an official implementation.

## Disclaimer

- Qoder's endpoints are served by Qoder and may change at any time: they may change, rate-limit or block callers without notice, breaking part or all of this plugin, with no compatibility window to promise.
- For personal learning and research only; this tool drives **your own** Qoder account. Do not use it commercially or beyond reasonable personal use. You are responsible for complying with Qoder's terms of service and for any consequence — account restriction, quota loss, service interruption — of using this project.
- The authors are not liable for any direct or indirect loss arising from use or misuse of this project. The names Qoder, DeepSeek and related marks belong to their respective owners and appear here only to describe compatibility.
