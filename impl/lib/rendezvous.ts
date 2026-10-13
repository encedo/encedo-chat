/**
 * rendezvous.ts — deterministic rendezvous derivation (docs/SPEC.md §5).
 *
 * SHARED, browser+Node engine on WebCrypto only (no third-party crypto lib).
 * Both sides compute the same ss = ECDH(IK_a, IK_b) and MUST run this exact
 * derivation so the topic matches. On current HEM firmware the HKDF runs
 * client-side over the raw ECDH output; on newer fw it moves into the device
 * (same inputs/labels/output — only the execution site moves). See CLAUDE.md.
 */

import { subtle, kdf } from './wc.ts'
import { nowMs } from './time.ts'
import { plog, val } from './protolog.ts'

const enc = new TextEncoder()

// RFC 4648 base32, lowercase, no padding (multiformats convention).
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

export interface RvParams {
  networkId: string   // --network id, default 'main' ([v6] extension, §5.1)
  dateUTC: string     // YYYY-MM-DD (UTC)
}

// The context (HKDF salt) = network_id || 0x00 || date_UTC   (§5.1, with the v6 domain separator)
export function paramsInfo({ networkId, dateUTC }: RvParams): Uint8Array {
  const n = enc.encode(networkId), d = enc.encode(dateUTC)
  const out = new Uint8Array(n.length + 1 + d.length)
  out.set(n, 0); out[n.length] = 0; out.set(d, n.length + 1)
  return out
}

/** Deterministic rendezvous topic (§5.1). ss = raw ECDH(IK_a, IK_b). */
export async function topicFromSecret(ss: Uint8Array, p: RvParams): Promise<string> {
  const mat = await kdf('encedo-chat-rendezvous-v1', ss, paramsInfo(p))
  const topic = base32(mat).slice(0, 52)
  plog('§5.1', `pair topic: kdf("encedo-chat-rendezvous-v1", ss=${val(ss)}, ctx=net|date=${p.networkId}|${p.dateUTC}) -> ${topic}`)
  return topic
}

/** Announce MAC key as a non-extractable HMAC CryptoKey (§5.5). */
export async function announceMacKey(ss: Uint8Array, p: RvParams): Promise<CryptoKey> {
  const raw = await kdf('encedo-chat-announce-mac-v1', ss, paramsInfo(p))
  plog('§5.5', `announce MAC key: kdf("encedo-chat-announce-mac-v1", ss, ctx=net|date=${p.networkId}|${p.dateUTC}) -> ${val(raw)}`)
  return subtle.importKey('raw', raw, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify'])
}

export function todayUTC(): string {
  return new Date(nowMs()).toISOString().slice(0, 10)
}

/** Group rendezvous topic (§5.3 Proposal): same construction as the pair topic
 *  but `ikm = group_secret` (a client-side per-epoch secret, not a DH secret) and
 *  a distinct label so the two topic spaces cannot collide. All members share
 *  `group_secret`, so all derive the same topic; it rotates per epoch (the secret
 *  changes on membership change) and daily (`date_UTC` in `info`). */
export async function groupTopicFromSecret(groupSecret: Uint8Array, p: RvParams): Promise<string> {
  const mat = await kdf('encedo-chat-group-rendezvous-v1', groupSecret, paramsInfo(p))
  const topic = base32(mat).slice(0, 52)
  plog('§5.3', `group topic: kdf("encedo-chat-group-rendezvous-v1", group_secret=${val(groupSecret)}, ctx=net|date=${p.networkId}|${p.dateUTC}) -> ${topic}`)
  return topic
}

/**
 * Per-pair rotation offset (docs/SPEC.md §5.4 Proposal): the second of the
 * UTC day at which THIS pair rotates its topic. Derived from the pair secret so
 * both members agree, and pseudo-random across pairs so the user base spreads
 * over 24 h instead of spiking at 00:00 UTC. **Date-independent** (the `info`
 * carries no date) -> stable per pair, computed once and cached.
 *
 * Firmware seam (same as the topic/MAC/cache derivations — CLAUDE.md): TODAY this
 * runs HKDF client-side over the raw `ss` a HEM returns. On newer fw the ecdh+HKDF
 * runs INSIDE the device (raw `ss` never leaves), and this becomes, in effect,
 * `rotationOffsetSec(myKid, peerKidOrPub) -> offset` — one HSM ecdh+HKDF call whose
 * label/context/`L` are exactly the ones here. It migrates in-device together with
 * `topicFromSecret`/`announceMacKey`, not on its own.
 */
export async function rotationOffsetSec(ss: Uint8Array, p: RvParams): Promise<number> {
  const nid = enc.encode(p.networkId)
  const ctx = new Uint8Array(nid.length + 1)
  ctx.set(nid, 0); ctx[nid.length] = 0 // network_id || 0x00 — NO date
  const mat = await kdf('encedo-chat-rotation-v1', ss, ctx, 4)
  const off = new DataView(mat.buffer, mat.byteOffset, 4).getUint32(0) % 86400
  plog('§5.4', `rotation offset: kdf("encedo-chat-rotation-v1", ss, ctx=net=${p.networkId}, no date) -> ${off}s `
    + `(${String(Math.floor(off / 3600)).padStart(2, '0')}:${String(Math.floor((off % 3600) / 60)).padStart(2, '0')} UTC)`)
  return off
}
