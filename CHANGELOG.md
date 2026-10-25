# Changelog

Entries describe user-visible behaviour; commit messages carry the mechanism.

## 1.0.5 — 2026-10-26

A packaging release. 1.0.4 shipped the README's four screenshots inside the
tarball — 750 kB of a 1 MB package for images no consumer reads — and linked them
from the README by relative path. No runtime behaviour changes.

### Changed — the package ships the icon and nothing else from `assets/`

**`files` listed the whole directory.** The host reads the plugin icon from
`package.json`'s `icon`, so `assets/icon.svg` stays; the screenshots exist for the
README and are no longer published. The tarball drops from 1.0 MB to 275 kB and
from 20 files to 16, unpacked from 1.7 MB to 930 kB.

### Changed — the README's screenshots load from absolute URLs

**npm renders the README from the tarball, so a relative image path resolves to
nothing once the file stops shipping.** The four images now point at jsDelivr's
GitHub endpoint, which serves the same repository files to GitHub and to the
package page alike. All four were verified against the CDN: 200, `image/png`,
byte sizes matching the files in the repository.

### Notes

- `lib/` is committed: run `pnpm run build` after pulling, or the bundle keeps
  reporting the old version.
- 1.0.4 is superseded but stays on the registry, screenshots inside.

## 1.0.4 — 2026-10-26

A polish release: three surfaces got smaller or quieter, and the README's
screenshots were retaken against them. Nothing about settings, credentials or
the wire changed — updating in place needs no migration.

### Changed — the composer readout stops scrolling

**The panel above the composer spent three lines per account and then
scrolled.** Each row stacked the name, the credits, a bar and a caption, and
with the pool's explanation on top a two-account pool already overflowed the
320px bound. The bar and its numbers now share one line, the service state
(尚未观测 / 正常 / 排队 / 限流) rides that same line as muted text instead of a
fourth filled pill, and the two sentences describing the walk moved into the
heading's tooltip — they are reference copy, and the settings card still prints
them in full. The panel is 340px wide, a two-account pool fits without a
scrollbar, and a larger pool scrolls thinly against a raised 360px bound.

**Long account names keep their room.** The health tag moved off the name line,
so the name is no longer squeezed by four neighbours, and a truncated name
carries the full string in its tooltip.

### Changed — the model card's save strip is row scale again

**保存设置 was drawn at 36px beside a 12px list.** It is 24px with an 11px
label now — the height of the rows it belongs to — and 取消 lost its border, so
the strip carries exactly one filled control. The strip's padding, gap and the
hairline above it tightened to match.

### Changed — a new icon

The blue tile with a bolt and a small dot became a bolt inside an open gauge arc.
Credit level is what this plugin is about, and the mark has to survive 16px in
the plugin list. The candidates that lost — a Q-shaped ring, rising bars, a
closed gauge — read as a magnifier, as analytics and as a loading spinner
respectively at small sizes; an open arc with a centred bolt did not.

### Notes

- `lib/` is committed: run `pnpm run build` after pulling, or the old bundle
  keeps drawing the 36px button.
- README screenshots were retaken from this build, in the light theme.

## 1.0.3 — 2026-10-25

A follow-up to 1.0.2. The first fix below is the pool counting rows in the two
credential files while the walk that serves a request counts accounts; the
second is unrelated — a catalog fetch that outlived the plugin.

### Changed — the settings page splits into 设置 and a 高级设置 behind a switch

**The card you configure every day got shorter.** The third card is now 设置 and
holds what a request meets day to day: the composer readout and its interval,
auto check-in and its time, automatic account switching with the routing
strategy and order. Queueing and stickiness moved out.

**They moved into 高级设置, which ships switched off.** The card carries one
switch in its header, off by default; while it is off the queue-retry switch
with its two bounds, the stickiness switch with its three bounds and the
设备码 controls are simply not drawn — so a user who never turns it on gets
the behaviour of the defaults, exactly as before that card existed. The switch
is a browser preference, not a settings-file field: it decides what the page
draws, never how a request is served, so turning it off cannot change behaviour
and turning it back on shows the values exactly as they were left.

**Stickiness is no longer nested under automatic account switching.** It is a
tuning row now, so it stays visible when switching is off, with one line saying
it only takes effect while switching is on — rather than disappearing and taking
its explanation with it.

### Fixed — one credential saved in both files no longer stops the walk

**The same PAT saved twice read as two accounts.** Pasting a PAT into 国内版 and
国际版 — or copying one settings file into the other — put the same credential
in both files, and the pool handed the transport the same account id twice. The
walk treats a repeated id as "already tried" and stops the whole lap there, so
when that account failed, every account *behind* the duplicate went untried:
healthy spares the user had added were never reached, and the request failed
with the first account's error. One credential is now one account no matter how
many files hold it, and the local file's copy is the one that represents it.

**The 「自动切换」 badge counted rows, not accounts.** In the same configuration
the card could claim automatic switching was ready while the pool held exactly
one usable account. The badge now counts accounts, so it agrees with what the
walk can actually reach.

### Fixed — unloading the plugin cancels a catalog fetch it started

A model-list fetch still in flight when the plugin was disposed ran to
completion with nothing left to receive it, holding the upstream socket for up
to the whole fetch timeout. Disposal now aborts it.

### Changed — advanced settings show only what their switches govern

**A control that cannot take effect is no longer on screen.** 高级设置 rendered
every failover, routing, stickiness, check-in and polling control at all times,
so a user who had turned automatic switching off still saw a routing order, and
one who had turned auto check-in off still saw a time for it. The card now nests
each group under the switch that governs it: routing strategy, the custom order
and conversation stickiness appear only while **账号自动切换** is on, the
check-in time only while auto check-in is on, the refresh interval only while
the composer readout is on, and the two queue bounds only while a new **排队重试**
switch is on. The nesting is not cosmetic — the transport already ignores those
settings when their switch is off, and queue retry is now the same kind of
switch: with it off a queued answer is reported at once instead of being waited
out.

**The stickiness bounds stopped repeating their own heading.** The three numbers
used to sit under a second 「会话粘性」 title directly below the switch of the
same name; they are now an indented sub-row of the switch itself, with the
explanation but without the duplicate title.

The sub-rows are also what makes the defaults readable: save order already walks
from one variant's file into the other's, so the default configuration needs no
custom order to reach a mixed pool.

### Changed — queue retry sits above automatic account switching

The two master switches now read in the order a request meets them: **排队重试**
first (is this request retried at all?), then **账号自动切换** (which account
serves the retry). Neither is a sub-menu of the other — retrying in place without
ever moving accounts stays a valid configuration.

### Added — one device-code reset for every saved account

**The card can now reset all saved accounts at once.** A **设备码** card at the
bottom of the settings page clears the saved device code for every account: nothing
is signed out and no PAT is deleted.

### Removed — the sidebar quota card's last remnants

The sidebar quota card itself went away in 0.4.0, but `sidebarQuotaCN` /
`sidebarQuotaGlobal` were still declared as if they did something, and the
settings reference promised they were "forced off at boot". Nothing forced them
and nothing read them. The two fields stay in the schema so older settings files
keep parsing, and the reference now says plainly that they have no effect.

## 1.0.2 — 2026-10-24

The pool was documented as spanning 国内版 and 国际版 from the first release —
the custom priority list says it may mix both, and the card says so in a
warning. It did not. Every account was resolved inside the credential file of
the variant the request arrived on, so a mixed list silently degraded to
"whichever accounts this variant happens to hold". This release makes the pool
actually reach across the two files, and keeps every account signed against the
region it was saved under.

### Fixed — the walk crosses from one variant's file into the other

Save order used to wrap back inside the file it had just finished, so the
second variant's accounts were never tried. The walk now continues into the
other file's first usable row, and only wraps when the whole pool is spent. A
custom order, and a session pinned to an account, resolve their ids across both
files for the same reason: they name an account directly, so refusing the ids
the user ordered made the order inert.

### Fixed — an account is signed with the endpoints of its own region

A Global PAT handed to the China transport used to be exchanged against the
China gateway, which is a guaranteed authentication failure — not a fallback.
The credential exchange, the chat endpoint, the image uploader and the token
heal now all follow the account's own region, so a request that fails over from
a China seat to a Global seat is answered by the Global service. Nothing writes
an account's region: the file's own stamp stays authoritative.

### Fixed — a cross-variant switch sticks in the file that owns the account

Adopting a failover account used to activate it in the local file only, where
the id does not exist; the failure was logged and the pointer never moved, so
the card's "current account" and every later catalog and credit read stayed on
the account that had just failed. Adoption now lands in the file that stores
the account.

### Fixed — the health chip and the auto-failover badge describe the whole pool

Health was tracked per variant, so a failure recorded while a China seat was
being walked never reached the Global card that displays that account — three
consecutive failures left the chip reading 正常. One ledger now serves the pool;
account ids are one-way hashes of the token, so they cannot collide. The
"automatic switching" badge likewise counted one file, which made a pool split
one seat per variant read as idle; it now counts every seat in the pool.

### Fixed — the unified card keeps the other variant fresh

The card only polled the variant it was showing, so after a failover moved
traffic into the other file that tab's credits and health labels froze at
whatever they were when the card first mounted. Both variants are now polled,
on the same interval and the same timer.

## 1.0.1 — 2026-10-23

A repair release for the account pool. Everything below is about the same
thing: which account serves a request, and whether the settings that describe
that choice take effect.

### Fixed — stickiness and rotation now actually move

**The rotation never happened.** The round bound counted a chat only if the
caller kept reading the stream to its end; the HTTP layer in front of the
transport stops at the terminating chunk, so the counter was never reached and
a conversation stayed on the same account no matter how the bounds were set. A
round is now counted at that terminating chunk, which is the moment the model
output is complete. The regression test drives the same consumption shape the
HTTP layer does, so this specific mistake cannot come back silently.

**The quarantine ladder was dead with it.** The same unreachable line held the
"this account served a request, clear its penalty" and "the account we blamed
has been replaced by one that works, record the failure" bookkeeping. Nothing
ever recorded a penalty, so rate-limit cooldowns never engaged and a failing
account was retried as though it were healthy. Both now run at the same
terminating chunk.

**Stickiness ignored the custom order.** Reaching a stickiness bound moved the
conversation along the *saved* order even when a custom priority order was
configured. It now uses the same walk order as a failure, so a custom order
means one thing everywhere.

**A new conversation ignored the custom order.** Under the custom strategy a
conversation started on whatever account was active and only consulted the list
once something failed — which is why a carefully ordered list looked inert. A
new conversation now starts on the first usable account of the order. Save
order, which states no priority, still starts on the active account.

### Changed — stickiness defaults for a small pool

`轮数 / requests / minutes` now default to larger, configurable bounds. A round
is one model output, so the old default of one rotated the account after every
single answer — which defeats the point of a priority order and loses the
upstream prompt cache on every message. The new defaults let a whole turn with a
few tool calls finish on one account, while a small pool still rotates within a
session. Existing settings files that do not name a field pick up the new
default; a stored value is untouched.

### Fixed — `plan` and `quota` reads send the same headers as `status`

Two of the three metadata calls went out with a thinner set of headers than
`status` did, so the service treated them differently. All three now send the
same set.

### Fixed — saved accounts agree on one device code across profiles

The value came from a per-profile file, so each DSH profile reported a different
device code. It is now one host-level value, which is also what the Qoder desktop
client uses.

### Fixed — cooldown skips are visible in the log

Starting a request on a different account because the intended one is cooling
down or busy now logs the ledger's view of the skipped account, including when
it becomes eligible again. Before, the request simply started elsewhere.

## 1.0.0 — 2026-10-22

The first stable release. It bundles the four capability rounds since 0.6.0 —
the account pool, the upstream not-serviceable notice, automatic account
failover, and per-account pricing — plus the settings face that shapes them, and
it is the first version whose documented behaviour is covered end to end by the
test suite.

### Added — account pool, upstream notice, automatic failover, and the settings that shape them

Everything below applies to **both** variants (国内版 and 国际版) and to both
surfaces that read them: the settings card and the composer credit panel.

- **Multiple PATs per variant, with switching.** The credential files now hold an
  account pool (`version: 3`, with an `activeId` pointer) instead of one token;
  `version: 2` files are read as a single account and upgraded in place on the
  next write, so an existing install keeps its token. The account card lists
  every saved account — order, token tail, account name, plan, remaining credit
  — each with *switch* and *remove*. Saving a token that is already in the pool
  updates that row instead of duplicating it. Removing the account in use moves
  the pointer to the next one; removing the last one signs out.
- **A notice, in the conversation, when the upstream cannot serve a model.**
  When Qoder answers *model queued / not serviceable* (the `10605` /
  `RESOURCE_LIMIT` family, whether it arrives as 200, 401 or 403), the plugin
  inserts an explanation where the user is looking — reusing its existing
  `command/run` + `command/done` notice row, the insertion approach
  [dsh-connect-workbuddy](https://github.com/dingminhua/dsh-connect-workbuddy#readme)
  settled on. It says this is neither a sign-in nor a quota problem, names the
  delay the upstream advises, quotes the upstream's own message, and adds a
  second line of guidance only when the same answer recurs inside one outage
  window. The sentence claiming a wait appears only when the request really
  sat out the advised window and was still refused. One notice per turn, not
  a stack; a later accepted chat retires it.
- **Automatic switch to the next account.** On a connection-level failure
  (network error, timeout, a stream that breaks before its first byte, upstream
  5xx, rate limit) the request advances to the next account in order and retries
  — at most one pass over the pool, never after the first byte has reached the
  client. A refused request and a queued model do not switch: another account
  would answer the same thing, and the queue is a fact about the model.
  `enabled() === false`, or a single-account pool, reproduces the old
  behaviour exactly.
- **Per-account park checkbox and health chip.** Unticking an account's checkbox
  parks it — the token stays, nothing is deleted, but it takes no part in the
  save-order walk, the custom routing order or a re-resolved pinned session, and
  the composer panel shows its credits as parked instead of as a spendable
  figure. Each row shows **正常 / 排队 / 限流**: a queued answer marks it queued;
  a second queued answer more than an hour later, or three consecutive failures,
  escalates to limited; an accepted chat clears it.
- **Advanced settings for the walk.** An *auto-failover* switch, *queue wait
  attempts* (0–10) and *queue wait seconds* (1–300, default 30), a *routing
  strategy* (save order, or a custom order that may mix both variants — mixing
  lists the models enabled in only one of them as an explanation, without
  gating the save, and an account whose variant cannot serve the requested
  model is simply skipped), and *conversation stickiness* in rounds (0–100),
  requests (0–10000) and minutes (0–1440).
  All of them are read live on every request: a settings write never re-mints
  the transport, and a captured value would freeze at whatever the file held at
  startup.
- **Stickiness rotates the conversation, it does not lock it.** One account
  serves a conversation until any of the three bounds is spent; the next request
  in that conversation then starts on the **next account of the walk order**
  rather than on the same account forever, which is what "固定用同一个账号" used
  to do in practice. A round is one chat whose model output was consumed to the
  end — a failed request never counts, so a flapping account cannot spend the
  bound for the account that replaced it.

### Fixed — 国内版 one-click check-in reporting a raw 409

`一键签到` on the China variant could surface
`Failed to execute Qoder ClaimCampaign with status 409.` A 409 from
`ClaimCampaign` is the upstream refusing the write — the benefit is already
accounted for or the window has moved — not a transport failure, so the result
is now re-read into a truthful state and reported as such instead of as an error
string. If the claim did land, the card says so; if it did not, it says that too.

### Fixed — session affinity never reached the transport

Conversation stickiness needs the host's session id, and it was being dropped
before the wire: the adapter did not ask for it and the shim did not forward it.
The adapter now sets `sendSessionAffinityHeaders`, the shim forwards
`x-session-affinity` (or a bare `session_id`) into the upstream request, and the
transport can finally pin a conversation to one account.

### Fixed — settings controls that silently refused input

Several controls on the settings card could not be changed: the three 会话粘性
fields (轮数 / 请求次数 / 分钟), the queue-wait and refresh-interval numbers, and
the toggles and routing-strategy select beside them. The panel mounted a *second*
settings store that no control wrote through, so a switch flipped back and a
typed number vanished on blur — the values on screen were never the values being
saved. The panel now edits the same store the page serves, so every control on
both the main card and the 积分设置 card reads and writes one document; number
fields commit on blur as well as on Enter, and a rejected value reverts to what
is stored instead of pretending it took.

### Added — remaining credit and account status on every account row

The account list and the 自定义优先级 rows now carry the same three facts next to
each account name: its remaining credit (or a dash when the read failed), its
service state (正常 / 排队 / 限流, and 已停用 for a parked account), and — in
the routing list — its variant. A parked account is never labelled healthy,
because the walk skips it while the label would still say 正常.

### Changed — daily check-in sits above the failover policy

The two check-in rows (自动签到 and 签到时间) moved above 账号自动切换 on the
advanced card. Check-in is a once-a-day housekeeping action; the rows below it
change how a running conversation is served. Reading the card top to bottom now
puts the routine first and the routing policy second.

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
  summary, and multi-account automatic switching needs a different bookkeeping
  shape.
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

The international service only serves the daily 100-Credit campaign to a machine that
has the Qoder **desktop client** installed. The plugin sent a value of its own
instead, so the service answered HTTP 200 with a campaign list that never contained
the daily benefit — which surfaced as "no campaign today" and an unusable *Claim
now* button. The plugin now takes what it needs from the installed client and sends
it on both the campaign and the claim request.

- Requires the Qoder desktop client installed locally. When it is missing, the card
  says so plainly (`每日签到需要本机安装 Qoder 桌面客户端` / "needs the Qoder desktop
  app") instead of blaming the account. The China variant never needed the
  desktop client and is unaffected.
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
