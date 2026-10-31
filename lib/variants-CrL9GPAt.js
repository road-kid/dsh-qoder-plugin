import { dirname, join, resolve } from "node:path";
import crypto, { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { writeFileAtomic } from "@deepseek-ai/dsh-atomic-write";
import { chmodSync, createReadStream, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolveDshHome } from "@deepseek-ai/dsh-home-paths";
import { EMPTY_RESPONSE_CODE, LlmError, ProviderRequestId, ReasoningEffortId, ToolCallId, attributionHeaders, contentHasImage, createAssistantMessage, createToolResultMessage, createUserMessage } from "@deepseek-ai/dsh-llm";
import { homedir, hostname, platform } from "node:os";
import { requestImageDimensions } from "@deepseek-ai/dsh-attachment";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { createGunzip } from "node:zlib";
//#region src/paths.ts
/**
* The plugin's data directory — the ONE place every file the plugin owns
* lives.
*
* Layout: `<profile>/.dsh-qoder-plugin/state/` (the profile discovered
* the same way the credential store always did). Everything — PAT files,
* saved catalogs, probe records, the host heartbeat, and the machine-id
* seed — writes there, so a profile directory never collects loose
* `.qoder-*` files and the whole plugin's footprint is one folder.
*
* Fallbacks, in order: `DSH_QODER_DATA_DIR` env override → the discovered
* profile → the Harness home (a checkout running its own tests, or a host
* loading the plugin from outside any profile).
*
* Split out of `auth.ts` so catalog/probe/heartbeat stores can import the
* directory without pulling in the credential code (and its upstream
* dependency) — these modules stay leaf-light on purpose.
*
* @module dsh-qoder-plugin/paths
*/
/** The per-profile directory the plugin's data folder lives under. */
const QODER_DATA_DIR_NAME = ".dsh-qoder-plugin";
/** The directory inside the data dir where the rebuildable state files live. */
const QODER_STATE_DIR_NAME = "state";
/** Environment override for the whole data directory. */
const QODER_DATA_DIR_ENV = "DSH_QODER_DATA_DIR";
const PROFILES_DIR_NAME = "profiles";
/** The npm name of this package, as a profile's manifest declares it. */
const PLUGIN_PACKAGE_NAME = "dsh-qoder-plugin";
function pluginPackageRoot() {
	try {
		return dirname(dirname(fileURLToPath(import.meta.url)));
	} catch {
		return;
	}
}
/**
* Whether a profile directory declares this plugin.
*
* Read from the profile's manifest rather than inferred from this module's own
* location, because DSH installs a plugin into a profile by *link*: the manifest
* carries `"dsh-qoder-plugin": "link:/path/to/checkout"`, while Node
* resolves the module to that real path, which lies outside `$DSH_HOME` entirely.
* Walking up from the module would therefore miss the profile for exactly the
* install shape a developer uses.
*/
function profileDeclaresPlugin(profileDir) {
	try {
		const manifest = JSON.parse(readFileSync(join(profileDir, "package.json"), "utf8"));
		return typeof manifest.dependencies?.[PLUGIN_PACKAGE_NAME] === "string" || typeof manifest.devDependencies?.[PLUGIN_PACKAGE_NAME] === "string";
	} catch {
		return false;
	}
}
/**
* Whether a profile's installed copy of this plugin resolves to this package.
*
* This is what separates two profiles that both declare the plugin — a `web` and
* a `desktop` profile can each list it — so the data directory follows the
* profile whose copy is actually running rather than the first one found.
*/
function profileLinksToThisPackage(profileDir) {
	const own = pluginPackageRoot();
	if (own === void 0) return false;
	try {
		return realpathSync(join(profileDir, "node_modules", PLUGIN_PACKAGE_NAME)) === realpathSync(own);
	} catch {
		return false;
	}
}
/**
* The profile directory this plugin belongs to, or undefined when none can be
* determined.
*
* A single declaring profile is accepted without the link test, so a normal
* (non-linked) install still resolves.
*/
function discoverProfileDir() {
	const profilesRoot = join(resolveDshHome(), PROFILES_DIR_NAME);
	let entries;
	try {
		entries = readdirSync(profilesRoot, { withFileTypes: true });
	} catch {
		return;
	}
	const candidates = [];
	for (const entry of entries) {
		if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
		const dir = join(profilesRoot, entry.name);
		if (profileDeclaresPlugin(dir)) candidates.push(dir);
	}
	if (candidates.length === 0) return void 0;
	if (candidates.length === 1) return candidates[0];
	return candidates.find((candidate) => profileLinksToThisPackage(candidate));
}
/**
* The plugin's data directory: `<profile>/.dsh-qoder-plugin`.
*
* Falls back to the Harness home when no profile can be discovered — a
* checkout running its own tests, or a host that loads the plugin from
* outside a profile — so the plugin always has somewhere to write, and
* `DSH_QODER_DATA_DIR` overrides either way.
*/
function qoderPluginDataDir() {
	const override = process.env[QODER_DATA_DIR_ENV];
	if (override !== void 0 && override.trim() !== "") return override;
	const base = discoverProfileDir() ?? resolveDshHome();
	return join(base, QODER_DATA_DIR_NAME);
}
/**
* The directory the rebuildable state files live in:
* `<data dir>/state/` (saved catalogs, probe records, the host heartbeat).
*/
function qoderStateDir() {
	return join(qoderPluginDataDir(), QODER_STATE_DIR_NAME);
}
//#endregion
//#region src/auth.ts
/**
* Qoder credential storage — a pool of Personal Access Tokens per variant.
*
* Every credential the plugin holds is a PAT the human pasted into the
* variant's card (or exported into the environment, or saved by the CLI).
* There is no device flow, no token refresh, and no expiry: a PAT is valid
* until the user revokes it, so this store only reads, writes, and deletes a
* small JSON document.
*
* One file per variant inside the plugin's data directory
* (`<.dsh-qoder-plugin>/`). The on-disk schema is
* `{version: 3, activeId, accounts: [{id, pat, region, savedAt}]}`.
*
* Why a *pool* rather than the single token the file used to hold: a user with
* more than one account (their own, a colleague's, a spare bought for exactly
* this) should not have to paste a token back in every time they want to use
* the other one, and — more importantly — a request that cannot reach the
* upstream on one account should be able to finish on the next without the
* human in the loop. Both of those need the other tokens to still be here.
*
* Order is the order accounts were saved in. This store deliberately does not
* rank them: it knows nothing about any account's health, and inventing an
* order would silently reorder a user's own list.
*
* @module dsh-qoder-plugin/auth
*/
/** The on-disk document version this writer produces. */
const AUTH_SCHEMA_VERSION = 3;
/** Environment fallback for the global arm when no file exists. */
const QODER_PAT_ENV_GLOBAL = "QODER_PERSONAL_ACCESS_TOKEN";
/** Environment fallback for the China arm when no file exists. */
const QODER_PAT_ENV_CN = "QODER_CN_PERSONAL_ACCESS_TOKEN";
/** Basename of the China variant's credential file inside the data directory. */
const QODER_AUTH_FILENAME = ".qoder-auth.json";
/** Last four characters of a token, for display. */
function patTail(pat) {
	const trimmed = pat.trim();
	return trimmed.length >= 4 ? trimmed.slice(-4) : void 0;
}
/**
* Stable identity key for a credential, used by probe records and saved
* catalogs.
*
* A PAT is a bearer secret, so the key is its one-way hash rather than any
* suffix of it: surfaces that show the key (cards, JSON diagnostics) leak
* nothing usable, while two reads of the same token still correlate locally.
*/
function qoderCredentialIdentity(credential) {
	return `pat:${createHash("sha256").update(credential.pat).digest("hex").slice(0, 16)}`;
}
function isRecord$3(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
/** A finite epoch-millisecond stamp, or `undefined` for anything else. */
function readTimestamp(value) {
	return typeof value === "number" && Number.isFinite(value) ? value : void 0;
}
var QoderCredentialStore = class {
	variant;
	ownPath;
	logger;
	/** The legacy-file warning is emitted once per process, not per read. */
	legacyWarned = false;
	/** Tail of the mutator queue; see {@link QoderCredentialStore.exclusive}. */
	chain = Promise.resolve();
	constructor(options) {
		this.variant = options.variant;
		this.ownPath = options.ownPath ?? join(qoderPluginDataDir(), options.variant.ownFilename);
		this.logger = options.logger;
	}
	/** Absolute path of this variant's credential file, for display and tests. */
	ownAuthPath() {
		return this.ownPath;
	}
	/**
	* Every stored account, in save order.
	*
	* The pool without the projection: callers that must act on a token (the
	* transport's failover, the CLI) need the secret; callers that only render
	* it use {@link QoderCredentialStore.accounts}.
	*/
	async list() {
		return (await this.readDocument()).accounts;
	}
	/**
	* The browser-safe account list for the card.
	*
	* An environment-sourced token is deliberately absent: it is not a stored
	* account, cannot be switched away from or removed here, and listing it
	* beside removable rows would offer actions that cannot work. It still signs
	* requests when no file exists — that is `current()`'s job, not this list's.
	*
	* `source` is always `card`: the file does not record who typed the token,
	* because "card vs cli" only says which entry point ran the same save and a
	* file left by any other tool is indistinguishable from the card's.
	*/
	async accounts() {
		const document = await this.readDocument();
		const activeId = activeIdOf(document);
		return document.accounts.map((account, index) => {
			const tail = patTail(account.pat);
			return {
				id: account.id,
				...tail === void 0 ? {} : { patTail: tail },
				...account.savedAtMs === void 0 ? {} : { savedAtMs: account.savedAtMs },
				source: "card",
				active: account.id === activeId,
				order: index + 1,
				...account.enabled === false ? { enabled: false } : {}
			};
		});
	}
	/**
	* The credential currently in effect, or `undefined` when there is none.
	*
	* Resolution order: the active account in the plugin-owned file, then the
	* arm's environment variable (only when no file account exists — a saved
	* token always wins over a stray env), then nothing. There is no refresh and
	* no expiry check: a PAT lives until revoked.
	*/
	async current() {
		const active = activeAccountOf(await this.readDocument());
		if (active !== void 0) return credentialOf(active);
		return this.fromEnvironment();
	}
	/**
	* The credential, or a thrown `MISSING_CREDENTIAL` error.
	*
	* Callers that serve requests (the shim, the catalog sweep) use this so the
	* absence of a token surfaces as the same classified failure the transport
	* itself raises when a saved token turns out empty.
	*/
	async resolve() {
		const credential = await this.current();
		if (credential === void 0 || credential.pat.trim() === "") throw new Error("qoder: MISSING_CREDENTIAL — no Personal Access Token is configured. Add one in the Qoder settings card.");
		return credential;
	}
	/** The token in effect as a bare string, rejecting when there is none. */
	async patPromise() {
		return (await this.resolve()).pat;
	}
	/**
	* Persist a token for this variant, and make it the active account.
	*
	* The caller is responsible for having validated it against the region first
	* (`validateApiKey` upstream). Saving a token that is already stored updates
	* it in place and selects it: pasting the same token again means "use this
	* one", not "add a second copy of it".
	*/
	async save(pat, source = "card") {
		const trimmed = pat.trim();
		if (trimmed === "") throw new Error("qoder: cannot save an empty Personal Access Token");
		return this.exclusive(async () => {
			const id = qoderCredentialIdentity({ pat: trimmed });
			const savedAtMs = Date.now();
			const document = await this.readDocument();
			const existing = document.accounts.find((account) => account.id === id);
			if (existing === void 0) document.accounts.push({
				id,
				pat: trimmed,
				region: this.variant.region,
				savedAtMs
			});
			else {
				existing.pat = trimmed;
				existing.region = this.variant.region;
				existing.savedAtMs = savedAtMs;
				delete existing.enabled;
			}
			document.activeId = id;
			await this.writeDocument(document);
			return {
				pat: trimmed,
				region: this.variant.region,
				savedAtMs,
				source
			};
		});
	}
	/**
	* Make one stored account sign requests.
	*
	* Throws on an unknown id rather than quietly selecting something else: the
	* only caller is the card, whose id came from a status document that may
	* have gone stale (the row was removed in another tab), and silently
	* switching to a *different* account than the one asked for is exactly the
	* surprise this feature exists to remove.
	*/
	async activate(accountId) {
		return this.exclusive(async () => {
			const document = await this.readDocument();
			const account = document.accounts.find((entry) => entry.id === accountId);
			if (account === void 0) throw new Error(`qoder: no stored account matches ${accountId}`);
			if (document.activeId !== accountId) {
				document.activeId = accountId;
				await this.writeDocument(document);
			}
			return credentialOf(account);
		});
	}
	/**
	* Drop one stored account. Returns whether one was actually removed.
	*
	* Removing the active account hands the role to the account that followed it
	* in save order (falling back to the one before it when it was last), which
	* is the same successor automatic failover would have picked — so a user who
	* deletes a dead account lands on a usable one instead of being signed out
	* while other tokens sit in the file.
	*/
	async remove(accountId) {
		return this.exclusive(async () => {
			const document = await this.readDocument();
			const index = document.accounts.findIndex((entry) => entry.id === accountId);
			if (index === -1) return false;
			document.accounts.splice(index, 1);
			if (document.accounts.length === 0) {
				await this.deleteDocument();
				return true;
			}
			if (document.activeId === accountId) document.activeId = document.accounts[index]?.id ?? document.accounts[index - 1]?.id;
			await this.writeDocument(document);
			return true;
		});
	}
	/**
	* Park or un-park one stored account. Returns whether the id was found.
	*
	* An unknown id answers `false` rather than throwing: the caller is a card
	* acting on a row it read a moment ago, and the row may legitimately have
	* been removed in another tab — that is a stale click, not a broken request.
	*
	* Parking never touches `activeId`. The account in effect keeps signing until
	* the user (or a failover) moves the pointer, because a checkbox that
	* silently changed which subscription pays would be a much larger action
	* than the one word on it.
	*/
	async setEnabled(accountId, enabled) {
		return this.exclusive(async () => {
			const document = await this.readDocument();
			const account = document.accounts.find((entry) => entry.id === accountId);
			if (account === void 0) return false;
			if (enabled) delete account.enabled;
			else account.enabled = false;
			await this.writeDocument(document);
			return true;
		});
	}
	/**
	* The account after `accountId` in save order, for automatic failover.
	*
	* Wraps, so a caller that tracks the ids it has already tried walks the whole
	* pool exactly once and then stops when the successor is one it has seen.
	* `undefined` means there is nothing else to try: no accounts at all, or only
	* the one that just failed.
	*
	* Parked accounts are skipped. That is the whole point of parking one: it
	* takes an account out of the automatic walk without deleting the token, so
	* a dead subscription stops absorbing half of every failover. The walk is
	* still bounded to one lap of the pool, and a starting id that is itself
	* parked still walks FORWARD from its position — otherwise parking the
	* account that just failed would end the walk instead of moving past it.
	*/
	async nextAfter(accountId) {
		const { accounts } = await this.readDocument();
		if (accounts.length === 0) return void 0;
		const parked = (account) => account.enabled === false;
		if (accountId === void 0) return accounts.find((account) => !parked(account));
		const index = accounts.findIndex((entry) => entry.id === accountId);
		if (index === -1) return accounts.find((account) => !parked(account));
		for (let step = 1; step < accounts.length; step += 1) {
			const candidate = accounts[(index + step) % accounts.length];
			if (candidate !== void 0 && !parked(candidate)) return candidate;
		}
	}
	/**
	* Resolve one stored account by id, token included.
	*
	* The custom routing order and a pinned session both name accounts by id
	* rather than by position, and both need the PAT to actually sign with. This
	* is the accessor that answers "which token is that id", the counterpart of
	* {@link QoderCredentialStore.accounts}, which deliberately carries no token.
	*
	* `undefined` for an id that names nothing — the card's order may be a poll
	* behind the file, and the walk must skip a removed account instead of
	* failing on it.
	*/
	async byId(accountId) {
		const { accounts } = await this.readDocument();
		return accounts.find((account) => account.id === accountId);
	}
	/** Remove every stored credential. A missing file is not an error. */
	async clear() {
		await this.exclusive(async () => {
			await this.deleteDocument();
		});
	}
	/**
	* Delete the credential file, if any.
	*
	* Split out of {@link QoderCredentialStore.clear} because `remove` has to do
	* the same deletion from *inside* the mutator queue, and calling `clear` there
	* would wait on a queue its own caller already holds.
	*/
	async deleteDocument() {
		try {
			await rm(this.ownPath, { force: true });
		} catch {}
		this.pendingLegacyReason = void 0;
	}
	/**
	* Run one read-modify-write section with the file to itself.
	*
	* Every mutator here loads the document, edits the array in memory, and writes
	* it back. Two of them interleaving lose an account: both read the same list,
	* and whichever writes second drops the other's addition — the atomic rename
	* inside `writeDocument` makes each write whole, but says nothing about the
	* read that preceded it. The card can fire two saves from one click (a double
	* submit, or a second tab) and the PAT route holds no lock of its own, so the
	* exclusion lives here instead. Reads stay outside the queue: they either see
	* the old document or the new one, never a torn one, and serializing them
	* would make every status poll wait on someone else's save.
	*/
	async exclusive(work) {
		const result = this.chain.then(work, work);
		this.chain = result.then(() => void 0, () => void 0);
		return result;
	}
	/** Alias kept for call-site readability (`logout` is just clearing). */
	async logout() {
		await this.clear();
	}
	/** Redacted summary for the card, the PAT route, and doctor output. */
	async status() {
		const base = {
			filePath: this.ownPath,
			region: this.variant.region
		};
		const credential = await this.current();
		if (credential === void 0) return {
			state: "missing",
			...base,
			...this.pendingLegacyReason === void 0 ? {} : { reason: this.pendingLegacyReason }
		};
		const tail = patTail(credential.pat);
		return {
			state: "configured",
			...base,
			pat: {
				source: credential.source,
				...credential.savedAtMs === void 0 ? {} : { savedAtMs: credential.savedAtMs },
				...tail === void 0 ? {} : { patTail: tail }
			}
		};
	}
	/** Set when a read found a stale WorkBuddy-era file; consumed once. */
	pendingLegacyReason;
	async fromEnvironment() {
		const name = this.variant.region === "china" ? QODER_PAT_ENV_CN : QODER_PAT_ENV_GLOBAL;
		const value = process.env[name]?.trim();
		if (value === void 0 || value === "") return void 0;
		return {
			pat: value,
			region: this.variant.region,
			source: "env"
		};
	}
	async readDocument() {
		let text;
		try {
			text = await readFile(this.ownPath, "utf8");
		} catch {
			this.pendingLegacyReason = void 0;
			return {
				activeId: void 0,
				accounts: []
			};
		}
		let parsed;
		try {
			parsed = JSON.parse(text);
		} catch {
			this.pendingLegacyReason = void 0;
			return {
				activeId: void 0,
				accounts: []
			};
		}
		if (!isRecord$3(parsed)) {
			this.pendingLegacyReason = void 0;
			return {
				activeId: void 0,
				accounts: []
			};
		}
		if (typeof parsed["accessToken"] === "string" && parsed["pat"] === void 0) {
			this.pendingLegacyReason = "stale WorkBuddy credential file; save a Qoder Personal Access Token instead";
			if (!this.legacyWarned) {
				this.legacyWarned = true;
				this.logger?.warn?.(`qoder: ${this.variant.displayName}: ${this.ownPath} holds a WorkBuddy-era credential; it is ignored. Save a Qoder Personal Access Token to replace it.`);
			}
			return {
				activeId: void 0,
				accounts: []
			};
		}
		this.pendingLegacyReason = void 0;
		const raw = parsed["accounts"];
		const accounts = [];
		const seen = /* @__PURE__ */ new Set();
		const push = (pat, savedAt, enabled) => {
			const trimmed = pat.trim();
			if (trimmed === "") return;
			const id = qoderCredentialIdentity({ pat: trimmed });
			if (seen.has(id)) return;
			seen.add(id);
			const savedAtMs = readTimestamp(savedAt);
			accounts.push({
				id,
				pat: trimmed,
				region: this.variant.region,
				...savedAtMs === void 0 ? {} : { savedAtMs },
				...enabled === false ? { enabled: false } : {}
			});
		};
		if (Array.isArray(raw)) for (const entry of raw) {
			if (!isRecord$3(entry)) continue;
			if (typeof entry["pat"] !== "string") continue;
			push(entry["pat"], entry["savedAt"], entry["enabled"]);
		}
		else if (typeof parsed["pat"] === "string") push(parsed["pat"], parsed["savedAt"], void 0);
		return {
			activeId: typeof parsed["activeId"] === "string" ? parsed["activeId"] : void 0,
			accounts
		};
	}
	async writeDocument(document) {
		const payload = {
			version: AUTH_SCHEMA_VERSION,
			activeId: document.activeId ?? document.accounts[0]?.id,
			accounts: document.accounts.map((account) => ({
				id: account.id,
				pat: account.pat,
				region: account.region,
				savedAt: account.savedAtMs,
				enabled: account.enabled
			}))
		};
		const directory = dirname(this.ownPath);
		try {
			await mkdir(directory, {
				recursive: true,
				mode: 448
			});
		} catch {}
		await writeFileAtomic(this.ownPath, `${JSON.stringify(payload, null, 2)}\n`, {
			mode: 384,
			dirMode: 448
		});
		this.pendingLegacyReason = void 0;
	}
};
/** The active account, falling back to the first when the pointer is stale. */
function activeAccountOf(document) {
	const active = activeIdOf(document);
	return active === void 0 ? void 0 : document.accounts.find((account) => account.id === active);
}
/** The active account's identity, resolved against the accounts actually present. */
function activeIdOf(document) {
	const { activeId, accounts } = document;
	if (activeId !== void 0 && accounts.some((account) => account.id === activeId)) return activeId;
	return accounts[0]?.id;
}
/** One stored account as the runtime credential the request path consumes. */
function credentialOf(account) {
	return {
		pat: account.pat,
		region: account.region,
		...account.savedAtMs === void 0 ? {} : { savedAtMs: account.savedAtMs },
		source: "card"
	};
}
/**
* The plugin-owned credential path for one variant.
* Kept as a free function for the CLI, which builds no store per display line.
*/
function qoderOwnAuthPath(variant) {
	return join(qoderPluginDataDir(), variant.ownFilename);
}
//#endregion
//#region src/status-paths.ts
/** Plugin-owned status endpoint consumed by its browser half. */
const QODER_STATUS_PATH = "/plugins/dsh-qoder-plugin/status";
/**
* Plugin-owned settings endpoint consumed by its browser half.
*
* GET answers the whole entry configuration as three layers (value/base/user)
* plus the write key; POST applies one patch. This is the plugin's own settings
* surface, replacing writes through the host's settings service — see
* {@link ./settings-store.ts} for why.
*/
const QODER_SETTINGS_FACE_PATH = "/plugins/dsh-qoder-plugin/settings";
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
/**
* Plugin-owned device-code reset endpoint.
*
* One POST rotates the host-level device seed and drops every cached job token,
* which is what makes each saved account present a new `Cosy-Machineid` /
* `Cosy-Machinehostname` on its next request. A write (it changes what every
* account claims to be), so it carries the same loopback Host/Origin guard and
* the in-process settings key as the other control routes.
*/
const QODER_DEVICE_RESET_PATH = "/plugins/dsh-qoder-plugin/device-reset";
/**
* Plugin-owned native-component (UMID) install endpoint.
*
* One POST starts a background job that installs the official `runtime-info`
* component into the host-level component directory, which is what lets the
* international daily campaign be requested on a machine with no Qoder desktop
* client. A write (it puts an executable on disk), so it carries the same
* loopback Host/Origin guard and the in-process settings key as the other
* control routes.
*/
const QODER_UMID_INSTALL_PATH = "/plugins/dsh-qoder-plugin/umid-install";
//#endregion
//#region src/catalog.ts
/**
* The built-in roster, transcribed from the transport's own `defaultModels`
* (`src/qoder/catalog.ts`) — the Qoder model keys both regions start from
* before the first successful discovery: `cmodel`, `auto`, `ultimate`,
* `performance`, `efficient`, `lite`.
*
* It exists so the provider registers with a usable catalog while the first
* fetch is in flight or the endpoint is unreachable, and it is deliberately
* *not* a promise about the upstream's current state: the discovery answer
* replaces it at startup. No per-region roster is invented here — the
* transport ships one shared default set, and this mirror keeps the same
* discipline. Reasoning and rate metadata are absent because the defaults
* declare none; those rows offer no thinking control until the upstream says
* otherwise.
*/
const FALLBACK_QODER_MODELS = [
	{
		id: "cmodel",
		name: "Cantus (Qoder)",
		contextWindow: 1e6,
		maxTokens: 32768,
		supportsImages: true,
		billing: {
			free: false,
			rateUnknown: true
		},
		source: "system"
	},
	{
		id: "auto",
		name: "Qoder Auto",
		contextWindow: 18e4,
		maxTokens: 32768,
		supportsImages: true,
		billing: {
			free: false,
			rateUnknown: true
		},
		source: "system"
	},
	{
		id: "ultimate",
		name: "Qoder Ultimate",
		contextWindow: 1e6,
		maxTokens: 32768,
		supportsImages: true,
		billing: {
			free: false,
			rateUnknown: true
		},
		source: "system"
	},
	{
		id: "performance",
		name: "Qoder Performance",
		contextWindow: 1e6,
		maxTokens: 32768,
		supportsImages: true,
		billing: {
			free: false,
			rateUnknown: true
		},
		source: "system"
	},
	{
		id: "efficient",
		name: "Qoder Efficient",
		contextWindow: 18e4,
		maxTokens: 32768,
		supportsImages: true,
		billing: {
			free: false,
			rateUnknown: true
		},
		source: "system"
	},
	{
		id: "lite",
		name: "Qoder Lite",
		contextWindow: 18e4,
		maxTokens: 32768,
		supportsImages: false,
		billing: {
			free: false,
			rateUnknown: true
		},
		source: "system"
	}
];
/**
* Mutable catalog shared by the shim's `/v1/models` and the adapter.
*
* Visibility is separate from content. A variant with no usable credential
* must expose *no* models rather than a fallback roster: the DSH model picker
* drops an empty group, so an empty catalog is exactly how a provider hides
* without touching registration. Serving the fallback to a signed-out user
* instead offers models that can only fail (the transport throws
* `MISSING_CREDENTIAL` on the first message), which is worse than showing
* nothing.
*
* The flag defaults to visible so a directly-constructed catalog behaves as
* it always has; the plugin runtime applies the credential gate.
*/
var QoderCatalog = class {
	models;
	visible = true;
	/**
	* Master switch for the whole variant (the card's 国内版/国际版 toggle).
	*
	* Separate from {@link visible}: `visible` is the CREDENTIAL gate (nobody
	* signed in ⇒ nothing to serve), while this is the user's deliberate "do not
	* use this product at all" choice. It gates `current()` — what the provider
	* serves to the model picker — but NOT `all()`, because the card still has to
	* list the models so the switch can be turned back on.
	*/
	enabled = true;
	useMaximumContextWindow = false;
	/** Per-model window overrides (model id → tokens); an override wins over the preference. */
	modelContextWindows = {};
	/** Disabled model IDs (blacklist); disabled models are filtered out from current(). */
	disabledModels = /* @__PURE__ */ new Set();
	constructor(initial = FALLBACK_QODER_MODELS) {
		this.models = initial;
	}
	/** Current entries; empty while the variant has no usable credential or is switched off, excluding disabled models. */
	current() {
		if (!this.visible || !this.enabled) return [];
		return this.all().filter((model) => !this.disabledModels.has(model.id));
	}
	/** All configured entries including disabled ones; empty while the variant has no usable credential. */
	all() {
		if (!this.visible) return [];
		return this.models.map((model) => {
			const override = this.modelContextWindows[model.id];
			if (override !== void 0 && override > 0) return {
				...model,
				defaultContextWindow: model.defaultContextWindow ?? model.contextWindow,
				contextWindow: override
			};
			const maximum = model.supportedContextWindows === void 0 ? void 0 : Math.max(...model.supportedContextWindows);
			return this.useMaximumContextWindow && maximum !== void 0 && maximum > model.contextWindow ? {
				...model,
				defaultContextWindow: model.defaultContextWindow ?? model.contextWindow,
				contextWindow: maximum
			} : model;
		});
	}
	/** Replace the list; callers invalidate their adapter snapshot after this. */
	set(models) {
		this.models = [...models];
	}
	/** Whether this variant's models are exposed at all. */
	isVisible() {
		return this.visible;
	}
	/**
	* Show or hide the whole catalog. Returns whether the value changed, so the
	* caller can skip an invalidation that would re-render an identical list.
	*/
	setVisible(visible) {
		if (this.visible === visible) return false;
		this.visible = visible;
		return true;
	}
	/** Select the largest declared window where the upstream offers one. */
	setUseMaximumContextWindow(useMaximum) {
		if (this.useMaximumContextWindow === useMaximum) return false;
		this.useMaximumContextWindow = useMaximum;
		return true;
	}
	/**
	* Switch this whole variant on or off (the card's per-variant master switch).
	*
	* Only {@link current} is gated, never {@link all}: the card must keep listing
	* the roster so the user can switch the variant back on. Returns whether the
	* value changed, so the caller can skip an invalidation over an identical
	* write.
	*/
	setEnabled(enabled) {
		if (this.enabled === enabled) return false;
		this.enabled = enabled;
		return true;
	}
	/** Whether this variant is switched on. */
	isEnabled() {
		return this.enabled;
	}
	/**
	* Replace the per-model window overrides wholesale. Returns whether the map
	* changed, so the caller can skip an invalidation over an identical write.
	*/
	setModelContextWindows(modelContextWindows) {
		const next = { ...modelContextWindows };
		if (JSON.stringify(next) === JSON.stringify(this.modelContextWindows)) return false;
		this.modelContextWindows = next;
		return true;
	}
	/**
	* Replace the disabled model IDs wholesale. Returns whether the set
	* changed, so the caller can skip an invalidation over an identical write.
	*/
	setDisabledModels(disabledModels) {
		const next = new Set(disabledModels);
		if (next.size === this.disabledModels.size && [...next].every((id) => this.disabledModels.has(id))) return false;
		this.disabledModels = next;
		return true;
	}
	/** Current disabled model IDs. */
	getDisabledModels() {
		return Array.from(this.disabledModels);
	}
	/**
	* Models to fall back to when the upstream fetch fails; ignores
	* visibility, because the caller asking for the fallback already knows the
	* credential state.
	*/
	fallback() {
		return this.models;
	}
};
//#endregion
//#region src/catalog-store.ts
/**
* The last catalog that actually loaded, kept per variant and per account.
*
* Both the plan (§4 "降级顺序为同账号的最近成功目录 → 本版内置保守目录")
* and the README promise this fallback, and without it a restart always drops
* the user to the built-in roster even when a good catalog was fetched minutes
* earlier. The built-in roster is a snapshot taken once; a fetched catalog is
* what the upstream actually serves to this account.
*
* What it deliberately is *not*:
*
* - not a cache with a freshness policy — it never prevents a fetch, it only
*   answers when a fetch cannot;
* - not shared across accounts (a different account can see a different roster),
*   nor across variants (the two regions serve overlapping ids with different
*   capacity and rate answers);
* - not a place for secrets: model metadata only, never a token. The account
*   key is a one-way hash of the credential, not the credential itself.
*
* @module dsh-qoder-plugin/catalog-store
*/
/** On-disk format this reader accepts; other versions are discarded. */
const CATALOG_FORMAT_VERSION = 1;
/** Plugin-owned saved-catalog path inside the plugin's state directory. */
function qoderCatalogPath(filename) {
	return join(qoderStateDir(), filename);
}
/** Whether a parsed value is a model row worth keeping. */
function isModel(value) {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const row = value;
	return typeof row["id"] === "string" && row["id"] !== "" && typeof row["name"] === "string" && typeof row["contextWindow"] === "number" && Number.isFinite(row["contextWindow"]) && typeof row["maxTokens"] === "number" && Number.isFinite(row["maxTokens"]) && typeof row["supportsImages"] === "boolean";
}
/** Whether a parsed value is a saved catalog this reader can trust. */
function isSaved(value) {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const entry = value;
	if (typeof entry["account"] !== "string" || entry["account"] === "") return false;
	if (typeof entry["source"] !== "string" || entry["source"] === "") return false;
	if (typeof entry["fetchedAtMs"] !== "number" || !Number.isFinite(entry["fetchedAtMs"])) return false;
	const models = entry["models"];
	if (!Array.isArray(models) || models.length === 0) return false;
	return models.every(isModel);
}
/**
* The last successful catalog per account, read once and written atomically.
*
* Malformed content reads as "nothing saved" rather than throwing: this file
* is an optimization for the offline and first-seconds cases, and a corrupt one
* must never be able to stop the plugin from serving models.
*/
var QoderCatalogStore = class {
	path;
	entries;
	constructor(options = {}) {
		this.path = typeof options === "string" ? options : options.path ?? qoderCatalogPath(".qoder-catalog.json");
	}
	/** Resolved state-file path, for the CLI and tests. */
	filePath() {
		return this.path;
	}
	load() {
		if (this.entries !== void 0) return this.entries;
		const entries = {};
		if (existsSync(this.path)) try {
			const parsed = JSON.parse(readFileSync(this.path, "utf8"));
			if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
				const document = parsed;
				const raw = document["version"] === CATALOG_FORMAT_VERSION ? document["entries"] : void 0;
				if (typeof raw === "object" && raw !== null && !Array.isArray(raw)) {
					for (const [key, value] of Object.entries(raw)) if (isSaved(value)) entries[key] = value;
				}
			}
		} catch {}
		this.entries = entries;
		return entries;
	}
	/** The saved catalog for one account, or `undefined` when there is none. */
	get(account) {
		const entry = this.load()[account];
		return entry === void 0 ? void 0 : entry;
	}
	/**
	* Remember a catalog for an account, replacing whatever was saved before.
	*
	* A failed write is swallowed: the plugin has already served these models,
	* and losing the *memory* of them is not worth surfacing.
	*/
	set(account, catalog) {
		const entries = this.load();
		entries[account] = {
			account,
			...catalog
		};
		this.persist();
	}
	/** Forget one account's catalog — used when that account signs out. */
	delete(account) {
		const entries = this.load();
		if (!(account in entries)) return;
		delete entries[account];
		this.persist();
	}
	persist() {
		const directory = dirname(this.path);
		try {
			if (!existsSync(directory)) mkdirSync(directory, { recursive: true });
			const document = {
				version: CATALOG_FORMAT_VERSION,
				entries: this.load()
			};
			const temporary = resolve(`${this.path}.tmp`);
			writeFileSync(temporary, `${JSON.stringify(document, null, 2)}\n`, { mode: 384 });
			renameSync(temporary, this.path);
		} catch {}
	}
};
//#endregion
//#region src/probe.ts
/**
* The reasoning-effort probe: decide whether a model's `reasoning_effort`
* parameter is actually validated, and if so which canonical values it accepts.
*
* Implements `docs/reasoning-effort-probe-plan.md` §4. The order matters and is
* not an optimization:
*
* 1. **Baseline** (no `reasoning_effort`) proves the model, credential, and
*    request shape work at all, so a later rejection can be attributed.
* 2. **Sentinel** (a fresh random, impossible-to-collide value) answers the one
*    question a per-level sweep cannot: does the upstream validate the field?
*    A model that accepts the sentinel answers 200 to *everything*, so its
*    per-level results would be uniformly false positives.
* 3. **Levels**, only after the sentinel was refused.
*
* The result is an observation, never a capability claim. Even a fully
* successful sweep means "the upstream accepted these spellings", not "these
* spellings change how the model thinks".
*
* @module dsh-qoder-plugin/probe
*/
/**
* The canonical values a probe tests, in a fixed order.
*
* `minimal` is absent: it appears in no upstream vocabulary. `off` is absent
* by policy — disabling thinking is a separate capability the upstream must
* declare through `canDisableThinking`, never something probing may infer.
*/
const PROBE_EFFORT_CANDIDATES = [
	"low",
	"medium",
	"high",
	"xhigh",
	"max"
];
/** Prompt body used by every probe request; carries nothing user-specific. */
const PROBE_PROMPT = "ping";
/** Default sentinel: unmistakably non-canonical, different on every call. */
function randomSentinel() {
	return `probe_sentinel_${randomBytes(12).toString("hex")}`;
}
/**
* The transport's rejection code for an effort the model does not advertise
* (`src/qoder/transport/wire/serialize.ts`).
*
* With the Qoder upstream this rejection is raised *locally* against the
* discovery catalog before any network call: a probe therefore measures the
* catalog's declaration as much as the endpoint behind it. That is a weaker
* finding than the WorkBuddy-era one, and it is what the plan's Stage D will
* weigh; the sequence below still distinguishes "advertises and validates"
* (per-level refusals after an accepted baseline) from "accepts anything the
* catalog does not name" — the sentinel answers that question against the
* same vocabulary the request path will later enforce.
*/
const INVALID_EFFORT_CODE = "UNSUPPORTED_REASONING_EFFORT";
/** Whether an attempt is an attributable rejection of the effort value. */
function isEffortRejection(attempt) {
	return attempt.status === 400 && attempt.errorCode === INVALID_EFFORT_CODE;
}
/** Whether an attempt shows the upstream accepted the request and streamed. */
function isAcceptance(attempt) {
	return attempt.status === 200 && attempt.streamed;
}
/** Why an attempt ended in `unknown`, phrased for a log line. */
function unknownReason(stage, attempt) {
	const code = attempt.errorCode === void 0 ? "" : ` (${attempt.errorCode})`;
	const detail = attempt.detail === void 0 ? "" : `: ${attempt.detail}`;
	return `${stage} status ${attempt.status}${code}${detail}`;
}
/**
* Probe one model.
*
* `options.candidates` exists so tests can shorten the sweep; production always
* uses {@link PROBE_EFFORT_CANDIDATES}.
*/
async function probeModel(options) {
	const sentinel = options.sentinel ?? randomSentinel;
	const candidates = options.candidates ?? PROBE_EFFORT_CANDIDATES;
	const timeoutMs = options.timeoutMs ?? 3e4;
	let requests = 0;
	const attempt = async (effort) => {
		requests += 1;
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), timeoutMs);
		try {
			return await options.send(effort, controller.signal);
		} catch (error) {
			return {
				status: 0,
				streamed: false,
				detail: `transport error: ${String(error)}`
			};
		} finally {
			clearTimeout(timer);
		}
	};
	const baseline = await attempt(void 0);
	if (!isAcceptance(baseline)) return {
		validation: "unknown",
		efforts: [],
		requests,
		reason: unknownReason("baseline", baseline)
	};
	const sentinelAttempt = await attempt(sentinel());
	if (isAcceptance(sentinelAttempt)) return {
		validation: "non-validating",
		efforts: [],
		requests
	};
	if (!isEffortRejection(sentinelAttempt)) return {
		validation: "unknown",
		efforts: [],
		requests,
		reason: unknownReason("sentinel", sentinelAttempt)
	};
	const accepted = [];
	for (const effort of candidates) {
		const levelAttempt = await attempt(effort);
		if (isAcceptance(levelAttempt)) {
			accepted.push(effort);
			continue;
		}
		if (isEffortRejection(levelAttempt)) continue;
		return {
			validation: "unknown",
			efforts: [],
			requests,
			reason: unknownReason(`level ${effort}`, levelAttempt)
		};
	}
	return {
		validation: "validating",
		efforts: accepted,
		requests
	};
}
//#endregion
//#region src/qoder/queue-notice.ts
/**
* The upstream "this model is not serviceable" answer, parsed and worded.
*
* Qoder announces a saturated per-model queue — or a region whose service is
* off — with a body carrying `code: 10605`, `isQueued`, `serviceAvailable`,
* `retryAfterSeconds`, `modelKey`, `queueCount`, `queueType` and
* `subCode: RESOURCE_LIMIT`. That body arrives as HTTP 200, 401 **or** 403, so
* the status is not the signal; the body is the only place the distinction
* between "come back shortly" and "your credential died" is visible.
*
* The body is also not a flat document. The upstream nests its own JSON inside
* the `message` field as a **string**, sometimes twice; users pasted this
* verbatim shape (2026-10-21):
*
*     {"code":"403","message":"{\"code\":\"10605\",
*      \"message\":\"{\\\"isQueued\\\":true,\\\"modelKey\\\":\\\"qfmodel\\\",…}\",
*      \"subCode\":\"RESOURCE_LIMIT\"}"}
*
* A plain `JSON.parse` of that text sees only the outer wrapper, so everything
* below descends through `message` strings until it reaches the object that
* actually holds the facts. The wording built here exists because the two
* misreadings both sent the user the wrong way: coded `AUTH` it sent them to
* replace a perfectly good token, and coded as a bare `RATE_LIMIT` it said
* "throttled" while hiding that the model itself is unavailable. The notice
* therefore states that credentials and quota are not the problem, and never
* claims a wait this plugin did not actually perform.
*
* @module dsh-qoder-plugin/qoder/queue-notice
*/
/** Bound keeping a runaway upstream body from flooding the conversation row. */
const UPSTREAM_MESSAGE_LIMIT = 400;
/** How many `message`-in-a-string layers are followed before giving up. */
const MAX_MESSAGE_DEPTH = 6;
/**
* The queue markers Qoder puts in a rejection body.
*
* This deliberately mirrors the private `QUEUE_BODY_MARKERS` in `./errors.ts`
* rather than importing it. `qoderQueueSignal` is the classification path
* shared with `src/upstream.ts` and the transport, and it must keep reading the
* bodies exactly as observed even if this newer, richer parser develops a
* blind spot; a shared constant would let one change move both at once. The
* two lists stay in step through the tests on either side
* (`tests/qoder/errors.test.ts`, `tests/qoder/queue-notice.test.ts`).
*/
const QUEUE_MARKERS = [
	/"code"\s*:\s*"?10605"?/u,
	/"isQueued"\s*:\s*true/u,
	/"queueCount"/u,
	/"serviceAvailable"\s*:\s*false/u
];
/**
* Parse Qoder's queue/unserviceable answer out of a raw response body,
* whatever HTTP status carried it.
*
* Total by contract: any string is a legal input, junk included, and `undefined`
* means "this body is not that answer" — never an exception thrown into an
* error path that is already reporting a failure. The returned-facts/undefined
* boundary is drawn on the same markers the classifier uses, so a rejection
* that classified as a throttle is never left without an explanation.
*/
function parseQueueFacts(body) {
	if (typeof body !== "string" || body.trim() === "") return void 0;
	if (!QUEUE_MARKERS.some((marker) => marker.test(body.replace(/\\/gu, "")))) return void 0;
	return factsFromRecords(collectRecords(body), body) ?? factsFromMarkerText(body);
}
/**
* Render the user-facing notice for one queue answer.
*
* `waited` and `occurrences` are facts, not decoration: the sentence claiming a
* wait appears only when the plugin really waited out the upstream's window,
* and the risk-control possibility is mentioned only when the same answer has
* recurred (a single saturated queue is an ordinary busy minute, while the
* same answer coming back repeatedly is what suggests the account is being
* throttled upstream).
*/
function formatQueueNotice(facts, options) {
	const seconds = facts.retryAfterSeconds;
	const state = facts.serviceAvailable === false ? "模型暂不可服务" : facts.isQueued ? "模型排队中" : "模型暂不可服务";
	const head = seconds === void 0 ? `上游模型排队中（${state}，上游未给出建议重试时间）` : `上游模型排队中（${state}，上游建议 ${seconds} 秒后重试）`;
	const wait = waitedSentence(seconds, options);
	const risk = options.occurrences > 1 ? "，如果频繁返回此结果可能代表当前账号已被风控" : "";
	const quoted = facts.upstreamMessage === void 0 ? void 0 : boundMessage(facts.upstreamMessage);
	return `${head}：这不是登录态或额度问题，${wait}${risk}${quoted === void 0 ? "" : `（上游原文：${quoted}）`}`;
}
/**
* The sentence claiming what waiting happened, from what was really observed.
*
* Three states, and the difference matters because each sentence is a claim:
*
* - the transport completed at least one wait on the CONFIGURED fallback: the
*   upstream advised nothing, so no advice may be quoted — say plainly how long
*   the configured window held the request;
* - the transport completed at least one wait on the upstream's ADVICE: quote
*   the advice, which is the window the wait was built on;
* - the transport waited nothing: keep the old contract, including the case
*   where the host's own retry cycle (not the plugin) is what sat out the
*   advised window — {@link formatQueueNotice}'s `waited` flag stays the only
*   evidence for that, and a request that never waited must not borrow it from
*   a clock reading.
*/
function waitedSentence(seconds, options) {
	const waits = options.waits;
	const completed = waits !== void 0 && waits.attempts > 0 ? waits : void 0;
	if (completed !== void 0 && completed.lastBasis?.source === "configured") return `已按配置等待 ${Math.max(1, Math.round(completed.totalWaitMs / 1e3))} 秒，重试后仍不可服务`;
	if (!(completed !== void 0 || options.waited === true)) return "本次未按上游建议等待即返回此结果";
	const advised = completed?.lastBasis?.advisedSeconds ?? seconds;
	return advised === void 0 ? "已按上游建议等待后仍不可服务" : `已按上游建议等待 ${advised} 秒仍不可服务`;
}
/**
* Render the visible "we are actually waiting now" row.
*
* The final-failure notice ({@link formatQueueNotice}) could only ever appear
* AFTER a request gave up, so a request that waited out one or two advise
* windows looked indistinguishable from a hang: the user watched an empty
* conversation for 30–90 seconds and read the queue explanation only when
* nothing was left to do. This row is printed when the wait STARTS, once per
* wait, and the attempt number makes consecutive rows textually different —
* the host's per-turn de-duplication (it suppresses identical notices) must not
* collapse the second wait into the first, or a two-wait retry would again look
* frozen after the first line.
*/
function formatQueueWaitNotice(facts, wait) {
	const seconds = Math.max(1, Math.round(wait.waitMs / 1e3));
	const left = wait.remaining > 0 ? `，本次请求还可再等 ${wait.remaining} 次` : "，这是本次请求的最后一次等待";
	const queue = facts.queueCount === void 0 ? "" : `（当前排队约 ${facts.queueCount} 个请求）`;
	const basis = wait.basis;
	const why = basis === void 0 ? "" : basis.source === "upstream" ? `（上游建议 ${basis.advisedSeconds ?? seconds} 秒，设置仅作无建议时的回退）` : `（上游未给出建议，按设置的 ${basis.configuredSeconds} 秒）`;
	const quoted = facts.upstreamMessage === void 0 ? void 0 : boundMessage(facts.upstreamMessage);
	const source = quoted === void 0 ? "" : `（上游原文：${quoted}）`;
	return `上游模型排队中：正在等待约 ${seconds} 秒后重试（第 ${wait.attempt} 次等待${left}）${queue}${why}。这不是登录态或额度问题${source}`;
}
/**
* Every JSON object reachable from `body`, outermost first.
*
* The descent follows `message` strings only, because that is where Qoder
* wraps each layer. A depth cap and a seen-set keep a self-referential or
* machine-generated nesting from turning a parse of a hostile body into
* unbounded work.
*/
function collectRecords(body) {
	const records = [];
	const seen = /* @__PURE__ */ new Set();
	let pending = [{
		text: body,
		depth: 0
	}];
	while (pending.length > 0) {
		const next = [];
		for (const { text, depth } of pending) {
			if (depth > MAX_MESSAGE_DEPTH || seen.has(text)) continue;
			seen.add(text);
			const record = parseObject(text);
			if (record === void 0) continue;
			records.push(record);
			const nested = record["message"];
			if (typeof nested === "string" && nested.trim() !== "") next.push({
				text: nested,
				depth: depth + 1
			});
		}
		pending = next;
	}
	return records;
}
/**
* Tolerate the text around the JSON: an SSE envelope prefixes the payload, and
* a truncated body has no closing brace at all (then there is simply nothing
* to parse and the caller falls back to a marker scan).
*/
function parseObject(text) {
	const trimmed = text.trim();
	const direct = tryParseObject(trimmed);
	if (direct !== void 0) return direct;
	const start = trimmed.indexOf("{");
	const end = trimmed.lastIndexOf("}");
	if (start < 0 || end <= start) return void 0;
	return tryParseObject(trimmed.slice(start, end + 1));
}
function tryParseObject(text) {
	try {
		const value = JSON.parse(text);
		return typeof value === "object" && value !== null && !Array.isArray(value) ? value : void 0;
	} catch {
		return;
	}
}
/**
* The facts the parsed layers carry, or `undefined` when none of them is a
* queue answer (an authorization rejection nests the same way, and must not
* acquire a queue explanation).
*
* Values are read innermost-first: that is where the upstream describes the
* model it is refusing, and an outer wrapper only ever repeats or omits it.
*/
function factsFromRecords(records, body) {
	const isQueued = deepestBoolean(records, "isQueued");
	const serviceAvailable = deepestBoolean(records, "serviceAvailable");
	const queueCount = deepestNumber(records, "queueCount");
	const codeIsQueue = records.some((record) => readString(record["code"]) === "10605");
	if (isQueued !== true && serviceAvailable !== false && queueCount === void 0 && !codeIsQueue) return;
	const facts = {
		isQueued: isQueued ?? false,
		serviceAvailable: serviceAvailable ?? true
	};
	const modelKey = deepestString(records, "modelKey");
	if (modelKey !== void 0) facts.modelKey = modelKey;
	const queueType = deepestString(records, "queueType");
	if (queueType !== void 0) facts.queueType = queueType;
	const subCode = deepestString(records, "subCode");
	if (subCode !== void 0) facts.subCode = subCode;
	if (queueCount !== void 0) facts.queueCount = queueCount;
	const retryAfterSeconds = deepestNumber(records, "retryAfterSeconds");
	if (retryAfterSeconds !== void 0) facts.retryAfterSeconds = retryAfterSeconds;
	const waitTime = deepestNumber(records, "waitTime");
	if (waitTime !== void 0) facts.waitTime = waitTime;
	const upstreamMessage = boundMessage(deepestMessage(records) ?? body);
	if (upstreamMessage !== void 0) facts.upstreamMessage = upstreamMessage;
	return facts;
}
/**
* Facts recovered from a body that does not parse at all — a truncated
* response, or an envelope carrying the markers as loose text.
*
* It exists so that a rejection the classifier calls a queue is never left
* without an explanation; it reads the markers after dropping the JSON string
* escapes, exactly as `qoderQueueSignal` does.
*/
function factsFromMarkerText(body) {
	const text = body.replace(/\\/gu, "");
	if (!QUEUE_MARKERS.some((marker) => marker.test(text))) return void 0;
	const isQueued = /"isQueued"\s*:\s*(true|false)/u.exec(text)?.[1];
	const serviceAvailable = /"serviceAvailable"\s*:\s*(true|false)/u.exec(text)?.[1];
	const facts = {
		isQueued: isQueued === "true",
		serviceAvailable: serviceAvailable === void 0 ? true : serviceAvailable === "true"
	};
	const modelKey = /"modelKey"\s*:\s*"([^"]*)"/u.exec(text)?.[1];
	if (modelKey !== void 0 && modelKey !== "") facts.modelKey = modelKey;
	const queueType = /"queueType"\s*:\s*"([^"]*)"/u.exec(text)?.[1];
	if (queueType !== void 0 && queueType !== "") facts.queueType = queueType;
	const subCode = /"subCode"\s*:\s*"([^"]*)"/u.exec(text)?.[1];
	if (subCode !== void 0 && subCode !== "") facts.subCode = subCode;
	const queueCount = readNumber(/"queueCount"\s*:\s*"?(\d+)"?/u.exec(text)?.[1]);
	if (queueCount !== void 0) facts.queueCount = queueCount;
	const retryAfterSeconds = readNumber(/"retryAfterSeconds"\s*:\s*"?(\d+)"?/u.exec(text)?.[1]);
	if (retryAfterSeconds !== void 0) facts.retryAfterSeconds = retryAfterSeconds;
	const waitTime = readNumber(/"waitTime"\s*:\s*"?(\d+(?:\.\d+)?)"?/u.exec(text)?.[1]);
	if (waitTime !== void 0) facts.waitTime = waitTime;
	const upstreamMessage = boundMessage(body);
	if (upstreamMessage !== void 0) facts.upstreamMessage = upstreamMessage;
	return facts;
}
function deepestBoolean(records, key) {
	for (let i = records.length - 1; i >= 0; i -= 1) {
		const record = records[i];
		if (record === void 0) continue;
		const value = readBoolean(record[key]);
		if (value !== void 0) return value;
	}
}
function deepestNumber(records, key) {
	for (let i = records.length - 1; i >= 0; i -= 1) {
		const record = records[i];
		if (record === void 0) continue;
		const value = readNumber(record[key]);
		if (value !== void 0) return value;
	}
}
function deepestString(records, key) {
	for (let i = records.length - 1; i >= 0; i -= 1) {
		const record = records[i];
		if (record === void 0) continue;
		const value = readString(record[key]);
		if (value !== void 0) return value;
	}
}
function deepestMessage(records) {
	for (let i = records.length - 1; i >= 0; i -= 1) {
		const record = records[i];
		if (record === void 0) continue;
		const value = record["message"];
		if (typeof value === "string" && value.trim() !== "") return value;
	}
}
/** Quoted numbers are accepted: the upstream does not promise JSON types. */
function readBoolean(value) {
	if (typeof value === "boolean") return value;
	if (value === "true") return true;
	if (value === "false") return false;
}
function readNumber(value) {
	if (typeof value === "number") return Number.isFinite(value) ? value : void 0;
	if (typeof value === "string" && /^\d+(?:\.\d+)?$/u.test(value.trim())) return Number(value);
}
function readString(value) {
	return typeof value === "string" && value.trim() !== "" ? value.trim() : void 0;
}
/**
* One readable line of upstream text.
*
* Whichever quoting layer it came from, the text ends up inside a single-line
* conversation row, so runs of whitespace collapse and the result is cut at
* {@link UPSTREAM_MESSAGE_LIMIT} with an ellipsis marking the cut.
*/
function boundMessage(text) {
	const collapsed = text.replace(/\s+/gu, " ").trim();
	if (collapsed === "") return void 0;
	return collapsed.length > UPSTREAM_MESSAGE_LIMIT ? `${collapsed.slice(0, UPSTREAM_MESSAGE_LIMIT)}…` : collapsed;
}
//#endregion
//#region src/qoder/errors.ts
/**
* DSH-compatible LLM error representation.
*
* @module dsh-qoder-plugin/qoder/errors
*/
var QoderLlmError = class extends LlmError {
	/**
	* The parsed queue answer, when this error IS the upstream's "model not
	* serviceable" reply.
	*
	* It rides the error because the body is the only place the distinction
	* lives, and the body is read exactly once, here, while classifying. Every
	* layer above gets the explanation without re-reading or re-parsing a body
	* it never had: the host builds the user-facing notice from this, and the
	* notice can therefore never disagree with the classification that decided
	* the request failed.
	*/
	qoderQueue;
	constructor(message, code = "UNKNOWN_ERROR", options) {
		super(message, code, options);
	}
};
/**
* The queue/limit markers Qoder puts in a rejection body (observed 2026-09-26).
*
* `./queue-notice.ts` keeps its own copy of this list on purpose: this one
* drives the AUTH-versus-RATE_LIMIT classification shared with `src/upstream.ts`
* and the transport, and it must keep reading observed bodies exactly as they
* are even if the richer parser next door changes. Tests on both sides hold the
* two in step.
*/
const QUEUE_BODY_MARKERS = [
	/"code"\s*:\s*"?10605"?/u,
	/"isQueued"\s*:\s*true/u,
	/"queueCount"/u,
	/"serviceAvailable"\s*:\s*false/u
];
/**
* Whether an upstream rejection body is Qoder's **queue/limit** answer rather
* than an authorization failure.
*
* Qoder answers a saturated per-model queue (and a region whose service is not
* available) with an HTTP 401/403 — or a 200 SSE envelope carrying
* `statusCodeValue: 403` — whose body says `code: 10605`, `isQueued: true`,
* `queueCount`, `retryAfterSeconds` and sometimes `serviceAvailable: false`.
* Observed verbatim on 2026-09-26:
*
*     {"code":"10605","message":"{\"isQueued\":true,\"modelKey\":\"qfmodel\",
*      \"queueCount\":8887,\"queueType\":\"p3\",\"retryAfterSeconds\":30,
*      \"serviceAvailable\":true,\"waitTime\":274}"}
*
* Reading that status as AUTH made the self-heal exchange fresh job tokens
* against a queue no token can jump, and — because the host retries
* `RATE_LIMIT` but deliberately not `AUTH` — it also suppressed the automatic
* retry that would have sailed through the 30-second window. The body is the
* only place the distinction is visible, so it gets the last say over status.
*/
function qoderQueueSignal(body) {
	if (body === void 0 || body === "") return void 0;
	const text = body.replace(/\\/gu, "");
	if (!QUEUE_BODY_MARKERS.some((marker) => marker.test(text))) return void 0;
	const match = /"retryAfterSeconds"\s*:\s*(\d+)/u.exec(text);
	return match === null ? {} : { retryAfterMs: Number(match[1]) * 1e3 };
}
/**
* The parsed facts of Qoder's queue/unserviceable answer, or `undefined` when
* the body is not that answer at all.
*
* {@link qoderQueueSignal} answers the classification question — "is this a
* throttle rather than a dead credential?" — with the minimum it needs. This
* answers the explanation question — "what should the user be told?" — from the
* same body, so a call site can classify an error and describe it without
* parsing the nesting twice, and the two can never disagree about what the
* upstream said. The re-export lives here because this module owns the
* upstream-error surface callers already import.
*/
function qoderQueueFacts(body) {
	return parseQueueFacts(body ?? "");
}
/**
* Replace status digits that read as authorization failure with a neutral
* word, for messages the upstream used to announce a queue.
*
* `dsh-llm-pi-ai`'s error classifier is a text matcher whose first test is
* `/\b(?:401|403)\b/` — ahead of its 429/rate-limit test — so any message
* carrying those digits classifies AUTH no matter the structured code
* travelling beside it. A queue answer quoting the upstream's 403 (in the
* message prefix, the envelope status, or the body's `"code":"403"`) must not
* reach that matcher as-is, or the user sees "API 密钥无效" for a throttle
* (observed verbatim on 2026-09-26 23:30 and again at 23:40).
*/
function deauthorizeDigits(message) {
	return message.replace(/\b(?:401|403)\b/gu, "throttled");
}
/**
* Upstream HTTP statuses that mean "the provider itself stumbled", not "the
* request is wrong".
*
* Taken from the reference gateway (`qoder2api-hub/qoder_proxy.py`:
* `TRANSIENT_HTTP_CODES = (418, 500, 502, 503, 504)`), which treats exactly
* these as same-account retry candidates. The 5xx members already classify as
* `SERVER` here; 418 is the one that used to fall through to
* `INVALID_REQUEST`, the code that tells the transport switching cannot help.
* Observed upstream shape: Qoder answers a provider failure as HTTP 418
* wrapping `provider_error`, so retrying or trying another account CAN clear
* it — the opposite of the request-error contract `INVALID_REQUEST` carries.
*
* The 4xx statuses with no transient meaning (400, 404, 405, 422, ...) keep
* classifying as client errors: an identical request fails identically on
* every identity, and switching would only obscure the real answer. The
* reference also promotes some other 4xx to transient when the body carries
* `provider_error`; doing that here needs a body-inspection policy decision
* (which messages count, and what a localised or reworded body does), so it is
* deliberately left out and listed as pending confirmation in the task report.
*/
const transientHttpCodes = [418];
/**
* The last-resort code for an HTTP status the classifier did not name.
*
* `SERVER` would have accepted the 418 as well, but it would also have erased
* the one distinction later policies need: a 5xx is a gateway-side failure of
* the response, while a 418 is the upstream packaging its own provider fault
* into a non-5xx status. Both are switch- and retry-eligible today, yet the
* self-harm guard has to be able to say "this was an upstream transient, not a
* hard account failure" without re-deriving it from the number. A dedicated
* code costs one extra arm here and keeps that vocabulary honest.
*/
const transientCode = "TRANSIENT";
function qoderHttpError(message, response, body) {
	const { status } = response;
	const headerRetryAfterMs = retryAfterMs(response.headers?.get("retry-after") ?? null);
	const requestId = qoderRequestId(response.headers);
	const queue = status === 401 || status === 403 || status === 429 ? qoderQueueSignal(body ?? message) : void 0;
	if (queue !== void 0) {
		const retryAfterMs = (queue.retryAfterMs !== void 0 && queue.retryAfterMs > 0 ? queue.retryAfterMs : void 0) ?? headerRetryAfterMs;
		const rejection = new QoderLlmError(deauthorizeDigits(message), "RATE_LIMIT", {
			status,
			...retryAfterMs === void 0 ? {} : { providerRetryAfterMs: retryAfterMs },
			...requestId === void 0 ? {} : { requestId }
		});
		const facts = qoderQueueFacts(body ?? message);
		if (facts !== void 0) rejection.qoderQueue = facts;
		return rejection;
	}
	return new QoderLlmError(message, status === 401 || status === 403 ? "AUTH" : status === 408 ? "TIMEOUT" : status === 429 ? "RATE_LIMIT" : transientHttpCodes.includes(status) ? transientCode : status >= 500 && status <= 599 ? "SERVER" : status >= 400 && status <= 499 ? "INVALID_REQUEST" : "PROVIDER_ERROR", {
		status,
		...headerRetryAfterMs === void 0 ? {} : { providerRetryAfterMs: headerRetryAfterMs },
		...requestId === void 0 ? {} : { requestId }
	});
}
function qoderRequestId(headers) {
	const normalized = (headers?.get("x-request-id") ?? headers?.get("request-id") ?? headers?.get("x-amzn-requestid"))?.trim();
	return normalized ? ProviderRequestId(normalized) : void 0;
}
/**
* Whether this failure is an upstream authorization rejection worth one
* re-auth retry.
*
* The job token the transport signs requests with is cached in memory; an
* upstream that invalidates it mid-lifetime (gateway rotation or a fault
* window) answers HTTP 401/403 before any payload is produced. That state is
* distinguishable from a genuinely revoked PAT only by trying a fresh
* exchange, so callers clear their credential cache and retry once before
* reporting `AUTH` to the user.
*
* A `RATE_LIMIT` code is never a re-auth candidate, **even when its status is
* 401/403**: that is the upstream's queue answer (code 10605 / isQueued /
* retryAfterSeconds in the body), which keeps the status but says the
* credential was not the problem. Healing it exchanged job tokens against a
* queue no token can jump (observed 2026-09-26) and, by consuming the retry,
* suppressed the rate-limit retry that would have ridden out the window.
*/
function isQoderAuthRejection(error) {
	if (!(error instanceof LlmError)) return false;
	if (error.code === "RATE_LIMIT") return false;
	return error.code === "AUTH" || error.failure.status === 401 || error.failure.status === 403;
}
function retryAfterMs(value, nowMs = Date.now()) {
	const normalized = value?.trim();
	if (!normalized) return void 0;
	if (/^\d+$/u.test(normalized)) {
		const delayMs = Number(normalized) * 1e3;
		return Number.isFinite(delayMs) && delayMs > 0 ? delayMs : void 0;
	}
	const retryAt = Date.parse(normalized);
	if (Number.isNaN(retryAt)) return void 0;
	const delayMs = retryAt - nowMs;
	return delayMs > 0 ? delayMs : void 0;
}
//#endregion
//#region src/qoder/transport/endpoints.ts
const qoderRegionEndpoints = {
	global: {
		baseUrl: "https://api3.qoder.sh/",
		openApiUrl: "https://openapi.qoder.sh",
		centerUrl: "https://center.qoder.sh"
	},
	china: {
		baseUrl: "https://gateway.qoder.com.cn/",
		openApiUrl: "https://openapi.qoder.com.cn",
		centerUrl: "https://gateway.qoder.com.cn"
	}
};
/** Signed path of the center image upload route; it never carries an `/algo` prefix. */
const qoderImageUploadPath = "/api/v2/image/upload";
qoderRegionEndpoints.global.baseUrl;
qoderRegionEndpoints.global.openApiUrl;
function resolveQoderEndpoints(region = "global") {
	return qoderRegionEndpoints[region] ?? qoderRegionEndpoints.global;
}
function getQoderChatUrl(region = "global") {
	const { baseUrl } = resolveQoderEndpoints(region);
	return `${baseUrl}algo/api/v2/service/pro/sse/agent_chat_generation?FetchKeys=llm_model_result&AgentId=agent_common&Encode=1`;
}
function getQoderModelListUrl(region = "global") {
	const { baseUrl } = resolveQoderEndpoints(region);
	return `${baseUrl}algo/api/v2/model/list?Encode=1`;
}
function getQoderImageUploadUrl(region = "global", requestId) {
	const { centerUrl } = resolveQoderEndpoints(region);
	const base = `${centerUrl.replace(/\/+$/u, "")}/algo${qoderImageUploadPath}`;
	return requestId === void 0 ? base : `${base}?request_id=${encodeURIComponent(requestId)}`;
}
function getQoderExchangeUrl(region = "global") {
	const { openApiUrl } = resolveQoderEndpoints(region);
	return `${openApiUrl}/api/v1/jobToken/exchange`;
}
function getQoderUserInfoUrl(region = "global") {
	const { openApiUrl } = resolveQoderEndpoints(region);
	return `${openApiUrl}/api/v1/userinfo`;
}
function getQoderUsageUrl(region = "global") {
	const { openApiUrl } = resolveQoderEndpoints(region);
	return `${openApiUrl}/api/v2/quota/usage`;
}
function getQoderUserPlanUrl(region = "global") {
	const { openApiUrl } = resolveQoderEndpoints(region);
	return `${openApiUrl}/api/v2/user/plan`;
}
function getQoderUserStatusUrl(region = "global") {
	const { openApiUrl } = resolveQoderEndpoints(region);
	return `${openApiUrl}/api/v3/user/status`;
}
function getQoderCampaignsUrl(region = "global") {
	const { openApiUrl } = resolveQoderEndpoints(region);
	return `${openApiUrl}/sash/api/v1/me/campaigns`;
}
function getQoderClaimCampaignUrl(region = "global", campaignId) {
	const { openApiUrl } = resolveQoderEndpoints(region);
	return `${openApiUrl}/sash/api/v1/me/campaigns/${encodeURIComponent(campaignId)}/claim`;
}
//#endregion
//#region src/qoder/transport/device-identity.ts
/**
* Per-account device fingerprints for the Qoder wire protocol.
*
* The upstream groups traffic by the `Cosy-Machineid` / `Cosy-Machinehostname`
* headers. Reporting one process-wide machine id therefore makes every account
* driven from this host look like a single device — the exact pattern the
* anti-abuse layer treats as a shared/scripted client. The official clients
* mint these values per account instead, and both are deterministic hashes of
* the account id (no random component), so a restart never changes an account's
* fingerprint. This module reproduces that derivation.
*
* The optional `seed` is the one escape hatch from "forever": the plugin's
* reset control rotates a host-level seed (see `device-seed.ts`), which gives
* every account a fresh fingerprint without touching its PAT, its login, or
* this host's real machine id. An absent seed contributes no bytes at all, so
* the derivation stays byte-for-byte what it always was and upgrading changes
* nobody's identity.
*
* @module dsh-qoder-plugin/qoder/transport/device-identity
*/
/**
* Salt the reference client prepends to the account id before hashing the
* machine id. Kept as an exported default so callers can name the salt they
* rely on while the derivation stays one function.
*/
const machineIdSalt = "machine";
/**
* Salt the reference client uses for the per-account hostname label. It is a
* separate salt so the hostname cannot be cross-referenced with the machine id.
*/
const machineHostnameSalt = "hostname";
function md5Hex(value) {
	return createHash("md5").update(value).digest("hex");
}
/**
* The seed's contribution to the hashed input, `''` when there is none.
*
* One helper so both derivations splice it identically: the seed sits between
* the salt and the account id. Empty and absent are the same thing on purpose —
* a seed file that exists but is blank must not silently change identities.
*/
function seedPrefix(seed) {
	return seed === void 0 || seed === "" ? "" : `${seed}:`;
}
/**
* Derive an account's device id as `MD5(salt:[seed:]userID)` forged into UUIDv4
* shape.
*
* The upstream accepts (and the reference clients send) a UUIDv4-shaped value,
* so version nibble `4` is written at position 12 and the RFC 4122 variant
* nibble at 16; the digest is otherwise untouched. Being derived rather than
* random is what makes the id stable for an account across restarts, and
* distinct per account even when several accounts share this host.
*
* @param userID - the account's upstream user id.
* @param salt - the salt to prepend; defaults to the reference client's.
* @param seed - host-level seed from the reset control; omitted means the
*   historical derivation.
*/
function deriveMachineId(userID, salt = machineIdSalt, seed) {
	const hash = md5Hex(`${salt}:${seedPrefix(seed)}${userID}`);
	const forged = `${hash.slice(0, 12)}4${hash.slice(13, 16)}a${hash.slice(17)}`;
	return [
		forged.slice(0, 8),
		forged.slice(8, 12),
		forged.slice(12, 16),
		forged.slice(16, 20),
		forged.slice(20)
	].join("-");
}
/**
* Derive an account's machine hostname as `DESKTOP-` plus seven uppercase hex
* characters of `MD5(hostname:[seed:]userID)`.
*
* This is the Windows-computer-name shape of `Cosy-Machinehostname`, which the
* official desktop client sends on the inference stream only. Deriving it from
* the account id keeps it stable across restarts and per account, and avoids
* leaking this host's real run name to the upstream.
*
* @param userID - the account's upstream user id.
* @param seed - host-level seed from the reset control; omitted means the
*   historical derivation.
*/
function deriveMachineHostname(userID, seed) {
	return `DESKTOP-${md5Hex(`${machineHostnameSalt}:${seedPrefix(seed)}${userID}`).slice(0, 7).toUpperCase()}`;
}
//#endregion
//#region src/qoder/transport/machine-id.ts
/**
* The locations a Qoder machine id may already live in, most authoritative
* first. The LAST entry is the only one this module may create.
*
* The order is the whole point of this list:
*
* 1. `~/.qoder/.auth/machine_id` is the OFFICIAL client's own stored id. When a
*    Qoder client is installed, the upstream already knows this machine by that
*    value, so reusing it is what makes the plugin look like the same device
*    rather than a second, unrelated one. (Measured on a machine with the
*    client installed: a different id here shows up upstream as a different
*    device, which is exactly the inconsistency this list exists to avoid.)
* 2. `~/.dsh/qoder/machine_id` is the plugin's own fallback, and it lives at
*    the HOST level on purpose. A profile-scoped seed — the old
*    `<profile>/state/.qoder-machine-id` — gave every DSH profile its own
*    "machine", so one computer reported several device identities and the
*    per-device view of quota and risk drifted between profiles.
*/
function defaultMachineIdPaths() {
	return [join(homedir(), ".qoder", ".auth", "machine_id"), join(homedir(), ".dsh", "qoder", "machine_id")];
}
/**
* Read the machine id from the first trusted location that has one, or create
* the DSH-owned fallback in the last location.
*
* A caller must NOT pass a narrower list than the default unless it wants to
* ignore the official client's id on purpose (tests do exactly that to stay
* hermetic). Every entry is a claim about "this machine"; letting each caller
* pick a different entry is how one host ends up presenting several identities,
* which is the bug this module's list order fixes.
*/
function getMachineId(paths = defaultMachineIdPaths()) {
	for (const path of paths) {
		if (!existsSync(path)) continue;
		try {
			const value = readFileSync(path, "utf8").trim();
			if (value) return value;
		} catch {}
	}
	const machineId = crypto.randomUUID();
	const savePath = paths.at(-1);
	if (savePath !== void 0) try {
		mkdirSync(dirname(savePath), { recursive: true });
		writeFileSync(savePath, machineId, {
			encoding: "utf8",
			flag: "wx"
		});
	} catch {
		try {
			const existing = readFileSync(savePath, "utf8").trim();
			if (existing) return existing;
		} catch {}
	}
	return machineId;
}
//#endregion
//#region src/qoder/transport/logging.ts
const sensitiveKey = /(?:authorization|credential|password|secret|token)/iu;
const identifierKey = /^(?:accountId|id|uid|userId)$/iu;
/** Shared with the inner-error observer so the two redactors cannot drift. */
const tokenValue = /\b(?:jrt|jt|pt)-[\w.-]+\b/giu;
const bearerValue = /Bearer\s+[^\s,;]+/giu;
const maxDepth = 4;
const maxEntries = 50;
const maxStringLength = 500;
function maskIdentifier(value) {
	const text = String(value);
	return text.length <= 4 ? "[REDACTED]" : `…${text.slice(-4)}`;
}
function maskEmail(value) {
	const text = String(value);
	const at = text.indexOf("@");
	if (at <= 0) return "[REDACTED]";
	return `${text.slice(0, 1)}***${text.slice(at)}`;
}
function redactString(value) {
	return (value.length > maxStringLength ? `${value.slice(0, maxStringLength)}…` : value).replace(tokenValue, "[REDACTED]").replace(bearerValue, "Bearer [REDACTED]");
}
/** Redact credentials and bound arbitrary provider values before logging them. */
function redactLogValue(value, depth = 0) {
	if (typeof value === "string") return redactString(value);
	if (value === null || typeof value !== "object") return value;
	if (depth >= maxDepth) return "[TRUNCATED]";
	if (value instanceof Error) return {
		name: value.name,
		message: redactString(value.message),
		..."code" in value ? { code: redactLogValue(value.code, depth + 1) } : {}
	};
	if (Array.isArray(value)) return value.slice(0, maxEntries).map((item) => redactLogValue(item, depth + 1));
	return Object.fromEntries(Object.entries(value).slice(0, maxEntries).map(([key, item]) => {
		if (sensitiveKey.test(key)) return [key, "[REDACTED]"];
		if (identifierKey.test(key)) return [key, maskIdentifier(item)];
		if (key.toLowerCase() === "email") return [key, maskEmail(item)];
		return [key, redactLogValue(item, depth + 1)];
	}));
}
/** Parse JSON-shaped diagnostics when possible, then apply the same redaction boundary. */
function redactLogPayload(text) {
	try {
		return redactLogValue(JSON.parse(text));
	} catch {
		return redactLogValue(text);
	}
}
/** Log one successfully parsed non-stream response through the shared redaction policy. */
function logParsedResponse(logger, operation, result) {
	logger?.debug?.("[Qoder Response] Parsed", redactLogValue({
		operation,
		result
	}));
}
//#endregion
//#region src/qoder/transport/wire/version.ts
/**
* Client versions presented to Qoder's upstream.
*
* These are FINGERPRINT values, not this package's version: the upstream groups
* traffic by the client build it thinks it is talking to, so they have to track
* the official clients. Every outbound header reads them from here — this file
* is the only place a client version literal may live, so a bump cannot update
* the user agent while leaving another header behind.
*
* Basis, verified against the reference implementation
* (E:\Workspace\zcode\agent2apisum\qoder2api-hub):
* - CLI / inference: `qoder_sign.py` declares `COSY_VERSION` with default
*   `1.1.75` and uses it for BOTH the `cosy-version` header and the signed
*   payload's `cosyVersion`; its `CHANGELOG.md` records this as the value
*   checked against official desktop 0.4.8 / qodercli 1.1.75.
* - Desktop / metadata: `qoder_accounts.py` declares `DESKTOP_CLIENT_VERSION`
*   with default `0.4.8`, used for the desktop request family's `Cosy-Version`
*   (campaign/check-in paths), which is a DIFFERENT client from the CLI above.
*   So metadata and inference versions are deliberately not unified.
*
* @module dsh-qoder-plugin/qoder/transport/wire/version
*/
/** Read an override, treating a blank/whitespace value as "not set". */
function readOverride(name, fallback) {
	const raw = process.env[name]?.trim();
	return raw ? raw : fallback;
}
/**
* Official qodercli version. Overridable through `QODER_IDE_VERSION` so a
* roll-out can follow the real client without a rebuild.
*/
const qoderIdeVersion = readOverride("QODER_IDE_VERSION", "1.1.75");
/**
* User agent for the metadata (openapi) requests.
*
* Derived from {@link qoderIdeVersion} so the agent string and the
* `cosy-version` header can never disagree. The official client sends
* `Qoder/1.1.75` (international) or `QoderWork/1.1.75` (China); this request
* layer does not know the region, so the shared `qoder/` prefix is kept and
* only the build number is centralized here.
*/
const qoderUserAgent = `qoder/${qoderIdeVersion}`;
/**
* Desktop client version for the metadata/check-in request family.
*
* The reference implementation sends this family's `Cosy-Version` as the
* desktop build (`0.4.8`), not as the CLI build above: campaign responses were
* measured to depend on the desktop identity, so the two headers intentionally
* carry different builds. Overridable through `QODER_DESKTOP_VERSION`.
*/
const metadataCosyVersion = readOverride("QODER_DESKTOP_VERSION", "0.4.8");
/**
* `cosy-version` for the campaign/check-in request family — the 1.0.0 wire
* value (see {@link campaignUserAgent}).
*/
const campaignCosyVersion = "1.0.1";
//#endregion
//#region src/qoder/transport/wire/cosy.ts
/**
* COSY authentication headers and signature algorithm for Qoder services.
*
* Implements RSA + AES + MD5 signature generation required by the upstream
* Qoder gateway.
*
* @module dsh-qoder-plugin/qoder/transport/wire/cosy
*/
const qoderRSAPublicKey = `-----BEGIN PUBLIC KEY-----
MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDA8iMH5c02LilrsERw9t6Pv5Nc
4k6Pz1EaDicBMpdpxKduSZu5OANqUq8er4GM95omAGIOPOh+Nx0spthYA2BqGz+l
6HRkPJ7S236FZz73In/KVuLnwI8JJ2CbuJap8kvheCCZpmAWpb/cPx/3Vr/J6I17
XcW+ML9FoCI6AOvOzwIDAQAB
-----END PUBLIC KEY-----`;
const qoderDataPolicy = "disagree";
const qoderLoginVersion = "v2";
const qoderMachineOs = process.platform === "win32" ? process.arch === "arm64" ? "aarch64_windows" : "x86_64_windows" : process.arch === "arm64" ? "aarch64_linux" : "x86_64_linux";
const qoderMachineTypeMagic = "5";
/**
* Environment override for {@link campaignMachineOs}; `auto` means detect.
*
* Exported so tests and the docs name the same string instead of two copies.
*/
const QODER_COSY_MACHINE_OS_ENV = "QODER_COSY_MACHINE_OS";
/**
* `cosy-machineos` for the campaign family: the DESKTOP vocabulary (SPEC-UMID-003 §3 R3).
*
* Deliberately a second constant rather than a reuse of {@link qoderMachineOs}.
* The two headers describe two different clients, not one machine: the
* inference path declares the CLI (`Cosy-Clienttype: 5` and the CLI user agent)
* and spells the platform `windows`, while the campaign path declares the
* desktop app (`cosy-clienttype: 10` + the desktop `cosy-version`) and the
* desktop app spells it `win32` (`x86_64_win32`). Reusing the CLI spelling here would make a
* request that claims to be the desktop client carry the CLI's vocabulary —
* which is exactly the cross-field inconsistency a fingerprint check looks for.
* "The same value on every endpoint" is not the same thing as "a
* self-consistent request", and one machine running both the CLI and the
* desktop app is normal.
*
* Keeping the pair separate is also what makes I-11 checkable: this constant can
* change without moving a single inference header, which is why
* {@link qoderMachineOs} stays module-private and unexported.
*
* `QODER_COSY_MACHINE_OS` replaces the whole value (default `auto` = detect), so
* an operator whose platform we mis-detect can correct the header without a
* rebuild. Resolved once at module load on purpose: this is a device
* fingerprint, and a value that changed mid-process would look like the machine
* moving. The failure mode of a wrong value is silent — the campaign list comes
* back empty with HTTP 200 — so the override is the only way to bisect it.
*/
const campaignMachineOs = (() => {
	const override = process.env[QODER_COSY_MACHINE_OS_ENV]?.trim();
	if (override !== void 0 && override !== "" && override.toLowerCase() !== "auto") return override;
	return `${process.arch === "arm64" ? "aarch64" : "x86_64"}_${process.platform === "win32" ? "win32" : process.platform === "darwin" ? "darwin" : "linux"}`;
})();
function computeSigPath(urlStr) {
	let sigPath = new URL(urlStr).pathname;
	if (sigPath.startsWith("/algo")) sigPath = sigPath.substring(5);
	return sigPath;
}
function rsaEncryptBase64(data) {
	const key = {
		key: qoderRSAPublicKey,
		padding: crypto.constants.RSA_PKCS1_PADDING
	};
	return crypto.publicEncrypt(key, typeof data === "string" ? Buffer.from(data) : data).toString("base64");
}
function aesEncryptCBCBase64(plaintext, keyStr) {
	const cipher = crypto.createCipheriv("aes-128-cbc", Buffer.from(keyStr), Buffer.from(keyStr));
	let encrypted = cipher.update(plaintext, "utf8", "base64");
	encrypted += cipher.final("base64");
	return encrypted;
}
function buildAuthHeaders(body, requestURL, creds, options = {}) {
	if (!creds.userID) throw new Error("cosy: user id is empty");
	if (!creds.authToken) throw new Error("cosy: auth token is empty");
	const aesKey = crypto.randomUUID().replace(/-/g, "").slice(0, 16);
	const userInfo = {
		uid: creds.userID,
		security_oauth_token: creds.authToken,
		name: creds.name || "",
		aid: "",
		email: creds.email || ""
	};
	const infoB64 = aesEncryptCBCBase64(JSON.stringify(userInfo), aesKey);
	const cosyKey = rsaEncryptBase64(aesKey);
	const timestamp = Math.floor(Date.now() / 1e3).toString();
	const cosyPayload = {
		version: "v1",
		requestId: crypto.randomUUID(),
		info: infoB64,
		cosyVersion: qoderIdeVersion,
		ideVersion: ""
	};
	const payloadB64 = Buffer.from(JSON.stringify(cosyPayload)).toString("base64");
	const sigPath = computeSigPath(requestURL);
	const sigInput = `${payloadB64}\n${cosyKey}\n${timestamp}\n${body ? Buffer.isBuffer(body) ? body.toString("utf8") : body : ""}\n${sigPath}`;
	const sig = crypto.createHash("md5").update(sigInput).digest("hex");
	const bodyHash = crypto.createHash("md5").update(body || "").digest("hex");
	const bodyLen = body ? (Buffer.isBuffer(body) ? body.length : Buffer.from(body).length).toString() : "0";
	const machineID = creds.derivedMachineID || creds.machineID || getMachineId();
	return {
		Authorization: `Bearer COSY.${payloadB64}.${sig}`,
		"Cosy-Key": cosyKey,
		"Cosy-User": creds.userID,
		"Cosy-Date": timestamp,
		"Cosy-Version": qoderIdeVersion,
		"Cosy-Machineid": machineID,
		"Cosy-Machinetoken": machineID,
		"Cosy-Machinetype": qoderMachineTypeMagic,
		"Cosy-Machineos": qoderMachineOs,
		...options.includeMachineHostname === true && creds.machineHostname ? { "Cosy-Machinehostname": creds.machineHostname } : {},
		"Cosy-Clienttype": "5",
		"Cosy-Clientip": "127.0.0.1",
		"Cosy-Bodyhash": bodyHash,
		"Cosy-Bodylength": bodyLen,
		"Cosy-Sigpath": sigPath,
		"Cosy-Data-Policy": qoderDataPolicy,
		"Cosy-Organization-Id": "",
		"Cosy-Organization-Tags": "",
		"Login-Version": qoderLoginVersion,
		"X-Request-Id": crypto.randomUUID()
	};
}
const defaultMaxJsonBytes = 2097152;
const defaultMaxErrorBytes = 16384;
const metadataRetryBaseDelayMs = 200;
const maxProviderRetryDelayMs = 1e4;
function opaqueCredentialKey(value) {
	return createHash("sha256").update(value).digest("hex");
}
function retryableMetadataError(error) {
	return error instanceof QoderLlmError && [
		"RATE_LIMIT",
		"SERVER",
		"TIMEOUT",
		"TRANSPORT"
	].includes(error.code);
}
function abortableDelay(ms, signal) {
	if (signal.aborted) return Promise.reject(new DOMException("aborted", "AbortError"));
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			signal.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		const onAbort = () => {
			clearTimeout(timer);
			reject(new DOMException("aborted", "AbortError"));
		};
		signal.addEventListener("abort", onAbort, { once: true });
	});
}
async function retryMetadataRead(signal, operation) {
	try {
		return await operation();
	} catch (error) {
		if (!retryableMetadataError(error) || signal.aborted) throw error;
		const providerDelay = error.failure.providerRetryAfterMs;
		await abortableDelay(providerDelay === void 0 ? metadataRetryBaseDelayMs + Math.floor(Math.random() * 41) : Math.min(providerDelay, maxProviderRetryDelayMs), signal);
		return operation();
	}
}
function withDeadline(signal, timeoutMs) {
	const timeoutSignal = AbortSignal.timeout(timeoutMs);
	return {
		timeoutSignal,
		signal: signal === void 0 ? timeoutSignal : AbortSignal.any([signal, timeoutSignal])
	};
}
async function readLimitedText(response, maxBytes, label) {
	const declaredLength = Number(response.headers.get("content-length"));
	if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
		await response.body?.cancel().catch(() => void 0);
		throw new QoderLlmError(`${label} exceeded its response size limit.`, "MALFORMED_RESPONSE");
	}
	if (!response.body) return "";
	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	let bytes = 0;
	let text = "";
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			bytes += value.byteLength;
			if (bytes > maxBytes) throw new QoderLlmError(`${label} exceeded its response size limit.`, "MALFORMED_RESPONSE");
			text += decoder.decode(value, { stream: true });
		}
		return text + decoder.decode();
	} finally {
		await reader.cancel().catch(() => void 0);
		reader.releaseLock();
	}
}
var SingleFlight = class {
	flights = /* @__PURE__ */ new Map();
	run(key, signal, start, abortedError) {
		if (signal?.aborted) return Promise.reject(abortedError());
		let flight = this.flights.get(key);
		if (flight === void 0 || flight.controller.signal.aborted) {
			const controller = new AbortController();
			const created = {};
			created.controller = controller;
			created.settled = false;
			created.waiters = 0;
			created.promise = start(controller.signal).finally(() => {
				created.settled = true;
				if (this.flights.get(key) === created) this.flights.delete(key);
			});
			flight = created;
			this.flights.set(key, created);
		}
		flight.waiters++;
		return new Promise((resolve, reject) => {
			let finished = false;
			const finish = (callback) => {
				if (finished) return;
				finished = true;
				signal?.removeEventListener("abort", onAbort);
				flight.waiters--;
				if (flight.waiters === 0 && !flight.settled) {
					if (this.flights.get(key) === flight) this.flights.delete(key);
					flight.controller.abort("all callers aborted");
				}
				callback();
			};
			const onAbort = () => finish(() => reject(abortedError()));
			signal?.addEventListener("abort", onAbort, { once: true });
			flight.promise.then((value) => finish(() => resolve(value)), (error) => finish(() => reject(error)));
		});
	}
};
async function openApiJsonRequest(fetchImpl, options) {
	const method = options.method ?? (options.body !== void 0 ? "POST" : "GET");
	const timeoutMs = options.timeoutMs ?? 15e3;
	const timeoutSignal = AbortSignal.timeout(timeoutMs);
	const requestSignal = options.signal === void 0 ? timeoutSignal : AbortSignal.any([options.signal, timeoutSignal]);
	const startedAt = performance.now();
	options.logger?.debug?.(`[Qoder ${options.operation}] Requesting`, {
		url: options.url,
		method
	});
	try {
		const campaign = options.fingerprint === "campaign";
		const headers = {
			accept: "application/json",
			"user-agent": options.userAgent ?? (campaign ? "qoder/1.1.47" : qoderUserAgent),
			"cosy-version": campaign ? campaignCosyVersion : metadataCosyVersion,
			"cosy-clienttype": "5",
			...options.headers
		};
		if (options.token) headers.authorization = `Bearer ${options.token}`;
		if (options.machineId) {
			headers["Cosy-MachineToken"] = options.machineId;
			headers["Cosy-MachineType"] = "host";
		}
		let bodyText;
		if (options.body !== void 0) {
			headers["content-type"] = "application/json";
			bodyText = typeof options.body === "string" ? options.body : JSON.stringify(options.body);
		}
		const response = await fetchImpl(options.url, {
			method,
			headers,
			...bodyText === void 0 ? {} : { body: bodyText },
			signal: requestSignal
		});
		options.logger?.debug?.(`[Qoder ${options.operation}] Request completed`, {
			status: response.status,
			statusText: response.statusText,
			durationMs: Math.round(performance.now() - startedAt),
			...qoderRequestId(response.headers) === void 0 ? {} : { requestId: qoderRequestId(response.headers) }
		});
		const text = await readLimitedText(response, response.ok ? defaultMaxJsonBytes : defaultMaxErrorBytes, `Qoder ${options.operation} response`);
		if (!response.ok) {
			options.logger?.error?.(`[Qoder ${options.operation}] Request failed`, redactLogPayload(text));
			throw qoderHttpError(`Failed to execute Qoder ${options.operation} with status ${response.status}.`, response, text);
		}
		let data;
		try {
			data = JSON.parse(text);
		} catch {
			options.logger?.error?.(`[Qoder ${options.operation}] Invalid JSON response`, redactLogPayload(text));
			throw new QoderLlmError(`Failed to parse Qoder ${options.operation} JSON response`, "MALFORMED_RESPONSE");
		}
		if (options.logCategory) logParsedResponse(options.logger, options.logCategory, data);
		return data;
	} catch (error) {
		if (error instanceof QoderLlmError) throw error;
		if (options.signal?.aborted) throw new QoderLlmError(`Qoder ${options.operation} request was aborted.`, "ABORTED");
		if (timeoutSignal.aborted) throw new QoderLlmError(`Qoder ${options.operation} request timed out.`, "TIMEOUT");
		throw new QoderLlmError(`Qoder ${options.operation} network request failed.`, "TRANSPORT", { cause: error });
	}
}
//#endregion
//#region src/qoder/transport/auth.ts
const expiryBufferMs = 3e5;
const defaultExpiryMs = 864e5;
const defaultAuthTimeoutMs = 15e3;
function abortedError() {
	return new QoderLlmError("Qoder authentication was aborted.", "ABORTED");
}
async function waitForFlight(promise, signal) {
	if (signal === void 0) return promise;
	if (signal.aborted) throw abortedError();
	return new Promise((resolve, reject) => {
		const onAbort = () => reject(abortedError());
		signal.addEventListener("abort", onAbort, { once: true });
		promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
	});
}
var QoderAuthService = class {
	cache = /* @__PURE__ */ new Map();
	inFlight = /* @__PURE__ */ new Map();
	/**
	* Self-heal exchanges in flight, keyed like the cache. Deliberately separate
	* from {@link inFlight}: that flight may be aborted by a departing
	* concurrent waiter (a quota poll, a catalog sweep) whose abort has nothing
	* to do with the heal, so healers must not share its controller. Concurrent
	* heals instead share this flight — see {@link exchangeFresh}.
	*/
	healFlights = /* @__PURE__ */ new Map();
	fetchImpl;
	timeoutMs;
	resolveMachineId;
	resolveDeviceSeed;
	region;
	logger;
	constructor(options = {}) {
		this.fetchImpl = options.fetch ?? globalThis.fetch;
		this.timeoutMs = options.timeoutMs ?? defaultAuthTimeoutMs;
		this.resolveMachineId = options.resolveMachineId ?? getMachineId;
		this.resolveDeviceSeed = options.resolveDeviceSeed ?? (() => void 0);
		this.region = options.region ?? "global";
		this.logger = options.logger;
	}
	clear(pat) {
		if (pat) this.cache.delete(`${this.region}:${opaqueCredentialKey(pat)}`);
		else this.cache.clear();
	}
	/**
	* Exchange a fresh job token OUTSIDE the single-flight, for the self-heal
	* retry. The shared flight can be aborted by a departing concurrent waiter
	* (the quota poll, the catalog sweep), and a retry that joins it would then
	* be cancelled by a path that has nothing to do with the chat. The result
	* replaces the cache entry.
	*
	* Two heals for the same credential that overlap share one exchange instead
	* of racing: each racer's `clear` deleted what the previous one had just
	* cached, and its own `cache.set` overwrote the other's — so the cache could
	* end up naming a token the losing request was no longer using, and with an
	* upstream that retires the previous job token on a new exchange the racers
	* also invalidated each other's credentials (one chat recovering while a
	* concurrent one failed, exactly the 2026-09-26 22:36 observation). The
	* shared exchange runs on its own timeout signal, so one healer's abort —
	* its chat request went away — cannot cancel an exchange other healers, and
	* the future `getCredentials` callers about to read the refreshed cache, are
	* waiting on.
	*/
	async exchangeFresh(pat, signal) {
		const cacheKey = `${this.region}:${opaqueCredentialKey(pat)}`;
		const existing = this.healFlights.get(cacheKey);
		if (existing !== void 0 && !existing.settled) return waitForFlight(existing.promise, signal);
		this.clear(pat);
		const created = { settled: false };
		created.promise = this.exchangeAndResolve(pat, AbortSignal.timeout(this.timeoutMs)).finally(() => {
			created.settled = true;
			if (this.healFlights.get(cacheKey) === created) this.healFlights.delete(cacheKey);
		});
		this.healFlights.set(cacheKey, created);
		return waitForFlight(created.promise, signal);
	}
	async getCredentials(pat, signal) {
		if (!pat || typeof pat !== "string") throw new QoderLlmError("Qoder Personal Access Token is missing or invalid. Configure Qoder in the Qoder settings page.", "MISSING_CREDENTIAL");
		if (signal?.aborted) throw abortedError();
		const cacheKey = `${this.region}:${opaqueCredentialKey(pat)}`;
		const cached = this.cache.get(cacheKey);
		if (cached && cached.expiresAt > Date.now() + expiryBufferMs) return cached.creds;
		let entry = this.inFlight.get(cacheKey);
		if (entry === void 0 || entry.controller.signal.aborted) {
			const controller = new AbortController();
			const created = {};
			created.controller = controller;
			created.waiters = 0;
			created.settled = false;
			created.timeout = setTimeout(() => controller.abort("authentication timeout"), this.timeoutMs);
			created.promise = this.exchangeAndResolve(pat, controller.signal).finally(() => {
				created.settled = true;
				clearTimeout(created.timeout);
				if (this.inFlight.get(cacheKey) === created) this.inFlight.delete(cacheKey);
			});
			entry = created;
			this.inFlight.set(cacheKey, entry);
		}
		entry.waiters++;
		try {
			return await waitForFlight(entry.promise, signal);
		} finally {
			entry.waiters--;
			if (entry.waiters === 0 && !entry.settled) {
				if (this.inFlight.get(cacheKey) === entry) this.inFlight.delete(cacheKey);
				entry.controller.abort("all callers aborted");
			}
		}
	}
	async exchangeAndResolve(pat, signal) {
		let jobToken;
		let expiresAt = Date.now() + defaultExpiryMs;
		const data = await openApiJsonRequest(this.fetchImpl, {
			url: getQoderExchangeUrl(this.region),
			body: { personal_token: pat },
			signal,
			timeoutMs: this.timeoutMs,
			logger: this.logger,
			operation: "Auth",
			logCategory: "auth.exchange"
		});
		if (!data.token) throw new QoderLlmError("Qoder PAT exchange returned no job token.", "AUTH");
		jobToken = data.token;
		if (data.expires_at) {
			const parsed = Date.parse(data.expires_at);
			if (!Number.isNaN(parsed)) expiresAt = parsed;
		} else if (typeof data.expires_in === "number" && data.expires_in > 0) expiresAt = Date.now() + data.expires_in;
		const userInfo = await retryMetadataRead(signal, () => this.fetchUserInfo(jobToken, signal));
		const deviceSeed = this.resolveDeviceSeed();
		const creds = {
			userID: userInfo.userID,
			authToken: jobToken,
			name: userInfo.name || "Qoder User",
			email: userInfo.email,
			machineID: this.resolveMachineId(),
			...userInfo.userID ? {
				derivedMachineID: deriveMachineId(userInfo.userID, machineIdSalt, deviceSeed),
				machineHostname: deriveMachineHostname(userInfo.userID, deviceSeed)
			} : {}
		};
		const cacheKey = `${this.region}:${opaqueCredentialKey(pat)}`;
		this.cache.set(cacheKey, {
			creds,
			expiresAt
		});
		return creds;
	}
	async fetchUserInfo(jobToken, signal) {
		const info = await openApiJsonRequest(this.fetchImpl, {
			url: getQoderUserInfoUrl(this.region),
			token: jobToken,
			signal,
			timeoutMs: this.timeoutMs,
			logger: this.logger,
			operation: "UserInfo",
			logCategory: "auth.user-info"
		});
		if (!info.id) throw new QoderLlmError("Qoder identity lookup returned no user id.", "AUTH");
		return {
			userID: info.id,
			email: info.email ?? "",
			name: info.name ?? info.username ?? ""
		};
	}
};
/**
* Per-account health tracker, shared by the whole pool.
*
* Keyed by account id, which is globally unique (a hash of the PAT), so one
* instance can serve both variants without confusing two accounts. Sharing it
* is what makes a cross-region switch observable: the failure is reported by
* the runtime whose walk ran, but the label is read from the document that now
* owns the row.
*
* Deliberately takes explicit timestamps instead of reading the clock: the
* hour-long rule is untestable otherwise, and the caller (the transport's
* failover and queue hooks) already knows the moment the answer arrived.
*/
var QoderAccountHealthTracker = class {
	observations = /* @__PURE__ */ new Map();
	/**
	* Record one upstream "model not serviceable" (queued) answer.
	*
	* The answer describes the MODEL's queue at that instant, not the account's
	* health, so it only keeps the account labelled `queued` for
	* {@link queuedHealthTtlMs}. It never promotes the account to `limited`: a
	* queue is the upstream pacing a saturated model, and a plugin that turned
	* that into "this account is throttled" would keep accusing it long after the
	* queue drained.
	*/
	noteQueue(accountId, atMs) {
		const observation = this.observations.get(accountId) ?? this.fresh();
		observation.lastQueueAtMs = atMs;
		this.observations.set(accountId, observation);
	}
	/**
	* Record one accepted request: the account demonstrably works.
	*
	* This is the only observation that clears `limited`, because it is the only
	* one that proves the condition it described is over. Clearing on a mere
	* absence of failures would silently forgive an account that simply has not
	* been asked anything since.
	*/
	noteConnected(accountId, atMs) {
		const observation = this.observations.get(accountId);
		if (observation === void 0) {
			this.observations.set(accountId, {
				...this.fresh(),
				lastConnectedAtMs: atMs
			});
			return;
		}
		observation.failureStreak = 0;
		observation.lastQueueAtMs = void 0;
		observation.limited = false;
		observation.lastConnectedAtMs = atMs;
		this.observations.set(accountId, observation);
	}
	/**
	* Record one failure to reach the upstream at all (transport error, timeout,
	* dropped stream) — not a refused request.
	*
	* The distinction matters: a 400 means the upstream answered and judged the
	* request, which says nothing bad about the account, while a connection that
	* never produced an answer may well be the network rather than the
	* subscription. Only the latter accumulates toward `limited`.
	*/
	noteFailure(accountId, atMs) {
		const observation = this.observations.get(accountId) ?? this.fresh();
		observation.failureStreak += 1;
		if (observation.failureStreak >= 3) observation.limited = true;
		this.observations.set(accountId, observation);
	}
	/**
	* What this account has shown at `nowMs`, or `undefined` when it has shown
	* nothing (or only an observation too old to still describe it).
	*/
	healthOf(accountId, nowMs) {
		const observation = this.observations.get(accountId);
		if (observation === void 0) return void 0;
		if (observation.limited) return "limited";
		if (observation.lastQueueAtMs !== void 0 && nowMs - observation.lastQueueAtMs <= 3e5) return "queued";
		if (observation.lastConnectedAtMs !== void 0) return "normal";
	}
	/** Forget one account (it was removed) so a re-saved token starts clean. */
	forget(accountId) {
		this.observations.delete(accountId);
	}
	/** Forget everything for this variant. */
	clear() {
		this.observations.clear();
	}
	fresh() {
		return {
			failureStreak: 0,
			limited: false
		};
	}
};
/** Soft rate-limit cooldown for the first offence: ten minutes. */
const rateLimitBaseCooldownMs = 6e5;
/** Ceiling for soft rate-limit cooldowns: two hours. */
const rateLimitMaxCooldownMs = 72e5;
/** Consecutive hard failures before the circuit breaker trips. */
const breakerThreshold = 3;
/** Circuit-breaker cooldown for the first trip: thirty minutes. */
const breakerBaseCooldownMs = 18e5;
/** Ceiling for circuit-breaker cooldowns: six hours. */
const breakerMaxCooldownMs = 216e5;
/** Unknown failures before the account is merely deprioritised. */
const downweightThreshold = 5;
/** First downweight window: ten minutes. */
const downweightBaseCooldownMs = 6e5;
/** Ceiling for downweight windows: two hours. */
const downweightMaxCooldownMs = 72e5;
/**
* In-process penalty ledger: what repeated failures have cost each account.
*
* Nothing here is persisted, and that is intentional rather than an omission. A
* cooldown is a claim about how the upstream is treating an account RIGHT NOW;
* carrying it across a restart would punish an account for an outage the new
* process never observed, and the restart itself is often the user's response
* to that outage (their first fix attempt would appear to do nothing). A fresh
* process starts with a clean, if uninformed, ledger.
*
* Escalation is per account, not per kind: one account-level `level` ladder
* makes any repeated misbehaviour — throttling, hard failures, unknown faults —
* cost more each time, which is the property "this account keeps causing
* trouble" that the ledger is trying to express. The first rung of each kind is
* what differs (ten minutes for a soft throttle, thirty for a tripped breaker).
*
* The ledger is deliberately silent about WHO gets punished and WHEN: the
* transport holds the failures in a pending-blame list for the duration of one
* request walk and only calls {@link noteFailure} once a different account has
* demonstrably served the request. A whole-pool failure therefore punishes
* nobody, which is the single most important rule here — the upstream going
* down must not burn every account in the pool.
*/
var QoderAccountPenaltyLedger = class {
	accounts = /* @__PURE__ */ new Map();
	/**
	* The clock, injected so tests can age a cooldown out.
	*
	* Declared as an explicit field instead of a constructor parameter property:
	* the repository's `node --test` path runs Node's strip-only type erasure,
	* which rejects parameter properties (they emit runtime assignments, not just
	* type syntax).
	*/
	now;
	constructor(now = Date.now) {
		this.now = now;
	}
	/** Whether the account is inside a penalty window and should be skipped. */
	isCooling(accountId) {
		const cooldownUntilMs = this.accounts.get(accountId)?.cooldownUntilMs;
		return cooldownUntilMs !== void 0 && cooldownUntilMs > this.now();
	}
	/**
	* Whether the account should be tried only after the other candidates.
	*
	* Downweighting never blocks the account: five unknown failures make it a
	* worse guess than its siblings, not an unusable one, and the pool may have
	* nothing else.
	*/
	isDeprioritized(accountId) {
		const downweightUntilMs = this.accounts.get(accountId)?.downweightUntilMs;
		return downweightUntilMs !== void 0 && downweightUntilMs > this.now();
	}
	/**
	* Land one failure's blame on the account it belongs to.
	*
	* Called only after another account has succeeded (the transport defers it),
	* so this method is free to count the failure as evidence against the
	* account. A success resets every counter here — see {@link noteSuccess}.
	*/
	noteFailure(accountId, kind) {
		const account = this.accounts.get(accountId) ?? {
			cooldownUntilMs: void 0,
			downweightUntilMs: void 0,
			level: 0,
			consecutiveHardFailures: 0,
			unknownFailures: 0
		};
		const at = this.now();
		if (kind === "rate-limit") {
			account.cooldownUntilMs = at + this.escalated(account.level, rateLimitBaseCooldownMs, rateLimitMaxCooldownMs);
			account.level += 1;
		} else if (kind === "hard") {
			account.consecutiveHardFailures += 1;
			if (account.consecutiveHardFailures >= breakerThreshold) {
				account.cooldownUntilMs = at + this.escalated(account.level, breakerBaseCooldownMs, breakerMaxCooldownMs);
				account.level += 1;
				account.consecutiveHardFailures = 0;
			}
		} else {
			account.unknownFailures += 1;
			if (account.unknownFailures >= downweightThreshold) {
				account.downweightUntilMs = at + this.escalated(account.level, downweightBaseCooldownMs, downweightMaxCooldownMs);
				account.level += 1;
				account.unknownFailures = 0;
			}
		}
		this.accounts.set(accountId, account);
	}
	/**
	* The account served a request to the end: clear everything held against it.
	*
	* One completed request is proof that the conditions the ledger described are
	* over, and a partially forgiven penalty would keep punishing an account that
	* is demonstrably serving — the exact self-harm this ledger exists to avoid.
	*/
	noteSuccess(accountId) {
		this.accounts.delete(accountId);
	}
	/** Forget one account (it was removed), so a re-saved token starts clean. */
	forget(accountId) {
		this.accounts.delete(accountId);
	}
	/** Forget every account (settings reset, or a test fixture). */
	clear() {
		this.accounts.clear();
	}
	/** Read-only view of one account's penalty state, for tests and diagnostics. */
	snapshot(accountId) {
		const account = this.accounts.get(accountId);
		return account === void 0 ? void 0 : { ...account };
	}
	/** Duration for the `level`-th escalation of one penalty kind. */
	escalated(level, baseMs, maxMs) {
		return Math.min(baseMs * 2 ** level, maxMs);
	}
};
function defaultSleep(ms, signal) {
	return new Promise((resolve) => {
		if (signal.aborted) {
			resolve();
			return;
		}
		const timer = setTimeout(resolve, ms);
		signal.addEventListener("abort", () => {
			clearTimeout(timer);
			resolve();
		}, { once: true });
	});
}
/**
* A keyed mutex with a minimum spacing between grants.
*
* Concurrency and spacing solve two different halves of the same problem: the
* mutex guarantees a single in-flight attempt per account, while the spacing
* guarantees that even back-to-back requests (where the previous one finished
* quickly) still start no closer than {@link accountMinStartGapMs}. Measuring
* from the previous START rather than the previous END is what makes the gap a
* property of the account's traffic rather than of how long a chat happened to
* take.
*/
var QoderAccountTrafficLimiter = class {
	accounts = /* @__PURE__ */ new Map();
	minStartGapMs;
	jitterMs;
	acquireTimeoutMs;
	now;
	random;
	sleep;
	onFailOpen;
	constructor(options = {}) {
		this.minStartGapMs = Math.max(0, options.minStartGapMs ?? 400);
		this.jitterMs = Math.max(0, options.jitterMs ?? 100);
		this.acquireTimeoutMs = Math.max(0, options.acquireTimeoutMs ?? 3e4);
		this.now = options.now ?? Date.now;
		this.random = options.random ?? Math.random;
		this.sleep = options.sleep ?? defaultSleep;
		this.onFailOpen = options.onFailOpen;
	}
	/**
	* Wait for this account's turn, then mark the attempt as started.
	*
	* Never rejects and never waits past the acquire timeout: a request that
	* cannot get its turn is let through with a warning instead (see the module
	* comment). Callers must release the returned lease in a `finally`.
	*/
	async acquire(accountId) {
		const gate = this.gateFor(accountId);
		const startedWaitingAtMs = this.now();
		const deadlineMs = startedWaitingAtMs + this.acquireTimeoutMs;
		if (gate.held) {
			const turn = this.waitForTurn(gate);
			if (!await this.waitAtMost(turn, deadlineMs - this.now())) {
				turn.then(() => this.handOver(gate));
				this.reportFailOpen(accountId, startedWaitingAtMs);
				return { release() {} };
			}
		} else gate.held = true;
		const pauseMs = this.minStartGapMs + Math.floor(clampRandom(this.random()) * this.jitterMs) - (gate.lastStartMs === void 0 ? Number.POSITIVE_INFINITY : this.now() - gate.lastStartMs);
		if (pauseMs > 0) {
			if (pauseMs >= deadlineMs - this.now()) {
				this.handOver(gate);
				this.reportFailOpen(accountId, startedWaitingAtMs);
				return { release() {} };
			}
			await this.sleep(pauseMs, new AbortController().signal);
		}
		gate.lastStartMs = this.now();
		let released = false;
		return { release: () => {
			if (released) return;
			released = true;
			this.handOver(gate);
		} };
	}
	/**
	* Whether this account already has an attempt in flight or requests queued
	* for it.
	*
	* The transport uses this as its only dispatch gate (T7): "busy" means the
	* guard is pacing this identity right now, so a free account is preferred for
	* a new request, and a busy account is only used as the last resort — where
	* the request queues behind this gate instead of failing.
	*/
	isBusy(accountId) {
		const gate = this.accounts.get(accountId);
		return gate !== void 0 && (gate.held || gate.waiters.length > 0);
	}
	gateFor(accountId) {
		const existing = this.accounts.get(accountId);
		if (existing !== void 0) return existing;
		const gate = {
			waiters: [],
			held: false,
			lastStartMs: void 0
		};
		this.accounts.set(accountId, gate);
		return gate;
	}
	waitForTurn(gate) {
		return new Promise((resolve) => {
			gate.waiters.push(resolve);
		});
	}
	/**
	* Release the slot, handing it to the next waiter if there is one.
	*
	* Handing over directly (instead of clearing `held` and letting a waiter
	* re-check) keeps the FIFO order and removes a wake-up race between two
	* requests that were both waiting.
	*/
	handOver(gate) {
		const next = gate.waiters.shift();
		if (next === void 0) {
			gate.held = false;
			return;
		}
		gate.held = true;
		next();
	}
	/** Resolve `true` when `work` finishes inside `timeoutMs`, `false` when not. */
	async waitAtMost(work, timeoutMs) {
		if (timeoutMs <= 0) return false;
		const controller = new AbortController();
		const granted = work.then(() => true);
		const expired = this.sleep(timeoutMs, controller.signal).then(() => false);
		const won = await Promise.race([granted, expired]);
		controller.abort();
		return won;
	}
	reportFailOpen(accountId, startedWaitingAtMs) {
		this.onFailOpen?.({
			accountId,
			waitedMs: this.now() - startedWaitingAtMs
		});
	}
};
/** Keep a jitter multiplier inside `[0, 1)`; an injected `random` may stray. */
function clampRandom(value) {
	if (!Number.isFinite(value)) return 0;
	return Math.max(0, Math.min(.999, value));
}
//#endregion
//#region src/qoder/catalog.ts
const reasoningEffortOrder = /* @__PURE__ */ new Map([
	["low", 0],
	["medium", 1],
	["high", 2],
	["xhigh", 3],
	["max", 4]
]);
function positiveNumber(value) {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : void 0;
}
function contextOptionsOf(value) {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return void 0;
	const options = {};
	for (const [key, raw] of Object.entries(value)) {
		if (typeof raw !== "object" || raw === null || Array.isArray(raw)) continue;
		const entry = raw;
		const tokenCount = positiveNumber(entry.token_count);
		const isDefault = typeof entry.is_default === "boolean" ? entry.is_default : void 0;
		if (tokenCount === void 0) continue;
		options[key] = {
			...tokenCount === void 0 ? {} : { tokenCount },
			...isDefault === void 0 ? {} : { isDefault }
		};
	}
	if (Object.keys(options).length === 0) return void 0;
	return options;
}
function reasoningEffortsOf(value) {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
	const enabled = value.enabled;
	if (typeof enabled !== "object" || enabled === null || Array.isArray(enabled)) return {};
	const rawEfforts = enabled.efforts;
	if (typeof rawEfforts !== "object" || rawEfforts === null || Array.isArray(rawEfforts)) return {};
	const efforts = [];
	let defaultEffort;
	for (const [id, raw] of Object.entries(rawEfforts)) {
		if (!id.trim() || typeof raw !== "object" || raw === null || Array.isArray(raw)) continue;
		const entry = raw;
		efforts.push({
			id,
			name: id,
			...typeof entry.description === "string" && entry.description.trim() ? { description: entry.description.trim() } : {}
		});
		if (entry.is_default === true) defaultEffort = id;
	}
	return {
		...efforts.length === 0 ? {} : { efforts: efforts.sort((left, right) => (reasoningEffortOrder.get(left.id) ?? Number.MAX_SAFE_INTEGER) - (reasoningEffortOrder.get(right.id) ?? Number.MAX_SAFE_INTEGER)) },
		...defaultEffort === void 0 ? {} : { defaultEffort }
	};
}
function thinkingDefault(value, fallback, onConflict) {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return fallback;
	const config = value;
	const isDefault = (entry) => typeof entry === "object" && entry !== null && !Array.isArray(entry) && entry.is_default === true;
	const enabled = isDefault(config.enabled);
	const disabled = isDefault(config.disabled);
	if (enabled && disabled) onConflict?.("thinking-defaults");
	return enabled === disabled ? fallback : enabled;
}
function normalizeQoderModels(payload, onConflict) {
	if (typeof payload !== "object" || payload === null || !Array.isArray(payload.assistant)) return [];
	const models = [];
	const seen = /* @__PURE__ */ new Set();
	for (const raw of payload.assistant) {
		if (typeof raw !== "object" || raw === null || raw.enable !== true) continue;
		const id = typeof raw.key === "string" ? raw.key.trim() : "";
		if (!id || seen.has(id)) continue;
		seen.add(id);
		const contextOptions = contextOptionsOf(raw.context_config);
		const defaultOptions = Object.values(contextOptions ?? {}).filter((option) => option.isDefault && option.tokenCount !== void 0);
		if (defaultOptions.length > 1) onConflict?.("context-defaults");
		const contextWindow = (defaultOptions.length === 1 ? defaultOptions[0]?.tokenCount : void 0) ?? positiveNumber(raw.max_input_tokens) ?? 18e4;
		const maxContextWindow = Math.max(positiveNumber(raw.max_input_tokens) ?? 0, contextWindow, ...Object.values(contextOptions ?? {}).map((option) => option.tokenCount ?? 0));
		const isReasoning = thinkingDefault(raw.thinking_config, raw.is_reasoning === true, onConflict);
		const priceFactor = typeof raw.price_factor === "number" && Number.isFinite(raw.price_factor) && raw.price_factor >= 0 ? raw.price_factor : void 0;
		const reasoning = reasoningEffortsOf(raw.thinking_config);
		models.push({
			id,
			name: typeof raw.display_name === "string" && raw.display_name.trim() ? raw.display_name.trim() : id,
			contextWindow,
			maxContextWindow,
			maxTokens: positiveNumber(raw.max_output_tokens) ?? 32768,
			source: typeof raw.source === "string" && raw.source.trim() ? raw.source.trim() : "system",
			isReasoning,
			supportsEffort: reasoning.efforts !== void 0,
			supportsImages: raw.is_vl === true,
			...reasoning.efforts === void 0 ? {} : { reasoningEfforts: reasoning.efforts },
			...reasoning.defaultEffort === void 0 ? {} : { defaultReasoningEffort: reasoning.defaultEffort },
			...priceFactor === void 0 ? {} : { priceFactor },
			...contextOptions === void 0 ? {} : { contextOptions }
		});
	}
	return models;
}
//#endregion
//#region src/qoder/transport/catalog-reader.ts
async function fetchQoderModels(credentials, options = {}) {
	const url = getQoderModelListUrl(options.region);
	const fetchImpl = options.fetch ?? globalThis.fetch;
	const startedAt = performance.now();
	const deadline = withDeadline(options.signal, options.timeoutMs ?? 15e3);
	options.logger?.debug?.("[Qoder Models] Requesting model catalog", { url });
	try {
		const response = await fetchImpl(url, {
			method: "GET",
			headers: {
				accept: "application/json",
				...buildAuthHeaders(null, url, credentials)
			},
			signal: deadline.signal
		});
		options.logger?.debug?.("[Qoder Models] Catalog request completed", {
			url,
			status: response.status,
			durationMs: Math.round(performance.now() - startedAt),
			...qoderRequestId(response.headers) === void 0 ? {} : { requestId: qoderRequestId(response.headers) }
		});
		const text = await readLimitedText(response, response.ok ? defaultMaxJsonBytes : defaultMaxErrorBytes, "Qoder model discovery response");
		if (!response.ok) {
			options.logger?.error?.("[Qoder Models] Catalog request failed", redactLogPayload(text));
			throw qoderHttpError(`Qoder model discovery failed with HTTP status ${response.status}.`, response);
		}
		let payload;
		try {
			payload = JSON.parse(text);
		} catch {
			throw new QoderLlmError("Qoder model discovery returned invalid JSON.", "MALFORMED_RESPONSE");
		}
		const models = normalizeQoderModels(payload, (conflict) => {
			options.logger?.warn?.("[Qoder Models] Conflicting catalog defaults; using fallback", { conflict });
		});
		if (models.length === 0) throw new QoderLlmError("Qoder model discovery returned no enabled models.", "EMPTY_RESPONSE");
		return models;
	} catch (error) {
		if (error instanceof QoderLlmError) throw error;
		if (options.signal?.aborted) throw new QoderLlmError("Qoder model discovery was aborted.", "ABORTED");
		if (deadline.timeoutSignal.aborted) throw new QoderLlmError("Qoder model discovery timed out.", "TIMEOUT");
		options.logger?.error?.("[Qoder Models] Catalog network request failed", redactLogValue(error));
		throw new QoderLlmError("Qoder model discovery network request failed.", "TRANSPORT", { cause: error });
	}
}
//#endregion
//#region src/qoder/transport/wire/translate.ts
function unsupported(message) {
	return new QoderLlmError(message, "UNSUPPORTED_CONTENT");
}
/**
* Join the text blocks of one tool-role message.
*
* In DSH 0.1.7 a tool result is a first-class `role: 'tool'` message that
* answers one call by id, so the blocks live on the message itself rather
* than nested inside a `tool-result` content block.
*/
function toolResultText(message) {
	let text = "";
	for (const nested of message.content) {
		if (nested.type === "image") continue;
		if (nested.type !== "text") throw unsupported(`Qoder tool results support text only; received nested ${String(nested.type)} content.`);
		text += nested.text;
	}
	return text;
}
/**
* Check message shapes without performing any provider I/O.
*
* Callers run this before resolving credentials so an invalid request never
* consumes a Qoder subscription.
*/
function validateMessageShapes(messages) {
	for (const message of messages) {
		if (message.role === "tool") {
			toolResultText(message);
			continue;
		}
		if (message.role === "developer") throw unsupported("Qoder transport does not support developer-role messages.");
		for (const block of message.content) {
			if (block.type === "text") continue;
			if (block.type === "image") {
				if (message.role !== "user") throw unsupported("Qoder image content is valid only in user messages.");
				continue;
			}
			if (block.type === "tool-call") {
				if (message.role !== "assistant") throw unsupported("Qoder tool calls are valid only in assistant messages.");
				continue;
			}
			if (block.type === "reasoning") continue;
			throw unsupported(`Qoder transport encountered unsupported block type: ${String(block.type)}`);
		}
	}
}
/** Reject a batch that exceeds the deployment image policy before any upload work starts. */
function enforceImageLimits(images, attachments) {
	const limits = attachments.imageLimits;
	if (images.length > limits.maxImagesPerMessage) throw unsupported(`Qoder accepts at most ${limits.maxImagesPerMessage} images per message; received ${images.length}.`);
	let total = 0;
	for (const image of images) total += image.attachment.bytes;
	if (total > limits.maxMessageImageBytes) throw unsupported("Qoder message image content exceeds the configured total byte limit.");
}
async function resolveImagePart(block, context) {
	const { attachments, uploader, credentials, signal } = context;
	if (attachments === void 0) throw new QoderLlmError("Qoder image input requires the DSH attachment service.", "ATTACHMENT");
	let image;
	try {
		const limits = attachments.imageLimits;
		image = await attachments.readImageRequest(block.attachment, {
			...requestImageDimensions(block.attachment.width, block.attachment.height, limits.maxImagePixels),
			maxBytes: limits.maxImageBytes
		}, signal);
	} catch (error) {
		if (signal?.aborted) throw new QoderLlmError("Qoder image preparation was aborted.", "ABORTED", { cause: error });
		if (error instanceof QoderLlmError) throw error;
		throw new QoderLlmError("Qoder could not prepare an image attachment.", "ATTACHMENT", { cause: error });
	}
	if (uploader !== void 0 && credentials !== void 0) return {
		type: "image_url",
		image_url: { url: await uploader.resolveImageUrl(image, credentials, signal) }
	};
	return {
		type: "image_url",
		image_url: { url: `data:${image.mediaType};base64,${Buffer.from(image.data).toString("base64")}` }
	};
}
function translateTools(tools) {
	return (tools ?? []).map((tool) => ({
		type: "function",
		function: {
			name: tool.name,
			description: tool.description,
			parameters: tool.parameters
		}
	}));
}
async function validateAndTranslateMessages(messages, systemPrompt, attachments, signal, pipeline) {
	validateMessageShapes(messages);
	const context = {
		attachments,
		signal,
		uploader: pipeline?.uploader,
		credentials: pipeline?.credentials
	};
	const preserveThinking = pipeline?.preserveThinking ?? true;
	const output = [];
	if (typeof systemPrompt === "string" && systemPrompt.trim().length > 0) output.push({
		role: "system",
		content: systemPrompt
	});
	for (const message of messages) {
		if (message.role === "tool") {
			output.push({
				role: "tool",
				tool_call_id: String(message.toolCallId),
				content: toolResultText(message)
			});
			const images = message.content.filter((block) => block.type === "image");
			if (images.length > 0) {
				if (attachments !== void 0) enforceImageLimits(images, attachments);
				output.push({
					role: "user",
					content: [{
						type: "text",
						text: `[${images.length} image${images.length === 1 ? "" : "s"} returned by the previous tool call]`
					}, ...await Promise.all(images.map((image) => resolveImagePart(image, context)))]
				});
			}
			continue;
		}
		if (message.role === "developer") throw unsupported("Qoder transport does not support developer-role messages.");
		let text = "";
		let reasoningText = "";
		const userContent = [];
		const pendingImages = [];
		let hasImage = false;
		const toolCalls = [];
		for (const block of message.content) {
			if (block.type === "text") {
				text += block.text;
				if (message.role === "user") userContent.push({
					type: "text",
					text: block.text
				});
				continue;
			}
			if (block.type === "image") {
				hasImage = true;
				pendingImages.push({
					slot: userContent.length,
					block
				});
				userContent.push(void 0);
				continue;
			}
			if (block.type === "tool-call") {
				toolCalls.push({
					id: String(block.id),
					type: "function",
					function: {
						name: block.name,
						arguments: block.arguments
					}
				});
				continue;
			}
			if (block.type === "reasoning") {
				if (message.role === "assistant") reasoningText += block.text;
				continue;
			}
		}
		if (message.role === "assistant") {
			const hasReasoning = preserveThinking && reasoningText.length > 0;
			if (!text && toolCalls.length === 0 && !hasReasoning) continue;
			output.push({
				role: "assistant",
				content: text || " ",
				...toolCalls.length === 0 ? {} : { tool_calls: toolCalls },
				...hasReasoning ? { reasoning_content: reasoningText } : {}
			});
			continue;
		}
		if (pendingImages.length > 0) {
			if (attachments !== void 0) enforceImageLimits(pendingImages.map((pending) => pending.block), attachments);
			await Promise.all(pendingImages.map(async (pending) => {
				userContent[pending.slot] = await resolveImagePart(pending.block, context);
			}));
		}
		output.push({
			role: message.role,
			content: hasImage ? userContent.filter((part) => part !== void 0) : text
		});
	}
	return output;
}
//#endregion
//#region src/qoder/transport/wire/serialize.ts
/** Build the minimum qodercli request envelope for a validated DSH request. */
function stableHash(prefix, ...inputs) {
	const hash = crypto.createHash("sha256");
	hash.update(prefix);
	for (const input of inputs) {
		hash.update("\0");
		hash.update(input);
	}
	return hash.digest("hex").slice(0, 16);
}
function stableChatRecordId(model, messages, tools, maxTokens) {
	const hash = crypto.createHash("sha256");
	hash.update("qoder-record");
	hash.update("\0");
	hash.update(model);
	hash.update("\0");
	hash.update(JSON.stringify(messages));
	hash.update("\0");
	hash.update(JSON.stringify(tools));
	hash.update("\0");
	hash.update(`mt=${maxTokens}`);
	return hash.digest("hex").slice(0, 16);
}
/**
* Reject an unusable request before any credential resolution or provider I/O.
*
* Image publication needs credentials, so message translation now runs after
* authentication. This static pass preserves the guarantee that a request the
* provider cannot serve never reaches the network.
*/
function validateQoderRequestShape(options, model) {
	if (options.reasoningEffort !== void 0) {
		const effort = String(options.reasoningEffort);
		if (!model?.reasoningEfforts?.some((candidate) => candidate.id === effort)) throw new QoderLlmError(`Qoder model "${options.model}" does not advertise reasoning effort "${effort}".`, "UNSUPPORTED_REASONING_EFFORT");
	}
	if (options.messages.some((message) => contentHasImage(message.content)) && model?.supportsImages !== true) throw new QoderLlmError(`Qoder model "${options.model}" does not advertise image input.`, "UNSUPPORTED_CONTENT");
	validateMessageShapes(options.messages);
}
/** Translate a request whose shape has already been validated. */
function translateQoderMessages(options, attachments, pipeline) {
	return validateAndTranslateMessages(options.messages, options.system, attachments, options.signal, pipeline);
}
async function validateQoderRequest(options, model, attachments) {
	validateQoderRequestShape(options, model);
	return validateAndTranslateMessages(options.messages, options.system, attachments, options.signal);
}
async function buildQoderRequestBody(options, userId, translatedMessages, model, attachments) {
	if (!userId) throw new QoderLlmError("Qoder request identity is missing.", "AUTH");
	const modelKey = options.model || "cmodel";
	const messages = translatedMessages ?? await validateQoderRequest(options, model, attachments);
	const modelMaxTokens = model?.maxTokens ?? 32768;
	const maxTokens = Math.min(options.maxTokens ?? modelMaxTokens, modelMaxTokens);
	const isReasoning = options.reasoningEffort !== void 0 || (model?.isReasoning ?? false);
	const tools = translateTools(options.tools);
	const defaultContexts = Object.values(model?.contextOptions ?? {}).filter((option) => option.isDefault === true && typeof option.tokenCount === "number" && Number.isFinite(option.tokenCount) && option.tokenCount > 0);
	const contextConfig = model?.contextOptions === void 0 || defaultContexts.length !== 1 ? void 0 : Object.fromEntries(Object.entries(model.contextOptions).map(([key, value]) => [key, {
		...value.tokenCount === void 0 ? {} : { token_count: value.tokenCount },
		...value.isDefault === void 0 ? {} : { is_default: value.isDefault }
	}]));
	let lastUserText = "";
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index];
		if (message === void 0) continue;
		if (message.role === "user") {
			const content = message.content;
			lastUserText = typeof content === "string" ? content : Array.isArray(content) ? content.filter((part) => part.type === "text").map((part) => part.text).join("") : "";
			break;
		}
	}
	const stablePart = stableHash("qoder-session", userId, modelKey);
	const sessionId = options.sessionId === void 0 ? `${stablePart}-${crypto.randomUUID()}` : `${stablePart}-${String(options.sessionId)}`;
	const recordId = stableChatRecordId(modelKey, messages, tools, maxTokens);
	return {
		request_id: crypto.randomUUID(),
		request_set_id: recordId,
		chat_record_id: recordId,
		session_id: sessionId,
		stream: true,
		chat_task: "FREE_INPUT",
		is_reply: true,
		is_retry: false,
		source: 1,
		version: "3",
		session_type: "qodercli",
		agent_id: "agent_common",
		task_id: "common",
		code_language: "",
		chat_prompt: "",
		image_urls: null,
		aliyun_user_type: "",
		system: "",
		messages,
		tools,
		parameters: {
			max_tokens: maxTokens,
			...options.reasoningEffort === void 0 ? {} : { reasoning_effort: String(options.reasoningEffort) }
		},
		chat_context: {
			chatPrompt: "",
			imageUrls: null,
			extra: {
				context: [],
				modelConfig: {
					key: modelKey,
					is_reasoning: isReasoning
				},
				originalContent: lastUserText
			},
			features: [],
			text: lastUserText
		},
		model_config: {
			key: modelKey,
			is_reasoning: isReasoning,
			max_output_tokens: maxTokens,
			source: model?.source || "system",
			...contextConfig === void 0 ? {} : { context_config: contextConfig }
		},
		business: {
			product: "cli",
			version: "1.0.0",
			type: "agent",
			stage: "start",
			id: crypto.randomUUID(),
			name: lastUserText.substring(0, 30),
			begin_at: Date.now()
		}
	};
}
const mediaTypeExtensions = {
	"image/png": "png",
	"image/jpeg": "jpg",
	"image/webp": "webp",
	"image/gif": "gif"
};
function aborted$2() {
	return new QoderLlmError("Qoder image upload was aborted.", "ABORTED");
}
/** Encode one image as a single-field multipart payload using the Qoder boundary shape. */
function buildQoderImageMultipart(data, mediaType, boundaryId = crypto.randomUUID()) {
	const boundary = `----qodercli-${boundaryId}`;
	const extension = mediaTypeExtensions[mediaType] ?? "png";
	const header = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="image.${extension}"\r\nContent-Type: ${mediaType}\r\n\r\n`, "utf8");
	const footer = Buffer.from(`\r\n--${boundary}--\r\n`, "utf8");
	return {
		body: Buffer.concat([
			header,
			Buffer.from(data),
			footer
		]),
		boundary
	};
}
/**
* Extract the durable object URL from a center upload response.
*
* @param payload - parsed response body.
* @returns the first usable absolute URL, or undefined when none is present.
*/
function readQoderImageUrl(payload) {
	if (payload === null || typeof payload !== "object") return void 0;
	const root = payload;
	const result = root.result;
	const data = root.data;
	const candidates = [
		root.url,
		result?.url,
		result?.oss_url,
		data?.url,
		data?.oss_url
	];
	for (const candidate of candidates) {
		if (typeof candidate !== "string") continue;
		const trimmed = candidate.trim();
		if (trimmed.length === 0) continue;
		if (!URL.canParse(trimmed)) continue;
		return trimmed;
	}
}
function dataUrl(image) {
	return `data:${image.mediaType};base64,${Buffer.from(image.data).toString("base64")}`;
}
/**
* Publishes request images to the Qoder center service and remembers the result.
*
* Publication never fails a model request: any upstream problem degrades to an
* inline data URL so the turn proceeds with the same content it would have
* carried before the pipeline existed.
*/
var QoderImageUploader = class {
	cache = /* @__PURE__ */ new Map();
	flights = new SingleFlight();
	fetchImpl;
	region;
	logger;
	timeoutMs;
	cacheTtlMs;
	cacheCapacity;
	maxConcurrency;
	refreshCredentials;
	now;
	active = 0;
	queue = [];
	constructor(options = {}) {
		this.fetchImpl = options.fetch ?? globalThis.fetch;
		this.region = options.region ?? "global";
		this.logger = options.logger;
		this.timeoutMs = options.timeoutMs ?? 3e4;
		this.cacheTtlMs = options.cacheTtlMs ?? 18e5;
		this.cacheCapacity = options.cacheCapacity ?? 512;
		this.maxConcurrency = options.maxConcurrency ?? 4;
		this.refreshCredentials = options.refreshCredentials;
		this.now = options.now ?? Date.now;
	}
	/**
	* Resolve the wire URL for one request image.
	*
	* @param image - request-encoded image produced by the DSH attachment store.
	* @param credentials - credentials authorizing the center exchange.
	* @param signal - optional caller cancellation.
	* @returns a center object URL, or an inline data URL when publication fails.
	* @throws QoderLlmError with code `ABORTED` only when the caller cancels.
	*/
	async resolveImageUrl(image, credentials, signal) {
		if (signal?.aborted) throw aborted$2();
		const key = this.cacheKey(image, credentials);
		const cached = this.cache.get(key);
		if (cached !== void 0) {
			if (cached.expiresAt > this.now()) {
				this.cache.delete(key);
				this.cache.set(key, cached);
				this.logger?.debug?.("[image-upload] cache hit", {
					url: cached.url,
					region: this.region,
					mediaType: image.mediaType,
					bytes: image.data.byteLength
				});
				return cached.url;
			}
			this.cache.delete(key);
		}
		return this.flights.run(key, signal, async (sharedSignal) => {
			const url = await this.publish(image, credentials, sharedSignal);
			if (url !== void 0) {
				this.remember(key, url);
				return url;
			}
			return dataUrl(image);
		}, aborted$2);
	}
	/**
	* Derive the deduplication identity for one request image.
	*
	* `variantId` is the attachment store's deterministic cache and upload index
	* over the attachment, the request policy, and the encoder parameters, so it
	* identifies these exact bytes without rehashing them. Region and subscriber
	* are included because a center object is never shared across either.
	*/
	cacheKey(image, credentials) {
		const hash = crypto.createHash("sha256");
		hash.update(getQoderImageUploadUrl(this.region));
		hash.update("\0");
		hash.update(credentials.userID);
		hash.update("\0");
		hash.update(image.mediaType);
		hash.update("\0");
		const variantId = typeof image.variantId === "string" ? image.variantId : "";
		if (variantId.length > 0) hash.update(variantId);
		else hash.update(crypto.createHash("sha256").update(Buffer.from(image.data)).digest("hex"));
		return hash.digest("hex");
	}
	remember(key, url) {
		this.cache.delete(key);
		this.cache.set(key, {
			url,
			expiresAt: this.now() + this.cacheTtlMs
		});
		while (this.cache.size > this.cacheCapacity) {
			const oldest = this.cache.keys().next();
			if (oldest.done === true) break;
			this.cache.delete(oldest.value);
		}
	}
	async withSlot(signal, operation) {
		if (signal.aborted) throw aborted$2();
		if (this.active >= this.maxConcurrency) {
			this.logger?.debug?.("[image-upload] queued", {
				region: this.region,
				active: this.active,
				queued: this.queue.length + 1
			});
			await new Promise((resolve, reject) => {
				const onAbort = () => {
					const index = this.queue.indexOf(release);
					if (index !== -1) this.queue.splice(index, 1);
					reject(aborted$2());
				};
				const release = () => {
					signal.removeEventListener("abort", onAbort);
					resolve();
				};
				signal.addEventListener("abort", onAbort, { once: true });
				this.queue.push(release);
			});
		} else this.active++;
		try {
			if (signal.aborted) throw aborted$2();
			return await operation();
		} finally {
			const next = this.queue.shift();
			if (next !== void 0) next();
			else this.active--;
		}
	}
	/** Attempt publication, returning undefined when the request must degrade. */
	async publish(image, credentials, signal) {
		return this.withSlot(signal, async () => {
			const first = await this.attempt(image, credentials, signal);
			if (first.url !== void 0) return first.url;
			if (!first.retryable || this.refreshCredentials === void 0) {
				this.warnDegraded(first.reason);
				return;
			}
			let refreshed;
			this.logger?.debug?.("[image-upload] refreshing credentials before retry", {
				region: this.region,
				reason: first.reason
			});
			try {
				refreshed = await this.refreshCredentials(signal);
			} catch (error) {
				if (signal.aborted) throw aborted$2();
				this.warnDegraded("credential refresh failed", error);
				return;
			}
			const second = await this.attempt(image, refreshed, signal);
			if (second.url !== void 0) return second.url;
			this.warnDegraded(second.reason);
		});
	}
	warnDegraded(reason, cause) {
		this.logger?.warn?.("[image-upload] upload failed, keeping base64 image", {
			region: this.region,
			reason
		}, ...cause === void 0 ? [] : [redactLogValue(cause)]);
	}
	async attempt(image, credentials, signal) {
		const requestId = crypto.randomUUID();
		const url = getQoderImageUploadUrl(this.region, requestId);
		const multipart = buildQoderImageMultipart(image.data, image.mediaType);
		const signedBody = Buffer.from(String(multipart.body.length), "utf8");
		const timeout = AbortSignal.timeout(this.timeoutMs);
		const requestSignal = AbortSignal.any([signal, timeout]);
		const startedAt = this.now();
		const details = {
			requestId,
			region: this.region,
			mediaType: image.mediaType,
			bytes: image.data.byteLength,
			timeoutMs: this.timeoutMs
		};
		this.logger?.debug?.("[image-upload] started", details);
		try {
			const response = await this.fetchImpl(url, {
				method: "PUT",
				headers: {
					...buildAuthHeaders(signedBody, url, credentials),
					"AI-CLIENT-TIMESTAMP": String(Math.floor(this.now() / 1e3)),
					"Content-Type": `multipart/form-data; boundary=${multipart.boundary}`,
					"Content-Length": String(multipart.body.length),
					"accept": "application/json"
				},
				body: new Uint8Array(multipart.body),
				signal: requestSignal
			});
			this.logger?.debug?.("[image-upload] response received", {
				requestId,
				status: response.status,
				elapsedMs: this.now() - startedAt
			});
			const text = await readLimitedText(response, defaultMaxJsonBytes, "Qoder image upload response");
			if (!response.ok) return {
				retryable: response.status === 401 || response.status === 403,
				reason: `HTTP ${response.status}`
			};
			let payload;
			try {
				payload = JSON.parse(text);
			} catch {
				return {
					retryable: false,
					reason: "invalid JSON response"
				};
			}
			const resolved = readQoderImageUrl(payload);
			if (resolved === void 0) return {
				retryable: false,
				reason: "response carried no image URL"
			};
			this.logger?.debug?.("[image-upload] succeeded", {
				...details,
				status: response.status,
				elapsedMs: this.now() - startedAt,
				url: resolved
			});
			return {
				url: resolved,
				retryable: false,
				reason: ""
			};
		} catch (error) {
			const failureDetails = {
				requestId,
				region: this.region,
				elapsedMs: this.now() - startedAt
			};
			if (signal.aborted) {
				this.logger?.debug?.("[image-upload] aborted", failureDetails);
				throw aborted$2();
			}
			if (timeout.aborted) {
				this.logger?.debug?.("[image-upload] timed out", failureDetails);
				return {
					retryable: false,
					reason: "upload timed out"
				};
			}
			this.logger?.debug?.("[image-upload] network failure", failureDetails, redactLogValue(error));
			return {
				retryable: false,
				reason: "network failure"
			};
		}
	}
};
//#endregion
//#region src/qoder/transport/account-reader.ts
const defaultUsageTtlMs = 6e4;
const defaultUsageTimeoutMs = 15e3;
function normalizeQuota(raw) {
	if (!raw || typeof raw !== "object") return void 0;
	const total = typeof raw.total === "number" && Number.isFinite(raw.total) ? raw.total : typeof raw.cap === "number" && Number.isFinite(raw.cap) ? raw.cap : typeof raw.remaining === "number" && typeof raw.used === "number" ? raw.used + raw.remaining : 0;
	const used = typeof raw.used === "number" && Number.isFinite(raw.used) ? raw.used : 0;
	const remaining = typeof raw.remaining === "number" && Number.isFinite(raw.remaining) ? raw.remaining : Math.max(0, total - used);
	let percentage;
	if (typeof raw.percentage === "number" && Number.isFinite(raw.percentage)) percentage = raw.percentage <= 1 && total > 1 ? raw.percentage * 100 : raw.percentage;
	else percentage = total > 0 ? used / total * 100 : 0;
	const unit = typeof raw.unit === "string" && raw.unit.length > 0 ? raw.unit : "credits";
	return {
		total,
		used,
		remaining,
		percentage,
		unit
	};
}
/**
* Qoder 表示「无到期」的哨兵值：9999-12-31T00:00:00Z。
* 实测于 GET /api/v2/quota/usage：`expiresAt: 253402214400000`（毫秒），
* 在 Asia/Shanghai 渲染成「9999年12月31日 08:00」—— 这正是要修的 bug。
* 该值是完全合法的日期，会通过一切 `> 0` 检查，所以必须在日期层面识别：
* UTC 年份 ≥ 9999 即哨兵，归一化为 undefined（渲染为「无到期」），绝不打印成截止日。
*/
function isPerpetualSentinel(ms) {
	return new Date(ms).getUTCFullYear() >= 9999;
}
/** 数字纪元统一为毫秒：秒级(< 1e12)×1000，毫秒级原样。读错单位会把秒当 1970 年。 */
function epochToMs(value) {
	return value < 0xe8d4a51000 ? value * 1e3 : value;
}
function normalizeExpiresAt(rawExpires) {
	if (rawExpires === void 0 || rawExpires === null) return void 0;
	if (typeof rawExpires === "number" && rawExpires > 0) {
		const ms = epochToMs(rawExpires);
		if (isPerpetualSentinel(ms)) return void 0;
		return new Date(ms).toISOString();
	}
	if (typeof rawExpires === "string" && rawExpires.length > 0) {
		const parsed = Date.parse(rawExpires);
		if (!Number.isNaN(parsed) && parsed > 0) {
			if (isPerpetualSentinel(parsed)) return void 0;
			return new Date(parsed).toISOString();
		}
	}
}
function asString(value) {
	return typeof value === "string" && value.trim().length > 0 ? value.trim() : void 0;
}
function asBoolean(value) {
	return typeof value === "boolean" ? value : void 0;
}
function asNumber(value) {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value === "string" && value.trim().length > 0) {
		const num = Number(value);
		if (Number.isFinite(num)) return num;
	}
}
function normalizeOrganization(raw) {
	if (!raw || typeof raw !== "object") return void 0;
	const obj = raw;
	const orgId = asString(obj.org_id) ?? asString(obj.orgId) ?? asString(obj.id);
	const orgName = asString(obj.org_name) ?? asString(obj.orgName) ?? asString(obj.name);
	if (!orgId || !orgName) return void 0;
	return {
		orgId,
		orgName,
		...asString(obj.role_name) ?? asString(obj.roleName) !== void 0 ? { roleName: asString(obj.role_name) ?? asString(obj.roleName) } : {},
		isSuspended: asBoolean(obj.is_suspended) ?? asBoolean(obj.isSuspended) ?? false,
		canManageSubscriptions: asBoolean(obj.can_manage_subscriptions) ?? asBoolean(obj.canManageSubscriptions) ?? false,
		resourcePackageFeatureEnabled: asBoolean(obj.resource_package_feature_enabled) ?? asBoolean(obj.resourcePackageFeatureEnabled) ?? false
	};
}
function normalizeFeatureAllowed(raw) {
	if (!raw || typeof raw !== "object") return void 0;
	const obj = raw;
	return {
		quest: asBoolean(obj.quest) ?? false,
		wiki: asBoolean(obj.wiki) ?? false,
		codeReview: asBoolean(obj.code_review) ?? asBoolean(obj.codeReview) ?? false
	};
}
function normalizePlan(raw) {
	if (!raw || typeof raw !== "object") return void 0;
	const obj = raw;
	const userType = asString(obj.user_type) ?? asString(obj.userType);
	const planTierName = asString(obj.plan_tier_name) ?? asString(obj.planTierName) ?? asString(obj.plan_name) ?? asString(obj.planName);
	if (!userType || !planTierName) return void 0;
	const organization = normalizeOrganization(obj.organization);
	const isPersonalVersion = asBoolean(obj.is_personal_version) ?? asBoolean(obj.isPersonalVersion) ?? organization === void 0;
	const startDate = normalizeExpiresAt(obj.start_date ?? obj.startDate);
	const endDate = normalizeExpiresAt(obj.end_date ?? obj.endDate);
	const planTier = asString(obj.plan_tier) ?? asString(obj.planTier);
	const isHighestTier = asBoolean(obj.is_highest_tier) ?? asBoolean(obj.isHighestTier);
	const isRenewed = asBoolean(obj.is_renewed) ?? asBoolean(obj.isRenewed);
	const featureAllowed = normalizeFeatureAllowed(obj.feature_allowed ?? obj.featureAllowed);
	return {
		userType,
		planTierName,
		...planTier !== void 0 ? { planTier } : {},
		isPersonalVersion,
		...isHighestTier !== void 0 ? { isHighestTier } : {},
		...isRenewed !== void 0 ? { isRenewed } : {},
		...startDate !== void 0 ? { startDate } : {},
		...endDate !== void 0 ? { endDate } : {},
		...organization !== void 0 ? { organization } : {},
		...featureAllowed !== void 0 ? { featureAllowed } : {},
		raw
	};
}
function normalizeStatus(raw) {
	if (!raw || typeof raw !== "object") return void 0;
	const obj = raw;
	const featureSwitches = obj.featureSwitches ?? obj.feature_switches;
	const teamSwitches = obj.teamSwitches ?? obj.team_switches;
	const allowByok = asNumber(featureSwitches?.allow_byok ?? featureSwitches?.allowByok) ?? 0;
	const teamAllowByok = asNumber(teamSwitches?.allow_byok ?? teamSwitches?.allowByok);
	const isPrivacyPolicyModifiable = asBoolean(obj.isPrivacyPolicyModifiable ?? obj.is_data_policy_modifiable);
	return {
		allowByok,
		...teamAllowByok !== void 0 ? { teamAllowByok } : {},
		...isPrivacyPolicyModifiable !== void 0 ? { isPrivacyPolicyModifiable } : {},
		raw
	};
}
var QoderUsageReader = class {
	authService;
	fetchImpl;
	ttlMs;
	timeoutMs;
	region;
	logger;
	cache = /* @__PURE__ */ new Map();
	flights = new SingleFlight();
	constructor(options) {
		this.authService = options.authService;
		this.fetchImpl = options.fetch ?? globalThis.fetch;
		this.ttlMs = options.ttlMs ?? defaultUsageTtlMs;
		this.timeoutMs = options.timeoutMs ?? defaultUsageTimeoutMs;
		this.region = options.region ?? "global";
		this.logger = options.logger;
	}
	async readAccount(pat, options) {
		if (!pat || typeof pat !== "string") throw new QoderLlmError("Qoder Personal Access Token is missing or invalid.", "MISSING_CREDENTIAL");
		const cacheKey = `${this.region}:${opaqueCredentialKey(pat)}`;
		const cached = this.cache.get(cacheKey);
		const now = Date.now();
		if (!options?.force) {
			if (cached && cached.expiresAt > now) return cached.info;
		} else if (options?.minIntervalMs !== void 0 && cached !== void 0 && now - cached.fetchedAtMs < options.minIntervalMs) return cached.info;
		return this.flights.run(cacheKey, options?.signal, (sharedSignal) => this.loadAccount(pat, sharedSignal, cacheKey), () => new QoderLlmError("Qoder account request was aborted.", "ABORTED"));
	}
	async loadAccount(pat, signal, cacheKey) {
		try {
			return await this.loadAccountWith(pat, signal, cacheKey);
		} catch (error) {
			if (!isQoderAuthRejection(error) || signal.aborted) throw error;
			this.logger?.warn?.("[Qoder Account] Usage read rejected as unauthorized; exchanging a fresh job token and retrying once");
		}
		this.authService.clear(pat);
		return this.loadAccountWith(pat, signal, cacheKey);
	}
	async loadAccountWith(pat, signal, cacheKey) {
		const creds = await this.authService.getCredentials(pat, signal);
		const profile = {
			id: creds.userID,
			name: creds.name === "Qoder User" ? "" : creds.name,
			email: creds.email || ""
		};
		const machineId = creds.machineID;
		const [usage, plan, status] = await Promise.all([
			retryMetadataRead(signal, () => this.fetchUsage(creds.authToken, machineId, signal)),
			this.safeFetchPlan(creds.authToken, machineId, signal),
			this.safeFetchStatus(creds.authToken, machineId, signal)
		]);
		const accountInfo = {
			profile,
			usage,
			...plan !== void 0 ? { plan } : {},
			...status !== void 0 ? { status } : {},
			updatedAt: (/* @__PURE__ */ new Date()).toISOString()
		};
		this.cache.set(cacheKey, {
			info: accountInfo,
			expiresAt: Date.now() + this.ttlMs,
			fetchedAtMs: Date.now()
		});
		return accountInfo;
	}
	clear(pat) {
		if (pat) this.cache.delete(`${this.region}:${opaqueCredentialKey(pat)}`);
		else this.cache.clear();
	}
	async fetchUsage(jobToken, machineId, signal) {
		const data = await openApiJsonRequest(this.fetchImpl, {
			url: getQoderUsageUrl(this.region),
			token: jobToken,
			machineId,
			signal,
			timeoutMs: this.timeoutMs,
			logger: this.logger,
			operation: "Usage",
			logCategory: "account.usage"
		});
		return {
			userQuota: normalizeQuota(data.userQuota),
			orgResourcePackage: normalizeQuota(data.orgResourcePackage),
			addOnQuota: normalizeQuota(data.addOnQuota),
			totalUsagePercentage: typeof data.totalUsagePercentage === "number" ? data.totalUsagePercentage : void 0,
			isQuotaExceeded: typeof data.isQuotaExceeded === "boolean" ? data.isQuotaExceeded : false,
			expiresAt: normalizeExpiresAt(data.expiresAt),
			raw: data
		};
	}
	async fetchPlan(jobToken, machineId, signal) {
		return normalizePlan(await openApiJsonRequest(this.fetchImpl, {
			url: getQoderUserPlanUrl(this.region),
			token: jobToken,
			machineId,
			signal,
			timeoutMs: this.timeoutMs,
			logger: this.logger,
			operation: "Plan",
			logCategory: "account.plan"
		}));
	}
	async safeFetchPlan(jobToken, machineId, signal) {
		try {
			return await this.fetchPlan(jobToken, machineId, signal);
		} catch (error) {
			if (signal.aborted) throw error;
			this.logger?.warn?.("[Qoder Plan] Failed to load user plan (degraded)", error instanceof Error ? error.message : error);
			return;
		}
	}
	async fetchStatus(jobToken, machineId, signal) {
		return normalizeStatus(await openApiJsonRequest(this.fetchImpl, {
			url: getQoderUserStatusUrl(this.region),
			token: jobToken,
			machineId,
			signal,
			timeoutMs: this.timeoutMs,
			logger: this.logger,
			operation: "Status",
			logCategory: "account.status"
		}));
	}
	async safeFetchStatus(jobToken, machineId, signal) {
		try {
			return await this.fetchStatus(jobToken, machineId, signal);
		} catch (error) {
			if (signal?.aborted) throw error;
			this.logger?.warn?.("[Qoder Status] Failed to load user status (degraded)", error instanceof Error ? error.message : error);
			return;
		}
	}
};
/**
* Where the cache lives: `~/.dsh/qoder/machine-identity.json`.
*
* Not under the profile directory, for the reason in this module's header.
*/
function identityCachePath(home = homedir()) {
	return join(home, ".dsh", "qoder", "machine-identity.json");
}
/**
* Read one realm's cached identity, or `undefined` when there is none.
*
* A missing file is the normal state on a machine that has never checked in.
* A file that is not a schema-1 document is treated as absent AND deleted: it
* cannot be migrated (there is no older schema), and leaving it in place would
* make every future read repeat the same failure.
*
* A single malformed realm entry is dropped from the answer without deleting
* the file: the other realm's identity is still good data, and deleting it
* because a sibling entry went bad would lose the very fallback this file
* exists to provide.
*
* @param realm - Which product's identity to read (`global` / `china`).
* @param path - Cache file location; overridable so tests stay hermetic.
*/
function readCachedIdentity(realm, path = identityCachePath()) {
	const document = readDocument(path);
	if (document === void 0) return void 0;
	return entryFrom(document.realm[realm]);
}
/**
* Store one realm's identity, leaving every other realm untouched.
*
* Read-modify-write rather than a blind overwrite: two regions can resolve
* concurrently in one process (a pool spans both) and two processes can resolve
* at once (the host plus a CLI invocation). A blind overwrite would let the
* slower writer erase the other realm's identity, which is exactly the fallback
* the next check-in needs.
*
* Never throws: a cache write that fails costs one extra component spawn later,
* which is not worth failing a check-in over.
*
* @returns whether the file on disk now holds the entry.
*/
function writeCachedIdentity(realm, identity, path = identityCachePath()) {
	const document = readDocument(path) ?? {
		schema: 1,
		realm: {}
	};
	document.realm[realm] = identity;
	return writeDocument(document, path);
}
/**
* Delete the on-disk identity cache entirely, for an explicit reset.
*
* A reset replaces the seed the component fingerprints (`umid reset-native`), so
* the component would mint a NEW identity on the next spawn — but the cache
* still holds the old one, and with `QODER_UMID_IDENTITY_TTL` defaulting to
* "never expires" the stale entry is served forever. The reset would look like
* it did nothing. I-14 forbids clearing the seed when the TTL merely expires;
* it says nothing about a user asking for a reset, and a user-requested reset
* must not be silently undone by a cache.
*
* Both realms go: the seed is machine-wide, so one reset changes the identity
* for every product the component is asked about.
*
* Never throws. A reset that cannot delete this file is still worth completing
* (the seed is already replaced) and a failed delete must not surface as a
* command error, so the failure is reported as a plain `false`.
*
* @returns whether a cache file was removed; `false` when there was none or it
* could not be removed.
*/
function clearMachineIdentityCache(options = {}) {
	const path = identityCachePath(options.home ?? homedir());
	try {
		rmSync(path);
		return true;
	} catch {
		return false;
	}
}
/**
* How long a cached identity stays fresh, milliseconds (`QODER_UMID_IDENTITY_TTL`).
*
* Milliseconds, matching every other timeout in this plugin and the `cachedAt`
* field it is compared against. `0` — the default, and the value used when the
* variable is unset or unparsable — means "never expires".
*
* Lives here, next to the file it governs, because BOTH the resolution path in
* `risk-identity.ts` and the status the host reports have to agree on what
* "stale" means. Two copies of this rule would drift apart, and a status that
* calls an identity stale while the resolution path happily serves it is worse
* than no status at all.
*/
function identityTtlMs(env) {
	const raw = env["QODER_UMID_IDENTITY_TTL"]?.trim();
	if (raw === void 0 || raw === "") return 0;
	const parsed = Number(raw);
	if (!Number.isFinite(parsed) || parsed <= 0) return 0;
	return parsed;
}
/**
* Whether an entry is past its TTL.
*
* An unlimited TTL (`ttlMs <= 0`) never expires anything — the default, because
* re-sampling costs three spawns of a signed helper and a machine's identity
* does not change on its own (I-14: expiry re-samples, never forgets).
*/
function identityExpired(entry, ttlMs, now) {
	if (ttlMs <= 0) return false;
	return now - entry.cachedAt >= ttlMs;
}
/**
* What the on-disk cache currently holds for one realm, for the host's status.
*
* Deliberately narrow: when the identity was taken and whether it has aged past
* its TTL. It does NOT read the in-process memory cache — that cache belongs to
* one process, and a status document whose answer depended on which process
* asked would be untrustworthy. It does not spawn anything either: reporting
* status must never cost three helper runs.
*
* `stale` is decided by the very rule the resolution path uses
* ({@link identityTtlMs} + {@link identityExpired}), so status can never call an
* identity stale while check-in is still serving it, or vice versa.
*
* @returns `undefined` when this realm has no cached identity — including when
* the file is unreadable or corrupt, which reads as "no cache" and is cleaned up
* on the way through.
*/
function identityCacheStatus(realm, options = {}) {
	const entry = readCachedIdentity(realm, identityCachePath(options.home ?? homedir()));
	if (entry === void 0) return void 0;
	const ttlMs = identityTtlMs(options.env ?? process.env);
	return {
		cachedAt: entry.cachedAt,
		stale: identityExpired(entry, ttlMs, options.now ?? Date.now())
	};
}
/** Parse the file, deleting it when it is not a schema-1 document. */
function readDocument(path) {
	let raw;
	try {
		raw = readFileSync(path, "utf8");
	} catch {
		return;
	}
	let parsed;
	try {
		parsed = JSON.parse(raw);
	} catch {
		discard(path);
		return;
	}
	if (!isRecord$2(parsed) || parsed["schema"] !== 1) {
		discard(path);
		return;
	}
	const realm = parsed["realm"];
	if (!isRecord$2(realm)) {
		discard(path);
		return;
	}
	return {
		schema: 1,
		realm: { ...realm }
	};
}
/**
* Write the document atomically, with `0600` (I-07).
*
* tmp + rename, like every other file this plugin owns: a reader must see the
* old identity or the new one, never a half-written document that would parse
* as corrupt and be deleted. The temporary name carries a random suffix so two
* concurrent writers never share a temporary file — the loser of the rename
* then reports a failed write instead of corrupting the winner's bytes.
*/
function writeDocument(document, path) {
	const tmp = `${path}.${randomBytes(6).toString("hex")}.tmp`;
	try {
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(tmp, `${JSON.stringify(document, void 0, 2)}\n`, {
			encoding: "utf8",
			mode: 384
		});
		renameSync(tmp, path);
		return true;
	} catch {
		try {
			rmSync(tmp, { force: true });
		} catch {}
		return false;
	}
}
/** Delete a file that cannot be read as a cache document. */
function discard(path) {
	try {
		rmSync(path, { force: true });
	} catch {}
}
/** Validate one realm entry out of the untyped document. */
function entryFrom(value) {
	if (!isRecord$2(value)) return void 0;
	const machineToken = value["machineToken"];
	const machineType = value["machineType"];
	const machineCode = value["machineCode"];
	const cachedAt = value["cachedAt"];
	if (!isNonEmptyString(machineToken) || !isNonEmptyString(machineType) || !isNonEmptyString(machineCode)) return void 0;
	if (typeof cachedAt !== "number" || !Number.isFinite(cachedAt) || cachedAt <= 0) return void 0;
	const entry = {
		machineToken,
		machineType,
		machineCode,
		source: "runtime-info",
		cachedAt
	};
	const environment = value["environment"];
	if (isNonEmptyString(environment)) entry.environment = environment;
	const vmInfo = vmInfoFrom$1(value["vmInfo"]);
	if (vmInfo !== void 0) entry.vmInfo = vmInfo;
	const votes = votesFrom(value["votes"]);
	if (votes !== void 0) entry.votes = votes;
	return entry;
}
function vmInfoFrom$1(value) {
	if (!isRecord$2(value)) return void 0;
	const info = {};
	const isVm = value["isVm"];
	if (typeof isVm === "boolean") info.isVm = isVm;
	const brand = value["brand"];
	if (isNonEmptyString(brand)) info.brand = brand;
	const vmTypeCode = value["vmTypeCode"];
	if (typeof vmTypeCode === "number" && Number.isFinite(vmTypeCode)) info.vmTypeCode = vmTypeCode;
	const percentage = value["percentage"];
	if (typeof percentage === "number" && Number.isFinite(percentage)) info.percentage = percentage;
	return Object.keys(info).length === 0 ? void 0 : info;
}
function votesFrom(value) {
	if (!isRecord$2(value)) return void 0;
	const rounds = value["rounds"];
	if (typeof rounds !== "number" || !Number.isFinite(rounds) || rounds <= 0) return void 0;
	const distribution = {};
	const raw = value["distribution"];
	if (isRecord$2(raw)) {
		for (const [key, count] of Object.entries(raw)) if (typeof count === "number" && Number.isFinite(count) && count > 0) distribution[key] = count;
	}
	return {
		rounds,
		distribution
	};
}
function isRecord$2(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
function isNonEmptyString(value) {
	return typeof value === "string" && value.trim() !== "";
}
/** Defaults for {@link UmidSizeHints}, measured against the published package. */
const umidDefaultSizeHints = {
	fileMin: 409600,
	fileMax: 2097152,
	dllMin: 2097152
};
/** Largest tarball this module will accept, bytes. */
const umidMaxTarballBytes = 67108864;
/** Shortest base64 literal treated as an embedded binary, characters. */
const umidMinBlobChars = 4e3;
/** How long the post-install self-check may run before it is killed, ms. */
const umidSelfCheckTimeoutMs = 25e3;
/** How long any single registry request may take, ms. */
const umidDownloadTimeoutMs = 3e4;
/** Identifies this installer to the registry, as npm's own clients do. */
const umidUserAgent = "dsh-qoder-plugin/umid-installer";
/** Targets the published package carries a component for, for error messages. */
const umidSupportedTargets = [
	"win32-x64",
	"darwin-x64",
	"darwin-arm64",
	"linux-x64",
	"linux-arm64"
];
/**
* The host-level component directory.
*
* Host level, not profile level, for the same reason the device seed is: two
* profiles on one machine are one machine, and downloading the component twice
* would be two copies of one fact. `QODER_UMID_DIR` overrides it and, when set,
* is used alone — a test or a user who points this at a directory means that
* directory, not "that directory, then fall back".
*/
function umidDir(env = process.env, home = homedir()) {
	const override = env["QODER_UMID_DIR"]?.trim();
	if (override !== void 0 && override.length > 0) return override;
	return join(home, ".dsh", "qoder", "umid");
}
/** Name of the component executable on `platform`. */
function umidBinaryName(platform = process.platform) {
	return platform === "win32" ? "runtime-info.exe" : "runtime-info";
}
/**
* Companion library the Windows component needs next to it.
*
* `runtime-info.exe` links against it, so an executable without the DLL is not
* a usable install; {@link umidInstalled} treats the pair as the unit.
*/
const umidWindowsLibraryName = "sgsdk.dll";
/** Absolute path of the component executable. */
function umidBinaryPath(platform = process.platform, dir = umidDir()) {
	return join(dir, umidBinaryName(platform));
}
/**
* Whether a usable component is present in `dir`.
*
* On Windows both files must exist: an executable alone fails to load, and
* reporting it as installed would turn a missing DLL into a confusing spawn
* failure at check-in time instead of an install prompt.
*/
function umidInstalled(dir = umidDir(), platform = process.platform) {
	if (!existsSync(umidBinaryPath(platform, dir))) return false;
	if (platform !== "win32") return true;
	return existsSync(join(dir, umidWindowsLibraryName));
}
/** Path of the manifest within a component directory. */
function umidManifestPath(dir = umidDir()) {
	return join(dir, "manifest.json");
}
/**
* Read the manifest, or `undefined` when there is none or it is unreadable.
*
* A corrupt manifest is not an error: the binaries are the install, the
* manifest is a record of it.
*/
function readUmidManifest(dir = umidDir()) {
	return readManifestFrom(umidManifestPath(dir));
}
/** Implementation of {@link readUmidManifest} over an explicit path. */
function readManifestFrom(path) {
	try {
		const parsed = JSON.parse(readFileSync(path, "utf8"));
		if (typeof parsed !== "object" || parsed === null) return void 0;
		const candidate = parsed;
		if (candidate.schema !== 1) return void 0;
		return candidate;
	} catch {
		return;
	}
}
const peDllCharacteristic = 8192;
/**
* Offset of the COFF header inside a PE image, or `undefined` when `data` is not
* one.
*
* Every read is bounds-checked: the blobs come from a downloaded file, so a
* short or lying header must answer "unknown", never throw.
*/
function peCoffOffset(data) {
	if (data.length < 64) return void 0;
	const offset = data.readUInt32LE(60);
	if (offset + 24 > data.length) return void 0;
	if (data[offset] !== 80 || data[offset + 1] !== 69) return void 0;
	if (data[offset + 2] !== 0 || data[offset + 3] !== 0) return void 0;
	return offset;
}
/** Identify a decoded blob by its magic bytes. */
function identifyUmidBlob(data) {
	if (data.length < 4) return "unknown";
	if (data[0] === 0 && data[1] === 97 && data[2] === 115 && data[3] === 109) return "wasm";
	if (data[0] === 127 && data[1] === 69 && data[2] === 76 && data[3] === 70) {
		if (data.length < 20 || data[4] !== 2 || data[5] !== 1) return "unknown";
		const machine = data.readUInt16LE(18);
		if (machine === 62) return "elf-x86_64";
		if (machine === 183) return "elf-aarch64";
		return "unknown";
	}
	if (data[0] === 207 && data[1] === 250 && data[2] === 237 && data[3] === 254) {
		if (data.length < 8) return "unknown";
		const cpu = data.readUInt32LE(4);
		if (cpu === 16777223) return "macho-x86_64";
		if (cpu === 16777228) return "macho-arm64";
		return "unknown";
	}
	if (data[0] === 77 && data[1] === 90) {
		const offset = peCoffOffset(data);
		if (offset === void 0) return "unknown";
		const machine = data.readUInt16LE(offset + 4);
		if (machine === 34404) return "pe-x86_64";
		if (machine === 43620) return "pe-aarch64";
		return "unknown";
	}
	return "unknown";
}
/**
* Whether a PE image carries `IMAGE_FILE_DLL`.
*
* The Windows pair is the one place where magic bytes are not enough: the
* executable and its companion library are both x86-64 PE images, and the only
* thing that tells them apart in the archive is this flag.
*/
function isUmidPeDll(data) {
	const offset = peCoffOffset(data);
	if (offset === void 0) return false;
	return (data.readUInt16LE(offset + 22) & peDllCharacteristic) !== 0;
}
/**
* Which character codes are base64 alphabet, indexed by code point.
*
* A table rather than a regex character class because the scan below runs over
* every byte of a ~31 MB bundle; `charCodeAt` plus one array read is the
* cheapest test available without a dependency.
*/
const umidBase64Code = /* @__PURE__ */ new Uint8Array(128);
for (let code = 0; code < 128; code += 1) umidBase64Code[code] = code >= 48 && code <= 57 || code >= 65 && code <= 90 || code >= 97 && code <= 122 || code === 43 || code === 47 || code === 61 ? 1 : 0;
/**
* Decode every long base64 literal in `text` and identify it.
*
* The indexes are the manifest's `blobIndexes` vocabulary, so a later diagnosis
* can say "the archive changed shape at slot N" instead of "it broke".
*
* Hand-written single pass, NOT `/(['"])([A-Za-z0-9+/=]{4000,})\1/g`. That
* pattern looks equivalent and is not: on the real bundle, whose base64
* literals run to megabytes, the engine's backtracking stack overflowed
* (`RangeError: Maximum call stack size exceeded`) and every network install
* died there. The small in-memory fixtures used by the tests never reached that
* size, which is exactly why this was found only against the real package.
*
* The loop is linear: a candidate run is measured once and `index` then jumps to
* its end, so no byte is re-scanned. Advancing by one on a failed candidate
* would make the scan quadratic on a bundle made of long unclosed runs.
*/
function scanUmidBlobs(text, minChars = umidMinBlobChars) {
	const records = [];
	const threshold = Math.max(4, Math.floor(minChars));
	const length = text.length;
	let index = 0;
	while (index < length) {
		const quote = text.charCodeAt(index);
		if (quote !== 34 && quote !== 39) {
			index += 1;
			continue;
		}
		const start = index + 1;
		let end = start;
		while (end < length) {
			const code = text.charCodeAt(end);
			if (code >= 128 || umidBase64Code[code] !== 1) break;
			end += 1;
		}
		if (end - start >= threshold && text.charCodeAt(end) === quote) {
			const data = Buffer.from(text.slice(start, end), "base64");
			const kind = identifyUmidBlob(data);
			const isDll = kind === "pe-x86_64" || kind === "pe-aarch64" ? isUmidPeDll(data) : false;
			const native = kind !== "wasm" && kind !== "unknown";
			records.push({
				index: records.length,
				kind,
				bytes: data.length,
				isDll,
				...native ? { data } : {}
			});
		}
		index = end;
	}
	return records;
}
function normalizeUmidArch(arch) {
	const value = arch.trim().toLowerCase();
	if (value === "x64" || value === "x86_64" || value === "amd64") return "x86_64";
	if (value === "arm64" || value === "aarch64") return "arm64";
}
function resolveUmidTarget(platform, arch) {
	const normalized = normalizeUmidArch(arch);
	if (normalized === void 0) return void 0;
	if (platform === "win32") return normalized === "x86_64" ? {
		platform,
		arch: normalized,
		pair: true
	} : void 0;
	if (platform === "darwin" || platform === "linux") return {
		platform,
		arch: normalized,
		pair: false
	};
}
/** The single-file blob kind `target` needs, or undefined for the Windows pair. */
function kindForTarget(target) {
	if (target.pair) return void 0;
	if (target.platform === "linux") return target.arch === "x86_64" ? "elf-x86_64" : "elf-aarch64";
	return target.arch === "x86_64" ? "macho-x86_64" : "macho-arm64";
}
/**
* The smallest candidate, breaking ties by the lower blob index.
*
* Smallest rather than largest because the component is the small binary in
* this archive (the 7 MB PE is the DLL), and index order because a selection
* that depends on the order of an untrusted file is not reproducible.
*/
function smallestBlob(candidates) {
	let best;
	for (const candidate of candidates) if (best === void 0 || candidate.bytes < best.bytes) best = candidate;
	return best;
}
/**
* Pick the blobs this platform needs out of everything the bundle embeds.
*
* Magic bytes decide format and architecture; the size windows only separate
* the component from other same-format blobs; the PE DLL flag separates the
* Windows executable from its library. Nothing here may fall back to "the first
* blob that looked close", because the failure mode of a wrong pick is a
* component that installs and then cannot mint an identity — the silent
* failure this whole milestone exists to remove.
*/
function selectUmidBlobs(blobs, target, hints = umidDefaultSizeHints) {
	const resolved = resolveUmidTarget(target.platform, target.arch);
	if (resolved === void 0) return {
		ok: false,
		error: `unsupported-platform: ${target.platform}-${target.arch} has no published component; supported: ${umidSupportedTargets.join(", ")}`
	};
	const withData = blobs.filter((blob) => blob.data !== void 0);
	if (resolved.pair) {
		const pe = withData.filter((blob) => blob.kind === "pe-x86_64");
		const exe = smallestBlob(pe.filter((blob) => !blob.isDll && blob.bytes >= hints.fileMin && blob.bytes <= hints.fileMax));
		const dll = smallestBlob(pe.filter((blob) => blob.isDll && blob.bytes >= hints.dllMin));
		if (exe === void 0 || dll === void 0) return {
			ok: false,
			error: `the package does not contain a usable ${exe === void 0 ? "runtime-info.exe" : "sgsdk.dll"} for win32-x64 (${pe.length} PE x86-64 blob(s) found); the upstream package layout may have changed, please report an issue`
		};
		return {
			ok: true,
			selection: {
				files: [{
					name: umidBinaryName("win32"),
					data: exe.data
				}, {
					name: umidWindowsLibraryName,
					data: dll.data
				}],
				blobIndexes: [exe.index, dll.index]
			}
		};
	}
	const kind = kindForTarget(resolved);
	const hit = smallestBlob(withData.filter((blob) => blob.kind === kind && blob.bytes >= hints.fileMin && blob.bytes <= hints.fileMax));
	if (hit === void 0) return {
		ok: false,
		error: `the package does not contain a usable ${String(kind)} component for ${resolved.platform}-${resolved.arch}; the upstream package layout may have changed, please report an issue`
	};
	return {
		ok: true,
		selection: {
			files: [{
				name: umidBinaryName(resolved.platform),
				data: hit.data
			}],
			blobIndexes: [hit.index]
		}
	};
}
const tarBlockBytes = 512;
/** A FIFO of byte chunks with cheap front-draining. */
var UmidByteQueue = class {
	#chunks = [];
	#offset = 0;
	#length = 0;
	get length() {
		return this.#length;
	}
	push(chunk) {
		if (chunk.length === 0) return;
		this.#chunks.push(chunk);
		this.#length += chunk.length;
	}
	/** Copy exactly `count` bytes from the front, leaving them in place. */
	peek(count) {
		const first = this.#chunks[0];
		if (first === void 0 || this.#length < count) throw new Error("umid: read past the end of the tar buffer");
		if (first.length - this.#offset >= count) return first.subarray(this.#offset, this.#offset + count);
		const out = Buffer.allocUnsafe(count);
		let written = 0;
		for (const chunk of this.#chunks) {
			const start = chunk === first ? this.#offset : 0;
			const take = Math.min(chunk.length - start, count - written);
			if (take > 0) {
				chunk.copy(out, written, start, start + take);
				written += take;
			}
			if (written === count) break;
		}
		return out;
	}
	/** Remove up to `count` bytes, handing each slice to `sink`. Returns bytes removed. */
	drain(count, sink) {
		let remaining = count;
		while (remaining > 0) {
			const first = this.#chunks[0];
			if (first === void 0) break;
			const available = first.length - this.#offset;
			if (available === 0) {
				this.#chunks.shift();
				this.#offset = 0;
				continue;
			}
			const take = Math.min(available, remaining);
			if (sink !== void 0) sink(first.subarray(this.#offset, this.#offset + take));
			this.#offset += take;
			this.#length -= take;
			remaining -= take;
			if (this.#offset === first.length) {
				this.#chunks.shift();
				this.#offset = 0;
			}
		}
		return count - remaining;
	}
};
function isZeroBlock(block) {
	for (const byte of block) if (byte !== 0) return false;
	return true;
}
function readTarString(block, offset, length) {
	const raw = block.subarray(offset, offset + length);
	const end = raw.indexOf(0);
	return (end < 0 ? raw : raw.subarray(0, end)).toString("utf8");
}
/**
* Decode a tar size field.
*
* Plain 12-byte octal is what npm produces. GNU's base-256 form (high bit set)
* is decoded rather than ignored: a size read as 0 would mis-parse every
* following header, and the resulting failure would look like a corrupt
* download instead of an unsupported archive.
*/
function readTarSize(block) {
	const raw = block.subarray(124, 136);
	if (((raw[0] ?? 0) & 128) !== 0) {
		let value = 0;
		for (let index = 1; index < raw.length; index += 1) value = value * 256 + (raw[index] ?? 0);
		return value;
	}
	const text = raw.toString("latin1").replace(/[\0 ]+$/u, "").trim();
	const size = Number.parseInt(text, 8);
	return Number.isFinite(size) && size >= 0 ? size : 0;
}
function normalizeEntryName(name) {
	let value = name;
	while (value.startsWith("./")) value = value.slice(2);
	while (value.startsWith("/")) value = value.slice(1);
	return value;
}
/**
* A streaming ustar reader.
*
* Hand-written because this module is not allowed a dependency and `node:tar`
* does not exist. It implements exactly the subset npm tarballs use: 512-byte
* blocks, `ustar\0` magic, octal sizes, `'0'`/`'\0'` as regular files, and
* every other typeflag's payload skipped. It never buffers more than one block
* plus whatever the handler chooses to keep.
*/
var UmidTarScanner = class {
	#queue = new UmidByteQueue();
	#handler;
	#mode = "header";
	#bodyRemaining = 0;
	#padRemaining = 0;
	#zeroBlocks = 0;
	#sink;
	constructor(handler) {
		this.#handler = handler;
	}
	feed(chunk) {
		this.#queue.push(chunk);
		this.#pump();
	}
	/**
	* Assert the archive ended on an entry boundary.
	*
	* A tar that stops mid-file is truncated, and accepting the entries read so
	* far would install a component assembled from a partial download.
	*/
	finish() {
		if (this.#mode === "body" || this.#mode === "pad") throw new Error("the tarball ended in the middle of a file entry");
	}
	#pump() {
		for (;;) {
			if (this.#mode === "done") return;
			if (this.#mode === "body") {
				if (this.#bodyRemaining === 0) {
					this.#mode = "pad";
					this.#sink = void 0;
					continue;
				}
				if (this.#queue.length === 0) return;
				this.#bodyRemaining -= this.#queue.drain(Math.min(this.#bodyRemaining, this.#queue.length), this.#sink);
				continue;
			}
			if (this.#mode === "pad") {
				if (this.#padRemaining === 0) {
					this.#mode = "header";
					continue;
				}
				if (this.#queue.length === 0) return;
				this.#padRemaining -= this.#queue.drain(Math.min(this.#padRemaining, this.#queue.length));
				continue;
			}
			if (this.#queue.length < tarBlockBytes) return;
			const block = this.#queue.peek(tarBlockBytes);
			this.#queue.drain(tarBlockBytes);
			if (isZeroBlock(block)) {
				this.#zeroBlocks += 1;
				if (this.#zeroBlocks >= 2) {
					this.#mode = "done";
					return;
				}
				continue;
			}
			this.#zeroBlocks = 0;
			const name = normalizeEntryName((() => {
				const base = readTarString(block, 0, 100);
				const prefix = readTarString(block, 345, 155);
				return prefix === "" ? base : `${prefix}/${base}`;
			})());
			const size = readTarSize(block);
			const typeflag = block[156] ?? 0;
			const isFile = typeflag === 48 || typeflag === 0;
			this.#sink = isFile ? this.#handler.start(name, size) : void 0;
			this.#bodyRemaining = size;
			this.#padRemaining = (tarBlockBytes - size % tarBlockBytes) % tarBlockBytes;
			this.#mode = "body";
		}
	}
};
/**
* Keeps the bundle and the package manifest, drops everything else.
*
* The archive is ~31 MB of mostly-irrelevant files; only the one `.mjs` bundle
* that embeds the binaries is needed, plus the tiny `package.json` that names
* the version for an offline install (where there is no packument to ask).
*/
var UmidTarCollector = class {
	#entries = [];
	#keptBytes = 0;
	get entries() {
		return this.#entries;
	}
	start(name, size) {
		if (!name.toLowerCase().endsWith(".mjs") && !(name === "package/package.json")) return void 0;
		if (size > 67108864 || this.#keptBytes + size > 67108864) return void 0;
		this.#keptBytes += size;
		const entry = {
			name,
			bytes: 0,
			chunks: []
		};
		this.#entries.push(entry);
		return (chunk) => {
			entry.chunks.push(chunk);
			entry.bytes += chunk.length;
		};
	}
};
/**
* Gunzip and tar-scan one compressed stream, hashing it on the way through.
*
* The compressed bytes are hashed as they arrive rather than after the fact,
* because the whole tarball is never held in memory. The consequence is that an
* integrity failure is discovered after the archive was decompressed, not
* before — acceptable, since nothing is written to disk until verification has
* passed, and cheaper than buffering 31 MB to re-read it.
*/
async function harvestTarball(chunks) {
	const hash = createHash("sha512");
	let total = 0;
	const sized = (async function* () {
		for await (const chunk of chunks) {
			total += chunk.length;
			if (total > 67108864) throw new Error(`the tarball is larger than ${formatBytes(umidMaxTarballBytes)}; refusing to continue`);
			hash.update(chunk);
			yield chunk;
		}
	})();
	const collector = new UmidTarCollector();
	const scanner = new UmidTarScanner(collector);
	const gunzip = createGunzip();
	const scan = (async () => {
		for await (const chunk of gunzip) scanner.feed(chunk);
	})();
	scan.catch(() => void 0);
	try {
		for await (const chunk of sized) if (!gunzip.write(chunk)) await once(gunzip, "drain");
		gunzip.end();
		await scan;
	} catch (error) {
		gunzip.destroy();
		throw error;
	}
	scanner.finish();
	return {
		tarballBytes: total,
		tarballSha512: hash.digest("base64"),
		entries: collector.entries
	};
}
function formatBytes(bytes) {
	if (bytes < 1048576) return `${Math.round(bytes / 1024)} KiB`;
	return `${Math.round(bytes / 1048576)} MiB`;
}
function asRecord$1(value) {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return void 0;
	return value;
}
function asNonEmptyString(value) {
	return typeof value === "string" && value.trim() !== "" ? value.trim() : void 0;
}
/** Redact anything token-shaped before a message reaches a user or a log. */
function redactUmidMessage(text) {
	return text.replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/gu, "[redacted token]").replace(/(\b(?:code|token|pat)=)[^&\s]+/giu, "$1[redacted]").replace(/\bpt-[A-Za-z0-9_-]{8,}\b/gu, "[redacted token]");
}
function umidErrorMessage(error) {
	return redactUmidMessage(error instanceof Error ? error.message : String(error)).slice(0, 500);
}
/** Parse a URL that must be `https:`. */
function requireHttpsUrl(raw, what) {
	let url;
	try {
		url = new URL(raw);
	} catch {
		throw new Error(`${what} is not a URL: ${raw}`);
	}
	if (url.protocol !== "https:") throw new Error(`${what} must use https:, not ${url.protocol}`);
	return url;
}
/**
* One registry request, bounded by a deadline and by the caller's abort signal.
*
* The deadline covers the body read as well as the headers: a registry that
* answers and then stalls would otherwise hold the install open forever.
*/
async function requestWithDeadline(fetchImpl, url, signal, accept) {
	const controller = new AbortController();
	const timer = setTimeout(() => {
		controller.abort(/* @__PURE__ */ new Error(`the request to ${new URL(url).host} timed out after ${Math.round(umidDownloadTimeoutMs / 1e3)}s`));
	}, umidDownloadTimeoutMs);
	const combined = signal === void 0 ? controller.signal : AbortSignal.any([controller.signal, signal]);
	try {
		return await fetchImpl(url, {
			signal: combined,
			redirect: "follow",
			headers: {
				"user-agent": umidUserAgent,
				accept
			}
		});
	} finally {
		clearTimeout(timer);
	}
}
async function resolveRegistryDist(options) {
	const packumentUrl = `${options.registry.href.replace(/\/+$/u, "")}/${options.packageName}`;
	const response = await requestWithDeadline(options.fetchImpl, packumentUrl, options.signal, "application/json");
	if (!response.ok) throw new Error(`the registry answered ${response.status} for ${options.packageName}`);
	const packument = asRecord$1(await response.json());
	if (packument === void 0) throw new Error("the registry answered with something that is not a packument");
	const version = options.version ?? asNonEmptyString(asRecord$1(packument["dist-tags"])?.["latest"]);
	if (version === void 0) throw new Error("the registry did not report dist-tags.latest; pass --version to choose one");
	const dist = asRecord$1(asRecord$1(asRecord$1(packument["versions"])?.[version])?.["dist"]);
	if (dist === void 0) throw new Error(`the registry has no version ${version} of ${options.packageName}`);
	const tarballUrl = asNonEmptyString(dist["tarball"]);
	if (tarballUrl === void 0) throw new Error(`version ${version} advertises no dist.tarball`);
	return {
		version,
		tarballUrl,
		integrity: asNonEmptyString(dist["integrity"])
	};
}
/** Stream the registry tarball, refusing anything that leaves the registry's host. */
async function* registryTarballChunks(request) {
	const response = await requestWithDeadline(request.fetchImpl, request.url.href, request.signal, "application/octet-stream");
	if (!response.ok) throw new Error(`the registry answered ${response.status} for the tarball`);
	const finalUrl = response.url;
	if (finalUrl === "") throw new Error("the tarball response did not report a final URL; refusing to trust it");
	let final;
	try {
		final = new URL(finalUrl);
	} catch {
		throw new Error("the tarball response reported an unparseable final URL");
	}
	if (final.protocol !== "https:") throw new Error(`the tarball was served over ${final.protocol}, not https:`);
	if (final.host !== request.registryHost) throw new Error(`the tarball was served from ${final.host}, not the registry host ${request.registryHost}`);
	const body = response.body;
	if (body === null) throw new Error("the tarball response had no body");
	const reader = body.getReader();
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		if (value !== void 0) yield Buffer.from(value);
	}
}
/** Stream a tarball the user already has on disk. */
async function* fileTarballChunks(path) {
	const stream = createReadStream(path);
	try {
		for await (const chunk of stream) yield chunk;
	} catch (error) {
		throw new Error(`cannot read the tarball at ${path}: ${umidErrorMessage(error)}`);
	}
}
/** Compare a computed sha512 against an npm `integrity` string. */
function integrityMatches(integrity, digestBase64) {
	const separator = integrity.indexOf("-");
	if (separator <= 0) return void 0;
	const algorithm = integrity.slice(0, separator).trim().toLowerCase();
	const expected = integrity.slice(separator + 1).trim();
	if (algorithm !== "sha512" || expected === "") return void 0;
	return expected === digestBase64;
}
/** Read `package/package.json` out of the archive, for offline version reporting. */
function versionFromCollected(entries) {
	const entry = entries.find((candidate) => candidate.name === "package/package.json");
	if (entry === void 0) return void 0;
	try {
		return asNonEmptyString(asRecord$1(JSON.parse(Buffer.concat(entry.chunks).toString("utf8")))?.["version"]);
	} catch {
		return;
	}
}
/**
* How long the self-check teardown waits for the child's `close` after a kill.
*
* `close` is the signal that the child's stdio pipes are gone, which is exactly
* when deleting the staging directory stops racing the process on Windows. A
* grandchild that inherited those pipes can keep `close` pending forever, so
* the wait is bounded; the staging removal retries instead of deleting early,
* so the fallback never turns into "remove while the child may still write".
*/
const umidSelfCheckCloseGraceMs = 2e3;
/**
* Run the component once and collect its first JSON line.
*
* The child is given the staging directory as its working directory because a
* component that resolves its companion library relative to the CWD would
* otherwise fail here and succeed nowhere.
*
* `close`, not `exit`, is the completion signal: only `close` means the stdio
* pipes are drained. `finish` decides the outcome but keeps the promise pending
* until that event; the install therefore deletes the staging directory only
* after the child it killed is really gone.
*
* Exported, and with an injectable `spawn`, so the teardown ordering can be
* tested: the component itself only exists for the target platform, but the
* contract "the child closed before the runner settled" is host independent.
*/
async function runSelfCheckProcess(request, spawnImpl = spawn) {
	return await new Promise((resolve) => {
		let stdout = "";
		let stderr = "";
		/** An outcome has been decided; the promise may still be waiting for close. */
		let settled = false;
		/** The child's stdio pipes are closed; the staging directory is safe to remove. */
		let closed = false;
		/** The outcome to resolve with once the child closes. */
		let decided;
		let resolved = false;
		/** Why the stop signal could not be delivered, when it could not. */
		let killFailure;
		let deadline;
		let closeFallback;
		const child = spawnImpl(request.binary, [...request.args], {
			cwd: request.cwd,
			stdio: [
				"ignore",
				"pipe",
				"pipe"
			],
			windowsHide: true
		});
		/** Resolve exactly once and drop the bounded fallback. */
		const deliver = (outcome) => {
			if (resolved) return;
			resolved = true;
			if (closeFallback !== void 0) {
				clearTimeout(closeFallback);
				closeFallback = void 0;
			}
			resolve(outcome);
		};
		/**
		* Decide the outcome. The promise resolves only after `close`; if that has
		* already happened, this is also the resolve.
		*/
		const finish = (outcome) => {
			if (settled) return;
			settled = true;
			if (deadline !== void 0) {
				clearTimeout(deadline);
				deadline = void 0;
			}
			decided = outcome;
			if (closed) {
				deliver(outcome);
				return;
			}
			if (child.exitCode === null && child.signalCode === null) try {
				if (!child.kill()) killFailure = "the component did not accept the stop signal";
			} catch (error) {
				killFailure = `cannot stop the component: ${umidErrorMessage(error)}`;
			}
			closeFallback = setTimeout(() => {
				closeFallback = void 0;
				deliver(killFailure === void 0 ? outcome : {
					...outcome,
					spawnError: outcome.spawnError ?? killFailure
				});
			}, umidSelfCheckCloseGraceMs);
		};
		deadline = setTimeout(() => {
			finish({
				code: null,
				stdout,
				spawnError: `the component did not answer within ${Math.round(request.timeoutMs / 1e3)}s`
			});
		}, request.timeoutMs);
		child.stdout?.on("data", (chunk) => {
			stdout += chunk.toString("utf8");
			if (stdout.length > 1048576) finish({
				code: null,
				stdout,
				spawnError: "the component flooded stdout"
			});
		});
		child.stderr?.on("data", (chunk) => {
			if (stderr.length < 65536) stderr += chunk.toString("utf8");
		});
		child.once("error", (error) => finish({
			code: null,
			stdout,
			spawnError: `cannot run the component: ${error.message}`
		}));
		child.once("close", (code) => {
			closed = true;
			if (decided !== void 0) {
				deliver(decided);
				return;
			}
			const detail = stderr.trim();
			finish({
				code,
				stdout,
				...detail === "" ? {} : { spawnError: `the component exited ${String(code)}: ${detail.slice(0, 200)}` }
			});
		});
	});
}
/** Decide whether the component answered with a usable identity. */
function judgeSelfCheck(outcome) {
	if (outcome.spawnError !== void 0) return {
		ok: false,
		reason: redactUmidMessage(outcome.spawnError)
	};
	const firstLine = outcome.stdout.split("\n")[0] ?? "";
	if (firstLine.trim() === "") return {
		ok: false,
		reason: `the component printed nothing (exit code ${String(outcome.code)})`
	};
	let parsed;
	try {
		parsed = JSON.parse(firstLine);
	} catch {
		return {
			ok: false,
			reason: "the component did not print a JSON line on stdout"
		};
	}
	const token = asNonEmptyString(asRecord$1(parsed)?.["machineToken"]);
	if (token === void 0) return {
		ok: false,
		reason: "the component reported no machineToken"
	};
	return {
		ok: true,
		machineToken: token
	};
}
/**
* Remove leftover `.staging-*` directories.
*
* A crash or a kill during an install leaves one behind, and a stale staging
* directory that is never cleaned would slowly accumulate copies of the
* component. Installs are single-flight by construction (the route runs one
* background job, and the CLI is a human action), so a staging directory found
* here is always abandoned.
*/
function removeStagingLeftovers(destDir) {
	let entries;
	try {
		entries = readdirSync(destDir, { withFileTypes: true });
	} catch {
		return;
	}
	for (const entry of entries) {
		if (!entry.name.startsWith(".staging-")) continue;
		try {
			rmSync(join(destDir, entry.name), {
				recursive: true,
				force: true
			});
		} catch {}
	}
}
/** Attempts the install makes to delete its own staging directory. */
const umidStagingRemovalAttempts = 5;
/** Base delay between staging-removal retries, ms; the attempt number scales it. */
const umidStagingRemovalRetryMs = 50;
/** Windows reports a just-released file/directory as one of these while it settles. */
function isBusyStagingError(error) {
	const code = error?.code;
	return code === "EBUSY" || code === "EPERM" || code === "ENOTEMPTY" || code === "EACCES";
}
/**
* Remove one install's staging directory, retrying while Windows still holds it.
*
* The self-check child is awaited to its `close` before this runs, but Windows
* can keep reporting a directory whose handles were released a moment ago as
* busy (EBUSY/EPERM). A single `rmSync` would then abandon the staging
* directory and leave a stale copy of the component behind; retrying is what
* turns that race into a clean install. Best effort: the install's outcome has
* already been decided by the time this runs, and a directory that stays locked
* is picked up by the next install's {@link removeStagingLeftovers}.
*/
async function removeUmidStaging(dir) {
	for (let attempt = 1;; attempt += 1) try {
		rmSync(dir, {
			recursive: true,
			force: true
		});
		return;
	} catch (error) {
		if (attempt >= umidStagingRemovalAttempts || !isBusyStagingError(error)) return;
		await new Promise((resolve) => setTimeout(resolve, umidStagingRemovalRetryMs * attempt));
	}
}
function writeStagedFile(path, bytes, platform) {
	writeFileSync(path, bytes, { mode: platform === "win32" ? 420 : 493 });
	if (platform !== "win32") chmodSync(path, 493);
}
/**
* Write `manifest.json` at mode 0600.
*
* The manifest names the tarball, its digest and the chosen blob indexes; on a
* shared machine that is a record of what the user installed, not something
* every local account needs to read.
*/
function writeUmidManifest(destDir, manifest) {
	const path = umidManifestPath(destDir);
	const temporary = `${path}.tmp`;
	writeFileSync(temporary, `${JSON.stringify(manifest, void 0, 2)}\n`, {
		encoding: "utf8",
		mode: 384
	});
	if (process.platform !== "win32") chmodSync(temporary, 384);
	renameSync(temporary, path);
}
function sha256Hex(bytes) {
	return createHash("sha256").update(bytes).digest("hex");
}
/** Build a failed result, keeping the optional fields truly absent. */
function failure(destDir, error, extra = {}) {
	return {
		ok: false,
		skipped: false,
		version: extra.version ?? "",
		destDir,
		files: [],
		selfCheck: extra.selfCheck ?? {
			ok: false,
			reason: error
		},
		error,
		...extra.source === void 0 ? {} : { source: extra.source }
	};
}
/**
* Install the component.
*
* Implemented by the extraction pipeline; see `docs/spec-native-device-identity.md`
* (SPEC-UMID-003) §6.1 for the required step order. Nothing is downloaded
* unless this is called explicitly — the check-in path never reaches here.
*
* Ordering note: the "already installed" short-circuit runs before the registry
* is contacted, although the spec numbers it after the packument fetch. A
* machine that already has a working component must not make a network request
* to find that out, and T-M1-5 asserts exactly that.
*/
async function installUmid(options = {}) {
	const env = options.env ?? process.env;
	const platform = options.platform ?? process.platform;
	const arch = options.arch ?? process.arch;
	const destDir = options.destDir ?? umidDir(env, void 0);
	const hints = options.sizeHints ?? umidDefaultSizeHints;
	const minBlobChars = options.minBlobChars ?? 4e3;
	const packageName = options.packageName ?? "@qoder-ai/qodercli";
	const logger = options.logger;
	const signal = options.signal;
	removeStagingLeftovers(destDir);
	if (resolveUmidTarget(platform, arch) === void 0) return failure(destDir, `unsupported-platform: ${platform}-${arch} has no published component; supported: ${umidSupportedTargets.join(", ")}`);
	if (options.force !== true && umidInstalled(destDir, platform)) {
		const manifest = readUmidManifest(destDir);
		return {
			ok: true,
			skipped: true,
			version: manifest?.source.version ?? "",
			destDir,
			files: manifest?.files ?? [],
			selfCheck: manifest?.selfCheck ?? {
				ok: false,
				reason: "installed before this manifest schema"
			},
			...manifest?.source === void 0 ? {} : { source: manifest.source }
		};
	}
	if (signal?.aborted === true) return failure(destDir, "the install was cancelled");
	const tarballPath = options.tarballPath ?? asNonEmptyString(env["QODER_UMID_TARBALL"]);
	const registryRaw = options.registry ?? asNonEmptyString(env["QODER_UMID_REGISTRY"]) ?? "https://registry.npmjs.org";
	let harvest;
	let version;
	let source;
	try {
		if (tarballPath !== void 0) {
			logger?.info(`umid: reading the offline tarball ${tarballPath}`);
			harvest = await harvestTarball(fileTarballChunks(tarballPath));
			version = options.version ?? versionFromCollected(harvest.entries) ?? "unknown";
			source = {
				kind: "tarball",
				package: packageName,
				version,
				tarballSha512: harvest.tarballSha512,
				tarballBytes: harvest.tarballBytes
			};
		} else {
			const registry = requireHttpsUrl(registryRaw, "the registry URL");
			logger?.info(`umid: asking ${registry.host} for ${packageName}`);
			const dist = await resolveRegistryDist({
				registry,
				packageName,
				version: options.version,
				fetchImpl: options.fetchImpl ?? fetch,
				signal
			});
			version = dist.version;
			const tarballUrl = requireHttpsUrl(dist.tarballUrl, "dist.tarball");
			if (tarballUrl.host !== registry.host) throw new Error(`dist.tarball points at ${tarballUrl.host}, not the registry host ${registry.host}`);
			logger?.info(`umid: downloading ${packageName}@${version}`);
			harvest = await harvestTarball(registryTarballChunks({
				url: tarballUrl,
				registryHost: registry.host,
				fetchImpl: options.fetchImpl ?? fetch,
				signal
			}));
			if (dist.integrity !== void 0) {
				const matched = integrityMatches(dist.integrity, harvest.tarballSha512);
				if (matched === false) return failure(destDir, "sha512 mismatch: the tarball does not match the registry integrity; nothing was written", { version });
				if (matched === void 0) logger?.warn("umid: the registry published no usable sha512 integrity; the tarball was not verified");
			}
			source = {
				kind: "registry",
				package: packageName,
				version,
				tarballSha512: harvest.tarballSha512,
				tarballBytes: harvest.tarballBytes
			};
		}
	} catch (error) {
		return failure(destDir, umidErrorMessage(error));
	}
	const bundles = harvest.entries.filter((entry) => entry.name.toLowerCase().endsWith(".mjs"));
	let blobs = [];
	let entryName;
	for (const bundle of bundles) {
		const scanned = scanUmidBlobs(Buffer.concat(bundle.chunks).toString("latin1"), minBlobChars);
		if (scanned.some((blob) => blob.kind !== "wasm" && blob.kind !== "unknown")) {
			blobs = scanned;
			entryName = bundle.name;
			break;
		}
	}
	if (entryName === void 0) return failure(destDir, "the package contains no .mjs bundle with embedded native binaries; the upstream package layout may have changed, please report an issue", { version });
	logger?.info(`umid: ${blobs.length} embedded blob(s) in ${entryName}`);
	const selection = selectUmidBlobs(blobs, {
		platform,
		arch
	}, hints);
	if (!selection.ok) return failure(destDir, selection.error, { version });
	const sourceWithBlobs = {
		...source,
		entry: entryName,
		blobIndexes: selection.selection.blobIndexes
	};
	const stagingDir = join(destDir, `.staging-${randomUUID().slice(0, 8)}`);
	try {
		mkdirSync(stagingDir, { recursive: true });
		for (const file of selection.selection.files) writeStagedFile(join(stagingDir, file.name), file.data, platform);
		const judged = judgeSelfCheck(await (options.selfCheck ?? runSelfCheckProcess)({
			binary: join(stagingDir, umidBinaryName(platform)),
			cwd: stagingDir,
			args: ["3"],
			timeoutMs: umidSelfCheckTimeoutMs
		}));
		if (!judged.ok) return failure(destDir, `self-check failed: ${judged.reason}`, {
			version,
			source: sourceWithBlobs
		});
		const selfCheck = {
			ok: true,
			at: (/* @__PURE__ */ new Date()).toISOString(),
			machineTokenSha256Prefix: sha256Hex(Buffer.from(judged.machineToken, "utf8")).slice(0, 8)
		};
		const files = [];
		for (const file of selection.selection.files) {
			renameSync(join(stagingDir, file.name), join(destDir, file.name));
			files.push({
				name: file.name,
				bytes: file.data.length,
				sha256: sha256Hex(file.data)
			});
		}
		writeUmidManifest(destDir, {
			schema: 1,
			installedAt: (/* @__PURE__ */ new Date()).toISOString(),
			platform,
			arch,
			source: sourceWithBlobs,
			files,
			selfCheck
		});
		return {
			ok: true,
			skipped: false,
			version,
			destDir,
			files,
			source: sourceWithBlobs,
			selfCheck
		};
	} catch (error) {
		return failure(destDir, umidErrorMessage(error), {
			version,
			source: sourceWithBlobs
		});
	} finally {
		await removeUmidStaging(stagingDir);
	}
}
//#endregion
//#region src/qoder/transport/risk-identity.ts
/**
* Device risk identity for the Qoder campaign endpoints.
*
* Qoder's international service only hands out the daily claim campaign to
* requests that carry a machine identity minted by its OWN desktop client.
* Measured against the live upstream: the same account, token and headers get
* an empty/lifeless `campaigns` array without it, and the real
* `CLAIM_BENEFIT` campaign with it — so a check-in built on a self-made
* machine id reports "no campaign today" forever while looking healthy at the
* transport layer (HTTP 200, no error).
*
* The identity cannot be synthesized: it is produced by the client's signed
* `runtime-info` helper, which fingerprints the real machine (its hardware,
* its VM status) and signs the answer. The only honest way to obtain one is
* to ask an installed Qoder client — or the copy of that helper this plugin
* downloaded from the vendor's own package (`umid-extract.ts`) — to produce it,
* which is what this module does. When neither is available, the campaign
* request simply cannot be made to qualify, and the caller is told so instead
* of being handed a fabricated identity that the upstream will ignore.
*
* Three properties of that helper shape everything below:
*
* 1. It is not always installed where a naive guess would look. A launcher that
*    keeps its files in a custom directory records that fact in its own
*    `state.ini`, so discovery reads that file before falling back to the fixed
*    locations the plugin used to hardcode (SPEC-UMID-003 §5.11).
* 2. Its answer jitters. `machineToken` is stable per machine, but
*    `machineType` / `machineCode` / `vmInfo` flip between virtualisation
*    profiles across invocations of the same binary on the same machine
*    (measured at 1.56%–10.29%). A single sample would therefore move the
*    upstream's risk view for no reason, so a resolution takes three samples
*    and extends to five when they disagree, then keeps the strict majority.
* 3. It can disappear. Anti-virus software quarantines it and users clean
*    `~/.dsh`; in both cases the identity already proven for this machine is
*    still perfectly usable. Hence the disk cache, and hence the rule that an
*    expired cache is better than a hard "no client" failure (I-13).
*
* Every platform- and filesystem-dependent decision goes through an injectable
* seam (`options.platform` / `env` / `existsImpl` / `readFileImpl` /
* `hostnameImpl`). That is not testability for its own sake: the Windows
* launcher layout has to be exercised on a Linux CI runner, and reading the
* real environment there would make the suite assert about the runner instead
* of the fixture.
*
* @module dsh-qoder-plugin/qoder/transport/risk-identity
*/
/**
* The `env` argument selects which product's identity is minted.
*
* Measured on an installed client: env `3` yields the international identity
* and env `0` the China one, from the same binary — the argument is the
* product selector, not a version. Sending the wrong one asks the upstream
* about the wrong product, which is indistinguishable from having no identity
* at all.
*/
const riskEnvForRegion = {
	global: "3",
	china: "0"
};
/**
* The product directory names a client install may use, preferred first.
*
* Both products are listed in every order because the helper for either product
* can mint either identity (see `riskEnvForRegion`); requiring the *matching*
* product would fail on a machine that only installed one of them.
*/
const productNames = {
	global: [
		"Qoder",
		"Qoder CN",
		"QoderCN"
	],
	china: [
		"Qoder CN",
		"QoderCN",
		"Qoder"
	]
};
/** Longest a single helper invocation may take before it is abandoned. */
const sampleTimeoutMs = 25e3;
/**
* Largest stdout accepted from one invocation, characters.
*
* A helper that floods stdout is malfunctioning, not authoritative; letting it
* run would also let a broken binary grow this process's heap.
*/
const sampleMaxStdoutChars = 1048576;
/** Rounds that must all agree before the vote is settled. */
const voteFirstPassRounds = 3;
/** Hard ceiling on rounds: the first pass plus one extension (§6.5). */
const voteMaxRounds = 5;
/** Longest header-safe hostname, characters (§6.8). */
const maxHostnameChars = 96;
/** Fill in the real seams for everything the caller did not inject. */
function lookupOf(options) {
	return {
		home: options.home ?? homedir(),
		platform: options.platform ?? platform(),
		env: options.env ?? process.env,
		exists: options.existsImpl ?? existsSync,
		readFile: options.readFileImpl ?? ((path) => readFileSync(path)),
		now: options.now ?? Date.now
	};
}
/**
* Name of the client's helper on `platform`.
*
* A function rather than a constant because the name is platform-dependent and
* the platform has to be injectable: a test exercising the Windows layout must
* be able to ask for `runtime-info.exe` while running on Linux, which a
* module-level constant derived from the real `process.platform` made
* impossible (SPEC-UMID-003 R13).
*/
function runtimeInfoName(platform$1 = platform()) {
	return umidBinaryName(platform$1);
}
/** The `state.ini` files a launcher may write for one product, best first. */
function launcherStateFiles(local, name) {
	return [join(local, name, `${name} Launcher`, "state.ini"), join(local, name, "Launcher", "state.ini")];
}
/**
* Read the `installDir` a launcher recorded for one product.
*
* The launcher writes `state.ini` in whatever encoding its own runtime defaulted
* to: UTF-8 on one build, UTF-16LE with a BOM on another (both observed). Rather
* than guess, the BOM decides when there is one and the decoders are tried in
* order when there is not — a UTF-16 file read as UTF-8 yields text with NUL
* bytes and no `installDir` key, which is exactly the case the candidate chain
* already has to fall through.
*
* An unreadable or key-less file is not an error: it means "no custom directory
* recorded", and the fixed candidates still apply.
*/
function launcherInstallDir(local, name, deps) {
	for (const file of launcherStateFiles(local, name)) {
		if (!deps.exists(file)) continue;
		let bytes;
		try {
			bytes = deps.readFile(file);
		} catch {
			continue;
		}
		const configured = installDirFromText(bytes);
		if (configured !== void 0) return configured;
	}
}
/** Decode a `state.ini` and return its `installDir` value, if any. */
function installDirFromText(bytes) {
	for (const text of decodeStateIni(bytes)) {
		const value = installDirFromIniText(text);
		if (value !== void 0) return value;
	}
}
/**
* Candidate decodings of a `state.ini`, most likely first.
*
* A BOM is authoritative. Without one, UTF-8 comes first (what the current
* launcher writes) and UTF-16LE second (what a UTF-16 file without a BOM looks
* like). Callers stop at the first decoding that yields the key.
*/
function decodeStateIni(bytes) {
	if (startsWithBytes(bytes, [255, 254])) return [bytes.subarray(2).toString("utf16le")];
	if (startsWithBytes(bytes, [254, 255])) return [decodeUtf16BigEndian(bytes.subarray(2))];
	if (startsWithBytes(bytes, [
		239,
		187,
		191
	])) return [bytes.subarray(3).toString("utf8")];
	return [bytes.toString("utf8"), bytes.toString("utf16le")];
}
/** Decode UTF-16BE, which Node does not expose directly. */
function decodeUtf16BigEndian(bytes) {
	const even = bytes.subarray(0, bytes.length - bytes.length % 2);
	const swapped = Buffer.from(even);
	swapped.swap16();
	return swapped.toString("utf16le");
}
/** Pull `installDir` out of INI text. */
function installDirFromIniText(text) {
	for (const rawLine of text.split(/\r?\n/)) {
		const line = rawLine.trim();
		if (line === "" || line.startsWith(";") || line.startsWith("#")) continue;
		const separator = line.indexOf("=");
		if (separator < 0) continue;
		if (line.slice(0, separator).trim().toLowerCase() !== "installdir") continue;
		const value = stripQuotes(line.slice(separator + 1).trim());
		if (value !== "") return value;
	}
}
function stripQuotes(value) {
	return ((/^"(.*)"$/.exec(value) ?? /^'(.*)'$/.exec(value))?.[1] ?? value).trim();
}
/**
* The fixed install locations, without any launcher configuration.
*
* These are the paths the plugin has always guessed, kept as the tail of the
* candidate chain so a machine that never wrote a launcher state file behaves
* exactly as it did before the launcher file was read. `env` is a parameter
* rather than `process.env` so a lookup can be proven to have used the injected
* environment (R13).
*/
function installRoots(home, os, env) {
	if (os === "win32") {
		const local = env["LOCALAPPDATA"] ?? join(home, "AppData", "Local");
		return [
			join(local, "Programs", "Qoder"),
			join(local, "Programs", "Qoder CN"),
			"C:\\Program Files\\Qoder",
			"C:\\Program Files\\Qoder CN",
			"D:\\Program Files\\Qoder",
			"D:\\Program Files\\Qoder CN"
		];
	}
	if (os === "darwin") return [
		"/Applications/Qoder.app/Contents",
		"/Applications/Qoder CN.app/Contents",
		join(home, "Applications", "Qoder.app", "Contents"),
		join(home, "Applications", "Qoder CN.app", "Contents")
	];
	return [
		"/opt/Qoder",
		"/opt/qoder",
		join(home, ".qoder")
	];
}
/**
* Every directory a Qoder desktop install may live in, best candidate first.
*
* Order is the point of this function, and it is what makes "client installed in
* a non-default directory" work: the launcher records the directory it actually
* uses, so that record beats every guess. Only then come the per-user and
* per-machine defaults, then the drive-level fallbacks.
*
* Roots, not component directories: each entry is a directory that may contain
* `resources/umid` (see {@link resourcesDirs}), which is how both the launcher
* layout and the plain layout are covered by one list.
*
* @param region - Which product to try first (either can mint either identity).
* @param home - Home directory, for the per-user locations.
* @param os - Target platform; injected so the Windows layout is testable.
* @param env - Environment to read `LOCALAPPDATA` / `ProgramFiles` from.
* @param deps - Existence and read seams, injected for tests.
*/
function desktopInstallDirs(region, home, os, env, deps) {
	const names = productNames[region] ?? productNames.global;
	const dirs = [];
	if (os === "win32") {
		const local = env["LOCALAPPDATA"] ?? join(home, "AppData", "Local");
		for (const name of names) {
			const configured = launcherInstallDir(local, name, deps);
			if (configured !== void 0) dirs.push(configured);
		}
		for (const name of names) dirs.push(join(local, "Programs", name));
		const programFiles = env["ProgramFiles"] ?? "C:\\Program Files";
		for (const name of names) dirs.push(join(programFiles, name));
	} else if (os === "darwin") {
		for (const name of names) dirs.push(`/Applications/${name}.app/Contents`);
		for (const name of names) dirs.push(join(home, "Applications", `${name}.app`, "Contents"));
	} else for (const name of names) dirs.push(join("/usr/share", name.toLowerCase()));
	for (const root of installRoots(home, os, env)) dirs.push(root);
	return dedupe(dirs);
}
/**
* Every `resources` directory a Qoder install might use, best candidate first.
*
* The 0.3+ launcher keeps the version actually running under
* `.qoder-versions/<ver>/resources`, while the top-level `resources` may be a
* stale leftover from the first install — so the versioned directories are
* tried FIRST. Getting this order backwards pins the plugin to whatever build
* happened to be installed first, whose helper can be older than the client
* the user is actually running.
*
* `Resources` (capitalised) is offered as well because that is how the macOS app
* bundle spells it and a case-sensitive volume would otherwise miss it; the
* extra candidate costs one existence check and only ever matters on that
* layout.
*/
function resourcesDirs(root) {
	const dirs = [];
	try {
		const versionRoot = join(root, ".qoder-versions");
		for (const entry of readdirSync(versionRoot, { withFileTypes: true })) if (entry.isDirectory()) dirs.push(join(versionRoot, entry.name, "resources"));
	} catch {}
	dirs.push(join(root, "resources"));
	dirs.push(join(root, "Resources"));
	return dirs;
}
/**
* Every directory that could hold a usable component, best candidate first.
*
* `QODER_UMID_DIR` is authoritative when set: a user or a test who points the
* plugin at a directory means that directory, not "that directory, then
* whatever else happens to be installed" (§5.1). Otherwise the client's own
* installation comes first — an installed client is the verified shape and must
* keep winning — and the plugin's own extracted copy is the last resort.
*/
function componentDirs(options, lookup) {
	const override = lookup.env["QODER_UMID_DIR"]?.trim();
	if (override !== void 0 && override !== "") return [override];
	const region = options.region ?? "global";
	const roots = options.installRoots ?? desktopInstallDirs(region, lookup.home, lookup.platform, lookup.env, {
		exists: lookup.exists,
		readFile: lookup.readFile
	});
	const dirs = [];
	for (const root of roots) for (const resources of resourcesDirs(root)) dirs.push(join(resources, "umid"));
	dirs.push(umidDir(lookup.env, lookup.home));
	return dedupe(dirs);
}
/**
* The component executable inside `dir`, or undefined when the directory does
* not hold a usable component.
*
* On Windows the executable alone is not an install: it links against
* `sgsdk.dll`, so a directory holding only the `.exe` would turn into a
* confusing spawn failure at check-in time instead of a clear "not installed"
* (I-06). This is the pair rule `umidInstalled` applies, restated over the
* injectable existence check this module resolves through.
*/
function componentBinary(dir, lookup) {
	const binary = join(dir, runtimeInfoName(lookup.platform));
	if (!lookup.exists(binary)) return void 0;
	if (lookup.platform !== "win32") return binary;
	return lookup.exists(join(dir, "sgsdk.dll")) ? binary : void 0;
}
/** Locate the client's risk-identity helper, or undefined when none exists. */
function findRuntimeInfoBinary(options = {}) {
	const lookup = lookupOf(options);
	for (const dir of componentDirs(options, lookup)) {
		const binary = componentBinary(dir, lookup);
		if (binary !== void 0) return binary;
	}
}
/**
* Whether this platform's helper takes the account on stdin.
*
* Only the desktop builds do (§6.5). The helper still gets its stdin closed on
* the others so it can never wait on a pipe nobody will write to.
*/
function takesAccountOnStdin(platform) {
	return platform === "darwin" || platform === "win32";
}
/**
* Ask the helper once for this machine's identity.
*
* The helper takes the account uid on stdin as `{"account":"<uid>"}` and answers
* one JSON line on stdout. It is the account that is being fingerprinted, so a
* uid is required: without one there is nothing to ask about, and the caller
* must not invent one.
*
* Never throws: an absent component, a timeout, a crash, or malformed output all
* resolve to `undefined`, because every one of them means the same thing to the
* caller — this round produced no usable sample.
*
* `cwd` is the component's own directory because the helper loads its companion
* library relative to the working directory, not relative to the executable.
*/
async function sampleOnce(exe, region, account, platform, spawnImpl) {
	const environment = riskEnvForRegion[region] ?? riskEnvForRegion.global;
	const withAccount = takesAccountOnStdin(platform);
	return await new Promise((resolve) => {
		let out = "";
		let settled = false;
		let timer;
		const child = spawnImpl(exe, withAccount ? [environment, "--account-stdin"] : [environment], {
			cwd: dirname(exe),
			stdio: [
				"pipe",
				"pipe",
				"ignore"
			],
			windowsHide: true
		});
		const finish = (value) => {
			if (settled) return;
			settled = true;
			if (timer !== void 0) clearTimeout(timer);
			if (child.exitCode === null) child.kill();
			resolve(value);
		};
		timer = setTimeout(() => finish(void 0), sampleTimeoutMs);
		const tryParse = () => {
			const newline = out.indexOf("\n");
			if (newline < 0) return;
			try {
				finish(sampleFrom(JSON.parse(out.slice(0, newline)), environment));
			} catch {
				finish(void 0);
			}
		};
		child.stdout?.on("data", (chunk) => {
			out += chunk.toString("utf8");
			if (out.length > sampleMaxStdoutChars) return finish(void 0);
			tryParse();
		});
		child.once("error", () => finish(void 0));
		child.once("close", () => {
			if (!settled) tryParse();
			finish(void 0);
		});
		child.stdin?.on("error", () => void 0);
		if (withAccount) child.stdin?.end(`${JSON.stringify({ account })}\n`);
		else child.stdin?.end();
	});
}
/**
* Turn one stdout line into a sample, or `undefined` when it is not one.
*
* All three identity fields are required. That is stricter than the reference
* implementation, which falls back per field, and it is deliberate: a partial
* identity is not something the campaign endpoints accept, so accepting it
* would only move the failure from a clear "no client" report to a silent
* empty campaign list.
*/
function sampleFrom(parsed, environment) {
	if (!isRecord$1(parsed)) return void 0;
	const machineToken = stringField(parsed, "machineToken");
	const machineType = stringField(parsed, "machineType");
	const machineCode = stringField(parsed, "machineCode");
	if (machineToken === void 0 || machineType === void 0 || machineCode === void 0) return void 0;
	const sample = {
		machineToken,
		machineType,
		machineCode,
		environment
	};
	const vmInfo = vmInfoFrom(parsed["vmInfo"]);
	if (vmInfo !== void 0) sample.vmInfo = vmInfo;
	return sample;
}
function stringField(parsed, key) {
	const value = parsed[key];
	if (typeof value !== "string") return void 0;
	const trimmed = value.trim();
	if (trimmed === "" || trimmed.length > 4096) return void 0;
	return trimmed;
}
function vmInfoFrom(value) {
	if (!isRecord$1(value)) return void 0;
	const info = {};
	const isVm = value["isVm"];
	if (typeof isVm === "boolean") info.isVm = isVm;
	const brand = value["brand"];
	if (typeof brand === "string" && brand.trim() !== "") info.brand = brand.trim();
	const vmTypeCode = value["vmTypeCode"];
	if (typeof vmTypeCode === "number" && Number.isFinite(vmTypeCode)) info.vmTypeCode = vmTypeCode;
	const percentage = value["percentage"];
	if (typeof percentage === "number" && Number.isFinite(percentage)) info.percentage = percentage;
	return Object.keys(info).length === 0 ? void 0 : info;
}
/**
* The value the vote compares (§6.5).
*
* `vmInfo.percentage` is deliberately absent: it is a floating-point estimate
* that differs between two invocations of the same helper on the same machine,
* so including it would make every vote disagree and buy nothing — the field is
* not part of what the upstream uses to recognise a device.
*/
function voteKey(sample) {
	const vm = sample.vmInfo;
	return [
		sample.machineToken,
		sample.machineType,
		sample.machineCode,
		vm?.isVm === void 0 ? "" : String(vm.isVm),
		vm?.brand ?? "",
		vm?.vmTypeCode === void 0 ? "" : String(vm.vmTypeCode)
	].join("|");
}
/** A stable, non-reversible label for a vote key, for the cache's diagnostics. */
function voteKeyHash(sample) {
	return createHash("sha256").update(voteKey(sample)).digest("hex").slice(0, 16);
}
/**
* Sample the helper and vote the answers together.
*
* Three rounds is the measured minimum that resolves the jitter; two more are
* spent only when those three disagree, so a healthy machine pays for three
* spawns and a machine whose profile flips pays for five. The ceiling is five:
* beyond that the vote is not converging, and a check-in is waiting.
*
* `undefined` means no round produced a usable sample — a different situation
* from "the answers disagreed", and the caller falls back to the cache for it.
*/
async function sampleWithVote(exe, region, account, platform, spawnImpl) {
	const samples = [];
	for (let round = 0; round < voteMaxRounds; round += 1) {
		if (round >= voteFirstPassRounds && agreedKey(samples) !== void 0) break;
		const sample = await sampleOnce(exe, region, account, platform, spawnImpl);
		if (sample !== void 0) samples.push(sample);
	}
	const first = samples[0];
	if (first === void 0) return void 0;
	const distribution = {};
	for (const sample of samples) {
		const hash = voteKeyHash(sample);
		distribution[hash] = (distribution[hash] ?? 0) + 1;
	}
	return {
		sample: pickWinner(samples, first),
		rounds: samples.length,
		distribution
	};
}
/** The single key all samples share, or undefined when they disagree. */
function agreedKey(samples) {
	const first = samples[0];
	if (first === void 0) return void 0;
	const key = voteKey(first);
	return samples.every((sample) => voteKey(sample) === key) ? key : void 0;
}
/**
* The strict majority sample, or the first one when no key holds a majority.
*
* A tie is not resolved by preference: there is no evidence that either answer
* is the machine's "real" one, and inventing a rule (newest, lowest code) would
* be a rule the upstream never agreed to. The first sample is at least the
* answer this process acted on when the vote started.
*/
function pickWinner(samples, first) {
	const counts = /* @__PURE__ */ new Map();
	for (const sample of samples) {
		const key = voteKey(sample);
		counts.set(key, (counts.get(key) ?? 0) + 1);
	}
	let bestKey;
	let bestCount = 0;
	let tied = false;
	for (const [key, count] of counts) if (count > bestCount) {
		bestKey = key;
		bestCount = count;
		tied = false;
	} else if (count === bestCount) tied = true;
	if (bestKey === void 0 || tied || bestCount * 2 <= samples.length) return first;
	return samples.find((sample) => voteKey(sample) === bestKey) ?? first;
}
/** The three header values out of a sample or a cache entry. */
function identityOf(source) {
	return {
		machineToken: source.machineToken,
		machineCode: source.machineCode,
		machineType: source.machineType
	};
}
/** Build the cache entry for a winning sample. */
function cacheEntryFrom(region, voted, cachedAt) {
	const sample = voted.sample;
	const entry = {
		machineToken: sample.machineToken,
		machineType: sample.machineType,
		machineCode: sample.machineCode,
		environment: riskEnvForRegion[region] ?? riskEnvForRegion.global,
		source: "runtime-info",
		cachedAt,
		votes: {
			rounds: voted.rounds,
			distribution: voted.distribution
		}
	};
	if (sample.vmInfo !== void 0) entry.vmInfo = sample.vmInfo;
	return entry;
}
/**
* Whether the disk cache may be used at all (`QODER_UMID_IDENTITY_CACHE`).
*
* On by default. Turning it off makes every resolution spawn the component,
* which is what the reference implementation does and what a debugging session
* sometimes wants.
*/
function identityCacheEnabled(env) {
	return env["QODER_UMID_IDENTITY_CACHE"]?.trim() !== "0";
}
/**
* How long a cached identity stays fresh, and whether one has aged past it, live
* in the cache module: the host's status reports the same verdict, and two
* copies of the rule would eventually disagree.
*/
/** Resolutions remembered for this process, keyed by realm. */
const memoryCache = /* @__PURE__ */ new Map();
/** Background re-samples in flight, keyed by realm, so one realm never races itself. */
const backgroundRefreshes = /* @__PURE__ */ new Map();
/**
* How many times the process memory has been dropped on purpose.
*
* A re-sample started before a reset describes the identity of the OLD seed, so
* its answer must not be written back afterwards: it would re-create exactly the
* cache entry the reset just deleted. Sampling is asynchronous, so the only way
* to notice that is a counter captured when the sample started.
*/
let resetGeneration = 0;
/**
* Forget the identities this process resolved, so the next check-in resolves
* again from disk and, if the disk copy is gone too, from the component.
*
* An explicit reset (`umid reset-native`) needs this: it replaces the seed, and
* a 30-minute memory entry would otherwise keep serving the identity of the seed
* that no longer exists. Nothing else may call it — the TTL expiring re-samples
* through the cache path instead (I-14).
*/
function clearIdentityMemoryCache() {
	resetGeneration += 1;
	memoryCache.clear();
}
function rememberedResolution(region, ttlMs, now) {
	if (ttlMs <= 0) return void 0;
	const entry = memoryCache.get(region);
	if (entry === void 0) return void 0;
	if (now - entry.at >= ttlMs) {
		memoryCache.delete(region);
		return;
	}
	return entry.resolution;
}
function rememberResolution(region, resolution, ttlMs, now) {
	if (ttlMs <= 0) return;
	memoryCache.set(region, {
		resolution,
		at: now
	});
}
/**
* Resolve the identity and report where it came from.
*
* The order is the answer to "which source wins", and it is constrained from
* two sides (SPEC-UMID-003 R7 and I-04):
*
* 1. A resolution this process already made (30 minutes, per realm).
* 2. A disk-cached identity that is still within its TTL — the component is NOT
*    spawned for it. This step has to come before the component, or I-04's
*    "at most one spawn within the TTL" could not hold: with the component
*    first, every check-in would spawn again even though a proven identity was
*    sitting on disk. R7 lists the component first, which describes which
*    source may PRODUCE an identity; I-04 says a cache that already has one is
*    authoritative. Where they disagree, the invariant wins.
* 3. The component, sampled and voted.
* 4. An expired cached identity, used as-is and marked `stale` while a
*    background re-sample runs. This is I-13: a quarantined helper or a cleaned
*    `~/.dsh` must not turn into "no client" while a usable identity exists.
* 5. Nothing.
*
* A component that is present but cannot answer falls through to step 4 rather
* than failing: "installed but broken" is the Defender case, and the identity
* already proven for this machine is still valid.
*/
async function resolveRiskIdentityDetail(region, uid, options = {}) {
	const account = uid.trim();
	if (account === "") return void 0;
	const lookup = lookupOf(options);
	const now = lookup.now();
	const memoryTtlMs = options.memoryCacheTtlMs ?? 18e5;
	const remembered = rememberedResolution(region, memoryTtlMs, now);
	if (remembered !== void 0) return remembered;
	const cacheEnabled = identityCacheEnabled(lookup.env);
	const ttlMs = identityTtlMs(lookup.env);
	const cachePath = identityCachePath(lookup.home);
	const cached = cacheEnabled ? readCachedIdentity(region, cachePath) : void 0;
	if (cached !== void 0 && !identityExpired(cached, ttlMs, now)) {
		const resolution = {
			identity: identityOf(cached),
			source: "cache",
			cachedAt: cached.cachedAt,
			stale: false
		};
		rememberResolution(region, resolution, memoryTtlMs, now);
		return resolution;
	}
	const resolvedOptions = {
		...options,
		region
	};
	const exe = findRuntimeInfoBinary(resolvedOptions);
	if (exe !== void 0) {
		const voted = await sampleWithVote(exe, region, account, lookup.platform, options.spawnImpl ?? spawn);
		if (voted !== void 0) {
			const cachedAt = lookup.now();
			if (cacheEnabled) writeCachedIdentity(region, cacheEntryFrom(region, voted, cachedAt), cachePath);
			const resolution = {
				identity: identityOf(voted.sample),
				source: "component",
				cachedAt,
				stale: false
			};
			rememberResolution(region, resolution, memoryTtlMs, cachedAt);
			return resolution;
		}
	}
	if (cached !== void 0) {
		const resolution = {
			identity: identityOf(cached),
			source: "cache-stale",
			cachedAt: cached.cachedAt,
			stale: true
		};
		rememberResolution(region, resolution, memoryTtlMs, now);
		scheduleBackgroundRefresh(region, account, resolvedOptions, cachePath, cacheEnabled, lookup, memoryTtlMs);
		return resolution;
	}
}
/**
* Resolve the identity, discarding the provenance.
*
* The shape the check-in service consumes. Kept as a thin wrapper so callers
* that only need the three header values never learn about `stale`.
*/
async function resolveRiskIdentity(region, uid, options = {}) {
	return (await resolveRiskIdentityDetail(region, uid, options))?.identity;
}
/**
* Re-sample in the background after a stale cache was used.
*
* Deliberately not awaited: the caller has an identity in hand and a check-in to
* finish, and a re-sample that takes five spawns must not become a slower
* check-in. One re-sample per realm at a time — a burst of check-ins on the same
* machine is one reason to refresh, not ten.
*/
function scheduleBackgroundRefresh(region, account, options, cachePath, cacheEnabled, lookup, memoryTtlMs) {
	if (backgroundRefreshes.has(region)) return;
	const work = refreshInBackground(region, account, options, cachePath, cacheEnabled, lookup, memoryTtlMs);
	backgroundRefreshes.set(region, work);
	work.then(() => {
		backgroundRefreshes.delete(region);
	}, () => {
		backgroundRefreshes.delete(region);
	});
}
async function refreshInBackground(region, account, options, cachePath, cacheEnabled, lookup, memoryTtlMs) {
	try {
		const exe = findRuntimeInfoBinary(options);
		if (exe === void 0) return;
		const generation = resetGeneration;
		const voted = await sampleWithVote(exe, region, account, lookup.platform, options.spawnImpl ?? spawn);
		if (voted === void 0) return;
		if (generation !== resetGeneration) return;
		const cachedAt = lookup.now();
		if (cacheEnabled) writeCachedIdentity(region, cacheEntryFrom(region, voted, cachedAt), cachePath);
		rememberResolution(region, {
			identity: identityOf(voted.sample),
			source: "component",
			cachedAt,
			stale: false
		}, memoryTtlMs, cachedAt);
	} catch {}
}
/**
* The real hostname in a form safe to put in an HTTP header (§6.8).
*
* The campaign family declares itself as the desktop client, and the only
* verified working shape of that request carries the machine's REAL hostname —
* a derived one is unverified (R4). Real hostnames are not header-safe though:
* they can be non-ASCII, contain spaces, or carry control characters, any of
* which turns into a malformed request rather than an error anyone can act on.
* So: keep the value when it is already safe, else let IDNA translate it, else
* fall back to a slug plus a digest — which stays stable for the same host
* without leaking the name.
*/
function headerSafeHostname(name) {
	if (isHeaderSafeHostname(name)) return name;
	const idna = idnaHostname(name);
	if (idna !== void 0 && isHeaderSafeHostname(idna)) return idna.slice(0, maxHostnameChars);
	const slug = slugifyHostname(name);
	const digest = createHash("sha256").update(name).digest("hex").slice(0, 8);
	return (slug === "" ? digest : `${slug}-${digest}`).slice(0, maxHostnameChars);
}
/**
* The campaign hostname for this machine (§6.8, R4).
*
* `QODER_CAMPAIGN_DERIVED_HOSTNAME=1` (the privacy switch) is not handled here:
* it needs the account uid and the derived-id helpers, and it belongs to the
* code that builds the header set, not to identity resolution.
*/
function campaignHostname(options = {}) {
	return headerSafeHostname((options.hostnameImpl ?? hostname)());
}
function isHeaderSafeHostname(value) {
	if (value === "" || value.length > maxHostnameChars) return false;
	if (value !== value.trim()) return false;
	return /^[\u0020-\u007e]+$/.test(value);
}
function idnaHostname(value) {
	try {
		const host = new URL(`http://${value}`).hostname;
		return host === "" ? void 0 : host;
	} catch {
		return;
	}
}
function slugifyHostname(value) {
	return value.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32);
}
/** Remove duplicates while keeping the first occurrence's position. */
function dedupe(values) {
	return [...new Set(values)];
}
function startsWithBytes(bytes, prefix) {
	if (bytes.length < prefix.length) return false;
	return prefix.every((byte, index) => bytes[index] === byte);
}
function isRecord$1(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
//#endregion
//#region src/qoder/transport/device-seed.ts
/**
* The host-level seed that perturbs every account's device fingerprint.
*
* Per-account device ids are derived from the account id alone (see
* `device-identity.ts`), which is what makes them stable — and also what makes
* them impossible to change: an account whose fingerprint the upstream has
* learned keeps it forever. This file is the one input the user can rotate, and
* it is deliberately HOST level, next to the machine id and for the same
* reason spelled out in `machine-id.ts`: a profile-scoped seed would let two DSH
* profiles present one account as two different devices, which is the exact
* inconsistency that invites an anti-abuse flag rather than clearing one.
*
* Rotation is additive, never destructive: the file only ever holds a random
* string, so losing it is the same as never having rotated. The plugin's reset
* control writes it and then drops the cached job tokens, which is what makes
* the next request re-derive a new `Cosy-Machineid` / `Cosy-Machinehostname`.
*
* @module dsh-qoder-plugin/qoder/transport/device-seed
*/
/**
* Where the seed lives: `~/.dsh/qoder/device_seed`, beside the machine id.
*
* Not under the profile directory on purpose — see this module's header. A
* missing file is the normal, never-rotated state.
*/
function defaultDeviceSeedPath() {
	return join(homedir(), ".dsh", "qoder", "device_seed");
}
/**
* Read the current seed, or `undefined` when there is none.
*
* An unreadable or blank file is reported as "no seed" rather than as an error:
* a seed nobody can read must leave accounts on their historical fingerprints,
* never move them to a different one. That keeps a permissions accident from
* silently re-identifying every account.
*
* @param path - seed file location; overridable so tests stay hermetic.
*/
function readDeviceSeed(path = defaultDeviceSeedPath()) {
	try {
		if (!existsSync(path)) return void 0;
		const value = readFileSync(path, "utf8").trim();
		return value === "" ? void 0 : value;
	} catch {
		return;
	}
}
/**
* Mint a fresh seed, store it, and return it.
*
* Throws when the file cannot be written: the caller is a user-initiated reset,
* and reporting "reset done" while the next request would still derive the old
* fingerprint would be a lie.
*
* The write is tmp + rename, like every other file this plugin owns. A plain
* overwrite that dies mid-write leaves a zero-length seed, which reads back as
* "no seed" — silently returning every account to its historical fingerprint
* right after the user asked for a new one. The rename also makes a concurrent
* reader see either the old seed or the new one, never a half-written file.
* `0o600` because the seed is the one input that decides what the upstream is
* told about this machine: it belongs to the user, not to other local accounts.
*
* @param path - seed file location; overridable so tests stay hermetic.
* @returns the new seed, 32 lowercase hex characters.
*/
function rotateDeviceSeed(path = defaultDeviceSeedPath()) {
	const seed = randomBytes(16).toString("hex");
	mkdirSync(dirname(path), { recursive: true });
	const tmp = `${path}.tmp`;
	try {
		writeFileSync(tmp, seed, {
			encoding: "utf8",
			mode: 384
		});
		renameSync(tmp, path);
	} catch (error) {
		rmSync(tmp, { force: true });
		throw error;
	}
	return seed;
}
/** Minutes past midnight in UTC+8 for an instant, ignoring the host timezone. */
function utc8MinuteOfDay(nowMs) {
	const d = new Date(nowMs);
	const utc8 = new Date(d.getTime() + (d.getTimezoneOffset() + 480) * 6e4);
	return {
		date: utc8,
		minuteOfDay: utc8.getHours() * 60 + utc8.getMinutes()
	};
}
/**
* Which claim window an instant belongs to, as `YYYY-MM-DD` in UTC+8.
*
* The returned label is the date the window OPENED. So 2026-09-30 23:11 and
* 2026-10-01 00:44 both answer `2026-09-30`: one window, still open, still
* claimed.
*/
function getClaimWindowDateString(nowMs = Date.now(), windowMinute = 600) {
	const { date, minuteOfDay } = utc8MinuteOfDay(nowMs);
	if (minuteOfDay < windowMinute) date.setDate(date.getDate() - 1);
	return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}
//#endregion
//#region src/qoder/transport/checkin.ts
const defaultCheckInTimeoutMs = 15e3;
/**
* Privacy switch that replaces the real hostname with a derived one (§3 R4).
*
* The only verified working six-header shape carries the machine's REAL
* hostname, so that is the default. Users who consider the hostname identifying
* can opt into the derived form, but it has never been observed working against
* the upstream — the README says so, and this variable is why the alternative
* exists at all.
*/
const CAMPAIGN_DERIVED_HOSTNAME_ENV = "QODER_CAMPAIGN_DERIVED_HOSTNAME";
/**
* The header mode for the next request.
*
* Read per request rather than once at module load: it decides how many headers
* to send, not what the device is, so a long-running host may pick the switch up
* without a re-import and tests can flip it. Anything other than `six` — unset,
* empty, misspelled, `three` — means the shipped default, because a typo must
* degrade to the measured shape and never to the experimental one.
*/
function campaignMachineHeaderMode(env = process.env) {
	return env["QODER_CAMPAIGN_MACHINE_HEADERS"]?.trim().toLowerCase() === "six" ? "six" : "three";
}
function campaignDerivedHostnameEnabled(env = process.env) {
	const value = env[CAMPAIGN_DERIVED_HOSTNAME_ENV]?.trim().toLowerCase();
	return value === "1" || value === "true";
}
/**
* The identity headers a real desktop client sends, or an empty set.
*
* An absent identity is NOT silently equivalent to a present one: the
* international upstream withholds the daily campaign from a request without
* it, so the caller distinguishes the two and reports the absence rather than
* letting it look like "there is no campaign today".
*
* `three` mode sends exactly the three component-minted headers. `six` mode
* appends the mixed pair a reference implementation was observed using
* (§6.7) — derived `machineid`, real hostname, desktop-vocabulary `machineos` —
* and it must stay that exact combination: the point of the experiment is to
* test a shape that is known to work somewhere, not to invent a "3 native +
* 3 derived" hybrid nobody has ever sent.
*
* Without the account id the derived pair cannot be minted at all, so `six`
* degrades to `three` instead of sending a half-filled set: a request carrying
* `machineid` but not `machinehostname` is a combination with no evidence
* behind it, which is precisely what R1 forbids.
*
* `seed` is the host-level reset seed. It only perturbs the two derived values,
* so the three native headers keep the identity the signed component minted —
* and a reset retires the campaign fingerprint at the same moment it retires
* the inference one, instead of leaving the campaign path presenting the id the
* user just rotated away from.
*/
function riskHeaders(identity, uid, resolveSeed) {
	if (identity === void 0) return {};
	const native = {
		"cosy-machinetoken": identity.machineToken,
		"cosy-machinecode": identity.machineCode,
		"cosy-machinetype": identity.machineType
	};
	if (uid === void 0 || campaignMachineHeaderMode() !== "six") return native;
	const seed = resolveSeed();
	return {
		...native,
		"cosy-machineid": deriveMachineId(uid, void 0, seed),
		"cosy-machineos": campaignMachineOs,
		"cosy-machinehostname": campaignDerivedHostnameEnabled() ? deriveMachineHostname(uid, seed) : campaignHostname()
	};
}
/**
* Whether a thrown failure is the claim endpoint refusing the write with HTTP 409.
*
* 409 is the upstream's way of saying "this benefit is already accounted for
* or is no longer claimable", not "your request was malformed" and not "your
* credential is bad". The transport renders any non-2xx as
* `Failed to execute Qoder ClaimCampaign with status 409.`, which is the
* mechanism of the failure rather than its meaning, so the claim path is the
* only place that can turn it into an honest answer: the status is inspected
* here and the campaign list — the authoritative record of whether the benefit
* was granted — is re-read.
*
* Only 409 qualifies. Every other status keeps its existing behaviour
* (401/403 still reach the single token-heal retry; 5xx/429 still surface).
*/
function isClaimConflict(error) {
	return error instanceof QoderLlmError && error.failure.status === 409;
}
/**
* When a claimed package expires, in epoch milliseconds; undefined when the
* upstream stated neither an absolute moment nor a validity window.
*
* Two sources, in order of authority: the claim's own `expiresAt` (an ISO
* string, what the upstream returns for the grant it just made) and the
* campaign's `validity.days` counted from the claim. Neither is invented — a
* plugin that guessed a 30-day window would print a confident wrong date the
* day Qoder changes its campaign.
*/
function resolveExpiryMs(claimExpiresAt, validity, claimedAtMs) {
	if (typeof claimExpiresAt === "string" && claimExpiresAt.trim() !== "") {
		const parsed = Date.parse(claimExpiresAt);
		if (!Number.isNaN(parsed) && parsed > 0) return parsed;
	}
	const days = validity?.days;
	if (typeof days === "number" && Number.isFinite(days) && days > 0) return claimedAtMs + days * 24 * 60 * 60 * 1e3;
}
var QoderCheckInService = class {
	authService;
	fetchImpl;
	region;
	variantId;
	logger;
	timeoutMs;
	riskIdentity;
	resolveDeviceSeed;
	windowMinute;
	constructor(options) {
		this.authService = options.authService;
		this.fetchImpl = options.fetch ?? globalThis.fetch;
		this.region = options.region ?? "china";
		this.variantId = options.variantId ?? "qoder";
		this.logger = options.logger;
		this.timeoutMs = options.timeoutMs ?? defaultCheckInTimeoutMs;
		this.riskIdentity = options.riskIdentity ?? resolveRiskIdentity;
		this.resolveDeviceSeed = options.resolveDeviceSeed ?? readDeviceSeed;
		this.windowMinute = options.windowMinute ?? 600;
	}
	/**
	* @param identity the component-minted identity, or undefined when this machine has none
	* @param uid the signed-in account id; `six` mode needs it to derive `machineid`
	*/
	async fetchCampaigns(token, signal, identity, uid) {
		const url = getQoderCampaignsUrl(this.region);
		const data = await openApiJsonRequest(this.fetchImpl, {
			url,
			token,
			headers: {
				"cosy-clienttype": "10",
				...riskHeaders(identity, uid, this.resolveDeviceSeed)
			},
			fingerprint: "campaign",
			signal,
			timeoutMs: this.timeoutMs,
			logger: this.logger,
			operation: "Campaigns",
			logCategory: "campaigns.list"
		});
		return Array.isArray(data?.campaigns) ? data.campaigns : [];
	}
	/** @param uid the signed-in account id; `six` mode needs it to derive `machineid` */
	async claimCampaign(token, campaignId, signal, identity, uid) {
		const url = getQoderClaimCampaignUrl(this.region, campaignId);
		const { openApiUrl } = resolveQoderEndpoints(this.region);
		return openApiJsonRequest(this.fetchImpl, {
			url,
			method: "POST",
			token,
			headers: {
				origin: openApiUrl,
				"cosy-clienttype": "10",
				...riskHeaders(identity, uid, this.resolveDeviceSeed)
			},
			fingerprint: "campaign",
			signal,
			timeoutMs: this.timeoutMs,
			logger: this.logger,
			operation: "ClaimCampaign",
			logCategory: "campaigns.claim"
		});
	}
	/**
	* Which daily claim window an instant belongs to, as `YYYY-MM-DD` in UTC+8.
	*
	* Deliberately NOT the calendar date. The upstream opens a window every day
	* at 10:00 UTC+8 and closes it just before 10:00 the next morning, so the
	* hours between midnight and 10:00 belong to the window that opened the
	* previous day. Stamping a claim made at 23:11 with the calendar date of the
	* following midnight made every date comparison disagree with the window the
	* claim actually belonged to, which re-armed the claim button hours before a
	* new benefit was available. The scheduler compares against the same rule.
	*/
	getTodayDateString(nowMs = Date.now()) {
		return getClaimWindowDateString(nowMs, this.windowMinute);
	}
	async checkIn(pat, signal) {
		const today = this.getTodayDateString();
		const nowMs = Date.now();
		if (!pat || typeof pat !== "string" || pat.trim() === "") return {
			variantId: this.variantId,
			date: today,
			timestamp: nowMs,
			status: "error",
			message: "No PAT available"
		};
		const executeWithToken = async (authToken, uid) => {
			const identity = await this.riskIdentity(this.region, uid);
			if (identity === void 0 && this.region === "global") return {
				variantId: this.variantId,
				date: today,
				timestamp: nowMs,
				status: "error",
				reasonCode: "no-client",
				message: "No Qoder desktop client found on this machine, so the daily campaign cannot be requested. Install Qoder (international) and retry."
			};
			const benefitCampaign = (await this.fetchCampaigns(authToken, signal, identity, uid)).find((c) => c.actionType === "CLAIM_BENEFIT");
			if (!benefitCampaign) return {
				variantId: this.variantId,
				date: today,
				timestamp: nowMs,
				status: "no-campaign",
				message: "No claimable benefit campaign found for this region"
			};
			if (benefitCampaign.claimStatus === "CLAIMED") {
				const expiresAtMs = resolveExpiryMs(void 0, benefitCampaign.benefit?.validity, nowMs);
				return {
					variantId: this.variantId,
					date: today,
					timestamp: nowMs,
					status: "already-claimed",
					campaignKey: benefitCampaign.campaignKey,
					amount: benefitCampaign.benefit?.amount ?? 100,
					message: "Already claimed today",
					...expiresAtMs === void 0 ? {} : { expiresAtMs }
				};
			}
			let claimResult;
			try {
				claimResult = await this.claimCampaign(authToken, benefitCampaign.campaignId, signal, identity, uid);
			} catch (claimError) {
				if (!isClaimConflict(claimError)) throw claimError;
				let settled;
				let settledListRead = false;
				try {
					settled = (await this.fetchCampaigns(authToken, signal, identity, uid)).find((c) => c.actionType === "CLAIM_BENEFIT");
					settledListRead = true;
				} catch (readError) {
					this.logger?.warn?.(`[Qoder CheckIn] Claim conflict, campaign re-read failed: ${readError instanceof Error ? readError.message : String(readError)}`);
				}
				if (settledListRead && settled?.claimStatus === "CLAIMED") {
					const expiresAtMs = resolveExpiryMs(void 0, settled.benefit?.validity, nowMs);
					this.logger?.warn?.("[Qoder CheckIn] Claim conflict resolved as already-claimed by the campaign read");
					return {
						variantId: this.variantId,
						date: today,
						timestamp: nowMs,
						status: "already-claimed",
						campaignKey: settled.campaignKey ?? benefitCampaign.campaignKey,
						amount: settled.benefit?.amount ?? benefitCampaign.benefit?.amount ?? 100,
						message: "Already claimed today",
						...expiresAtMs === void 0 ? {} : { expiresAtMs }
					};
				}
				const observed = settled === void 0 ? settledListRead ? "the campaign is no longer listed" : "the campaign list could not be re-read" : `the campaign still reports ${settled.claimStatus ?? "an unknown status"}`;
				this.logger?.warn?.(`[Qoder CheckIn] Claim refused with 409; ${observed}`);
				return {
					variantId: this.variantId,
					date: today,
					timestamp: nowMs,
					status: "error",
					reasonCode: "claim-conflict",
					campaignKey: settled?.campaignKey ?? benefitCampaign.campaignKey,
					message: `Qoder refused the daily benefit claim as a conflict and ${observed}, so no credits were granted. Retry once the campaign shows a claimable benefit.`
				};
			}
			const isClaimed = claimResult.status === "CLAIMED";
			const replayed = Boolean(claimResult.replayed);
			const amount = claimResult.benefit?.amount ?? benefitCampaign.benefit?.amount ?? 100;
			if (isClaimed) {
				const expiresAtMs = resolveExpiryMs(claimResult.expiresAt, benefitCampaign.benefit?.validity, nowMs);
				return {
					variantId: this.variantId,
					date: today,
					timestamp: nowMs,
					status: replayed ? "already-claimed" : "claimed",
					amount,
					campaignKey: benefitCampaign.campaignKey,
					message: replayed ? "Already claimed today" : `Successfully claimed ${amount} credits`,
					...expiresAtMs === void 0 ? {} : { expiresAtMs }
				};
			}
			return {
				variantId: this.variantId,
				date: today,
				timestamp: nowMs,
				status: "error",
				campaignKey: benefitCampaign.campaignKey,
				message: `Claim returned status ${claimResult.status ?? "unknown"}`
			};
		};
		try {
			const creds = await this.authService.getCredentials(pat, signal);
			try {
				return await executeWithToken(creds.authToken, creds.userID);
			} catch (innerError) {
				if (isQoderAuthRejection(innerError)) {
					this.logger?.warn?.(`[Qoder CheckIn] Auth token rejected, retrying with fresh exchange`);
					const freshCreds = await this.authService.exchangeFresh(pat, signal);
					return await executeWithToken(freshCreds.authToken, freshCreds.userID);
				}
				throw innerError;
			}
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			this.logger?.error?.(`[Qoder CheckIn] Check-in failed: ${message}`);
			return {
				variantId: this.variantId,
				date: today,
				timestamp: nowMs,
				status: "error",
				message
			};
		}
	}
};
//#endregion
//#region src/qoder/transport/wire/encoding.ts
/**
* Qoder WAF Body encoding algorithm.
*
* Re-arranges standard Base64 chunks and translates characters against
* a custom alphabet to satisfy Qoder upstream WAF requirements.
*
* The translation runs through a byte table applied to a Buffer instead of a
* per-character string loop. The loop form (`out += char` plus
* `alphabet.indexOf(char)`) costs ~800 ms on a 1 MB body and runs on the main
* thread once per model request, which saturated the Harness event loop as
* soon as a few large-context sessions were in flight. The table form is
* byte-for-byte identical (the input is always Base64, i.e. ASCII) and about
* 24x faster.
*
* @module dsh-qoder-plugin/qoder/transport/wire/encoding
*/
const qoderCustomAlphabet = "_doRTgHZBKcGVjlvpC,@aFSx#DPuNJme&i*MzLOEn)sUrthbf%Y^w.(kIQyXqWA!";
const qoderStdAlphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
/**
* Byte translation table: every byte maps to itself unless it is a Base64
* alphabet character (→ the custom alphabet) or the `=` pad (→ `$`).
*/
const encodeTable = (() => {
	const table = /* @__PURE__ */ new Uint8Array(256);
	for (let index = 0; index < 256; index++) table[index] = index;
	for (let index = 0; index < 64; index++) table[qoderStdAlphabet.charCodeAt(index)] = qoderCustomAlphabet.charCodeAt(index);
	table["=".charCodeAt(0)] = "$".charCodeAt(0);
	return table;
})();
function qoderEncodeBody(plaintext) {
	const std = Buffer.isBuffer(plaintext) ? plaintext.toString("base64") : Buffer.from(plaintext).toString("base64");
	const n = std.length;
	const a = Math.floor(n / 3);
	const rearranged = std.slice(n - a) + std.slice(a, n - a) + std.slice(0, a);
	const source = Buffer.from(rearranged, "latin1");
	const target = Buffer.allocUnsafe(n);
	for (let index = 0; index < n; index++) target[index] = encodeTable[source[index] ?? 0] ?? 0;
	return target.toString("latin1");
}
//#endregion
//#region src/qoder/transport/wire/thinking.ts
const thinkingTags = [{
	open: "<thinking>",
	close: "</thinking>"
}, {
	open: "<think>",
	close: "</think>"
}];
const allTags = thinkingTags.flatMap((tag) => [tag.open, tag.close]);
function trailingPrefixLength(text, candidates) {
	let best = 0;
	for (const candidate of candidates) {
		const limit = Math.min(text.length, candidate.length - 1);
		for (let length = limit; length > best; length--) if (text.endsWith(candidate.slice(0, length))) {
			best = length;
			break;
		}
	}
	return best;
}
function earliestTag(text, kind) {
	let found;
	for (const tag of thinkingTags) {
		const position = text.indexOf(tag[kind]);
		if (position !== -1 && (found === void 0 || position < found.position)) found = {
			position,
			tag
		};
	}
	return found;
}
function trimSeparator(text) {
	if (text.startsWith("\n\n")) return text.slice(2);
	if (text.startsWith("\n")) return text.slice(1);
	return text;
}
var NativeReasoningStripper = class {
	buffer = "";
	push(chunk) {
		this.buffer += chunk;
		let output = "";
		while (this.buffer) {
			let firstPosition = -1;
			let firstTag = "";
			for (const tag of allTags) {
				const position = this.buffer.indexOf(tag);
				if (position !== -1 && (firstPosition === -1 || position < firstPosition)) {
					firstPosition = position;
					firstTag = tag;
				}
			}
			if (firstPosition !== -1) {
				output += this.buffer.slice(0, firstPosition);
				this.buffer = this.buffer.slice(firstPosition + firstTag.length);
				continue;
			}
			const held = trailingPrefixLength(this.buffer, allTags);
			output += this.buffer.slice(0, this.buffer.length - held);
			this.buffer = this.buffer.slice(this.buffer.length - held);
			break;
		}
		return output;
	}
	finish() {
		const output = allTags.some((tag) => tag.startsWith(this.buffer)) ? "" : this.buffer;
		this.buffer = "";
		return output;
	}
};
var QoderThinkingParser = class {
	buffer = "";
	mode = "text";
	closingTag = thinkingTags[0].close;
	native = new NativeReasoningStripper();
	pushReasoning(chunk) {
		const text = this.native.push(chunk);
		return text ? [{
			type: "reasoning",
			text
		}] : [];
	}
	pushContent(chunk) {
		const output = [];
		const pendingReasoning = this.native.finish();
		if (pendingReasoning) output.push({
			type: "reasoning",
			text: pendingReasoning
		});
		this.buffer += chunk;
		while (this.buffer) {
			if (this.mode === "reasoning") {
				const closeAt = this.buffer.indexOf(this.closingTag);
				if (closeAt !== -1) {
					if (closeAt > 0) output.push({
						type: "reasoning",
						text: this.buffer.slice(0, closeAt)
					});
					this.buffer = trimSeparator(this.buffer.slice(closeAt + this.closingTag.length));
					this.mode = "text";
					continue;
				}
				const held = trailingPrefixLength(this.buffer, [this.closingTag]);
				const safeLength = this.buffer.length - held;
				if (safeLength > 0) output.push({
					type: "reasoning",
					text: this.buffer.slice(0, safeLength)
				});
				this.buffer = this.buffer.slice(safeLength);
				break;
			}
			const opener = earliestTag(this.buffer, "open");
			const closer = earliestTag(this.buffer, "close");
			if (opener !== void 0 && (closer === void 0 || opener.position < closer.position)) {
				if (opener.position > 0) output.push({
					type: "text",
					text: this.buffer.slice(0, opener.position)
				});
				this.buffer = this.buffer.slice(opener.position + opener.tag.open.length);
				this.closingTag = opener.tag.close;
				this.mode = "reasoning";
				continue;
			}
			if (closer !== void 0) {
				if (closer.position > 0) output.push({
					type: "text",
					text: this.buffer.slice(0, closer.position)
				});
				this.buffer = trimSeparator(this.buffer.slice(closer.position + closer.tag.close.length));
				continue;
			}
			const held = trailingPrefixLength(this.buffer, allTags);
			const safeLength = this.buffer.length - held;
			if (safeLength > 0) output.push({
				type: "text",
				text: this.buffer.slice(0, safeLength)
			});
			this.buffer = this.buffer.slice(safeLength);
			break;
		}
		return output;
	}
	finish() {
		const output = [];
		const pendingReasoning = this.native.finish();
		if (pendingReasoning) output.push({
			type: "reasoning",
			text: pendingReasoning
		});
		if (this.buffer) output.push({
			type: this.mode,
			text: this.buffer
		});
		this.buffer = "";
		return output;
	}
};
//#endregion
//#region src/qoder/transport/wire/inner-errors.ts
/**
* Observability for errors the upstream reports *inside* a 200 SSE stream.
*
* Qoder accepts the chat request (HTTP 200) and then narrates the real failure
* as an inner chunk: a content-policy refusal, a queue/throttle notice, or an
* auth complaint. The decoder used to read those frames only for `choices`, so
* the error text was silently dropped — the request simply ended without an
* answer and nothing in the log named the reason. This module makes that
* failure mode visible by classifying and counting the inner errors.
*
* It observes and counts, it never decides. A stream that has already delivered
* bytes has handed content to the host, so it must not be retried or turned
* into an error by the transport; only the classes and counts are exposed. The
* same classification also feeds the first (and only) WARN that a stream emits
* for a class, which keeps a repetitive error from flooding the log.
*
* Counters are process-wide and in memory, on purpose: they describe this
* process's recent traffic, and a restart genuinely has no observations.
*
* @module dsh-qoder-plugin/qoder/transport/wire/inner-errors
*/
const counters = {
	content_policy: 0,
	rate_limit: 0,
	invalid_request: 0,
	auth: 0,
	other: 0
};
const maxMessageLength = 300;
function sanitize(text) {
	return (text.length > maxMessageLength ? `${text.slice(0, maxMessageLength)}…` : text).replace(tokenValue, "[REDACTED]").replace(bearerValue, "Bearer [REDACTED]");
}
/** Record one occurrence. Called for every chunk, including repeats. */
function recordQoderInnerError(classification) {
	counters[classification] += 1;
}
/** Read-only process-wide snapshot, for health/status channels and tests. */
function qoderInnerErrorSnapshot() {
	return { ...counters };
}
function asRecord(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value) ? value : void 0;
}
function pickCode(value) {
	if (typeof value === "string" || typeof value === "number") return value;
}
/**
* Pull the error facts out of an inner chunk.
*
* Qoder's payloads are not uniform: the same failure arrives as `error` (string
* or object), as `errorCode`/`code` with an optional `message`, or folded into
* a JSON string inside `message`. All of those shapes are read here so the
* classification downstream is about the failure, not about which spelling it
* used.
*/
function readQoderInnerError(chunk) {
	const errorValue = chunk.error;
	const errorObject = asRecord(errorValue) ?? asRecord(asRecord(chunk.detail)?.error);
	const hasError = typeof errorValue === "string" ? errorValue.trim() !== "" : errorObject !== void 0 && Object.keys(errorObject).length > 0;
	const code = pickCode(chunk.errorCode) ?? pickCode(chunk.code) ?? pickCode(errorObject?.code);
	const rawMessage = typeof errorValue === "string" ? errorValue : errorObject?.message ?? chunk.message ?? chunk.msg ?? chunk.error_msg;
	const message = typeof rawMessage === "string" ? rawMessage : "";
	if (!hasError && !(code !== void 0 && code !== 0 && code !== "0")) return void 0;
	if (!hasError && chunk.choices !== void 0) return void 0;
	return {
		...code === void 0 ? {} : { code },
		message: sanitize(message),
		...typeof errorObject?.type === "string" ? { type: errorObject.type } : {}
	};
}
function numericCode(code) {
	if (typeof code === "number") return code;
	if (code === void 0) return void 0;
	const parsed = Number(code);
	return Number.isFinite(parsed) ? parsed : void 0;
}
/**
* Classify one inner error.
*
* Order matters: an auth-looking word inside a content-policy refusal should
* still read as a refusal, and the queue code 10605 is the upstream's throttle
* marker even though it travels in a 200 stream. Unknown spellings land in
* `other` rather than being guessed into a class that would trigger a retry.
*/
function classifyQoderInnerError(fields) {
	const code = numericCode(fields.code);
	const text = `${fields.type ?? ""} ${fields.message}`.toLowerCase();
	if (fields.type === "content_filter" || /content[_ -]?polic|content[_ -]?filter|moderation|data[_ -]?inspection|inappropriate content|sensitive[_ -]?content|敏感|违规/u.test(text)) return "content_policy";
	if (code === 10605 || code === 429 || /rate.?limit|too many requests|throttl|is[_ -]?queued|"queued"|queue|quota|saturat|overloaded/u.test(text)) return "rate_limit";
	if (code === 401 || code === 403 || /unauthor|forbidden|permission|expired|token|invalid api key|api key/u.test(text)) return "auth";
	if (code === 400 || code === 404 || code === 405 || code === 422 || /invalid|unsupported|malformed|missing (?:required )?parameter|must be a response|provider[_ -]?error|not found|参数/u.test(text)) return "invalid_request";
	return "other";
}
/** Detect, classify, and sanitize one inner chunk. Returns `undefined` when clean. */
function detectQoderInnerError(chunk) {
	const fields = readQoderInnerError(chunk);
	if (fields === void 0) return void 0;
	return {
		classification: classifyQoderInnerError(fields),
		...fields.code === void 0 ? {} : { code: fields.code },
		message: fields.message
	};
}
//#endregion
//#region src/qoder/transport/wire/sse.ts
/** Decode Qoder's outer SSE envelope and inner model chunks. */
const doneMarker = "[DONE]";
function malformed(message) {
	return new QoderLlmError(message, "MALFORMED_RESPONSE");
}
function parseEnvelope(rawData) {
	let value;
	try {
		value = JSON.parse(rawData);
	} catch {
		throw malformed("Malformed outer SSE JSON payload received from Qoder.");
	}
	if (value === null || typeof value !== "object") throw malformed("Malformed outer SSE envelope received from Qoder.");
	const envelope = value;
	if (envelope.statusCodeValue !== void 0 && typeof envelope.statusCodeValue !== "number") throw malformed("Qoder SSE envelope has an invalid status code.");
	if (envelope.statusCodeValue !== void 0 && (!Number.isInteger(envelope.statusCodeValue) || envelope.statusCodeValue < 100 || envelope.statusCodeValue > 599)) throw malformed("Qoder SSE envelope has an invalid status code.");
	if (envelope.statusCodeValue !== void 0 && envelope.statusCodeValue !== 200) {
		const status = envelope.statusCodeValue;
		throw qoderHttpError(envelope.body ? `Qoder service returned upstream error status ${status}: ${envelope.body}` : `Qoder service returned upstream error status ${status}.`, { status }, envelope.body);
	}
	if (envelope.body !== void 0 && typeof envelope.body !== "string") throw malformed("Qoder SSE envelope has an invalid model body.");
	return envelope;
}
function parseInner(body) {
	try {
		const value = JSON.parse(body);
		if (value === null || typeof value !== "object") throw new Error("not an object");
		return value;
	} catch {
		throw malformed("Malformed inner model payload received from Qoder.");
	}
}
function tokenUsage(innerChunk) {
	if (!innerChunk.usage) return void 0;
	const usage = innerChunk.usage;
	const promptTokens = usage.prompt_tokens ?? 0;
	const cacheReadTokens = usage.prompt_tokens_details?.cached_tokens ?? 0;
	const cacheWriteTokens = usage.prompt_tokens_details?.cache_write_tokens ?? 0;
	const reasoningTokens = usage.completion_tokens_details?.reasoning_tokens;
	return {
		inputTokens: Math.max(0, promptTokens - cacheReadTokens - cacheWriteTokens),
		outputTokens: usage.completion_tokens ?? 0,
		...cacheReadTokens > 0 ? { cacheReadTokens } : {},
		...cacheWriteTokens > 0 ? { cacheWriteTokens } : {},
		...reasoningTokens === void 0 ? {} : { reasoningTokens }
	};
}
function finishKind(value) {
	if (value === void 0 || value === null || value === "") return void 0;
	if (value === "stop") return "stop";
	if (value === "length") return "max-tokens";
	if (value === "tool_calls" || value === "toolUse") return "tool-calls";
	if (value === "content_filter") throw new QoderLlmError("Qoder blocked the response through its content filter.", "PROVIDER_ERROR");
	throw malformed(`Qoder returned unknown finish reason "${value}".`);
}
async function* parseQoderSse(stream, options = {}) {
	const reader = stream.getReader();
	const decoder = new TextDecoder();
	const thinkingParser = new QoderThinkingParser();
	const toolCalls = /* @__PURE__ */ new Map();
	let buffer = "";
	let sourceEnded = false;
	let sawDone = false;
	let nextBlockIndex = 0;
	let activeTextual;
	let pendingUsage;
	let terminalKind = "stop";
	let sawContent = false;
	const maxBufferChars = options.maxBufferChars ?? 2097152;
	const warnedInnerErrorClasses = /* @__PURE__ */ new Set();
	const closeTextual = () => {
		if (activeTextual === void 0) return [];
		const state = activeTextual;
		activeTextual = void 0;
		return [{
			type: "block-end",
			index: state.index,
			block: state.type === "text" ? {
				type: "text",
				text: state.text
			} : {
				type: "reasoning",
				text: state.text
			}
		}];
	};
	const appendSegment = (segment) => {
		if (!segment.text) return [];
		const chunks = [];
		sawContent = true;
		if (activeTextual?.type !== segment.type) {
			chunks.push(...closeTextual());
			activeTextual = {
				type: segment.type,
				index: nextBlockIndex++,
				text: ""
			};
			chunks.push({
				type: "block-start",
				index: activeTextual.index,
				blockType: segment.type
			});
		}
		activeTextual.text += segment.text;
		chunks.push(segment.type === "text" ? {
			type: "text-delta",
			index: activeTextual.index,
			text: segment.text
		} : {
			type: "reasoning-delta",
			index: activeTextual.index,
			text: segment.text
		});
		return chunks;
	};
	const openToolCall = (state) => {
		if (!state.id || state.blockIndex !== void 0) return [];
		const chunks = closeTextual();
		state.blockIndex = nextBlockIndex++;
		sawContent = true;
		chunks.push({
			type: "block-start",
			index: state.blockIndex,
			blockType: "tool-call"
		});
		const argumentsDelta = state.arguments.slice(state.emittedArguments);
		state.emittedArguments = state.arguments.length;
		chunks.push({
			type: "tool-call-delta",
			index: state.blockIndex,
			id: ToolCallId(state.id),
			...state.name ? { name: state.name } : {},
			argumentsDelta
		});
		return chunks;
	};
	try {
		while (!sourceEnded && !sawDone) {
			const { done, value } = await reader.read();
			if (done) {
				sourceEnded = true;
				buffer += decoder.decode();
				if (buffer.length > 0 && !buffer.endsWith("\n")) buffer += "\n";
			} else {
				options.onActivity?.();
				buffer += decoder.decode(value, { stream: true });
				if (buffer.length > maxBufferChars) throw malformed("Qoder SSE frame exceeded its size limit.");
			}
			while (!sawDone) {
				const lineEnd = buffer.indexOf("\n");
				if (lineEnd === -1) break;
				let line = buffer.substring(0, lineEnd);
				buffer = buffer.substring(lineEnd + 1);
				if (line.endsWith("\r")) line = line.slice(0, -1);
				line = line.trim();
				if (!line.startsWith("data:")) continue;
				const rawData = line.substring(5).trim();
				if (!rawData) continue;
				if (rawData === doneMarker) {
					sawDone = true;
					break;
				}
				const body = parseEnvelope(rawData).body?.trim();
				if (!body) continue;
				if (body === doneMarker) {
					sawDone = true;
					break;
				}
				const innerChunk = parseInner(body);
				const innerError = detectQoderInnerError(innerChunk);
				if (innerError !== void 0) {
					recordQoderInnerError(innerError.classification);
					if (!warnedInnerErrorClasses.has(innerError.classification)) {
						warnedInnerErrorClasses.add(innerError.classification);
						try {
							options.onInnerError?.(innerError);
						} catch {}
					}
				}
				pendingUsage = tokenUsage(innerChunk) ?? pendingUsage;
				for (const choice of innerChunk.choices ?? []) {
					terminalKind = finishKind(choice.finish_reason) ?? terminalKind;
					const delta = choice.delta;
					if (!delta) continue;
					if (typeof delta.reasoning_content === "string" && delta.reasoning_content) for (const segment of thinkingParser.pushReasoning(delta.reasoning_content)) for (const chunk of appendSegment(segment)) yield chunk;
					if (typeof delta.content === "string" && delta.content) for (const segment of thinkingParser.pushContent(delta.content)) for (const chunk of appendSegment(segment)) yield chunk;
					if (delta.tool_calls !== void 0) {
						if (!Array.isArray(delta.tool_calls)) throw malformed("Qoder tool-call delta is not an array.");
						for (const rawCall of delta.tool_calls) {
							if (typeof rawCall !== "object" || rawCall === null || Array.isArray(rawCall)) throw malformed("Qoder tool-call delta is not an object.");
							const upstreamIndex = rawCall.index ?? 0;
							if (!Number.isInteger(upstreamIndex) || upstreamIndex < 0) throw malformed("Qoder tool-call delta has an invalid index.");
							let state = toolCalls.get(upstreamIndex);
							if (state === void 0) {
								state = {
									id: "",
									name: "",
									arguments: "",
									emittedArguments: 0
								};
								toolCalls.set(upstreamIndex, state);
							}
							if (rawCall.id !== void 0) {
								if (rawCall.id === "" || rawCall.id === null) {} else if (typeof rawCall.id !== "string") throw malformed("Qoder tool call has an invalid id.");
								else {
									if (state.id && state.id !== rawCall.id) throw malformed("Qoder changed a streamed tool-call id.");
									state.id = rawCall.id;
								}
							}
							let hasNewName = false;
							if (rawCall.function?.name !== void 0) {
								const name = rawCall.function.name;
								if (name === "" || name === null) {} else if (typeof name !== "string") throw malformed("Qoder tool call has an invalid name.");
								else {
									if (state.name && state.name !== name) throw malformed("Qoder changed a streamed tool-call name.");
									if (state.name !== name) {
										state.name = name;
										hasNewName = true;
									}
								}
							}
							if (rawCall.function?.arguments !== void 0) {
								if (typeof rawCall.function.arguments !== "string") throw malformed("Qoder tool-call arguments delta is not a string.");
								state.arguments += rawCall.function.arguments;
							}
							const wasOpen = state.blockIndex !== void 0;
							for (const chunk of openToolCall(state)) yield chunk;
							if (wasOpen && state.blockIndex !== void 0 && state.emittedArguments < state.arguments.length) {
								const argumentsDelta = state.arguments.slice(state.emittedArguments);
								state.emittedArguments = state.arguments.length;
								yield {
									type: "tool-call-delta",
									index: state.blockIndex,
									id: ToolCallId(state.id),
									...state.name ? { name: state.name } : {},
									argumentsDelta
								};
							} else if (wasOpen && state.blockIndex !== void 0 && hasNewName) yield {
								type: "tool-call-delta",
								index: state.blockIndex,
								id: ToolCallId(state.id),
								name: state.name,
								argumentsDelta: ""
							};
						}
					}
				}
			}
		}
	} finally {
		await reader.cancel().catch(() => void 0);
		reader.releaseLock();
	}
	if (!sawDone) throw new QoderLlmError("SSE stream ended prematurely without [DONE].", "TRANSPORT");
	for (const segment of thinkingParser.finish()) for (const chunk of appendSegment(segment)) yield chunk;
	for (const chunk of closeTextual()) yield chunk;
	for (const [, state] of [...toolCalls.entries()].sort(([left], [right]) => left - right)) {
		if (!state.id || !state.name) throw malformed("Qoder completed an unidentifiable tool call.");
		const normalizedArguments = state.arguments.trim() ? state.arguments : "{}";
		try {
			JSON.parse(normalizedArguments);
		} catch {
			throw malformed(`Qoder completed tool call "${state.name}" with malformed JSON arguments.`);
		}
		for (const chunk of openToolCall(state)) yield chunk;
		if (state.blockIndex === void 0) throw malformed("Qoder failed to open a completed tool call.");
		if (state.emittedArguments === 0 && normalizedArguments === "{}") yield {
			type: "tool-call-delta",
			index: state.blockIndex,
			id: ToolCallId(state.id),
			name: state.name,
			argumentsDelta: "{}"
		};
		yield {
			type: "block-end",
			index: state.blockIndex,
			block: {
				type: "tool-call",
				id: ToolCallId(state.id),
				name: state.name,
				arguments: normalizedArguments
			}
		};
	}
	if (pendingUsage) yield {
		type: "usage",
		usage: pendingUsage
	};
	if (!sawContent) {
		yield {
			type: "finish",
			reason: {
				kind: "error",
				failure: {
					message: "Model returned a completed response with no content.",
					code: EMPTY_RESPONSE_CODE
				}
			}
		};
		return;
	}
	yield {
		type: "finish",
		reason: { kind: toolCalls.size > 0 ? "tool-calls" : terminalKind }
	};
}
//#endregion
//#region src/qoder/transport/chat.ts
/** Qoder chat request encoding, timeout lifecycle, and SSE streaming. */
function aborted$1(message) {
	return new QoderLlmError(message, "ABORTED");
}
async function* streamQoderChat(options, model, credentials, messages, dependencies) {
	const request = await buildQoderRequestBody(options, credentials.userID, messages, model);
	const encodedBody = qoderEncodeBody(JSON.stringify(request));
	const encodedBytes = Buffer.from(encodedBody, "utf8");
	const chatUrl = getQoderChatUrl(dependencies.region);
	const requestController = new AbortController();
	let headerTimedOut = false;
	let idleTimedOut = false;
	let idleTimer;
	let chunkCount = 0;
	let reqId;
	const startedAt = performance.now();
	let lastActivityAt = startedAt;
	const onCallerAbort = () => requestController.abort(options.signal?.reason);
	options.signal?.addEventListener("abort", onCallerAbort, { once: true });
	const headerTimer = setTimeout(() => {
		headerTimedOut = true;
		requestController.abort("response header timeout");
	}, dependencies.responseHeaderTimeoutMs);
	const resetIdleTimer = () => {
		lastActivityAt = performance.now();
		if (idleTimer !== void 0) clearTimeout(idleTimer);
		idleTimer = setTimeout(() => {
			idleTimedOut = true;
			requestController.abort("stream idle timeout");
		}, dependencies.streamIdleTimeoutMs);
	};
	try {
		const response = await dependencies.fetch(chatUrl, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				"accept": "text/event-stream",
				"cache-control": "no-cache",
				"accept-encoding": "identity",
				"x-model-key": options.model || "cmodel",
				"x-model-source": model?.source || "system",
				...attributionHeaders(),
				...buildAuthHeaders(encodedBytes, chatUrl, credentials, { includeMachineHostname: true })
			},
			body: encodedBytes,
			signal: requestController.signal
		});
		clearTimeout(headerTimer);
		reqId = qoderRequestId(response.headers);
		dependencies.logger?.debug?.("[Qoder Stream] Response headers received", {
			region: dependencies.region,
			status: response.status,
			durationMs: Math.round(performance.now() - startedAt),
			...reqId === void 0 ? {} : { requestId: reqId }
		});
		resetIdleTimer();
		if (!response.ok) {
			let errorBody;
			try {
				errorBody = await readLimitedText(response, defaultMaxErrorBytes, "Qoder chat error response");
			} catch {
				errorBody = void 0;
			}
			throw qoderHttpError(`Qoder upstream service returned HTTP ${response.status}.`, response, errorBody);
		}
		if (!response.body) throw new QoderLlmError("Qoder response contains no readable body stream.", "EMPTY_RESPONSE");
		let firstChunkDurationMs;
		let tokenUsage;
		let finishReason;
		const streamStartedAt = performance.now();
		for await (const chunk of parseQoderSse(response.body, {
			onActivity: resetIdleTimer,
			onInnerError: (report) => {
				dependencies.logger?.warn?.("[Qoder Stream] Inner error in stream", redactLogValue({
					...report,
					...reqId === void 0 ? {} : { requestId: reqId }
				}));
			}
		})) {
			chunkCount++;
			if (firstChunkDurationMs === void 0) {
				firstChunkDurationMs = Math.round(performance.now() - startedAt);
				dependencies.logger?.debug?.("[Qoder Stream] First chunk received", {
					durationMs: firstChunkDurationMs,
					...reqId === void 0 ? {} : { requestId: reqId }
				});
			}
			if (chunk.type === "usage") tokenUsage = chunk.usage;
			if (chunk.type === "finish") finishReason = chunk.reason.kind;
			yield chunk;
		}
		dependencies.logger?.debug?.("[Qoder Stream] Stream completed", {
			durationMs: Math.round(performance.now() - startedAt),
			streamDurationMs: Math.round(performance.now() - streamStartedAt),
			chunkCount,
			...finishReason === void 0 ? {} : { finishReason },
			...tokenUsage === void 0 ? {} : { usage: tokenUsage },
			...reqId === void 0 ? {} : { requestId: reqId }
		});
	} catch (error) {
		if (options.signal?.aborted) throw aborted$1("Request was aborted.");
		const elapsedMs = Math.round(performance.now() - startedAt);
		if (headerTimedOut) {
			const failure = new QoderLlmError("Qoder model request exceeded its response header timeout.", "TIMEOUT");
			dependencies.logger?.error?.("[Qoder Stream] Request failed", redactLogValue(failure), {
				phase: "header",
				elapsedMs,
				timeoutMs: dependencies.responseHeaderTimeoutMs
			});
			throw failure;
		}
		if (idleTimedOut) {
			const failure = new QoderLlmError("Qoder model stream exceeded its idle timeout.", "TIMEOUT");
			dependencies.logger?.error?.("[Qoder Stream] Request failed", redactLogValue(failure), {
				phase: "stream-idle",
				chunkCount,
				idleDurationMs: Math.round(performance.now() - lastActivityAt),
				elapsedMs,
				...reqId === void 0 ? {} : { requestId: reqId }
			});
			throw failure;
		}
		if (error instanceof QoderLlmError) {
			dependencies.logger?.error?.("[Qoder Stream] Request failed", redactLogValue(error), {
				chunkCount,
				elapsedMs,
				...reqId === void 0 ? {} : { requestId: reqId }
			});
			throw error;
		}
		const failure = new QoderLlmError("Qoder transport request failed.", "TRANSPORT", { cause: error });
		dependencies.logger?.error?.("[Qoder Stream] Request failed", redactLogValue(failure), {
			chunkCount,
			elapsedMs,
			...reqId === void 0 ? {} : { requestId: reqId },
			cause: redactLogValue(error)
		});
		throw failure;
	} finally {
		clearTimeout(headerTimer);
		if (idleTimer !== void 0) clearTimeout(idleTimer);
		options.signal?.removeEventListener("abort", onCallerAbort);
		requestController.abort("request complete");
	}
}
/**
* How long a rotated-token notice may wait for an accepting chat.
*
* The heal's own retry can lose a race with a transient fault and be rescued
* by a later attempt, so the notice is deferred until some chat is accepted.
* That deferral has to be bounded: an unbounded one let a rotation from
* minutes earlier surface as a fresh-looking row whose timestamp named a
* moment the user could not connect to the row appearing now. Five minutes
* comfortably covers the host's own retry cycle (its backoff caps at 10s)
* while keeping the row adjacent to the event it describes.
*/
const jobTokenNoticeMaxAgeMs = 3e5;
/**
* Longest single queue wait the transport will honour.
*
* A queue answer can carry a retry window the upstream computed, and nothing
* stops that window from naming hours. Holding a request open for hours is not
* a wait, it is a hang: the caller's own retry cycle is shorter than that, and
* the user would rather see the queue explained than a spinner that outlives
* their patience. Waits longer than this are capped and the queue is reported
* on the next failure.
*/
const queueWaitCeilingMs = 3e5;
/**
* The fixed margin and the jitter spread added to every queue wait.
*
* The upstream's advice names the moment IT will let the next request in, and
* every client that received the same answer will wake at that same moment —
* a stampede the queue then has to answer again. A one-second margin plus a
* spread of up to two seconds turns that synchronised wake-up into a trickle,
* which is why the wait is not simply the advised window.
*/
const queueWaitPaddingMs = 1e3;
const queueWaitJitterMs = 2e3;
/**
* The conversation one request belongs to, as the string every per-conversation
* map keys on — or `undefined` when the host asked for no conversation.
*
* This is the identity the hint rows are attributed to. It comes from the
* request itself rather than from a remembered "current agent", because requests
* run concurrently (a chat and its session-title request at minimum) and only
* the request knows which conversation its queue answer or its heal describes.
*/
function sessionIdOf(options) {
	return options.sessionId === void 0 ? void 0 : String(options.sessionId);
}
/**
* Whether one request is the host's automatic session-title call.
*
* The host derives a session title with a synthetic one-message request whose
* single user message is framed by its `frameMessages` helper (seen verbatim in
* the host build): the text is `Generate the session title from this JSON
* array of human messages:` (first title) or `Update the session title from
* this JSON object:` (title refresh) followed by the framed JSON. The message
* source marker the session log carries (`dsh-session-title-llm`) is stamped
* over by this plugin's own shim before the transport sees the request, so the
* text prefix is the only surviving signal.
*
* A title call is bookkeeping, not a turn: it must neither pin a session nor
* spend any stickiness bound, otherwise every new conversation burns one round
* and one request of its first account before the user's turn even starts.
*/
function isTitleRequest(options) {
	const messages = options.messages;
	if (messages.length !== 1) return false;
	const only = messages[0];
	if (only === void 0 || only.role !== "user") return false;
	const blocks = only.content;
	if (blocks.length !== 1) return false;
	const block = blocks[0];
	if (block === void 0 || block.type !== "text") return false;
	return block.text.startsWith("Generate the session title from this JSON array of human messages:") || block.text.startsWith("Update the session title from this JSON object:");
}
/**
* Whether one request OPENS a new user turn rather than continuing one.
*
* The host runs one `generate` call per model step, and a turn's later steps
* arrive with the previous step's tool results appended — their LAST message is
* a tool result. The stickiness bounds are examined only at turn openings, and
* the round bound is credited at the turn's FINAL answer, which is what keeps a
* multi-step turn on one account: a bound reached mid-turn waits for the next
* turn instead of splitting the turn across accounts.
*/
function opensNewTurn(options) {
	const messages = options.messages;
	const last = messages[messages.length - 1];
	return last === void 0 || last.role !== "tool";
}
/**
* The pending-notice map key for one conversation.
*
* A request that carries no session id — a direct API call, a host that passes
* none — still heals and still gets a row, so those requests share one bucket
* and flush each other's notice. That is what the fallback target already means
* for them: they are indistinguishable to this module, and none of them can be
* printed into someone else's conversation.
*/
function pendingKeyOf(sessionId) {
	return sessionId ?? "<sessionless>";
}
/**
* How many `nextAccount` hops one selection may take while looking for an
* account that is not cooling down.
*
* The host owns the walk order, so this cannot be derived from a pool size; it
* only has to be larger than any realistic pool and finite, so a host whose
* `nextAccount` wraps or echoes ids cannot trap selection in a loop.
*/
const maxWalkSearchSteps = 64;
/**
* How a failure is recorded in the penalty ledger.
*
* Kept next to `isAccountFailure` because it is the same judgment one level
* deeper: the walk has already decided the failure says something about the
* account, and this decides how much it costs. A rate limit is an upstream
* pacing the subscription; everything else the account could not serve at all.
* The status fallback mirrors `isAccountFailure` so an untyped failure that the
* walk accepted is still classified consistently.
*/
function penaltyKind(error) {
	if (error instanceof LlmError) {
		const status = error.failure.status;
		if (error.code === "RATE_LIMIT" || status === 429) return "rate-limit";
		if (error.code === "AUTH" || error.code === "SERVER" || error.code === "TIMEOUT" || error.code === "TRANSIENT" || error.code === "TRANSPORT" || error.code === "EMPTY_RESPONSE" || status === 401 || status === 403 || status === 418 || status !== void 0 && status >= 500 && status <= 599) return "hard";
	}
	return "unknown";
}
/**
* Whether a terminal chunk is the model finishing an ANSWER.
*
* The `finish` chunk is the single terminal signal of a stream, and it carries
* a failure reason for the two kinds that did not produce an answer: an upstream
* error and a caller abort. Everything else — `stop`, `tool-calls`, `max-tokens`
* — means the step was served to the end, which exonerates the account in the
* penalty ledger. Only `stop` and `max-tokens` are a turn's FINAL answer; see
* `noteTurnProgress` for why `tool-calls` must not credit a round yet.
*/
function isServedFinish(chunk) {
	if (chunk.type !== "finish") return false;
	const kind = chunk.reason.kind;
	return kind !== "error" && kind !== "aborted";
}
/** The summary the host renders from: the ledger's completed-wait half. */
function queueWaitSummary(ledger) {
	return {
		attempts: ledger.attempts,
		totalWaitMs: ledger.totalWaitMs,
		...ledger.lastBasis === void 0 ? {} : { lastBasis: ledger.lastBasis }
	};
}
function aborted(message) {
	return new QoderLlmError(message, "ABORTED");
}
/**
* Whether a failure says something about the ACCOUNT rather than the request.
*
* A malformed request fails identically on every account, so switching would
* only trade a clear error for a slower identical one — and adopt an identity
* nothing needed. `INVALID_REQUEST` is therefore excluded explicitly, and the
* remaining signals are the connection-level family (the fetch never completed,
* the handshake or stream timed out, the response carried no body to stream)
* plus the account-level classifications. `TRANSIENT` belongs to that last
* family: it is the code `qoderHttpError` gives HTTP 418, which upstream uses
* to wrap its own provider fault, and another identity can clear it. `QUOTA` is
* deliberately not one of them: the frozen spec enumerates what failover
* answers to, and a depleted quota is an account fact the user resolves by
* choosing another account.
*
* A queue answer is excluded for the same reason one step removed. It is the
* upstream's statement about a busy MODEL (`isQueued`, `serviceAvailable:false`)
* that merely travels wearing `RATE_LIMIT` and the upstream's 403 — see
* `qoderHttpError`. No credential queue-jumps a model, so the walk would only
* spend a second subscription on the same answer, and because a switch reports
* the previous condition over, it would also erase the explanation this plugin
* owes the user for exactly that answer (observed end to end: a two-account
* pool answered the queue on B, `upstreamNotice` came back undefined, and the
* stored active account had moved). The queue is reported, never retried
* against another identity.
*/
function isAccountFailure(error) {
	if (!(error instanceof LlmError)) return false;
	if (error.code === "INVALID_REQUEST") return false;
	if (error instanceof QoderLlmError && error.qoderQueue !== void 0) return false;
	if (error.code === "AUTH" || error.code === "RATE_LIMIT" || error.code === "SERVER" || error.code === "TIMEOUT" || error.code === "TRANSIENT" || error.code === "TRANSPORT" || error.code === "EMPTY_RESPONSE") return true;
	const status = error.failure.status;
	return status !== void 0 && (status === 401 || status === 403 || status === 418 || status === 429 || status >= 500 && status <= 599);
}
/**
* A short, redacted account-switch reason for the host's `switched` record.
*
* It names the classification and status only: the upstream's message can quote
* request content, and the credential must never travel into a notice.
*/
function switchReason(error) {
	if (error instanceof LlmError) {
		const status = error.failure.status;
		return status === void 0 ? `upstream ${error.code}` : `upstream ${error.code} (HTTP ${status})`;
	}
	return "connection failure";
}
var DefaultQoderTransport = class {
	region;
	resolvePat;
	fetchImpl;
	logger;
	streamIdleTimeoutMs;
	responseHeaderTimeoutMs;
	metadataTimeoutMs;
	resolveMachineId;
	/**
	* The host-level seed every account's derived device id is built from.
	*
	* Held as a provider, not a value: the seed lives on disk, may be absent, and
	* changes when the user resets the device codes. Each credential mint reads it
	* once, so all headers of one job token belong to the same reset epoch.
	*/
	resolveDeviceSeed;
	imageUploadTimeoutMs;
	imageUrlCacheTtlMs;
	auth;
	usage;
	checkInService;
	modelFlights = new SingleFlight();
	attachments;
	imageUploader;
	/**
	* The per-region copies of the two services a CHAT attempt needs.
	*
	* `auth` and `imageUploader` are the only services whose endpoint is decided
	* per attempt rather than per variant: a pool may span both Qoder regions, and
	* an account saved in the other region has to be exchanged and signed against
	* THAT region's gateway (see `QoderPooledAccount`). One instance per region is
	* the whole trick — the auth cache is already keyed `${region}:${pat}`, and the
	* upload cache keys on the region's upload URL, so two instances never share
	* an entry they should not.
	*
	* The metadata services (`usage`, `checkInService`) stay on this transport's
	* own region: they are read through the host's per-variant runtime, which
	* always hands them an account from its own credential file.
	*/
	authByRegion = /* @__PURE__ */ new Map();
	uploaderByRegion = /* @__PURE__ */ new Map();
	preserveThinking;
	failover;
	onUpstreamQueue;
	/**
	* The accepted-chat callback, named apart from `onChatAccepted` because that
	* name is the seam this transport fires it from.
	*/
	chatAccepted;
	onJobTokenRefreshed;
	onJobTokenRefreshFailed;
	onQueueWait;
	queueWait;
	stickiness;
	routing;
	now;
	/**
	* Randomness for the queue wait's jitter, injectable so a test can pin the
	* spread instead of asserting on a distribution.
	*/
	random;
	/**
	* Per-account traffic guard, keyed by `account.id` (see `account-limiter.ts`).
	*
	* It lives on the transport rather than on the host because only the
	* transport knows which account each attempt actually signs with; the host
	* sees one stream call, not the pool walk behind it.
	*/
	traffic;
	/**
	* What repeated failures have cost each pooled account (T5).
	*
	* Per transport, hence per variant and per process, and never persisted: a
	* cooldown describes the upstream's current treatment of an account, which a
	* restart does not know. The ledger carries only facts the transport itself
	* observed, and only once another account has exonerated the failure's
	* request — see `generateWithAccounts`.
	*/
	penalties;
	/**
	* Session → account pins, least recently used first.
	*
	* Stickiness cannot live in the host's stored account state: that state names
	* one active account for the whole plugin, and the point of a pin is that two
	* sessions may legitimately sit on two accounts at the same time. A bounded
	* map keyed by the session id the caller already supplies is therefore the
	* storage, ordered by Map insertion so the oldest pin is the one evicted.
	*/
	sessionPins = /* @__PURE__ */ new Map();
	/**
	* The turns currently in flight, keyed by conversation, with the account that
	* served their LATEST step.
	*
	* A turn that ends in `tool-calls` is not finished, so it earns no round until
	* its final answer arrives — which may be several steps and one failover
	* later. This record is what lets that final answer complete the turn it
	* belongs to instead of looking like the first step of something new. It is
	* dropped when the turn completes, when it dies without an answer, when a new
	* turn supersedes it, and when its session loses its pin.
	*/
	pendingTurns = /* @__PURE__ */ new Map();
	/**
	* The conversations whose self-heal exchanged a fresh job token and whose
	* retry has not been accepted yet, with the time each rotation happened.
	*
	* Set by the heal, cleared when a chat from the SAME conversation succeeds.
	* The notice reports "the token was rotated because the old one was rejected",
	* which is true from that exchange on — so it must not be tied to the heal's
	* OWN retry, which can still lose a race with a transient upstream timeout and
	* be rescued by a later attempt.
	*
	* Keyed per conversation instead of being one shared slot, because one job
	* token is shared by every request the credential signs: a single slot let a
	* chat in a DIFFERENT conversation flush it, printing "已自动重换并恢复" into a
	* conversation whose own request never healed (observed: a rotation reported
	* an hour later, in another chat). A conversation now collects only its own
	* notice, and one that never comes back leaves nothing to print.
	*/
	pendingRefreshBySession = /* @__PURE__ */ new Map();
	/**
	* Whether the current unresolved heal failure has already been reported.
	*
	* One upstream rejection can outlive many host-level retries (an observed
	* storm ran 59 of them across 75 steps), and the transport re-heals inside
	* every one of them. Without this latch the failure notice would print once
	* per retry; with it, the user is told once per outage. Cleared as soon as
	* any chat is accepted, so the next outage announces itself again.
	*/
	refreshFailureAnnounced = false;
	constructor(options) {
		this.region = options.region;
		this.resolvePat = options.resolvePat;
		this.fetchImpl = options.fetch ?? globalThis.fetch;
		this.logger = options.logger;
		this.streamIdleTimeoutMs = options.streamIdleTimeoutMs ?? 3e5;
		this.responseHeaderTimeoutMs = options.responseHeaderTimeoutMs ?? 6e4;
		this.metadataTimeoutMs = options.metadataTimeoutMs;
		this.resolveMachineId = options.resolveMachineId;
		this.resolveDeviceSeed = options.resolveDeviceSeed;
		this.imageUploadTimeoutMs = options.imageUploadTimeoutMs;
		this.imageUrlCacheTtlMs = options.imageUrlCacheTtlMs;
		this.attachments = options.attachments;
		this.preserveThinking = options.preserveThinking;
		this.failover = options.failover;
		this.onUpstreamQueue = options.onUpstreamQueue;
		this.chatAccepted = options.onChatAccepted;
		this.onJobTokenRefreshed = options.onJobTokenRefreshed;
		this.onJobTokenRefreshFailed = options.onJobTokenRefreshFailed;
		this.onQueueWait = options.onQueueWait;
		this.queueWait = options.queueWait;
		this.stickiness = options.stickiness;
		this.routing = options.routing;
		this.now = options.now ?? Date.now;
		this.random = options.random ?? Math.random;
		this.penalties = new QoderAccountPenaltyLedger(this.now);
		this.traffic = new QoderAccountTrafficLimiter({
			now: this.now,
			random: this.random,
			onFailOpen: (info) => {
				this.logger?.warn?.("[Qoder Stream] Account traffic guard timed out waiting for its turn; letting the request through", {
					accountId: info.accountId,
					waitedMs: info.waitedMs
				});
			}
		});
		this.auth = this.authFor(this.region);
		this.imageUploader = this.uploaderFor(this.region);
		this.usage = new QoderUsageReader({
			authService: this.auth,
			fetch: this.fetchImpl,
			logger: this.logger,
			region: this.region,
			timeoutMs: this.metadataTimeoutMs
		});
		this.checkInService = new QoderCheckInService({
			authService: this.auth,
			fetch: this.fetchImpl,
			logger: this.logger,
			region: this.region,
			timeoutMs: this.metadataTimeoutMs
		});
	}
	/**
	* Forget every cached job token, so the next request re-derives its device id.
	*
	* The derived `Cosy-Machineid` / `Cosy-Machinehostname` are minted while a job
	* token is exchanged and then cached with it, so clearing the caches is the
	* only way a rotated seed can reach an account that is already signed in —
	* and it must cover EVERY region, because one transport serves a pool that may
	* span both.
	*
	* What this deliberately does NOT touch: the real machine id (a host fact, not
	* a per-account claim), the PATs, the account pins, and the penalty ledger.
	* Resetting a fingerprint is not a logout and not a clean slate for the
	* upstream's opinion of an account; it only changes what that account claims
	* to be.
	*
	* The cost is one extra token exchange per account on its next use.
	*/
	resetDeviceIdentity() {
		for (const auth of this.authByRegion.values()) auth.clear();
	}
	/**
	* The auth service for one region, built once and reused.
	*
	* A chat attempt resolves the account's OWN region first (see
	* `attemptRegion`), so the same transport may exchange job tokens against
	* either gateway during one request walk. The service's cache is keyed
	* `${region}:${pat}`, which is exactly why one instance per region is safe:
	* a token exchanged for `api3.qoder.sh` can never be handed to
	* `gateway.qoder.com.cn`.
	*/
	authFor(region) {
		const cached = this.authByRegion.get(region);
		if (cached !== void 0) return cached;
		const created = new QoderAuthService({
			fetch: this.fetchImpl,
			logger: this.logger,
			region,
			resolveMachineId: this.resolveMachineId,
			resolveDeviceSeed: this.resolveDeviceSeed
		});
		this.authByRegion.set(region, created);
		return created;
	}
	/**
	* The image uploader for one region, built once and reused.
	*
	* Publication is signed with the same region's job token, so the uploader has
	* to follow the account's region rather than the variant's: a China account's
	* image published to the global center would be signed by a gateway it never
	* authenticated against. Its credential-refresh callback re-reads through the
	* SAME region's auth service for the same reason.
	*/
	uploaderFor(region) {
		const cached = this.uploaderByRegion.get(region);
		if (cached !== void 0) return cached;
		const auth = this.authFor(region);
		const created = new QoderImageUploader({
			fetch: this.fetchImpl,
			logger: this.logger,
			region,
			...this.imageUploadTimeoutMs === void 0 ? {} : { timeoutMs: this.imageUploadTimeoutMs },
			...this.imageUrlCacheTtlMs === void 0 ? {} : { cacheTtlMs: this.imageUrlCacheTtlMs },
			refreshCredentials: async (signal) => {
				const pat = await this.requirePat(signal);
				auth.clear(pat);
				return auth.getCredentials(pat, signal);
			}
		});
		this.uploaderByRegion.set(region, created);
		return created;
	}
	/**
	* The region one pooled account signs against.
	*
	* A pooled account carries the region it was saved under (the host keeps one
	* credential file per region, and the file's region stamp is authoritative —
	* see `QoderPooledAccount`). An account with no declared region, or an
	* ambient credential, signs against this transport's own region, which is the
	* single-region behavior this transport had before pools could span regions.
	*/
	attemptRegion(account) {
		return account?.region ?? this.region;
	}
	stream(options, model) {
		return this.generate(options, model);
	}
	/**
	* Report THIS conversation's pending self-heal once its chat is accepted.
	*
	* The notice means "the stale token was rejected, so it was rotated, and the
	* chat works again" — all three are true by the time a chat is accepted
	* after the refresh, no matter which attempt delivered it. "This conversation"
	* is load-bearing: the rotated token is shared, so another conversation's
	* acceptance proves nothing about the request that actually healed, and
	* reporting there printed a recovery row in the wrong conversation.
	*
	* @param key - The pending-map key for the conversation whose chat landed
	*   (see {@link pendingKeyOf}).
	* @param sessionId - The same id as a string, reported so the host can print
	*   into that conversation; `undefined` when the request carried no session.
	*/
	flushPendingRefreshNotice(key, sessionId) {
		const at = this.pendingRefreshBySession.get(key);
		if (at === void 0) return;
		this.pendingRefreshBySession.delete(key);
		if (Date.now() - at > jobTokenNoticeMaxAgeMs) return;
		this.logger?.warn?.("[Qoder Stream] Job token was auto-refreshed after an upstream rejection; the chat has recovered");
		this.onJobTokenRefreshed?.({
			region: this.region,
			at,
			...sessionId === void 0 ? {} : { sessionId }
		});
	}
	/**
	* Drop this conversation's pending rotation notice whose heal rescued nothing.
	*
	* The heal's own retry was rejected too, so "the rotation fixed it" is not
	* what happened. Leaving the notice pending made a LATER chat acceptance flush
	* it — printing a success row that contradicts the failure row already shown,
	* stamped with the old rotation time.
	*/
	discardPendingRefreshNotice(key, at) {
		if (this.pendingRefreshBySession.get(key) === at) this.pendingRefreshBySession.delete(key);
	}
	/**
	* Note that the upstream accepted a chat, ending any unresolved heal failure.
	*
	* `streamChat` calls this the moment its first chunk arrives — the only point
	* at which "the credential was accepted" is actually known. A rejected chat
	* throws before that, so this never fires on a failing attempt.
	*
	* Acceptance is equally proof that the condition an earlier failure announced
	* is over, so the host is told here as well: it owns that notice's wording and
	* lifetime, and nothing in the transport can retract it later.
	*/
	onChatAccepted(accountId, sessionId) {
		this.refreshFailureAnnounced = false;
		this.flushPendingRefreshNotice(pendingKeyOf(sessionId), sessionId);
		this.chatAccepted?.(accountId, sessionId);
	}
	async discoverModels(signal) {
		const pat = await this.requirePat(signal);
		const key = opaqueCredentialKey(pat);
		return this.modelFlights.run(key, signal, async (sharedSignal) => {
			const credentials = await this.auth.getCredentials(pat, sharedSignal);
			return retryMetadataRead(sharedSignal, () => fetchQoderModels(credentials, {
				fetch: this.fetchImpl,
				signal: sharedSignal,
				logger: this.logger,
				region: this.region,
				timeoutMs: this.metadataTimeoutMs
			}));
		}, () => aborted("Qoder model discovery was aborted."));
	}
	async readAccount(options) {
		const pat = options?.pat ?? await this.requirePat(options?.signal);
		return this.usage.readAccount(pat, {
			force: options?.force,
			signal: options?.signal,
			...options?.minIntervalMs === void 0 ? {} : { minIntervalMs: options.minIntervalMs }
		});
	}
	async checkIn(signal) {
		const pat = await this.requirePat(signal);
		return this.checkInService.checkIn(pat, signal);
	}
	async requirePat(signal) {
		if (signal?.aborted) throw aborted("Qoder request was aborted.");
		const pat = (await this.resolvePat()).trim();
		if (!pat) throw new QoderLlmError("Qoder Personal Access Token is missing. Configure Qoder in the Qoder settings page.", "MISSING_CREDENTIAL");
		if (signal?.aborted) throw aborted("Qoder request was aborted.");
		return pat;
	}
	/**
	* Stream one chat, reporting acceptance as soon as the FIRST chunk arrives.
	*
	* `streamQoderChat` throws before yielding anything when the upstream rejects
	* the request, so a first chunk means the credential was accepted. Reporting
	* at that moment — rather than after the whole stream drains — matters
	* because the consumer may close the stream early, and code after a
	* completed `yield*` would then never run.
	*
	* @param onAccepted - Called once, before the first chunk is forwarded.
	* @param onFirstByte - Called only when there is a chunk to forward, so a
	*   caller can tell "the upstream accepted this credential" apart from "the
	*   consumer has already seen bytes", which an empty stream would conflate.
	*/
	async *streamChat(options, model, credentials, messages, onAccepted, region, onFirstByte) {
		const stream = streamQoderChat(options, model, credentials, messages, {
			fetch: this.fetchImpl,
			logger: this.logger,
			region,
			responseHeaderTimeoutMs: this.responseHeaderTimeoutMs,
			streamIdleTimeoutMs: this.streamIdleTimeoutMs
		});
		const first = await stream.next();
		onAccepted();
		if (!first.done) {
			onFirstByte?.();
			yield first.value;
		}
		yield* stream;
	}
	async *generate(options, model) {
		if (options.signal?.aborted) throw aborted("Request was aborted prior to generation.");
		validateQoderRequestShape(options, model);
		const attribution = { accountId: void 0 };
		const queueBudget = this.newQueueWaitLedger();
		try {
			yield* this.generateWithAccounts(options, model, attribution, queueBudget);
		} catch (error) {
			const facts = error instanceof QoderLlmError ? error.qoderQueue : void 0;
			if (facts !== void 0 && options.signal?.aborted !== true) this.onUpstreamQueue?.(facts, attribution.accountId, sessionIdOf(options), queueWaitSummary(queueBudget));
			throw error;
		}
	}
	/**
	* Walk the account pool once, retrying a connection-level failure on the next
	* account, and yield the first account's successful stream.
	*
	* This sits OUTSIDE the per-account self-heal (see `attempt`) on purpose: a
	* stale job token belongs to the account that holds it, so that account gets
	* its one fresh-token retry before the transport spends a second identity.
	* Only a failure the account could not be rescued from advances the walk.
	*
	* The `switched` hook is awaited before the retry because it is also what
	* points the host at the new account: the image publisher's own credential
	* refresh resolves the ambient active PAT, so that adoption must have landed
	* before the retry can reach it.
	*/
	async *generateWithAccounts(options, model, attribution, queueBudget) {
		const failover = this.failover;
		if (failover === void 0 || !failover.enabled()) {
			yield* this.attempt(options, model, { pat: await this.requirePat(options.signal) }, { emitted: false }, void 0, queueBudget);
			return;
		}
		const active = await failover.activeAccount();
		if (active === void 0) {
			yield* this.attempt(options, model, { pat: await this.requirePat(options.signal) }, { emitted: false }, void 0, queueBudget);
			return;
		}
		const sessionId = isTitleRequest(options) ? void 0 : sessionIdOf(options);
		const newTurn = opensNewTurn(options);
		if (newTurn && sessionId !== void 0) this.pendingTurns.delete(sessionId);
		const pinned = await this.pinnedAccount(sessionId, newTurn);
		let first = pinned ?? await this.preferredStart(failover, active);
		const firstCooling = this.penalties.isCooling(first.id);
		const firstBusy = this.traffic.isBusy(first.id);
		if (firstCooling || firstBusy) {
			const alternative = await this.nextWalkAccount(failover, first.id, /* @__PURE__ */ new Set([first.id]));
			if (alternative !== void 0) {
				if (firstCooling) try {
					await failover.adopted?.({
						fromId: first.id,
						toId: alternative.id,
						reason: "cooling"
					});
				} catch (error) {
					this.logger?.warn?.("[Qoder Stream] Could not adopt the account chosen after a cooldown", {
						fromId: first.id,
						toId: alternative.id,
						message: error instanceof Error ? error.message : String(error)
					});
				}
				this.logger?.warn?.("[Qoder Stream] Starting this request on another account without failing over", {
					fromId: first.id,
					toId: alternative.id,
					cause: firstCooling ? "cooling" : "busy",
					penalty: this.penalties.snapshot(first.id)
				});
				first = alternative;
			}
		}
		if (pinned === void 0 || first.id !== pinned.id) this.pinSession(sessionId, first);
		this.noteRequest(sessionId, first.id);
		const tried = /* @__PURE__ */ new Set([first.id]);
		const pendingBlame = [];
		let account = first;
		for (;;) {
			const state = { emitted: false };
			state.onFinish = (() => {
				const servedId = account.id;
				const servedTurn = newTurn;
				return (chunk) => {
					if (!isServedFinish(chunk)) {
						if (sessionId !== void 0) this.pendingTurns.delete(sessionId);
						return;
					}
					this.penalties.noteSuccess(servedId);
					for (const blame of pendingBlame) this.penalties.noteFailure(blame.accountId, blame.kind);
					pendingBlame.length = 0;
					this.noteTurnProgress(sessionId, servedId, chunk, servedTurn);
				};
			})();
			attribution.accountId = account.id;
			try {
				yield* this.attempt(options, model, account, state, account.id, queueBudget);
				return;
			} catch (error) {
				if (options.signal?.aborted || state.emitted) throw error;
				if (!isAccountFailure(error)) throw error;
				const next = await this.nextWalkAccount(failover, account.id, tried, true);
				if (next === void 0 || tried.has(next.id)) throw error;
				tried.add(next.id);
				const reason = switchReason(error);
				failover.failed?.({
					accountId: account.id,
					reason,
					at: this.now()
				});
				pendingBlame.push({
					accountId: account.id,
					kind: penaltyKind(error)
				});
				await failover.switched({
					fromId: account.id,
					toId: next.id,
					reason,
					...sessionId === void 0 ? {} : { sessionId }
				});
				account = next;
				this.pinSession(sessionId, next);
				this.noteRequest(sessionId, next.id);
			}
		}
	}
	/**
	* Run one account's whole request: credentials, wire translation, the chat,
	* and the same-account job-token self-heal.
	*
	* @param pat - The PAT this attempt signs with. A failover retry passes the
	*   next account's PAT instead of re-resolving the ambient credential.
	* @param state - Flipped before the first chunk is forwarded, so the caller
	*   knows a retry would duplicate bytes already handed to the consumer.
	*/
	async *attempt(options, model, account, state = { emitted: false }, accountId, queueBudget = this.newQueueWaitLedger()) {
		let lease;
		let released = false;
		const release = () => {
			if (released) return;
			released = true;
			lease?.release();
		};
		try {
			lease = accountId === void 0 ? void 0 : await this.traffic.acquire(accountId);
			for await (const chunk of this.attemptPaced(options, model, account, state, accountId, queueBudget)) {
				if (chunk.type === "finish") release();
				if (chunk.type === "finish" && state.onFinish !== void 0) {
					const onFinish = state.onFinish;
					state.onFinish = void 0;
					try {
						onFinish(chunk);
					} catch (error) {
						this.logger?.warn?.("[Qoder Stream] Finish bookkeeping threw; continuing the stream", { message: error instanceof Error ? error.message : String(error) });
					}
				}
				yield chunk;
			}
		} finally {
			release();
		}
	}
	async *attemptPaced(options, model, account, state, accountId, queueBudget) {
		const region = this.attemptRegion(account);
		const auth = this.authFor(region);
		const uploader = this.uploaderFor(region);
		const pat = account.pat;
		const credentials = await auth.getCredentials(pat, options.signal);
		const messages = await translateQoderMessages(options, this.attachments, {
			uploader,
			credentials,
			preserveThinking: this.preserveThinking
		});
		let chatCredentials = await auth.getCredentials(pat, options.signal);
		const onFirstByte = () => {
			state.emitted = true;
		};
		let healRound = 0;
		let noticeAt;
		const pendingId = sessionIdOf(options);
		for (;;) try {
			yield* this.streamChat(options, model, chatCredentials, messages, () => {
				this.onChatAccepted(accountId, sessionIdOf(options));
			}, region, onFirstByte);
			return;
		} catch (error) {
			if (queueBudget.waitsLeft > 0 && !state.emitted && options.signal?.aborted !== true) {
				const plan = this.queueWaitMs(error);
				if (plan !== void 0) {
					const waitMs = plan.waitMs;
					queueBudget.waitsLeft -= 1;
					const attempt = queueBudget.total - queueBudget.waitsLeft;
					this.logger?.warn?.("[Qoder Stream] Upstream queue is saturated; waiting before retrying the same account", {
						waitMs,
						attempt,
						attemptsLeft: queueBudget.waitsLeft,
						basis: plan.basis.source
					});
					const facts = error instanceof QoderLlmError ? error.qoderQueue : void 0;
					if (facts !== void 0) this.onQueueWait?.(facts, accountId, {
						waitMs,
						attempt,
						remaining: queueBudget.waitsLeft,
						basis: plan.basis
					}, pendingId);
					await this.waitOutQueue(waitMs, options.signal);
					queueBudget.attempts += 1;
					queueBudget.totalWaitMs += waitMs;
					queueBudget.lastBasis = plan.basis;
					continue;
				}
			}
			if (!isQoderAuthRejection(error) || options.signal?.aborted) throw error;
			if (healRound >= 2) {
				if (noticeAt !== void 0) this.discardPendingRefreshNotice(pendingKeyOf(pendingId), noticeAt);
				if (!this.refreshFailureAnnounced) {
					this.refreshFailureAnnounced = true;
					this.logger?.warn?.("[Qoder Stream] Job token refresh did not recover the chat; the upstream still rejects it", { status: error.failure.status });
					this.onJobTokenRefreshFailed?.({
						region,
						at: Date.now(),
						...error.failure.status === void 0 ? {} : { status: error.failure.status },
						...pendingId === void 0 ? {} : { sessionId: pendingId }
					});
				}
				throw error;
			}
			if (healRound === 0) this.logger?.warn?.("[Qoder Stream] Chat rejected as unauthorized; exchanging a fresh job token and retrying once", { status: error.failure.status });
			else {
				this.logger?.warn?.("[Qoder Stream] Fresh job token also rejected; waiting 2s and retrying once more", {
					status: error.failure.status,
					round: healRound
				});
				await this.pauseBeforeNextHeal(options);
			}
			const refreshed = await auth.exchangeFresh(pat, options.signal);
			noticeAt = Date.now();
			this.pendingRefreshBySession.set(pendingKeyOf(pendingId), noticeAt);
			chatCredentials = refreshed;
			healRound += 1;
		}
	}
	/**
	* The account the walk should visit next: cooling accounts (T5) are skipped
	* entirely, busy accounts (T7, the traffic guard is serving them) and
	* deprioritised accounts are collected as fallbacks, and a free candidate is
	* preferred over both.
	*
	* "Skip" is a statement about this request, not about the pool: cooling
	* accounts are left untried so a known-bad guess cannot spend the request,
	* but they stay in the walk order for when the ledger forgets them. Accounts
	* that are merely deprioritised are collected and used as a fallback — the
	* whole point of a downweight is "prefer others", not "refuse". A busy
	* account is the last resort, and only when `allowBusy` asks for it: a request
	* that would otherwise fail is better served by queueing behind the traffic
	* guard than by refusing the user, and the guard paces the two requests on
	* that identity. Dispatch-time selection (the cooling skip) leaves it out —
	* waiting for a busy account is worse than taking a merely cooling one now.
	*
	* Only a walk with no candidate at all returns `undefined`, which ends the
	* walk and lets the original failure surface. The search is bounded and never
	* revisits an id, so a host `nextAccount` that wraps the pool cannot make
	* selection loop.
	*/
	async nextWalkAccount(failover, currentId, tried, allowBusy = false) {
		const considered = /* @__PURE__ */ new Set([currentId]);
		const deprioritized = [];
		const busy = [];
		let id = currentId;
		for (let step = 0; step < maxWalkSearchSteps; step++) {
			const candidate = await this.nextAccount(failover, id, tried);
			if (candidate === void 0 || tried.has(candidate.id) || considered.has(candidate.id)) break;
			considered.add(candidate.id);
			if (this.penalties.isCooling(candidate.id)) {
				id = candidate.id;
				continue;
			}
			if (this.traffic.isBusy(candidate.id)) {
				if (allowBusy) busy.push(candidate);
				id = candidate.id;
				continue;
			}
			if (this.penalties.isDeprioritized(candidate.id)) {
				deprioritized.push(candidate);
				id = candidate.id;
				continue;
			}
			return candidate;
		}
		return deprioritized[0] ?? (allowBusy ? busy[0] : void 0);
	}
	/**
	* The account an unpinned request starts on.
	*
	* Under the save-order strategy the stored active account is the whole
	* answer: nothing has been stated about priority, so "where the user left
	* off" is the only honest choice. Under a custom order the user has stated
	* one, so the first entry that still resolves is where a conversation opens;
	* the walk and the stickiness rotation then continue from there through the
	* same resolver, which is what turns the list into one policy instead of a
	* failure-only hint.
	*
	* A list that resolves to nobody is a typo, not a policy, so it falls back to
	* the active account rather than failing the request.
	*
	* Cooling and busy accounts are deliberately NOT skipped here: the dispatch
	* block that runs next applies those two transient facts to every start
	* whatever chose it, so this method stays a pure precedence decision.
	*/
	async preferredStart(failover, active) {
		const routing = this.routing;
		const resolve = failover.accountById;
		if (routing === void 0 || resolve === void 0 || routing.strategy() !== "custom") return active;
		for (const id of routing.order()) {
			const account = await resolve(id);
			if (account !== void 0) return account;
		}
		return active;
	}
	/**
	* The account the walk visits after `currentId`.
	*
	* With no custom routing this is exactly the host's own save order. A custom
	* order is a statement about which accounts the user wants used first, so it
	* is followed while it can serve and abandoned the moment it cannot: ids the
	* user has since removed resolve to nothing, and a list that names nobody
	* would otherwise turn a routing typo into an outage.
	*/
	async nextAccount(failover, currentId, tried) {
		const routing = this.routing;
		const resolve = failover.accountById;
		if (routing === void 0 || resolve === void 0 || routing.strategy() !== "custom") return await failover.nextAccount(currentId);
		const order = routing.order();
		if (order.length === 0) return await failover.nextAccount(currentId);
		const start = order.indexOf(currentId);
		for (let offset = 1; offset <= order.length; offset++) {
			const id = order[(start + offset + order.length) % order.length];
			if (id === void 0 || tried.has(id)) continue;
			const account = await resolve(id);
			if (account !== void 0) return account;
		}
		return await failover.nextAccount(currentId);
	}
	/**
	* The account a session should start on, or `undefined` when it should start
	* over on the active account.
	*
	* A live pin is re-resolved through `accountById` whenever the host exposes
	* it, so an account the user removed can never keep signing: the pin is
	* dropped and the session starts over on the active account. Without that
	* hook the credential captured when the session was pinned is the best
	* available answer.
	*
	* When `examineBounds` is true (a turn-opening request) and the pin has
	* reached one of its bounds the session is moved to the next account in the
	* walk order — reaching a bound means "change account", not "stop
	* remembering one". Only a session that has nobody to move to stays where
	* it is, with its counters restarted so the same bound is not examined and
	* rejected on every following request. Continuation steps pass `false`: the
	* pin is re-resolved but never rotated, so a turn can never be split across
	* accounts.
	*/
	async pinnedAccount(sessionId, examineBounds) {
		const policy = this.stickiness;
		if (sessionId === void 0 || policy === void 0 || !this.stickinessEnabled(policy)) return void 0;
		const resolve = this.failover?.accountById;
		for (;;) {
			const pin = this.sessionPins.get(sessionId);
			if (pin === void 0) return void 0;
			if (resolve !== void 0) {
				const account = await resolve(pin.id);
				if (this.sessionPins.get(sessionId) !== pin) continue;
				if (account === void 0) {
					this.sessionPins.delete(sessionId);
					return;
				}
				pin.pat = account.pat;
				pin.region = account.region;
			}
			if (examineBounds && this.pinExhausted(pin, policy)) {
				const moved = await this.rotatePin(sessionId, pin);
				if (moved.kind === "stale") continue;
				if (moved.kind === "moved") return moved.account;
				pin.pinnedAtMs = this.now();
				pin.rounds = 0;
				pin.requests = 0;
			}
			if (this.sessionPins.get(sessionId) !== pin) continue;
			this.sessionPins.delete(sessionId);
			this.sessionPins.set(sessionId, pin);
			return {
				id: pin.id,
				pat: pin.pat,
				...pin.region === void 0 ? {} : { region: pin.region }
			};
		}
	}
	/**
	* Whether one bound of the stickiness policy has been reached.
	*
	* The three bounds are independent and all are counts of work this account
	* actually did, so the comparison is `>=`: with a round bound of 1, the
	* account serves exactly one completed conversation and the next request
	* moves on.
	*/
	pinExhausted(pin, policy) {
		const rounds = policy.rounds();
		if (Number.isFinite(rounds) && rounds > 0 && pin.rounds >= Math.floor(rounds)) return true;
		const requests = policy.requests();
		if (Number.isFinite(requests) && requests > 0 && pin.requests >= Math.floor(requests)) return true;
		const minutes = policy.minutes();
		if (Number.isFinite(minutes) && minutes > 0 && this.now() - pin.pinnedAtMs >= minutes * 6e4) return true;
		return false;
	}
	/**
	* Move a session to the next account of the walk order, and pin it there.
	*
	* This goes through `nextWalkAccount` — the same resolver the failure walk
	* uses — instead of the raw `failover.nextAccount` hook, so a rotation follows
	* the user's custom `routing.order` and skips accounts the ledger is cooling
	* down or that the traffic guard is serving. Using the hook directly was the
	* second half of "每轮切换没有生效": the bound fired, but the session moved
	* along the host's SAVE order, so a custom priority list never took part in a
	* rotation at all.
	*
	* A pool whose every other account is cooling (or busy) must still rotate
	* rather than strand the session on the account it just outgrew, so the raw
	* hook is the fallback: a bound means "change account", and cooling is a
	* transient opinion, not a membership test. `undefined`, or the same account
	* back again (a pool of one), means there is nowhere to go.
	*/
	async rotatePin(sessionId, pin) {
		const failover = this.failover;
		if (failover === void 0) return { kind: "none" };
		const tried = /* @__PURE__ */ new Set([pin.id]);
		const free = await this.nextWalkAccount(failover, pin.id, tried);
		if (this.sessionPins.get(sessionId) !== pin) return { kind: "stale" };
		const next = free ?? await this.nextAccount(failover, pin.id, tried);
		if (this.sessionPins.get(sessionId) !== pin) return { kind: "stale" };
		if (next === void 0 || next.id === pin.id) return { kind: "none" };
		this.pinSession(sessionId, next);
		return {
			kind: "moved",
			account: {
				id: next.id,
				pat: next.pat,
				...next.region === void 0 ? {} : { region: next.region }
			}
		};
	}
	/**
	* Count one request against the account its session is pinned to.
	*
	* Called once per request, after the account has been chosen: counting at
	* choice time would let a request that never signed anything (the walk ended
	* before any attempt) spend the request bound of an account it never asked.
	*/
	noteRequest(sessionId, accountId) {
		if (sessionId === void 0) return;
		const pin = this.sessionPins.get(sessionId);
		if (pin === void 0 || pin.id !== accountId) return;
		pin.requests += 1;
	}
	/**
	* Count one completed TURN against the account that served its final answer.
	*
	* A turn is the user's message through its final answer, tool steps included,
	* so it is worth exactly one round — credited when that answer arrives
	* (`stop` or `max-tokens`), never when an intermediate step merely asked for a
	* tool. A request that failed, or that the caller stopped reading, produced no
	* answer and must not move the session on.
	*/
	completeRound(sessionId, accountId) {
		if (sessionId === void 0) return;
		const pin = this.sessionPins.get(sessionId);
		if (pin === void 0 || pin.id !== accountId) return;
		pin.rounds += 1;
	}
	/**
	* Record where a turn stands at the terminal chunk of one of its steps.
	*
	* A round is one COMPLETED turn, so it is credited only when the model's FINAL
	* answer arrives: `stop`, or `max-tokens` (a truncated answer is still an
	* answer). `tool-calls` means the model asked for tools and the SAME turn
	* continues in the next request, so the turn is only remembered as pending —
	* counting that step would spend the bound on a turn that has not finished.
	*
	* The final answer is credited to the account that actually served it. A turn
	* can be rerouted mid-way (the opening account fails and the walk lands
	* elsewhere), and the round belongs to the account that ran it to the end.
	*/
	noteTurnProgress(sessionId, accountId, chunk, opening) {
		if (sessionId === void 0 || chunk.type !== "finish") return;
		const kind = chunk.reason.kind;
		if (kind === "stop" || kind === "max-tokens") {
			if (opening || this.pendingTurns.has(sessionId)) this.completeRound(sessionId, accountId);
			this.pendingTurns.delete(sessionId);
			return;
		}
		if (this.sessionPins.has(sessionId)) this.pendingTurns.set(sessionId, { accountId });
	}
	/**
	* Record that a session now belongs to an account.
	*
	* Called both when a session first picks an account and when the walk moves
	* it, so the pin always names an account this session actually reached. The
	* counters start at zero: the account has served no completed round yet, and
	* the request about to run is counted by `noteRequest`, not here.
	* Insertion order is the eviction order, and the cap only ever costs the
	* oldest session its stickiness.
	*/
	pinSession(sessionId, account) {
		const policy = this.stickiness;
		if (sessionId === void 0 || policy === void 0) return;
		if (!this.stickinessEnabled(policy)) return;
		if (!this.sessionPins.has(sessionId)) while (this.sessionPins.size >= 512) {
			const oldest = this.sessionPins.keys().next();
			if (oldest.done === true) break;
			this.sessionPins.delete(oldest.value);
			this.pendingTurns.delete(oldest.value);
		}
		this.sessionPins.delete(sessionId);
		this.sessionPins.set(sessionId, {
			id: account.id,
			pat: account.pat,
			...account.region === void 0 ? {} : { region: account.region },
			pinnedAtMs: this.now(),
			rounds: 0,
			requests: 0
		});
	}
	/**
	* Whether stickiness has any bound to honour at all.
	*
	* All three providers returning zero is how the host says "off", and off has
	* to mean fully off: a pin written with no bound would never move on, which is
	* the one outcome worse than having no stickiness.
	*/
	stickinessEnabled(policy) {
		if (!policy.enabled()) return false;
		const minutes = policy.minutes();
		const rounds = policy.rounds();
		const requests = policy.requests();
		return Number.isFinite(minutes) && minutes > 0 || Number.isFinite(rounds) && rounds > 0 || Number.isFinite(requests) && requests > 0;
	}
	/**
	* A fresh wait budget for ONE REQUEST, with nothing yet recorded against it.
	*
	* The budget belongs to the request, not to an attempt: a request that walks
	* from one account to the next is still one caller waiting, and refreshing
	* the budget on every switch would let an N-account pool hold that caller for
	* N times the configured number of waits (the reference implementation hit
	* exactly that and saw a single request take 197s). It is minted once in
	* `generate` and threaded through the whole walk.
	*
	* `attempts`/`totalWaitMs` start empty because they record what actually
	* happened: a wait the caller aborted mid-sleep must not be reported as one
	* the transport completed.
	*/
	newQueueWaitLedger() {
		const total = this.queueWaitBudget();
		return {
			waitsLeft: total,
			total,
			attempts: 0,
			totalWaitMs: 0,
			lastBasis: void 0
		};
	}
	queueWaitBudget() {
		const policy = this.queueWait;
		if (policy === void 0) return 0;
		const attempts = policy.attempts();
		return Number.isFinite(attempts) ? Math.max(0, Math.floor(attempts)) : 0;
	}
	/**
	* How long to wait out a queue answer, or `undefined` when the error is not a
	* queue at all.
	*
	* The upstream's own advice wins over the configured fallback because it is
	* computed from the queue it describes, and the LARGER of its two hints is
	* used: `retryAfterSeconds` is a retry hint that can be far shorter than the
	* queue it describes (observed 30s against a `waitTime` of 86s), and a wait
	* that returns to the same queue is just a slower error. Both are capped: a
	* window long enough to outlive the caller's patience is a hang dressed up as
	* a wait. With no advice at all the configured seconds are the fallback. On
	* top of the window comes the padding and jitter described at
	* `queueWaitPaddingMs`, and the total is capped again so the padding can
	* never push a five-minute wait past the ceiling that exists to bound the
	* caller's time.
	*
	* The answer names WHICH value governed, not just the length. The host's row
	* used to print only the seconds, so a user reading "等待约 86 秒" next to a
	* 排队等待秒数 setting of 30 concluded the setting was ignored — when in fact
	* the setting is the fallback used only when the upstream advises nothing, and
	* the queue's own window plus the anti-stampede padding produced 86. Saying
	* which one drove the wait is the fix; changing the algorithm to obey the
	* setting would mean waiting out a queue the upstream said is longer, which
	* is a slower failure dressed up as obedience.
	*/
	queueWaitMs(error) {
		if (!(error instanceof QoderLlmError) || error.qoderQueue === void 0) return void 0;
		const advised = error.failure.providerRetryAfterMs;
		const advisedMs = advised !== void 0 && Number.isFinite(advised) && advised > 0 ? advised : 0;
		const waitTime = error.qoderQueue.waitTime;
		const waitTimeMs = waitTime !== void 0 && Number.isFinite(waitTime) && waitTime > 0 ? waitTime * 1e3 : 0;
		const queuedMs = Math.max(advisedMs, waitTimeMs);
		const configuredSeconds = Math.max(0, this.queueWait?.seconds() ?? 0);
		const baseMs = queuedMs > 0 ? Math.min(queuedMs, queueWaitCeilingMs) : Math.min(configuredSeconds * 1e3, queueWaitCeilingMs);
		const jitterMs = Math.floor(Math.max(0, Math.min(.999, this.random())) * queueWaitJitterMs);
		const waitMs = Math.min(baseMs + queueWaitPaddingMs + jitterMs, queueWaitCeilingMs);
		const advisedSeconds = queuedMs > 0 ? Math.round(queuedMs / 1e3) : void 0;
		return {
			waitMs,
			basis: {
				source: queuedMs > 0 ? "upstream" : "configured",
				...advisedSeconds === void 0 ? {} : { advisedSeconds },
				configuredSeconds
			}
		};
	}
	/**
	* Sleep out an advised queue window, aborting with the request.
	*
	* The abort has to CLEAR the timer rather than race it: a plain timeout would
	* hold the request open until its deadline even after the caller had given
	* up.
	*/
	async waitOutQueue(waitMs, signal) {
		if (waitMs <= 0) return;
		const cancelled = () => aborted("Request was aborted while waiting out the upstream queue.");
		if (signal?.aborted === true) throw cancelled();
		await new Promise((resolve, reject) => {
			let timer;
			const onAbort = () => {
				if (timer !== void 0) clearTimeout(timer);
				reject(cancelled());
			};
			timer = setTimeout(() => {
				signal?.removeEventListener("abort", onAbort);
				resolve();
			}, waitMs);
			signal?.addEventListener("abort", onAbort, { once: true });
		});
	}
	/**
	* The pause between the two paced self-heal rounds.
	*
	* Extracted from the heal itself because both the wait and the queue wait
	* above must behave the same way under an abort: `setTimeout` never fires for
	* a request whose signal is already aborted, and it must not leave a pending
	* promise behind either.
	*/
	async pauseBeforeNextHeal(options) {
		await new Promise((resolve, reject) => {
			const timer = setTimeout(resolve, 2e3);
			options.signal?.addEventListener("abort", () => {
				clearTimeout(timer);
				reject(aborted("Request was aborted during the re-auth backoff."));
			}, { once: true });
		});
	}
};
//#endregion
//#region src/qoder/transport/index.ts
function createQoderTransport(options) {
	return new DefaultQoderTransport(options);
}
//#endregion
//#region src/upstream.ts
/**
* Qoder upstream client — the loopback shim's OpenAI-shaped surface, carried
* over to the Qoder transport.
*
* The plugin's browser card, the CLI, and DSH's pi-ai adapter all reach Qoder
* through this one module. The wire reality changed underneath the WorkBuddy
* edition it replaces: there is no HTTP endpoint that accepts an OpenAI JSON
* body any more. Instead this module
*
* - **translates** the narrow OpenAI chat-completions request the shim forwards
*   (model, messages, tools, `max_tokens`, `temperature`, `stop`,
*   `reasoning_effort`) into dsh-llm's `GenerateOptions`, and
* - **re-serializes** the transport's `StreamChunk` vocabulary back into
*   `chat.completion.chunk` SSE frames, so the adapter side needs nothing
*   Qoder-specific, and
* - maps catalog discovery (`transport.discoverModels`) into the plugin's
*   model rows, and the account read (`transport.readAccount`) into the
*   card's credit shape.
*
* Failure classification follows the transport's error taxonomy
* (`QoderLlmError.failure.code` plus the HTTP status it carried); the
* WorkBuddy-era session/credit marker lists are gone with the upstream they
* described.
*
* @module dsh-qoder-plugin/upstream
*/
/** HTTP status the shim answers each failure kind with. */
const KIND_STATUS = {
	missing_credential: 401,
	auth: 401,
	soft_rate: 429,
	quota_exceeded: 402,
	server: 502,
	client: 400
};
/**
* Normalize a billing rate label for display.
*
* Qoder reports a `priceFactor` number; the host spells it `x<n>` (and the
* WorkBuddy-era saved files sometimes carried a trailing " credits"). The card
* wants one shape: a trimmed multiplier without the suffix.
*/
function normalizeCredits(credits) {
	if (credits === void 0) return void 0;
	const trimmed = credits.trim().replace(/\s+credits?$/iu, "");
	return trimmed === "" ? void 0 : trimmed;
}
/**
* Spell one catalog price multiplier the way the pickers show it: `x` + the
* factor, with WHOLE factors padded to one decimal.
*
* Qoder reports a bare number, so `0` and `1` would otherwise render as `x0`
* and `x1` beside fractional neighbours like `x0.79` / `x1.6` — the free tier
* then reads as a different KIND of value rather than a rate that happens to be
* zero (the same reasoning the card's `formatRate` records). Fractional factors
* keep the upstream's own precision: padding them to one decimal would turn a
* real `0.79` into a wrong `0.8`.
*/
function formatRateLabel(factor) {
	return `x${Number.isInteger(factor) ? factor.toFixed(1) : String(factor)}`;
}
/**
* Classify a raw HTTP upstream failure from status and a body excerpt.
*
* Status first, then phrases: a throttling body often also says "quota
* exceeded", and reading that as an exhausted balance parks a healthy account
* until the next billing day instead of retrying shortly.
*/
function classifyUpstreamError(status, body) {
	const lower = body.toLowerCase();
	if (qoderQueueSignal(body) !== void 0) return "soft_rate";
	if (status === 402) return "quota_exceeded";
	if (status === 429) return "soft_rate";
	if (status === 401 || status === 403) return "auth";
	for (const marker of [
		"quota exceeded",
		"insufficient quota",
		"quota_exhausted",
		"exhausted"
	]) if (lower.includes(marker)) return "quota_exceeded";
	for (const marker of [
		"rate limit",
		"too many requests",
		"throttl"
	]) if (lower.includes(marker)) return "soft_rate";
	for (const marker of [
		"invalid token",
		"invalid pat",
		"invalid job token",
		"token expired",
		"token has expired",
		"unauthorized",
		"forbidden",
		"not authenticated"
	]) if (lower.includes(marker)) return "auth";
	if (status === 0 || status >= 500) return "server";
	return "client";
}
/**
* Map one structured transport failure onto the shim's error kind.
*
* The transport's taxonomy (`src/qoder/errors.ts`) codes an HTTP 402 as
* `INVALID_REQUEST`, so the status gets the last say for the quota and auth
* families before the code-based defaults apply.
*
* `RATE_LIMIT` is tested before the auth family because the upstream's queue
* answer keeps its 401/403 status: a saturated qfmodel queue reads
* `code: RATE_LIMIT, status: 403` (body carries 10605/isQueued/
* retryAfterSeconds), and letting the status arm claim it reported a dead
* credential — which the host never retries — instead of a throttle it would.
*/
function kindFromQoderFailure(failure) {
	if (failure.code === "MISSING_CREDENTIAL") return "missing_credential";
	if (failure.code === "RATE_LIMIT") return "soft_rate";
	if (failure.code === "AUTH" || failure.status === 401 || failure.status === 403) return "auth";
	if (failure.status === 429) return "soft_rate";
	if (failure.code === "QUOTA" || failure.status === 402) return "quota_exceeded";
	if (failure.code.startsWith("INVALID_") || failure.code.startsWith("UNSUPPORTED_") || failure.code === "ATTACHMENT") return "client";
	return "server";
}
/**
* Whether a Personal Access Token works against one region's endpoints.
*
* Never throws: every outcome is reported as a value, so the caller can
* distinguish "the token is wrong" from "we could not find out".
*/
async function validateApiKey(pat, region, options = {}) {
	const trimmed = pat.trim();
	if (trimmed === "") return {
		ok: false,
		error: "invalid",
		reason: "the token is empty"
	};
	const timeoutMs = options.timeoutMs ?? 15e3;
	try {
		await createQoderTransport({
			region,
			resolvePat: async () => trimmed,
			...options.fetch === void 0 ? {} : { fetch: options.fetch },
			metadataTimeoutMs: timeoutMs
		}).discoverModels(AbortSignal.timeout(timeoutMs));
		return { ok: true };
	} catch (error) {
		return classifyKeyValidationFailure(error);
	}
}
/**
* Split a discovery failure into "the token was refused" and "no answer came".
*
* Only the first is the user's to fix. A timeout, a transport error, or a 5xx
* says nothing about the token, and reporting those as an invalid credential
* is what sent users hunting for a replacement PAT during a slow cold start.
*/
function classifyKeyValidationFailure(error) {
	const message = error instanceof Error ? error.message : String(error);
	const failure = error instanceof LlmError ? error.failure : void 0;
	if (failure === void 0) return {
		ok: false,
		error: "unreachable",
		reason: message.slice(0, 200)
	};
	if (failure.code === "AUTH" || failure.status === 401 || failure.status === 403) return {
		ok: false,
		error: "invalid",
		reason: message.slice(0, 200)
	};
	return {
		ok: false,
		error: "unreachable",
		reason: message.slice(0, 200)
	};
}
/** A request the OpenAI layer itself could not accept; the shim answers 400. */
var UpstreamRequestError = class extends Error {};
/** One `data:` frame of a `chat.completion.chunk` SSE body. */
function sseFrame(payload) {
	return `data: ${JSON.stringify(payload)}\n\n`;
}
const SSE_DONE = "data: [DONE]\n\n";
/** The media types the attachment service normalizes; anything else is refused. */
const IMAGE_MEDIA_TYPES = [
	"image/png",
	"image/jpeg",
	"image/webp",
	"image/gif"
];
function isRecord(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
function requiredString(value, what) {
	if (typeof value !== "string" || value.trim() === "") throw new UpstreamRequestError(`${what} must be a non-empty string`);
	return value;
}
/** Decode one `data:image/...;base64,` URL into typed bytes. */
function decodeDataImage(url) {
	const match = /^data:([a-z]+\/[a-z0-9.+-]+)(?:;[a-z0-9;=+.-]*)?,(.*)$/iu.exec(url);
	if (match === null) throw new UpstreamRequestError("image_url data URL is malformed");
	const mediaType = match[1].toLowerCase();
	if (!IMAGE_MEDIA_TYPES.includes(mediaType)) throw new UpstreamRequestError(`image media type "${mediaType}" is not supported (png, jpeg, webp, gif)`);
	let data;
	try {
		data = new Uint8Array(Buffer.from(match[2] ?? "", "base64"));
	} catch {
		throw new UpstreamRequestError("image_url base64 payload could not be decoded");
	}
	if (data.byteLength === 0) throw new UpstreamRequestError("image_url payload is empty");
	return {
		mediaType,
		data
	};
}
/**
* Parse one OpenAI content value (string or parts array) into text.
*
* With `imagesAs`, image parts are offered for commit — and a request that
* carries them without any commit path fails as a client error, because the
* Qoder wire can only ever transport a durable attachment reference.
*
* The accumulator is a plain mutable array because the caller keeps appending
* (tool calls join the assistant turn after its text and images); it is typed
* as `ContentBlock[]` rather than `Message['content']` because 0.1.7 made the
* latter `readonly`.
*/
async function openAiContentBlocks(content, role, imagesAs) {
	const blocks = [];
	const parts = typeof content === "string" || content === null || content === void 0 ? typeof content === "string" && content !== "" ? [{
		type: "text",
		text: content
	}] : [] : Array.isArray(content) ? content : (() => {
		throw new UpstreamRequestError(`${role} message content must be a string or a parts array`);
	})();
	for (const raw of parts) {
		if (!isRecord(raw) || typeof raw["type"] !== "string") throw new UpstreamRequestError(`${role} message content part is malformed`);
		switch (raw["type"]) {
			case "text":
				blocks.push({
					type: "text",
					text: typeof raw["text"] === "string" ? raw["text"] : ""
				});
				break;
			case "image_url": {
				if (role !== "user") throw new UpstreamRequestError("image parts are valid only in user messages");
				const imageUrl = raw["image_url"];
				const url = isRecord(imageUrl) && typeof imageUrl["url"] === "string" ? imageUrl["url"] : "";
				if (!url.toLowerCase().startsWith("data:")) throw new UpstreamRequestError("image_url must be an inline data: URL; remote image URLs are not fetched");
				if (imagesAs === void 0) throw new UpstreamRequestError("image input requires the DSH attachment service");
				const decoded = decodeDataImage(url);
				blocks.push(await imagesAs.commit(decoded));
				break;
			}
			default: throw new UpstreamRequestError(`unsupported content part type "${raw["type"]}"`);
		}
	}
	return blocks;
}
/**
* Translate one OpenAI chat-completions body into a `GenerateOptions` request.
*
* The layer is deliberately narrow: it accepts exactly what pi-ai's
* `openai-completions` API sends, and rejects anything else with an
* attributable 400 rather than silently dropping a caller's intent. System
* prompts ride `options.system` (the transport's own slot), not a leading
* message; tool results become dedicated user-role messages the Qoder
* serializer accepts.
*/
async function toGenerateOptions(bodyJson, context) {
	let parsed;
	try {
		parsed = JSON.parse(bodyJson);
	} catch {
		throw new UpstreamRequestError("request body is not valid JSON");
	}
	if (!isRecord(parsed)) throw new UpstreamRequestError("request body must be a JSON object");
	const model = requiredString(parsed["model"], "model");
	const rawMessages = parsed["messages"];
	if (!Array.isArray(rawMessages) || rawMessages.length === 0) throw new UpstreamRequestError("messages must be a non-empty array");
	const systemParts = [];
	const messages = [];
	for (const raw of rawMessages) {
		if (!isRecord(raw)) throw new UpstreamRequestError("each message must be an object");
		const role = raw["role"];
		switch (role) {
			case "system":
			case "developer":
				if (typeof raw["content"] !== "string") throw new UpstreamRequestError("system message content must be a string");
				if (raw["content"] !== "") systemParts.push(raw["content"]);
				break;
			case "user": {
				const content = await openAiContentBlocks(raw["content"], "user", context.attachments === void 0 ? void 0 : { commit: async (part) => ({
					type: "image",
					attachment: await context.attachments.saveImage({
						data: part.data,
						mediaType: part.mediaType
					})
				}) });
				messages.push(createUserMessage({
					content,
					source: { kind: "user" }
				}));
				break;
			}
			case "assistant": {
				const content = await openAiContentBlocks(raw["content"], "assistant", void 0);
				const rawCalls = raw["tool_calls"];
				if (Array.isArray(rawCalls)) for (const rawCall of rawCalls) {
					if (!isRecord(rawCall)) throw new UpstreamRequestError("each tool call must be an object");
					const fn = isRecord(rawCall["function"]) ? rawCall["function"] : rawCall;
					content.push({
						type: "tool-call",
						id: ToolCallId(requiredString(rawCall["id"], "tool call id")),
						name: requiredString(fn["name"], "tool call function name"),
						arguments: typeof fn["arguments"] === "string" ? fn["arguments"] : ""
					});
				}
				if (content.length === 0) break;
				messages.push(createAssistantMessage({
					content,
					source: {
						provider: context.providerId,
						model
					}
				}));
				break;
			}
			case "tool": {
				const callId = requiredString(raw["tool_call_id"], "tool_call_id");
				const content = raw["content"];
				let text;
				if (typeof content === "string") text = content;
				else if (Array.isArray(content)) {
					text = content.filter((part) => isRecord(part) && part["type"] === "text").map((part) => typeof part["text"] === "string" ? part["text"] : "").join("");
					if (content.some((part) => isRecord(part) && part["type"] !== "text")) throw new UpstreamRequestError("tool result content is limited to text");
				} else throw new UpstreamRequestError("tool message content must be a string or a text-parts array");
				messages.push(createToolResultMessage({
					callId: ToolCallId(callId),
					content: [{
						type: "text",
						text
					}],
					isError: false
				}));
				break;
			}
			default: throw new UpstreamRequestError(`unsupported message role "${String(role)}"`);
		}
	}
	if (messages.length === 0) throw new UpstreamRequestError("the request carries no model-facing message");
	const tools = Array.isArray(parsed["tools"]) ? parsed["tools"].map((raw) => {
		if (!isRecord(raw)) throw new UpstreamRequestError("each tool must be an object");
		const fn = isRecord(raw["function"]) ? raw["function"] : raw;
		if (!isRecord(fn)) throw new UpstreamRequestError("each tool must carry a function object");
		return {
			name: requiredString(fn["name"], "tool name"),
			description: typeof fn["description"] === "string" ? fn["description"] : "",
			parameters: isRecord(fn["parameters"]) ? fn["parameters"] : {}
		};
	}) : void 0;
	const effort = parsed["reasoning_effort"];
	const stop = parsed["stop"];
	const temperature = parsed["temperature"];
	const maxTokens = parsed["max_tokens"];
	const sessionId = context.sessionId === void 0 ? void 0 : context.sessionId;
	return {
		provider: context.providerId,
		model,
		messages,
		...systemParts.length > 0 ? { system: systemParts.join("\n") } : {},
		...tools === void 0 || tools.length === 0 ? {} : { tools },
		...typeof temperature === "number" && Number.isFinite(temperature) ? { temperature } : {},
		...typeof maxTokens === "number" && Number.isFinite(maxTokens) && maxTokens > 0 ? { maxTokens: Math.floor(maxTokens) } : {},
		...typeof effort === "string" && effort.trim() !== "" ? { reasoningEffort: ReasoningEffortId(effort.trim()) } : {},
		...Array.isArray(stop) ? { stop: stop.filter((entry) => typeof entry === "string") } : typeof stop === "string" ? { stop: [stop] } : {},
		...sessionId === void 0 ? {} : { sessionId },
		...context.signal === void 0 ? {} : { signal: context.signal }
	};
}
/**
* Re-serialize one `StreamChunk` sequence into OpenAI chunk frames.
*
* One assistant choice, deltas keyed by a per-block tool-call index that
* restarts at zero per block like OpenAI's own, reasoning streamed as
* `delta.reasoning_content` (the compatible extension other gateways use),
* usage as a choices-less frame before the terminal finish, and `data:
* [DONE]` last. A failed or aborted finish mid-stream becomes an error JSON
* frame and then `[DONE]`: the HTTP status is already sent and cannot carry
* the failure.
*/
var ChunkEncoder = class {
	id;
	created;
	model;
	started = false;
	terminal = false;
	toolIndexByBlock = /* @__PURE__ */ new Map();
	announcedTools = /* @__PURE__ */ new Set();
	nextToolIndex = 0;
	constructor(model) {
		this.id = `chatcmpl-${randomBytes(12).toString("hex")}`;
		this.created = Math.floor(Date.now() / 1e3);
		this.model = model;
	}
	frame(extra) {
		return sseFrame({
			id: this.id,
			object: "chat.completion.chunk",
			created: this.created,
			model: this.model,
			...extra
		});
	}
	/** The role frame opens every stream, once. */
	start() {
		if (this.started) return [];
		this.started = true;
		return [this.frame({ choices: [{
			index: 0,
			delta: { role: "assistant" },
			finish_reason: null
		}] })];
	}
	/** Translate one transport chunk into zero or more SSE frames. */
	frames(chunk) {
		switch (chunk.type) {
			case "block-start":
			case "block-end": return [];
			case "text-delta": return [this.frame({ choices: [{
				index: 0,
				delta: { content: chunk.text },
				finish_reason: null
			}] })];
			case "reasoning-delta": return [this.frame({ choices: [{
				index: 0,
				delta: { reasoning_content: chunk.text },
				finish_reason: null
			}] })];
			case "tool-call-delta": {
				let toolIndex = this.toolIndexByBlock.get(chunk.index);
				if (toolIndex === void 0) {
					toolIndex = this.nextToolIndex++;
					this.toolIndexByBlock.set(chunk.index, toolIndex);
				}
				const first = !this.announcedTools.has(chunk.index);
				if (first) this.announcedTools.add(chunk.index);
				const call = {
					index: toolIndex,
					...first ? {
						id: String(chunk.id),
						type: "function",
						function: {
							name: chunk.name ?? "",
							arguments: chunk.argumentsDelta
						}
					} : { function: { arguments: chunk.argumentsDelta } }
				};
				return [this.frame({ choices: [{
					index: 0,
					delta: { tool_calls: [call] },
					finish_reason: null
				}] })];
			}
			case "usage": {
				const cacheRead = chunk.usage.cacheReadTokens;
				const cacheWrite = chunk.usage.cacheWriteTokens;
				const prompt = chunk.usage.inputTokens + (cacheRead ?? 0) + (cacheWrite ?? 0);
				const completion = chunk.usage.outputTokens;
				const reasoning = chunk.usage.reasoningTokens;
				const details = cacheRead === void 0 && cacheWrite === void 0 ? void 0 : {
					...cacheRead === void 0 ? {} : { cached_tokens: cacheRead },
					...cacheWrite === void 0 ? {} : { cache_write_tokens: cacheWrite }
				};
				return [this.frame({
					choices: [],
					usage: {
						prompt_tokens: prompt,
						completion_tokens: completion,
						total_tokens: chunk.usage.totalTokens ?? prompt + completion,
						...details === void 0 ? {} : { prompt_tokens_details: details },
						...reasoning === void 0 ? {} : { completion_tokens_details: { reasoning_tokens: reasoning } }
					}
				})];
			}
			case "finish": {
				this.terminal = true;
				const reason = chunk.reason;
				if (reason.kind === "error" || reason.kind === "aborted") return [sseFrame({ error: {
					message: reason.failure.message,
					type: "server_error",
					code: reason.failure.code
				} }), SSE_DONE];
				const finishReason = reason.kind === "max-tokens" ? "length" : reason.kind === "tool-calls" ? "tool_calls" : "stop";
				return [this.frame({ choices: [{
					index: 0,
					delta: {},
					finish_reason: finishReason
				}] }), SSE_DONE];
			}
		}
	}
	/** Fallback finish when the chunk source ended without a finish chunk. */
	finishFallback() {
		if (this.terminal) return [];
		this.terminal = true;
		return [this.frame({ choices: [{
			index: 0,
			delta: {},
			finish_reason: "stop"
		}] }), SSE_DONE];
	}
	/** A thrown mid-stream failure, phrased as one error frame and the end. */
	abortFrames(message, code) {
		this.terminal = true;
		return [sseFrame({ error: {
			message,
			type: "server_error",
			code
		} }), SSE_DONE];
	}
};
/** Turn any thrown failure into the shim's classified pre-stream result. */
function failureResult(error) {
	if (error instanceof UpstreamRequestError) return {
		ok: false,
		status: 400,
		kind: "client",
		message: error.message
	};
	if (error instanceof LlmError) {
		const kind = kindFromQoderFailure(error.failure);
		return {
			ok: false,
			status: typeof error.failure.status === "number" && error.failure.status >= 100 && error.failure.status <= 599 ? error.failure.status : KIND_STATUS[kind],
			kind,
			message: error.failure.message
		};
	}
	return {
		ok: false,
		status: 502,
		kind: "server",
		message: String(error)
	};
}
/**
* Map one quota answer onto the card's credit shape.
*
* Qoder reports one personal quota, an optional organization resource package,
* and the day's bonus bucket; each becomes a package row the card already knows
* how to draw. An unbounded personal allowance (`total === 0`, not exceeded) is
* the account's "unlimited" state.
*
* `expiresAt` 是账号级的周期边界（喂给 `cycleResetTime`），不是任何资源包
* 自己的效期。此前三个包行都借用它作 `packageEndTime`，把同一个 9999 哨兵
* 同时印在三行上 —— 官方页各包效期互不相同。`quota/usage` 不含 per-bucket
* 效期字段，所以包行不携带效期，渲染为「无到期」，绝不猜日期。
*/
function creditsFromUsage(usage) {
	const accounts = [];
	const personal = usage.userQuota;
	if (personal !== void 0) accounts.push({
		packageName: "个人额度",
		remain: personal.remaining,
		size: personal.total
	});
	const org = usage.orgResourcePackage;
	if (org !== void 0) accounts.push({
		packageName: "组织资源包",
		remain: org.remaining,
		size: org.total
	});
	const addOn = usage.addOnQuota;
	if (addOn !== void 0) accounts.push({
		packageName: "赠送额度",
		remain: addOn.remaining,
		size: addOn.total
	});
	const unlimited = usage.isQuotaExceeded === false && personal !== void 0 && personal.total === 0;
	return {
		total: usage.totalUsagePercentage ?? personal?.percentage ?? 0,
		totalSize: accounts.reduce((sum, entry) => sum + entry.size, 0),
		accounts,
		...unlimited ? { unlimited: true } : {},
		...usage.expiresAt === void 0 ? {} : { cycleResetTime: usage.expiresAt }
	};
}
var QoderUpstreamClient = class {
	region;
	providerId;
	getPat;
	transport;
	attachments;
	externalCatalog;
	/** The raw discovery rows of the last successful `fetchModels`, by id. */
	discovered = /* @__PURE__ */ new Map();
	/** Provenance of the last successful catalog fetch, for the status card. */
	lastCatalog;
	/**
	* The subscriber name from the last successful account read; undefined
	* until one lands (or after it fails). `fetchCredits` runs on every status
	* poll, so this tracks the credential the card is already displaying
	* without a second upstream request.
	*/
	accountName;
	/**
	* The subscriber's coding plan from the same account read.
	*
	* `readAccount` already fetches `/api/v2/user/plan` on every call — the
	* answer was parsed and then dropped, so the card could show the credits a
	* plan grants without ever naming the plan. Cached here beside
	* {@link accountName} for the same reason: the status document needs it
	* without a second upstream request.
	*/
	accountPlan;
	constructor(options) {
		this.region = options.region;
		this.providerId = options.providerId;
		this.getPat = options.getPat;
		this.transport = options.transport;
		this.attachments = options.attachments;
		this.externalCatalog = options.catalogProvider;
	}
	/** The region this client's transport serves. */
	get clientRegion() {
		return this.region;
	}
	/**
	* The catalog row for one model id: this client's own discovery answers
	* first (it is the same data the upstream catalog call produced), and an
	* externally supplied provider — the plugin's fallback roster, say — fills
	* ids the discovery never listed.
	*/
	catalogModelFor(id) {
		return this.discovered.get(id) ?? this.externalCatalog?.(id);
	}
	/**
	* Discover this variant's models and translate them into plugin rows.
	*
	* The raw rows stay addressable via {@link catalogModelFor}: a chat request
	* for a discovered model must hand the transport its row, because effort
	* support, image capability, and the output cap are all validated against
	* it. The last successful fetch's provenance lands in {@link lastCatalog}
	* for the status card.
	*/
	async fetchModels(signal) {
		const models = await this.transport.discoverModels(signal);
		this.discovered.clear();
		for (const model of models) this.discovered.set(model.id, model);
		this.lastCatalog = {
			fetchedAtMs: Date.now(),
			source: `${this.providerId}:discovery`
		};
		return models.map(modelInfoOf);
	}
	/**
	* One named account's plan and credits, without adopting it.
	*
	* {@link fetchCredits} prices the credential that currently signs and caches
	* its name for the card; this reads a SPECIFIC pooled token so the composer
	* panel can price every account the user holds. The distinction is
	* load-bearing: reading a spare account must not relabel the ambient one, so
	* neither `accountName` nor `accountPlan` is touched here — the caller
	* projects the answer onto the row it belongs to.
	*
	* `force` is deliberately not offered: the account reader already caches per
	* token with single-flight, and pricing a whole pool on every status poll is
	* exactly the case that cache exists for.
	*/
	async fetchAccountBilling(pat, signal) {
		const account = await this.transport.readAccount({
			pat,
			...signal === void 0 ? {} : { signal }
		});
		const name = account.profile.name;
		return {
			...name === "" ? {} : { accountName: name },
			...account.plan === void 0 ? {} : { plan: account.plan },
			credits: creditsFromUsage(account.usage ?? {})
		};
	}
	/**
	* The ambient credential's quota answer, plus the name and plan it belongs
	* to, cached for the next status document.
	*
	* `force: true` is deliberate here and only here: this is the read the user
	* is looking at, and a cached figure that lags the account they just switched
	* to is the one staleness the card must not show. The per-account pool read
	* ({@link fetchAccountBilling}) is the opposite case and uses the cache.
	*
	* `maxAgeMs` is the caller's coalescing window, not a cache: the status route
	* hands a document to a page that mounts, prefetches, and polls, and each of
	* those used to spend its own billing round trip. Reusing an answer younger
	* than that window collapses the burst; the per-token cache key keeps the
	* window from ever spanning two credentials.
	*
	* The mapping itself lives in {@link creditsFromUsage}, shared with the pool
	* read so both price an account identically.
	*/
	async fetchCredits(signal, options) {
		const account = await this.transport.readAccount({
			force: true,
			...options?.maxAgeMs === void 0 ? {} : { minIntervalMs: options.maxAgeMs },
			...signal === void 0 ? {} : { signal }
		});
		this.accountName = account.profile.name === "" ? void 0 : account.profile.name;
		this.accountPlan = account.plan;
		return creditsFromUsage(account.usage ?? {});
	}
	/**
	* Run daily benefit check-in for this client's variant.
	*/
	async checkIn(signal) {
		return this.transport.checkIn(signal);
	}
	/**
	* Stream one translated chat-completions request.
	*
	* The first transport chunk is pulled before the response is constructed:
	* everything the transport can reject without touching the network — a
	* missing or empty credential, an effort the model does not advertise, an
	* image on a text-only model — must still be able to answer as a real HTTP
	* status, not as a 200 whose first frame is an error. Once streaming has
	* begun, failures degrade to the error-frame-then-`[DONE]` form the
	* {@link ChunkEncoder} documents.
	*
	* `sessionId` is the harness conversation this request belongs to, taken
	* from the affinity header the shim reads. It rides `GenerateOptions` so the
	* transport can keep one session on one account (session stickiness); an
	* absent id simply means the request is not sticky.
	*/
	async chatStream(bodyJson, signal, sessionId) {
		let options;
		try {
			options = await toGenerateOptions(bodyJson, {
				providerId: this.providerId,
				attachments: this.attachments,
				...signal === void 0 ? {} : { signal },
				...sessionId === void 0 ? {} : { sessionId }
			});
		} catch (error) {
			return failureResult(error);
		}
		try {
			await this.getPat();
		} catch {
			return {
				ok: false,
				status: KIND_STATUS.missing_credential,
				kind: "missing_credential",
				message: "no Qoder Personal Access Token is configured"
			};
		}
		const encoder = new ChunkEncoder(options.model);
		let iterator;
		try {
			iterator = this.transport.stream(options, this.catalogModelFor(options.model))[Symbol.asyncIterator]();
		} catch (error) {
			return failureResult(error);
		}
		try {
			const first = await iterator.next();
			if (!first.done) {
				const earlyFailure = first.value.type === "finish" && (first.value.reason.kind === "error" || first.value.reason.kind === "aborted") ? first.value.reason.failure : void 0;
				if (earlyFailure !== void 0) {
					await iterator.return?.();
					const kind = kindFromQoderFailure(earlyFailure);
					return {
						ok: false,
						status: earlyFailure.status ?? KIND_STATUS[kind],
						kind,
						message: earlyFailure.message
					};
				}
			}
			const stream = this.bodyStream(iterator, first, encoder);
			return {
				ok: true,
				response: new Response(stream, {
					status: 200,
					headers: {
						"Content-Type": "text/event-stream; charset=utf-8",
						"Cache-Control": "no-cache",
						"Connection": "keep-alive"
					}
				})
			};
		} catch (error) {
			await iterator.return?.();
			return failureResult(error);
		}
	}
	/** Drive the SSE body from an already-started chunk iterator. */
	bodyStream(iterator, first, encoder) {
		const encoderRef = encoder;
		const toBytes = (() => {
			const text = new TextEncoder();
			return (frame) => text.encode(frame);
		})();
		let queue = [];
		let pending = first;
		return new ReadableStream({
			pull: async (controller) => {
				try {
					while (queue.length === 0 && !encoderRef.terminal) {
						if (pending === void 0) pending = await iterator.next();
						const next = pending;
						pending = void 0;
						if (next.done) {
							queue.push(...encoderRef.finishFallback());
							break;
						}
						queue.push(...encoderRef.start(), ...encoderRef.frames(next.value));
					}
				} catch (error) {
					const message = error instanceof LlmError ? error.failure.message : String(error);
					const code = error instanceof LlmError ? error.failure.code : "TRANSPORT";
					queue = encoderRef.abortFrames(message, code);
				}
				if (queue.length > 0) {
					controller.enqueue(toBytes(queue.shift()));
					if (encoderRef.terminal && queue.length === 0) controller.close();
					return;
				}
				controller.close();
			},
			cancel: async () => {
				await iterator.return?.();
			}
		});
	}
	/**
	* One minimal reasoning-effort request, as the probe sweep needs it.
	*
	* The transport validates `reasoningEffort` against the model's advertised
	* efforts **locally** before any network call: a rejection therefore reads
	* as an attributable 400 with code `UNSUPPORTED_REASONING_EFFORT`, and an
	* accepted value costs exactly one streamed request, which this method ends
	* after the first chunk arrives. A probe on this upstream measures the
	* discovery catalog as much as the endpoint behind it — see the module docs
	* in `probe.ts`.
	*/
	async probeEffort(model, effort, signal) {
		try {
			await this.getPat();
		} catch {
			return {
				status: 401,
				streamed: false,
				errorCode: "MISSING_CREDENTIAL",
				detail: "no Personal Access Token configured"
			};
		}
		const options = {
			provider: this.providerId,
			model,
			messages: [createUserMessage({
				content: [{
					type: "text",
					text: PROBE_PROMPT
				}],
				source: { kind: "user" }
			})],
			maxTokens: 1,
			...effort === void 0 ? {} : { reasoningEffort: ReasoningEffortId(effort) },
			signal
		};
		try {
			const iterator = this.transport.stream(options, this.catalogModelFor(model))[Symbol.asyncIterator]();
			try {
				const first = await iterator.next();
				return {
					status: first.done ? 502 : 200,
					streamed: !first.done
				};
			} finally {
				await iterator.return?.();
			}
		} catch (error) {
			if (error instanceof LlmError) return {
				status: error.failure.status ?? defaultStatusForProbe(error.failure.code),
				streamed: false,
				errorCode: error.failure.code,
				detail: error.failure.message.slice(0, 300)
			};
			return {
				status: 0,
				streamed: false,
				detail: `transport error: ${String(error)}`
			};
		}
	}
};
/** Statuses {@link probeEffort} reports for failures the transport raised pre-network. */
function defaultStatusForProbe(code) {
	switch (code) {
		case "UNSUPPORTED_REASONING_EFFORT":
		case "UNSUPPORTED_CONTENT":
		case "INVALID_REQUEST": return 400;
		case "MISSING_CREDENTIAL":
		case "AUTH": return 401;
		case "RATE_LIMIT": return 429;
		case "QUOTA": return 402;
		default: return 502;
	}
}
/**
* Translate one Qoder catalog row into the plugin's model-info shape.
*
* The Qoder vocabulary carries less than the WorkBuddy one did — no badges,
* no promotions, no free/credits strings — so the billing section reports the
* price factor only, spelled `x<n>`, and says so honestly when the upstream
* reported nothing (`rateUnknown`). Context capacity comes from the effective
* window, with the declared options kept for the card and the maximum-window
* preference; a row with no capacity at all takes the transport's own default.
*/
function modelInfoOf(model) {
	const options = Object.values(model.contextOptions ?? {}).map((option) => option.tokenCount).filter((count) => typeof count === "number" && Number.isFinite(count) && count > 0);
	const supportedContextWindows = [...new Set(options)].sort((left, right) => left - right);
	const defaultOptions = Object.values(model.contextOptions ?? {}).filter((option) => option.isDefault === true);
	const contextWindow = model.contextWindow ?? (defaultOptions.length === 1 ? defaultOptions[0]?.tokenCount : void 0) ?? DEFAULT_CONTEXT_WINDOW;
	const reasoning = model.isReasoning === true || model.supportsEffort === true ? {
		supports: true,
		...model.reasoningEfforts === void 0 || model.reasoningEfforts.length === 0 ? {} : { supportedEfforts: model.reasoningEfforts.map((effort) => effort.id) },
		...model.defaultReasoningEffort === void 0 ? {} : { defaultEffort: model.defaultReasoningEffort },
		canDisableThinking: false
	} : void 0;
	const billing = model.priceFactor === void 0 ? {
		free: false,
		rateUnknown: true
	} : {
		credits: formatRateLabel(model.priceFactor),
		free: model.priceFactor === 0
	};
	return {
		id: model.id,
		name: model.name === "" ? model.id : model.name,
		contextWindow,
		...defaultOptions.length === 1 && defaultOptions[0]?.tokenCount !== void 0 ? { defaultContextWindow: defaultOptions[0].tokenCount } : {},
		...supportedContextWindows.length > 1 ? { supportedContextWindows } : {},
		maxTokens: model.maxTokens ?? DEFAULT_MAX_TOKENS,
		supportsImages: model.supportsImages === true,
		...reasoning === void 0 ? {} : { reasoning },
		billing,
		...model.source === void 0 ? {} : { source: model.source }
	};
}
/** The transport's own output cap for rows that declare none. */
const DEFAULT_MAX_TOKENS = 32768;
/** A conservative input budget for rows that declare none. */
const DEFAULT_CONTEXT_WINDOW = 18e4;
//#endregion
//#region src/version.ts
const QODER_CONNECT_VERSION = "1.1.0";
//#endregion
//#region src/host-heartbeat.ts
/**
* Host-side heartbeat: a small JSON file written into the plugin's data
* directory once the `qoder` providers are registered. The status CLI reads it
* to report whether the host bundle is alive, independent of the browser card.
*
* The browser (client) bundle cannot write files; its health is reported
* only through `console.error` on failure (see `src/client/index.tsx`).
* This asymmetry is intentional: the host is the load-bearing half, and
* a missing heartbeat unambiguously means the host never started.
*
* @module dsh-qoder-plugin/host-heartbeat
*/
/** Basename of the host heartbeat file inside the plugin's state directory. */
const QODER_HOST_HEARTBEAT_FILENAME = ".qoder-host-heartbeat.json";
/** Current on-disk heartbeat format; readers reject others. */
const HEARTBEAT_FORMAT_VERSION = 1;
/** Absolute path of the host heartbeat file. */
function qoderHostHeartbeatPath() {
	return join(qoderStateDir(), QODER_HOST_HEARTBEAT_FILENAME);
}
/**
* Write (or overwrite) the heartbeat after the host bundle registered the
* provider. A failed write is non-fatal: the host is already running, and
* the status CLI will simply report "heartbeat missing" rather than failing.
*/
async function writeHostHeartbeat() {
	const document = {
		version: HEARTBEAT_FORMAT_VERSION,
		package: "dsh-qoder-plugin",
		pluginVersion: QODER_CONNECT_VERSION,
		registeredAt: Date.now(),
		pid: process.pid
	};
	try {
		await mkdir(qoderStateDir(), { recursive: true });
		await writeFile(qoderHostHeartbeatPath(), JSON.stringify(document), "utf8");
	} catch {}
}
/** Remove the heartbeat on plugin disposal so a stale file does not linger. */
async function clearHostHeartbeat() {
	try {
		await rm(qoderHostHeartbeatPath(), { force: true });
	} catch {}
}
/** Read and validate the heartbeat; returns `undefined` when absent or malformed. */
async function readHostHeartbeat() {
	let raw;
	try {
		raw = await readFile(qoderHostHeartbeatPath(), "utf8");
	} catch {
		return;
	}
	try {
		const parsed = JSON.parse(raw);
		if (parsed.version === HEARTBEAT_FORMAT_VERSION && parsed.package === "dsh-qoder-plugin" && typeof parsed.registeredAt === "number" && typeof parsed.pid === "number") return {
			version: HEARTBEAT_FORMAT_VERSION,
			package: "dsh-qoder-plugin",
			pluginVersion: typeof parsed.pluginVersion === "string" ? parsed.pluginVersion : "unknown",
			registeredAt: parsed.registeredAt,
			pid: parsed.pid
		};
	} catch {}
}
/**
* Absolute start time (epoch ms) of the process holding `pid`, or `undefined`
* when it cannot be determined (no such PID, platform lacks a readable source).
*
* - macOS / Linux: `ps -o lstart=` prints a local-time "EEE MMM DD HH:MM:SS YYYY";
*   `Date.parse` resolves it against the local clock, which matches how
*   `registeredAt` (a `Date.now()` absolute value) is expressed.
* - Windows: WMI `CreationDate` is UTC (`YYYYMMDDHHMMSS.mmm+zzzz`); parsed with
*   `Date.UTC`, again comparable to `registeredAt`.
*
* Failures return `undefined` so callers can fall back to plain PID liveness
* rather than mis-report a running host as dead.
*/
function processStartTimeMs(pid) {
	try {
		if (process.platform === "win32") {
			const m = execFileSync("wmic", [
				"process",
				"where",
				`processid=${pid}`,
				"get",
				"CreationDate"
			], {
				encoding: "utf8",
				windowsHide: true
			}).match(/(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})\.\d+([+-]\d{4})/);
			if (m === null) return void 0;
			const [, y, mo, d, h, mi, s] = m;
			const ms = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s));
			return Number.isFinite(ms) ? ms : void 0;
		}
		const out = execFileSync("ps", [
			"-o",
			"lstart=",
			"-p",
			String(pid)
		], {
			encoding: "utf8",
			env: {
				...process.env,
				LC_ALL: "C",
				LANG: "C"
			}
		}).trim();
		if (out === "") return void 0;
		const ms = Date.parse(out);
		return Number.isFinite(ms) ? ms : void 0;
	} catch {
		return;
	}
}
/**
* Whether the heartbeat's PID is still alive *and* still the same process that
* registered it. A stale heartbeat (host crashed without clearing the file)
* is distinguished from a live host by two checks:
*
* 1. `process.kill(pid, 0)` — the PID exists (signal 0 tests existence).
* 2. The process holding that PID started at or before `registeredAt`. A host
*    that registered the heartbeat must have been started before writing it,
*    so `start <= registeredAt`; a recycled PID belongs to an unrelated process
*    started after the host died, so `start > registeredAt` correctly reads dead.
*
* PID-only detection is not enough: after a crash the OS may hand the same PID
* to an unrelated process, and the un-cleared stale heartbeat would otherwise
* produce a false "Host running". When the process start time cannot be read
* (e.g. unsupported platform) the check degrades to plain PID liveness.
*/
function isHeartbeatProcessAlive(heartbeat) {
	try {
		process.kill(heartbeat.pid, 0);
	} catch {
		return false;
	}
	const startAtMs = processStartTimeMs(heartbeat.pid);
	if (startAtMs === void 0) return true;
	return startAtMs <= heartbeat.registeredAt;
}
//#endregion
//#region src/variants.ts
/**
* The two Qoder products this one plugin serves.
*
* Both are the same upstream in different regions, and they differ by route
* (endpoints per `src/qoder/transport/endpoints.ts`), file identity, and display
* identity. Everything that varies between them is collected here as one
* descriptor, so no module has to carry its own `if (international)` branch and
* a third variant would be a data change rather than a refactor.
*
* Each variant holds its own Personal Access Token: a token minted on
* qoder.com does not work against the China deployment and vice versa, and the
* two files, routes, and catalogs never cross.
*
* This module is host-side (it names files and routes). The browser half takes
* the same ids and routes from the Node-free `status-paths.ts`, which stays the
* single source shared by both halves.
*
* @module dsh-qoder-plugin/variants
*/
/** China Qoder first: the no-suffix arm keeps the plugin's primary routes. */
const QODER_VARIANTS = [{
	id: "qoder",
	displayName: "Qoder",
	appName: "Qoder",
	region: "china",
	ownFilename: ".qoder-auth.json",
	probeFilename: ".qoder-probe.json",
	catalogFilename: ".qoder-catalog.json",
	statusPath: QODER_STATUS_PATH,
	probePath: QODER_PROBE_PATH,
	authPath: QODER_AUTH_PATH
}, {
	id: "qoder-global",
	displayName: "Qoder Global",
	appName: "Qoder Global",
	region: "global",
	ownFilename: ".qoder-global-auth.json",
	probeFilename: ".qoder-global-probe.json",
	catalogFilename: ".qoder-global-catalog.json",
	statusPath: QODER_GLOBAL_STATUS_PATH,
	probePath: QODER_GLOBAL_PROBE_PATH,
	authPath: QODER_GLOBAL_AUTH_PATH
}];
/** The China variant; the plugin's default and compatibility anchor. */
const CHINA_VARIANT = QODER_VARIANTS[0];
/** The international variant. */
const GLOBAL_VARIANT = QODER_VARIANTS[1];
/** Look up a variant by provider id. */
function variantFor(id) {
	return QODER_VARIANTS.find((variant) => variant.id === id);
}
//#endregion
export { QODER_SETTINGS_FACE_PATH as $, umidDir as A, PROBE_EFFORT_CANDIDATES as B, defaultDeviceSeedPath as C, installUmid as D, clearIdentityMemoryCache as E, identityTtlMs as F, FALLBACK_QODER_MODELS as G, randomSentinel as H, QoderAccountHealthTracker as I, QODER_DEVICE_RESET_PATH as J, QoderCatalog as K, getMachineId as L, clearMachineIdentityCache as M, identityCachePath as N, readUmidManifest as O, identityCacheStatus as P, QODER_PROBE_PATH as Q, formatQueueNotice as R, getClaimWindowDateString as S, rotateDeviceSeed as T, QoderCatalogStore as U, probeModel as V, qoderCatalogPath as W, QODER_GLOBAL_PROBE_PATH as X, QODER_GLOBAL_AUTH_PATH as Y, QODER_GLOBAL_STATUS_PATH as Z, modelInfoOf as _, QODER_HOST_HEARTBEAT_FILENAME as a, QoderCredentialStore as at, createQoderTransport as b, processStartTimeMs as c, qoderOwnAuthPath as ct, writeHostHeartbeat as d, qoderPluginDataDir as dt, QODER_STATUS_PATH as et, QODER_CONNECT_VERSION as f, qoderStateDir as ft, kindFromQoderFailure as g, classifyUpstreamError as h, variantFor as i, QODER_PAT_ENV_GLOBAL as it, umidInstalled as j, umidBinaryPath as k, qoderHostHeartbeatPath as l, QODER_DATA_DIR_ENV as lt, QoderUpstreamClient as m, GLOBAL_VARIANT as n, QODER_AUTH_FILENAME as nt, clearHostHeartbeat as o, patTail as ot, KIND_STATUS as p, QODER_AUTH_PATH as q, QODER_VARIANTS as r, QODER_PAT_ENV_CN as rt, isHeartbeatProcessAlive as s, qoderCredentialIdentity as st, CHINA_VARIANT as t, QODER_UMID_INSTALL_PATH as tt, readHostHeartbeat as u, QODER_DATA_DIR_NAME as ut, normalizeCredits as v, readDeviceSeed as w, qoderInnerErrorSnapshot as x, validateApiKey as y, formatQueueWaitNotice as z };
