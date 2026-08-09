/**
 * descr.ts — what a key looks like in the HEM: its `label`, its `DESCR`, and the
 * id the device gives it (docs/PROTOCOL.md §4, "several identities in one HEM").
 *
 * Two fields with different jobs, and both are used deliberately:
 *
 *   label   32 characters, a firmware limit. What a HUMAN sees in the device's
 *           own key list. Truncated freely — it is a caption.
 *   DESCR   128 bytes, searchable by anchored prefix. What the CLIENT reads.
 *           Authoritative wherever the two disagree.
 *
 * ```
 * IK     label  Onchato-IK-<handle>            DESCR  ETSEIC:self1,<handle>
 * PEER   label  Onchato-Peer-<name>            DESCR  ETSEIC:peer1,<ownerKid>,<name>
 * ```
 *
 * Four rules hold this together, and each one is a bug that has already been
 * paid for somewhere in this repo:
 *
 * - **The identity's id is the KID of its own IK entry.** Nothing is minted,
 *   nothing is stored, nothing can be lost, and it is portable for free because
 *   `KID = SHA-1(pub)[0:16]` is derived from the key's content — the same key on
 *   another device carries the same id. The `self` record therefore does not name
 *   itself: `key_search` returns its KID beside it.
 * - **Fixed-width identifiers first, free text last, and the tail read whole.**
 *   `key_search` matches an anchored prefix, so the owner has to precede the
 *   name for scoping to work at all. And a name comes from a person: today's
 *   `split(',')[1]` turns the contact "Kowalski, Jan" into "Kowalski". Reading
 *   the tail cannot have that bug, whatever anyone types.
 * - **The budget is BYTES.** "Zespół" is six characters and eight bytes, and the
 *   HEM truncates silently at 128. Every cut here goes through `sliceBytes`,
 *   which also never splits a character in half.
 * - **The record is NUL-padded.** It is a fixed 128-byte field, so what comes
 *   back has zeros after the text; anything that decodes it must cut at the
 *   first one before looking at the content.
 *
 * Generations ride in the prefix (`self1`, `peer1`). This build does not read
 * any earlier form — pre-MVP the old records are erased with the devices that
 * hold them — but the digit stays, because the change that cannot be made this
 * way is one that reorders fields: an old record would not fail to parse, it
 * would parse as something else.
 */

import { subtle, b64, unb64 } from './wc.ts'

/** The HEM description field is a raw 128-byte record. Overrunning it truncates silently. */
export const DESCR_MAX = 128
/** Firmware limit on a key label (`hem-sdk.js`: "label max 32 chars"). */
export const LABEL_MAX = 32

export const SELF_PREFIX = 'ETSEIC:self1,'
export const PEER_PREFIX = 'ETSEIC:peer1,'

// ---------------------------------------------------------------------------
// text budget
// ---------------------------------------------------------------------------

const enc = new TextEncoder()
const dec = new TextDecoder()

/** UTF-8 length — the only length a DESCR is measured in. */
export function byteLen(s: string): number { return enc.encode(s).length }

/** Longest prefix of `s` that fits `max` UTF-8 bytes, never splitting a character. */
export function sliceBytes(s: string, max: number): string {
  if (byteLen(s) <= max) return s
  let out = ''
  for (const ch of s) { // by code point, so surrogate pairs stay intact
    if (byteLen(out + ch) > max) break
    out += ch
  }
  return out
}

/**
 * The text of a DESCR as it comes back from the device: bytes or string, with
 * the field's NUL padding removed. Null in, null out.
 */
export function descrText(raw: Uint8Array | string | null | undefined): string | null {
  if (raw == null) return null
  const s = typeof raw === 'string' ? raw : dec.decode(raw)
  const z = s.indexOf('\0')
  return z >= 0 ? s.slice(0, z) : s
}

// ---------------------------------------------------------------------------
// key ids
// ---------------------------------------------------------------------------

/** Anyone this module can identify: an HSM-issued KID, a public key, or both. */
export interface KeyRef { kid?: string; pub?: Uint8Array }

/**
 * The HEM KID: `SHA-1(pub)[0:16]`, hex — deterministic and global, so the same
 * public key yields the same KID on every HEM. That is what lets one device
 * write an identifier another device resolves, and what makes the device refuse
 * to hold one public key twice.
 *
 * SHA-**1**, deliberately, and worth having the argument to hand: this is an
 * index on key content, not a security binding. Hijacking a chosen KID is a
 * second preimage on 128 truncated bits (2^128); SHA-1's practical weakness is
 * chosen-prefix *collision*, which needs both inputs and is bounded below by the
 * generic 2^64 birthday cost once the output is cut to 128 bits — so RFC 7093's
 * truncated SHA-256 would change no attack cost here. The app fingerprint is a
 * different identifier for a different question (`SHA-256(pub)`, §4.4,
 * out-of-band MITM).
 */
export async function hemKid(pub: Uint8Array): Promise<string> {
  const d = new Uint8Array(await subtle.digest('SHA-1', pub))
  return hex(d.slice(0, 16))
}

/** Prefer what the HSM issued; derive only when we hold no KID. Equal by construction. */
export async function kidOf(r: KeyRef): Promise<string | undefined> {
  if (r.kid) return r.kid.toLowerCase()
  return r.pub ? hemKid(r.pub) : undefined
}

export const isHexKid = (k: string, minHex = 8) =>
  /^[0-9a-f]+$/i.test(k) && k.length >= minHex && k.length % 2 === 0

export function unhex(s: string): Uint8Array {
  const out = new Uint8Array(s.length >> 1)
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16)
  return out
}
export function hex(b: Uint8Array): string { return [...b].map((x) => x.toString(16).padStart(2, '0')).join('') }

export function b64url(b: Uint8Array): string {
  return b64(b).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}
export function unb64url(s: string): Uint8Array {
  const p = s.replace(/-/g, '+').replace(/_/g, '/')
  return unb64(p + '='.repeat((4 - (p.length % 4)) % 4))
}

/**
 * A 16-byte KID as the 22 base64url characters a DESCR carries, and back.
 *
 * Ten characters cheaper than hex, which is ten more the name gets. `null` for
 * anything that is not a well-formed KID rather than a guess — a wrong owner id
 * would silently scope a contact into another identity.
 */
export const kidToField = (kidHex: string): string | null =>
  isHexKid(kidHex, 32) && kidHex.length === 32 ? b64url(unhex(kidHex)) : null
export function kidFromField(field: string): string | null {
  let raw: Uint8Array
  try { raw = unb64url(field) } catch { return null }
  return raw.length === 16 ? hex(raw) : null
}

// ---------------------------------------------------------------------------
// labels
// ---------------------------------------------------------------------------

const label = (prefix: string, name: string) => sliceBytes(prefix + name, LABEL_MAX)

/** `Onchato-IK-<handle>` — the identity as its owner sees it in the device. */
export const selfLabel = (handle: string) => label('Onchato-IK-', handle)
/** `Onchato-Peer-<name>` — a contact, likewise. */
export const peerLabel = (name: string) => label('Onchato-Peer-', name)
/** `Onchato-Group-<name>` — the group key entry, admin's pair or member's imported pub. */
export const groupLabel = (name: string) => label('Onchato-Group-', name)

// ---------------------------------------------------------------------------
// records
// ---------------------------------------------------------------------------

/** `ETSEIC:self1,<handle>` — the handle is the tail, so it may contain anything. */
export const buildSelfDescr = (handle: string): string =>
  SELF_PREFIX + sliceBytes(handle, DESCR_MAX - byteLen(SELF_PREFIX))

export function parseSelfDescr(raw: Uint8Array | string | null | undefined): { handle: string } | null {
  const s = descrText(raw)
  if (s == null || !s.startsWith(SELF_PREFIX)) return null
  return { handle: s.slice(SELF_PREFIX.length) }
}

/**
 * `ETSEIC:peer1,<ownerKid>,<name>` — a contact, scoped to the identity that
 * holds it. Null when the owner id is not a KID, because a contact written under
 * a malformed owner would be invisible to the identity that owns it and visible
 * to nobody else.
 */
export function buildPeerDescr(ownerKidHex: string, name: string): string | null {
  const owner = kidToField(ownerKidHex)
  if (!owner) return null
  const head = `${PEER_PREFIX}${owner},`
  return head + sliceBytes(name, DESCR_MAX - byteLen(head))
}

export function parsePeerDescr(raw: Uint8Array | string | null | undefined): { ownerKid: string; name: string } | null {
  const s = descrText(raw)
  if (s == null || !s.startsWith(PEER_PREFIX)) return null
  const rest = s.slice(PEER_PREFIX.length)
  const comma = rest.indexOf(',')
  if (comma < 0) return null
  const ownerKid = kidFromField(rest.slice(0, comma))
  if (!ownerKid) return null
  // Everything after the FIRST comma is the name — commas in it are the user's,
  // not delimiters. This is the whole reason the owner goes first.
  return { ownerKid, name: rest.slice(comma + 1) }
}

/**
 * The anchored prefix that returns exactly one identity's contacts. Without an
 * owner it returns every identity's — which is what the add path wants, to see
 * whether some other identity already holds a key.
 */
export const peerSearchPrefix = (ownerKidHex?: string): string => {
  if (!ownerKidHex) return PEER_PREFIX
  const owner = kidToField(ownerKidHex)
  return owner ? `${PEER_PREFIX}${owner},` : PEER_PREFIX
}
