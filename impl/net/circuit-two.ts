/**
 * circuit-two.ts — circuit-relay data-plane test with A and B in SEPARATE processes
 * (rules out a same-process artifact in circuit-probe.ts).
 *   PROBE_RELAY=<relay multiaddr> node net/circuit-two.ts listen
 *   PROBE_RELAY=<relay multiaddr> node net/circuit-two.ts dial <peerId>
 */

import { createLibp2p } from 'libp2p'
import { webSockets } from '@libp2p/websockets'
import { noise } from '@chainsafe/libp2p-noise'
import { yamux } from '@chainsafe/libp2p-yamux'
import { identify } from '@libp2p/identify'
import { circuitRelayTransport } from '@libp2p/circuit-relay-v2'
import { multiaddr } from '@multiformats/multiaddr'

process.on('unhandledRejection', (e: any) => console.log('unhandledRejection:', e?.message ?? e))

const PROTO = '/encedo-chat/probe/1.0.0'
const wsFilter = (addrs) => addrs.filter((ma) => { const s = ma.toString(); return /\/(wss?)(\/|$)/.test(s) && !s.includes('/p2p-circuit') })
const RELAY = process.env.PROBE_RELAY!
const relayId = multiaddr(RELAY).getPeerId()!

async function mkNode() {
  const node = await createLibp2p({
    addresses: { listen: ['/p2p-circuit'] },
    transports: [webSockets({ filter: wsFilter }), circuitRelayTransport()],
    connectionEncrypters: [noise()],
    streamMuxers: [yamux()],
    connectionGater: { denyDialMultiaddr: () => false },
    services: { identify: identify() },
  })
  await node.start()
  await node.dial(multiaddr(RELAY))
  return node
}
async function waitCircuit(node, ms = 25_000) {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) {
    if (node.getMultiaddrs().map(String).some((a) => a.includes('/p2p-circuit'))) return true
    await new Promise((r) => setTimeout(r, 400))
  }
  return false
}

const role = process.argv[2]
const node = await mkNode()
const ok = await waitCircuit(node)
console.log(`node ${node.peerId.toString().slice(0, 12)}… reservation=${ok}`)

if (role === 'listen') {
  await node.handle(PROTO, async ({ stream }) => {
    for await (const chunk of stream.source) { console.log('LISTEN_GOT ' + new TextDecoder().decode(chunk.subarray())); break }
  })
  console.log('LISTEN_PEERID=' + node.peerId.toString())
} else if (role === 'dial') {
  const target = process.argv[3]
  const addr = multiaddr(`/p2p/${relayId}/p2p-circuit/p2p/${target}`)
  console.log('dialing', addr.toString())
  try {
    const stream = await node.dialProtocol(addr, PROTO)
    await stream.sink([new TextEncoder().encode('hello-two-proc')])
    console.log('DIAL_OK — sent')
    await new Promise((r) => setTimeout(r, 1500))
    console.log('PASS')
  } catch (e: any) { console.log('DIAL_FAIL', e?.message ?? e) }
  await node.stop(); process.exit(0)
}
