/**
 * onchato relay — libp2p 2.2.1 GossipSub + circuit-relay-v2 3.1.0.
 *
 * The single rendezvous/transport node (bs1.onchato.com). Transport-only: it
 * forwards encrypted GossipSub frames and grants circuit-relay reservations —
 * it never sees plaintext or keys. Both v5 and v6 clients use it unchanged.
 *
 *   node relay.mjs --pass <secret> --port 9001 [--host bs1.onchato.com] [--peers <ma>...]
 *                  [--max-topics 250] [--idle-ttl 120]
 *   DUMP=<dir> node relay.mjs …   — debug/audit: every observable action to JSONL
 *                                  (dump.mjs). NEVER on production.
 *
 * ⚠️ --pass is the Ed25519 seed → the relay's PeerId. Production MUST keep
 *    --pass bs1.onchato.com so the PeerId stays 12D3KooWP6Sp…cDmp — clients
 *    carry that multiaddr hardcoded; change the pass and every client breaks.
 */

import { createLibp2p } from 'libp2p'
import { webSockets } from '@libp2p/websockets'
import { noise } from '@chainsafe/libp2p-noise'
import { yamux } from '@chainsafe/libp2p-yamux'
import { circuitRelayServer } from '@libp2p/circuit-relay-v2'
import { identify } from '@libp2p/identify'
import { gossipsub } from '@chainsafe/libp2p-gossipsub'
import { createPeerScoreParams } from '@chainsafe/libp2p-gossipsub/score'
import { generateKeyPairFromSeed } from '@libp2p/crypto/keys'
import { peerIdFromPrivateKey } from '@libp2p/peer-id'
import { multiaddr } from '@multiformats/multiaddr'
import { createHash } from 'crypto'
import { createDump } from './dump.mjs'

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
// Optional IPv6 listen port for inter-relay peering over a provider's private
// network (where public IPv4 between VMs is blocked but IPv6 routes). Kept on a
// SEPARATE port from PORT so the IPv4 nginx path (0.0.0.0:PORT) is untouched and
// binds cleanly regardless of the host's bindv6only setting (`::` + 0.0.0.0 on the
// SAME port collides when bindv6only=0). Only the dialed node (bs1) needs it.
// --v6-host pins the listen to ONE address (e.g. bs1's public IPv6) so the peer
// port is not also exposed over IPv4-mapped `::`; default `::` = any IPv6.
const V6PORT = get('--v6-port', null)
const V6HOST = get('--v6-host', '::')
// Topic budget. Both are operational knobs, not protocol: raise MAX_TOPICS on a
// busier node, shorten IDLE_TTL only if you are sure it stays well above the
// clients' ~15 s Announce heartbeat (below it, live rooms would be evicted).
const MAX_TOPICS = parseInt(get('--max-topics', '250'))
const IDLE_TTL = parseInt(get('--idle-ttl', '120')) * 1000
// Connection ceiling, a flag so stress tests raise it from ExecStart instead of
// editing this file (a local edit conflicts on every git pull). Default sized for
// 512 clients + inter-relay headroom; a load test passes e.g. --max-connections 50000.
const MAX_CONNS = parseInt(get('--max-connections', '520'))
// DUMP=<dir> → full JSONL trace of everything the relay observes (see dump.mjs).
// Null when unset — every use below is `dump?.…`, so production runs no dump
// code at all. Created BEFORE the node: its X-Real-IP capture wraps
// http.createServer, which libp2p calls when it opens the WebSocket listener.
const dump = createDump(process.env.DUMP)

const seed    = createHash('sha256').update(PASS).digest()
const privKey = await generateKeyPairFromSeed('Ed25519', seed)
const peerId  = peerIdFromPrivateKey(privKey)

console.log(`\n🔑 Pass: "${PASS}" → PeerId: ${peerId.toString()}`)

const relay = await createLibp2p({
  privateKey: privKey,
  // IPv4 on PORT for the nginx path (0.0.0.0 — unchanged, nginx→127.0.0.1:PORT).
  // Optionally ALSO listen on IPv6 on a SEPARATE V6PORT for inter-relay peering
  // over a provider's private network — never on PORT itself (`::` + 0.0.0.0 on
  // one port collides when bindv6only=0). nginx is NOT on this path: a peer dials
  // the raw ws port directly (/ip6/<addr>/tcp/<V6PORT>/ws), bypassing nginx/443.
  addresses: { listen: [`/ip4/0.0.0.0/tcp/${PORT}/ws`, ...(V6PORT ? [`/ip6/${V6HOST}/tcp/${V6PORT}/ws`] : [])] },
  // Keep any ws/wss multiaddr INCLUDING the `/http-path/%2Frelay/` form the
  // production nodes advertise (WSS via nginx). The default `all` filter rejects
  // http-path when DIALING, so `--peers /dns4/bs1…/wss/http-path/…` failed with
  // NoValidAddressesError — the relays never connected and the mesh never bridged.
  // Same fix as the client's net/peer.ts.
  transports: [webSockets({ filter: (addrs) => addrs.filter((ma) => /\/(wss?)(\/|$)/.test(ma.toString())) })],
  connectionEncrypters: [noise()],
  streamMuxers: [yamux()],
  connectionGater: { denyDialMultiaddr: () => false },
  connectionManager: {
    maxConnections: MAX_CONNS,  // default 520 (512 clients + inter-relay headroom); --max-connections for load tests

    // Behind nginx, EVERY client arrives from 127.0.0.1 — so any limit libp2p
    // applies "per host" is really a limit on the whole network. Its defaults
    // are 5 new inbound connections per second per host and 10 in flight at
    // once, which measured out as exactly that: dialing sequentially, 8 of 8
    // clients connect; dialing 8 at once, 3 are refused mid-Noise handshake
    // ("EncryptionFailedError: unexpected end of input" on the client, and no
    // trace at all on the relay). A deploy, or any blip that makes a few dozen
    // clients re-dial together, would have run straight into it.
    //
    // This is the same trap as the GossipSub IP-colocation score (see below):
    // a reverse proxy makes per-IP defences meaningless, and leaving them on
    // punishes the whole userbase for looking like one machine. Rate limiting
    // belongs in nginx, where the real client address is known —
    // `limit_conn`/`limit_req` on the /relay location (see relay/README).
    inboundConnectionThreshold: 500,
    maxIncomingPendingConnections: 128
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
      historyGossip: 1,       // advertise only last window in gossip announcements
      // ⚠️ Turn OFF the IP-colocation penalty. GossipSub's default punishes
      // peers sharing an IP (-5 per peer above 10, squared) because in a public
      // blockchain mesh that pattern means a sybil. Here it means a household,
      // an office or a VPN — normal users. Worse: a peer whose score is not
      // POSITIVE keeps its stats AND its IP for retainScore (1 h) after
      // disconnecting, and our clients sit at exactly 0 (no per-topic score
      // params), so an IP accumulates slots as people come and go. Past ~14
      // clients per hour behind one address the next arrival is graylisted:
      // the relay still accepts the connection and the meshsub streams, then
      // silently ignores its RPCs — subscriptions included. The room simply
      // never forms, with nothing in the log to say why.
      scoreParams: createPeerScoreParams({ IPColocationFactorWeight: 0 })
    })
  }
})

// Soft topic cap. MAX_TOPICS bounds CONCURRENT topics (a DoS guard); abandoned
// topics are EVICTED, so the cap counts LIVE rooms, not every room ever seen.
// Liveness = activity on the topic: clients publish an Announce heartbeat every
// ~15 s, so any room with a live subscriber is refreshed continuously. When all
// clients leave or die the heartbeats stop and the topic is evicted after
// IDLE_TTL — so we never evict a room someone is actually in (no silent kill).
//
// Sizing: a room is one topic and (today) two clients, so the ceiling that
// binds first is maxConnections (520) — 250 topics leaves headroom rather than
// turning "the node is busy" into "new rooms silently do not work".
// Sweep often enough that IDLE_TTL means what it says: with the production
// 120 s TTL a topic goes at 120–150 s, and a short TTL (tests, a busy node)
// does not silently wait a full 30 s sweep.
const SWEEP_MS = Math.max(2_000, Math.min(30_000, Math.floor(IDLE_TTL / 2)))
const lastSeen = new Map() // topic -> last activity (ms); drives eviction

relay.services.pubsub.addEventListener('subscription-change', (evt) => {
  for (const { topic, subscribe } of evt.detail.subscriptions) {
    if (subscribe && !relay.services.pubsub.getTopics().includes(topic)) {
      if (relay.services.pubsub.getTopics().length >= MAX_TOPICS) {
        // The client gets no error for this — it just never sees anyone in the
        // room. Loud in the log, because it looks like "the app is broken".
        console.log(`[!topic] LIMIT ${MAX_TOPICS} reached — REFUSING "${topic}" (raise --max-topics)`)
        dump?.event('topic.refuse', { topic, peer: evt.detail.peerId.toString(), limit: MAX_TOPICS })
        continue
      }
      relay.services.pubsub.subscribe(topic)
      lastSeen.set(topic, Date.now())
      console.log(`[+topic] "${topic}"`)
      dump?.event('topic.add', { topic, peer: evt.detail.peerId.toString() })
    }
  }
})

relay.services.pubsub.addEventListener('message', (evt) => {
  lastSeen.set(evt.detail.topic, Date.now()) // heartbeat announces count → live rooms stay
  // Metadata only. The payload is ciphertext (and with EH-2 it is binary, so
  // decoding it printed garbage anyway) — logging it just parked user metadata
  // in journald for no operational benefit.
  const from = evt.detail.from.toString().slice(0, 12)
  console.log(`[msg:${evt.detail.topic.slice(0, 12)}…] ${from}… ${evt.detail.data.length} B`)
})

// evict abandoned topics: no activity (not even a heartbeat) for IDLE_TTL → all
// clients gone → free the slot so the cap counts live rooms, not historical ones.
setInterval(() => {
  const now = Date.now()
  for (const topic of relay.services.pubsub.getTopics()) {
    if (now - (lastSeen.get(topic) ?? 0) > IDLE_TTL) {
      relay.services.pubsub.unsubscribe(topic)
      lastSeen.delete(topic)
      console.log(`[-topic] evicted "${topic}" (idle > ${IDLE_TTL / 1000}s)`)
      dump?.event('topic.evict', { topic, idle_s: IDLE_TTL / 1000 })
    }
  }
}, SWEEP_MS)

relay.addEventListener('peer:connect', (evt) => console.log('[+]', evt.detail.toString().slice(0, 16) + '...'))
relay.addEventListener('peer:disconnect', (evt) => console.log('[-]', evt.detail.toString().slice(0, 16) + '...'))
// connections, subscriptions, every frame, reservations, start/stop → JSONL
dump?.attach(relay, { flags: args })

// Keep the inter-relay links UP. A one-shot dial is a lottery — it can time out
// ("operation was aborted") or the link can drop later, and with no re-dial the
// mesh silently never forms. So dial each peer, then re-check every 10 s and
// re-dial whenever we are not connected to it.
if (PEERS.length > 0) {
  console.log(`\nŁączę z ${PEERS.length} innymi relay (keep-alive z ponawianiem)...`)
  for (const addr of PEERS) {
    const ma = multiaddr(addr)
    const pid = ma.getPeerId()
    const ensure = async () => {
      if (pid && relay.getConnections().some((c) => c.remotePeer.toString() === pid)) return
      try { await relay.dial(ma); console.log(`  ✓ ${addr.slice(0, 60)}`) }
      catch (e) { console.log(`  ✗ ${addr.slice(0, 50)}… (${e.message}) — ponawiam`) }
    }
    await ensure()
    setInterval(() => { void ensure() }, 10_000)
  }
}

console.log(`\n✅ Relay uruchomiony na porcie ${PORT}`)
// Print the topic budget: it is the setting that decides whether a room forms
// at all, and after a deploy it is the one line that proves which build is up.
console.log(`📦 Tematy: limit ${MAX_TOPICS} równoczesnych, eviction po ${IDLE_TTL / 1000}s ciszy (sweep ${SWEEP_MS / 1000}s)`)
console.log(`🔌 Połączenia: limit ${MAX_CONNS}`)
// Loud on purpose: this line's ABSENCE from the journal is what proves a node
// ran without the dump. Nothing is printed when DUMP is unset.
if (dump) console.log(`🧾 DUMP ON → ${dump.dir}  (events-*.jsonl + payload-*.jsonl, pełne peer id, IP z X-Real-IP — NIE na produkcji)`)
if (HOST) {
  console.log(`📋 Adres produkcyjny (WSS przez nginx):`)
  console.log(`   /dns4/${HOST}/tcp/443/wss/http-path/%2Frelay/p2p/${peerId.toString()}`)
}
console.log(`📋 Adres lokalny (WS bezpośredni):`)
console.log(`   /ip4/127.0.0.1/tcp/${PORT}/ws/p2p/${peerId.toString()}`)
if (V6PORT) {
  console.log(`📋 Adres IPv6 dla peerów (--peers na drugim relay, wstaw ten host IPv6):`)
  console.log(`   /ip6/<ten-host-ipv6>/tcp/${V6PORT}/ws/p2p/${peerId.toString()}`)
}
console.log('')
