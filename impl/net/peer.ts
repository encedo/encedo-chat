/**
 * peer.ts — a libp2p node client (Node.js), reusing v5's proven config.
 *
 * Ephemeral PeerId per start (identity is the HEM key, not the transport peer id).
 * The webSockets filter is v5's fix: accept ws/wss multiaddrs including the
 * `http-path` form the onchato relay uses (default filters reject it).
 */

import { createLibp2p } from 'libp2p'
import { webSockets } from '@libp2p/websockets'
import { noise } from '@chainsafe/libp2p-noise'
import { yamux } from '@chainsafe/libp2p-yamux'
import { identify } from '@libp2p/identify'
import { gossipsub } from '@chainsafe/libp2p-gossipsub'
import { multiaddr } from '@multiformats/multiaddr'

// v5 fix: keep any ws/wss multiaddr (incl. /http-path/...) instead of exactMatch.
const wsFilter = (addrs) => addrs.filter((ma) => /\/(wss?)(\/|$)/.test(ma.toString()))

export async function createPeer() {
  const node = await createLibp2p({
    transports: [webSockets({ filter: wsFilter })],
    connectionEncrypters: [noise()],
    streamMuxers: [yamux()],
    connectionGater: { denyDialMultiaddr: () => false },
    services: {
      identify: identify(),
      pubsub: gossipsub({
        allowPublishToZeroTopicPeers: true,
        emitSelf: false,
        floodPublish: true,
        D: 8, Dlo: 6, Dhi: 12, Dout: 0,
      }),
    },
  })
  await node.start()
  return node
}

export function dial(node, addr, opts) {
  // opts forwards libp2p dial options — notably `signal`, so a failover sweep can
  // put a timeout on each candidate and move on instead of stalling on a hung node.
  return node.dial(multiaddr(addr), opts)
}
