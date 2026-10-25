# dsh-qoder-plugin

**English** | [简体中文](./README.md)

Bring your **Qoder subscription** models into [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH). Paste a Personal Access Token (PAT) and Qoder's models show up in DSH's model picker — no browser sign-in flow, and nothing about DSH's own conversation loop, compaction or permissions changes.

China (qoder.com.cn) and Global (qoder.com) are two independent entries: separate credentials, separate model catalogues, separate credit. Configure only the one you use — the other never appears.

![Where the plugin sits in DSH](assets/overview.svg)

## What it does

- **Paste and go** — paste a PAT into the settings card and press *Save*; the token is validated against that region first and only then written, and the models appear in DSH's picker immediately — no restart. *Replace PAT* and *Clear PAT* are one click away, and a new token overwrites the old one only after it validates, so a mistyped paste can never strand a working credential.
- **Two independent variants** — `qoder` (China) and `qoder-global` (Global) keep separate credentials and model catalogues. A token minted on qoder.com does not work against the China deployment and vice versa; the two never mix.
- **Model visibility** — every model of the selected variant is listed in Qoder's own order (no re-sorting), with its reasoning levels and the upstream default labelled. A model you switch off disappears from DSH's model picker right away.
- **Per-model context window** — one thick slider per model, with the windows that model declares ticked underneath. Dragging only edits a local draft, releasing snaps to the nearest allowed window, and the changes commit together with one *Save*.
- **Three-tier model catalogue** — live fetch first; the last saved catalogue when the network or a restart gets in the way; a built-in roster as the final fallback. The card says which one you are looking at, and refreshes in place.
- **Composer credit readout** — while the session uses a Qoder model, a `Qoder · remaining` readout sits in the composer toolbar. Click it for a compact anchored panel with plan, remaining / total, progress and expiry. Switch to another model and it steps aside.
- **Daily check-in** — 100 Credits are claimable every day. The window is **10:00 → 10:00 the next day (UTC+8)**, not a calendar day: claim at 23:00 and the card still reads *Claimed today* after midnight. The account card shows the check-in state and remaining credit, claims in one click, and *Settings* holds an optional automatic check-in (off by default) with one shared check-in time.
- **Multiple accounts** — save several PATs per variant and switch at will, with each account's remaining credit and health shown in the list. Automatic switching to the next usable account is on by default; everything about it lives under *Settings* / *Advanced settings*, and the defaults are meant to be left alone.
- **A plain explanation when the upstream cannot serve a model** — instead of a bare error, the conversation gets a notice saying this is neither a sign-in nor a credit problem, how long the upstream suggests waiting, and what it actually said. It retires itself once a later chat is accepted.
- **Rate display `x<priceFactor>`** — each model name carries the Qoder-reported multiplier (`x0.79`; free reads `x0.0`). Display only — it never changes a request.

## Screenshots

The screenshots show the Chinese dark UI, which is what this machine runs; account names, balances and token tails on the account card are masked.

![Find the plugin in the installed list on the Plugins page](assets/screenshot-plugins-list.png)

![Plugin page header: version, package description and inline docs](assets/screenshot-plugin-page.png)

![Account card: credit, check-in and saved accounts](assets/screenshot-accounts.png)

![Models card: per-model switches, reasoning levels and context windows](assets/screenshot-models.png)

![Settings card: composer readout, refresh interval, automatic check-in and account switching](assets/screenshot-settings.png)

## Install

Prerequisites:

- DSH **≥ 0.1.7** (the settings card relies on the plugin-configuration seats introduced there), up to `< 0.3.0`;
- Node.js `^22.19.0 || >=24.0.0`;
- A Qoder account and at least one personal access token.

```sh
dsh plugin --profile web add dsh-qoder-plugin
```

Swap `--profile` for the profile you use (`web` / `desktop` / `tui`). The profile you install into owns the data directory; profiles stay independent.

Installing from GitHub works with the same command — hand it the repository address: `dsh plugin --profile web add github:<user>/dsh-qoder-plugin`.

> **DSH versions** — on 0.1.5 / 0.1.6 the host side (models, PAT, catalogue, check-in) still works, but **the settings card does not appear**: those versions have no plugin-configuration seats. The supported range is declared in `peerDependencies`, which is what DSH validates at install time.

> **Upgrading from an older release** — this plugin used to be called `dsh-connect-qoder-x`; since 0.6.0 its profile row id is `qoder-plugin`. Re-run the install command above; the data directory stays where it is. If the plugin manager shows a new *Configure* entry, open it once.

## Configure

### Mint a PAT

- **China** — sign in at [qoder.com.cn](https://qoder.com.cn) → account settings → personal access token, then copy it.
- **Global** — sign in at [qoder.com](https://qoder.com) → account settings → personal access token, then copy it.

### Save it on the card

Open the settings surface (next section) and paste the PAT into the password field, then press *Save*. The plugin validates the token against that region before writing anything, and it tells the two failure modes apart: a token Qoder actually rejected, versus **Qoder being unreachable** — a network problem never gets reported as a bad token.

### Environment fallback

When no credential file has been saved, the plugin falls back to an environment variable:

| Variant | Variable |
|---|---|
| `qoder` (China) | `QODER_CN_PERSONAL_ACCESS_TOKEN` |
| `qoder-global` (Global) | `QODER_PERSONAL_ACCESS_TOKEN` |

The file wins over the environment: once that variant has a saved credential, the variable no longer applies.

## Command line (optional)

You can configure everything without the GUI:

```sh
dsh-qoder-plugin status            # credential state and remaining credit
dsh-qoder-plugin pat set <PAT>     # validate and store a token
dsh-qoder-plugin pat clear         # remove the stored token (logout is an alias)
dsh-qoder-plugin catalog refresh   # re-fetch and save the model catalog
dsh-qoder-plugin doctor            # secret-free environment diagnostics
```

`--provider` picks the variant to act on (`qoder` / `qoder-global`, default `qoder`); `status` and `doctor` accept `--json`; `pat set` can also read the token from `--file <path>` or `-` (standard input) so it never lands in your shell history. On DSH versions where the settings card does not appear, this is the only way to configure the plugin.

## Where the settings surface is

Since DSH 0.1.7 plugin configuration lives on the **Plugins** page: open it, click this plugin in the installed list, and the settings body renders inline under the package description. Do not go looking under DSH's own *Settings* — there is no entry for this plugin there.

Four cards, top to bottom:

1. **Account** — China / Global switch, sign-in state, plan, remaining credit and check-in, and the saved-account list (switch / remove / park);
2. **Models** — catalogue provenance and refresh, per-model switches, context windows;
3. **Settings** — show credits in the composer, credit refresh interval, automatic check-in and its time, automatic account switching and routing order;
4. **Advanced settings** (collapsed by default) — queue retry, conversation stickiness, device-code reset. While it is off its rows are not drawn and every setting keeps its saved value; turn it on to change them.

The cards draw no chrome of their own: theme, colours and button shapes all come from DSH, so dark mode and keyboard focus follow the host.

## Data and privacy

- Everything the plugin owns lives under `<profile>/.dsh-qoder-plugin/`: credentials, settings, check-in state, and a rebuildable model-catalogue cache under `state/`.
- `DSH_QODER_DATA_DIR` overrides that location explicitly.
- Credentials stay on this machine and go nowhere except Qoder's own endpoints. The plugin ships no telemetry, collects no usage data, and does not read your conversations for statistics.
- Deleting that directory clears all of the plugin's local state, saved accounts included.

## Troubleshooting

**The card says "Not signed in"** — that variant has no usable credential yet. Paste a PAT, or set the matching environment variable. China and Global are separate credentials: filling in one does not light up the other.

**The conversation shows "Upstream model unavailable"** — your sign-in and your credit are fine; the upstream is not serving that model right now. The notice states the suggested retry time and quotes the upstream message, and it retires itself once a later chat is accepted.

**An account is marked queued or limited** — an upstream queue reply marks it queued; a few connection failures in a row escalate it to limited; one accepted chat clears it back to normal. The label only describes the account — nothing is deleted automatically.

**One-click check-in reports a conflict** — the upstream refused the claim with 409 (already claimed this window, or the window is not open). The plugin re-reads the campaign list and tells you whether credits were actually granted this time.

**The model list is empty or short** — the top of the card says whether the list is live, saved or the built-in fallback, and refreshes in place. If the whole variant is switched off, or every model is disabled, that variant naturally has nothing to show in the picker.

**A settings change does not stick** — controls only accept values inside the allowed range; out-of-range input is not written. Number fields commit on blur, and a refused commit falls back to the saved value.

**Global check-in asks for the Qoder desktop app** — the Global service only offers that campaign to machines with the Qoder desktop client installed. Install it and retry; China has no such requirement.

## Development

```sh
pnpm install
pnpm run build      # tsdown → lib/ (host bundle + client bundle)
pnpm test           # vitest run
pnpm run test:qoder # node --test (Qoder transport suite)
pnpm run typecheck  # tsc: host + client tsconfigs
pnpm run check      # typecheck + test + test:qoder + build
```

Layout and architecture: [docs/architecture.md](./docs/architecture.md). Build, test baseline and release flow: [docs/development.md](./docs/development.md). Release notes: [CHANGELOG.md](./CHANGELOG.md).

## Acknowledgements

This project's implementation was informed by these open-source projects. Thanks to their authors:

- [dsh-qoder-connect](https://github.com/masknull/dsh-qoder-connect) — plugin skeleton and the connect mechanism
- [dsh-connect-workbuddy](https://github.com/masknull/dsh-workbuddy-connect) — shape of the settings card and the composer readout
- [dsh-provider-qoder](https://github.com/mo-n/dsh-provider-qoder) — Qoder transport details

All three are MIT-licensed; this project is too — see [LICENSE](./LICENSE) and [NOTICE](./NOTICE). It is a community adapter, unaffiliated with Qoder or DeepSeek.

## Disclaimer

- Qoder's endpoints are run by its own service and may change at any time; they can be modified, rate-limited or closed to callers, which can break some or all of this plugin. No compatibility window is guaranteed.
- This tool is for personal study and research, driving **your own** Qoder account. Do not use it for commercial resale or anything beyond reasonable personal use. Using it means you accept the consequences — account restrictions, lost credit, service interruptions — and that you comply with Qoder's terms of service.
- The authors accept no liability for direct or indirect damages arising from use or misuse of this plugin. Qoder, DeepSeek and other names are trademarks of their respective owners and appear here only to describe compatibility.
