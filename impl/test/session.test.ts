import { test } from 'node:test'
import assert from 'node:assert/strict'
import { eh2Session } from '../lib/session.ts'
import { encodeEnvelope, decodeEnvelope, envMsg } from '../lib/envelope.ts'
import { initiate, initiatorComplete, respond, responderComplete } from '../eh2/handshake.ts'
import { generateX25519 } from '../lib/x25519.ts'
import { mlkem768 } from '../eh2/mlkem.ts'

const P = { networkId: 'main', dateUTC: '2026-07-27' }

test('eh2 session: the same seam, now backed by the ratchet', async () => {
  const [ikI, ikR] = [await generateX25519(), await generateX25519()]
  const i1 = await initiate({ ik: ikI, peerIkPub: ikR.pub, kem: mlkem768 })
  const r1 = await respond({ ik: ikR, peerIkPub: ikI.pub, msg1: i1.msg1, kem: mlkem768 })
  const i2 = await initiatorComplete(i1.state, r1.msg2)
  const rr = await responderComplete(r1.state, i2.msg3)

  const [a, b] = [await eh2Session(i2.result), await eh2Session(rr)]
  const pt = await b.decrypt(await a.encrypt(encodeEnvelope(envMsg(1, 'przez seam, z ratchetem'))))
  assert.notEqual(pt, null)
  assert.equal((decodeEnvelope(pt!) as any).body, 'przez seam, z ratchetem')
  // the same plaintext never seals the same way (per-message forward secrecy)
  const [x, y] = [await a.encrypt(new Uint8Array([7])), await a.encrypt(new Uint8Array([7]))]
  assert.notDeepEqual(x, y)
})
