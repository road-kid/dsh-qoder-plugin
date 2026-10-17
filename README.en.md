# dsh-connect-qoder-x

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

`dsh-connect-qoder-x` is a community plugin for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH): it brings Qoder's models into DSH through a Personal Access Token (PAT), with China and Global served by separate credentials, providers and model catalogs that never mix.

**This plugin's identity** (what you need when installing, troubleshooting, or looking for its data):

| Item | Value |
|---|---|
| Package name | `dsh-connect-qoder-x` |
| Profile row id | `llm-qoder-x` |
| Data directory | `<profile>/.dsh-connect-qoder-x/` |
| HTTP route prefix | `/plugins/dsh-connect-qoder-x/*` |
| CLI command | `dsh-connect-qoder-x` |

**Why the row id differs from the package name**: DSH keys a plugin-configuration seat by `` `${package name}#${row id}` `` — the package name comes from `package.json`, the row id from the `id` this plugin's patch declares. Spelling both out in full is what keeps that key unique in any profile and clear of other Qoder plugins. See [Settings surface and DSH versions](#settings-surface-and-dsh-versions).

---

## Features

- **PAT: save it and it works** — paste a PAT into the settings card and press *Save*; the token is validated live against that variant's region before anything is written, and the model group appears immediately — no DSH restart. Once signed in, *Replace PAT* (the new token overwrites only after it validates, so a mistyped paste can never strand a working credential) and *Clear PAT* are one click away.
- **Two independent variants** — `qoder` (china) and `qoder-global` (global) keep separate credential files, routes and saved catalogs: a token minted on qoder.com does not work against the China deployment and vice versa.
- **Three-tier model catalog (live → saved → fallback)** — the card states where the list on screen came from: *“Model list updated …”* (fetched now), *“Showing the saved model list from …”* (this account's last successful fetch, restored after a restart or a failed fetch), or *“Showing the built-in model list (not yet updated from Qoder)”* (the roster compiled into the plugin). The reason of the most recent failed fetch is shown too, and a *Refresh model list* button sits right there.
- **Per-model context window (staged, one save)** — every model row carries a thick solid Qoder-style slider (tick labels under the track; dragging snaps to the windows the model declares — 200K / 400K / 1M). Dragging only edits a local draft — nothing is written per drag tick — and the enable switches plus window changes are committed together by one *Save changes*; a sticky *“N unsaved change(s)”* bar appears while the draft is dirty and *Cancel* restores the saved state. Requests carry the selected window; a row that declares none falls back to the plugin's conservative built-in default (180K). The two variants keep independent settings.
- **Model visibility toggles** — the *Models* card lists every model of the selected variant; disabled models are hidden from the DSH model picker, keeping it tidy. Toggles stage locally like the window sliders and are committed by the same *Save changes*.
- **Daily check-in (automatic + manual)** — 100 Credits are claimable every day. The claim window is **10:00 → 10:00 the next day (UTC+8)**, not a calendar day — the plugin judges "already claimed" strictly by the window: claim at 23:00 and the card still reads *Claimed today* at 00:44, flipping back to *Claim now* only when the next window opens at 10:00. A custom check-in time moves the window boundary with it. Automatic check-in is **off by default** and toggled per variant on the card (its time defaults to 10:00 UTC+8, the moment Qoder resets the campaign); once enabled it also catches up on startup so a missed window is not lost. The *Recent claims* panel lists every credit package you actually hold with its own expiry date — only genuine grants are recorded, and repeat clicks no longer mint phantom rows. **The international variant requires the Qoder desktop app to be installed on this machine**: the international service only serves the daily campaign to requests carrying a client-minted device risk identity, and when none is found the plugin says so plainly instead of falsely reporting "no campaign today". The China variant has no such requirement.
- **Composer quota readout + credit panel** — a `Qoder · remaining` readout sits in the composer toolbar, and **only while this session uses a Qoder model** (switch to another model and it steps aside rather than occupying shared toolbar space). Clicking it opens a compact panel anchored above the readout: one row for the variant that owns the selected model, with plan tag, *remaining / total*, solid bar, percentage and expiry, a manual refresh and the auto-refresh note. The figures sum what the account really holds (`credits.unlimited` no longer hides real remaining credit). The readout can be hidden, or narrowed to one variant, from *Advanced* — stored as a per-browser preference rather than in the plugin settings file. The old sidebar widget and centre-column quota dashboard are gone; quota lives where it is used. Both share one refresh interval (default 5 min, minimum 1 min).
- **Rate display `x<priceFactor>`** — each model name is suffixed with the Qoder-reported price multiplier (in the model picker: `Some Model · x0.79`, free is `x0.0`), spelled `x<n>` from the catalog's `price_factor`. Whole factors are padded to one decimal (`x1.0`) so a zero rate reads as a rate beside its fractional neighbours; fractional factors keep Qoder's own value (`x0.79`, `x1.6`). Display only — it never changes the request; models whose rate Qoder does not report simply show no suffix. The card's own model list spells the same number as `0.5x`; the value is identical, only the layout direction differs.

---

## A look at the UI

The settings page is four compact cards: **Account** (sign-in state, plan, credential source, variant switch, replace/clear PAT), **Check-in** (claim today, recent claims ledger, clear log), **Models** (catalog provenance + refresh, per-model switches, context-window sliders, one save) and **Advanced** (daily auto check-in and its time, refresh interval, readout switches). Nothing is collapsed behind tabs, and no card draws its own chrome.

The *Check-in* card keeps today's claim, the ledger of grants actually received and the clear-log action together:

![Check-in card](assets/checkin-credits.png)

The *Models* card toggles models row by row and sets each model's context window with a slider; changes stay staged until *Save changes*, and a hidden model disappears from the DSH model picker:

![Model toggles and context windows](assets/model-toggles.png)

The quota readout in the composer toolbar (only while the session uses a Qoder model) opens an anchored panel with the selected variant's remaining credit, plan and expiry:

![Composer quota readout](assets/composer-quota.png)

![Quota panel](assets/quota-panel.png)

---

## Where to find the settings UI

DSH 0.1.7 gathers every plugin's configuration into the **Plugins page** (0.2.x keeps the same seats — verified). Once installed, the plugin appears under **Installed** on that page:

![dsh-connect-qoder-x on the Plugins page](assets/plugin-list.png)

Click it to open the package page; the settings body renders **inline** under the package description — that is this plugin's settings UI:

![Package page: description and the inline settings card](assets/plugin-page.png)

The card draws no disclosure shell of its own (the page supplies the title, the icon and the breadcrumb). Two panes carry everything: **Auto check-in** (account, available credit, the claims ledger, and the claim action) and **Models** (model visibility and context windows). The row's own *Configure* control opens the very same card.

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
dsh plugin --profile web add github:road-kid/dsh-connect-qoder-x
```

Swap the `--profile` value for the profile you use (`web` / `desktop` / `tui`) — data stays inside that profile, so web / desktop / tui never collide.

> **Coexists with other Qoder plugins**: this plugin's package name, row id, route prefix and data directory are all independently named, so it can be installed alongside other Qoder plugins without either configuration touching the other. (Installing *this* plugin twice is a different matter — a profile should carry only one row of the same name.)

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

Everything the plugin owns lives in one data directory: `<profile>/.dsh-connect-qoder-x/` — credentials at the root, rebuildable caches under `state/` (so “clear the cache” can never touch a credential):

```text
<profile>/.dsh-connect-qoder-x/
├── .qoder-auth.json              # China PAT ({version:2, pat, region, savedAt})
├── .qoder-global-auth.json       # Global PAT
├── settings.json                 # refresh interval / check-in time and other own config
├── checkin-status.json           # check-in state and the claims ledger
└── state/
    ├── .qoder-catalog.json       # China per-account saved catalog
    ├── .qoder-global-catalog.json
    ├── .qoder-probe.json         # China reasoning-effort probe records
    ├── .qoder-global-probe.json
    ├── .qoder-host-heartbeat.json
    └── .qoder-machine-id
```

`DSH_QODER_DATA_DIR` overrides the directory explicitly.

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
| `plugins.row.config` | `dsh-connect-qoder-x#llm-qoder-x` | the row gains a *Configure* control that opens this card |
| `plugins.bundle.config` | `dsh-connect-qoder-x` | the same card renders inline on the package page |

The row key is `` `${package name}#${row id}` `` — the package name comes from `package.json`, the row id from the `id` this plugin's patch declares. **Spelling both out in full is what keeps that key unique in any profile**, clear of other Qoder plugins.

The card component follows the owner's `view` contract accordingly:

- `view === 'summary'` → the one-liner alone (the card row's description)
- `view === 'page'` → the settings body, drawing **no title and no disclosure shell** of its own

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

> **Known failures:** the full suite is **469** cases, and every run lands at **462–463 passed / 6–7 failed**. The failures sit in three files: `tests/adapter.spec.ts` (1 — the code and the test expectation contradict each other), `tests/catalog-lifecycle.spec.ts` (1 — module-level state leaks between cases), and `tests/reasoning-merge.spec.ts` (5 — 5-second-timeout flakes that fire after `boot()`, varying between 4 and 5 per run, which is why the passed count swings 462/463). These three files are long-standing baseline failures, not introduced by this version. Separately, `test:qoder` (the node --test Qoder transport suite) is **131/131** green.

---

## Acknowledgements

This project's implementation was informed by the following open-source projects — thanks to their authors:

- [dsh-qoder-connect](https://github.com/masknull/dsh-qoder-connect) — plugin skeleton and the connect mechanism
- [dsh-connect-workbuddy](https://github.com/masknull/dsh-workbuddy-connect) — the shape of the composer readout and its anchored panel
- [dsh-provider-qoder](https://github.com/mo-n/dsh-provider-qoder) — Qoder transport protocol details

All of them are released under the MIT License, as is this project — see [LICENSE](./LICENSE). This is a community adapter — not affiliated with, authorized by, or endorsed by Qoder or DeepSeek, and not an official implementation.

## Disclaimer

- Qoder's endpoints are served by Qoder and may change at any time: they may change, rate-limit or block callers without notice, breaking part or all of this plugin, with no compatibility window to promise.
- For personal learning and research only; this tool drives **your own** Qoder account. Do not use it commercially or beyond reasonable personal use. You are responsible for complying with Qoder's terms of service and for any consequence — account restriction, quota loss, service interruption — of using this project.
- The authors are not liable for any direct or indirect loss arising from use or misuse of this project. The names Qoder, DeepSeek and related marks belong to their respective owners and appear here only to describe compatibility.
