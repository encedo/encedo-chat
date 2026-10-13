/**
 * rendezvous.ts — deterministic rendezvous derivation (docs/SPEC.md §5).
 *
 * SHARED, browser+Node engine on WebCrypto only (no third-party crypto lib).
 * Both sides compute the same ss = ECDH(IK_a, IK_b) and MUST run this exact
 * derivation so the topic matches. For a pair the HKDF runs wherever the
 * identity backend runs it (lib/derive.ts): the labels, contexts and lengths
 * are the ones here, and the material converters below turn its output into
 * a topic, a MAC key or an offset.
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

export const RV_LABEL = 'encedo-chat-rendezvous-v1'
export const ANNOUNCE_LABEL = 'encedo-chat-announce-mac-v1'
export const ROTATION_LABEL = 'encedo-chat-rotation-v1'
export const GROUP_RV_LABEL = 'encedo-chat-group-rendezvous-v1'

/** The context of the rotation offset: network_id || 0x00, NO date (§5.4). */
export function rotationCtx(networkId: string): Uint8Array {
  const nid = enc.encode(networkId)
  const ctx = new Uint8Array(nid.length + 1)
  ctx.set(nid, 0); ctx[nid.length] = 0
  return ctx
}
/** 32 bytes of topic material -> the 52-character topic (§5.1). */
export const topicFromMaterial = (mat: Uint8Array): string => base32(mat).slice(0, 52)
/** 32 bytes of key material -> the non-extractable Announce HMAC key (§5.5). */
export const announceKeyFromMaterial = (raw: Uint8Array): Promise<CryptoKey> =>
  subtle.importKey('raw', raw, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify'])
/** 4 bytes of rotation material -> seconds past 00:00 UTC (§5.4). */
export const offsetFromMaterial = (mat: Uint8Array): number => new DataView(mat.buffer, mat.byteOffset, 4).getUint32(0) % 86400

// The context (HKDF salt) = network_id || 0x00 || date_UTC   (§5.1, with the v6 domain separator)
export function paramsInfo({ networkId, dateUTC }: RvParams): Uint8Array {
  const n = enc.encode(networkId), d = enc.encode(dateUTC)
  const out = new Uint8Array(n.length + 1 + d.length)
  out.set(n, 0); out[n.length] = 0; out.set(d, n.length + 1)
  return out
}

/** Deterministic rendezvous topic (§5.1). ss = raw ECDH(IK_a, IK_b). */
export async function topicFromSecret(ss: Uint8Array, p: RvParams): Promise<string> {
  const mat = await kdf(RV_LABEL, ss, paramsInfo(p))
  const topic = topicFromMaterial(mat)
  plog('§5.1', `pair topic: kdf("encedo-chat-rendezvous-v1", ss=${val(ss)}, ctx=net|date=${p.networkId}|${p.dateUTC}) -> ${topic}`)
  return topic
}

/** Announce MAC key as a non-extractable HMAC CryptoKey (§5.5). */
export async function announceMacKey(ss: Uint8Array, p: RvParams): Promise<CryptoKey> {
  const raw = await kdf(ANNOUNCE_LABEL, ss, paramsInfo(p))
  plog('§5.5', `announce MAC key: kdf("encedo-chat-announce-mac-v1", ss, ctx=net|date=${p.networkId}|${p.dateUTC}) -> ${val(raw)}`)
  return announceKeyFromMaterial(raw)
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
  const mat = await kdf(GROUP_RV_LABEL, groupSecret, paramsInfo(p))
  const topic = topicFromMaterial(mat)
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
 * This form takes a secret the caller holds (a group_secret, an invite_secret);
 * for a pair or the self-DH, core derives the material through the identity
 * backend (lib/derive.ts) and converts it with `offsetFromMaterial`.
 */
export async function rotationOffsetSec(ss: Uint8Array, p: RvParams): Promise<number> {
  const mat = await kdf(ROTATION_LABEL, ss, rotationCtx(p.networkId), 4)
  const off = offsetFromMaterial(mat)
  plog('§5.4', `rotation offset: kdf("encedo-chat-rotation-v1", ss, ctx=net=${p.networkId}, no date) -> ${off}s `
    + `(${String(Math.floor(off / 3600)).padStart(2, '0')}:${String(Math.floor((off % 3600) / 60)).padStart(2, '0')} UTC)`)
  return off
}
