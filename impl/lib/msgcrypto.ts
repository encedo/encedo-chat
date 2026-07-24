/**
 * msgcrypto.ts — INTERIM message encryption for the CLI/GUI (pre-EH-2).
 *
 * ⚠️ PLACEHOLDER. Real scheme is EH-2 + Double Ratchet (docs/PROTOCOL.md §6–7),
 * held for the cryptographer. Static AES-256-GCM key from the pair secret ss
 * (same ss as topic/macKey): real E2E vs the relay, but NO forward secrecy / no
 * ratchet. Interim only. Browser+Node: @noble/ciphers, no Buffer.
 */

import { hkdf } from '@noble/hashes/hkdf'
import { sha256 } from '@noble/hashes/sha2'
import { randomBytes } from '@noble/hashes/utils'
import { gcm } from '@noble/ciphers/aes'
import { fromString, toString } from 'uint8arrays'
import { paramsInfo, type RvParams } from './rendezvous.ts'

const enc = new TextEncoder()
const dec = new TextDecoder()

export function msgKeyFromSecret(ss: Uint8Array, p: RvParams): Uint8Array {
  return hkdf(sha256, ss, enc.encode('encedo-chat-msg-v0-INTERIM'), paramsInfo(p), 32)
}

/** AES-256-GCM (nonce 12B, tag appended to ct by @noble). Wire: {"k":"m","iv":b64,"ct":b64}. */
export function encryptMsg(text: string, key: Uint8Array): Uint8Array {
  const iv = randomBytes(12)
  const ct = gcm(key, iv).encrypt(enc.encode(text))
  return fromString(JSON.stringify({ k: 'm', iv: toString(iv, 'base64'), ct: toString(ct, 'base64') }), 'utf8')
}

/** Returns plaintext, or null if this isn't a chat message / wrong key / tampered. */
export function tryDecryptMsg(data: Uint8Array, key: Uint8Array): string | null {
  let m: any
  try { m = JSON.parse(toString(data, 'utf8')) } catch { return null }
  if (m?.k !== 'm') return null
  try {
    return dec.decode(gcm(key, fromString(m.iv, 'base64')).decrypt(fromString(m.ct, 'base64')))
  } catch { return null }
}
