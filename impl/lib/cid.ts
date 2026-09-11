/**
 * cid.ts - checking that bytes are the bytes a CID names.
 *
 * ## Why this exists
 *
 * The official node list is fetched by a CID compiled into the build, and the
 * comment over that constant explains — correctly — that nobody can redirect
 * WHICH list is asked for. What nothing did was check that the bytes coming
 * back are the ones that CID names. They arrive through the app's own `/f`
 * proxy, so anyone able to shape that response could hand every client a chosen
 * set of relays: the first hop of every conversation. `THREAT-MODELS.md` claimed
 * "content addressing is the integrity"; until this module that claim was
 * stronger than the code.
 *
 * Content addressing only buys integrity where somebody computes the hash. That
 * is the whole of this file.
 *
 * ## Why only CIDv1 / raw / sha2-256
 *
 * A CIDv0 (`Qm…`) names a dag-pb node, not the file: verifying one means
 * rebuilding the UnixFS framing around the bytes, which is a protobuf
 * implementation to carry and get wrong. A CIDv1 with `raw` leaves names the
 * bytes themselves, so verification is one SHA-256 and a comparison — and we
 * control how the file is published (`ipfs add --cid-version=1 --raw-leaves`).
 * Everything else is REFUSED rather than waved through: a verifier that quietly
 * answers "fine" for the shapes it cannot check is worse than none at all,
 * because it is believed.
 */

import { sha256 } from './wc.ts'

/** RFC 4648 base32, lower case, no padding — multibase `b`. */
const B32 = 'abcdefghijklmnopqrstuvwxyz234567'

function base32(bytes: Uint8Array): string {
  let bits = 0, value = 0, out = ''
  for (const b of bytes) {
    value = (value << 8) | b
    bits += 8
    while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5 }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31]
  return out
}

/**
 * The CID these bytes would get from `ipfs add --cid-version=1 --raw-leaves`,
 * for content small enough to be a single block (up to 256 KiB by default).
 *
 * Prefix bytes: version 1 (0x01), codec `raw` (0x55), multihash sha2-256
 * (0x12) of length 32 (0x20).
 */
export async function cidV1Raw(bytes: Uint8Array): Promise<string> {
  const digest = await sha256(bytes)
  const out = new Uint8Array(4 + digest.length)
  out.set([0x01, 0x55, 0x12, 0x20], 0)
  out.set(digest, 4)
  return 'b' + base32(out)
}

/** Is this a CID this module can actually check? */
export const isVerifiableCid = (cid: string): boolean =>
  /^bafkrei[a-z2-7]{52}$/.test(cid)

/**
 * Do these bytes belong to this CID?
 *
 * Refuses (rather than passes) anything it cannot check: a CIDv0, a different
 * codec, a different hash. The caller decides what to do about that — and
 * should not treat "cannot verify" as "verified".
 */
export async function cidMatches(cid: string, bytes: Uint8Array): Promise<boolean> {
  if (!isVerifiableCid(cid)) return false
  return (await cidV1Raw(bytes)) === cid
}
