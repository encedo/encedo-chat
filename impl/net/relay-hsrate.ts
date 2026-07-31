/**
 * relay-hsrate.ts — how many real libp2p handshakes/s can ONE relay process do?
 *
 *   RELAY=/ip4/127.0.0.1/tcp/9001/ws/p2p/<id> node net/relay-hsrate.ts [seconds] [concurrency]
 *
 * Raw-WS floods measure nginx's TLS; this measures the RELAY itself — a full
 * libp2p connection (WS upgrade + Noise + yamux + identify), the work a real
 * client's arrival costs the relay, churned open+close as fast as possible.
 *
 * The question it answers: a relay is a single Node process. Does giving it a
 * second core raise this number, or is it single-core-bound (→ scale by running
 * more processes / sharding, not by adding vCPU)? Pin the relay with `taskset`
 * to 1 core vs 2 and compare the rate here against the relay's own CPU%.
 */

import { createPeer, dial } from './peer.ts'

const RELAY = process.env.RELAY
if (!RELAY) { console.error('set RELAY=/ip4/…/ws/p2p/<id>'); process.exit(2) }
const SECONDS = Number(process.argv[2] ?? 15)
const CONC = Number(process.argv[3] ?? 24)

let ok = 0, fail = 0
const lat: number[] = []
const deadline = Date.now() + SECONDS * 1000

async function worker() {
  while (Date.now() < deadline) {
    const t0 = Date.now()
    let node: any = null
    try {
      node = await createPeer()
      await dial(node, RELAY)
      ok++
      lat.push(Date.now() - t0)
    } catch { fail++ }
    finally { if (node) { try { await node.stop() } catch {} } }
  }
}

const pct = (xs: number[], p: number) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.floor(xs.length * p)] : NaN)
console.log(`relay-hsrate — ${CONC} concurrent, ${SECONDS}s, full libp2p handshakes`)
const t0 = Date.now()
await Promise.all(Array.from({ length: CONC }, worker))
const secs = (Date.now() - t0) / 1000
console.log(`${ok} handshakes in ${secs.toFixed(1)}s → ${Math.round(ok / secs)}/s   (fail ${fail}, latency p50/p95 ${Math.round(pct(lat, 0.5))}/${Math.round(pct(lat, 0.95))} ms)`)
process.exit(0)
