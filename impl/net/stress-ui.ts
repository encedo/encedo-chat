/**
 * stress-ui.ts — load ONE relay to a target share of its capacity and hold it
 * there while a person uses the app on the same relay.
 *
 *   RELAY=<multiaddr> node net/stress-ui.ts [--steps 25,50,75,85] [--step-min 3] [--hold-min 10]
 *                                           [--max-conns 520] [--rate 12] [--build 4]
 *
 * The relay's own load figure is max(connections / max-conns, topics /
 * max-topics) (relay/load.mjs); with one topic per pair, connections bind
 * first, so a step of P % means ceil(P/100 * max-conns) - 2 clients (the two
 * mesh links count too). The clients are what the app is since 0.6.25: LIGHT
 * peers (pick/push, net/light.ts), in PAIRS that complete a real EH-2
 * handshake on a topic of their own and then talk -- each side sends `rate`
 * messages a minute, and every message carries its send time, so the
 * receiver measures delivery latency on one clock (same process).
 *
 * The ramp adds pairs at `--build` per second to each step, holds the step for
 * `--step-min`, and holds the last step for `--hold-min`; then everything is
 * torn down and the relay is left to evict the topics on its own. Every 10 s
 * one line: clients up, secured, messages/s sent and received, delivery
 * p50/p95/max, failures. Watch the relay itself on infra/dash.
 *
 * Production needs an nginx exception for the generator's address: a relay
 * allows 20 connections per IP (infra/nginx/relay-node.conf) and this opens
 * hundreds. See the load-test notes in ~/develop/chat/RELAY-DIAG.md.
 */
import { joinChat } from '../lib/room.ts'
import { announceMacKey, topicFromSecret } from '../lib/rendezvous.ts'
import { generateX25519 } from '../lib/x25519.ts'
import { createLightPeer } from './light.ts'
import { dial } from './peer.ts'
import { memoryUsage } from 'node:process'

const args = process.argv.slice(2)
const opt = (n: string, d: string) => { const i = args.indexOf(n); return i >= 0 && args[i + 1] ? args[i + 1] : d }
const RELAY = process.env.RELAY
if (!RELAY) { console.error('RELAY=<multiaddr> is required'); process.exit(2) }
const STEPS = opt('--steps', '25,50,75,85').split(',').map(Number)
const STEP_MS = Number(opt('--step-min', '3')) * 60_000
const HOLD_MS = Number(opt('--hold-min', '10')) * 60_000
const MAX_CONNS = Number(opt('--max-conns', '520'))
const RATE = Number(opt('--rate', '12'))            // messages per minute, per client
const BUILD = Number(opt('--build', '4'))           // pairs brought up per second
const MESH = 2
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

interface Pair { A: any; B: any; nA: any; nB: any; timer?: any }
const pairs: Pair[] = []
let sent = 0, received = 0, failed = 0, lat: number[] = []
let stopping = false

async function makePair(i: number): Promise<Pair> {
  const [ikA, ikB] = [await generateX25519(), await generateX25519()]
  const ss = await ikA.dh(ikB.pub)
  const p = { networkId: `stress-${process.pid}-${i}`, dateUTC: new Date().toISOString().slice(0, 10) }
  const topic = await topicFromSecret(ss, p)
  const macKey = await announceMacKey(ss, p)
  const nA = await createLightPeer(); await dial(nA, RELAY!)
  const nB = await createLightPeer(); await dial(nB, RELAY!)
  const onMessage = (_f: string, m: any) => {
    received++
    const t = Number(String(m.body).split('|')[1])
    if (t) lat.push(Date.now() - t)
  }
  const eh2 = (ik: any, pub: Uint8Array) => ({ ik, peerIkPub: pub })
  const A = joinChat(nA, topic, { macKey, eh2: eh2(ikA, ikB.pub) }, { onMessage })
  const B = joinChat(nB, topic, { macKey, eh2: eh2(ikB, ikA.pub) }, { onMessage })
  const pair: Pair = { A, B, nA, nB }
  // Staggered so the relay sees a steady stream, not bursts on every tick.
  const gap = 60_000 / RATE
  setTimeout(() => {
    pair.timer = setInterval(() => {
      if (stopping) return
      for (const side of [A, B]) {
        if (!side.secured().length) continue
        try { side.sendText(`s${i}|${Date.now()}|${'x'.repeat(120)}`); sent++ } catch { failed++ }
      }
    }, gap)
  }, Math.random() * gap)
  return pair
}

async function growTo(clients: number) {
  const want = Math.ceil(clients / 2)
  while (pairs.length < want && !stopping) {
    const batch = Math.min(BUILD, want - pairs.length)
    const t0 = Date.now()
    const made = await Promise.allSettled(Array.from({ length: batch }, (_, k) => makePair(pairs.length + k)))
    for (const m of made) { if (m.status === 'fulfilled') pairs.push(m.value); else failed++ }
    const left = 1000 - (Date.now() - t0)
    if (left > 0) await sleep(left)
  }
}

const pct = (a: number[], q: number) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(q * s.length))] }
let lastSent = 0, lastRecv = 0, lastT = Date.now()
function report(tag: string) {
  const now = Date.now(), dt = (now - lastT) / 1000
  const secured = pairs.filter((p) => p.A.secured().length && p.B.secured().length).length
  const l = lat; lat = []
  console.log(`[${new Date().toISOString().slice(11, 19)}] ${tag.padEnd(10)} clients ${String(pairs.length * 2).padStart(4)} (~${Math.ceil(((pairs.length * 2 + MESH) / MAX_CONNS) * 100)}%)`
    + ` secured ${secured}/${pairs.length} pairs | sent ${((sent - lastSent) / dt).toFixed(1)}/s recv ${((received - lastRecv) / dt).toFixed(1)}/s`
    + ` | latency p50 ${pct(l, 0.5) ?? '-'} p95 ${pct(l, 0.95) ?? '-'} max ${l.length ? Math.max(...l) : '-'} ms | failed ${failed} | rss ${Math.round(memoryUsage().rss / 1e6)} MB`)
  lastSent = sent; lastRecv = received; lastT = now
}

let tag = 'start'
const reporter = setInterval(() => report(tag), 10_000)
async function shutdown(code = 0) {
  if (stopping) return
  stopping = true; tag = 'teardown'
  clearInterval(reporter)
  console.log(`\ntearing down ${pairs.length * 2} clients...`)
  for (const p of pairs) { clearInterval(p.timer); try { p.A.stop(); p.B.stop() } catch {} }
  await Promise.allSettled(pairs.flatMap((p) => [p.nA.stop(), p.nB.stop()]))
  console.log(`done: sent ${sent}, received ${received}, failed ${failed}`)
  process.exit(code)
}
process.on('SIGINT', () => void shutdown(130))
process.on('SIGTERM', () => void shutdown(143))

console.log(`stress-ui -> ${RELAY.slice(0, 60)}...`)
console.log(`steps ${STEPS.join(' -> ')} % of ${MAX_CONNS} connections, ${STEP_MS / 60_000} min each, last held ${HOLD_MS / 60_000} min; ${RATE} msg/min per client\n`)
for (const [k, p] of STEPS.entries()) {
  tag = `ramp ${p}%`
  const clients = Math.max(2, Math.ceil((p / 100) * MAX_CONNS) - MESH)
  await growTo(clients)
  tag = k === STEPS.length - 1 ? `HOLD ${p}%` : `step ${p}%`
  report(tag)
  await sleep(k === STEPS.length - 1 ? HOLD_MS : STEP_MS)
}
await shutdown(0)
