/**
 * circuit-probe.ts — does the onchato relay allow circuit-relay-v2 HOP/reservations?
 *
 * GossipSub-flooding (what meet.ts/chat-test.ts already prove) circuit HOP. The
 * §13 data plane needs peers to open a DIRECT stream to each other, tunneled
 * through the relay as a blind byte-forwarder. This probes exactly that: two
 * peers reserve on the relay; one opens a /p2p-circuit stream to the other and
 * sends a byte. PASS the direct-stream data plane is viable via onchato.
 *   node net/circuit-probe.ts
 */

import { createLibp2p } from 'libp2p'
import { webSockets } from '@libp2p/websockets'
import { noise } from '@chainsafe/libp2p-noise'
import { yamux } from '@chainsafe/libp2p-yamux'
import { identify } from '@libp2p/identify'
import { circuitRelayTransport } from '@libp2p/circuit-relay-v2'
import { multiaddr } from '@multiformats/multiaddr'
import { onchatoRelay } from './onchato.ts'

process.on('unhandledRejection', (e: any) => console.log('  unhandledRejection:', e?.message ?? e))

const PROTO = '/onchato/probe/1.0.0'
// keep ws/wss (incl. /http-path/...) but NOT /p2p-circuit — those go to the circuit transport
const wsFilter = (addrs) => addrs.filter((ma) => { const s = ma.toString(); return /\/(wss?)(\/|$)/.test(s) && !s.includes('/p2p-circuit') })

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
  return node
}

async function waitCircuitAddr(node, ms = 25_000) {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) {
    const addr = node.getMultiaddrs().map(String).find((a) => a.includes('/p2p-circuit'))
    if (addr) return addr
    await new Promise((r) => setTimeout(r, 500))
  }
  return null
}

// PROBE_RELAY env overrides onchato with a local relay addr (for verifying a relay fix)
const relayEnv = process.env.PROBE_RELAY
const { multiaddr: relay, peerId: relayId } = relayEnv
  ? { multiaddr: relayEnv, peerId: multiaddr(relayEnv).getPeerId()! }
  : await onchatoRelay()
const na = await mkNode()
const nb = await mkNode()

await Promise.all([na.dial(multiaddr(relay)), nb.dial(multiaddr(relay))])
console.log(`both dialed relay; A=${na.peerId.toString().slice(0, 12)}... B=${nb.peerId.toString().slice(0, 12)}...`)
console.log('waiting for B reservation on the relay...')

const bCircuit = await waitCircuitAddr(nb)
if (!bCircuit) {
  console.log('FAIL — B got no /p2p-circuit reservation (relay HOP disabled or not permitted)')
  await Promise.allSettled([na.stop(), nb.stop()]); process.exit(1)
}
console.log('B reachable via circuit:', bCircuit)

let resolveGot
const got = new Promise((r) => (resolveGot = r))
await nb.handle(PROTO, async ({ stream }) => {
  for await (const chunk of stream.source) { resolveGot(new TextDecoder().decode(chunk.subarray())); break }
})

// dial via the relay's PeerId (A already holds a connection to it) — the relay's
// /http-path/ ws addr is not Circuit.exactMatch-compatible, but /p2p/<relay>/... is
const dialAddr = multiaddr(`/p2p/${relayId}/p2p-circuit/p2p/${nb.peerId.toString()}`)
await new Promise((r) => setTimeout(r, 3000)) // let B's reservation settle
console.log('A dialing B via circuit + opening stream...', dialAddr.toString())
let stream
for (let attempt = 1; attempt <= 3 && !stream; attempt++) {
  try {
    stream = await na.dialProtocol(dialAddr, PROTO)
    await stream.sink([new TextEncoder().encode('hello-via-circuit')])
  } catch (e: any) {
    console.log(`  [attempt ${attempt}] dial failed:`, e?.message ?? e)
    if (attempt < 3) await new Promise((r) => setTimeout(r, 4000))
  }
}

const result = await Promise.race([got, new Promise((r) => setTimeout(() => r(null), 15_000))])
await Promise.allSettled([na.stop(), nb.stop()])

if (result === 'hello-via-circuit') { console.log('PASS — circuit-relay-v2 stream works on onchato:', JSON.stringify(result)); process.exit(0) }
console.log('FAIL — no stream data received:', JSON.stringify(result)); process.exit(1)
