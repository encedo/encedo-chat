/**
 * EH-2 stage 3 — ML-KEM-768, the PQ half of the hybrid (docs/PROTOCOL.md §6.2, §6.4).
 *
 * Two things must hold: the KEM itself round-trips at the sizes the wire format
 * expects, and the full handshake still lands on one SK when the real KEM
 * replaces the stage-2 stand-in — i.e. `ss` is genuinely shared and genuinely
 * inside the key schedule.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mlkem768, mlkem768Seeded, MLKEM768_SEED } from '../eh2/mlkem.ts'
import { MLKEM768_PK, MLKEM768_CT, decodeMsg1, decodeMsg2, encodeMsg2 } from '../eh2/wire.ts'
import { initiate, initiatorComplete, respond, responderComplete } from '../eh2/handshake.ts'
import { generateX25519, x25519FromPriv } from '../lib/x25519.ts'
import { b64 } from '../lib/wc.ts'

const NOW = 1_784_000_000_000

test('ML-KEM-768 encapsulate/decapsulate round-trips at FIPS 203 sizes', async () => {
  const key = await mlkem768.generate()
  assert.equal(key.pub.length, MLKEM768_PK)
  const { ct, ss } = await mlkem768.encapsulate(key.pub)
  assert.equal(ct.length, MLKEM768_CT)
  assert.equal(ss.length, 32)
  assert.deepEqual(await key.decapsulate(ct), ss)
})

test('a foreign ciphertext decapsulates to an unrelated secret (implicit rejection)', async () => {
  const [a, b] = [await mlkem768.generate(), await mlkem768.generate()]
  const { ct, ss } = await mlkem768.encapsulate(b.pub)
  const wrong = await a.decapsulate(ct)
  assert.equal(wrong.length, 32)
  assert.notDeepEqual(wrong, ss, 'no shared secret without the matching private key')
})

test('each handshake gets fresh KEM material', async () => {
  const [k1, k2] = [await mlkem768.generate(), await mlkem768.generate()]
  assert.notDeepEqual(k1.pub, k2.pub)
  const e1 = await mlkem768.encapsulate(k1.pub)
  const e2 = await mlkem768.encapsulate(k1.pub)
  assert.notDeepEqual(e1.ct, e2.ct, 'encapsulation is randomized')
  assert.notDeepEqual(e1.ss, e2.ss)
})

test('hybrid handshake with the real KEM: SK_i == SK_r', async () => {
  const [ikI, ikR] = [await generateX25519(), await generateX25519()]
  const i1 = await initiate({ ik: ikI, peerIkPub: ikR.pub, kem: mlkem768, now: NOW })
  assert.equal(decodeMsg1(i1.msg1).pqPub.length, MLKEM768_PK)
  const r1 = await respond({ ik: ikR, peerIkPub: ikI.pub, msg1: i1.msg1, kem: mlkem768, now: NOW })
  assert.equal(decodeMsg2(r1.msg2).pqCt.length, MLKEM768_CT)
  const i2 = await initiatorComplete(i1.state, r1.msg2, { now: NOW })
  const rr = await responderComplete(r1.state, i2.msg3)
  assert.deepEqual(i2.result.sk, rr.sk)
  assert.deepEqual(i2.result.firstStepIkm, rr.firstStepIkm)
})

test('ss really enters SK: swapping in another peer\'s ciphertext breaks mac_r', async () => {
  const [ikI, ikR] = [await generateX25519(), await generateX25519()]
  const i1 = await initiate({ ik: ikI, peerIkPub: ikR.pub, kem: mlkem768, now: NOW })
  const r1 = await respond({ ik: ikR, peerIkPub: ikI.pub, msg1: i1.msg1, kem: mlkem768, now: NOW })

  // Same X25519 ephemerals and the same MAC, only the ciphertext replaced: the
  // initiator decapsulates a different ss -> different SK -> mac_r fails. (It also
  // fails the transcript check, which is the point: ct is bound via h2_partial.)
  const other = await mlkem768.generate()
  const foreign = (await mlkem768.encapsulate(other.pub)).ct
  const tampered = encodeMsg2({ ...decodeMsg2(r1.msg2), pqCt: foreign })
  await assert.rejects(() => initiatorComplete(i1.state, tampered, { now: NOW }), /mac_r/)
})

test('KAT — fixed X25519 keys + fixed ML-KEM seed pin the hybrid schedule', async () => {
  const ikI = await x25519FromPriv(new Uint8Array(32).fill(0x11))
  const ikR = await x25519FromPriv(new Uint8Array(32).fill(0x22))
  const ekI = await x25519FromPriv(new Uint8Array(32).fill(0x33))
  const ekR = await x25519FromPriv(new Uint8Array(32).fill(0x44))
  const kem = mlkem768Seeded(new Uint8Array(MLKEM768_SEED).fill(0x55), new Uint8Array(32).fill(0x66))

  const i1 = await initiate({ ik: ikI, peerIkPub: ikR.pub, kem, now: NOW, ek: ekI })
  const r1 = await respond({ ik: ikR, peerIkPub: ikI.pub, msg1: i1.msg1, kem, now: NOW, ek: ekR })
  const i2 = await initiatorComplete(i1.state, r1.msg2, { now: NOW })
  assert.deepEqual((await responderComplete(r1.state, i2.msg3)).sk, i2.result.sk)

  // Recorded from this implementation. A change means the wire format, the DH
  // ordering, the info string, the transcript or the KEM binding moved.
  assert.equal(b64(i2.result.sk), 'HTdOzsUBv2unO/b/cvVkzTQASOCnoYn9aoOkqiog9Xk=')
})
