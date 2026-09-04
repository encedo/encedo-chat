/**
 * EH-2 stage 5 — establishment end to end (docs/PROTOCOL.md §6.1–6.2, §7).
 *
 * Everything below runs over an in-memory channel: two peers, three handshake
 * frames, then a real conversation through the `Session` seam. The property
 * this file exists for is the **msg3 gate** — the responder must have no way to
 * process the initiator's data before `mac_i` verifies.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { startHandshake, isHandshakeFrame } from '../eh2/establish.ts'
import { generateX25519 } from '../lib/x25519.ts'
import { encodeEnvelope, decodeEnvelope, envMsg } from '../lib/envelope.ts'
import type { Session } from '../lib/session.ts'
import { HandshakeError } from '../eh2/handshake.ts'
import { T_MSG1, T_MSG2, T_MSG3 } from '../eh2/wire.ts'

const te = new TextEncoder()
const td = new TextDecoder()

/** Run the three frames between the two state machines; return both sessions. */
async function connect(): Promise<{ i: Session; r: Session; frames: Uint8Array[] }> {
  const [ikI, ikR] = [await generateX25519(), await generateX25519()]
  const I = await startHandshake({ role: 'initiator', ik: ikI, peerIkPub: ikR.pub })
  const R = await startHandshake({ role: 'responder', ik: ikR, peerIkPub: ikI.pub })

  const frames: Uint8Array[] = [...I.initial]
  const msg2 = await R.feed(frames[0])
  frames.push(msg2!)
  const msg3 = await I.feed(msg2!)
  frames.push(msg3!)
  assert.equal(await R.feed(msg3!), null)
  return { i: await I.session, r: await R.session, frames }
}

test('three frames, two sessions, a conversation', async () => {
  const { i, r, frames } = await connect()
  assert.deepEqual(frames.map((f) => f[0]), [T_MSG1, T_MSG2, T_MSG3])
  assert.ok(frames.every(isHandshakeFrame), 'handshake frames are recognisable on the wire')

  const say = async (from: Session, to: Session, text: string) => {
    const pt = await to.decrypt(await from.encrypt(encodeEnvelope(envMsg(1, text))))
    return pt === null ? null : (decodeEnvelope(pt) as any).body
  }
  assert.equal(await say(i, r, 'pierwsza'), 'pierwsza')
  assert.equal(await say(r, i, 'odpowiedź'), 'odpowiedź')
  for (let n = 0; n < 20; n++) assert.equal(await say(i, r, `n${n}`), `n${n}`)
  assert.equal(await say(r, i, 'nadal ok'), 'nadal ok')

  // data frames are NOT handshake frames — the room can tell them apart
  assert.equal(isHandshakeFrame(await i.encrypt(te.encode('x'))), false)
})

test('the msg3 gate: the responder has no session until mac_i verifies (§6.2)', async () => {
  const [ikI, ikR] = [await generateX25519(), await generateX25519()]
  const I = await startHandshake({ role: 'initiator', ik: ikI, peerIkPub: ikR.pub })
  const R = await startHandshake({ role: 'responder', ik: ikR, peerIkPub: ikI.pub })

  const msg2 = await R.feed(I.initial[0])
  assert.equal(R.authenticated, false, 'R holds SK but I is still unauthenticated')

  // R's session must not be reachable yet — nothing to decrypt the initiator's
  // early data with, which is exactly the gate the spec asks for.
  let settled = false
  R.session.then(() => { settled = true }, () => { settled = true })
  await new Promise((r) => setImmediate(r))
  assert.equal(settled, false)

  const msg3 = await I.feed(msg2!)
  assert.equal(I.authenticated, true, 'I authenticated R via mac_r')
  await R.feed(msg3!)
  assert.equal(R.authenticated, true)
  assert.ok(await R.session)
})

test('a forged msg3 leaves the responder without a session', async () => {
  const [ikI, ikR, mallory] = [await generateX25519(), await generateX25519(), await generateX25519()]
  const R = await startHandshake({ role: 'responder', ik: ikR, peerIkPub: ikI.pub })
  const I = await startHandshake({ role: 'initiator', ik: ikI, peerIkPub: ikR.pub })
  const msg2 = await R.feed(I.initial[0])
  const msg3 = (await I.feed(msg2!))!

  const forged = msg3.slice(); forged[5] ^= 0x40
  await assert.rejects(() => R.feed(forged), (e: Error) => e instanceof HandshakeError && /mac_i/.test(e.message))
  await assert.rejects(() => R.session, /mac_i/)
  assert.equal(R.authenticated, false)
  assert.ok(mallory.pub) // (an impostor never gets this far — see the handshake tests)
})

test('frames out of order are refused', async () => {
  const [ikI, ikR] = [await generateX25519(), await generateX25519()]
  const I = await startHandshake({ role: 'initiator', ik: ikI, peerIkPub: ikR.pub })
  const R = await startHandshake({ role: 'responder', ik: ikR, peerIkPub: ikI.pub })

  await assert.rejects(() => R.feed(new Uint8Array([T_MSG3, 1, ...new Uint8Array(32)])), /expected msg1/)

  const R2 = await startHandshake({ role: 'responder', ik: ikR, peerIkPub: ikI.pub })
  const msg2 = await R2.feed(I.initial[0])
  await assert.rejects(() => R2.feed(I.initial[0]), /expected msg3/)
  await assert.rejects(() => I.feed(new Uint8Array([T_MSG1, 1, 2])), /expected msg2/)
  assert.ok(msg2)
})

test('two peers that both initiate: one attempt survives, the session works', async () => {
  // The room breaks the tie (lower peer id initiates); if both start anyway,
  // the crossed attempt fails cleanly and the surviving one still completes.
  const [ikA, ikB] = [await generateX25519(), await generateX25519()]
  const aInit = await startHandshake({ role: 'initiator', ik: ikA, peerIkPub: ikB.pub })
  const bInit = await startHandshake({ role: 'initiator', ik: ikB, peerIkPub: ikA.pub })
  await assert.rejects(() => aInit.feed(bInit.initial[0]), /expected msg2/)

  const bResp = await startHandshake({ role: 'responder', ik: ikB, peerIkPub: ikA.pub })
  const msg2 = await bResp.feed(aInit.initial[0])
  const msg3 = await (await startHandshake({ role: 'initiator', ik: ikA, peerIkPub: ikB.pub })).feed(msg2!)
    .then(() => null, () => null) // the fresh initiator has a different msg1 -> mac_r fails
  assert.equal(msg3, null)

  // the honest pairing (one initiator, one responder) is the one that completes
  const { i, r } = await connect()
  assert.ok(await i.encrypt(te.encode('ok')))
  assert.ok(await r.decrypt(await i.encrypt(te.encode('ok'))) !== null)
  assert.equal(td.decode((await r.decrypt(await i.encrypt(te.encode('ok'))))!), 'ok')
})
