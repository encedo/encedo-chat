/**
 * x25519.ts — X25519 keys as a DH capability, over WebCrypto only.
 *
 * One interface for "a private key I can do DH with", whoever holds it:
 *   - an ephemeral key generated here (EH-2's EK_*, the ratchet's DH_self),
 *   - a long-term IK inside the HEM (adapter over Identity.ecdh — raw mode, §4.3).
 *
 * The private key never leaves its holder: for local keys it stays a
 * non-extractable CryptoKey, for the HSM it never exists here at all. That is
 * why callers get a `dh()` function, not key bytes.
 */

import { subtle, b64, unb64 } from './wc.ts'

/** A private X25519 key you can compute raw DH outputs with. */
export interface Dh {
  /** The matching public key, raw 32 bytes. */
  pub: Uint8Array
  /** Raw X25519 shared secret (32 B) with a peer's raw public key. */
  dh(peerPub: Uint8Array): Promise<Uint8Array>
}

/** Fresh ephemeral X25519 keypair; the private key stays non-extractable. */
export async function generateX25519(): Promise<Dh> {
  const kp = (await subtle.generateKey({ name: 'X25519' }, false, ['deriveBits'])) as CryptoKeyPair
  const pub = new Uint8Array(await subtle.exportKey('raw', kp.publicKey))
  return { pub, dh: (peerPub) => rawDh(kp.privateKey, peerPub) }
}

/** PKCS#8 prefix for an X25519 private key (RFC 8410) — header + 32-byte scalar. */
const PKCS8_X25519 = new Uint8Array([
  0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x6e, 0x04, 0x22, 0x04, 0x20,
])
const BASEPOINT = new Uint8Array(32); BASEPOINT[0] = 9

/**
 * Build a `Dh` from raw private-key bytes. For known-answer tests (fixed keys ->
 * reproducible SK) and for keystores that hold a raw scalar. The public key is
 * recovered as X25519(priv, basepoint) — WebCrypto cannot export it from a
 * private key directly.
 */
export async function x25519FromPriv(priv32: Uint8Array): Promise<Dh> {
  if (priv32.length !== 32) throw new Error(`X25519: private key must be 32 B, got ${priv32.length}`)
  const pkcs8 = new Uint8Array(PKCS8_X25519.length + 32)
  pkcs8.set(PKCS8_X25519); pkcs8.set(priv32, PKCS8_X25519.length)
  const priv = await subtle.importKey('pkcs8', pkcs8, { name: 'X25519' }, false, ['deriveBits'])
  const pub = await rawDh(priv, BASEPOINT)
  return { pub, dh: (peerPub) => rawDh(priv, peerPub) }
}

async function rawDh(priv: CryptoKey, peerPub: Uint8Array): Promise<Uint8Array> {
  if (peerPub.length !== 32) throw new Error(`X25519: peer public key must be 32 B, got ${peerPub.length}`)
  const pub = await subtle.importKey('raw', peerPub, { name: 'X25519' }, false, [])
  return new Uint8Array(await subtle.deriveBits({ name: 'X25519', public: pub }, priv, 256))
}

/**
 * Adapt anything with the core's `ecdh(peerPubB64)` contract (HEM identity or
 * software identity) into a `Dh` over raw bytes — the form the handshake and
 * ratchet speak. This is the single place base64 meets the crypto layer.
 */
export function dhFromEcdh(pubB64: string, ecdh: (peerPubB64: string) => Promise<Uint8Array>): Dh {
  return { pub: unb64(pubB64), dh: (peerPub) => ecdh(b64(peerPub)) }
}
