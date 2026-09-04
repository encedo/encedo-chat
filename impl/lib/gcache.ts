/**
 * gcache.ts — at-rest crypto for the group-state cache (§10). Pure: given the
 * identity-anchored `base` secret and a gid, seal/open a per-group blob.
 *
 * Key schedule (identity-agnostic — HEM or software):
 *   base = ECDH(IK, emp_pub)                          // one id.ecdh per session
 *   k_gid = HKDF(base, salt="encedo-chat-group-cache-v1", info=gid) // per group
 *   blob  = iv || AES-256-GCM(k_gid, iv, plaintext)
 *
 * IK never leaves the HEM: `emp_pub` is a random X25519 public key stored in
 * localStorage, and the HSM computes ECDH(IK_priv, emp_pub). `base` is stable
 * across sessions (same emp_pub) yet derivable only by the IK holder. Binding the
 * per-group key to the gid means one group's cache key never opens another's.
 */

import { subtle, hkdfBits, b64, unb64, randomBytes } from './wc.ts'

const enc = new TextEncoder()
const CACHE_SALT = enc.encode('encedo-chat-group-cache-v1')

async function groupKey(base: Uint8Array, gidHex: string): Promise<CryptoKey> {
  const raw = await hkdfBits(base, CACHE_SALT, enc.encode(gidHex), 32)
  return subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt'])
}

/** Encrypt a per-group cache blob -> base64(iv || ct). */
export async function sealCache(base: Uint8Array, gidHex: string, plaintext: Uint8Array): Promise<string> {
  const key = await groupKey(base, gidHex)
  const iv = randomBytes(12)
  const ct = new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv }, key, plaintext))
  const out = new Uint8Array(iv.length + ct.length)
  out.set(iv); out.set(ct, iv.length)
  return b64(out)
}

/** Decrypt a per-group cache blob (base64 iv || ct), or null if it does not open
 *  (wrong base / wrong gid / tampered). */
export async function openCache(base: Uint8Array, gidHex: string, blob: string): Promise<Uint8Array | null> {
  try {
    const bytes = unb64(blob)
    const iv = bytes.slice(0, 12)
    const ct = bytes.slice(12)
    const key = await groupKey(base, gidHex)
    return new Uint8Array(await subtle.decrypt({ name: 'AES-GCM', iv }, key, ct))
  } catch { return null }
}
