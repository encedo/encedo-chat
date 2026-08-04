/**
 * gmarker.ts — the HEM group marker (§8 "HEM marker (portable membership)").
 *
 * The only per-group object in the HSM is the GK key entry; its DESCR is what
 * makes membership PORTABLE. `key_search` over the marker prefix yields the
 * group list on any device holding the same HEM, without a byte of group state
 * having been stored anywhere on the network.
 *
 *     ETSEIC:chan,<admin_KID>,<name ≤16>,<roster blob>
 *
 * What it deliberately does NOT hold: `group_secret` (the topic seed) and
 * sender keys (content). Those are client-side and forward-secret; a HEM dump
 * must not hand over the ability to read anything.
 *
 * Four things about this layout are decisions, not accidents:
 *
 * - **No `iat`.** The HSM already timestamps its own key entries, and spending
 *   ten of 128 bytes to repeat what the key record answers is not a trade worth
 *   making.
 * - **A KID is taken from the HEM when we hold one, and derived only when we do
 *   not.** The HEM KID is `SHA1(pub)[0:16]` (GROUPS-DESIGN.md) — deterministic
 *   and global, which is exactly why a hint the admin writes resolves on
 *   someone else's device. Note it is SHA-**1**, and NOT the app fingerprint
 *   `SHA-256(pub)` (§4.4), which is the human out-of-band check and a different
 *   identifier entirely. Preferring the issued KID keeps this correct even if a
 *   firmware ever stops deriving them that way; deriving covers a member we
 *   hold a public key for but have not imported.
 * - **The name is capped at 16 characters.** It is a label, it is held
 *   client-side anyway, and the roster is what actually needs the room.
 * - **The roster blob is LAST**, so it is the field that can grow, be truncated
 *   by a shorter record, or be absent, without disturbing anything before it.
 *
 * The blob is a 4-byte KID hint per member plus a CRC32 over the concatenated
 * full KIDs. Hints are resolved by KID-prefix lookup among keys the HEM already
 * holds (your contacts), and the CRC confirms the reconstructed set — a 4-byte
 * hint collides rarely, but "rarely" is not "never". The CRC is **integrity,
 * not authenticity**: it catches a hint that resolved to the wrong key, it does
 * not make a roster trustworthy. Authenticity is the admin's `rk_i` MAC (§8),
 * always — anyone who can write this DESCR can write a matching CRC.
 *
 * Trade-off, stated in the design: with the roster blob, one HEM dump reveals
 * the whole membership graph (hints plus your contacts, both in the HEM);
 * without it, a dump reveals only that a group exists. Including it is the
 * caller's choice.
 */

import { subtle, b64, unb64 } from './wc.ts'

/** Anyone this module can identify: an HSM-issued KID, a public key, or both. */
export interface KeyRef { kid?: string; pub?: Uint8Array }

/**
 * The HEM KID: `SHA1(pub)[0:16]`, hex — deterministic and global, so the same
 * public key yields the same KID on every HEM, which is what lets a hint
 * written by the admin resolve on a member's device.
 *
 * SHA-**1**, deliberately: this is a key index. The app fingerprint is
 * `SHA-256(pub)` (§4.4) and answers a different question (out-of-band MITM).
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
/** A label, not a protocol field — the roster needs the room more than it does. */
export const NAME_MAX = 16
/** The spec bounds the compact roster at 10 members (~44 B). Beyond that it is omitted. */
export const ROSTER_MAX = 10

const HINT_HEX = 8 // 4 bytes of KID, as hex characters

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

const isHexKid = (k: string) => /^[0-9a-f]+$/i.test(k) && k.length >= HINT_HEX && k.length % 2 === 0
function unhex(s: string): Uint8Array {
  const out = new Uint8Array(s.length >> 1)
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16)
  return out
}
function hex(b: Uint8Array): string { return [...b].map((x) => x.toString(16).padStart(2, '0')).join('') }

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
  /** The admin's KID as the HSM issued it — whom to ask for a re-sync. */
  adminKid: string
  /** Display label, ≤16 characters. */
  name: string
  /** 4-byte KID hints (8 hex chars), one per member, in roster order. Empty = no blob. */
  hints: string[]
  /** CRC32 over the concatenated FULL KIDs, in the same order. 0 when no roster. */
  crc: number
}

/**
 * Build the DESCR.
 *
 * Fields yield in priority order, because 128 bytes does not fit everything at
 * ten members: the admin KID always survives, the name is capped and then
 * truncated on a character boundary, and the roster blob — last, and the only
 * optional field — is dropped WHOLE rather than partially, because half a
 * roster reconstructs a wrong one. Callers are told what actually made it in.
 *
 * `memberKids` must be the KIDs the HSM issued. A member with no KID (a
 * local-only contact never imported) cannot be represented, and the blob is
 * omitted rather than silently written short.
 */
export async function buildMarker(m: {
  admin: KeyRef
  /** Members in roster order. Omit to skip the blob. */
  members?: KeyRef[]
  name?: string
}): Promise<{ descr: string; rosterIncluded: boolean; nameIncluded: boolean }> {
  const adminKid = await kidOf(m.admin)
  if (!adminKid) throw new Error('marker: the admin needs a KID or a public key')
  const kids = await Promise.all((m.members ?? []).map(kidOf))
  // A member we can neither name nor derive cannot be represented, and half a
  // roster reconstructs a wrong one — so the blob is all or nothing.
  const usable = kids.length > 0 && kids.length <= ROSTER_MAX
    && kids.every((k): k is string => !!k && isHexKid(k))

  let blob = ''
  if (usable) {
    const list = kids as string[]
    const packed = new Uint8Array(list.length * 4 + 4)
    list.forEach((k, i) => packed.set(unhex(k.slice(0, HINT_HEX)), i * 4))
    const c = crc32(unhex(list.join('')))
    const off = list.length * 4
    packed[off] = (c >>> 24) & 0xff; packed[off + 1] = (c >>> 16) & 0xff
    packed[off + 2] = (c >>> 8) & 0xff; packed[off + 3] = c & 0xff
    blob = b64url(packed)
  }

  // A comma would break the positional format, so it cannot survive in one.
  let name = [...(m.name ?? '').replace(/,/g, ' ')].slice(0, NAME_MAX).join('')
  const head = `${MARKER_PREFIX}${adminKid},`
  name = sliceBytes(name, Math.max(0, DESCR_MAX - byteLen(head) - 1 - byteLen(blob)))
  let descr = `${head}${name},${blob}`
  let rosterIncluded = blob.length > 0
  if (byteLen(descr) > DESCR_MAX) { // the blob no longer fits: drop it whole
    rosterIncluded = false
    descr = `${head}${name},`
  }
  return { descr, rosterIncluded, nameIncluded: name.length > 0 }
}

/** Parse a DESCR written by `buildMarker`. Null when it is not a group marker. */
export function parseMarker(descr: string): MarkerFields | null {
  if (!descr.startsWith(MARKER_PREFIX)) return null
  const parts = descr.slice(MARKER_PREFIX.length).split(',')
  if (parts.length < 3) return null
  const adminKid = parts[0]
  const name = parts[1]
  const blobS = parts.slice(2).join(',') // the blob is last and base64url: no commas in it
  if (!adminKid || !isHexKid(adminKid)) return null
  const hints: string[] = []
  let crc = 0
  if (blobS) {
    const blob = unb64url(blobS)
    if (blob.length < 8 || (blob.length - 4) % 4 !== 0) return null
    const n = (blob.length - 4) / 4
    for (let i = 0; i < n; i++) hints.push(hex(blob.slice(i * 4, i * 4 + 4)))
    const o = n * 4
    crc = ((blob[o] << 24) | (blob[o + 1] << 16) | (blob[o + 2] << 8) | blob[o + 3]) >>> 0
  }
  return { adminKid, name, hints, crc }
}

/**
 * Rebuild the roster from hints against keys this device can see — the HEM
 * contact list, each entry carrying the KID the HSM issued for it. Returns the
 * members in roster order, or null when the result does not match the CRC: an
 * unresolved hint, or a 4-byte collision that picked the wrong key.
 *
 * Reconstruction only. A roster is trusted because the admin MAC'd it, never
 * because it came out of here.
 */
export async function resolveRoster<T extends KeyRef>(
  m: MarkerFields,
  candidates: T[],
): Promise<T[] | null> {
  if (!m.hints.length) return null
  const byHint = new Map<string, { c: T; kid: string }>()
  for (const c of candidates) {
    const kid = await kidOf(c)
    if (!kid || !isHexKid(kid)) continue
    const h = kid.slice(0, HINT_HEX)
    if (!byHint.has(h)) byHint.set(h, { c, kid }) // first wins; the CRC catches a wrong pick
  }
  const picked: { c: T; kid: string }[] = []
  for (const h of m.hints) {
    const hit = byHint.get(h.toLowerCase())
    if (!hit) return null // a member this device has never imported
    picked.push(hit)
  }
  if (crc32(unhex(picked.map((p) => p.kid).join(''))) !== m.crc) return null
  return picked.map((p) => p.c)
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
