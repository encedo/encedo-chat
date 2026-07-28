import { test } from 'node:test'
import assert from 'node:assert/strict'
import { deriveRoom, hemIdentityFrom, hemContactBook, localContactBook, mergedContactBook, type Identity } from '../lib/core.ts'
import { topicFromSecret, announceMacKey } from '../lib/rendezvous.ts'
import { msgKeyFromSecret, seal, open } from '../lib/msgcrypto.ts'

const P = { networkId: 'main', dateUTC: '2026-07-27' }
const fakeId = (ss: Uint8Array): Identity => ({ handle: 'x', pub: '', ecdh: async () => ss })

test('deriveRoom topic == the direct rendezvous derivation (no drift)', async () => {
  const ss = new Uint8Array(32).fill(9)
  const { topic } = await deriveRoom(fakeId(ss), 'ignored', P)
  assert.equal(topic, await topicFromSecret(ss, P))
})

test('deriveRoom keys work: macKey verifies, session seals the same as the primitives', async () => {
  const ss = new Uint8Array(32).fill(5)
  const { keys } = await deriveRoom(fakeId(ss), 'ignored', P)
  // macKey is the same HMAC key (an announce built with the primitive verifies)
  const { buildAnnounce, verifyAnnounce } = await import('../lib/announce.ts')
  const ann = await buildAnnounce('12D3KooPeer', await announceMacKey(ss, P))
  assert.equal((await verifyAnnounce(ann, keys.macKey)).ok, true)
  // session decrypts a box sealed with the primitive key
  const box = await seal(new TextEncoder().encode('hi'), await msgKeyFromSecret(ss, P))
  assert.deepEqual(await keys.session.decrypt(box), new TextEncoder().encode('hi'))
})

test('hemIdentityFrom exposes handle/pub and an ecdh that calls the HEM', async () => {
  let called: any = null
  const hem = { authorizePassword: async () => 'tok', ecdh: async (t: string, kid: string, pub: string) => { called = { t, kid, pub }; return new Uint8Array(32).fill(1) } }
  const id = hemIdentityFrom(hem, 'kid7', 'alice', 'PUBB64')
  assert.equal(id.handle, 'alice'); assert.equal(id.pub, 'PUBB64')
  const ss = await id.ecdh('peerpub')
  assert.equal(ss.length, 32)
  assert.deepEqual(called, { t: 'tok', kid: 'kid7', pub: 'peerpub' })
})

test('hemContactBook: add imports ETSEIC:peer descr + 32B pub; list parses name/pub; remove deletes', async () => {
  const PUB = 'UC88Dc7X8pxWQvcjUQDKAWXZqYycmJjnoZABKmwwnAM=' // a real 32-byte X25519 pub (base64)
  const calls: any = {}
  const hem = {
    authorizePassword: async (_pw: any, scope: string) => 'tok:' + scope,
    importPublicKey: async (_t: string, label: string, type: string, bytes: Uint8Array, descrB64: string) => {
      calls.import = { label, type, len: bytes.length, descr: new TextDecoder().decode(Uint8Array.from(atob(descrB64), (c) => c.charCodeAt(0))) }
      return { kid: 'K1' }
    },
    searchKeys: async (_t: string, pat: string) => { calls.search = pat; return [{ kid: 'K1', description: new TextEncoder().encode('ETSEIC:peer,bob,ik') }] },
    getPubKey: async (_t: string, _kid: string) => ({ pubkey: PUB }),
    deleteKey: async (_t: string, kid: string) => { calls.del = kid },
  }
  const book = hemContactBook(hem)
  await book.add('bob', PUB)
  assert.equal(calls.import.label, 'chat-peer-bob'); assert.equal(calls.import.type, 'CURVE25519')
  assert.equal(calls.import.len, 32); assert.equal(calls.import.descr, 'ETSEIC:peer,bob,ik')
  const list = await book.list()
  assert.equal(calls.search, 'ETSEIC:peer,')
  assert.equal(list.length, 1); assert.equal(list[0].name, 'bob'); assert.equal(list[0].pub, PUB); assert.equal(list[0].kid, 'K1'); assert.equal(list[0].source, 'hem')
  await book.remove(list[0])
  assert.equal(calls.del, 'K1')
})

test('mergedContactBook: add routes by persistent, remove by source, list concatenates', async () => {
  let store: Array<{ name: string; pub: string }> = []
  const local = localContactBook(() => store, (l) => { store = l })
  const hemCalls: any = { added: [], removed: [] }
  const hem = {
    async list() { return [{ name: 'perm', pub: 'P', kid: 'K', source: 'hem' as const }] },
    async add(n: string, p: string) { hemCalls.added.push([n, p]) },
    async remove(c: any) { hemCalls.removed.push(c.kid) },
  }
  const book = mergedContactBook(hem, local)
  await book.add('carl', 'CARLPUB', false) // → local
  await book.add('perm', 'PERMPUB', true)  // → hem
  assert.deepEqual(hemCalls.added, [['perm', 'PERMPUB']])
  assert.equal(store.length, 1); assert.equal(store[0].name, 'carl')
  const list = await book.list()
  assert.equal(list.length, 2)
  assert.ok(list.find((c) => c.name === 'carl' && c.source === 'local'))
  assert.ok(list.find((c) => c.name === 'perm' && c.source === 'hem'))
  await book.remove({ name: 'carl', pub: 'CARLPUB', source: 'local' })
  assert.equal(store.length, 0)
  await book.remove({ name: 'perm', pub: 'P', kid: 'K', source: 'hem' })
  assert.deepEqual(hemCalls.removed, ['K'])
})
