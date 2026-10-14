/**
 * Storage names that say nothing (lib/storenames.ts, SPEC.md 10).
 *
 * What must hold: no name carries the KID, a group id or a room id; only the
 * identity can compute its names, and computes the same ones every time and
 * in every client; and the move off the old names loses nothing and leaves
 * nothing behind that still names the identity.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from '../lib/wc.ts'
import { namesFor, namesFromKey, migrateToNames, FIXED } from '../lib/storenames.ts'
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

test('every record moves off its KID-carrying name with its value intact, and the old names are gone', async () => {
  const legacy = {
    [`ec-gcache-emp-${KID}`]: 'EMP', [`ec-local-contacts-${KID}`]: 'BOOK', [`ec-local-contacts-${KID}-signed`]: '1',
    [`ec-sealed-${KID}`]: '1', [`ec-invites-${KID}`]: 'INV', [`ec-waiting-${KID}`]: 'WAIT', [`ec-ignored-${KID}`]: 'IGN',
    [`ec-outbox-${KID}`]: 'OUT', [`ec-prefs-${KID}`]: 'PREFS', [`ec-seen-${KID}`]: 'SEEN', [`ec-gleft-${KID}`]: 'LEFT',
    [`ec-gcache-${KID}-${GID}`]: 'GROUP', [`ec-pins-${KID}-${PEER}`]: 'PINS1', [`ec-pins-${KID}-${GID}`]: 'PINS2',
  }
  const kv = mem({ ...legacy, [`ec-local-contacts-${OTHER}`]: 'CUDZA', 'ec-soft-id-ala': 'ID', 'ec-lang': 'pl' })
  const n = await namesFromKey(randomBytes(32), KID)
  assert.equal(await migrateToNames(kv, n), Object.keys(legacy).length)
  const want: Record<string, string> = {
    [n.fixed.emp]: 'EMP', [n.fixed.book]: 'BOOK', [n.fixed['book-signed']]: '1', [n.fixed.sealed]: '1',
    [n.fixed.invites]: 'INV', [n.fixed.waiting]: 'WAIT', [n.fixed.ignored]: 'IGN', [n.fixed.outbox]: 'OUT',
    [n.fixed.prefs]: 'PREFS', [n.fixed.seen]: 'SEEN', [n.fixed.gleft]: 'LEFT',
    [await n.scoped('group', GID)]: 'GROUP', [await n.scoped('pin', PEER)]: 'PINS1', [await n.scoped('pin', GID)]: 'PINS2',
  }
  for (const [k, v] of Object.entries(want)) assert.equal(kv.get(k), v, k)
  assert.deepEqual(kv.keys().filter((k) => k.includes(KID)), [], 'nothing names the identity any more')
  assert.equal(kv.get(`ec-local-contacts-${OTHER}`), 'CUDZA', 'another identity is not touched')
  assert.equal(kv.get('ec-soft-id-ala'), 'ID')
  assert.deepEqual(await n.groups(kv), [GID], 'the group is listed in the index')
  assert.equal(await migrateToNames(kv, n), 0, 'a second sign-in has nothing to move')
})

test('a name already written by this build keeps its value; the old copy is dropped', async () => {
  const n = await namesFromKey(randomBytes(32), KID)
  const kv = mem({ [n.fixed.book]: 'NEW', [`ec-local-contacts-${KID}`]: 'OLD' })
  assert.equal(await migrateToNames(kv, n), 0)
  assert.equal(kv.get(n.fixed.book), 'NEW')
  assert.equal(kv.get(`ec-local-contacts-${KID}`), null)
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
