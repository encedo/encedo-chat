import { multiaddr } from '@multiformats/multiaddr'
import { createPeer } from './peer.ts'
const RELAY = '/ip4/127.0.0.1/tcp/9099/ws/p2p/12D3KooWFUsLeqmXf92ZWvfrgferuLwUCJ6L1RnCje5n2wNDgYDy'
const n = await createPeer()
await n.dial(multiaddr(RELAY))
const routed = async (t: string) => { n.services.pubsub.subscribe(t); await new Promise(r => setTimeout(r, 1200)); const ok = n.services.pubsub.getSubscribers(t).length > 0; n.services.pubsub.unsubscribe(t); return ok }
console.log('cap=3, ttl=6s — filling the cap:')
for (const t of ['room-1', 'room-2', 'room-3']) console.log(`  ${t}: routed=${await routed(t)}`)
console.log(`  room-4 (over the cap): routed=${await routed('room-4')}   <- must be false`)
console.log('waiting 9s for the idle sweep…')
await new Promise(r => setTimeout(r, 9000))
console.log(`  room-5 (after eviction): routed=${await routed('room-5')}   <- must be true`)
process.exit(0)
