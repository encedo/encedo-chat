/**
 * load-test.ts — does a client connected to ONE relay learn about the others?
 *
 * That is the whole claim behind announcing load on the mesh instead of serving
 * a file per node over HTTP (`relay/load.mjs` has the reasoning). The pure
 * parts — the saturation arithmetic, the encoding, dropping stale readings —
 * are unit-tested in `relay/load.test.mjs`. What cannot be tested there is the
 * wiring: whether the announcement actually crosses between relays and reaches
 * somebody attached to just one of them.
 *
 *   node net/load-test.ts /ip4/127.0.0.1/tcp/9911/ws/p2p/<A>
 *
 * Exit 0 when at least two different nodes were heard through one connection.
 */
import { multiaddr } from '@multiformats/multiaddr'
import { createPeer } from './peer.ts'
import { LOAD_TOPIC, decodeLoad, freshest, ANNOUNCE_MS } from '../../relay/load.mjs'

const addr = process.argv[2]
if (!addr) {
  console.error('usage: node net/load-test.ts <relay multiaddr>')
  process.exit(2)
}

const peer = await createPeer()
await peer.dial(multiaddr(addr))

const heard: any[] = []
peer.services.pubsub.addEventListener('message', (e: any) => {
  if (e.detail.topic !== LOAD_TOPIC) return
  const r = decodeLoad(e.detail.data)
  if (r) heard.push(r)
})
peer.services.pubsub.subscribe(LOAD_TOPIC)

// Long enough for more than one announcement round, so a single early reading
// cannot pass for "it works".
const WAIT = ANNOUNCE_MS + 15_000
console.log(`podlaczony do JEDNEGO wezla, slucham ${WAIT / 1000}s na temacie ${LOAD_TOPIC.slice(0, 12)}...`)
await new Promise((r) => setTimeout(r, WAIT))

const seen = freshest(heard)
const list = [...seen.values()].map((r) => `${r.node}=${r.pct}%`).join('  ')
console.log(`uslyszane: ${list || '(nic)'}`)
console.log(seen.size >= 2
  ? `PRZESZLO — ${seen.size} wezly przez jedno polaczenie`
  : `NIE PRZESZLO — tylko ${seen.size}; obciazenie nie przechodzi przez siatke`)

await peer.stop()
process.exit(seen.size >= 2 ? 0 : 1)
