/**
 * allowlist-test.ts - a node that admits devices by list (relay --allow-peers,
 * relay/allowlist.mjs) against real sessions of this engine with stable keys
 * (lib/netkey.ts, SessionOpts.peerKey).
 *
 *   node net/allowlist-test.ts
 *
 * Two listed identities (one light, one GossipSub) see each other and talk; an
 * unlisted one does not get in, enrols with the administrator's code through the
 * real enrolment service (relay/enroll.mjs) and then does; one taken off the
 * list is dropped.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { generateKeyPair, privateKeyToProtobuf } from '@libp2p/crypto/keys'
import { startSession, type Identity } from '../lib/core.ts'
import { netPeerId } from '../lib/netkey.ts'
import { enrollDevice, deviceStatus } from '../lib/enroll.ts'
// @ts-ignore - plain .mjs
import { toBase32, totpAt } from '../../relay/enroll.mjs'
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

const ENROLL_PORT = 9992
const SEED = Buffer.from('harness-totp-seed-20')
function startEnroll(): Promise<void> {
  writeFileSync(join(dir, 'totp.seed'), toBase32(SEED) + '\n')
  return new Promise((ok, fail) => {
    const p = spawn('node', ['enroll.mjs'], { cwd: RELAY_DIR, env: { ...process.env, ALLOW_PEERS: LIST, NETWORK_ID: 'allowlist-test', ENROLL_PORT: String(ENROLL_PORT) } })
    procs.push(p)
    let out = ''
    const t = setTimeout(() => fail(new Error(`the enrolment service did not start:\n${out}`)), 10_000)
    const read = (d: Buffer) => { out += d; relayLog += d; if (out.includes('[ok] enroll on')) { clearTimeout(t); ok() } }
    p.stdout.on('data', read); p.stderr.on('data', read)
  })
}

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
  await startEnroll()
  const EURL = `http://127.0.0.1:${ENROLL_PORT}/onchato/enroll`
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
  await X?.close?.()

  // It enrols with the administrator's code, over HTTP, and then gets in.
  if ((await deviceStatus(EURL, 'allowlist-test', kX))?.listed !== false) throw new Error('the status check did not say "not listed"')
  const wrong = await enrollDevice(EURL, 'allowlist-test', kX, '00000000')
  if (wrong.ok) throw new Error('a wrong code enrolled the device')
  const right = await enrollDevice(EURL, 'allowlist-test', kX, totpAt(SEED, Math.floor(Date.now() / 30000)), 'harness x')
  if (!right.ok) throw new Error(`the right code did not enrol: ${JSON.stringify(right)}`)
  if ((await deviceStatus(EURL, 'allowlist-test', kX))?.listed !== true) throw new Error('enrolled, but the status check says not listed')
  await sleep(2500) // the relay re-reads the list (allowlist.mjs, every 2 s)
  const X2 = await startSession(x.id, { relays: [R], transport: 'light', params, peerKey: kX } as any)
  if (!await until(() => X2.netStatus().connected, 15_000)) throw new Error('an enrolled device was still not let in')
  console.log('  [ok] it enrols with the administrator\'s code (a wrong one refused) and is then let in')
  await X2.close?.()

  // Taken off the list: dropped.
  writeFileSync(LIST, `${netPeerId(kA)} A\n`)
  if (!await until(() => relayLog.includes('is off the list - closing'), 10_000)) throw new Error('a device taken off the list was not dropped')
  console.log('  [ok] a device taken off the list is dropped')
  ok = true
  await A.close?.(); await B.close?.()
} catch (e: any) {
  console.log(`[fail] ${e?.message ?? e}`)
} finally {
  for (const p of procs) p.kill()
  rmSync(dir, { recursive: true, force: true })
  await sleep(300)
  console.log(ok ? 'PASS - the node admits by list' : 'FAIL')
  process.exit(ok ? 0 : 1)
}
