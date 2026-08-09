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

import {
  DESCR_MAX, byteLen, sliceBytes, isHexKid, unhex, hex, b64url, unb64url, hemKid, kidOf, type KeyRef,
} from './descr.ts'

// The budget rules and the key-id helpers are shared with the identity/contact
// records (`descr.ts`) — one DESCR field, one set of rules. Re-exported because
// this module was their home first and callers still import them from here.
export { DESCR_MAX, byteLen, hemKid, kidOf, type KeyRef }

/**
 * `key_search` prefix that finds EVERY generation — the version digit follows it,
 * so one search returns markers written by any build (§8 implementation note).
 */
export const MARKER_SEARCH = 'ETSEIC:chan'
/** What this build WRITES: generation 1 of the compact format. */
export const MARKER_PREFIX = 'ETSEIC:chan1:'
/**
 * The unversioned format written before 2026-08-07 — full admin KID in hex,
 * comma-separated. Still READ (a device already carries markers in it), never
 * written. This is what the version digit is for.
 */
const LEGACY_PREFIX = 'ETSEIC:chan,'

/**
 * What overrunning `DESCR_MAX` costs HERE, which is worse than a clipped string:
 * the roster blob is last, so silent truncation leaves a blob that still decodes
 * — into a *different* roster. Hence every cut goes through `sliceBytes`, and the
 * blob is dropped whole rather than shortened.
 */
/** A label, not a protocol field — the roster needs the room more than it does. */
export const NAME_MAX = 16
/** The spec bounds the compact roster at 10 members (~44 B). Beyond that it is omitted. */
export const ROSTER_MAX = 10

const HINT_HEX = 8 // 4 bytes of KID, as hex characters

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
  /**
   * Whom to ask for a re-sync — as a **hint**, not as proof.
   *
   * 8 hex chars (4 bytes) in the current format, the full KID in a legacy
   * marker. Four bytes are grindable (~2^32), so this selects a candidate among
   * keys the device already holds; the admin's `rk_i` MAC is what decides.
   */
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

  // The admin travels as the same 4-byte hint the roster members do, in the same
  // base64url: 6 characters instead of 32, which is most of what makes the
  // compact form fit a 63-byte field. See the §8 implementation note.
  // The hint is 4 bytes of the KID, so it needs a hex KID to cut. A device that
  // labels its keys some other way still has the public key, and `hemKid`
  // derives the same value the HSM would — so derive rather than refuse.
  const adminHex = isHexKid(adminKid)
    ? adminKid
    : m.admin.pub ? await hemKid(m.admin.pub) : null
  if (!adminHex) throw new Error('marker: the admin needs a hex KID or a public key')
  const adminHint = b64url(unhex(adminHex.slice(0, HINT_HEX)))

  // A separator would break the positional format, so it cannot survive in one.
  const wanted = [...(m.name ?? '').replace(/[:,]/g, ' ')].slice(0, NAME_MAX).join('')
  const head = `${MARKER_PREFIX}${adminHint}:`
  let name = sliceBytes(wanted, Math.max(0, DESCR_MAX - byteLen(head) - 1 - byteLen(blob)))
  let descr = `${head}${name}:${blob}`
  let rosterIncluded = blob.length > 0
  if (byteLen(descr) > DESCR_MAX) { // the blob no longer fits: drop it whole
    rosterIncluded = false
    name = sliceBytes(wanted, Math.max(0, DESCR_MAX - byteLen(head) - 1))
    descr = `${head}${name}:`
  }
  return { descr, rosterIncluded, nameIncluded: name.length > 0 }
}

/**
 * Parse a DESCR written by `buildMarker`, in either generation. Null when it is
 * not a group marker.
 *
 * Both are read because markers outlive builds: one is already sitting in a HEM
 * the moment the format changes, and a device that cannot read its own past
 * shows the user an empty group list.
 */
export function parseMarker(descr: string): MarkerFields | null {
  const v1 = descr.startsWith(MARKER_PREFIX)
  const legacy = !v1 && descr.startsWith(LEGACY_PREFIX)
  if (!v1 && !legacy) return null
  const sep = v1 ? ':' : ','
  const parts = descr.slice((v1 ? MARKER_PREFIX : LEGACY_PREFIX).length).split(sep)
  if (parts.length < 3) return null
  const name = parts[1]
  const blobS = parts.slice(2).join(sep) // the blob is last and base64url: no separator in it

  let adminKid: string
  if (v1) {
    let raw: Uint8Array
    try { raw = unb64url(parts[0]) } catch { return null }
    if (raw.length !== 4) return null
    adminKid = hex(raw)
  } else {
    adminKid = parts[0]
    if (!adminKid || !isHexKid(adminKid)) return null
  }
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
