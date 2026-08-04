/**
 * gmarker.ts — the HEM group marker (§8 "HEM marker (portable membership)").
 *
 * The only per-group object in the HSM is the GK key entry; its DESCR is what
 * makes membership PORTABLE. `key_search` over the marker prefix yields the
 * group list on any device holding the same HEM, without a single byte of
 * group state having been stored anywhere on the network.
 *
 * What it deliberately does NOT hold: `group_secret` (the topic seed) and
 * sender keys (content). Those are client-side and forward-secret; a HEM dump
 * must not hand over the ability to read anything.
 *
 * Optionally it carries a **compact roster**: a 4-byte KID hint per member plus
 * a CRC32 over the full concatenated KIDs. The hints are resolved by looking up
 * KID prefixes among keys the HEM already holds (your contacts), and the CRC
 * confirms the reconstructed set is the intended one — a 4-byte hint collides
 * rarely, but "rarely" is not "never". The CRC is **integrity, not
 * authenticity**: authenticity of a roster is and remains the admin's `rk_i`
 * MAC (§8). Anyone who can write this DESCR can write any CRC to match it.
 *
 * The trade-off is explicit in the design: with the roster blob, one HEM dump
 * reveals the whole membership graph (hints plus your contacts, both in the
 * HEM); without it, a dump reveals only that a group exists. That is why
 * including it is a caller's choice, not this module's.
 *
 * Identifier note: HEM KID = SHA1(pub)[0:16] (key index — this file), which is
 * NOT the app fingerprint SHA-256(pub) used for out-of-band MITM checks (§4.4).
 */

import { subtle, b64, unb64 } from './wc.ts'

/** `key_search` prefix — everything below is one DESCR field. */
export const MARKER_PREFIX = 'ETSEIC:chan,'

/**
 * The HEM description field is a raw **128-byte** record, and overrunning it is
 * silent truncation — of the roster blob, which then decodes to a *different*
 * roster. So the budget is checked, and checked in BYTES: the generated fields
 * are ASCII, but a group name is not ("Zespół" is 6 characters and 8 bytes), and
 * measuring a name in `String.length` overruns the field by exactly as many
 * bytes as it has non-ASCII characters.
 */
export const DESCR_MAX = 128

const enc = new TextEncoder()
/** UTF-8 length — the only length this field is measured in. */
export function byteLen(s: string): number { return enc.encode(s).length }
/** Longest prefix of `s` that fits `max` UTF-8 bytes, never splitting a character. */
function sliceBytes(s: string, max: number): string {
  if (byteLen(s) <= max) return s
  let out = ''
  for (const ch of s) { // by code point, so surrogate pairs stay intact
    if (byteLen(out + ch) > max) break
    out += ch
  }
  return out
}

/** The spec bounds the compact roster at 10 members (~44 B). Beyond that it is omitted. */
export const ROSTER_MAX = 10

const HINT_BYTES = 4

/**
 * HEM KID: `SHA1(pub)[0:16]`, hex. Deterministic and global — the same public
 * key imported into two HEMs gets the same KID, which is what lets a hint
 * written by the admin resolve on a member's device.
 */
export async function hemKid(pub: Uint8Array): Promise<string> {
  const d = new Uint8Array(await subtle.digest('SHA-1', pub))
  return hex(d.slice(0, 16))
}

function hex(b: Uint8Array): string { return [...b].map((x) => x.toString(16).padStart(2, '0')).join('') }
function unhex(s: string): Uint8Array {
  const out = new Uint8Array(s.length >> 1)
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16)
  return out
}

/** CRC-32 (IEEE), table built once. Integrity check only — never a MAC. */
const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let i = 0; i < 256; i++) {
    let c = i
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[i] = c >>> 0
  }
  return t
})()
export function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

export interface MarkerFields {
  /** Unix seconds — when the group was founded. */
  iat: number
  /** Full KID of the admin: whom to ask for a re-sync. */
  adminKid: string
  /** 4-byte KID hints, one per member, in roster order. Empty = no roster blob. */
  hints: string[]
  /** CRC32 over the concatenated FULL KIDs, in the same order. 0 when no roster. */
  crc: number
  /** Best-effort display name. Dropped first when the 128-byte field is tight. */
  name: string
}

/**
 * Build the DESCR.
 *
 * Field order is a priority order, because 128 bytes does not fit everything at
 * ten members: identity and authority (`iat`, `adminKid`) always survive, the
 * roster blob is dropped if it would overrun, and the name — cosmetic, and held
 * client-side anyway — is truncated or dropped first. Callers are told what
 * actually made it in, so nothing silently disappears.
 */
export async function buildMarker(m: {
  iat: number
  adminPub: Uint8Array
  /** Raw member public keys in roster order. Pass none to omit the roster blob. */
  rosterPubs?: Uint8Array[]
  name?: string
}): Promise<{ descr: string; rosterIncluded: boolean; nameIncluded: boolean }> {
  const adminKid = await hemKid(m.adminPub)
  let hintsField = ''
  let rosterIncluded = false
  const pubs = m.rosterPubs ?? []
  if (pubs.length && pubs.length <= ROSTER_MAX) {
    const kids = await Promise.all(pubs.map(hemKid))
    const blob = new Uint8Array(pubs.length * HINT_BYTES + 4)
    kids.forEach((k, i) => blob.set(unhex(k).slice(0, HINT_BYTES), i * HINT_BYTES))
    const full = unhex(kids.join(''))
    const c = crc32(full)
    const off = pubs.length * HINT_BYTES
    blob[off] = (c >>> 24) & 0xff; blob[off + 1] = (c >>> 16) & 0xff
    blob[off + 2] = (c >>> 8) & 0xff; blob[off + 3] = c & 0xff
    hintsField = b64url(blob)
    rosterIncluded = true
  }
  const head = `${MARKER_PREFIX}${m.iat},${adminKid},`
  let descr = `${head}${hintsField},`
  if (byteLen(descr) > DESCR_MAX) { // the roster alone overruns: drop it whole
    hintsField = ''; rosterIncluded = false
    descr = `${head},`
  }
  // Whatever is left goes to the name, measured in bytes. A comma would break
  // the positional format, so it cannot survive in one.
  const name = sliceBytes((m.name ?? '').replace(/,/g, ' '), Math.max(0, DESCR_MAX - byteLen(descr)))
  return { descr: descr + name, rosterIncluded, nameIncluded: name.length > 0 }
}

/** Parse a DESCR written by `buildMarker`. Null when it is not a group marker. */
export function parseMarker(descr: string): MarkerFields | null {
  if (!descr.startsWith(MARKER_PREFIX)) return null
  const rest = descr.slice(MARKER_PREFIX.length)
  const parts = rest.split(',')
  if (parts.length < 4) return null
  const [iatS, adminKid, blobS] = parts
  const name = parts.slice(3).join(',')
  const iat = Number(iatS)
  if (!Number.isFinite(iat) || !/^[0-9a-f]{32}$/.test(adminKid)) return null
  let hints: string[] = []
  let crc = 0
  if (blobS) {
    const blob = unb64url(blobS)
    if (blob.length < 4 || (blob.length - 4) % HINT_BYTES !== 0) return null
    const n = (blob.length - 4) / HINT_BYTES
    for (let i = 0; i < n; i++) hints.push(hex(blob.slice(i * HINT_BYTES, (i + 1) * HINT_BYTES)))
    const o = n * HINT_BYTES
    crc = ((blob[o] << 24) | (blob[o + 1] << 16) | (blob[o + 2] << 8) | blob[o + 3]) >>> 0
  }
  return { iat, adminKid, hints, crc, name }
}

/**
 * Rebuild the roster from hints against public keys this device can see (the
 * HEM contact list). Returns the members in roster order, or null when the
 * result does not match the CRC — an unresolved hint, or a 4-byte collision
 * that picked the wrong key.
 *
 * Reconstruction only. A roster is trusted because the admin MAC'd it, never
 * because it came out of here.
 */
export async function resolveRoster(
  m: MarkerFields,
  candidates: Uint8Array[],
): Promise<Uint8Array[] | null> {
  if (!m.hints.length) return null
  const byHint = new Map<string, { pub: Uint8Array; kid: string }>()
  for (const pub of candidates) {
    const kid = await hemKid(pub)
    const h = kid.slice(0, HINT_BYTES * 2)
    if (!byHint.has(h)) byHint.set(h, { pub, kid }) // first wins; the CRC catches a wrong pick
  }
  const picked: { pub: Uint8Array; kid: string }[] = []
  for (const h of m.hints) {
    const hit = byHint.get(h)
    if (!hit) return null // a member this device has never imported
    picked.push(hit)
  }
  if (crc32(unhex(picked.map((p) => p.kid).join(''))) !== m.crc) return null
  return picked.map((p) => p.pub)
}

// base64url without padding — the DESCR budget is tight enough that four
// characters of '=' matter, and the field is text.
function b64url(b: Uint8Array): string {
  return b64(b).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}
function unb64url(s: string): Uint8Array {
  const p = s.replace(/-/g, '+').replace(/_/g, '/')
  return unb64(p + '='.repeat((4 - (p.length % 4)) % 4))
}
