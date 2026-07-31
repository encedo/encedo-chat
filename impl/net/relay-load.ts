/**
 * relay-load.ts — how many clients does the onchato relay actually carry?
 *
 *   node net/relay-load.ts [pairs...]        # default: 5 10 20 40
 *   node net/relay-load.ts 5 10 20 40 80
 *
 * Synthetic clients in waves. Every wave is a fresh set of PAIRS: two peers,
 * their own derived topic, a real EH-2 handshake and a message each way — the
 * same work a real conversation does, so the numbers mean something.
 *
 * What it measures, per wave: how long the relay takes to accept a dial, how
 * long two peers need to find each other on a fresh topic, how long the
 * handshake takes, and whether the round trip completes at all.
 *
 * It also measures THIS machine (RSS, and how much of the wall clock the process
 * spent on CPU). Without that, a slow wave is unattributable: a laptop running
 * eighty libp2p nodes in one process saturates long before a server does, and
 * reporting that as "the relay fell over" would be wrong.
 *
 * Each wave is torn down completely before the next one starts, so the relay
 * sees arrivals and departures rather than a monotonic climb.
 */

import { createPeer, dial } from './peer.ts'
import { onchatoRelay } from './onchato.ts'
import { joinChat } from '../lib/room.ts'
import { announceMacKey, topicFromSecret } from '../lib/rendezvous.ts'
import { generateX25519 } from '../lib/x25519.ts'
import { memoryUsage, cpuUsage } from 'node:process'

const WAVES = process.argv.slice(2).map(Number).filter((n) => n > 0)
const PLAN = WAVES.length ? WAVES : [5, 10, 20, 40]
const RELAY = process.env.RELAY ?? (await onchatoRelay()).multiaddr
/** Give up on one pair after this long; a wave is not held up by a straggler. */
const PAIR_TIMEOUT_MS = 60_000
/**
 * Spread the starts within a wave. A relay behind a reverse proxy sees every
 * client as one host, so libp2p's per-host inbound limits apply to the whole
 * network — `STAGGER_MS=700` measures a relay that still has those defaults
 * without simply bouncing off them (see relay/relay.mjs).
 */
const STAGGER_MS = Number(process.env.STAGGER_MS ?? 0)

const pct = (xs: number[], p: number) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(xs.length * p))] : NaN)
const ms = (n: number) => (Number.isFinite(n) ? `${Math.round(n)}` : '—')

const until = async (cond: () => boolean, deadline: number) => {
  while (!cond()) {
    if (Date.now() > deadline) return false
    await new Promise((r) => setTimeout(r, 25))
  }
  return true
}

interface PairResult {
  dialMs: number[]      // one per peer
  discoverMs: number    // both peers see each other
  handshakeMs: number   // both hold a ratchet
  rtMs: number          // a message each way
  ok: boolean
  why?: string
}

async function runPair(day: string, index: number): Promise<{ result: PairResult; stop: () => Promise<void> }> {
  const started = Date.now()
  const deadline = started + PAIR_TIMEOUT_MS
  const r: PairResult = { dialMs: [], discoverMs: NaN, handshakeMs: NaN, rtMs: NaN, ok: false }
  const [ikA, ikB] = [await generateX25519(), await generateX25519()]
  const ss = await ikA.dh(ikB.pub)
  // A unique network id per pair per run: fresh topics, no collision with the
  // real network, and nothing left behind that a real client would join.
  const p = { networkId: `load-${process.pid}-${index}`, dateUTC: day }
  const topic = await topicFromSecret(ss, p)
  const macKey = await announceMacKey(ss, p)

  const nodes: any[] = []
  const rooms: any[] = []
  const stop = async () => {
    for (const room of rooms) { try { room.stop() } catch {} }
    for (const n of nodes) { try { await n.stop() } catch {} }
  }

  try {
    for (let i = 0; i < 2; i++) {
      const t0 = Date.now()
      const node = await createPeer()
      await dial(node, RELAY)
      r.dialMs.push(Date.now() - t0)
      nodes.push(node)
    }
    const got: string[] = []
    const back: string[] = []
    const eh2 = (ik: any, peerPub: Uint8Array) => ({ ik, peerIkPub: peerPub })
    const A = joinChat(nodes[0], topic, { macKey, eh2: eh2(ikA, ikB.pub) }, { onMessage: (_f, m) => back.push(m.body) })
    const B = joinChat(nodes[1], topic, { macKey, eh2: eh2(ikB, ikA.pub) }, { onMessage: (_f, m) => got.push(m.body) })
    rooms.push(A, B)

    const t1 = Date.now()
    if (!(await until(() => A.who().length > 0 && B.who().length > 0, deadline))) { r.why = 'never discovered each other'; return { result: r, stop } }
    r.discoverMs = Date.now() - t1
    if (!(await until(() => A.secured().length === 1 && B.secured().length === 1, deadline))) { r.why = 'handshake never completed'; return { result: r, stop } }
    r.handshakeMs = Date.now() - t1

    const t2 = Date.now()
    A.sendText(`load-${index}-a`)
    if (!(await until(() => got.length > 0, deadline))) { r.why = 'A→B never arrived'; return { result: r, stop } }
    B.sendText(`load-${index}-b`)
    if (!(await until(() => back.length > 0, deadline))) { r.why = 'B→A never arrived'; return { result: r, stop } }
    r.rtMs = Date.now() - t2
    r.ok = true
    return { result: r, stop }
  } catch (e: any) {
    r.why = e?.message ?? String(e)
    return { result: r, stop }
  }
}

const rssMb = () => Math.round(memoryUsage().rss / 1024 / 1024)
const day = new Date().toISOString().slice(0, 10)

console.log(`relay-load — ${RELAY.slice(0, 48)}…`)
console.log(`waves (pairs): ${PLAN.join(', ')}   timeout ${PAIR_TIMEOUT_MS / 1000}s per pair\n`)
console.log('pairs  clients  ok      dial p50/p95   discover p50/p95   handshake p50/p95   round-trip p50   rss   cpu%')

for (const pairs of PLAN) {
  const cpu0 = cpuUsage()
  const t0 = Date.now()
  const started = await Promise.all(Array.from({ length: pairs }, async (_, i) => {
    if (STAGGER_MS) await new Promise((r) => setTimeout(r, i * STAGGER_MS))
    return runPair(day, i)
  }))
  const results = started.map((s) => s.result)
  const wall = Date.now() - t0
  const cpu1 = cpuUsage(cpu0)
  const cpuPct = Math.round(((cpu1.user + cpu1.system) / 1000 / wall) * 100)

  const ok = results.filter((r) => r.ok)
  const dial = results.flatMap((r) => r.dialMs)
  const disc = ok.map((r) => r.discoverMs)
  const hs = ok.map((r) => r.handshakeMs)
  const rt = ok.map((r) => r.rtMs)
  console.log(
    `${String(pairs).padStart(5)}  ${String(pairs * 2).padStart(7)}  ${String(ok.length).padStart(2)}/${String(pairs).padEnd(4)}`
    + `${(ms(pct(dial, 0.5)) + '/' + ms(pct(dial, 0.95))).padStart(13)}`
    + `${(ms(pct(disc, 0.5)) + '/' + ms(pct(disc, 0.95))).padStart(19)}`
    + `${(ms(pct(hs, 0.5)) + '/' + ms(pct(hs, 0.95))).padStart(20)}`
    + `${ms(pct(rt, 0.5)).padStart(17)}`
    + `${(rssMb() + 'M').padStart(7)}${String(cpuPct).padStart(6)}`,
  )
  for (const bad of results.filter((r) => !r.ok)) console.log(`         ✖ ${bad.why}`)

  for (const s of started) await s.stop()
  await new Promise((r) => setTimeout(r, 3_000)) // let the relay see them leave
}

console.log('\ndone — all waves torn down')
process.exit(0)
