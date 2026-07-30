/**
 * room-sim.ts — randomized offline simulator for the room + EH-2 handshake.
 *
 *   node net/room-sim.ts [runs] [seed]
 *
 * The live tests answer "does it work on a good day". This answers "does it
 * still work when the network behaves like a network": latency and jitter,
 * loss, duplication, reordering, peers that join at different times, and a
 * peer whose heartbeat goes quiet because the browser throttled its tab.
 *
 * Everything runs against an in-memory pubsub, so a failure is reproducible:
 * every run prints its seed, and the same seed replays the same network.
 * That matters — the two bugs this harness exists to catch (a duplicated msg1
 * restarting the responder, and a presence timeout tearing down a live
 * ratchet) were both invisible on a healthy link and obvious here.
 */

import { joinChat } from '../lib/room.ts'
import { announceMacKey } from '../lib/rendezvous.ts'
import { generateX25519 } from '../lib/x25519.ts'

const RUNS = Number(process.argv[2] ?? 24)
const SEED = Number(process.argv[3] ?? 20260729)
/** Optional profile filter, so a failing run replays the profile it failed on. */
const ONLY = process.argv[4]
/** `LOG=1` narrates both peers — how a failing replay gets diagnosed. */
const LOG = process.env.LOG === '1'

/** mulberry32 — small, seeded, good enough to replay a scenario exactly. */
function rngFrom(seed: number) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

interface NetProfile {
  name: string
  minMs: number
  maxMs: number   // latency range → jitter, and therefore reordering
  lossPct: number
  dupPct: number
  joinGapMs: number // how much later the second peer joins
  quietMs: number   // a window where one peer's Announce is swallowed (throttled tab)
}

const isAnnounce = (d: Uint8Array) => d[0] === 0x7b // '{' — Announce is JSON, content/handshake are binary

/** In-memory GossipSub with a personality. */
function simNet(rng: () => number, p: NetProfile) {
  const nodes = new Map<string, (topic: string, data: Uint8Array, from: string) => void>()
  let quietUntil = 0
  let quietPeer = ''
  const timers: any[] = []
  return {
    silence(peer: string, ms: number) { quietPeer = peer; quietUntil = Date.now() + ms },
    stop() { for (const t of timers) clearTimeout(t) },
    node(id: string) {
      const listeners: Array<(evt: any) => void> = []
      nodes.set(id, (topic, data, from) => {
        for (const h of listeners) h({ detail: { topic, data, from: { toString: () => from } } })
      })
      return {
        peerId: { toString: () => id },
        services: {
          pubsub: {
            addEventListener: (_e: string, h: (evt: any) => void) => listeners.push(h),
            removeEventListener: () => {},
            subscribe: () => {},
            unsubscribe: () => {},
            getSubscribers: () => [...nodes.keys()].filter((k) => k !== id),
            publish: async (topic: string, data: Uint8Array) => {
              // a throttled tab still runs, it just stops being heard from
              if (id === quietPeer && Date.now() < quietUntil && isAnnounce(data)) return
              const copies = rng() * 100 < p.dupPct ? 2 : 1
              for (let c = 0; c < copies; c++) {
                if (rng() * 100 < p.lossPct) continue
                const delay = p.minMs + rng() * (p.maxMs - p.minMs)
                const t = setTimeout(() => {
                  for (const [peer, deliver] of nodes) if (peer !== id) deliver(topic, data, id)
                }, delay)
                ;(t as any).unref?.()
                timers.push(t)
              }
            },
          },
        },
      }
    },
  }
}

const until = async (cond: () => boolean, ms: number) => {
  const t0 = Date.now()
  while (!cond()) {
    if (Date.now() - t0 > ms) return false
    await new Promise((r) => setTimeout(r, 20))
  }
  return true
}

interface Result {
  profile: string; established: boolean; msEstablished: number
  aGot: number; bGot: number; quietOk: boolean
  /** Arrivals that belonged behind something already delivered. */
  reordered: number
  /** …of those, how many the room FAILED to flag. Any is a bug. */
  unflagged: number
  ok: boolean
}

/** Received message, with what the room said about it. */
interface Got { body: string; outOfOrder: boolean }

/**
 * Bodies are `x-0`, `x-1`, `x-2` — sent in that order — so the sender's order is
 * readable from the text. Every arrival that goes backwards must have been
 * flagged; an unflagged one means the receiver silently showed an answer before
 * its question.
 */
function checkOrder(got: Got[]): { reordered: number; unflagged: number } {
  let top = -1, reordered = 0, unflagged = 0
  for (const g of got) {
    const n = Number(g.body.split('-')[1])
    if (!Number.isFinite(n)) continue
    if (n > top) { top = n; continue }
    reordered++
    if (!g.outOfOrder) unflagged++
  }
  return { reordered, unflagged }
}

/**
 * Three promises, judged separately:
 *  - the HANDSHAKE must always complete — it retries, so loss may delay it but
 *    must never leave the pair without a ratchet;
 *  - message DELIVERY now survives loss too: content is confirmed and re-sent
 *    until the peer acks it, so even the 30%-loss profile should get everything
 *    through. (It did not always: this was best-effort until acks existed, and
 *    the sim measured the losses instead of hiding them.)
 *  - ORDER is not promised — jitter and re-sends genuinely shuffle messages —
 *    but honesty about it is: every arrival that belongs behind one already
 *    shown must be FLAGGED, so the UI can put it where it was written. An
 *    unflagged reorder fails the run.
 */

async function runOnce(p: NetProfile, seed: number): Promise<Result> {
  const rng = rngFrom(seed)
  const net = simNet(rng, p)
  const ss = new Uint8Array(32).fill(0x5e)
  const macKey = await announceMacKey(ss, { networkId: 'sim', dateUTC: '2026-07-29' })
  const [ikA, ikB] = [await generateX25519(), await generateX25519()]
  const aGot: Got[] = []
  const bGot: Got[] = []
  const eh2 = (ik: any, peerPub: Uint8Array) => ({ ik, peerIkPub: peerPub, attemptTimeoutMs: 800 })
  const t0 = Date.now()

  const A = joinChat(net.node('peer-a'), 'sim', { macKey, eh2: eh2(ikA, ikB.pub) }, {
    firstAnnounceMs: 50, heartbeatMs: 1_000,
    onMessage: (_f, m, meta) => aGot.push({ body: m.body, outOfOrder: meta.outOfOrder }),
    onLog: LOG ? (m, lvl) => console.log(`    A${lvl === 'debug' ? '·' : ' '} ${m}`) : undefined,
    onUndelivered: LOG ? (id) => console.log(`    A  UNDELIVERED ${id}`) : undefined,
  })
  await new Promise((r) => setTimeout(r, p.joinGapMs))
  const B = joinChat(net.node('peer-b'), 'sim', { macKey, eh2: eh2(ikB, ikA.pub) }, {
    firstAnnounceMs: 50, heartbeatMs: 1_000,
    onMessage: (_f, m, meta) => bGot.push({ body: m.body, outOfOrder: meta.outOfOrder }),
    onLog: LOG ? (m, lvl) => console.log(`    B${lvl === 'debug' ? '·' : ' '} ${m}`) : undefined,
    onUndelivered: LOG ? (id) => console.log(`    B  UNDELIVERED ${id}`) : undefined,
  })

  const established = await until(() => A.secured().length === 1 && B.secured().length === 1, 15_000)
  const msEstablished = Date.now() - t0

  // traffic both ways, sent at irregular moments
  for (let i = 0; i < 3; i++) {
    A.sendText(`a-${i}`)
    await new Promise((r) => setTimeout(r, 40 + rng() * 160))
    B.sendText(`b-${i}`)
    await new Promise((r) => setTimeout(r, 40 + rng() * 160))
  }
  const delivered = await until(() => aGot.length >= 3 && bGot.length >= 3, 12_000)
  const lossless = p.lossPct === 0

  // …then B's tab goes to the background: its Announce stops being heard, long
  // enough for A to declare it gone. The ratchet must survive that.
  let quietOk = true
  if (p.quietMs > 0) {
    net.silence('peer-b', p.quietMs)
    await new Promise((r) => setTimeout(r, p.quietMs + 200))
    B.sendText('back-from-background')
    quietOk = await until(() => aGot.some((g) => g.body === 'back-from-background'), 8_000)
  }

  A.stop(); B.stop(); net.stop()
  const order = [checkOrder(aGot), checkOrder(bGot)]
  const reordered = order[0].reordered + order[1].reordered
  const unflagged = order[0].unflagged + order[1].unflagged
  return {
    profile: p.name, established, msEstablished,
    aGot: aGot.length, bGot: bGot.length, quietOk, reordered, unflagged,
    // An unflagged reorder fails the run on ANY profile: jitter is allowed to
    // shuffle messages, the receiver is not allowed to keep quiet about it.
    ok: established && quietOk && unflagged === 0
      && (lossless ? delivered : aGot.length + bGot.length > 0),
  }
}

const PROFILES: NetProfile[] = [
  { name: 'clean',            minMs: 5,   maxMs: 20,  lossPct: 0,  dupPct: 0,  joinGapMs: 0,    quietMs: 0 },
  { name: 'both-at-once',     minMs: 20,  maxMs: 120, lossPct: 0,  dupPct: 0,  joinGapMs: 0,    quietMs: 0 },
  { name: 'B joins late',     minMs: 20,  maxMs: 120, lossPct: 0,  dupPct: 0,  joinGapMs: 1500, quietMs: 0 },
  { name: 'lossy 15%',        minMs: 20,  maxMs: 200, lossPct: 15, dupPct: 0,  joinGapMs: 300,  quietMs: 0 },
  { name: 'lossy 35%',        minMs: 20,  maxMs: 200, lossPct: 35, dupPct: 0,  joinGapMs: 300,  quietMs: 0 },
  { name: 'duplicating',      minMs: 20,  maxMs: 150, lossPct: 5,  dupPct: 30, joinGapMs: 200,  quietMs: 0 },
  { name: 'reordering (jit)', minMs: 5,   maxMs: 400, lossPct: 5,  dupPct: 10, joinGapMs: 800,  quietMs: 0 },
  { name: 'background tab',   minMs: 20,  maxMs: 120, lossPct: 5,  dupPct: 5,  joinGapMs: 400,  quietMs: 7000 },
  { name: 'awful',            minMs: 30,  maxMs: 500, lossPct: 30, dupPct: 25, joinGapMs: 2000, quietMs: 5000 },
]

const POOL = ONLY ? PROFILES.filter((p) => p.name.startsWith(ONLY)) : PROFILES
if (!POOL.length) { console.error(`no profile matches "${ONLY}"`); process.exit(2) }
console.log(`room-sim — ${RUNS} runs, base seed ${SEED}${ONLY ? `, profile "${ONLY}"` : ''}\n`)
const results: Array<Result & { seed: number }> = []
for (let i = 0; i < RUNS; i++) {
  const p = POOL[i % POOL.length]
  const seed = SEED + i
  const r = await runOnce(p, seed)
  results.push({ ...r, seed })
  const mark = r.ok ? '✔' : '✖'
  const lost = 6 - Math.min(3, r.aGot) - Math.min(3, r.bGot)
  console.log(
    `${mark} ${p.name.padEnd(18)} seed=${seed}  established=${r.established ? `${r.msEstablished} ms` : 'NO'}` +
    `  delivered=${Math.min(3, r.aGot) + Math.min(3, r.bGot)}/6${lost ? ` (lost ${lost})` : ''}` +
    `${r.reordered ? `  reordered=${r.reordered}${r.unflagged ? ` (UNFLAGGED ${r.unflagged})` : ' (all flagged)'}` : ''}` +
    `${p.quietMs ? `  after-quiet=${r.quietOk ? 'ok' : 'LOST'}` : ''}`,
  )
}

const bad = results.filter((r) => !r.ok)
const noHandshake = results.filter((r) => !r.established)
const totalSent = results.length * 6
const totalGot = results.reduce((n, r) => n + Math.min(3, r.aGot) + Math.min(3, r.bGot), 0)
console.log(`\nhandshakes: ${results.length - noHandshake.length}/${results.length} completed`)
console.log(`content delivery across all profiles (incl. deliberately lossy ones): ${totalGot}/${totalSent}`)
const reordered = results.reduce((n, r) => n + r.reordered, 0)
const unflagged = results.reduce((n, r) => n + r.unflagged, 0)
console.log(`arrived out of order: ${reordered}, of which unflagged: ${unflagged}`)
const times = results.filter((r) => r.established).map((r) => r.msEstablished).sort((a, b) => a - b)
console.log(`\nestablished: median ${times[Math.floor(times.length / 2)]} ms, worst ${times[times.length - 1]} ms`)
if (bad.length === 0) { console.log(`PASS — ${results.length}/${results.length} runs`); process.exit(0) }
console.log(`FAIL — ${bad.length}/${results.length} runs; replay it with: node net/room-sim.ts 1 ${bad[0].seed} "${bad[0].profile}"`)
process.exit(1)
