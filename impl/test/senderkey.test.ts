/**
 * Group Sender Keys (`lib/senderkey.ts`): the per-member hash-ratchet + AES-GCM
 * body + per-recipient HMAC. Pins the KDF labels (a KAT that decrypts a sealed
 * frame with an INDEPENDENTLY derived MK/nonce), plus roundtrip, out-of-order,
 * replay, the skip bound, and that a forged frame neither opens nor burns the chain.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { newSendChain, sendChainFrom, seal, SenderReceiver, tag, verify, MAX_SKIP } from '../lib/senderkey.ts'
import { hkdfBits, subtle } from '../lib/wc.ts'

const enc = new TextEncoder()
const NO_SALT = new Uint8Array(0)
const body = (s: string) => enc.encode(s)
const H = new Uint8Array([0xaa, 0xbb, 0xcc, 0xdd]) // an opaque header (the AAD)

test('KAT: a sealed frame opens with an independently derived MK and nonce', async () => {
  // If the labels/derivation drift, this manual decrypt fails.
  const key0 = new Uint8Array(32).fill(0x11)
  const { ct } = await seal(sendChainFrom(key0), H, body('hello'))
  const mk0 = await hkdfBits(key0, NO_SALT, enc.encode('encedo-group-msg'), 32)
  const nonce = await hkdfBits(mk0, NO_SALT, enc.encode('encedo-aead-nonce'), 12)
  const k = await subtle.importKey('raw', mk0, { name: 'AES-GCM' }, false, ['decrypt'])
  const pt = new Uint8Array(await subtle.decrypt({ name: 'AES-GCM', iv: nonce, additionalData: H }, k, ct))
  assert.deepEqual(pt, body('hello'))
})

test('the chain is deterministic: two chains from one key seal identically', async () => {
  const key = new Uint8Array(32).fill(0x22)
  const a = await seal(sendChainFrom(key), H, body('x'))
  const b = await seal(sendChainFrom(key), H, body('x'))
  assert.deepEqual(a.ct, b.ct)
  assert.equal(a.n, 0)
})

test('roundtrip: a receiver seeded from the sender key opens the messages in order', async () => {
  const key = new Uint8Array(32).fill(0x33)
  const send = sendChainFrom(key)
  const recv = new SenderReceiver(key)
  for (const word of ['one', 'two', 'three']) {
    const { n, ct } = await seal(send, H, body(word))
    const pt = await recv.open(n, H, ct)
    assert.deepEqual(pt, body(word))
  }
  assert.equal(recv.stats().n, 3)
})

test('out of order: a later message opens first, the skipped ones open when they arrive', async () => {
  const key = new Uint8Array(32).fill(0x44)
  const send = sendChainFrom(key)
  const recv = new SenderReceiver(key)
  const frames = []
  for (const w of ['m0', 'm1', 'm2']) frames.push({ ...(await seal(send, H, body(w))), w })
  // deliver 2, 0, 1
  assert.deepEqual(await recv.open(frames[2].n, H, frames[2].ct), body('m2'))
  assert.deepEqual(await recv.open(frames[0].n, H, frames[0].ct), body('m0'))
  assert.deepEqual(await recv.open(frames[1].n, H, frames[1].ct), body('m1'))
})

test('a spent counter is a replay: it opens once', async () => {
  const key = new Uint8Array(32).fill(0x55)
  const send = sendChainFrom(key); const recv = new SenderReceiver(key)
  const { n, ct } = await seal(send, H, body('once'))
  assert.deepEqual(await recv.open(n, H, ct), body('once'))
  assert.equal(await recv.open(n, H, ct), null)
})

test('a jump past MAX_SKIP is rejected (DoS bound)', async () => {
  const key = new Uint8Array(32).fill(0x66)
  const recv = new SenderReceiver(key, { maxSkip: 4 })
  await assert.rejects(() => recv.open(5 + MAX_SKIP, H, new Uint8Array(20)), /over the .* bound/)
})

test('per-recipient MAC: it verifies, and a wrong key or tampered bytes do not', async () => {
  const mkA = new Uint8Array(32).fill(0x77)
  const mkB = new Uint8Array(32).fill(0x88)
  const ct = body('sealed-bytes')
  const mac = await tag(mkA, H, ct)
  assert.equal(await verify(mkA, H, ct, mac), true)
  assert.equal(await verify(mkB, H, ct, mac), false, 'a different pair key must not verify')
  const bad = ct.slice(); bad[0] ^= 1
  assert.equal(await verify(mkA, H, bad, mac), false, 'tampered ct must not verify')
})

test('a tampered ciphertext does not open and does not burn the chain', async () => {
  const key = new Uint8Array(32).fill(0x99)
  const send = sendChainFrom(key); const recv = new SenderReceiver(key)
  const { n, ct } = await seal(send, H, body('intact'))
  const bad = ct.slice(); bad[5] ^= 0xff
  assert.equal(await recv.open(n, H, bad), null, 'a forged frame must not open')
  assert.deepEqual(await recv.open(n, H, ct), body('intact'), 'the chain survived — the real frame still opens')
})

test('newSendChain gives a random 32-byte key at position 0', () => {
  const a = newSendChain(); const b = newSendChain()
  assert.equal(a.key.length, 32); assert.equal(a.n, 0)
  assert.notDeepEqual(a.key, b.key)
})
