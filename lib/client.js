window.__ModuleLoader__.load({
	id: "dsh-connect-qoder-x",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		let react_jsx_runtime = require("react/jsx-runtime");
		//#region src/status-paths.ts
		/** Plugin-owned status endpoint consumed by its browser half. */
		const QODER_STATUS_PATH = "/plugins/dsh-connect-qoder-x/status";
		/**
		* Plugin-owned probe control endpoint.
		*
		* Separate from the status route because it accepts writes: the status route's
		* loopback Host/Origin guard protects against a DNS-rebinding *page*, which is
		* not the same as authorizing a state-changing action. This route therefore
		* also requires the in-process key the browser half receives with the status
		* document.
		*/
		const QODER_PROBE_PATH = "/plugins/dsh-connect-qoder-x/probe";
		/**
		* Plugin-owned PAT endpoint, one per variant.
		*
		* A POST here saves (validates and persists) a Personal Access Token, or
		* clears the stored one. Unlike the read-only status GET it is a write —
		* it persists a credential — so it also requires the in-process key the
		* browser half receives with the status document.
		*/
		const QODER_AUTH_PATH = "/plugins/dsh-connect-qoder-x/auth";
		/**
		* The international (Qoder Global) variant's own triple of routes.
		*
		* Kept as separate constants rather than a computed suffix so both halves
		* reference literal strings: the browser bundle and the host bundle are built
		* independently, and a shared expression is one build-config drift away from
		* the desk asking a route the host never mounted.
		*/
		const QODER_GLOBAL_STATUS_PATH = "/plugins/dsh-connect-qoder-x/global/status";
		const QODER_GLOBAL_PROBE_PATH = "/plugins/dsh-connect-qoder-x/global/probe";
		const QODER_GLOBAL_AUTH_PATH = "/plugins/dsh-connect-qoder-x/global/auth";
		//#endregion
		//#region src/client/status-document.ts
		/**
		* Whether a parsed status response really is a status document.
		*
		* A 200 is not a promise about the body: it may be empty, literal `null`, a
		* non-JSON page from a proxy, or an array. Both halves of the browser plugin
		* read the same route, so both must agree on what is valid — storing an
		* unreadable value puts something in state that the next render dereferences.
		*
		* The check is deliberately limited to the discriminator (plus `error`'s
		* `message`, which the error paragraph renders): validating optional fields
		* here would reject documents the host legitimately omits fields from.
		*/
		function isQoderWebStatus(value) {
			if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
			const wrapped = value;
			const status = wrapped["status"];
			if (status === "signed-out" || status === "signed-in") return true;
			return status === "error" && typeof wrapped["message"] === "string";
		}
		//#endregion
		//#region src/client/controls.tsx
		/**
		* The plugin's small in-house control set.
		*
		* Why not import `@deepseek-ai/dsh-client-ui-primitives`? That package renders
		* inside the host shell, where its dependencies are bundled; its published
		* `package.json` lists no runtime `dependencies` (only devDependencies and a
		* cordis peer), so importing it from an out-of-tree bundle works only in the
		* host, and fails in the plugin's own vitest run (`Cannot find package 'clsx'
		* imported from .../dsh-client-ui-primitives/lib/index.js`). A plugin that
		* cannot test what it ships is worse than one that owns three small controls.
		*
		* These controls reproduce the official geometry from ui-primitives
		* (docs/ui-radius.md, docs/web-styling.md): Button md 36px/R12 and sm
		* 28px/R8; a 36x20 switch with a 16px thumb; SegmentedControl with a 4px inset
		* track, R12 outer and R8 segments; 8px state dots; 20px tags; 32px/R12 text
		* inputs. Appearance lives in quota-styles.ts; semantics (roles, aria state,
		* keyboard) live here, so every surface answers the same way.
		*/
		/** Join class names, dropping falsey entries. */
		function cx(...parts) {
			return parts.filter((part) => typeof part === "string" && part.length > 0).join(" ");
		}
		/** Hairline/secondary button; never styled with literal colours. */
		function QdpButton({ variant = "outline", size = "sm", className, type = "button", ...rest }) {
			return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
				...rest,
				type,
				className: cx("qdp-btn", size === "md" && "qdp-btnMd", variant === "primary" && "qdp-btnPrimary", variant === "danger" && "qdp-btnDanger", variant === "dangerQuiet" && "qdp-btnDangerQuiet", variant === "ghost" && "qdp-btnGhost", className)
			});
		}
		/** 36x20 capsule switch; `role="switch"` so assistive tech reads on/off. */
		function QdpSwitch({ checked, onChange, label, disabled, id }) {
			return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
				id,
				type: "button",
				role: "switch",
				"aria-checked": checked,
				"aria-label": label,
				disabled,
				className: "qdp-switch",
				onClick: () => onChange(!checked),
				children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { className: "qdp-switchThumb" })
			});
		}
		/**
		* Segmented control on the official track geometry. Arrow/Home/End move the
		* selection (roving `tabIndex` keeps a single tab stop), and each option is a
		* real `role="tab"` so the existing tests' `aria-selected` assertions keep
		* meaning what they say.
		*/
		function QdpSegmented({ label, value, options, onChange, disabled }) {
			const index = options.findIndex((option) => option.value === value);
			const active = index === -1 ? 0 : index;
			const enabled = options.filter((option) => option.disabled !== true);
			const select = (0, react.useCallback)((next) => {
				if (next !== void 0 && next.value !== value) onChange(next.value);
			}, [onChange, value]);
			const onKeyDown = (event) => {
				if (enabled.length === 0) return;
				const current = options[active];
				const at = current === void 0 ? -1 : enabled.indexOf(current);
				if (event.key === "ArrowRight" || event.key === "ArrowDown") {
					event.preventDefault();
					select(enabled[(at + 1) % enabled.length]);
				} else if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
					event.preventDefault();
					select(enabled[(at - 1 + enabled.length) % enabled.length]);
				} else if (event.key === "Home") {
					event.preventDefault();
					select(enabled[0]);
				} else if (event.key === "End") {
					event.preventDefault();
					select(enabled[enabled.length - 1]);
				}
			};
			return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
				role: "tablist",
				"aria-label": label,
				className: "qdp-seg",
				children: options.map((option) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
					type: "button",
					role: "tab",
					"aria-selected": option.value === value,
					tabIndex: option.value === value ? 0 : -1,
					disabled: disabled === true || option.disabled === true,
					className: cx("qdp-segItem", option.value === value && "qdp-segItemActive"),
					onClick: () => onChange(option.value),
					onKeyDown,
					children: option.label
				}, option.value))
			});
		}
		/** 8px state dot; `label` makes it announced, otherwise it is decorative. */
		function QdpStateDot({ state, label }) {
			return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
				className: cx("qdp-dot", state === "done" ? "qdp-dotDone" : state === "ongoing" ? "qdp-dotOngoing" : state === "warn" ? "qdp-dotWarn" : state === "error" ? "qdp-dotError" : void 0),
				"aria-hidden": label === void 0 ? true : void 0,
				"aria-label": label
			});
		}
		/** 20px read-only capsule for plan/status words. */
		function QdpTag({ tone = "neutral", children }) {
			return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
				className: cx("qdp-tag", tone === "success" && "qdp-tagSuccess", tone === "warn" && "qdp-tagWarn", tone === "error" && "qdp-tagError"),
				children
			});
		}
		/** Single-line text field on the official 32px/R12 geometry. */
		function QdpInput({ className, ...rest }) {
			return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
				...rest,
				className: cx("qdp-input", className)
			});
		}
		/** 28x28 icon-only button; the icon is the consumer's child. */
		function QdpIconButton({ label, className, type = "button", ...rest }) {
			return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
				...rest,
				type,
				"aria-label": label,
				title: label,
				className: cx("qdp-iconButton", className)
			});
		}
		//#endregion
		//#region src/client/quota-merge.ts
		/**
		* Group credit accounts by (packageName, packageEndTime) and sum each group.
		*
		* A missing figure counts as 0 (the user's ruling): a package whose total the
		* upstream did not report contributes nothing to the group's `size` rather
		* than poisoning the bar into "unknown". A group whose summed `size` is still
		* 0 keeps an honest "unknown total" rendering in the card — the merge never
		* invents a denominator. `unlimited` is sticky: one unlimited member makes the
		* whole group unlimited, and its sums are not displayed as a quota.
		*
		* MERGE KEY IS THE NAME ALONE (the user's correction): same-named packages
		* whose expiries differ by seconds (stacked purchase batches) must still be
		* one overview row — keying on the expiry exploded 28 same-named packages
		* back into 28 separate bars the moment the host started reporting real
		* dates. The expiry travels on the group (earliest of the members) for the
		* sort/visibility rules; the itemised per-expiry breakdown lives in the
		* dashboard's table.
		*
		* @param accounts - the status document's per-package credit entries.
		* @returns one group per distinct package NAME, in first-seen order.
		*/
		function mergeCreditAccounts(accounts) {
			const groups = /* @__PURE__ */ new Map();
			for (const account of accounts) {
				const key = account.packageName;
				const existing = groups.get(key);
				if (existing === void 0) {
					groups.set(key, {
						packageName: account.packageName,
						packageEndTime: account.packageEndTime,
						remain: account.remain,
						size: account.size,
						unlimited: account.unlimited === true
					});
					continue;
				}
				existing.remain += account.remain;
				existing.size += account.size;
				existing.unlimited = existing.unlimited || account.unlimited === true;
				if (existing.packageEndTime !== void 0 && account.packageEndTime !== void 0) {
					const a = Date.parse(existing.packageEndTime);
					const b = Date.parse(account.packageEndTime);
					if (!Number.isNaN(a) && !Number.isNaN(b) && b < a) existing.packageEndTime = account.packageEndTime;
				} else existing.packageEndTime = existing.packageEndTime ?? account.packageEndTime;
			}
			return [...groups.values()];
		}
		/** Clamp helper shared by the card's percent math. */
		function clampPercent(remain, size) {
			if (!(size > 0)) return void 0;
			const percent = remain / size * 100;
			if (!Number.isFinite(percent)) return void 0;
			return Math.min(100, Math.max(0, percent));
		}
		/** Parse an upstream expiry string ("YYYY-MM-DD HH:mm:ss") into a timestamp; undefined when unparseable. */
		function parseExpiry(value) {
			if (value === void 0) return void 0;
			const parsed = Date.parse(value);
			return Number.isNaN(parsed) ? void 0 : parsed;
		}
		/** Whether a group is spent (remain 0) and NOT unlimited. */
		function isSpent(group) {
			return !group.unlimited && group.remain <= 0;
		}
		/** Whether a spent group's expiry date has already passed (undated → false: no proof of expiry). */
		function isExpired(group, now) {
			if (!isSpent(group)) return false;
			const expiry = parseExpiry(group.packageEndTime);
			return expiry !== void 0 && expiry < now;
		}
		/**
		* SIDEBAR overview rule (the user's spec, restored after it was wrongly
		* applied to the panel):
		*
		* - A group with credit LEFT (remain > 0, or unlimited) renders.
		* - A SPENT group (remain 0) renders ONLY when EVERY group is spent AND it
		*   is not expired — the account's standing quota whose emptiness is itself
		*   the news. When anything still has credit, spent rows are noise.
		* - An EXPIRED group (spent and its expiry date has passed) renders
		*   NOWHERE, whatever the rest of the account looks like.
		*
		* Applied AFTER the merge so the sums are settled before the test.
		* "Now" is injectable for tests.
		*
		* @param groups - merged groups, in first-seen order.
		* @param now - current timestamp (defaults to Date.now()).
		* @returns the groups to display, in first-seen order.
		*/
		function visibleQuotaGroups(groups, now = Date.now()) {
			const hasCredit = groups.some((group) => group.unlimited || group.remain > 0);
			return groups.filter((group) => {
				if (group.unlimited || group.remain > 0) return true;
				return !hasCredit && !isExpired(group, now);
			});
		}
		/**
		* PANEL detail-table ordering (the user's spec): every row renders — the
		* panel is the itemised ledger — but spent-yet-still-active rows sink to the
		* BOTTOM (lowest priority), and expired rows are dropped entirely. Rows keep
		* their first-seen order within each band.
		*
		* @param rows - per-package rows, unmerged, in first-seen order.
		* @param now - current timestamp (defaults to Date.now()).
		*/
		function sortPackageRows(rows, now = Date.now()) {
			const live = [];
			const spent = [];
			for (const row of rows) {
				const unlimited = row.unlimited === true;
				const expiry = parseExpiry(row.packageEndTime);
				if (!unlimited && row.remain <= 0 && expiry !== void 0 && expiry < now) continue;
				if (unlimited || row.remain > 0) live.push(row);
				else spent.push(row);
			}
			return [...live, ...spent];
		}
		//#endregion
		//#region src/client/quota-settings-store.ts
		let pollIntervalMs = 3e5;
		const toggles = {
			cn: false,
			global: false
		};
		let togglesSnapshot = {
			cn: false,
			global: false
		};
		const signIn = {
			cn: false,
			global: false
		};
		let signInSnapshot = {
			cn: false,
			global: false
		};
		let revision = 0;
		const listeners = /* @__PURE__ */ new Set();
		function bump() {
			revision += 1;
			for (const listener of listeners) listener();
		}
		/** Update the shared poll interval (from the settings document). */
		function setQuotaPollMs(ms) {
			if (Number.isFinite(ms) && ms >= 6e4 && pollIntervalMs !== ms) {
				pollIntervalMs = ms;
				bump();
			}
		}
		/** Read the configured poll interval. */
		function quotaPollMs() {
			return pollIntervalMs;
		}
		/** Update both sidebar toggles (from the settings document). */
		function setQuotaToggles(cn, global) {
			if (toggles.cn !== cn || toggles.global !== global) {
				toggles.cn = cn;
				toggles.global = global;
				togglesSnapshot = { ...toggles };
				bump();
			}
		}
		/** Read the current toggles. */
		function quotaToggles() {
			return togglesSnapshot;
		}
		/** Record a variant's sign-in state from any successful status poll. */
		function noteQuotaSignIn(variantId, signedIn) {
			if (variantId === "qoder" && signIn.cn !== signedIn) {
				signIn.cn = signedIn;
				signInSnapshot = { ...signIn };
				bump();
			} else if (variantId === "qoder-global" && signIn.global !== signedIn) {
				signIn.global = signedIn;
				signInSnapshot = { ...signIn };
				bump();
			}
		}
		/** Read the cached sign-in state. */
		function quotaSignInState() {
			return signInSnapshot;
		}
		/** Subscribe to any flag change; returns the disposer. */
		function onQuotaSettingsChange(listener) {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		}
		/** The current revision — the useSyncExternalStore snapshot value. */
		function quotaSettingsRevision() {
			return revision;
		}
		/** Which variant a status route belongs to, from the route path. */
		function variantOfStatusPath(statusPath) {
			return statusPath.includes("/global/") ? "qoder-global" : "qoder";
		}
		/**
		* The last status document per variant, shared by EVERY quota surface.
		*
		* The sidebar cards and the dashboard each used to fetch independently, so a
		* dashboard refresh updated the panel while the sidebar card kept showing its
		* previous read until its own next tick — two different numbers for one
		* account on one screen. One store, one write path
		* ({@link noteQuotaStatus}), and every subscriber re-renders through the
		* same revision: whatever surface refreshed last, all of them show it.
		*
		* Documents are kept by identity (never mutated), so reference comparisons
		* in useSyncExternalStore selectors stay cheap and stable.
		*/
		const statusDocuments = {
			cn: void 0,
			global: void 0
		};
		/**
		* Publish one variant's freshly fetched status document. Downstream
		* subscribers (both sidebar cards and the dashboard, through whichever
		* observable wraps this store) re-render on the revision bump.
		*/
		function noteQuotaStatus(variantId, status) {
			if (variantId === "qoder" && statusDocuments.cn !== status) {
				statusDocuments.cn = status;
				statusFetchedAt.cn = Date.now();
				bump();
			} else if (variantId === "qoder-global" && statusDocuments.global !== status) {
				statusDocuments.global = status;
				statusFetchedAt.global = Date.now();
				bump();
			}
			noteQuotaSignIn(variantId, status.status === "signed-in");
		}
		/** Read one variant's latest status document. */
		function quotaStatus(variantId) {
			return variantId === "qoder" ? statusDocuments.cn : statusDocuments.global;
		}
		/** When each variant's document was last fetched (per publish, not per read). */
		const statusFetchedAt = {
			cn: void 0,
			global: void 0
		};
		/** Read the time a variant's current document was fetched, if any. */
		function quotaStatusFetchedAt(variantId) {
			return variantId === "qoder" ? statusFetchedAt.cn : statusFetchedAt.global;
		}
		/**
		* Whether ONE variant's shared document is fresh enough to skip a fetch:
		* the user's rule — a click/mount/interval tick within the configured
		* interval of the last successful read reuses the cached document, and only
		* a variant with NO result yet (or a failed read that never landed one)
		* forces the upstream call. The interval is a cache lifetime, not a metronome.
		*
		* A `maxAgeMs` of the poll interval comes from the settings document; a
		* failed last read is NOT tracked here (callers gate failures themselves),
		* because "the last read failed" still means "no usable result".
		*
		* @param variantId - which variant's freshness to test.
		* @param maxAgeMs - the configured poll interval (cache lifetime).
		*/
		function quotaStatusIsFresh(variantId, maxAgeMs) {
			const fetchedAt = variantId === "qoder" ? statusFetchedAt.cn : statusFetchedAt.global;
			const document = variantId === "qoder" ? statusDocuments.cn : statusDocuments.global;
			if (fetchedAt === void 0 || document === void 0) return false;
			return Date.now() - fetchedAt < maxAgeMs;
		}
		//#endregion
		//#region src/client/QuotaSettingsCard.tsx
		/**
		* The shared quota-settings card: one card above the two variant cards that
		* configures both sidebar quota widgets.
		*
		* Like the built-in plugin cards, it registers into the Plugins tab's card
		* list — `settings.plugin.item` on DSH 0.1.5, the shared 《插件设置》 block on
		* 0.1.7, where that list is gone — and writes through the settings face's
		* revision-fenced `set` — the same durable-write path every preference row
		* uses. A toggle commits on click: each click is one explicit user choice,
		* and the scope's ordering makes the last one win, so no staged-draft form is
		* needed for two booleans and a number.
		*
		* The two toggles gate the CN and international sidebar cards respectively;
		* the interval is one shared poll period. Toggles are disabled while their
		* variant is signed out: a quota card for an account nobody is signed into
		* would render an error forever, so the setting waits for a session.
		*/
		/** The default poll interval shown before a value is stored. */
		const POLL_DEFAULT_MS = 3e5;
		/** Floor the schema also enforces; mirrored here for immediate UI feedback. */
		const POLL_MIN_MS = 6e4;
		/** 10:00 UTC+8, the moment the upstream resets the daily campaign. */
		const CHECK_IN_MINUTE_DEFAULT = 600;
		/** Minutes past midnight (UTC+8), split for the two number fields. */
		function splitMinutes(minutes) {
			const safe = Number.isFinite(minutes) ? Math.trunc(minutes) : CHECK_IN_MINUTE_DEFAULT;
			const clamped = safe < 0 || safe > 1439 ? CHECK_IN_MINUTE_DEFAULT : safe;
			return {
				hours: Math.floor(clamped / 60),
				minutes: clamped % 60
			};
		}
		/** Read the section values out of a scope snapshot (defaults when absent). */
		function project(scope) {
			if (scope === void 0) return {
				status: "unavailable",
				writable: false,
				values: {
					sidebarQuotaCN: false,
					sidebarQuotaGlobal: false,
					autoCheckInCN: false,
					autoCheckInGlobal: false,
					checkInMinuteCN: CHECK_IN_MINUTE_DEFAULT,
					checkInMinuteGlobal: CHECK_IN_MINUTE_DEFAULT,
					quotaPollMs: POLL_DEFAULT_MS
				}
			};
			const snapshot = scope.getSnapshot();
			const value = snapshot.value ?? {};
			return {
				status: snapshot.status,
				writable: snapshot.writable,
				values: {
					sidebarQuotaCN: value.sidebarQuotaCN === true,
					sidebarQuotaGlobal: value.sidebarQuotaGlobal === true,
					autoCheckInCN: value.autoCheckInCN === true,
					autoCheckInGlobal: value.autoCheckInGlobal === true,
					checkInMinuteCN: typeof value.checkInMinuteCN === "number" ? value.checkInMinuteCN : CHECK_IN_MINUTE_DEFAULT,
					checkInMinuteGlobal: typeof value.checkInMinuteGlobal === "number" ? value.checkInMinuteGlobal : CHECK_IN_MINUTE_DEFAULT,
					quotaPollMs: typeof value.quotaPollMs === "number" ? value.quotaPollMs : POLL_DEFAULT_MS
				}
			};
		}
		/**
		* Stable-reference projection cache.
		*
		* React's useSyncExternalStore requires getSnapshot() to return THE SAME
		* reference between renders unless the store actually changed. project()
		* builds a fresh object every call, which re-renders forever and crashes the
		* card with React error #185 ("maximum update depth exceeded") — exactly the
		* crash the slot ledger reported. The cache below returns the last built
		* projection until the underlying scope snapshot (or scope identity) changes,
		* which is the only thing the projection actually derives from.
		*/
		let cachedScope;
		let cachedProjection;
		const UNAVAILABLE = {
			status: "unavailable",
			writable: false,
			values: {
				sidebarQuotaCN: false,
				sidebarQuotaGlobal: false,
				autoCheckInCN: false,
				autoCheckInGlobal: false,
				checkInMinuteCN: CHECK_IN_MINUTE_DEFAULT,
				checkInMinuteGlobal: CHECK_IN_MINUTE_DEFAULT,
				quotaPollMs: POLL_DEFAULT_MS
			}
		};
		function stableProject(scope) {
			if (scope === void 0) return UNAVAILABLE;
			const next = project(scope);
			if (cachedProjection === void 0 || cachedScope !== scope || cachedProjection.status !== next.status || cachedProjection.writable !== next.writable || cachedProjection.values.sidebarQuotaCN !== next.values.sidebarQuotaCN || cachedProjection.values.sidebarQuotaGlobal !== next.values.sidebarQuotaGlobal || cachedProjection.values.autoCheckInCN !== next.values.autoCheckInCN || cachedProjection.values.autoCheckInGlobal !== next.values.autoCheckInGlobal || cachedProjection.values.checkInMinuteCN !== next.values.checkInMinuteCN || cachedProjection.values.checkInMinuteGlobal !== next.values.checkInMinuteGlobal || cachedProjection.values.quotaPollMs !== next.values.quotaPollMs) {
				cachedScope = scope;
				cachedProjection = next;
			}
			return cachedProjection;
		}
		/**
		* One toggle row: the official settings-row anatomy — label + description on
		* the left, the control flush right — with the shell's own switch control.
		*/
		function ToggleRow({ label, hint, checked, disabled, disabledHint, onToggle }) {
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: "qdp-row",
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					className: "qdp-rowText",
					children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						className: "qdp-rowTitle",
						children: label
					}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						className: "qdp-rowDesc",
						children: disabled === true && disabledHint !== void 0 ? disabledHint : hint
					})]
				}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
					className: "qdp-rowControl",
					children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(QdpSwitch, {
						checked,
						label,
						disabled: disabled === true,
						onChange: onToggle
					})
				})]
			});
		}
		/**
		* One time row: the moment a variant checks in, as two typeable number fields.
		*
		* Deliberately NOT `<input type="time">`: that control's segments are spinners,
		* and with an IME active (every Chinese/Japanese keyboard) the segments refuse
		* typed digits, leaving only the tiny stepper arrows — unusable for the one
		* thing this row exists to do. Two plain number fields accept typing under any
		* input method; the value is committed on blur or Enter, so a half-typed
		* field never writes a wrong moment to the host.
		*/
		function TimeRow({ label, hint, value, disabled, onPick }) {
			const split = splitMinutes(value);
			const [hourDraft, setHourDraft] = (0, react.useState)(String(split.hours));
			const [minuteDraft, setMinuteDraft] = (0, react.useState)(String(split.minutes).padStart(2, "0"));
			(0, react.useEffect)(() => {
				const next = splitMinutes(value);
				setHourDraft(String(next.hours));
				setMinuteDraft(String(next.minutes).padStart(2, "0"));
			}, [value]);
			const commit = () => {
				const parsedHours = Number.parseInt(hourDraft, 10);
				const parsedMinutes = Number.parseInt(minuteDraft, 10);
				const hours = Number.isFinite(parsedHours) ? Math.min(23, Math.max(0, parsedHours)) : split.hours;
				const minutes = Number.isFinite(parsedMinutes) ? Math.min(59, Math.max(0, parsedMinutes)) : split.minutes;
				const next = hours * 60 + minutes;
				if (next === value) {
					setHourDraft(String(hours));
					setMinuteDraft(String(minutes).padStart(2, "0"));
					return;
				}
				onPick(next);
			};
			const onKeyDown = (event) => {
				if (event.key === "Enter") {
					event.preventDefault();
					commit();
				}
			};
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: "qdp-row",
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					className: "qdp-rowText",
					children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						className: "qdp-rowTitle",
						children: label
					}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						className: "qdp-rowDesc",
						children: hint
					})]
				}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					className: "qdp-rowControl",
					children: [
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)(QdpInput, {
							className: "qdp-inputShort",
							type: "number",
							min: 0,
							max: 23,
							value: hourDraft,
							disabled: disabled === true,
							"aria-label": `${label} — hour`,
							"data-checkin-part": "hour",
							onChange: (event) => {
								setHourDraft(event.target.value);
							},
							onBlur: commit,
							onKeyDown
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							className: "qdp-muted",
							"aria-hidden": "true",
							children: ":"
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)(QdpInput, {
							className: "qdp-inputShort",
							type: "number",
							min: 0,
							max: 59,
							value: minuteDraft,
							disabled: disabled === true,
							"aria-label": `${label} — minute`,
							"data-checkin-part": "minute",
							onChange: (event) => {
								setMinuteDraft(event.target.value);
							},
							onBlur: commit,
							onKeyDown
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							className: "qdp-caption",
							children: "UTC+8"
						})
					]
				})]
			});
		}
		/** The inner controls for sidebar quota settings. */
		function QuotaSettingsContent({ t = (key) => key, scope, signedIn, variant }) {
			const subscribe = (0, react.useCallback)((onStoreChange) => {
				return scope?.subscribe(onStoreChange) ?? (() => {});
			}, [scope]);
			const projection = (0, react.useSyncExternalStore)(subscribe, () => stableProject(scope));
			const liveSignIn = (0, react.useSyncExternalStore)(onQuotaSettingsChange, quotaSignInState);
			const [probe, setProbe] = (0, react.useState)();
			(0, react.useEffect)(() => {
				let disposed = false;
				const probeOne = async (path) => {
					try {
						const body = await (await fetch(path, { headers: { accept: "application/json" } })).json();
						if (disposed || !isQoderWebStatus(body)) return void 0;
						noteQuotaSignIn(variantOfStatusPath(path), body.status === "signed-in");
						return body.status === "signed-in";
					} catch {
						return;
					}
				};
				(async () => {
					const [cn, global] = variant === "cn" ? [await probeOne(QODER_STATUS_PATH), void 0] : variant === "global" ? [void 0, await probeOne(QODER_GLOBAL_STATUS_PATH)] : await Promise.all([probeOne(QODER_STATUS_PATH), probeOne(QODER_GLOBAL_STATUS_PATH)]);
					if (!disposed) setProbe({
						cn: cn === true,
						global: global === true
					});
				})();
				return () => {
					disposed = true;
				};
			}, []);
			if (projection.status === "unavailable") return null;
			const reported = signedIn?.();
			const deriveSigned = (variant, variantId) => {
				if (reported !== void 0) return Boolean(reported[variant]);
				const currentStatus = quotaStatus(variantId);
				if (currentStatus?.status === "signed-out") return false;
				const live = liveSignIn[variant];
				if (probe !== void 0) {
					if (!probe[variant]) return Boolean(live && currentStatus?.status === "signed-in");
					return Boolean(live);
				}
				return Boolean(live && currentStatus?.status === "signed-in");
			};
			const signed = {
				cn: deriveSigned("cn", "qoder"),
				global: deriveSigned("global", "qoder-global")
			};
			const write = (field, value) => {
				if (field === "sidebarQuotaCN" && value === true && !signed.cn) return;
				if (field === "sidebarQuotaGlobal" && value === true && !signed.global) return;
				if (field === "autoCheckInCN" && value === true && !signed.cn) return;
				if (field === "autoCheckInGlobal" && value === true && !signed.global) return;
				scope?.set(field, value);
			};
			const minutes = Math.max(POLL_MIN_MS / 6e4, Math.round(projection.values.quotaPollMs / 6e4));
			const showCN = variant === void 0 || variant === "cn";
			const showGlobal = variant === void 0 || variant === "global";
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [
				showCN ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)(ToggleRow, {
					label: t("quotaToggleCN"),
					hint: t("quotaToggleHint"),
					checked: projection.values.sidebarQuotaCN,
					disabled: !signed.cn,
					disabledHint: t("quotaSignInRequired"),
					onToggle: (next) => write("sidebarQuotaCN", next)
				}) : null,
				showGlobal ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)(ToggleRow, {
					label: t("quotaToggleGlobal"),
					hint: t("quotaToggleHint"),
					checked: projection.values.sidebarQuotaGlobal,
					disabled: !signed.global,
					disabledHint: t("quotaSignInRequired"),
					onToggle: (next) => write("sidebarQuotaGlobal", next)
				}) : null,
				showCN ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)(ToggleRow, {
					label: t("autoCheckInCN"),
					hint: t("autoCheckInHintCN"),
					checked: projection.values.autoCheckInCN,
					disabled: !signed.cn,
					disabledHint: t("quotaSignInRequired"),
					onToggle: (next) => write("autoCheckInCN", next)
				}) : null,
				showCN ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)(TimeRow, {
					label: t("checkInTimeCN"),
					hint: t("checkInTimeHint"),
					value: projection.values.checkInMinuteCN,
					disabled: !signed.cn,
					onPick: (next) => write("checkInMinuteCN", next)
				}) : null,
				showGlobal ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)(ToggleRow, {
					label: t("autoCheckInGlobal"),
					hint: t("autoCheckInHintGlobal"),
					checked: projection.values.autoCheckInGlobal,
					disabled: !signed.global,
					disabledHint: t("quotaSignInRequired"),
					onToggle: (next) => write("autoCheckInGlobal", next)
				}) : null,
				showGlobal ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)(TimeRow, {
					label: t("checkInTimeGlobal"),
					hint: t("checkInTimeHint"),
					value: projection.values.checkInMinuteGlobal,
					disabled: !signed.global,
					onPick: (next) => write("checkInMinuteGlobal", next)
				}) : null,
				/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					className: "qdp-row",
					children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "qdp-rowText",
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							className: "qdp-rowTitle",
							children: t("quotaPollLabel")
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							className: "qdp-rowDesc",
							children: t("quotaPollHint")
						})]
					}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "qdp-rowControl",
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(QdpInput, {
							className: "qdp-inputShort",
							type: "number",
							min: POLL_MIN_MS / 6e4,
							step: 1,
							value: minutes,
							"aria-label": t("quotaPollLabel"),
							onChange: (event) => {
								const mins = Number.parseInt(event.target.value, 10);
								if (Number.isFinite(mins) && mins > 0) write("quotaPollMs", Math.max(POLL_MIN_MS, mins * 6e4));
							}
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							className: "qdp-caption",
							children: t("quotaPollUnit")
						})]
					})]
				}),
				projection.writable === false ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
					className: "qdp-error",
					children: t("quotaSettingsSaveFailed")
				}) : null
			] });
		}
		//#endregion
		//#region src/client/QoderPluginCard.tsx
		/** Qoder status card contributed to Harness Plugin configuration. */
		/** China Qoder; the plugin's primary card and default. */
		const QODER_CN_CARD = {
			id: "qoder",
			titleKey: "title",
			introKey: "intro",
			signedOutKey: "signedOutHint",
			patGuideKey: "patGuide",
			patPlaceholderKey: "patPlaceholder",
			statusPath: QODER_STATUS_PATH,
			probePath: QODER_PROBE_PATH,
			authPath: QODER_AUTH_PATH
		};
		/** International Qoder Global. */
		const QODER_GLOBAL_CARD = {
			id: "qoder-global",
			titleKey: "titleAI",
			introKey: "introAI",
			signedOutKey: "signedOutHintAI",
			patGuideKey: "patGuideAI",
			patPlaceholderKey: "patPlaceholderAI",
			statusPath: QODER_GLOBAL_STATUS_PATH,
			probePath: QODER_GLOBAL_PROBE_PATH,
			authPath: QODER_GLOBAL_AUTH_PATH
		};
		/** Both cards, in display order (China first). */
		const QODER_CARD_VARIANTS = [QODER_CN_CARD, QODER_GLOBAL_CARD];
		const POLL_INTERVAL_MS = 6e4;
		/**
		* Map the status document's state onto the local state-dot vocabulary.
		*
		* `loading` is its own state: before the first response the card knows nothing
		* about the account, so it must not borrow the signed-out grey — that would read
		* as "nobody is signed in" when the truth is "not read yet". The dot itself is
		* rendered by the `QdpStateDot` control, so no colour literals live here.
		*/
		function dotStateOf(status) {
			if (status === "signed-in") return "done";
			if (status === "error") return "error";
			if (status === "loading") return "ongoing";
			return "idle";
		}
		function formatNumber(value) {
			return new Intl.NumberFormat(void 0).format(value);
		}
		function formatPercent(value) {
			return new Intl.NumberFormat(void 0, { maximumFractionDigits: 1 }).format(value);
		}
		/** Date-only formatting for expiries: the day is what a validity window means. */
		function formatDate(ms) {
			return new Intl.DateTimeFormat(void 0, { dateStyle: "medium" }).format(new Date(ms));
		}
		function formatTime(ms) {
			return new Intl.DateTimeFormat(void 0, {
				dateStyle: "medium",
				timeStyle: "short"
			}).format(new Date(ms));
		}
		function formatCycleReset(time) {
			const parsed = Date.parse(time);
			if (!Number.isNaN(parsed)) return formatTime(parsed);
			return time;
		}
		function patSourceText(source, t) {
			if (source === "env") return t("patSourceEnv");
			if (source === "cli") return t("patSourceCli");
			return t("patSourceCard");
		}
		/**
		* One billing package as a labeled progress bar.
		*
		* A package whose allowance the upstream never reported (`size` not positive)
		* has no percentage to state. It must not fall back to 100%: the plugin would be
		* claiming a full quota it knows nothing about, which is the opposite of the
		* honest "remaining N" line printed below it. Unknown size therefore renders the
		* percent slot as unknown copy and an unfilled, indeterminate track.
		*/
		function CreditBar({ label, remain, size, unlimited, packageEndTime, t }) {
			const expiry = packageEndTime === void 0 ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("p", {
				className: "qdp-rate",
				children: [
					t("quotaExpires"),
					" ",
					formatCycleReset(packageEndTime)
				]
			});
			if (unlimited === true) {
				const quotaText = t("unlimitedQuota");
				return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					className: "qdp-group",
					children: [
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: "qdp-label",
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: label }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: quotaText })]
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
							className: "qdp-track",
							role: "progressbar",
							"aria-label": label,
							"aria-valuetext": quotaText
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
							className: "qdp-body",
							children: quotaText
						}),
						expiry
					]
				});
			}
			const sizeKnown = size > 0;
			const detail = sizeKnown ? t("exactRemaining", {
				remain: formatNumber(remain),
				size: formatNumber(size)
			}) : t("creditPackageUnknownSize", { remain: formatNumber(remain) });
			const percent = sizeKnown ? remain / size * 100 : void 0;
			const display = percent === void 0 ? t("percentUnknown") : t("percentRemaining", { percent: formatPercent(percent) });
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: "qdp-group",
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "qdp-label",
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: label }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: display })]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						className: "qdp-track",
						role: "progressbar",
						"aria-label": label,
						...percent === void 0 ? { "aria-valuetext": detail } : {
							"aria-valuemin": 0,
							"aria-valuemax": 100,
							"aria-valuenow": percent
						},
						children: percent === void 0 ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
							className: "qdp-barFill",
							style: { width: `${String(Math.max(0, Math.min(100, percent)))}%` }
						})
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
						className: "qdp-body",
						children: detail
					}),
					expiry
				]
			});
		}
		/**
		* The 额度 section body: account-wide remaining/total headline, the cycle reset
		* time, then ONE progress row per merged credit group.
		*
		* The accounts are merged first (`mergeCreditAccounts`) so a package bought
		* several times reads as one bar with summed figures instead of near-duplicate
		* rows, and filtered through `visibleQuotaGroups` so spent rows stay out of the
		* overview while anything still has credit. A credit read failure renders as an
		* alert with an in-place retry instead of a silent blank: the message travels on
		* the status document's `creditsError`.
		*/
		function QuotaSummary({ credits, creditsError, t, busy, onRetry }) {
			if (creditsError !== void 0) return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: "qdp-alert qdp-alertError",
				role: "alert",
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: t("creditsError", { message: creditsError }) }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
					className: "qdp-actions",
					children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(QdpButton, {
						disabled: busy,
						onClick: onRetry,
						children: busy ? t("refreshing") : t("refresh")
					})
				})]
			});
			if (credits === void 0) return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
				className: "qdp-empty",
				children: t("creditsNoData")
			});
			const groups = visibleQuotaGroups(mergeCreditAccounts(credits.accounts));
			const totalRemain = groups.reduce((sum, group) => sum + group.remain, 0);
			const declaredSize = groups.reduce((sum, group) => sum + group.size, 0);
			const totalSize = credits.totalSize ?? declaredSize;
			const unlimited = credits.unlimited === true;
			const usage = Number.isFinite(credits.total) ? t("creditsUsed", { percent: formatPercent(credits.total) }) : unlimited ? t("creditsUsedUnlimited") : t("creditsNoData");
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [
				/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("p", {
					className: "qdp-totalLine",
					children: [
						t("quotaTotalRemain"),
						" ",
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("strong", {
							className: "qdp-totalValue",
							children: unlimited ? t("quotaUnlimited") : formatNumber(totalRemain)
						}),
						unlimited ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [" / ", totalSize > 0 ? formatNumber(totalSize) : t("quotaUnknownTotal")] })
					]
				}),
				/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
					className: "qdp-totalSub",
					children: usage
				}),
				credits.cycleResetTime === void 0 ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
					className: "qdp-windowReset",
					children: t("cycleResetAt", { time: formatCycleReset(credits.cycleResetTime) })
				}),
				groups.length === 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
					className: "qdp-empty",
					children: t("creditsNoData")
				}) : groups.map((group, index) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)(CreditBar, {
					label: group.packageName,
					remain: group.remain,
					size: group.size,
					unlimited: group.unlimited,
					packageEndTime: group.packageEndTime,
					t
				}, `${group.packageName}-${String(index)}`))
			] });
		}
		/**
		* Context capacity, listed in full.
		*
		* Every model the upstream reports a capacity for, largest first. A one-line
		* summary with the exceptions on hover was tried and rejected: capacity is
		* reference data you scan by model, and hiding most of it behind a hover made
		* the common case (a model you already have in mind) the hard one to look up.
		*
		* Purely a report of the upstream's own numbers — the middle alternatives the
		* upstream lists between the default and the maximum are display-only (the
		* upstream honours the default and the maximum, nothing between), so the only
		* control is the maximum-window preference below, which flips every eligible
		* model between its default and its largest declared window.
		*/
		function formatTokens(tokens) {
			if (tokens >= 1e6 && tokens % 1e6 === 0) return `${tokens / 1e6}M`;
			if (tokens >= 1e3 && tokens % 1e3 === 0) return `${tokens / 1e3}K`;
			return String(tokens);
		}
		/**
		* A credit multiplier, spelled the way Qoder spells it: the number first, then
		* `x` — `0.0x` for a free model, `0.1x`, `0.5x`, `1.4x`.
		*
		* The upstream's own label is `x<n>` (see `normalizeCredits`), but the user
		* reads the rate as a price multiplier ("half price"), and every Qoder surface
		* they compared against prints it after the number. Two decimals are ALWAYS
		* shown, so the free tier reads `0.0x` rather than `0x`: the column then has
		* one decimal width throughout, and `0.0x` says "a rate that happens to be
		* zero" where a bare `0x` reads like a different kind of value.
		*/
		function formatRate(factor) {
			return `${factor.toFixed(1)}x`;
		}
		/**
		* 「使用与签到」section body: the claim ledger beside the claim action.
		*
		* The credit breakdown moved out of this panel into its own 额度 section — one
		* surface answers one question. What remains is the check-in half: the ledger
		* of claimed grants on the left and today's claim CTA (with the next automatic
		* run) on the right. `qdp-twoUp` falls back to one column on narrow pages.
		*/
		function UsageCheckInPanel({ checkIn, t, busy, checkingIn, checkInNotice, autoCheckIn, onCheckIn, clearingLogs, logsDisabled, onClearLogs }) {
			/**
			* Today's benefit is already in — whether this process granted it or merely
			* found the upstream reporting it as claimed.
			*
			* `already-claimed` must count: the upstream answers that way for every later
			* request on a claimed day, so treating only `claimed` as "done" re-armed the
			* button and invited the repeat click that used to append a phantom ledger
			* row (see the ledger's filter below).
			*
			* The DATE must count too, and this is the part that was missing. `checkIn`
			* is the persisted record, not a live reading: a `claimed` row from three
			* days ago satisfies the status test forever, so the button stayed greyed
			* out reading 「今日已签到」 on days the user had not checked in at all —
			* the record's own `lastDate` was never consulted. Comparing against
			* `today` (stamped host-side in UTC+8, the day the scheduler itself uses)
			* returns the button to 「立即领取」 once the record stops describing today.
			*
			* Both tests are required, and neither is redundant: `status` alone pins the
			* button forever, while a date alone would treat a failed or no-campaign
			* attempt earlier today as a completed claim.
			*/
			const claimedToday = checkIn !== void 0 && checkIn.lastDate === checkIn.today && (checkIn.status === "claimed" || checkIn.status === "already-claimed");
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: "qdp-twoUp",
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(CheckInLedger, {
					logs: checkIn?.logs,
					t,
					...clearingLogs === void 0 ? {} : { clearing: clearingLogs },
					...logsDisabled === void 0 ? {} : { disabled: logsDisabled },
					...onClearLogs === void 0 ? {} : { onClear: onClearLogs }
				}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					className: "qdp-panel",
					children: [
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
							className: "qdp-panelHead",
							children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("h3", {
								className: "qdp-panelTitle",
								children: t("paneUsage")
							})
						}),
						autoCheckIn !== true || checkIn?.nextRunAt === void 0 ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
							className: "qdp-panelMeta",
							children: t("checkInNextRun", { time: formatTime(checkIn.nextRunAt) })
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)(QdpButton, {
							variant: claimedToday ? "outline" : "primary",
							size: "md",
							className: "qdp-claimBtn",
							disabled: busy === true || checkingIn === true || claimedToday,
							onClick: onCheckIn,
							children: checkingIn === true ? t("checkInChecking") : claimedToday ? t("checkInClaimedToday") : t("checkInNow")
						}),
						checkInNotice === void 0 ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
							className: "qdp-body",
							children: checkInNotice
						})
					]
				})]
			});
		}
		/**
		* 「3 天内到期」的统计窗口。30 天有效期的包还剩 20 天才到期,不该出现在
		* 「3 天内到期」里 —— 这里统计的是窗口内真的会作废的笔,不是「所有还没过期的」。
		* workbuddy 的「最近 3 天到期」就是这个读法。
		*/
		const SOON_WINDOW_MS = 2592e5;
		/**
		* 最近的签到记录(BOX):插件内每次签到领取到的资源包、数量与到期时间。
		*
		* 这是原来「签到日志」表格的替代:表格只能证明「点过按钮」,而这里回答的是
		* 用户真正关心的问题 —— 我手上有哪些还没过期的资源包,各自什么时候作废。
		* 因此按「领取时间」倒序列出,并在每行右侧给出该笔的到期日;上游没给有效期
		* 的笔(手动签到)按领取后 30 天补算,不再显示「有效期未知」。
		*/
		function CheckInLedger({ logs, t, clearing, disabled, onClear }) {
			const now = Date.now();
			const MANUAL_GRANT_VALIDITY_MS = 2592e6;
			const effectiveExpiry = (entry) => entry.expiresAtMs ?? entry.timestamp + MANUAL_GRANT_VALIDITY_MS;
			const claimed = (logs ?? []).filter((entry) => entry.status === "claimed").sort((a, b) => b.timestamp - a.timestamp);
			const expiringSoonTotal = claimed.filter((entry) => {
				const expiry = effectiveExpiry(entry);
				return expiry > now && expiry <= now + SOON_WINDOW_MS;
			}).reduce((sum, entry) => sum + (entry.amount ?? 0), 0);
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: "qdp-panel",
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "qdp-panelHead",
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h3", {
							className: "qdp-panelTitle",
							children: t("ledgerHeading")
						}), onClear === void 0 ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsx)(QdpButton, {
							variant: "dangerQuiet",
							disabled: disabled === true || clearing === true,
							onClick: onClear,
							children: clearing === true ? t("checkInClearing") : t("checkInClear")
						})]
					}),
					claimed.length === 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
						className: "qdp-empty",
						children: t("ledgerEmpty")
					}) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						className: "qdp-logList qdp-ledgerList",
						children: claimed.map((entry) => {
							const expiry = effectiveExpiry(entry);
							const expired = expiry <= now;
							return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								className: "qdp-ledgerRow",
								children: [
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										className: "qdp-ledgerDate",
										children: formatTime(entry.timestamp)
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										className: "qdp-ledgerAmount",
										children: entry.amount === void 0 ? "—" : `+${entry.amount}`
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										className: expired ? "qdp-ledgerExpiry qdp-ledgerExpired" : "qdp-ledgerExpiry",
										children: expired ? t("ledgerExpired") : t("ledgerExpiresAt", { date: formatDate(expiry) })
									})
								]
							}, entry.id);
						})
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "qdp-ledgerFoot",
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							className: "qdp-panelMeta",
							children: t("ledgerExpiringHeading", { days: 3 })
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							className: "qdp-ledgerFootValue",
							children: String(expiringSoonTotal)
						})]
					})
				]
			});
		}
		/**
		* 「模型」面板:可见性开关与每个模型的上下文容量合并到同一行(原先一个只有
		* 一个复选框的「上下文」tab + 一个纯开关列表),刷新模型按钮挪进本栏头部
		* (原先孤悬在账号行上)。max-window 偏好置于列表上方。
		*/
		function ModelsPane({ models, disabledModels = [], catalog, t, busy, onSetModelContextWindow, onSetModelsEnabled, onRefreshModels }) {
			const MODEL_TIER = [
				"auto",
				"ultimate",
				"performance",
				"cmodel",
				"efficient",
				"lite"
			];
			const tierOf = (id) => {
				const index = MODEL_TIER.indexOf(id);
				return index === -1 ? MODEL_TIER.length : index;
			};
			const capabilityOf = (model) => model.defaultContextWindow ?? model.contextWindow ?? 0;
			const list = [...models ?? []].sort((a, b) => {
				const byTier = tierOf(a.id) - tierOf(b.id);
				if (byTier !== 0) return byTier;
				const byCapability = capabilityOf(b) - capabilityOf(a);
				return byCapability !== 0 ? byCapability : a.id.localeCompare(b.id);
			});
			const axisMax = list.reduce((best, model) => {
				const declaredMax = (model.supportedContextWindows ?? []).reduce((top, value) => value > top ? value : top, 0);
				const fallback = model.defaultContextWindow ?? model.contextWindow ?? 0;
				const rowMax = declaredMax > 0 ? declaredMax : fallback;
				return rowMax > best ? rowMax : best;
			}, 0);
			const axisTicks = (declared) => [.../* @__PURE__ */ new Set([
				0,
				...declared,
				axisMax
			])].filter((value) => Number.isFinite(value) && value >= 0 && value <= axisMax).sort((a, b) => a - b);
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: "qdp-list",
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "qdp-modelHead",
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: "qdp-inline",
							children: [catalog === void 0 ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: "qdp-modelMeta",
								children: catalog.source === "live" && catalog.fetchedAt !== void 0 ? t("catalogLive", { time: formatTime(catalog.fetchedAt) }) : catalog.source === "saved" && catalog.fetchedAt !== void 0 ? t("catalogSaved", { time: formatTime(catalog.fetchedAt) }) : t("catalogFallback")
							}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)(QdpButton, {
								disabled: busy === true,
								onClick: onRefreshModels,
								children: busy === true ? t("refreshingModels") : t("refreshModels")
							})]
						})]
					}),
					catalog?.error === void 0 ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "qdp-alert qdp-alertError",
						role: "alert",
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: t("catalogError", { message: catalog.error }) }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
							className: "qdp-actions",
							children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(QdpButton, {
								disabled: busy === true,
								onClick: onRefreshModels,
								children: busy === true ? t("refreshingModels") : t("refreshModels")
							})
						})]
					}),
					list.length === 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
						className: "qdp-empty",
						children: t("modelsNoModels")
					}) : /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "qdp-modelColumns",
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: t("modelNameColumn") }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: t("contextHeading") })]
					}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						className: "qdp-modelList",
						children: list.map((model) => {
							const isModelEnabled = !disabledModels.includes(model.id);
							const capacity = model.contextWindow;
							const declared = [...new Set(model.supportedContextWindows ?? (capacity !== void 0 ? [capacity] : []))].sort((a, b) => a - b);
							const stops = axisTicks(declared);
							const axisSpan = axisMax > 0 ? axisMax : 1;
							const ratioOf = (value) => value / axisSpan * 100;
							const effective = capacity ?? model.defaultContextWindow;
							const nearest = effective === void 0 || effective <= 0 ? 0 : stops.reduce((best, choice, index) => Math.abs(choice - effective) < Math.abs(stops[best] - effective) ? index : best, 0);
							const currentValue = effective === void 0 || effective <= 0 ? 0 : stops[nearest] ?? 0;
							const currentIndex = stops.indexOf(currentValue);
							const writable = new Set(declared);
							return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								className: "qdp-modelRow",
								style: { opacity: isModelEnabled ? 1 : .65 },
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
									className: "qdp-modelEnable",
									children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
										type: "checkbox",
										checked: isModelEnabled,
										disabled: busy,
										onChange: (event) => {
											onSetModelsEnabled([model.id], event.currentTarget.checked);
										}
									}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
										className: "qdp-modelCopy",
										children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
											className: "qdp-modelName",
											children: [model.name, model.priceFactor === void 0 ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
												className: "qdp-modelRate",
												children: formatRate(model.priceFactor)
											})]
										}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
											className: "qdp-modelMeta",
											children: model.id
										})]
									})]
								}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: "qdp-contextPicker",
									children: declared.length > 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
										className: "qdp-windowSlider",
										children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
											className: "qdp-windowTrack",
											"aria-hidden": "true",
											children: [
												/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
													className: "qdp-windowFill",
													style: { width: `${String(ratioOf(currentValue))}%` }
												}),
												/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
													className: "qdp-windowKnob",
													style: { left: `${String(ratioOf(currentValue))}%` }
												}),
												/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
													className: "qdp-windowInput",
													type: "range",
													min: 0,
													max: stops.length - 1,
													step: 1,
													value: currentIndex,
													disabled: busy,
													"aria-label": `${model.name} ${t("contextHeading")}`,
													"aria-valuetext": currentValue <= 0 ? t("contextHeading") : formatTokens(currentValue),
													onChange: (event) => {
														const index = Number(event.currentTarget.value);
														const choice = stops[index];
														if (choice !== void 0 && writable.has(choice)) onSetModelContextWindow(model.id, choice);
													}
												})
											]
										}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
											className: "qdp-windowTicks",
											"aria-hidden": "true",
											children: (() => {
												const labelled = declared.length <= 3 ? new Set(declared) : /* @__PURE__ */ new Set([
													declared[0],
													declared[Math.floor((declared.length - 1) / 2)],
													declared[declared.length - 1]
												]);
												return stops.map((choice, index) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
													className: "qdp-windowTick",
													style: { left: `${String(ratioOf(choice))}%` },
													children: choice === 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { className: "qdp-windowTickMark" }) : labelled.has(choice) ? formatTokens(choice) : null
												}, index));
											})()
										})]
									}) : capacity !== void 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										className: "qdp-modelMeta",
										children: formatTokens(capacity)
									}) : null
								})]
							}, model.id);
						})
					})] })
				]
			});
		}
		/**
		* Render Qoder PAT state, quota, catalog, and context capacities as the Plugins
		* page's configuration page (or its one-liner, when the owner asks for
		* `summary`).
		*
		* On `page` this component renders the configuration BODY only: the Plugins page
		* draws the breadcrumb, icon, title, version and description, so no shell chrome
		* or second title lives here. The unified card's variant switcher stays as
		* in-page navigation. Sections, top to bottom:
		*
		* 1. 账户 — variant switcher, status dot + account name + plan tag + expiry,
		*    refresh / replace-PAT / sign-out actions, credential provenance and entry
		* 2. 额度 — remaining/total headline, cycle reset, one merged-group bar each
		* 3. 使用与签到 — claim ledger beside today's claim CTA
		* 4. 模型 — per-model visibility toggles and context-window sliders
		* 5. 高级设置 — the variant-scoped quota settings rows
		*/
		function QoderPluginCard(props) {
			const { t, scope, signedIn, variant, unified, view } = props;
			if (t === void 0) throw new Error("Qoder plugin card requires its translation function");
			const isUnified = unified === true;
			const liveSignIn = (0, react.useSyncExternalStore)(onQuotaSettingsChange, quotaSignInState);
			/**
			* The automatic check-in toggles, read from the same settings face the
			* settings rows write. The scheduler arms a timer for EVERY variant (so a
			* toggle flipped on later still fires), so `nextRunAt` alone cannot tell
			* 「已安排」 from 「功能没开」 — this flag is what the card gates the
			* 「下次自动领取」 line on.
			*
			* getSnapshot MUST return the same reference between renders unless the
			* store changed: returning `scope.getSnapshot().value` (a fresh object each
			* call) re-renders forever and trips React's maximum-update-depth guard —
			* the exact hazard `stableProject` documents in QuotaSettingsCard. The
			* projection here is a STRING, so identity is stable by construction.
			*/
			const settingsSubscribe = (0, react.useCallback)((onStoreChange) => {
				return scope?.subscribe(onStoreChange) ?? (() => {});
			}, [scope]);
			const autoCheckInKey = (0, react.useSyncExternalStore)(settingsSubscribe, () => {
				const value = scope?.getSnapshot().value;
				return `${value?.autoCheckInCN === true ? "1" : "0"}${value?.autoCheckInGlobal === true ? "1" : "0"}`;
			});
			const autoCheckInCN = autoCheckInKey.startsWith("1");
			const autoCheckInGlobal = autoCheckInKey.endsWith("1");
			const [activeVariantId, setActiveVariantId] = (0, react.useState)("qoder");
			const currentVariant = isUnified ? activeVariantId === "qoder" ? QODER_CN_CARD : QODER_GLOBAL_CARD : variant ?? QODER_CN_CARD;
			const [status, setStatus] = (0, react.useState)();
			const [signedInState, setSignedInState] = (0, react.useState)();
			const [readFailure, setReadFailure] = (0, react.useState)();
			const [busy, setBusy] = (0, react.useState)(false);
			const [patDraft, setPatDraft] = (0, react.useState)("");
			const [replacing, setReplacing] = (0, react.useState)(false);
			const [patBusy, setPatBusy] = (0, react.useState)(false);
			const [patError, setPatError] = (0, react.useState)();
			const [patNotice, setPatNotice] = (0, react.useState)();
			const [checkingIn, setCheckingIn] = (0, react.useState)(false);
			const [clearingLogs, setClearingLogs] = (0, react.useState)(false);
			const [checkInNotice, setCheckInNotice] = (0, react.useState)();
			/** 「清除 PAT」的内联确认：点一次进入确认，再点一次才真正清除。 */
			const [confirmingClear, setConfirmingClear] = (0, react.useState)(false);
			/**
			* 每个 variant 的启用勾选(workbuddy 的 tab-switch)。这是客户端意图层:
			* 关掉的 variant 不再轮询/显示其内容;模型通道的开关仍由 disabledModels
			* 决定,这里不写宿主配置。
			*/
			const [variantEnabled, setVariantEnabled] = (0, react.useState)({
				cn: true,
				global: true
			});
			const cnEnabled = variantEnabled.cn;
			const globalEnabled = variantEnabled.global;
			const mounted = (0, react.useRef)(true);
			const readSeq = (0, react.useRef)(0);
			const manualControllers = (0, react.useRef)(/* @__PURE__ */ new Set());
			(0, react.useEffect)(() => {
				mounted.current = true;
				return () => {
					mounted.current = false;
					for (const controller of manualControllers.current) controller.abort();
					manualControllers.current.clear();
				};
			}, []);
			const trackController = (0, react.useCallback)(() => {
				const controller = new AbortController();
				manualControllers.current.add(controller);
				return controller;
			}, []);
			const authKey = status === void 0 || status.status === "error" ? void 0 : status.authKey;
			const refresh = (0, react.useCallback)(async (signal) => {
				const seq = ++readSeq.current;
				const current = () => mounted.current && signal?.aborted !== true && seq === readSeq.current;
				try {
					const response = await fetch(currentVariant.statusPath, {
						headers: { accept: "application/json" },
						credentials: "same-origin",
						...signal === void 0 ? {} : { signal }
					});
					const value = await response.json().catch(() => void 0);
					if (!response.ok) throw new Error(`HTTP ${response.status}`);
					if (!isQoderWebStatus(value)) throw new Error(t("statusResponseInvalid"));
					if (!current()) return false;
					setStatus(value);
					if (value.status === "signed-in") {
						setSignedInState(true);
						noteQuotaStatus(currentVariant.id, value);
					} else if (value.status === "signed-out") {
						setSignedInState(false);
						noteQuotaStatus(currentVariant.id, value);
					}
					setReadFailure(void 0);
					return true;
				} catch (error) {
					const message = error instanceof Error ? error.message : t("requestFailed");
					if (current()) {
						setReadFailure(message);
						setStatus((previous) => previous === void 0 ? {
							status: "error",
							message
						} : previous);
					}
					return false;
				}
			}, [currentVariant.statusPath, t]);
			(0, react.useEffect)(() => {
				setStatus(void 0);
				setSignedInState(void 0);
				setReadFailure(void 0);
				setPatDraft("");
				setReplacing(false);
				setPatError(void 0);
				setPatNotice(void 0);
				const controller = new AbortController();
				refresh(controller.signal);
				return () => {
					controller.abort();
				};
			}, [currentVariant.statusPath, refresh]);
			(0, react.useEffect)(() => {
				if (signedInState === false) return;
				const controller = new AbortController();
				const timer = window.setInterval(() => {
					refresh(controller.signal);
				}, POLL_INTERVAL_MS);
				return () => {
					window.clearInterval(timer);
					controller.abort();
				};
			}, [refresh, signedInState]);
			const manualRefresh = async () => {
				setBusy(true);
				const controller = trackController();
				try {
					await refresh(controller.signal);
				} finally {
					manualControllers.current.delete(controller);
					if (mounted.current) setBusy(false);
				}
			};
			/**
			* Ask the host to re-read the credential and re-fetch this variant's catalog.
			*
			* Shares the probe route's key and guards: it is a write that spends an
			* upstream request, so it does not belong on the read-only status GET. A
			* failure is surfaced through the refreshed document's `catalog.error` rather
			* than thrown away, so the reason survives the round trip.
			*/
			const refreshModels = (0, react.useCallback)(async () => {
				const key = status?.status === "signed-in" ? status.probeKey : void 0;
				if (key === void 0) return;
				setBusy(true);
				let result;
				const controller = trackController();
				try {
					const response = await fetch(currentVariant.probePath, {
						method: "POST",
						headers: {
							"Content-Type": "application/json",
							"X-Qoder-Probe-Key": key
						},
						credentials: "same-origin",
						signal: controller.signal,
						body: JSON.stringify({ action: "refresh" })
					});
					if (!response.ok) throw new Error(`HTTP ${response.status}`);
					result = await response.json();
				} catch (error) {
					if (mounted.current && controller.signal.aborted !== true) setReadFailure(error instanceof Error ? error.message : t("requestFailed"));
					manualControllers.current.delete(controller);
					return;
				} finally {
					if (mounted.current) setBusy(false);
				}
				if (result.state === "failed") {
					if (mounted.current) setReadFailure(result.reason ?? t("requestFailed"));
					manualControllers.current.delete(controller);
					return;
				}
				if (result.state === "refreshed" && mounted.current) setReadFailure(void 0);
				try {
					await refresh(controller.signal);
				} finally {
					manualControllers.current.delete(controller);
				}
			}, [
				currentVariant.probePath,
				refresh,
				status,
				t,
				trackController
			]);
			const manualCheckIn = (0, react.useCallback)(async () => {
				const key = status?.status === "signed-in" ? status.probeKey : void 0;
				if (key === void 0) return;
				setCheckingIn(true);
				setCheckInNotice(void 0);
				const controller = trackController();
				try {
					const response = await fetch(currentVariant.probePath, {
						method: "POST",
						headers: {
							"Content-Type": "application/json",
							"X-Qoder-Probe-Key": key
						},
						credentials: "same-origin",
						signal: controller.signal,
						body: JSON.stringify({ action: "checkin" })
					});
					if (!response.ok) throw new Error(`HTTP ${response.status}`);
					const result = await response.json();
					if (result.state === "claimed") setCheckInNotice(t("autoCheckInStatusClaimed", { amount: result.amount ?? 100 }));
					else if (result.state === "already-claimed") setCheckInNotice(t("autoCheckInStatusAlready"));
					else if (result.state === "no-campaign") setCheckInNotice(t("autoCheckInStatusNoCampaign"));
					else if (result.reasonCode === "no-client") setCheckInNotice(t("checkInNeedsClient"));
					else if (result.reason) setCheckInNotice(t("autoCheckInStatusError", { message: result.reason }));
				} catch (error) {
					if (mounted.current && controller.signal.aborted !== true) setCheckInNotice(error instanceof Error ? error.message : t("requestFailed"));
				} finally {
					manualControllers.current.delete(controller);
					if (mounted.current) setCheckingIn(false);
				}
				try {
					await refresh(controller.signal);
				} finally {
					manualControllers.current.delete(controller);
				}
			}, [
				currentVariant.probePath,
				refresh,
				status,
				t,
				trackController
			]);
			const clearCheckInLogs = (0, react.useCallback)(async () => {
				const key = status?.status === "signed-in" ? status.probeKey : void 0;
				if (key === void 0) return;
				setClearingLogs(true);
				setCheckInNotice(void 0);
				const controller = trackController();
				try {
					const response = await fetch(currentVariant.probePath, {
						method: "POST",
						headers: {
							"Content-Type": "application/json",
							"X-Qoder-Probe-Key": key
						},
						credentials: "same-origin",
						signal: controller.signal,
						body: JSON.stringify({ action: "clear-checkin-logs" })
					});
					if (!response.ok) throw new Error(`HTTP ${response.status}`);
				} catch (error) {
					if (mounted.current && controller.signal.aborted !== true) setCheckInNotice(error instanceof Error ? error.message : t("requestFailed"));
				} finally {
					manualControllers.current.delete(controller);
					if (mounted.current) setClearingLogs(false);
				}
				try {
					await refresh(controller.signal);
				} finally {
					manualControllers.current.delete(controller);
				}
			}, [
				currentVariant.probePath,
				refresh,
				status,
				t,
				trackController
			]);
			/**
			* Run one probe-route control action and refresh the card's state afterwards.
			*
			* The key travels in a header, not the body: it authorizes the write, and
			* the host never accepts a prompt, a sentinel, or a model outside its own
			* catalog from here.
			*/
			const control = (0, react.useCallback)(async (action) => {
				const key = status?.status === "signed-in" ? status.probeKey : void 0;
				if (key === void 0) return;
				setBusy(true);
				const controller = trackController();
				try {
					const response = await fetch(currentVariant.probePath, {
						method: "POST",
						headers: {
							"Content-Type": "application/json",
							"X-Qoder-Probe-Key": key
						},
						credentials: "same-origin",
						signal: controller.signal,
						body: JSON.stringify(action)
					});
					const value = await response.json().catch(() => void 0);
					if (!response.ok) {
						const message = typeof value === "object" && value !== null && "error" in value ? String(value["error"]) : `HTTP ${response.status}`;
						throw new Error(message);
					}
					if ((action.action === "set-maximum-context-window" || action.action === "set-models-enabled") && (typeof value !== "object" || value === null || value["state"] !== "updated")) {
						const reason = typeof value === "object" && value !== null && "reason" in value ? String(value["reason"]) : t("requestFailed");
						throw new Error(reason);
					}
					await refresh(controller.signal);
				} catch (error) {
					if (mounted.current && controller.signal.aborted !== true) setReadFailure(error instanceof Error ? error.message : t("requestFailed"));
				} finally {
					manualControllers.current.delete(controller);
					if (mounted.current) setBusy(false);
				}
			}, [
				currentVariant.probePath,
				refresh,
				status,
				t,
				trackController
			]);
			/**
			* Validate and store the pasted PAT (or overwrite the stored one).
			*
			* The PAT route answers both outcomes as 200 with `ok` carrying the verdict —
			* a refused token is an answer, not a transport failure — so the card checks
			* `ok` and translates the stable `qoder_invalid_pat` / `qoder_missing_pat`
			* codes into the re-generate prompt. The route is variant-fixed: the token
			* this card saves can only ever be validated and stored for this product.
			*/
			const savePat = (0, react.useCallback)(async () => {
				const key = authKey;
				const pat = patDraft.trim();
				if (key === void 0 || pat === "" || patBusy) return;
				setPatBusy(true);
				setPatError(void 0);
				setPatNotice(void 0);
				const controller = trackController();
				try {
					const response = await fetch(currentVariant.authPath, {
						method: "POST",
						headers: {
							"Content-Type": "application/json",
							"X-Qoder-Auth-Key": key
						},
						credentials: "same-origin",
						signal: controller.signal,
						body: JSON.stringify({
							action: "save-pat",
							pat
						})
					});
					const value = await response.json().catch(() => void 0);
					const record = typeof value === "object" && value !== null ? value : {};
					const detail = typeof record["error"] === "string" ? record["error"] : `HTTP ${response.status}`;
					if (!response.ok) {
						setPatError(t("patSaveFailed", { message: detail }));
						return;
					}
					if (record["ok"] !== true) {
						const reason = typeof record["reason"] === "string" ? record["reason"] : t("requestFailed");
						if (detail === "qoder_invalid_pat" || detail === "qoder_missing_pat") setPatError(t("patInvalid"));
						else if (detail === "qoder_unreachable") setPatError(t("patUnreachable", { message: reason }));
						else setPatError(t("patSaveFailed", { message: detail }));
						return;
					}
					setPatDraft("");
					setReplacing(false);
					setPatNotice(t("patSaved"));
					noteQuotaSignIn(currentVariant.id, true);
					await refresh(controller.signal);
				} catch (error) {
					if (mounted.current && controller.signal.aborted !== true) setPatError(t("patSaveFailed", { message: error instanceof Error ? error.message : t("requestFailed") }));
				} finally {
					manualControllers.current.delete(controller);
					if (mounted.current) setPatBusy(false);
				}
			}, [
				authKey,
				currentVariant.authPath,
				patBusy,
				patDraft,
				refresh,
				t,
				trackController
			]);
			/** Remove the stored PAT; the host answer is `{ ok: true }`, then the card re-reads. */
			const clearPat = (0, react.useCallback)(async () => {
				const key = authKey;
				if (key === void 0 || patBusy) return;
				setPatBusy(true);
				setPatError(void 0);
				setPatNotice(void 0);
				setReplacing(false);
				const controller = trackController();
				try {
					const response = await fetch(currentVariant.authPath, {
						method: "POST",
						headers: {
							"Content-Type": "application/json",
							"X-Qoder-Auth-Key": key
						},
						credentials: "same-origin",
						signal: controller.signal,
						body: JSON.stringify({ action: "clear" })
					});
					setConfirmingClear(false);
					const value = await response.json().catch(() => void 0);
					const record = typeof value === "object" && value !== null ? value : {};
					if (!response.ok || record["ok"] !== true) {
						const detail = typeof record["error"] === "string" ? record["error"] : `HTTP ${response.status}`;
						setPatError(t("patSaveFailed", { message: detail }));
						return;
					}
					setPatDraft("");
					const signedOutDoc = {
						status: "signed-out",
						authKey: key
					};
					setStatus(signedOutDoc);
					setSignedInState(false);
					noteQuotaStatus(currentVariant.id, signedOutDoc);
					noteQuotaSignIn(currentVariant.id, false);
					await refresh(controller.signal);
				} catch (error) {
					if (mounted.current && controller.signal.aborted !== true) setPatError(t("patSaveFailed", { message: error instanceof Error ? error.message : t("requestFailed") }));
				} finally {
					manualControllers.current.delete(controller);
					if (mounted.current) setPatBusy(false);
				}
			}, [
				authKey,
				currentVariant.authPath,
				patBusy,
				refresh,
				t,
				trackController
			]);
			/**
			* 更换 PAT: open the entry over the signed-in document, pre-cleared and
			* focused. Unlike the removed device-flow switch this needs no sign-out
			* first — saving validates the new token and overwrites the stored one
			* only on success, so a mistyped paste can never strand the working
			* credential.
			*/
			const patEntry = () => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: "qdp-stack",
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
						className: "qdp-body",
						children: t(currentVariant.patGuideKey)
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "qdp-patRow",
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)(QdpInput, {
								type: "password",
								value: patDraft,
								placeholder: t(currentVariant.patPlaceholderKey),
								"aria-label": t("patHeading"),
								disabled: patBusy,
								onChange: (event) => {
									setPatDraft(event.target.value);
								},
								onKeyDown: (event) => {
									if (event.key === "Enter") {
										event.preventDefault();
										savePat();
									}
								}
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)(QdpButton, {
								variant: "primary",
								disabled: patBusy || busy || patDraft.trim() === "",
								onClick: () => {
									savePat();
								},
								children: patBusy ? t("patSaving") : t("patSave")
							}),
							replacing ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)(QdpButton, {
								disabled: patBusy,
								onClick: () => {
									setReplacing(false);
									setPatDraft("");
									setPatError(void 0);
								},
								children: t("cancel")
							}) : null
						]
					}),
					patError === void 0 ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						className: "qdp-alert qdp-alertError",
						role: "alert",
						children: patError
					}),
					patNotice === void 0 ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
						className: "qdp-body",
						children: patNotice
					})
				]
			});
			const cardIntro = isUnified ? t("unifiedIntro") : t(currentVariant.introKey);
			const label = status === void 0 ? t("loading") : status.status === "signed-in" ? t("signedIn") : status.status === "error" ? t("requestFailed") : t("signedOut");
			const signedInLabel = status?.status === "signed-in" && status.pat?.accountName !== void 0 ? t("accountSignedInAs", { name: status.pat.accountName }) : label;
			const reported = signedIn?.();
			const cnSignedIn = reported !== void 0 ? reported.cn : liveSignIn.cn;
			const globalSignedIn = reported !== void 0 ? reported.global : liveSignIn.global;
			const cnDotState = dotStateOf(isUnified && activeVariantId === "qoder" ? status === void 0 ? "loading" : status.status : cnSignedIn ? "signed-in" : "signed-out");
			const globalDotState = dotStateOf(isUnified && activeVariantId === "qoder-global" ? status === void 0 ? "loading" : status.status : globalSignedIn ? "signed-in" : "signed-out");
			const planTag = status?.status === "signed-in" && status.plan !== void 0 ? t("planTier", { name: status.plan.planTierName }) : void 0;
			const planMeta = status?.status === "signed-in" && status.plan !== void 0 ? [status.plan.organizationName === void 0 ? null : t("planOrganization", { name: status.plan.organizationName }), status.plan.endDate === void 0 ? null : t("planEndsAt", { date: formatCycleReset(status.plan.endDate) })].filter((part) => part !== null).join(" · ") : void 0;
			if (view === "summary") return /* @__PURE__ */ (0, react_jsx_runtime.jsx)(react_jsx_runtime.Fragment, { children: cardIntro });
			const settingsVariant = isUnified ? activeVariantId === "qoder" ? "cn" : "global" : currentVariant.id === "qoder" ? "cn" : "global";
			const signedInDoc = status?.status === "signed-in" ? status : void 0;
			return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
				className: "qdp-card qdp-cardOpen",
				children: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					className: "qdp-cardBody",
					children: [
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("section", {
							className: "qdp-section",
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								className: "qdp-sectionHead",
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h2", {
									className: "qdp-sectionTitle",
									children: t("accountHeading")
								}), isUnified ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)(QdpSegmented, {
									label: "Qoder Version Selection",
									value: activeVariantId,
									options: [{
										value: "qoder",
										disabled: !cnEnabled,
										label: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(QdpStateDot, { state: cnDotState }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: t("variantTabCN") })] })
									}, {
										value: "qoder-global",
										disabled: !globalEnabled,
										label: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(QdpStateDot, { state: globalDotState }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: t("variantTabGlobal") })] })
									}],
									onChange: setActiveVariantId
								}) : null]
							}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								className: "qdp-sectionBody",
								children: [
									/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
										className: "qdp-accountBox",
										children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
											className: "qdp-accountMain",
											children: [
												/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
													className: "qdp-accountState",
													role: "status",
													"aria-busy": status === void 0,
													children: [
														/* @__PURE__ */ (0, react_jsx_runtime.jsx)(QdpStateDot, { state: dotStateOf(status === void 0 ? "loading" : status.status) }),
														/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: signedInLabel }),
														planTag === void 0 ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsx)(QdpTag, { children: planTag })
													]
												}),
												status?.status !== "signed-in" || status.pat === void 0 ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
													className: "qdp-accountExpiry",
													children: [
														patSourceText(status.pat.source, t),
														status.pat.savedAtMs === void 0 ? null : t("patSavedAt", { time: formatTime(status.pat.savedAtMs) }),
														status.pat.patTail === void 0 ? null : t("patTail", { tail: `****${status.pat.patTail}` })
													].filter(Boolean).join(" · ")
												}),
												planMeta === void 0 || planMeta === "" ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
													className: "qdp-accountExpiry",
													children: planMeta
												})
											]
										}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
											className: "qdp-actions",
											children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(QdpButton, {
												disabled: busy,
												onClick: () => {
													manualRefresh();
												},
												children: busy ? t("refreshing") : t("refresh")
											}), signedInDoc === void 0 ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(QdpButton, {
												disabled: busy || patBusy,
												onClick: () => {
													setReplacing((open) => !open);
												},
												children: t("patReplace")
											}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)(QdpButton, {
												variant: "dangerQuiet",
												disabled: busy || patBusy,
												onClick: () => {
													setConfirmingClear(true);
												},
												children: t("patRemove")
											})] })]
										})]
									}),
									isUnified ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
										className: "qdp-row",
										children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
											className: "qdp-rowText",
											children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
												className: "qdp-rowTitle",
												children: t("variantTabCN")
											}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
												className: "qdp-rowDesc",
												children: t("variantEnable")
											})]
										}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
											className: "qdp-rowControl",
											children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(QdpSwitch, {
												checked: cnEnabled,
												onChange: (next) => {
													setVariantEnabled((prev) => ({
														...prev,
														cn: next
													}));
												},
												label: `${t("variantTabCN")} · ${t("variantEnable")}`
											})
										})]
									}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
										className: "qdp-row",
										children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
											className: "qdp-rowText",
											children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
												className: "qdp-rowTitle",
												children: t("variantTabGlobal")
											}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
												className: "qdp-rowDesc",
												children: t("variantEnable")
											})]
										}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
											className: "qdp-rowControl",
											children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(QdpSwitch, {
												checked: globalEnabled,
												onChange: (next) => {
													setVariantEnabled((prev) => ({
														...prev,
														global: next
													}));
												},
												label: `${t("variantTabGlobal")} · ${t("variantEnable")}`
											})
										})]
									})] }) : null,
									confirmingClear && signedInDoc !== void 0 && signedInDoc.pat !== void 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
										className: "qdp-alert",
										role: "alert",
										children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: t("patClearConfirm") }), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
											className: "qdp-actions",
											children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(QdpButton, {
												variant: "danger",
												disabled: busy || patBusy,
												onClick: () => {
													clearPat();
												},
												children: patBusy ? t("patClearing") : t("patClearConfirmYes")
											}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)(QdpButton, {
												disabled: patBusy,
												onClick: () => {
													setConfirmingClear(false);
												},
												children: t("cancel")
											})]
										})]
									}) : null,
									signedInDoc === void 0 || signedInDoc.pat === void 0 ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
										className: "qdp-patBox",
										children: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
											className: "qdp-patBoxCopy",
											children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
												className: "qdp-accountState",
												children: t("patBoxLabel")
											}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
												className: "qdp-patBoxMeta",
												children: [signedInDoc.pat.accountName, signedInDoc.pat.patTail === void 0 ? null : t("patTail", { tail: `****${signedInDoc.pat.patTail}` })].filter(Boolean).join(" · ")
											})]
										})
									}),
									replacing ? patEntry() : null,
									signedInDoc !== void 0 && signedInDoc.jobTokenRefreshedAt !== void 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
										className: "qdp-meta",
										children: t("jobTokenRefreshed", { time: formatTime(signedInDoc.jobTokenRefreshedAt) })
									}) : null,
									readFailure === void 0 || signedInState === void 0 ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
										className: "qdp-alert qdp-alertError",
										role: "alert",
										children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: t("statusRefreshFailed", { message: readFailure }) }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
											className: "qdp-actions",
											children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(QdpButton, {
												disabled: busy,
												onClick: () => {
													manualRefresh();
												},
												children: busy ? t("refreshing") : t("refresh")
											})
										})]
									}),
									signedInDoc === void 0 && status?.status === "signed-out" ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
										className: status.reason === void 0 ? "qdp-body" : "qdp-error",
										children: status.reason ?? t(currentVariant.signedOutKey)
									}), authKey === void 0 ? null : patEntry()] }) : null,
									status?.status === "error" ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
										className: "qdp-alert qdp-alertError",
										role: "alert",
										children: status.message
									}) : null
								]
							})]
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("section", {
							className: "qdp-section",
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
								className: "qdp-sectionHead",
								children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("h2", {
									className: "qdp-sectionTitle",
									children: t("creditsHeading")
								})
							}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
								className: "qdp-sectionBody",
								children: signedInDoc === void 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
									className: "qdp-empty",
									children: status === void 0 ? t("loading") : t("quotaNotSignedIn")
								}) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)(QuotaSummary, {
									credits: signedInDoc.credits,
									creditsError: signedInDoc.creditsError,
									t,
									busy,
									onRetry: () => {
										manualRefresh();
									}
								})
							})]
						}),
						signedInDoc === void 0 ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("section", {
							className: "qdp-section",
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
								className: "qdp-sectionHead",
								children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("h2", {
									className: "qdp-sectionTitle",
									children: t("quotaSectionUsage")
								})
							}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
								className: "qdp-sectionBody",
								children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(UsageCheckInPanel, {
									checkIn: signedInDoc.checkIn,
									autoCheckIn: isUnified ? activeVariantId === "qoder" ? autoCheckInCN : autoCheckInGlobal : currentVariant.id === "qoder" ? autoCheckInCN : autoCheckInGlobal,
									t,
									busy,
									checkingIn,
									checkInNotice,
									onCheckIn: () => {
										manualCheckIn();
									},
									clearingLogs,
									logsDisabled: false,
									onClearLogs: () => {
										clearCheckInLogs();
									}
								})
							})]
						}),
						signedInDoc === void 0 ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("section", {
							className: "qdp-section",
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
								className: "qdp-sectionHead",
								children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("h2", {
									className: "qdp-sectionTitle",
									children: t("paneModels")
								})
							}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
								className: "qdp-sectionBody",
								children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(ModelsPane, {
									models: signedInDoc.models,
									disabledModels: signedInDoc.disabledModels,
									catalog: signedInDoc.catalog,
									t,
									busy,
									onSetModelContextWindow: (model, window) => {
										control({
											action: "set-model-context-window",
											model,
											window
										});
									},
									onSetModelsEnabled: (models, enabled) => {
										control({
											action: "set-models-enabled",
											models,
											enabled
										});
									},
									onRefreshModels: () => {
										refreshModels();
									}
								})
							})]
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("section", {
							className: "qdp-section",
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
								className: "qdp-sectionHead",
								children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("h2", {
									className: "qdp-sectionTitle",
									children: t("quotaSectionAdvanced")
								})
							}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
								className: "qdp-sectionBody",
								children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(QuotaSettingsContent, {
									t,
									scope,
									signedIn,
									variant: settingsVariant
								})
							})]
						})
					]
				})
			});
		}
		//#endregion
		//#region src/client/QoderProbeControl.tsx
		/**
		* Per-model reasoning-effort entry beside the Composer's model selector.
		*
		* Interaction follows the Fast Mode control `dsh-codex-connect` ships in this
		* same seat, which is the established shape for composer chrome here:
		*
		* - a **static inline label** next to the icon names the feature ("Reasoning
		*   levels"), set smaller and dimmer than the surrounding chrome so it reads as
		*   an annotation on the icon. It never carries state: the verified levels
		*   already appear in the model dropdown (the adapter exposes them as
		*   selectable efforts), so repeating them here would duplicate the real answer
		*   and make the label's width jump as results change.
		* - a **hover/focus tooltip** carries the state and the click's purpose, the way
		*   Fast Mode's tooltip explains its current speed.
		* - the **confirmation** is a small bubble anchored to the control, not a
		*   `window.confirm`. Probing spends real credit, so a confirmation stays — but
		*   it belongs next to the thing it acts on, sized to one line plus two small
		*   buttons.
		*
		* @module dsh-connect-qoder-x/client/probe-control
		*/
		/**
		* The card (and therefore the routes) a selected provider belongs to.
		*
		* The control serves both Qoder providers from one seat, so the provider id
		* is what selects the status and probe endpoints. Returning `undefined` for any
		* other provider is what keeps the icon off every non-Qoder model.
		*/
		function cardVariantFor(provider) {
			return QODER_CARD_VARIANTS.find((card) => card.id === provider);
		}
		/** How often the control re-checks state when the window regains focus. */
		const RECONCILE_MS = 6e4;
		/**
		* The feature's static inline label. Deliberately not a state readout — see the
		* module comment.
		*/
		function useLabel(t) {
			return t("probeLabel");
		}
		/** Pick the model's recorded observation out of the probe section. */
		function resultFor(status, model) {
			if (status.status !== "signed-in") return void 0;
			return status.probe?.results.find((result) => result.id === model);
		}
		/**
		* The one-line tooltip: current state first, then what a click does — the same
		* two-part shape Fast Mode uses.
		*
		* A recorded result outranks a remembered failure. `failed` only means "the last
		* run from this control did not complete"; the host can record a result for the
		* same model at any time (a detection started from the settings card, another
		* conversation, or a finished sweep), and the levels the user paid for are the
		* more useful answer than the stale failure. Failure copy is what remains when
		* there is no result to report.
		*/
		function tooltipText(t, model, state) {
			if (state.busy) return t("probeRunning", { model });
			const result = state.result;
			if (result !== void 0) {
				if (result.validation === "validating" && result.efforts.length > 0) return t("probeTooltipVerified", { levels: result.efforts.join(" / ") });
				if (result.validation === "non-validating") return t("probeTooltipNotValidating");
				return t("probeTooltipRetry");
			}
			if (state.failed) return t("probeTooltipRetry");
			return t("probeTooltipIdle", { model });
		}
		/** Model-independent shell: resolves the selection, then delegates per model. */
		function QoderProbeControl({ directory, t }) {
			const subscribe = (0, react.useCallback)((listener) => directory.subscribe(listener), [directory]);
			const snapshot = (0, react.useCallback)(() => directory.getSnapshot(), [directory]);
			const selection = (0, react.useSyncExternalStore)(subscribe, snapshot, snapshot).current;
			const card = selection == null ? void 0 : cardVariantFor(selection.provider);
			const key = card === void 0 || selection == null ? void 0 : `${card.id}:${selection.model}`;
			return card === void 0 || selection == null || key === void 0 ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsx)(ModelProbe, {
				model: selection.model,
				card,
				label: useLabel(t),
				t
			}, key);
		}
		function ModelProbe({ model, card, label, t }) {
			const [status, setStatus] = (0, react.useState)();
			const [busy, setBusy] = (0, react.useState)(false);
			const [confirming, setConfirming] = (0, react.useState)(false);
			const [tooltipVisible, setTooltipVisible] = (0, react.useState)(false);
			const [failed, setFailed] = (0, react.useState)(false);
			const [note, setNote] = (0, react.useState)();
			const inFlight = (0, react.useRef)(false);
			const mounted = (0, react.useRef)(false);
			const readSeq = (0, react.useRef)(0);
			const tooltipId = (0, react.useId)();
			const refresh = (0, react.useCallback)(async (signal) => {
				const seq = ++readSeq.current;
				const response = await fetch(card.statusPath, {
					credentials: "same-origin",
					headers: { accept: "application/json" },
					...signal === void 0 ? {} : { signal }
				});
				if (!response.ok) throw new Error(`HTTP ${response.status}`);
				const value = await response.json().catch(() => void 0);
				if (!isQoderWebStatus(value)) throw new Error(t("statusResponseInvalid"));
				if (mounted.current && !signal?.aborted && seq === readSeq.current) setStatus(value);
			}, [card.statusPath, t]);
			(0, react.useEffect)(() => {
				mounted.current = true;
				const controller = new AbortController();
				const load = () => {
					refresh(controller.signal).catch(() => {});
				};
				load();
				const timer = window.setInterval(load, RECONCILE_MS);
				window.addEventListener("focus", load);
				return () => {
					mounted.current = false;
					controller.abort();
					window.clearInterval(timer);
					window.removeEventListener("focus", load);
				};
			}, [refresh]);
			const probe = status?.status === "signed-in" ? status.probe : void 0;
			const key = status?.status === "signed-in" ? status.probeKey : void 0;
			const result = status === void 0 ? void 0 : resultFor(status, model);
			const visible = probe?.candidates.includes(model) === true || result !== void 0;
			(0, react.useEffect)(() => {
				if (result !== void 0) setFailed(false);
			}, [result]);
			(0, react.useEffect)(() => {
				setConfirming(false);
				setNote(void 0);
			}, [model]);
			const detect = async () => {
				if (key === void 0 || inFlight.current || probe?.running === true) return;
				inFlight.current = true;
				setNote(void 0);
				setConfirming(false);
				setBusy(true);
				setFailed(false);
				try {
					const response = await fetch(card.probePath, {
						method: "POST",
						credentials: "same-origin",
						headers: {
							"Content-Type": "application/json",
							"X-Qoder-Probe-Key": key
						},
						body: JSON.stringify({
							action: "probe",
							model
						})
					});
					const body = await response.json();
					if (!response.ok || body.state !== "ok" || body.validation !== "validating" && body.validation !== "non-validating" || !Array.isArray(body.efforts) || !body.efforts.every((effort) => typeof effort === "string")) throw new Error("probe failed");
					if (mounted.current) {
						const completed = {
							id: model,
							name: model,
							validation: body.validation,
							efforts: body.efforts,
							probedAt: Date.now()
						};
						setNote(completed);
					}
					refresh().catch(() => {});
				} catch {
					if (mounted.current) setFailed(true);
				} finally {
					inFlight.current = false;
					if (mounted.current) setBusy(false);
				}
			};
			if (!visible) return null;
			const text = tooltipText(t, model, {
				busy,
				result,
				failed
			});
			const disabled = busy || probe?.running === true || key === void 0;
			const showTooltip = tooltipVisible && !confirming && note === void 0;
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
				className: "qdp-probeWrap",
				onMouseEnter: () => {
					setTooltipVisible(true);
				},
				onMouseLeave: () => {
					setTooltipVisible(false);
				},
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("button", {
						type: "button",
						"aria-label": text,
						"aria-describedby": showTooltip ? tooltipId : void 0,
						"aria-busy": busy,
						"aria-expanded": confirming,
						disabled,
						onClick: () => {
							setConfirming(true);
						},
						onFocus: () => {
							setTooltipVisible(true);
						},
						onBlur: () => {
							setTooltipVisible(false);
						},
						className: "qdp-probe",
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("svg", {
							width: "16",
							height: "16",
							viewBox: "0 0 24 24",
							fill: "none",
							stroke: "currentColor",
							strokeWidth: "1.6",
							"aria-hidden": "true",
							focusable: "false",
							children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("circle", {
									cx: "12",
									cy: "12",
									r: "9"
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("circle", {
									cx: "12",
									cy: "12",
									r: "4"
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("path", { d: "M12 12 20 4" }),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("circle", {
									cx: "12",
									cy: "12",
									r: "1"
								})
							]
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							className: "qdp-probeLabel",
							children: label
						})]
					}),
					showTooltip && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						id: tooltipId,
						role: "tooltip",
						className: "qdp-probeTip",
						children: text
					}),
					confirming && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
						className: "qdp-probeBubble",
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: t("probeBubbleBody") }), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
							className: "qdp-probeBubbleRow",
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(QdpButton, {
								onClick: () => {
									setConfirming(false);
								},
								children: t("cancel")
							}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)(QdpButton, {
								variant: "primary",
								onClick: () => {
									detect();
								},
								children: t("probeConfirmAction")
							})]
						})]
					}),
					note === void 0 ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
						role: "status",
						"aria-live": "polite",
						className: "qdp-probeNote",
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: noteText(t, note) }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)(QdpButton, {
							onClick: () => {
								setNote(void 0);
							},
							children: t("probeNoteDismiss")
						})]
					})
				]
			});
		}
		/** Compose the one-line outcome string the note bubble shows. */
		function noteText(t, result) {
			if (result.validation === "validating" && result.efforts.length > 0) return t("probeNoteVerified", { levels: result.efforts.join(" / ") });
			if (result.validation === "non-validating") return t("probeNoteNotValidating");
			return t("probeNoteUnknown");
		}
		//#endregion
		//#region src/client/http-settings-scope.ts
		/** Base path of the host half's settings face. */
		const ROUTE_BASE = "/plugins/dsh-connect-qoder-x";
		/**
		* Fetch one settings face document.
		* @param init - the request init (method, headers, body).
		* @returns the parsed document.
		* @throws when the transport or the host refuses the request.
		*/
		async function request(init) {
			const response = await fetch(`${ROUTE_BASE}/settings`, {
				credentials: "same-origin",
				...init
			});
			const value = await response.json().catch(() => void 0);
			if (!response.ok) {
				const error = typeof value === "object" && value !== null && "error" in value ? String(value["error"]) : `HTTP ${response.status}`;
				throw new Error(error);
			}
			if (typeof value !== "object" || value === null || !("value" in value)) throw new Error("qoder: settings face answered an invalid document");
			return value;
		}
		/**
		* The scope the card was written against, backed by this plugin's own file.
		*
		* A write optimistically adopts the value it just sent, then confirms with the
		* host's answer (which re-reads the file it wrote), so the card never renders a
		* value the host does not hold.
		*/
		var OwnQuotaSettingsScope = class {
			document;
			listeners = /* @__PURE__ */ new Set();
			snapshot = {
				status: "loading",
				value: void 0,
				writable: true
			};
			/**
			* Load the current document. Call once before the card binds; repeated calls
			* are harmless and re-read the host.
			* @returns the effective values.
			*/
			async load() {
				try {
					this.document = await request({ headers: { accept: "application/json" } });
				} catch {
					return;
				}
				this.publish();
				return this.document.value;
			}
			/** @returns the stable snapshot the card reads (ready once loaded). */
			getSnapshot() {
				return this.snapshot;
			}
			/** @param listener - invoked after every snapshot change. @returns the disposer. */
			subscribe(listener) {
				this.listeners.add(listener);
				return () => {
					this.listeners.delete(listener);
				};
			}
			/**
			* Write one field.
			* @param field - field name inside the settings document.
			* @param value - the JSON-shaped value to store.
			* @returns whether the host accepted the write.
			*/
			async set(field, value) {
				return this.patch({ [field]: value });
			}
			/**
			* Clear one field: the value falls back to the schema default.
			* @param field - field name inside the settings document.
			* @returns whether the host accepted the clear.
			*/
			async unset(field) {
				return this.patch({ [field]: null });
			}
			/** Send one patch and adopt the host's answer. */
			async patch(patch) {
				const key = this.document?.key;
				if (key === void 0) return false;
				try {
					this.document = await request({
						method: "POST",
						headers: {
							"Content-Type": "application/json",
							"X-Qoder-Settings-Key": key
						},
						body: JSON.stringify(patch)
					});
					this.publish();
					return true;
				} catch {
					return false;
				}
			}
			/** Rebuild the cached snapshot and notify the subscribers. */
			publish() {
				this.snapshot = {
					status: this.document === void 0 ? "loading" : "ready",
					value: this.document?.value,
					writable: true
				};
				for (const listener of this.listeners) listener();
			}
		};
		//#endregion
		//#region src/client/SidebarQuotaCard.tsx
		/**
		* The sidebar footer quota card + the center-column dashboard it opens.
		*
		* The structure is a direct port of commandcode's plans & quota panel
		* (src/client/panel-view.tsx + panel.ts), which the user held up as the
		* reference: the card IS the button (the shell supplies no chrome), it renders
		* one block per merged package group — the group's remain/total, its
		* percentage and its bar — carries the last-updated time in the card's top
		* row, and opens a dashboard in the layout's keyed `main` slot on click. In
		* the 56px rail it collapses to a 36px icon button carrying the ring.
		*
		* Data comes from the variant's status route (poll, paused while hidden);
		* strings come from the `panel.qoder-quota` locale namespace; classes come
		* from `./quota-styles.ts` (`qdp-` prefix).
		*/
		/** Fallback translator: renders keys bare rather than throwing unbound. */
		const fallbackT = (key) => key;
		/**
		* Identity line under the dashboard card title: the redacted PAT tail when a
		* token is on file, plain signed-in copy if the summary is missing, and the
		* save-a-PAT hint otherwise. There is no nickname on a PAT document.
		*/
		function ownerText(status, t) {
			if (status === void 0 || status.status !== "signed-in") return t("quotaNotSignedIn");
			const tail = status.pat?.patTail;
			return tail === void 0 ? t("signedIn") : t("patTail", { tail: `****${tail}` });
		}
		/** Project the credit accounts into the card's bar list. */
		function buildBars(accounts) {
			const groups = visibleQuotaGroups(mergeCreditAccounts(accounts));
			const bars = [];
			for (const group of groups) {
				const percent = group.unlimited ? void 0 : clampPercent(group.remain, group.size);
				const detail = group.unlimited ? "∞" : percent === void 0 ? `${group.remain.toLocaleString()} · ?` : `${group.remain.toLocaleString()} / ${group.size.toLocaleString()}`;
				bars.push({
					label: group.packageName,
					detail,
					percent: percent === void 0 ? void 0 : `${Math.round(percent)}%`,
					barPercent: percent === void 0 ? 0 : Math.max(2, percent),
					warn: !group.unlimited && percent !== void 0 && percent < 20,
					packageEndTime: group.packageEndTime
				});
			}
			return bars;
		}
		/**
		* The quota ring — commandcode's glyph ported verbatim (`qdp-` classes): a
		* faint track plus an arc whose sweep is the consumption, drawn from 12
		* o'clock. Circumference 2πr = 45.55 at r = 7.25.
		*/
		function Ring({ percent, warn, size }) {
			const clamped = Math.min(100, Math.max(0, percent));
			const circumference = 45.55;
			const dashoffset = Math.round(circumference * (1 - clamped / 100) * 1e3) / 1e3;
			return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
				className: "qdp-glyph",
				"aria-hidden": "true",
				children: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("svg", {
					viewBox: "0 0 20 20",
					width: size,
					height: size,
					focusable: "false",
					children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("circle", {
						cx: "10",
						cy: "10",
						r: "7.25",
						fill: "none",
						stroke: "currentColor",
						strokeWidth: "1.5",
						opacity: "0.4"
					}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("circle", {
						cx: "10",
						cy: "10",
						r: "7.25",
						fill: "none",
						stroke: warn ? "var(--dsw-alias-state-error-primary)" : "currentColor",
						strokeWidth: "2.5",
						strokeLinecap: "round",
						strokeDasharray: String(circumference),
						strokeDashoffset: String(dashoffset),
						transform: "rotate(-90 10 10)"
					})]
				})
			});
		}
		/**
		* The dashboard's detail rows: EVERY package as the upstream reported it —
		* no merging, exhausted ones included. The sidebar card shows the merged
		* overview; this panel is the itemised ledger, so collapsing here would
		* destroy the only place a per-package figure is visible.
		*/
		function buildPackageRows(accounts) {
			return sortPackageRows(accounts).map((account) => {
				const percent = account.unlimited === true ? void 0 : clampPercent(account.remain, account.size);
				return {
					name: account.packageName,
					remain: account.remain,
					size: account.size,
					percent,
					warn: account.unlimited !== true && percent !== void 0 && percent < 20,
					packageEndTime: account.packageEndTime
				};
			});
		}
		/** Time-of-day formatter for the updated stamp. */
		function timeText(ms) {
			return new Date(ms).toLocaleTimeString(void 0, {
				hour: "2-digit",
				minute: "2-digit"
			});
		}
		/** One variant's sidebar quota card. */
		function SidebarQuotaCard(props) {
			const { t = fallbackT, statusPath, open } = props;
			const variantId = statusPath !== void 0 ? variantOfStatusPath(statusPath) : "qoder";
			const nameKey = variantId === "qoder-global" ? "quotaCardGlobal" : "quotaCardCN";
			const wide = props.wide !== false;
			const [failed, setFailed] = (0, react.useState)(false);
			(0, react.useSyncExternalStore)(onQuotaSettingsChange, quotaSettingsRevision);
			const enabled = variantId === "qoder" ? quotaToggles().cn : quotaToggles().global;
			const status = quotaStatus(variantId);
			const signedIn = status?.status === "signed-in";
			(0, react.useEffect)(() => {
				if (statusPath === void 0 || !enabled) return void 0;
				let disposed = false;
				let timer;
				const controller = new AbortController();
				const refresh = async () => {
					try {
						const response = await fetch(statusPath, {
							signal: controller.signal,
							headers: { accept: "application/json" }
						});
						const body = await response.json();
						if (disposed) return;
						if (!response.ok || !isQoderWebStatus(body)) {
							setFailed(true);
							return;
						}
						setFailed(false);
						noteQuotaStatus(variantId, body);
					} catch {
						if (!disposed) setFailed(true);
					}
				};
				const isHidden = () => typeof document !== "undefined" && document.hidden;
				const loop = () => {
					if (isHidden()) return;
					refresh();
				};
				timer = window.setInterval(loop, Math.max(6e4, quotaPollMs()));
				refresh();
				const onVisible = () => {
					if (!isHidden()) loop();
				};
				if (typeof document !== "undefined") document.addEventListener("visibilitychange", onVisible);
				return () => {
					disposed = true;
					controller.abort();
					if (timer !== void 0) window.clearInterval(timer);
					if (typeof document !== "undefined") document.removeEventListener("visibilitychange", onVisible);
				};
			}, [
				statusPath,
				enabled,
				variantId
			]);
			if (enabled === false) return null;
			const credits = status !== void 0 && "credits" in status ? status.credits : void 0;
			const bars = credits === void 0 ? [] : buildBars(credits.accounts ?? []);
			const lowest = bars.reduce((acc, bar) => {
				if (bar.percent === void 0) return acc;
				const value = Number.parseFloat(bar.percent);
				if (!Number.isFinite(value)) return acc;
				return acc === void 0 ? value : Math.min(acc, value);
			}, void 0);
			const ringPercent = failed || status === void 0 ? 0 : credits?.unlimited === true ? 100 : lowest ?? 0;
			const ringWarn = failed || lowest !== void 0 && lowest < 20;
			const fetchedAt = quotaStatusFetchedAt(variantId);
			const title = [
				t(nameKey),
				...bars.map((bar) => `${bar.label} ${bar.detail}${bar.percent === void 0 ? "" : ` (${bar.percent})`}`),
				fetchedAt !== void 0 ? `${t("quotaUpdated")} ${timeText(fetchedAt)}` : ""
			].filter((part) => part !== "").join(" · ");
			if (!wide) return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
				type: "button",
				className: "qdp-railButton",
				"aria-label": title,
				title,
				disabled: !signedIn,
				onClick: () => {
					if (!signedIn) return;
					open?.();
				},
				children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Ring, {
					percent: ringPercent,
					warn: ringWarn,
					size: 18
				})
			});
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("button", {
				type: "button",
				className: "qdp-foot",
				"aria-label": title,
				title,
				disabled: !signedIn,
				onClick: () => {
					if (!signedIn) return;
					open?.();
				},
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
					className: "qdp-footTop",
					children: [
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Ring, {
							percent: ringPercent,
							warn: ringWarn,
							size: 16
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							className: "qdp-footName",
							children: t(nameKey)
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { className: "qdp-spacer" }),
						fetchedAt !== void 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
							className: "qdp-updated",
							children: [
								t("quotaUpdated"),
								" ",
								timeText(fetchedAt)
							]
						}) : null
					]
				}), failed ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
					className: "qdp-footRow",
					children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						className: "qdp-footLabel",
						children: t("quotaError")
					})
				}) : bars.length === 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
					className: "qdp-footRow",
					children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						className: "qdp-footLabel",
						children: status === void 0 ? "…" : !("credits" in status) ? t("quotaNotSignedIn") : status.creditsError ?? t("quotaError")
					})
				}) : bars.map((bar, index) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
					className: "qdp-footRow",
					children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
						className: "qdp-footHead",
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: "qdp-footLabel",
								title: bar.packageEndTime !== void 0 ? `${t("quotaExpires")} ${bar.packageEndTime}` : t("quotaNoExpiry"),
								children: bar.label
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: "qdp-footAmount",
								children: bar.detail
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: "qdp-footPct",
								children: bar.percent ?? ""
							})
						]
					}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						className: "qdp-footBar",
						children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							className: bar.warn ? "qdp-footFill qdp-footFillWarn" : "qdp-footFill",
							style: { width: `${bar.barPercent}%` }
						})
					})]
				}, `${index}\u0000${bar.label}\u0000${bar.packageEndTime ?? ""}`))]
			});
		}
		/**
		* The center-column dashboard, registered into the layout's keyed `main` slot
		* under the id the footer cards select, so card → panel is one navigation
		* entry. One variant at a time, switched by tabs (commandcode's account-tab
		* pattern): CN and international are separate accounts with separate package
		* lists, so mixing them into one column would misattribute every number.
		*
		* The panel fetches BOTH routes itself on mount and on the shared poll
		* interval — a user opening the panel must never wait for the sidebar cards'
		* next tick, and must never see a stale "sign in" just because no poll had
		* run yet. The tab defaults to the variant whose card was clicked.
		*/
		function QuotaDashboard(props) {
			const { t = fallbackT, statusPaths, refresh, close, useQuotaDashboard, onVariantPicked } = props;
			(0, react.useSyncExternalStore)(onQuotaSettingsChange, quotaSettingsRevision);
			const state = useQuotaDashboard((s) => s);
			const followedPath = state.activePath;
			const [userPicked, setUserPicked] = (0, react.useState)(void 0);
			const activePathResolved = userPicked ?? followedPath;
			const activeVariant = variantOfStatusPath(activePathResolved);
			const status = quotaStatus(activeVariant);
			const loading = state.loading;
			const fetchedAt = state.fetchedAt;
			const credits = status !== void 0 && "credits" in status ? status.credits : void 0;
			const rows = credits === void 0 ? [] : buildPackageRows(credits.accounts ?? []);
			const nameKey = activeVariant === "qoder-global" ? "quotaCardGlobal" : "quotaCardCN";
			const signedIn = status?.status === "signed-in";
			const totalRemain = credits === void 0 ? 0 : credits.accounts.reduce((sum, account) => sum + account.remain, 0);
			const totalSize = credits?.totalSize ?? credits?.accounts.reduce((sum, account) => sum + account.size, 0) ?? 0;
			const totalPercent = clampPercent(totalRemain, totalSize);
			const plan = status !== void 0 && status.status === "signed-in" ? status.plan : void 0;
			return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
				className: "qdp-main",
				role: "region",
				"aria-label": t("quotaDashboardTitle"),
				children: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					className: "qdp-mainInner",
					children: [
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("header", {
							className: "qdp-header",
							children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
									className: "qdp-headerText",
									children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h2", {
										className: "qdp-title",
										children: t("quotaDashboardTitle")
									}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
										className: "qdp-subtitle",
										children: t("quotaDashboardSubtitle")
									})]
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { className: "qdp-spacer" }),
								fetchedAt !== void 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
									className: "qdp-meta",
									children: [
										t("quotaUpdated"),
										" ",
										timeText(fetchedAt)
									]
								}) : null,
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)(QdpButton, {
									variant: "outline",
									disabled: loading,
									onClick: () => refresh(),
									children: [loading ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)(QdpStateDot, { state: "ongoing" }) : null, loading ? t("quotaRefreshing") : t("quotaRefresh")]
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)(QdpIconButton, {
									label: t("quotaClose"),
									onClick: () => close(),
									children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										"aria-hidden": "true",
										children: "×"
									})
								})
							]
						}),
						statusPaths.length > 1 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
							className: "qdp-tabs",
							role: "tablist",
							"aria-label": t("quotaDashboardTitle"),
							children: statusPaths.map((path) => {
								const key = variantOfStatusPath(path) === "qoder-global" ? "quotaCardGlobal" : "quotaCardCN";
								return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
									type: "button",
									role: "tab",
									"aria-selected": path === activePathResolved,
									className: path === activePathResolved ? "qdp-tab qdp-tabActive" : "qdp-tab",
									onClick: () => {
										setUserPicked(path);
										onVariantPicked(path);
									},
									children: t(key)
								}, path);
							})
						}) : null,
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("section", {
							className: "qdp-dashCard",
							"aria-label": t(nameKey),
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								className: "qdp-dashCardHead",
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
									className: "qdp-inline",
									children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										className: "qdp-avatar",
										children: activeVariant === "qoder-global" ? "GL" : "CN"
									}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
										className: "qdp-cardIdentity",
										children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
											className: "qdp-dashCardTitle",
											children: t(nameKey)
										}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
											className: "qdp-cardOwner",
											children: ownerText(status, t)
										})]
									})]
								}), plan !== void 0 || credits?.unlimited === true ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
									className: "qdp-inline",
									children: [
										plan !== void 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)(QdpTag, { children: plan.planTierName }) : null,
										plan?.organizationName !== void 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)(QdpTag, { children: plan.organizationName }) : null,
										plan?.endDate !== void 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)(QdpTag, { children: `${t("quotaExpires")} ${plan.endDate}` }) : null,
										credits?.unlimited === true ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)(QdpTag, { children: t("quotaUnlimited") }) : null
									]
								}) : null]
							}), !signedIn ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
								className: "qdp-notice",
								children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
									className: "qdp-noticeTitle",
									children: t("quotaNotSignedIn")
								})
							}) : credits === void 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								className: "qdp-notice qdp-noticeError",
								children: [
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
										className: "qdp-noticeTitle",
										children: t("quotaError")
									}),
									status !== void 0 && status.status === "signed-in" && status.creditsError !== void 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
										className: "qdp-muted",
										children: status.creditsError
									}) : null,
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
										className: "qdp-actions",
										children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(QdpButton, {
											variant: "outline",
											disabled: loading,
											onClick: () => refresh(),
											children: t("quotaRefresh")
										})
									})
								]
							}) : /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("p", {
									className: "qdp-totalLine",
									children: [
										t("quotaTotalRemain"),
										" ",
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("strong", {
											className: "qdp-totalValue",
											children: totalRemain.toLocaleString()
										}),
										" / ",
										totalSize > 0 ? totalSize.toLocaleString() : t("quotaUnknownTotal")
									]
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
									className: "qdp-totalSub",
									children: t("quotaTotalShare", { percent: totalPercent === void 0 ? t("quotaUnknownTotal") : `${totalPercent.toFixed(2)}%` })
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
									className: "qdp-bar",
									role: "progressbar",
									"aria-label": t("quotaTotal"),
									...totalPercent === void 0 ? { "aria-valuetext": t("quotaUnknownTotal") } : {
										"aria-valuemin": 0,
										"aria-valuemax": 100,
										"aria-valuenow": Math.round(totalPercent)
									},
									children: totalPercent === void 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", { className: "qdp-barFill qdp-barFillIndeterminate" }) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
										className: totalPercent < 20 ? "qdp-barFill qdp-barFillWarn" : "qdp-barFill",
										style: { width: `${Math.max(2, totalPercent)}%` }
									})
								}),
								Number.isFinite(credits.total) || credits.cycleResetTime !== void 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("p", {
									className: "qdp-caption",
									children: [
										Number.isFinite(credits.total) ? t("quotaCycleUsed", { percent: String(credits.total) }) : null,
										Number.isFinite(credits.total) && credits.cycleResetTime !== void 0 ? " · " : null,
										credits.cycleResetTime !== void 0 ? `${t("quotaExpires")} ${credits.cycleResetTime}` : null
									]
								}) : null,
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h3", {
									className: "qdp-blockTitle",
									children: t("quotaByPackage")
								}),
								rows.length === 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
									className: "qdp-empty",
									children: t("quotaUnknownTotal")
								}) : /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("table", {
									className: "qdp-table",
									children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("thead", { children: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("tr", { children: [
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("th", { children: t("quotaColPackage") }),
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("th", { children: t("quotaColRemain") }),
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("th", { children: t("quotaColExpiry") })
									] }) }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("tbody", { children: rows.map((row, index) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("tr", { children: [
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("td", { children: row.name }),
										/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("td", {
											className: "qdp-num",
											children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
												className: "qdp-numText",
												children: [
													row.remain.toLocaleString(),
													" / ",
													row.size.toLocaleString()
												]
											}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
												className: "qdp-miniBar",
												children: row.percent === void 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { className: "qdp-footFill qdp-barFillIndeterminate" }) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
													className: row.warn ? "qdp-footFill qdp-footFillWarn" : "qdp-footFill",
													style: { width: `${Math.max(2, row.percent)}%` }
												})
											})]
										}),
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("td", {
											className: "qdp-expiry",
											title: row.packageEndTime ?? t("quotaNoExpiry"),
											children: row.packageEndTime ?? "—"
										})
									] }, `${index}\u0000${row.name}\u0000${row.packageEndTime ?? ""}`)) })]
								})
							] })]
						})
					]
				})
			});
		}
		//#endregion
		//#region src/client/quota-styles.ts
		/**
		* Stylesheet for the Qoder quota surfaces: the plugin configuration page, its
		* plugins-list summary line, the sidebar footer card (wide + 56px rail) and the
		* quota dashboard panel.
		*
		* Design contract (DSH web UI, 0.2.1-rc.1):
		* - every colour, radius, font role and stroke comes from a `--dsw-*` token
		*   (docs/web-styling.md); no literal palette values, no dark-theme selectors;
		* - radii follow the role table (docs/ui-radius.md): 20px cards (`xl`), 16px
		*   nested groups (`lg`), 12px controls (`md`), 8px
		*   compact (`sm`), 999px capsules paired with `corner-shape: round`;
		* - flat neutral borders draw at 0.5px; elevated/floating surfaces would use
		*   `--dsw-elevation-*` (these surfaces are flat, so they keep a real hairline);
		* - typography uses the composed `--dsw-font-*` roles so size and line height
		*   never drift apart; numbers are tabular;
		* - focus rings come from the global `:focus-visible` rule (2px, theme colour),
		*   never from a hardcoded outline colour.
		*
		* Classes are `qdp-` prefixed: several plugins inject GLOBAL CSS into the same
		* document, so prefixes must not collide. The stylesheet is returned as a
		* string (no DOM side effects at import time), installed once by the client
		* entry keyed by `data-plugin-css`, and removed when the plugin's fiber
		* unwinds.
		*/
		/** Stylesheet id (the `data-plugin-css` value that makes injection idempotent). */
		const QUOTA_CSS_ID = "dsh-connect-qoder-x/QuotaPanel.module.css";
		/** Install the stylesheet once; returns its disposer. */
		function injectQuotaCss() {
			if (typeof document === "undefined") return () => {};
			if (document.querySelector(`style[data-plugin-css="dsh-connect-qoder-x/QuotaPanel.module.css"]`) !== null) return () => {};
			const tag = document.createElement("style");
			tag.dataset.plugin = "dsh-connect-qoder-x";
			tag.dataset.pluginCss = QUOTA_CSS_ID;
			tag.textContent = QUOTA_CSS;
			document.head.appendChild(tag);
			return () => {
				tag.remove();
			};
		}
		/** The quota surfaces stylesheet. */
		const QUOTA_CSS = `
/* ------------------------------------------------- sidebar footer card */
/* The shell's foot area renders this list ABOVE the Settings seat, inside a
   flex ROW container whose occupants each declare a full-width line, so as a
   row it overflows the column. Force the sidebar's footer-action container into
   a column, anchored to "_footArea" because "footerActions" is also used by the
   ask-user-question dialog — an unanchored rule would stack THAT dialog's
   buttons too. Anchoring keeps the fix scoped to the sidebar; the descendant
   combinator survives a wrapper appearing between the two. The rule is
   idempotent when another plugin ships the same fix. */
[class*="_footArea"] [class*="_footerActions"]{flex-direction:column}

/* The wide card: the shell supplies no chrome, the occupant owns its surface.
   Settings-card material, radius xl, and a quiet one-step hover. */
.qdp-foot{box-sizing:border-box;flex:0 0 auto;width:100%;min-width:0;display:flex;flex-direction:column;gap:8px;margin:0 0 4px;padding:10px 12px;font:var(--dsw-font-xs-13);color:var(--dsw-alias-label-secondary);text-align:left;cursor:pointer;border:0.5px solid var(--dsw-alias-settings-card-stroke);border-radius:var(--dsw-radius-xl);background:var(--dsw-alias-settings-card-fill);transition:background .16s var(--ds-ease-in-out),border-color .16s var(--ds-ease-in-out)}
.qdp-foot:hover{background:var(--dsw-alias-interactive-bg-hover-solid);border-color:var(--dsw-alias-border-l3)}
.qdp-foot:active{background:var(--dsw-alias-interactive-bg-active)}
.qdp-foot:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:2px}
.qdp-footTop{align-items:center;gap:8px;min-width:0;display:flex}
.qdp-footName{white-space:nowrap;text-overflow:ellipsis;color:var(--dsw-alias-label-primary);min-width:0;overflow:hidden;font:var(--dsw-font-s-strong-14)}
.qdp-updated{flex:none;margin-left:auto;color:var(--dsw-alias-label-caption);font:var(--dsw-font-xxxs-11);font-variant-numeric:tabular-nums;white-space:nowrap}
/* One block per merged package group: a head line carrying the group's own
   remain/total, then the FULL-WIDTH bar under it. */
.qdp-footRow{display:flex;flex-direction:column;gap:4px;min-width:0}
.qdp-footHead{align-items:baseline;gap:8px;min-width:0;display:flex}
.qdp-footLabel{flex:1;color:var(--dsw-alias-label-tertiary);font:var(--dsw-font-xxs-12);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.qdp-footAmount{flex:none;color:var(--dsw-alias-label-secondary);font:var(--dsw-font-xxs-12);font-variant-numeric:tabular-nums;white-space:nowrap}
/* The card's markup must stay PHRASING content — it can render inside a host
   button — so these bars are spans, not divs. display:block is load-bearing:
   an inline box ignores width and height. */
.qdp-footBar{display:block;background:var(--dsw-alias-bg-module-platform);border-radius:999px;corner-shape:round;height:4px;overflow:hidden}
.qdp-footFill{display:block;background:var(--dsw-alias-state-business-primary);border-radius:999px;corner-shape:round;height:100%;transition:width .3s var(--ds-ease-in-out)}
.qdp-footFillWarn{background:var(--dsw-alias-state-error-primary)}
.qdp-footPct{flex:none;width:34px;color:var(--dsw-alias-label-secondary);text-align:right;font:var(--dsw-font-xxs-12);font-variant-numeric:tabular-nums}

/* The 56px rail: one icon button on the shell's own rail geometry (36px cell). */
.qdp-railButton{box-sizing:border-box;width:36px;height:36px;flex:none;display:inline-flex;justify-content:center;align-items:center;margin:0 0 4px;padding:0;color:var(--dsw-alias-label-secondary);cursor:pointer;background:0 0;border:0;border-radius:var(--dsw-radius-sm)}
.qdp-railButton:hover{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-interactive-bg-hover)}
.qdp-railButton:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:2px}

/* The ring glyph: sized by its own width/height attribute. */
.qdp-glyph{flex:none;display:inline-flex;justify-content:center;align-items:center;color:var(--dsw-alias-state-business-primary)}

/* ------------------------------------------------- shared primitives */
/* Sections are settings cards on the plugin page and plain groups inside the
   dashboard. fill/stroke tokens are bound on body by ui-theme (base.css). */
.qdp-section{box-sizing:border-box;display:flex;flex-direction:column;gap:16px;padding:20px 22px;border:0.5px solid var(--dsw-alias-settings-card-stroke);border-radius:var(--dsw-radius-xl);background:var(--dsw-alias-settings-card-fill)}
.qdp-sectionHead{display:flex;align-items:center;justify-content:space-between;gap:12px;min-width:0}
.qdp-sectionTitle{margin:0;color:var(--dsw-alias-label-primary);font:var(--dsw-font-s-strong-14)}
.qdp-sectionMeta{color:var(--dsw-alias-label-caption);font:var(--dsw-font-xxs-12);font-variant-numeric:tabular-nums}
.qdp-sectionBody{display:flex;flex-direction:column;gap:12px;min-width:0}

/* A settings row: text block left, control flush right, hairline under. */
.qdp-row{display:flex;align-items:center;justify-content:space-between;gap:24px;padding:12px 0;border-bottom:0.5px solid var(--dsw-alias-border-l2)}
.qdp-row:last-child{border-bottom:0;padding-bottom:0}
.qdp-row:first-child{padding-top:0}
.qdp-rowText{display:flex;flex-direction:column;gap:2px;min-width:0;flex:1}
.qdp-rowTitle{color:var(--dsw-alias-label-primary);font:var(--dsw-font-s-14)}
.qdp-rowDesc{margin:0;color:var(--dsw-alias-label-secondary);font:var(--dsw-font-xxs-12)}
.qdp-rowControl{display:flex;align-items:center;gap:8px;flex:none}
.qdp-stack{display:flex;flex-direction:column;gap:12px;min-width:0}
.qdp-inline{display:flex;align-items:center;gap:8px;min-width:0;flex-wrap:wrap}
.qdp-muted{margin:0;color:var(--dsw-alias-label-tertiary);font:var(--dsw-font-xxs-12)}
.qdp-caption{margin:0;color:var(--dsw-alias-label-caption);font:var(--dsw-font-xxxs-11)}
.qdp-num{font-variant-numeric:tabular-nums}
.qdp-link{color:var(--dsw-alias-link);font:var(--dsw-font-s-strong-14);font-weight:500;text-decoration:none;border-radius:var(--dsw-radius-xs)}
.qdp-link:hover,.qdp-link:focus-visible{text-decoration:underline;text-decoration-style:dotted;text-underline-offset:3px}
.qdp-empty{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:6px;padding:24px 16px;color:var(--dsw-alias-label-tertiary);font:var(--dsw-font-xs-13);text-align:center}
.qdp-alert{display:flex;flex-direction:column;gap:4px;padding:10px 12px;border:1px solid var(--dsw-alias-state-warn-primary);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-state-warn-tertiary);color:var(--dsw-alias-state-warn-label);font:var(--dsw-font-xs-13)}
.qdp-alertError{border-color:var(--dsw-alias-state-error-primary);background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-state-error-primary)}
.qdp-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.qdp-iconButton{box-sizing:border-box;width:28px;height:28px;flex:none;display:inline-flex;justify-content:center;align-items:center;padding:0;color:var(--dsw-alias-label-secondary);cursor:pointer;background:0 0;border:0;border-radius:var(--dsw-radius-sm)}
.qdp-iconButton:hover{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-interactive-bg-hover)}
.qdp-iconButton:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:2px}
.qdp-iconButton:disabled{color:var(--dsw-alias-label-tertiary);cursor:default}
.qdp-skeleton{display:block;height:8px;border-radius:var(--dsw-radius-xs);background:var(--dsw-alias-bg-skeleton);animation:qdp-pulse 1.4s var(--ds-ease-in-out) infinite}
@keyframes qdp-pulse{0%,100%{opacity:.6}50%{opacity:1}}

/* ------------------------------------------------------------ dashboard */
/* The center column in the layout frame: fill it, scroll the content column,
   and cap the reading width like the harness's own panels. */
.qdp-main{display:block;width:100%;height:100%;overflow:auto;background:var(--dsw-alias-bg-layer-1)}
.qdp-mainInner{display:flex;flex-direction:column;gap:20px;max-width:720px;margin:0 auto;padding:28px 24px 48px;color:var(--dsw-alias-label-primary)}
.qdp-header{display:flex;align-items:center;gap:12px;flex-wrap:wrap;min-width:0}
.qdp-headerText{display:flex;flex-direction:column;gap:2px;min-width:0;flex:1}
.qdp-title{margin:0;color:var(--dsw-alias-label-primary);font:var(--dsw-font-l-20)}
.qdp-subtitle{margin:0;color:var(--dsw-alias-label-tertiary);font:var(--dsw-font-xs-13)}
.qdp-spacer{flex:1}
.qdp-meta{color:var(--dsw-alias-label-tertiary);font:var(--dsw-font-xxs-12);font-variant-numeric:tabular-nums}
.qdp-close,.qdp-refresh{box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center;gap:6px;height:28px;padding:0 10px;color:var(--dsw-alias-label-secondary);cursor:pointer;font:var(--dsw-font-xxs-12);background:0 0;border:0.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-sm)}
.qdp-close{min-width:28px;padding:0}
.qdp-close:hover,.qdp-refresh:hover:not(:disabled){color:var(--dsw-alias-label-primary);background:var(--dsw-alias-interactive-bg-hover)}
.qdp-close:focus-visible,.qdp-refresh:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:2px}
.qdp-refresh:disabled{color:var(--dsw-alias-label-tertiary);cursor:default}
.qdp-close span{font-size:16px;line-height:1}

/* Notices (signed-out / error). */
.qdp-notice{display:flex;flex-direction:column;gap:6px;padding:16px 18px;border:0.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-lg);background:var(--dsw-alias-bg-module-platform)}
.qdp-noticeError{border-color:var(--dsw-alias-state-error-primary)}
.qdp-noticeTitle{margin:0;color:var(--dsw-alias-label-primary);font:var(--dsw-font-s-strong-14)}

/* One card per variant on the dashboard. Flat settings-card material. */
.qdp-dashCard{list-style:none;display:flex;flex-direction:column;gap:16px;padding:20px 22px;border:0.5px solid var(--dsw-alias-settings-card-stroke);border-radius:var(--dsw-radius-xl);background:var(--dsw-alias-settings-card-fill)}
.qdp-dashCardHead{display:flex;flex:1;flex-direction:column;align-items:flex-start;gap:4px;min-width:0;flex-wrap:wrap}
.qdp-avatar{flex:none;display:inline-flex;justify-content:center;align-items:center;width:32px;height:32px;color:var(--dsw-alias-label-primary-foreground);background:var(--dsw-alias-state-business-primary);border-radius:50%;corner-shape:round;font:var(--dsw-font-xxs-strong-12)}
.qdp-cardIdentity{display:flex;flex-direction:column;gap:1px;min-width:0}
.qdp-dashCardTitle{color:var(--dsw-alias-label-primary);text-align:left;font:var(--dsw-font-base-strong-16)}
.qdp-cardOwner{max-width:220px;color:var(--dsw-alias-label-tertiary);font:var(--dsw-font-xxxs-11);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}

/* Quota blocks: each merged group is a label row plus the track. */
.qdp-bar{height:6px;overflow:hidden;background:var(--dsw-alias-bg-module-platform);border-radius:999px;corner-shape:round}
.qdp-barFill{height:100%;background:var(--dsw-alias-state-business-primary);border-radius:999px;corner-shape:round;transition:width .3s var(--ds-ease-in-out)}
.qdp-barFillWarn{background:var(--dsw-alias-state-error-primary)}
.qdp-barFillIndeterminate{width:100%;opacity:.25}
.qdp-windowReset{margin:0;color:var(--dsw-alias-label-tertiary);font:var(--dsw-font-xxs-12)}

/* Read-only badges. */
.qdp-badge{display:inline-flex;align-items:center;height:20px;padding:0 8px;white-space:nowrap;background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-secondary);border-radius:999px;corner-shape:round;font:var(--dsw-font-xxxs-strong-11)}

/* Overall remaining + share line, ahead of the detail table. */
.qdp-totalLine{margin:0;display:flex;align-items:baseline;gap:6px;flex-wrap:wrap;color:var(--dsw-alias-label-secondary);font:var(--dsw-font-s-14)}
.qdp-totalValue{margin-left:auto;color:var(--dsw-alias-label-primary);font:var(--dsw-font-l-20);font-variant-numeric:tabular-nums}
.qdp-totalSub{margin:0;color:var(--dsw-alias-label-tertiary);font:var(--dsw-font-xxs-12);font-variant-numeric:tabular-nums}
.qdp-blockTitle{margin:0;color:var(--dsw-alias-label-primary);font:var(--dsw-font-s-strong-14)}

/* Detail table: every package, unmerged. Hairlines, tabular numbers, quiet
   column heads. */
.qdp-table{width:100%;border-collapse:collapse;color:var(--dsw-alias-label-secondary);font:var(--dsw-font-xxs-12)}
.qdp-table th{padding:6px 10px;color:var(--dsw-alias-label-caption);text-align:left;font:var(--dsw-font-xxxs-strong-11);letter-spacing:.02em;border-bottom:0.5px solid var(--dsw-alias-border-l2)}
.qdp-table td{padding:9px 10px;vertical-align:top;border-bottom:0.5px solid var(--dsw-alias-border-l2)}
.qdp-table tbody tr:last-child td{border-bottom:0}
.qdp-num{min-width:140px}
.qdp-numText{display:block;margin-bottom:4px;color:var(--dsw-alias-label-primary);font-variant-numeric:tabular-nums}
.qdp-miniBar{display:block;height:4px;overflow:hidden;background:var(--dsw-alias-bg-module-platform);border-radius:999px;corner-shape:round}
.qdp-expiry{white-space:nowrap;color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums}

/* Variant switcher on the dashboard: text tabs (kept quiet next to the cards). */
.qdp-tabs{display:flex;flex-wrap:wrap;gap:2px;padding:4px;border-radius:var(--dsw-radius-md);background:var(--dsw-alias-interactive-bg-hover)}
.qdp-tab{display:inline-flex;align-items:center;gap:6px;padding:4px 12px;color:var(--dsw-alias-label-tertiary);cursor:pointer;font:var(--dsw-font-xxs-strong-12);background:0 0;border:0;border-radius:var(--dsw-radius-sm)}
.qdp-tab:hover:not(.qdp-tabActive){color:var(--dsw-alias-label-primary)}
.qdp-tabActive{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-1);box-shadow:var(--dsw-elevation-soft)}
.qdp-tab:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:1px}

/* ------------------------------------------------- plugin card (page) */
/* The page body: the host detail page already draws the crumb, icon, title,
   version and description, so this is a plain column of sections — no outer
   card chrome, no second heading. */
.qdp-card{display:flex;flex-direction:column;gap:20px;min-width:0;padding:0;margin:0;background:none;border:0;list-style:none}
.qdp-cardOpen{background:none}
.qdp-cardBody{display:flex;flex-direction:column;gap:20px;margin:0;padding:0;min-width:0}
/* Legacy disclosure header (kept for the bundle-config seat and for the
   summary-line anatomy; the page seat renders body-only). */
.qdp-cardHeader{display:flex;align-items:flex-start;gap:12px;width:100%;padding:14px 16px;color:inherit;cursor:pointer;text-align:left;background:none;border:0;border-radius:var(--dsw-radius-xl)}
.qdp-cardHeader:hover{background:var(--dsw-alias-interactive-bg-hover)}
.qdp-cardHead{display:flex;flex:1;flex-direction:column;align-items:flex-start;gap:2px;min-width:0;flex-wrap:wrap}
.qdp-cardTitle{color:var(--dsw-alias-label-primary);text-align:left;font:var(--dsw-font-base-strong-16)}
.qdp-cardDescription{color:var(--dsw-alias-label-tertiary);text-align:left;font:var(--dsw-font-xs-13)}
.qdp-cardIcon{flex:none;display:block;width:36px;height:36px;border-radius:var(--dsw-radius-sm)}
.qdp-cardChevron{flex:none;width:7px;height:7px;margin:6px 4px 0 0;border-right:1.5px solid var(--dsw-alias-label-tertiary);border-bottom:1.5px solid var(--dsw-alias-label-tertiary);transform:rotate(45deg);transition:transform .16s var(--ds-ease-in-out)}
.qdp-cardChevronOpen{transform:rotate(225deg)}

/* Status header inside the account section. */
.qdp-accountBox{display:flex;align-items:center;justify-content:space-between;gap:16px;min-width:0}
.qdp-accountState{display:flex;align-items:center;gap:8px;color:var(--dsw-alias-label-primary);font:var(--dsw-font-base-strong-16)}
.qdp-accountExpiry{color:var(--dsw-alias-label-tertiary);font:var(--dsw-font-xxs-12)}
.qdp-accountMain{display:flex;flex-direction:column;gap:3px;min-width:0}

/* PAT (credential) group. */
.qdp-patBox{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;padding:12px 0;border-top:0.5px solid var(--dsw-alias-border-l2)}
.qdp-patBoxCopy{display:flex;flex-direction:column;gap:2px;min-width:0}
.qdp-patBoxMeta{color:var(--dsw-alias-label-tertiary);font:var(--dsw-font-xxs-12);font-variant-numeric:tabular-nums}
.qdp-body{margin:0;color:var(--dsw-alias-label-tertiary);font:var(--dsw-font-xs-13)}
.qdp-error{margin:0;color:var(--dsw-alias-state-error-primary);font:var(--dsw-font-xs-13)}
.qdp-rate{color:var(--dsw-alias-label-tertiary);font:var(--dsw-font-xxs-12)}

/* Buttons: the local 'QdpButton' control (src/client/controls.tsx) renders
   these classes on the official small-button geometry (28px / R8 / 12-18). */
.qdp-btn{box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center;gap:4px;height:28px;padding:0 10px;color:var(--dsw-alias-label-secondary);cursor:pointer;font:var(--dsw-font-xxs-strong-12);background:0 0;border:0.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-sm)}
.qdp-btn:hover:not(:disabled){color:var(--dsw-alias-label-primary);background:var(--dsw-alias-interactive-bg-hover)}
.qdp-btn:disabled{color:var(--dsw-alias-label-tertiary);background:var(--dsw-alias-interactive-bg-hover);border-color:transparent;cursor:default}
.qdp-btn:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:2px}
.qdp-btnPrimary{color:var(--dsw-alias-label-primary-foreground);background:var(--dsw-alias-button-primary-fill);border-color:var(--dsw-alias-button-primary-fill)}
.qdp-btnPrimary:hover:not(:disabled){color:var(--dsw-alias-label-primary-foreground);background:var(--dsw-alias-button-primary-hover);border-color:var(--dsw-alias-button-primary-hover)}
.qdp-btnDanger{color:var(--dsw-alias-label-primary-foreground);background:var(--dsw-alias-state-error-primary);border-color:var(--dsw-alias-state-error-primary)}
.qdp-btnDangerQuiet{color:var(--dsw-alias-state-error-primary)}
.qdp-btnDangerQuiet:hover:not(:disabled){color:var(--dsw-alias-state-error-primary);background:var(--dsw-alias-interactive-bg-hover-danger)}
.qdp-btnGhost{border-color:transparent}

/* Medium action button (36px / R12) for the one CTA that deserves emphasis. */
.qdp-btnMd{height:36px;padding:0 14px;font:var(--dsw-font-s-strong-14);border-radius:var(--dsw-radius-md)}

/* Toggle: 36x20 capsule with a 16px thumb — the official switch geometry. */
.qdp-switch{box-sizing:border-box;position:relative;display:inline-flex;flex:none;align-items:center;width:36px;height:20px;padding:2px;cursor:pointer;background:var(--dsw-alias-border-l3);border:0;border-radius:999px;corner-shape:round;transition:background .12s var(--ds-ease-in-out)}
.qdp-switch[aria-checked="true"]{background:var(--dsw-alias-brand-primary)}
.qdp-switch:disabled{opacity:.5;cursor:default}
.qdp-switch:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:2px}
.qdp-switchThumb{display:block;width:16px;height:16px;background:var(--dsw-alias-switch-thumb);border-radius:50%;corner-shape:round;transition:transform .12s var(--ds-ease-in-out)}
.qdp-switch[aria-checked="true"] .qdp-switchThumb{background:var(--dsw-alias-label-primary-foreground)}
.qdp-switch[aria-checked="true"] .qdp-switchThumb{transform:translateX(16px)}

/* Status dot (8px), the shell's own state vocabulary. */
.qdp-dot{display:inline-flex;flex:none;width:8px;height:8px;border-radius:50%;corner-shape:round;background:var(--dsw-alias-state-idle-primary)}
.qdp-dotDone{background:var(--dsw-alias-state-success-primary)}
.qdp-dotOngoing{background:var(--dsw-alias-state-business-primary);animation:qdp-pulse 1.4s var(--ds-ease-in-out) infinite}
.qdp-dotWarn{background:var(--dsw-alias-state-warn-primary)}
.qdp-dotError{background:var(--dsw-alias-state-error-primary)}

/* Read-only tag/capsule. */
.qdp-tag{display:inline-flex;align-items:center;gap:4px;height:20px;padding:0 8px;color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-module-platform);border-radius:999px;corner-shape:round;font:var(--dsw-font-xxxs-strong-11);white-space:nowrap}
.qdp-tagSuccess{color:var(--dsw-alias-state-success-primary);background:var(--dsw-alias-state-success-tertiary)}
.qdp-tagWarn{color:var(--dsw-alias-state-warn-label);background:var(--dsw-alias-state-warn-tertiary)}
.qdp-tagError{color:var(--dsw-alias-state-error-primary);background:var(--dsw-alias-interactive-bg-hover-danger)}

/* Single-line text input (local 'QdpInput'): 32px / R12, hairline at rest. */
.qdp-input{box-sizing:border-box;display:flex;flex:1;min-width:200px;height:32px;padding:0 10px;color:var(--dsw-alias-label-primary);font:var(--dsw-font-s-14);background:var(--dsw-alias-bg-module-platform);border:0.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-md)}
.qdp-input::placeholder{color:var(--dsw-alias-label-caption)}
.qdp-input:hover:not(:disabled){border-color:var(--dsw-alias-border-l3)}
.qdp-input:focus-visible{border-color:var(--dsw-alias-state-business-primary);outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:1px}
.qdp-input:disabled{opacity:.5;cursor:default}
.qdp-inputShort{flex:0 0 auto;width:56px;min-width:0;padding:0 8px;text-align:center;font-variant-numeric:tabular-nums}

/* Credential input row (local 'QdpInput'): 32px / R12, hairline at rest. */
.qdp-patRow{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.qdp-patInput{box-sizing:border-box;flex:1;min-width:200px;height:32px;padding:0 8px;color:var(--dsw-alias-label-primary);font:var(--dsw-font-s-14);background:var(--dsw-alias-bg-module-platform);border:0.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-md)}
.qdp-patInput::placeholder{color:var(--dsw-alias-label-caption)}
.qdp-patInput:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:1px}

/* Segmented control: 4px inset track, R12 outer / R8 segments (local control). */
.qdp-seg{display:flex;align-items:center;gap:2px;padding:4px;background:var(--dsw-alias-interactive-bg-hover);border-radius:var(--dsw-radius-md)}
.qdp-segItem{flex:1;display:flex;align-items:center;justify-content:center;gap:6px;height:28px;padding:0 16px;color:var(--dsw-alias-label-secondary);cursor:pointer;font:var(--dsw-font-xs-strong-13);background:0 0;border:0;border-radius:var(--dsw-radius-sm);transition:background .16s var(--ds-ease-in-out),color .16s var(--ds-ease-in-out)}
.qdp-segItem:hover{color:var(--dsw-alias-label-primary)}
.qdp-segItem:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:1px}
.qdp-segItemActive{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-1);box-shadow:var(--dsw-elevation-soft)}
.qdp-segCell{display:flex;align-items:center;gap:2px;flex:1;min-width:0}
.qdp-segSwitch{display:inline-flex;flex:none;align-items:center;padding:0 8px 0 2px;cursor:pointer}
.qdp-segSwitch input{margin:0;cursor:pointer;accent-color:var(--dsw-alias-state-business-primary)}
.qdp-segSwitch input:disabled{opacity:.4;cursor:default}
.qdp-contextPicker{display:flex;align-items:center;justify-content:flex-end;gap:8px;flex-wrap:wrap}

/* Usage & check-in group: one surfaced block, usage above a hairline, check-in
   below. Nested group radius = outer card 20 − inset 4 → 16. */
.qdp-panel{display:flex;flex-direction:column;gap:14px;padding:16px;background:var(--dsw-alias-bg-module-platform);border:0;border-radius:var(--dsw-radius-lg)}
.qdp-panel + .qdp-panel{margin-top:-4px}
.qdp-panelHead{display:flex;align-items:baseline;justify-content:space-between;gap:12px}
.qdp-panelTitle{margin:0;color:var(--dsw-alias-label-primary);font:var(--dsw-font-s-strong-14)}
.qdp-panelMeta{color:var(--dsw-alias-label-tertiary);font:var(--dsw-font-xxs-12);font-variant-numeric:tabular-nums}
.qdp-list{display:flex;flex-direction:column;gap:10px;min-width:0}
.qdp-group{display:flex;flex-direction:column;gap:10px;min-width:0}
.qdp-label{display:flex;justify-content:space-between;gap:12px;color:var(--dsw-alias-label-secondary);font:var(--dsw-font-xxs-12)}
.qdp-logList{display:flex;flex-direction:column;gap:4px}
.qdp-track{height:6px;overflow:hidden;background:var(--dsw-alias-bg-layer-1);border-radius:999px;corner-shape:round}
.qdp-settingsFlat{display:flex;flex-direction:column;gap:4px;padding-top:14px;border-top:0.5px solid var(--dsw-alias-border-l2)}
.qdp-twoUp{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:12px;align-items:stretch}
@media (max-width:760px){.qdp-twoUp{grid-template-columns:1fr}}

/* Pane tabs: underline strip like the plugins settings tabs. */
.qdp-paneTabs{display:flex;gap:20px;margin-top:2px;border-bottom:0.5px solid var(--dsw-alias-border-l2)}
.qdp-paneTab{margin-bottom:-1px;padding:7px 1px 9px;color:var(--dsw-alias-label-tertiary);cursor:pointer;font:var(--dsw-font-xs-13);background:0 0;border:0;border-bottom:2px solid transparent}
.qdp-paneTab:hover{color:var(--dsw-alias-label-primary)}
.qdp-paneTab:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:2px;border-radius:2px}
.qdp-paneTabActive{color:var(--dsw-alias-label-primary);font-weight:500;border-bottom-color:var(--dsw-alias-label-primary)}

/* Model list: one framed list (R16) whose rows own the hairline dividers. */
.qdp-modelHead{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap}
.qdp-modelColumns{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:0 2px 2px;color:var(--dsw-alias-label-caption);font:var(--dsw-font-xxxs-11)}
.qdp-modelList{overflow:hidden;background:var(--dsw-alias-settings-card-fill);border:0.5px solid var(--dsw-alias-settings-card-stroke);border-radius:var(--dsw-radius-lg)}
.qdp-modelRow{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;padding:12px 14px}
.qdp-modelRow + .qdp-modelRow{border-top:0.5px solid var(--dsw-alias-border-l2)}
.qdp-modelEnable{display:flex;flex:1;align-items:center;gap:10px;min-width:0;cursor:pointer}
.qdp-modelEnable input{flex:none;width:16px;height:16px;margin:0;cursor:pointer;accent-color:var(--dsw-alias-state-business-primary)}
.qdp-modelCopy{display:flex;flex-direction:column;gap:1px;min-width:0}
.qdp-modelName{overflow:hidden;color:var(--dsw-alias-label-primary);text-overflow:ellipsis;white-space:nowrap;font:var(--dsw-font-s-14)}
.qdp-modelRate{margin-left:6px;color:var(--dsw-alias-label-tertiary);font:var(--dsw-font-xxxs-11);font-variant-numeric:tabular-nums}
.qdp-modelMeta{white-space:nowrap;color:var(--dsw-alias-label-tertiary);font:var(--dsw-font-xxxs-11)}

/* Per-model context-window slider (Qoder's own control: success-toned). */
.qdp-windowSlider{display:flex;flex:none;flex-direction:column;gap:4px;width:170px}
.qdp-windowTrack{position:relative;display:flex;align-items:center;height:18px}
.qdp-windowTrack::before{content:"";position:absolute;left:0;right:0;height:6px;background:var(--dsw-alias-bg-module-platform);border-radius:999px;corner-shape:round}
.qdp-windowFill{position:absolute;left:0;height:6px;background:var(--dsw-alias-state-business-primary);opacity:.22;border-radius:999px;corner-shape:round}
.qdp-windowKnob{position:absolute;width:2px;height:14px;background:var(--dsw-alias-state-business-primary);border-radius:1px;corner-shape:round;transform:translateX(-1px)}
.qdp-windowInput{position:absolute;left:0;right:0;width:100%;height:18px;margin:0;opacity:0;cursor:pointer;-webkit-appearance:none;appearance:none}
.qdp-windowInput:disabled{cursor:default}
.qdp-windowTicks{position:relative;height:14px;color:var(--dsw-alias-label-tertiary);font:var(--dsw-font-xxxs-11);font-variant-numeric:tabular-nums}
.qdp-windowTick{position:absolute;white-space:nowrap;transform:translateX(-50%)}
.qdp-windowTickMark{display:inline-block;width:1px;height:4px;background:var(--dsw-alias-border-l4)}

/* Check-in ledger. */
.qdp-ledgerRow{display:flex;align-items:baseline;justify-content:space-between;gap:10px;color:var(--dsw-alias-label-secondary);font:var(--dsw-font-xxs-12)}
.qdp-ledgerList{max-height:216px;overflow-y:auto}
.qdp-ledgerDate{white-space:nowrap;color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums}
.qdp-ledgerAmount{flex:none;color:var(--dsw-alias-label-primary);font-weight:500;font-variant-numeric:tabular-nums}
.qdp-ledgerExpiry{margin-left:auto;white-space:nowrap;color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums}
.qdp-ledgerExpired{color:var(--dsw-alias-state-error-primary)}
.qdp-claimBtn{width:100%;justify-content:center}
.qdp-ledgerFoot{display:flex;align-items:baseline;justify-content:space-between;gap:10px;padding-top:10px;border-top:0.5px solid var(--dsw-alias-border-l2)}
.qdp-ledgerFootValue{color:var(--dsw-alias-label-primary);font-weight:500;font-variant-numeric:tabular-nums}

/* The composer probe control: a compact pill button. */
.qdp-probe{box-sizing:border-box;display:inline-flex;align-items:center;gap:6px;height:28px;padding:0 10px;color:var(--dsw-alias-label-secondary);cursor:pointer;font:var(--dsw-font-xxs-strong-12);background:0 0;border:0.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-sm)}
.qdp-probe:hover{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-interactive-bg-hover)}
.qdp-probe:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:2px}
.qdp-probe:disabled{opacity:.4;cursor:default}
.qdp-probeDot{flex:none;width:6px;height:6px;border-radius:50%;corner-shape:round;background:var(--dsw-alias-state-idle-primary)}
.qdp-probeDotOn{background:var(--dsw-alias-state-success-primary)}
.qdp-probeDotWarn{background:var(--dsw-alias-state-warn-primary)}
.qdp-probeDotError{background:var(--dsw-alias-state-error-primary)}
.qdp-probeWrap{display:inline-flex;position:relative;align-items:center;transform:translateY(2px);margin-right:-8px}
.qdp-probeLabel{color:var(--dsw-alias-label-tertiary);font:var(--dsw-font-xxxs-11);white-space:nowrap}
/* Tooltip: dark capsule, elevation carries the edge (no border + shadow pairing). */
.qdp-probeTip{position:absolute;left:50%;bottom:calc(100% + 8px);z-index:1000;transform:translateX(-50%);padding:4px 8px;white-space:nowrap;pointer-events:none;color:var(--dsw-alias-label-primary-foreground);background:var(--dsw-alias-tooltip-bg);border-radius:var(--dsw-radius-sm);box-shadow:var(--dsw-elevation-soft);font:var(--dsw-font-xxs-12)}
/* Confirmation/result surface: light elevated popover, same anchor. */
.qdp-probeBubble{position:absolute;right:0;bottom:calc(100% + 8px);z-index:1001;display:flex;flex-direction:column;gap:10px;width:260px;padding:12px 14px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-1);border-radius:var(--dsw-radius-md);box-shadow:var(--dsw-elevation-panel);font:var(--dsw-font-xxs-12)}
.qdp-probeBubbleRow{display:flex;justify-content:flex-end;gap:8px}
.qdp-probeNote{position:absolute;right:0;bottom:calc(100% + 8px);z-index:1001;display:flex;align-items:center;gap:12px;padding:8px 10px;white-space:nowrap;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-1);border-radius:var(--dsw-radius-md);box-shadow:var(--dsw-elevation-panel);font:var(--dsw-font-xxs-12)}
.qdp-bubble{position:absolute;z-index:120;display:flex;flex-direction:column;gap:6px;min-width:200px;max-width:320px;padding:10px 12px;background:var(--dsw-alias-tooltip-bg);border-radius:var(--dsw-radius-md);box-shadow:var(--dsw-elevation-panel);color:var(--dsw-alias-label-primary-foreground);font:var(--dsw-font-xxs-12)}
.qdp-bubbleTitle{font:var(--dsw-font-xxs-strong-12)}
.qdp-bubbleNote{opacity:.85}

@media (prefers-reduced-motion:reduce){
  .qdp-foot,.qdp-footFill,.qdp-barFill,.qdp-skeleton,.qdp-cardChevron,.qdp-segItem{transition:none;animation:none}
}
`;
		//#endregion
		//#region src/client/locales.ts
		/** Plugin-card copy registered under the settings.qoder locale namespace. */
		const en = {
			title: "Qoder",
			intro: "Use the models from your Qoder (China) account directly in DSH — paste a Personal Access Token, no browser sign-in flow.",
			titleAI: "Qoder Global",
			introAI: "Use the models from your Qoder Global account directly in DSH — paste a Personal Access Token, no browser sign-in flow.",
			unifiedTitle: "Qoder",
			unifiedIntro: "Sign in with a PAT to use your Qoder models in DSH — China and Global side by side, each with its own credential, model list and quota.",
			variantTabCN: "China",
			variantTabGlobal: "Global",
			expand: "Expand",
			collapse: "Collapse",
			loading: "Loading account…",
			signedOut: "Not signed in",
			signedOutHint: "Save a Personal Access Token to use Qoder (China) models in DSH.",
			signedOutHintAI: "Save a Personal Access Token to use Qoder Global models in DSH.",
			patHeading: "Personal Access Token",
			patGuide: "Generate a PAT in your qoder.com.cn account settings (Account → Personal Access Token), then paste it here.",
			patGuideAI: "Generate a PAT in your qoder.com account settings (Account → Personal Access Token), then paste it here.",
			patPlaceholder: "Paste the PAT generated on qoder.com.cn",
			patPlaceholderAI: "Paste the PAT generated on qoder.com",
			patSave: "Save",
			patSaving: "Validating and saving…",
			patSaved: "PAT saved.",
			patSaveFailed: "Save failed: {message}",
			patInvalid: "That PAT was rejected — generate a new one in your account settings and try again.",
			patUnreachable: "Could not reach Qoder to verify the PAT ({message}). The token was not saved — check the network and try again.",
			patReplace: "Replace PAT",
			patClear: "Clear PAT",
			patClearing: "Clearing PAT…",
			signedIn: "Signed in",
			patSourceCard: "source: saved via this card",
			patSourceEnv: "source: environment variable",
			patSourceCli: "source: command line",
			patSavedAt: "saved {time}",
			patTail: "ends {tail}",
			creditsHeading: "Available credit",
			tabStatus: "Status",
			tabContext: "Context window",
			tabModels: "Model visibility",
			tabDetails: "Credit details",
			tabCheckIn: "Check-in",
			paneUsage: "Auto check-in",
			variantEnable: "Enabled",
			accountSignedInAs: "Signed in: {name}",
			planTier: "Plan: {name}",
			planOrganization: "Organization: {name}",
			planEndsAt: "Term ends {date}",
			patBoxLabel: "Personal access token (PAT)",
			patRemove: "Remove",
			paneModels: "Models",
			modelsMergedHeading: "Models & context window",
			modelsMergedHint: "Toggle visibility per model; its context capacity (and the larger window it can reach) is stated beside it.",
			cardExpand: "Expand",
			cardCollapse: "Collapse",
			ledgerHeading: "Recent claims",
			ledgerExpiringHeading: "Expiring within {days} days",
			ledgerEmpty: "No claims recorded in this range.",
			ledgerExpiresAt: "Expires {date}",
			ledgerExpired: "Expired",
			checkInLogTime: "Check-in time",
			checkInLogResult: "Result",
			checkInLogAmount: "Credits",
			checkInLogEmpty: "No check-in logs recorded yet.",
			checkInLogShow: "Logs",
			checkInLogHide: "Hide log",
			checkInNow: "Claim now",
			checkInClaimedToday: "Claimed today",
			checkInChecking: "Claiming…",
			checkInRefresh: "Refresh",
			checkInRefreshing: "Refreshing…",
			checkInClear: "Clear logs",
			checkInClearing: "Clearing…",
			checkInNextRun: "Next automatic claim: {time}",
			creditsDetailHeading: "By package",
			creditsUsed: "Used this cycle: {percent}%",
			creditsUsedUnlimited: "This cycle: no usage cap",
			creditsNoData: "No data found",
			unlimitedQuota: "Unlimited",
			cycleResetAt: "Resets {time}",
			percentRemaining: "{percent}% remaining",
			percentUnknown: "Remaining share unknown",
			exactRemaining: "{remain} / {size} remaining",
			creditPackageUnknownSize: "{remain} remaining",
			creditsError: "Credit unavailable: {message}",
			refresh: "Refresh",
			refreshing: "Refreshing…",
			refreshModels: "Refresh from Qoder",
			refreshingModels: "Refreshing models…",
			jobTokenRefreshed: "Job token was auto-refreshed at {time} (upstream rejected the old one; the message recovered).",
			catalogLive: "Model list updated {time}",
			catalogSaved: "Showing the saved model list from {time}",
			catalogFallback: "Showing the built-in model list (not yet updated from Qoder)",
			catalogError: "Last update failed: {message}",
			requestFailed: "Request failed",
			statusRefreshFailed: "Refresh failed: {message} — showing the last known state",
			statusResponseInvalid: "Qoder returned an unreadable status reply",
			accountHeading: "Account",
			quotaSectionUsage: "Usage & check-in",
			quotaSectionAdvanced: "Advanced settings",
			modelsHeading: "Model visibility",
			modelsSubtitle: "Choose which models are exposed to the DeepSeek Harness model selector.",
			modelsSearchPlaceholder: "Search by model name or ID…",
			modelsSelectAll: "Select all",
			modelsDeselectAll: "Deselect all",
			modelsEnableSelected: "Enable selected",
			modelsDisableSelected: "Disable selected",
			modelsEnabled: "Enabled",
			modelsDisabled: "Disabled",
			modelsBatchActions: "Batch actions",
			modelsSelectedCount: "{count} selected",
			modelsNoModels: "No models available.",
			modelsNoMatch: "No models matching \"{query}\".",
			modelNameColumn: "Model name",
			contextHeading: "Context window",
			contextUpTo: "up to {size}",
			contextDefault: "default {size}",
			useMaximumContextWindow: "Use the largest declared context window",
			useMaximumContextWindowHint: "When on, models that declare a larger window are requested at it; when off, at their default.",
			probeLabel: "Reasoning levels",
			probeTooltipIdle: "Detect the reasoning levels {model} accepts",
			probeTooltipVerified: "Accepted levels: {levels} · click to detect again",
			probeTooltipNotValidating: "This model does not check the effort parameter",
			probeTooltipRetry: "Detection did not complete · click to retry",
			probeBubbleBody: "Send test requests to confirm the available reasoning levels. May consume a small amount of credit.",
			probeConfirmAction: "Confirm",
			probeNoteVerified: "Detected: {levels}",
			probeNoteNotValidating: "This model does not check the effort parameter",
			probeNoteUnknown: "Detection did not complete",
			probeNoteDismiss: "Got it",
			probeHeading: "Reasoning effort detection",
			probeResultNoLevels: "No tested levels were accepted.",
			probeIntro: "Some models reason but declare no selectable effort levels. Detecting which levels a model accepts sends a few real requests that may consume credit.",
			probeConsentHint: "Each detection sends test requests to one model to confirm its available reasoning levels, and may consume a small amount of credit.",
			probeStart: "Detect",
			probeRedetect: "Detect again",
			probeRunning: "Detecting {model}…",
			probeRunningGeneric: "Detecting…",
			probeClear: "Clear detected results",
			probeCandidates: "Detectable models: {count}",
			probeConfirmBody: "Send test requests to {model} to confirm its available reasoning levels. May consume a small amount of credit.",
			cancel: "Cancel",
			probeResultVerified: "Verified levels: {levels}",
			probeResultNotValidating: "This model does not check the effort parameter",
			probeResultUnknown: "Detection did not complete",
			probeResultAt: "Detected {time}",
			probeResultEmpty: "No detectable models right now.",
			probeFailed: "Detection failed: {message}",
			quotaSettingsTitle: "Qoder sidebar display",
			quotaSettingsHeading: "Sidebar & check-in settings",
			patClearConfirm: "Clear the saved PAT? This account signs out.",
			patClearConfirmYes: "Yes, clear it",
			quotaSettingsIntro: "Show remaining credit beside the sidebar Settings seat. Each toggle needs its variant to have a saved PAT.",
			quotaToggleCN: "Show China credit card",
			quotaToggleGlobal: "Show global credit card",
			quotaToggleHint: "Show this account’s remaining credit in the sidebar footer.",
			autoCheckInCN: "Qoder (China) daily auto check-in (100 Credits)",
			autoCheckInGlobal: "Qoder Global (International) daily auto check-in",
			autoCheckInHintCN: "Automatically check in daily to claim 100 Credits for the China account.",
			autoCheckInHintGlobal: "Automatically check in daily to claim available perks for the Global account.",
			checkInTimeCN: "Check-in time (China)",
			checkInTimeGlobal: "Check-in time (Global)",
			checkInTimeHint: "The moment the automatic check-in runs each day, in UTC+8.",
			autoCheckInStatusClaimed: "Checked in today (+{amount} Credits)",
			autoCheckInStatusAlready: "Already checked in today",
			autoCheckInStatusNoCampaign: "No active benefit campaign today",
			checkInNeedsClient: "Qoder's daily campaign needs the Qoder desktop app on this machine: the international service only serves it to requests carrying a client-minted device identity. Install Qoder and try again.",
			autoCheckInStatusError: "Auto check-in error: {message}",
			quotaSignInRequired: "Save a PAT for this variant first to enable this card.",
			quotaPollLabel: "Refresh interval",
			quotaPollHint: "Applies to both quota cards. Longer is kinder to the billing endpoint.",
			quotaPollUnit: "min",
			quotaSettingsSave: "Save",
			quotaSettingsSaving: "Saving…",
			quotaSettingsDiscard: "Discard",
			quotaSettingsDirty: "Unsaved changes",
			quotaSettingsInvalid: "A value is invalid — fix it before saving",
			quotaSettingsSaveFailed: "Save did not land — retry",
			quotaSettingsSavedHint: "Saved",
			quotaCardCN: "Qoder credit",
			quotaCardGlobal: "Qoder Global credit",
			quotaUnknownTotal: "total unknown",
			quotaUnlimited: "Unlimited",
			quotaExpires: "Expires",
			quotaNoExpiry: "No expiry",
			quotaError: "Credit unavailable",
			quotaNotSignedIn: "Save a PAT to see the remaining credit",
			quotaUpdated: "Updated",
			quotaDashboardTitle: "Qoder quota",
			quotaDashboardSubtitle: "Remaining credit by package, per product",
			quotaRefresh: "Refresh",
			quotaRefreshing: "Refreshing…",
			quotaClose: "Close",
			quotaByPackage: "By package",
			quotaTotal: "Total",
			quotaTotalRemain: "Remaining",
			quotaTotalShare: "{percent} of this cycle’s granted total",
			quotaCycleUsed: "Used this cycle: {percent}%",
			quotaColPackage: "Package",
			quotaColRemain: "Remaining / Total",
			quotaColExpiry: "Expires"
		};
		const zh = {
			title: "Qoder（国内版）",
			intro: "保存个人访问令牌（PAT）后，即可在 DSH 中直接使用 Qoder 国内版的模型。",
			titleAI: "Qoder Global（国际版）",
			introAI: "保存个人访问令牌（PAT）后，即可在 DSH 中直接使用 Qoder Global 的模型。",
			unifiedTitle: "Qoder",
			unifiedIntro: "粘贴 PAT 即可在 DSH 中使用 Qoder 模型：国内版与国际版各一套凭证、模型列表与额度，互不干扰。",
			variantTabCN: "国内版",
			variantTabGlobal: "国际版",
			expand: "展开",
			collapse: "收起",
			loading: "正在读取账号…",
			signedOut: "未登录",
			signedOutHint: "填入个人访问令牌（PAT）后即可在 DSH 中使用 Qoder 国内版的模型。",
			signedOutHintAI: "填入个人访问令牌（PAT）后即可在 DSH 中使用 Qoder Global 的模型。",
			patHeading: "个人访问令牌（PAT）",
			patGuide: "请先在 qoder.com.cn 的账号设置（账号 → 个人访问令牌）中生成 PAT，再粘贴到下方输入框。",
			patGuideAI: "请先在 qoder.com 的账号设置（账号 → 个人访问令牌）中生成 PAT，再粘贴到下方输入框。",
			patPlaceholder: "粘贴在 qoder.com.cn 生成的 PAT",
			patPlaceholderAI: "粘贴在 qoder.com 生成的 PAT",
			patSave: "保存",
			patSaving: "校验并保存中…",
			patSaved: "PAT 已保存。",
			patSaveFailed: "保存失败：{message}",
			patInvalid: "PAT 无效或已过期 — 请到账号设置重新生成后再试。",
			patUnreachable: "无法连接 Qoder 校验该 PAT（{message}）。令牌未保存 — 请检查网络后重试。",
			patReplace: "更换 PAT",
			patClear: "清除 PAT",
			patClearing: "正在清除 PAT…",
			signedIn: "已登录",
			patSourceCard: "来源：卡片保存",
			patSourceEnv: "来源：环境变量",
			patSourceCli: "来源：命令行",
			patSavedAt: "保存于 {time}",
			patTail: "尾号 {tail}",
			creditsHeading: "可用额度",
			tabStatus: "状态",
			tabContext: "上下文窗口",
			tabModels: "模型开关",
			tabDetails: "额度明细",
			tabCheckIn: "签到",
			paneUsage: "自动签到",
			variantEnable: "启用",
			accountSignedInAs: "已登录：{name}",
			planTier: "套餐：{name}",
			planOrganization: "组织：{name}",
			planEndsAt: "有效期至 {date}",
			patBoxLabel: "个人访问令牌（PAT）",
			patRemove: "删除",
			paneModels: "模型",
			modelsMergedHeading: "模型与上下文窗口",
			modelsMergedHint: "逐模型控制可见与可用；旁边标注该模型的上下文容量及其可扩展的最大窗口。",
			cardExpand: "展开",
			cardCollapse: "收起",
			ledgerHeading: "最近领取",
			ledgerExpiringHeading: "{days} 天内到期",
			ledgerEmpty: "该区间内暂无领取记录。",
			ledgerExpiresAt: "有效期至 {date}",
			ledgerExpired: "已过期",
			checkInLogTime: "签到时间",
			checkInLogResult: "签到结果",
			checkInLogAmount: "获得额度",
			checkInLogEmpty: "暂无签到日志记录。",
			checkInLogShow: "日志",
			checkInLogHide: "收起日志",
			checkInNow: "立即领取",
			checkInClaimedToday: "今日已签到",
			checkInChecking: "正在领取…",
			checkInRefresh: "刷新",
			checkInRefreshing: "正在刷新…",
			checkInClear: "清空日志",
			checkInClearing: "正在清空…",
			checkInNextRun: "下次自动领取：{time}",
			creditsDetailHeading: "按套餐",
			creditsUsed: "本轮已用 {percent}%",
			creditsUsedUnlimited: "本轮：无使用上限",
			creditsNoData: "未找到数据",
			unlimitedQuota: "不限额",
			cycleResetAt: "重置时间：{time}",
			percentRemaining: "剩余 {percent}%",
			percentUnknown: "剩余占比未知",
			exactRemaining: "剩余 {remain} / {size}",
			creditPackageUnknownSize: "剩余 {remain}",
			creditsError: "额度查询失败：{message}",
			refresh: "刷新",
			refreshing: "正在刷新…",
			refreshModels: "从 Qoder 刷新",
			jobTokenRefreshed: "jobToken 已于 {time} 自动刷新（Qoder 拒绝了旧令牌，消息已自动恢复）。",
			refreshingModels: "正在刷新模型…",
			catalogLive: "模型列表更新于 {time}",
			catalogSaved: "当前显示已保存的模型列表，更新于 {time}",
			catalogFallback: "当前显示内置模型列表（尚未从 Qoder 更新）",
			catalogError: "上次更新失败：{message}",
			requestFailed: "请求失败",
			statusRefreshFailed: "刷新失败：{message} — 当前显示的是上次成功获取的状态",
			statusResponseInvalid: "Qoder 返回的状态数据无法识别",
			accountHeading: "账号",
			quotaSectionUsage: "使用与签到",
			quotaSectionAdvanced: "高级设置",
			modelsHeading: "模型开关",
			modelsSubtitle: "控制哪些模型在 DeepSeek Harness 模型选择器中可见并可供调用。",
			modelsSearchPlaceholder: "按模型名称或 ID 搜索…",
			modelsSelectAll: "全选",
			modelsDeselectAll: "取消全选",
			modelsEnableSelected: "批量开启",
			modelsDisableSelected: "批量关闭",
			modelsEnabled: "已开启",
			modelsDisabled: "已关闭",
			modelsBatchActions: "批量操作",
			modelsSelectedCount: "已选 {count} 项",
			modelsNoModels: "暂无可配置的模型。",
			modelsNoMatch: "未找到匹配“{query}”的模型。",
			modelNameColumn: "模型名称",
			contextHeading: "上下文窗口",
			contextUpTo: "最高 {size}",
			contextDefault: "默认 {size}",
			useMaximumContextWindow: "使用 Qoder 声明的最大上下文窗口",
			useMaximumContextWindowHint: "勾选后，声明了更大窗口的模型按最大窗口请求；不勾选则按目录给出的默认窗口。",
			probeLabel: "推理等级",
			probeTooltipIdle: "检测 {model} 可用的推理档位",
			probeTooltipVerified: "已接受：{levels} · 点击可重新检测",
			probeTooltipNotValidating: "该模型不校验该参数",
			probeTooltipRetry: "检测未完成 · 点击重试",
			probeBubbleBody: "发送探测请求以确认可用推理档位。可能消耗少量积分。",
			probeConfirmAction: "确认检测",
			probeNoteVerified: "已检测：{levels}",
			probeNoteNotValidating: "该模型不校验该参数",
			probeNoteUnknown: "检测未完成",
			probeNoteDismiss: "知道了",
			probeHeading: "推理档位检测",
			probeResultNoLevels: "本次测试的档位均未被接受。",
			probeIntro: "部分模型具备思考能力，但没有声明可选档位。检测会发送少量真实请求，可能消耗积分。",
			probeConsentHint: "每次检测会向该模型发送探测请求，以确认可用推理档位，可能消耗少量积分。",
			probeStart: "开始检测",
			probeRedetect: "重新检测",
			probeRunning: "正在检测 {model}…",
			probeRunningGeneric: "正在检测…",
			probeClear: "清除已探测结果",
			probeCandidates: "可检测模型：{count} 个",
			probeConfirmBody: "向 {model} 发送探测请求，以确认可用推理档位。可能消耗少量积分。",
			cancel: "取消",
			probeResultVerified: "已验证接受的档位：{levels}",
			probeResultNotValidating: "该模型不校验该参数",
			probeResultUnknown: "检测未完成",
			probeResultAt: "检测于 {time}",
			probeResultEmpty: "当前没有可检测的模型。",
			probeFailed: "检测失败：{message}",
			quotaSettingsTitle: "Qoder 侧栏展示",
			quotaSettingsHeading: "侧栏与签到设置",
			patClearConfirm: "确定清除已保存的 PAT？该账号将登出。",
			patClearConfirmYes: "确认清除",
			quotaSettingsIntro: "在侧栏设置项旁展示剩余额度。开关需要对应产品已保存 PAT。",
			quotaToggleCN: "展示国内版额度",
			quotaToggleGlobal: "展示国际版额度",
			quotaToggleHint: "在侧栏底部展示该账号的剩余额度。",
			autoCheckInCN: "Qoder（国内版）每日自动签到",
			autoCheckInGlobal: "Qoder Global（国际版）每日自动签到",
			autoCheckInHintCN: "每天自动签到，为国内版账号领取 100 Credits 算力额度。",
			autoCheckInHintGlobal: "每天自动签到，为国际版账号领取可用福利额度。",
			checkInTimeCN: "签到时间（国内版）",
			checkInTimeGlobal: "签到时间（国际版）",
			checkInTimeHint: "每天执行自动签到的时刻，按北京时间（UTC+8）。",
			autoCheckInStatusClaimed: "今日已自动签到（+{amount} Credits）",
			autoCheckInStatusAlready: "今日已完成签到",
			autoCheckInStatusNoCampaign: "今日无可用签到福利活动",
			checkInNeedsClient: "每日签到需要本机安装 Qoder 桌面客户端：国际版只对携带客户端设备身份的请求下发该活动。安装 Qoder 后重试即可。",
			autoCheckInStatusError: "自动签到出错：{message}",
			quotaSignInRequired: "请先为该变体保存 PAT，再开启此开关。",
			quotaPollLabel: "刷新间隔",
			quotaPollHint: "对两张额度卡片同时生效。间隔越长对计费接口越友好。",
			quotaPollUnit: "分钟",
			quotaSettingsSave: "保存",
			quotaSettingsSaving: "保存中…",
			quotaSettingsDiscard: "放弃更改",
			quotaSettingsDirty: "有未保存的更改",
			quotaSettingsInvalid: "有数值不合法，请修正后再保存",
			quotaSettingsSaveFailed: "保存未生效，请重试",
			quotaSettingsSavedHint: "已保存",
			quotaCardCN: "Qoder 额度",
			quotaCardGlobal: "Qoder Global 额度",
			quotaUnknownTotal: "总量未知",
			quotaUnlimited: "不限量",
			quotaExpires: "到期",
			quotaNoExpiry: "无到期时间",
			quotaError: "额度信息不可用",
			quotaNotSignedIn: "保存 PAT 后显示剩余额度",
			quotaUpdated: "更新于",
			quotaDashboardTitle: "Qoder 额度",
			quotaDashboardSubtitle: "按套餐展示各产品的剩余额度",
			quotaRefresh: "刷新",
			quotaRefreshing: "刷新中…",
			quotaClose: "关闭",
			quotaByPackage: "按套餐",
			quotaTotal: "合计",
			quotaTotalRemain: "剩余额度",
			quotaTotalShare: "占本轮总额度 {percent}",
			quotaCycleUsed: "本轮已用 {percent}%",
			quotaColPackage: "资源包",
			quotaColRemain: "剩余 / 总量",
			quotaColExpiry: "到期时间"
		};
		//#endregion
		//#region src/client/index.tsx
		/** Browser half: Qoder account status, quota cards, and plugin settings. */
		/** Stable browser-plugin name. */
		const name = "dsh-connect-qoder-x-client";
		/**
		* Client services this bundle requires BEFORE it activates.
		*
		* DSH 0.1.2 removed `@deepseek-ai/dsh-client-runtime` (the package that used to
		* hold the browser `ClientContext` alias and the `slots` service). The services
		* this card relies on now come from narrower packages: the `slots` registry
		* moved to `@deepseek-ai/dsh-client-ui-renderer` and `locale` stayed in
		* `@deepseek-ai/dsh-client-locale`. Both are named in the package's
		* `dsh.client.inject` list.
		*
		* NOT declared here: the settings services. `settingsScope` (0.1.5) does not
		* exist at all on 0.1.7 — a static service dependency on it is what left this
		* plugin's client activation pending forever — and `configForms` (0.1.7) does
		* not exist on 0.1.5. Neither is used any more (see `OwnQuotaSettingsScope`),
		* so no callback waits on them either.
		*
		* ALSO NOT declared here: `ui-plugin-manager`. The two plugin-configuration
		* seats this card registers into (`plugins.row.config`, `plugins.bundle.config`)
		* are declared by that package, but the registrations go through
		* `ctx.slots.inject`, which is a CALLBACK on a slot NAME — a deployment that
		* never composes the Plugins page simply never calls back, exactly like the
		* optional services above. A static dependency would instead gate this whole
		* client on a package the plugin does not need to serve models.
		*/
		const inject = [
			"slots",
			"locale",
			"remote",
			"remote.session"
		];
		/** The status routes per variant id (mirrors the host's locked route table). */
		const VARIANT_STATUS = {
			qoder: QODER_STATUS_PATH,
			"qoder-global": QODER_GLOBAL_STATUS_PATH
		};
		/**
		* The profile ROW ID this plugin runs as — the id its own patch declares.
		*
		* `cordis.patch.yml` inserts `- id: llm-qoder-x, name: dsh-connect-qoder-x`, so
		* the Plugins page reports this plugin's row as `llm-qoder-x`. The browser half
		* needs it for exactly one thing: the right half of {@link ROW_CONFIG_KEY}.
		*
		* A profile that composes this bundle under some OTHER id — the package name is
		* what an entry without an explicit id falls back to — would dispatch a key this
		* constant does not match, and the card simply would not appear on that row.
		* There is no partial failure mode: a keyed slot nobody dispatches renders
		* nothing.
		*/
		const ENTRY_ID = "llm-qoder-x";
		/**
		* The two 0.1.7 seats this card registers into, on the Plugins page.
		*
		* Both are KEYED slots declared by `@deepseek-ai/dsh-client-ui-plugin-manager`
		* (`packages/client/ui-plugin-manager/src/client/slot-contract.ts`) and both
		* receive the same card component; only the key differs:
		*
		*   - `plugins.row.config`, keyed `<package name>#<row id>`, is the PRIMARY seat.
		*     Hitting it is what makes the Plugins page put a 「配置」 control on this
		*     plugin's row, and clicking that opens this card as the row's own page —
		*     the 「插件 → 点插件名 → 展开设置」 path.
		*   - `plugins.bundle.config`, keyed by PACKAGE NAME alone, renders inline on the
		*     package detail page between the description and the row list: the same
		*     card for a reader who opened the package rather than the row.
		*
		* This replaces the `settings.section` container plus the community-private
		* `plugin-settings.item` child that the three connect plugins used to rendezvous
		* in. That rendezvous is gone: the slot is a normal keyed seat, the owner
		* dispatches it, and no sibling plugin has to agree on an id.
		*/
		const ROW_CONFIG_SLOT = "plugins.row.config";
		const BUNDLE_CONFIG_SLOT = "plugins.bundle.config";
		/**
		* This plugin's package name — the `plugins.bundle.config` key, and the left half
		* of the `plugins.row.config` key.
		*/
		const PACKAGE_NAME = "dsh-connect-qoder-x";
		/**
		* The complete `plugins.row.config` key.
		*
		* The owner derives it as `` `${pkg.name}#${row.rowId}` `` where `rowId` comes
		* from the id the bundle's patch declares (`plugin-manager/lib/index.js`:
		* `rows.push({ rowId: row.id, ... })`, fed by `composeEntries`), and this
		* plugin's patch inserts its row as `id: llm-qoder-x`. Built from the two
		* constants rather than written as one literal so a rename cannot desync them
		* from {@link ENTRY_ID} and {@link PACKAGE_NAME}.
		*/
		const ROW_CONFIG_KEY = `${PACKAGE_NAME}#${ENTRY_ID}`;
		/**
		* Register card copy, the unified Qoder card on both Plugins-page seats, and the
		* sidebar quota cards.
		*
		* The entire body is wrapped so that a DSH slot-API breaking change (for
		* example the rc.6→rc.7 `id`→`key` / `order`→`priority` rename) degrades
		* to a `console.error` instead of throwing into the DSH loader and raising
		* the red "Failed to load plugins" banner. The host provider keeps working:
		* the `qoder` model channel is unaffected, and `dsh-connect-qoder-x
		* status` reports host health via the heartbeat file.
		*
		* NOTE: the try/catch boundary of this function is mirrored (duplicated) in
		* `tests/client-fallback.spec.ts`, because the real client entry imports
		* browser-only DSH packages that cannot load in the Node test environment.
		* That test therefore does not import this function — it replicates its
		* shape. If you change the guarded body or the `console.error` message here,
		* update the mirrored `apply()` in that spec too, or the fallback test will
		* silently diverge from this real implementation.
		*/
		function apply(ctx) {
			try {
				const namespace = "settings.qoder";
				ctx.effect(() => ctx.locale.register(namespace, {
					zh,
					en
				}), "dsh-connect-qoder-x: settings copy");
				const t = ctx.locale.bind(namespace);
				/**
				* The bound quota settings face, filled in as soon as this plugin's own
				* settings file answers (see {@link OwnQuotaSettingsScope}).
				*
				* It is bound on a STORED fact rather than when the card's inject factory
				* first runs: the factory only executes while the Plugins page renders, so a
				* fresh page load read no toggles and rendered no sidebar card until the user
				* opened that page. The face's subscription mirrors every accepted snapshot
				* (toggles + interval) into the shared store the sidebar cards and the
				* dashboard read; a deployment where the host route never answers never
				* binds, and the sidebar cards stay hidden.
				*/
				let quotaScope;
				const adoptQuotaScope = (scope) => {
					quotaScope = scope;
					const applySnapshot = () => {
						const value = scope.getSnapshot().value;
						setQuotaToggles(value?.sidebarQuotaCN === true, value?.sidebarQuotaGlobal === true);
						if (typeof value?.quotaPollMs === "number") setQuotaPollMs(value.quotaPollMs);
					};
					applySnapshot();
					scope.subscribe(applySnapshot);
				};
				/**
				* The card's inject face. One face serves both seats: the card is the same
				* component either way, and it reads `view` from its PROPS (the owner's
				* contract), not from here.
				*/
				const cardFace = () => ({
					t,
					scope: quotaScope,
					signedIn: () => quotaSignInState(),
					unified: true
				});
				/**
				* Register the unified Qoder card on both Plugins-page configuration seats.
				*
				* Two registrations, one component, keys derived above. They are independent
				* — a deployment that declares only one of the two seats gets the card on
				* that one and simply never calls back for the other — so neither failure
				* can suppress the other.
				*/
				const registerCard = (slot, key) => {
					try {
						ctx.slots.inject(slot, () => ctx.slots.register({
							name: slot,
							key,
							inject: cardFace
						}, QoderPluginCard));
					} catch (error) {
						console.error(`[dsh-connect-qoder-x] card slot "${slot}" failed to register (host provider unaffected):`, error);
					}
				};
				registerCard(ROW_CONFIG_SLOT, ROW_CONFIG_KEY);
				registerCard(BUNDLE_CONFIG_SLOT, PACKAGE_NAME);
				/**
				* 插件自有配置（`<profile>/.dsh-connect-qoder-x/settings.json`）：两条宿主线的
				* 读写都走宿主半的 settings face，不再经过 settingsScope / configForms。
				*
				* 0.1.7 的 configForms 写入会整树 reconcile + fiber 热重载（每次约
				* 1~1.5 秒，且每次保存都刷新所有客户端镜像）；自有文件写入是本地毫秒级
				* 原子写。卡片注册无条件进行：scope 在启动时载入，迟到也不会漏掉 UI。
				*/
				const ownQuotaScope = new OwnQuotaSettingsScope();
				ownQuotaScope.load();
				adoptQuotaScope(ownQuotaScope);
				const QUOTA_PANEL_ID = "qoder-quota-panel";
				const CONVERSATION_PANEL_ID = "conversation";
				const dashboardDocuments = {
					cn: void 0,
					global: void 0
				};
				let dashboardFetchedAt;
				let dashboardLoading = false;
				let dashboardRequestedPath = QODER_STATUS_PATH;
				/** Whether the dashboard is the CURRENT center panel (its mount owns this). */
				let quotaPanelOpen = false;
				const dashboardListeners = /* @__PURE__ */ new Set();
				/**
				* The observable source the dashboard reads through the inject face's
				* `hooks` compartment. The renderer caches an inject face ONCE per entry
				* and SPREADS it into props — a face getter is read exactly once and
				* frozen, which is why face-carried documents/activePath went stale. The
				* hooks channel survives: `bindInjectSources` converts each hooks member
				* into a `use<Name>` selector hook, and the hook reads the CURRENT
				* snapshot on every render (the same mechanism commandcode's usage store
				* rides).
				*
				* STABILITY CONTRACT: useSyncExternalStore requires getSnapshot() to
				* return the SAME reference between changes — a fresh object per call
				* re-renders forever and React kills the entry (error #185, the same
				* class of crash the settings card's unstable projection caused). So the
				* snapshot is a CACHED object, replaced wholesale by publish(); every
				* mutator builds the next snapshot and publishes exactly once.
				*/
				let dashboardSnap = {
					documents: [void 0, void 0],
					fetchedAt: void 0,
					loading: false,
					activePath: QODER_STATUS_PATH
				};
				const rebuildSnapshot = () => {
					const next = {
						documents: [dashboardDocuments.cn, dashboardDocuments.global],
						fetchedAt: dashboardFetchedAt,
						loading: dashboardLoading,
						activePath: dashboardRequestedPath
					};
					if (JSON.stringify(next) !== JSON.stringify(dashboardSnap)) {
						dashboardSnap = next;
						for (const listener of dashboardListeners) listener();
					}
				};
				const dashboardSource = {
					getSnapshot: () => dashboardSnap,
					subscribe: (listener) => {
						dashboardListeners.add(listener);
						return () => {
							dashboardListeners.delete(listener);
						};
					}
				};
				const notifyDashboard = () => {
					rebuildSnapshot();
				};
				/**
				* Refresh ONE variant's document (the one the panel is showing) — not
				* both. The earlier version fetched both routes on every panel mount, so
				* clicking the CN card also refreshed the Global card's data and timestamp;
				* the user ruled each click refreshes only what it shows.
				*
				* Freshness rule (also the user's): if the shared document for THIS
				* variant is newer than the configured interval, the fetch is SKIPPED —
				* a click shows the cached numbers instead of re-billing upstream. A
				* variant with NO result yet always fetches. A manual Refresh click
				* (force=true) bypasses the freshness check: an explicit user action
				* always re-reads.
				*/
				const refreshDashboard = async (options = {}) => {
					if (dashboardLoading) return;
					const variantId = variantOfStatusPath(dashboardRequestedPath);
					if (options.force !== true && quotaStatusIsFresh(variantId, quotaPollMs())) return;
					dashboardLoading = true;
					rebuildSnapshot();
					try {
						const result = await fetchStatusDocument(variantId === "qoder" ? QODER_STATUS_PATH : QODER_GLOBAL_STATUS_PATH);
						if (result !== void 0) noteQuotaStatus(variantId, result);
						dashboardFetchedAt = Date.now();
					} finally {
						dashboardLoading = false;
						rebuildSnapshot();
					}
				};
				let dashboardTimer;
				const startDashboardPoll = () => {
					if (dashboardTimer !== void 0) return;
					refreshDashboard();
					dashboardTimer = window.setInterval(() => {
						if (document.hidden) return;
						refreshDashboard();
					}, Math.max(6e4, quotaPollMs()));
				};
				const stopDashboardPoll = () => {
					if (dashboardTimer === void 0) return;
					window.clearInterval(dashboardTimer);
					dashboardTimer = void 0;
				};
				async function fetchStatusDocument(path) {
					try {
						const response = await fetch(path, { headers: { accept: "application/json" } });
						const body = await response.json();
						return response.ok && isQoderWebStatus(body) ? body : void 0;
					} catch {
						return;
					}
				}
				function QuotaDashboardWithLifecycle(props) {
					(0, react.useEffect)(() => {
						quotaPanelOpen = true;
						startDashboardPoll();
						return () => {
							quotaPanelOpen = false;
							stopDashboardPoll();
						};
					}, []);
					return /* @__PURE__ */ (0, react_jsx_runtime.jsx)(QuotaDashboard, { ...props });
				}
				const panelFace = () => ({
					hooks: { quotaDashboard: dashboardSource },
					t,
					statusPaths: [QODER_STATUS_PATH, QODER_GLOBAL_STATUS_PATH],
					refresh: () => {
						refreshDashboard({ force: true });
					},
					onVariantPicked: (path) => {
						dashboardRequestedPath = path;
						notifyDashboard();
						refreshDashboard();
					},
					close: () => {
						const layout = ctx.get("layout");
						if (typeof layout?.selectPanel !== "function") return;
						try {
							layout.selectPanel(null);
						} catch {
							try {
								layout.selectPanel(CONVERSATION_PANEL_ID);
							} catch (error) {
								console.error("[dsh-connect-qoder-x] could not close the quota panel:", error);
							}
						}
					}
				});
				ctx.effect(() => injectQuotaCss(), "dsh-connect-qoder-x: quota styles");
				try {
					ctx.slots.inject("main", () => ctx.slots.register({
						name: "main",
						key: QUOTA_PANEL_ID,
						locale: "panel.qoder-quota",
						inject: panelFace
					}, QuotaDashboardWithLifecycle));
				} catch (error) {
					console.error("[dsh-connect-qoder-x] could not register the quota dashboard:", error);
				}
				ctx.inject(["layout"], (layoutCtx) => {
					if (typeof layoutCtx.get("layout")?.selectPanel !== "function") return;
					try {
						for (const variant of QODER_CARD_VARIANTS) {
							const statusPath = VARIANT_STATUS[variant.id];
							if (statusPath === void 0) continue;
							const injected = {
								t,
								statusPath,
								open: () => {
									const current = layoutCtx.get("layout");
									if (typeof current?.selectPanel !== "function") return;
									if (quotaPanelOpen && dashboardRequestedPath === statusPath) {
										current.selectPanel(null);
										return;
									}
									dashboardRequestedPath = statusPath;
									notifyDashboard();
									refreshDashboard();
									current.selectPanel(QUOTA_PANEL_ID);
								}
							};
							layoutCtx.slots.inject("sidebar.footer.action", () => layoutCtx.slots.register({
								name: "sidebar.footer.action",
								id: variant.id === "qoder" ? "qoder-quota" : "qoder-global-quota",
								order: variant.id === "qoder" ? 20 : 21,
								locale: "panel.qoder-quota",
								inject: () => injected
							}, SidebarQuotaCard));
						}
					} catch (error) {
						console.error("[dsh-connect-qoder-x] could not register the sidebar footer card:", error);
					}
				});
				ctx.inject(["modelDirectories"], (scope) => {
					scope.slots.inject("conversation.input.right", () => scope.slots.register({
						name: "conversation.input.right",
						id: "qoder-probe",
						order: 10,
						inject: (sessionId) => ({
							directory: scope.modelDirectories.directoryFor(sessionId).store,
							t
						})
					}, QoderProbeControl));
				});
			} catch (error) {
				console.error("[dsh-connect-qoder-x] client card failed to load (host provider unaffected):", error);
			}
		}
		//#endregion
		exports.apply = apply;
		exports.inject = inject;
		exports.name = name;
		return module.exports;
	}
});
