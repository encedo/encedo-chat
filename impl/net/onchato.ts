/**
 * onchato.ts — the operator's live discovery node (bs1.onchato.com).
 *
 * The relay's PeerId is deterministic from its --pass (v5 relay.mjs derivation:
 * sha256(pass) -> Ed25519 seed -> PeerId), so we compute the dialable multiaddr
 * locally — no need to read it off the server. Production --pass is the hostname
 * itself ("bs1.onchato.com", from deploy/relay.service).
 *
 *   node net/onchato.ts     # print the relay's PeerId + WSS multiaddr
 */

import { createHash, createPrivateKey, createPublicKey } from 'node:crypto'
import { privateKeyFromRaw } from '@libp2p/crypto/keys'
import { peerIdFromPrivateKey } from '@libp2p/peer-id'

const PASS = 'bs1.onchato.com'
const HOST = 'bs1.onchato.com'

export async function onchatoRelay() {
  const seed = createHash('sha256').update(PASS).digest()
  // Not generateKeyPairFromSeed: @libp2p/crypto 5.0.x derives the public key
  // from a JWK Node 24.22 refuses (relay/nodekey.mjs). PKCS#8 + the 64 raw bytes.
  const der = Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), seed])
  const pub = Buffer.from(createPublicKey(createPrivateKey({ key: der, format: 'der', type: 'pkcs8' })).export({ format: 'jwk' }).x!, 'base64url')
  const privKey = privateKeyFromRaw(new Uint8Array(Buffer.concat([seed, pub])))
  const peerId = peerIdFromPrivateKey(privKey).toString()
  // Browser/Node dial path: WSS on 443 via nginx, http-path %2Frelay
  const multiaddr = `/dns4/${HOST}/tcp/443/wss/http-path/%2Frelay/p2p/${peerId}`
  return { peerId, multiaddr }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { peerId, multiaddr } = await onchatoRelay()
  console.log('PeerId:   ', peerId)
  console.log('multiaddr:', multiaddr)
}
