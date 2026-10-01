/**
 * mesh-watchdog-test.ts — a relay whose stream to a sibling died is reset.
 *
 *   node net/mesh-watchdog-test.ts [--no-watchdog] [--no-overlap]
 *
 * Reproduces what production showed on 2026-09-29. R1 and R2 are meshed
 * siblings. R2 is frozen (SIGSTOP), so R1 still holds its connection; a new R2
 * with the SAME PeerId comes up and dials R1 while that connection is open,
 * then the frozen one is killed. R1's GossipSub then keeps writing into the
 * old connection: clients on the two relays stop hearing each other in that
 * direction, with every TCP link up. The watchdog (relay/topics.mjs
 * staleSiblings) must notice the silence and reset the link, and the overlap
 * reset (topics.mjs overlapReset) must catch the moment itself, in seconds.
 * --no-watchdog puts the silence limit out of reach, --no-overlap turns the
 * overlap reset off; with both, the breakage must stay.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { createLightPeer } from './light.ts'
import { dial } from './peer.ts'

const RELAY_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'relay')
const NO_WATCHDOG = process.argv.includes('--no-watchdog')
const NO_OVERLAP = process.argv.includes('--no-overlap')
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const procs: ChildProcess[] = []
const logs: Record<string, string> = {}

function startRelay(name: string, port: number, extra: string[] = []): Promise<{ addr: string; proc: ChildProcess }> {
  return new Promise((resolve, reject) => {
    const p = spawn('node', ['relay.mjs', '--pass', `mwd-${name.replace(/'$/, '')}`, '--port', String(port), '--pick', '--quiet-msgs',
      '--announce-load', '--load-every', '2', '--mesh-silence', NO_WATCHDOG ? '100000' : '7',
      ...(NO_OVERLAP ? ['--no-overlap-reset'] : []), ...extra], { cwd: RELAY_DIR })
    procs.push(p)
    let out = ''
    const t = setTimeout(() => reject(new Error(`relay ${name} did not start: ${out.slice(-300)}`)), 15_000)
    p.stdout.on('data', (d) => {
      out += d; logs[name] = (logs[name] ?? '') + d
      const m = out.match(/PeerId: (12D3\w+)/)
      if (m && out.includes('Relay uruchomiony')) { clearTimeout(t); resolve({ addr: `/ip4/127.0.0.1/tcp/${port}/ws/p2p/${m[1]}`, proc: p }) }
    })
    p.stderr.on('data', (d) => { out += d })
  })
}
const id = (a: string) => a.split('/p2p/')[1]

/** Does a push from `from` on T reach `to`? Four tries. */
async function reaches(from: any, to: { got: string[] }, T: string, tag: string) {
  for (let i = 0; i < 4; i++) {
    await from.services.pubsub.publish(T, new TextEncoder().encode(`${tag}-${i}`))
    await sleep(600)
    if (to.got.some((g) => g.startsWith(tag))) return true
  }
  return false
}
async function client(addr: string, T: string) {
  const n = await createLightPeer(); await dial(n, addr)
  const got: string[] = []
  n.services.pubsub.addEventListener('message', (e: any) => { if (e.detail.topic === T) got.push(new TextDecoder().decode(e.detail.data)) })
  n.services.pubsub.subscribe(T)
  return { n, got }
}

let ok = false
try {
  // PeerIds come from --pass: a first start learns them.
  const pre1 = await startRelay('R1', 9981), pre2 = await startRelay('R2', 9982)
  const id1 = id(pre1.addr), id2 = id(pre2.addr)
  for (const p of procs.splice(0)) p.kill()
  await sleep(800)
  const shape = (sib: string) => ['--local-topics-only', '--leaf-announce', '--siblings', sib]
  // Production shape: each relay of a pair has the other in --peers (R1 lists
  // both the address R2 starts on and the one its successor will use), so the
  // re-dial after a reset goes first from whichever has the smaller PeerId.
  const R1 = await startRelay('R1', 9981, ['--peers', `/ip4/127.0.0.1/tcp/9982/ws/p2p/${id2}`, `/ip4/127.0.0.1/tcp/9983/ws/p2p/${id2}`, ...shape(id2)])
  const R2 = await startRelay('R2', 9982, ['--peers', R1.addr, ...shape(id1)])
  const T = 'mwd-' + Date.now().toString(36)
  const A = await client(R1.addr, T)
  const B = await client(R2.addr, T)
  await sleep(2_000)
  console.log(`before: R2->R1 ${await reaches(B.n, A, T, 'b1') ? 'ok' : 'BROKEN'}, R1->R2 ${await reaches(A.n, B, T, 'a1') ? 'ok' : 'BROKEN'}`)

  // The overlap rule acts only on an old connection (> 30 s): a real reconnect
  // after a drop, not two relays dialling each other at start.
  await sleep(32_000)
  // The production sequence: R2 hangs, a new R2 (same PeerId) dials R1 while
  // R1 still holds the old connection, then the old one dies.
  R2.proc.kill('SIGSTOP')
  await sleep(500)
  const R2b = await startRelay("R2'", 9983, ['--peers', R1.addr, ...shape(id1)])
  await sleep(1_500)
  R2.proc.kill('SIGKILL')
  await sleep(1_000)
  const B2 = await client(R2b.addr, T)
  await sleep(2_000)
  const broke = !(await reaches(A.n, B2, T, 'a2'))
  console.log(`after the overlap: R1->R2' ${broke ? 'BROKEN' : 'ok'}`)
  // Give the watchdog its 7 s of silence plus a check.
  let healed = false, secs = 0
  for (const t0 = Date.now(); !healed && Date.now() - t0 < 40_000; ) {
    healed = await reaches(A.n, B2, T, `a3-${secs}`)
    secs = Math.round((Date.now() - t0) / 1000)
  }
  const all = (logs['R1'] ?? '') + (logs["R2'"] ?? '')
  const how = all.includes('reconnected over a still-open connection') ? ' (overlap reset)' : all.includes('[mesh] nothing from sibling') ? ' (watchdog reset)' : ''
  console.log(healed ? `R1->R2' healed after ${secs} s${how}` : `R1->R2' still BROKEN after ${secs} s`)
  // Both defences off: it must stay broken. The overlap reset alone: healed, fast.
  ok = NO_WATCHDOG && NO_OVERLAP ? !healed : healed && (NO_OVERLAP || secs <= 15)
  for (const c of [A, B, B2]) await c.n.stop().catch(() => {})
  console.log(ok ? 'PRZESZLO' : 'NIE PRZESZLO')
} catch (e: any) {
  console.log(`NIE PRZESZLO — ${e?.message ?? e}`)
} finally {
  for (const p of procs) { try { p.kill('SIGCONT') } catch {}; p.kill('SIGKILL') }
  await sleep(300)
  process.exit(ok ? 0 : 1)
}
