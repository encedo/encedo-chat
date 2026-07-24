/**
 * rendezvous.ts — deterministic rendezvous derivation (docs/PROTOCOL.md §5).
 *
 * SHARED, browser+Node engine: @noble/hashes (sync, no Buffer, no node:crypto).
 * Both sides compute the same ss = ECDH(IK_a, IK_b) and MUST run this exact
 * derivation so the topic matches. On current HEM firmware the HKDF runs
 * client-side over the raw ECDH output; on newer fw it moves into the device
 * (same inputs/labels/output — only the execution site moves). See CLAUDE.md.
 */

import { hkdf } from '@noble/hashes/hkdf'
import { sha256 } from '@noble/hashes/sha2'

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

// info = network_id || 0x00 || date_UTC   (§5.1, with the v6 domain separator)
export function paramsInfo({ networkId, dateUTC }: RvParams): Uint8Array {
  const n = enc.encode(networkId), d = enc.encode(dateUTC)
  const out = new Uint8Array(n.length + 1 + d.length)
  out.set(n, 0); out[n.length] = 0; out.set(d, n.length + 1)
  return out
}

function derive(ss: Uint8Array, salt: string, p: RvParams, len = 32): Uint8Array {
  return hkdf(sha256, ss, enc.encode(salt), paramsInfo(p), len)
}

/** Deterministic rendezvous topic (§5.1). ss = raw ECDH(IK_a, IK_b). */
export function topicFromSecret(ss: Uint8Array, p: RvParams): string {
  return base32(derive(ss, 'encedo-chat-rendezvous-v1', p)).slice(0, 52)
}

/** Announce MAC key (§5.5) — 32-byte Uint8Array. */
export function announceMacKey(ss: Uint8Array, p: RvParams): Uint8Array {
  return derive(ss, 'encedo-chat-announce-mac-v1', p)
}

export function todayUTC(): string {
  return new Date().toISOString().slice(0, 10)
}
