/**
 * derive.test.ts - the identity backend's derivation seam (lib/derive.ts,
 * SPEC.md 4.3): the same bytes whichever side derives them, and a backend
 * that derives in-device is actually the one asked.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { deriveWith, deriveOverEcdh, deriveManyWith, hemDerivation } from '../lib/derive.ts'
import { kdf, b64 } from '../lib/wc.ts'
import { generateX25519 } from '../lib/x25519.ts'
import { derivePresence, deriveRotationOffset, deriveSelfRoom, presenceFromSecret, hemIdentityFrom, type Identity } from '../lib/core.ts'
import { rotationOffsetSec } from '../lib/rendezvous.ts'
import { msgMacKeyFor, msgMacKeyFromSecret, rosterMacKeyFor, rosterMacKeyFromSecret } from '../lib/group.ts'

const enc = new TextEncoder()
const P = { networkId: 'test', dateUTC: '2026-10-13' }

async function pair() {
  const a = await generateX25519(), b = await generateX25519()
  const ecdhA = async (peer: string) => a.dh(Uint8Array.from(atob(peer), (c) => c.charCodeAt(0)))
  const ecdhB = async (peer: string) => b.dh(Uint8Array.from(atob(peer), (c) => c.charCodeAt(0)))
  const raw: Identity = { handle: 'raw', pub: b64(a.pub), ecdh: ecdhA }                       // a backend with raw ecdh only
  const dev: Identity = { handle: 'dev', pub: b64(a.pub), ecdh: ecdhA, derive: deriveOverEcdh(ecdhA) } // one that derives itself
  return { a, b, raw, dev, ecdhA, ecdhB }
}

test('deriveWith over a raw-only backend equals HKDF over its ecdh', async () => {
  const { raw, b, ecdhA } = await pair()
  const ctx = enc.encode('ctx')
  const viaSeam = await deriveWith(raw, 'label-x', b64(b.pub), ctx, 32)
  const direct = await kdf('label-x', await ecdhA(b64(b.pub)), ctx, 32)
  assert.deepEqual(viaSeam, direct)
  // ...and a different label or context is a different key
  assert.notDeepEqual(await deriveWith(raw, 'label-y', b64(b.pub), ctx, 32), direct)
  assert.notDeepEqual(await deriveWith(raw, 'label-x', b64(b.pub), enc.encode('other'), 32), direct)
})

test('a backend that derives is asked to derive, and its raw ecdh is never called', async () => {
  const { a, b, ecdhA } = await pair()
  let rawCalls = 0, deriveCalls = 0
  const id: Identity = {
    handle: 'dev', pub: b64(a.pub),
    ecdh: async (peer) => { rawCalls++; return ecdhA(peer) },
    derive: async (label, peer, ctx, len) => { deriveCalls++; return kdf(label, await ecdhA(peer), ctx, len) },
  }
  const peer = { pub: b64(b.pub) }
  await derivePresence(id, peer, P)
  await deriveRotationOffset(id, peer, P)
  await deriveSelfRoom(id, P)
  const gid = new Uint8Array(16).fill(7)
  await msgMacKeyFor(id, b64(b.pub), gid, 3)
  await rosterMacKeyFor(id, b64(b.pub), gid, 3)
  assert.equal(rawCalls, 0, 'a rendezvous/group derivation must not take the raw secret out of the backend')
  assert.equal(deriveCalls, 7) // topic, MAC, offset, self topic, self MAC, mk_ij, rk_i
})

test('the derived material equals the secret-form derivation (wire unchanged)', async () => {
  const { dev, raw, b, ecdhA } = await pair()
  const peer = { pub: b64(b.pub) }
  const ss = await ecdhA(b64(b.pub))
  const expect = await presenceFromSecret(ss, P)
  for (const id of [dev, raw]) {
    const got = await derivePresence(id, peer, P)
    assert.equal(got.topic, expect.topic)
    assert.equal(await deriveRotationOffset(id, peer, P), await rotationOffsetSec(ss, P))
    const gid = new Uint8Array(16).fill(1)
    assert.deepEqual(await msgMacKeyFor(id, b64(b.pub), gid, 5), await msgMacKeyFromSecret(ss, gid, 5))
    assert.deepEqual(await rosterMacKeyFor(id, b64(b.pub), gid, 5), await rosterMacKeyFromSecret(ss, gid, 5))
  }
  // the MAC key is a CryptoKey; prove equality through a signature
  const { subtle } = await import('../lib/wc.ts')
  const msg = enc.encode('1|peer|nonce|1')
  const s1 = new Uint8Array(await subtle.sign('HMAC', expect.macKey, msg))
  const s2 = new Uint8Array(await subtle.sign('HMAC', (await derivePresence(dev, peer, P)).macKey, msg))
  assert.deepEqual(s1, s2)
})

/**
 * A fake of firmware 1.3's ecdh + hkdf_args: real X25519 and HKDF, with the
 * device's rules - hkdf_len 16..128, at most 8 items, an info starting with
 * 'encedo-' refused - and a count of what it was asked.
 */
function fakeDevice(priv: { dh(p: Uint8Array): Promise<Uint8Array> }, stored: Map<string, Uint8Array> = new Map()) {
  const seen: any[] = []
  const ecdhHkdf = async (peer: { pubkey?: Uint8Array; extKid?: string }, items: Array<{ hkdfSalt: Uint8Array | null; hkdfCtx: string | Uint8Array; hkdfLen: number }>) => {
    seen.push({ peer, items })
    assert.ok(items.length >= 1 && items.length <= 8, 'hkdf_args is 1..8')
    const peerPub = peer.pubkey ?? stored.get(peer.extKid!)
    assert.ok(peerPub, 'a peer')
    const ss = await priv.dh(peerPub!)
    return Promise.all(items.map((it) => {
      assert.ok(Number.isInteger(it.hkdfLen) && it.hkdfLen >= 16 && it.hkdfLen <= 128, `hkdf_len ${it.hkdfLen}`)
      assert.ok(!(typeof it.hkdfCtx === 'string' ? it.hkdfCtx : new TextDecoder().decode(it.hkdfCtx)).startsWith('encedo-'), 'the reserved prefix')
      assert.ok(it.hkdfSalt === null || it.hkdfSalt.length >= 1, 'an empty salt is sent as none')
      return kdf(it.hkdfCtx, ss, it.hkdfSalt ?? new Uint8Array(0), it.hkdfLen)
    }))
  }
  return { ecdhHkdf, seen }
}

test('in-device derivation gives the client\'s bytes: 32, 4 (the first 4 of 16), no salt, a stored peer', async () => {
  const { a, b, raw } = await pair()
  const dev = fakeDevice(a, new Map([['kidB', b.pub]]))
  const { derive } = hemDerivation(dev.ecdhHkdf, (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0)))
  const ctx = enc.encode('main\0' + '2026-11-07')
  for (const [label, c, len] of [['onchato-rendezvous-v1', ctx, 32], ['onchato-rotation-v1', enc.encode('main\0'), 4], ['onchato-store-names-v1', new Uint8Array(0), 32]] as const) {
    const want = await deriveWith(raw, label, b64(b.pub), c, len)
    assert.deepEqual(await derive(label, b64(b.pub), c, len), want, `${label} L=${len}`)
    assert.deepEqual(await derive(label, b64(b.pub), c, len, 'kidB'), want, `${label} via the stored peer`)
  }
  const asked = dev.seen.map((x) => x.items[0])
  assert.equal(asked[2].hkdfLen, 16, 'the device is asked for 16 when 4 are wanted')
  assert.equal(asked[4].hkdfSalt, null, 'an empty context is no salt, not an empty one')
  assert.deepEqual(dev.seen[1].peer, { extKid: 'kidB' }, 'a stored contact is named by its KID')
})

test('several outputs of one ECDH are one device call, in batches of 8', async () => {
  const { a, b, raw } = await pair()
  const dev = fakeDevice(a)
  const backend = hemDerivation(dev.ecdhHkdf, (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0)))
  const id: Identity = { ...raw, ...backend }
  const items = Array.from({ length: 11 }, (_, i) => ({ label: `onchato-test-${i}`, ctx: enc.encode(`c${i}`), len: i === 3 ? 4 : 32 }))
  const out = await deriveManyWith(id, items, b64(b.pub))
  assert.equal(dev.seen.length, 2, '11 outputs = 8 + 3')
  for (let i = 0; i < items.length; i++) assert.deepEqual(out[i], await deriveWith(raw, items[i].label, b64(b.pub), items[i].ctx, items[i].len), `item ${i}`)
  dev.seen.length = 0
  const pres = await derivePresence(id, { pub: b64(b.pub) }, P)
  assert.equal(dev.seen.length, 1, 'a pair topic and its Announce key: one device call')
  const ref = await derivePresence(raw, { pub: b64(b.pub) }, P)
  assert.equal(pres.topic, ref.topic)
})

test('a HEM identity derives through ecdhHkdf and never asks the device for the raw secret', async () => {
  const a = await generateX25519(), b = await generateX25519()
  const dev = fakeDevice(a)
  let raws = 0
  const hem = {
    authorizePassword: async () => 'tok',
    ecdh: async () => { raws++; return new Uint8Array(32) },
    ecdhHkdf: async (_t: string, kid: string, opts: any) => { assert.equal(kid, 'IKKID'); const { items, ...peer } = opts; return dev.ecdhHkdf(peer, items) },
  }
  const id = hemIdentityFrom(hem, 'IKKID', 'me', b64(a.pub))
  await derivePresence(id, { pub: b64(b.pub) }, P)
  await deriveRotationOffset(id, { pub: b64(b.pub) }, P)
  await deriveSelfRoom(id, P)
  assert.equal(raws, 0, 'no raw ECDH for a rendezvous, a rotation offset or the self-topic')
  assert.equal(dev.seen.length, 3)
})
