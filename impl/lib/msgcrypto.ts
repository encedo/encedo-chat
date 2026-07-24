/**
 * msgcrypto.ts — INTERIM message encryption for the CLI/GUI (pre-EH-2). WebCrypto only.
 *
 * ⚠️ PLACEHOLDER. Real scheme is EH-2 + Double Ratchet (docs/PROTOCOL.md §6–7),
 * held for the cryptographer. Static AES-256-GCM key from the pair secret ss
 * (same ss as topic/macKey): real E2E vs the relay, but NO forward secrecy / no
 * ratchet. Interim only. Key is a non-extractable AES-GCM CryptoKey.
 */

import { subtle, randomBytes, b64, unb64 } from './wc.ts'
import { paramsInfo, type RvParams } from './rendezvous.ts'
import { hkdfBits } from './wc.ts'

const enc = new TextEncoder()
const dec = new TextDecoder()

export async function msgKeyFromSecret(ss: Uint8Array, p: RvParams): Promise<CryptoKey> {
  const raw = await hkdfBits(ss, enc.encode('encedo-chat-msg-v0-INTERIM'), paramsInfo(p), 32)
  return subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt'])
}

/** AES-256-GCM (12B iv, tag appended by WebCrypto). Wire: {"k":"m","iv":b64,"ct":b64}. */
export async function encryptMsg(text: string, key: CryptoKey): Promise<Uint8Array> {
  const iv = randomBytes(12)
  const ct = new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(text)))
  return enc.encode(JSON.stringify({ k: 'm', iv: b64(iv), ct: b64(ct) }))
}

/** Returns plaintext, or null if this isn't a chat message / wrong key / tampered. */
export async function tryDecryptMsg(data: Uint8Array, key: CryptoKey): Promise<string | null> {
  let m: any
  try { m = JSON.parse(dec.decode(data)) } catch { return null }
  if (m?.k !== 'm') return null
  try {
    const pt = await subtle.decrypt({ name: 'AES-GCM', iv: unb64(m.iv) }, key, unb64(m.ct))
    return dec.decode(new Uint8Array(pt))
  } catch { return null }
}
