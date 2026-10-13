/**
 * wc.ts — WebCrypto helpers. Platform primitives only (crypto.subtle,
 * getRandomValues, btoa/atob) — no third-party crypto library. Works unchanged
 * in Node 24 and the browser. Keys are handled as non-extractable CryptoKey
 * objects wherever possible.
 */

export const subtle = globalThis.crypto.subtle

/** HKDF-SHA256 -> raw bytes. */
export async function hkdfBits(ikm: Uint8Array, salt: Uint8Array, info: Uint8Array, len: number): Promise<Uint8Array> {
  const base = await subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits'])
  const bits = await subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, base, len * 8)
  return new Uint8Array(bits)
}

const NO_CTX = new Uint8Array(0)
const utf8 = (s: string | Uint8Array) => (typeof s === 'string' ? new TextEncoder().encode(s) : s)
/**
 * The ONE derivation convention of the protocol (PROTOCOL.md 14): the label
 * is HKDF's `info`, the context - a date, a group id and epoch, a root key, a
 * counter - is HKDF's `salt`, empty where there is none. Two families used
 * to coexist (label-as-salt for the rendezvous and group MAC keys, label-as-
 * info for the chains), which was two things for an auditor to hold and one
 * way to derive the wrong key by swapping them (S7, 2026-10-13).
 */
export function kdf(label: string | Uint8Array, ikm: Uint8Array, ctx: Uint8Array = NO_CTX, len = 32): Promise<Uint8Array> {
  return hkdfBits(ikm, ctx, utf8(label), len)
}
/** The one AEAD nonce: 12 bytes from the single-use message key and the counter it seals (7.2, 8.2). */
export function aeadNonce(mk: Uint8Array, n: number): Promise<Uint8Array> {
  const nb = new Uint8Array(4)
  new DataView(nb.buffer).setUint32(0, n, false)
  return kdf('encedo-aead-nonce', mk, nb, 12)
}

/** SHA-256 -> 32 raw bytes. */
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
