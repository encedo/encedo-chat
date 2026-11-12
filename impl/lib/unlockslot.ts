/**
 * unlockslot.ts - a second way into a software profile: a passkey instead of
 * the password (SPEC 4.5, Unlock slot).
 *
 * The sealed profile (`profile.ts`) stays exactly what it was, and the password
 * keeps opening it. A slot is a SECOND sealing of the same plaintext, under a
 * key that comes from the platform's authenticator instead of from a password:
 * the WebAuthn PRF output of a passkey in a browser, or a random secret the
 * Android keystore releases (`web/src/passkey.ts` hides which). Touch ID, Face
 * ID, Windows Hello or a phone's fingerprint is what unlocks it; this file
 * never sees any of that, only the 32 bytes it yields.
 *
 * What it changes about the assurance, honestly: a profile with a slot opens
 * by EITHER way, so it is as strong as the weaker one. A synced passkey puts
 * its PRF secret in the account of the passkey provider (iCloud Keychain,
 * Google Password Manager), which is why the slot records whether the passkey
 * can be synced at all, and why a network may refuse those (`policy.softUnlock`).
 *
 * Deliberately NOT here:
 * - **No export.** A slot belongs to this device and this origin; the profile
 *   file (`migrate.ts`) carries only the password seal, and an import never
 *   writes a slot.
 * - **No stretching.** The PRF output is a full-entropy key, so the KDF is a
 *   single HKDF; PBKDF2 or Argon2 would buy nothing here.
 * - **No password replacement.** Every `PASSWORD_EVERY_MS` the password is
 *   required again (`passwordDue`), because a profile whose owner has forgotten
 *   its password cannot be moved to another device or recovered when the
 *   passkey is lost.
 */

import { subtle, kdf, randomBytes, b64, unb64 } from './wc.ts'

/** The HKDF info of the slot key; the context (salt) is empty. */
export const UNLOCK_LABEL = 'onchato-soft-unlock-v1'

/** The password is asked for again when it has not been used for this long (the user's call, 2026-11-10). */
export const PASSWORD_EVERY_MS = 14 * 86_400_000

/** Where a profile's slot lives: beside `ec-soft-id-<name>`, and like it named
 *  in clear, because it has to be found before anything is open. */
export const unlockSlotKey = (name: string) => 'ec-soft-unlock-' + name
export const UNLOCK_SLOT_PREFIX = 'ec-soft-unlock-'

/** What a network allows (NetworkPolicy.softUnlock); absent = 'any'. */
export type SoftUnlockPolicy = 'any' | 'device-bound' | 'none'

interface SlotCommon {
  v: 1
  /** The secret could leave this device (a synced passkey): it may live in a provider's cloud. */
  synced: boolean
  /** When the password last opened this profile (ms). */
  pwAt: number
  iv: string
  ct: string
}

/** The browser: a passkey's PRF output is the secret. */
export interface PrfSlot extends SlotCommon {
  kind: 'webauthn-prf'
  /** The WebAuthn relying party: this page's host. A slot of another origin is not offered. */
  rpId: string
  /** The passkey's credential id, base64. */
  credId: string
  /** The PRF input (`eval.first`), 32 random bytes, base64. */
  prfSalt: string
}

/**
 * The Android app: a random secret wrapped by a non-exportable AES key in
 * AndroidKeyStore that only a fingerprint, a face or the device's own unlock
 * releases (src-tauri/plugins/onchato-bio). `synced` is always false.
 */
export interface KeystoreSlot extends SlotCommon {
  kind: 'android-keystore'
  /** The keystore entry, random hex: it names no profile. */
  alias: string
  /** The secret as the keystore key sealed it (AES-GCM), base64. */
  wiv: string
  wct: string
}

/**
 * The Windows app: a Windows Hello key (RSA in the TPM, released by a
 * fingerprint, a face or the Hello PIN) signs a fixed challenge; PKCS#1 v1.5
 * is deterministic, so SHA-256 of the signature is the same 32 bytes every
 * time and nothing else is stored (src-tauri/plugins/onchato-bio, hello.rs).
 * `synced` is always false.
 */
export interface HelloSlot extends SlotCommon {
  kind: 'windows-hello'
  /** The Hello credential's name, random hex: it names no profile. */
  alias: string
}

export type UnlockSlot = PrfSlot | KeystoreSlot | HelloSlot
/** What a slot records about the key behind it: everything but the seal. */
export type SlotMeta =
  | Pick<PrfSlot, 'kind' | 'rpId' | 'credId' | 'prfSalt' | 'synced'>
  | Pick<KeystoreSlot, 'kind' | 'alias' | 'wiv' | 'wct' | 'synced'>
  | Pick<HelloSlot, 'kind' | 'alias' | 'synced'>

const str = (x: any) => typeof x === 'string' && x.length > 0

export function isUnlockSlot(v: any): v is UnlockSlot {
  if (!v || v.v !== 1 || typeof v.synced !== 'boolean' || !Number.isSafeInteger(v.pwAt) || v.pwAt < 0
    || typeof v.iv !== 'string' || typeof v.ct !== 'string') return false
  if (v.kind === 'webauthn-prf') return str(v.rpId) && str(v.credId) && typeof v.prfSalt === 'string'
  if (v.kind === 'android-keystore') return /^[0-9a-f]{32}$/.test(v.alias) && str(v.wiv) && str(v.wct) && v.synced === false
  if (v.kind === 'windows-hello') return /^[0-9a-f]{32}$/.test(v.alias) && v.synced === false
  return false
}

/** The AEAD refused: the passkey answered with a different secret, or the slot was altered. */
export class SlotRefused extends Error {
  constructor() { super('the unlock slot does not open'); this.name = 'SlotRefused' }
}

async function slotKey(secret: Uint8Array): Promise<CryptoKey> {
  if (!(secret instanceof Uint8Array) || secret.length !== 32) throw new Error('an unlock secret is 32 bytes')
  const k = await kdf(UNLOCK_LABEL, secret)
  try {
    return await subtle.importKey('raw', k, 'AES-GCM', false, ['encrypt', 'decrypt'])
  } finally { k.fill(0) }
}

/** The profile name is the AAD: a slot copied under another name does not open there. */
const aad = (name: string) => new TextEncoder().encode(name)

export async function sealSlot(
  secret: Uint8Array, plaintext: string, name: string, meta: SlotMeta, now: number,
): Promise<UnlockSlot> {
  const iv = randomBytes(12)
  const key = await slotKey(secret)
  const ct = new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aad(name) }, key, new TextEncoder().encode(plaintext)))
  const seal = { v: 1 as const, pwAt: now, iv: b64(iv), ct: b64(ct) }
  if (meta.kind === 'windows-hello') return { ...seal, kind: 'windows-hello', alias: meta.alias, synced: false }
  return meta.kind === 'android-keystore'
    ? { ...seal, kind: 'android-keystore', alias: meta.alias, wiv: meta.wiv, wct: meta.wct, synced: false }
    : { ...seal, kind: 'webauthn-prf', rpId: meta.rpId, credId: meta.credId, prfSalt: meta.prfSalt, synced: meta.synced }
}

export async function openSlot(secret: Uint8Array, slot: UnlockSlot, name: string): Promise<string> {
  if (!isUnlockSlot(slot)) throw new Error('not an unlock slot')
  const key = await slotKey(secret)
  let pt: ArrayBuffer
  try {
    pt = await subtle.decrypt({ name: 'AES-GCM', iv: unb64(slot.iv), additionalData: aad(name) }, key, unb64(slot.ct))
  } catch { throw new SlotRefused() }
  return new TextDecoder().decode(pt)
}

/** A fresh PRF input for a new slot. */
export const newPrfSalt = (): Uint8Array => randomBytes(32)

/**
 * The password is due: not used for `PASSWORD_EVERY_MS`, or the stamp is in
 * the future (a clock set back, or an edited record) - both ask for it.
 */
export function passwordDue(slot: UnlockSlot, now: number): boolean {
  return now - slot.pwAt >= PASSWORD_EVERY_MS || slot.pwAt - now > 86_400_000
}

/** The same slot, stamped as opened by the password now. */
export const withPasswordAt = (slot: UnlockSlot, now: number): UnlockSlot => ({ ...slot, pwAt: now })

/**
 * Whether a network's policy lets this slot be used. `synced` is the BE flag
 * the authenticator reported: a declaration, not an attestation, so the rule
 * holds against honest authenticators and a careless user, not an attacker.
 */
export function slotAllowed(policy: SoftUnlockPolicy | undefined, synced: boolean): boolean {
  if (policy === 'none') return false
  if (policy === 'device-bound') return !synced
  return true
}

/** Parse what is stored, or null for anything that is not a slot. */
export function readSlot(raw: string | null): UnlockSlot | null {
  if (!raw) return null
  try { const v = JSON.parse(raw); return isUnlockSlot(v) ? v : null } catch { return null }
}
