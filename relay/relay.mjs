/**
 * onchato relay — libp2p 2.2.1 GossipSub + circuit-relay-v2 3.1.0.
 *
 * The single rendezvous/transport node (bs1.onchato.com). Transport-only: it
 * forwards encrypted GossipSub frames and grants circuit-relay reservations —
 * it never sees plaintext or keys. Both v5 and v6 clients use it unchanged.
 *
 *   node relay.mjs --pass <secret> --port 9001 [--host bs1.onchato.com] [--peers <ma>...]
 *
 * ⚠️ --pass is the Ed25519 seed → the relay's PeerId. Production MUST keep
 *    --pass bs1.onchato.com so the PeerId stays 12D3KooWP6Sp…cDmp — clients
 *    carry that multiaddr hardcoded; change the pass and every client breaks.
 */

import { createLibp2p } from 'libp2p'
import { webSockets } from '@libp2p/websockets'
import { all } from '@libp2p/websockets/filters'
import { noise } from '@chainsafe/libp2p-noise'
import { yamux } from '@chainsafe/libp2p-yamux'
import { circuitRelayServer } from '@libp2p/circuit-relay-v2'
import { identify } from '@libp2p/identify'
import { gossipsub } from '@chainsafe/libp2p-gossipsub'
import { generateKeyPairFromSeed } from '@libp2p/crypto/keys'
import { peerIdFromPrivateKey } from '@libp2p/peer-id'
import { multiaddr } from '@multiformats/multiaddr'
import { createHash } from 'crypto'

const args = process.argv.slice(2)
const get = (flag, def) => { const i = args.indexOf(flag); return i !== -1 ? args[i + 1] : def }
const getPeers = () => {
  const peers = []
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--peers' && args[i + 1]) {
      for (let j = i + 1; j < args.length && !args[j].startsWith('--'); j++) {
        peers.push(args[j])
      }
    }
  }
  return peers
}

const PASS  = get('--pass', 'default-relay-pass')
const PORT  = parseInt(get('--port', '9001'))
const HOST  = get('--host', null)   // e.g. onchato.com — used to print the production WSS multiaddr
const PEERS = getPeers()

const seed    = createHash('sha256').update(PASS).digest()
const privKey = await generateKeyPairFromSeed('Ed25519', seed)
const peerId  = peerIdFromPrivateKey(privKey)

console.log(`\n🔑 Pass: "${PASS}" → PeerId: ${peerId.toString()}`)

const relay = await createLibp2p({
  privateKey: privKey,
  addresses: { listen: [`/ip4/0.0.0.0/tcp/${PORT}/ws`] },
  transports: [webSockets({ filter: all })],
  connectionEncrypters: [noise()],
  streamMuxers: [yamux()],
  connectionGater: { denyDialMultiaddr: () => false },
  connectionManager: {
    maxConnections: 520  // 512 clients + headroom for inter-relay connections
  },
  services: {
    identify: identify(),
    relay: circuitRelayServer({ reservations: { maxReservations: 256 } }),
    pubsub: gossipsub({
      allowPublishToZeroTopicPeers: true,
      emitSelf: false,
      floodPublish: true,
      D: 8, Dlo: 6, Dhi: 12, Dout: 0,
      maxMessageSize: 65536,  // 64 KB — enough for encrypted text, prevents flood abuse
      historyLength: 2,       // keep last 2 windows (~2 min) instead of default 5
      historyGossip: 1        // advertise only last window in gossip announcements
    })
  }
})

// Hard cap: once MAX_TOPICS distinct topics are live the relay refuses NEW ones
// (rendezvous rooms beyond the cap won't be forwarded). No eviction yet.
// TODO(eviction): make the cap soft — drop a topic when its last subscriber
// unsubscribes (subscription-change), and/or TTL-evict idle topics. Tracked as
// a follow-up; kept as-is here so this move is behaviour-neutral vs the live relay.
const MAX_TOPICS = 50

relay.services.pubsub.addEventListener('subscription-change', (evt) => {
  for (const { topic, subscribe } of evt.detail.subscriptions) {
    if (subscribe && !relay.services.pubsub.getTopics().includes(topic)) {
      if (relay.services.pubsub.getTopics().length >= MAX_TOPICS) {
        console.log(`[!topic] limit reached (${MAX_TOPICS}), ignoring "${topic}"`)
        continue
      }
      relay.services.pubsub.subscribe(topic)
      console.log(`[+topic] "${topic}"`)
    }
  }
})

relay.services.pubsub.addEventListener('message', (evt) => {
  const from = evt.detail.from.toString().slice(0, 12)
  console.log(`[msg:${evt.detail.topic}] ${from}...: ${new TextDecoder().decode(evt.detail.data)}`)
})

relay.addEventListener('peer:connect', (evt) => console.log('[+]', evt.detail.toString().slice(0, 16) + '...'))
relay.addEventListener('peer:disconnect', (evt) => console.log('[-]', evt.detail.toString().slice(0, 16) + '...'))

if (PEERS.length > 0) {
  console.log(`\nŁączę z ${PEERS.length} innymi relay...`)
  for (const addr of PEERS) {
    try {
      await relay.dial(multiaddr(addr))
      console.log(`  ✓ ${addr.slice(0, 60)}`)
    } catch (e) {
      console.log(`  ✗ ${addr.slice(0, 60)} (${e.message})`)
    }
  }
}

console.log(`\n✅ Relay uruchomiony na porcie ${PORT}`)
if (HOST) {
  console.log(`📋 Adres produkcyjny (WSS przez nginx):`)
  console.log(`   /dns4/${HOST}/tcp/443/wss/http-path/%2Frelay/p2p/${peerId.toString()}`)
}
console.log(`📋 Adres lokalny (WS bezpośredni):`)
console.log(`   /ip4/127.0.0.1/tcp/${PORT}/ws/p2p/${peerId.toString()}\n`)
