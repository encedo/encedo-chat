/**
 * Group persistence (§10): GroupManager.snapshot() -> JSON -> restore() rebuilds
 * the FULL group state — my sending chain AND every other member's receiving key —
 * so a reload continues the conversation with no re-distribution. Skipped keys are
 * intentionally not persisted (a restore loses only in-flight out-of-order frames).
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { generateX25519, x25519FromPriv } from '../lib/x25519.ts'
import { b64, unb64, randomBytes } from '../lib/wc.ts'
import { GroupManager, type GroupId, type Member } from '../lib/group.ts'
import { envGroupSkd, encodeEnvelope, decodeEnvelope, type GroupSkdEnv } from '../lib/envelope.ts'

const enc = new TextEncoder()
const P = { networkId: 'gpersist', dateUTC: '2026-08-02' }
const body = (s: string) => enc.encode(s)

async function softId(): Promise<GroupId> {
  const k = await generateX25519()
  return { pub: b64(k.pub), ecdh: async (peerPubB64: string) => k.dh(unb64(peerPubB64)) }
}
async function distribute(from: { id: GroupId; mgr: GroupManager }, gidHex: string, to: { id: GroupId; mgr: GroupManager }[]) {
  for (const r of to) {
    const skd = (await from.mgr.skdFor(gidHex, r.id.pub))! // per-recipient (roster MAC per member)
    await r.mgr.applySkd(from.id.pub, decodeEnvelope(encodeEnvelope(envGroupSkd(0, skd))) as GroupSkdEnv)
  }
}

test('snapshot -> JSON -> restore keeps the full group state (send + all receivers)', async () => {
  const A = await softId(), B = await softId(), C = await softId()
  const mA = new GroupManager(A, P), mB = new GroupManager(B, P), mC = new GroupManager(C, P)
  const gkPriv = randomBytes(32)
  const gk = await x25519FromPriv(gkPriv)
  const roster: Member[] = [{ pub: A.pub }, { pub: B.pub }, { pub: C.pub }]
  const gid = await mA.createGroup(gk.pub, roster, gkPriv)
  const wA = { id: A, mgr: mA }, wB = { id: B, mgr: mB }, wC = { id: C, mgr: mC }
  await distribute(wA, gid, [wB, wC]); await distribute(wB, gid, [wA, wC]); await distribute(wC, gid, [wA, wB])

  // Advance the chains so they are at non-zero positions: A sends twice, C sends once.
  await mB.session(gid)!.receive(await mA.session(gid)!.send(body('a1')))
  await mB.session(gid)!.receive(await mA.session(gid)!.send(body('a2')))
  assert.deepEqual((await mA.session(gid)!.receive(await mC.session(gid)!.send(body('c1'))))?.pt, body('c1'))

  // Persist A, drop it, rebuild a fresh manager for the SAME identity (a reload).
  const json = JSON.stringify(mA.snapshot())
  const mA2 = new GroupManager(A, P)
  const restored = await mA2.restore(JSON.parse(json))
  assert.deepEqual(restored, [gid])
  assert.equal(await mA2.session(gid)!.topic(), await mB.session(gid)!.topic())

  // 1) A keeps sending from where it left off → B opens it (send counter continued,
  //    no reuse of a spent counter).
  assert.deepEqual((await mB.session(gid)!.receive(await mA2.session(gid)!.send(body('a3'))))?.pt, body('a3'))
  // 2) A still opens NEW messages from BOTH other members with no re-distribution —
  //    this is the "we save the others' keys too / full state" property.
  assert.deepEqual((await mA2.session(gid)!.receive(await mB.session(gid)!.send(body('b1'))))?.pt, body('b1'))
  assert.deepEqual((await mA2.session(gid)!.receive(await mC.session(gid)!.send(body('c2'))))?.pt, body('c2'))
})

test('a restored member does not reuse a spent send counter', async () => {
  const A = await softId(), B = await softId()
  const mA = new GroupManager(A, P), mB = new GroupManager(B, P)
  const gkPriv = randomBytes(32)
  const gk = await x25519FromPriv(gkPriv)
  const gid = await mA.createGroup(gk.pub, [{ pub: A.pub }, { pub: B.pub }], gkPriv)
  await distribute({ id: A, mgr: mA }, gid, [{ id: B, mgr: mB }])
  await distribute({ id: B, mgr: mB }, gid, [{ id: A, mgr: mA }])

  await mB.session(gid)!.receive(await mA.session(gid)!.send(body('one')))
  const mA2 = new GroupManager(A, P)
  await mA2.restore(JSON.parse(JSON.stringify(mA.snapshot())))
  // B already consumed counter 0; the restored A must send counter 1, which B opens.
  assert.deepEqual((await mB.session(gid)!.receive(await mA2.session(gid)!.send(body('two'))))?.pt, body('two'))
})
