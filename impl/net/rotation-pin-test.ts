/**
 * rotation-pin-test.ts — a room left on yesterday's topic follows the contact.
 *
 *   node net/rotation-pin-test.ts [--no-realign]
 *
 * Reproduces 2026-10-01: A and B talk; the pair's rendezvous day rotates
 * (forced to happen 30 s into the test); B restarts and reopens on the NEW
 * day's topic while A's room is still pinned to the old one. They saw each
 * other only through presence - orange both ways - and nothing went through
 * until A restarted too. With the fix A's session notices nobody is left on
 * its room's topic, moves the room to the current day, and B's next message
 * arrives. --no-realign puts the check out of reach, to show the breakage.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { startSession, type Identity } from '../lib/core.ts'
import { generateX25519 } from '../lib/x25519.ts'
import { b64 } from '../lib/wc.ts'

const RELAY_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'relay')
const NO_REALIGN = process.argv.includes('--no-realign')
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const procs: ChildProcess[] = []

function startRelay(port: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const p = spawn('node', ['relay.mjs', '--pass', 'rotpin', '--port', String(port), '--pick', '--quiet-msgs'], { cwd: RELAY_DIR })
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
  return { id: { handle, pub: b64(k.pub), ecdh: async (peer: string) => k.dh(Uint8Array.from(atob(peer), (c) => c.charCodeAt(0))) } as any as Identity, pub: b64(k.pub) }
}
const until = async (what: string, cond: () => boolean, ms: number) => {
  const t0 = Date.now()
  while (!cond()) { if (Date.now() - t0 > ms) throw new Error(`timed out: ${what}`); await sleep(250) }
  return Math.round((Date.now() - t0) / 1000)
}

let ok = false
try {
  const R = await startRelay(9991)
  const now = new Date()
  const rotateAt = Date.now() + 30_000
  const forcedRotationSec = Math.floor((rotateAt % 86_400_000) / 1000) // the pair rotates 30 s from now
  const params = { networkId: 'rotpin-test', dateUTC: now.toISOString().slice(0, 10) }
  const base = { relays: [R], transport: 'light', params, forcedRotationSec, realignEveryMs: NO_REALIGN ? 3_600_000 : 2_000 }
  const a = await softId('a'), b = await softId('b')
  const logsA: string[] = []
  const A = await startSession(a.id, { ...base, onLog: (m: string) => logsA.push(m) } as any)
  const gotA: string[] = []
  const convA = await A.open({ pub: b.pub, name: 'b' } as any, { params, onMessage: (_f: string, m: any) => gotA.push(m.body) } as any)
  let B = await startSession(b.id, base as any)
  let convB = await B.open({ pub: a.pub, name: 'a' } as any, { params } as any)
  await until('the conversation is secured', () => convA.secured().length > 0 && convB.secured().length > 0, 30_000)
  convB.sendText('przed')
  await until('the first message', () => gotA.includes('przed'), 15_000)
  const before = convA.topic
  console.log(`secured on ${before.slice(0, 12)}...; waiting for the pair's rotation`)
  await sleep(Math.max(0, rotateAt - Date.now()) + 3_000)
  // B restarts after the rotation: a new session, a room on the NEW day.
  await convB.leave(); await B.close?.()
  B = await startSession(b.id, base as any)
  convB = await B.open({ pub: a.pub, name: 'a' } as any, { params } as any)
  console.log(`B reopened on ${convB.topic.slice(0, 12)}... (A still on ${convA.topic.slice(0, 12)}...)`)
  if (convB.topic === before) throw new Error('the forced rotation did not change the topic - the test proves nothing')
  const moved = await until('A follows to the current topic', () => convA.topic === convB.topic, 30_000).catch(() => -1)
  console.log(moved >= 0 ? `  A moved its room after ${moved} s` : '  A stayed on the old topic')
  await until('the new session is secured', () => convB.secured().length > 0, 30_000).catch(() => {})
  convB.sendText('po-rotacji')
  const got = await until('the message after the restart', () => gotA.includes('po-rotacji'), 30_000).then(() => true, () => false)
  console.log(got ? '  A received the message sent after B reopened' : '  A received NOTHING after B reopened')
  ok = NO_REALIGN ? !got : moved >= 0 && got
  await A.close?.(); await B.close?.()
  console.log(ok ? 'PRZESZLO' : 'NIE PRZESZLO')
} catch (e: any) {
  console.log(`NIE PRZESZLO — ${e?.message ?? e}`)
} finally {
  for (const p of procs) p.kill()
  await sleep(300)
  process.exit(ok ? 0 : 1)
}
