/**
 * allowlist-test.ts - a node that admits devices by list (relay --allow-peers,
 * relay/allowlist.mjs) against real sessions of this engine with stable keys
 * (lib/netkey.ts, SessionOpts.peerKey).
 *
 *   node net/allowlist-test.ts
 *
 * Two listed identities (one light, one GossipSub) see each other and talk; an
 * unlisted one does not get in; one taken off the list is dropped.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { generateKeyPair, privateKeyToProtobuf } from '@libp2p/crypto/keys'
import { startSession, type Identity } from '../lib/core.ts'
import { netPeerId } from '../lib/netkey.ts'
import { generateX25519 } from '../lib/x25519.ts'
import { b64 } from '../lib/wc.ts'

const RELAY_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'relay')
const PORT = 9993
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const until = async (cond: () => boolean, ms: number) => { const t0 = Date.now(); while (!cond()) { if (Date.now() - t0 > ms) return false; await sleep(100) } return true }
const dir = mkdtempSync(join(tmpdir(), 'ec-allow-'))
const LIST = join(dir, 'peers.txt')
const procs: ChildProcess[] = []
let relayLog = ''

function startRelay(): Promise<string> {
  return new Promise((ok, fail) => {
    const p = spawn('node', ['relay.mjs', '--key-file', join(dir, 'node.key'), '--port', String(PORT), '--pick', '--quiet-msgs', '--allow-peers', LIST], { cwd: RELAY_DIR })
    procs.push(p)
    const t = setTimeout(() => fail(new Error(`the relay did not start:\n${relayLog.slice(-800)}`)), 20_000)
    const read = (d: Buffer) => { relayLog += d; const m = relayLog.match(/PeerId: (12D3\w+)/); if (m && relayLog.includes('Relay uruchomiony')) { clearTimeout(t); ok(`/ip4/127.0.0.1/tcp/${PORT}/ws/p2p/${m[1]}`) } }
    p.stdout.on('data', read); p.stderr.on('data', read)
  })
}
async function softId(handle: string) {
  const k = await generateX25519()
  return { id: { handle, pub: b64(k.pub), ecdh: async (peer: string) => k.dh(Uint8Array.from(atob(peer), (c) => c.charCodeAt(0))) } as any as Identity, pub: b64(k.pub) }
}
const netKey = async () => privateKeyToProtobuf(await generateKeyPair('Ed25519'))

let ok = false
try {
  const kA = await netKey(), kB = await netKey(), kX = await netKey()
  writeFileSync(LIST, `${netPeerId(kA)} A\n${netPeerId(kB)} B\n`)
  const R = await startRelay()
  const params = { networkId: 'allowlist-test', dateUTC: new Date().toISOString().slice(0, 10) }
  const a = await softId('a'), b = await softId('b'), x = await softId('x')
  const A = await startSession(a.id, { relays: [R], transport: 'light', params, peerKey: kA } as any)
  const B = await startSession(b.id, { relays: [R], transport: 'libp2p', params, peerKey: kB } as any)
  let seenA = false, seenB = false, convB: any = null
  const gotB: string[] = []
  await A.watchContacts([{ pub: b.pub, name: 'b' } as any], { onOnline: () => { seenA = true }, onOffline: () => {} })
  await B.watchContacts([{ pub: a.pub, name: 'a' } as any], {
    onOnline: () => { seenB = true }, onOffline: () => {},
    onWantsConversation: async (p: any) => { if (!convB) convB = await B.open(p, { params, onMessage: (_f: string, m: any) => gotB.push(m.body) } as any) },
  })
  if (A.netStatus().self !== netPeerId(kA) || B.netStatus().self !== netPeerId(kB)) throw new Error('a session did not dial with its stable key')
  if (!await until(() => seenA && seenB, 45_000)) throw new Error('two listed devices did not see each other')
  console.log('  [ok] two listed devices (light, GossipSub) see each other')
  const convA = await A.open({ pub: b.pub, name: 'b' } as any, { params, onMessage: () => {} } as any)
  convA.sendText('through the list')
  if (!await until(() => gotB.includes('through the list'), 45_000)) throw new Error('a message between listed devices did not arrive')
  console.log('  [ok] a message between them')

  // Not on the list: the node refuses it after the Noise handshake.
  let xIn = false
  const X = await startSession(x.id, { relays: [R], transport: 'light', params, peerKey: kX } as any).then((s) => { xIn = true; return s }, () => null)
  await sleep(3000)
  if (X && X.netStatus().connected) throw new Error('a device NOT on the list got a connection')
  if (X && X.netStatus().self !== netPeerId(kX)) throw new Error('the unlisted session did not use its key')
  console.log(`  [ok] a device not on the list is not let in${xIn ? ' (its session started, with no connection)' : ''}`)

  // Taken off the list: dropped.
  writeFileSync(LIST, `${netPeerId(kA)} A\n`)
  if (!await until(() => relayLog.includes('is off the list - closing'), 10_000)) throw new Error('a device taken off the list was not dropped')
  console.log('  [ok] a device taken off the list is dropped')
  ok = true
  await A.close?.(); await B.close?.(); await X?.close?.()
} catch (e: any) {
  console.log(`[fail] ${e?.message ?? e}`)
} finally {
  for (const p of procs) p.kill()
  rmSync(dir, { recursive: true, force: true })
  await sleep(300)
  console.log(ok ? 'PASS - the node admits by list' : 'FAIL')
  process.exit(ok ? 0 : 1)
}
