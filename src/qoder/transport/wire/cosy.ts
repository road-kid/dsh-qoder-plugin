/**
 * COSY authentication headers and signature algorithm for Qoder services.
 *
 * Implements RSA + AES + MD5 signature generation required by the upstream
 * Qoder gateway.
 *
 * @module dsh-qoder-plugin/qoder/transport/wire/cosy
 */

import crypto from 'node:crypto'
import { getMachineId } from '../machine-id.ts'
import { qoderIdeVersion } from './version.ts'

const qoderRSAPublicKey = `-----BEGIN PUBLIC KEY-----
MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDA8iMH5c02LilrsERw9t6Pv5Nc
4k6Pz1EaDicBMpdpxKduSZu5OANqUq8er4GM95omAGIOPOh+Nx0spthYA2BqGz+l
6HRkPJ7S236FZz73In/KVuLnwI8JJ2CbuJap8kvheCCZpmAWpb/cPx/3Vr/J6I17
XcW+ML9FoCI6AOvOzwIDAQAB
-----END PUBLIC KEY-----`

export const qoderClientType = '5'
/**
 * The desktop client identifier the campaign endpoints require.
 *
 * Measured against the live upstream: `/sash/api/v1/me/campaigns` answers
 * HTTP 200 with an EMPTY `campaigns` array when the caller presents the
 * generic {@link qoderClientType} (`5`), and returns the real list only when
 * it presents the desktop identifier `10`. A check-in built on the wrong
 * identifier looks healthy at the transport layer — status 200, no error —
 * while silently reporting "no campaign today" forever, so the campaign
 * paths must send this one explicitly.
 */
export const qoderDesktopClientType = '10'
const qoderDataPolicy = 'disagree'
const qoderLoginVersion = 'v2'
const qoderMachineOs = process.platform === 'win32'
  ? process.arch === 'arm64'
    ? 'aarch64_windows'
    : 'x86_64_windows'
  : process.arch === 'arm64'
    ? 'aarch64_linux'
    : 'x86_64_linux'
const qoderMachineTypeMagic = '5'

/**
 * Environment override for {@link campaignMachineOs}; `auto` means detect.
 *
 * Exported so tests and the docs name the same string instead of two copies.
 */
export const QODER_COSY_MACHINE_OS_ENV = 'QODER_COSY_MACHINE_OS'

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
export const campaignMachineOs: string = (() => {
  const override = process.env[QODER_COSY_MACHINE_OS_ENV]?.trim()
  if (override !== undefined && override !== '' && override.toLowerCase() !== 'auto') return override
  const arch = process.arch === 'arm64' ? 'aarch64' : 'x86_64'
  // Unlike `qoderMachineOs` (which folds darwin into `linux`, a shape already
  // live on the inference path and therefore frozen), this one names the three
  // platforms the desktop client actually ships for.
  const platform = process.platform === 'win32'
    ? 'win32'
    : process.platform === 'darwin'
      ? 'darwin'
      : 'linux'
  return `${arch}_${platform}`
})()

export interface CosyCredentials {
  userID: string
  authToken: string
  name: string
  email: string
  /**
   * This host's real, install-wide machine id. Metadata requests (status/plan)
   * send it as `Cosy-MachineToken`; it is NOT the id the COSY client requests
   * present, because a shared host id is what makes several accounts look like
   * one device.
   */
  machineID?: string
  /**
   * Per-account device id derived from the user id. COSY-authenticated client
   * requests use it for `Cosy-Machineid`/`Cosy-Machinetoken`; when absent (for
   * example a hand-built credential in a test) the real {@link machineID} is
   * used so the header is never dropped.
   */
  derivedMachineID?: string
  /**
   * Per-account hostname label. Only the inference request may carry it, so it
   * is passed through to {@link buildAuthHeaders}' options rather than being
   * emitted on every request.
   */
  machineHostname?: string
}

export interface BuildAuthHeadersOptions {
  /**
   * Emit `Cosy-Machinehostname`. The official desktop client sends it on the
   * inference SSE request only; the model list and the metadata/status
   * endpoints must not receive it, so this is opt-in per call site.
   */
  includeMachineHostname?: boolean
}

interface UserInfo {
  uid: string
  security_oauth_token: string
  name: string
  aid: string
  email: string
}

interface CosyPayload {
  version: string
  requestId: string
  info: string
  cosyVersion: string
  ideVersion: string
}

export function computeSigPath(urlStr: string): string {
  const parsed = new URL(urlStr)
  let sigPath = parsed.pathname
  if (sigPath.startsWith('/algo')) {
    sigPath = sigPath.substring('/algo'.length)
  }
  return sigPath
}

function rsaEncryptBase64(data: Buffer | string): string {
  const key = {
    key: qoderRSAPublicKey,
    padding: crypto.constants.RSA_PKCS1_PADDING,
  }
  const encrypted = crypto.publicEncrypt(key, typeof data === 'string' ? Buffer.from(data) : data)
  return encrypted.toString('base64')
}

function aesEncryptCBCBase64(plaintext: string, keyStr: string): string {
  const cipher = crypto.createCipheriv('aes-128-cbc', Buffer.from(keyStr), Buffer.from(keyStr))
  let encrypted = cipher.update(plaintext, 'utf8', 'base64')
  encrypted += cipher.final('base64')
  return encrypted
}

export function buildAuthHeaders(
  body: Buffer | string | null,
  requestURL: string,
  creds: CosyCredentials,
  options: BuildAuthHeadersOptions = {},
): Record<string, string> {
  if (!creds.userID) {
    throw new Error('cosy: user id is empty')
  }
  if (!creds.authToken) {
    throw new Error('cosy: auth token is empty')
  }

  const aesKey = crypto.randomUUID().replace(/-/g, '').slice(0, 16)
  const userInfo: UserInfo = {
    uid: creds.userID,
    security_oauth_token: creds.authToken,
    name: creds.name || '',
    aid: '',
    email: creds.email || '',
  }

  const infoB64 = aesEncryptCBCBase64(JSON.stringify(userInfo), aesKey)
  const cosyKey = rsaEncryptBase64(aesKey)

  const timestamp = Math.floor(Date.now() / 1000).toString()
  const requestId = crypto.randomUUID()

  const cosyPayload: CosyPayload = {
    version: 'v1',
    requestId,
    info: infoB64,
    cosyVersion: qoderIdeVersion,
    ideVersion: '',
  }

  const payloadB64 = Buffer.from(JSON.stringify(cosyPayload)).toString('base64')
  const sigPath = computeSigPath(requestURL)

  const bodyStr = body ? (Buffer.isBuffer(body) ? body.toString('utf8') : body) : ''
  const sigInput = `${payloadB64}\n${cosyKey}\n${timestamp}\n${bodyStr}\n${sigPath}`
  const sig = crypto.createHash('md5').update(sigInput).digest('hex')

  const bodyHash = crypto
    .createHash('md5')
    .update(body || '')
    .digest('hex')
  const bodyLen = body ? (Buffer.isBuffer(body) ? body.length : Buffer.from(body).length).toString() : '0'

  /*
   * COSY-authenticated client requests present the account-derived id on BOTH
   * machine headers, in pairs: the reference CLI derives machineid and
   * machinetoken together from the account (qoder_sign.py:595/661-662), and a
   * request whose id and token disagree would look inconsistent.
   *
   * The boundary is deliberate: this module is the chat/inference/model-list
   * wire only. The metadata requests (status/plan/quota) keep sending this
   * host's real UMID as `Cosy-MachineToken`, and the campaign path resolves
   * its own real machine identity — do not move the derivation there.
   */
  const machineID = creds.derivedMachineID || creds.machineID || getMachineId()

  return {
    Authorization: `Bearer COSY.${payloadB64}.${sig}`,
    'Cosy-Key': cosyKey,
    'Cosy-User': creds.userID,
    'Cosy-Date': timestamp,
    'Cosy-Version': qoderIdeVersion,
    'Cosy-Machineid': machineID,
    'Cosy-Machinetoken': machineID,
    'Cosy-Machinetype': qoderMachineTypeMagic,
    'Cosy-Machineos': qoderMachineOs,
    ...options.includeMachineHostname === true && creds.machineHostname
      ? { 'Cosy-Machinehostname': creds.machineHostname }
      : {},
    'Cosy-Clienttype': qoderClientType,
    'Cosy-Clientip': '127.0.0.1',
    'Cosy-Bodyhash': bodyHash,
    'Cosy-Bodylength': bodyLen,
    'Cosy-Sigpath': sigPath,
    'Cosy-Data-Policy': qoderDataPolicy,
    'Cosy-Organization-Id': '',
    'Cosy-Organization-Tags': '',
    'Login-Version': qoderLoginVersion,
    'X-Request-Id': crypto.randomUUID(),
  }
}
