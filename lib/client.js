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
		/**
		* Context-window slider: a thick filled rail with a narrow vertical grab handle
		* at the fill's edge (the Qoder model-settings look). Pointer drags anywhere on
		* the surface jump and follow the pointer; arrows, PageUp/PageDown and Home/End
		* keep it keyboard operable. With `snapTo` the value always anchors to one of
		* the offered windows instead of a free number. The component is fully
		* controlled — it never writes anything by itself.
		*/
		function QdpSlider({ label, value, min, max, step = 1e3, disabled, onChange, valueText, ticks, format, snapTo, testId }) {
			const formatValue = (raw) => format !== void 0 ? format(raw) : raw === value && valueText !== void 0 ? valueText : String(raw);
			const percentOf = (raw) => span > 0 ? Math.min(100, Math.max(0, (raw - min) / span * 100)) : 0;
			const trackRef = (0, react.useRef)(null);
			const span = max > min ? max - min : 0;
			const ratio = span > 0 ? Math.min(1, Math.max(0, (value - min) / span)) : 0;
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
			const fromClientX = (0, react.useCallback)((clientX) => {
				const element = trackRef.current;
				if (element === null) return;
				const rect = element.getBoundingClientRect();
				const share = rect.width > 0 ? (clientX - rect.left) / rect.width : 0;
				onChange(snap(min + Math.min(1, Math.max(0, share)) * span));
			}, [
				max,
				min,
				onChange,
				snap,
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
			const release = (event) => {
				if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
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
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: "qdp-sliderField",
				"data-testid": testId,
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
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
					children: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "qdp-sliderTrack",
						ref: trackRef,
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
							className: "qdp-sliderFill",
							style: { width: `${(ratio * 100).toFixed(2)}%` }
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							className: "qdp-sliderThumb",
							style: { left: `${(ratio * 100).toFixed(2)}%` }
						})]
					})
				}), ticks !== void 0 && ticks.length > 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
					className: "qdp-windowTicks",
					children: ticks.map((tick) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						className: "qdp-windowTick",
						style: { left: `${percentOf(tick).toFixed(2)}%` },
						children: formatValue(tick)
					}, tick))
				})]
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
		const MODEL_TIER = [
			"auto",
			"ultimate",
			"performance",
			"cmodel",
			"efficient",
			"lite"
		];
		const tierOf = (id) => {
			const tier = MODEL_TIER.indexOf(id);
			return tier === -1 ? MODEL_TIER.length : tier;
		};
		const capabilityOf = (model) => model.defaultContextWindow ?? model.contextWindow ?? 0;
		function orderModels(models) {
			return [...models ?? []].sort((a, b) => {
				const byTier = tierOf(a.id) - tierOf(b.id);
				if (byTier !== 0) return byTier;
				const byCapability = capabilityOf(b) - capabilityOf(a);
				return byCapability !== 0 ? byCapability : a.id.localeCompare(b.id);
			});
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
		* Marks under a row's track: the model's declared windows plus both axis ends,
		* so the shared scale stays readable (contract: min on the left, axisMax on the
		* right). The endpoint labels are the same on every row, which is what lets a
		* 400K on one row line up with a 400K on the next.
		*/
		function rowTicks(model, min, max) {
			const declared = declaredWindows(model);
			const marks = declared.length > 0 ? [
				min,
				...declared,
				max
			] : [min, max];
			return [...new Set(marks)].filter((value) => value >= min && value <= max).sort((a, b) => a - b);
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
					model.priceFactor ?? null
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
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: t("contextHeading") })
						]
					}), list.map((model) => {
						const inputId = `qdp-model-${model.id}`;
						const enabled = !draft.disabled.includes(model.id);
						const baseline = rowWindow(model);
						const value = draft.windows[model.id] ?? baseline;
						const current = value === void 0 ? void 0 : clampWindow(value, minWindow, axisMax);
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
										...model.supportedContextWindows === void 0 ? {} : { snapTo: model.supportedContextWindows },
										ticks: rowTicks(model, minWindow, axisMax),
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
							disabled: saving,
							onClick: saveDraft,
							children: saving ? t("savingChanges") : t("saveChanges")
						})]
					})]
				}) : null]
			});
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
		/** Pre-0.5.0 key (the plugin's former package name); read once and migrated to {@link READOUT_STORAGE_KEY}. */
		const LEGACY_READOUT_STORAGE_KEY = "dsh-connect-qoder-x:readout";
		/** The all-on state used when nothing (or nothing valid) was stored. */
		function defaultQuotaReadout() {
			return {
				enabled: true,
				cn: true,
				global: true
			};
		}
		/** A stored flag counts as on unless it was explicitly `false`. */
		function readoutFlag(stored) {
			return stored !== false;
		}
		/**
		* The browser storage, or undefined when there is none or access is blocked
		* (non-browser runtime, private mode, disabled site data). Every access is
		* wrapped: `window.localStorage` itself can throw when storage is disabled.
		*/
		function readoutStorage() {
			try {
				if (typeof window === "undefined" || window.localStorage === void 0) return void 0;
				return window.localStorage;
			} catch {
				return;
			}
		}
		/** Read the persisted switches once; missing/invalid storage means all-on. */
		function loadQuotaReadout() {
			const storage = readoutStorage();
			if (storage === void 0) return defaultQuotaReadout();
			try {
				const raw = storage.getItem(READOUT_STORAGE_KEY) ?? storage.getItem(LEGACY_READOUT_STORAGE_KEY);
				if (raw === null) return defaultQuotaReadout();
				const parsed = JSON.parse(raw);
				if (typeof parsed !== "object" || parsed === null) return defaultQuotaReadout();
				const stored = parsed;
				const state = {
					enabled: readoutFlag(stored.enabled),
					cn: readoutFlag(stored.cn),
					global: readoutFlag(stored.global)
				};
				if (storage.getItem(READOUT_STORAGE_KEY) === null) {
					storage.setItem(READOUT_STORAGE_KEY, JSON.stringify(state));
					storage.removeItem(LEGACY_READOUT_STORAGE_KEY);
				}
				return state;
			} catch {
				return defaultQuotaReadout();
			}
		}
		/** Persist the switches; a blocked/full store only costs the preference. */
		function persistQuotaReadout(state) {
			const storage = readoutStorage();
			if (storage === void 0) return;
			try {
				storage.setItem(READOUT_STORAGE_KEY, JSON.stringify(state));
			} catch {}
		}
		let readout = loadQuotaReadout();
		let readoutSnapshot = { ...readout };
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
		/**
		* Update the composer-readout switches.
		*
		* This is a CLIENT-SIDE preference (see {@link READOUT_STORAGE_KEY}), not a
		* settings-file write: it persists to localStorage, bumps the revision so
		* every composer chip re-renders, and never touches the host document.
		*/
		function setQuotaReadout(enabled, cn, global) {
			if (readout.enabled !== enabled || readout.cn !== cn || readout.global !== global) {
				readout = {
					enabled,
					cn,
					global
				};
				readoutSnapshot = { ...readout };
				persistQuotaReadout(readout);
				bump();
			}
		}
		/** Read the composer-readout switches. */
		function quotaReadout() {
			return readoutSnapshot;
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
		/**
		* Manual grants carry no upstream expiry; the campaign's own rule is 30 days
		* from the claim. Kept as one constant so a campaign-rule change is one edit.
		*/
		const MANUAL_GRANT_VALIDITY_MS = 2592e6;
		/** 10:00 UTC+8, the upstream campaign's reset moment (mirrors QuotaSettingsCard). */
		const CHECK_IN_MINUTE_DEFAULT = 600;
		/** Default billing-endpoint poll period, in milliseconds (mirrors the settings face). */
		const POLL_DEFAULT_MS = 3e5;
		/** The face clamps the poll interval at one minute. */
		const POLL_MIN_MS = 6e4;
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
			minuteCN: CHECK_IN_MINUTE_DEFAULT,
			minuteGlobal: CHECK_IN_MINUTE_DEFAULT,
			pollMs: POLL_DEFAULT_MS,
			status: "unavailable",
			writable: false
		};
		/**
		* Read the check-in half of the settings face as a STABLE STRING.
		*
		* `useSyncExternalStore`'s getSnapshot must return the same reference between
		* renders unless the store changed. The face's value is a fresh object per
		* accepted document, so projecting it directly would re-render forever
		* (React #185); the JSON string below is stable by construction, and is parsed
		* back into the fields the card actually renders.
		*
		* The readout switches are deliberately NOT projected here: they are a
		* client-side preference (the shipped host's settings face rejects the field),
		* so they live in the shared store and are read directly by the advanced card.
		*/
		function settingsKeyOf(scope) {
			if (scope === void 0) return "unavailable";
			const snapshot = scope.getSnapshot();
			const value = snapshot.value ?? {};
			return JSON.stringify([
				value.autoCheckInCN === true,
				value.autoCheckInGlobal === true,
				typeof value.checkInMinuteCN === "number" ? value.checkInMinuteCN : CHECK_IN_MINUTE_DEFAULT,
				typeof value.checkInMinuteGlobal === "number" ? value.checkInMinuteGlobal : CHECK_IN_MINUTE_DEFAULT,
				snapshot.status,
				snapshot.writable,
				typeof value.quotaPollMs === "number" ? value.quotaPollMs : POLL_DEFAULT_MS
			]);
		}
		function parseSettingsKey(raw) {
			if (raw === "unavailable") return UNAVAILABLE_SETTINGS;
			try {
				const parsed = JSON.parse(raw);
				if (!Array.isArray(parsed) || parsed.length < 6) return UNAVAILABLE_SETTINGS;
				const autoCN = parsed[0] === true;
				const autoGlobal = parsed[1] === true;
				const minuteCN = typeof parsed[2] === "number" ? parsed[2] : CHECK_IN_MINUTE_DEFAULT;
				const minuteGlobal = typeof parsed[3] === "number" ? parsed[3] : CHECK_IN_MINUTE_DEFAULT;
				const status = parsed[4] === "ready" || parsed[4] === "loading" ? parsed[4] : "unavailable";
				return {
					autoCN,
					autoGlobal,
					minuteCN,
					minuteGlobal,
					pollMs: typeof parsed[6] === "number" ? parsed[6] : POLL_DEFAULT_MS,
					status,
					writable: parsed[5] === true
				};
			} catch {
				return UNAVAILABLE_SETTINGS;
			}
		}
		/**
		* Render the Qoder account, check-in, model and advanced-settings sections as
		* the Plugins page's configuration page (or its one-liner, when the owner asks
		* for `summary`).
		*
		* On `page` this component renders the configuration BODY only: the Plugins
		* page draws the breadcrumb, icon, title, version and description, so no shell
		* chrome or second title lives here. The page is a grid of four cards:
		*
		* 1. 账号 — variant switcher, one compact status row, credential row, PAT entry
		* 2. 签到 — today's claim row + recent-grants row + a capped ledger list
		* 3. 模型 — catalogue provenance + refresh, then the models pane body
		* 4. 高级设置 — auto check-in, its UTC+8 time, quota-readout switches, poll interval
		*
		* A signed-out account renders 账号 (with the PAT entry) and 高级设置 only:
		* check-in and model preferences for an account nobody is signed into would be
		* settings the user cannot exercise yet.
		*/
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
			/** The check-in half of the settings face, as a stable projection string. */
			const settingsSubscribe = (0, react.useCallback)((onStoreChange) => {
				return scope?.subscribe(onStoreChange) ?? (() => {});
			}, [scope]);
			const settings = parseSettingsKey((0, react.useSyncExternalStore)(settingsSubscribe, () => settingsKeyOf(scope)));
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
			/** 「删除 PAT」的内联确认：点一次进入确认，再点一次才真正清除。 */
			const [confirmingClear, setConfirmingClear] = (0, react.useState)(false);
			/** The model pane's batched save: its own busy flag, separate from a refresh. */
			const [savingModels, setSavingModels] = (0, react.useState)(false);
			const [modelsSaveError, setModelsSaveError] = (0, react.useState)();
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
				setConfirmingClear(false);
				setCheckInNotice(void 0);
				setCheckInNotice(void 0);
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
			const settingsSignedIn = reported !== void 0 ? Boolean(reported[settingsVariant]) : Boolean(liveSignIn[settingsVariant]);
			const autoCheckInOn = settingsVariant === "cn" ? settings.autoCN : settings.autoGlobal;
			const checkInMinute = settingsVariant === "cn" ? settings.minuteCN : settings.minuteGlobal;
			const readoutEnabled = readout.enabled;
			const readoutCN = readout.cn;
			const readoutGlobal = readout.global;
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
			* The automatic check-in controls write the same fields the advanced card
			* always wrote; a variant with no PAT cannot arm a timer it could never fire,
			* so the switch stays disabled until that variant signs in.
			*/
			const writeAutoCheckIn = (next) => {
				if (!settingsSignedIn) return;
				writeSetting(settingsVariant === "cn" ? "autoCheckInCN" : "autoCheckInGlobal", next);
			};
			const writeCheckInMinute = (minutes) => {
				if (!settingsSignedIn) return;
				writeSetting(settingsVariant === "cn" ? "checkInMinuteCN" : "checkInMinuteGlobal", minutes);
			};
			/**
			* The three readout switches are NOT gated on sign-in: they describe what the
			* composer chip should show, and a user configuring the plugin before signing
			* in must still be able to hide a variant they never signed into. Only the
			* master switch gates the two variant switches.
			*
			* They write the shared STORE, not the settings scope: the shipped host's
			* settings face rejects `quotaReadoutEnabled` (HTTP 400 unknown field), and a
			* host restart is not available. `setQuotaReadout` bumps the store's revision
			* synchronously, so the card re-renders from the store; the master toggle
			* carries the two per-variant values through unchanged.
			*/
			const writeReadoutEnabled = (next) => {
				setQuotaReadout(next, readout.cn, readout.global);
			};
			const writeReadoutCN = (next) => {
				if (!readout.enabled) return;
				setQuotaReadout(readout.enabled, next, readout.global);
			};
			const writeReadoutGlobal = (next) => {
				if (!readout.enabled) return;
				setQuotaReadout(readout.enabled, readout.cn, next);
			};
			const writePollMinutes = (minutes) => {
				writeSetting("quotaPollMs", Math.max(POLL_MIN_MS, minutes * 6e4));
			};
			const checkIn = signedInDoc?.checkIn;
			const now = Date.now();
			/**
			* Today's benefit is already in — whether this process granted it or merely
			* found the upstream reporting it as claimed.
			*
			* `already-claimed` must count: the upstream answers that way for every later
			* request on a claimed day, so treating only `claimed` as "done" re-armed the
			* button and invited the repeat click that appended a phantom ledger row. The
			* DATE must count too — `checkIn` is the persisted record, not a live reading,
			* and `today` is stamped host-side in UTC+8 (the day the scheduler uses), so a
			* `claimed` row from three days ago no longer disables today's button.
			*/
			const claimedToday = checkIn !== void 0 && checkIn.lastDate === checkIn.today && (checkIn.status === "claimed" || checkIn.status === "already-claimed");
			const effectiveExpiryOf = (entry) => entry.expiresAtMs ?? entry.timestamp + MANUAL_GRANT_VALIDITY_MS;
			const claimedLogs = (checkIn?.logs ?? []).filter((entry) => entry.status === "claimed").sort((a, b) => b.timestamp - a.timestamp);
			const latestLog = claimedLogs[0];
			const latestExpiry = latestLog === void 0 ? void 0 : effectiveExpiryOf(latestLog);
			const ledgerExpiryText = latestLog === void 0 ? t("ledgerEmpty") : latestExpiry === void 0 ? "" : latestExpiry <= now ? t("ledgerExpired") : t("ledgerExpiresAt", { date: formatDate(latestExpiry) });
			const ledgerSummary = claimedLogs.length === 0 ? t("ledgerEmpty") : `${t("ledgerCount", { count: claimedLogs.length })} · ${ledgerExpiryText}`;
			const nextRunCaption = autoCheckInOn && checkIn?.nextRunAt !== void 0 ? t("checkInNextRun", { time: formatTime(checkIn.nextRunAt) }) : void 0;
			const catalogCaption = signedInDoc === void 0 ? void 0 : catalogCaptionOf(signedInDoc.catalog, t);
			const credentialMeta = signedInDoc?.pat === void 0 ? void 0 : [
				patSourceText(signedInDoc.pat.source, t),
				signedInDoc.pat.savedAtMs === void 0 ? null : t("patSavedAt", { time: formatTime(signedInDoc.pat.savedAtMs) }),
				signedInDoc.pat.patTail === void 0 ? null : t("patTail", { tail: `****${signedInDoc.pat.patTail}` })
			].filter((part) => part !== null).join(" · ");
			const signedOutStatus = status?.status === "signed-out" ? status : void 0;
			const patEntryOpen = replacing || signedOutStatus !== void 0;
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
										label: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(QdpStateDot, { state: cnDotState }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: t("variantTabCN") })] })
									}, {
										value: "qoder-global",
										label: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(QdpStateDot, { state: globalDotState }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: t("variantTabGlobal") })] })
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
								signedInDoc?.pat === void 0 || replacing ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
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
											variant: "ghost",
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
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
							className: "qdp-sectionHead",
							children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("h2", {
								className: "qdp-sectionTitle",
								children: t("quotaSectionUsage")
							})
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: "qdp-sectionBody",
							children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
									className: "qdp-row",
									children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
										className: "qdp-rowText",
										children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
											className: "qdp-rowTitle",
											children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(QdpStateDot, { state: claimedToday ? "done" : "idle" }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: t("checkInTodayTitle") })]
										}), nextRunCaption === void 0 ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
											className: "qdp-rowDesc",
											children: nextRunCaption
										})]
									}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
										className: "qdp-rowControl",
										children: claimedToday ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)(QdpTag, {
											tone: "success",
											children: t("checkInClaimedToday")
										}) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)(QdpButton, {
											variant: "primary",
											disabled: busy || checkingIn,
											onClick: () => {
												manualCheckIn();
											},
											children: checkingIn ? t("checkInChecking") : t("checkInNow")
										})
									})]
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
									className: "qdp-row",
									children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
										className: "qdp-rowText",
										children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
											className: "qdp-rowTitle",
											children: t("ledgerHeading")
										}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
											className: "qdp-rowDesc",
											children: ledgerSummary
										})]
									}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
										className: "qdp-rowControl",
										children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(QdpButton, {
											variant: "ghost",
											size: "sm",
											disabled: clearingLogs || claimedLogs.length === 0,
											onClick: () => {
												clearCheckInLogs();
											},
											children: clearingLogs ? t("checkInClearing") : t("checkInClear")
										})
									})]
								}),
								claimedLogs.length === 0 ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
									className: "qdp-logList",
									children: claimedLogs.map((entry) => {
										const expiry = effectiveExpiryOf(entry);
										const expired = expiry <= now;
										return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
											className: "qdp-logRow",
											children: [
												/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
													className: "qdp-muted",
													children: formatTime(entry.timestamp)
												}),
												/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
													className: "qdp-num",
													children: entry.amount === void 0 ? "—" : `+${String(entry.amount)}`
												}),
												/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
													className: expired ? "qdp-error" : "qdp-caption",
													children: expired ? t("ledgerExpired") : t("ledgerExpiresAt", { date: formatDate(expiry) })
												})
											]
										}, entry.id);
									})
								}),
								checkInNotice === void 0 ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
									className: "qdp-body",
									children: checkInNotice
								})
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
									variant: "ghost",
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
											children: settingsVariant === "cn" ? t("checkInTimeCN") : t("checkInTimeGlobal")
										}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
											className: "qdp-rowDesc",
											children: t("checkInTimeHint")
										})]
									}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
										className: "qdp-rowControl",
										children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(CheckInTimeRow, {
											label: settingsVariant === "cn" ? t("checkInTimeCN") : t("checkInTimeGlobal"),
											value: checkInMinute,
											disabled: !settingsSignedIn || !autoCheckInOn,
											onPick: writeCheckInMinute
										})
									})]
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
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
									className: "qdp-row",
									children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
										className: "qdp-rowText",
										children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
											className: "qdp-rowTitle",
											children: t("quotaReadoutCNLabel")
										}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
											className: "qdp-rowDesc",
											children: t("quotaReadoutCNDesc")
										})]
									}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
										className: "qdp-rowControl",
										children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(QdpSwitch, {
											checked: readoutCN,
											disabled: !readoutEnabled,
											label: t("quotaReadoutCNLabel"),
											onChange: writeReadoutCN
										})
									})]
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
									className: "qdp-row",
									children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
										className: "qdp-rowText",
										children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
											className: "qdp-rowTitle",
											children: t("quotaReadoutGlobalLabel")
										}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
											className: "qdp-rowDesc",
											children: t("quotaReadoutGlobalDesc")
										})]
									}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
										className: "qdp-rowControl",
										children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(QdpSwitch, {
											checked: readoutGlobal,
											disabled: !readoutEnabled,
											label: t("quotaReadoutGlobalLabel"),
											onChange: writeReadoutGlobal
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
										children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(QdpInput, {
											className: "qdp-inputShort",
											type: "number",
											min: 1,
											step: 1,
											value: pollMinutes,
											"aria-label": t("quotaPollLabel"),
											onChange: (event) => {
												const minutes = Number.parseInt(event.target.value, 10);
												if (Number.isFinite(minutes) && minutes >= 1) writePollMinutes(minutes);
											}
										}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
											className: "qdp-caption",
											children: t("quotaPollUnit")
										})]
									})]
								}),
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
		//#region src/client/quota-merge.ts
		/** Clamp helper shared by the card's percent math. */
		function clampPercent(remain, size) {
			if (!(size > 0)) return void 0;
			const percent = remain / size * 100;
			if (!Number.isFinite(percent)) return void 0;
			return Math.min(100, Math.max(0, percent));
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
		* and the chip disappears when that variant's readout switch is off.
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
		* Distill a credits document into the numbers the chip and the panel show.
		*
		* "Unlimited" means "there is nothing to count", not "the upstream flagged it":
		* live documents report `credits.unlimited: true` while still carrying real
		* per-package sizes (the CN gift plan), and treating the flag alone as unlimited
		* hid thousands of remaining credits behind 不限量. The rule (m01963 item 5):
		* unlimited only when `Σ account.size <= 0`; otherwise `Σ remain / Σ size`,
		* falling back to `credits.totalSize` when every package reports size 0.
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
		/**
		* The chip's remaining-credit readout: a number, "Unlimited", or an em dash.
		*
		* The em dash is the not-ready state (no document yet, signed out, or an
		* upstream error document) rather than "0", which would claim an empty account.
		*/
		function chipReadout(status, t) {
			if (status === void 0 || status.status !== "signed-in") return "—";
			const credits = status.credits;
			if (credits === void 0) return "—";
			const summary = creditSummary(credits);
			return summary.unlimited ? t("quotaUnlimited") : formatNumber(summary.remain);
		}
		/**
		* Project a status document into the row's figures.
		*
		* `undefined` means "no figures to draw" (no document, signed out, or the
		* upstream error arm) — the row renders an empty/error state instead of
		* inventing zeroes. The credit figures follow {@link creditSummary}; the
		* denominator is the summed package size (the reported total only when the
		* packages carry no size at all).
		*/
		function variantFigures(status) {
			if (status === void 0 || status.status !== "signed-in") return void 0;
			const credits = status.credits;
			if (credits === void 0) return void 0;
			const summary = creditSummary(credits);
			return {
				planName: status.plan?.planTierName,
				unlimited: summary.unlimited,
				remain: summary.remain,
				total: summary.total,
				percent: summary.unlimited ? void 0 : clampPercent(summary.remain, summary.total),
				expiry: credits.cycleResetTime ?? status.plan?.endDate
			};
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
				}) : /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						className: "qdp-popBar",
						children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
							className: cx("qdp-popBarFill", figures.percent !== void 0 && figures.percent < WARN_PERCENT && "qdp-popWarn"),
							style: { width: `${figures.percent === void 0 ? 100 : Math.max(2, figures.percent)}%` }
						})
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						className: "qdp-popCaption",
						children: captionText(figures, t)
					}),
					failed || failedDocument ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
						className: "qdp-alert qdp-alertError",
						children: t("quotaError")
					}) : null
				] })]
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
			const variantEnabled = card.id === "qoder-global" ? readout.global : readout.cn;
			return readout.enabled && variantEnabled ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)(ComposerQuota, {
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
			const currentStatus = quotaStatus(card.id);
			const name = t(chipNameKey(card));
			const readout = chipReadout(currentStatus, t);
			const fetchedAt = quotaStatusFetchedAt(card.id);
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
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						className: "qdp-popList",
						children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(VariantRow, {
							card,
							status: currentStatus,
							failed,
							t
						})
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
		//#region src/client/http-settings-scope.ts
		/** Base path of the host half's settings face. */
		const ROUTE_BASE = "/plugins/dsh-qoder-plugin";
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
		//#region src/client/quota-styles.ts
		/**
		* The plugin's single stylesheet (one global <style> injected once).
		*
		* Every value is a DSH 0.2.1 theme token: semantic `--dsw-alias-*` colours,
		* `--dsw-radius-*` role radii, composed `--dsw-font-*` typography roles and
		* `--dsw-elevation-*` for floating surfaces. No literal colours, no palette
		* copies, no theme selectors — the theme owns both light and dark. Neutral
		* hairline borders draw at 0.5px; state-coloured borders stay 1px; compact
		* capsules pair `corner-shape: round` with the 999px radius.
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

.qdp-btn {
  display: inline-flex;
  flex: 0 0 auto;
  align-items: center;
  justify-content: center;
  gap: 4px;
  height: 28px;
  padding: 0 10px;
  border: 0.5px solid var(--dsw-alias-border-l2);
  border-radius: var(--dsw-radius-sm);
  background: none;
  color: var(--dsw-alias-label-secondary);
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
  background: var(--dsw-alias-bg-layer-2);
  color: var(--dsw-alias-label-tertiary);
  cursor: default;
}
.qdp-btnMd {
  height: 36px;
  padding: 0 14px;
  border-radius: var(--dsw-radius-md);
  font: var(--dsw-font-s-strong-14);
}
.qdp-btnPrimary {
  border-color: var(--dsw-alias-button-primary-fill);
  background: var(--dsw-alias-button-primary-fill);
  color: var(--dsw-alias-label-primary-foreground);
}
.qdp-btnPrimary:hover:not(:disabled) {
  border-color: var(--dsw-alias-button-primary-hover);
  background: var(--dsw-alias-button-primary-hover);
  color: var(--dsw-alias-label-primary-foreground);
}
.qdp-btnPrimary:disabled {
  border-color: var(--dsw-alias-button-primary-fill);
  background: var(--dsw-alias-button-primary-fill);
  color: var(--dsw-alias-label-primary-foreground);
  opacity: 0.45;
}
.qdp-btnDanger {
  border-color: var(--dsw-alias-state-error-primary);
  background: var(--dsw-alias-state-error-primary);
  color: var(--dsw-alias-label-primary-foreground);
}
.qdp-btnDangerQuiet {
  border-color: transparent;
  color: var(--dsw-alias-state-error-primary);
}
.qdp-btnDangerQuiet:hover:not(:disabled) {
  background: var(--dsw-alias-interactive-bg-hover-danger);
  color: var(--dsw-alias-state-error-primary);
}
.qdp-btnGhost {
  border-color: transparent;
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

/* ------------------------------------------------------------------- dots */

.qdp-dot {
  flex: 0 0 auto;
  width: 8px;
  height: 8px;
  border-radius: 50%;
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
.qdp-patInput {
  flex: 1 1 auto;
  min-width: 200px;
}

/* ---------------------------------------------------------------- sliders */

.qdp-slider {
  position: relative;
  display: flex;
  align-items: center;
  height: 32px;
  padding: 0 2px;
  border-radius: var(--dsw-radius-xs);
  cursor: pointer;
  touch-action: none;
  user-select: none;
}
.qdp-slider[aria-disabled='true'] {
  opacity: 0.5;
  cursor: default;
}
.qdp-sliderTrack {
  position: relative;
  width: 100%;
  height: 12px;
  border-radius: 999px;
  corner-shape: round;
  background: var(--dsw-alias-interactive-bg-hover);
}
.qdp-sliderFill {
  position: absolute;
  top: 0;
  left: 0;
  height: 100%;
  border-radius: 999px;
  corner-shape: round;
  /* A solid, readable bar (the Qoder model-settings look): the fill is a
     strong brand tint, the handle the same colour at full strength. */
  background: var(--dsw-alias-state-business-primary);
  opacity: 0.42;
}
.qdp-sliderThumb {
  position: absolute;
  top: 50%;
  width: 4px;
  height: 20px;
  border-radius: 2px;
  background: var(--dsw-alias-state-business-primary);
  transform: translate(-50%, -50%);
}

/* ----------------------------------------------------------------- models */

.qdp-modelScroll {
  max-height: 420px;
  overflow-y: auto;
  overscroll-behavior: contain;
}
.qdp-modelColumns {
  position: sticky;
  top: 0;
  z-index: 1;
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) 232px;
  gap: 10px;
  align-items: center;
  padding: 4px 0 4px;
  border-bottom: 0.5px solid var(--dsw-alias-border-l2);
  background: var(--dsw-alias-settings-card-fill);
  font: var(--dsw-font-xxxs-11);
  color: var(--dsw-alias-label-tertiary);
}
.qdp-modelRow {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) 232px;
  gap: 10px;
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
.qdp-modelAxis {
  min-width: 0;
}
.qdp-sliderField {
  position: relative;
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}
.qdp-windowTicks {
  position: relative;
  height: 12px;
  margin: 0 2px;
}
.qdp-windowTick {
  position: absolute;
  transform: translateX(-50%);
  font: var(--dsw-font-xxxs-11);
  color: var(--dsw-alias-label-tertiary);
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}
.qdp-windowTick:first-child {
  transform: none;
}
.qdp-windowTick:last-child {
  transform: translateX(-100%);
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

/* ------------------------------------------------------- check-in ledger */

.qdp-logList {
  display: flex;
  flex-direction: column;
  max-height: 138px;
  padding: 2px 0;
  overflow-y: auto;
  scrollbar-width: thin;
}
.qdp-logRow {
  display: flex;
  align-items: baseline;
  gap: 8px;
  min-height: 26px;
  padding: 4px 0;
  font: var(--dsw-font-xxs-12);
  color: var(--dsw-alias-label-secondary);
}
.qdp-logRow + .qdp-logRow {
  border-top: 0.5px solid var(--dsw-alias-border-l1);
}
.qdp-logRow .qdp-num {
  margin-left: auto;
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
			quotaReadoutEnabledLabel: "Show quota readout",
			quotaReadoutEnabledDesc: "A remaining-credit chip in the composer toolbar; click it to open the details panel.",
			quotaReadoutCNLabel: "China variant",
			quotaReadoutCNDesc: "Show the China account’s remaining credit while the session uses a China model.",
			quotaReadoutGlobalLabel: "Global variant",
			quotaReadoutGlobalDesc: "Show the global account’s remaining credit while the session uses a global model.",
			checkInTodayTitle: "Today",
			ledgerCount: "{count} entries"
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
			quotaReadoutEnabledLabel: "显示额度读数",
			quotaReadoutEnabledDesc: "在输入框工具条上显示剩余额度标签，点击可展开明细面板。",
			quotaReadoutCNLabel: "国内版额度",
			quotaReadoutCNDesc: "当前会话使用国内版模型时，显示国内版账号的剩余额度。",
			quotaReadoutGlobalLabel: "国际版额度",
			quotaReadoutGlobalDesc: "当前会话使用国际版模型时，显示国际版账号的剩余额度。",
			checkInTodayTitle: "今日",
			ledgerCount: "{count} 条记录"
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
		* `cordis.patch.yml` inserts `- id: llm-qoder-x, name: dsh-qoder-plugin`, so
		* the Plugins page reports this plugin's row as `llm-qoder-x`. The browser half
		* needs it for exactly one thing: the right half of {@link ROW_CONFIG_KEY}.
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
