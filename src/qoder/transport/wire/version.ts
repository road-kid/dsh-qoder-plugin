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
function readOverride(name: string, fallback: string): string {
  const raw = process.env[name]?.trim()
  return raw ? raw : fallback
}

/**
 * Official qodercli version. Overridable through `QODER_IDE_VERSION` so a
 * roll-out can follow the real client without a rebuild.
 */
export const qoderIdeVersion: string = readOverride('QODER_IDE_VERSION', '1.1.75')

/**
 * User agent for the metadata (openapi) requests.
 *
 * Derived from {@link qoderIdeVersion} so the agent string and the
 * `cosy-version` header can never disagree. The official client sends
 * `Qoder/1.1.75` (international) or `QoderWork/1.1.75` (China); this request
 * layer does not know the region, so the shared `qoder/` prefix is kept and
 * only the build number is centralized here.
 */
export const qoderUserAgent = `qoder/${qoderIdeVersion}`

/**
 * Desktop client version for the metadata/check-in request family.
 *
 * The reference implementation sends this family's `Cosy-Version` as the
 * desktop build (`0.4.8`), not as the CLI build above: campaign responses were
 * measured to depend on the desktop identity, so the two headers intentionally
 * carry different builds. Overridable through `QODER_DESKTOP_VERSION`.
 */
export const metadataCosyVersion: string = readOverride('QODER_DESKTOP_VERSION', '0.4.8')
