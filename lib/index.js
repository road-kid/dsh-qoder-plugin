import { $ as QODER_SETTINGS_FACE_PATH, A as umidDir, B as PROBE_EFFORT_CANDIDATES, D as installUmid, G as FALLBACK_QODER_MODELS, H as randomSentinel, I as QoderAccountHealthTracker, K as QoderCatalog, L as getMachineId, O as readUmidManifest, P as identityCacheStatus, Q as QODER_PROBE_PATH, R as formatQueueNotice, S as getClaimWindowDateString, T as rotateDeviceSeed, U as QoderCatalogStore, V as probeModel, W as qoderCatalogPath, X as QODER_GLOBAL_PROBE_PATH, Y as QODER_GLOBAL_AUTH_PATH, Z as QODER_GLOBAL_STATUS_PATH, _ as modelInfoOf, a as QODER_HOST_HEARTBEAT_FILENAME, at as QoderCredentialStore, b as createQoderTransport, c as processStartTimeMs, ct as qoderOwnAuthPath, d as writeHostHeartbeat, dt as qoderPluginDataDir, et as QODER_STATUS_PATH, f as QODER_CONNECT_VERSION, ft as qoderStateDir, g as kindFromQoderFailure, h as classifyUpstreamError, i as variantFor, it as QODER_PAT_ENV_GLOBAL, j as umidInstalled, l as qoderHostHeartbeatPath, lt as QODER_DATA_DIR_ENV, m as QoderUpstreamClient, n as GLOBAL_VARIANT, nt as QODER_AUTH_FILENAME, o as clearHostHeartbeat, ot as patTail, p as KIND_STATUS, q as QODER_AUTH_PATH, r as QODER_VARIANTS, rt as QODER_PAT_ENV_CN, s as isHeartbeatProcessAlive, st as qoderCredentialIdentity, t as CHINA_VARIANT, u as readHostHeartbeat, ut as QODER_DATA_DIR_NAME, v as normalizeCredits, w as readDeviceSeed, x as qoderInnerErrorSnapshot, y as validateApiKey, z as formatQueueWaitNotice } from "./variants-DHhCqtyk.js";
import { dirname, join, resolve } from "node:path";
import z from "@deepseek-ai/schemastery";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { createProvider } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { resolveRetryPolicy } from "@deepseek-ai/dsh-llm";
import { PiAiAdapter } from "@deepseek-ai/dsh-llm-pi-ai";
import { createServer } from "node:http";
import { Readable } from "node:stream";
//#region src/loopback.ts
/**
* Shared loopback gates for the plugin's local HTTP surfaces: the loopback
* shim and the same-origin web-status route. Both are only ever meant to be
* addressed through the machine's loopback interface.
*
* @module dsh-qoder-plugin/loopback
*/
/** Loopback hostnames a local plugin surface may be addressed by. */
const LOOPBACK_HOSTS = /* @__PURE__ */ new Set([
	"127.0.0.1",
	"localhost",
	"[::1]"
]);
/** Strip the optional :port from a Host header value, IPv6-bracket aware. */
function hostnameOfHost(host) {
	let hostname = host.trim().toLowerCase();
	if (hostname.startsWith("[")) {
		const end = hostname.indexOf("]");
		return end === -1 ? hostname : hostname.slice(0, end + 1);
	}
	const colon = hostname.lastIndexOf(":");
	if (colon !== -1 && !hostname.slice(0, colon).includes(":") && /^\d+$/.test(hostname.slice(colon + 1))) hostname = hostname.slice(0, colon);
	return hostname;
}
/**
* The request's Host header must name the loopback interface. A DNS-rebinding
* page (attacker domain re-resolved to 127.0.0.1) sends its own domain in
* Host, so this check drops those before any routing happens.
*/
function hostIsLoopback(host) {
	if (host === void 0 || host.trim() === "") return false;
	return LOOPBACK_HOSTS.has(hostnameOfHost(host));
}
/**
* A browser-sent Origin (present header) must be loopback. Non-browser
* clients (the plugin's own fetch calls) send no Origin at all and pass.
*/
function originIsLoopback(origin) {
	if (origin === void 0 || origin.trim() === "") return true;
	try {
		const { hostname } = new URL(origin);
		return LOOPBACK_HOSTS.has(hostname) || hostname === "::1";
	} catch {
		return false;
	}
}
//#endregion
//#region src/auth-route.ts
/**
* PAT route: saves (validate-then-persist), selects, removes, or clears one
* variant's stored tokens.
*
* The state-changing endpoints the plugin exposes share one guard shape — a
* loopback Host and Origin, plus the in-process key the card receives with its
* status document — because loopback alone is *not* authentication: any local
* process can address `127.0.0.1`, and this route writes a credential to disk.
*
* The region is never taken from the request. It is fixed by the route the
* browser called (one route per variant), so a card for one product can never
* steer a token into the other's upstream — a token pasted into the Qoder
* Global card is validated against, and stored for, Qoder Global only.
*
* @module dsh-qoder-plugin/auth-route
*/
/** Largest control body accepted; a Personal Access Token is a short string. */
const MAX_BODY_BYTES$2 = 16384;
function json$3(res, status, body) {
	const payload = JSON.stringify(body);
	res.writeHead(status, {
		"Content-Type": "application/json",
		"Content-Length": Buffer.byteLength(payload)
	});
	res.end(payload);
}
/** Read the request body with a hard ceiling. */
async function readBody$2(req) {
	const chunks = [];
	let total = 0;
	for await (const chunk of req) {
		const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
		total += buffer.length;
		if (total > MAX_BODY_BYTES$2) return void 0;
		chunks.push(buffer);
	}
	return Buffer.concat(chunks).toString("utf8");
}
/** Parse and shape-check a PAT request; unknown fields are ignored, not trusted. */
function parseRequest(text) {
	let parsed;
	try {
		parsed = JSON.parse(text);
	} catch {
		return;
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return void 0;
	const wrapped = parsed;
	const action = wrapped["action"];
	if (action === "clear") return { action };
	if (action === "save-pat") {
		const pat = wrapped["pat"];
		if (typeof pat !== "string" || pat.trim() === "") return void 0;
		return {
			action,
			pat
		};
	}
	if (action === "activate-account" || action === "remove-account") {
		const accountId = wrapped["accountId"];
		if (typeof accountId !== "string" || accountId.trim() === "") return void 0;
		return {
			action,
			accountId: accountId.trim()
		};
	}
	if (action === "set-account-enabled") {
		const accountId = wrapped["accountId"];
		const enabled = wrapped["enabled"];
		if (typeof accountId !== "string" || accountId.trim() === "") return void 0;
		if (typeof enabled !== "boolean") return void 0;
		return {
			action,
			accountId: accountId.trim(),
			enabled
		};
	}
}
/**
* Strip token-like content from a message before it reaches the browser.
*
* The route reports failures to a same-origin card, and a validation error
* body is the one input here that is not the plugin's own prose.
* Belt-and-braces: everything this route produces is already a summary, and
* this keeps a future one from carrying a credential across.
*/
function safeMessage$2(error) {
	return (error instanceof Error ? error.message : String(error)).replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/gu, "[redacted token]").replace(/(\b(?:code|token|pat)=)[^&\s]+/giu, "$1[redacted]").slice(0, 500);
}
/** Mint the per-process PAT control key. */
function createAuthKey() {
	return randomBytes(24).toString("hex");
}
/** Constant-time key comparison; a length mismatch is a failure, not a crash. */
function keyMatches$2(expected, presented) {
	if (presented === void 0 || presented.length !== expected.length) return false;
	const a = Buffer.from(expected);
	const b = Buffer.from(presented);
	return a.length === b.length && timingSafeEqual(a, b);
}
/**
* The PAT route's handler, extracted so tests can mount it on a bare server
* with a known key.
*
* @param deps - the save/clear operations for one variant.
* @param key - the in-process control key this route requires.
* @returns the Node request handler.
*/
function qoderAuthHandler(deps, key) {
	return async (req, res) => {
		if (req.method !== "POST") {
			json$3(res, 405, { error: "method not allowed" });
			return;
		}
		if (!hostIsLoopback(req.headers.host) || !originIsLoopback(req.headers.origin)) {
			json$3(res, 403, { error: "request-not-trusted" });
			return;
		}
		if (!keyMatches$2(key, req.headers["x-qoder-auth-key"])) {
			json$3(res, 403, { error: "invalid-auth-key" });
			return;
		}
		const body = await readBody$2(req);
		if (body === void 0) {
			json$3(res, 413, { error: "body too large" });
			return;
		}
		const request = parseRequest(body);
		if (request === void 0) {
			json$3(res, 400, { error: "invalid action" });
			return;
		}
		try {
			if (request.action === "clear") {
				await deps.clear();
				json$3(res, 200, { ok: true });
				return;
			}
			if (request.action === "activate-account") {
				json$3(res, 200, {
					ok: true,
					status: await deps.activate(request.accountId)
				});
				return;
			}
			if (request.action === "remove-account") {
				json$3(res, 200, {
					ok: true,
					status: await deps.remove(request.accountId)
				});
				return;
			}
			if (request.action === "set-account-enabled") {
				const setEnabled = deps.setEnabled;
				if (setEnabled === void 0) {
					json$3(res, 200, {
						ok: false,
						error: "set-account-enabled is not available on this host"
					});
					return;
				}
				json$3(res, 200, {
					ok: true,
					status: await setEnabled(request.accountId, request.enabled)
				});
				return;
			}
			json$3(res, 200, await deps.save(request.pat));
		} catch (error) {
			json$3(res, 200, {
				ok: false,
				error: safeMessage$2(error)
			});
		}
	};
}
/** Mount the POST PAT route on an optional webServer context. */
function registerQoderAuthRoute(ctx, deps, key) {
	const path = deps.path ?? "/plugins/dsh-qoder-plugin/auth";
	ctx.effect(() => {
		const dispose = ctx.webServer.register({
			kind: "exact",
			path,
			handler: qoderAuthHandler(deps, key)
		});
		return () => {
			dispose();
		};
	}, "dsh-qoder-plugin: PAT route");
}
//#endregion
//#region src/adapter.ts
/**
* The Qoder pi-ai provider: one loopback-backed adapter per variant route,
* registered into the Harness LLM seam, assembled from public
* `dsh-llm-pi-ai` extension points the way `dsh-codex-connect` assembles its
* Codex route.
*
* @module dsh-qoder-plugin/adapter
*/
/** Default provider route owned by this bundle (the China variant). */
const QODER_PROVIDER = "qoder";
/** Provider idle ceiling while one stream read is outstanding. */
const QODER_STREAM_IDLE_TIMEOUT_MS = 3e5;
/**
* Image-request budgets at the dsh-llm-pi-ai defaults; the profile type made
* them required in 0.1.1-rc.2. They bound requests to models whose catalog
* entry declares `supportsImages`; text-only models never receive images.
*/
const REQUEST_IMAGE_BUDGETS = {
	maxRequestImageBytes: 20971520,
	requestImagePixelBudget: 4194304,
	requestImageMaxBytes: 1048576
};
/**
* Inert pi-ai auth plane. The Qoder routes authenticate only through the
* shim shared secret resolved per request by `resolveApiKey`, so pi-ai's own
* credential lifecycle and ambient discovery must never manufacture a
* credential for them. `PiAiAdapterOptions.auth` is required since 0.1.1-rc.2;
* every ambient question here answers "nothing stored, nothing set".
*/
const INERT_AUTH = {
	credentials: {
		async read() {},
		async list() {
			return [];
		},
		async modify() {
			throw new Error("dsh-qoder-plugin: Qoder routes have no pi-ai credential lifecycle");
		},
		async delete() {}
	},
	authContext: {
		async env() {},
		async fileExists() {
			return false;
		}
	}
};
/** No per-token pricing is knowable for a subscription quota; report zero. */
const NO_COST = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0
};
/**
* The suffix appended to a model's display name so its billing rate is visible
* wherever the name is shown.
*
* The separator is a middle dot rather than a hyphen or colon: model names
* commonly contain hyphens, so a hyphen separator would be ambiguous about
* where the name ends and the rate begins.
*/
const RATE_SEPARATOR = " · ";
/**
* What the model seat shows in place of a rate the plugin cannot stand behind.
*
* The seat has no locale service (the adapter is a host seam), so this is a
* literal; it matches the settings card's own wording for the same state.
* Rendering it as WORDS rather than an empty slot: every other model in the
* seat shows `· x0.3`, so a bare name where the rate should be reads as a
* rendering bug. This plugin's fallback roster carries no rate at all, so the
* case is not hypothetical.
*/
const RATE_UNAVAILABLE = "价格暂不可用";
/**
* Append the billing rate to one model's display name.
*
* The rate rides the *name* alone: since DSH 0.1.2 the composer's model seat
* (`ModelSelect`) renders `model.name` only — `description` is no longer read
* there at all. The `/model` popup renders the name too, so a separate
* `description` copy would duplicate the rate depending on client generation.
*
* This is display-only and cannot affect routing: the wire request is built
* from `model.id` (pi-ai's completions API sets `model: model.id`), the
* selection a picker submits is `{provider, model: id, reasoningEffort}`, and
* `dsh-llm` validates `name` as a non-empty string without comparing its
* contents. Nothing in the host resolves a model *by* name.
*/
/** The catalog display suffix: the normalized billing rate, when the row has one. */
function displaySuffix(info) {
	if (info.billing?.rateUnknown === true) return RATE_UNAVAILABLE;
	const rate = normalizeCredits(info.billing?.credits);
	return rate === void 0 || rate === "" ? void 0 : rate;
}
/** Append the catalog display suffix to one model's display name. */
function withCatalogDisplay(name, info) {
	const suffix = displaySuffix(info);
	return suffix === void 0 ? name : `${name}${RATE_SEPARATOR}${suffix}`;
}
/**
* Resolve a Qoder model's reasoning capability into pi-ai's
* `thinkingLevelMap` (every level pinned to its wire spelling or `null` for
* unsupported), mirroring `dsh-llm-pi-ai`'s own `resolveModelReasoning`.
*
* Two sources, strictly ordered (`docs/reasoning-effort-probe-plan.md` §5):
*
* 1. **The declared set.** When the upstream declares a non-empty
*    `supportedEfforts`, exactly those values are offered and nothing else.
*    This always wins: an observation never widens or narrows a declared set.
* 2. **A local observation.** Rows the upstream left undeclared normally get
*    no control at all — their selectable set is client-side knowledge the
*    catalog does not carry. If the user authorized a probe and it established
*    that the upstream *validates* the parameter, the verified spellings are
*    offered.
*
* A `non-validating` observation deliberately yields no control: an upstream
* that accepts values that cannot exist would make every per-level acceptance
* a false positive.
*
* `off` is offered only when the upstream declares `canDisableThinking: true`.
* It is never probed — disabling thinking is a separate capability, and the
* per-model acceptance of `off` cannot be inferred from the row's shape.
*
* The offered set is described internally as "verified accepted", never as
* "verified effective": acceptance proves the upstream did not reject the
* spelling, not that it changes what the model does.
*/
function reasoningFields(info, observed) {
	const reasoning = info.reasoning;
	if (reasoning === void 0 || reasoning.supports !== true) return { reasoning: false };
	const declared = reasoning.supportedEfforts;
	const efforts = declared !== void 0 && declared.length > 0 ? declared : observed?.validation === "validating" && observed.efforts.length > 0 ? observed.efforts : void 0;
	if (efforts === void 0) return { reasoning: false };
	return {
		reasoning: true,
		thinkingLevelMap: {
			off: reasoning.canDisableThinking === true && declared !== void 0 && declared.length > 0 ? "off" : null,
			minimal: null,
			low: efforts.includes("low") ? "low" : null,
			medium: efforts.includes("medium") ? "medium" : null,
			high: efforts.includes("high") ? "high" : null,
			xhigh: efforts.includes("xhigh") ? "xhigh" : null,
			max: efforts.includes("max") ? "max" : null
		}
	};
}
/** Build one pi-ai model descriptor pointing at the loopback shim. */
function toPiModel(info, baseUrl, observed, providerId = QODER_PROVIDER) {
	return {
		id: info.id,
		name: info.name,
		api: "openai-completions",
		provider: providerId,
		baseUrl,
		input: info.supportsImages === true ? ["text", "image"] : ["text"],
		...reasoningFields(info, observed),
		cost: NO_COST,
		contextWindow: info.contextWindow,
		maxTokens: info.maxTokens,
		compat: {
			maxTokensField: "max_tokens",
			sendSessionAffinityHeaders: true
		}
	};
}
/**
* Assemble the adapter. The provider's `getModels` reads the live catalog,
* and every model's `baseUrl` is re-resolved per read so the shim's
* ephemeral port applies from the first snapshot after startup.
*
* The profile is constructed by hand rather than through dsh-llm-pi-ai's
* internal `resolveProfiles()`: that helper is not part of the package's
* public export surface (root entry, `lib/` deep imports blocked by the
* exports map, `src/` not shipped), so hand-assembly is the only supported
* path and every newly required field must be adopted here explicitly —
* `modelErrors` since 0.1.5-alpha.2 (#12).
*/
function createQoderAdapter(options) {
	const { shim, store, catalog, resolveAttachments, observe } = options;
	const providerId = options.providerId ?? "qoder";
	const displayName = options.displayName ?? "Qoder";
	const buildModels = () => {
		const baseUrl = `${shim.baseUrl()}/v1`;
		return catalog.current().map((info) => toPiModel(info, baseUrl, observe?.(info.id), providerId));
	};
	const provider = {
		...createProvider({
			id: providerId,
			name: displayName,
			auth: { apiKey: {
				name: "Qoder shim shared secret",
				async resolve({ credential }) {
					const apiKey = credential?.key;
					return apiKey === void 0 || apiKey.length === 0 ? void 0 : {
						auth: { apiKey },
						source: displayName
					};
				}
			} },
			models: buildModels(),
			api: openAICompletionsApi()
		}),
		getModels: () => buildModels()
	};
	const profile = {
		provider: providerId,
		displayName,
		streamIdleTimeoutMs: QODER_STREAM_IDLE_TIMEOUT_MS,
		retryPolicy: resolveRetryPolicy(void 0, `dsh-qoder-plugin:${providerId} retryPolicy`),
		configuredMaxTokens: /* @__PURE__ */ new Map(),
		modelErrors: /* @__PURE__ */ new Map(),
		...REQUEST_IMAGE_BUDGETS,
		piProvider: provider
	};
	let profiles = /* @__PURE__ */ new Map([[providerId, profile]]);
	return {
		adapter: new QoderPiAiAdapter(catalog, {
			profiles: () => profiles,
			auth: INERT_AUTH,
			resolveApiKey: async () => shim.token(),
			...resolveAttachments === void 0 ? {} : { resolveAttachments }
		}),
		invalidate: () => {
			profiles = /* @__PURE__ */ new Map([[providerId, profile]]);
		}
	};
}
/**
* The Qoder variant route's adapter: `PiAiAdapter` with the billing rate folded
* into the catalog answers it returns to the DSH model pickers.
*
* `PiAiAdapter.listModels()` and `.resolveModel()` build their answers straight
* from the pi-ai descriptors, which carry no billing fact, so the rate is
* layered on here by looking the model up in the live catalog. Both overrides
* delegate to `super` and then rewrite only the display fields, so streaming,
* capability resolution, and effort mapping stay exactly as `dsh-llm-pi-ai`
* implements them.
*
* A model missing from the catalog (an id the shim would serve but the last
* upstream refresh did not list) falls through with its name untouched rather
* than being dropped: catalog membership is advisory, and the seam tolerates
* serving an unlisted id.
*/
var QoderPiAiAdapter = class extends PiAiAdapter {
	catalog;
	constructor(catalog, options) {
		super(options);
		this.catalog = catalog;
	}
	/** Catalog entry for one model id, or undefined when the catalog omits it. */
	infoFor(model) {
		return this.catalog.current().find((entry) => entry.id === model);
	}
	async listModels(provider) {
		return (await super.listModels(provider)).map((model) => {
			const info = this.infoFor(model.id);
			if (info === void 0) return model;
			return {
				...model,
				name: withCatalogDisplay(model.name, info)
			};
		});
	}
	async resolveModel(provider, model, signal) {
		const resolved = await super.resolveModel(provider, model, signal);
		const info = this.infoFor(model);
		if (info === void 0) return resolved;
		return {
			...resolved,
			name: withCatalogDisplay(resolved.name, info)
		};
	}
};
//#endregion
//#region src/shim.ts
/**
* Loopback OpenAI-compatible endpoint. The pi-ai provider points here; the
* shim guards the local boundary and hands the raw JSON body to the upstream
* client, which translates it onto the Qoder transport. It binds 127.0.0.1
* only and never serves another interface.
*
* Inbound hardening: the loopback bind alone is not a trust boundary (any
* local process or a DNS-rebinding page can reach 127.0.0.1), so every
* request must carry a loopback Host header, browser-sent Origins must be
* loopback, chat POSTs must be application/json, and the Authorization
* header must carry the shim's per-process shared secret. The plugin's
* own client satisfies all four by construction; local attackers cannot
* read the secret out of the plugin process's memory.
*
* @module dsh-qoder-plugin/shim
*/
const REQUEST_BODY_LIMIT = 67108864;
/** Chat-completion POSTs must carry a JSON body type (simple-request CSRF drops here). */
function isJsonContentType(req) {
	const type = req.headers["content-type"];
	return typeof type === "string" && type.trim().toLowerCase().startsWith("application/json");
}
/**
* The session the caller asked this request to stick to, or `undefined`.
*
* pi-ai sends the affinity headers only when the model descriptor opts in (see
* `toPiModel` in `src/adapter.ts`), and it sends them rather than the identity
* in the body: the id belongs to the harness conversation, which the OpenAI
* chat-completions schema has no field for. `x-session-affinity` is pi-ai's
* `openai`-format spelling and the one this shim checks; `session_id` is the
* same value under the OpenRouter-style bare key, accepted because a caller
* that sets only one of them should not lose its session.
*
* A blank value is treated as absent: an empty string would otherwise become a
* pin key shared by every session that sent it, which would quietly couple
* conversations that have nothing to do with each other.
*/
function sessionIdOf(req) {
	const raw = req.headers["x-session-affinity"] ?? req.headers["session_id"];
	const value = Array.isArray(raw) ? raw[0] : raw;
	if (typeof value !== "string") return void 0;
	const trimmed = value.trim();
	return trimmed === "" ? void 0 : trimmed;
}
function writeJson(res, status, body) {
	const payload = JSON.stringify(body);
	res.writeHead(status, {
		"Content-Type": "application/json",
		"Content-Length": Buffer.byteLength(payload)
	});
	res.end(payload);
}
function writeOpenAIError(res, status, kind, message) {
	writeJson(res, status, { error: {
		message,
		type: kind,
		code: kind
	} });
}
/** Read a request body with a size cap; over-limit bodies fail the request. */
function readBody$1(req) {
	return new Promise((resolve, reject) => {
		const chunks = [];
		let size = 0;
		req.on("data", (chunk) => {
			size += chunk.length;
			if (size > REQUEST_BODY_LIMIT) {
				reject(/* @__PURE__ */ new Error("request body too large"));
				req.destroy();
				return;
			}
			chunks.push(chunk);
		});
		req.on("end", () => resolve(Buffer.concat(chunks)));
		req.on("error", reject);
	});
}
/**
* Start the loopback endpoint. Requests carry any bearer; the loopback bind
* is the boundary, and the upstream credential comes from the store alone.
*/
function createQoderShim(options) {
	const { store, client, catalog } = options;
	const logger = options.logger;
	const providerId = options.providerId;
	const SHARED_SECRET = randomBytes(32).toString("base64url");
	/** Constant-time bearer check; absent or mismatched bearers are rejected. */
	function bearerOk(req) {
		const header = req.headers.authorization;
		if (typeof header !== "string") return false;
		const match = /^Bearer\s+(.+)$/i.exec(header.trim());
		if (match === null) return false;
		const presented = match[1];
		const expected = SHARED_SECRET;
		const a = Buffer.from(presented);
		const b = Buffer.from(expected);
		if (a.length !== b.length) return false;
		return timingSafeEqual(a, b);
	}
	const server = createServer((req, res) => {
		handle(req, res).catch((error) => {
			logger?.warn("dsh-qoder-plugin: loopback request failed", error);
			try {
				if (!res.headersSent) writeOpenAIError(res, 500, "internal", "loopback request failed");
				else res.end();
			} catch {}
		});
	});
	const ready = new Promise((resolve, reject) => {
		server.once("listening", () => resolve());
		server.once("error", reject);
	});
	server.listen(0, "127.0.0.1");
	const baseUrl = () => {
		const address = server.address();
		if (address === null || typeof address === "string") throw new Error(`${providerId} shim has no listening address`);
		return `http://127.0.0.1:${address.port}`;
	};
	async function handle(req, res) {
		try {
			if (!hostIsLoopback(req.headers.host)) {
				writeOpenAIError(res, 403, "host_not_allowed", "Host header must name the loopback interface");
				return;
			}
			if (!originIsLoopback(req.headers.origin)) {
				writeOpenAIError(res, 403, "origin_not_allowed", "Origin must be a loopback origin");
				return;
			}
			if (!bearerOk(req)) {
				writeOpenAIError(res, 401, "unauthorized", "missing or invalid Authorization bearer");
				return;
			}
			const url = req.url ?? "/";
			if (req.method === "GET" && (url === "/healthz" || url === "/healthz/")) {
				writeJson(res, 200, { ok: true });
				return;
			}
			if (req.method === "GET" && (url === "/v1/models" || url === "/v1/models/")) {
				writeJson(res, 200, {
					object: "list",
					data: catalog.current().map((model) => ({
						id: model.id,
						object: "model",
						created: 0,
						owned_by: providerId
					}))
				});
				return;
			}
			if (req.method === "POST" && (url === "/v1/chat/completions" || url === "/v1/chat/completions/")) {
				await chatCompletions(req, res);
				return;
			}
			writeOpenAIError(res, 404, "not_found", `no such route: ${req.method} ${url}`);
		} catch (error) {
			if (!res.headersSent) writeOpenAIError(res, 500, "internal", String(error));
			else res.end();
		}
	}
	async function chatCompletions(req, res) {
		if (!isJsonContentType(req)) {
			writeOpenAIError(res, 415, "unsupported_media_type", "Content-Type must be application/json");
			return;
		}
		try {
			await store.resolve();
		} catch (error) {
			writeOpenAIError(res, KIND_STATUS.missing_credential, "not_signed_in", String(error));
			return;
		}
		const raw = (await readBody$1(req)).toString("utf8");
		const controller = new AbortController();
		req.on("close", () => controller.abort());
		const result = await client.chatStream(raw, controller.signal, sessionIdOf(req));
		if (!result.ok) {
			writeOpenAIError(res, KIND_STATUS[result.kind], result.kind, `${providerId} upstream ${result.kind} (http ${KIND_STATUS[result.kind]}): ${result.message.slice(0, 400)}`);
			return;
		}
		res.writeHead(200, {
			"Content-Type": "text/event-stream",
			"Cache-Control": "no-cache",
			"Connection": "keep-alive",
			"X-Accel-Buffering": "no"
		});
		let sawDone = false;
		const body = Readable.fromWeb(result.response.body);
		body.on("data", (chunk) => {
			if (chunk.includes("[DONE]")) sawDone = true;
		});
		body.on("error", (error) => {
			logger?.warn("dsh-qoder-plugin: upstream stream failed mid-flight", error);
			if (!sawDone && res.writable) res.end("data: [DONE]\n\n");
		});
		body.pipe(res);
	}
	return {
		ready,
		baseUrl,
		token: () => SHARED_SECRET,
		close: () => new Promise((resolve, reject) => {
			server.close(() => resolve());
			server.closeAllConnections();
			server.once("error", reject);
		})
	};
}
//#endregion
//#region src/probe-store.ts
/**
* Local record of reasoning-effort probes.
*
* What this stores is an *observation*, never a claim about the upstream: a
* model's row is only consulted when the catalog carries no explicit
* `supportedEfforts` set, and it always loses to a declared set. The plan this
* implements (`docs/reasoning-effort-probe-plan.md` §5) requires that a result
* is invalidated whenever the model's catalog row changes, so every record
* carries a fingerprint of the fields the probe depended on.
*
* The file lives in the plugin's own state directory, never beside the
* product's files, and carries no token, prompt, or response body — only
* model ids, effort spellings, and timestamps.
*
* @module dsh-qoder-plugin/probe-store
*/
/** Basename of the China variant's probe record inside the plugin's state dir. */
const QODER_PROBE_FILENAME = ".qoder-probe.json";
/** On-disk format this reader accepts; other versions are discarded. */
const PROBE_FORMAT_VERSION = 1;
/**
* How long an observation stays usable. Conservative on purpose: the plan's
* whole argument is that upstream metadata moves fast, so a result that has
* outlived its fingerprint's usefulness should not quietly keep granting a
* picker entry.
*/
const DEFAULT_TTL_MS = 12096e5;
/**
* Plugin-owned probe record path inside the plugin's state directory.
*
* One file per variant. The two regions serve overlapping model ids with
* different entitlements, and {@link fingerprintModel} covers only
* `id`/`reasoning`/`supportsImages` — never the provider — so a single shared
* file would let one variant's observation answer for the other. The paths
* differ; the format does not.
*/
function qoderProbePath(filename = QODER_PROBE_FILENAME) {
	return join(qoderStateDir(), filename);
}
/**
* Fingerprint the catalog fields a probe depends on.
*
* Deliberately excludes display-only fields (`name`, `billing`, `contextWindow`)
* so a rename or a rate relabel does not throw away a valid observation, and
* deliberately includes the whole reasoning object so any change to the
* declared shape re-probes.
*/
function fingerprintModel(info) {
	const basis = JSON.stringify({
		id: info.id,
		reasoning: info.reasoning ?? null,
		supportsImages: info.supportsImages ?? null
	});
	return createHash("sha256").update(basis).digest("hex").slice(0, 16);
}
/** Read-and-validate the documents on disk; anything malformed reads as empty. */
function readDocument(path) {
	if (!existsSync(path)) return void 0;
	let parsed;
	try {
		parsed = JSON.parse(readFileSync(path, "utf8"));
	} catch {
		return;
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return void 0;
	const wrapped = parsed;
	if (wrapped["version"] !== PROBE_FORMAT_VERSION) return void 0;
	const records = wrapped["records"];
	if (typeof records !== "object" || records === null || Array.isArray(records)) return void 0;
	return parsed;
}
/** One record's shape check; a bad row is dropped rather than trusted. */
function isRecord(value) {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const wrapped = value;
	const validation = wrapped["validation"];
	if (validation !== "validating" && validation !== "non-validating" && validation !== "unknown") return false;
	if (typeof wrapped["fingerprint"] !== "string") return false;
	if (typeof wrapped["probedAtMs"] !== "number" || !Number.isFinite(wrapped["probedAtMs"])) return false;
	if (typeof wrapped["pluginVersion"] !== "string") return false;
	const efforts = wrapped["efforts"];
	if (!Array.isArray(efforts) || efforts.some((effort) => typeof effort !== "string")) return false;
	return true;
}
/**
* The plugin's probe records: read once, written atomically, never trusted
* across a fingerprint change or past the TTL.
*/
var QoderProbeStore = class {
	path;
	ttlMs;
	pluginVersion;
	now;
	records;
	constructor(options) {
		const opts = typeof options === "string" ? {
			path: options,
			pluginVersion: "0.0.0"
		} : options;
		this.path = opts.path ?? qoderProbePath();
		this.ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
		this.pluginVersion = opts.pluginVersion;
		this.now = opts.now ?? (() => Date.now());
	}
	/** Resolved state-file path, for the CLI and tests. */
	filePath() {
		return this.path;
	}
	load() {
		if (this.records === void 0) {
			const document = readDocument(this.path);
			const records = {};
			for (const [id, record] of Object.entries(document?.records ?? {})) if (isRecord(record)) records[id] = record;
			this.records = records;
		}
		return this.records;
	}
	/**
	* The usable record for a model, or `undefined` when there is none, it is
	* expired, it was taken against a different catalog row, or it belongs to a
	* different account.
	*
	* @param account - the account in effect, as `uid:enterpriseId`. Records are
	*   only returned for the account that produced them.
	*/
	get(modelId, fingerprint, account) {
		const record = this.load()[modelId];
		if (record === void 0) return void 0;
		if (record.fingerprint !== fingerprint) return void 0;
		if (record.account !== account) return void 0;
		if (this.now() - record.probedAtMs > this.ttlMs) return void 0;
		return record;
	}
	/**
	* Store one observation. Only a decisive answer (`validating` /
	* `non-validating`) replaces an existing decisive record: a transient
	* `unknown` must not erase knowledge the user already paid for.
	*/
	set(modelId, record) {
		const records = this.load();
		const existing = records[modelId];
		if (record.validation === "unknown" && existing !== void 0 && existing.fingerprint === record.fingerprint && existing.validation !== "unknown") return;
		records[modelId] = record;
		this.persist();
	}
	/** Drop every record; used by the card's explicit "clear" action. */
	clear() {
		this.records = {};
		this.persist();
	}
	/** Every record currently held, for status display. */
	all() {
		return { ...this.load() };
	}
	/** Build a record stamped with this store's clock, version, and account. */
	record(fingerprint, validation, efforts, account) {
		return {
			fingerprint,
			validation,
			efforts: validation === "validating" ? [...efforts] : [],
			probedAtMs: this.now(),
			pluginVersion: this.pluginVersion,
			account
		};
	}
	/**
	* Write through a temporary file and rename, so a crash mid-write cannot
	* leave a half-parsed document that reads as "no records" and silently drops
	* every observation.
	*/
	persist() {
		const directory = dirname(this.path);
		try {
			if (!existsSync(directory)) mkdirSync(directory, { recursive: true });
			const document = {
				version: PROBE_FORMAT_VERSION,
				records: this.load()
			};
			const temporary = resolve(`${this.path}.tmp`);
			writeFileSync(temporary, `${JSON.stringify(document, null, 2)}\n`, { mode: 384 });
			renameSync(temporary, this.path);
		} catch {}
	}
};
/**
* Order observations newest-first for display.
*
* The store keeps insertion order so the file reads chronologically, but the
* card wants the most recent detection at the top: a sweep the user just ran
* should not appear below every earlier one, which is what appending to an
* insertion-ordered list does.
*/
function newestFirst(records) {
	return [...records].sort((a, b) => b.probedAt - a.probedAt);
}
//#endregion
//#region src/probe-service.ts
/**
* Serial probe runner. One instance is shared by the manual API and any
* future automatic trigger, so the two can never overlap.
*/
var QoderProbeService = class {
	options;
	queue = Promise.resolve();
	pending = /* @__PURE__ */ new Map();
	running = false;
	constructor(options) {
		this.options = options;
	}
	/** Whether a sweep is in flight right now. */
	isRunning() {
		return this.running;
	}
	/**
	* The record the adapter may use for this model, or `undefined`.
	*
	* Applies the plan's precedence (§5): a declared set always wins, so a model
	* that declares `supportedEfforts` is never answered from an observation.
	*/
	recordFor(modelId) {
		const info = this.options.catalog.current().find((model) => model.id === modelId);
		if (info === void 0) return void 0;
		if (info.reasoning?.supportedEfforts !== void 0 && info.reasoning.supportedEfforts.length > 0) return;
		const account = this.options.account();
		if (account === void 0) return void 0;
		return this.options.store.get(modelId, fingerprintModel(info), account);
	}
	/**
	* Probe one model, serially.
	*
	* The authenticated manual route supplies one-request consent after UI
	* confirmation. Other callers must pass the configured consent gate.
	* Manual consent never changes the automatic-probing configuration.
	* Explicit requests bypass historical results, but share an ongoing run.
	*/
	async probe(modelId, manualConsent = false) {
		if (!manualConsent && !this.options.consent()) return {
			state: "unavailable",
			reason: "probing is not authorized"
		};
		if (this.options.catalog.current().find((model) => model.id === modelId) === void 0) return {
			state: "unavailable",
			reason: `unknown model: ${modelId}`
		};
		const account = this.options.account();
		if (account === void 0) return {
			state: "unavailable",
			reason: "no Qoder credential"
		};
		const pendingKey = JSON.stringify([account, modelId]);
		const pending = this.pending.get(pendingKey);
		if (pending !== void 0) return pending;
		const run = this.queue.then(async () => {
			const current = this.options.catalog.current().find((model) => model.id === modelId);
			if (current === void 0) return {
				state: "unavailable",
				reason: `unknown model: ${modelId}`
			};
			if (!manualConsent && !this.options.consent()) return {
				state: "unavailable",
				reason: "probing is not authorized"
			};
			if (current.reasoning?.supports !== true || (current.reasoning.supportedEfforts?.length ?? 0) > 0) return {
				state: "unavailable",
				reason: "model does not need detection"
			};
			const cached = this.recordFor(modelId);
			if (!manualConsent && cached !== void 0 && cached.validation !== "unknown") return {
				state: "ok",
				validation: cached.validation,
				efforts: cached.efforts,
				requests: 0
			};
			if (this.options.account() !== account) return {
				state: "unavailable",
				reason: "account changed before detection"
			};
			if (await this.options.credentials.current() === void 0) return {
				state: "unavailable",
				reason: "no Qoder credential"
			};
			const send = this.options.send === void 0 ? (effort, signal) => this.options.client.probeEffort(modelId, effort, signal) : this.options.send(modelId);
			this.running = true;
			try {
				const outcome = await probeModel({
					send,
					...this.options.sentinel === void 0 ? {} : { sentinel: this.options.sentinel }
				});
				if (this.options.account() !== account) return {
					state: "unavailable",
					reason: "account changed during detection"
				};
				const record = this.options.store.record(fingerprintModel(current), outcome.validation, outcome.efforts, account);
				this.options.store.set(modelId, record);
				if (outcome.validation === "unknown") return {
					state: "unavailable",
					reason: outcome.reason
				};
				return {
					state: "ok",
					validation: outcome.validation,
					efforts: record.efforts,
					requests: outcome.requests
				};
			} finally {
				this.running = false;
			}
		});
		this.queue = run.catch(() => void 0);
		this.pending.set(pendingKey, run);
		try {
			return await run;
		} finally {
			this.pending.delete(pendingKey);
		}
	}
};
//#endregion
//#region src/device-reset-route.ts
/**
* Guarded write routes: the device-code reset and the native-component install.
*
* Both are the same kind of thing — one user-facing button, one host-side write,
* one verdict back — so they share one guard implementation instead of two
* copies that could drift apart. The guard shape is the PAT route's: a loopback
* Host and Origin plus the in-process key the card receives with its settings
* document. Any local process can address `127.0.0.1`, and these routes change
* the identity every account presents to the upstream and download code from
* the network respectively.
*
* Be precise about what the key buys: it stops a CROSS-SITE page from driving
* the routes, which is the threat a browser can deliver. It is not a secret from
* local processes — the settings face hands the same key to any loopback caller
* that asks, by design, because the card needs it without a login. A local
* process that wants to rotate the seed can therefore do so; it could already
* edit the seed file directly. The guards raise the bar, they do not close the
* local door.
*
* Both routes deliberately report failures as 200 with `ok: false`: the card is
* same-origin and reads the verdict, and a failed write (a read-only home
* directory being the realistic case) must show as a failed action, not as a
* broken card.
*
* @module dsh-qoder-plugin/device-reset-route
*/
/** Largest body accepted; neither action carries more than a flag. */
const MAX_BODY_BYTES$1 = 4096;
function json$2(res, status, body) {
	const payload = JSON.stringify(body);
	res.writeHead(status, {
		"Content-Type": "application/json",
		"Content-Length": Buffer.byteLength(payload)
	});
	res.end(payload);
}
/**
* Drain the request body and keep it, up to the ceiling.
*
* The body is read to the END even after the ceiling is passed. Bailing out of
* the `for await` early destroys the stream mid-body, and the 413 written
* afterwards can then be lost — the client sees a reset connection instead of
* the reason. Reaching this at all means the caller already passed the loopback
* and key checks, so there is no unauthenticated party to drain for.
*
* The text is DROPPED once the ceiling is crossed rather than buffered and then
* rejected: a caller that sends a gigabyte would otherwise be held in memory by
* the very code that is about to refuse it, and the only thing wanted from an
* oversized body is its length.
*/
async function drainBody(req) {
	let total = 0;
	const chunks = [];
	for await (const chunk of req) {
		const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
		total += buffer.length;
		if (total <= MAX_BODY_BYTES$1) chunks.push(buffer);
		else chunks.length = 0;
	}
	return {
		withinLimit: total <= MAX_BODY_BYTES$1,
		text: Buffer.concat(chunks).toString("utf8")
	};
}
/** Parse a drained body; `undefined` when it is empty or not JSON. */
function parseJson(text) {
	if (text.length === 0) return void 0;
	try {
		return JSON.parse(text);
	} catch {
		return;
	}
}
/** Constant-time key comparison; a length mismatch is a failure, not a crash. */
function keyMatches$1(expected, presented) {
	if (presented === void 0 || presented.length !== expected.length) return false;
	const a = Buffer.from(expected);
	const b = Buffer.from(presented);
	return a.length === b.length && timingSafeEqual(a, b);
}
/** Strip anything token-like from a message before it reaches the browser. */
function safeMessage$1(error) {
	return (error instanceof Error ? error.message : String(error)).replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/gu, "[redacted token]").replace(/\bpt-[A-Za-z0-9_-]{8,}/gu, "[redacted token]").slice(0, 500);
}
/**
* The guard every write route in this plugin runs behind.
*
* Order matters and is deliberate: the method is checked before the loopback
* guard (a `GET` from anywhere is answered as the wrong method, which says
* nothing about the caller), the loopback guard before the key (an off-host
* caller must not learn whether a key it guessed was right), and the key before
* the body is read (an unauthenticated caller must not be able to make the host
* buffer anything).
*
* Extracted so the two actions cannot drift: a guard bug fixed here is fixed
* for both, and the tests can mount either one on a bare server with a known
* key.
*
* @param options - the key to require and the action to run.
* @returns the Node request handler.
*/
function guardedActionHandler(options) {
	return async (req, res) => {
		if (req.method !== "POST") {
			json$2(res, 405, { error: "method not allowed" });
			return;
		}
		if (!hostIsLoopback(req.headers.host) || !originIsLoopback(req.headers.origin)) {
			json$2(res, 403, { error: "request-not-trusted" });
			return;
		}
		if (!keyMatches$1(options.key, req.headers["x-qoder-settings-key"])) {
			json$2(res, 403, { error: "invalid-settings-key" });
			return;
		}
		const body = await drainBody(req);
		if (!body.withinLimit) {
			json$2(res, 413, { error: "body too large" });
			return;
		}
		let verdict;
		try {
			verdict = await options.handler({ body: parseJson(body.text) });
		} catch (error) {
			json$2(res, 200, {
				ok: false,
				error: safeMessage$1(error)
			});
			return;
		}
		json$2(res, 200, verdict);
	};
}
/** Mount a guarded action on an optional webServer context. */
function registerGuardedActionRoute(ctx, options) {
	ctx.effect(() => {
		const dispose = ctx.webServer.register({
			kind: "exact",
			path: options.path,
			handler: guardedActionHandler({
				key: options.key,
				handler: options.handler
			})
		});
		return () => {
			dispose();
		};
	}, options.effectLabel);
}
/**
* The action behind the reset route.
*
* `at` is stamped after the write, not before: the card shows it as the moment
* the reset took effect, and a timestamp taken before a slow disk write would
* claim the reset happened earlier than it did.
*/
function deviceResetAction(deps) {
	return async () => {
		return {
			ok: true,
			accounts: (await deps.reset()).accounts,
			at: Date.now()
		};
	};
}
/** Mount the POST device-reset route on an optional webServer context. */
function registerQoderDeviceResetRoute(ctx, deps, key) {
	registerGuardedActionRoute(ctx, {
		path: deps.path ?? "/plugins/dsh-qoder-plugin/device-reset",
		key,
		effectLabel: "dsh-qoder-plugin: device reset route",
		handler: deviceResetAction(deps)
	});
}
/**
* Single-flight wrapper around the install.
*
* The install downloads a tarball, extracts it, and runs a self-check — tens of
* seconds on a good connection, and unbounded on a bad one. A request must not
* wait for that: the browser would time out long before the answer and the card
* would show a failure for an install that is still going. So the request
* starts the job and answers with its id; the card then polls the status
* document, which is a route it already polls.
*
* Single-flight because the work is idempotent but expensive and
* non-reentrant: two overlapping installs would race on the staging directory
* and could promote a half-written component. The second caller is told
* `alreadyRunning` with the SAME job id, so it can watch the job it did not
* start rather than being told it failed.
*
* A synchronous throw from `install` is deliberately NOT caught: it propagates
* to the route's guard, which reports `{ ok: false, error }` in the response.
* That is the only failure the caller can still be told about directly, and
* swallowing it would leave a request answered `started: true` for a job that
* never existed. Asynchronous rejections cannot reach the response — it is
* already sent — so they land in {@link QoderUmidInstallJobState.lastError},
* where the card reads them from the next status poll.
*
* @param install - the install itself.
* @param now - clock for job ids; injected so tests can pin it.
* @returns the runner.
*/
function createQoderUmidInstallRunner(install, now = Date.now) {
	let running;
	let lastError;
	let sequence = 0;
	return {
		start(force) {
			if (running !== void 0) return {
				started: false,
				jobId: running.jobId
			};
			sequence += 1;
			const job = { jobId: `umid-${now()}-${sequence}` };
			running = job;
			lastError = void 0;
			install(force).then((outcome) => {
				if (!outcome.ok) lastError = outcome.error ?? "the native component install failed";
			}, (error) => {
				lastError = safeMessage$1(error);
			}).finally(() => {
				if (running === job) running = void 0;
			});
			return {
				started: true,
				jobId: job.jobId
			};
		},
		state() {
			return {
				installing: running !== void 0,
				...running === void 0 ? {} : { jobId: running.jobId },
				...lastError === void 0 ? {} : { lastError }
			};
		}
	};
}
/** Read the `force` flag from a request body; anything else is "no". */
function readForce(body) {
	if (typeof body !== "object" || body === null) return false;
	return body["force"] === true;
}
/**
* The action behind the install route.
*
* `alreadyRunning` is an ANSWER, not an error: the user pressed the button
* twice, or a second card asked, and the honest reply is "a job is already
* running, watch this one" — the card then polls the status document. Reporting
* it as a failure would show an error for the state the user asked for.
*/
function umidInstallAction(runner) {
	return async (request) => {
		const { started, jobId } = runner.start(readForce(request.body));
		return started ? {
			ok: true,
			started: true,
			jobId
		} : {
			ok: true,
			alreadyRunning: true,
			jobId
		};
	};
}
/** Mount the POST native-component install route on an optional webServer context. */
function registerQoderUmidInstallRoute(ctx, deps, key) {
	registerGuardedActionRoute(ctx, {
		path: deps.path ?? "/plugins/dsh-qoder-plugin/umid-install",
		key,
		effectLabel: "dsh-qoder-plugin: native component install route",
		handler: umidInstallAction(deps.runner)
	});
}
//#endregion
//#region src/web-status.ts
/**
* How long a status document may reuse the billing answer it just read.
*
* Not a cache lifetime — the card's own poll interval decides freshness. This
* only collapses a burst the page itself creates (mount, the sibling-variant
* prefetch, a tab switch) into one upstream billing read, which is the slowest
* part of the document. An account switch changes the cache key, so the window
* never serves the previous account's numbers.
*/
const STATUS_CREDITS_REUSE_MS = 1e4;
/**
* Project a subscriber plan onto the fields the card renders.
*
* Only these three facts cross to the browser: the raw payload stays host-side
* and the organization is reduced to its display name. Shared by the ambient
* account's row and every pooled account's row — a plan that is named one way
* in the headline and another in the list would be a bug the user sees as two
* different subscriptions.
*/
function webPlan(plan) {
	if (plan === void 0) return void 0;
	return {
		planTierName: plan.planTierName,
		...plan.organization?.orgName === void 0 ? {} : { organizationName: plan.organization.orgName },
		...plan.endDate === void 0 ? {} : { endDate: plan.endDate }
	};
}
/** Redact token-like content before it crosses to the browser. */
function safeMessage(error) {
	return (error instanceof Error ? error.message : String(error)).replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/gu, "[redacted token]").replace(/(\b(?:code|token|pat)=)[^&\s]+/giu, "$1[redacted]").slice(0, 500);
}
function json$1(res, status, body) {
	const payload = JSON.stringify(body);
	res.writeHead(status, {
		"Content-Type": "application/json",
		"Content-Length": Buffer.byteLength(payload)
	});
	res.end(payload);
}
/**
* The request must be addressed to the loopback interface, and a
* browser-attached Origin must be loopback too. The Host check drops
* DNS-rebinding pages (their Host is the attacker's domain, not loopback);
* the card's same-origin fetches carry no Origin and pass on Host alone.
*/
function loopbackRequest(req) {
	return hostIsLoopback(req.headers.host) && originIsLoopback(req.headers.origin);
}
/** The `x<n>` rate label back into the number the snapshot carries, when honest. */
function priceFactorOf(info) {
	if (info.billing.rateUnknown === true) return void 0;
	const rate = normalizeCredits(info.billing.credits);
	if (rate === void 0) return void 0;
	const match = /^x([0-9]+(?:\.[0-9]+)?)$/u.exec(rate);
	if (match === null) return void 0;
	const value = Number(match[1]);
	return Number.isFinite(value) ? value : void 0;
}
/** One catalog row as the status document snapshots it. */
function modelSnapshot(model) {
	const supported = model.supportedContextWindows ?? [];
	const maxContextWindow = supported.length > 0 ? Math.max(...supported) : void 0;
	const defaultContextWindow = model.defaultContextWindow ?? model.contextWindow;
	const priceFactor = priceFactorOf(model);
	return {
		id: model.id,
		name: model.name,
		...model.contextWindow > 0 ? { contextWindow: model.contextWindow } : {},
		...defaultContextWindow > 0 && defaultContextWindow < model.contextWindow ? { defaultContextWindow } : {},
		...maxContextWindow === void 0 || maxContextWindow <= defaultContextWindow ? {} : { supportedContextWindows: supported },
		...model.reasoning?.supports === true ? { isReasoning: true } : {},
		...model.reasoning?.supportedEfforts !== void 0 && model.reasoning.supportedEfforts.length > 0 ? { reasoningEfforts: model.reasoning.supportedEfforts } : {},
		...model.reasoning?.defaultEffort === void 0 ? {} : { defaultReasoningEffort: model.reasoning.defaultEffort },
		...priceFactor === void 0 ? {} : { priceFactor },
		supportsImages: model.supportsImages,
		...model.source === void 0 ? {} : { source: model.source }
	};
}
/**
* Assemble the card's status document. Credential state is read-only; credit
* is a live billing answer whose failure degrades to `creditsError` rather
* than failing the whole document.
*/
async function qoderWebStatus(deps) {
	const nativeDevice = deps.nativeDevice?.();
	const authStatus = await deps.store.status();
	if (authStatus.state !== "configured") return {
		status: "signed-out",
		...authStatus.reason === void 0 ? {} : { reason: authStatus.reason },
		...deps.authKey === void 0 ? {} : { authKey: deps.authKey },
		...nativeDevice === void 0 ? {} : { nativeDevice }
	};
	const accountName = deps.accountName?.();
	const planField = webPlan(deps.plan?.());
	const patSummary = authStatus.pat === void 0 && accountName === void 0 ? void 0 : {
		source: authStatus.pat?.source ?? "card",
		...authStatus.pat?.savedAtMs === void 0 ? {} : { savedAtMs: authStatus.pat.savedAtMs },
		...authStatus.pat?.patTail === void 0 ? {} : { patTail: authStatus.pat.patTail },
		...accountName === void 0 ? {} : { accountName }
	};
	const status = {
		status: "signed-in",
		...authStatus.region === void 0 ? {} : { region: authStatus.region },
		...patSummary === void 0 ? {} : { pat: patSummary },
		...planField === void 0 ? {} : { plan: planField },
		...deps.authKey === void 0 ? {} : { authKey: deps.authKey },
		...nativeDevice === void 0 ? {} : { nativeDevice }
	};
	const modelsField = deps.models().map(modelSnapshot);
	const catalog = deps.catalog?.();
	const withCatalog = catalog === void 0 ? status : {
		...status,
		catalog
	};
	const statusWithModels = modelsField.length > 0 ? {
		...withCatalog,
		models: modelsField
	} : withCatalog;
	const probed = deps.probe === void 0 ? statusWithModels : {
		...statusWithModels,
		probe: deps.probe(),
		...deps.probeKey === void 0 ? {} : { probeKey: deps.probeKey },
		...deps.useMaximumContextWindow === void 0 ? {} : { useMaximumContextWindow: deps.useMaximumContextWindow() },
		...deps.disabledModels === void 0 ? {} : { disabledModels: deps.disabledModels() }
	};
	const refreshedAt = deps.jobTokenRefreshedAt?.();
	const withRefreshNotice = refreshedAt === void 0 ? probed : {
		...probed,
		jobTokenRefreshedAt: refreshedAt
	};
	const checkInRecord = deps.checkIn?.();
	const withCheckIn = checkInRecord === void 0 ? withRefreshNotice : {
		...withRefreshNotice,
		checkIn: {
			...checkInRecord,
			today: deps.today?.() ?? getClaimWindowDateString()
		}
	};
	const creditsResult = deps.client.fetchCredits(void 0, { maxAgeMs: STATUS_CREDITS_REUSE_MS }).then((credits) => ({
		ok: true,
		credits
	}), (error) => ({
		ok: false,
		error
	}));
	const [accountsSection, credits] = await Promise.all([Promise.resolve(deps.accounts?.()), creditsResult]);
	const withAccounts = accountsSection === void 0 ? withCheckIn : {
		...withCheckIn,
		accounts: accountsSection
	};
	const upstreamNotice = deps.upstreamNotice?.();
	const withInnerErrors = {
		...upstreamNotice === void 0 ? withAccounts : {
			...withAccounts,
			upstreamNotice
		},
		innerErrors: qoderInnerErrorSnapshot()
	};
	if (!credits.ok) return {
		...withInnerErrors,
		creditsError: safeMessage(credits.error)
	};
	return {
		...withInnerErrors,
		credits: credits.credits
	};
}
/** The status route's request handler, extracted so tests can mount it on a bare server. */
function qoderStatusHandler(deps) {
	return async (req, res) => {
		if (req.method !== "GET") {
			json$1(res, 405, { error: "method not allowed" });
			return;
		}
		if (!loopbackRequest(req)) {
			json$1(res, 403, { error: "request-not-trusted" });
			return;
		}
		try {
			json$1(res, 200, await qoderWebStatus(deps));
		} catch (error) {
			json$1(res, 500, { error: safeMessage(error) });
		}
	};
}
/** Mount the GET status route on an optional webServer context. */
function registerQoderStatusRoute(ctx, deps) {
	const path = deps.path ?? "/plugins/dsh-qoder-plugin/status";
	ctx.effect(() => {
		const dispose = ctx.webServer.register({
			kind: "exact",
			path,
			handler: qoderStatusHandler(deps)
		});
		return () => {
			dispose();
		};
	}, "dsh-qoder-plugin: Web status route");
}
//#endregion
//#region src/probe-route.ts
/**
* Probe control route: the only state-changing endpoint the plugin exposes.
*
* Two guards, because they stop different things (see `docs/reasoning-effort-probe-plan.md`
* §6.4 and the v0.3.1 note in AGENTS.md about their exact scope):
*
* 1. **Loopback Host + Origin**, shared with the status route. This drops
*    DNS-rebinding pages, whose requests arrive addressed to the attacker's
*    domain.
* 2. **An in-process random key**, minted per process and handed only to the
*    same-origin card. Loopback alone is *not* authentication — any local
*    process can write `Host: 127.0.0.1` — so a route that spends the user's
*    credit must prove the caller was told the key.
*
* The route never accepts a prompt, a model id outside the live catalog, or a
* sentinel from the browser: a probe request is assembled entirely host-side.
*
* @module dsh-qoder-plugin/probe-route
*/
/** Largest control body accepted; these payloads are a few dozen bytes. */
const MAX_BODY_BYTES = 4096;
/** Mint the per-process control key. */
function createProbeKey() {
	return randomBytes(24).toString("hex");
}
/**
* Constant-time key comparison; a length mismatch is a failure, not a crash.
*/
function keyMatches(expected, presented) {
	if (presented === void 0 || presented.length !== expected.length) return false;
	const a = Buffer.from(expected);
	const b = Buffer.from(presented);
	return a.length === b.length && timingSafeEqual(a, b);
}
function json(res, status, body) {
	const payload = JSON.stringify(body);
	res.writeHead(status, {
		"Content-Type": "application/json",
		"Content-Length": Buffer.byteLength(payload)
	});
	res.end(payload);
}
/** Read the request body with a hard ceiling. */
async function readBody(req) {
	const chunks = [];
	let total = 0;
	for await (const chunk of req) {
		const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
		total += buffer.length;
		if (total > MAX_BODY_BYTES) return void 0;
		chunks.push(buffer);
	}
	return Buffer.concat(chunks).toString("utf8");
}
/** Parse and shape-check an action; unknown fields are ignored, not trusted. */
function parseAction(text) {
	let parsed;
	try {
		parsed = JSON.parse(text);
	} catch {
		return;
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return void 0;
	const wrapped = parsed;
	const action = wrapped["action"];
	if (action === "clear") return { action: "clear" };
	if (action === "checkin") return { action: "checkin" };
	if (action === "refresh") return { action: "refresh" };
	if (action === "set-maximum-context-window") return typeof wrapped["enabled"] === "boolean" ? {
		action: "set-maximum-context-window",
		enabled: wrapped["enabled"]
	} : void 0;
	if (action === "set-model-context-window") {
		const model = wrapped["model"];
		if (typeof model !== "string" || model.trim() === "") return void 0;
		const raw = wrapped["window"];
		if (typeof raw !== "number" || !Number.isFinite(raw) || raw < 0) return void 0;
		return {
			action: "set-model-context-window",
			model: model.trim(),
			window: Math.floor(raw)
		};
	}
	if (action === "set-models-enabled") {
		if (typeof wrapped["enabled"] !== "boolean") return void 0;
		const rawModels = wrapped["models"];
		const rawModel = wrapped["model"];
		let models = [];
		if (Array.isArray(rawModels)) models = rawModels.filter((m) => typeof m === "string" && m.trim() !== "").map((m) => m.trim());
		else if (typeof rawModel === "string" && rawModel.trim() !== "") models = [rawModel.trim()];
		if (models.length === 0) return void 0;
		return {
			action: "set-models-enabled",
			models,
			enabled: wrapped["enabled"]
		};
	}
	if (action === "probe") {
		const model = wrapped["model"];
		if (typeof model !== "string" || model.trim() === "") return void 0;
		return {
			action: "probe",
			model: model.trim()
		};
	}
}
/**
* The control route's handler, extracted so tests can mount it on a bare
* server with a known key.
*/
function qoderProbeHandler(deps, key) {
	return async (req, res) => {
		if (req.method !== "POST") {
			json(res, 405, { error: "method not allowed" });
			return;
		}
		if (!hostIsLoopback(req.headers.host) || !originIsLoopback(req.headers.origin)) {
			json(res, 403, { error: "request-not-trusted" });
			return;
		}
		if (!keyMatches(key, req.headers["x-qoder-probe-key"])) {
			json(res, 403, { error: "invalid-probe-key" });
			return;
		}
		const body = await readBody(req);
		if (body === void 0) {
			json(res, 413, { error: "body too large" });
			return;
		}
		const action = parseAction(body);
		if (action === void 0) {
			json(res, 400, { error: "invalid action" });
			return;
		}
		try {
			if (action.action === "checkin") {
				if (deps.checkIn === void 0) {
					json(res, 404, { error: "checkin-not-supported" });
					return;
				}
				json(res, 200, await deps.checkIn());
				return;
			}
			if (action.action === "clear") {
				deps.clear();
				json(res, 200, { state: "cleared" });
				return;
			}
			if (action.action === "refresh") {
				if (deps.refresh === void 0) {
					json(res, 404, { error: "refresh-not-supported" });
					return;
				}
				json(res, 200, await deps.refresh());
				return;
			}
			if (action.action === "set-maximum-context-window") {
				if (deps.setMaximumContextWindow === void 0) {
					json(res, 404, { error: "context-window-setting-not-supported" });
					return;
				}
				json(res, 200, await deps.setMaximumContextWindow(action.enabled === true));
				return;
			}
			if (action.action === "set-model-context-window") {
				if (deps.setModelContextWindow === void 0) {
					json(res, 404, { error: "model-context-window-setting-not-supported" });
					return;
				}
				json(res, 200, await deps.setModelContextWindow({
					model: action.model,
					window: action.window ?? 0
				}));
				return;
			}
			if (action.action === "set-models-enabled") {
				if (deps.setModelsEnabled === void 0) {
					json(res, 404, { error: "models-enabled-setting-not-supported" });
					return;
				}
				json(res, 200, await deps.setModelsEnabled({
					models: action.models ?? (action.model ? [action.model] : []),
					enabled: action.enabled === true
				}));
				return;
			}
			json(res, 200, await deps.probe(action.model));
		} catch (error) {
			json(res, 500, { error: error instanceof Error ? error.message : String(error) });
		}
	};
}
/** Mount the POST probe-control route on an optional webServer context. */
function registerQoderProbeRoute(ctx, deps, key) {
	const path = deps.path ?? "/plugins/dsh-qoder-plugin/probe";
	ctx.effect(() => {
		const dispose = ctx.webServer.register({
			kind: "exact",
			path,
			handler: qoderProbeHandler(deps, key)
		});
		return () => {
			dispose();
		};
	}, "dsh-qoder-plugin: probe control route");
}
//#endregion
//#region src/checkin-scheduler.ts
/** Scheduling and catch-up orchestration for daily 10:00 (UTC+8) check-in. */
var JsonFileCheckInStore = class {
	filePath;
	constructor(filePath) {
		this.filePath = filePath ?? join(qoderPluginDataDir(), "checkin-status.json");
	}
	readAll() {
		try {
			if (!existsSync(this.filePath)) return {};
			const raw = readFileSync(this.filePath, "utf-8");
			return JSON.parse(raw);
		} catch {
			return {};
		}
	}
	read(variantId) {
		return this.readAll()[variantId];
	}
	write(variantId, record) {
		try {
			const all = this.readAll();
			all[variantId] = record;
			mkdirSync(dirname(this.filePath), { recursive: true });
			writeFileSync(this.filePath, JSON.stringify(all, null, 2), "utf-8");
		} catch {}
	}
};
/**
* The moment a variant checks in, as minutes past midnight in UTC+8.
*
* 600 is 10:00, which is when the upstream resets the daily campaign; it is
* also the default a variant falls back to when its setting is absent or
* malformed, so a bad stored value can never leave the day unscheduled.
*
* Aliased to the claim-window constant rather than restated: this moment IS
* the window opening, and two literals would let the timer and the window
* comparison drift apart the day someone edits one of them.
*/
const DEFAULT_CHECK_IN_MINUTE = 600;
/** Clamp any stored/typed value onto a real minute of the day. */
function normalizeCheckInMinute(value) {
	if (typeof value !== "number" || !Number.isFinite(value)) return DEFAULT_CHECK_IN_MINUTE;
	const whole = Math.trunc(value);
	if (whole < 0 || whole > 1439) return DEFAULT_CHECK_IN_MINUTE;
	return whole;
}
/**
* Calculates milliseconds until the next occurrence of `minuteOfDay` (UTC+8).
*
* Five seconds past the configured minute are used so the request lands after
* the upstream has flipped the day over rather than on the boundary itself.
*/
function msUntilNextCheckIn(minuteOfDay, nowMs = Date.now()) {
	const minute = normalizeCheckInMinute(minuteOfDay);
	const d = new Date(nowMs);
	const utc8Time = new Date(d.getTime() + (d.getTimezoneOffset() + 480) * 6e4);
	const targetUtc8 = new Date(utc8Time.getTime());
	targetUtc8.setHours(Math.floor(minute / 60), minute % 60, 5, 0);
	let diff = targetUtc8.getTime() - utc8Time.getTime();
	if (diff <= 0) {
		targetUtc8.setDate(targetUtc8.getDate() + 1);
		diff = targetUtc8.getTime() - utc8Time.getTime();
	}
	return diff;
}
/**
* Whether today's configured check-in moment (UTC+8) has already passed.
*/
function isPastCheckInTime(minuteOfDay, nowMs = Date.now()) {
	const minute = normalizeCheckInMinute(minuteOfDay);
	const d = new Date(nowMs);
	const utc8 = new Date(d.getTime() + (d.getTimezoneOffset() + 480) * 6e4);
	return utc8.getHours() * 60 + utc8.getMinutes() >= minute;
}
var CheckInScheduler = class {
	targets;
	isEnabled;
	store;
	onResult;
	now;
	/**
	* One timer per enabled variant, keyed by variant id.
	*
	* Per-variant rather than one shared timer because the two products may be
	* configured to different moments; a single timer would have to wake for the
	* earliest and then decide who was due, which is the same bookkeeping with a
	* worse failure mode.
	*/
	timers = /* @__PURE__ */ new Map();
	/**
	* Variants with a sweep in progress, so concurrent callers cannot double-claim.
	*/
	inFlight = /* @__PURE__ */ new Set();
	/** When each variant's timer is next due, epoch ms, for the card to show. */
	nextRuns = /* @__PURE__ */ new Map();
	disposed = false;
	constructor(options) {
		this.targets = options.targets;
		this.isEnabled = options.isEnabled;
		this.store = options.store ?? new JsonFileCheckInStore();
		this.onResult = options.onResult;
		this.now = options.now ?? Date.now;
	}
	start() {
		if (this.disposed) return;
		this.sweepAll(true);
		this.rearm();
	}
	/**
	* Re-run the startup catch-up once the toggles are actually readable.
	*
	* `start()` runs while the plugin is still assembling, before the settings
	* section that owns these toggles has handed over its stored values, so that
	* first sweep sees the raw plugin config and skips the day. The host calls
	* this again from the section's source callback; the sweep is idempotent, so
	* a day already handled costs nothing.
	*/
	catchUp() {
		if (this.disposed) return;
		this.sweepAll(true);
	}
	dispose() {
		this.disposed = true;
		for (const timer of this.timers.values()) clearTimeout(timer);
		this.timers.clear();
	}
	/**
	* Re-place every variant's timer.
	*
	* Called after each fire and whenever configuration lands or changes, so a
	* user editing the time on the card does not have to restart DSH for it to
	* take effect.
	*
	* A timer is placed for every target, including variants whose toggle is
	* currently off. `start()` runs while the plugin is still assembling, when
	* the stored toggles are not readable yet, so gating placement on
	* `isEnabled` left a variant with NO timer at all — and nothing re-armed it
	* afterwards, which is precisely how a configured 12:13 check-in never
	* fired. Whether the work is due is decided inside the sweep, where the
	* configuration is current; the timer only decides when to look.
	*/
	rearm() {
		if (this.disposed) return;
		for (const timer of this.timers.values()) clearTimeout(timer);
		this.timers.clear();
		this.nextRuns.clear();
		const nowMs = this.now();
		for (const target of this.targets) {
			const delay = msUntilNextCheckIn(target.minuteOfDay(), nowMs);
			this.nextRuns.set(target.variantId, nowMs + delay);
			const timer = setTimeout(() => {
				this.timers.delete(target.variantId);
				this.sweepAll(false, target.variantId).finally(() => {
					this.rearm();
				});
			}, delay);
			timer.unref?.();
			this.timers.set(target.variantId, timer);
		}
	}
	/** When this variant's timer is next due, epoch ms; absent before first arm. */
	nextRunAt(variantId) {
		return this.nextRuns.get(variantId);
	}
	async sweepAll(isCatchUp, only) {
		if (this.disposed) return;
		const nowMs = this.now();
		for (const target of this.targets) {
			if (only !== void 0 && target.variantId !== only) continue;
			if (!this.isEnabled(target.variantId)) continue;
			if (this.inFlight.has(target.variantId)) continue;
			this.inFlight.add(target.variantId);
			try {
				await this.sweepOne(target, isCatchUp, nowMs);
			} finally {
				this.inFlight.delete(target.variantId);
			}
		}
	}
	async sweepOne(target, isCatchUp, nowMs) {
		const record = this.store.read(target.variantId);
		const currentWindow = getClaimWindowDateString(nowMs, target.minuteOfDay());
		if (record?.lastDate === currentWindow && (record.status === "claimed" || record.status === "already-claimed")) {
			if (!isCatchUp) this.store.write(target.variantId, {
				lastDate: currentWindow,
				lastAt: nowMs,
				status: "already-claimed",
				...record.amount === void 0 ? {} : { amount: record.amount },
				message: "Scheduled check-in ran; this window was already claimed"
			});
			return;
		}
		if (isCatchUp && !isPastCheckInTime(target.minuteOfDay(), nowMs)) return;
		let result;
		try {
			result = await target.checkIn();
		} catch {
			return;
		}
		try {
			if (result.status !== "error") {
				this.store.write(target.variantId, {
					lastDate: currentWindow,
					lastAt: result.timestamp,
					status: result.status,
					amount: result.amount,
					message: result.message,
					...result.expiresAtMs === void 0 ? {} : { expiresAtMs: result.expiresAtMs }
				});
				if (result.status === "claimed") target.onClaimed?.();
			}
			this.onResult?.(result);
		} catch {}
	}
};
//#endregion
//#region src/job-token-hint.ts
/** The name recorded on the hint row (and therefore its displayed title). */
const JOB_TOKEN_HINT_NAME = "qoder";
/** The context captured at install time, for its session store. */
let installed;
/** Refresh time per agent id, so a later read can name when it happened. */
const lastRefreshAt = /* @__PURE__ */ new Map();
/** The most recent agent observed entering a running turn. */
let lastRunningAgent;
/** Monotonic suffix keeping appended ids unique within this process. */
let hintSeq = 0;
/** Monotonic mark for the latest observed turn, and the turn each agent is in. */
let turnSeq = 0;
const turnByAgent = /* @__PURE__ */ new Map();
/**
* The last upstream notice printed, per agent, with the turn it was printed in.
*
* The host retries a RATE_LIMIT several times inside one turn and the queue
* answer is identical on every attempt, so without this the conversation would
* collect the same row once per retry.
*/
const lastNoticeByAgent = /* @__PURE__ */ new Map();
/**
* How many agent ids the per-agent bookkeeping above remembers at most.
*
* Nothing removes an entry when a conversation ends, so without a bound these
* maps grow for the life of the process — one entry per agent id ever seen,
* which a long-lived host with many conversations reaches. The cap is far above
* any plausible number of live conversations; eviction only costs an evicted
* agent its de-duplication (one notice may print twice) and its remembered
* refresh time.
*/
const AGENT_MEMORY_LIMIT = 256;
/**
* Record one per-agent fact, keeping the map bounded and in recency order.
*
* Re-inserting moves the key to the end, so the map's insertion order is also
* its recency order and evicting the first key evicts the least recently
* updated agent.
*/
function remember(map, agentId, value) {
	map.delete(agentId);
	map.set(agentId, value);
	if (map.size <= AGENT_MEMORY_LIMIT) return;
	const oldest = map.keys().next().value;
	if (oldest !== void 0) map.delete(oldest);
}
/**
* Start tracking which agent is running, and keep the session store reachable.
*
* `agent/status` is a plain `emit` event: a listener that returns nothing
* cannot disturb the emitting path (unlike a waterfall event, where a listener
* owes the chain its `next()` call). It is no longer the PRIMARY way to pick a
* conversation — the request's own session id is — but it still supplies the
* fallback target for callers that carry no id, and it advances the turn mark
* the upstream-notice guard is scoped to.
*
* The turn mark matters because a `running` status is what opens a turn: the
* identical notice is suppressed inside one and allowed again in the next, which
* is exactly the recurrence the notice wording reports as a risk-control signal.
*/
function installJobTokenHint(ctx) {
	installed = ctx;
	ctx.on("agent/status", ((payload) => {
		if (payload.status === "running" && payload.agent !== void 0) {
			lastRunningAgent = payload.agent;
			turnSeq += 1;
			remember(turnByAgent, String(payload.agent.id), turnSeq);
		}
	}));
}
/**
* The session store, or `undefined` when this host has none.
*
* The two ways to read it, in order, and why neither may be a bare property
* read on the install-time context:
*
* 1. **The soft lookup `ctx.get`.** On a real host `ctx.sessions` is a service
*    property, and Cordis throws `cannot get property "sessions" without
*    inject` when the plugin's `inject` list does not name it. This module
*    deliberately declares nothing — the store is optional diagnostics
*    plumbing, not a reason to withhold the plugin until a service appears —
*    so the mixed-in `ctx.get(name, false)` is the way to ask for it: it walks
*    the same service table and answers `undefined` instead of throwing. The
*    `false` is the non-strict flag, which also accepts a store whose own
*    fiber is not active right now.
* 2. **The plain property.** Test contexts (and any host that hands a bare
*    object) provide `sessions` as an ordinary field, with no proxy in the
*    way. On a real Cordis context this read is exactly the one that throws,
*    so it stays wrapped.
*
* Either read can throw for a reason of its own (a host without a reflection
* layer, a getter that rejects), and a diagnostics line is never worth a
* request: a store that cannot be read is a store this host does not have.
*/
function sessionStore() {
	const ctx = installed;
	if (ctx === void 0) return void 0;
	try {
		const store = ctx.get?.("sessions", false);
		if (store !== void 0 && store !== null) return store;
	} catch {}
	try {
		const direct = ctx.sessions;
		if (direct !== void 0 && direct !== null) return direct;
	} catch {}
}
/**
* The stored session for one id, or `undefined` when it is not in the store.
*
* `get` belongs to the host's store implementation, so it can throw as well;
* a miss is the same outcome as a store that is not there.
*/
function storedSession(sessionId) {
	const store = sessionStore();
	if (store === void 0) return void 0;
	try {
		return store.get(sessionId);
	} catch {
		return;
	}
}
/**
* Resolve the conversation a row belongs to.
*
* The id is the issuing request's own session id, which the transport carries
* because requests run concurrently and no remembered "current agent" can say
* which conversation a given queue answer or heal belongs to. With an id the
* rule is strict:
*
* - the session store's own object for that id wins — it is the live log the
*   client is reading, and it also works for a conversation that is idle right
*   now (a session-title or compaction request belongs to its own conversation,
*   not to whoever started most recently);
* - otherwise the remembered agent, but ONLY when it is that same conversation;
* - otherwise nothing. The row is dropped rather than printed into a
*   conversation whose request it does not describe: a missing diagnostics line
*   is a lost detail, a misplaced one is a false statement about someone else's
*   chat.
*
* Without an id there is nothing to be strict about, so the old best-effort
* target stands: the most recently running agent.
*
* @param sessionId - The issuing request's session id, `undefined` when the
*   request carried none.
*/
function resolveTarget(sessionId) {
	if (sessionId === void 0) {
		const agent = lastRunningAgent;
		return agent?.session === void 0 ? void 0 : {
			id: String(agent.id),
			session: agent.session
		};
	}
	const stored = storedSession(sessionId);
	if (stored !== void 0) return {
		id: sessionId,
		session: stored
	};
	const agent = lastRunningAgent;
	if (agent?.session !== void 0 && String(agent.id) === sessionId) return {
		id: sessionId,
		session: agent.session
	};
}
/**
* Print the refresh row into the conversation whose request triggered it.
*
* Best effort by design: a missing agent, an absent session, or a projection
* that rejects the append must never affect the chat that just recovered.
*
* @param at - When the job token was rotated.
* @param text - The row's summary line.
* @param sessionId - The conversation whose request healed; see
*   {@link resolveTarget}.
*/
function emitJobTokenHint(at, text, sessionId) {
	try {
		const target = resolveTarget(sessionId);
		if (target === void 0) return;
		remember(lastRefreshAt, target.id, at);
		appendHintRow(target.session, "success", text);
	} catch {}
}
/**
* Print the failed-heal row into the conversation whose request triggered it.
*
* The mirror of {@link emitJobTokenHint}: the self-heal ran, exchanged a fresh
* job token, retried, and the upstream still refused. Without this row that
* outcome was silent — the user saw only the resulting authorization failure
* and could not tell that recovery had already been attempted and lost.
*
* Rate limited by the transport (once per unresolved outage), not here: this
* module stays a pure printer so the dedupe policy lives with the state that
* knows when an outage ends.
*
* @param at - When the failed heal was recorded.
* @param text - The row's summary line.
* @param sessionId - The conversation whose request failed to heal; see
*   {@link resolveTarget}.
*/
function emitJobTokenRefreshFailedHint(at, text, sessionId) {
	try {
		const target = resolveTarget(sessionId);
		if (target === void 0) return;
		appendHintRow(target.session, "error", text);
	} catch {}
}
/**
* Print one upstream "model not serviceable" notice into the conversation whose
* request produced it.
*
* The same best-effort printer as the job-token rows. The request it describes
* has already been answered with the upstream's own queue/unserviceable body,
* so a missing agent session must never turn a diagnostics line into a second
* failure: no target, no row, and the chat keeps whatever outcome it had.
*
* Guarded per turn. The host retries a `RATE_LIMIT` several times inside one
* turn and the upstream's queue answer is byte-identical on each attempt, so
* without the guard the conversation would stack one identical row per retry.
* Identical text is the key, not "any notice": a turn that first reports the
* queue without waiting and later reports the waited-out retry has two
* different facts to tell and prints both. The turn mark advances on every
* `agent/status` `running`, so the same notice may legitimately surface again
* in a later turn — and that recurrence is what the wording reports as a
* possible risk-control signal.
*
* @param text - The rendered notice line (see `formatQueueNotice`).
* @param sessionId - The conversation whose request produced this answer; see
*   {@link resolveTarget}.
*/
function emitUpstreamNotice(text, sessionId) {
	if (text === "") return;
	try {
		const target = resolveTarget(sessionId);
		if (target === void 0) return;
		const id = target.id;
		const turn = turnByAgent.get(id) ?? 0;
		const printed = lastNoticeByAgent.get(id);
		if (printed !== void 0 && printed.turn === turn && printed.text === text) return;
		remember(lastNoticeByAgent, id, {
			turn,
			text
		});
		appendHintRow(target.session, "error", text);
	} catch {}
}
/** Append one log-only command pair carrying `text` as its outcome. */
function appendHintRow(session, kind, text) {
	const commandId = `cmd-qoder-hint-${Date.now().toString(36)}-${++hintSeq}`;
	try {
		session.append("command/run", {
			commandId,
			name: JOB_TOKEN_HINT_NAME,
			source: { kind: "user" }
		});
		session.append("command/done", {
			commandId,
			kind,
			text
		});
	} catch {}
}
//#endregion
//#region src/settings-store.ts
/**
* Plugin-owned settings store — the single source of truth for this plugin's
* user configuration on every host line.
*
* WHY THIS EXISTS
*
* A settings write on DSH 0.1.7 goes through the profile patch
* (`configEditor.edit`), which reconciles the whole loader tree and hot-reloads
* the plugin's fiber (~1–1.5 s, plus a storm of client mirror refreshes) on
* EVERY write — one per toggled switch. The plugin's own files (the credential,
* the catalog cache) have always lived in `<profile>/.dsh-qoder-plugin/`, so
* the settings move there too: a write becomes a small atomic local file write
* with an in-memory apply, no tree reconcile, no reload.
*
* FILE
*   <plugin data dir>/settings.json   (same directory as the credential)
*
* The data directory is resolved by `qoderPluginDataDir()` — the ONE discovery
* implementation this plugin already has (env override, then the declaring
* profile, then the installing link). It is deliberately not re-implemented
* here: a second copy of that logic is how a nested `.dsh-qoder-plugin/
* .dsh-qoder-plugin/` path gets shipped.
*
* LAYERS
*   the file holds the user's live edits once the card has written through
*   {@link SettingsStore.patch}; until then the entry config in the profile
*   patch stays the fallback layer the caller overlays it on.
*
* @module dsh-qoder-plugin/settings-store
*/
/** Settings file name inside the plugin data directory. */
const SETTINGS_FILE_NAME = "settings.json";
/** This plugin's data directory (shared with the credential and caches). */
function dataDir() {
	return qoderPluginDataDir();
}
/** Absolute path of the settings file. */
function settingsFilePath() {
	return join(dataDir(), SETTINGS_FILE_NAME);
}
/** Read + parse the settings file; `undefined` when absent or unreadable. */
function readFile() {
	const path = settingsFilePath();
	if (!existsSync(path)) return void 0;
	try {
		const parsed = JSON.parse(readFileSync(path, "utf8"));
		return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : void 0;
	} catch {
		return;
	}
}
/** Write the settings file atomically (tmp + rename), creating the directory. */
function writeSettings(values) {
	const path = settingsFilePath();
	mkdirSync(dirname(path), { recursive: true });
	const tmp = `${path}.tmp`;
	writeFileSync(tmp, `${JSON.stringify(values, null, 2)}\n`, "utf8");
	renameSync(tmp, path);
}
/**
* Reserved bookkeeping key: how many writes the settings card has made through
* this store. Its presence separates "the file holds user edits" from "the
* file is absent" — see {@link SettingsStore.edited}. Field readers address
* their fields by name and never collide with it.
*/
const WRITE_MARK = "__writes";
/**
* One store instance: the plugin's own settings file, with the entry config as
* the fallback layer the caller overlays it on.
*/
var SettingsStore = class {
	/** The user layer exactly as stored (presence marks an override). */
	user;
	constructor() {
		this.user = readFile() ?? {};
	}
	/** Whether the store file exists. */
	exists() {
		return existsSync(settingsFilePath());
	}
	/**
	* Whether the settings card has ever written through this store.
	*
	* False until the first card write. While false the entry config stays
	* authoritative; once the card writes, the file is — a runtime edit must
	* never be regressed by a stale profile row.
	*/
	get edited() {
		return typeof this.user[WRITE_MARK] === "number" && this.user[WRITE_MARK] > 0;
	}
	/**
	* Apply one patch in memory and persist it.
	* @param patch - field → value; a `null` value clears the field.
	* @param fromCard - true when the settings card made this write; marks the
	*   file as holding live user edits from then on.
	* @returns the new user layer.
	*/
	patch(patch, fromCard = false) {
		const next = { ...this.user };
		for (const [field, value] of Object.entries(patch)) if (value === null) delete next[field];
		else next[field] = value;
		if (fromCard) next[WRITE_MARK] = (typeof next[WRITE_MARK] === "number" ? next[WRITE_MARK] : 0) + 1;
		writeSettings(next);
		for (const key of Object.keys(this.user)) delete this.user[key];
		Object.assign(this.user, next);
		return this.user;
	}
	/** The current user layer. */
	values() {
		return this.user;
	}
};
//#endregion
//#region src/index.ts
/**
* Qoder models for DeepSeek Harness, driven by Personal Access Tokens.
* Registers one provider per product variant — `qoder` for the China region
* and `qoder-global` for the international one — while streaming, tool calls,
* compaction, and permissions stay Harness-owned.
*
* The two variants are assembled by the same factory and differ only in their
* {@link QoderVariant} descriptor: each gets its own credential store,
* transport, catalog, upstream client, shim, adapter, probe state, and routes.
* Neither variant's startup, catalog fetch, or credential state can stop the
* other from registering — a user with only one token sees only that group.
*
* @module dsh-qoder-plugin
*/
/** Stable Cordis plugin name (matches the profile row id in cordis.patch.yml). */
const name = "qoder-plugin";
/** The model registry required before the provider can register. */
const inject = ["llm"];
/**
* Settings namespace owning the China card's section.
*
* DSH 0.1.2 dropped the `settingsNamespace()` branding function: a namespace is
* now a nominal string, validated by the type system where it is used rather
* than at runtime by a function call. The brand is compile-time only, so this
* stays the plain string it always was — every comparison, descriptor lookup,
* and `dsh` config file still sees `'qoder'`. It is cast once here so the
* public constant carries the seam's type without pulling the brand helper
* into this package (upstream DSH plugins, `dsh-llm-pi-ai` included, pass
* their namespaces as plain string literals).
*/
const QODER_SETTINGS_NS = "qoder";
/**
* Settings namespace owning the global card's section.
*
* One namespace per card, not one shared: the settings Plugins tab dispatches a
* card by rendering `settings.plugin.item` with `entryKey = ns` for each
* namespace the Host serves, and skips an entry whose key names no served
* namespace. With a single installed section, the global card registers
* into the slot but is never rendered — the card list is built from the Host's
* sections, not from the slot's entries. Each card therefore needs its own
* installed section whose namespace equals the card's slot key.
*/
const QODER_GLOBAL_SETTINGS_NS = "qoder-global";
/**
* How often the credential files are re-checked, in milliseconds.
*
* A startup-only catalog fetch cannot notice a token saved while DSH is
* already running, so the model group would not appear until a restart. This
* poll is a cheap existence/parse read of at most a few local files: it never
* contacts the network and never runs a reasoning probe.
*
* `DSH_QODER_POLL_MS` overrides it. That exists so the sweep can be
* exercised end to end in tests and shortened while diagnosing a slow
* sign-in on a real machine; it is not a product setting and no UI exposes it.
* The value is clamped to a sane range so a mistaken override cannot turn the
* poll into a busy loop.
*/
const CREDENTIAL_POLL_MS = 3e4;
/** Floor and ceiling for the overridable poll interval. */
const MIN_POLL_MS = 100;
const MAX_POLL_MS = 864e5;
/** Resolve the sweep interval, honoring the override when it is usable. */
function credentialPollMs() {
	const override = Number(process.env["DSH_QODER_POLL_MS"]);
	if (!Number.isFinite(override) || override < MIN_POLL_MS) return CREDENTIAL_POLL_MS;
	return Math.min(override, MAX_POLL_MS);
}
/**
* How long to wait before retrying a catalog fetch that failed.
*
* The credential sweep deliberately does not re-fetch a catalog it already has
* (the same token carries no new model information). But a *failed* fetch must
* not be treated the same way: without a retry, one transient network blip at
* startup would leave the group on the built-in fallback roster until the user
* noticed and pressed refresh. This bound keeps that recovery automatic while
* still honoring the "not every round" rule — at most one attempt per
* interval, and none at all once a live catalog lands.
*
* Expressed as a multiple of the sweep rather than a fixed duration so the two
* stay in proportion under the `DSH_QODER_POLL_MS` override.
*/
const CATALOG_RETRY_SWEEPS = 10;
/**
* Mark one configuration field as a live projected setting, when the host has
* that concept at all.
*
* DSH 0.1.7 projects a `.volatile()` field into the profile's settings form and
* hands the plugin a STABLE REFERENCE instead of the value; a field without the
* mark never reaches the form — `dsh-settings`' `describe()` skips an entry
* whose schema has no volatile field (`lib/index.js:411-421`), which is exactly
* what makes the browser-side `configForms` namespace exist. DSH 0.1.5's
* schemastery has no `volatile` at all, so calling it there is a `TypeError`
* that would take the whole plugin down with it. The method is therefore
* probed, never assumed.
*
* Only TOP-LEVEL fields are marked: a volatile field may not sit inside another
* volatile field, and schemastery rejects a volatile node reached through a
* collection (`validateVolatileSchema`), while the 0.1.7 client writes a single
* path segment (`ConfigFormController.set` → `path: [field]`). Every field this
* plugin exposes is already a top-level member of {@link Config}, so marking
* the field itself is both legal and the only granularity the write path can
* address.
*
* @param field - the field's schema.
* @returns the projected schema on a host that supports projection, else the field itself.
*/
function volatileField(field) {
	const probe = field;
	if (typeof probe.volatile === "function") return probe.volatile();
	if (typeof probe.extra === "function") return probe.extra("volatile", true);
	if (probe && typeof probe === "object") {
		probe.meta = {
			...probe.meta,
			volatile: true
		};
		return probe;
	}
	return field;
}
/**
* Read one configuration field through the volatile indirection.
*
* On DSH 0.1.7 a `.volatile()` field arrives as a reference object whose value
* is read with `.get()` (`@deepseek-ai/dsh-agent-default-model`,
* `lib/index.js:38-41`); on DSH 0.1.5 the plain value arrives directly. Every
* read of a projected field goes through here, so both hosts yield the value
* itself.
*
* @param config - the raw plugin configuration, in either host's shape.
* @param field - field name inside the configuration object.
* @returns the field's value, or undefined when the field is absent.
*/
function readField(config, field) {
	const value = config?.[field];
	return value !== null && typeof value === "object" && typeof value.get === "function" ? value.get() : value;
}
/**
* Read one declared field with its declared type.
*
* The typed face of {@link readField}, for the few call sites that want a
* single field rather than a whole {@link readConfig}.
*
* @param config - the raw plugin configuration, in either host's shape.
* @param field - field name inside the configuration object.
* @returns the field's plain value, or undefined when it is absent.
*/
function readConfigField(config, field) {
	return readField(config, field);
}
/** Probe authorization (shared by the plugin schema and the China section). */
const PROBE_CONSENT_FIELD = volatileField(z.boolean().default(false).description("Authorize reasoning-effort probes (each probe sends real requests that may consume credit)"));
const MAXIMUM_CONTEXT_WINDOW_FIELD = volatileField(z.boolean().default(true).description("Use the largest context window declared by Qoder Global when alternatives are available (on by default)"));
/** The China variant's own maximum-window preference. */
const MAXIMUM_CONTEXT_WINDOW_CN_FIELD = volatileField(z.boolean().default(true).description("Use the largest context window declared by Qoder (China) when alternatives are available (on by default)"));
/**
* Per-model window overrides (model id → tokens). The card writes one entry
* per selector change; the field is optional so an absent map means "no
* overrides" rather than a default object the host must keep in sync.
*/
const MODEL_CONTEXT_WINDOWS_FIELD = volatileField(z.dict(z.number().min(1), z.string()).description("Per-model context-window overrides for Qoder Global (model id → tokens)"));
/** Disabled models list (blacklist) */
const DISABLED_MODELS_FIELD = volatileField(z.array(z.string()).default([]).description("Models hidden from the provider catalog and picker"));
/**
* The whole-variant master switch (one per variant).
*
* On by default: an existing profile keeps serving both products. Off makes
* the provider expose none of that variant's models, while the card still
* lists them (see `QoderCatalog.setEnabled`).
*/
const VARIANT_ENABLED_FIELD = volatileField(z.boolean().default(true).description("启用该版本的全部模型（默认开启）"));
/**
* Legacy sidebar-quota toggle (one per variant).
*
* The sidebar card no longer exists — the composer readout shows credits — so
* this field is declared only so older settings files keep validating. The
* description says as much, because the settings reference documents it as a
* no-op and a promise of a sidebar card here would contradict that.
*/
const QUOTA_TOGGLE_FIELD = volatileField(z.boolean().default(false).description("历史字段：侧栏额度卡已取消，此开关不再有任何效果（保留仅为兼容旧配置文件）"));
/** Automatic check-in toggle. */
const AUTO_CHECK_IN_FIELD = volatileField(z.boolean().default(false).description("每天自动签到领取算力额度（默认关闭）"));
/**
* The SHARED check-in moment (one control for both variants), as minutes past
* midnight in UTC+8.
*
* Stored as a plain minute count rather than a "HH:mm" string so the schema
* itself rejects an impossible time: a browser time input yields 0–1439, and
* anything outside that range fails Host validation instead of silently
* scheduling a request at a moment that never arrives.
*/
const CHECK_IN_MINUTE_FIELD = volatileField(z.number().default(DEFAULT_CHECK_IN_MINUTE).min(0).max(1439).description("国内版与国际版共用的每日自动签到时刻（自 UTC+8 午夜起的分钟数，600 = 10:00）"));
/**
* Quota poll interval: default 5 minutes, floor 1 minute. The status route
* performs a live upstream billing call per request with no cache, so an
* aggressively small interval translates directly into upstream load; the
* floor is the smallest value the UI offers rather than a silent clamp —
* smaller staged values fail Host validation and refuse to save.
*/
const QUOTA_POLL_DEFAULT_MS = 3e5;
const QUOTA_POLL_MIN_MS = 6e4;
const QUOTA_POLL_FIELD = volatileField(z.number().default(QUOTA_POLL_DEFAULT_MS).min(QUOTA_POLL_MIN_MS).description("Sidebar quota card refresh interval in milliseconds (default 300000, minimum 60000)"));
/** Automatic failover master switch (on by default; one account makes it inert). */
const AUTO_FAILOVER_FIELD = volatileField(z.boolean().default(true).description("账号连接失败时自动切换到下一个账号（默认开启）"));
/** Queue wait master switch: off reports a queued answer at once (on by default). */
const QUEUE_WAIT_ENABLED_FIELD = volatileField(z.boolean().default(true).description("排队重试总开关：关闭后上游排队直接报错，不再等待重试（默认开启）"));
/** Queue wait retry count: 0 = report at once, 1..10 retries. */
const QUEUE_WAIT_ATTEMPTS_FIELD = volatileField(z.number().default(5).min(0).max(10).description("上游排队时的重试次数（0 = 不重试，默认 5 次，最多 10 次）"));
/** Queue wait seconds per retry: 1..300. */
const QUEUE_WAIT_SECONDS_FIELD = volatileField(z.number().default(30).min(1).max(300).description("每次排队重试前等待的秒数（1–300）"));
/** Routing strategy: save order, or the user's own order. */
const ROUTING_STRATEGY_FIELD = volatileField(z.union([z.const("save-order"), z.const("custom")]).default("save-order").description("账号试用顺序：save-order = 保存顺序，custom = 自定义优先级"));
/** The user's own account order (ids across both variants). */
const ROUTING_ORDER_FIELD = volatileField(z.array(z.string()).default([]).description("自定义账号优先级（可跨国内/国际版混排，顺序即试用顺序）"));
/** Stickiness master switch: off hides the three bounds and disables stickiness. */
const STICKINESS_ENABLED_FIELD = volatileField(z.boolean().default(true).description("会话粘性总开关：关闭后不再保持同一账号，每次请求都重新选择账号"));
/** Stickiness rounds: 0 disables. Default 0 — requests and minutes still bound. */
const STICKINESS_ROUNDS_FIELD = volatileField(z.number().default(0).min(0).max(100).description("会话粘性：同一账号连续服务多少轮对话后自动换到下一个账号；一轮 = 一次用户提问到回答完成（含工具调用步骤），换号只在两轮之间发生（0 = 不限制）"));
/** Stickiness requests: 0 disables. Default 0 — minutes still bound. */
const STICKINESS_REQUESTS_FIELD = volatileField(z.number().default(0).min(0).max(1e4).description("会话粘性：同一账号连续服务多少次请求后自动换到下一个账号；换号只在两轮之间发生（0 = 不限制）"));
/** Stickiness minutes: 0 disables. Default 240. */
const STICKINESS_MINUTES_FIELD = volatileField(z.number().default(240).min(0).max(1440).description("会话粘性：同一账号连续服务多少分钟后自动换到下一个账号；换号只在两轮之间发生（0 = 不限制）"));
const Config = z.object({
	probeConsent: PROBE_CONSENT_FIELD,
	useMaximumContextWindow: MAXIMUM_CONTEXT_WINDOW_FIELD,
	useMaximumContextWindowCN: MAXIMUM_CONTEXT_WINDOW_CN_FIELD,
	modelContextWindows: MODEL_CONTEXT_WINDOWS_FIELD,
	modelContextWindowsCN: MODEL_CONTEXT_WINDOWS_FIELD,
	disabledModels: DISABLED_MODELS_FIELD,
	disabledModelsCN: DISABLED_MODELS_FIELD,
	variantEnabledCN: VARIANT_ENABLED_FIELD,
	variantEnabledGlobal: VARIANT_ENABLED_FIELD,
	sidebarQuotaCN: QUOTA_TOGGLE_FIELD,
	sidebarQuotaGlobal: QUOTA_TOGGLE_FIELD,
	autoCheckInCN: AUTO_CHECK_IN_FIELD,
	autoCheckInGlobal: AUTO_CHECK_IN_FIELD,
	checkInMinute: CHECK_IN_MINUTE_FIELD,
	quotaPollMs: QUOTA_POLL_FIELD,
	autoFailoverEnabled: AUTO_FAILOVER_FIELD,
	queueWaitEnabled: QUEUE_WAIT_ENABLED_FIELD,
	queueWaitAttempts: QUEUE_WAIT_ATTEMPTS_FIELD,
	queueWaitSeconds: QUEUE_WAIT_SECONDS_FIELD,
	routingStrategy: ROUTING_STRATEGY_FIELD,
	routingOrder: ROUTING_ORDER_FIELD,
	stickinessEnabled: STICKINESS_ENABLED_FIELD,
	stickinessRounds: STICKINESS_ROUNDS_FIELD,
	stickinessRequests: STICKINESS_REQUESTS_FIELD,
	stickinessMinutes: STICKINESS_MINUTES_FIELD
});
/**
* Every field each settings section owns, and therefore every field the live
* configuration has to carry through.
*
* One list per section, shared by the merge and by the test that pins it to
* the schema. Writing the merge out by hand is what broke auto check-in: the
* `qoder-quota` section grew four fields (`autoCheckInCN`, `autoCheckInGlobal`,
* `checkInMinute`, `quotaPollMs`) while the merge kept copying only the three
* that predated them, so `current().autoCheckInCN` read `undefined` forever and
* the scheduler saw the toggle as permanently off. The card saved it, the file
* held it, and nothing ever acted on it.
*/
const CN_SECTION_KEYS = [
	"probeConsent",
	"useMaximumContextWindowCN",
	"modelContextWindowsCN",
	"disabledModelsCN",
	"variantEnabledCN"
];
const GLOBAL_SECTION_KEYS = [
	"useMaximumContextWindow",
	"modelContextWindows",
	"disabledModels",
	"variantEnabledGlobal"
];
const QUOTA_SECTION_KEYS = [
	"sidebarQuotaCN",
	"sidebarQuotaGlobal",
	"autoCheckInCN",
	"autoCheckInGlobal",
	"checkInMinute",
	"quotaPollMs",
	"autoFailoverEnabled",
	"queueWaitEnabled",
	"queueWaitAttempts",
	"queueWaitSeconds",
	"routingStrategy",
	"routingOrder",
	"stickinessEnabled",
	"stickinessRounds",
	"stickinessRequests",
	"stickinessMinutes"
];
/** Every declared configuration field, in the order the sections are merged. */
const CONFIG_KEYS = [
	...CN_SECTION_KEYS,
	...GLOBAL_SECTION_KEYS,
	...QUOTA_SECTION_KEYS
];
/** Copy the declared fields off one section's source, skipping absent ones. */
function pickFields(source, keys) {
	const value = source();
	const picked = {};
	for (const key of keys) {
		const field = readField(value, key);
		if (field !== void 0) picked[key] = field;
	}
	return picked;
}
/**
* Unwrap a whole configuration object into plain values.
*
* The merged configuration is read through {@link pickFields}/{@link readField}
* everywhere else, but the plugin also reads its initial config directly while
* it assembles its runtimes — before any settings section has handed over a
* source. On 0.1.7 those direct reads would otherwise compare a reference
* object against `true`/`undefined` and silently see "not set" for every field.
*
* @param config - the raw plugin configuration, in either host's shape.
* @returns the same configuration with every declared field read out.
*/
function readConfig(config) {
	return pickFields(() => config, CONFIG_KEYS);
}
/** Stable identity key used by credentials, probe records, and catalog entries. */
const credentialIdentity = qoderCredentialIdentity;
/** The settings namespace a variant's card and provider directory entry use. */
function settingsNamespaceFor(variant) {
	return variant.id === CHINA_VARIANT.id ? QODER_SETTINGS_NS : QODER_GLOBAL_SETTINGS_NS;
}
/**
* The static catalog a variant serves before its first successful fetch.
*
* Both regions share one roster transcribed from the transport's built-in
* model defaults: unlike the WorkBuddy-era endpoints, the Qoder pools are
* region-specific only in what discovery lists, and inventing a second roster
* from nothing would misdescribe whichever variant it was not captured from.
*/
function fallbackFor(_variant) {
	return FALLBACK_QODER_MODELS;
}
/**
* The hint row's summary line: what happened, and when.
*
* Named here rather than in the hint module because the text is this plugin's
* user-facing wording, and the transport callback that produces it runs before
* the plugin's own scope exists.
*/
function jobTokenHintText(at) {
	return `jobToken 已自动刷新（${new Date(at).toLocaleTimeString("zh-CN", { hour12: false })}）— 旧令牌被上游拒绝，已自动重换并恢复`;
}
/**
* The failed-heal row's summary line.
*
* Deliberately does not name a cause: the upstream rejection that survived a
* fresh token is not necessarily an authorization problem at all, and the real
* reason travels in the failure message itself (see the SSE envelope body).
* Claiming "quota" or "revoked" here would be a guess presented as a finding.
*
* It also must not point the reader at "the error above": the failed heal does
* not always belong to a chat whose failure renders a card in this
* conversation. A heal inside the session-title request — same transport,
* same shared notice state — fails silently there, so the row used to send
* users looking for an error card that does not exist. The row states only
* what is known: the retry ran, it did not recover, the request failed.
*/
function jobTokenRefreshFailedHintText(at) {
	return `jobToken 已重换但仍被上游拒绝（${new Date(at).toLocaleTimeString("zh-CN", { hour12: false })}）— 自愈未恢复，该请求已失败`;
}
/**
* The conversation row written when an automatic account switch happens.
*
* The row carries the visible copy (the card's tag only reports the state
* afterwards), and it says what actually happened rather than naming the
* account: the row is appended to whichever conversation was running, and this
* module has only the redacted reason the transport classified — never a token,
* never an upstream body. A switch caused by a queue answer is reported by
* {@link formatQueueNotice} instead; this one is the connection/interruption
* case, where there is no upstream explanation to quote.
*/
function failoverNoticeText(reason) {
	return `已自动切换到下一个账号重试（原因：${reason}）— 当前请求由备用账号继续`;
}
/**
* Whether a connection failure could be absorbed by switching accounts.
*
* This is the derived fact the card's 「自动切换」 tag reports, and it is not the
* same claim as the user's setting: the walk needs somewhere to go, so a pool
* with no second usable seat cannot fail over even with the switch on. Parked
* seats are out of the walk (`accountById` refuses them), so they must not
* count towards "another account exists" — otherwise a two-seat pool with the
* spare parked would still advertise automatic switching.
*
* Kept as a named function because the host's status document is assembled
* inline, and this is the one part of it a test can pin without booting a
* whole fiber.
*/
function autoFailoverActive(enabled, entries) {
	if (enabled === false) return false;
	return entries.filter((entry) => entry.enabled !== false).length > 1;
}
/**
* Every seat in the pool, flattened into the shape {@link autoFailoverActive}
* reads: one flag per row, `enabled: false` for a parked one.
*
* Reading both files is what makes the derived 「自动切换」 fact honest for a
* mixed pool. It costs two file reads per status request — the same reads the
* walk itself does, and the document is assembled on demand rather than polled
* in a tight loop.
*/
async function poolSeatFlags(members) {
	const seats = /* @__PURE__ */ new Map();
	for (const member of members) for (const account of await member.store.list()) seats.set(account.id, (seats.get(account.id) ?? false) || account.enabled !== false);
	return [...seats.values()].map((usable) => usable ? {} : { enabled: false });
}
/**
* Move the stored active pointer to the account a failover just switched to.
*
* The retry itself is already answering with the successor's PAT, so this move
* only decides which account every LATER read (catalog, credits, the card)
* resolves. A refusal is therefore harmless to the request in flight: the id
* can go stale between the transport's walk and this write when the account is
* removed in another tab, and a failed adoption must not turn a recovered
* request into an error. The caller still records the switch and still reports
* it — the switch did happen, only its stored pointer is behind. Returns
* whether the pointer moved; warns with the reason when it did not.
*/
async function adoptFailoverAccount(store, accountId, warn) {
	try {
		await store.activate(accountId);
		return true;
	} catch (error) {
		warn(`dsh-qoder-plugin: could not adopt the failover account (${accountId}): ${error instanceof Error ? error.message : String(error)}`);
		return false;
	}
}
/**
* The walk's view of the pool: this variant's file first, then its siblings.
*
* Local-first is not cosmetic — it is what keeps a single-region install
* byte-for-byte unchanged. The sibling contributes no rows there, so every
* resolution lands on the same store the walk always used, and the extra reads
* are two cheap file misses. For a mixed pool it also gives the save-order walk
* a sane continuation: this file ends, and the walk resumes in the other one
* instead of looping back to an account it has already tried.
*/
function poolOrder(pool, variant) {
	const all = pool();
	const own = all.filter((runtime) => runtime.variant.id === variant.id);
	const siblings = all.filter((runtime) => runtime.variant.id !== variant.id);
	return [...own, ...siblings];
}
/**
* The variant whose credential file stores `accountId`, if any file holds it.
*
* The same PAT can be saved in both files (the copy-paste case {@link poolRing}
* collapses), and one copy can be parked while the other is usable. The pool
* decides a seat is usable when ANY copy is, so the file named here is the one
* holding a usable copy: moving the active pointer in the parked file would
* leave the account that actually serves requests unpinned.
*/
async function poolOwner(order, accountId) {
	for (const runtime of order) {
		const found = await runtime.store.byId(accountId);
		if (found === void 0 || found.enabled === false) continue;
		return runtime;
	}
}
/**
* Project one stored row the way the transport consumes it: id, PAT, region.
*
* The region is the row's OWN stamp (written by whichever file stores it, never
* trusted from disk), and it is the only thing that tells the transport which
* endpoint set may sign this credential. Dropping it here is what used to make
* every cross-variant hand-off an AUTH failure.
*/
function pooledAccount(account) {
	return {
		id: account.id,
		pat: account.pat,
		region: account.region
	};
}
/**
* By-id resolution across the pool, for custom routing and pinned sessions.
*
* The id is a hash of the PAT, so a row normally lives in one file — but the
* same PAT saved in both files gives the id two copies, and one copy can be
* parked while the other is usable. {@link poolRing} seats the id when ANY copy
* is usable, so resolution has to agree: a parked copy must not hide the usable
* one, or a seat the ring hands the walk becomes one the walk cannot name. A row
* no file holds resolves to nothing, which is how the walk skips an account
* removed in another tab.
*/
async function pooledAccountById(order, accountId) {
	for (const runtime of order) {
		const found = await runtime.store.byId(accountId);
		if (found === void 0 || found.enabled === false) continue;
		return pooledAccount(found);
	}
}
/**
* The pool as one ordered ring: every file's usable rows, local file first.
*
* Each file keeps its own save order, and the pool is their concatenation —
* the same local-first order {@link poolOrder} gives the walk. Parked rows are
* dropped here rather than skipped later, because the ring's answer must not
* depend on which file it happens to look in: the transport treats "not in the
* pool" and "parked" identically, and building the ring once is what lets the
* walk continue into the sibling file at exactly the point its own file ends.
*
* Reading the files costs one `list()` per variant per step. That is the same
* on-demand read the store already does for every `nextAfter` call, and the
* pool has two files at most.
*/
async function poolRing(order) {
	const ring = [];
	const seen = /* @__PURE__ */ new Set();
	for (const runtime of order) for (const account of await runtime.store.list()) {
		if (account.enabled === false) continue;
		if (seen.has(account.id)) continue;
		seen.add(account.id);
		ring.push(pooledAccount(account));
	}
	return ring;
}
/**
* How many accounts the pool has SAVED, parked ones included.
*
* Distinct ids across every file, so a PAT stored in both files counts once —
* the same identity rule {@link poolRing} uses, minus the usability filter. The
* device-code reset rotates one host-level seed, which re-identifies a parked
* account exactly like a serving one, so this is the number the card reports.
*/
async function savedAccountCount(pool) {
	const saved = /* @__PURE__ */ new Set();
	for (const runtime of pool()) for (const account of await runtime.store.list()) saved.add(account.id);
	return saved.size;
}
/**
* The account after `accountId`, continuing across the pool's files.
*
* This is the save-order leg. Within one file it is exactly the store's own
* `nextAfter`; at the end of a file the walk continues with the NEXT file's
* first row, and only after the last file does it wrap to the pool's first
* row. That is the difference from the per-file walk: it used to wrap inside
* its own document, so an account in the other variant's file was never
* reached by save order at all — the very leg the two-file pool was supposed
* to extend.
*
* An id no file holds (removed in another tab, or the step after a pin to a
* since-deleted account) restarts the ring at its first row instead of
* dead-ending, which is the same "one silent extra lap" the per-file walk
* always had, now spanning the pool. The transport's own `tried` set is what
* stops a lap from repeating.
*/
async function pooledNextAccount(order, accountId) {
	const ring = await poolRing(order);
	if (ring.length === 0) return void 0;
	const index = ring.findIndex((account) => account.id === accountId);
	if (index === -1) return ring[0];
	return ring[(index + 1) % ring.length];
}
/**
* Move the active pointer in whichever file stores the account a switch chose.
*
* The pointer that has to move is the OWNING variant's — the card, the catalog
* and the credits all resolve "the active account" out of their own file, so a
* cross-region switch that only warned would leave the card pointing at the
* account that just failed while the request signs as the sibling's. The
* per-file semantics stay intact: a variant's file still records exactly one
* active row, it is just chosen by whoever owns the row.
*/
async function adoptPooledAccount(order, accountId, warn) {
	const owner = await poolOwner(order, accountId);
	if (owner === void 0) {
		warn(`dsh-qoder-plugin: could not adopt the failover account (${accountId}): no variant can serve it`);
		return false;
	}
	return await adoptFailoverAccount(owner.store, accountId, warn);
}
/** Build one variant's stores, transport, and probe state. */
function createVariantRuntime(ctx, config, variant, current, identityOf, pool, health) {
	const store = new QoderCredentialStore({
		variant,
		logger: ctx.logger
	});
	const cacheScope = resolve(dirname(store.ownAuthPath()));
	let jobTokenRefreshedAt;
	/**
	* How long an upstream "not serviceable" answer keeps describing the present.
	*
	* The upstream's own answer is transient by construction — it names a retry
	* delay, typically 30 s — so a notice older than this bound is no longer a
	* description of anything the user is about to hit, and keeping it on the
	* card would report a stale condition as a live one. Same convention (and the
	* same five minutes) as the job-token notice, which is the other notice about
	* a condition that clears itself.
	*/
	const queueNoticeMaxAgeMs = 3e5;
	/**
	* The live queue notice: the last answer, when it arrived, and how many times
	* it has come back within the same outage window.
	*/
	let queueNotice;
	let queueNoticeSessionId;
	/** The last automatic account switch, for the card. */
	let failoverAt;
	let failoverReason;
	const resolveAttachmentService = () => {
		const service = ctx.get("attachments");
		if (service === void 0) throw new Error("dsh-qoder-plugin: no attachment service is available");
		return service;
	};
	const attachments = {
		get imageLimits() {
			return resolveAttachmentService().imageLimits;
		},
		readImageRequest: async (attachment, policy, signal) => await resolveAttachmentService().readImageRequest(attachment, policy, signal),
		saveImage: async (request) => await resolveAttachmentService().saveImage(request)
	};
	const transport = createQoderTransport({
		region: variant.region,
		resolvePat: () => store.patPromise(),
		resolveMachineId: () => getMachineId(),
		resolveDeviceSeed: () => readDeviceSeed(),
		attachments,
		failover: {
			enabled: () => current().autoFailoverEnabled !== false,
			activeAccount: async () => {
				const credential = await store.current();
				if (credential !== void 0) {
					const id = qoderCredentialIdentity(credential);
					const row = await store.byId(id);
					if (row === void 0 || row.enabled !== false) return {
						id,
						pat: credential.pat,
						region: credential.region
					};
				}
				return (await poolRing(poolOrder(pool, variant)))[0];
			},
			nextAccount: async (id) => await pooledNextAccount(poolOrder(pool, variant), id),
			accountById: async (id) => await pooledAccountById(poolOrder(pool, variant), id),
			adopted: async (info) => {
				await adoptPooledAccount(poolOrder(pool, variant), info.toId, (message) => {
					ctx.logger.warn(message);
				});
				ctx.logger.warn(`dsh-qoder-plugin: ${variant.displayName} adopted ${info.toId} after the previous account entered a cooldown (${info.reason})`);
			},
			failed: (info) => {
				health.noteFailure(info.accountId, info.at);
			},
			switched: async (info) => {
				await adoptPooledAccount(poolOrder(pool, variant), info.toId, (message) => {
					ctx.logger.warn(message);
				});
				failoverAt = Date.now();
				failoverReason = info.reason;
				queueNotice = void 0;
				ctx.logger.warn(`dsh-qoder-plugin: ${variant.displayName} switched accounts after a connection failure (${info.reason})`);
				emitUpstreamNotice(failoverNoticeText(info.reason), info.sessionId);
			}
		},
		onUpstreamQueue: (facts, accountId, sessionId, waits) => {
			const at = Date.now();
			if (accountId !== void 0) health.noteQueue(accountId, at);
			const previous = queueNotice;
			const sameOutage = previous !== void 0 && at - previous.at <= queueNoticeMaxAgeMs;
			const advisedMs = facts.retryAfterSeconds === void 0 || facts.retryAfterSeconds <= 0 ? void 0 : facts.retryAfterSeconds * 1e3;
			const transportWaited = waits !== void 0 && waits.attempts > 0;
			const waitedByHostClock = sameOutage && sessionId === queueNoticeSessionId && advisedMs !== void 0 && at - previous.at >= advisedMs;
			const waited = transportWaited || waitedByHostClock;
			queueNoticeSessionId = sessionId;
			queueNotice = {
				kind: facts.serviceAvailable === false ? "unavailable" : "queued",
				...facts.upstreamMessage === void 0 ? {} : { upstreamMessage: facts.upstreamMessage },
				...advisedMs === void 0 ? {} : { retryAfterMs: advisedMs },
				waited,
				at,
				occurrences: sameOutage ? previous.occurrences + 1 : 1,
				...waits === void 0 ? {} : { waits }
			};
			ctx.logger.warn(`dsh-qoder-plugin: ${variant.displayName} upstream model is not serviceable (${facts.subCode ?? "no sub-code"}, retry after ${facts.retryAfterSeconds ?? "unknown"}s)`);
			emitUpstreamNotice(formatQueueNotice(facts, {
				waited,
				occurrences: queueNotice.occurrences,
				...waits === void 0 ? {} : { waits }
			}), sessionId);
		},
		onQueueWait: (facts, accountId, wait, sessionId) => {
			ctx.logger.warn(`dsh-qoder-plugin: ${variant.displayName} upstream model is queued; waiting ${Math.round(wait.waitMs / 1e3)}s before retry ${wait.attempt}/${wait.attempt + wait.remaining} (account ${accountId ?? "ambient"}, wait driven by ${wait.basis?.source ?? "unknown"})`);
			emitUpstreamNotice(formatQueueWaitNotice(facts, wait), sessionId);
		},
		onChatAccepted: (accountId, sessionId) => {
			queueNotice = void 0;
			if (accountId !== void 0) health.noteConnected(accountId, Date.now());
		},
		onJobTokenRefreshed: (info) => {
			jobTokenRefreshedAt = info.at;
			ctx.logger.warn(`dsh-qoder-plugin: ${variant.displayName} job token was auto-refreshed after an upstream rejection`);
			emitJobTokenHint(info.at, jobTokenHintText(info.at), info.sessionId);
		},
		onJobTokenRefreshFailed: (info) => {
			ctx.logger.warn(`dsh-qoder-plugin: ${variant.displayName} job token refresh did not recover the chat (upstream status ${info.status ?? "unknown"})`);
			emitJobTokenRefreshFailedHint(info.at, jobTokenRefreshFailedHintText(info.at), info.sessionId);
		},
		queueWait: {
			attempts: () => current().queueWaitEnabled === false ? 0 : current().queueWaitAttempts ?? 5,
			seconds: () => current().queueWaitSeconds ?? 30
		},
		stickiness: {
			enabled: () => current().stickinessEnabled !== false,
			rounds: () => current().stickinessRounds ?? 0,
			requests: () => current().stickinessRequests ?? 0,
			minutes: () => current().stickinessMinutes ?? 240
		},
		routing: {
			strategy: () => current().routingStrategy ?? "save-order",
			order: () => current().routingOrder ?? []
		},
		now: () => Date.now()
	});
	const client = new QoderUpstreamClient({
		region: variant.region,
		providerId: variant.id,
		getPat: () => store.patPromise(),
		transport,
		attachments
	});
	const fallback = fallbackFor(variant);
	const catalog = new QoderCatalog(fallback);
	const initial = current();
	if (variant.id !== CHINA_VARIANT.id) {
		catalog.setUseMaximumContextWindow(initial.useMaximumContextWindow === true);
		if (initial.disabledModels !== void 0) catalog.setDisabledModels(initial.disabledModels);
		catalog.setEnabled(initial.variantEnabledGlobal !== false);
	} else {
		catalog.setUseMaximumContextWindow(initial.useMaximumContextWindowCN === true);
		if (initial.modelContextWindowsCN !== void 0) catalog.setModelContextWindows(initial.modelContextWindowsCN);
		if (initial.disabledModelsCN !== void 0) catalog.setDisabledModels(initial.disabledModelsCN);
		catalog.setEnabled(initial.variantEnabledCN !== false);
	}
	catalog.setVisible(false);
	const probeStore = new QoderProbeStore({
		pluginVersion: QODER_CONNECT_VERSION,
		path: qoderProbePath(variant.probeFilename)
	});
	const savedCatalogs = new QoderCatalogStore({ path: qoderCatalogPath(variant.catalogFilename) });
	return {
		variant,
		store,
		cacheScope,
		client,
		transport,
		catalog,
		probeStore,
		probeService: new QoderProbeService({
			store: probeStore,
			catalog,
			credentials: store,
			client,
			consent: () => current().probeConsent === true,
			account: () => identityOf(variant.id, cacheScope)
		}),
		savedCatalogs,
		fallback,
		catalogSource: "fallback",
		catalogFetchedAtMs: void 0,
		catalogError: void 0,
		lastFetchAtMs: 0,
		catalogGeneration: 0,
		inflightFetch: void 0,
		invalidate: () => {},
		registered: false,
		jobTokenRefreshedAt: () => jobTokenRefreshedAt,
		upstreamNotice: () => {
			if (queueNotice === void 0) return void 0;
			if (Date.now() - queueNotice.at > queueNoticeMaxAgeMs) {
				queueNotice = void 0;
				return;
			}
			return queueNotice;
		},
		failoverAt: () => failoverAt,
		failoverReason: () => failoverReason,
		healthOf: (accountId) => health.healthOf(accountId, Date.now()),
		forgetHealth: (accountId) => {
			health.forget(accountId);
		},
		checkIn: (signal) => transport.checkIn(signal)
	};
}
/** The catalog provenance the card displays. */
function catalogSection(runtime) {
	return {
		source: runtime.catalogSource,
		...runtime.catalogFetchedAtMs === void 0 ? {} : { fetchedAt: runtime.catalogFetchedAtMs },
		...runtime.catalogError === void 0 ? {} : { error: runtime.catalogError }
	};
}
/**
* Whether a model can be probed by hand: it reasons and the upstream declares
* no effort set for it.
*
* Deliberately *not* filtered by whether a result already exists. Dropping a
* model once it has been detected made the list shrink with use, so
* re-detecting one model — after an upstream change, say — meant clearing every
* other result first. The list stays stable and the card marks which entries
* already have an answer.
*/
function isProbeCandidate(info) {
	if (info.reasoning?.supports !== true) return false;
	return (info.reasoning.supportedEfforts?.length ?? 0) === 0;
}
/** Compact probe state for one card: consent, candidates, observations. */
function probeSection(runtime, consent) {
	const models = runtime.catalog.current();
	const results = models.flatMap((info) => {
		const record = runtime.probeService.recordFor(info.id);
		if (record === void 0) return [];
		return [{
			id: info.id,
			name: info.name,
			validation: record.validation,
			efforts: record.efforts,
			probedAt: record.probedAtMs
		}];
	});
	return {
		consent,
		running: runtime.probeService.isRunning(),
		candidates: models.filter(isProbeCandidate).map((info) => info.id),
		results: newestFirst(results)
	};
}
/**
* Run a detached promise without letting its failure kill the host.
*
* Node terminates the whole process on an unhandled rejection (exit code 1),
* which the desktop shell reports as the backend having "exited unexpectedly"
* — so a failing heartbeat write, loopback close, or background sweep in this
* plugin would take the entire Harness down with it. Every fire-and-forget
* call therefore carries a handler; a failure is a diagnostic, never a reason
* for the host to die.
*/
function detach(ctx, work, what) {
	work.catch((error) => {
		ctx.logger.warn(`dsh-qoder-plugin: ${what} failed`, error);
	});
}
/**
* Start one variant: its loopback endpoint, provider registration, and
* configuration-card wiring.
*
* Registration waits for the shim to hold a port, because the provider's
* models read the shim origin at construction time. A failure here is
* contained to this variant: the caller logs it and the other keeps working.
*
* @param seedCatalog - adopt the current credential into this runtime's
*   catalog immediately; supplied by `apply` (it owns `adoptIdentity`).
* @returns whether the provider registered.
*/
async function startVariant(ctx, runtime, seedCatalog) {
	const { variant, store, client, catalog, probeService } = runtime;
	const shim = createQoderShim({
		store,
		client,
		catalog,
		providerId: variant.id,
		logger: ctx.logger
	});
	try {
		await shim.ready;
	} catch (error) {
		ctx.logger.error(`dsh-qoder-plugin: ${variant.displayName} loopback endpoint failed to start`, error);
		return false;
	}
	try {
		const qoder = createQoderAdapter({
			providerId: variant.id,
			displayName: variant.displayName,
			shim,
			store,
			catalog,
			resolveAttachments: () => ctx.get("attachments"),
			observe: (modelId) => probeService.recordFor(modelId)
		});
		runtime.invalidate = () => {
			qoder.invalidate();
			ctx.emit("llm/adapters-updated");
		};
		let releaseAdapter;
		let releaseDirectory;
		try {
			releaseAdapter = ctx.llm.registerAdapter([variant.id], qoder.adapter);
			const entryId = ctx.fiber?.entry?.options?.id;
			const settingsNs = entryId !== void 0 ? entryId : settingsNamespaceFor(variant);
			releaseDirectory = ctx.llm.registerConfigurableProviders([{
				provider: variant.id,
				displayName: variant.displayName,
				settingsNs,
				settingsPath: [],
				declared: false
			}]);
		} finally {
			if (releaseAdapter === void 0 || releaseDirectory === void 0) {
				releaseAdapter?.();
				releaseDirectory?.();
			}
		}
		try {
			ctx.effect(() => () => {
				releaseAdapter?.();
				releaseDirectory?.();
				detach(ctx, shim.close(), "loopback endpoint close");
			});
		} catch {
			releaseAdapter?.();
			releaseDirectory?.();
			detach(ctx, shim.close(), "loopback endpoint close");
		}
		runtime.registered = true;
		detach(ctx, seedCatalog(), `${variant.id} catalog seed`);
		return true;
	} catch (error) {
		ctx.logger.error(`dsh-qoder-plugin: ${variant.displayName} provider registration failed`, error);
		detach(ctx, shim.close(), "loopback endpoint close");
		return false;
	}
}
/**
* State that MUST survive a fiber reload, module-level on purpose.
*
* DSH 0.1.7's configuration write (`configEditor.edit`) reconciles the profile
* tree, which hot-reloads the entry's fiber — `apply()` runs again with a fresh
* closure. Anything re-minted per apply is therefore invalidated by every
* settings write: the browser cards hold the keys the status document handed
* them, so a per-apply key turns each write into a wave of 403s ("刷新失败"),
* and a per-apply identity map makes the sweep re-fetch the catalog from
* upstream on every write (the burst of requests and most of the latency).
*
* Keys and identity/fetch bookkeeping are per-PROCESS secrets and caches, not
* per-instance state, so they live here once. A reload keeps the same keys (no
* 403 storm) and a same-account, freshly-fetched sweep (no refetch burst).
*/
/** The in-process control keys, minted once per process. */
let processKeys;
function controlKeys() {
	processKeys ??= {
		probe: createProbeKey(),
		auth: createAuthKey()
	};
	return processKeys;
}
/** The loopback guard the probe and status routes use, restated for settings. */
function trustedSettingsRequest(req) {
	const host = req.headers.host ?? "";
	const origin = req.headers.origin;
	if (!/^(localhost|127(?:\.\d{1,3}){3}|\[::1\])(?::\d+)?$/i.test(String(host))) return false;
	return origin === void 0 || /^https?:\/\/(localhost|127(?:\.\d{1,3}){3}|\[::1\])(?::\d+)?$/i.test(String(origin));
}
/**
* The schema defaults, READ off each field's own `meta.default`.
*
* Two ways this was got wrong before, both silent and both destructive: a
* hand-written table drifted from the schema (so the schema's own defaults
* were classified as real overrides and the legacy settings document could
* never win), and `validate({})` was then tried instead — which on this
* schemastery answers with hollow `{}` per field instead of applying the
* defaults, which is worse than nothing because it looks like it worked.
* Walking `Config.dict` for `meta.default` is the only honest source: it is
* the value schemastery itself substituted during validation.
*/
const DEFAULT_FOR_FIELD = (() => {
	const out = {};
	try {
		for (const [key, field] of Object.entries(Config.dict ?? {})) {
			const fallback = field?.meta?.default;
			if (fallback !== void 0) out[key] = fallback;
		}
	} catch {}
	if (Object.keys(out).length === 0) return {
		probeConsent: false,
		useMaximumContextWindow: true,
		useMaximumContextWindowCN: true,
		modelContextWindows: {},
		modelContextWindowsCN: {},
		disabledModels: [],
		disabledModelsCN: [],
		variantEnabledCN: true,
		variantEnabledGlobal: true,
		sidebarQuotaCN: false,
		sidebarQuotaGlobal: false,
		autoCheckInCN: false,
		autoCheckInGlobal: false,
		checkInMinute: 600,
		quotaPollMs: 3e5,
		autoFailoverEnabled: true,
		queueWaitEnabled: true,
		queueWaitAttempts: 5,
		queueWaitSeconds: 30,
		routingStrategy: "save-order",
		routingOrder: [],
		stickinessEnabled: true,
		stickinessRounds: 0,
		stickinessRequests: 0,
		stickinessMinutes: 240
	};
	return out;
})();
/**
* Register the settings face (GET/POST) the browser cards read and write
* through, answering the whole entry configuration as three layers.
*
* `value` carries every declared field, so a card rendering the quota section
* sees the same merged view the host itself reads; `user` is the settings file
* exactly as stored (presence marks an override), which is what the staged-edit
* form's "written/reset" display needs. A POST validates the fields it is
* allowed to touch, writes the file, applies the new view in memory, and
* re-arms the check-in scheduler (the old 0.1.5 section `onChange` behaviour).
*/
function registerQoderSettingsFace(ctx, deps) {
	const { store, config, current, apply, rearm } = deps;
	const key = controlKeys().probe;
	/** The document both routes answer with. */
	const view = () => {
		const merged = current();
		const value = {};
		const base = {};
		for (const field of CONFIG_KEYS) {
			if (merged[field] !== void 0) value[field] = merged[field];
			base[field] = readConfig(config)[field] ?? DEFAULT_FOR_FIELD[field];
		}
		return {
			key,
			value,
			base,
			user: store.values()
		};
	};
	ctx.effect(() => {
		const dispose = ctx.webServer.register({
			kind: "exact",
			path: QODER_SETTINGS_FACE_PATH,
			handler: async (req, res) => {
				if (!trustedSettingsRequest(req)) {
					jsonFace(res, 403, { error: "request-not-trusted" });
					return;
				}
				if (req.method === "GET") {
					jsonFace(res, 200, view());
					return;
				}
				if (req.method !== "POST") {
					jsonFace(res, 405, { error: "method not allowed" });
					return;
				}
				if (req.headers["x-qoder-settings-key"] !== key) {
					jsonFace(res, 403, { error: "invalid-key" });
					return;
				}
				const body = await readFaceBody(req);
				if (body === void 0) {
					jsonFace(res, 413, { error: "body too large" });
					return;
				}
				let patch;
				try {
					patch = JSON.parse(body || "{}");
				} catch {
					jsonFace(res, 400, { error: "invalid json" });
					return;
				}
				if (patch === null || typeof patch !== "object" || Array.isArray(patch)) {
					jsonFace(res, 400, { error: "invalid patch" });
					return;
				}
				const invalid = validateSettingsPatch(patch);
				if (invalid !== void 0) {
					jsonFace(res, 400, { error: invalid });
					return;
				}
				store.patch(patch, true);
				apply(current());
				rearm();
				jsonFace(res, 200, view());
			}
		});
		return () => {
			dispose();
		};
	}, "dsh-qoder-plugin: settings face");
}
/** JSON response helper for the settings face. */
function jsonFace(res, status, body) {
	const payload = JSON.stringify(body);
	res.writeHead(status, { "Content-Type": "application/json" });
	res.end(payload);
}
/** Read the request body, or undefined when absent or oversized. */
function readFaceBody(req) {
	return new Promise((resolve) => {
		let body = "";
		req.on("data", (chunk) => {
			body += String(chunk);
			if (body.length > 1e6) resolve(void 0);
		});
		req.on("end", () => resolve(body));
		req.on("error", () => resolve(void 0));
	});
}
/** Schema-level validation of one settings patch; the reason, or undefined. */
function validateSettingsPatch(patch) {
	for (const [field, value] of Object.entries(patch)) {
		if (!CONFIG_KEYS.includes(field)) return `unknown field ${field}`;
		if (value === null) continue;
		switch (field) {
			case "probeConsent":
			case "useMaximumContextWindow":
			case "useMaximumContextWindowCN":
			case "variantEnabledCN":
			case "variantEnabledGlobal":
			case "sidebarQuotaCN":
			case "sidebarQuotaGlobal":
			case "autoCheckInCN":
			case "autoCheckInGlobal":
			case "autoFailoverEnabled":
			case "queueWaitEnabled":
				if (typeof value !== "boolean") return `${field} must be a boolean`;
				break;
			case "disabledModels":
			case "disabledModelsCN":
			case "routingOrder":
				if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) return `${field} must be an array of strings`;
				break;
			case "routingStrategy":
				if (value !== "save-order" && value !== "custom") return `${field} must be "save-order" or "custom"`;
				break;
			case "queueWaitAttempts":
				if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > 10) return `${field} must be an integer 0..10`;
				break;
			case "queueWaitSeconds":
				if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 300) return `${field} must be an integer 1..300`;
				break;
			case "stickinessEnabled":
				if (typeof value !== "boolean") return `${field} must be a boolean`;
				break;
			case "stickinessRounds":
				if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > 100) return `${field} must be an integer 0..100`;
				break;
			case "stickinessRequests":
				if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > 1e4) return `${field} must be an integer 0..10000`;
				break;
			case "stickinessMinutes":
				if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > 1440) return `${field} must be an integer 0..1440`;
				break;
			case "checkInMinute":
				if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > 1439) return `${field} must be an integer minute 0..1439`;
				break;
			case "quotaPollMs":
				if (typeof value !== "number" || !Number.isInteger(value) || value < 6e4) return `${field} must be an integer of at least 60000 ms`;
				break;
			case "modelContextWindows":
			case "modelContextWindowsCN": if (typeof value !== "object" || value === null || Array.isArray(value)) return `${field} must be an object`;
		}
	}
}
/** The account identity each variant last published a catalog for, across reloads. */
const lastIdentities = /* @__PURE__ */ new Map();
/**
* When a variant's catalog was last fetched LIVE from upstream, per identity.
*
* A reload reseeds the catalog from the saved file; without this record the
* sweep's retry rule (`stale && due`) sees `lastFetchAtMs = 0` and re-fetches
* immediately — one upstream round trip per variant per settings write.
*/
const lastLiveFetchAt = /* @__PURE__ */ new Map();
/**
* The cache key for one variant's catalog identity, scoped to a data root.
*
* Both maps above are module-level so they survive the settings write that
* re-applies the plugin — but "the plugin" is per data root, and one process can
* host more than one (two profiles, or two temporary roots in a test run).
* Keying by variant id alone let one root's last account and live-fetch time
* answer for another's: a second root with the same PAT then skipped its own
* catalog fetch, and an account switch in one root cleared another root's probe
* observations. The scope is the directory of the credential file (see
* `VariantRuntime.cacheScope`), so a custom store path stays isolated too.
*/
function identityCacheKey(cacheScope, variantId) {
	return `${cacheScope}\0${variantId}`;
}
/** The same scoping rule for the live-fetch record, keyed by account. */
function liveFetchCacheKey(cacheScope, identity) {
	return `${cacheScope}\0${identity}`;
}
/**
* Start both variants: their loopback endpoints, the `qoder` and
* `qoder-global` providers, their configuration cards, and their
* credential-driven catalog lifecycles.
*
* Each variant registers unconditionally; what varies is whether its catalog is
* *visible*. An empty catalog is how DSH hides a model group (the host filters
* out groups with no models), which keeps a token saved after startup working
* without re-registering the provider.
*/
function apply(ctx, config) {
	const store = new SettingsStore();
	const current = () => ({
		...readConfig(config),
		...store.values()
	});
	/** Timers and in-flight work belonging to this plugin instance. */
	let stopped = false;
	const timers = [];
	const runtimes = [];
	const pool = () => runtimes;
	const health = new QoderAccountHealthTracker();
	for (const variant of QODER_VARIANTS) runtimes.push(createVariantRuntime(ctx, config, variant, () => current(), (variantId, cacheScope) => lastIdentities.get(identityCacheKey(cacheScope, variantId)), pool, health));
	const checkInStore = new JsonFileCheckInStore();
	/**
	* When one variant's daily claim window opens, in minutes past midnight UTC+8.
	*
	* One definition, used by both the scheduler's timer and the status route's
	* `today` stamp. They must agree: the scheduler decides whether a window was
	* already claimed using this moment, and the card decides whether to offer
	* the button using the same notion of "now" — if the two drifted, the card
	* could offer an action the sweep considered done, or hide one it considered
	* due.
	*
	* A missing or out-of-range stored value must never leave a variant
	* unscheduled, so it falls back to the documented default rather than to
	* "now" or to an instant that never comes.
	*/
	const variantWindowMinute = () => {
		return normalizeCheckInMinute(current().checkInMinute ?? DEFAULT_CHECK_IN_MINUTE);
	};
	const checkInScheduler = new CheckInScheduler({
		targets: runtimes.map((runtime) => ({
			variantId: runtime.variant.id,
			checkIn: (signal) => runtime.checkIn(signal),
			minuteOfDay: () => variantWindowMinute(),
			onClaimed: () => {
				runtime.client.fetchCredits().catch(() => void 0);
			}
		})),
		isEnabled: (variantId) => {
			const cfg = current();
			if (variantId === CHINA_VARIANT.id) return cfg.autoCheckInCN === true;
			return cfg.autoCheckInGlobal === true;
		},
		store: checkInStore
	});
	checkInScheduler.start();
	/**
	* The startup catch-up, run once more from the settings source callback.
	*
	* `start()` above runs while the plugin is still assembling: the section
	* that stores these toggles has not handed over its values yet, so that
	* sweep reads the raw plugin config, sees no toggle, and skips the day. The
	* retry is what makes "boot after 10:00" actually claim.
	*/
	let startupCatchUpDone = false;
	const runStartupCatchUpOnce = () => {
		if (startupCatchUpDone) return;
		startupCatchUpDone = true;
		checkInScheduler.catchUp();
	};
	installJobTokenHint(ctx);
	const { probe: probeKey, auth: authKey } = controlKeys();
	let setMaximumContextWindow;
	let setMaximumContextWindowCN;
	let setModelsEnabled;
	let setModelsEnabledCN;
	let setModelContextWindow;
	let setModelContextWindowCN;
	/**
	* Point a variant at an account identity, invalidating whatever the previous
	* one left behind.
	*
	* One helper for all four transitions (sweep sign-in, sweep sign-out, manual
	* refresh, card save) because each of them used to do its own partial
	* version, and the manual path forgot pieces the sweep did. Every transition
	* bumps {@link VariantRuntime.catalogGeneration}, which is what makes an
	* in-flight request from before the change refuse to write back.
	*
	* Probe observations are dropped whenever the account actually changes —
	* including sign-out, and including the "signed out, then in as someone else"
	* sequence that used to look like a first sighting and let the new account
	* inherit the old one's detected levels. They are deliberately NOT cleared on
	* a first sign-in: no previous account's data could leak there, and clearing
	* would delete records this very account owns (written before a restart, or
	* seeded while all of this is running).
	*
	* @param identity - the account now in effect, or `undefined` when signed out.
	*/
	const adoptIdentity = (runtime, identity) => {
		const key = identityCacheKey(runtime.cacheScope, runtime.variant.id);
		const known = lastIdentities.get(key);
		if (known === identity && runtime.catalog.isVisible()) return;
		const hadCredential = known !== void 0;
		if (identity === void 0) lastIdentities.delete(key);
		else lastIdentities.set(key, identity);
		runtime.catalogGeneration += 1;
		runtime.inflightFetch?.controller.abort();
		runtime.inflightFetch = void 0;
		if (hadCredential && known !== identity) {
			runtime.probeStore.clear();
			runtime.invalidate();
		}
		if (identity === void 0) {
			if (known !== void 0) runtime.savedCatalogs.delete(known);
			runtime.catalog.set(runtime.fallback);
			runtime.catalogSource = "fallback";
			runtime.catalogFetchedAtMs = void 0;
			runtime.catalogError = void 0;
			if (runtime.catalog.setVisible(false)) runtime.invalidate();
			return;
		}
		const saved = runtime.savedCatalogs.get(identity);
		if (saved !== void 0) {
			runtime.catalog.set([...saved.models]);
			runtime.catalogSource = "saved";
			runtime.catalogFetchedAtMs = saved.fetchedAtMs;
		} else {
			runtime.catalog.set(runtime.fallback);
			runtime.catalogSource = "fallback";
			runtime.catalogFetchedAtMs = void 0;
		}
		runtime.catalogError = void 0;
		runtime.catalog.setVisible(true);
		runtime.invalidate();
	};
	/**
	* Apply catalog preferences from a configuration view, in memory.
	*
	* Shared by the probe-route setters and the settings face's POST: both write
	* the plugin-owned settings file and then land the new view here, which is
	* what the cards see on their next status read.
	*/
	const applyCatalogSettings = (next) => {
		let changed = false;
		for (const runtime of runtimes) {
			const isChina = runtime.variant.id === CHINA_VARIANT.id;
			const preference = isChina ? next.useMaximumContextWindowCN : next.useMaximumContextWindow;
			if (runtime.catalog.setUseMaximumContextWindow(preference === true)) changed = true;
			const overrides = isChina ? next.modelContextWindowsCN : next.modelContextWindows;
			if (overrides !== void 0 && runtime.catalog.setModelContextWindows(overrides)) changed = true;
			const disabled = isChina ? next.disabledModelsCN : next.disabledModels;
			if (runtime.catalog.setDisabledModels(disabled ?? [])) changed = true;
			const variantEnabled = isChina ? next.variantEnabledCN !== false : next.variantEnabledGlobal !== false;
			if (runtime.catalog.setEnabled(variantEnabled)) changed = true;
		}
		if (changed) for (const runtime of runtimes) runtime.invalidate();
	};
	ctx.inject(["webServer"], (webCtx) => {
		const umidRunner = createQoderUmidInstallRunner(async (force) => {
			const result = await installUmid({ force });
			return result.ok ? { ok: true } : {
				ok: false,
				...result.error === void 0 ? {} : { error: result.error }
			};
		});
		/**
		* Project the component's state for one variant's status document.
		*
		* A callback, not a value: an install finishes between two polls, and the
		* card learns that from the document it already reads rather than from a
		* second route. The reads are local and small (a stat plus one JSON file),
		* so paying them per poll is cheaper than caching state that could then
		* disagree with the disk the install actually wrote.
		*
		* `applicable` is per variant: only the international service gates its
		* campaign on the identity this component mints, so a China-only card must
		* not grow an install section for something its campaign never asks for.
		*
		* `identity` describes the on-disk cache only, never the in-process one: a
		* status document whose answer depended on which process asked would be
		* untrustworthy, and the interesting case — component deleted by antivirus
		* while a sampled identity still serves check-in — is exactly the one the
		* disk records. Absent when this realm has no cache at all, which reads as
		* "no identity yet" and is the normal state before the first check-in.
		*/
		const nativeDeviceOf = (runtime) => () => {
			const dir = umidDir();
			const manifest = readUmidManifest(dir);
			const job = umidRunner.state();
			const identity = identityCacheStatus(runtime.variant.region);
			return {
				applicable: runtime.variant.id !== CHINA_VARIANT.id,
				installed: umidInstalled(dir),
				dir,
				...manifest === void 0 ? {} : { version: manifest.source.version },
				...manifest === void 0 ? {} : { selfCheck: {
					ok: manifest.selfCheck.ok,
					...manifest.selfCheck.at === void 0 ? {} : { at: manifest.selfCheck.at },
					...manifest.selfCheck.reason === void 0 ? {} : { reason: manifest.selfCheck.reason }
				} },
				installing: job.installing,
				...job.jobId === void 0 ? {} : { jobId: job.jobId },
				...job.lastError === void 0 ? {} : { lastError: job.lastError },
				...identity === void 0 ? {} : { identity: {
					cachedAt: identity.cachedAt,
					stale: identity.stale,
					source: identity.stale ? "cache-stale" : "cache"
				} }
			};
		};
		for (const runtime of runtimes) {
			registerQoderStatusRoute(webCtx, {
				path: runtime.variant.statusPath,
				store: runtime.store,
				client: runtime.client,
				accountName: () => runtime.client.accountName,
				plan: () => runtime.client.accountPlan,
				models: () => runtime.catalog.all(),
				catalog: () => catalogSection(runtime),
				probe: () => probeSection(runtime, current().probeConsent === true),
				probeKey,
				authKey,
				...runtime.variant.id === CHINA_VARIANT.id ? {
					useMaximumContextWindow: () => current().useMaximumContextWindowCN === true,
					disabledModels: () => current().disabledModelsCN ?? []
				} : {
					useMaximumContextWindow: () => current().useMaximumContextWindow === true,
					disabledModels: () => current().disabledModels ?? []
				},
				jobTokenRefreshedAt: runtime.jobTokenRefreshedAt,
				nativeDevice: nativeDeviceOf(runtime),
				accounts: async () => {
					const [summaries, stored] = await Promise.all([runtime.store.accounts(), runtime.store.list()]);
					const tokens = new Map(stored.map((account) => [account.id, account.pat]));
					const entries = await Promise.all(summaries.map(async (entry) => {
						const health = runtime.healthOf(entry.id);
						const withHealth = health === void 0 ? entry : {
							...entry,
							health
						};
						const pat = tokens.get(entry.id);
						if (pat === void 0) return withHealth;
						try {
							const billing = await runtime.client.fetchAccountBilling(pat);
							const plan = webPlan(billing.plan);
							return {
								...withHealth,
								...billing.accountName === void 0 ? {} : { accountName: billing.accountName },
								...plan === void 0 ? {} : { plan },
								credits: billing.credits
							};
						} catch (error) {
							return {
								...withHealth,
								creditsError: error instanceof Error ? error.message.slice(0, 300) : String(error)
							};
						}
					}));
					const lastFailoverAt = runtime.failoverAt();
					const lastFailoverReason = runtime.failoverReason();
					return {
						entries,
						autoFailover: autoFailoverActive(current().autoFailoverEnabled, await poolSeatFlags(pool())),
						autoFailoverEnabled: current().autoFailoverEnabled !== false,
						routingStrategy: current().routingStrategy ?? "save-order",
						routingOrder: current().routingOrder ?? [],
						...lastFailoverAt === void 0 ? {} : { lastFailoverAt },
						...lastFailoverReason === void 0 ? {} : { lastFailoverReason }
					};
				},
				upstreamNotice: runtime.upstreamNotice,
				checkIn: () => {
					const record = checkInStore.read(runtime.variant.id);
					if (record === void 0) return void 0;
					const nextRunAt = checkInScheduler.nextRunAt(runtime.variant.id);
					return {
						...record,
						...nextRunAt === void 0 ? {} : { nextRunAt }
					};
				},
				today: () => getClaimWindowDateString(Date.now(), variantWindowMinute())
			});
			registerQoderAuthRoute(webCtx, {
				path: runtime.variant.authPath,
				save: async (pat) => {
					const validation = await validateApiKey(pat, runtime.variant.region);
					if (!validation.ok) return validation.error === "invalid" ? {
						ok: false,
						error: "qoder_invalid_pat",
						reason: validation.reason
					} : {
						ok: false,
						error: "qoder_unreachable",
						reason: validation.reason
					};
					const credential = await runtime.store.save(pat);
					const identity = credentialIdentity(credential);
					adoptIdentity(runtime, identity);
					await fetchCatalog(runtime, identity);
					return {
						ok: true,
						status: await runtime.store.status()
					};
				},
				activate: async (accountId) => {
					const credential = await runtime.store.activate(accountId);
					const identity = credentialIdentity(credential);
					adoptIdentity(runtime, identity);
					await fetchCatalog(runtime, identity);
					return await runtime.store.status();
				},
				remove: async (accountId) => {
					if (await runtime.store.remove(accountId)) {
						const credential = await runtime.store.current();
						adoptIdentity(runtime, credential === void 0 ? void 0 : credentialIdentity(credential));
					}
					return await runtime.store.status();
				},
				clear: async () => {
					await runtime.store.clear();
					adoptIdentity(runtime, void 0);
				},
				setEnabled: async (accountId, enabled) => {
					if (await runtime.store.setEnabled(accountId, enabled)) runtime.forgetHealth(accountId);
					return await runtime.store.status();
				}
			}, authKey);
			registerQoderProbeRoute(webCtx, {
				path: runtime.variant.probePath,
				probe: async (modelId) => {
					const result = await runtime.probeService.probe(modelId, true);
					if (result.state === "ok") runtime.invalidate();
					return result;
				},
				clear: () => {
					runtime.probeStore.clear();
					runtime.invalidate();
				},
				refresh: async () => {
					if (stopped) return {
						state: "failed",
						reason: "plugin is stopping"
					};
					let credential;
					try {
						credential = await runtime.store.current();
					} catch (error) {
						return {
							state: "failed",
							reason: error instanceof Error ? error.message.slice(0, 300) : String(error)
						};
					}
					if (credential === void 0) {
						adoptIdentity(runtime, void 0);
						return { state: "signed-out" };
					}
					const identity = credentialIdentity(credential);
					adoptIdentity(runtime, identity);
					await fetchCatalog(runtime, identity);
					return runtime.catalogError === void 0 ? {
						state: "refreshed",
						reason: `${runtime.catalog.current().length} models`
					} : {
						state: "failed",
						reason: runtime.catalogError
					};
				},
				checkIn: async () => {
					const result = await runtime.checkIn();
					if (result.status !== "error") {
						const window = getClaimWindowDateString(Date.now(), variantWindowMinute());
						if (!(() => {
							const record = checkInStore.read(runtime.variant.id);
							return record?.lastDate === window && (record.status === "claimed" || record.status === "already-claimed");
						})()) checkInStore.write(runtime.variant.id, {
							lastDate: window,
							lastAt: result.timestamp,
							status: result.status,
							...result.amount === void 0 ? {} : { amount: result.amount },
							...result.message === void 0 ? {} : { message: result.message },
							...result.expiresAtMs === void 0 ? {} : { expiresAtMs: result.expiresAtMs }
						});
						if (result.status === "claimed") runtime.client.fetchCredits().catch(() => void 0);
					}
					const nativeDevice = nativeDeviceOf(runtime)();
					const reasonCode = result.reasonCode === "no-client" && nativeDevice.applicable && !nativeDevice.installed ? "no-native-component" : result.reasonCode;
					return {
						state: result.status,
						...result.amount === void 0 ? {} : { amount: result.amount },
						...reasonCode === void 0 ? {} : { reasonCode },
						...result.message === void 0 ? {} : { reason: result.message }
					};
				},
				...runtime.variant.id === CHINA_VARIANT.id ? {
					setMaximumContextWindow: async (enabled) => {
						if (setMaximumContextWindowCN === void 0) return {
							state: "failed",
							reason: "settings are unavailable"
						};
						return setMaximumContextWindowCN(enabled);
					},
					setModelsEnabled: async (opts) => {
						if (setModelsEnabledCN === void 0) return {
							state: "failed",
							reason: "settings are unavailable"
						};
						return setModelsEnabledCN(opts);
					},
					setModelContextWindow: async (opts) => {
						if (setModelContextWindowCN === void 0) return {
							state: "failed",
							reason: "settings are unavailable"
						};
						return setModelContextWindowCN(opts);
					}
				} : {
					setMaximumContextWindow: async (enabled) => {
						if (setMaximumContextWindow === void 0) return {
							state: "failed",
							reason: "settings are unavailable"
						};
						return setMaximumContextWindow(enabled);
					},
					setModelsEnabled: async (opts) => {
						if (setModelsEnabled === void 0) return {
							state: "failed",
							reason: "settings are unavailable"
						};
						return setModelsEnabled(opts);
					},
					setModelContextWindow: async (opts) => {
						if (setModelContextWindow === void 0) return {
							state: "failed",
							reason: "settings are unavailable"
						};
						return setModelContextWindow(opts);
					}
				}
			}, probeKey);
		}
		registerQoderSettingsFace(webCtx, {
			store,
			config,
			current,
			apply: applyCatalogSettings,
			rearm: () => {
				runStartupCatchUpOnce();
				checkInScheduler.rearm();
			}
		});
		const resetDeviceCodes = async () => {
			for (const runtime of runtimes) if (typeof runtime.transport.resetDeviceIdentity !== "function") throw new Error("this host cannot reset device codes");
			rotateDeviceSeed();
			for (const runtime of runtimes) runtime.transport.resetDeviceIdentity?.();
			return { accounts: await savedAccountCount(pool) };
		};
		registerQoderDeviceResetRoute(webCtx, { reset: resetDeviceCodes }, controlKeys().probe);
		registerQoderUmidInstallRoute(webCtx, { runner: umidRunner }, controlKeys().probe);
	});
	ctx.inject(["settings"], (settingsCtx) => {
		/**
		* `auto: false` turns OFF the host's generated form page for this entry —
		* the plugin ships its own card, which is now the only editor. It must be
		* called as a METHOD: on 0.1.7 `configure` is a SettingsForms class method
		* (it reads `this.presentations`), and extracting it as a free function
		* throws a TypeError that used to kill the whole settings callback.
		*/
		const settingsService = settingsCtx.settings;
		if (typeof settingsService.configure === "function") try {
			settingsCtx.effect(() => {
				const dispose = settingsService.configure({ auto: false }, ctx.fiber);
				return typeof dispose === "function" ? dispose : () => {};
			});
		} catch (error) {
			console.error("[dsh-qoder-plugin] settings.configure failed (own settings file still serves):", error);
		}
		/**
		* The four setters, now one implementation on both hosts: write the
		* plugin-owned settings file, then apply the new view in memory. No
		* profile-patch write means no tree reconcile, no fiber reload, and no
		* client-mirror storm per toggle.
		*/
		const write = (patch) => {
			store.patch(patch, true);
			applyCatalogSettings(current());
			checkInScheduler.rearm();
		};
		setMaximumContextWindow = async (enabled) => {
			write({ useMaximumContextWindow: enabled });
			return { state: "updated" };
		};
		setMaximumContextWindowCN = async (enabled) => {
			write({ useMaximumContextWindowCN: enabled });
			return { state: "updated" };
		};
		/**
		* Per-model window write, landed in the same settings field the multi
		* variant already reads (`modelContextWindows[CN]`) — the catalog honours
		* an override over the account-wide preference, so one model can take the
		* larger declared window while the rest keep the default.
		*
		* `window === 0` deletes the key rather than storing a zero: the catalog
		* skips non-positive overrides, and an absent key is the honest spelling
		* of 「no override」.
		*/
		setModelContextWindow = async ({ model, window }) => {
			const windows = { ...readConfigField(current(), "modelContextWindows") ?? {} };
			if (window > 0) windows[model] = window;
			else delete windows[model];
			write({ modelContextWindows: windows });
			return { state: "updated" };
		};
		setModelContextWindowCN = async ({ model, window }) => {
			const windows = { ...readConfigField(current(), "modelContextWindowsCN") ?? {} };
			if (window > 0) windows[model] = window;
			else delete windows[model];
			write({ modelContextWindowsCN: windows });
			return { state: "updated" };
		};
		setModelsEnabled = async ({ models, enabled }) => {
			const currentDisabled = new Set(readConfigField(current(), "disabledModels") ?? []);
			for (const m of models) if (enabled) currentDisabled.delete(m);
			else currentDisabled.add(m);
			write({ disabledModels: Array.from(currentDisabled) });
			return { state: "updated" };
		};
		setModelsEnabledCN = async ({ models, enabled }) => {
			const currentDisabled = new Set(readConfigField(current(), "disabledModelsCN") ?? []);
			for (const m of models) if (enabled) currentDisabled.delete(m);
			else currentDisabled.add(m);
			write({ disabledModelsCN: Array.from(currentDisabled) });
			return { state: "updated" };
		};
	});
	ctx.effect(() => () => {
		stopped = true;
		checkInScheduler.dispose();
		for (const timer of timers) clearInterval(timer);
		timers.length = 0;
		for (const runtime of runtimes) {
			runtime.inflightFetch?.controller.abort();
			runtime.inflightFetch = void 0;
		}
		detach(ctx, clearHostHeartbeat(), "host heartbeat cleanup");
	});
	/**
	* Fetch one variant's catalog for the current credential.
	*
	* Shared by the credential sweep and the card's manual refresh, and written
	* so that concurrent callers cost one request and cannot interleave badly:
	*
	* - **One request at a time.** A second caller joins the in-flight fetch
	*   instead of starting its own (spec §5: one catalog request per variant at
	*   a time).
	* - **Generation-checked write-back.** The request records the generation it
	*   started under and writes nothing if the generation moved on — which is
	*   what a slow answer from a superseded account must not do. Checking only
	*   the *identity* was not enough: two refreshes for the same account can
	*   still finish out of order, and the older one would win.
	* - **`resolve()`, not `current()`.** A catalog fetch demands a usable token;
	*   the difference from `current()` is that its absence surfaces as the same
	*   classified `MISSING_CREDENTIAL` failure every other request path reports,
	*   rather than as a silent "no credential" that would hide a bad file on
	*   disk behind an env override.
	*/
	const fetchCatalog = async (runtime, identity) => {
		const inflight = runtime.inflightFetch;
		const generation = runtime.catalogGeneration;
		if (inflight !== void 0 && inflight.identity === identity && inflight.generation === generation) return inflight.promise;
		inflight?.controller.abort();
		const controller = new AbortController();
		let run;
		run = (async () => {
			let models;
			try {
				const credential = await runtime.store.resolve();
				const resolvedIdentity = credentialIdentity(credential);
				if (resolvedIdentity !== identity) {
					adoptIdentity(runtime, resolvedIdentity);
					await fetchCatalog(runtime, resolvedIdentity);
					return;
				}
				models = await runtime.client.fetchModels(controller.signal);
				const latest = await runtime.store.current();
				const latestIdentity = latest === void 0 ? void 0 : credentialIdentity(latest);
				if (latestIdentity !== identity) {
					adoptIdentity(runtime, latestIdentity);
					if (latestIdentity !== void 0) await fetchCatalog(runtime, latestIdentity);
					return;
				}
			} catch (error) {
				if (stopped || runtime.catalogGeneration !== generation) return;
				runtime.lastFetchAtMs = Date.now();
				runtime.catalogError = error instanceof Error ? error.message.slice(0, 300) : String(error);
				ctx.logger.warn(`dsh-qoder-plugin: ${runtime.variant.displayName} catalog unavailable; serving the fallback list`, error);
				runtime.invalidate();
				return;
			}
			if (stopped || runtime.catalogGeneration !== generation) return;
			runtime.lastFetchAtMs = Date.now();
			lastLiveFetchAt.set(liveFetchCacheKey(runtime.cacheScope, identity), runtime.lastFetchAtMs);
			runtime.catalog.set([...models]);
			runtime.catalogSource = "live";
			runtime.catalogFetchedAtMs = runtime.client.lastCatalog?.fetchedAtMs ?? Date.now();
			runtime.catalogError = void 0;
			if (lastIdentities.get(identityCacheKey(runtime.cacheScope, runtime.variant.id)) === identity) try {
				runtime.savedCatalogs.set(identity, {
					source: runtime.client.lastCatalog?.source ?? "unknown",
					fetchedAtMs: runtime.client.lastCatalog?.fetchedAtMs ?? Date.now(),
					models: [...models]
				});
			} catch (error) {
				ctx.logger.warn(`dsh-qoder-plugin: ${runtime.variant.displayName} catalog could not be saved for this account`, error);
			}
			runtime.invalidate();
		})().finally(() => {
			if (runtime.inflightFetch?.promise === run) runtime.inflightFetch = void 0;
		});
		runtime.inflightFetch = {
			identity,
			generation,
			controller,
			promise: run
		};
		return run;
	};
	/**
	* Reconcile one variant with its credentials.
	*
	* Four transitions matter, and each is a different action:
	*
	* - **none → some** (first sighting): reveal the group and fetch a catalog.
	* - **none → some, identity changed**: additionally drop the previous
	*   account's observations, so another token's probe answers cannot be read
	*   as the new one's.
	* - **some → none**: hide the group and stop serving its models.
	* - **same identity**: nothing to do — a PAT neither rotates nor expires, so
	*   re-fetching on every sweep would hit the catalog endpoint for no new
	*   information.
	*/
	const syncVariant = async (runtime) => {
		if (stopped || !runtime.registered) return;
		const credential = await runtime.store.current().catch((error) => {
			ctx.logger.warn(`dsh-qoder-plugin: ${runtime.variant.displayName} credential read failed`, error);
		});
		if (stopped) return;
		if (credential === void 0) {
			adoptIdentity(runtime, void 0);
			return;
		}
		const identity = credentialIdentity(credential);
		if (lastIdentities.get(identityCacheKey(runtime.cacheScope, runtime.variant.id)) === identity && runtime.catalog.isVisible()) {
			const stale = runtime.catalogSource !== "live";
			const fetchedAt = lastLiveFetchAt.get(liveFetchCacheKey(runtime.cacheScope, identity)) ?? 0;
			const due = Date.now() - fetchedAt >= credentialPollMs() * CATALOG_RETRY_SWEEPS;
			if (stale && due) await fetchCatalog(runtime, identity);
			return;
		}
		adoptIdentity(runtime, identity);
		await fetchCatalog(runtime, identity);
	};
	/** Run one reconcile sweep across both variants. */
	const syncAll = async () => {
		for (const runtime of runtimes) await syncVariant(runtime);
	};
	/**
	* Start both variants, then begin the credential sweep.
	*
	* The chain carries its own failure handler: without one, a rejection here
	* would be an unhandled rejection — which Node turns into process
	* termination, taking the whole Harness down over one plugin's startup.
	*/
	detach(ctx, Promise.all(runtimes.map(async (runtime) => startVariant(ctx, runtime, async () => {
		if (stopped) return;
		let credential;
		try {
			credential = await runtime.store.current();
		} catch {
			return;
		}
		if (credential === void 0) return;
		const identity = credentialIdentity(credential);
		if (lastIdentities.get(identityCacheKey(runtime.cacheScope, runtime.variant.id)) !== identity || !runtime.catalog.isVisible()) adoptIdentity(runtime, identity);
	}))).then(() => {
		if (stopped) return;
		if (runtimes.some((runtime) => runtime.registered)) detach(ctx, writeHostHeartbeat(), "host heartbeat write");
		detach(ctx, syncAll(), "credential sweep");
		const timer = setInterval(() => {
			detach(ctx, syncAll(), "credential sweep");
		}, credentialPollMs());
		timer.unref?.();
		timers.push(timer);
	}), "variant startup");
}
//#endregion
export { CHINA_VARIANT, CN_SECTION_KEYS, Config, FALLBACK_QODER_MODELS, GLOBAL_SECTION_KEYS, GLOBAL_VARIANT, KIND_STATUS, PROBE_EFFORT_CANDIDATES, QODER_AUTH_FILENAME, QODER_AUTH_PATH, QODER_DATA_DIR_ENV, QODER_DATA_DIR_NAME, QODER_GLOBAL_AUTH_PATH, QODER_GLOBAL_PROBE_PATH, QODER_GLOBAL_SETTINGS_NS, QODER_GLOBAL_STATUS_PATH, QODER_HOST_HEARTBEAT_FILENAME, QODER_PAT_ENV_CN, QODER_PAT_ENV_GLOBAL, QODER_PROBE_FILENAME, QODER_PROBE_PATH, QODER_PROVIDER, QODER_SETTINGS_NS, QODER_STATUS_PATH, QODER_STREAM_IDLE_TIMEOUT_MS, QODER_VARIANTS, QUOTA_POLL_DEFAULT_MS, QUOTA_POLL_MIN_MS, QUOTA_SECTION_KEYS, QoderCatalog, QoderCatalogStore, QoderCredentialStore, QoderProbeService, QoderProbeStore, QoderUpstreamClient, adoptFailoverAccount, adoptPooledAccount, apply, autoFailoverActive, classifyUpstreamError, clearHostHeartbeat, createAuthKey, createQoderAdapter, createQoderShim, fingerprintModel, inject, isHeartbeatProcessAlive, kindFromQoderFailure, modelInfoOf, name, normalizeCredits, patTail, poolOrder, poolOwner, poolRing, poolSeatFlags, pooledAccountById, pooledNextAccount, probeModel, processStartTimeMs, qoderAuthHandler, qoderCatalogPath, qoderCredentialIdentity, qoderHostHeartbeatPath, qoderOwnAuthPath, qoderPluginDataDir, qoderProbePath, randomSentinel, readHostHeartbeat, registerQoderAuthRoute, savedAccountCount, variantFor };
