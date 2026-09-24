/**
 * enum-check.ts — how many topics does a relay announce to a peer that asked
 * for nothing?
 *
 * GossipSub sends its whole subscription list to every peer that connects.
 * With `--leaf-announce` (relay/leaf.mjs) a relay tells a client only about the
 * topics the client itself holds, so a peer that holds nothing must be told
 * NOTHING. This dials, subscribes to nothing, listens, and counts. Measured on
 * bs3 before the change: 13 in 12 s.
 *
 *   node net/enum-check.ts <relay multiaddr>
 *
 * Prints the count; never the ids. Exit 0 when nothing was announced.
 */
import { multiaddr } from '@multiformats/multiaddr'
import { createPeer } from './peer.ts'

const addr = process.argv[2]
if (!addr) { console.error('usage: node net/enum-check.ts <relay multiaddr>'); process.exit(2) }

const p = await createPeer()
const seen = new Set<string>()
p.services.pubsub.addEventListener('subscription-change', (e: any) => {
  for (const s of e.detail.subscriptions) if (s.subscribe) seen.add(s.topic)
})
await p.dial(multiaddr(addr))
await new Promise((r) => setTimeout(r, 12_000))
console.log(`tematow ogloszonych peerowi, ktory o nic nie prosil: ${seen.size}`)
await p.stop()
process.exit(seen.size === 0 ? 0 : 1)
