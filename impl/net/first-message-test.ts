/**
 * first-message-test.ts — how long from opening a conversation to the first message.
 *
 *   node net/first-message-test.ts [--slow]
 *
 * Asked on a train, 2026-10-03: both sides showed each other as available
 * (orange) within seconds, yet "hello" took 10-15 s. The opening room started
 * its handshake only once it heard the contact announce again - up to one
 * 15 s heartbeat of the contact's presence watch - although its own watch had
 * just heard it. Now the watch hands what it heard to the room, and a watch
 * answers a newcomer at once. Three trials, one local relay, two light
 * sessions that see each other through presence only; A opens and writes, B
 * is pulled into the conversation by A's handshake. --slow turns the hints
 * off (the old path) for comparison.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { startSession, type Identity } from '../lib/core.ts'
import { generateX25519 } from '../lib/x25519.ts'
import { b64 } from '../lib/wc.ts'

const RELAY_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'relay')
const SLOW = process.argv.includes('--slow')
const TRIALS = 3
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const procs: ChildProcess[] = []

function startRelay(port: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const p = spawn('node', ['relay.mjs', '--pass', 'firstmsg', '--port', String(port), '--pick', '--quiet-msgs'], { cwd: RELAY_DIR })
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
const until = async (cond: () => boolean, ms: number) => {
  const t0 = Date.now()
  while (!cond()) { if (Date.now() - t0 > ms) return -1; await sleep(100) }
  return Date.now() - t0
}

let ok = false
try {
  const R = await startRelay(9993)
  const params = { networkId: 'firstmsg-test', dateUTC: new Date().toISOString().slice(0, 10) }
  // The watches beat every 60 s - a hidden tab or a phone in the background -
  // which is where the wait came from: the opener waited for the next beat.
  const base = { relays: [R], transport: 'light', params, presenceHints: !SLOW, presenceHeartbeatMs: 60_000 }
  const a = await softId('a'), b = await softId('b')
  const A = await startSession(a.id, base as any)
  const B = await startSession(b.id, base as any)
  let onlineA = false, onlineB = false
  const gotB: string[] = []
  let convB: any = null
  await A.watchContacts([{ pub: b.pub, name: 'b' } as any], { onOnline: () => { onlineA = true }, onOffline: () => { onlineA = false } })
  await B.watchContacts([{ pub: a.pub, name: 'a' } as any], {
    onOnline: () => { onlineB = true }, onOffline: () => { onlineB = false },
    // B's app: a handshake on the watch opens the conversation, as app.ts does.
    onWantsConversation: async (p: any) => { if (!convB) convB = await B.open(p, { params, onMessage: (_f: string, m: any) => gotB.push(m.body) } as any) },
  })
  if (await until(() => onlineA && onlineB, 30_000) < 0) throw new Error('the two never saw each other')
  const times: number[] = []
  for (let i = 0; i < TRIALS; i++) {
    // Past the watches' early beacons: the steady state of somebody who has
    // been "available" for a while, which is where the wait used to come from.
    await sleep(9_000 + Math.random() * 6_000)
    const t0 = Date.now()
    const convA = await A.open({ pub: b.pub, name: 'b' } as any, { params } as any)
    convA.sendText(`hello-${i}`)
    const ms = await until(() => gotB.includes(`hello-${i}`), 40_000)
    times.push(ms < 0 ? 40_000 : Date.now() - t0)
    console.log(`  trial ${i + 1}: ${ms < 0 ? 'NOT delivered in 40 s' : `${((Date.now() - t0) / 1000).toFixed(1)} s`}`)
    await convA.leave(); if (convB) { await convB.leave(); convB = null }
    await until(() => onlineA && onlineB, 30_000)
  }
  const median = [...times].sort((x, y) => x - y)[Math.floor(TRIALS / 2)]
  console.log(`${SLOW ? 'old path' : 'with hints'}: median ${(median / 1000).toFixed(1)} s to the first message`)
  ok = SLOW ? median > 8_000 : median < 4_000
  console.log(ok ? 'PRZESZLO' : 'NIE PRZESZLO')
  await A.close?.(); await B.close?.()
} catch (e: any) {
  console.log(`NIE PRZESZLO — ${e?.message ?? e}`)
} finally {
  for (const p of procs) p.kill()
  await sleep(300)
  process.exit(ok ? 0 : 1)
}
