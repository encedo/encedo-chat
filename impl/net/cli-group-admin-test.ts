/**
 * cli-group-admin-test.ts - the group admin's commands and a script sending to
 * a group, over the real relays (CLI-PLAN.md stage 6).
 *
 *   node net/cli-group-admin-test.ts
 *
 * ala (admin) and bob in emulated terminals; cee is a script: a Hub with the
 * daemon on a socket, as `onchato daemon` runs it. Read off the screens and the
 * hub's events: /group new with bob; /add cee reaches cee's hub as a `group`
 * event and ala's words as `msg` events carrying the group; `send <group>`
 * through the daemon reaches ala's screen (status 'sent' - a group has no acks);
 * /kick bob opens a new epoch: cee still reads ala, bob reads nothing of it;
 * /rename reaches cee, and the script sends under the new name.
 */

import { readFileSync, mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { browserSoftwareIdentity, localContactBook, localOnlyManager, type Identity } from '../lib/core.ts'
import { runClient } from '../cli/client.ts'
import { Hub, type HubEvent } from '../cli/hub.ts'
import { serve, connectDaemon, ask } from '../cli/daemon.ts'
import { cacheBaseOf } from '../lib/localbook.ts'
import { identityKey } from '../cli/profiles.ts'
import type { KV } from '../lib/migrate.ts'
import { VT } from '../test/vt.ts'

const relays = JSON.parse(readFileSync(new URL('../../infra/nodes.json', import.meta.url), 'utf8')).nodes.map((n: any) => n.addr)
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const step = (s: string) => console.log('  - ' + s)
async function until(what: string, cond: () => boolean, ms = 120_000) {
  const t0 = Date.now()
  while (!cond()) { if (Date.now() - t0 > ms) throw new Error('timed out: ' + what); await sleep(250) }
}
const memKV = (): KV => { const m = new Map<string, string>(); return { keys: () => [...m.keys()], get: (k) => m.get(k) ?? null, set: (k, v) => { m.set(k, v) } } }
const plain = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '')
const book = (contacts: Array<{ name: string; pub: string }>) => { let b = contacts.slice(); return localOnlyManager(localContactBook(() => b, (l) => { b = l })) }

async function vaultFor(id: Identity) { const kv = memKV(), kid = await identityKey(id.pub); return { kv, kid, base: await cacheBaseOf(id, kid, kv) } }
async function terminal(id: Identity, contacts: Array<{ name: string; pub: string }>, debug = false) {
  const vt = new VT(26, 150)
  let feed: (s: string) => void = () => {}
  let exited = -1
  const c = await runClient({
    id, kind: 'software', relays, debug, vault: await vaultFor(id), contacts: book(contacts),
    io: { out: vt, onInput: (cb) => { feed = cb }, exit: (x) => { exited = x } },
  })
  // Every line of every window, so a background window counts too.
  const all = () => c.windows.list().flatMap((wn) => wn.lines.map(plain)).join('\n')
  return { type: (s: string) => feed(s), screen: () => vt.screen().join('\n'), all, status: () => vt.line(25), exited: () => exited }
}

let failed = false
let dump = () => ''
try {
  const [ala, bob, cee] = await Promise.all(['ala', 'bob', 'cee'].map((n) => browserSoftwareIdentity(n, () => null, () => {})))
  console.log(`  (ala ${ala.pub.slice(0, 8)}, bob ${bob.pub.slice(0, 8)}, cee ${cee.pub.slice(0, 8)})`)
  const contactsOf = (me: Identity) => [ala, bob, cee].filter((x) => x !== me).map((x) => ({ name: x.handle, pub: x.pub }))
  const A = await terminal(ala, contactsOf(ala), !!process.env.DEBUG)
  const B = await terminal(bob, contactsOf(bob), !!process.env.DEBUG)
  const ev: HubEvent[] = []
  const clog: string[] = []
  const C = new Hub({ id: cee, contacts: book(contactsOf(cee)), relays, vault: await vaultFor(cee), log: (m) => clog.push(new Date().toISOString().slice(11, 19) + ' ' + m) })
  C.on((e) => ev.push(e))
  await C.start()
  const sockPath = join(mkdtempSync(join(process.env.HOME!, 'ec-logs', 'gadmin-')), 'd.sock')
  const srv = await serve(C, sockPath)
  const req = async (o: unknown) => { const s = (await connectDaemon(sockPath))!; const r = await ask(s, o); s.destroy(); return r }
  const gotC = (text: string, group: string) => ev.some((e) => e.t === 'msg' && e.text === text && e.group === group)
  dump = () => '--- ala:\n' + (process.env.DEBUG ? A.all().split('\n').slice(-80).join('\n') : A.screen()) + '\n--- bob:\n' + (process.env.DEBUG ? B.all().split('\n').slice(-80).join('\n') : B.screen()) + '\n--- cee events:\n' + ev.map((e) => JSON.stringify(e)).join('\n') + '\n--- cee log:\n' + clog.slice(-60).join('\n')
  await until('presence on ala', () => / 1\) ● /.test(A.screen()) && / 2\) ● /.test(A.screen()), 60_000)
  step('ala and bob in terminals, cee a script behind the daemon; all online')

  A.type('/group new zespol bob\r')
  await until('bob joined', () => B.all().includes('dołączono do grupy „zespol”'))
  step('/group new zespol bob: bob joined')

  A.type('/add cee\r')
  await until('ala says cee was added', () => A.all().includes('dodano cee'))
  await until('cee\'s hub joined', () => ev.some((e) => e.t === 'group' && e.name === 'zespol'))
  await until('bob saw the roster change', () => /zespol”: zmiana \(.*skład.*\) - 3 osób/.test(B.all()))
  const m1 = 'po dodaniu ' + Date.now().toString(36)
  A.type(m1 + '\r')
  await until('ala\'s message on bob and cee', () => B.all().includes('<ala> ' + m1) && gotC(m1, 'zespol'))
  step('/add cee: new epoch; cee\'s hub gets a `group` event, then ala\'s words as `msg` with group "zespol"; bob still reads')

  const s1 = 'ze skryptu ' + Date.now().toString(36)
  const r1 = await req({ op: 'send', to: 'zespol', text: s1, wait: 5000 })
  if (!r1.ok || r1.status !== 'sent') throw new Error('daemon send to a group: ' + JSON.stringify(r1))
  await until('the script\'s message on ala', () => A.all().includes('<cee> ' + s1))
  // A frame that beats the sender's key to a member is dropped there, and only
  // asks for the key (lib/group.ts, §8 repair) - cee's 1:1 with bob may be
  // seconds old. So one more message, which the repaired key must open.
  let note = ''
  try { await until('the script\'s message on bob', () => B.all().includes('<cee> ' + s1), 20_000) }
  catch {
    const s1b = 'ponownie ' + Date.now().toString(36)
    await req({ op: 'send', to: 'zespol', text: s1b, wait: 5000 })
    await until('the second script message on bob', () => B.all().includes('<cee> ' + s1b), 60_000)
    note = ' (bob: the first frame beat cee\'s key and was dropped; the repaired key opened the next)'
  }
  step('daemon `send zespol`: status "sent", the message on both terminals' + note)

  A.type('/kick bob\r')
  await until('ala says bob was removed', () => A.all().includes('usunięto bob'))
  await until('cee sees the new roster', () => ev.filter((e) => e.t === 'msg').length >= 1 && C.groups!.byName('zespol')!.members.length === 2)
  const m2 = 'bez boba ' + Date.now().toString(36)
  A.type(m2 + '\r')
  await until('ala\'s message on cee after the kick', () => gotC(m2, 'zespol'))
  await sleep(15_000)
  if (B.all().includes(m2)) throw new Error('bob, removed, still read the new epoch')
  step('/kick bob: new epoch - cee reads ala, bob (15 s later) has read nothing of it')

  A.type('/rename ekipa\r')
  await until('ala renamed', () => A.all().includes('nazwa grupy: „ekipa”'))
  await until('cee\'s hub knows the new name', () => !!C.groups!.byName('ekipa'))
  const s2 = 'nowa nazwa ' + Date.now().toString(36)
  const r2 = await req({ op: 'send', to: 'ekipa', text: s2, wait: 5000 })
  if (r2.status !== 'sent') throw new Error('send to the renamed group: ' + JSON.stringify(r2))
  await until('the script under the new name reaches ala', () => A.all().includes('<cee> ' + s2))
  step('/rename ekipa: cee\'s hub has the new name and `send ekipa` reaches ala')

  const bad = await req({ op: 'send', to: 'zespol', text: 'x', wait: 2000 })
  if (bad.ok) throw new Error('the old name still resolves: ' + JSON.stringify(bad))
  step('the old name no longer resolves: ' + bad.error)

  for (const x of [A, B]) x.type('/quit\r')
  await until('clients exited', () => [A, B].every((x) => x.exited() === 0), 15_000)
  srv.close(); await C.close()
  console.log('PASS - group admin commands and a script sending to a group, over the real relays')
} catch (e: any) {
  failed = true
  console.error('FAIL - ' + (e?.message ?? e))
  console.error(dump())
}
process.exit(failed ? 1 : 0)
