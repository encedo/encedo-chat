/**
 * derive.test.ts - the identity backend's derivation seam (lib/derive.ts,
 * SPEC.md 4.3): the same bytes whichever side derives them, and a backend
 * that derives in-device is actually the one asked.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { deriveWith, deriveOverEcdh } from '../lib/derive.ts'
import { kdf, b64 } from '../lib/wc.ts'
import { generateX25519 } from '../lib/x25519.ts'
import { derivePresence, deriveRotationOffset, deriveSelfRoom, presenceFromSecret, type Identity } from '../lib/core.ts'
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
