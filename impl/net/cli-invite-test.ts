/**
 * cli-invite-test.ts - an invite that answers itself, between two CLI clients,
 * over the real relays.
 *
 *   node net/cli-invite-test.ts
 *
 * ala hangs up an invite (cli/invites.ts, the app's sealed record) and runs the
 * client; cee has opened that invite - holds ala as a contact and a waiting
 * knock, exactly what `onchato add <invite>` leaves - and runs the client too.
 * Read off the screens: cee's client knocks by itself, ala sees the knock with
 * cee's fingerprint, /accept 1 adds cee, and cee is told the knock was accepted
 * once ala announces. Then they talk.
 */

import { readFileSync } from 'node:fs'
import { browserSoftwareIdentity, localContactBook, localOnlyManager, type Identity } from '../lib/core.ts'
import { runClient } from '../cli/client.ts'
import { InviteStore, type Waiting } from '../cli/invites.ts'
import { fingerprint } from '../cli/fp.ts'
import { cacheBaseOf } from '../lib/localbook.ts'
import { identityKey } from '../cli/profiles.ts'
import type { KV } from '../lib/migrate.ts'
import { VT } from '../test/vt.ts'

const relays = JSON.parse(readFileSync(new URL('../../infra/nodes.json', import.meta.url), 'utf8')).nodes.map((n: any) => n.addr)
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const step = (s: string) => console.log('  - ' + s)
async function until(what: string, cond: () => boolean, ms = 60_000) {
  const t0 = Date.now()
  while (!cond()) { if (Date.now() - t0 > ms) throw new Error('timed out: ' + what); await sleep(150) }
}
const memKV = (): KV => { const m = new Map<string, string>(); return { keys: () => [...m.keys()], get: (k) => m.get(k) ?? null, set: (k, v) => { m.set(k, v) } } }

async function storeFor(id: Identity) {
  const kv = memKV(), kid = await identityKey(id.pub)
  return new InviteStore(kv, await cacheBaseOf(id, kid, kv), kid)
}
async function terminal(id: Identity, contacts: Array<{ name: string; pub: string }>, store: InviteStore) {
  const vt = new VT(24, 120)
  let feed: (s: string) => void = () => {}
  let exited = -1
  let book = contacts.slice()
  await runClient({
    id, kind: 'software', store, relays,
    contacts: localOnlyManager(localContactBook(() => book, (l) => { book = l })),
    io: { out: vt, onInput: (cb) => { feed = cb }, exit: (c) => { exited = c } },
  })
  return { type: (s: string) => feed(s), screen: () => vt.screen().join('\n'), status: () => vt.line(23), exited: () => exited, book: () => book }
}

let failed = false
let dump: () => string = () => ''
try {
  const ala = await browserSoftwareIdentity('ala', () => null, () => {})
  const cee = await browserSoftwareIdentity('cee', () => null, () => {})
  const alaStore = await storeFor(ala), ceeStore = await storeFor(cee)
  const inv = await alaStore.create('biuro')
  // What `onchato add <ala's invite>` leaves behind on cee's side.
  await ceeStore.saveWaiting(new Map<string, Waiting>([[ala.pub, { inbox: inv.secret, name: 'ala', since: Date.now() }]]))

  const A = await terminal(ala, [], alaStore)
  await until('ala listening', () => A.screen().includes('słucham 1 zaproszeń'), 15_000)
  step('ala\'s client listens on her published invite')
  const C = await terminal(cee, [{ name: 'ala', pub: ala.pub }], ceeStore)
  dump = () => '--- ala:\n' + A.screen() + '\n--- cee:\n' + C.screen()
  await until('cee knocking', () => C.screen().includes('pukam do: ala'), 15_000)
  step('cee\'s client resumes the knock by itself')

  const ceeFp = await fingerprint(cee.pub)
  await until('the knock on ala\'s screen, with cee\'s fingerprint', () => A.screen().includes('cee puka') && A.screen().includes(ceeFp), 60_000)
  step(`ala sees "cee puka" with the fingerprint ${ceeFp} and /accept 1`)

  A.type('/accept 1\r')
  await until('cee added on ala\'s side', () => A.screen().includes('dodano cee') && A.book().some((c) => c.pub === cee.pub))
  step('/accept 1 adds cee to ala\'s contacts')
  await until('cee told the knock was accepted', () => C.screen().includes('ala przyjął(a) Twoje pukanie'), 90_000)
  if ((await ceeStore.waiting()).size !== 0) throw new Error('the waiting knock was not cleared after acceptance')
  step('cee is told the knock was accepted, and stops knocking')

  C.type('/query ala\r')
  const msg = 'po zaproszeniu ' + Date.now().toString(36)
  C.type(msg + '\r')
  A.type('/query cee\r')
  await until('the first message reaches ala', () => A.screen().includes('<cee> ' + msg), 90_000)
  step('and they talk')

  A.type('/quit\r'); C.type('/quit\r')
  await until('both exited', () => A.exited() === 0 && C.exited() === 0, 10_000)
  console.log('PASS - an invite that answers itself, CLI to CLI over the real relays')
} catch (e: any) {
  failed = true
  console.error('FAIL - ' + (e?.message ?? e))
  console.error(dump())
}
process.exit(failed ? 1 : 0)
