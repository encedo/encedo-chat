/**
 * cli-files-test.ts - files between CLI clients and through the daemon, over
 * the real relays and the real store (CLI-PLAN.md stage 5).
 *
 *   node net/cli-files-test.ts
 *
 * 1. Two irssi-style clients on emulated terminals: ala `/send`s a file, bob's
 *    screen shows it with its size and `/get` saves it - byte for byte.
 * 2. The daemon: `sendfile` through the socket reaches a second hub, which
 *    saves it - byte for byte.
 * 3. `onchato listen --json --save-files <dir>` as a process, through the
 *    daemon: an incoming file is saved by itself - byte for byte.
 */

import { readFileSync, writeFileSync, mkdtempSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { spawn } from 'node:child_process'
import { browserSoftwareIdentity, localContactBook, localOnlyManager, type Identity } from '../lib/core.ts'
import { runClient } from '../cli/client.ts'
import { Hub } from '../cli/hub.ts'
import { serve, connectDaemon, ask } from '../cli/daemon.ts'
import { VT } from '../test/vt.ts'

const relays = JSON.parse(readFileSync(new URL('../../infra/nodes.json', import.meta.url), 'utf8')).nodes.map((n: any) => n.addr)
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const step = (s: string) => console.log('  - ' + s)
async function until(what: string, cond: () => boolean, ms = 90_000) {
  const t0 = Date.now()
  while (!cond()) { if (Date.now() - t0 > ms) throw new Error('timed out: ' + what); await sleep(200) }
}
const book = (contacts: Array<{ name: string; pub: string }>) => { let b = contacts.slice(); return localOnlyManager(localContactBook(() => b, (l) => { b = l })) }
const dir = mkdtempSync(join(process.env.HOME!, 'ec-logs', 'files-'))
const same = (a: string, b: string) => Buffer.compare(readFileSync(a), readFileSync(b)) === 0

async function terminal(id: Identity, contacts: Array<{ name: string; pub: string }>) {
  const vt = new VT(24, 140)
  let feed: (s: string) => void = () => {}
  let exited = -1
  await runClient({ id, kind: 'software', contacts: book(contacts), relays, io: { out: vt, onInput: (cb) => { feed = cb }, exit: (c) => { exited = c } } })
  return { type: (s: string) => feed(s), screen: () => vt.screen().join('\n'), status: () => vt.line(23), exited: () => exited }
}

let failed = false
let dump = () => ''
try {
  const ala = await browserSoftwareIdentity('ala', () => null, () => {})
  const bob = await browserSoftwareIdentity('bob', () => null, () => {})
  const src = join(dir, 'raport-q3.bin'); writeFileSync(src, randomBytes(150_000))

  // 1 - the interactive clients
  const bobDl = join(dir, 'bob-dl'); process.env.ONCHATO_DOWNLOADS = bobDl
  const A = await terminal(ala, [{ name: 'bob', pub: bob.pub }])
  const B = await terminal(bob, [{ name: 'ala', pub: ala.pub }])
  dump = () => '--- ala:\n' + A.screen() + '\n--- bob:\n' + B.screen()
  A.type('/query bob\r'); B.type('/query ala\r')
  await until('both secured', () => A.status().includes('🔐') && B.status().includes('🔐'), 90_000)
  A.type(`/send ${src}\r`)
  await until('the file on bob\'s screen', () => /📎 raport-q3\.bin \(146 kB\).*\/get [0-9A-Za-z_-]{4}/.test(B.screen()))
  step('/send: bob\'s screen shows "📎 raport-q3.bin (146 kB) - /get id"')
  B.type('/get\r')
  await until('saved on bob\'s side', () => B.screen().includes('zapisano'))
  const got1 = join(bobDl, readdirSync(bobDl)[0])
  if (!same(src, got1)) throw new Error('the file /get saved differs from the one sent')
  step('/get saves it - identical, byte for byte')
  A.type('/quit\r'); B.type('/quit\r')
  await until('clients exited', () => A.exited() === 0 && B.exited() === 0, 10_000)

  // 2 - the daemon
  const sockPath = join(dir, 'd.sock')
  const D = new Hub({ id: ala, contacts: book([{ name: 'bob', pub: bob.pub }]), relays }); await D.start()
  const srv = await serve(D, sockPath)
  const H = new Hub({ id: bob, contacts: book([{ name: 'ala', pub: ala.pub }]), relays })
  const fileIds: string[] = []
  H.on((e) => { if (e.t === 'file') fileIds.push(e.id) })
  await H.start()
  const s = (await connectDaemon(sockPath))!
  const r = await ask(s, { op: 'sendfile', to: 'bob', path: src, wait: 90_000 }); s.destroy()
  if (!r.ok || r.status !== 'delivered') throw new Error('sendfile through the daemon: ' + JSON.stringify(r))
  await until('the file event on bob\'s hub', () => fileIds.length === 1)
  const got2 = await H.getFile(fileIds[0], join(dir, 'hub-dl'))
  if (!same(src, got2)) throw new Error('the daemon\'s file differs')
  step(`daemon sendfile: delivered in ${r.ms} ms, saved by the recipient - identical`)

  // 3 - `onchato listen --json --save-files` through the daemon
  const saveDir = join(dir, 'auto')
  const lines: any[] = []
  const p = spawn('node', [new URL('../cli/onchato.ts', import.meta.url).pathname, 'listen', '--json', '--save-files', saveDir], { env: { ...process.env, ONCHATO_SOCKET: sockPath } })
  let buf = ''
  p.stdout.on('data', (d) => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { const l = buf.slice(0, i); buf = buf.slice(i + 1); try { lines.push(JSON.parse(l)) } catch {} } })
  await sleep(1500)
  const back = join(dir, 'odpowiedz.txt'); writeFileSync(back, 'zażółć gęślą jaźń - odpowiedź\n')
  await H.sendFile('ala', back, 60_000)
  await until('listen saved the file', () => lines.some((l) => l.t === 'saved'))
  const saved = lines.find((l) => l.t === 'saved')
  if (!same(back, saved.path)) throw new Error('the auto-saved file differs')
  if (!lines.some((l) => l.t === 'file' && l.name === 'odpowiedz.txt' && !('key' in l))) throw new Error('the file event is missing, or carries the key')
  step('`onchato listen --json --save-files` saves an incoming file by itself; the event carries no key')
  p.kill()

  srv.close(); await D.close(); await H.close()
  console.log('PASS - files over the real relays and store')
} catch (e: any) {
  failed = true
  console.error('FAIL - ' + (e?.message ?? e))
  console.error(dump())
}
process.exit(failed ? 1 : 0)
