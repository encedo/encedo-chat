/**
 * pickloss-test.ts — a pick stream that dies on a live connection is re-opened.
 *
 *   node net/pickloss-test.ts
 *
 * One local relay, two light sessions A and B with a secured conversation.
 * A's pick stream is then aborted while its connection stays up - what a
 * stream reset does. A must notice, re-open the stream, and receive B's next
 * message. Before 2026-09-29 A stayed "online" and deaf until a reload: the
 * session counted connections, not the stream, and nothing re-opened it.
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

function startRelay(port: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const p = spawn('node', ['relay.mjs', '--pass', 'pickloss', '--port', String(port), '--pick', '--quiet-msgs'], { cwd: RELAY_DIR })
    procs.push(p)
    let out = ''
    const t = setTimeout(() => reject(new Error('relay did not start')), 15_000)
    p.stdout.on('data', (d) => {
      out += d
      const m = out.match(/PeerId: (12D3\w+)/)
      if (m && out.includes('Relay uruchomiony')) { clearTimeout(t); resolve(`/ip4/127.0.0.1/tcp/${port}/ws/p2p/${m[1]}`) }
    })
  })
}
async function softId(handle: string) {
  const k = await generateX25519()
  const id = { handle, pub: b64(k.pub), ecdh: async (peer: string) => k.dh(Uint8Array.from(atob(peer), (c) => c.charCodeAt(0))) } as any as Identity
  return { id, pub: b64(k.pub) }
}
const until = async (what: string, cond: () => boolean, ms: number) => {
  const t0 = Date.now()
  while (!cond()) { if (Date.now() - t0 > ms) throw new Error(`timed out: ${what}`); await sleep(200) }
  return Math.round((Date.now() - t0) / 1000)
}

let ok = false
try {
  const R = await startRelay(9971)
  const params = { networkId: 'pickloss-test', dateUTC: new Date().toISOString().slice(0, 10) }
  const a = await softId('a'), b = await softId('b')
  let nodeA: any = null
  const logsA: string[] = []
  const A = await startSession(a.id, { relays: [R], transport: 'light', params, onLog: (m: string) => logsA.push(m), onTransport: (n: any) => { nodeA = n } } as any)
  const B = await startSession(b.id, { relays: [R], transport: 'light', params } as any)
  const gotA: string[] = []
  const convA = await A.open({ pub: b.pub, name: 'b' } as any, { params, onMessage: (_f: string, m: any) => gotA.push(m.body) } as any)
  const convB = await B.open({ pub: a.pub, name: 'a' } as any, { params } as any)
  await until('the conversation is secured', () => convA.secured().length > 0 && convB.secured().length > 0, 30_000)
  convB.sendText('przed')
  await until('the first message', () => gotA.includes('przed'), 15_000)
  console.log('secured, first message delivered; aborting A\'s pick stream, connection kept')
  const picks = nodeA.getConnections().flatMap((c: any) => c.streams).filter((s: any) => s.protocol === '/onchato/pick/1')
  for (const s of picks) s.abort(new Error('test: stream reset'))
  const conns = nodeA.getConnections().length
  await sleep(500)
  console.log(`  streams aborted: ${picks.length}, connections still up: ${conns}`)
  const secs = await until('A re-opens its pick stream', () => nodeA.pickConnected(), 20_000).catch(() => -1)
  console.log(secs >= 0 ? `  pick stream re-opened after ${secs} s` : '  pick stream NOT re-opened')
  convB.sendText('po-zerwaniu')
  const got = await until('the message after the reset', () => gotA.includes('po-zerwaniu'), 20_000).then(() => true, () => false)
  console.log(got ? '  A received the message sent after the reset' : '  A received NOTHING after the reset')
  ok = secs >= 0 && got
  await A.close?.(); await B.close?.()
  console.log(ok ? 'PRZESZLO' : 'NIE PRZESZLO')
} catch (e: any) {
  console.log(`NIE PRZESZLO — ${e?.message ?? e}`)
} finally {
  for (const p of procs) p.kill()
  await sleep(300)
  process.exit(ok ? 0 : 1)
}
