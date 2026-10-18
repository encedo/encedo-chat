/**
 * relay-compat-test.ts - this client against ANOTHER build's relay.
 *
 *   RELAY_DIR=<path to a relay/ checkout> node net/relay-compat-test.ts
 *
 * An operator running a network of its own takes the apps from us and updates
 * its relays on its own schedule, so the day an app update lands, its relays
 * are one release behind. Until 1.0 nothing on the wire is versioned
 * (SECURITY.md, Versions), so the only promise that can be made is a tested
 * one: the new client works against the PREVIOUS release's relay (N-1). CI
 * checks out the last release tag's relay/ and points this at it.
 *
 * One local relay, two sessions of THIS engine - one on the light transport
 * (pick/push, the default), one a full GossipSub peer - which see each other
 * through presence, open a conversation and send a message each way. Both
 * transports, because an old relay has to carry both.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'
import { readFileSync } from 'node:fs'
import { startSession, type Identity } from '../lib/core.ts'
import { generateX25519 } from '../lib/x25519.ts'
import { b64 } from '../lib/wc.ts'

const RELAY_DIR = resolve(process.env.RELAY_DIR ?? join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'relay'))
const PORT = 9994
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const procs: ChildProcess[] = []

function startRelay(): Promise<string> {
  return new Promise((ok, fail) => {
    const p = spawn('node', ['relay.mjs', '--pass', 'compat', '--port', String(PORT), '--pick', '--quiet-msgs'], { cwd: RELAY_DIR })
    procs.push(p)
    let out = ''
    const t = setTimeout(() => fail(new Error(`the relay in ${RELAY_DIR} did not start:\n${out.slice(-800)}`)), 20_000)
    const read = (d: Buffer) => {
      out += d
      const m = out.match(/PeerId: (12D3\w+)/)
      if (m && out.includes('Relay uruchomiony')) { clearTimeout(t); ok(`/ip4/127.0.0.1/tcp/${PORT}/ws/p2p/${m[1]}`) }
    }
    p.stdout.on('data', read); p.stderr.on('data', read)
  })
}
async function softId(handle: string) {
  const k = await generateX25519()
  return { id: { handle, pub: b64(k.pub), ecdh: async (peer: string) => k.dh(Uint8Array.from(atob(peer), (c) => c.charCodeAt(0))) } as any as Identity, pub: b64(k.pub) }
}
const until = async (cond: () => boolean, ms: number) => {
  const t0 = Date.now()
  while (!cond()) { if (Date.now() - t0 > ms) return false; await sleep(100) }
  return true
}

let ok = false
try {
  let version = '?'
  try { version = JSON.parse(readFileSync(join(RELAY_DIR, 'package.json'), 'utf8')).version } catch {}
  console.log(`relay under test: ${RELAY_DIR} (relay ${version})`)
  const R = await startRelay()
  const params = { networkId: 'compat-test', dateUTC: new Date().toISOString().slice(0, 10) }
  const a = await softId('a'), b = await softId('b')
  const A = await startSession(a.id, { relays: [R], transport: 'light', params } as any)
  const B = await startSession(b.id, { relays: [R], transport: 'libp2p', params } as any)
  let seenA = false, seenB = false
  const gotA: string[] = [], gotB: string[] = []
  let convB: any = null
  await A.watchContacts([{ pub: b.pub, name: 'b' } as any], { onOnline: () => { seenA = true }, onOffline: () => {} })
  await B.watchContacts([{ pub: a.pub, name: 'a' } as any], {
    onOnline: () => { seenB = true }, onOffline: () => {},
    onWantsConversation: async (p: any) => { if (!convB) convB = await B.open(p, { params, onMessage: (_f: string, m: any) => gotB.push(m.body) } as any) },
  })
  if (!await until(() => seenA && seenB, 45_000)) throw new Error(`presence did not cross the relay (light sees gossip: ${seenA}, gossip sees light: ${seenB})`)
  console.log('  [ok] presence both ways (light <-> GossipSub)')
  const convA = await A.open({ pub: b.pub, name: 'b' } as any, { params, onMessage: (_f: string, m: any) => gotA.push(m.body) } as any)
  convA.sendText('from-light')
  if (!await until(() => gotB.includes('from-light'), 45_000)) throw new Error('light -> GossipSub: not delivered in 45 s')
  console.log('  [ok] a message light -> GossipSub')
  convB.sendText('from-gossip')
  if (!await until(() => gotA.includes('from-gossip'), 45_000)) throw new Error('GossipSub -> light: not delivered in 45 s')
  console.log('  [ok] a message GossipSub -> light')
  ok = true
  await convA.leave(); await convB.leave()
  await A.close?.(); await B.close?.()
} catch (e: any) {
  console.log(`[fail] ${e?.message ?? e}`)
} finally {
  for (const p of procs) p.kill()
  await sleep(300)
  console.log(ok ? 'PASS - this client works with that relay' : 'FAIL')
  process.exit(ok ? 0 : 1)
}
