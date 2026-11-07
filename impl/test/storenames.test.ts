/**
 * Storage names that say nothing (lib/storenames.ts, SPEC.md 10).
 *
 * What must hold: no name carries the KID, a group id or a room id; only the
 * identity can compute its names, and computes the same ones every time and
 * in every client; and the 0.8.0 move to the current name key loses nothing.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from '../lib/wc.ts'
import { namesFor, namesFromKey, migrateNamesKey, pinName, FIXED, NAMES_LABEL_PRE_080 } from '../lib/storenames.ts'
import { deriveOverEcdh } from '../lib/derive.ts'
import { browserSoftwareIdentity } from '../lib/core.ts'

const KID = '5954eb6d5a1dd906ec78fe9dae5645e3'
const OTHER = '0123456789abcdef0123456789abcdef'
const PEER = 'iv3Q1qyn2LhfwPVy7UvnKi/f0yiqZLeY4GALWq5ilzA='
const GID = '00112233445566778899aabbccddeeff'
const mem = (seed: Record<string, string> = {}) => {
  const m = new Map(Object.entries(seed))
  return { m, keys: () => [...m.keys()], get: (k: string) => m.get(k) ?? null, set: (k: string, v: string) => { m.set(k, v) }, remove: (k: string) => { m.delete(k) } }
}

test('a name is the identity\'s tag and a tag of its own, and carries no KID, room or group', async () => {
  const n = await namesFromKey(randomBytes(32), KID)
  assert.match(n.prefix, /^ec-[0-9a-f]{16}-$/)
  const all = [...Object.values(n.fixed), await n.scoped('pin', PEER), await n.scoped('group', GID), await n.scoped('pin', GID)]
  assert.equal(new Set(all).size, all.length, 'no two records share a name')
  for (const name of all) {
    assert.match(name, /^ec-[0-9a-f]{16}-[0-9a-f]{32}$/, name)
    assert.ok(name.startsWith(n.prefix))
    for (const leak of [KID, KID.slice(0, 8), GID.slice(0, 8), PEER.slice(0, 8)]) assert.ok(!name.includes(leak), `${name} carries ${leak}`)
  }
  assert.deepEqual(Object.keys(n.fixed).sort(), [...FIXED].sort())
})

test('only the identity computes its names: the same every time, different for another identity', async () => {
  const a = await browserSoftwareIdentity('a', () => null, () => {})
  const b = await browserSoftwareIdentity('b', () => null, () => {})
  const na1 = await namesFor(a, KID), na2 = await namesFor(a, KID), nb = await namesFor(b, OTHER)
  assert.deepEqual(na1.fixed, na2.fixed)
  assert.equal(await na1.scoped('pin', PEER), await na2.scoped('pin', PEER))
  assert.notEqual(nb.prefix, na1.prefix)
  assert.notEqual(nb.fixed.book, na1.fixed.book)
  // the names hang off IK, not off anything public: the public key and the KID are the same here
  const fake = await namesFromKey(randomBytes(32), KID)
  assert.notEqual(fake.prefix, na1.prefix)
})

test('0.8.2: the markers of the removed migrations are deleted at sign-in, and a KID-carrying name is nobody\'s any more', async () => {
  let saved: string | null = null
  const id = await browserSoftwareIdentity('o', () => saved, (v) => { saved = v })
  const n = await namesFor(id, KID)
  assert.equal(n.obsolete.length, 2, "'book-signed' and 'sealed'")
  for (const o of n.obsolete) assert.ok(o.startsWith(n.prefix) && !Object.values(n.fixed).includes(o))
  const kv = mem({ [n.obsolete[0]]: '1', [n.obsolete[1]]: '1', [n.fixed.moved]: '1', [`ec-local-contacts-${KID}`]: 'OLD' })
  await migrateNamesKey(kv, id, n)
  for (const o of n.obsolete) assert.equal(kv.get(o), null, 'the marker is gone')
  assert.equal(kv.get(`ec-local-contacts-${KID}`), 'OLD', 'a pre-0.7.34 name is not read, moved or touched (0.8.2)')
})

test('the group index is sealed, keeps one entry per group, and goes when it is empty', async () => {
  const n = await namesFromKey(randomBytes(32), KID)
  const kv = mem()
  await n.setGroups(kv, [GID, GID, 'ff'.repeat(16)])
  const raw = kv.get(n.fixed.groups)!
  assert.ok(!raw.includes(GID) && !raw.includes('ffff'), 'no group id in the clear')
  assert.deepEqual(await n.groups(kv), [GID, 'ff'.repeat(16)])
  assert.deepEqual(await (await namesFromKey(randomBytes(32), KID)).groups(kv), [], 'another key reads nothing')
  await n.setGroups(kv, [])
  assert.equal(kv.get(n.fixed.groups), null)
})

test('0.8.0: every record moves from the old name key to the new one, the group index re-sealed, pins when their room opens', async () => {
  let saved: string | null = null
  const id = await browserSoftwareIdentity('m', () => saved, (v) => { saved = v })
  const ctx = new TextEncoder().encode('local storage names')
  const oldNk = await deriveOverEcdh(id.ecdh)(NAMES_LABEL_PRE_080, id.pub, ctx, 32)
  const old = await namesFromKey(oldNk, KID)
  const kv = mem()
  kv.set(old.fixed.emp, 'EMP'); kv.set(old.fixed.book, 'BOOK'); kv.set(old.fixed.prefs, 'PREFS')
  kv.set(await old.scoped('group', GID), 'GROUP')
  await old.setGroups(kv, [GID])
  kv.set(await old.scoped('pin', PEER), 'PIN')
  kv.set('ec-soft-id-m', 'PROFILE') // not this identity's record: never touched

  const names = await namesFor(id, KID)
  assert.notEqual(names.prefix, old.prefix, 'the label moved, so did the names')
  const r = await migrateNamesKey(kv, id, names)
  assert.equal(r.moved, 4, 'emp, book, prefs and the group')
  assert.equal(kv.get(names.fixed.emp), 'EMP'); assert.equal(kv.get(names.fixed.book), 'BOOK'); assert.equal(kv.get(names.fixed.prefs), 'PREFS')
  assert.equal(kv.get(await names.scoped('group', GID)), 'GROUP')
  assert.deepEqual(await names.groups(kv), [GID], 'the index opens under the new key')
  assert.equal(kv.get('ec-soft-id-m'), 'PROFILE')
  assert.ok(r.legacy, 'a pin is left, so the old names are handed back')
  assert.equal(kv.get(names.fixed.moved), null, 'not done while a record is left')

  const pin = await pinName(kv, names, PEER, r.legacy)
  assert.equal(kv.get(pin), 'PIN', 'the pin moves when its room asks for it')
  assert.equal(kv.keys().filter((k) => k.startsWith(old.prefix)).length, 0, 'nothing left under the old names')

  const again = await migrateNamesKey(kv, id, names)
  assert.deepEqual(again, { moved: 0, legacy: null })
  assert.equal(kv.get(names.fixed.moved), '1', 'done, and recorded')
  let asked = 0
  const counting = { ...id, ecdh: async (p: string) => { asked++; return id.ecdh(p) } }
  await migrateNamesKey(kv, counting, names)
  assert.equal(asked, 0, 'once recorded, no ECDH is spent on it again')
})

test('0.8.0: an identity that refuses a raw ECDH (a HEM without the policy) has nothing to move, and says so once', async () => {
  const id = await browserSoftwareIdentity('h', () => null, () => {})
  const names = await namesFor(id, KID)
  const kv = mem()
  const refusing = { ...id, ecdh: async () => { throw Object.assign(new Error('403'), { code: 'http_403' }) } }
  assert.deepEqual(await migrateNamesKey(kv, refusing, names), { moved: 0, legacy: null })
  assert.equal(kv.get(names.fixed.moved), '1')
})
