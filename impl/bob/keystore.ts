/**
 * keystore.ts — Bob's SOFTWARE identity store (test peer; no HEM).
 *
 * Bob is the software counterpart in the live rendezvous test: Alice runs a real
 * HEM on USB, Bob's X25519 identity lives here in a file. Both derive the same
 * ss = ECDH(IK_a, IK_b) — Alice via HEM `ecdh`, Bob via node X25519 here.
 *
 * The private key file is TEST-ONLY and git-ignored. A real client never keeps
 * an identity private key outside the HEM.
 */

import { generateKeyPairSync, createPublicKey, createPrivateKey, diffieHellman, type KeyObject } from 'node:crypto'
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { buildSelfDescr } from '../lib/descr.ts'

// X25519 ASN.1 DER prefixes for raw<->KeyObject conversion.
const SPKI_PREFIX  = Buffer.from('302a300506032b656e032100', 'hex')          // public  (12B) + 32B key
const PKCS8_PREFIX = Buffer.from('302e020100300506032b656e04220420', 'hex')  // private (16B) + 32B key

export function rawToPub(raw: Uint8Array): KeyObject {
  return createPublicKey({ key: Buffer.concat([SPKI_PREFIX, Buffer.from(raw)]), format: 'der', type: 'spki' })
}
export function rawToPriv(raw: Uint8Array): KeyObject {
  return createPrivateKey({ key: Buffer.concat([PKCS8_PREFIX, Buffer.from(raw)]), format: 'der', type: 'pkcs8' })
}
const pubRaw  = (ko: KeyObject): Buffer => ko.export({ type: 'spki',  format: 'der' }).subarray(-32)
const privRaw = (ko: KeyObject): Buffer => ko.export({ type: 'pkcs8', format: 'der' }).subarray(-32)

export interface KeystoreData {
  handle: string
  iat: number
  priv: string                    // base64 raw 32B — TEST ONLY (git-ignored)
  pub: string                     // base64 raw 32B
  peers: Record<string, string>   // handle -> base64 raw pub
}

export class Keystore {
  path: string
  data: KeystoreData
  constructor(path: string, data: KeystoreData) {
    this.path = path
    this.data = data
  }

  static create(path: string, handle: string): Keystore {
    const { publicKey, privateKey } = generateKeyPairSync('x25519')
    const ks = new Keystore(path, {
      handle,
      iat: Math.floor(Date.now() / 1000),
      priv: privRaw(privateKey).toString('base64'),
      pub:  pubRaw(publicKey).toString('base64'),
      peers: {},
    })
    ks.save()
    return ks
  }

  static load(path: string): Keystore { return new Keystore(path, JSON.parse(readFileSync(path, 'utf8'))) }
  static exists(path: string): boolean { return existsSync(path) }
  save(): void { writeFileSync(this.path, JSON.stringify(this.data, null, 2) + '\n') }

  ownPubB64(): string { return this.data.pub }
  descrSelf(): string { return buildSelfDescr(this.data.handle) }

  addPeer(handle: string, pubB64: string): void {
    // validate it parses as an X25519 point before storing
    rawToPub(Buffer.from(pubB64, 'base64'))
    this.data.peers[handle] = pubB64
    this.save()
  }

  /** ss = ECDH(own_priv, peer_pub) — identical value to what the peer's HEM computes. */
  sharedSecret(peerHandle: string): Buffer {
    const peerB64 = this.data.peers[peerHandle]
    if (!peerB64) throw new Error(`unknown peer: ${peerHandle} (add-peer first)`)
    return diffieHellman({
      privateKey: rawToPriv(Buffer.from(this.data.priv, 'base64')),
      publicKey:  rawToPub(Buffer.from(peerB64, 'base64')),
    })
  }
}
