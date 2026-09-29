/**
 * evict-test.ts — a quiet topic that a light client still holds is not evicted.
 *
 *   node net/evict-test.ts
 *
 * Two local relays, R1 and R2, meshed, both with a 4 s idle TTL. Light client A
 * picks topic T on R1 and then says nothing for three TTLs - what a throttled
 * hidden tab does to a quiet presence topic. Light client B picks T on R2 and
 * pushes. A must receive it. Before 2026-09-29 R1's idle sweep unsubscribed T
 * from the mesh while A's pick stayed, so nothing from R2 reached A, and A was
 * told nothing.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { createLightPeer } from './light.ts'
import { dial } from './peer.ts'

const RELAY_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'relay')
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const procs: ChildProcess[] = []
let r1log = ''

function startRelay(name: string, port: number, extra: string[] = []): Promise<string> {
  return new Promise((resolve, reject) => {
    const p = spawn('node', ['relay.mjs', '--pass', `evict-${name}`, '--port', String(port), '--pick', '--idle-ttl', '4', '--quiet-msgs', ...extra], { cwd: RELAY_DIR })
    procs.push(p)
    let out = ''
    const t = setTimeout(() => reject(new Error(`relay ${name} did not start: ${out.slice(-300)}`)), 15_000)
    p.stdout.on('data', (d) => {
      out += d; if (name === 'R1') r1log += d
      const m = out.match(/PeerId: (12D3\w+)/)
      if (m && out.includes('Relay uruchomiony')) { clearTimeout(t); resolve(`/ip4/127.0.0.1/tcp/${port}/ws/p2p/${m[1]}`) }
    })
    p.stderr.on('data', (d) => { out += d })
  })
}

let ok = false
try {
  // Production shape: each relay carries only its own clients' topics and
  // announces them to its siblings (--local-topics-only --leaf-announce
  // --siblings). PeerIds come from --pass, so a first start learns them.
  const id = (a: string) => a.split('/p2p/')[1]
  const id1 = id(await startRelay('R1', 9961)), id2 = id(await startRelay('R2', 9962))
  for (const p of procs.splice(0)) p.kill()
  await sleep(800); r1log = ''
  const shape = (sib: string) => ['--local-topics-only', '--leaf-announce', '--siblings', sib]
  const R1 = await startRelay('R1', 9961, shape(id2))
  await startRelay('R2', 9962, ['--peers', R1, ...shape(id1)])
  const R2 = `/ip4/127.0.0.1/tcp/9962/ws/p2p/${id2}`
  const T = 'evict-test-' + Date.now().toString(36)
  const A = await createLightPeer(); await dial(A, R1)
  let got = ''
  A.services.pubsub.addEventListener('message', (e: any) => { if (e.detail.topic === T) got = new TextDecoder().decode(e.detail.data) })
  A.services.pubsub.subscribe(T)
  await sleep(1_500)
  console.log('A holds T on R1 and stays quiet for 12 s (three idle TTLs)...')
  await sleep(12_000)
  const evicted = r1log.includes(`evicted "${T}"`)
  console.log(`R1 ${evicted ? 'EVICTED' : 'kept'} the topic A holds`)
  const B = await createLightPeer(); await dial(B, R2)
  B.services.pubsub.subscribe(T)
  await sleep(1_500)
  for (let i = 0; i < 5 && !got; i++) { await B.services.pubsub.publish(T, new TextEncoder().encode('hello-from-R2')); await sleep(800) }
  console.log(got ? `A received "${got}" through R2 -> R1` : 'A received NOTHING from R2')
  ok = !evicted && got === 'hello-from-R2'
  await A.stop(); await B.stop()
  console.log(ok ? 'PRZESZLO' : 'NIE PRZESZLO')
} catch (e: any) {
  console.log(`NIE PRZESZLO — ${e?.message ?? e}`)
} finally {
  for (const p of procs) p.kill()
  await sleep(300)
  process.exit(ok ? 0 : 1)
}
