/**
 * relay-saturate.ts — how many clients can the relay hold AT ONCE?
 *
 *   node net/relay-saturate.ts [max] [per-second]     # default: 600 clients, 4/s
 *   RELAY=/ip4/… node net/relay-saturate.ts 200 20
 *
 * The static counterpart to `relay-load.ts`. That one asks "what happens when
 * everyone calls at the same moment"; this one asks "how many can be on the line
 * together", and deliberately arrives slowly so that arrival-rate limits are not
 * what is being measured. Connections are opened and HELD.
 *
 * Two numbers are worth having and only one is obvious: how many connections the
 * relay accepts, and how many are still up a while later. A relay can accept far
 * past its budget and then prune — silently, from the client's point of view —
 * so the run holds everything at the end and counts again.
 *
 * It also reports this machine's RSS, because at some point the honest answer to
 * "what broke" is "the laptop running six hundred libp2p nodes in one process".
 */

import { createPeer, dial } from './peer.ts'
import { onchatoRelay } from './onchato.ts'
import { memoryUsage } from 'node:process'

const MAX = Number(process.argv[2] ?? 600)
const PER_SEC = Number(process.argv[3] ?? 4)
const RELAY = process.env.RELAY ?? (await onchatoRelay()).multiaddr
const HOLD_MS = Number(process.env.HOLD_MS ?? 30_000)

const rssMb = () => Math.round(memoryUsage().rss / 1024 / 1024)
const nodes: any[] = []
const failures = new Map<string, number>()
let refused = 0

console.log(`relay-saturate — ${RELAY.slice(0, 52)}…`)
console.log(`target ${MAX} clients at ${PER_SEC}/s, then hold ${HOLD_MS / 1000}s\n`)
console.log('opened  live  refused   rss    elapsed')

const t0 = Date.now()
const gap = 1000 / PER_SEC
for (let i = 0; i < MAX; i++) {
  try {
    const node = await createPeer()
    await dial(node, RELAY)
    nodes.push(node)
  } catch (e: any) {
    refused++
    const why = `${e?.constructor?.name}: ${e?.message}`.slice(0, 70)
    failures.set(why, (failures.get(why) ?? 0) + 1)
  }
  if ((i + 1) % 25 === 0 || i === MAX - 1) {
    const live = nodes.filter((n) => n.getConnections().length > 0).length
    console.log(
      `${String(i + 1).padStart(6)}${String(live).padStart(6)}${String(refused).padStart(9)}`
      + `${(rssMb() + 'M').padStart(7)}${(Math.round((Date.now() - t0) / 1000) + 's').padStart(11)}`,
    )
    // Stop early once the relay is clearly refusing everything: the interesting
    // number is where it stopped, not how long we can keep being told no.
    if (refused > 30 && live < nodes.length * 0.9) { console.log('\n(relay is refusing steadily — stopping the ramp here)'); break }
  }
  await new Promise((r) => setTimeout(r, gap))
}

const peak = nodes.filter((n) => n.getConnections().length > 0).length
console.log(`\npeak live connections: ${peak} (of ${nodes.length} opened, ${refused} refused)`)
if (failures.size) for (const [why, n] of failures) console.log(`  ✖ ${n}× ${why}`)

console.log(`holding ${HOLD_MS / 1000}s to see whether the relay prunes…`)
await new Promise((r) => setTimeout(r, HOLD_MS))
const held = nodes.filter((n) => n.getConnections().length > 0).length
console.log(`still live after the hold: ${held}${held < peak ? `  (${peak - held} were dropped)` : '  (none dropped)'}`)

for (const n of nodes) { try { await n.stop() } catch {} }
console.log('done — all clients disconnected')
process.exit(0)
