import { test } from 'node:test'
import assert from 'node:assert/strict'
import { KnockDesk, type Knock } from '../cli/knocks.ts'
import { newInboxSecret } from '../lib/invite.ts'
import { fingerprint } from '../cli/fp.ts'

const key = (b: number) => btoa(String.fromCharCode(...new Uint8Array(32).fill(b)))

function rig(o: { contacts?: Array<{ name: string; pub: string }>; knockEveryMs?: number } = {}) {
  const inv = { id: 'i1', label: 'biuro', secret: newInboxSecret(), created: 0 }
  let waiting = new Map<string, any>()
  const ignored: Array<{ fp: string; at: number }> = []
  const store: any = {
    invites: async () => [inv],
    waiting: async () => new Map(waiting),
    saveWaiting: async (m: Map<string, any>) => { waiting = new Map(m) },
    ignored: async () => [...ignored],
    ignore: async (fp: string) => { ignored.push({ fp, at: 0 }) },
  }
  const knocked: string[] = []
  const session: any = {
    watchInbox: () => ({ stop() {} }),
    knock: async (_raw: Uint8Array, k: string) => { knocked.push(k); return 1 },
  }
  const contacts: any[] = [...(o.contacts ?? [])]
  const seen: { knock: Knock[]; known: string[]; accepted: string[] } = { knock: [], known: [], accepted: [] }
  const desk = new KnockDesk({
    session, store, me: { handle: 'bot' }, contacts: () => contacts,
    addContact: async (name, pub) => { const c = { name, pub, source: 'local' }; contacts.push(c); return c },
    on: { knock: (k) => seen.knock.push(k), knownKnock: (c) => seen.known.push(c.name), accepted: (c) => seen.accepted.push(c?.name ?? '?') },
    knockEveryMs: o.knockEveryMs, invitesEveryMs: 3_600_000,
  })
  return { desk, inv, store, contacts, seen, knocked, waiting: () => waiting, ignored }
}

test('a knock is held with its fingerprint; accepting adds the contact, once', async () => {
  const r = rig(); await r.desk.start()
  await r.desk.onKnock(r.inv, key(7), 'Ewa', 'z biura')
  await r.desk.onKnock(r.inv, key(7), 'Ewa', 'z biura')          // the app re-knocks every 90 s
  assert.equal(r.seen.knock.length, 1, 'said once')
  assert.equal(r.seen.knock[0].fp, await fingerprint(key(7)))
  const { contact } = await r.desk.accept(1)
  assert.deepEqual([contact.name, contact.pub], ['Ewa', key(7)])
  assert.equal(r.desk.list().length, 0)
  await assert.rejects(r.desk.accept(1), /nie ma pukania nr 1/)
  await r.desk.onKnock(r.inv, key(7), 'Ewa', '')
  assert.deepEqual(r.seen.known, ['Ewa'], 'now a contact: told, not held')
  r.desk.stop()
})

test('ignoring dismisses that key for good; other keys still knock', async () => {
  const r = rig(); await r.desk.start()
  await r.desk.onKnock(r.inv, key(8), 'Spam', '')
  const k = await r.desk.ignore(1)
  assert.equal(r.ignored[0].fp, k.fp)
  await r.desk.onKnock(r.inv, key(8), 'Spam', '')
  await r.desk.onKnock(r.inv, key(9), 'Ola', '')
  assert.deepEqual(r.seen.knock.map((x) => x.name), ['Spam', 'Ola'])
  assert.equal(r.contacts.length, 0, 'ignoring adds nobody')
  r.desk.stop()
})

test('our knock repeats until they appear, and appearing ends it', async () => {
  const r = rig({ knockEveryMs: 20 }); await r.desk.start()
  const theirs = { pub: key(5), name: 'Kuba', inbox: newInboxSecret(), key: key(6) }
  await r.desk.knockInvite(theirs, 'Kuba', 'bot')
  assert.ok(r.waiting().has(key(5)), 'the waiting record is saved')
  await new Promise((res) => setTimeout(res, 90))
  const n = r.knocked.length
  assert.ok(n >= 3, `knocked again on the timer (${n})`)
  r.contacts.push({ name: 'Kuba', pub: key(5) })
  assert.equal(r.desk.online(key(5)), true)
  assert.deepEqual(r.seen.accepted, ['Kuba'])
  assert.equal(r.waiting().has(key(5)), false)
  await new Promise((res) => setTimeout(res, 60))
  assert.equal(r.knocked.length, n, 'no knocking after they accepted')
  assert.equal(r.desk.online(key(5)), false, 'only the first appearance counts')
  r.desk.stop()
})

test('a link without an inbox has nothing to knock on', async () => {
  const r = rig(); await r.desk.start()
  await assert.rejects(r.desk.knockInvite({ pub: key(1), name: 'x' }, 'x'), /nie ma skrzynki/)
  r.desk.stop()
})
