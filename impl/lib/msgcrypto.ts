/**
 * msgcrypto.ts — INTERIM sealed box for the CLI/GUI (pre-EH-2). WebCrypto only.
 *
 * ⚠️ PLACEHOLDER. Real scheme is EH-2 + Double Ratchet (docs/PROTOCOL.md §6–7),
 * held for the cryptographer. Static AES-256-GCM key from the pair secret ss
 * (same ss as topic/macKey): real E2E vs the relay, but NO forward secrecy / no
 * ratchet. Interim only. Key is a non-extractable AES-GCM CryptoKey.
 *
 * Type-agnostic: seals/opens raw bytes. The application payload (the JSON
 * envelope, lib/envelope.ts) lives INSIDE this box; this layer knows nothing
 * about it. When EH-2 lands, the same envelope bytes get sealed by the ratchet
 * and this file goes away.
 */

import { subtle, randomBytes, b64, unb64, hkdfBits } from './wc.ts'
import { paramsInfo, type RvParams } from './rendezvous.ts'

const enc = new TextEncoder()
const dec = new TextDecoder()

export async function msgKeyFromSecret(ss: Uint8Array, p: RvParams): Promise<CryptoKey> {
  const raw = await hkdfBits(ss, enc.encode('encedo-chat-msg-v0-INTERIM'), paramsInfo(p), 32)
  return subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt'])
}

/** Seal raw bytes: AES-256-GCM (12B iv, tag appended by WebCrypto). Wire: {"k":"m","iv":b64,"ct":b64}. */
export async function seal(plaintext: Uint8Array, key: CryptoKey): Promise<Uint8Array> {
  const iv = randomBytes(12)
  const ct = new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv }, key, plaintext))
  return enc.encode(JSON.stringify({ k: 'm', iv: b64(iv), ct: b64(ct) }))
}

/** Open a sealed box → plaintext bytes, or null if not a box / wrong key / tampered. */
export async function open(data: Uint8Array, key: CryptoKey): Promise<Uint8Array | null> {
  let m: any
  try { m = JSON.parse(dec.decode(data)) } catch { return null }
  if (m?.k !== 'm') return null
  try {
    const pt = await subtle.decrypt({ name: 'AES-GCM', iv: unb64(m.iv) }, key, unb64(m.ct))
    return new Uint8Array(pt)
  } catch { return null }
}
