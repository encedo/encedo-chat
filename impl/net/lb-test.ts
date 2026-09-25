/**
 * lb-test.ts — does a session leave a loaded node for a lighter one on its own?
 *
 *   node net/lb-test.ts
 *
 * Starts two relays on this machine, A and B, meshed, both announcing load and
 * both with --max-connections 10 so a handful of idle peers makes A hot. Then:
 *
 *   1. idle light peers fill A to ~70 % while B sits near 10 %;
 *   2. a real session (lib/core.ts, light transport, loadBalance on) is given
 *      the list [A, B] -- A first, so without load-awareness it would stay;
 *   3. it must read both nodes' load from A at once (the relay replays its
 *      cache), decide that B is lighter by the gap, and end up connected to B;
 *   4. the control: the same session with loadBalance OFF stays on A.
 *
 * Exit 0 only if both halves hold.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { startSession, type Identity } from '../lib/core.ts'
import { generateX25519 } from '../lib/x25519.ts'
import { b64 } from '../lib/wc.ts'
import { createLightPeer } from './light.ts'
import { dial } from './peer.ts'
import { LOAD_TOPIC, decodeLoad } from '../../relay/load.mjs'

const RELAY_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'relay')
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const procs: ChildProcess[] = []

function startRelay(name: string, port: number, extra: string[] = []): Promise<string> {
  return new Promise((resolve, reject) => {
    const p = spawn('node', ['relay.mjs', '--pass', `lb-${name}`, '--port', String(port), '--pick', '--announce-load',
      '--max-connections', '10', '--stats-node', name, '--quiet-msgs', ...extra], { cwd: RELAY_DIR })
    procs.push(p)
    let out = ''
    const t = setTimeout(() => reject(new Error(`relay ${name} did not start: ${out.slice(-300)}`)), 15_000)
    p.stdout.on('data', (d) => {
      out += d
      const m = out.match(/PeerId: (12D3\w+)/)
      if (m && out.includes('Relay uruchomiony')) { clearTimeout(t); resolve(`/ip4/127.0.0.1/tcp/${port}/ws/p2p/${m[1]}`) }
    })
    p.stderr.on('data', (d) => { out += d })
  })
}

async function softId(handle: string): Promise<Identity> {
  const k = await generateX25519()
  return { handle, pub: b64(k.pub), ecdh: async (peer: string) => k.dh(Uint8Array.from(atob(peer), (c) => c.charCodeAt(0))) } as any
}

let ok = false
try {
  const B = await startRelay('lbB', 9931)
  const A = await startRelay('lbA', 9932, ['--peers', B])
  const keyOf = (addr: string) => (addr === A ? 'lbA' : addr === B ? 'lbB' : '?')
  console.log(`A ${A.slice(0, 40)}...\nB ${B.slice(0, 40)}...`)

  // 1. load A with idle light peers; watch the announcements through one of them
  const idle: any[] = []
  for (let i = 0; i < 6; i++) { const n = await createLightPeer(); await dial(n, A); idle.push(n) }
  const seen = new Map<string, number>()
  idle[0].services.pubsub.addEventListener('message', (e: any) => {
    if (e.detail.topic !== LOAD_TOPIC) return
    const r = decodeLoad(e.detail.data); if (r) seen.set(r.node, r.pct)
  })
  idle[0].services.pubsub.subscribe(LOAD_TOPIC)
  // A announces 5 s after start and then every 30 s: wait for a reading that
  // already counts the idle peers (and one from B, which crossed the mesh).
  for (let i = 0; i < 90 && !((seen.get('lbA') ?? 0) >= 50 && seen.has('lbB')); i++) await sleep(500)
  console.log(`load seen through A: ${[...seen].map(([k, v]) => `${k} ${v}%`).join(', ')}`)
  if (!((seen.get('lbA') ?? 0) >= 50 && seen.has('lbB'))) throw new Error('A never announced itself loaded, or B was not heard across the mesh')

  // 2-3. a load-aware session, A first in its list
  const logsOn: string[] = []
  const sOn = await startSession(await softId('lb-on'), {
    relays: [A, B], transport: 'light', loadBalance: true, nodeKeyOf: keyOf,
    params: { networkId: 'lb-test', dateUTC: new Date().toISOString().slice(0, 10) },
    onLog: (m: string) => logsOn.push(m),
  } as any)
  for (let i = 0; i < 40 && sOn.netStatus().relay !== B; i++) await sleep(250)
  const movedOn = sOn.netStatus().relay === B
  console.log(`load-aware session: ${logsOn.filter((l) => l.startsWith('load')).join(' | ')}`)
  console.log(`  ends on ${keyOf(sOn.netStatus().relay)} -> ${movedOn ? 'MOVED to the lighter node' : 'stayed on the loaded node'}`)
  await sOn.close?.()

  // 4. the control: same list, load-awareness off
  const sOff = await startSession(await softId('lb-off'), {
    relays: [A, B], transport: 'light', loadBalance: false, nodeKeyOf: keyOf,
    params: { networkId: 'lb-test', dateUTC: new Date().toISOString().slice(0, 10) },
  } as any)
  await sleep(4_000)
  const stayedOff = sOff.netStatus().relay === A
  console.log(`control (load-awareness off): ends on ${keyOf(sOff.netStatus().relay)} -> ${stayedOff ? 'stayed, as it should' : 'MOVED without being asked'}`)
  await sOff.close?.()

  for (const n of idle) await n.stop().catch(() => {})
  ok = movedOn && stayedOff
  console.log(ok ? 'PRZESZLO' : 'NIE PRZESZLO')
} catch (e: any) {
  console.log(`NIE PRZESZLO — ${e?.message ?? e}`)
} finally {
  for (const p of procs) p.kill()
  await sleep(300)
  process.exit(ok ? 0 : 1)
}
