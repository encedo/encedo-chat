/**
 * relay-flood.ts — how much of a connection flood does the front door absorb?
 *
 *   node net/relay-flood.ts hold  [max] [rate]   # open N raw WSS, hold them
 *   node net/relay-flood.ts churn [seconds] [conc]  # open+close as fast as possible
 *
 * This is the DDoS question, not the "how many chat users" question. A flood
 * hits nginx (a full TLS handshake per attempt) and the relay's accept path
 * BEFORE libp2p's connection cap is even consulted, so it is measurable now,
 * from outside, without touching the relay's config.
 *
 * The clients are RAW WebSockets — no Noise, no yamux, no libp2p state — which
 * is both what an attacker actually sends (they do not complete a handshake) and
 * light enough to throw thousands from one machine. What is measured is how many
 * the server accepts, how fast, and whether the failures are refusals or resets.
 *
 * Blind spot, stated up front: with no SSH to the box, the VPS's own CPU / RAM /
 * fd are invisible. Everything here is client-side — established count, latency,
 * failure reasons — plus the honest service test (`--probe`): a REAL libp2p meet
 * run during the flood. If a legitimate pair can still find each other, the
 * relay is not down; when they cannot, that is the ceiling.
 */

import { memoryUsage } from 'node:process'

const URL = process.env.FLOOD_URL ?? 'wss://bs1.onchato.com/relay'
const MODE = process.argv[2] ?? 'hold'
const rss = () => Math.round(memoryUsage().rss / 1024 / 1024)
const now = () => Date.now()
const pct = (xs: number[], p: number) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(xs.length * p))] : NaN)

/** Open one raw WSS; resolve with how it went. Never throws. */
function openOne(timeoutMs = 15_000): Promise<{ ok: boolean; ms: number; ws?: WebSocket; why?: string }> {
  return new Promise((resolve) => {
    const t0 = now()
    let done = false
    let ws: WebSocket
    const finish = (r: { ok: boolean; ms: number; ws?: WebSocket; why?: string }) => { if (!done) { done = true; resolve(r) } }
    try { ws = new WebSocket(URL) } catch (e: any) { return finish({ ok: false, ms: 0, why: `ctor: ${e?.message ?? e}` }) }
    const timer = setTimeout(() => { try { ws.close() } catch {} ; finish({ ok: false, ms: now() - t0, why: 'open-timeout' }) }, timeoutMs)
    ws.onopen = () => { clearTimeout(timer); finish({ ok: true, ms: now() - t0, ws }) }
    ws.onerror = (e: any) => { clearTimeout(timer); finish({ ok: false, ms: now() - t0, why: (e?.message ?? 'error').slice(0, 40) }) }
    ws.onclose = (e: any) => { clearTimeout(timer); if (!done) finish({ ok: false, ms: now() - t0, why: `closed ${e?.code ?? '?'}` }) }
  })
}

/** A real libp2p meeting, timed, run to prove whether the relay still serves. */
async function serviceProbe(): Promise<string> {
  try {
    const { createPeer, dial } = await import('./peer.ts')
    const { onchatoRelay } = await import('./onchato.ts')
    const { joinChat } = await import('../lib/room.ts')
    const { announceMacKey, topicFromSecret } = await import('../lib/rendezvous.ts')
    const { generateX25519 } = await import('../lib/x25519.ts')
    const relay = (await onchatoRelay()).multiaddr
    const [ikA, ikB] = [await generateX25519(), await generateX25519()]
    const ss = await ikA.dh(ikB.pub)
    const p = { networkId: `flood-probe-${process.pid}`, dateUTC: new Date().toISOString().slice(0, 10) }
    const topic = await topicFromSecret(ss, p)
    const macKey = await announceMacKey(ss, p)
    const t0 = now()
    const nA = await createPeer(); await dial(nA, relay)
    const nB = await createPeer(); await dial(nB, relay)
    const A = joinChat(nA, topic, { macKey }, {})
    const B = joinChat(nB, topic, { macKey }, {})
    const met = await new Promise<boolean>((res) => {
      const iv = setInterval(() => { if (A.who().length && B.who().length) { clearInterval(iv); res(true) } }, 50)
      setTimeout(() => { clearInterval(iv); res(false) }, 25_000)
    })
    const ms = now() - t0
    A.stop(); B.stop(); await nA.stop(); await nB.stop()
    return met ? `✔ a real pair met in ${ms} ms (relay still serving)` : `✖ a real pair could NOT meet within 25 s (relay degraded)`
  } catch (e: any) { return `✖ probe failed: ${e?.message ?? e}` }
}

async function hold() {
  const MAX = Number(process.argv[3] ?? 4000)
  const RATE = Number(process.argv[4] ?? 400) // new connections attempted per second
  const PROBE = process.argv.includes('--probe')
  const open: WebSocket[] = []
  const latencies: number[] = []
  const fails = new Map<string, number>()
  let attempted = 0
  console.log(`flood/hold — ${URL}`)
  console.log(`ramp to ${MAX} held connections at ~${RATE}/s${PROBE ? ', with a live service probe each step' : ''}\n`)
  console.log('attempted  open  failed   openMs p50/p95   myRSS   note')

  const gap = 1000 / RATE
  let stop = false
  while (attempted < MAX && !stop) {
    const batch = Math.max(1, Math.round(RATE / 10)) // ~10 reporting slices per second of dialing
    await Promise.all(Array.from({ length: batch }, async () => {
      attempted++
      const r = await openOne()
      if (r.ok && r.ws) { open.push(r.ws); latencies.push(r.ms) }
      else fails.set(r.why ?? '?', (fails.get(r.why ?? '?') ?? 0) + 1)
    }))
    await new Promise((r) => setTimeout(r, gap * batch))

    if (attempted % Math.max(batch, Math.round(RATE / 2)) < batch || attempted >= MAX) {
      const liveNow = open.filter((w) => w.readyState === 1).length
      const failed = attempted - open.length
      const recent = latencies.slice(-200)
      let note = ''
      // If a big fraction is failing, the server is refusing — the interesting
      // number is where that began, so record it and ease off.
      if (failed > 50 && failed > attempted * 0.15) { note = '← refusing'; stop = true }
      console.log(
        `${String(attempted).padStart(9)}${String(liveNow).padStart(6)}${String(failed).padStart(8)}`
        + `${(Math.round(pct(recent, 0.5)) + '/' + Math.round(pct(recent, 0.95))).padStart(15)}`
        + `${(rss() + 'M').padStart(8)}   ${note}`,
      )
      if (PROBE && (attempted % (RATE * 2) < batch || stop)) console.log('   probe: ' + (await serviceProbe()))
      if (rss() > 3500) { console.log('   (stopping — THIS machine is the bottleneck, not the relay)'); break }
    }
  }

  const live = open.filter((w) => w.readyState === 1).length
  console.log(`\npeak: ${live} sockets held open (of ${attempted} attempted)`)
  if (fails.size) for (const [why, n] of [...fails.entries()].sort((a, b) => b[1] - a[1])) console.log(`  ✖ ${n}× ${why}`)
  console.log('\nfinal service probe: ' + (await serviceProbe()))
  console.log('holding 8s, then releasing…')
  await new Promise((r) => setTimeout(r, 8_000))
  for (const w of open) { try { w.close() } catch {} }
}

async function churn() {
  const SECONDS = Number(process.argv[3] ?? 20)
  const CONC = Number(process.argv[4] ?? 200) // how many open-and-close in flight at once
  console.log(`flood/churn — ${URL}`)
  console.log(`open+close as fast as possible for ${SECONDS}s, ${CONC} in flight\n`)
  let opened = 0, failed = 0
  const lat: number[] = []
  const fails = new Map<string, number>()
  const deadline = now() + SECONDS * 1000
  const worker = async () => {
    while (now() < deadline) {
      const r = await openOne(10_000)
      if (r.ok && r.ws) { opened++; lat.push(r.ms); try { r.ws.close() } catch {} }
      else { failed++; fails.set(r.why ?? '?', (fails.get(r.why ?? '?') ?? 0) + 1) }
    }
  }
  const t0 = now()
  await Promise.all(Array.from({ length: CONC }, worker))
  const secs = (now() - t0) / 1000
  console.log(`completed ${opened} full connect+close in ${secs.toFixed(1)}s → ${Math.round(opened / secs)}/s sustained`)
  console.log(`failures: ${failed}   connect latency p50/p95: ${Math.round(pct(lat, 0.5))}/${Math.round(pct(lat, 0.95))} ms`)
  if (fails.size) for (const [why, n] of [...fails.entries()].sort((a, b) => b[1] - a[1])) console.log(`  ✖ ${n}× ${why}`)
  console.log('\nservice probe after the churn: ' + (await serviceProbe()))
}

if (MODE === 'hold') await hold()
else if (MODE === 'churn') await churn()
else { console.error('usage: relay-flood.ts <hold|churn> …'); process.exit(2) }
console.log('\ndone')
process.exit(0)
