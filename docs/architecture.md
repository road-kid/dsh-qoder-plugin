# Architecture

This document describes how `dsh-qoder-plugin` is put together for a curious user or a
new contributor: what runs where, what each half owns, and what lives on disk.

## What the plugin is

`dsh-qoder-plugin` connects [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH) to
Qoder models using a Personal Access Token (PAT) that you paste in yourself. It
exposes Qoder's models to DSH as a normal provider, so they appear in the model
picker next to every other provider and can be used in any conversation.

Two independent model groups are shipped:

| Provider id     | Product                    | Region        |
| --------------- | -------------------------- | ------------- |
| `qoder`         | Qoder (China / 国内版)      | China         |
| `qoder-global`  | Qoder Global (国际版)       | International |

They are separate providers with separate credentials, catalogs and settings:
signing in to one does not sign you in to the other, and either can be disabled
alone.

## Where it sits

The plugin has two halves, both loaded by DSH itself:

```
DSH host process
├─ cordis.patch.yml  ── adds profile row "qoder-plugin"
│   └─ dsh-qoder-plugin  (host half, src/index.ts)
│       ├─ credential store ............... <profile>/.dsh-qoder-plugin/
│       ├─ model catalog (live → saved → built-in)
│       ├─ loopback endpoint (127.0.0.1) ── Qoder transport ──▶ Qoder
│       ├─ daily check-in scheduler
│       └─ HTTP routes under /plugins/dsh-qoder-plugin/*
└─ web client bundle  (src/client/index.tsx)
    ├─ settings card (Plugins page, inline)
    └─ composer quota readout (composer input row)
```

The host half is a Cordis plugin inserted by `cordis.patch.yml`; the browser half is a
separate client entry point served by the web UI. They share one type module and the
plugin's HTTP routes, but never a process.

## Package facts

| Fact                | Value                                                  |
| ------------------- | ------------------------------------------------------ |
| Package name        | `dsh-qoder-plugin`                                     |
| Profile row id      | `qoder-plugin`                                         |
| HTTP route prefix   | `/plugins/dsh-qoder-plugin/*`                          |
| CLI command         | `dsh-qoder-plugin`                                     |
| Data directory      | `<profile>/.dsh-qoder-plugin/`                          |
| Client entry point  | `./client` → `lib/client.js`                           |

## Host side

The host half owns everything that touches the network or the disk.

**Credentials.** Each provider keeps its own pool of PATs in the data directory,
sourced from the settings card, an environment variable, or the CLI. There is no
sign-in flow, no refresh token and no expiry — a PAT is valid until you revoke it
at Qoder. Tokens are validated before they are saved, so a typo fails immediately
instead of at the first request.

**Model catalog.** On startup the plugin asks Qoder for the models the account can
use. The catalog therefore has three states, in priority order:

| Source     | Meaning                                                            |
| ---------- | ------------------------------------------------------------------ |
| `live`     | Fetched from Qoder during this session.                            |
| `saved`    | Last successful answer, kept on disk for the next start.           |
| `fallback` | Built-in roster used before the first successful fetch, or while signed out. |

The built-in roster keeps the provider usable while the first fetch is in flight or
the endpoint is unreachable; it is not a promise about Qoder's current offering.

**Context windows.** Each model declares an input budget. The settings card can ask
for the largest window the upstream advertises instead of the default one; when
that maximum is larger than the model's own window, the catalog reports the larger
value and keeps the default around for reference.

**Streaming chat.** The provider is registered through DSH's LLM service and points
at a loopback endpoint bound to `127.0.0.1` only; the adapter hands each request body
to the Qoder transport, which translates it into Qoder's chat protocol and streams
tokens back. The endpoint accepts only loopback `Host`/`Origin` headers, requires a
JSON content type for chat, and requires a per-process secret held in memory — so a
stray local process cannot use your credentials just by reaching `127.0.0.1`.

**Quota.** The card and the composer readout show the account's plan and credit
balance, refreshed periodically and on demand.

**Daily check-in.** Qoder awards a daily benefit that has to be claimed. The plugin
schedules that claim once a day, catches up if DSH was not running at the scheduled
moment, and remembers the outcome so it does not claim twice. It is off by default.

**Multi-account handling.** A provider can hold more than one PAT — a personal
account and a work account, for example — and you can switch the active one from
the card. A few optional scheduling options exist for people who would rather the
plugin pick the account for them; none are required for normal use.

## Client side

The browser half renders UI and nothing else — no credentials, no upstream calls.

**Settings card.** The card is rendered inline on the Plugins page through two slots:

| Slot                    | Key                              |
| ----------------------- | -------------------------------- |
| `plugins.row.config`    | `dsh-qoder-plugin#qoder-plugin`   |
| `plugins.bundle.config` | `dsh-qoder-plugin`                |

The first key is the `<package name>#<row id>` form DSH uses to attach a component
to a specific profile row; the second covers the bundle-level entry. Both mount the
same component, so the card looks identical wherever DSH decides to place it.

**View contract.** The card receives `view: 'summary' | 'page'`. In `summary` mode it
draws a one-line status, because that is all the row list gives it. In `page` mode it
draws the full body and no title, icon or breadcrumb — the owning page already
provides that chrome. A card that draws its own heading ends up with two.

**Composer quota readout.** A chip in the composer's input row shows the active
provider's remaining quota and opens a panel with details. It reads the same status
document as the card and hides when the provider is signed out.

**Theming.** The client injects one stylesheet built entirely from DSH theme tokens
(`--dsw-alias-*`, `--dsw-radius-*`, `--dsw-font-*`, `--dsw-elevation-*`). No literal
colours, no theme selectors: light and dark follow the host. Class names are
prefixed so they do not collide with other plugins injecting global CSS.

## Local data

Everything the plugin writes lives under one directory:

```
<profile>/.dsh-qoder-plugin/
├─ credentials per provider      ← your PATs; never uploaded anywhere but Qoder
├─ state/                        ← saved catalogs and status snapshots
└─ check-in bookkeeping          ← last claim attempt and its outcome
```

The split that matters is **credentials vs. cache**: credentials are the only
irreplaceable files, and everything else is rebuildable — delete it and the plugin
re-fetches what it needs on the next start. `DSH_QODER_DATA_DIR` moves the whole
directory, which is useful for tests and for keeping DSH profiles apart.

Credentials never leave the machine except to Qoder itself. There is no telemetry
and no plugin-operated server in the path: the host half talks to Qoder and to the
local DSH process, and to nothing else.

## Compatibility

- **DSH `>= 0.1.7 < 0.3.0`.** 0.1.7 introduced the plugin settings slot the card
  needs; 0.3.0 has not been validated against this plugin.
- The range is declared in `peerDependencies`, which is the field DSH actually
  validates at install time. `engines.dsh` is documentation for humans and is not
  read by the compatibility check.
- **Node.js `^22.19.0 || >= 24.0.0`**, per `engines.node`.

On DSH 0.1.5/0.1.6 the host features still work but the settings card does not appear —
those versions have no plugin configuration slot — so configure from the CLI or env.

## Lifecycle

**Load.** DSH applies the profile row, which calls the plugin's `apply()`. The plugin
builds one runtime per enabled provider: it starts the loopback endpoint, registers
the provider and its settings directory entry, wires the status routes, and starts
the check-in scheduler. A provider that fails to start is logged and skipped — the
other one keeps working.

**Unload.** When the plugin's fiber is disposed — DSH shutting down, the profile row
being removed, or a configuration write hot-reloading the entry — the plugin tears
down in order: routes are unregistered, in-flight work is cancelled so a disposed
fiber never leaves a request open, the check-in scheduler is disposed, and the
loopback endpoint is closed. Nothing is left listening and nothing is left scheduled.
Configuration writes also reload the plugin — DSH reconciles the profile tree on every
write — so the plugin keeps its in-process control keys at module scope and a reload
does not invalidate the keys an open browser tab is holding.
