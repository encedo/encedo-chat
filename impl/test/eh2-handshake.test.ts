/**
 * EH-2 stage 2 — the handshake key schedule (docs/PROTOCOL.md §6.2–6.3).
 *
 * The spec names the first test to write: **both sides must derive the same
 * SK**, because the DH triad is concatenated in *responder perspective* and
 * getting that order wrong is the classic EH-2 bug. Everything else here guards
 * the authenticators: mac_r authenticates R to I, mac_i gates R's acceptance
 * of I (§6.2), and any transcript tamper must break both.
 *
 * The PQ slot is filled by a toy KEM (test/toy-kem.ts) — stage 3 swaps in
 * ML-KEM-768 behind the same interface, key schedule untouched.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { initiate, initiatorComplete, respond, responderComplete, HandshakeError, MAX_SKEW_MS } from '../eh2/handshake.ts'
import { generateX25519, x25519FromPriv, type Dh } from '../lib/x25519.ts'
import { decodeMsg2, encodeMsg2, h1 as hashMsg1 } from '../eh2/wire.ts'
import { hkdfBits, concat, b64 } from '../lib/wc.ts'
import { toyKem, seededRand } from './toy-kem.ts'

const NOW = 1_784_000_000_000
const enc = new TextEncoder()

/** Full 1.5-RT flow between two identities; returns both sides' results + frames. */
async function handshake(opts: { ikI: Dh; ikR: Dh; peerIkPubForR?: Uint8Array; kem?: any; now?: number } ) {
  const kem = opts.kem ?? toyKem()
  const now = opts.now ?? NOW
  const i1 = await initiate({ ik: opts.ikI, peerIkPub: opts.ikR.pub, kem, now })
  const r1 = await respond({ ik: opts.ikR, peerIkPub: opts.peerIkPubForR ?? opts.ikI.pub, msg1: i1.msg1, kem, now })
  const i2 = await initiatorComplete(i1.state, r1.msg2, { now })
  const rr = await responderComplete(r1.state, i2.msg3)
  return { init: i1, resp: r1, iResult: i2.result, rResult: rr, msg3: i2.msg3 }
}

test('SK_i == SK_r — both sides derive the same session key (§6.3 first test)', async () => {
  const [ikI, ikR] = [await generateX25519(), await generateX25519()]
  const { iResult, rResult } = await handshake({ ikI, ikR })
  assert.equal(iResult.sk.length, 32)
  assert.deepEqual(iResult.sk, rResult.sk)
  assert.notDeepEqual(iResult.sk, new Uint8Array(32), 'SK is not all-zero')
})

test('the key schedule is exactly ikm = DH(IK_r,EK_i) || DH(EK_r,IK_i) || DH(EK_r,EK_i) || ss', async () => {
  const [ikI, ikR] = [await generateX25519(), await generateX25519()]
  const kem = toyKem()
  const i1 = await initiate({ ik: ikI, peerIkPub: ikR.pub, kem, now: NOW })
  const r1 = await respond({ ik: ikR, peerIkPub: ikI.pub, msg1: i1.msg1, kem, now: NOW })
  const i2 = await initiatorComplete(i1.state, r1.msg2, { now: NOW })

  const msg2 = decodeMsg2(r1.msg2)
  const dh1 = await i1.state.ekI.dh(ikR.pub)     // DH(IK_r, EK_i)
  const dh2 = await ikI.dh(msg2.ekPub)           // DH(EK_r, IK_i)
  const dh3 = await i1.state.ekI.dh(msg2.ekPub)  // DH(EK_r, EK_i)
  const ss = await i1.state.pq.decapsulate(msg2.pqCt)
  const salt = await hashMsg1(i1.msg1)
  const info = enc.encode('encedo-handshake-v2')

  assert.deepEqual(i2.result.sk, await hkdfBits(concat(dh1, dh2, dh3, ss), salt, info, 32))
  // and the ordering is load-bearing: any other permutation is a different key
  assert.notDeepEqual(i2.result.sk, await hkdfBits(concat(dh2, dh1, dh3, ss), salt, info, 32))
  assert.notDeepEqual(i2.result.sk, await hkdfBits(concat(dh1, dh3, dh2, ss), salt, info, 32))
  // as is the salt (h1) — that is what makes every session's SK unique
  assert.notDeepEqual(i2.result.sk, await hkdfBits(concat(dh1, dh2, dh3, ss), new Uint8Array(32), info, 32))
})

test('dh3 is the first ratchet step input and both sides hold it', async () => {
  const [ikI, ikR] = [await generateX25519(), await generateX25519()]
  const { init, resp, iResult, rResult } = await handshake({ ikI, ikR })
  assert.deepEqual(iResult.firstStepIkm, rResult.firstStepIkm)
  assert.equal(iResult.firstStepIkm.length, 32)
  assert.deepEqual(iResult.ekSelf!.pub, init.state.ekI.pub, 'I keeps EK_i as its first ratchet key (§6.2)')
  assert.deepEqual(rResult.ekPeerPub, init.state.ekI.pub, 'R seeds DH_peer_pub with EK_i_pub')
  assert.equal(rResult.ekSelf, null, 'R keeps no ephemeral — EK_r_priv is gone after SK')
  assert.deepEqual(iResult.ekPeerPub, decodeMsg2(resp.msg2).ekPub, 'I ratchets against EK_r_pub')
})

test('every handshake produces a fresh SK (replay of the same identities)', async () => {
  const [ikI, ikR] = [await generateX25519(), await generateX25519()]
  const a = await handshake({ ikI, ikR })
  const b = await handshake({ ikI, ikR })
  assert.notDeepEqual(a.iResult.sk, b.iResult.sk)
})

test('mac_r authenticates R: a tampered msg2 is rejected by the initiator', async () => {
  const [ikI, ikR] = [await generateX25519(), await generateX25519()]
  const kem = toyKem()
  const i1 = await initiate({ ik: ikI, peerIkPub: ikR.pub, kem, now: NOW })
  const r1 = await respond({ ik: ikR, peerIkPub: ikI.pub, msg1: i1.msg1, kem, now: NOW })
  const m2 = decodeMsg2(r1.msg2)

  for (const [what, frame] of [
    ['mac_r', encodeMsg2({ ...m2, macR: flip(m2.macR) })],
    ['ek_r', encodeMsg2({ ...m2, ekPub: (await generateX25519()).pub })],
    ['pq_ct', encodeMsg2({ ...m2, pqCt: flip(m2.pqCt) })],
    ['ts_r', encodeMsg2({ ...m2, ts: m2.ts + 1 })],
  ] as const) {
    await assert.rejects(
      () => initiatorComplete(i1.state, frame, { now: NOW }),
      (e: Error) => e instanceof HandshakeError && /mac_r/.test(e.message),
      `tampering with ${what} must break mac_r`,
    )
  }
})

test('mac_i gates the responder: a tampered msg3 is rejected', async () => {
  const [ikI, ikR] = [await generateX25519(), await generateX25519()]
  const kem = toyKem()
  const i1 = await initiate({ ik: ikI, peerIkPub: ikR.pub, kem, now: NOW })
  const r1 = await respond({ ik: ikR, peerIkPub: ikI.pub, msg1: i1.msg1, kem, now: NOW })
  const i2 = await initiatorComplete(i1.state, r1.msg2, { now: NOW })
  const bad = i2.msg3.slice(); bad[bad.length - 1] ^= 0x01
  await assert.rejects(
    () => responderComplete(r1.state, bad),
    (e: Error) => e instanceof HandshakeError && /mac_i/.test(e.message),
  )
  // fail-closed: a rejected msg3 destroys the pending state, so a "corrected"
  // msg3 cannot rescue the session — the caller must start a fresh handshake.
  await assert.rejects(() => responderComplete(r1.state, i2.msg3), /mac_i/)

  // and the clean run of the same flow does complete
  const c1 = await initiate({ ik: ikI, peerIkPub: ikR.pub, kem, now: NOW })
  const c2 = await respond({ ik: ikR, peerIkPub: ikI.pub, msg1: c1.msg1, kem, now: NOW })
  const c3 = await initiatorComplete(c1.state, c2.msg2, { now: NOW })
  assert.deepEqual((await responderComplete(c2.state, c3.msg3)).sk, c3.result.sk)
})

test('an impostor cannot complete: wrong long-term key on either side', async () => {
  const [ikI, ikR, mallory] = [await generateX25519(), await generateX25519(), await generateX25519()]
  const kem = toyKem()

  // I thinks it is talking to Mallory's key, R answers with its own → no shared SK
  const i1 = await initiate({ ik: ikI, peerIkPub: mallory.pub, kem, now: NOW })
  const r1 = await respond({ ik: ikR, peerIkPub: ikI.pub, msg1: i1.msg1, kem, now: NOW })
  await assert.rejects(() => initiatorComplete(i1.state, r1.msg2, { now: NOW }), /mac_r/)

  // R resolves the wrong contact for initiator_id → caught before any DH
  const i2 = await initiate({ ik: ikI, peerIkPub: ikR.pub, kem, now: NOW })
  await assert.rejects(
    () => respond({ ik: ikR, peerIkPub: mallory.pub, msg1: i2.msg1, kem, now: NOW }),
    /initiator_id/,
  )

  // Mallory replays I's msg1 with her own IK: R (resolving Mallory) refuses,
  // because the id in the frame is I's.
  await assert.rejects(
    () => respond({ ik: ikR, peerIkPub: mallory.pub, msg1: i2.msg1, kem, now: NOW }),
    /initiator_id/,
  )
})

test('timestamps outside the ±5 min window are refused (§6.4 replay)', async () => {
  const [ikI, ikR] = [await generateX25519(), await generateX25519()]
  const kem = toyKem()
  const i1 = await initiate({ ik: ikI, peerIkPub: ikR.pub, kem, now: NOW })
  await assert.rejects(
    () => respond({ ik: ikR, peerIkPub: ikI.pub, msg1: i1.msg1, kem, now: NOW + MAX_SKEW_MS + 1 }),
    /msg1 timestamp/,
  )
  const r1 = await respond({ ik: ikR, peerIkPub: ikI.pub, msg1: i1.msg1, kem, now: NOW })
  await assert.rejects(
    () => initiatorComplete(i1.state, r1.msg2, { now: NOW - MAX_SKEW_MS - 1 }),
    /msg2 timestamp/,
  )
  // inside the window is fine (clock drift is normal)
  assert.ok((await initiatorComplete(i1.state, r1.msg2, { now: NOW + MAX_SKEW_MS - 1 })).result.sk)
})

test('KAT — fixed keys and fixed KEM randomness pin the classical schedule', async () => {
  const ikI = await x25519FromPriv(new Uint8Array(32).fill(0x11))
  const ikR = await x25519FromPriv(new Uint8Array(32).fill(0x22))
  const ekI = await x25519FromPriv(new Uint8Array(32).fill(0x33))
  const ekR = await x25519FromPriv(new Uint8Array(32).fill(0x44))
  const kem = toyKem(seededRand())

  const i1 = await initiate({ ik: ikI, peerIkPub: ikR.pub, kem, now: NOW, ek: ekI })
  const r1 = await respond({ ik: ikR, peerIkPub: ikI.pub, msg1: i1.msg1, kem, now: NOW, ek: ekR })
  const i2 = await initiatorComplete(i1.state, r1.msg2, { now: NOW })
  assert.ok((await responderComplete(r1.state, i2.msg3)).sk)

  // Recorded from this implementation — a change here means the wire format,
  // the DH ordering, the info string or the transcript changed. (The toy KEM's
  // ss is part of it; stage 3 re-records with ML-KEM-768.)
  assert.equal(b64(i2.result.sk), 'DLBOTGa3JpgLmSQW8aSbWduqNg+63qVCgh5xloJy7r8=')
})

function flip(b: Uint8Array): Uint8Array {
  const c = b.slice(); c[0] ^= 0x01; return c
}
