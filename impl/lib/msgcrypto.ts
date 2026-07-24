/**
 * msgcrypto.ts — INTERIM message encryption for the CLI (pre-EH-2).
 *
 * ⚠️ PLACEHOLDER. The real scheme is EH-2 + Double Ratchet (docs/PROTOCOL.md
 * §6–7), held pending the cryptographer. This derives a STATIC AES-256-GCM key
 * from the pair secret ss (same ss as topic/macKey). It gives real E2E
 * confidentiality against the relay (which sees only ciphertext) — but NO
 * forward secrecy and NO ratchet. Interim transport for the CLI only; replaced
 * by EH-2 before anything ships.
 */

import { hkdfSync, randomBytes, createCipheriv, createDecipheriv } from 'node:crypto'
import { fromString, toString } from 'uint8arrays'
import type { RvParams } from './rendezvous.ts'

export function msgKeyFromSecret(ss: Uint8Array, p: RvParams): Buffer {
  const info = Buffer.concat([Buffer.from(p.networkId, 'utf8'), Buffer.from([0]), Buffer.from(p.dateUTC, 'utf8')])
  return Buffer.from(hkdfSync('sha256', ss, Buffer.from('encedo-chat-msg-v0-INTERIM'), info, 32))
}

/** AES-256-GCM. Wire: {"k":"m","iv":b64,"ct":b64,"tag":b64}. */
export function encryptMsg(text: string, key: Buffer): Uint8Array {
  const iv = randomBytes(12)
  const c = createCipheriv('aes-256-gcm', key, iv)
  const ct = Buffer.concat([c.update(text, 'utf8'), c.final()])
  return fromString(JSON.stringify({
    k: 'm', iv: iv.toString('base64'), ct: ct.toString('base64'), tag: c.getAuthTag().toString('base64'),
  }), 'utf8')
}

/** Returns plaintext, or null if this isn't a chat message / wrong key / tampered. */
export function tryDecryptMsg(data: Uint8Array, key: Buffer): string | null {
  let m: any
  try { m = JSON.parse(toString(data, 'utf8')) } catch { return null }
  if (m?.k !== 'm') return null
  try {
    const d = createDecipheriv('aes-256-gcm', key, Buffer.from(m.iv, 'base64'))
    d.setAuthTag(Buffer.from(m.tag, 'base64'))
    return Buffer.concat([d.update(Buffer.from(m.ct, 'base64')), d.final()]).toString('utf8')
  } catch { return null }
}
