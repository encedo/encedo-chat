/**
 * relay-chatload.ts — the relay-carries-content case (WebRTC NOT in use).
 *
 *   RELAY=/ip4/… node net/relay-chatload.ts [pairs] [msg/min per pair] [seconds]
 *
 * The other load tools measure the light path: WebRTC carries content, so the
 * relay only ever sees rendezvous + the EH-2 handshake + presence heartbeats.
 * But WebRTC is not always available (hard NAT, a browser that refuses it, a
 * relay-only deployment), and then EVERY message rides GossipSub through the
 * relay. That is a different cost — bandwidth and per-message CPU, scaling with
 * traffic rather than with connection count.
 *
 * These clients are Node libp2p peers, which never use WebRTC — so they already
 * route content through the relay, exactly the fallback we are pricing. Each
 * pair establishes, then both sides send a message every `60/rate` seconds for
 * `seconds`. Read the relay's CPU / memory / NET with `docker stats` alongside.
 */

import { createPeer, dial } from './peer.ts'
import { onchatoRelay } from './onchato.ts'
import { joinChat } from '../lib/room.ts'
import { announceMacKey, topicFromSecret } from '../lib/rendezvous.ts'
import { generateX25519 } from '../lib/x25519.ts'

const PAIRS = Number(process.argv[2] ?? 20)
const RATE = Number(process.argv[3] ?? 12)     // messages per minute, per peer
const SECONDS = Number(process.argv[4] ?? 40)
const RELAY = process.env.RELAY ?? (await onchatoRelay()).multiaddr
const BODY = 'x'.repeat(180) // a typical short chat line, sealed → ~1 envelope

const nodes: any[] = []
const rooms: any[] = []
let received = 0

async function pair(i: number) {
  const [ikA, ikB] = [await generateX25519(), await generateX25519()]
  const ss = await ikA.dh(ikB.pub)
  const p = { networkId: `chatload-${process.pid}-${i}`, dateUTC: new Date().toISOString().slice(0, 10) }
  const topic = await topicFromSecret(ss, p)
  const macKey = await announceMacKey(ss, p)
  const nA = await createPeer(); await dial(nA, RELAY)
  const nB = await createPeer(); await dial(nB, RELAY)
  nodes.push(nA, nB)
  const eh2 = (ik: any, pub: Uint8Array) => ({ ik, peerIkPub: pub })
  const A = joinChat(nA, topic, { macKey, eh2: eh2(ikA, ikB.pub) }, { onMessage: () => received++ })
  const B = joinChat(nB, topic, { macKey, eh2: eh2(ikB, ikA.pub) }, { onMessage: () => received++ })
  rooms.push(A, B)
  return { A, B }
}

console.log(`relay-chatload — ${RELAY.slice(0, 48)}…`)
console.log(`${PAIRS} pairs, ${RATE} msg/min each way, ${SECONDS}s, content via the relay (no WebRTC)\n`)

const built = []
for (let i = 0; i < PAIRS; i++) built.push(await pair(i))
const until = async (c: () => boolean, ms: number) => { const t0 = Date.now(); while (!c()) { if (Date.now() - t0 > ms) return false; await new Promise((r) => setTimeout(r, 50)) } return true }
const ready = await until(() => rooms.every((r) => r.secured?.().length === 1), 40_000)
console.log(`established: ${rooms.filter((r) => r.secured?.().length === 1).length}/${rooms.length} rooms${ready ? '' : ' (some never handshaked)'}`)

let sent = 0
const gap = 60_000 / RATE
const deadline = Date.now() + SECONDS * 1000
console.log(`\nsending for ${SECONDS}s — watch: docker stats --format '{{.CPUPerc}} {{.MemUsage}} {{.NetIO}}' <relay>\n`)
const t0 = Date.now()
const senders = built.map(({ A, B }, i) => setInterval(() => {
  if (Date.now() > deadline) return
  try { A.sendText(`${i}:${BODY}`); B.sendText(`${i}:${BODY}`); sent += 2 } catch {}
}, gap))
await new Promise((r) => setTimeout(r, SECONDS * 1000 + 1500))
for (const s of senders) clearInterval(s)
const secs = (Date.now() - t0) / 1000
console.log(`sent ${sent} messages (${Math.round(sent / secs)}/s aggregate), received ${received}`)
console.log(`per active conversation: ${(RATE * 2)} msg/min ≈ ${((RATE * 2) / 60).toFixed(1)} msg/s through the relay`)

for (const r of rooms) { try { r.stop() } catch {} }
for (const n of nodes) { try { await n.stop() } catch {} }
console.log('done')
process.exit(0)
