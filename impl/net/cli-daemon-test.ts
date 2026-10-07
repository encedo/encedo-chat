/**
 * cli-daemon-test.ts - the script mode and the daemon over the real relays.
 *
 *   node net/cli-daemon-test.ts
 *
 * ala runs the daemon (Hub + socket, in-process, on a temporary socket); bob is
 * a second Hub. Checked: send through the socket (delivered), listen through
 * the socket (bob's message arrives as a JSON line), a send to an offline bob
 * (queued) that reaches him by itself when he comes back - while the daemon
 * runs - and the real `onchato send` command as a separate process, both
 * through the daemon and without one (its own short session, its own profile).
 */

import { readFileSync, mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { browserSoftwareIdentity, localContactBook, localOnlyManager, type Identity } from '../lib/core.ts'
import { Hub, type HubEvent } from '../cli/hub.ts'
import { serve, connectDaemon, ask, lineReader } from '../cli/daemon.ts'
import { fileKV } from '../cli/store.ts'
import { createProfile, identityKey } from '../cli/profiles.ts'
import { openLocalBook, cacheBaseOf } from '../lib/localbook.ts'

const relays = JSON.parse(readFileSync(new URL('../../infra/nodes.json', import.meta.url), 'utf8')).nodes.map((n: any) => n.addr)
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const step = (s: string) => console.log('  - ' + s)
async function until(what: string, cond: () => boolean, ms = 60_000) {
  const t0 = Date.now()
  while (!cond()) { if (Date.now() - t0 > ms) throw new Error('timed out: ' + what); await sleep(150) }
}
const hubFor = (id: Identity, contacts: Array<{ name: string; pub: string }>) => {
  let book = contacts.slice()
  return new Hub({ id, relays, contacts: localOnlyManager(localContactBook(() => book, (l) => { book = l })) })
}
const PW = 'kot pies dom lampa'
const dir = mkdtempSync(join(process.env.HOME!, 'ec-logs', 'daemon-'))
const sockPath = join(dir, 'onchato.sock')
// Async on purpose: the daemon runs in THIS process, and a synchronous spawn
// would block the very event loop that has to answer the child's socket.
const cli = (args: string[], env: Record<string, string>) => new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve) => {
  const p = spawn('node', [new URL('../cli/onchato.ts', import.meta.url).pathname, ...args], { env: { ...process.env, ...env } })
  let stdout = '', stderr = ''
  p.stdout.on('data', (d) => { stdout += d }); p.stderr.on('data', (d) => { stderr += d })
  const t = setTimeout(() => p.kill(), 90_000)
  p.on('close', (status) => { clearTimeout(t); resolve({ status, stdout, stderr }) })
})

let failed = false
try {
  const ala = await browserSoftwareIdentity('ala', () => null, () => {})
  const bob = await browserSoftwareIdentity('bob', () => null, () => {})
  // cee: a real CLI profile on disk, for `onchato send` without a daemon.
  const ceeHome = join(dir, 'cee')
  const ceeKV = fileKV(ceeHome)
  const cee = await createProfile(ceeKV, 'cee', PW)
  const ceeKey = await identityKey(cee.pub)
  const { book: ceeBook } = await openLocalBook(ceeKey, ceeKV, await cacheBaseOf(cee, ceeKey, ceeKV))
  await ceeBook.add('bob', bob.pub); await sleep(150)

  const A = hubFor(ala, [{ name: 'bob', pub: bob.pub }])
  await A.start()
  const srv = await serve(A, sockPath)
  let B = hubFor(bob, [{ name: 'ala', pub: ala.pub }, { name: 'cee', pub: cee.pub }])
  let bobGot: string[] = []
  B.on((e) => { if (e.t === 'msg') bobGot.push(e.text) })
  await B.start()
  step('daemon (ala) on its socket, bob on a second hub')

  const s1 = (await connectDaemon(sockPath))!
  const r1 = await ask(s1, { op: 'send', to: 'bob', text: 'przez demona', wait: 60_000 }); s1.end()
  if (r1.status !== 'delivered') throw new Error('send through the daemon: ' + JSON.stringify(r1))
  await until('bob got it', () => bobGot.includes('przez demona'))
  step(`send through the socket: delivered in ${r1.ms} ms`)

  const s2 = (await connectDaemon(sockPath))!
  const heard: HubEvent[] = []
  s2.on('data', lineReader((o) => { if (o.t) heard.push(o) }))
  s2.write(JSON.stringify({ op: 'listen' }) + '\n')
  await sleep(300)
  await B.send('ala', 'do ala', 60_000)
  await until('the message on the listen stream', () => heard.some((e) => e.t === 'msg' && e.text === 'do ala' && e.from === 'bob'))
  s2.end()
  step('listen through the socket: bob\'s message arrives as a JSON line')

  const r3 = await cli(['send', 'bob', 'z procesu', '--json'], { ONCHATO_SOCKET: sockPath, ONCHATO_HOME: join(dir, 'nobody') })
  const j3 = JSON.parse(r3.stdout.trim() || '{}')
  if (r3.status !== 0 || j3.status !== 'delivered' || j3.via !== 'daemon') throw new Error(`onchato send via daemon: rc ${r3.status} ${r3.stdout} ${r3.stderr}`)
  await until('bob got the process message', () => bobGot.includes('z procesu'))
  step('`onchato send … --json` as a process hands off to the daemon: exit 0, delivered')

  await B.close()
  await sleep(2000)
  const s4 = (await connectDaemon(sockPath))!
  const r4 = await ask(s4, { op: 'send', to: 'bob', text: 'gdy wrócisz', wait: 5_000 }); s4.end()
  if (r4.status !== 'queued') throw new Error('expected queued for an offline bob: ' + JSON.stringify(r4))
  step('bob offline: queued (exit 3 for the command)')
  B = hubFor(bob, [{ name: 'ala', pub: ala.pub }, { name: 'cee', pub: cee.pub }])
  bobGot = []
  B.on((e) => { if (e.t === 'msg') bobGot.push(e.text) })
  await B.start()
  await until('the queued message reaches bob when he is back', () => bobGot.includes('gdy wrócisz'), 120_000)
  step('bob back online: the queued message reaches him by itself')

  const r5 = await cli(['send', 'bob', 'bez demona', '--json', '--wait', '60'], { ONCHATO_SOCKET: join(dir, 'none.sock'), ONCHATO_HOME: ceeHome, ONCHATO_PASSWORD: PW })
  const j5 = JSON.parse(r5.stdout.trim() || '{}')
  if (r5.status !== 0 || j5.status !== 'delivered' || j5.via !== 'direct') throw new Error(`onchato send without a daemon: rc ${r5.status} ${r5.stdout} ${r5.stderr}`)
  await until('bob got the direct message', () => bobGot.includes('bez demona'))
  step('`onchato send` with no daemon: its own short session, exit 0, delivered')

  srv.close(); await A.close(); await B.close()
  console.log('PASS - script mode and daemon over the real relays')
} catch (e: any) {
  failed = true
  console.error('FAIL - ' + (e?.message ?? e))
}
process.exit(failed ? 1 : 0)
