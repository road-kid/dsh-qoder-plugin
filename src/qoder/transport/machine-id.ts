import crypto from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

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
function defaultMachineIdPaths(): string[] {
  return [
    join(homedir(), '.qoder', '.auth', 'machine_id'),
    join(homedir(), '.dsh', 'qoder', 'machine_id'),
  ]
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
export function getMachineId(paths: readonly string[] = defaultMachineIdPaths()): string {
  for (const path of paths) {
    if (!existsSync(path)) continue
    try {
      const value = readFileSync(path, 'utf8').trim()
      if (value) return value
    } catch {
      // An unreadable file is not proof of an absent client, so keep looking.
    }
  }

  const machineId = crypto.randomUUID()
  const savePath = paths.at(-1)
  if (savePath !== undefined) {
    try {
      mkdirSync(dirname(savePath), { recursive: true })
      writeFileSync(savePath, machineId, { encoding: 'utf8', flag: 'wx' })
    } catch {
      // Another process may have won creation; prefer its stable value.
      try {
        const existing = readFileSync(savePath, 'utf8').trim()
        if (existing) return existing
      } catch {
        // An ephemeral id is still sufficient for this process.
      }
    }
  }
  return machineId
}
