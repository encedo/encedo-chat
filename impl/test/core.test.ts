import { test } from 'node:test'
import assert from 'node:assert/strict'
import { deriveRoom, hemIdentityFrom, type Identity } from '../lib/core.ts'
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
