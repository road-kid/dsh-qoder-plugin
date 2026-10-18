# Changelog

Entries describe user-visible behaviour; commit messages carry the mechanism.

## 0.6.0

### Changed — row id, account summary strip, official-style buttons, snap slider

Follow-up to 0.5.0 from six user reports against the live settings page: the
variant switches lived in the wrong card, the check-in time was duplicated per
variant, the context slider snapped mid-drag, every button was borderless, and
the account card showed no credit or check-in figures.

- **The profile row id is `qoder-plugin`** (was `llm-qoder-x`). The package name
  and the row id now agree, so `plugins.row.config` keys as
  `dsh-qoder-plugin#qoder-plugin`. After reinstalling, press *Configure* on the
  row once more; the provider ids (`qoder`, `qoder-global`) and the existing
  model selections are unchanged.
- **One readout switch.** The 国内版 / 国际版 quota-readout toggles in 高级设置 are
  gone — a single switch cannot contradict itself the way two could. It is now
  called **在对话框显示积分** and sits at the top of 高级设置, above 自动签到.
- **Per-variant enable is back, in the variant switcher.** Each segmented tab
  (国内版 / 国际版) carries a checkbox that turns that variant's models off
  wholesale; its state dot and 自动签到 row follow the checkbox. The whole-variant
  switches that had been dropped from 高级设置 are therefore reachable again.
- **One 签到时间 for both variants** (`checkInMinute`) drives the China and the
  Global scheduler; 高级设置 labels it 签到时间 instead of 签到时间（国内版）.
- **Context slider free-slides, then snaps.** Dragging is continuous again
  (no more quantising under the pointer); releasing — or stopping the keyboard
  step — settles on the nearest window the model allows.
- **Buttons follow the official design system.** 保存/保存设置 is a filled
  primary button (near-black on the light theme, near-white on the dark one)
  and the PAT 清除 control is the outlined danger button the Plugins page uses
  for uninstall (minus its trash glyph, so the two stay distinguishable).
  Everything else is the borderless white button from the other plugins.
- **The account card carries the account summary.** Directly under the sign-in
  row: 剩余积分 (same summation rule as the composer chip), 签到状态 (今日已签到 /
  今日未签到), 当前使用 (the signed-in account name) and a one-click **一键签到**
  that claims on both variants in one batch.
- **Removed — the 使用与签到 card, its grant ledger and the `clear-checkin-logs`
  action.** Per-grant history bought nothing once the account card carries the
  summary; the plugin is heading toward multi-account risk-control
  auto-switching, which needs a different bookkeeping shape.
- **Removed — legacy compatibility shims.** The `checkInMinuteCN` /
  `checkInMinuteGlobal` fields, the 0.1.5 `settings.yaml` import, the automatic
  `.dsh-connect-qoder-x/` data-directory migration and the
  `dsh-connect-qoder-x:readout` localStorage migration are all gone; until 0.6.0
  the plugin had a single user installing it from source, so no shim earned its
  keep.
- **The models pane no longer re-sorts the roster**: it shows the upstream order
  verbatim (which is the official GUI's order) and labels each model's reasoning
  efforts, calling out the upstream default.

**Upgrade from 0.5.0**

1. Re-run the install command:
   `dsh plugin --profile web add github:road-kid/dsh-qoder-plugin` — or, now
   that the package is on npm, `dsh plugin --profile web add dsh-qoder-plugin`.
2. Press *Configure* on the plugin row once — the row key changed with the row
   id, so the old registration is ignored.
3. Nothing in `<profile>/.dsh-qoder-plugin/` moves; the PAT, settings and
   check-in record are read by name.

## 0.5.0

### Changed — renamed to `dsh-qoder-plugin`

The plugin was `dsh-connect-qoder-x`, which collided in spirit with the
unrelated `dsh-connect-qoder` and `dsh-qoder-connect` packages and could not be
found in the plugin market under its own name. It is now **`dsh-qoder-plugin`**
everywhere: npm package name, module registration id, HTTP route prefix
(`/plugins/dsh-qoder-plugin/*`), CLI command (`dsh-qoder-plugin`), data
directory (`.dsh-qoder-plugin/`) and the GitHub repository
(`road-kid/dsh-qoder-plugin`). The profile row id stays `llm-qoder-x` in this
release, so the provider id and existing model selections are unchanged.

**Upgrade from 0.4.x**

1. Remove the old package from the profile (or let the new install replace it):
   `dsh plugin --profile web add github:road-kid/dsh-qoder-plugin`.
2. The plugin moves `<profile>/.dsh-connect-qoder-x/` to
   `<profile>/.dsh-qoder-plugin/` on first use, so the saved PAT and settings
   carry over. If the folder cannot be moved, rename it by hand; otherwise
   re-save the PAT.
3. The per-browser readout switches migrate from the old localStorage key
   (`dsh-connect-qoder-x:readout`) to `dsh-qoder-plugin:readout`.

## 0.4.0

### Changed — quota moved into the composer, settings page compacted, models save in one step

Follow-up to 0.3.1, driven by three user complaints: the quota surfaces were in
the wrong places, the settings page was big and empty, and every model toggle
stuttered because it wrote to the host on each click.

- **Composer quota readout replaces the sidebar cards and the dashboard.** A
  `Qoder · remaining` chip lives in `conversation.input.left` and renders only
  while the session's selected model belongs to this plugin (a non-Qoder model
  leaves the shared toolbar untouched). Clicking it opens a compact panel
  anchored above the chip — the variant that owns the selected model, plan tag,
  remaining/total, solid bar, percent and expiry, manual refresh, auto-refresh
  note — placed with viewport-clamped fixed positioning and dismissed by
  outside click or Escape. The `sidebar.footer.action` widgets, the `main` quota
  panel and their settings toggles are removed; the quota readout keeps one
  shared refresh interval. 高级设置 carries the switches that come back with it:
  one master switch plus one per variant, stored as a per-browser preference
  (a readout is a view, so it does not write to the plugin settings file).
- **Settings page rebuilt as four compact cards.** 账号 (variant switch, status,
  credential row, PAT replace/clear), 签到 (claim today, recent-claims ledger,
  clear log), 模型 (catalog provenance + refresh, model switches, window sliders,
  unified save) and 高级设置 (daily auto check-in + time, refresh interval,
  readout switches). The 可用额度 card, the sidebar toggles and the duplicate
  status block are gone; rows are 36px with 0.5px separators inside 20px cards.
- **Model settings stage locally and save once.** Toggle and window edits build a
  draft and a sticky “N unsaved change(s)” bar; `保存设置` commits the enable /
  disable deltas, one write per changed window, then exactly one status refresh —
  a click never stutters the card, `取消` restores the saved state.
- **Context-window slider rebuilt.** The old invisible range input is replaced by
  a 12px solid fill bar with a rounded handle, tick labels under the track, and
  snapping to the windows the model declares (200K / 400K / 1M): a drag lands on
  a preset, Arrow/PageUp/PageDown walk presets, Home/End pick the ends, and the
  handle follows the pointer through pointer capture with `role="slider"` and
  `aria-valuetext`.
- **Credit figures count what the account really holds.** The live billing
  documents flag `credits.unlimited` while still reporting per-package sizes, so
  trusting the flag alone showed 不限量 next to thousands of remaining credits;
  only `Σ size <= 0` counts as unlimited now, and the panel shows the summed
  remaining / summed size otherwise.
- **Design-system fixes from the visual review.** Refresh becomes a stroke icon
  button, the variant switcher's accessible name is localized, disabled buttons
  and the model/advanced rows no longer drop below readable contrast in dark
  theme, and the plugin page keeps using only `--dsw-*` tokens, role radii,
  0.5px hairlines and the theme focus ring.

## 0.3.1

### Changed — plugin UI rebuilt to the DSH 0.2.1 design language

Every surface now draws from the official theme contract instead of hand-picked
values, and the card structure follows the plugin-page slot contract:

- **Body-only plugin page.** The card no longer paints its own icon, title,
  description or collapse header — the plugin detail page already draws that
  chrome. The page is five settings cards: 账号 / 可用额度 / 使用与签到 / 模型 /
  高级设置.
- **Design tokens throughout.** Colours, typography, radii, hairlines and
  elevation come from `--dsw-*` tokens: 20px settings cards with a 0.5px stroke,
  14/22 row titles and 12/18 descriptions, 0.5px separators, theme focus rings,
  superellipse corners. Literal hex values, off-scale radii (10/14/16px) and
  custom dark-theme selectors are gone.
- **Dark theme fixed.** The sidebar progress bar was black-on-black, the selected
  variant tab rendered as a near-black block, variant checkboxes were unreadable
  and the disabled check-in button was invisible; all four are now token-driven.
- **Typography and voice.** Section headings are localized (使用与签到 /
  高级设置), numbers are tabular, and credit figures share one
  剩余/总量 presentation across the footer card, the page and the dashboard.
- **Interaction rebuilt.** Variant pills are a proper segmented control
  (arrow-key navigation, disabled when that variant is off), the account actions
  are grouped next to the status line, failed credits/catalogue/PAT reads offer an
  in-place retry, and every control has a visible focus ring and aria label.
- **Consistent controls.** Local switch/segmented/button/state-dot/input controls
  reproduce the official geometry (switch 36×20, segmented track 12/4/8, buttons
  H28/H36) without adding a runtime dependency on `ui-primitives`.

## 0.3.0

### Fixed — international (`qoder-global`) daily check-in never offered a claim

The international service only serves the daily 100-Credit campaign to requests that
carry a device risk identity minted by the Qoder **desktop client** on this machine.
The plugin sent a self-generated random UUID in its place (and no `Cosy-MachineCode`
at all), so the service answered HTTP 200 with a campaign list that never contained
the daily benefit — which surfaced as "no campaign today" and an unusable *Claim now*
button. The plugin now drives the installed client's signed `runtime-info` component
to obtain the real identity and sends it on both the campaign and the claim request.

- Requires the Qoder desktop client installed locally. When it is missing, the card
  says so plainly (`每日签到需要本机安装 Qoder 桌面客户端` / "needs the Qoder desktop
  app") instead of blaming the account. The China variant never required this
  identity and is unaffected.
- This was never a regression: the check-in path has no region-specific branch in any
  version, so the international claim did not work on older builds either.

### Fixed — check-in re-offered a claim after midnight, before 10:00

The claim window runs **10:00 → 10:00 the next day (UTC+8)**, not midnight →
midnight. Every "is this already claimed?" test compared calendar dates, so a benefit
claimed at 23:11 looked unclaimed at 00:44: the button went back to *Claim now* and a
scheduled sweep would have spent a second request the service can only refuse. All
three sites — the scheduler's settle test, the record's stored label, and the card's
`today` stamp — now compare the claim window, using each variant's own configured
window opening so they cannot drift apart.

### Fixed — ledger showed phantom claims with wrong timestamps

"最近领取 / Recent claims" recorded a `+100` row for **every** write, including repeat
clicks and scheduled runs that only learned the day was already claimed. Those rows
carry the observation clock rather than a grant instant, so the ledger filled with
entries the account never received, all stamped with the same back-computed expiry.
Now only a genuine grant mints a ledger row; an already-claimed day keeps the original
settlement untouched. A claim already granted by the service also keeps the button
disabled, so the repeat click that produced the noise is no longer invited.

### Fixed — a rejected PAT and an unreachable service reported the same error

`validateApiKey` answered a bare boolean, so "Qoder refused this token" and "we never
got an answer" were indistinguishable, and the card rendered both as *That PAT was
rejected* — sending users to regenerate a credential that had never been judged
whenever the endpoint was slow, offline, or returning 5xx. The two are now separate
outcomes with their own messages, in the card, the settings route and
`dsh-qoder-plugin pat set`.

### Fixed — model-list refresh failures were silent

The route answers a failed refresh with **HTTP 200** and puts the reason in the
response body. The card checked only `response.ok`, so every failure looked like a
success: no message, and the stale model list stayed on screen. The card now reads the
body and shows the reason, and does not repaint over it.

### Changed — price factor `x0` now reads `x0.0`

Whole-number multipliers are padded to one decimal (`x0.0`, `x1.0`, `x2.0`) so a free
model reads as a rate beside its fractional neighbours, and the column keeps a steady
width. Fractional factors keep Qoder's own value (`x0.79` stays `x0.79`) — they are
real quoted rates, not rounded ones. Catalog rows stored before this change pick up
the new spelling on the next model-list refresh.

### Changed — DSH 0.2.x compatibility

The peer and engine ranges capped at `<0.2.0`, which would have had DSH disable this
plugin's row the moment 0.2.0 shipped final (the running `0.2.0-rc.1` already passed,
because prereleases participate in range matching). The ranges are widened to
`>=0.1.7-rc.1 <0.3.0`. Verified, not assumed: diffing the DSH tags `dsh-v0.1.7-rc.2`
→ `dsh-v0.2.0-rc.1` shows **zero changed source files** across every package this
plugin imports, and the 0.1.7 plugin-configuration seats it registers on are the same
seats 0.2.x reads. The code needed no change. `^0.2.0` was deliberately not used: it
rejects the current `0.2.0-rc.1` and would drop 0.1.7 support.

### Fixed — lockfile could not be installed from a clone

`package.json` required the 0.1.7 release candidates while `pnpm-lock.yaml` still
pinned `^0.1.5-rc.1`, so a frozen install — CI's default — failed with
`ERR_PNPM_OUTDATED_LOCKFILE` on 16 mismatched dependencies. Regenerated; the frozen
check passes from a clean directory.

### Added — check-in panel shows what is actually held

The old free-form log table is replaced by a *Recent claims* panel that answers the
question users actually ask — which credit packages do I hold and when does each
expire — listing each grant with its own expiry, plus an expiring-within-3-days
summary. Qoder's own expiry travels from the claim to the card; a grant the service
did not date falls back to the documented 30-day convention rather than a guessed
date. `清空日志 / Clear logs` stays within reach.

### Improved — card content and the DSH 0.1.7 tool-role port

- The card now names the coding plan the credits belong to, and never renders a
  placeholder subscriber name.
- Tool results are ported to DSH 0.1.7's first-class `tool` role
  (`toolCallId` / `isError`) instead of being smuggled inside a `user` message, which
  0.1.7 and 0.2.x no longer read.
- Model list, context-window slider and usage panels were reshaped; dead settings
  surfaces, the redundant card shell and orphaned styles were removed.
- The plugin page now shows the package name `dsh-qoder-plugin` with a description
  covering PAT-based access, dual-region support, model toggles, context windows,
  quota and check-in; the card's own one-liner was rewritten to match.

### Notes for testers

- Install/update requires `pnpm install` (the lockfile changed); rebuild with
  `pnpm run build` — `lib/` is committed, so source changes are invisible until built.
- After updating, refresh the model list once to re-store catalog rows with the new
  price-factor spelling.
- Full suite: **462–463 passed / 6–7 failed** of 469, every run. The failures are
  long-standing baseline cases (`adapter` 1, `catalog-lifecycle` 1, `reasoning-merge`
  4–5 flaky 5-second timeouts). `test:qoder` (the node --test transport suite) is
  131/131 green.
- International check-in can only be verified on a machine with the Qoder desktop
  client installed.
