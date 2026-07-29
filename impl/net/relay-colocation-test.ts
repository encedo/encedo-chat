/**
 * relay-colocation-test.ts — reproduce (and verify the fix for) GossipSub
 * graylisting by IP colocation.
 *
 *   node net/relay-colocation-test.ts <relay-multiaddr>
 *
 * Why this exists: the relay looked healthy — connections accepted, meshsub
 * streams open, nothing in the log — while every new client silently failed to
 * form a room. The cause was gossipsub's default peer score: peers sharing an
 * IP are penalised (a sybil signal in a public mesh, an ordinary household or
 * office here), AND a peer whose score is not positive keeps its stats and its
 * IP for retainScore (1 h) after disconnecting. Our clients sit at exactly 0,
 * so an address accumulates slots as people connect and leave — a tester
 * reloading a page a dozen times does it single-handedly. Past the threshold
 * the next arrival is graylisted and its RPCs, subscriptions included, are
 * dropped without a word.
 *
 * The test: churn peers from one IP, then check whether the relay still takes
 * a fresh peer's subscription. Broken relay → NO. Fixed relay → YES.
 */

import { multiaddr } from '@multiformats/multiaddr'
import { createPeer } from './peer.ts'

const RELAY = process.argv[2]
if (!RELAY) {
  console.error('usage: node net/relay-colocation-test.ts <relay-multiaddr>')
  process.exit(2)
}
const CHURN = 14 // default threshold is 10 peers/IP; 14 puts the score past graylist

for (let i = 0; i < CHURN; i++) {
  const n = await createPeer()
  await n.dial(multiaddr(RELAY))
  await new Promise((r) => setTimeout(r, 250))
  await n.stop()
}
console.log(`${CHURN} peers connected and left from this IP`)

const n = await createPeer()
await n.dial(multiaddr(RELAY))
const topic = `colocation-probe-${Date.now().toString(36)}`
n.services.pubsub.subscribe(topic)
await new Promise((r) => setTimeout(r, 3000))
const ok = n.services.pubsub.getSubscribers(topic).length > 0
await n.stop()

console.log(ok
  ? 'PASS — the relay still accepts subscriptions from this IP (colocation penalty off)'
  : 'FAIL — the relay ignores this IP: graylisted by the IP-colocation score')
process.exit(ok ? 0 : 1)
