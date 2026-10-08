/**
 * cli-group-test.ts - a group between three CLI clients over the real relays
 * (CLI-PLAN.md stage 6).
 *
 *   node net/cli-group-test.ts
 *
 * ala, bob and cee are mutual contacts, each in an emulated terminal. Read off
 * the screens: /group new makes the group and the invitations reach bob and cee
 * by themselves; a message from each member reaches the others; "@ala" from bob
 * is a mention on ala's side; /who lists the members with the admin; and after
 * ala's client restarts, the group comes back from the sealed cache and still
 * carries messages both ways.
 */

import { readFileSync } from 'node:fs'
import { browserSoftwareIdentity, localContactBook, localOnlyManager, type Identity } from '../lib/core.ts'
import { runClient } from '../cli/client.ts'
import { cacheBaseOf } from '../lib/localbook.ts'
import { identityKey } from '../cli/profiles.ts'
import type { KV } from '../lib/migrate.ts'
import { VT } from '../test/vt.ts'
import { enableProtoLog } from '../lib/protolog.ts'
import { appendFileSync } from 'node:fs'
if (process.env.DEBUG === '2') {
  const f = process.env.HOME + '/ec-logs/group-wire.log'
  // In memory, written only on failure: a file write per line shifted the timing
  // enough that the race stopped reproducing.
  const trace: string[] = []
  ;(globalThis as any).__dumpTrace = () => appendFileSync(f, trace.join('\n') + '\n')
  enableProtoLog({ events: true, wire: true, sink: (l) => { trace.push(`${Date.now() % 1_000_000} ${l}`); if (trace.length > 300_000) trace.splice(0, 50_000) } })
}

const relays = JSON.parse(readFileSync(new URL('../../infra/nodes.json', import.meta.url), 'utf8')).nodes.map((n: any) => n.addr)
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const step = (s: string) => console.log('  - ' + s)
async function until(what: string, cond: () => boolean, ms = 120_000) {
  const t0 = Date.now()
  while (!cond()) { if (Date.now() - t0 > ms) throw new Error('timed out: ' + what); await sleep(250) }
}
const memKV = (): KV => { const m = new Map<string, string>(); return { keys: () => [...m.keys()], get: (k) => m.get(k) ?? null, set: (k, v) => { m.set(k, v) } } }

async function vaultFor(id: Identity) { const kv = memKV(), kid = await identityKey(id.pub); return { kv, kid, base: await cacheBaseOf(id, kid, kv) } }
async function terminal(id: Identity, contacts: Array<{ name: string; pub: string }>, vault: any) {
  const vt = new VT(26, 150)
  let feed: (s: string) => void = () => {}
  let exited = -1
  let book = contacts.slice()
  const c = await runClient({
    id, kind: 'software', relays, vault, debug: !!process.env.DEBUG,
    contacts: localOnlyManager(localContactBook(() => book, (l) => { book = l })),
    io: { out: vt, onInput: (cb) => { feed = cb }, exit: (x) => { exited = x } },
  })
  const all = () => c.windows.list().flatMap((wn) => wn.lines.map((l: string) => l.replace(/\x1b\[[0-9;]*m/g, ''))).join('\n')
  return { type: (s: string) => feed(s), screen: () => (process.env.DEBUG ? all().split('\n').slice(-120).join('\n') : vt.screen().join('\n')), status: () => vt.line(25), exited: () => exited, windows: c.windows }
}

let failed = false
let dump = () => ''
try {
  const [ala, bob, cee] = await Promise.all(['ala', 'bob', 'cee'].map((n) => browserSoftwareIdentity(n, () => null, () => {})))
  const book = (me: Identity) => [ala, bob, cee].filter((x) => x !== me).map((x) => ({ name: x.handle, pub: x.pub }))
  const vA = await vaultFor(ala), vB = await vaultFor(bob), vC = await vaultFor(cee)
  let A = await terminal(ala, book(ala), vA)
  const B = await terminal(bob, book(bob), vB)
  const C = await terminal(cee, book(cee), vC)
  dump = () => ['ala', A, 'bob', B, 'cee', C].map((x) => typeof x === 'string' ? `--- ${x}:` : (x as any).screen()).join('\n')
  await until('presence on ala', () => / 1\) ● /.test(A.screen()) && / 2\) ● /.test(A.screen()), 60_000)
  step('three clients up, mutual contacts online')

  A.type('/group new zespol bob cee\r')
  await until('the group window on ala', () => A.status().includes(':zespol'))
  await until('bob joined', () => B.screen().includes('dołączono do grupy „zespol”'))
  await until('cee joined', () => C.screen().includes('dołączono do grupy „zespol”'))
  step('/group new: the invitations reach bob and cee by themselves')

  const m1 = 'witajcie ' + Date.now().toString(36)
  A.type(m1 + '\r')
  B.type('/query zespol\r'); C.type('/query zespol\r')
  await until('ala\'s message on bob and cee', () => B.screen().includes('<ala> ' + m1) && C.screen().includes('<ala> ' + m1))
  step('a message from the admin reaches both members')

  A.type('\x1b1')                                                // ala looks at status
  B.type('@ala dzięki za zaproszenie\r')
  await until('the mention on ala\'s side', () => A.windows.activity().some((a) => a.activity === 'mention'))
  step('"@ala" from bob lights ala\'s status line as a MENTION (not just activity)')

  const m3 = 'cee tu ' + Date.now().toString(36)
  C.type(m3 + '\r')
  await until('cee on ala and bob', () => B.screen().includes('<cee> ' + m3) && A.windows.list().some((wn) => wn.kind === 'group' && wn.lines.some((l) => l.replace(/\x1b\[[0-9;]*m/g, '').includes('<cee> ' + m3))))
  step('a message from the third member reaches the other two')

  A.type('/query zespol\r'); A.type('/who\r')
  await until('/who lists the members', () => /bob/.test(A.screen()) && /cee/.test(A.screen()) && A.screen().includes('admin'))
  step('/who: three members, the admin marked')

  A.type('/quit\r')
  await until('ala exited', () => A.exited() === 0, 15_000)
  await sleep(2000)
  A = await terminal(ala, book(ala), vA)
  await until('the group restored on ala', () => A.screen().includes('grupy: „zespol”'), 30_000)
  A.type('/query zespol\r')
  const m4 = 'po restarcie ' + Date.now().toString(36)
  A.type(m4 + '\r')
  await until('after the restart ala still reaches bob', () => B.screen().includes('<ala> ' + m4))
  const m5 = 'i z powrotem ' + Date.now().toString(36)
  B.type(m5 + '\r')
  await until('and bob still reaches ala', () => A.screen().includes('<bob> ' + m5))
  step('ala restarted: the group came back from the sealed cache and carries messages both ways')

  for (const x of [A, B, C]) x.type('/quit\r')
  await until('all exited', () => [A, B, C].every((x) => x.exited() === 0), 15_000)
  console.log('PASS - a group between three CLI clients over the real relays')
} catch (e: any) {
  failed = true
  console.error('FAIL - ' + (e?.message ?? e))
  console.error(dump())
  ;(globalThis as any).__dumpTrace?.()
}
process.exit(failed ? 1 : 0)
