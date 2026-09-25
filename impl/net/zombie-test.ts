/**
 * zombie-test.ts — a relay that stops answering WITHOUT closing the socket.
 *
 *   node net/zombie-test.ts
 *
 * What a phone sees when LTE drops and comes back, or hands over: the TCP
 * connection is not closed, it just goes silent. `connection:close` never
 * fires, so the only way to notice is that nothing we send is acknowledged.
 * Reported from a phone on a motorway (2026-09-25): messages sat on
 * "wysylam..." for good, because the light transport reported a missing ACK
 * as "no evidence" and the room's isolation detector ignores that.
 *
 * Two local relays, A and B. A session (light transport) is on A with a room
 * open, so the room heartbeats. Then A is frozen with SIGSTOP: the process
 * holds its sockets, answers nothing. The session must notice on its own
 * (two heartbeats that reached nobody), re-dial, and end up on B -- within a
 * minute. A is resumed and stopped at the end.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { startSession, type Identity } from '../lib/core.ts'
import { generateX25519 } from '../lib/x25519.ts'
import { b64 } from '../lib/wc.ts'

const RELAY_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'relay')
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const procs: ChildProcess[] = []

function startRelay(name: string, port: number): Promise<{ addr: string; proc: ChildProcess }> {
  return new Promise((resolve, reject) => {
    const p = spawn('node', ['relay.mjs', '--pass', `zombie-${name}`, '--port', String(port), '--pick', '--quiet-msgs'], { cwd: RELAY_DIR })
    procs.push(p)
    let out = ''
    const t = setTimeout(() => reject(new Error(`relay ${name} did not start`)), 15_000)
    p.stdout.on('data', (d) => {
      out += d
      const m = out.match(/PeerId: (12D3\w+)/)
      if (m && out.includes('Relay uruchomiony')) { clearTimeout(t); resolve({ addr: `/ip4/127.0.0.1/tcp/${port}/ws/p2p/${m[1]}`, proc: p }) }
    })
  })
}

async function softId(handle: string): Promise<Identity> {
  const k = await generateX25519()
  return { handle, pub: b64(k.pub), ecdh: async (peer: string) => k.dh(Uint8Array.from(atob(peer), (c) => c.charCodeAt(0))) } as any
}

let ok = false
let frozen: ChildProcess | null = null
try {
  const A = await startRelay('A', 9941)
  const B = await startRelay('B', 9942)
  const logs: string[] = []
  const params = { networkId: 'zombie-test', dateUTC: new Date().toISOString().slice(0, 10) }
  const s = await startSession(await softId('zombie'), {
    relays: [A.addr, B.addr], transport: 'light', params, onLog: (m: string) => logs.push(m),
  } as any)
  // A room with a contact who never comes: its heartbeat is what notices.
  const other = await generateX25519()
  await s.open({ pub: b64(other.pub) } as any, { params } as any)
  await sleep(3_000)
  console.log(`session on ${s.netStatus().relay === A.addr ? 'A' : '?'}; freezing A (SIGSTOP) -- socket open, nothing answers`)
  frozen = A.proc
  A.proc.kill('SIGSTOP')
  const t0 = Date.now()
  while (Date.now() - t0 < 75_000 && s.netStatus().relay !== B.addr) await sleep(500)
  const secs = Math.round((Date.now() - t0) / 1000)
  const moved = s.netStatus().relay === B.addr
  console.log(logs.filter((l) => /heartbeat|isolat|re-dial|failover|link:/i.test(l)).slice(-4).map((l) => '  ' + l).join('\n'))
  console.log(moved ? `noticed the silent relay and moved to B after ${secs} s` : `still on A after ${secs} s -- the dead socket was not noticed`)
  ok = moved && secs <= 70
  console.log(ok ? 'PRZESZLO' : 'NIE PRZESZLO')
  await s.close()
} catch (e: any) {
  console.log(`NIE PRZESZLO — ${e?.message ?? e}`)
} finally {
  if (frozen) frozen.kill('SIGCONT')
  for (const p of procs) p.kill()
  await sleep(300)
  process.exit(ok ? 0 : 1)
}
