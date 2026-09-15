/**
 * localstore.ts — small local records, sealed at rest.
 *
 * The app's promise is that nothing on this device remembers a conversation.
 * A few things still have to survive a reload — what you published, who you are
 * waiting on, who you told the app to stop showing you — and every one of them
 * is a record ABOUT PEOPLE. A list of keys that knocked at a journalist, or of
 * journalists a source is trying to reach, is exactly the material this product
 * exists to not leave lying around, so it goes to disk sealed or not at all.
 *
 * ## Key schedule — §10, one salt per store
 *
 *   base = ECDH(IK, emp_pub)                     // identity-agnostic, one per session
 *   k    = HKDF(base, salt, info=scope)
 *   blob = base64(iv || AES-256-GCM(k, iv, JSON))
 *
 * `base` reaches the same secret whether IK lives in a HEM or in a sealed
 * software profile, so this works the same under either without knowing which.
 *
 * **The salt is per store and must stay that way.** Same base, same scope,
 * different context means one store's blob cannot be opened as another's — not
 * by an attacker and not by us, by accident, after a refactor. `gcache.ts` and
 * `pincache.ts` are the same construction with their own salts; this is the
 * general form for the small stores that came after them.
 *
 * ## What it does NOT promise
 *
 * A sealed blob still says how big it is and when it was written, and anyone
 * holding the device while the identity is unlocked can read it. This defends
 * a device at rest and a copied profile directory, which is the threat the rest
 * of §10 addresses; it is not a defence against a live, unlocked session.
 */

import { subtle, hkdfBits, b64, unb64, randomBytes } from './wc.ts'

const enc = new TextEncoder()
const IV_LEN = 12

async function storeKey(base: Uint8Array, salt: string, scope: string): Promise<CryptoKey> {
  const raw = await hkdfBits(base, enc.encode(salt), enc.encode(scope), 32)
  return subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt'])
}

/** Seal any JSON-able value -> base64(iv || ct). */
export async function sealLocal(base: Uint8Array, salt: string, scope: string, value: unknown): Promise<string> {
  const key = await storeKey(base, salt, scope)
  const iv = randomBytes(IV_LEN)
  const ct = new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(JSON.stringify(value))))
  const out = new Uint8Array(iv.length + ct.length)
  out.set(iv, 0); out.set(ct, iv.length)
  return b64(out)
}

/**
 * Open a blob, or null.
 *
 * Null for every failure and never a throw: the caller is reading a key out of
 * localStorage, where a blob from another identity, a truncated write, or an
 * older format are all ordinary — and none of them is worth losing the session
 * over. A caller that gets null treats the store as empty.
 */
export async function openLocal<T>(base: Uint8Array, salt: string, scope: string, blob: string): Promise<T | null> {
  try {
    const raw = unb64(blob)
    if (raw.length <= IV_LEN) return null
    const key = await storeKey(base, salt, scope)
    const pt = await subtle.decrypt({ name: 'AES-GCM', iv: raw.subarray(0, IV_LEN) }, key, raw.subarray(IV_LEN))
    return JSON.parse(new TextDecoder().decode(new Uint8Array(pt))) as T
  } catch { return null }
}
