window.__ModuleLoader__.load({
	id: "dsh-qoder-plugin",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		let react_jsx_runtime = require("react/jsx-runtime");
		//#region src/status-paths.ts
		/** Plugin-owned status endpoint consumed by its browser half. */
		const QODER_STATUS_PATH = "/plugins/dsh-qoder-plugin/status";
		/**
		* Plugin-owned probe control endpoint.
		*
		* Separate from the status route because it accepts writes: the status route's
		* loopback Host/Origin guard protects against a DNS-rebinding *page*, which is
		* not the same as authorizing a state-changing action. This route therefore
		* also requires the in-process key the browser half receives with the status
		* document.
		*/
		const QODER_PROBE_PATH = "/plugins/dsh-qoder-plugin/probe";
		/**
		* Plugin-owned PAT endpoint, one per variant.
		*
		* A POST here saves (validates and persists) a Personal Access Token, or
		* clears the stored one. Unlike the read-only status GET it is a write —
		* it persists a credential — so it also requires the in-process key the
		* browser half receives with the status document.
		*/
		const QODER_AUTH_PATH = "/plugins/dsh-qoder-plugin/auth";
		/**
		* The international (Qoder Global) variant's own triple of routes.
		*
		* Kept as separate constants rather than a computed suffix so both halves
		* reference literal strings: the browser bundle and the host bundle are built
		* independently, and a shared expression is one build-config drift away from
		* the desk asking a route the host never mounted.
		*/
		const QODER_GLOBAL_STATUS_PATH = "/plugins/dsh-qoder-plugin/global/status";
		const QODER_GLOBAL_PROBE_PATH = "/plugins/dsh-qoder-plugin/global/probe";
		const QODER_GLOBAL_AUTH_PATH = "/plugins/dsh-qoder-plugin/global/auth";
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
				children: options.map((option) => {
					const tab = /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
						type: "button",
						role: "tab",
						"aria-selected": option.value === value,
						tabIndex: option.value === value ? 0 : -1,
						disabled: disabled === true || option.disabled === true,
						className: cx("qdp-segItem", option.value === value && "qdp-segItemActive"),
						onClick: () => onChange(option.value),
						onKeyDown,
						children: option.label
					}, option.value);
					if (option.trailing === void 0) return tab;
					return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
						className: "qdp-segCell",
						children: [tab, option.trailing]
					}, option.value);
				})
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
		/**
		* A bounded number field that writes on commit, never on a keystroke.
		*
		* The card's other number fields used to call `onChange` for every character,
		* which cannot work: clearing the field to retype it yields `''`, the parse
		* fails, the write is skipped, and the controlled input snaps straight back to
		* the stored number — so the field reads as "cannot be edited". Here the typed
		* text is local state; blur or Enter parses it, clamps it into `[min, max]`, and
		* commits only a value that differs from the stored one. Escape reverts.
		*/
		function QdpNumberField({ value, min, max, label, disabled, className, marker, onCommit }) {
			const [draft, setDraft] = (0, react.useState)(String(value));
			(0, react.useEffect)(() => {
				setDraft(String(value));
			}, [value]);
			const commit = () => {
				const parsed = Number.parseInt(draft, 10);
				if (!Number.isFinite(parsed)) {
					setDraft(String(value));
					return;
				}
				const clamped = Math.min(max, Math.max(min, parsed));
				setDraft(String(clamped));
				if (clamped !== value) onCommit(clamped);
			};
			return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
				type: "number",
				inputMode: "numeric",
				className: cx("qdp-input", "qdp-inputShort", className),
				min,
				max,
				step: 1,
				value: draft,
				disabled: disabled === true,
				"aria-label": label,
				"data-number-field": marker,
				onChange: (event) => {
					setDraft(event.target.value);
				},
				onBlur: commit,
				onKeyDown: (event) => {
					if (event.key === "Enter") {
						event.preventDefault();
						commit();
					} else if (event.key === "Escape") {
						event.preventDefault();
						setDraft(String(value));
					}
				}
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
		/** Hairline marks under the rail — 33 marks, one every 3.125 % of the field. */
		const SLIDER_RULER_MARKS = 33;
		/**
		* Context-window slider, replicating the Qoder model-settings control.
		*
		* Geometry follows the upstream component: a 56 px field whose 18 px rail sits
		* on the vertical centre and whose 12 px label row hangs 40 px below the field's
		* top, 33 hairlines along the rail (every eighth one taller and darker) and a
		* 2×12 px grab tick at the fill's edge. The scale starts at zero — a window's
		* position is `value / max`, so 200K sits at 20 % of a 1M axis exactly as in the
		* official table — and the rail itself stops at the widest offered window. Only
		* the offered windows carry a label (9 px, sitting on the field colour so the
		* hairlines pass behind); the one in force is the dark, medium-weight label.
		*
		* With `snapTo` a pointer drag moves the grab tick one tier at a time (it lands
		* only on the offered windows); without offers it follows the pointer quantized
		* to `step`. Arrows, PageUp/PageDown and Home/End keep it keyboard operable,
		* with arrows walking the offers one by one. The component is fully controlled —
		* it never writes anything by itself.
		*/
		function QdpSlider({ label, value, min, max, step = 1e3, disabled, onChange, valueText, ticks, format, snapTo, testId }) {
			const formatValue = (raw) => format !== void 0 ? format(raw) : raw === value && valueText !== void 0 ? valueText : String(raw);
			/**
			* Position of a window on the field, in percent.
			*
			* The official control's axis starts at zero (`value / maxValue`), not at the
			* smallest window, so a 200K window covers the first fifth of a 1M axis on
			* every row and equal windows line up across rows.
			*/
			const percentOf = (raw) => max > 0 ? Math.min(100, Math.max(0, raw / max * 100)) : 0;
			/** Label/tick transforms that keep the end marks inside the field. */
			const edgeTransform = (percent) => percent >= 99.5 ? "translate(-100%, -50%)" : percent <= .5 ? "translate(0, -50%)" : "translate(-50%, -50%)";
			const trackRef = (0, react.useRef)(null);
			const span = max > min ? max - min : 0;
			/** The offered values that actually fit the shared axis, ascending. */
			const anchors = (0, react.useMemo)(() => {
				if (snapTo === void 0 || snapTo.length === 0) return void 0;
				const inRange = snapTo.filter((candidate) => Number.isFinite(candidate) && candidate >= min && candidate <= max).slice().sort((a, b) => a - b);
				return inRange.length > 0 ? inRange : void 0;
			}, [
				max,
				min,
				snapTo
			]);
			/** Where the grab tick and the filled rail end. */
			const fillPercent = percentOf(value);
			/**
			* The rail stops at the widest offered window, not at the axis end: a row that
			* offers only 200K / 400K draws a shorter rail instead of empty track beyond
			* its last tier (the official control behaves the same way).
			*/
			const railPercent = percentOf(anchors === void 0 ? max : anchors[anchors.length - 1] ?? max);
			const snap = (0, react.useCallback)((raw) => {
				const clamped = Math.min(max, Math.max(min, raw));
				if (anchors !== void 0) {
					let best = anchors[0] ?? clamped;
					for (const candidate of anchors) if (Math.abs(candidate - clamped) < Math.abs(best - clamped)) best = candidate;
					return best;
				}
				if (step <= 0) return clamped;
				const stepped = min + Math.round((clamped - min) / step) * step;
				return Math.min(max, Math.max(min, stepped));
			}, [
				anchors,
				max,
				min,
				step
			]);
			/**
			* The value a live drag reports.
			*
			* With `snapTo` the drag advances tier by tier: every pointer move reports the
			* nearest offered window, so the handle is never parked between two tiers
			* (one slide, one context size) and the number under it is always a window the
			* upstream declares. Without offers the drag is quantized to `step`, keeping
			* the displayed number free of round-off noise.
			*/
			const free = (0, react.useCallback)((raw) => {
				if (anchors !== void 0) return snap(raw);
				const clamped = Math.min(max, Math.max(min, raw));
				if (step <= 0) return clamped;
				const stepped = min + Math.round((clamped - min) / step) * step;
				return Math.min(max, Math.max(min, stepped));
			}, [
				anchors,
				max,
				min,
				snap,
				step
			]);
			/** Pointer position of the drag in flight, kept for the release settle. */
			const lastRaw = (0, react.useRef)(void 0);
			const fromClientX = (0, react.useCallback)((clientX) => {
				const element = trackRef.current;
				if (element === null) return;
				const rect = element.getBoundingClientRect();
				const share = rect.width > 0 ? (clientX - rect.left) / rect.width : 0;
				const raw = min + Math.min(1, Math.max(0, share)) * span;
				lastRaw.current = raw;
				onChange(free(raw));
			}, [
				free,
				min,
				onChange,
				span
			]);
			const onPointerDown = (event) => {
				if (disabled === true) return;
				event.preventDefault();
				event.currentTarget.setPointerCapture(event.pointerId);
				fromClientX(event.clientX);
			};
			const onPointerMove = (event) => {
				if (disabled === true || !event.currentTarget.hasPointerCapture(event.pointerId)) return;
				fromClientX(event.clientX);
			};
			/**
			* End of drag: settle on the offer nearest the pointer.
			*
			* A drag that has offers already reports one on every move, so this only
			* matters for the last finger position: `lastRaw` is the pointer position the
			* drag ended at, not `value` — the controlled parent may still be rendering
			* the previous tick when the release lands.
			*/
			const release = (event) => {
				if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
				const raw = lastRaw.current;
				lastRaw.current = void 0;
				if (raw === void 0) return;
				const snapped = snap(raw);
				if (snapped !== value) onChange(snapped);
			};
			const onKeyDown = (event) => {
				if (disabled === true) return;
				const big = step * 10;
				/** The offer after (direction 1) or before (-1) the current value. */
				const neighbour = (direction) => {
					if (anchors === void 0) return snap(value + direction * step);
					const index = anchors.findIndex((candidate) => candidate === value);
					if (index === -1) return snap(value);
					const nextIndex = Math.min(anchors.length - 1, Math.max(0, index + direction));
					return anchors[nextIndex] ?? snap(value);
				};
				let next;
				if (event.key === "ArrowRight" || event.key === "ArrowUp") next = neighbour(1);
				else if (event.key === "ArrowLeft" || event.key === "ArrowDown") next = neighbour(-1);
				else if (event.key === "PageUp") next = snap(value + big);
				else if (event.key === "PageDown") next = snap(value - big);
				else if (event.key === "Home") next = min;
				else if (event.key === "End") next = max;
				if (next === void 0) return;
				event.preventDefault();
				if (next !== value) onChange(next);
			};
			return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
				className: "qdp-sliderField",
				"data-testid": testId,
				children: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					className: "qdp-slider",
					role: "slider",
					"aria-label": label,
					"aria-valuemin": min,
					"aria-valuemax": max,
					"aria-valuenow": value,
					"aria-valuetext": valueText ?? formatValue(value),
					"aria-disabled": disabled === true || void 0,
					tabIndex: disabled === true ? -1 : 0,
					onPointerDown,
					onPointerMove,
					onPointerUp: release,
					onPointerCancel: release,
					onKeyDown,
					children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "qdp-sliderTrack",
						ref: trackRef,
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
								className: "qdp-sliderRail",
								style: { width: `${railPercent.toFixed(2)}%` }
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
								className: "qdp-sliderFill",
								style: { width: `${fillPercent.toFixed(2)}%` }
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: "qdp-sliderThumb",
								style: { left: `calc(${fillPercent.toFixed(2)}% - 5px)` }
							})
						]
					}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "qdp-windowTicks",
						children: [Array.from({ length: SLIDER_RULER_MARKS }, (_, index) => {
							const percent = index / 32 * 100;
							if (percent > railPercent + .01) return null;
							return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								"aria-hidden": "true",
								className: cx("qdp-windowTickMark", index % 8 === 0 && "qdp-windowTickMarkMajor"),
								style: { left: `${percent.toFixed(2)}%` }
							}, `mark-${index}`);
						}), (ticks ?? []).map((tick) => {
							const percent = percentOf(tick);
							return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: cx("qdp-windowTick", tick === value && "qdp-windowTickActive"),
								style: {
									left: `${percent.toFixed(2)}%`,
									transform: edgeTransform(percent)
								},
								children: formatValue(tick)
							}, tick);
						})]
					})]
				})
			});
		}
		//#endregion
		//#region src/client/ModelsPane.tsx
		/**
		* 「模型」 pane: per-model visibility and context-window preferences.
		*
		* The pane never writes. Every checkbox and slider mutates a local draft, a
		* sticky save bar appears once that draft differs from the props, and only its
		* 「保存设置」 button hands the whole change set to `onSave` so the page can
		* batch the individual network writes behind one click. The draft re-bases from
		* the props whenever their signature changes (a refreshed catalogue, a new
		* disabled set, or the applied result of a previous save), which is also why
		* there is no explicit reset signal in the props.
		*
		* The row is three grid columns — checkbox, copy, axis — so the sliders line up
		* across rows. The axes are independent controls but share one absolute token
		* scale (the same min/max for every row), so 200K sits in the same column
		* everywhere and windows are comparable at a glance.
		*
		* Catalogue provenance and the refresh control live in the page's section head,
		* not here; `catalog`, `busy` and `onRefreshModels` stay on the props so the
		* page writer can keep passing the state it already owns.
		*/
		function orderModels(models) {
			return [...models ?? []];
		}
		/** Current/preferred window from the catalogue; an override already replaced `contextWindow`. */
		function baselineWindow(model) {
			const value = model.contextWindow ?? model.defaultContextWindow;
			return value !== void 0 && Number.isFinite(value) && value > 0 ? value : void 0;
		}
		/** Upstream-declared windows, deduped, positive and ascending; `[]` when none are known. */
		function declaredWindows(model) {
			const current = baselineWindow(model);
			const source = model.supportedContextWindows ?? (current === void 0 ? [] : [current]);
			return [...new Set(source)].filter((value) => Number.isFinite(value) && value > 0).sort((a, b) => a - b);
		}
		/** The value a row shows before the draft touches it (declared first window as fallback). */
		function rowWindow(model) {
			return baselineWindow(model) ?? declaredWindows(model)[0];
		}
		/** Same notation as the card's token labels: 200K / 400K / 1M, bare number otherwise. */
		function formatTokens(tokens) {
			if (tokens >= 1e6 && tokens % 1e6 === 0) return `${tokens / 1e6}M`;
			if (tokens >= 1e3 && tokens % 1e3 === 0) return `${tokens / 1e3}K`;
			return String(tokens);
		}
		function formatRate(factor) {
			return `${factor.toFixed(1)}x`;
		}
		/**
		* The reasoning-effort tag's text: the levels the model can reason at, plus the
		* upstream default.
		*
		* The tag speaks the upstream's English wire vocabulary (`low`, `high`,
		* `xhigh`, `max`, …) in every UI language — the words are model parameters, and
		* the official Qoder app lists them untranslated. A model that advertises no
		* selectable effort says so instead of drawing an empty tag.
		*/
		function effortsTagText(model, t) {
			const efforts = (model.reasoningEfforts ?? []).filter((id) => id !== "");
			if (efforts.length === 0) return t("effortsUnsupported");
			const nameOf = (id) => id === "low" ? t("effortLow") : id === "medium" ? t("effortMedium") : id === "high" ? t("effortHigh") : id === "xhigh" ? t("effortXhigh") : id === "max" ? t("effortMax") : id === "minimal" ? t("effortMinimal") : id;
			return efforts.map(nameOf).join(" · ") + (model.defaultReasoningEffort !== void 0 && efforts.includes(model.defaultReasoningEffort) ? ` (${t("modelEffortsDefault", { name: nameOf(model.defaultReasoningEffort) })})` : "");
		}
		/** Round an axis end up to a clean K/M boundary so tick labels stay readable. */
		function roundUpAxis(value) {
			if (!Number.isFinite(value) || value <= 0) return 1e6;
			const unit = value >= 1e6 ? 1e6 : value >= 1e3 ? 1e3 : 1;
			return Math.ceil(value / unit) * unit;
		}
		/** Global right end of every row's axis: the widest declared/default window, rounded up. */
		function axisMaximum(list) {
			return roundUpAxis(list.reduce((best, model) => {
				const declared = declaredWindows(model);
				const rowMax = declared.length > 0 ? declared[declared.length - 1] : rowWindow(model);
				return rowMax !== void 0 && rowMax > best ? rowMax : best;
			}, 0));
		}
		/** Global left end of every row's axis: the narrowest window any model declares. */
		function minimumWindow(list, axisMax) {
			const lowest = list.reduce((best, model) => {
				const candidate = declaredWindows(model)[0] ?? baselineWindow(model);
				return candidate !== void 0 && candidate > 0 && candidate < best ? candidate : best;
			}, Number.POSITIVE_INFINITY);
			if (!Number.isFinite(lowest) || lowest <= 0) return Math.min(1e3, axisMax);
			return Math.min(lowest, axisMax);
		}
		const clampWindow = (value, min, max) => Math.min(max, Math.max(min, value));
		const uniqueSorted = (ids) => [...new Set(ids)].sort((a, b) => a.localeCompare(b));
		/**
		* The windows this row offers as tiers, clipped to the shared axis.
		*
		* These are exactly the values the slider lands on and the marks it draws; the
		* shared axis ENDS are deliberately not added. On a row whose narrowest offer
		* sits close to the global minimum (the international roster's Performance
		* offers 272K while the shared minimum is 200K) the extra minimum label
		* overlapped the row's own first label. The scale is still shared, so a 400K on
		* one row keeps lining up with a 400K on the next.
		*/
		function rowTiers(model, min, max) {
			return declaredWindows(model).filter((value) => value >= min && value <= max);
		}
		/**
		* Signature of everything the draft is based on. When it changes the draft is
		* discarded and re-seeded from the props: a model appearing/disappearing, its
		* upstream window/price changing, or the persisted disabled set changing (e.g.
		* the request that a save triggered has landed).
		*/
		function modelSignature(list, disabled) {
			return JSON.stringify({
				models: list.map((model) => [
					model.id,
					model.name,
					model.contextWindow ?? null,
					model.defaultContextWindow ?? null,
					model.supportedContextWindows === void 0 ? null : [...model.supportedContextWindows],
					model.priceFactor ?? null,
					model.reasoningEfforts === void 0 ? null : [...model.reasoningEfforts],
					model.defaultReasoningEffort ?? null
				]),
				disabled: [...disabled]
			});
		}
		function ModelsPane({ models, disabledModels = [], t, saving = false, saveError, onSave }) {
			const list = orderModels(models);
			const baselineDisabled = uniqueSorted(disabledModels);
			const signature = modelSignature(list, baselineDisabled);
			const [draft, setDraft] = (0, react.useState)(() => ({
				disabled: uniqueSorted(disabledModels),
				windows: {}
			}));
			const signatureRef = (0, react.useRef)(signature);
			(0, react.useEffect)(() => {
				if (signatureRef.current === signature) return;
				signatureRef.current = signature;
				setDraft({
					disabled: uniqueSorted(disabledModels),
					windows: {}
				});
			}, [signature, disabledModels]);
			const axisMax = axisMaximum(list);
			const minWindow = minimumWindow(list, axisMax);
			const byId = new Map(list.map((model) => [model.id, model]));
			const windowDiff = {};
			for (const [id, value] of Object.entries(draft.windows)) {
				const model = byId.get(id);
				if (model === void 0) continue;
				if (rowWindow(model) !== value) windowDiff[id] = value;
			}
			const changeCount = draft.disabled.filter((id) => !baselineDisabled.includes(id)).length + baselineDisabled.filter((id) => !draft.disabled.includes(id)).length + Object.keys(windowDiff).length;
			const dirty = changeCount > 0;
			const controlsDisabled = saving;
			const toggleModel = (id, enabled) => {
				setDraft((current) => {
					const disabled = new Set(current.disabled);
					if (enabled) disabled.delete(id);
					else disabled.add(id);
					return {
						disabled: [...disabled].sort((a, b) => a.localeCompare(b)),
						windows: current.windows
					};
				});
			};
			const changeWindow = (model, value) => {
				const base = rowWindow(model);
				setDraft((current) => {
					const windows = { ...current.windows };
					if (base !== void 0 && base === value) delete windows[model.id];
					else windows[model.id] = value;
					return {
						disabled: current.disabled,
						windows
					};
				});
			};
			const resetDraft = () => {
				setDraft({
					disabled: [...baselineDisabled],
					windows: {}
				});
			};
			const saveDraft = () => {
				onSave({
					disabled: [...draft.disabled],
					windows: { ...windowDiff }
				});
			};
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: "qdp-stack",
				children: [list.length === 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
					className: "qdp-empty",
					children: t("modelsNoModels")
				}) : /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					className: "qdp-modelScroll",
					children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "qdp-modelColumns",
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { "aria-hidden": "true" }),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: t("modelNameColumn") }),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: t("effortsHeading") }),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: t("contextHeading") })
						]
					}), list.map((model) => {
						const inputId = `qdp-model-${model.id}`;
						const enabled = !draft.disabled.includes(model.id);
						const baseline = rowWindow(model);
						const value = draft.windows[model.id] ?? baseline;
						const current = value === void 0 ? void 0 : clampWindow(value, minWindow, axisMax);
						const effortsText = effortsTagText(model, t);
						const tiers = rowTiers(model, minWindow, axisMax);
						return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: "qdp-modelRow",
							"data-model-id": model.id,
							"aria-disabled": enabled ? void 0 : true,
							children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("label", {
									className: "qdp-modelEnable",
									children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
										id: inputId,
										type: "checkbox",
										checked: enabled,
										disabled: controlsDisabled,
										"aria-label": model.name,
										onChange: (event) => toggleModel(model.id, event.currentTarget.checked)
									})
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
									className: "qdp-modelCopy",
									children: [
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("label", {
											htmlFor: inputId,
											children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
												className: "qdp-modelName",
												children: model.name
											})
										}),
										model.priceFactor === void 0 ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsx)(QdpTag, { children: formatRate(model.priceFactor) }),
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
											className: "qdp-modelMeta",
											children: model.id
										})
									]
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: "qdp-modelEfforts",
									children: effortsText
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
									className: "qdp-modelAxis",
									children: current === void 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										className: "qdp-modelMeta",
										children: "—"
									}) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)(QdpSlider, {
										label: t("contextWindowAria"),
										value: current,
										min: minWindow,
										max: axisMax,
										step: 1e3,
										disabled: controlsDisabled,
										onChange: (next) => changeWindow(model, next),
										valueText: formatTokens(current),
										snapTo: tiers,
										ticks: tiers,
										format: formatTokens,
										testId: `qdp-window-${model.id}`
									})
								})
							]
						}, model.id);
					})]
				}), dirty || saveError !== void 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					className: "qdp-saveBar",
					"data-testid": "qdp-models-savebar",
					children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "qdp-saveBarText",
						children: [changeCount > 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: "qdp-num",
								children: t("modelsUnsavedCount", { count: changeCount })
							}),
							" ",
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: "qdp-muted",
								children: t("modelsBatchSaveHint")
							})
						] }) : null, saveError === void 0 ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
							className: "qdp-alert qdp-alertError",
							role: "alert",
							children: t("modelsSaveFailed", { message: saveError })
						})]
					}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "qdp-saveBarActions",
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(QdpButton, {
							"data-testid": "qdp-models-cancel",
							disabled: saving,
							onClick: resetDraft,
							children: t("cancelChanges")
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)(QdpButton, {
							"data-testid": "qdp-models-save",
							variant: "primary",
							size: "md",
							disabled: saving,
							onClick: saveDraft,
							children: saving ? t("savingChanges") : t("saveChanges")
						})]
					})]
				}) : null]
			});
		}
		//#endregion
		//#region src/client/quota-merge.ts
		/** Clamp helper shared by the card's percent math. */
		function clampPercent(remain, size) {
			if (!(size > 0)) return void 0;
			const percent = remain / size * 100;
			if (!Number.isFinite(percent)) return void 0;
			return Math.min(100, Math.max(0, percent));
		}
		/**
		* Distill a credits document into the numbers the chip, the panel and the
		* account card show.
		*
		* "Unlimited" means "there is nothing to count", not "the upstream flagged it":
		* live documents report `credits.unlimited: true` while still carrying real
		* per-package sizes (the CN gift plan), and treating the flag alone as unlimited
		* hid thousands of remaining credits behind 不限量. The rule: unlimited only
		* when `Σ account.size <= 0`; otherwise `Σ remain / Σ size`, falling back to
		* `credits.totalSize` when every package reports size 0.
		*
		* Lives here (a pure module both client surfaces already import) rather than in
		* the composer chip, so the account card cannot drift from the chip's figure.
		*/
		function creditSummary(credits) {
			const accounts = credits.accounts;
			const remain = accounts.reduce((sum, account) => sum + account.remain, 0);
			const summedSize = accounts.reduce((sum, account) => sum + account.size, 0);
			const unlimited = summedSize <= 0 && (credits.unlimited === true || accounts.some((account) => account.unlimited === true));
			let total = 0;
			if (!unlimited) {
				if (summedSize > 0) total = summedSize;
				else if (credits.totalSize !== void 0 && credits.totalSize > 0) total = credits.totalSize;
			}
			return {
				remain,
				total,
				unlimited
			};
		}
		//#endregion
		//#region src/client/quota-settings-store.ts
		let pollIntervalMs = 3e5;
		/**
		* localStorage key holding the readout switches.
		*
		* These three preferences do NOT live in the settings file: the switches must
		* work against ANY loaded host, including one whose settings schema predates
		* them (a fresh host rejects unknown fields with HTTP 400). A browser
		* preference needs no host round trip, survives reloads, and keeps both halves
		* honest about where the value lives.
		*/
		const READOUT_STORAGE_KEY = "dsh-qoder-plugin:readout";
		/** The on state used when nothing (or nothing valid) was stored. */
		function defaultQuotaReadout() {
			return { enabled: true };
		}
		/** A stored flag counts as on unless it was explicitly `false`. */
		function readoutFlag(stored) {
			return stored !== false;
		}
		/**
		* The browser storage, or undefined when there is none or access is blocked
		* (non-browser runtime, private mode, disabled site data). Every access is
		* wrapped: touching `globalThis.localStorage` itself can throw when storage is
		* disabled.
		*/
		function browserStorage() {
			try {
				const scope = globalThis;
				const storage = scope.localStorage ?? scope.window?.localStorage;
				return storage === void 0 ? void 0 : storage;
			} catch {
				return;
			}
		}
		/** Read the persisted switches once; missing/invalid storage means all-on. */
		function loadQuotaReadout() {
			const storage = browserStorage();
			if (storage === void 0) return defaultQuotaReadout();
			try {
				const raw = storage.getItem(READOUT_STORAGE_KEY);
				if (raw === null) return defaultQuotaReadout();
				const parsed = JSON.parse(raw);
				if (typeof parsed !== "object" || parsed === null) return defaultQuotaReadout();
				return { enabled: readoutFlag(parsed.enabled) };
			} catch {
				return defaultQuotaReadout();
			}
		}
		/** Persist the switches; a blocked/full store only costs the preference. */
		function persistQuotaReadout(state) {
			const storage = browserStorage();
			if (storage === void 0) return;
			try {
				storage.setItem(READOUT_STORAGE_KEY, JSON.stringify(state));
			} catch {}
		}
		let readout = loadQuotaReadout();
		let readoutSnapshot = { ...readout };
		/**
		* localStorage key holding the last known sign-in fact per variant.
		*
		* The cards' grey dot is only honest when it means "the host says this variant
		* has no PAT". Every page load used to start from `false` for both variants,
		* so a signed-in Global account was painted grey until its status route (a
		* cross-border call) answered. Remembering the last answer keeps the switcher
		* truthful across reloads; the first read still corrects it.
		*/
		const SIGN_IN_STORAGE_KEY = "dsh-qoder-plugin:sign-in";
		/** Read the remembered sign-in facts; anything unreadable means "not read". */
		function loadQuotaSignIn() {
			const unknownState = {
				cn: void 0,
				global: void 0
			};
			const storage = browserStorage();
			if (storage === void 0) return unknownState;
			try {
				const raw = storage.getItem(SIGN_IN_STORAGE_KEY);
				if (raw === null) return unknownState;
				const parsed = JSON.parse(raw);
				if (typeof parsed !== "object" || parsed === null) return unknownState;
				const stored = parsed;
				return {
					cn: typeof stored.cn === "boolean" ? stored.cn : void 0,
					global: typeof stored.global === "boolean" ? stored.global : void 0
				};
			} catch {
				return unknownState;
			}
		}
		/** Persist the sign-in facts; blocked storage only costs the remembered dot. */
		function persistQuotaSignIn() {
			const storage = browserStorage();
			if (storage === void 0) return;
			try {
				storage.setItem(SIGN_IN_STORAGE_KEY, JSON.stringify({
					cn: signIn.cn,
					global: signIn.global
				}));
			} catch {}
		}
		const signIn = loadQuotaSignIn();
		let signInSnapshot = { ...signIn };
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
		/**
		* Update the composer-readout switch.
		*
		* This is a CLIENT-SIDE preference (see {@link READOUT_STORAGE_KEY}), not a
		* settings-file write: it persists to localStorage, bumps the revision so
		* every composer chip re-renders, and never touches the host document.
		*/
		function setQuotaReadout(enabled) {
			if (readout.enabled !== enabled) {
				readout = { enabled };
				readoutSnapshot = { ...readout };
				persistQuotaReadout(readout);
				bump();
			}
		}
		/** Read the composer-readout switch. */
		function quotaReadout() {
			return readoutSnapshot;
		}
		/** Record a variant's sign-in state from any successful status poll. */
		function noteQuotaSignIn(variantId, signedIn) {
			if (variantId === "qoder" && signIn.cn !== signedIn) {
				signIn.cn = signedIn;
				signInSnapshot = { ...signIn };
				persistQuotaSignIn();
				bump();
			} else if (variantId === "qoder-global" && signIn.global !== signedIn) {
				signIn.global = signedIn;
				signInSnapshot = { ...signIn };
				persistQuotaSignIn();
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
		/** Page-level poll period, in milliseconds. */
		const POLL_INTERVAL_MS = 6e4;
		/** 10:00 UTC+8, the upstream campaign's reset moment (mirrors QuotaSettingsCard). */
		const CHECK_IN_MINUTE_DEFAULT = 600;
		/** Default billing-endpoint poll period, in milliseconds (mirrors the settings face). */
		const POLL_DEFAULT_MS = 3e5;
		/** The face clamps the poll interval at one minute. */
		const POLL_MIN_MS = 6e4;
		/**
		* The card's own ceiling for the poll interval, in minutes.
		*
		* The host sets no upper bound (a poll is cheap), but a field with no ceiling
		* invites a typo that parks the readout for a day; one day is the widest
		* interval that can still be called a poll.
		*/
		const POLL_MINUTES_MAX = 1440;
		const QUEUE_WAIT_ATTEMPTS_DEFAULT = 0;
		const QUEUE_WAIT_ATTEMPTS_MAX = 10;
		const QUEUE_WAIT_SECONDS_DEFAULT = 30;
		const QUEUE_WAIT_SECONDS_MIN = 1;
		const QUEUE_WAIT_SECONDS_MAX = 300;
		const STICKINESS_ROUNDS_DEFAULT = 3;
		const STICKINESS_ROUNDS_MAX = 100;
		const STICKINESS_REQUESTS_DEFAULT = 200;
		const STICKINESS_REQUESTS_MAX = 1e4;
		const STICKINESS_MINUTES_DEFAULT = 180;
		const STICKINESS_MINUTES_MAX = 1440;
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
		/** Time-of-day formatting for "next run" and credential-saved lines. */
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
		* One pooled account's facts, in the same order the single-credential row used
		* (source · saved · tail) plus the failover position.
		*
		* The position leads because it is the only thing that distinguishes two rows
		* saved at the same moment, and because it is what the user is choosing between
		* when they press 「切换使用」.
		*/
		function accountRowMeta(account, t) {
			return [
				t("accountSlot", { order: account.order }),
				patSourceText(account.source, t),
				account.savedAtMs === void 0 ? null : t("patSavedAt", { time: formatTime(account.savedAtMs) }),
				account.patTail === void 0 ? null : t("patTail", { tail: `****${account.patTail}` })
			].filter((part) => part !== null).join(" · ");
		}
		/**
		* One pooled account's own credit figure.
		*
		* The row follows the SAME summation rule as the card header (see
		* `creditSummary`), because two currency rules over one credential is how a
		* card ends up disagreeing with itself.
		*
		* A PARKED account reports no figure at all. It is excluded from the failover
		* walk and from the composer panel's totals, so printing a spendable-looking
		* number beside it would promise a balance this list will never route through;
		* saying why is more honest than an em dash that reads as a failed read.
		*/
		function accountRowCredits(account, t) {
			if (account.enabled === false) return t("accountCreditsParked");
			if (account.credits === void 0) return account.creditsError === void 0 ? t("accountCreditsUnknown") : t("creditsError", { message: account.creditsError });
			const summary = creditSummary(account.credits);
			return t("accountCreditsValue", { value: summary.unlimited ? t("quotaUnlimited") : new Intl.NumberFormat(void 0).format(summary.remain) });
		}
		/**
		* One account's observed service state, as the user-facing word for it.
		*
		* 限流 is the upstream's own term for an account that only ever answers with a
		* per-model queue, so the label states the condition the host actually
		* recorded instead of guessing at a cause.
		*
		* An absent state is not a healthy one: `health` stays undefined until the
		* transport observes a failure, so the word for it is 「尚未观测」 — the same
		* silence {@link ComposerQuota} keeps, said out loud where a tag is expected.
		*/
		function accountHealthLabel(health, t) {
			if (health === void 0) return t("accountHealthUnknown");
			if (health === "queued") return t("accountHealthQueued");
			if (health === "limited") return t("accountHealthLimited");
			return t("accountHealthNormal");
		}
		/**
		* The two variants' routing facts as one stable string.
		*
		* The warning compares facts that live in two documents — this card's variant
		* and whatever the shared store last saw of the other one — and
		* `useSyncExternalStore` requires a snapshot that is reference-stable between
		* renders (see {@link settingsKeyOf}). JSON is stable by construction; it is
		* parsed back into {@link RoutingFacts} and cached by that string, so a render
		* reads the same object until the store actually changes.
		*/
		function routingKeyOf() {
			const project = (variantId) => {
				const doc = quotaStatus(variantId);
				const signedIn = doc?.status === "signed-in" ? doc : void 0;
				const entries = Array.isArray(signedIn?.accounts?.entries) ? signedIn.accounts.entries : [];
				const disabled = Array.isArray(signedIn?.disabledModels) ? signedIn.disabledModels : [];
				const ids = (Array.isArray(signedIn?.models) ? signedIn.models : []).map((model) => typeof model?.id === "string" ? model.id : "").filter((id) => id !== "");
				return [
					entries.filter((entry) => typeof entry === "object" && entry !== null).map((entry) => [
						entry.id,
						entry.accountName ?? "",
						entry.order,
						entry.credits ?? null,
						entry.creditsError ?? null,
						entry.health ?? null,
						entry.enabled ?? null
					]),
					ids.filter((id) => !disabled.includes(id)),
					ids
				];
			};
			return JSON.stringify([project("qoder"), project("qoder-global")]);
		}
		let routingCacheKey;
		let routingCacheFacts;
		/** The parsed facts behind {@link routingKeyOf}, rebuilt only when it changes. */
		function routingFacts() {
			const key = routingKeyOf();
			if (key !== routingCacheKey || routingCacheFacts === void 0) {
				routingCacheKey = key;
				routingCacheFacts = parseRoutingFacts(key);
			}
			return routingCacheFacts;
		}
		function readRoutingIds(value) {
			return Array.isArray(value) ? value.filter((id) => typeof id === "string") : [];
		}
		function readRoutingAccounts(value, variant) {
			if (!Array.isArray(value)) return [];
			const accounts = [];
			for (const item of value) {
				if (!Array.isArray(item)) continue;
				const [id, name, order, credits, creditsError, health, enabled] = item;
				if (typeof id !== "string" || id === "") continue;
				accounts.push({
					id,
					name: typeof name === "string" ? name : "",
					order: typeof order === "number" ? order : accounts.length + 1,
					variant,
					...typeof credits === "object" && credits !== null ? { credits } : {},
					...typeof creditsError === "string" ? { creditsError } : {},
					...health === "normal" || health === "queued" || health === "limited" ? { health } : {},
					...typeof enabled === "boolean" ? { enabled } : {}
				});
			}
			return accounts;
		}
		function parseRoutingFacts(raw) {
			const empty = {
				accounts: [],
				cnServed: [],
				globalServed: [],
				cnCatalog: [],
				globalCatalog: []
			};
			try {
				const parsed = JSON.parse(raw);
				if (!Array.isArray(parsed) || parsed.length < 2) return empty;
				const cn = parsed[0];
				const global = parsed[1];
				return {
					accounts: [...readRoutingAccounts(cn[0], "cn"), ...readRoutingAccounts(global[0], "global")],
					cnServed: readRoutingIds(cn[1]),
					cnCatalog: readRoutingIds(cn[2]),
					globalServed: readRoutingIds(global[1]),
					globalCatalog: readRoutingIds(global[2])
				};
			} catch {
				return empty;
			}
		}
		/**
		* The models that make a mixed order unsafe: ones a variant offers while the
		* OTHER variant's catalogue does not declare them at all.
		*
		* A side whose catalogue the store has never seen contributes no offenders —
		* an empty catalogue would make every model look one-sided, and a warning that
		* cannot name a single model is worse than no warning.
		*/
		function mixedRoutingOffenders(facts) {
			const globalCatalog = new Set(facts.globalCatalog);
			const cnCatalog = new Set(facts.cnCatalog);
			return {
				cn: facts.globalCatalog.length === 0 ? [] : facts.cnServed.filter((id) => !globalCatalog.has(id)),
				global: facts.cnCatalog.length === 0 ? [] : facts.globalServed.filter((id) => !cnCatalog.has(id))
			};
		}
		/**
		* The order the routing list shows: what the user chose, then every account
		* they have not placed yet, in save order.
		*
		* The fallback is load-bearing. The stored order is only ever the user's own
		* list, so an account saved AFTER that list was written would otherwise vanish
		* from the very controls meant to order it — and a list that silently drops a
		* member is worse than one that appends it.
		*/
		function mergeRoutingOrder(chosen, saveOrder) {
			const known = new Set(saveOrder);
			const placed = [];
			for (const id of chosen) if (known.has(id) && !placed.includes(id)) placed.push(id);
			return [...placed, ...saveOrder.filter((id) => !placed.includes(id))];
		}
		/**
		* POST one auth action and report whether the host accepted it.
		*
		* Every auth action answers the same shape — `{ ok: true }`, or
		* `{ ok: false, error }` / a 5xx — so the transport is shared and a refused id
		* stays a VERDICT rather than a transport failure. Callers re-read the document
		* afterwards instead of trusting the reply to describe the new state.
		*/
		async function postAuthAction(path, key, body, signal) {
			const response = await fetch(path, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					"X-Qoder-Auth-Key": key
				},
				credentials: "same-origin",
				signal,
				body: JSON.stringify(body)
			});
			const value = await response.json().catch(() => void 0);
			const record = typeof value === "object" && value !== null ? value : {};
			if (response.ok && record["ok"] === true) return {
				ok: true,
				detail: ""
			};
			return {
				ok: false,
				detail: typeof record["error"] === "string" ? record["error"] : `HTTP ${response.status}`
			};
		}
		/**
		* The upstream "model not serviceable" notice.
		*
		* This is deliberately NOT an error alert. A saturated per-model queue (or a
		* service that is switched off) resolves by waiting, and the one action a user
		* must not take is re-generating a perfectly good PAT — the old rendering put
		* this text where credential errors go and users reasonably concluded their
		* token was broken. So the block carries the upstream's own words for the user
		* to quote, states a retry delay only when the upstream supplied one, claims a
		* wait ONLY when `waited` records that one actually happened, and says outright
		* that the credential is not the problem.
		*/
		function UpstreamNoticeBlock({ notice, t }) {
			const retrySeconds = typeof notice.retryAfterMs === "number" && Number.isFinite(notice.retryAfterMs) ? Math.max(1, Math.round(notice.retryAfterMs / 1e3)) : void 0;
			const at = typeof notice.at === "number" && Number.isFinite(notice.at) ? notice.at : void 0;
			const occurrences = typeof notice.occurrences === "number" && Number.isFinite(notice.occurrences) ? notice.occurrences : 1;
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: "qdp-notice",
				role: "status",
				"data-notice-kind": notice.kind,
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "qdp-noticeHead",
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)(QdpTag, {
								tone: "warn",
								children: notice.kind === "queued" ? t("upstreamNoticeKindQueued") : t("upstreamNoticeKindUnavailable")
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: "qdp-noticeTitle",
								children: t("upstreamNoticeHeading")
							}),
							at === void 0 ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: "qdp-noticeAt",
								children: t("upstreamNoticeAt", { time: formatTime(at) })
							})
						]
					}),
					notice.upstreamMessage === void 0 ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
						className: "qdp-noticeQuote",
						children: t("upstreamNoticeMessage", { message: notice.upstreamMessage })
					}),
					notice.waited ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
						className: "qdp-body",
						children: retrySeconds === void 0 ? t("upstreamNoticeWaitedNoDelay") : t("upstreamNoticeWaited", { seconds: retrySeconds })
					}) : retrySeconds === void 0 ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
						className: "qdp-body",
						children: t("upstreamNoticeRetry", { seconds: retrySeconds })
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
						className: "qdp-body",
						children: t("upstreamNoticeNotAuth")
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
						className: "qdp-caption",
						children: occurrences > 1 ? `${t("upstreamNoticeAdvice")} · ${t("upstreamNoticeRecurrence", { count: occurrences })}` : t("upstreamNoticeAdvice")
					})
				]
			});
		}
		/**
		* The section head's catalogue provenance line: where the visible model roster
		* came from and when. `live` and `saved` name the last successful fetch; the
		* built-in fallback says so explicitly instead of pretending to be current.
		*/
		function catalogCaptionOf(catalog, t) {
			if (catalog === void 0) return void 0;
			if (catalog.source === "live") return catalog.fetchedAt === void 0 ? t("catalogFallback") : t("catalogLive", { time: formatTime(catalog.fetchedAt) });
			if (catalog.source === "saved") return catalog.fetchedAt === void 0 ? t("catalogFallback") : t("catalogSaved", { time: formatTime(catalog.fetchedAt) });
			return t("catalogFallback");
		}
		/** Minutes past midnight (UTC+8), split for the two number fields. */
		function splitMinutes(minutes) {
			const safe = Number.isFinite(minutes) ? Math.trunc(minutes) : CHECK_IN_MINUTE_DEFAULT;
			const clamped = safe < 0 || safe > 1439 ? CHECK_IN_MINUTE_DEFAULT : safe;
			return {
				hours: Math.floor(clamped / 60),
				minutes: clamped % 60
			};
		}
		/**
		* The automatic check-in time: the moment a variant checks in, as two typeable
		* number fields.
		*
		* Deliberately NOT `<input type="time">`: that control's segments are spinners,
		* and with an IME active (every Chinese/Japanese keyboard) the segments refuse
		* typed digits, leaving only the tiny stepper arrows — unusable for the one
		* thing this control exists to do. Two plain number fields accept typing under
		* any input method; the value is committed on blur or Enter, so a half-typed
		* field never writes a wrong moment to the settings file.
		*/
		function CheckInTimeRow({ label, value, disabled, onPick }) {
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
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [
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
			] });
		}
		const UNAVAILABLE_SETTINGS = {
			autoCN: false,
			autoGlobal: false,
			minute: CHECK_IN_MINUTE_DEFAULT,
			pollMs: POLL_DEFAULT_MS,
			variantCN: true,
			variantGlobal: true,
			status: "unavailable",
			writable: false,
			autoFailoverEnabled: true,
			queueWaitAttempts: QUEUE_WAIT_ATTEMPTS_DEFAULT,
			queueWaitSeconds: QUEUE_WAIT_SECONDS_DEFAULT,
			routingStrategy: "save-order",
			routingOrder: [],
			stickinessEnabled: true,
			stickinessRounds: STICKINESS_ROUNDS_DEFAULT,
			stickinessRequests: STICKINESS_REQUESTS_DEFAULT,
			stickinessMinutes: STICKINESS_MINUTES_DEFAULT,
			writeError: ""
		};
		/**
		* Read the advanced-settings half of the settings face as a STABLE STRING.
		*
		* `useSyncExternalStore`'s getSnapshot must return the same reference between
		* renders unless the store changed. The face's value is a fresh object per
		* accepted document, so projecting it directly would re-render forever
		* (React #185); the JSON string below is stable by construction, and is parsed
		* back into the fields the card actually renders.
		*
		* The readout switch is deliberately NOT projected here: it is a client-side
		* preference (the shipped host's settings face does not own it), so it lives in
		* the shared store and is read directly by the advanced card.
		*/
		function settingsKeyOf(scope) {
			if (scope === void 0) return "unavailable";
			const snapshot = scope.getSnapshot();
			const value = snapshot.value ?? {};
			return JSON.stringify([
				value.autoCheckInCN === true,
				value.autoCheckInGlobal === true,
				typeof value.checkInMinute === "number" ? value.checkInMinute : CHECK_IN_MINUTE_DEFAULT,
				snapshot.status,
				snapshot.writable,
				typeof value.quotaPollMs === "number" ? value.quotaPollMs : POLL_DEFAULT_MS,
				value.variantEnabledCN !== false,
				value.variantEnabledGlobal !== false,
				value.autoFailoverEnabled !== false,
				typeof value.queueWaitAttempts === "number" ? value.queueWaitAttempts : QUEUE_WAIT_ATTEMPTS_DEFAULT,
				typeof value.queueWaitSeconds === "number" ? value.queueWaitSeconds : QUEUE_WAIT_SECONDS_DEFAULT,
				value.routingStrategy === "custom" ? "custom" : "save-order",
				Array.isArray(value.routingOrder) ? value.routingOrder : [],
				typeof value.stickinessRounds === "number" ? value.stickinessRounds : STICKINESS_ROUNDS_DEFAULT,
				typeof value.stickinessMinutes === "number" ? value.stickinessMinutes : STICKINESS_MINUTES_DEFAULT,
				typeof value.stickinessRequests === "number" ? value.stickinessRequests : STICKINESS_REQUESTS_DEFAULT,
				snapshot.error ?? "",
				value.stickinessEnabled !== false
			]);
		}
		function parseSettingsKey(raw) {
			if (raw === "unavailable") return UNAVAILABLE_SETTINGS;
			try {
				const parsed = JSON.parse(raw);
				if (!Array.isArray(parsed) || parsed.length < 6) return UNAVAILABLE_SETTINGS;
				const autoCN = parsed[0] === true;
				const autoGlobal = parsed[1] === true;
				const minute = typeof parsed[2] === "number" ? parsed[2] : CHECK_IN_MINUTE_DEFAULT;
				const status = parsed[3] === "ready" || parsed[3] === "loading" ? parsed[3] : "unavailable";
				const pollMs = typeof parsed[5] === "number" ? parsed[5] : POLL_DEFAULT_MS;
				const routingOrder = Array.isArray(parsed[12]) ? parsed[12].filter((id) => typeof id === "string") : [];
				return {
					autoCN,
					autoGlobal,
					minute,
					pollMs,
					variantCN: parsed[6] !== false,
					variantGlobal: parsed[7] !== false,
					status,
					writable: parsed[4] === true,
					autoFailoverEnabled: parsed[8] !== false,
					queueWaitAttempts: typeof parsed[9] === "number" ? parsed[9] : QUEUE_WAIT_ATTEMPTS_DEFAULT,
					queueWaitSeconds: typeof parsed[10] === "number" ? parsed[10] : QUEUE_WAIT_SECONDS_DEFAULT,
					routingStrategy: parsed[11] === "custom" ? "custom" : "save-order",
					routingOrder,
					stickinessRounds: typeof parsed[13] === "number" ? parsed[13] : STICKINESS_ROUNDS_DEFAULT,
					stickinessMinutes: typeof parsed[14] === "number" ? parsed[14] : STICKINESS_MINUTES_DEFAULT,
					stickinessRequests: typeof parsed[15] === "number" ? parsed[15] : STICKINESS_REQUESTS_DEFAULT,
					writeError: typeof parsed[16] === "string" ? parsed[16] : "",
					stickinessEnabled: parsed[17] !== false
				};
			} catch {
				return UNAVAILABLE_SETTINGS;
			}
		}
		/**
		* Render the Qoder account, model and advanced-settings sections as the
		* Plugins page's configuration page (or its one-liner, when the owner asks
		* for `summary`).
		*
		* On `page` this component renders the configuration BODY only: the Plugins
		* page draws the breadcrumb, icon, title, version and description, so no shell
		* chrome or second title lives here. The page is a grid of three cards:
		*
		* 1. 账号 — variant switcher (with per-variant enable checkboxes), status row,
		*    account summary strip, credential row, PAT entry
		* 2. 模型 — catalogue provenance + refresh, then the models pane body
		* 3. 高级设置 — quota-readout switch, auto check-in + its UTC+8 time, poll interval
		*
		* A signed-out account renders 账号 (with the PAT entry) and 高级设置 only:
		* model preferences for an account nobody is signed into would be settings the
		* user cannot exercise yet.
		*/
		/**
		* The custom routing order, top to bottom.
		*
		* The list is what the failover walk follows, so a row's position is its
		* priority and the only two edits are 「上移 / 下移」. Both ends are disabled
		* rather than hidden: the buttons stay where the eye left them, and a disabled
		* up-arrow on the first row IS the statement that it is already first.
		*/
		function RoutingOrderList(props) {
			const { ids, nameOf, variantOf, accountOf, disabled, t, onMove } = props;
			if (ids.length === 0) return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
				className: "qdp-caption",
				children: t("routingOrderMissing")
			});
			return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("ol", {
				className: "qdp-routingList",
				children: ids.map((id, index) => {
					const name = nameOf(id);
					const side = variantOf(id);
					const account = accountOf(id);
					const creditsText = account === void 0 ? void 0 : accountRowCredits(account, t);
					const showHealth = account !== void 0 && account.enabled !== false;
					const health = account?.health;
					return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("li", {
						className: "qdp-routingItem",
						"data-account-id": id,
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
								className: "qdp-routingWho",
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: "qdp-routingName",
									children: name
								}), creditsText === void 0 ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: "qdp-routingCredits",
									children: creditsText
								})]
							}),
							showHealth ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)(QdpTag, {
								tone: health === void 0 ? "neutral" : health === "normal" ? "success" : "warn",
								children: accountHealthLabel(health, t)
							}) : null,
							side === void 0 ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsx)(QdpTag, {
								tone: "neutral",
								children: side === "cn" ? t("variantTabCN") : t("variantTabGlobal")
							}),
							account?.enabled === false ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)(QdpTag, {
								tone: "neutral",
								children: t("accountParked")
							}) : null,
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
								className: "qdp-routingItemActions",
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(QdpButton, {
									variant: "outline",
									size: "sm",
									disabled: disabled || index === 0,
									"aria-label": t("routingOrderMoveUpAria", { name }),
									onClick: () => {
										onMove(index, index - 1);
									},
									children: t("routingOrderMoveUp")
								}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)(QdpButton, {
									variant: "outline",
									size: "sm",
									disabled: disabled || index === ids.length - 1,
									"aria-label": t("routingOrderMoveDownAria", { name }),
									onClick: () => {
										onMove(index, index + 1);
									},
									children: t("routingOrderMoveDown")
								})]
							})
						]
					}, id);
				})
			});
		}
		/**
		* The mixed-variant routing warning.
		*
		* A custom order that interleaves the two variants can send a request to a
		* variant that does not offer the model at all. This is stated as a fact, not a
		* gate: the user asked for the order and the walk skips accounts that cannot
		* serve the model anyway, so the banner exists to explain what will happen —
		* never to hold the write back or to ask for an acknowledgement.
		*/
		function MixedRoutingWarning(props) {
			const { offendersCN, offendersGlobal, t } = props;
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: "qdp-alert qdp-routingWarning",
				role: "alert",
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						className: "qdp-routingWarningTitle",
						children: t("routingMixedHeading")
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: t("routingMixedBody") }),
					offendersCN.length + offendersGlobal.length === 0 ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", { children: [t("routingMixedOffenders"), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
						className: "qdp-routingOffenders",
						children: [offendersCN.length === 0 ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: t("routingMixedOffenderCN", { models: offendersCN.join("、") }) }), offendersGlobal.length === 0 ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: t("routingMixedOffenderGlobal", { models: offendersGlobal.join("、") }) })]
					})] })
				]
			});
		}
		/** 14px stroke refresh glyph, so the icon-button matches the host's icon set. */
		function RefreshGlyph() {
			return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("svg", {
				"aria-hidden": "true",
				width: "14",
				height: "14",
				viewBox: "0 0 16 16",
				fill: "none",
				children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("path", {
					d: "M13.2 6.4A5.4 5.4 0 1 0 13 10.6M13.2 2.6v3.8H9.4",
					stroke: "currentColor",
					strokeWidth: "1.3",
					strokeLinecap: "round",
					strokeLinejoin: "round"
				})
			});
		}
		function QoderPluginCard(props) {
			const { t, scope, signedIn, variant, unified, view } = props;
			if (t === void 0) throw new Error("Qoder plugin card requires its translation function");
			const isUnified = unified === true;
			const liveSignIn = (0, react.useSyncExternalStore)(onQuotaSettingsChange, quotaSignInState);
			/**
			* The composer-readout switches are a CLIENT preference, not part of the host
			* settings document: the shipped settings face rejects the field with HTTP
			* 400 `unknown field`, so the shared store owns (and persists) it. The store
			* returns a stable cached snapshot, which is what `useSyncExternalStore`
			* requires.
			*/
			const readout = (0, react.useSyncExternalStore)(onQuotaSettingsChange, quotaReadout);
			/**
			* Both variants' account pools and catalogues, as a stable snapshot.
			*
			* The custom routing order spans BOTH variants, so the warning that guards a
			* mixed order has to read the other variant's document too — not just the one
			* this card is showing. It comes from the shared store rather than a fetch:
			* the card never asks the host for a variant the user is not looking at.
			*/
			const routing = (0, react.useSyncExternalStore)(onQuotaSettingsChange, routingFacts);
			(0, react.useSyncExternalStore)(onQuotaSettingsChange, quotaSettingsRevision, quotaSettingsRevision);
			/** The check-in half of the settings face, as a stable projection string. */
			const settingsSubscribe = (0, react.useCallback)((onStoreChange) => {
				return scope?.subscribe(onStoreChange) ?? (() => {});
			}, [scope]);
			const settings = parseSettingsKey((0, react.useSyncExternalStore)(settingsSubscribe, () => settingsKeyOf(scope)));
			(0, react.useEffect)(() => {
				scope?.ensureLoaded?.();
			}, [scope]);
			const [activeVariantId, setActiveVariantId] = (0, react.useState)("qoder");
			const currentVariant = isUnified ? activeVariantId === "qoder" ? QODER_CN_CARD : QODER_GLOBAL_CARD : variant ?? QODER_CN_CARD;
			/**
			* The last known sign-in fact for one variant, from the host injection when
			* it supplies one (the settings integration does) and from the shared store
			* otherwise. `undefined` = never read, which is NOT the same as signed out.
			*/
			const reported = signedIn?.();
			const knownSignIn = (variantId) => {
				const key = variantId === "qoder" ? "cn" : "global";
				return reported !== void 0 ? reported[key] : liveSignIn[key];
			};
			/**
			* Last status document PER VARIANT, plus the last read failure per variant.
			*
			* A single `status` cleared on every switch made the card blank and start
			* over: even a variant whose document was already cached on this page fell
			* back to the spinner, and a variant never read fell back to the grey
			* "signed out" dot — which is exactly what made the Global tab look disabled
			* on entry. Keyed per variant, the switcher paints the last read at once and
			* revalidates it in the background.
			*/
			const [documents, setDocuments] = (0, react.useState)({});
			const [readFailures, setReadFailures] = (0, react.useState)({});
			const status = documents[currentVariant.id] ?? quotaStatus(currentVariant.id);
			const readFailure = readFailures[currentVariant.id];
			const [busy, setBusy] = (0, react.useState)(false);
			const [patDraft, setPatDraft] = (0, react.useState)("");
			const [replacing, setReplacing] = (0, react.useState)(false);
			const [patBusy, setPatBusy] = (0, react.useState)(false);
			const [patError, setPatError] = (0, react.useState)();
			const [patNotice, setPatNotice] = (0, react.useState)();
			const [checkingIn, setCheckingIn] = (0, react.useState)(false);
			const [checkInNotice, setCheckInNotice] = (0, react.useState)();
			/** 「删除 PAT」的内联确认：点一次进入确认，再点一次才真正清除。 */
			const [confirmingClear, setConfirmingClear] = (0, react.useState)(false);
			/**
			* The account-pool actions: one busy flag for switch/remove, the id whose
			* row is asking for a remove confirmation, and one message pair.
			*
			* `accountError` is deliberately NOT `patError`: the PAT entry can be closed
			* when a row action fails, and an error parked inside a hidden box is an
			* error the user never sees.
			*/
			const [accountBusy, setAccountBusy] = (0, react.useState)(false);
			const [confirmingRemoveId, setConfirmingRemoveId] = (0, react.useState)();
			const [accountError, setAccountError] = (0, react.useState)();
			const [accountNotice, setAccountNotice] = (0, react.useState)();
			/**
			* The ids with an in-flight park/unpark write.
			*
			* A SET, not one flag: parking two seats is two independent writes to two
			* accounts, and a single shared busy flag would make the second click a
			* silent no-op. It is separate from `accountBusy` (switch/remove) because the
			* two gestures touch different rows and must not block each other.
			*/
			const [togglingIds, setTogglingIds] = (0, react.useState)([]);
			/**
			* The model pane's batched save: its own busy flag, separate from a refresh.
			*/
			const [savingModels, setSavingModels] = (0, react.useState)(false);
			const [modelsSaveError, setModelsSaveError] = (0, react.useState)();
			const mounted = (0, react.useRef)(true);
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
			const readSeq = (0, react.useRef)({});
			/**
			* Read one variant's status document.
			*
			* With `force: false` (the sibling prefetch) the shared cache decides first:
			* a document younger than the configured poll interval is reused, so warming
			* the other tab costs no upstream call — the configured interval is a cache
			* lifetime, not a metronome. Mount, tab switches, every explicit gesture
			* (refresh, a write's follow-up) and the interval tick force: they paint the
			* cached document at once and revalidate it, so a stale cache never sticks.
			*/
			const readVariant = (0, react.useCallback)(async (target, options, signal) => {
				const variantId = target.id;
				if (options.force !== true && quotaStatusIsFresh(variantId, quotaPollMs())) return false;
				const seq = (readSeq.current[variantId] ?? 0) + 1;
				readSeq.current[variantId] = seq;
				const current = () => mounted.current && signal?.aborted !== true && readSeq.current[variantId] === seq;
				try {
					const response = await fetch(target.statusPath, {
						headers: { accept: "application/json" },
						credentials: "same-origin",
						...signal === void 0 ? {} : { signal }
					});
					const value = await response.json().catch(() => void 0);
					if (!response.ok) throw new Error(`HTTP ${response.status}`);
					if (!isQoderWebStatus(value)) throw new Error(t("statusResponseInvalid"));
					if (!current()) return false;
					setDocuments((previous) => previous[variantId] === value ? previous : {
						...previous,
						[variantId]: value
					});
					setReadFailures((previous) => previous[variantId] === void 0 ? previous : {
						...previous,
						[variantId]: void 0
					});
					if (value.status === "signed-in" || value.status === "signed-out") noteQuotaStatus(variantId, value);
					return true;
				} catch (error) {
					if (!current()) return false;
					const message = error instanceof Error && error.message !== "" ? error.message : t("requestFailed");
					setReadFailures((previous) => ({
						...previous,
						[variantId]: message
					}));
					setDocuments((previous) => previous[variantId] !== void 0 || quotaStatus(variantId) !== void 0 ? previous : {
						...previous,
						[variantId]: {
							status: "error",
							message
						}
					});
					return false;
				}
			}, [t]);
			/** A deliberate re-read: user refresh, a write's follow-up, the poll tick. */
			const refresh = (0, react.useCallback)((signal) => readVariant(currentVariant, { force: true }, signal), [currentVariant, readVariant]);
			/** Record (or clear) the read failure a variant's tab shows. */
			const noteReadFailure = (0, react.useCallback)((variantId, message) => {
				setReadFailures((previous) => previous[variantId] === message ? previous : {
					...previous,
					[variantId]: message
				});
			}, []);
			(0, react.useEffect)(() => {
				setPatDraft("");
				setReplacing(false);
				setPatError(void 0);
				setPatNotice(void 0);
				setAccountError(void 0);
				setAccountNotice(void 0);
				setConfirmingRemoveId(void 0);
				setConfirmingClear(false);
				setCheckInNotice(void 0);
				const controller = new AbortController();
				readVariant(currentVariant, { force: true }, controller.signal);
				return () => {
					controller.abort();
				};
			}, [currentVariant.statusPath, readVariant]);
			const prefetched = (0, react.useRef)(false);
			(0, react.useEffect)(() => {
				if (!isUnified || prefetched.current) return;
				prefetched.current = true;
				const controller = new AbortController();
				for (const candidate of QODER_CARD_VARIANTS) {
					if (candidate.id === currentVariant.id) continue;
					if (quotaStatusIsFresh(candidate.id, quotaPollMs())) continue;
					readVariant(candidate, {}, controller.signal);
				}
				return () => {
					controller.abort();
				};
			}, [
				currentVariant.id,
				isUnified,
				readVariant
			]);
			const currentSignIn = knownSignIn(currentVariant.id);
			(0, react.useEffect)(() => {
				if (currentSignIn === false) return;
				const controller = new AbortController();
				const timer = window.setInterval(() => {
					readVariant(currentVariant, { force: true }, controller.signal);
					if (!isUnified) return;
					for (const candidate of QODER_CARD_VARIANTS) {
						if (candidate.id === currentVariant.id) continue;
						if (knownSignIn(candidate.id) === false) continue;
						readVariant(candidate, {}, controller.signal);
					}
				}, POLL_INTERVAL_MS);
				return () => {
					window.clearInterval(timer);
					controller.abort();
				};
			}, [
				currentSignIn,
				currentVariant,
				isUnified,
				readVariant
			]);
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
					if (mounted.current && controller.signal.aborted !== true) noteReadFailure(currentVariant.id, error instanceof Error ? error.message : t("requestFailed"));
					manualControllers.current.delete(controller);
					return;
				} finally {
					if (mounted.current) setBusy(false);
				}
				if (result.state === "failed") {
					if (mounted.current) noteReadFailure(currentVariant.id, result.reason ?? t("requestFailed"));
					manualControllers.current.delete(controller);
					return;
				}
				if (result.state === "refreshed" && mounted.current) noteReadFailure(currentVariant.id, void 0);
				try {
					await refresh(controller.signal);
				} finally {
					manualControllers.current.delete(controller);
				}
			}, [
				currentVariant.id,
				currentVariant.probePath,
				noteReadFailure,
				refresh,
				status,
				t,
				trackController
			]);
			/**
			* 「一键签到」: claim today's benefit for EVERY signed-in variant in one click.
			*
			* The probe key is process-wide (one key authorizes both variants' routes),
			* so the card can drive the other variant's route without a second read. A
			* variant that is not signed in is skipped rather than attempted: its route
			* would only answer with a credential error the user cannot act on from here.
			*
			* One failure must not abort the other claim: each target is wrapped
			* separately and its own sentence is appended, so a China failure still lets
			* Global claim (and vice versa).
			*/
			const manualCheckInAll = (0, react.useCallback)(async () => {
				const key = (status?.status === "signed-in" ? status : void 0)?.probeKey;
				if (key === void 0) return;
				setCheckingIn(true);
				setCheckInNotice(void 0);
				const controller = trackController();
				const sentences = [];
				try {
					for (const variant of QODER_CARD_VARIANTS) {
						if (!(variant.id === currentVariant.id || (variant.id === "qoder" ? liveSignIn.cn : liveSignIn.global))) continue;
						const name = t(variant.id === "qoder" ? "variantTabCN" : "variantTabGlobal");
						try {
							const response = await fetch(variant.probePath, {
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
							const text = result.state === "claimed" ? t("autoCheckInStatusClaimed", { amount: result.amount ?? 100 }) : result.state === "already-claimed" ? t("autoCheckInStatusAlready") : result.state === "no-campaign" ? t("autoCheckInStatusNoCampaign") : result.reasonCode === "no-client" ? t("checkInNeedsClient") : result.reason === void 0 ? void 0 : t("autoCheckInStatusError", { message: result.reason });
							if (text !== void 0) sentences.push(`${name} · ${text}`);
						} catch (error) {
							if (controller.signal.aborted === true) return;
							const message = error instanceof Error ? error.message : t("requestFailed");
							sentences.push(`${name} · ${message}`);
						}
					}
					if (mounted.current && sentences.length > 0) setCheckInNotice(sentences.join("；"));
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
				currentVariant.id,
				liveSignIn,
				refresh,
				status,
				t,
				trackController
			]);
			/**
			* One probe-route write, WITHOUT a status re-read.
			*
			* The batch save below issues several writes (two enable/disable batches and
			* one window write per changed model) and re-reads the status exactly once
			* afterwards. Refreshing per write would repaint the page between every
			* round trip, reset the pane's draft mid-save, and multiply the reads.
			*
			* The key travels in a header, not the body: it authorizes the write, and
			* the host never accepts a prompt, a sentinel, or a model outside its own
			* catalog from here.
			*/
			const probeWrite = (0, react.useCallback)(async (action) => {
				const key = status?.status === "signed-in" ? status.probeKey : void 0;
				if (key === void 0) throw new Error(t("requestFailed"));
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
					if (action.action === "set-maximum-context-window" || action.action === "set-models-enabled" || action.action === "set-model-context-window") {
						if (typeof value !== "object" || value === null || value["state"] !== "updated") {
							const reason = typeof value === "object" && value !== null && "reason" in value ? String(value["reason"]) : t("requestFailed");
							throw new Error(reason);
						}
					}
				} finally {
					manualControllers.current.delete(controller);
				}
			}, [
				currentVariant.probePath,
				status,
				t,
				trackController
			]);
			/**
			* Apply one draft from the models pane as a batch: the enable/disable delta,
			* then one write per changed context window, then ONE status re-read.
			*
			* The draft is a diff against the catalogue (the pane only stages models that
			* differ), so empty deltas are skipped rather than posted: the host rejects an
			* empty `models` list, and a pointless write is a failed save in waiting.
			*/
			const saveModelDraft = (0, react.useCallback)(async (draft) => {
				const document = status?.status === "signed-in" ? status : void 0;
				if (document?.probeKey === void 0) return;
				setSavingModels(true);
				setModelsSaveError(void 0);
				try {
					const baseDisabled = document.disabledModels ?? [];
					const toDisable = draft.disabled.filter((id) => !baseDisabled.includes(id));
					const toEnable = baseDisabled.filter((id) => !draft.disabled.includes(id));
					if (toDisable.length > 0) await probeWrite({
						action: "set-models-enabled",
						models: toDisable,
						enabled: false
					});
					if (toEnable.length > 0) await probeWrite({
						action: "set-models-enabled",
						models: toEnable,
						enabled: true
					});
					const models = document.models ?? [];
					for (const [model, window] of Object.entries(draft.windows)) {
						const baseline = models.find((entry) => entry.id === model);
						if ((baseline?.contextWindow ?? baseline?.defaultContextWindow) === window) continue;
						await probeWrite({
							action: "set-model-context-window",
							model,
							window
						});
					}
					await refresh();
				} catch (error) {
					if (mounted.current) setModelsSaveError(error instanceof Error ? error.message : t("requestFailed"));
				} finally {
					if (mounted.current) setSavingModels(false);
				}
			}, [
				probeWrite,
				refresh,
				status,
				t
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
					setDocuments((previous) => ({
						...previous,
						[currentVariant.id]: signedOutDoc
					}));
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
			* 「切换使用」/「删除账号」: the two pool writes, addressed by the account id
			* the status document handed us.
			*
			* The id is the credential's one-way hash, never the token, so a card can
			* only ever name an account the host already told it about and the host
			* re-checks it against the pool it owns. The route answers the same shape as
			* save/clear (`{ ok: true }`, or `{ ok: false, error }` / a 5xx), and a
			* refused id is a verdict rather than a transport failure — so it is reported
			* and the pool is re-read, because an unknown id means another surface
			* changed the list under this card.
			*
			* A successful write is not trusted to describe itself: `refresh` re-reads
			* the document, which is what makes the active dot, the summary strip, and
			* the credit figure all move together.
			*/
			const accountAction = (0, react.useCallback)(async (action, accountId, name) => {
				const key = authKey;
				if (key === void 0 || accountBusy) return;
				setAccountBusy(true);
				setAccountError(void 0);
				setAccountNotice(void 0);
				setConfirmingRemoveId(void 0);
				const controller = trackController();
				try {
					const body = {
						action,
						accountId
					};
					const result = await postAuthAction(currentVariant.authPath, key, body, controller.signal);
					if (!result.ok) setAccountError(t("accountActionFailed", { message: result.detail }));
					else setAccountNotice(action === "activate-account" ? t("accountSwitched", { name }) : t("accountRemoved"));
					await refresh(controller.signal);
				} catch (error) {
					if (mounted.current && controller.signal.aborted !== true) setAccountError(t("accountActionFailed", { message: error instanceof Error ? error.message : t("requestFailed") }));
				} finally {
					manualControllers.current.delete(controller);
					if (mounted.current) setAccountBusy(false);
				}
			}, [
				accountBusy,
				authKey,
				currentVariant.authPath,
				refresh,
				t,
				trackController
			]);
			/**
			* Park or unpark one pooled account.
			*
			* The checkbox is bound to the DOCUMENT (`enabled !== false`), never to an
			* optimistic local copy. Flipping it in state would show a value the host may
			* refuse, and the row's own re-read would then snap it back — a flicker users
			* read as a lost click. So the row reports itself busy and the value moves
			* only when the document says it did; a refusal keeps the previous value and
			* surfaces the host's reason in the shared account error line.
			*
			* Pending state is per account (see `togglingIds`), so one seat's write never
			* freezes another's checkbox.
			*/
			const accountToggle = (0, react.useCallback)(async (accountId, enabled, name) => {
				const key = authKey;
				if (key === void 0 || togglingIds.includes(accountId)) return;
				setTogglingIds((ids) => [...ids, accountId]);
				setAccountError(void 0);
				setAccountNotice(void 0);
				const controller = trackController();
				try {
					const body = {
						action: "set-account-enabled",
						accountId,
						enabled
					};
					const result = await postAuthAction(currentVariant.authPath, key, body, controller.signal);
					if (!result.ok) setAccountError(t("accountActionFailed", { message: result.detail }));
					else setAccountNotice(enabled ? t("accountEnabledNotice", { name }) : t("accountParkedNotice", { name }));
					await refresh(controller.signal);
				} catch (error) {
					if (mounted.current && controller.signal.aborted !== true) setAccountError(t("accountActionFailed", { message: error instanceof Error ? error.message : t("requestFailed") }));
				} finally {
					manualControllers.current.delete(controller);
					if (mounted.current) setTogglingIds((ids) => ids.filter((id) => id !== accountId));
				}
			}, [
				authKey,
				currentVariant.authPath,
				refresh,
				t,
				togglingIds,
				trackController
			]);
			/**
			* The inline PAT entry: a password field plus save (and cancel while
			* replacing). The save control beside the field is the retry: an invalid PAT
			* is a value problem, not a transport one.
			*/
			const patEntry = () => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: "qdp-stack",
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
						className: "qdp-caption",
						children: t(currentVariant.patGuideKey)
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "qdp-row",
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)(QdpInput, {
								className: "qdp-patInput",
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
			const dotFor = (target, enabled) => {
				if (!enabled) return "idle";
				if (isUnified && activeVariantId === target.id) {
					const document = documents[target.id] ?? quotaStatus(target.id);
					return dotStateOf(document === void 0 ? "loading" : document.status);
				}
				const known = knownSignIn(target.id);
				return known === void 0 ? "ongoing" : dotStateOf(known ? "signed-in" : "signed-out");
			};
			const cnDotState = dotFor(QODER_CN_CARD, settings.variantCN !== false);
			const globalDotState = dotFor(QODER_GLOBAL_CARD, settings.variantGlobal !== false);
			const planTag = status?.status === "signed-in" && status.plan !== void 0 ? t("planTier", { name: status.plan.planTierName }) : void 0;
			const planMeta = status?.status === "signed-in" && status.plan !== void 0 ? [status.plan.organizationName === void 0 ? null : t("planOrganization", { name: status.plan.organizationName }), status.plan.endDate === void 0 ? null : t("planEndsAt", { date: formatCycleReset(status.plan.endDate) })].filter((part) => part !== null).join(" · ") : void 0;
			if (view === "summary") return /* @__PURE__ */ (0, react_jsx_runtime.jsx)(react_jsx_runtime.Fragment, { children: cardIntro });
			const settingsVariant = isUnified ? activeVariantId === "qoder" ? "cn" : "global" : currentVariant.id === "qoder" ? "cn" : "global";
			const signedInDoc = status?.status === "signed-in" ? status : void 0;
			const settingsSignedIn = Boolean(knownSignIn(settingsVariant === "cn" ? "qoder" : "qoder-global"));
			/** Whether EITHER account is signed in — the shared check-in time needs one. */
			const anySignedIn = Boolean(knownSignIn("qoder") || knownSignIn("qoder-global"));
			const autoCheckInOn = settingsVariant === "cn" ? settings.autoCN : settings.autoGlobal;
			/** One moment for both variants: the card edits a single shared setting. */
			const checkInMinute = settings.minute;
			const readoutEnabled = readout.enabled;
			const pollMinutes = Math.max(1, Math.round(settings.pollMs / 6e4));
			/**
			* One write path for every advanced-card control: the local settings face is
			* immediate (there is no save button), and a face the host does not serve —
			* or one that refuses writes — is skipped instead of pretending to store.
			*/
			const writeSetting = (field, value) => {
				if (settings.status === "unavailable" || scope === void 0) return;
				scope.set(field, value);
			};
			/**
			* Write a field whose value is not a boolean or number.
			*
			* Kept separate from {@link writeSetting} so the scalar path above can never
			* be handed an array by mistake — a routing order posted through it would be
			* silently dropped by the host's own typing.
			*/
			const writeStructuredSetting = (field, value) => {
				if (settings.status === "unavailable" || scope === void 0) return;
				scope.set(field, value);
			};
			/**
			* The automatic check-in controls write the same fields the advanced card
			* always wrote; a variant with no PAT cannot arm a timer it could never fire,
			* so the switch stays disabled until that variant signs in.
			*/
			const writeAutoCheckIn = (next) => {
				if (!settingsSignedIn) return;
				writeSetting(settingsVariant === "cn" ? "autoCheckInCN" : "autoCheckInGlobal", next);
			};
			/**
			* The ONE check-in time.
			*
			* The shared field is the value the host's scheduler reads first, so writing
			* it alone retimes both variants. The legacy per-variant fields are cleared
			* (null) so a stale value can never outrank the shared one on an older
			* settings face that keeps them.
			*/
			const writeCheckInMinute = (minutes) => {
				if (!anySignedIn) return;
				writeSetting("checkInMinute", minutes);
			};
			/**
			* The readout switch is NOT gated on sign-in: it describes what the composer
			* chip should show, and a user configuring the plugin before signing in must
			* still be able to hide it.
			*
			* It writes the shared STORE, not the settings scope: the shipped host does
			* not own this preference, and a browser preference must work against any
			* loaded host version. `setQuotaReadout` bumps the store's revision
			* synchronously, so the card re-renders from it.
			*/
			const writeReadoutEnabled = (next) => {
				setQuotaReadout(next);
			};
			/**
			* The per-variant master checkboxes beside the switcher tabs. They gate the
			* PROVIDER (no model of that variant is offered) without touching the
			* per-model blacklist, so flipping one back on restores exactly the previous
			* model selection.
			*/
			const writeVariantEnabled = (variant, next) => {
				writeSetting(variant === "cn" ? "variantEnabledCN" : "variantEnabledGlobal", next);
			};
			const writePollMinutes = (minutes) => {
				writeSetting("quotaPollMs", Math.max(POLL_MIN_MS, minutes * 6e4));
			};
			/**
			* The routing controls write the host's OWN failover fields, so a settings
			* face that does not serve them gets no controls at all — a switch whose
			* value the host drops is a lie the user would only discover after a
			* failover went the wrong way.
			*/
			const routingWritable = settings.status !== "unavailable" && scope !== void 0;
			/**
			* Whether the settings face has actually answered.
			*
			* While it is still loading the card renders the schema defaults, so every
			* control looks live but a write would be dropped (there is no document to
			* authorize it). Such controls are disabled instead of silently inert: a
			* control that accepts a click and forgets it is the exact failure this
			* state exists to prevent.
			*/
			const settingsReady = settings.status === "ready";
			const routingStrategy = settings.routingStrategy;
			const routingStoredOrder = settings.routingOrder;
			const routingNameOf = (id) => {
				const account = routing.accounts.find((entry) => entry.id === id);
				if (account === void 0) return id;
				return account.name === "" ? t("accountSlot", { order: account.order }) : account.name;
			};
			const routingVariantOf = (id) => routing.accounts.find((entry) => entry.id === id)?.variant;
			/** Every variant holding this id: one token saved to both counts as both. */
			const routingSidesOf = (id) => {
				const sides = [];
				if (routing.accounts.some((entry) => entry.id === id && entry.variant === "cn")) sides.push("cn");
				if (routing.accounts.some((entry) => entry.id === id && entry.variant === "global")) sides.push("global");
				return sides;
			};
			const routingOrderIds = mergeRoutingOrder(routingStoredOrder, routing.accounts.map((entry) => entry.id));
			const routingMixed = routingStrategy === "custom" && new Set(routingOrderIds.flatMap(routingSidesOf)).size > 1;
			const routingOffenders = routingMixed ? mixedRoutingOffenders(routing) : {
				cn: [],
				global: []
			};
			/**
			* Apply a routing change.
			*
			* The mixed-variant banner is informational: the order the user builds is
			* written straight through, because the walk simply skips an account whose
			* variant does not serve the model. Nothing here may hold a write back — the
			* user has already been told what the interleaving costs.
			*/
			const applyRouting = (next) => {
				if (!routingWritable) return;
				if (next.strategy !== settings.routingStrategy) writeStructuredSetting("routingStrategy", next.strategy);
				if (next.order.join("\0") !== routingStoredOrder.join("\0")) writeStructuredSetting("routingOrder", [...next.order]);
			};
			const moveRoutingAccount = (from, to) => {
				const ids = [...routingOrderIds];
				if (from < 0 || from >= ids.length || to < 0 || to >= ids.length) return;
				const moved = ids.splice(from, 1)[0];
				if (moved === void 0) return;
				ids.splice(to, 0, moved);
				applyRouting({
					strategy: "custom",
					order: ids
				});
			};
			const chooseRoutingStrategy = (next) => {
				applyRouting({
					strategy: next,
					order: routingOrderIds
				});
			};
			const checkIn = signedInDoc?.checkIn;
			/**
			* Today's benefit is already in — whether this process granted it or merely
			* found the upstream reporting it as claimed.
			*
			* `already-claimed` must count: the upstream answers that way for every later
			* request on a claimed day, so treating only `claimed` as "done" re-armed the
			* button and invited the repeat click. The DATE must count too — `checkIn` is
			* the persisted record, not a live reading, and `today` is stamped host-side
			* in UTC+8 (the day the scheduler uses), so a `claimed` row from three days
			* ago no longer disables today's button.
			*/
			const claimedToday = checkIn !== void 0 && checkIn.lastDate === checkIn.today && (checkIn.status === "claimed" || checkIn.status === "already-claimed");
			const catalogCaption = signedInDoc === void 0 ? void 0 : catalogCaptionOf(signedInDoc.catalog, t);
			/**
			* The account summary strip (剩余积分 / 签到状态 / 当前使用 / 一键签到).
			*
			* The remaining figure follows the SAME rule as the composer chip — summed
			* package remainder, "Unlimited" only when nothing is countable — because a
			* second currency rule on the same document is a bug waiting to happen.
			*/
			const creditsText = signedInDoc?.credits === void 0 ? "—" : (() => {
				const summary = creditSummary(signedInDoc.credits);
				return summary.unlimited ? t("quotaUnlimited") : new Intl.NumberFormat(void 0).format(summary.remain);
			})();
			const accountName = signedInDoc?.pat?.accountName;
			const credentialMeta = signedInDoc?.pat === void 0 ? void 0 : [
				patSourceText(signedInDoc.pat.source, t),
				signedInDoc.pat.savedAtMs === void 0 ? null : t("patSavedAt", { time: formatTime(signedInDoc.pat.savedAtMs) }),
				signedInDoc.pat.patTail === void 0 ? null : t("patTail", { tail: `****${signedInDoc.pat.patTail}` })
			].filter((part) => part !== null).join(" · ");
			const signedOutStatus = status?.status === "signed-out" ? status : void 0;
			const patEntryOpen = replacing || signedOutStatus !== void 0;
			/**
			* The account pool, when the host serves one.
			*
			* `accounts` is present even with a single account (`entries.length === 1`),
			* and the list below renders from it alone — a synthesized one-row shape
			* would be a second code path that only ever shows one row. An EMPTY pool is
			* treated as absent on purpose: `accounts()` omits an env-only credential by
			* design, and that credential still needs the single-credential row to
			* describe it.
			*/
			const servedAccounts = signedInDoc?.accounts;
			/**
			* Rows whose `id` is missing are dropped rather than rendered.
			*
			* The id IS the write key (`{action, accountId}`) and the row's React key, so
			* an entry without one can only offer a control that sends `undefined` — and
			* a hostile or newer-host document must not be able to paint a dead button or
			* crash the page on `entries` itself.
			*/
			const poolEntries = (Array.isArray(servedAccounts?.entries) ? servedAccounts.entries : []).filter((entry) => typeof entry?.id === "string" && entry.id.length > 0);
			const pool = servedAccounts !== void 0 && poolEntries.length > 0 ? {
				...servedAccounts,
				entries: poolEntries
			} : void 0;
			/**
			* The host's in-process count of upstream errors that arrived INSIDE a 200
			* stream (a refused chat, a rate-limit page) and that the transport had to
			* classify after the status code said "fine".
			*
			* Rendered only when at least one has happened: zero is the normal case and
			* needs no row. The counts are per process, so they reset on restart — the
			* caption says so rather than pretending to be a lifetime statistic.
			*/
			const innerErrorsSummary = (() => {
				const counters = signedInDoc?.innerErrors;
				if (counters === void 0) return void 0;
				const parts = [
					["content_policy", t("innerErrorsContentPolicy")],
					["rate_limit", t("innerErrorsRateLimit")],
					["invalid_request", t("innerErrorsInvalidRequest")],
					["auth", t("innerErrorsAuth")],
					["other", t("innerErrorsOther")]
				].map(([kind, label]) => ({
					label,
					count: counters[kind] ?? 0
				})).filter((item) => item.count > 0).map((item) => `${item.label} ${item.count}`);
				return parts.length === 0 ? void 0 : parts.join(" · ");
			})();
			const upstreamNotice = signedInDoc?.upstreamNotice;
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: "qdp-page",
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("section", {
						className: "qdp-card",
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: "qdp-sectionHead",
							children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h2", {
									className: "qdp-sectionTitle",
									children: t("accountHeading")
								}),
								isUnified ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)(QdpSegmented, {
									label: t("variantSwitcherAria"),
									value: activeVariantId,
									options: [{
										value: "qoder",
										label: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(QdpStateDot, { state: cnDotState }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: t("variantTabCN") })] }),
										trailing: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
											type: "checkbox",
											className: "qdp-segCheck",
											checked: settings.variantCN,
											disabled: !settingsReady,
											"aria-label": `${t("variantTabCN")} — ${t("variantEnable")}`,
											title: t("variantEnable"),
											onClick: (event) => {
												event.stopPropagation();
											},
											onChange: (event) => {
												writeVariantEnabled("cn", event.target.checked);
											}
										})
									}, {
										value: "qoder-global",
										label: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(QdpStateDot, { state: globalDotState }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: t("variantTabGlobal") })] }),
										trailing: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
											type: "checkbox",
											className: "qdp-segCheck",
											checked: settings.variantGlobal,
											disabled: !settingsReady,
											"aria-label": `${t("variantTabGlobal")} — ${t("variantEnable")}`,
											title: t("variantEnable"),
											onClick: (event) => {
												event.stopPropagation();
											},
											onChange: (event) => {
												writeVariantEnabled("global", event.target.checked);
											}
										})
									}],
									onChange: setActiveVariantId
								}) : null,
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)(QdpIconButton, {
									label: t("refresh"),
									disabled: busy,
									onClick: () => {
										manualRefresh();
									},
									children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(RefreshGlyph, {})
								})
							]
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: "qdp-sectionBody",
							children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
									className: "qdp-row",
									children: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
										className: "qdp-rowText",
										children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
											className: "qdp-rowTitle",
											role: "status",
											"aria-busy": status === void 0,
											children: [
												/* @__PURE__ */ (0, react_jsx_runtime.jsx)(QdpStateDot, { state: dotStateOf(status === void 0 ? "loading" : status.status) }),
												/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: signedInLabel }),
												planTag === void 0 ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsx)(QdpTag, { children: planTag })
											]
										}), planMeta === void 0 || planMeta === "" ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
											className: "qdp-rowDesc",
											children: planMeta
										})]
									})
								}),
								signedInDoc === void 0 ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
									className: "qdp-accountSummary",
									children: [
										/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
											className: "qdp-accountStat",
											children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
												className: "qdp-accountStatLabel",
												children: t("creditsRemaining")
											}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
												className: "qdp-accountStatValue qdp-num",
												children: creditsText
											})]
										}),
										/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
											className: "qdp-accountStat",
											children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
												className: "qdp-accountStatLabel",
												children: t("checkInStatus")
											}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
												className: "qdp-accountStatValue",
												children: claimedToday ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)(QdpTag, {
													tone: "success",
													children: t("checkInClaimedToday")
												}) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: t("checkInNotClaimed") })
											})]
										}),
										/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
											className: "qdp-accountStat",
											children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
												className: "qdp-accountStatLabel",
												children: t("accountCurrent")
											}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
												className: "qdp-accountStatValue",
												children: accountName ?? t("signedIn")
											})]
										}),
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
											className: "qdp-accountActions",
											children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(QdpButton, {
												variant: "primary",
												size: "sm",
												disabled: busy || checkingIn || !anySignedIn,
												onClick: () => {
													manualCheckInAll();
												},
												children: checkingIn ? t("checkInChecking") : t("checkInAll")
											})
										})
									]
								}),
								checkInNotice === void 0 ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
									className: "qdp-body",
									children: checkInNotice
								}),
								upstreamNotice === void 0 ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsx)(UpstreamNoticeBlock, {
									notice: upstreamNotice,
									t
								}),
								pool === void 0 ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
									className: "qdp-accountPool",
									children: [
										/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
											className: "qdp-row",
											children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
												className: "qdp-rowText",
												children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
													className: "qdp-rowTitle",
													children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: t("accountsHeading") }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)(QdpTag, {
														tone: pool.autoFailover ? "success" : "neutral",
														children: pool.autoFailover ? t("accountsFailoverOn") : pool.autoFailoverEnabled === false ? t("accountsFailoverOff") : t("accountsFailoverIdle")
													})]
												}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
													className: "qdp-rowDesc",
													children: t("accountsHint")
												})]
											}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
												className: "qdp-rowControl",
												children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(QdpButton, {
													variant: "outline",
													size: "sm",
													disabled: busy || patBusy || accountBusy || authKey === void 0,
													onClick: () => {
														setPatError(void 0);
														setPatNotice(void 0);
														setReplacing(true);
													},
													children: t("accountAdd")
												})
											})]
										}),
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("ul", {
											className: "qdp-accountList",
											children: pool.entries.map((entry) => {
												const name = entry.accountName ?? t("accountSlot", { order: entry.order });
												const armed = confirmingRemoveId === entry.id;
												const showHealth = entry.enabled !== false;
												const health = entry.health;
												return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("li", {
													className: entry.enabled === false ? "qdp-accountItem is-off" : "qdp-accountItem",
													"data-account-id": entry.id,
													children: [
														/* @__PURE__ */ (0, react_jsx_runtime.jsx)("label", {
															className: "qdp-accountCheck",
															children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
																type: "checkbox",
																checked: entry.enabled !== false,
																disabled: busy || accountBusy || togglingIds.includes(entry.id),
																"aria-label": t("accountEnabledAria", { name }),
																onChange: (event) => {
																	accountToggle(entry.id, event.target.checked, name);
																}
															})
														}),
														/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
															className: "qdp-accountItemInfo",
															children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
																className: "qdp-accountItemName",
																children: [
																	/* @__PURE__ */ (0, react_jsx_runtime.jsx)(QdpStateDot, { state: entry.active ? "done" : "idle" }),
																	/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: name }),
																	/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
																		className: "qdp-accountItemCredits",
																		children: accountRowCredits(entry, t)
																	}),
																	showHealth ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
																		className: "qdp-accountHealth",
																		title: t("accountHealthAria"),
																		children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(QdpTag, {
																			tone: health === void 0 ? "neutral" : health === "normal" ? "success" : "warn",
																			children: accountHealthLabel(health, t)
																		})
																	}) : null,
																	entry.active ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)(QdpTag, {
																		tone: "success",
																		children: t("accountCurrent")
																	}) : null,
																	entry.enabled === false ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)(QdpTag, {
																		tone: "neutral",
																		children: t("accountParked")
																	}) : null
																]
															}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
																className: "qdp-accountItemMeta",
																children: accountRowMeta(entry, t)
															})]
														}),
														/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
															className: "qdp-rowControl",
															children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(QdpButton, {
																variant: "outline",
																size: "sm",
																disabled: entry.active || busy || accountBusy,
																"aria-label": t("accountSwitchAria", { name }),
																onClick: () => {
																	accountAction("activate-account", entry.id, name);
																},
																children: t("accountSwitch")
															}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)(QdpButton, {
																variant: "dangerQuiet",
																size: "sm",
																disabled: busy || accountBusy,
																"aria-label": t("accountRemoveAria", { name }),
																onClick: () => {
																	setConfirmingRemoveId(entry.id);
																},
																children: t("patRemove")
															})]
														}),
														armed ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
															className: "qdp-alert qdp-accountItemConfirm",
															role: "alert",
															children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: t("accountRemoveConfirm") }), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
																className: "qdp-actions",
																children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(QdpButton, {
																	variant: "danger",
																	disabled: busy || accountBusy,
																	onClick: () => {
																		accountAction("remove-account", entry.id, name);
																	},
																	children: t("accountRemoveConfirmYes")
																}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)(QdpButton, {
																	disabled: accountBusy,
																	onClick: () => {
																		setConfirmingRemoveId(void 0);
																	},
																	children: t("cancel")
																})]
															})]
														}) : null
													]
												}, entry.id);
											})
										}),
										innerErrorsSummary === void 0 ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("p", {
											className: "qdp-caption",
											children: [
												t("innerErrorsHeading"),
												" · ",
												innerErrorsSummary
											]
										}),
										pool.lastFailoverAt === void 0 ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("p", {
											className: "qdp-caption",
											children: [t("accountsLastFailover", { time: formatTime(pool.lastFailoverAt) }), pool.lastFailoverReason === void 0 ? null : ` · ${t("accountsLastFailoverReason", { reason: pool.lastFailoverReason })}`]
										})
									]
								}),
								accountError === void 0 ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
									className: "qdp-alert qdp-alertError",
									role: "alert",
									children: accountError
								}),
								accountNotice === void 0 ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
									className: "qdp-body",
									children: accountNotice
								}),
								pool !== void 0 || signedInDoc?.pat === void 0 || replacing ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
									className: "qdp-row",
									children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
										className: "qdp-rowText",
										children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
											className: "qdp-rowTitle",
											children: t("patHeading")
										}), credentialMeta === void 0 ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
											className: "qdp-rowDesc",
											children: credentialMeta
										})]
									}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
										className: "qdp-rowControl",
										children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(QdpButton, {
											variant: "outline",
											size: "sm",
											disabled: busy || patBusy,
											onClick: () => {
												setReplacing(true);
											},
											children: t("patReplace")
										}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)(QdpButton, {
											variant: "dangerQuiet",
											size: "sm",
											disabled: busy || patBusy,
											onClick: () => {
												setConfirmingClear(true);
											},
											children: t("patRemove")
										})]
									})]
								}),
								confirmingClear && signedInDoc?.pat !== void 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
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
								signedOutStatus !== void 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
									className: signedOutStatus.reason === void 0 ? "qdp-body" : "qdp-error",
									children: signedOutStatus.reason ?? t(currentVariant.signedOutKey)
								}) : null,
								patEntryOpen && authKey !== void 0 ? patEntry() : null,
								signedInDoc !== void 0 && signedInDoc.jobTokenRefreshedAt !== void 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
									className: "qdp-caption",
									children: t("jobTokenRefreshed", { time: formatTime(signedInDoc.jobTokenRefreshedAt) })
								}) : null,
								readFailure === void 0 || status?.status === "error" ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
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
								status?.status === "error" ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
									className: "qdp-alert qdp-alertError",
									role: "alert",
									children: status.message
								}) : null
							]
						})]
					}),
					signedInDoc === void 0 ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("section", {
						className: "qdp-card",
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: "qdp-sectionHead",
							children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h2", {
									className: "qdp-sectionTitle",
									children: t("paneModels")
								}),
								catalogCaption === void 0 ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: "qdp-caption",
									children: catalogCaption
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)(QdpButton, {
									variant: "outline",
									size: "sm",
									disabled: busy,
									onClick: () => {
										refreshModels();
									},
									children: busy ? t("refreshingModels") : t("refreshModels")
								})
							]
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: "qdp-sectionBody",
							children: [signedInDoc.catalog?.error === void 0 ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
								className: "qdp-error",
								children: t("catalogError", { message: signedInDoc.catalog.error })
							}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)(ModelsPane, {
								models: signedInDoc.models,
								disabledModels: signedInDoc.disabledModels,
								catalog: signedInDoc.catalog,
								t,
								busy: busy === true,
								saving: savingModels,
								saveError: modelsSaveError,
								onSave: (draft) => {
									saveModelDraft(draft);
								},
								onRefreshModels: () => {
									refreshModels();
								}
							})]
						})]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("section", {
						className: "qdp-card",
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
							className: "qdp-sectionHead",
							children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("h2", {
								className: "qdp-sectionTitle",
								children: t("quotaSectionAdvanced")
							})
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: "qdp-sectionBody",
							children: [
								settings.status !== "loading" ? null : settings.writeError === "" ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
									className: "qdp-note",
									role: "status",
									"data-settings-state": "loading",
									children: t("settingsLoading")
								}) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
									className: "qdp-note qdp-noteDanger",
									role: "alert",
									"data-settings-state": "unreadable",
									children: t("settingsUnavailable", { message: settings.writeError })
								}),
								settings.status === "loading" || settings.writeError === "" ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
									className: "qdp-note qdp-noteDanger",
									role: "alert",
									"data-settings-state": "write-failed",
									children: t("settingsWriteFailed", { message: settings.writeError })
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
									className: "qdp-row",
									children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
										className: "qdp-rowText",
										children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
											className: "qdp-rowTitle",
											children: t("quotaReadoutEnabledLabel")
										}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
											className: "qdp-rowDesc",
											children: t("quotaReadoutEnabledDesc")
										})]
									}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
										className: "qdp-rowControl",
										children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(QdpSwitch, {
											checked: readoutEnabled,
											label: t("quotaReadoutEnabledLabel"),
											onChange: writeReadoutEnabled
										})
									})]
								}),
								settings.status === "unavailable" ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
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
										children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(QdpNumberField, {
											marker: "quota-poll-minutes",
											min: 1,
											max: POLL_MINUTES_MAX,
											value: pollMinutes,
											label: t("quotaPollLabel"),
											disabled: !settingsReady,
											onCommit: (minutes) => {
												writePollMinutes(minutes);
											}
										}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
											className: "qdp-caption",
											children: t("quotaPollUnit")
										})]
									})]
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
									className: "qdp-row",
									children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
										className: "qdp-rowText",
										children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
											className: "qdp-rowTitle",
											children: t("paneUsage")
										}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
											className: "qdp-rowDesc",
											children: settingsSignedIn ? settingsVariant === "cn" ? t("autoCheckInHintCN") : t("autoCheckInHintGlobal") : t("quotaSignInRequired")
										})]
									}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
										className: "qdp-rowControl",
										children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(QdpSwitch, {
											checked: autoCheckInOn,
											disabled: !settingsSignedIn,
											label: t("paneUsage"),
											onChange: writeAutoCheckIn
										})
									})]
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
									className: "qdp-row",
									children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
										className: "qdp-rowText",
										children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
											className: "qdp-rowTitle",
											children: t("checkInTime")
										}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
											className: "qdp-rowDesc",
											children: t("checkInTimeHint")
										})]
									}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
										className: "qdp-rowControl",
										children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(CheckInTimeRow, {
											label: t("checkInTime"),
											value: checkInMinute,
											disabled: !anySignedIn,
											onPick: writeCheckInMinute
										})
									})]
								}),
								settings.status === "unavailable" ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [
									/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
										className: "qdp-row",
										children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
											className: "qdp-rowText",
											children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
												className: "qdp-rowTitle",
												children: t("autoFailoverLabel")
											}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
												className: "qdp-rowDesc",
												children: t("autoFailoverHint")
											})]
										}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
											className: "qdp-rowControl",
											children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(QdpSwitch, {
												checked: settings.autoFailoverEnabled,
												label: t("autoFailoverLabel"),
												disabled: !settingsReady,
												onChange: (next) => {
													writeSetting("autoFailoverEnabled", next);
												}
											})
										})]
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
										className: "qdp-row",
										children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
											className: "qdp-rowText",
											children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
												className: "qdp-rowTitle",
												children: t("queueWaitAttemptsLabel")
											}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
												className: "qdp-rowDesc",
												children: t("queueWaitAttemptsHint")
											})]
										}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
											className: "qdp-rowControl",
											children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(QdpNumberField, {
												marker: "queue-wait-attempts",
												min: 0,
												max: QUEUE_WAIT_ATTEMPTS_MAX,
												value: settings.queueWaitAttempts,
												label: t("queueWaitAttemptsLabel"),
												disabled: !settingsReady,
												onCommit: (attempts) => {
													writeSetting("queueWaitAttempts", attempts);
												}
											})
										})]
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
										className: "qdp-row",
										children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
											className: "qdp-rowText",
											children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
												className: "qdp-rowTitle",
												children: t("queueWaitSecondsLabel")
											}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
												className: "qdp-rowDesc",
												children: t("queueWaitSecondsHint")
											})]
										}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
											className: "qdp-rowControl",
											children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(QdpNumberField, {
												marker: "queue-wait-seconds",
												min: QUEUE_WAIT_SECONDS_MIN,
												max: QUEUE_WAIT_SECONDS_MAX,
												value: settings.queueWaitSeconds,
												label: t("queueWaitSecondsLabel"),
												disabled: !settingsReady,
												onCommit: (seconds) => {
													writeSetting("queueWaitSeconds", seconds);
												}
											}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
												className: "qdp-caption",
												children: t("queueWaitSecondsUnit")
											})]
										})]
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
										className: "qdp-row",
										children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
											className: "qdp-rowText",
											children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
												className: "qdp-rowTitle",
												children: t("routingStrategyLabel")
											}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
												className: "qdp-rowDesc",
												children: t("routingStrategyHint")
											})]
										}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
											className: "qdp-rowControl",
											children: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("select", {
												className: "qdp-select",
												value: routingStrategy,
												disabled: !routingWritable || !settingsReady,
												"aria-label": t("routingStrategyLabel"),
												onChange: (event) => {
													chooseRoutingStrategy(event.target.value === "custom" ? "custom" : "save-order");
												},
												children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
													value: "save-order",
													children: t("routingStrategySaveOrder")
												}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
													value: "custom",
													children: t("routingStrategyCustom")
												})]
											})
										})]
									}),
									routingStrategy !== "custom" ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
										className: "qdp-row qdp-rowStack",
										children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
											className: "qdp-rowText",
											children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
												className: "qdp-rowTitle",
												children: t("routingOrderHeading")
											}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
												className: "qdp-rowDesc",
												children: t("routingOrderHint")
											})]
										}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)(RoutingOrderList, {
											ids: routingOrderIds,
											nameOf: routingNameOf,
											variantOf: routingVariantOf,
											accountOf: (id) => routing.accounts.find((entry) => entry.id === id),
											disabled: !routingWritable || !settingsReady,
											t,
											onMove: moveRoutingAccount
										})]
									}),
									routingMixed ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)(MixedRoutingWarning, {
										offendersCN: routingOffenders.cn,
										offendersGlobal: routingOffenders.global,
										t
									}) : null,
									/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
										className: "qdp-row",
										children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
											className: "qdp-rowText",
											children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
												className: "qdp-rowTitle",
												children: t("stickinessLabel")
											}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
												className: "qdp-rowDesc",
												children: t("stickinessToggleHint")
											})]
										}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
											className: "qdp-rowControl",
											children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(QdpSwitch, {
												checked: settings.stickinessEnabled,
												label: t("stickinessLabel"),
												disabled: !settingsReady,
												onChange: (next) => {
													writeSetting("stickinessEnabled", next);
												}
											})
										})]
									}),
									settings.stickinessEnabled ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
										className: "qdp-row",
										children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
											className: "qdp-rowText",
											children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
												className: "qdp-rowTitle",
												children: t("stickinessLabel")
											}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
												className: "qdp-rowDesc",
												children: t("stickinessHint")
											})]
										}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
											className: "qdp-rowControl",
											children: [
												/* @__PURE__ */ (0, react_jsx_runtime.jsx)(QdpNumberField, {
													marker: "stickiness-rounds",
													min: 0,
													max: STICKINESS_ROUNDS_MAX,
													value: settings.stickinessRounds,
													label: t("stickinessRoundsLabel"),
													disabled: !settingsReady,
													onCommit: (rounds) => {
														writeSetting("stickinessRounds", rounds);
													}
												}),
												/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
													className: "qdp-caption",
													children: t("stickinessRoundsLabel")
												}),
												/* @__PURE__ */ (0, react_jsx_runtime.jsx)(QdpNumberField, {
													marker: "stickiness-requests",
													min: 0,
													max: STICKINESS_REQUESTS_MAX,
													value: settings.stickinessRequests,
													label: t("stickinessRequestsLabel"),
													disabled: !settingsReady,
													onCommit: (requests) => {
														writeSetting("stickinessRequests", requests);
													}
												}),
												/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
													className: "qdp-caption",
													children: t("stickinessRequestsLabel")
												}),
												/* @__PURE__ */ (0, react_jsx_runtime.jsx)(QdpNumberField, {
													marker: "stickiness-minutes",
													min: 0,
													max: STICKINESS_MINUTES_MAX,
													value: settings.stickinessMinutes,
													label: t("stickinessMinutesLabel"),
													disabled: !settingsReady,
													onCommit: (minutes) => {
														writeSetting("stickinessMinutes", minutes);
													}
												}),
												/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
													className: "qdp-caption",
													children: t("stickinessMinutesLabel")
												})
											]
										})]
									}) : null
								] }),
								settings.status === "ready" && !settings.writable ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
									className: "qdp-error",
									children: t("quotaSettingsSaveFailed")
								}) : null
							]
						})]
					})
				]
			});
		}
		//#endregion
		//#region src/client/ComposerQuota.tsx
		/**
		* Composer quota readout: a chip in the Composer toolbar that expands into an
		* anchored panel for the session model's Qoder variant.
		*
		* This replaces the old sidebar quota cards and the center-column dashboard.
		* The user's instruction was "取消原本的额度显示方式，改为「输入框内显示额度读数 +
		* 点击展开小面板」(m01150)": the seat must not occupy toolbar space for readers
		* who keep another provider selected, so the chip resolves the session's model
		* directory itself and renders nothing unless the current provider is one of
		* this plugin's (`qoder` / `qoder-global`). A later round added the switches —
		* "输入框中显示额度应该加入开关" — and made the panel speak about ONE product only
		* (m01963): the panel lists just the variant the session model is drawn from,
		* and the chip disappears when that variant's readout switch is off. The latest
		* round made the readout multi-account (m01197): 对话框的积分显示界面 must show
		* every saved account's credits and let the user click a username to switch.
		*
		* Shape:
		*
		* - the chip is a one-line readout — variant short name + remaining credit —
		*   modeled on the WorkBuddy credit chip the user pointed at;
		* - the panel is anchored to the chip with `position: fixed`, opening upward
		*   when there is room (the composer sits at the bottom of the window) and
		*   flipping/clamping when there is not;
		* - the panel has one row for the active variant: name, plan tag,
		*   `remaining / total`, a thin bar and the percent + expiry caption;
		* - when the host reports an account pool (`status.accounts.entries`), those
		*   rows become per-account instead: the username IS the switch control, the
		*   active seat carries the in-use marker, and every row shows its OWN plan and
		*   credits — a spare account is priced before the user moves to it. The chip
		*   headline still speaks only for the ACTIVE account (a spare's figures must
		*   never leak upward), a row whose billing read failed keeps its name and its
		*   switch and says "unavailable" rather than borrowing a neighbour's number,
		*   and an env-only credential (no pool at all) renders the single row it
		*   always did;
		* - documents are shared, not owned: successful reads publish through
		*   `noteQuotaStatus` (the same store the settings surfaces read), failed reads
		*   keep the last good document and surface a one-line error instead of
		*   blanking the figures;
		* - the remaining figure is the summed per-package remainder, and "Unlimited"
		*   is reserved for documents with no countable size at all: the upstream
		*   marks accounts `unlimited: true` even when gift packages carry real
		*   figures (live CN document: `{unlimited:true, accounts:[{remain:1933,size:2400},
		*   {remain:0,size:0}]}`), which used to make the chip read 不限量 on an account
		*   with 1,933 credits left (m01963 item 5).
		*
		* Styling lives entirely in quota-styles.ts (`qdp-chip`, `qdp-pop*`); the only
		* inline sizes are the bar's `width` percent and the panel's fixed `left`/`top`,
		* which are geometry, not appearance.
		*
		* @module dsh-qoder-plugin/client/composer-quota
		*/
		/** Panel width, mirrored by `.qdp-pop` in quota-styles.ts. */
		const PANEL_WIDTH = 300;
		/** Breathing room between the chip and its panel. */
		const ANCHOR_GAP = 8;
		/** The panel never comes closer than this to a viewport edge. */
		const VIEWPORT_MARGIN = 12;
		/** The shared poll interval can never be shorter than one minute. */
		const MIN_POLL_MS = 6e4;
		/** Below this share of the granted total the bar turns warn-coloured. */
		const WARN_PERCENT = 20;
		/** Group digits in the browser's locale (same formatting the old card used). */
		function formatNumber(value) {
			return new Intl.NumberFormat(void 0).format(value);
		}
		/** Percent with at most one fraction digit. */
		function formatPercent(percent) {
			return new Intl.NumberFormat(void 0, { maximumFractionDigits: 1 }).format(percent);
		}
		/** Wall-clock `HH:mm`, matching the old card's "updated" caption. */
		function timeText(ms) {
			return new Date(ms).toLocaleTimeString(void 0, {
				hour: "2-digit",
				minute: "2-digit"
			});
		}
		/**
		* Expiry text: a locale date when the upstream string parses, otherwise the
		* string verbatim. The upstream reports ISO strings and numeric epochs that the
		* host normalizes; an unrecognized shape is displayed as-is rather than guessed
		* into a date.
		*/
		function expiryText(value) {
			const parsed = Date.parse(value);
			if (Number.isNaN(parsed)) return value;
			return new Date(parsed).toLocaleDateString(void 0, {
				year: "numeric",
				month: "2-digit",
				day: "2-digit"
			});
		}
		/**
		* The chip's short product name.
		*
		* The variant table in QoderPluginCard.tsx carries `titleKey` (full card title)
		* but no `nameKey`; the composer chip needs the one-word label, which is what
		* the composer-specific `quotaChip*` copy keys are for.
		*/
		function chipNameKey(card) {
			return card.id === "qoder-global" ? "quotaChipGlobal" : "quotaChipCN";
		}
		/**
		* The credit document the chip headline must speak for.
		*
		* The chip belongs to the account that pays for the session's requests, so when
		* the host reports a pool the ACTIVE entry's own price is the headline figure.
		* A spare account's numbers belong to its panel row and must never leak upward
		* (m01197). Documents without a pool — the env-only credential — keep the
		* document-level `credits` they always used.
		*/
		function activeCredits(status) {
			if (status === void 0 || status.status !== "signed-in") return void 0;
			return (status.accounts?.entries.find((entry) => entry.active))?.credits ?? status.credits;
		}
		/**
		* The chip's remaining-credit readout: a number, "Unlimited", or an em dash.
		*
		* The em dash is the not-ready state (no document yet, signed out, or an
		* upstream error document) rather than "0", which would claim an empty account.
		*/
		function chipReadout(status, t) {
			const credits = activeCredits(status);
			if (credits === void 0) return "—";
			const summary = creditSummary(credits);
			return summary.unlimited ? t("quotaUnlimited") : formatNumber(summary.remain);
		}
		/**
		* Project one plan + credits pair into a row's figures.
		*
		* Shared by the single-account row (the document's `plan`/`credits`) and the
		* per-account rows (each entry's own pair), so the account that pays cannot be
		* priced differently in the two layouts. `undefined` means "no figures to draw"
		* (the upstream error arm, or a pool row whose billing read failed) — the row
		* renders an unavailable state instead of inventing zeroes. The credit figures
		* follow {@link creditSummary}; the denominator is the summed package size (the
		* reported total only when the packages carry no size at all).
		*/
		function figuresFrom(plan, credits) {
			if (credits === void 0) return void 0;
			const summary = creditSummary(credits);
			return {
				planName: plan?.planTierName,
				unlimited: summary.unlimited,
				remain: summary.remain,
				total: summary.total,
				percent: summary.unlimited ? void 0 : clampPercent(summary.remain, summary.total),
				expiry: credits.cycleResetTime ?? plan?.endDate
			};
		}
		/** The active variant's figures, from the document-level plan and credits. */
		function variantFigures(status) {
			if (status === void 0 || status.status !== "signed-in") return void 0;
			return figuresFrom(status.plan, status.credits);
		}
		/** The row-head value copy: unlimited, `remain / size`, or "remain only". */
		function valueText(figures, t) {
			if (figures.unlimited) return t("quotaUnlimited");
			if (figures.total > 0) return t("exactRemaining", {
				remain: formatNumber(figures.remain),
				size: formatNumber(figures.total)
			});
			return t("creditPackageUnknownSize", { remain: formatNumber(figures.remain) });
		}
		/** The row caption: percent remaining and when the quota lapses. */
		function captionText(figures, t) {
			const parts = [];
			if (figures.percent !== void 0) parts.push(t("percentRemaining", { percent: formatPercent(figures.percent) }));
			parts.push(figures.expiry !== void 0 ? `${t("quotaExpires")} ${expiryText(figures.expiry)}` : t("quotaNoExpiry"));
			return parts.join(" · ");
		}
		/**
		* Whether `target` is inside `container`.
		*
		* The container refs are null while the panel is closed and in DOM-less test
		* environments; the Node guard keeps that case from touching an undefined
		* `Node` global.
		*/
		function containsTarget(container, target) {
			if (container === null || target === null) return false;
			return typeof Node !== "undefined" && target instanceof Node && container.contains(target);
		}
		/**
		* The thin remaining-credit bar plus its percent/expiry caption.
		*
		* Shared by the single-account row and the per-account rows so both draw the
		* same bar geometry (the only inline size is the bar's percent `width`, which
		* is geometry, not appearance).
		*/
		function CreditBar({ figures, t }) {
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
				className: "qdp-popBar",
				children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
					className: cx("qdp-popBarFill", figures.percent !== void 0 && figures.percent < WARN_PERCENT && "qdp-popWarn"),
					style: { width: `${figures.percent === void 0 ? 100 : Math.max(2, figures.percent)}%` }
				})
			}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
				className: "qdp-popCaption",
				children: captionText(figures, t)
			})] });
		}
		/** The active variant's panel row. */
		function VariantRow({ card, status, failed, t }) {
			const figures = variantFigures(status);
			const failedDocument = status?.status === "error";
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: "qdp-popVariant",
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					className: "qdp-popVariantHead",
					children: [
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							className: "qdp-popName",
							children: t(chipNameKey(card))
						}),
						figures?.planName !== void 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)(QdpTag, { children: figures.planName }) : null,
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							className: "qdp-popValue",
							children: figures === void 0 ? "—" : valueText(figures, t)
						})
					]
				}), figures === void 0 ? failed || failedDocument || status !== void 0 && status.status === "signed-in" ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
					className: "qdp-alert qdp-alertError",
					children: t("quotaError")
				}) : status === void 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
					className: "qdp-empty",
					children: t("quotaPanelEmpty")
				}) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
					className: "qdp-caption",
					children: t("quotaNotSignedIn")
				}) : /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(CreditBar, {
					figures,
					t
				}), failed || failedDocument ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
					className: "qdp-alert qdp-alertError",
					children: t("quotaError")
				}) : null] })]
			});
		}
		/**
		* The name one pooled account is listed under.
		*
		* The subscriber name is the real answer; the token tail is the honest fallback
		* (two tokens saved for the same person are told apart by nothing else), and the
		* failover slot is the last resort — the same order the settings card's pool
		* list uses, so one account reads the same in both surfaces.
		*/
		function accountDisplayName(entry, t) {
			return entry.accountName ?? entry.patTail ?? t("accountSlot", { order: entry.order });
		}
		/**
		* One pooled account's row in the panel.
		*
		* The USERNAME is the switch control (m01197: 「点击用户名切换账号」): the active
		* seat's name is inert text carrying the in-use marker, every other name is a
		* button that activates that account. A row whose billing read failed keeps its
		* name and its switch — an account the user may need to move to is exactly the
		* one a failed price must not hide — and states the figure as unavailable
		* rather than borrowing a neighbour's number.
		*/
		function AccountRow({ entry, busy, canSwitch, onActivate, t }) {
			const name = accountDisplayName(entry, t);
			const parked = entry.enabled === false;
			const figures = parked ? void 0 : figuresFrom(entry.plan, entry.credits);
			const switchable = !entry.active && canSwitch;
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("li", {
				className: cx("qdp-popAccount", entry.active && "qdp-popAccountActive", parked && "qdp-popAccountParked"),
				"data-account-id": entry.id,
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					className: "qdp-popAccountHead",
					children: [
						switchable ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
							type: "button",
							className: "qdp-popAccountName qdp-popAccountSwitch",
							"aria-label": t("accountSwitchAria", { name }),
							disabled: busy,
							onClick: () => {
								onActivate(entry.id, name);
							},
							children: name
						}) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							className: "qdp-popAccountName",
							children: name
						}),
						entry.active ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)(QdpTag, {
							tone: "success",
							children: t("accountCurrent")
						}) : null,
						parked ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)(QdpTag, {
							tone: "neutral",
							children: t("accountParked")
						}) : null,
						figures?.planName === void 0 ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsx)(QdpTag, { children: figures.planName }),
						parked ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							className: "qdp-popAccountHealth",
							title: t("accountHealthAria"),
							children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(QdpTag, {
								tone: entry.health === void 0 ? "neutral" : entry.health === "normal" ? "success" : "warn",
								children: accountHealthLabel(entry.health, t)
							})
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							className: "qdp-popValue",
							children: parked ? t("accountCreditsParked") : figures === void 0 ? "—" : valueText(figures, t)
						})
					]
				}), parked ? null : figures === void 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
					className: "qdp-popAccountUnavailable",
					children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(QdpTag, {
						tone: "error",
						children: t("quotaError")
					})
				}) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)(CreditBar, {
					figures,
					t
				})]
			});
		}
		/**
		* The pooled-account section of the panel.
		*
		* It replaces the single-variant row rather than sitting under it: with a pool
		* the per-account rows carry the same plan/credit/bar facts, and rendering both
		* would show the active account's numbers twice.
		*/
		function AccountPool({ entries, busy, canSwitch, onActivate, t }) {
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: "qdp-popAccounts",
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "qdp-popAccountsHead",
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							className: "qdp-popAccountsTitle",
							children: t("accountsHeading")
						}), canSwitch ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							className: "qdp-popAccountsSwitchHint",
							children: t("accountsSwitchHint")
						}) : null]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						className: "qdp-popAccountsHint",
						children: t("accountsHint")
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("ul", {
						className: "qdp-popAccountList",
						children: entries.map((entry) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)(AccountRow, {
							entry,
							busy,
							canSwitch,
							onActivate,
							t
						}, entry.id))
					})
				]
			});
		}
		/**
		* Model-independent shell: resolves the selection and the readout switches,
		* then renders the chip.
		*
		* Returning `null` for every other provider is what keeps the composer seat
		* free for readers who do not use Qoder; the guard runs after all hooks so hook
		* order cannot change with the selection or the settings.
		*/
		function ComposerQuotaChip({ directory, t }) {
			const subscribe = (0, react.useCallback)((listener) => directory.subscribe(listener), [directory]);
			const snapshot = (0, react.useCallback)(() => directory.getSnapshot(), [directory]);
			const selection = (0, react.useSyncExternalStore)(subscribe, snapshot, snapshot).current;
			(0, react.useSyncExternalStore)(onQuotaSettingsChange, quotaSettingsRevision, quotaSettingsRevision);
			const readout = quotaReadout();
			const card = selection == null ? void 0 : QODER_CARD_VARIANTS.find((variant) => variant.id === selection.provider);
			if (card === void 0) return null;
			return readout.enabled ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)(ComposerQuota, {
				card,
				t
			}) : null;
		}
		/**
		* The readout itself, mounted only while a Qoder provider is selected and its
		* readout switch is on.
		*
		* @param card - the variant whose status route the chip reads.
		* @param t - translator bound to the shared settings namespace.
		*/
		function ComposerQuota({ card, t }) {
			const [open, setOpen] = (0, react.useState)(false);
			const [refreshing, setRefreshing] = (0, react.useState)(false);
			/** Whether the most recent read for this variant failed; cleared by success. */
			const [failed, setFailed] = (0, react.useState)(false);
			/** A pooled-account switch in flight; every switch control disables meanwhile. */
			const [accountBusy, setAccountBusy] = (0, react.useState)(false);
			/** The last switch's verdict: the failure line, or the confirmation line. */
			const [accountError, setAccountError] = (0, react.useState)(void 0);
			const [accountNotice, setAccountNotice] = (0, react.useState)(void 0);
			/** Fixed-panel geometry, measured from the chip; `null` until first measured. */
			const [position, setPosition] = (0, react.useState)(null);
			const triggerRef = (0, react.useRef)(null);
			const panelRef = (0, react.useRef)(null);
			const mounted = (0, react.useRef)(true);
			/** Guards a slow read and a refresh from double-fetching the same route. */
			const inFlight = (0, react.useRef)(false);
			(0, react.useEffect)(() => {
				mounted.current = true;
				return () => {
					mounted.current = false;
				};
			}, []);
			(0, react.useSyncExternalStore)(onQuotaSettingsChange, quotaSettingsRevision, quotaSettingsRevision);
			const pollMs = (0, react.useSyncExternalStore)(onQuotaSettingsChange, quotaPollMs, quotaPollMs);
			const currentStatus = quotaStatus(card.id);
			const authKey = currentStatus === void 0 || currentStatus.status === "error" ? void 0 : currentStatus.authKey;
			/**
			* Read the active variant's status route.
			*
			* `force` bypasses the freshness cache (refresh button, interval ticks);
			* otherwise a document younger than the configured poll interval is reused,
			* so opening the panel right after a mount does not re-hit the billing route.
			* Failures keep the previous document and only add the error line.
			*/
			const fetchStatus = (0, react.useCallback)(async (force) => {
				if (!force && quotaStatusIsFresh(card.id, quotaPollMs())) return;
				if (inFlight.current) return;
				inFlight.current = true;
				try {
					const response = await fetch(card.statusPath, { headers: { accept: "application/json" } });
					const body = await response.json().catch(() => void 0);
					if (!mounted.current) return;
					if (!response.ok || !isQoderWebStatus(body)) {
						setFailed(true);
						return;
					}
					noteQuotaStatus(card.id, body);
					setFailed(false);
				} catch {
					if (mounted.current) setFailed(true);
				} finally {
					inFlight.current = false;
				}
			}, [card]);
			(0, react.useEffect)(() => {
				fetchStatus(false);
				const timer = setInterval(() => {
					if (typeof document !== "undefined" && document.hidden) return;
					fetchStatus(true);
				}, Math.max(MIN_POLL_MS, pollMs));
				const onVisibilityChange = () => {
					if (typeof document !== "undefined" && !document.hidden) fetchStatus(false);
				};
				if (typeof document !== "undefined") document.addEventListener("visibilitychange", onVisibilityChange);
				return () => {
					clearInterval(timer);
					if (typeof document !== "undefined") document.removeEventListener("visibilitychange", onVisibilityChange);
				};
			}, [
				card,
				fetchStatus,
				pollMs
			]);
			(0, react.useEffect)(() => {
				if (!open) return;
				fetchStatus(false);
			}, [open, fetchStatus]);
			const close = (0, react.useCallback)(() => {
				setOpen(false);
				triggerRef.current?.focus();
			}, []);
			const toggle = (0, react.useCallback)(() => {
				if (open) close();
				else setOpen(true);
			}, [close, open]);
			(0, react.useEffect)(() => {
				if (!open || typeof document === "undefined") return;
				const onPointerDown = (event) => {
					if (containsTarget(panelRef.current, event.target) || containsTarget(triggerRef.current, event.target)) return;
					close();
					if (typeof window !== "undefined") window.setTimeout(() => {
						triggerRef.current?.focus();
					}, 0);
				};
				document.addEventListener("pointerdown", onPointerDown, true);
				return () => document.removeEventListener("pointerdown", onPointerDown, true);
			}, [open, close]);
			const onPanelKeyDown = (event) => {
				if (event.key !== "Escape") return;
				event.preventDefault();
				event.stopPropagation();
				close();
			};
			/**
			* Anchor the panel to the chip.
			*
			* The composer sits at the bottom of the window, so "above" is the default.
			* If the panel does not fit above it flips below; if it fits in neither place
			* it is clamped to the viewport. Left is clamped the same way (the chip can be
			* close to either edge). Measured on mount, on scroll/resize, and after every
			* render so a growing panel keeps its anchor.
			*/
			const measure = (0, react.useCallback)(() => {
				const trigger = triggerRef.current;
				if (trigger === null || typeof window === "undefined") return;
				const triggerRect = trigger.getBoundingClientRect();
				const panel = panelRef.current;
				const panelHeight = panel === null ? 0 : panel.getBoundingClientRect().height;
				const viewportWidth = window.innerWidth;
				const viewportHeight = window.innerHeight;
				const width = Math.min(PANEL_WIDTH, viewportWidth - 24);
				const left = Math.max(VIEWPORT_MARGIN, Math.min(triggerRect.left, viewportWidth - VIEWPORT_MARGIN - width));
				const preferredTop = triggerRect.top - ANCHOR_GAP - panelHeight;
				const belowTop = triggerRect.bottom + ANCHOR_GAP;
				const top = preferredTop >= VIEWPORT_MARGIN ? preferredTop : belowTop + panelHeight <= viewportHeight - VIEWPORT_MARGIN ? belowTop : Math.max(VIEWPORT_MARGIN, viewportHeight - VIEWPORT_MARGIN - panelHeight);
				setPosition((previous) => previous !== null && Math.abs(previous.left - left) < .5 && Math.abs(previous.top - top) < .5 ? previous : {
					left,
					top
				});
			}, []);
			(0, react.useLayoutEffect)(() => {
				if (open) measure();
			});
			(0, react.useLayoutEffect)(() => {
				if (open) panelRef.current?.focus();
			}, [open]);
			(0, react.useEffect)(() => {
				if (!open || typeof window === "undefined") return;
				const onViewportChange = () => measure();
				window.addEventListener("scroll", onViewportChange, true);
				window.addEventListener("resize", onViewportChange);
				return () => {
					window.removeEventListener("scroll", onViewportChange, true);
					window.removeEventListener("resize", onViewportChange);
				};
			}, [open, measure]);
			/** Force-read the active variant (the panel's refresh action). */
			const refresh = (0, react.useCallback)(async () => {
				if (refreshing) return;
				setRefreshing(true);
				try {
					await fetchStatus(true);
				} finally {
					if (mounted.current) setRefreshing(false);
				}
			}, [fetchStatus, refreshing]);
			/**
			* Move the sign-in to another pooled account.
			*
			* The request mirrors the settings card's `accountAction` field for field —
			* same route, same capitalized `X-Qoder-Auth-Key`, same same-origin
			* credentials — because the host treats both surfaces as one caller and the
			* key is the only proof the write is ours. The body names the account by its
			* id (the credential's one-way hash), never the token.
			*
			* The re-read is what moves the in-use marker and the chip headline: the route
			* answers `{ok}` only, so the new active seat is a fact of the status
			* document, not of the response. A refusal is re-read too — an unknown id
			* means another surface changed the pool under this panel.
			*/
			const activateAccount = (0, react.useCallback)(async (accountId, name) => {
				const key = authKey;
				if (key === void 0 || accountBusy) return;
				setAccountBusy(true);
				setAccountError(void 0);
				setAccountNotice(void 0);
				try {
					const body = {
						action: "activate-account",
						accountId
					};
					const response = await fetch(card.authPath, {
						method: "POST",
						headers: {
							"Content-Type": "application/json",
							"X-Qoder-Auth-Key": key
						},
						credentials: "same-origin",
						body: JSON.stringify(body)
					});
					const value = await response.json().catch(() => void 0);
					if (!mounted.current) return;
					const record = typeof value === "object" && value !== null ? value : {};
					if (!response.ok || record["ok"] !== true) {
						const detail = typeof record["error"] === "string" ? record["error"] : `HTTP ${response.status}`;
						setAccountError(t("accountActionFailed", { message: detail }));
					} else setAccountNotice(t("accountSwitched", { name }));
					await fetchStatus(true);
				} catch (error) {
					if (mounted.current) setAccountError(t("accountActionFailed", { message: error instanceof Error ? error.message : t("requestFailed") }));
				} finally {
					if (mounted.current) setAccountBusy(false);
				}
			}, [
				accountBusy,
				authKey,
				card.authPath,
				fetchStatus,
				t
			]);
			const name = t(chipNameKey(card));
			const readout = chipReadout(currentStatus, t);
			const fetchedAt = quotaStatusFetchedAt(card.id);
			const poolEntries = currentStatus?.status === "signed-in" ? currentStatus.accounts?.entries ?? [] : [];
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("button", {
				ref: triggerRef,
				type: "button",
				className: "qdp-chip",
				"aria-haspopup": "dialog",
				"aria-expanded": open,
				"aria-label": `${t("quotaChipAria")}: ${name} · ${readout}`,
				onClick: toggle,
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						className: "qdp-chipName",
						children: name
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						"aria-hidden": "true",
						children: "·"
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						className: "qdp-chipValue",
						children: readout
					})
				]
			}), open ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				ref: panelRef,
				role: "dialog",
				"aria-label": t("quotaDashboardTitle"),
				tabIndex: -1,
				className: "qdp-pop",
				style: position === null ? void 0 : {
					left: position.left,
					top: position.top
				},
				onKeyDown: onPanelKeyDown,
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "qdp-popHead",
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: "qdp-popTitle",
								children: t("quotaDashboardTitle")
							}),
							fetchedAt !== void 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: "qdp-popTime",
								children: `${t("quotaUpdated")} ${timeText(fetchedAt)}`
							}) : null,
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)(QdpIconButton, {
								className: "qdp-popRefresh",
								label: refreshing ? t("quotaRefreshing") : t("quotaRefresh"),
								disabled: refreshing,
								onClick: () => {
									refresh();
								},
								children: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("svg", {
									width: "16",
									height: "16",
									viewBox: "0 0 24 24",
									fill: "none",
									stroke: "currentColor",
									strokeWidth: "1.6",
									"aria-hidden": "true",
									focusable: "false",
									children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("path", { d: "M20 11a8 8 0 1 0-2.35 5.66" }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("path", { d: "M20 4v7h-7" })]
								})
							})
						]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "qdp-popList",
						children: [
							poolEntries.length > 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(AccountPool, {
								entries: poolEntries,
								busy: accountBusy,
								canSwitch: authKey !== void 0,
								onActivate: (accountId, accountName) => {
									activateAccount(accountId, accountName);
								},
								t
							}), failed ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
								className: "qdp-alert qdp-alertError",
								children: t("quotaError")
							}) : null] }) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)(VariantRow, {
								card,
								status: currentStatus,
								failed,
								t
							}),
							accountError !== void 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
								className: "qdp-alert qdp-alertError",
								role: "alert",
								children: accountError
							}) : null,
							accountNotice !== void 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
								className: "qdp-caption",
								role: "status",
								children: accountNotice
							}) : null
						]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						className: "qdp-popFoot",
						children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: t("quotaPanelAutoRefresh", { minutes: String(Math.round(Math.max(MIN_POLL_MS, quotaPollMs()) / 6e4)) }) })
					})
				]
			}) : null] });
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
		* @module dsh-qoder-plugin/client/probe-control
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
		//#region src/client/QoderQueueNoticeRow.tsx
		function QoderQueueNoticeRow({ node }) {
			const text = node.outcome?.text ?? "";
			if (text === "") return null;
			const tone = node.outcome?.kind === "error" ? " qdp-noticeRowError" : "";
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: `qdp-noticeRow${tone}`,
				"data-notice-command": node.name ?? "qoder",
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						className: "qdp-noticeRowName",
						children: node.name ?? "qoder"
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						className: "qdp-noticeRowDot",
						children: "·"
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						className: "qdp-noticeRowText",
						children: text
					})
				]
			});
		}
		//#endregion
		//#region src/client/http-settings-scope.ts
		/** Base path of the host half's settings face. */
		const ROUTE_BASE = "/plugins/dsh-qoder-plugin";
		/**
		* How many times the initial read is attempted before the face is given up on.
		*
		* The read races the host plugin's own mount: on a fresh page the browser half
		* may activate while the host route is still being registered, and a host
		* reload disposes the old route before the new one answers. A single failed
		* read used to leave the card on its schema defaults forever — every control
		* enabled and inert — so the read retries instead of trusting one attempt.
		*/
		const LOAD_ATTEMPTS = 3;
		/** Delay before each retry of the initial read, in milliseconds. */
		const LOAD_RETRY_DELAY_MS = [400, 1200];
		/**
		* A refused settings-face request, carrying the HTTP status so the caller can
		* tell a rotated write key (recoverable: re-read and retry) from a refused
		* value (not recoverable: report it).
		*/
		var SettingsFaceError = class extends Error {
			status;
			constructor(message, status) {
				super(message);
				this.name = "SettingsFaceError";
				this.status = status;
			}
		};
		/**
		* Fetch one settings face document.
		* @param init - the request init (method, headers, body).
		* @returns the parsed document.
		* @throws {SettingsFaceError} when the transport or the host refuses the request.
		*/
		async function request(init) {
			const response = await fetch(`${ROUTE_BASE}/settings`, {
				credentials: "same-origin",
				...init
			});
			const value = await response.json().catch(() => void 0);
			if (!response.ok) throw new SettingsFaceError(typeof value === "object" && value !== null && "error" in value ? String(value["error"]) : `HTTP ${response.status}`, response.status);
			if (typeof value !== "object" || value === null || !("value" in value)) throw new SettingsFaceError("qoder: settings face answered an invalid document", response.status);
			return value;
		}
		/**
		* @param error - whatever a face request threw.
		* @returns whether the refusal means the write key went stale, not that the value was bad.
		*/
		function isStaleKeyRefusal(error) {
			return error instanceof SettingsFaceError && (error.status === 401 || error.status === 403 || error.status === 404 || error.status === 405);
		}
		/**
		* @param error - whatever a face request threw.
		* @returns a short message the card can show the user.
		*/
		function describeFailure(error) {
			if (error instanceof SettingsFaceError) return error.message;
			if (error instanceof Error && error.message !== "") return error.message;
			return "the settings service did not answer";
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
			/** The last refusal, as a message for the card; absent once a write lands. */
			error;
			/** The last refusal, kept for the retry decision and the error report. */
			lastFailure;
			/** Whether the last refusal was a stale write key (recoverable by re-reading). */
			lastFailureIsStaleKey = false;
			/** The read in flight, so a second caller joins it instead of racing it. */
			pending;
			/**
			* Load the current document, retrying a read that raced the host's mount.
			*
			* Repeated calls are harmless and re-read the host.
			* @returns the effective values, or undefined when every attempt failed.
			*/
			async load() {
				this.error = void 0;
				const run = this.readWithRetries();
				this.pending = run;
				try {
					return await run;
				} finally {
					if (this.pending === run) this.pending = void 0;
				}
			}
			/**
			* Load the document unless it is already loaded or being loaded.
			*
			* The card calls this on mount: the browser half can activate before the host
			* route exists, and a face that never answered must be retried rather than
			* left disabled for the lifetime of the page.
			*/
			ensureLoaded() {
				if (this.document !== void 0 || this.pending !== void 0) return;
				this.load();
			}
			/** @returns the effective values, or undefined when every attempt failed. */
			async readWithRetries() {
				for (let attempt = 0; attempt < LOAD_ATTEMPTS; attempt += 1) {
					if (attempt > 0) await delay(LOAD_RETRY_DELAY_MS[attempt - 1] ?? 1200);
					try {
						this.document = await request({ headers: { accept: "application/json" } });
						this.publish();
						return this.document.value;
					} catch (error) {
						this.lastFailure = describeFailure(error);
					}
				}
				this.error = this.lastFailure ?? "the settings service did not answer";
				this.publish();
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
			/**
			* Send one patch and adopt the host's answer.
			*
			* A refusal that means the write key went stale (the host plugin was
			* reloaded, which re-mints the key and re-registers the route) is healed by
			* re-reading the document and retrying once: without that, every control
			* stayed inert until the page itself was reloaded.
			*/
			async patch(patch) {
				const sent = await this.send(patch);
				if (sent !== void 0) return this.adopt(sent);
				if (this.lastFailureIsStaleKey) {
					if (await this.tryRead() !== void 0) {
						const retried = await this.send(patch);
						if (retried !== void 0) return this.adopt(retried);
					}
				}
				this.error = this.lastFailure ?? "the settings service refused the change";
				this.publish();
				return false;
			}
			/** @returns the accepted document, or undefined (recording the failure). */
			async send(patch) {
				const key = this.document?.key;
				if (key === void 0) {
					this.lastFailure = "the settings service has not loaded yet";
					this.lastFailureIsStaleKey = false;
					return;
				}
				try {
					return await request({
						method: "POST",
						headers: {
							"Content-Type": "application/json",
							"X-Qoder-Settings-Key": key
						},
						body: JSON.stringify(patch)
					});
				} catch (error) {
					this.lastFailure = describeFailure(error);
					this.lastFailureIsStaleKey = isStaleKeyRefusal(error);
					return;
				}
			}
			/** @returns one accepted read, or undefined (recording the failure). */
			async tryRead() {
				try {
					const document = await request({ headers: { accept: "application/json" } });
					this.document = document;
					return document;
				} catch (error) {
					this.lastFailure = describeFailure(error);
					return;
				}
			}
			/** Adopt an accepted document and clear the error. */
			adopt(document) {
				this.document = document;
				this.error = void 0;
				this.lastFailure = void 0;
				this.lastFailureIsStaleKey = false;
				this.publish();
				return true;
			}
			/** Rebuild the cached snapshot and notify the subscribers. */
			publish() {
				this.snapshot = {
					status: this.document === void 0 ? "loading" : "ready",
					value: this.document?.value,
					writable: true,
					...this.error === void 0 ? {} : { error: this.error }
				};
				for (const listener of this.listeners) listener();
			}
		};
		/**
		* @param milliseconds - how long to wait.
		* @returns a promise settled after the delay.
		*/
		function delay(milliseconds) {
			return new Promise((resolve) => {
				setTimeout(resolve, milliseconds);
			});
		}
		//#endregion
		//#region src/client/quota-styles.ts
		/**
		* The plugin's single stylesheet (one global <style> injected once).
		*
		* Every value is a DSH 0.2.1 theme token: semantic `--dsw-alias-*` colours,
		* `--dsw-radius-*` role radii, composed `--dsw-font-*` typography roles and
		* `--dsw-elevation-*` for floating surfaces. No literal colours, no palette
		* copies, no theme selectors — the theme owns both light and dark. Neutral
		* hairline borders draw at 0.5px; state-coloured borders stay 1px; compact
		* capsules pair `corner-shape: round` with the 999px radius, and every true
		* circle (dots, the switch knob) pairs it with 50% — the theme's global
		* superellipse otherwise deforms both into squircles.
		*
		* Two surfaces share these classes:
		*   - the plugin page (`.qdp-page` → four `.qdp-card` sections), and
		*   - the composer quota readout chip + its anchored panel (`.qdp-chip`,
		*     `.qdp-pop`), which replaces the old sidebar cards and dashboard.
		*
		* Classes are `qdp-` prefixed: several plugins inject GLOBAL CSS into the same
		* document, so prefixes must not collide. The stylesheet is returned as a
		* string (no DOM side effects at import time), installed once by the client
		* entry keyed by `data-plugin-css`, and removed when the plugin's fiber
		* unwinds.
		*/
		/** Stylesheet id (the `data-plugin-css` value that makes injection idempotent). */
		const QUOTA_CSS_ID = "dsh-qoder-plugin/QuotaPanel.module.css";
		/** Install the stylesheet once; returns its disposer. */
		function injectQuotaCss() {
			if (typeof document === "undefined") return () => {};
			if (document.querySelector(`style[data-plugin-css="dsh-qoder-plugin/QuotaPanel.module.css"]`) !== null) return () => {};
			const tag = document.createElement("style");
			tag.dataset.plugin = "dsh-qoder-plugin";
			tag.dataset.pluginCss = QUOTA_CSS_ID;
			tag.textContent = QUOTA_CSS;
			document.head.appendChild(tag);
			return () => {
				tag.remove();
			};
		}
		/** The quota + settings surfaces stylesheet. */
		const QUOTA_CSS = `
/* ------------------------------------------------------------------ base */

.qdp-page {
  box-sizing: border-box;
  display: grid;
  gap: 12px;
  font: var(--dsw-font-s-14);
  color: var(--dsw-alias-label-primary);
}
.qdp-page *,
.qdp-pop *,
.qdp-chip,
.qdp-pop {
  box-sizing: border-box;
}
.qdp-page :focus-visible,
.qdp-pop :focus-visible,
.qdp-chip:focus-visible,
.qdp-slider:focus-visible {
  outline: var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary));
  outline-offset: 2px;
}

/* ----------------------------------------------------------- page sections */

.qdp-card {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 16px;
  border: 0.5px solid var(--dsw-alias-settings-card-stroke);
  border-radius: var(--dsw-radius-xl);
  background: var(--dsw-alias-settings-card-fill);
}
.qdp-sectionHead {
  display: flex;
  align-items: center;
  gap: 12px;
  min-height: 28px;
  margin-bottom: 4px;
}
.qdp-sectionTitle {
  flex: 1 1 auto;
  min-width: 0;
  margin: 0;
  font: var(--dsw-font-xs-strong-13);
  color: var(--dsw-alias-label-secondary);
}
.qdp-sectionBody {
  display: flex;
  flex-direction: column;
  min-width: 0;
}
.qdp-row {
  display: flex;
  align-items: center;
  gap: 10px;
  min-height: 36px;
  padding: 10px 0;
}
.qdp-row + .qdp-row {
  border-top: 0.5px solid var(--dsw-alias-border-l2);
}
.qdp-rowText {
  display: flex;
  flex: 1 1 auto;
  flex-direction: column;
  gap: 1px;
  min-width: 0;
}
.qdp-rowTitle {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  font: var(--dsw-font-s-strong-14);
  color: var(--dsw-alias-label-primary);
}
.qdp-rowDesc {
  font: var(--dsw-font-xxs-12);
  color: var(--dsw-alias-label-tertiary);
}
.qdp-rowControl {
  display: flex;
  flex: 0 0 auto;
  align-items: center;
  gap: 6px;
}
.qdp-actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
}
/*
 * The account card's summary strip: remaining credit, check-in state, the
 * account in use, and the one-click check-in at the trailing edge.
 */
.qdp-accountSummary {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px 18px;
  padding: 10px 0;
  border-top: 0.5px solid var(--dsw-alias-border-l2);
}
.qdp-accountStat {
  display: flex;
  align-items: baseline;
  gap: 6px;
  min-width: 0;
}
.qdp-accountStatLabel {
  font: var(--dsw-font-xxxs-11, var(--dsw-font-xxs-12));
  color: var(--dsw-alias-label-tertiary);
  white-space: nowrap;
}
.qdp-accountStatValue {
  display: inline-flex;
  align-items: center;
  min-width: 0;
  font: var(--dsw-font-xxs-strong-12);
  color: var(--dsw-alias-label-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.qdp-accountActions {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-left: auto;
}
/*
 * The saved-account pool: one row per stored PAT, in failover order.
 *
 * Rows are a list rather than a table: the facts are a variable-width sentence
 * (source · saved · tail) and the only per-row choice is which one signs, so a
 * grid would add alignment rules that carry no information.
 */
.qdp-accountPool {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 10px 0;
  border-top: 0.5px solid var(--dsw-alias-border-l2);
}
.qdp-accountList {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin: 0;
  padding: 0;
  list-style: none;
}
.qdp-accountItem {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px 12px;
  padding: 6px 8px;
  border: 0.5px solid var(--dsw-alias-border-l2);
  border-radius: var(--dsw-radius-sm);
}
.qdp-accountItemInfo {
  display: flex;
  flex: 1 1 auto;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}
.qdp-accountItemName {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  min-width: 0;
  font: var(--dsw-font-xxs-strong-12);
  color: var(--dsw-alias-label-primary);
}
/*
 * The seat's balance, inline after its name.
 *
 * Same line as the name on purpose: the account list is scanned to answer
 * "which seat still has credits", and a figure on its own line below the name
 * made every row two glances tall. Quieter than the name so the name stays the
 * row's identity.
 */
.qdp-accountItemCredits {
  font: var(--dsw-font-xxxs-11, var(--dsw-font-xxs-12));
  color: var(--dsw-alias-label-secondary);
  font-variant-numeric: tabular-nums;
}
.qdp-accountItemMeta {
  font: var(--dsw-font-xxxs-11, var(--dsw-font-xxs-12));
  color: var(--dsw-alias-label-tertiary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
/* The inline remove confirmation belongs to its row, not to the whole card. */
.qdp-accountItemConfirm {
  flex: 1 1 100%;
  margin: 0;
}
/*
 * The park checkbox, before the row's facts.
 *
 * It carries no visible label of its own: the aria label names it for
 * assistive tech, and the 「已停用」 tag beside the account name is what tells a
 * sighted user which way the box is set — a second label would only repeat it.
 */
.qdp-accountCheck {
  display: flex;
  flex: 0 0 auto;
  align-items: center;
  padding: 2px;
  cursor: pointer;
}
.qdp-accountCheck input {
  width: 14px;
  height: 14px;
  margin: 0;
  cursor: inherit;
}
/* A parked seat keeps its row — it is still saved and still switchable — but
   it no longer takes part in the walk, and it has to look that way. */
.qdp-accountItem.is-off .qdp-accountItemInfo {
  opacity: 0.6;
}
.qdp-accountItemFacts {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  font: var(--dsw-font-xxxs-11, var(--dsw-font-xxs-12));
  color: var(--dsw-alias-label-secondary);
}
/*
 * The custom routing order: a numbered priority list.
 *
 * It is deliberately NOT the account list repeated. The number in the gutter is
 * the priority the failover walk uses, and it is the only thing this list says
 * that the account list above does not.
 */
.qdp-rowStack {
  flex-direction: column;
  align-items: stretch;
}
.qdp-routingList {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin: 0;
  padding: 0;
  list-style: none;
  counter-reset: qdp-routing;
}
.qdp-routingItem {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 8px;
  border: 0.5px solid var(--dsw-alias-border-l2);
  border-radius: var(--dsw-radius-sm);
}
.qdp-routingItem::before {
  counter-increment: qdp-routing;
  content: counter(qdp-routing);
  min-width: 14px;
  font: var(--dsw-font-xxs-strong-12);
  color: var(--dsw-alias-label-tertiary);
}
.qdp-routingWho {
  display: flex;
  flex: 1 1 auto;
  align-items: center;
  gap: 8px;
  min-width: 0;
}
.qdp-routingName {
  flex: 0 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font: var(--dsw-font-xxs-12);
  color: var(--dsw-alias-label-primary);
}
.qdp-routingCredits {
  flex: 0 0 auto;
  font: var(--dsw-font-xxxs-11, var(--dsw-font-xxs-12));
  color: var(--dsw-alias-label-secondary);
  font-variant-numeric: tabular-nums;
}
.qdp-routingItemActions {
  display: flex;
  flex: 0 0 auto;
  align-items: center;
  gap: 4px;
}
/*
 * The mixed-variant order warning.
 *
 * Warn tone and a left rule, never the error red: the order becomes usable the
 * moment the user consents, so this is a condition to resolve rather than a
 * failure to fix.
 */
.qdp-routingWarning {
  flex-direction: column;
  align-items: stretch;
  gap: 4px;
  border-left: 3px solid var(--dsw-alias-state-warn-primary);
}
.qdp-routingWarningTitle {
  font: var(--dsw-font-xxs-strong-12);
  color: var(--dsw-alias-label-primary);
}
.qdp-routingOffenders {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding-left: 8px;
}
/*
 * The upstream "model not serviceable" notice.
 *
 * Warn-toned and framed, never the alert's red: this condition clears by
 * waiting, and dressing it as a credential failure is exactly the mistake this
 * block exists to prevent. The left rule is what makes it read as a quoted
 * upstream report rather than another plugin error.
 */
.qdp-notice {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin: 8px 0;
  padding: 8px 10px;
  border-left: 3px solid var(--dsw-alias-state-warn-primary);
  border-radius: var(--dsw-radius-sm);
  background: var(--dsw-alias-bg-layer-2);
}
.qdp-noticeHead {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
}
.qdp-noticeTitle {
  font: var(--dsw-font-xxs-strong-12);
  color: var(--dsw-alias-label-primary);
}
.qdp-noticeAt {
  margin-left: auto;
  font: var(--dsw-font-xxxs-11, var(--dsw-font-xxs-12));
  color: var(--dsw-alias-label-tertiary);
}
.qdp-noticeQuote {
  margin: 0;
  padding-left: 8px;
  border-left: 2px solid var(--dsw-alias-border-l2);
  font: var(--dsw-font-xxs-12);
  color: var(--dsw-alias-label-secondary);
  overflow-wrap: anywhere;
}
.qdp-metaRow {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px 8px;
  padding-top: 2px;
  font: var(--dsw-font-xxs-12);
  color: var(--dsw-alias-label-caption);
}
.qdp-caption {
  font: var(--dsw-font-xxs-12);
  color: var(--dsw-alias-label-tertiary);
}
/*
 * An inline explanation attached to a settings surface: the face is still
 * loading, or the host refused the last write.
 *
 * Deliberately quieter than the upstream notice block: it explains a control the user is
 * looking at, it is not an upstream report. The danger tone is only for a
 * refusal, where the value on screen is known not to be the stored one.
 */
.qdp-note {
  margin: 0 0 8px;
  padding: 6px 8px;
  border-radius: var(--dsw-radius-sm);
  background: var(--dsw-alias-bg-layer-2);
  color: var(--dsw-alias-label-secondary);
  font: var(--dsw-font-xxs-12);
  line-height: 1.5;
  word-break: break-word;
}
.qdp-noteDanger {
  border-left: 3px solid var(--dsw-alias-state-error-primary);
  color: var(--dsw-alias-label-primary);
}
.qdp-muted {
  color: var(--dsw-alias-label-tertiary);
}
.qdp-num {
  font: var(--dsw-font-xxs-strong-12);
  font-variant-numeric: tabular-nums;
  color: var(--dsw-alias-label-primary);
}
.qdp-stack {
  display: flex;
  flex-direction: column;
}
.qdp-inline {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
}
.qdp-spacer {
  flex: 1 1 auto;
}
.qdp-empty {
  padding: 12px 0;
  text-align: center;
  font: var(--dsw-font-xxs-12);
  color: var(--dsw-alias-label-tertiary);
}
.qdp-skeleton {
  border-radius: var(--dsw-radius-sm);
  background: var(--dsw-alias-bg-skeleton);
}
.qdp-link {
  color: var(--dsw-alias-link);
  font-weight: 500;
  text-decoration: none;
}
.qdp-link:hover {
  text-decoration: underline dotted;
  text-underline-offset: 3px;
}

/* ---------------------------------------------------------------- notices */

/*
 * The 'qoder' command row in the conversation flow (the queue notices and the
 * job-token heal lines). The host's generic command card ellipsizes its summary
 * to one nowrap line, which cut the notice's tail — the queue length and retry
 * count — off. This is the plugin's own renderer (QoderQueueNoticeRow): the
 * text wraps, and the tone matches the generic row's caption so the line still
 * reads as the host's own. Backtick-free: this file is one template literal.
 */
.qdp-noticeRow {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 4px;
  padding: 2px 0;
  font: var(--dsw-font-xxs-12);
  color: var(--dsw-alias-label-secondary);
}
.qdp-noticeRowName {
  color: var(--dsw-alias-label-tertiary);
  font-variant-numeric: tabular-nums;
}
.qdp-noticeRowDot {
  color: var(--dsw-alias-label-tertiary);
}
.qdp-noticeRowText {
  flex: 1 1 40ch;
  min-width: 0;
  line-height: 1.5;
  white-space: normal;
  overflow-wrap: anywhere;
}
.qdp-noticeRowError,
.qdp-noticeRowError .qdp-noticeRowText {
  color: var(--dsw-alias-state-error-primary);
}

.qdp-body {
  font: var(--dsw-font-xxs-12);
  color: var(--dsw-alias-label-tertiary);
}
.qdp-error {
  font: var(--dsw-font-xxs-12);
  color: var(--dsw-alias-state-error-primary);
}
.qdp-alert {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  padding: 8px 10px;
  border-radius: var(--dsw-radius-sm);
  background: var(--dsw-alias-bg-layer-2);
  font: var(--dsw-font-xxs-12);
  color: var(--dsw-alias-label-secondary);
}
.qdp-alertError {
  border: 1px solid var(--dsw-alias-state-error-primary);
  background: transparent;
  color: var(--dsw-alias-state-error-primary);
}

/* ---------------------------------------------------------------- buttons */

/*
 * Geometry from the host's own Button (ui-primitives): sm 28px/R8, md 36px/R12,
 * no icon padding, hairline border. The DEFAULT button is the official
 * outline style (transparent on the card, 0.5px border-l3, primary label),
 * which is what the other plugin's white buttons are: a thin frame, never a
 * bare label floating on the card. The primary fill is the official filled CTA
 * — black in the light theme, white in the dark one, because it reads
 * --dsw-alias-button-primary-fill (= brand-primary), not a literal colour.
 */
.qdp-btn {
  display: inline-flex;
  flex: 0 0 auto;
  align-items: center;
  justify-content: center;
  gap: 4px;
  height: 28px;
  padding: 0 10px;
  border: 0.5px solid var(--dsw-alias-border-l3);
  border-radius: var(--dsw-radius-sm);
  background: transparent;
  color: var(--dsw-alias-label-primary);
  font: var(--dsw-font-xxs-strong-12);
  white-space: nowrap;
  cursor: pointer;
  transition: color .2s var(--ds-ease-in-out, ease), background-color .2s var(--ds-ease-in-out, ease);
}
.qdp-btn:hover:not(:disabled) {
  color: var(--dsw-alias-label-primary);
  background: var(--dsw-alias-interactive-bg-hover);
}
.qdp-btn:disabled {
  border-color: var(--dsw-alias-border-l2);
  background: transparent;
  color: var(--dsw-alias-label-tertiary);
  opacity: 0.5;
  cursor: default;
}
.qdp-btnMd {
  height: 36px;
  padding: 0 14px;
  border-radius: var(--dsw-radius-md);
  font: var(--dsw-font-s-strong-14);
}
.qdp-btnPrimary {
  border-color: transparent;
  background: var(--dsw-alias-button-primary-fill);
  color: var(--dsw-alias-label-primary-foreground);
}
.qdp-btnPrimary:hover:not(:disabled) {
  border-color: transparent;
  background: var(--dsw-alias-button-primary-hover);
  color: var(--dsw-alias-label-primary-foreground);
}
.qdp-btnPrimary:disabled {
  border-color: transparent;
  background: var(--dsw-alias-button-primary-fill);
  color: var(--dsw-alias-label-primary-foreground);
  opacity: 0.4;
}
/* The destructive confirm: the official danger fill (a red primary). */
.qdp-btnDanger {
  border-color: transparent;
  background: var(--dsw-alias-state-error-primary);
  color: var(--dsw-alias-label-primary-foreground);
}
.qdp-btnDanger:hover:not(:disabled) {
  border-color: transparent;
  background: var(--dsw-alias-state-error-primary);
  color: var(--dsw-alias-label-primary-foreground);
  opacity: 0.9;
}
/*
 * 删除: the official UNINSTALL button (PluginManagerPage's danger rule), minus its
 * trash icon: red ink on transparent, red border at 30% so it recedes until
 * hovered, red wash on hover. Deliberately not the danger FILL — an uninstall
 * does not shout until clicked, and neither does removing a PAT.
 */
.qdp-btnDangerQuiet {
  border-color: color-mix(in srgb, var(--dsw-alias-state-error-primary) 30%, transparent);
  background: transparent;
  color: var(--dsw-alias-state-error-primary);
}
.qdp-btnDangerQuiet:hover:not(:disabled) {
  background: color-mix(in srgb, var(--dsw-alias-state-error-primary) 8%, transparent);
  color: var(--dsw-alias-state-error-primary);
}
/* A deliberately frameless button; only for inline actions that already sit in
   a framed control group (e.g. a text-ish "cancel"). */
.qdp-btnGhost {
  border-color: transparent;
  background: transparent;
  color: var(--dsw-alias-label-secondary);
}
.qdp-btnGhost:hover:not(:disabled) {
  color: var(--dsw-alias-label-primary);
  background: var(--dsw-alias-interactive-bg-hover);
}
.qdp-iconButton {
  display: inline-flex;
  flex: 0 0 auto;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  padding: 0;
  border: 0;
  border-radius: var(--dsw-radius-sm);
  background: none;
  color: var(--dsw-alias-label-tertiary);
  cursor: pointer;
}
.qdp-iconButton:hover:not(:disabled) {
  background: var(--dsw-alias-interactive-bg-hover);
  color: var(--dsw-alias-label-primary);
}
.qdp-iconButton:disabled {
  opacity: 0.5;
  cursor: default;
}

/* ----------------------------------------------------------------- switch */

.qdp-switch {
  position: relative;
  flex: 0 0 auto;
  width: 36px;
  height: 20px;
  padding: 0;
  border: 0;
  border-radius: 999px;
  corner-shape: round;
  background: var(--dsw-alias-border-l3);
  cursor: pointer;
  transition: background-color .1s var(--ds-ease-in-out, ease);
}
.qdp-switch[aria-checked='true'] {
  background: var(--dsw-alias-brand-primary);
}
.qdp-switch:disabled {
  opacity: 0.5;
  cursor: default;
}
.qdp-switchThumb {
  position: absolute;
  top: 2px;
  left: 2px;
  width: 16px;
  height: 16px;
  border-radius: 50%;
  /* The theme rounds corners with a superellipse, which deforms a 50% radius
     into a squircle. The official control's knob is a true circle, so this
     shape opts out — a switch knob that is visibly not round reads as a
     different control than the ones beside it. */
  corner-shape: round;
  background: var(--dsw-alias-switch-thumb, var(--dsw-alias-bg-layer-1));
  transition: transform .1s var(--ds-ease-in-out, ease);
}
.qdp-switch[aria-checked='true'] .qdp-switchThumb {
  background: var(--dsw-alias-label-primary-foreground);
  transform: translateX(16px);
}

/* -------------------------------------------------------------- segmented */

.qdp-seg {
  display: inline-flex;
  flex: 0 0 auto;
  gap: 2px;
  padding: 4px;
  border-radius: var(--dsw-radius-md);
  background: var(--dsw-alias-interactive-bg-hover);
}
.qdp-segItem {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 28px;
  padding: 0 10px;
  border: 0;
  border-radius: var(--dsw-radius-sm);
  background: transparent;
  color: var(--dsw-alias-label-secondary);
  font: var(--dsw-font-xs-strong-13);
  white-space: nowrap;
  cursor: pointer;
}
.qdp-segItemActive {
  background: var(--dsw-alias-bg-layer-1);
  color: var(--dsw-alias-label-primary);
  box-shadow: var(--dsw-elevation-soft);
}
.qdp-segItem:disabled {
  opacity: 0.5;
  cursor: default;
}
/* Cell wrapper when an option carries a trailing control (the variant enable
   checkbox): the cell becomes the track's flex child so the tab inside keeps
   its own geometry, and the checkbox sits beside it without actuating it. */
.qdp-segCell {
  display: inline-flex;
  align-items: center;
  gap: 2px;
}
.qdp-segCheck {
  width: 14px;
  height: 14px;
  margin: 0 6px 0 0;
  accent-color: var(--dsw-alias-label-primary);
  cursor: pointer;
}
.qdp-segCheck:disabled {
  opacity: 0.4;
  cursor: default;
}

/* ------------------------------------------------------------------- dots */

.qdp-dot {
  flex: 0 0 auto;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  corner-shape: round;
  background: var(--dsw-alias-state-idle-primary);
}
.qdp-dotDone {
  background: var(--dsw-alias-state-success-primary);
}
.qdp-dotOngoing {
  box-sizing: border-box;
  background: transparent;
  border: 1.5px solid var(--dsw-alias-state-business-primary);
  border-right-color: transparent;
  animation: qdp-spin .8s linear infinite;
}
.qdp-dotWarn {
  background: var(--dsw-alias-state-warn-primary);
}
.qdp-dotError {
  background: var(--dsw-alias-state-error-primary);
}
@keyframes qdp-spin {
  to {
    transform: rotate(360deg);
  }
}

/* ------------------------------------------------------------------- tags */

.qdp-tag {
  display: inline-flex;
  flex: 0 0 auto;
  align-items: center;
  height: 20px;
  padding: 0 8px;
  border-radius: 999px;
  corner-shape: round;
  background: var(--dsw-alias-bg-layer-2);
  color: var(--dsw-alias-label-secondary);
  font: var(--dsw-font-xxxs-strong-11);
  white-space: nowrap;
}
.qdp-tagSuccess {
  background: var(--dsw-alias-state-success-tertiary);
  color: var(--dsw-alias-state-success-primary);
}
.qdp-tagWarn {
  background: var(--dsw-alias-state-warn-tertiary);
  color: var(--dsw-alias-state-warn-label);
}
.qdp-tagError {
  background: var(--dsw-alias-interactive-bg-hover-danger);
  color: var(--dsw-alias-state-error-primary);
}

/* ------------------------------------------------------------------ input */

.qdp-input {
  box-sizing: border-box;
  display: inline-flex;
  align-items: center;
  height: 32px;
  min-width: 200px;
  padding: 0 8px;
  border: 0.5px solid var(--dsw-alias-border-l2);
  border-radius: var(--dsw-radius-md);
  background: var(--dsw-alias-bg-base);
  color: var(--dsw-alias-label-primary);
  font: var(--dsw-font-s-14);
  outline: none;
}
.qdp-input::placeholder {
  color: var(--dsw-alias-label-caption);
}
.qdp-input:hover:not(:disabled) {
  border-color: var(--dsw-alias-border-l3);
}
.qdp-input:focus {
  border-color: var(--dsw-alias-state-business-primary);
  box-shadow: 0 0 0 1px var(--dsw-alias-state-business-primary);
}
.qdp-input:disabled {
  opacity: 0.5;
  cursor: default;
}
.qdp-inputShort {
  min-width: 0;
  flex: 0 0 auto;
  width: 56px;
  padding: 0 8px;
  text-align: center;
  font-variant-numeric: tabular-nums;
}
/*
 * The routing-strategy select. It follows the input geometry above rather than
 * the segmented control, because the card may keep only one level of tabs.
 */
.qdp-select {
  box-sizing: border-box;
  height: 32px;
  padding: 0 8px;
  border: 0.5px solid var(--dsw-alias-border-l2);
  border-radius: var(--dsw-radius-md);
  background: var(--dsw-alias-bg-base);
  font: var(--dsw-font-xxs-12);
  color: var(--dsw-alias-label-primary);
}
.qdp-select:hover:not(:disabled) {
  border-color: var(--dsw-alias-border-l3);
}
.qdp-select:focus {
  border-color: var(--dsw-alias-state-business-primary);
  box-shadow: 0 0 0 1px var(--dsw-alias-state-business-primary);
}
.qdp-select:disabled {
  opacity: 0.5;
  cursor: default;
}
.qdp-patInput {
  flex: 1 1 auto;
  min-width: 200px;
}

/* ---------------------------------------------------------------- sliders */

/* The official Qoder model-settings slider: a 56 px field, an 18 px rail on the
   vertical centre, a 2 × 12 px grab tick at the fill's edge and a 12 px label
   row hanging 40 px below the field's top. The rail is a soft neutral and the
   fill a 42 % brand tint, so the grab tick reads as the only strong mark. */
.qdp-slider {
  position: relative;
  width: 100%;
  max-width: 252px;
  height: 56px;
  border-radius: var(--dsw-radius-xs);
  cursor: pointer;
  touch-action: none;
  user-select: none;
}
.qdp-slider[aria-disabled='true'] {
  opacity: 0.55;
  cursor: default;
}
.qdp-sliderTrack {
  position: absolute;
  top: 50%;
  right: 0;
  left: 0;
  height: 18px;
  transform: translateY(-50%);
}
.qdp-sliderRail,
.qdp-sliderFill {
  position: absolute;
  top: 0;
  left: 0;
  height: 100%;
  border-radius: var(--dsw-radius-xs);
}
.qdp-sliderRail {
  background: var(--dsw-alias-interactive-bg-hover);
}
/* The chosen stretch is a quiet neutral, exactly like the upstream rail: the
   strong mark on the control is the grab tick, not a saturated fill. */
.qdp-sliderFill {
  background: var(--dsw-alias-border-l3);
}
.qdp-sliderThumb {
  position: absolute;
  top: 3px;
  width: 2px;
  height: 12px;
  border-radius: 1px;
  background: var(--dsw-alias-state-business-primary);
}

/* ----------------------------------------------------------------- models */

.qdp-modelScroll {
  max-height: 420px;
  /* Vertical scrolling only: a horizontal bar under the roster was pure noise,
     and the extra right padding keeps the scrollbar off the context slider. */
  overflow-x: hidden;
  overflow-y: auto;
  padding-right: 12px;
  overscroll-behavior: contain;
}
.qdp-modelColumns {
  position: sticky;
  top: 0;
  z-index: 1;
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) minmax(0, 1.15fr) 232px;
  gap: 12px;
  align-items: center;
  padding: 4px 0 4px;
  border-bottom: 0.5px solid var(--dsw-alias-border-l2);
  background: var(--dsw-alias-settings-card-fill);
  font: var(--dsw-font-xxxs-11);
  color: var(--dsw-alias-label-tertiary);
}
.qdp-modelRow {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) minmax(0, 1.15fr) 232px;
  gap: 12px;
  align-items: center;
  min-height: 44px;
  padding: 6px 0;
}
.qdp-modelRow + .qdp-modelRow {
  border-top: 0.5px solid var(--dsw-alias-border-l2);
}
.qdp-modelRow[aria-disabled='true'] {
  opacity: 0.55;
}
.qdp-modelEnable {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  cursor: pointer;
}
.qdp-modelEnable input {
  flex: 0 0 auto;
  width: 16px;
  height: 16px;
  margin: 0;
  accent-color: var(--dsw-alias-brand-primary);
}
.qdp-modelCopy {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px 8px;
  min-width: 0;
}
.qdp-modelName {
  font: var(--dsw-font-xs-strong-13);
  color: var(--dsw-alias-label-primary);
}
.qdp-modelMeta {
  font: var(--dsw-font-xxs-12);
  color: var(--dsw-alias-label-caption);
  font-variant-numeric: tabular-nums;
}
.qdp-modelRate {
  flex: 0 0 auto;
  font: var(--dsw-font-xxxs-11);
  color: var(--dsw-alias-label-caption);
  font-variant-numeric: tabular-nums;
}
/* The effort column: the tiers themselves, no "Efforts:" prefix — the column
   header says what they are. */
.qdp-modelEfforts {
  min-width: 0;
  font: var(--dsw-font-xxs-12);
  color: var(--dsw-alias-label-secondary);
  font-variant-numeric: tabular-nums;
  overflow-wrap: anywhere;
}
.qdp-modelAxis {
  min-width: 0;
}
.qdp-sliderField {
  position: relative;
  min-width: 0;
}
.qdp-windowTicks {
  position: absolute;
  top: 40px;
  right: 0;
  left: 0;
  height: 12px;
  pointer-events: none;
}
/* Hairline ruler under the rail: 33 marks across the field, every eighth one
   taller and a step darker, matching the official scale. */
.qdp-windowTickMark {
  position: absolute;
  top: 50%;
  width: 1px;
  height: 7px;
  border-radius: 999px;
  corner-shape: round;
  background: var(--dsw-alias-label-caption);
  transform: translate(-50%, -50%);
}
.qdp-windowTickMarkMajor {
  height: 10px;
  background: var(--dsw-alias-label-tertiary);
}
/* Tier labels sit on the field colour so the ruler passes behind them. */
.qdp-windowTick {
  position: absolute;
  top: 50%;
  padding: 0 4px;
  background: var(--dsw-alias-settings-card-fill);
  font: var(--dsw-font-xxxs-11);
  font-size: 9px;
  line-height: 12px;
  color: var(--dsw-alias-label-tertiary);
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}
/* The window in force is the only dark number: the other tiers are offers the
   user has not selected, so they keep the tertiary (grey) tone. */
.qdp-windowTickActive {
  color: var(--dsw-alias-label-primary);
  font-weight: 500;
}
/* A disabled slider greys every label, the active one included. */
.qdp-slider[aria-disabled='true'] .qdp-windowTick {
  color: var(--dsw-alias-label-caption);
}

/* --------------------------------------------------------------- save bar */

.qdp-saveBar {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-top: 10px;
  padding: 10px 0 0;
  border-top: 0.5px solid var(--dsw-alias-border-l2);
  background: var(--dsw-alias-settings-card-fill);
}
.qdp-saveBarText {
  flex: 1 1 auto;
  min-width: 0;
  font: var(--dsw-font-xxs-12);
  color: var(--dsw-alias-label-secondary);
}
.qdp-saveBarActions {
  display: flex;
  flex: 0 0 auto;
  align-items: center;
  gap: 6px;
}

/* ------------------------------------------------- chip + anchored panel */

.qdp-chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 24px;
  max-width: 220px;
  padding: 0 8px;
  border: 0;
  border-radius: 999px;
  corner-shape: round;
  background: transparent;
  color: var(--dsw-alias-label-secondary);
  font: var(--dsw-font-xxs-strong-12);
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
  cursor: pointer;
  transition: background-color .2s var(--ds-ease-in-out, ease), color .2s var(--ds-ease-in-out, ease);
}
.qdp-chip:hover,
.qdp-chip[aria-expanded='true'] {
  background: var(--dsw-alias-interactive-bg-hover);
  color: var(--dsw-alias-label-primary);
}
.qdp-chipName {
  overflow: hidden;
  max-width: 96px;
  text-overflow: ellipsis;
}
.qdp-chipValue {
  color: var(--dsw-alias-label-primary);
}

.qdp-pop {
  position: fixed;
  z-index: 60;
  width: 300px;
  padding: 12px;
  border: 0;
  border-radius: var(--dsw-radius-lg);
  background: var(--dsw-alias-bg-layer-1);
  box-shadow: var(--dsw-elevation-prominent);
  font: var(--dsw-font-s-14);
  color: var(--dsw-alias-label-primary);
}
.qdp-popHead {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 4px;
}
.qdp-popTitle {
  flex: 1 1 auto;
  min-width: 0;
  font: var(--dsw-font-s-strong-14);
  color: var(--dsw-alias-label-primary);
}
.qdp-popTime {
  font: var(--dsw-font-xxxs-11);
  color: var(--dsw-alias-label-tertiary);
  font-variant-numeric: tabular-nums;
}
.qdp-popList {
  display: flex;
  flex-direction: column;
  gap: 2px;
  /*
   * A stored pool makes the row count unbounded (the user can save as many
   * tokens as they like), and the panel opens upward from the composer — so it
   * scrolls here instead of growing off the top of the window.
   */
  max-height: 320px;
  overflow-y: auto;
}
.qdp-popVariant {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 8px;
  border-radius: var(--dsw-radius-sm);
}
.qdp-popVariantActive {
  background: var(--dsw-alias-interactive-bg-hover);
}
.qdp-popVariantHead {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}
.qdp-popName {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font: var(--dsw-font-xs-strong-13);
  color: var(--dsw-alias-label-primary);
}
.qdp-popValue {
  flex: 0 0 auto;
  font: var(--dsw-font-xxs-strong-12);
  color: var(--dsw-alias-label-primary);
  font-variant-numeric: tabular-nums;
}
.qdp-popBar {
  position: relative;
  height: 5px;
  overflow: hidden;
  border-radius: 999px;
  corner-shape: round;
  background: var(--dsw-alias-interactive-bg-hover);
}
.qdp-popBarFill {
  height: 100%;
  border-radius: 999px;
  corner-shape: round;
  background: var(--dsw-alias-state-business-primary);
}
.qdp-popWarn {
  background: var(--dsw-alias-state-warn-primary);
}
.qdp-popCaption {
  font: var(--dsw-font-xxxs-11);
  color: var(--dsw-alias-label-tertiary);
  font-variant-numeric: tabular-nums;
}
/*
 * The pooled-account section (m01197).
 *
 * Rows are framed like the settings card's pool, so one account reads the same
 * in both surfaces — but here the NAME is the switch. The panel is the fast path
 * for "price my other accounts and move to one", and a separate switch button
 * would spend a control's width on a 300px panel to say what clicking the
 * username already says.
 */
.qdp-popAccounts {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.qdp-popAccountsHead {
  display: flex;
  align-items: center;
  gap: 6px;
}
.qdp-popAccountsTitle {
  font: var(--dsw-font-xxs-strong-12);
  color: var(--dsw-alias-label-secondary);
}
.qdp-popAccountsSwitchHint {
  margin-left: auto;
  font: var(--dsw-font-xxxs-11);
  color: var(--dsw-alias-label-tertiary);
}
.qdp-popAccountsHint {
  font: var(--dsw-font-xxxs-11);
  color: var(--dsw-alias-label-tertiary);
}
.qdp-popAccountList {
  display: flex;
  flex-direction: column;
  gap: 2px;
  margin: 0;
  padding: 0;
  list-style: none;
}
.qdp-popAccount {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 8px;
  border-radius: var(--dsw-radius-sm);
}
.qdp-popAccountActive {
  background: var(--dsw-alias-interactive-bg-hover);
}
.qdp-popAccountHead {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}
/*
 * The name keeps the row's own typography whether it is the active seat's text
 * or the switch; a raw <button> only gets box-sizing from the shared reset, so
 * the switch rule below flattens the browser's chrome and restores the pointer.
 */
.qdp-popAccountName {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font: var(--dsw-font-xs-strong-13);
  color: var(--dsw-alias-label-primary);
  text-align: left;
}
.qdp-popAccountSwitch {
  border: 0;
  padding: 0;
  background: transparent;
  cursor: pointer;
}
.qdp-popAccountSwitch:hover:not(:disabled) {
  text-decoration: underline;
}
.qdp-popAccountSwitch:disabled {
  cursor: default;
}
.qdp-popAccountUnavailable {
  display: flex;
  align-items: center;
  gap: 6px;
}
/*
 * A parked seat still appears (it is saved, and still switchable — parking is
 * "do not route here", not "forget this"), but it is out of the walk and out of
 * the panel's arithmetic, so it steps back visually the same way the card's
 * account list does.
 */
.qdp-popAccountParked .qdp-popAccountHead {
  opacity: 0.6;
}
.qdp-popAccountHealth {
  display: inline-flex;
  flex: 0 0 auto;
}
.qdp-popFoot {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 8px;
  padding-top: 8px;
  border-top: 0.5px solid var(--dsw-alias-border-l2);
  font: var(--dsw-font-xxxs-11);
  color: var(--dsw-alias-label-caption);
}
.qdp-popRefresh {
  flex: 0 0 auto;
}

/* ----------------------------------------------------- context probe chip */

.qdp-probeWrap {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  min-width: 0;
}
.qdp-probe {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  height: 24px;
  padding: 0 6px;
  border: 0;
  border-radius: 999px;
  corner-shape: round;
  background: transparent;
  color: var(--dsw-alias-label-secondary);
  font: var(--dsw-font-xxs-strong-12);
  white-space: nowrap;
  cursor: pointer;
}
.qdp-probe:hover:not(:disabled) {
  background: var(--dsw-alias-interactive-bg-hover);
  color: var(--dsw-alias-label-primary);
}
.qdp-probe:disabled {
  opacity: 0.5;
  cursor: default;
}
.qdp-probeLabel {
  max-width: 120px;
  overflow: hidden;
  text-overflow: ellipsis;
}
.qdp-probeDot {
  flex: 0 0 auto;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  corner-shape: round;
  background: var(--dsw-alias-state-idle-primary);
}
.qdp-probeDotOn {
  background: var(--dsw-alias-state-success-primary);
}
.qdp-probeDotWarn {
  background: var(--dsw-alias-state-warn-primary);
}
.qdp-probeDotError {
  background: var(--dsw-alias-state-error-primary);
}
.qdp-probeTip {
  position: fixed;
  z-index: 70;
  max-width: 240px;
  padding: 6px 8px;
  border-radius: var(--dsw-radius-sm);
  background: var(--dsw-alias-tooltip-bg, var(--dsw-alias-label-primary));
  color: var(--dsw-alias-label-primary-foreground);
  font: var(--dsw-font-xxxs-11);
  box-shadow: var(--dsw-elevation-soft);
  pointer-events: none;
}
.qdp-probeBubble {
  position: fixed;
  z-index: 70;
  width: 260px;
  padding: 12px;
  border: 0;
  border-radius: var(--dsw-radius-lg);
  background: var(--dsw-alias-bg-layer-1);
  box-shadow: var(--dsw-elevation-panel);
  font: var(--dsw-font-xxs-12);
  color: var(--dsw-alias-label-secondary);
}
.qdp-probeBubbleRow {
  display: flex;
  justify-content: flex-end;
  gap: 6px;
  margin-top: 10px;
}
.qdp-probeNote {
  position: fixed;
  z-index: 70;
  display: flex;
  align-items: center;
  gap: 8px;
  width: 260px;
  padding: 8px 10px;
  border-radius: var(--dsw-radius-sm);
  background: var(--dsw-alias-bg-layer-1);
  box-shadow: var(--dsw-elevation-panel);
  font: var(--dsw-font-xxs-12);
  color: var(--dsw-alias-label-secondary);
}
.qdp-glyph {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 16px;
  height: 16px;
  color: currentColor;
}

/* ------------------------------------------------------------- aesthetics */

@media (prefers-reduced-motion: reduce) {
  .qdp-btn,
  .qdp-switch,
  .qdp-switchThumb,
  .qdp-chip,
  .qdp-dotOngoing {
    transition: none;
    animation: none;
  }
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
			checkInClaimedToday: "Claimed today",
			checkInChecking: "Claiming…",
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
			accountsHeading: "Saved accounts",
			accountsHint: "Requests use the first account that works; the list is in the order you saved them. Switching accounts changes which subscription pays.",
			accountsSwitchHint: "Click a name to switch",
			accountsFailoverOn: "Automatic switch on",
			accountsFailoverOff: "Automatic switch off",
			accountsFailoverIdle: "Automatic switch standby (only one usable account)",
			accountsLastFailover: "Last automatic switch {time}",
			accountsLastFailoverReason: "Reason: {reason}",
			accountSlot: "Account {order}",
			accountAdd: "Add account",
			accountSwitch: "Use",
			accountSwitchAria: "Use account {name}",
			accountRemoveAria: "Remove account {name}",
			accountRemoveConfirm: "Remove this account?",
			accountRemoveConfirmYes: "Yes, remove it",
			accountSwitched: "Now using {name}.",
			accountRemoved: "Account removed.",
			accountActionFailed: "The account change did not land: {message}",
			upstreamNoticeKindQueued: "Queued",
			upstreamNoticeKindUnavailable: "Service busy",
			upstreamNoticeHeading: "Upstream model unavailable",
			upstreamNoticeAt: "Reported {time}",
			upstreamNoticeMessage: "Upstream said: {message}",
			upstreamNoticeWaited: "This plugin already waited {seconds}s and retried; still unavailable.",
			upstreamNoticeWaitedNoDelay: "This plugin already waited and retried; still unavailable.",
			upstreamNoticeRetry: "Try again in about {seconds}s.",
			upstreamNoticeNotAuth: "This is not a credential problem — re-saving the PAT will not help.",
			upstreamNoticeAdvice: "It normally clears on its own; wait a little, then retry.",
			upstreamNoticeRecurrence: "Seen {count} times in this session",
			quotaSectionAdvanced: "Advanced settings",
			settingsLoading: "Loading settings from the plugin host… the controls below are disabled until it answers.",
			settingsUnavailable: "Could not read settings from the plugin host: {message}. The controls below are disabled; reloading the page retries.",
			settingsWriteFailed: "The plugin host refused that change: {message}. The value shown is still the stored one.",
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
			effortsHeading: "Reasoning effort",
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
			autoCheckInHintCN: "Check in automatically every day; during campaigns this earns 100 Credits of compute for the China and Global accounts.",
			autoCheckInHintGlobal: "Check in automatically every day; during campaigns this earns 100 Credits of compute for the China and Global accounts.",
			checkInTimeHint: "The time the automatic check-in runs each day, Beijing time (UTC+8), refreshing at 10:00 daily.",
			autoCheckInStatusClaimed: "Checked in today (+{amount} Credits)",
			autoCheckInStatusAlready: "Already checked in today",
			autoCheckInStatusNoCampaign: "No active benefit campaign today",
			checkInNeedsClient: "Qoder's daily campaign needs the Qoder desktop app on this machine: the international service only serves it to requests carrying a client-minted device identity. Install Qoder and try again.",
			autoCheckInStatusError: "Auto check-in error: {message}",
			quotaSignInRequired: "Save a PAT for this variant first to enable this card.",
			quotaPollLabel: "Credit refresh interval",
			quotaPollHint: "How often the remaining-credit label refreshes; a longer interval is kinder to the billing endpoint.",
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
			quotaColExpiry: "Expires",
			quotaChipAria: "Qoder quota readout",
			quotaChipCN: "Qoder",
			quotaChipGlobal: "Qoder Global",
			quotaPanelAutoRefresh: "Auto-refreshes every {minutes} min",
			quotaPanelEmpty: "No quota data yet",
			modelsUnsavedCount: "{count} unsaved change(s)",
			modelsBatchSaveHint: "Changes apply after you save.",
			saveChanges: "Save changes",
			savingChanges: "Saving…",
			cancelChanges: "Cancel",
			modelsSaved: "Saved.",
			modelsSaveFailed: "Save failed: {message}",
			contextWindowAria: "Context window size",
			variantSwitcherAria: "Qoder version",
			quotaReadoutEnabledLabel: "Credits in the dialog",
			quotaReadoutEnabledDesc: "Show the remaining credits on the composer toolbar; click to expand the details panel.",
			checkInTime: "Check-in time",
			modelEffortsDefault: "default {name}",
			effortMinimal: "minimal",
			effortLow: "low",
			effortMedium: "medium",
			effortHigh: "high",
			effortXhigh: "xhigh",
			effortMax: "max",
			effortsUnsupported: "not supported",
			accountCurrent: "In use",
			creditsRemaining: "Remaining credit",
			checkInStatus: "Check-in",
			checkInNotClaimed: "Not claimed yet",
			checkInAll: "Check in all",
			accountEnabledLabel: "Use in failover",
			accountEnabledAria: "Use account {name} in automatic failover",
			accountEnabledNotice: "{name} joins automatic failover.",
			accountParkedNotice: "{name} is parked and no longer tried automatically.",
			accountParked: "Parked",
			accountCreditsValue: "{value} left",
			accountCreditsParked: "Not counted",
			accountCreditsUnknown: "Credit unknown",
			accountHealthAria: "Account health",
			accountHealthNormal: "Normal",
			accountHealthQueued: "Queued",
			accountHealthLimited: "Rate-limited",
			accountHealthUnknown: "Not observed yet",
			innerErrorsHeading: "In-stream upstream errors (this process)",
			innerErrorsContentPolicy: "Content policy",
			innerErrorsRateLimit: "Rate limit",
			innerErrorsInvalidRequest: "Invalid request",
			innerErrorsAuth: "Auth",
			innerErrorsOther: "Other",
			autoFailoverLabel: "Automatic account switch",
			autoFailoverHint: "When a request cannot connect, try the next saved account. Turning this off pins every request to the account in use.",
			queueWaitAttemptsLabel: "Queue retry attempts",
			queueWaitAttemptsHint: "How many times one request waits out a queue notice before the error is reported; failover to another account does not reset this budget; 0 reports it at once.",
			queueWaitSecondsLabel: "Wait per retry",
			queueWaitSecondsHint: "Fallback wait before each queue retry, used only when the upstream advises nothing; an advised window wins instead, plus 1–3 s of jitter, capped at five minutes.",
			queueWaitSecondsUnit: "s",
			routingStrategyLabel: "Account order",
			routingStrategyHint: "Save order follows the list above. Custom order uses the priority you set below.",
			routingStrategySaveOrder: "Save order",
			routingStrategyCustom: "Custom order",
			routingOrderHeading: "Priority",
			routingOrderHint: "Accounts are tried from top to bottom; the list may span both variants.",
			routingOrderMissing: "No account to order yet.",
			routingOrderMoveUp: "Up",
			routingOrderMoveUpAria: "Move {name} up",
			routingOrderMoveDown: "Down",
			routingOrderMoveDownAria: "Move {name} down",
			stickinessLabel: "Conversation stickiness",
			stickinessHint: "When on, one account serves a conversation until it reaches any of the limits below; the conversation then switches to the next account automatically. A round is one chat whose answer finished, 0 disables that limit.",
			stickinessToggleHint: "Turn off to let every request pick an account fresh instead of staying on one.",
			stickinessRoundsLabel: "Rounds",
			stickinessRequestsLabel: "Requests",
			stickinessMinutesLabel: "Minutes",
			routingMixedHeading: "China + Global mixed order",
			routingMixedBody: "This order mixes accounts from both variants. A model that exists in only one variant cannot be served when the walk lands on the other one.",
			routingMixedOffenders: "Models enabled on only one side:",
			routingMixedOffenderCN: "China only: {models}",
			routingMixedOffenderGlobal: "Global only: {models}"
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
			checkInClaimedToday: "今日已签到",
			checkInChecking: "正在领取…",
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
			accountsHeading: "已保存的账号",
			accountsHint: "请求会依次使用可用的账号，顺序即保存顺序。切换账号会更换计费所归属的套餐。",
			accountsSwitchHint: "点击账号名称切换",
			accountsFailoverOn: "自动切换已开启",
			accountsFailoverOff: "自动切换已关闭",
			accountsFailoverIdle: "自动切换待命（仅 1 个可用账号）",
			accountsLastFailover: "最近一次自动切换：{time}",
			accountsLastFailoverReason: "原因：{reason}",
			accountSlot: "账号 {order}",
			accountAdd: "添加账号",
			accountSwitch: "切换使用",
			accountSwitchAria: "切换使用账号 {name}",
			accountRemoveAria: "删除账号 {name}",
			accountRemoveConfirm: "确定删除该账号？",
			accountRemoveConfirmYes: "确认删除",
			accountSwitched: "已切换到 {name}。",
			accountRemoved: "账号已删除。",
			accountActionFailed: "账号操作未生效：{message}",
			upstreamNoticeKindQueued: "排队中",
			upstreamNoticeKindUnavailable: "服务繁忙",
			upstreamNoticeHeading: "上游模型暂不可用",
			upstreamNoticeAt: "上报时间：{time}",
			upstreamNoticeMessage: "上游返回：{message}",
			upstreamNoticeWaited: "插件已按上游要求等待 {seconds} 秒并重试，仍不可用。",
			upstreamNoticeWaitedNoDelay: "插件已等待并重试，仍不可用。",
			upstreamNoticeRetry: "建议约 {seconds} 秒后重试。",
			upstreamNoticeNotAuth: "这不是凭证问题 — 重新保存 PAT 也无济于事。",
			upstreamNoticeAdvice: "通常会自行恢复，稍等片刻再试即可。",
			upstreamNoticeRecurrence: "本次会话已出现 {count} 次",
			quotaSectionAdvanced: "高级设置",
			settingsLoading: "正在从插件宿主读取设置… 在宿主应答前下方控件不可用。",
			settingsUnavailable: "无法从插件宿主读取设置：{message}。下方控件已禁用；刷新页面可重试。",
			settingsWriteFailed: "插件宿主拒绝了这次修改：{message}。界面上显示的值仍是已保存的值。",
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
			effortsHeading: "思考强度",
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
			autoCheckInHintCN: "每天自动签到，活动期间为国内版和国际版账号领取 100 Credits 算力额度。",
			autoCheckInHintGlobal: "每天自动签到，活动期间为国内版和国际版账号领取 100 Credits 算力额度。",
			checkInTimeHint: "每天执行自动签到的时刻，按北京时间（UTC+8）于每日 10:00 刷新。",
			autoCheckInStatusClaimed: "今日已自动签到（+{amount} Credits）",
			autoCheckInStatusAlready: "今日已完成签到",
			autoCheckInStatusNoCampaign: "今日无可用签到福利活动",
			checkInNeedsClient: "每日签到需要本机安装 Qoder 桌面客户端：国际版只对携带客户端设备身份的请求下发该活动。安装 Qoder 后重试即可。",
			autoCheckInStatusError: "自动签到出错：{message}",
			quotaSignInRequired: "请先为该变体保存 PAT，再开启此开关。",
			quotaPollLabel: "积分刷新间隔",
			quotaPollHint: "剩余积分标签的刷新频率，间隔越长对计费接口越友好。",
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
			quotaColExpiry: "到期时间",
			quotaChipAria: "Qoder 额度读数",
			quotaChipCN: "Qoder",
			quotaChipGlobal: "Qoder Global",
			quotaPanelAutoRefresh: "每 {minutes} 分钟自动刷新",
			quotaPanelEmpty: "暂无额度数据",
			modelsUnsavedCount: "未保存 {count} 项",
			modelsBatchSaveHint: "改动会在保存后生效。",
			saveChanges: "保存设置",
			savingChanges: "正在保存…",
			cancelChanges: "取消",
			modelsSaved: "已保存。",
			modelsSaveFailed: "保存失败：{message}",
			contextWindowAria: "上下文窗口大小",
			variantSwitcherAria: "Qoder 版本",
			quotaReadoutEnabledLabel: "对话框显示积分",
			quotaReadoutEnabledDesc: "在输入框工具条上展示剩余积分，点击可展开明细面板。",
			checkInTime: "签到时间",
			modelEffortsDefault: "default {name}",
			effortMinimal: "minimal",
			effortLow: "low",
			effortMedium: "medium",
			effortHigh: "high",
			effortXhigh: "xhigh",
			effortMax: "max",
			effortsUnsupported: "not supported",
			accountCurrent: "当前使用",
			creditsRemaining: "剩余积分",
			checkInStatus: "签到状态",
			checkInNotClaimed: "今日未签到",
			checkInAll: "一键签到",
			accountEnabledLabel: "参与自动切换",
			accountEnabledAria: "将账号 {name} 纳入自动切换",
			accountEnabledNotice: "{name} 已纳入自动切换。",
			accountParkedNotice: "{name} 已停用，自动切换将不再尝试该账号。",
			accountParked: "已停用",
			accountCreditsValue: "剩余 {value}",
			accountCreditsParked: "不计入",
			accountCreditsUnknown: "积分未知",
			accountHealthAria: "账号健康状态",
			accountHealthNormal: "正常",
			accountHealthQueued: "排队",
			accountHealthLimited: "限流",
			accountHealthUnknown: "尚未观测",
			innerErrorsHeading: "上游流内错误（本进程）",
			innerErrorsContentPolicy: "内容策略",
			innerErrorsRateLimit: "限流",
			innerErrorsInvalidRequest: "无效请求",
			innerErrorsAuth: "认证",
			innerErrorsOther: "其他",
			autoFailoverLabel: "账号自动切换",
			autoFailoverHint: "请求连接失败时自动改用下一个已保存账号；关闭后所有请求固定使用当前账号。",
			queueWaitAttemptsLabel: "排队重试次数",
			queueWaitAttemptsHint: "单个请求最多等待排队几次，用完才报错；换号不会重置该次数；0 表示立即报错。",
			queueWaitSecondsLabel: "排队等待秒数",
			queueWaitSecondsHint: "每次排队重试的回退等待时间，仅在上游未给出建议时生效；上游给出建议窗口时优先按建议等待，实际再加 1–3 秒随机抖动，总等待不超过 5 分钟。",
			queueWaitSecondsUnit: "秒",
			routingStrategyLabel: "路由策略",
			routingStrategyHint: "保存顺序按上方列表先后；自定义顺序按你下面设置的优先级。",
			routingStrategySaveOrder: "保存顺序",
			routingStrategyCustom: "自定义顺序",
			routingOrderHeading: "自定义优先级",
			routingOrderHint: "按从上到下依次尝试；列表可以同时包含国内版与国际版账号。",
			routingOrderMissing: "还没有可排序的账号。",
			routingOrderMoveUp: "上移",
			routingOrderMoveUpAria: "将 {name} 上移",
			routingOrderMoveDown: "下移",
			routingOrderMoveDownAria: "将 {name} 下移",
			stickinessLabel: "会话粘性",
			stickinessHint: "开启后，同一会话先由同一个账号服务，达到下面任一条限制后自动换到下一个账号；一轮 = 一次对话的模型输出完整结束，0 表示该项不限制。",
			stickinessToggleHint: "关闭后每次请求都重新挑选账号，不再固定在同一账号上。",
			stickinessRoundsLabel: "轮数",
			stickinessRequestsLabel: "请求次数",
			stickinessMinutesLabel: "分钟",
			routingMixedHeading: "国内版与国际版混排",
			routingMixedBody: "该顺序混排了两个版本的账号。仅存在于其中一个版本的模型，在轮到另一个版本时将无法使用。",
			routingMixedOffenders: "目前只在一个版本启用的模型：",
			routingMixedOffenderCN: "仅国内版：{models}",
			routingMixedOffenderGlobal: "仅国际版：{models}"
		};
		//#endregion
		//#region src/client/index.tsx
		/** Stable browser-plugin name. */
		const name = "dsh-qoder-plugin-client";
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
		/**
		* The profile ROW ID this plugin runs as — the id its own patch declares.
		*
		* `cordis.patch.yml` inserts `- id: qoder-plugin, name: dsh-qoder-plugin`, so
		* the Plugins page reports this plugin's row as `qoder-plugin`. The browser half
		* needs it for exactly one thing: the right half of {@link ROW_CONFIG_KEY}.
		*/
		const ENTRY_ID = "qoder-plugin";
		/**
		* The two 0.1.7 seats this card registers into, on the Plugins page.
		*
		* Both are KEYED slots declared by `@deepseek-ai/dsh-client-ui-plugin-manager`
		* (`packages/client/ui-plugin-manager/src/client/slot-contract.ts`) and both
		* receive the same card component; only the key differs:
		*
		*   - `plugins.row.config`, keyed `<package name>#<row id>`, is the PRIMARY seat.
		*     Hitting it is what makes the Plugins page put a 「配置」 control on this
		*     plugin's row, and clicking that opens this card as the row's own page.
		*   - `plugins.bundle.config`, keyed by PACKAGE NAME alone, renders inline on the
		*     package detail page between the description and the row list.
		*/
		const ROW_CONFIG_SLOT = "plugins.row.config";
		const BUNDLE_CONFIG_SLOT = "plugins.bundle.config";
		/** This plugin's package name — the `plugins.bundle.config` key, and the left half of the row key. */
		const PACKAGE_NAME = "dsh-qoder-plugin";
		/** The complete `plugins.row.config` key (`` `${pkg.name}#${rowId}` ``). */
		const ROW_CONFIG_KEY = `${PACKAGE_NAME}#${ENTRY_ID}`;
		/**
		* Register card copy, the unified Qoder card on both Plugins-page seats, the
		* composer quota readout, and the context-window probe.
		*
		* The entire body is wrapped so that a DSH slot-API breaking change (for
		* example the rc.6→rc.7 `id`→`key` / `order`→`priority` rename) degrades
		* to a `console.error` instead of throwing into the DSH loader and raising
		* the red "Failed to load plugins" banner. The host provider keeps working:
		* the `qoder` model channel is unaffected, and `dsh-qoder-plugin
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
				}), "dsh-qoder-plugin: settings copy");
				const t = ctx.locale.bind(namespace);
				/**
				* The bound quota settings face, filled in as soon as this plugin's own
				* settings file answers (see {@link OwnQuotaSettingsScope}).
				*
				* It is bound on a STORED fact rather than when the card's inject factory
				* first runs: the factory only executes while the Plugins page renders, so a
				* fresh page load read no toggles and rendered no readout until the user
				* opened that page. The face's subscription mirrors the poll interval into
				* the shared store the composer readout reads; a deployment where the host
				* route never answers never binds, and the readout falls back to its
				* default interval.
				*/
				let quotaScope;
				const adoptQuotaScope = (scope) => {
					quotaScope = scope;
					const applySnapshot = () => {
						const value = scope.getSnapshot().value;
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
						console.error(`[dsh-qoder-plugin] card slot "${slot}" failed to register (host provider unaffected):`, error);
					}
				};
				registerCard(ROW_CONFIG_SLOT, ROW_CONFIG_KEY);
				registerCard(BUNDLE_CONFIG_SLOT, PACKAGE_NAME);
				/**
				* Own the `qoder` command row in the conversation.
				*
				* The queue notices and the job-token heal lines are logged as command rows
				* named `qoder` (`src/job-token-hint.ts`). The host renders an unclaimed
				* command name with its generic card, whose summary span is
				* `white-space: nowrap` with an ellipsis — the notice's tail (queue length,
				* retry count) was cut off. Claiming the key replaces only this plugin's own
				* rows; every other command keeps the generic card. `replaceRisk: none` is
				* the owner's own note for this seat, and `keyDomain` reports `qoder` free.
				*
				* The key MIRRORS `JOB_TOKEN_HINT_NAME` in `src/job-token-hint.ts` — the
				* host half's literal `'qoder'`. It is duplicated rather than imported for
				* the same reason `ENTRY_ID` above mirrors the patch row id: the client
				* bundle stays free of host modules (that one imports the cordis server
				* context), and the pinned test suite keeps the two literals in step.
				*/
				const NOTICE_ROW_SLOT = "conversation.chat.commandview";
				const NOTICE_ROW_KEY = "qoder";
				try {
					ctx.slots.inject(NOTICE_ROW_SLOT, () => ctx.slots.register({
						name: NOTICE_ROW_SLOT,
						key: NOTICE_ROW_KEY,
						inject: () => ({})
					}, QoderQueueNoticeRow));
				} catch (error) {
					console.error(`[dsh-qoder-plugin] command row "${NOTICE_ROW_SLOT}" failed to register (host provider unaffected):`, error);
				}
				/**
				* 插件自有配置（`<profile>/.dsh-qoder-plugin/settings.json`）：两条宿主线的
				* 读写都走宿主半的 settings face，不再经过 settingsScope / configForms。
				*
				* 0.1.7 的 configForms 写入会整树 reconcile + fiber 热重载（每次约
				* 1~1.5 秒，且每次保存都刷新所有客户端镜像）；自有文件写入是本地毫秒级
				* 原子写。卡片注册无条件进行：scope 在启动时载入，迟到也不会漏掉 UI。
				*/
				const ownQuotaScope = new OwnQuotaSettingsScope();
				ownQuotaScope.load();
				adoptQuotaScope(ownQuotaScope);
				ctx.effect(() => injectQuotaCss(), "dsh-qoder-plugin: quota styles");
				ctx.inject(["modelDirectories"], (scope) => {
					try {
						scope.slots.inject("conversation.input.left", () => scope.slots.register({
							name: "conversation.input.left",
							id: "qoder-quota-readout",
							order: 5,
							inject: (sessionId) => ({
								directory: scope.modelDirectories.directoryFor(sessionId).store,
								t
							})
						}, ComposerQuotaChip));
					} catch (error) {
						console.error("[dsh-qoder-plugin] could not register the composer quota readout:", error);
					}
				});
				ctx.inject(["modelDirectories"], (scope) => {
					try {
						scope.slots.inject("conversation.input.right", () => scope.slots.register({
							name: "conversation.input.right",
							id: "qoder-probe",
							order: 10,
							inject: (sessionId) => ({
								directory: scope.modelDirectories.directoryFor(sessionId).store,
								t
							})
						}, QoderProbeControl));
					} catch (error) {
						console.error("[dsh-qoder-plugin] could not register the context probe:", error);
					}
				});
			} catch (error) {
				console.error("[dsh-qoder-plugin] client card failed to load (host provider unaffected):", error);
			}
		}
		//#endregion
		exports.apply = apply;
		exports.inject = inject;
		exports.name = name;
		return module.exports;
	}
});
