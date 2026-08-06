/**
 * profile.ts — a software identity at rest, sealed with a password.
 *
 * The software identity exists so someone can try the product without owning a
 * HEM. That makes it the onboarding path, and it used to keep its X25519
 * private key as plain JSON in localStorage: anything running in the origin, or
 * anyone with the unlocked device, could lift an identity whole.
 *
 * A password fixes that, and it also gives the login screen its three answers
 * without storing anything to compare against:
 *
 * | situation | how it is detected |
 * |---|---|
 * | no such profile | nothing under the storage key |
 * | right password | the AEAD opens |
 * | wrong password | the AEAD refuses |
 *
 * **There is no password check.** `unseal` either produces the identity or
 * throws, because the tag is the check — nothing here is compared, so there is
 * no verifier to steal and no comparison to time.
 *
 * What this is NOT: protection against someone who takes the ciphertext and
 * grinds it offline. A password people are willing to type is worth far less
 * than 256 bits, and PBKDF2 buys a constant factor, not a category. It raises
 * the cost of casual extraction; it does not make a weak password strong. The
 * answer to a serious adversary is the HEM, where the key cannot be exported at
 * all — which is the honest sales argument for it.
 */

import { subtle, randomBytes, b64, unb64 } from './wc.ts'

/**
 * PBKDF2 rounds. 1,000,000 puts a phone at roughly a second or two, paid once
 * per login — the most a person will sit through without believing the app has
 * hung, which is the real limit on this number rather than any security target.
 */
export const DEFAULT_ITERATIONS = 1_000_000

/** Refuse a stored blob that would take minutes to open. A tampered `iter` is
 *  otherwise a denial of service that looks like a slow phone. */
const MAX_ITERATIONS = 10_000_000

export interface SealedProfile {
  v: 1
  kdf: 'PBKDF2-SHA256'
  /** Rounds used for THIS blob. Stored rather than assumed: raising the default
   *  later must not lock people out of profiles made under the old one. */
  iter: number
  /** Per-profile, so two profiles with the same password derive different keys
   *  and one cracked password does not open the other. */
  salt: string
  iv: string
  ct: string
}

export function isSealedProfile(v: any): v is SealedProfile {
  return !!v && v.v === 1 && v.kdf === 'PBKDF2-SHA256'
    && Number.isInteger(v.iter) && v.iter > 0 && v.iter <= MAX_ITERATIONS
    && typeof v.salt === 'string' && typeof v.iv === 'string' && typeof v.ct === 'string'
}

/** Thrown when the AEAD refuses. Its own type because the login screen has to
 *  say "wrong password" for this and "something broke" for everything else. */
export class BadPassword extends Error {
  constructor() { super('wrong password'); this.name = 'BadPassword' }
}

async function derive(password: string, salt: Uint8Array, iter: number): Promise<CryptoKey> {
  const base = await subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveKey'])
  return subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations: iter, hash: 'SHA-256' },
    base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'],
  )
}

export async function seal(password: string, plaintext: string, iter = DEFAULT_ITERATIONS): Promise<SealedProfile> {
  if (!password) throw new Error('a profile needs a password')
  const salt = randomBytes(16)
  const iv = randomBytes(12)
  const key = await derive(password, salt, iter)
  const ct = new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(plaintext)))
  return { v: 1, kdf: 'PBKDF2-SHA256', iter, salt: b64(salt), iv: b64(iv), ct: b64(ct) }
}

export async function unseal(password: string, blob: SealedProfile): Promise<string> {
  if (!isSealedProfile(blob)) throw new Error('not a sealed profile')
  const key = await derive(password, unb64(blob.salt), blob.iter)
  let pt: ArrayBuffer
  // Every failure here is the same failure as far as a caller is concerned: a
  // wrong password and a corrupted blob are indistinguishable by design, and
  // telling them apart would mean trusting something outside the tag.
  try {
    pt = await subtle.decrypt({ name: 'AES-GCM', iv: unb64(blob.iv) }, key, unb64(blob.ct))
  } catch { throw new BadPassword() }
  return new TextDecoder().decode(pt)
}

/**
 * Re-seal under a new password. Takes the old one because it decrypts first —
 * there is no way to change the password without opening the profile, and a
 * "change password" that did not require the old one would be a way to lock
 * out whoever left the device unlocked for a minute.
 */
export async function reseal(oldPassword: string, newPassword: string, blob: SealedProfile): Promise<SealedProfile> {
  return seal(newPassword, await unseal(oldPassword, blob))
}
