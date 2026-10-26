#!/usr/bin/env node
import { A as umidDir, C as defaultDeviceSeedPath, D as installUmid, E as clearIdentityMemoryCache, F as identityTtlMs, G as FALLBACK_QODER_MODELS, M as clearMachineIdentityCache, N as identityCachePath, O as readUmidManifest, U as QoderCatalogStore, W as qoderCatalogPath, at as QoderCredentialStore, b as createQoderTransport, f as QODER_CONNECT_VERSION, i as variantFor, j as umidInstalled, k as umidBinaryPath, l as qoderHostHeartbeatPath, m as QoderUpstreamClient, r as QODER_VARIANTS, s as isHeartbeatProcessAlive, st as qoderCredentialIdentity, t as CHINA_VARIANT, u as readHostHeartbeat, y as validateApiKey } from "./variants-BUtMu_pg.js";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { existsSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
//#region src/bin.ts
/** Standalone status/diagnostics/PAT CLI for the dsh-qoder-plugin bundle. */
const JSON_SCHEMA_VERSION = 1;
/** Remove token-like strings from an unexpected diagnostic message. */
function safeMessage(error) {
	return (error instanceof Error ? error.message : String(error)).replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/gu, "[redacted token]").replace(/(\b(?:code|token|pat)=)[^&\s]+/giu, "$1[redacted]");
}
function printHelp() {
	process.stdout.write([
		"Usage: dsh-qoder-plugin <doctor|status|pat|logout|catalog|umid> [--provider <id>] [--json] [--file <path>]",
		"",
		"  doctor         secret-free environment diagnostics",
		"  status         credential state and remaining Qoder credit",
		"  pat set        validate and store a Personal Access Token (arg, --file, or stdin)",
		"  pat clear      remove the stored credential",
		"  logout         alias for `pat clear`",
		"  catalog refresh   re-fetch the model list and save it for this account",
		"",
		"  umid install      fetch and install the native device-identity component",
		"  umid status       show the component, its manifest and the identity cache",
		"  umid reset-native remove the identity seed so the next run mints a new one",
		"",
		"  --provider  which product to act on; defaults to qoder",
		`              one of: ${QODER_VARIANTS.map((variant) => variant.id).join(", ")}`,
		"  --json      emit one secret-free JSON document (doctor/status/umid only)",
		"  --file      file to read the token from with `pat set`; \"-\" reads standard input",
		"",
		"  umid install flags:",
		"    --from-tarball <path>  install from a local tarball instead of the registry",
		"    --version <version>    pin a published version (default: dist-tags.latest)",
		"    --force                reinstall even when the component is already present",
		"  umid reset-native flags:",
		"    --yes                  actually delete; without it the command only lists the targets",
		"",
		"  A token can also arrive as the positional argument after `pat set`.",
		"  Environment fallback: QODER_CN_PERSONAL_ACCESS_TOKEN (qoder) or",
		"  QODER_PERSONAL_ACCESS_TOKEN (qoder-global) when no file is saved.",
		""
	].join("\n"));
}
function printJson(value) {
	process.stdout.write(`${JSON.stringify(value)}\n`);
}
/** One variant's store. */
function makeStore(variant) {
	return new QoderCredentialStore({ variant });
}
/** One variant's store plus the upstream client riding its transport. */
function makeClient(store, variant) {
	const transport = createQoderTransport({
		region: variant.region,
		resolvePat: () => store.patPromise()
	});
	return new QoderUpstreamClient({
		region: variant.region,
		providerId: variant.id,
		getPat: () => store.patPromise(),
		transport
	});
}
async function doctor(jsonOutput, variant) {
	const store = makeStore(variant);
	const status = await store.status();
	const heartbeat = await readHostHeartbeat();
	const hostAlive = heartbeat !== void 0 && isHeartbeatProcessAlive(heartbeat);
	const component = readUmidComponentReport();
	const identityCache = readIdentityCacheReport(variant.region);
	const report = {
		schemaVersion: JSON_SCHEMA_VERSION,
		package: "dsh-qoder-plugin",
		version: QODER_CONNECT_VERSION,
		node: process.version,
		provider: variant.id,
		displayName: variant.displayName,
		region: variant.region,
		credentialFile: store.ownAuthPath(),
		hostHeartbeat: {
			path: qoderHostHeartbeatPath(),
			present: heartbeat !== void 0,
			...heartbeat === void 0 ? {} : {
				registeredAt: heartbeat.registeredAt,
				pid: heartbeat.pid
			},
			processAlive: hostAlive
		},
		signIn: status.state,
		...status.pat === void 0 ? {} : { pat: status.pat },
		...status.reason === void 0 ? {} : { reason: status.reason },
		fallbackModels: FALLBACK_QODER_MODELS.length,
		nativeDevice: {
			componentDir: component.componentDir,
			binary: component.binary,
			installed: component.installed,
			...component.manifest === void 0 ? {} : { manifest: component.manifest },
			identityCache
		},
		hints: [...status.state === "configured" ? [] : [`Save a token with \`dsh-qoder-plugin pat set <token> --provider ${variant.id}\`, or from the plugin's settings card.`], ...hostAlive ? [] : ["Host bundle not running in this DSH profile (or the process exited). The browser card is unavailable until DSH starts the plugin; the pat command above still works."]]
	};
	if (jsonOutput) printJson(report);
	else process.stdout.write([
		`${variant.displayName} Connect ${QODER_CONNECT_VERSION} on ${process.version}`,
		`Region: ${report.region}`,
		`Credential file: ${report.credentialFile}`,
		`Host bundle: ${hostAlive ? `running (pid ${heartbeat.pid})` : heartbeat !== void 0 ? "stale heartbeat (process exited)" : "not started"}`,
		`Credential: ${status.state === "configured" ? `configured (${status.pat?.source ?? "file"}${status.pat?.patTail === void 0 ? "" : `, tail …${status.pat.patTail}`})` : "missing"}`,
		...status.reason === void 0 ? [] : [`Note: ${status.reason}`],
		`Static fallback models: ${report.fallbackModels}`,
		`Native device: ${component.installed ? `component installed at ${component.componentDir}` : `component not installed (would live at ${component.componentDir})`}`,
		...component.manifest === void 0 ? [] : [`  ${describeUmidManifest(component.manifest)}`],
		`Identity cache: ${describeIdentityCache(identityCache)}`,
		...report.hints.map((hint) => `Hint: ${hint}`),
		""
	].join("\n"));
	return status.state === "configured" ? 0 : 1;
}
async function status(jsonOutput, variant) {
	const store = makeStore(variant);
	const auth = await store.status();
	const base = {
		schemaVersion: JSON_SCHEMA_VERSION,
		package: "dsh-qoder-plugin",
		version: QODER_CONNECT_VERSION,
		provider: variant.id,
		region: variant.region,
		credentialFile: auth.filePath,
		signIn: auth.state,
		...auth.pat === void 0 ? {} : { pat: auth.pat },
		...auth.reason === void 0 ? {} : { reason: auth.reason }
	};
	if (auth.state !== "configured") {
		if (jsonOutput) printJson({
			...base,
			credits: void 0
		});
		else process.stdout.write([
			`${variant.displayName}: no credential configured at ${auth.filePath}`,
			...auth.reason === void 0 ? [] : [`Note: ${auth.reason}`],
			"Save a token with `pat set` or from the plugin’s settings card.",
			""
		].join("\n"));
		return 1;
	}
	const client = makeClient(store, variant);
	try {
		const credits = await client.fetchCredits();
		if (jsonOutput) printJson({
			...base,
			credits
		});
		else process.stdout.write([
			`${variant.displayName} (${variant.region}): token from ${auth.pat?.source ?? "file"}${auth.pat?.patTail === void 0 ? "" : `, tail …${auth.pat.patTail}`}`,
			credits.unlimited ? "Quota: unlimited for the current cycle" : `Quota: ${Math.max(0, 100 - credits.total).toFixed(1)}% remaining of the cycle allowance`,
			...credits.accounts.map((account) => `  ${account.packageName}: ${account.remain}/${account.size}${account.unlimited ? " (unlimited)" : ""}`),
			...credits.cycleResetTime === void 0 ? [] : [`  resets: ${credits.cycleResetTime}`],
			""
		].join("\n"));
		return 0;
	} catch (error) {
		if (jsonOutput) printJson({
			...base,
			creditsError: safeMessage(error)
		});
		else process.stdout.write(`${variant.displayName}: credential stored, but the quota call failed: ${safeMessage(error)}\n`);
		return 1;
	}
}
/** Read a token from the positional arg, --file, or standard input. */
async function readPat(source, rest) {
	const inline = rest.find((argument) => !argument.startsWith("--"));
	const pat = (source === void 0 ? inline ?? await readStdin() : source === "-" ? await readStdin() : await readFile(source, "utf8"))?.trim() ?? "";
	if (pat === "") throw new Error("no token given: pass it as an argument, via --file <path>, or on standard input");
	return pat;
}
async function readStdin() {
	const chunks = [];
	for await (const chunk of process.stdin) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
	return Buffer.concat(chunks).toString("utf8");
}
async function patSet(variant, file, rest) {
	const store = makeStore(variant);
	const pat = await readPat(file, rest);
	process.stdout.write(`Validating a token against ${variant.displayName} (${variant.region})…\n`);
	const validation = await validateApiKey(pat, variant.region);
	if (!validation.ok) {
		if (validation.error === "unreachable") {
			process.stderr.write(`dsh-qoder-plugin: could not reach ${variant.displayName} to verify the token (${validation.reason}). Nothing was saved.\n`);
			process.stderr.write("This is a network or endpoint problem, not a rejected token — check connectivity and try again.\n");
			return 2;
		}
		process.stderr.write(`dsh-qoder-plugin: the token was refused by ${variant.displayName} (${variant.region}). Nothing was saved.\n`);
		process.stderr.write("If this token belongs to the other Qoder product, use --provider for that one.\n");
		return 2;
	}
	await store.save(pat, "cli");
	const status = await store.status();
	process.stdout.write([
		`Saved to ${store.ownAuthPath()}${status.pat?.patTail === void 0 ? "" : ` (tail …${status.pat.patTail})`}`,
		"The running plugin picks the token up on its next sweep; no restart needed.",
		""
	].join("\n"));
	return 0;
}
async function patClear(variant) {
	const store = makeStore(variant);
	await store.clear();
	const status = await store.status();
	process.stdout.write(status.state === "configured" ? `${variant.displayName} Connect: removed the stored file, but a token is still active from the environment (${status.pat?.source ?? "env"}).\n` : `${variant.displayName} Connect: signed out; removed ${store.ownAuthPath()}\n`);
	return 0;
}
async function catalogRefresh(variant) {
	const store = makeStore(variant);
	const credential = await store.resolve();
	const client = makeClient(store, variant);
	const models = await client.fetchModels();
	const identity = qoderCredentialIdentity(credential);
	const fetch = client.lastCatalog;
	new QoderCatalogStore({ path: qoderCatalogPath(variant.catalogFilename) }).set(identity, {
		source: fetch?.source ?? "unknown",
		fetchedAtMs: fetch?.fetchedAtMs ?? Date.now(),
		models: [...models]
	});
	process.stdout.write(`${variant.displayName}: fetched ${models.length} models; saved for account ${identity}.\n`);
	return 0;
}
/**
* The seed the Qoder client itself fingerprints (SPEC-UMID-003 §5.10, R8).
*
* Not this plugin's file: it belongs to the user's real client, which is why
* only `umid reset-native --yes` may delete it, and why nothing here recreates
* it — the client writes it on its next run, from the machine it is on.
*/
function nativeSeedPath(home = homedir()) {
	return join(home, ".config", ".locale_cfg");
}
/**
* Read the identity cache without changing it.
*
* Deliberately not {@link readCachedIdentity}: that function deletes a document
* it cannot migrate, which is right for the transport (it would fail on every
* check-in otherwise) but wrong for a diagnostics command — `doctor` must be
* safe to run on a machine whose state is already broken. A malformed document
* is therefore reported as absent rather than quietly repaired.
*/
function readIdentityCacheReport(region, options = {}) {
	const path = identityCachePath(options.home ?? homedir());
	const ttlMs = identityTtlMs(options.env ?? process.env);
	const now = options.now ?? Date.now();
	const absent = {
		path,
		present: false,
		stale: false,
		ttlMs
	};
	let document;
	try {
		document = JSON.parse(readFileSync(path, "utf8"));
	} catch {
		return absent;
	}
	if (typeof document !== "object" || document === null) return absent;
	const realm = document.realm;
	if (typeof realm !== "object" || realm === null) return absent;
	const entry = realm[region];
	if (typeof entry !== "object" || entry === null) return absent;
	const cachedAt = entry.cachedAt;
	if (typeof cachedAt !== "number" || !Number.isFinite(cachedAt)) return absent;
	const ageMs = now - cachedAt;
	return {
		path,
		present: true,
		cachedAt,
		ageMs,
		stale: ttlMs > 0 && ageMs >= ttlMs,
		ttlMs
	};
}
/** One line describing the identity cache, shared by `doctor` and `umid status`. */
function describeIdentityCache(report) {
	if (!report.present) return `absent at ${report.path}`;
	const cachedAt = report.cachedAt === void 0 ? "unknown" : new Date(report.cachedAt).toISOString();
	const freshness = report.ttlMs <= 0 ? "TTL 0, never expires" : report.stale ? `stale, TTL ${report.ttlMs} ms` : `fresh, TTL ${report.ttlMs} ms`;
	return `present at ${report.path} (cached ${cachedAt}, ${freshness})`;
}
/** One line describing the self-check that gated an install. */
function describeSelfCheck(check) {
	const prefix = check.machineTokenSha256Prefix;
	return `${check.ok ? "passed" : "failed"}${prefix === void 0 ? "" : ` (machine token sha256 …${prefix})`}`;
}
/** One line describing an installed manifest. */
function describeUmidManifest(manifest) {
	return [
		`version ${manifest.source.version}`,
		`installed ${manifest.installedAt}`,
		`self-check ${describeSelfCheck(manifest.selfCheck)}`
	].join(", ");
}
function readUmidComponentReport() {
	const componentDir = umidDir();
	const manifest = readUmidManifest(componentDir);
	return {
		componentDir,
		binary: umidBinaryPath(process.platform, componentDir),
		installed: umidInstalled(componentDir),
		...manifest === void 0 ? {} : { manifest }
	};
}
/**
* `umid install`: fetch, verify, self-check and promote the native component.
*
* Progress is written to stderr so `--json` still emits exactly one document on
* stdout; both branches carry the same facts. A failure is exit 1, never 2 —
* 2 is reserved for a malformed command line, which the caller detects before
* reaching this function.
*/
async function umidInstall(options) {
	const result = await installUmid({
		force: options.force,
		...options.fromTarball === void 0 ? {} : { tarballPath: options.fromTarball },
		...options.version === void 0 ? {} : { version: options.version },
		logger: {
			info: (message) => process.stderr.write(`${message}\n`),
			warn: (message) => process.stderr.write(`warning: ${message}\n`)
		}
	});
	if (options.json) printJson({
		schemaVersion: JSON_SCHEMA_VERSION,
		package: "dsh-qoder-plugin",
		command: "umid install",
		...result
	});
	else if (result.ok) process.stdout.write([
		`Native device component ${result.skipped ? "already installed" : "installed"}: ${result.version} in ${result.destDir}`,
		...result.files.map((file) => `  ${file.name} (${file.bytes} bytes)`),
		`Self-check: ${describeSelfCheck(result.selfCheck)}`,
		""
	].join("\n"));
	else process.stderr.write(`dsh-qoder-plugin: umid install failed: ${safeMessage(result.error ?? "unknown error")}\n`);
	return result.ok ? 0 : 1;
}
/**
* `umid status`: report the component, its manifest and the identity cache.
*
* Exit 0 even when nothing is installed: the command succeeded at reporting,
* and "no component yet" is the normal state on a machine that has never run
* the plugin. Failing here would make a status probe look like a fault.
*/
function umidStatus(jsonOutput, variant) {
	const component = readUmidComponentReport();
	const identity = readIdentityCacheReport(variant.region);
	const report = {
		schemaVersion: JSON_SCHEMA_VERSION,
		package: "dsh-qoder-plugin",
		command: "umid status",
		provider: variant.id,
		region: variant.region,
		componentDir: component.componentDir,
		binary: component.binary,
		installed: component.installed,
		...component.manifest === void 0 ? {} : { manifest: component.manifest },
		identityCache: identity,
		identityTtlNote: "QODER_UMID_IDENTITY_TTL only decides when the identity is re-sampled; it never clears the stored seed (R9)."
	};
	if (jsonOutput) printJson(report);
	else process.stdout.write([
		`Native device component: ${component.installed ? `installed at ${component.componentDir}` : `not installed (would live at ${component.componentDir})`}`,
		...component.manifest === void 0 ? [] : [`  ${describeUmidManifest(component.manifest)}`],
		`Identity cache: ${describeIdentityCache(identity)}`,
		`Note: ${report.identityTtlNote}`,
		...component.installed ? [] : ["Hint: run `dsh-qoder-plugin umid install` to fetch the component."],
		""
	].join("\n"));
	return 0;
}
/**
* `umid reset-native`: forget this machine's device seed and cached identity.
*
* Without `--yes` this is a dry run that only prints what would happen, because
* the seed is what the upstream has been told about this machine and its loss
* is irreversible.
*
* The order inside `--yes` is load-bearing: the seed is deleted first, then the
* disk cache, then the in-process cache. Deleting the cache first would leave a
* window in which a concurrent check-in still finds the seed, re-samples the
* identity the seed no longer backs, and writes it straight back — the reset
* would silently undo itself. The identity cache also has a default TTL of 0
* (never expires), so clearing it is not optional: without this step a reset
* keeps returning the old identity forever.
*
* `~/.config/.locale_cfg` — the official Qoder client's own seed — is never
* touched. It is the user's file, and rotating it would change the identity of
* their real client, not of this plugin.
*
* Exit 1 only when the seed was present and is still there afterwards: that is
* the one failure that makes the reset a lie. A cache clear that reports `false`
* is reported in words but is not a failure — the cache may simply have been
* empty already.
*/
function umidResetNative(options) {
	const home = homedir();
	const seedPath = defaultDeviceSeedPath();
	const cachePath = identityCachePath(home);
	const officialSeedPath = nativeSeedPath(home);
	const seedPresent = existsSync(seedPath);
	const cachePresent = existsSync(cachePath);
	let cacheCleared = false;
	if (options.yes) {
		if (seedPresent) try {
			rmSync(seedPath, { force: true });
		} catch {}
		try {
			cacheCleared = clearMachineIdentityCache({ home });
		} catch {
			cacheCleared = false;
		}
		clearIdentityMemoryCache();
	}
	const seedGone = !existsSync(seedPath);
	const impact = "The next check-in mints a fresh device seed and samples a fresh identity; the previous identity cannot be recovered.";
	const officialNote = `Official client identity ${officialSeedPath} is untouched: only the Qoder client writes and rotates it.`;
	const seedLine = options.yes ? seedPresent ? seedGone ? `Removed device seed: ${seedPath}` : `Failed to remove device seed: ${seedPath}` : `Device seed already absent: ${seedPath}` : seedPresent ? `Would delete device seed: ${seedPath}` : `Device seed already absent: ${seedPath}`;
	const cacheLine = options.yes ? cacheCleared ? `Cleared identity cache: ${cachePath}` : cachePresent ? `Failed to clear identity cache: ${cachePath}` : `Identity cache already absent: ${cachePath}` : cachePresent ? `Would clear identity cache: ${cachePath}` : `Identity cache already absent: ${cachePath}`;
	if (options.json) printJson({
		schemaVersion: JSON_SCHEMA_VERSION,
		package: "dsh-qoder-plugin",
		command: "umid reset-native",
		dryRun: !options.yes,
		seed: {
			path: seedPath,
			present: seedPresent,
			removed: options.yes && seedGone
		},
		identityCache: {
			path: cachePath,
			present: cachePresent,
			cleared: cacheCleared
		},
		memoryCacheCleared: options.yes,
		officialClientSeed: {
			path: officialSeedPath,
			touched: false
		},
		impact
	});
	else process.stdout.write([
		seedLine,
		cacheLine,
		options.yes ? "Cleared the in-process identity memory cache" : "Would clear the in-process identity memory cache",
		officialNote,
		`Impact: ${impact}`,
		...options.yes ? [] : ["Re-run with --yes to perform this reset."],
		""
	].join("\n"));
	return !options.yes || seedGone ? 0 : 1;
}
/** Execute one boot-free command. */
async function run(argv) {
	if (argv.length === 0 || argv[0] === "--help" || argv[0] === "-h") {
		printHelp();
		return 0;
	}
	const [rawAction, ...flags] = argv;
	if (![
		"doctor",
		"status",
		"pat",
		"logout",
		"catalog",
		"umid"
	].includes(rawAction)) {
		process.stderr.write(`dsh-qoder-plugin: expected doctor, status, pat, logout, catalog, or umid; got ${JSON.stringify(rawAction)}\n`);
		return 1;
	}
	const action = rawAction;
	const jsonOutput = flags.includes("--json");
	let providerId;
	let file;
	let fromTarball;
	let pinnedVersion;
	let force = false;
	let yes = false;
	const rest = [];
	for (let index = 0; index < flags.length; index += 1) {
		const flag = flags[index];
		if (flag === "--provider") {
			providerId = flags[index + 1];
			index += 1;
			continue;
		}
		if (flag.startsWith("--provider=")) {
			providerId = flag.slice(11);
			continue;
		}
		if (flag === "--file") {
			file = flags[index + 1];
			index += 1;
			continue;
		}
		if (flag.startsWith("--file=")) {
			file = flag.slice(7);
			continue;
		}
		if (flag === "--from-tarball" || flag === "--version") {
			const value = flags[index + 1];
			if (value === void 0 || value.startsWith("--")) {
				process.stderr.write(`dsh-qoder-plugin: ${flag} needs a value\n`);
				return 2;
			}
			if (flag === "--from-tarball") fromTarball = value;
			else pinnedVersion = value;
			index += 1;
			continue;
		}
		if (flag.startsWith("--from-tarball=")) {
			fromTarball = flag.slice(15);
			continue;
		}
		if (flag.startsWith("--version=")) {
			pinnedVersion = flag.slice(10);
			continue;
		}
		if (flag === "--force") {
			force = true;
			continue;
		}
		if (flag === "--yes") {
			yes = true;
			continue;
		}
		rest.push(flag);
	}
	const variant = providerId === void 0 ? CHINA_VARIANT : variantFor(providerId);
	if (variant === void 0) {
		process.stderr.write(`dsh-qoder-plugin: unknown provider ${JSON.stringify(providerId)}; expected one of ${QODER_VARIANTS.map((v) => v.id).join(", ")}\n`);
		return 1;
	}
	let patCommand;
	let catalogCommand;
	let umidCommand;
	if (action === "pat") {
		const sub = rest.shift();
		patCommand = sub === "set" || sub === "clear" ? sub : void 0;
		if (patCommand === void 0) {
			process.stderr.write(`dsh-qoder-plugin: pat needs set or clear; got ${JSON.stringify(sub ?? "")}\n`);
			return 1;
		}
	}
	if (action === "catalog") {
		const sub = rest.shift();
		catalogCommand = sub === "refresh" ? sub : void 0;
		if (catalogCommand === void 0) {
			process.stderr.write(`dsh-qoder-plugin: catalog needs refresh; got ${JSON.stringify(sub ?? "")}\n`);
			return 1;
		}
	}
	if (action === "umid") {
		const sub = rest.shift();
		umidCommand = sub === "install" || sub === "status" || sub === "reset-native" ? sub : void 0;
		if (umidCommand === void 0) {
			process.stderr.write(`dsh-qoder-plugin: umid needs install, status, or reset-native; got ${JSON.stringify(sub ?? "")}\n`);
			return 2;
		}
	}
	if (rest.filter((flag) => flag !== "--json" && !flag.startsWith("--")).length > 0 || jsonOutput && action !== "doctor" && action !== "status" && action !== "umid") {
		process.stderr.write(`dsh-qoder-plugin: invalid options for ${action}: ${flags.join(" ")}\n`);
		return 1;
	}
	if (action !== "pat" && file !== void 0) {
		process.stderr.write(`dsh-qoder-plugin: --file applies to pat set, not ${action}\n`);
		return 1;
	}
	const umidOnlyFlags = [
		...fromTarball === void 0 ? [] : ["--from-tarball"],
		...pinnedVersion === void 0 ? [] : ["--version"],
		...force ? ["--force"] : []
	];
	if (umidOnlyFlags.length > 0 && !(action === "umid" && umidCommand === "install")) {
		const verb = umidOnlyFlags.length === 1 ? "applies" : "apply";
		process.stderr.write(`dsh-qoder-plugin: ${umidOnlyFlags.join(", ")} ${verb} to \`umid install\` only\n`);
		return 2;
	}
	if (yes && !(action === "umid" && umidCommand === "reset-native")) {
		process.stderr.write("dsh-qoder-plugin: --yes applies to `umid reset-native` only\n");
		return 2;
	}
	try {
		switch (action) {
			case "doctor": return await doctor(jsonOutput, variant);
			case "status": return await status(jsonOutput, variant);
			case "pat": return patCommand === "set" ? await patSet(variant, file, rest) : await patClear(variant);
			case "logout": return await patClear(variant);
			case "catalog": return await catalogRefresh(variant);
			case "umid":
				if (umidCommand === "install") return await umidInstall({
					fromTarball,
					version: pinnedVersion,
					force,
					json: jsonOutput
				});
				if (umidCommand === "status") return umidStatus(jsonOutput, variant);
				return umidResetNative({
					yes,
					json: jsonOutput
				});
		}
	} catch (error) {
		process.stderr.write(`dsh-qoder-plugin: ${action} failed: ${safeMessage(error)}\n`);
		return 1;
	}
}
if (process.argv[1] !== void 0 && fileURLToPath(import.meta.url) === realpathSync(process.argv[1])) process.exitCode = await run(process.argv.slice(2));
//#endregion
export { run };
