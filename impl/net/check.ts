/**
 * check.ts — live connectivity check against the onchato relay.
 *   node net/check.ts
 */

import { createPeer, dial } from './peer.ts'
import { onchatoRelay } from './onchato.ts'

const { multiaddr: addr, peerId: expected } = await onchatoRelay()
const node = await createPeer()
console.log('my ephemeral PeerId:', node.peerId.toString())
console.log('dialing:', addr)

try {
  const conn = await dial(node, addr)
  const remote = conn.remotePeer.toString()
  console.log('CONNECTED to:', remote)
  console.log('matches expected relay PeerId:', remote === expected ? 'YES [ok]' : `NO [fail] (expected ${expected})`)
} catch (e) {
  console.error('DIAL FAILED:', e?.message ?? e)
} finally {
  await node.stop()
}
