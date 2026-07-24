/**
 * rendezvous.ts — deterministic rendezvous derivation (docs/PROTOCOL.md §5).
 *
 * SHARED module: used identically by Bob (software, Node) and by Alice's client
 * (over her HEM). Both sides compute the same ss = ECDH(IK_a, IK_b) and MUST run
 * this exact derivation, so the topic matches.
 *
 * Firmware phase note (CLAUDE.md): on current HEM firmware the HKDF here runs
 * client-side over the raw ECDH output. On newer firmware the same HKDF moves
 * into the device (/ecdh alg=HKDF-SHA256 + hkdf_salt/info/n). The derivation
 * (inputs, labels, output) is identical either way — only the execution site moves.
 */

import { hkdfSync } from 'node:crypto'

const RENDEZVOUS_SALT   = 'encedo-chat-rendezvous-v1'
const ANNOUNCE_MAC_SALT = 'encedo-chat-announce-mac-v1'

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
function info({ networkId, dateUTC }: RvParams): Buffer {
  return Buffer.concat([Buffer.from(networkId, 'utf8'), Buffer.from([0]), Buffer.from(dateUTC, 'utf8')])
}

function hkdf(ss: Uint8Array, salt: string, p: RvParams, len = 32): Buffer {
  return Buffer.from(hkdfSync('sha256', ss, Buffer.from(salt, 'utf8'), info(p), len))
}

/** Deterministic rendezvous topic (§5.1). ss = raw ECDH(IK_a, IK_b). */
export function topicFromSecret(ss: Uint8Array, p: RvParams): string {
  return base32(hkdf(ss, RENDEZVOUS_SALT, p)).slice(0, 52)
}

/** Announce MAC key (§5.5). */
export function announceMacKey(ss: Uint8Array, p: RvParams): Buffer {
  return hkdf(ss, ANNOUNCE_MAC_SALT, p)
}

export function todayUTC(): string {
  return new Date().toISOString().slice(0, 10)
}
