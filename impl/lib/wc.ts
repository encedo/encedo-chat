/**
 * wc.ts — WebCrypto helpers. Platform primitives only (crypto.subtle,
 * getRandomValues, btoa/atob) — no third-party crypto library. Works unchanged
 * in Node 24 and the browser. Keys are handled as non-extractable CryptoKey
 * objects wherever possible.
 */

export const subtle = globalThis.crypto.subtle

/** HKDF-SHA256 → raw bytes. */
export async function hkdfBits(ikm: Uint8Array, salt: Uint8Array, info: Uint8Array, len: number): Promise<Uint8Array> {
  const base = await subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits'])
  const bits = await subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, base, len * 8)
  return new Uint8Array(bits)
}

/** SHA-256 → 32 raw bytes. */
export async function sha256(data: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await subtle.digest('SHA-256', data))
}

/** Concatenate byte runs (transcript building; no allocation games). */
export function concat(...parts: Uint8Array[]): Uint8Array {
  let n = 0
  for (const p of parts) n += p.length
  const out = new Uint8Array(n)
  let o = 0
  for (const p of parts) { out.set(p, o); o += p.length }
  return out
}

export function randomBytes(n: number): Uint8Array {
  const b = new Uint8Array(n)
  globalThis.crypto.getRandomValues(b)
  return b
}

// base64 (binary-safe; our payloads are small). btoa/atob are platform globals.
export function b64(u8: Uint8Array): string {
  let s = ''
  for (let i = 0; i < u8.length; i++) s += String.fromCharCode(u8[i])
  return btoa(s)
}
export function unb64(str: string): Uint8Array {
  const s = atob(str)
  const u = new Uint8Array(s.length)
  for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i)
  return u
}
