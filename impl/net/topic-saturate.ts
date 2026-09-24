/**
 * topic-saturate.ts — many clients, many topics, all HELD: what does a relay
 * pay per topic, and where does it start refusing?
 *
 *   RELAY=/ip4/127.0.0.1/tcp/9911/ws/p2p/<id> node net/topic-saturate.ts [clients] [topics/client] [hold s] [per second]
 *   default: 50 clients x 4 topics, held 60 s, 5 clients/s
 *
 * The connection cap was never the one that binds -- topics are (~4 per real
 * client, one per contact), and a topic refused past the cap is refused in
 * SILENCE. So this is the static topic counterpart of relay-saturate.ts: each
 * synthetic client dials once, subscribes its share of DISTINCT topics, and
 * stays. What is counted, from the client's own side, is how many of those
 * topics the relay actually joined: with `--leaf-announce` the relay tells a
 * client about exactly the topics it holds, so `getSubscribers(t)` naming the
 * relay is the acceptance signal, and an empty answer after the settle time is
 * a refusal (or the relay being too slow, which at these sizes is the same
 * operational fact).
 *
 * Read the relay's `[stats]` lines alongside: run it with `--stats 0.25` for a
 * line every 15 s, and rss/heap against the topic count is the number the
 * `--max-topics` decision needs. This process's RSS is printed too, because at
 * a few hundred libp2p nodes the laptop is a suspect.
 */
import { multiaddr } from '@multiformats/multiaddr'
import { randomBytes } from 'node:crypto'
import { memoryUsage } from 'node:process'
import { createPeer } from './peer.ts'

const RELAY = process.env.RELAY
if (!RELAY) { console.error('RELAY=<multiaddr> is required'); process.exit(2) }
const CLIENTS = Number(process.argv[2] ?? 50)
const PER = Number(process.argv[3] ?? 4)
const HOLD_S = Number(process.argv[4] ?? 60)
const RATE = Number(process.argv[5] ?? 5)
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const mb = (b: number) => (b / 1e6).toFixed(0) + ' MB'

const ma = multiaddr(RELAY)
const relayId = RELAY.split('/p2p/')[1]
const t0 = Date.now()
const clients: Array<{ node: any; topics: string[] }> = []
let dialFail = 0

console.log(`${CLIENTS} clients x ${PER} topics = ${CLIENTS * PER} topics, ${RATE}/s, held ${HOLD_S} s -> ${RELAY.slice(0, 60)}...`)
for (let i = 0; i < CLIENTS; i++) {
  const node = await createPeer()
  try { await node.dial(ma) } catch (e: any) { dialFail++; await node.stop().catch(() => {}); continue }
  const topics = Array.from({ length: PER }, () => 'sat-' + randomBytes(16).toString('hex'))
  for (const t of topics) node.services.pubsub.subscribe(t)
  clients.push({ node, topics })
  if ((i + 1) % 25 === 0) console.log(`  ${i + 1} clients up, ${(Date.now() - t0) / 1000 | 0} s, this process rss ${mb(memoryUsage().rss)}`)
  await sleep(1000 / RATE)
}
console.log(`dialled ${clients.length}, dial failures ${dialFail}; settling 10 s`)
await sleep(10_000)

const count = () => {
  let accepted = 0, refused = 0
  for (const c of clients) for (const t of c.topics) {
    const subs = c.node.services.pubsub.getSubscribers(t).map((p: any) => p.toString())
    if (subs.includes(relayId)) accepted++; else refused++
  }
  return { accepted, refused }
}
const first = count()
console.log(`after settle: relay joined ${first.accepted} topics, silent on ${first.refused} (${(100 * first.refused / Math.max(1, first.accepted + first.refused)).toFixed(0)}%)`)

// Hold, and see whether what was accepted stays accepted (eviction, prune).
const step = Math.max(10, Math.min(30, HOLD_S / 4))
for (let held = 0; held < HOLD_S; held += step) {
  await sleep(step * 1000)
  const now = count()
  const alive = clients.filter((c) => c.node.getConnections().length > 0).length
  console.log(`  held ${held + step} s: joined ${now.accepted}, silent ${now.refused}, clients still connected ${alive}/${clients.length}, this process rss ${mb(memoryUsage().rss)}`)
}
const last = count()
console.log(`\nWYNIK: ${clients.length} clients, ${clients.length * PER} topics asked, ${last.accepted} carried at the end, ${last.refused} not`)
console.log(last.refused === 0 ? 'wszystko przyjete' : `ODMOWY: ${last.refused} (limit tematow albo limit na peera -- sprawdz [stats] REFUSED i banner przekaznika)`)
await Promise.all(clients.map((c) => c.node.stop().catch(() => {})))
process.exit(0)
