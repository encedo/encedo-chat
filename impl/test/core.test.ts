import { test } from 'node:test'
import assert from 'node:assert/strict'
import { deriveRoom, hemIdentityFrom, hemContactBook, localContactBook, mergedContactBook, pubKeyReader, type Identity } from '../lib/core.ts'
import { topicFromSecret, announceMacKey } from '../lib/rendezvous.ts'
import { buildPeerDescr, buildSelfDescr, peerSearchPrefix, hemKid } from '../lib/descr.ts'
import { unb64 } from '../lib/wc.ts'

const P = { networkId: 'main', dateUTC: '2026-07-27' }
const fakeId = (ss: Uint8Array): Identity => ({ handle: 'x', pub: '', ecdh: async () => ss })

test('deriveRoom topic == the direct rendezvous derivation (no drift)', async () => {
  const ss = new Uint8Array(32).fill(9)
  const { topic } = await deriveRoom(fakeId(ss), { pub: 'ignored' }, P)
  assert.equal(topic, await topicFromSecret(ss, P))
})

test('deriveRoom keys: macKey verifies, and EH-2 keys are wired (no interim path)', async () => {
  const ss = new Uint8Array(32).fill(5)
  const peerPub = Buffer.from(new Uint8Array(32).fill(7)).toString('base64')
  const { keys } = await deriveRoom(fakeId(ss), { pub: peerPub }, P)
  // macKey is the same HMAC key (an announce built with the primitive verifies)
  const { buildAnnounce, verifyAnnounce } = await import('../lib/announce.ts')
  const ann = await buildAnnounce('12D3KooPeer', await announceMacKey(ss, P))
  assert.equal((await verifyAnnounce(ann, keys.macKey)).ok, true)
  // content crypto is EH-2: the room gets our IK + the peer's IK public, no static session
  assert.ok(keys.eh2, 'eh2 keys present')
  assert.equal((keys as any).session, undefined, 'no interim session key')
  assert.deepEqual(keys.eh2.peerIkPub, new Uint8Array(32).fill(7))
})

test('hemIdentityFrom: ecdh uses base64 pubkey, or ecdhKid when a peer kid is given', async () => {
  let base: any = null, ext: any = null
  const hem = {
    authorizePassword: async () => 'tok',
    ecdh: async (t: string, kid: string, pub: string) => { base = { t, kid, pub }; return new Uint8Array(32).fill(1) },
    ecdhKid: async (t: string, kid: string, extKid: string) => { ext = { t, kid, extKid }; return new Uint8Array(32).fill(2) },
  }
  const id = hemIdentityFrom(hem, 'kid7', 'alice', 'PUBB64')
  assert.equal(id.handle, 'alice'); assert.equal(id.pub, 'PUBB64')
  await id.ecdh('peerpub')                      // no kid -> base64 ecdh
  assert.deepEqual(base, { t: 'tok', kid: 'kid7', pub: 'peerpub' }); assert.equal(ext, null)
  await id.ecdh('peerpub', 'peerKid9')          // kid present -> two-KID ecdhKid
  assert.deepEqual(ext, { t: 'tok', kid: 'kid7', extKid: 'peerKid9' })
})

test('hemContactBook: writes the scoped record, reads only ours, and sees a collision coming', async () => {
  const PUB = 'UC88Dc7X8pxWQvcjUQDKAWXZqYycmJjnoZABKmwwnAM=' // a real 32-byte X25519 pub (base64)
  const OTHER = 'aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789AbCdEfg='
  const MINE = '0123456789abcdef0123456789abcdef'
  const THEIRS = 'fedcba9876543210fedcba9876543210'
  const enc = (s: string) => new TextEncoder().encode(s)

  const mk = (entries: any[]) => {
    const calls: any = { searches: [] }
    const hem = {
      authorizePassword: async (_pw: any, scope: string) => 'tok:' + scope,
      importPublicKey: async (_t: string, label: string, type: string, bytes: Uint8Array, descrB64: string) => {
        calls.import = { label, type, len: bytes.length, descr: new TextDecoder().decode(Uint8Array.from(atob(descrB64), (c) => c.charCodeAt(0))) }
        return { kid: 'K1' }
      },
      updateKey: async (_t: string, kid: string, label: string, descrB64: string) => {
        calls.update = { kid, label, descr: new TextDecoder().decode(Uint8Array.from(atob(descrB64), (c) => c.charCodeAt(0))) }
      },
      // The device matches an anchored PREFIX — the stub must too, or the test
      // would pass with scoping that does not work.
      searchKeys: async (_t: string, pat: string) => {
        calls.searches.push(pat)
        return entries.filter((e) => new TextDecoder().decode(e.description).startsWith(pat))
      },
      getPubKey: async (_t: string, _kid: string) => ({ pubkey: PUB }),
      deleteKey: async (_t: string, kid: string) => { calls.del = kid },
    }
    return { hem, calls }
  }

  // --- ours and a second identity's contact live side by side in one device
  const mineDescr = buildPeerDescr(MINE, 'bob')!
  const theirsDescr = buildPeerDescr(THEIRS, 'carol')!
  const { hem, calls } = mk([
    { kid: 'K1', description: enc(mineDescr) },
    { kid: 'K9', description: enc(theirsDescr) },
    { kid: THEIRS, description: enc(buildSelfDescr('Work')) },
  ])
  const book = hemContactBook(hem, MINE)

  await book.add('bob', PUB)
  assert.equal(calls.import.label, 'Onchato-Peer-bob')
  assert.equal(calls.import.type, 'CURVE25519')
  assert.equal(calls.import.len, 32)
  assert.equal(calls.import.descr, mineDescr, 'the record names the identity that owns it')

  const list = await book.list()
  assert.ok(calls.searches.includes(peerSearchPrefix(MINE)), 'the list is scoped to this identity')
  assert.equal(list.length, 1, "the other identity's contact is not ours to show")
  assert.equal(list[0].name, 'bob'); assert.equal(list[0].pub, PUB); assert.equal(list[0].kid, 'K1'); assert.equal(list[0].source, 'hem')

  await book.rename(list[0], 'Bob Nowak')
  assert.equal(calls.update.label, 'Onchato-Peer-Bob Nowak')
  assert.equal(calls.update.descr, buildPeerDescr(MINE, 'Bob Nowak'), 'both fields move together')

  await book.remove(list[0])
  assert.equal(calls.del, 'K1')
})

test('adding a key another identity already holds is refused BEFORE the device is touched', async () => {
  // The device would refuse it anyway — KID indexes the key's content — but as a
  // firmware error naming nothing. The client can predict it, because the KID is
  // SHA-1 of the public key it is holding.
  const OTHER_PUB = 'UC88Dc7X8pxWQvcjUQDKAWXZqYycmJjnoZABKmwwnAM='
  const MINE = '0123456789abcdef0123456789abcdef'
  const THEIRS = 'fedcba9876543210fedcba9876543210'
  const enc = (s: string) => new TextEncoder().encode(s)
  const otherKid = await hemKid(unb64(OTHER_PUB))

  let imported = false
  const hem = {
    authorizePassword: async () => 'tok',
    importPublicKey: async () => { imported = true; return { kid: 'X' } },
    searchKeys: async (_t: string, pat: string) => [
      { kid: otherKid, description: enc(buildPeerDescr(THEIRS, 'carol')!) },
      { kid: THEIRS, description: enc(buildSelfDescr('Work')) },
    ].filter((e) => new TextDecoder().decode(e.description).startsWith(pat)),
  }

  await assert.rejects(
    () => hemContactBook(hem, MINE).add('carol', OTHER_PUB),
    (e: any) => {
      assert.equal(e.name, 'ContactHeldByOtherIdentity')
      assert.equal(e.ownerKid, THEIRS)
      assert.equal(e.ownerHandle, 'Work', 'the message can name the identity, not just a hex blob')
      return true
    },
  )
  assert.equal(imported, false, 'nothing was written')
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
  await book.add('carl', 'CARLPUB', false) // -> local
  await book.add('perm', 'PERMPUB', true)  // -> hem
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

test('the pair secret is fetched once per contact, however many derivations want it', async () => {
  // On a HEM every ecdh is a device round trip of one to two seconds, and a
  // trace of one sign-in showed the same secret being fetched three times: the
  // presence watch, the rotation offset and opening the room each paid for it.
  let calls = 0
  const ss = new Uint8Array(32).fill(3)
  const id: Identity = { handle: 'x', pub: 'PUB', ecdh: async () => { calls++; return ss } }
  // The shape `startSession` now uses: one memo, holding the PROMISE.
  const cache = new Map<string, Promise<Uint8Array>>()
  const pairSecret = (pub: string) => {
    let p = cache.get(pub)
    if (!p) { p = id.ecdh(pub); cache.set(pub, p) }
    return p
  }
  // Concurrent callers must share the in-flight call, not start their own —
  // that race is what produced two of the three.
  const [a, b] = await Promise.all([pairSecret('peer'), pairSecret('peer')])
  const c = await pairSecret('peer')
  assert.equal(calls, 1, 'one device call')
  assert.equal(a, b); assert.equal(b, c)
  await pairSecret('other')
  assert.equal(calls, 2, 'a different contact is a different secret')
})

test('deriveRoom accepts a secret already paid for, and derives the same room', async () => {
  const ss = new Uint8Array(32).fill(9)
  let calls = 0
  const id: Identity = { handle: 'x', pub: '', ecdh: async () => { calls++; return ss } }
  const peer = { pub: Buffer.from(new Uint8Array(32).fill(7)).toString('base64') }
  const fresh = await deriveRoom(id, peer, P)
  const callsAfterFresh = calls
  const reused = await deriveRoom(id, peer, P, { ss })
  assert.equal(reused.topic, fresh.topic, 'the same room, whoever computed the secret')
  assert.equal(calls, callsAfterFresh, 'and no further ecdh for the topic')
})

test('one broad token reads every public key, and a device that refuses it still works', async () => {
  // getPubKey is documented as needing keymgmt:use:<KID>, which is per-key: ten
  // contacts meant ten authorisations, each two round trips. `keymgmt:get` is
  // KID-independent. Firmware that does not know it refuses, so the first
  // attempt decides and the answer is remembered.
  const modern = { scopes: [] as string[], async authorizePassword(_p: any, s: string) { this.scopes.push(s); return 't' }, async getPubKey(_t: string, kid: string) { return { pubkey: 'P:' + kid } } }
  const readModern = pubKeyReader(modern)
  assert.equal(await readModern('K1'), 'P:K1')
  assert.equal(await readModern('K2'), 'P:K2')
  assert.deepEqual(modern.scopes, ['keymgmt:get', 'keymgmt:get'], 'never a per-key scope')

  const legacy = {
    scopes: [] as string[],
    async authorizePassword(_p: any, s: string) {
      this.scopes.push(s)
      if (s === 'keymgmt:get') throw Object.assign(new Error('unknown scope'), { code: 'http_403' })
      return 't'
    },
    async getPubKey(_t: string, kid: string) { return { pubkey: 'P:' + kid } },
  }
  const readLegacy = pubKeyReader(legacy)
  assert.equal(await readLegacy('K1'), 'P:K1')
  assert.equal(await readLegacy('K2'), 'P:K2')
  assert.deepEqual(legacy.scopes, ['keymgmt:get', 'keymgmt:use:K1', 'keymgmt:use:K2'],
    'the broad scope is tried ONCE, then never again on this device')
})

test('a failure after the broad scope has worked is reported, not retried narrowly', async () => {
  // Otherwise a device that goes away mid-session would look like one that wants
  // the old scope, and every later read would pay for two authorisations.
  let n = 0
  const hem = {
    async authorizePassword() { return 't' },
    async getPubKey(_t: string, kid: string) { if (++n > 1) throw new Error('device asleep'); return { pubkey: 'P:' + kid } },
  }
  const read = pubKeyReader(hem)
  assert.equal(await read('K1'), 'P:K1')
  await assert.rejects(() => read('K2'), /device asleep/)
})
