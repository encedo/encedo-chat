/**
 * Group state + wire (`lib/group.ts`): shared topic, 3-member send/receive over
 * sender keys, the per-recipient MAC gate — including the insider-forge test that
 * is the whole point of §8: a member holding another's sending chain can re-seal a
 * body but cannot forge that member's MAC to a THIRD party.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { generateX25519 } from '../lib/x25519.ts'
import { b64, unb64, concat, randomBytes } from '../lib/wc.ts'
import {
  GroupSession, groupIdFromGK, senderIdOf, msgMacKeyFromSecret,
  type GroupId, type Member,
} from '../lib/group.ts'
import { seal, sendChainFrom, tag } from '../lib/senderkey.ts'

const enc = new TextEncoder()
const P = { networkId: 'gtest', dateUTC: '2026-08-01' }
const body = (s: string) => enc.encode(s)

async function softId(): Promise<GroupId & { raw: Awaited<ReturnType<typeof generateX25519>> }> {
  const k = await generateX25519()
  return { raw: k, pub: b64(k.pub), ecdh: async (peerPubB64: string) => k.dh(unb64(peerPubB64)) }
}

/** Build the 3 members' sessions and cross-distribute their sender keys. */
async function makeGroup() {
  const A = await softId(), B = await softId(), C = await softId()
  const gk = await generateX25519()
  const gid = await groupIdFromGK(gk.pub)
  const groupSecret = randomBytes(32)
  const epoch = 0
  const members: Member[] = [{ pub: A.pub }, { pub: B.pub }, { pub: C.pub }]
  const mk = async (id: GroupId) => GroupSession.create({ id, gid, epoch, groupSecret, members, params: P })
  const sa = await mk(A), sb = await mk(B), sc = await mk(C)
  // distribution (stage 3 does this over 1:1; here we hand keys directly)
  const keys = { [A.pub]: sa.mySenderKey(), [B.pub]: sb.mySenderKey(), [C.pub]: sc.mySenderKey() }
  for (const [who, s] of [[A.pub, sa], [B.pub, sb], [C.pub, sc]] as const)
    for (const other of [A.pub, B.pub, C.pub]) if (other !== who) s.setSenderKey(other, keys[other])
  return { A, B, C, gid, groupSecret, epoch, members, sa, sb, sc }
}

test('all members derive the same topic; a different secret gives a different one', async () => {
  const g = await makeGroup()
  const t = await g.sa.topic()
  assert.equal(t.length, 52)
  assert.equal(await g.sb.topic(), t)
  assert.equal(await g.sc.topic(), t)
  const other = await GroupSession.create({ id: g.A, gid: g.gid, epoch: 0, groupSecret: randomBytes(32), members: g.members, params: P })
  assert.notEqual(await other.topic(), t)
})

test('group_id is SHA-256(GK_pub)[0:16], deterministic', async () => {
  const gk = await generateX25519()
  assert.deepEqual(await groupIdFromGK(gk.pub), await groupIdFromGK(gk.pub))
  assert.equal((await groupIdFromGK(gk.pub)).length, 16)
})

test('A broadcasts, B and C decrypt, A does not open its own echo', async () => {
  const g = await makeGroup()
  const frame = await g.sa.send(body('hej grupo'))
  const atB = await g.sb.receive(frame)
  const atC = await g.sc.receive(frame)
  assert.deepEqual(atB?.pt, body('hej grupo')); assert.equal(atB?.from, g.A.pub)
  assert.deepEqual(atC?.pt, body('hej grupo'))
  assert.equal(await g.sa.receive(frame), null, 'own echo is dropped')
})

test('a member without the sender key cannot open (distribution has not reached it)', async () => {
  const g = await makeGroup()
  const frame = await g.sa.send(body('x'))
  // fresh C-session that never received A's sender key
  const cFresh = await GroupSession.create({ id: g.C, gid: g.gid, epoch: 0, groupSecret: g.groupSecret, members: g.members, params: P })
  assert.equal(await cFresh.receive(frame), null)
})

test('a tampered MAC is rejected by that recipient', async () => {
  const g = await makeGroup()
  const frame = await g.sa.send(body('genuine'))
  // flip a byte inside the mac region (after T,ver,header,macCount)
  const bad = frame.slice(); bad[2 + 32 + 1 + 8] ^= 0xff // first byte of the first mac
  const out = await g.sb.receive(bad)
  assert.equal(out, null, 'B (first recipient) rejects the tampered mac')
})

test('insider-forge: B re-seals under A\'s chain but cannot forge A->C\'s MAC', async () => {
  const g = await makeGroup()
  // B is malicious: it holds A's sending key (distributed), so it can seal a body
  // "as A". It builds a frame addressed to C and MACs it with the only key it can
  // make for C — mk_{B,C}, NOT mk_{A,C}.
  const aKey = g.sa.mySenderKey()
  const sidA = await senderIdOf(g.A.pub)
  const sidC = await senderIdOf(g.C.pub)
  const header = new Uint8Array(32); header.set(g.gid, 0); header.set(sidA, 16)
  new DataView(header.buffer).setUint32(24, 0, false); new DataView(header.buffer).setUint32(28, 0, false)
  const { ct } = await seal(sendChainFrom(aKey), header, body('forged as A'))
  const ssBC = await g.B.ecdh(g.C.pub)
  const wrongMac = await tag(await msgMacKeyFromSecret(ssBC, g.gid, 0), header, ct)
  const forged = concat(new Uint8Array([0x20, 1]), header, new Uint8Array([1]), sidC, wrongMac, ct)
  assert.equal(await g.sc.receive(forged), null, 'C rejects a frame claiming to be from A but MAC\'d by B')
})

test('out-of-order across the group: later message opens, earlier one follows', async () => {
  const g = await makeGroup()
  const f0 = await g.sa.send(body('a0'))
  const f1 = await g.sa.send(body('a1'))
  assert.deepEqual((await g.sb.receive(f1))?.pt, body('a1'))
  assert.deepEqual((await g.sb.receive(f0))?.pt, body('a0'))
})
