/**
 * bookmac.ts — proof that the contact book was written by us.
 *
 * ## What this is defending against, and what it is NOT
 *
 * The local contact book sits in `localStorage` as plain JSON: names and public
 * keys. Reading it tells somebody who you talk to, which is unpleasant.
 * **Writing it is the attack**: swap a contact's `pub` for your own and the app
 * derives the rendezvous with you, handshakes with you, and encrypts to you —
 * with nothing anywhere reporting it, because every layer below is working
 * perfectly on the key it was handed. The book is the trust anchor and it was
 * the one piece of state with no protection at all.
 *
 * So this signs it. Deliberately a MAC and not encryption (the user's call, and
 * the right one): confidentiality here buys a little, integrity is what the
 * crypto rests on, and a book that stays readable keeps every read on the UI
 * path synchronous — verify once at sign-in, hold the verified list in memory,
 * re-sign on write.
 *
 * ## Key schedule — the §10 secret, no new material at rest
 *
 *   base   = ECDH(IK, emp_pub)                             // already stored, already computed
 *   k_book = HKDF(base, salt="encedo-chat-contact-book-v1", info=idKey)
 *   mac    = HMAC-SHA-256(k_book, body)                    // body = the JSON, exactly as stored
 *
 * `emp_pub` is the same random public key the group cache uses, so nothing new
 * lands on disk and the HEM does one ECDH per session for both. Binding `info`
 * to the identity's KID means a book signed for one identity does not verify for
 * another — copying a file between profiles is caught rather than inherited.
 *
 * ## The body is a STRING, and that is not laziness
 *
 * The MAC covers the stored text verbatim. Recomputing it from a parsed-and-
 * re-serialised list would make the check depend on key order, number formatting
 * and escaping agreeing across engines and versions — a canonicalisation problem
 * nobody needs, whose failure mode is a false alarm that accuses the user of
 * tampering. What was written is what is verified.
 */

import { subtle, hkdfBits, b64, unb64 } from './wc.ts'

const enc = new TextEncoder()
const BOOK_SALT = enc.encode('encedo-chat-contact-book-v1')

/** What a signed book looks like in storage. `v` is there so a later format has
 *  somewhere to say so. */
export interface PackedBook { v: 1; mac: string; body: string }

export type Verdict =
  /** Signed by us, and the signature is good. */
  | 'ok'
  /** Nothing there yet, or a book written before this existed. Not a fault. */
  | 'unsigned'
  /** Signed, and the signature does NOT match what is stored. */
  | 'tampered'

/**
 * Read whatever storage holds. A bare array is the pre-MAC format and is
 * reported as `unsigned` rather than refused: locking somebody out of their own
 * contacts to introduce a security feature is a worse outcome than the risk it
 * closes, and the next write signs it.
 */
export function unpack(raw: string | null): { body: string; mac: string | null } {
  if (!raw) return { body: '[]', mac: null }
  try {
    const o = JSON.parse(raw)
    if (Array.isArray(o)) return { body: raw, mac: null }
    if (o && typeof o.body === 'string' && typeof o.mac === 'string') return { body: o.body, mac: o.mac }
  } catch { /* not JSON at all: treat as an empty unsigned book */ }
  return { body: '[]', mac: null }
}

export function pack(body: string, mac: string): string {
  const packed: PackedBook = { v: 1, mac, body }
  return JSON.stringify(packed)
}

async function bookKey(base: Uint8Array, idKey: string): Promise<CryptoKey> {
  const raw = await hkdfBits(base, BOOK_SALT, enc.encode(idKey), 32)
  return subtle.importKey('raw', raw, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify'])
}

/** Sign the stored text. */
export async function signBook(base: Uint8Array, idKey: string, body: string): Promise<string> {
  const key = await bookKey(base, idKey)
  return b64(new Uint8Array(await subtle.sign('HMAC', key, enc.encode(body))))
}

/**
 * Check what storage holds. The comparison is `subtle.verify`, so it does not
 * leak a byte-by-byte answer the way a string compare would.
 */
export async function checkBook(base: Uint8Array, idKey: string, raw: string | null): Promise<{ verdict: Verdict; body: string }> {
  const { body, mac } = unpack(raw)
  if (mac === null) return { verdict: 'unsigned', body }
  try {
    const key = await bookKey(base, idKey)
    const ok = await subtle.verify('HMAC', key, unb64(mac), enc.encode(body))
    return { verdict: ok ? 'ok' : 'tampered', body }
  } catch {
    // A mac that is not even base64 is a tampered mac, not a crash.
    return { verdict: 'tampered', body }
  }
}
