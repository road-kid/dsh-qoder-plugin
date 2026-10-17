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
 * MIGRATION (one time)
 *   the file is absent → seed it from the entry config's own fields → write the
 *   file → delete ONLY this plugin's fields from the entry config (see
 *   ./index.ts), so the profile row returns to its shipped state.
 *
 * @module dsh-qoder-plugin/settings-store
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { qoderPluginDataDir } from './paths.ts'
// js-yaml is the parser the Host itself uses (cordis-plugin-include's
// dependency). It is NOT resolvable from a plugin's own module path — the Host
// keeps it in its own install root, and a plugin installed through a junction
// resolves its dependencies from its own checkout — so it is declared in this
// package's dependencies, installed into the checkout's node_modules, and
// inlined by the build, which keeps the published artifact self-contained.
//
// CJS interop: rolldown inlines this CJS module, and a named import across that
// boundary is not guaranteed to survive the transform. Resolve the callable off
// the default export, with the named shape first, so either outcome works.
// CJS interop: rolldown inlines this CJS module, and a named import across that
// boundary is not guaranteed to survive the transform. Resolve the callable off
// the default export, with the named shape first, so either outcome works. The
// module's shape is declared in ./js-yaml.d.ts.
import yamlModule from 'js-yaml'

const yaml = yamlModule as unknown as {
  load?: (text: string) => unknown
  default?: { load?: (text: string) => unknown }
}

const loadYaml = (typeof yaml.load === 'function' ? yaml.load : yaml.default?.load) as
  | ((text: string) => unknown)
  | undefined

/** Settings file name inside the plugin data directory. */
const SETTINGS_FILE_NAME = 'settings.json'
/** This plugin's data directory (shared with the credential and caches). */
export function dataDir(): string {
  return qoderPluginDataDir()
}

/** Absolute path of the settings file. */
export function settingsFilePath(): string {
  return join(dataDir(), SETTINGS_FILE_NAME)
}

/** Read + parse the settings file; `undefined` when absent or unreadable. */
function readFile(): Record<string, unknown> | undefined {
  const path = settingsFilePath()
  if (!existsSync(path)) return undefined
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : undefined
  } catch {
    // A corrupt file is not a reason to take the host down: the caller falls
    // back to the entry config, whose values still serve as a live fallback.
    return undefined
  }
}

/** Write the settings file atomically (tmp + rename), creating the directory. */
export function writeSettings(values: Record<string, unknown>): void {
  const path = settingsFilePath()
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.tmp`
  writeFileSync(tmp, `${JSON.stringify(values, null, 2)}\n`, 'utf8')
  renameSync(tmp, path)
}

/** Resolve `$DSH_HOME` the way the Host does, without importing a Host package. */
function dshHome(): string {
  const fromEnv: string | undefined = process.env.DSH_HOME?.trim() || undefined
  if (fromEnv !== undefined) return fromEnv
  return join(homedir(), '.dsh')
}

/**
 * Read this plugin's sections out of the legacy settings document.
 *
 * The 0.1.5 host kept every plugin's settings in `$DSH_HOME/settings.yaml`;
 * 0.1.7 renames it to `settings.yaml.imported` once, on the first boot, and
 * imports only the sections whose names match a profile entry id. This
 * plugin's 0.1.5 sections were keyed by its SERVED NAMESPACES (`qoder`,
 * `qoder-global`, `qoder-quota`), which name no entry in the profile — the row
 * is `llm-qoder-x` — so the platform refuses them and their data survives only
 * in the renamed document. Reading it here recovers that data independently of
 * the platform's import, its section-name mapping, and its timing.
 *
 * @param namespaces - the section names the 0.1.5 host keyed this plugin's
 *   settings under (one per served section).
 * @returns the union of those sections' fields, or undefined when the document
 *   is absent, unreadable, or holds none of them.
 */
export function readLegacySections(namespaces: readonly string[]): Record<string, unknown> | undefined {
  let path: string | undefined
  for (const name of ['settings.yaml', 'settings.yaml.imported']) {
    const candidate = join(dshHome(), name)
    if (existsSync(candidate)) { path = candidate; break }
  }
  if (path === undefined || loadYaml === undefined) return undefined
  let document: unknown
  try {
    document = loadYaml(readFileSync(path, 'utf8'))
  } catch {
    // Unreadable or unparsable: the legacy layer is a bonus, never a
    // requirement — the seed rule falls through to the entry and the defaults.
    return undefined
  }
  if (document === null || typeof document !== 'object') return undefined
  const merged: Record<string, unknown> = {}
  let found = false
  for (const ns of namespaces) {
    const section = (document as Record<string, unknown>)[ns]
    if (section === null || typeof section !== 'object' || Array.isArray(section)) continue
    Object.assign(merged, section)
    found = true
  }
  return found ? merged : undefined
}

/**
 * Reserved bookkeeping key: how many writes the settings card has made through
 * this store. Its presence separates "the file holds migration seed" from "the
 * file holds the user's live edits" — see the seed rule in ./index.ts. Field
 * readers address their fields by name and never collide with it.
 */
const WRITE_MARK = '__writes'

/**
 * One store instance: the plugin's own settings file, with the entry config as
 * the fallback layer the caller overlays it on.
 */
export class SettingsStore {
  /** The user layer exactly as stored (presence marks an override). */
  readonly user: Record<string, unknown>

  constructor() {
    this.user = readFile() ?? {}
  }

  /** Whether the store file exists. */
  exists(): boolean {
    return existsSync(settingsFilePath())
  }

  /**
   * Whether the settings card has ever written through this store.
   *
   * False during the migration window — the window where a 0.1.5 settings.yaml
   * import (which lands only after the Loader settles, i.e. AFTER this plugin's
   * first apply) can still deliver the user's real values, and where a first
   * seed may have been taken before that import. While false the entry config
   * stays authoritative; once the card writes, the file is — a runtime edit
   * must never be regressed by a stale profile row.
   */
  get edited(): boolean {
    return typeof this.user[WRITE_MARK] === 'number' && this.user[WRITE_MARK] > 0
  }

  /**
   * Apply one patch in memory and persist it.
   * @param patch - field → value; a `null` value clears the field.
   * @param fromCard - true when the settings card made this write; marks the
   *   file as holding live user edits from then on.
   * @returns the new user layer.
   */
  patch(patch: Record<string, unknown>, fromCard = false): Record<string, unknown> {
    const next = { ...this.user }
    for (const [field, value] of Object.entries(patch)) {
      if (value === null) delete next[field]
      else next[field] = value
    }
    if (fromCard) next[WRITE_MARK] = (typeof next[WRITE_MARK] === 'number' ? next[WRITE_MARK] : 0) + 1
    writeSettings(next)
    // Keep the in-memory view in step with the file without swapping the
    // reference the host captured: mutate in place.
    for (const key of Object.keys(this.user)) delete this.user[key]
    Object.assign(this.user, next)
    return this.user
  }

  /** The current user layer. */
  values(): Record<string, unknown> {
    return this.user
  }
}
