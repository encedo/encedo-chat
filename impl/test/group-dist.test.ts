/**
 * Sender-Key Distribution (`lib/group.ts` GroupManager + the `group-skd`
 * envelope): a group is bootstrapped by each member handing its sending key to
 * the others over 1:1, then everyone can send/receive on the shared topic. This
 * drives the whole stack (senderkey + group + envelope) end to end in memory.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { generateX25519, x25519FromPriv } from '../lib/x25519.ts'
import { b64, unb64, randomBytes } from '../lib/wc.ts'
import { GroupManager, groupIdFromGK, type GroupId, type Member } from '../lib/group.ts'
import { envGroupSkd, encodeEnvelope, decodeEnvelope, type GroupSkdEnv } from '../lib/envelope.ts'

const enc = new TextEncoder()
const P = { networkId: 'gdist', dateUTC: '2026-08-01' }
const body = (s: string) => enc.encode(s)

async function softId(): Promise<GroupId> {
  const k = await generateX25519()
  return { pub: b64(k.pub), ecdh: async (peerPubB64: string) => k.dh(unb64(peerPubB64)) }
}

/** `from` hands its SKD for `gid` to each recipient — over the wire (envelope
 *  encode → decode), exactly as the 1:1 ratchet would carry it. */
async function distribute(from: { id: GroupId; mgr: GroupManager }, gidHex: string, to: { id: GroupId; mgr: GroupManager }[]) {
  for (const r of to) {
    const skd = (await from.mgr.skdFor(gidHex, r.id.pub))! // per-recipient: the roster MAC is per member
    const e = decodeEnvelope(encodeEnvelope(envGroupSkd(0, skd))) as GroupSkdEnv
    assert.equal(e.t, 'group-skd')
    await r.mgr.applySkd(from.id.pub, e)
  }
}

test('3 members bootstrap via SKD, then broadcast on the shared topic', async () => {
  const A = await softId(), B = await softId(), C = await softId()
  const mA = new GroupManager(A, P), mB = new GroupManager(B, P), mC = new GroupManager(C, P)
  const gkPriv = randomBytes(32)
  const gk = await x25519FromPriv(gkPriv)
  const roster: Member[] = [{ pub: A.pub }, { pub: B.pub }, { pub: C.pub }]

  // A creates the group and distributes; then B and C distribute back.
  const gid = await mA.createGroup(gk.pub, roster, gkPriv)
  const wA = { id: A, mgr: mA }, wB = { id: B, mgr: mB }, wC = { id: C, mgr: mC }
  await distribute(wA, gid, [wB, wC])
  await distribute(wB, gid, [wA, wC])
  await distribute(wC, gid, [wA, wB])

  // Everyone landed on the same gid + topic.
  assert.equal(mB.gidHexOf(await groupIdFromGK(gk.pub)), gid)
  const topic = await mA.session(gid)!.topic()
  assert.equal(await mB.session(gid)!.topic(), topic)
  assert.equal(await mC.session(gid)!.topic(), topic)

  // A broadcasts → B and C decrypt.
  const f1 = await mA.session(gid)!.send(body('grupa dziala'))
  assert.deepEqual((await mB.session(gid)!.receive(f1))?.pt, body('grupa dziala'))
  assert.deepEqual((await mC.session(gid)!.receive(f1))?.pt, body('grupa dziala'))

  // …and C broadcasts → A and B decrypt (every member has every sender key).
  const f2 = await mC.session(gid)!.send(body('od C'))
  assert.deepEqual((await mA.session(gid)!.receive(f2))?.pt, body('od C'))
  assert.deepEqual((await mB.session(gid)!.receive(f2))?.pt, body('od C'))
})

test('before it receives an SKD, a member cannot open a broadcast', async () => {
  const A = await softId(), B = await softId()
  const mA = new GroupManager(A, P), mB = new GroupManager(B, P)
  const gkPriv = randomBytes(32)
  const gk = await x25519FromPriv(gkPriv)
  const gid = await mA.createGroup(gk.pub, [{ pub: A.pub }, { pub: B.pub }], gkPriv)
  // A sent, but B never got A's SKD → B has no group at all.
  await distribute({ id: A, mgr: mA }, gid, []) // no-op recipient list
  assert.equal(mB.session(gid), undefined)
})

test('the group-skd envelope round-trips and validates', () => {
  const skd = { gid: b64(randomBytes(16)), gkPub: b64(randomBytes(32)), epoch: 2, secret: b64(randomBytes(32)), chain: b64(randomBytes(32)), roster: ['p1', 'p2'] }
  const e = decodeEnvelope(encodeEnvelope(envGroupSkd(5, skd))) as GroupSkdEnv
  assert.equal(e.t, 'group-skd'); assert.equal(e.epoch, 2); assert.deepEqual(e.roster, ['p1', 'p2'])
  // a malformed one (missing chain) drops
  const bad = encodeEnvelope({ v: 1, t: 'group-skd', id: 'x', ts: 1, seq: 0, gid: 'g', gkPub: 'k', epoch: 0, secret: 's', roster: [] } as any)
  assert.equal(decodeEnvelope(bad), null)
})
