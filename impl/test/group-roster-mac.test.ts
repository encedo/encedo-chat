/**
 * Roster MAC — admin-authoritative roster (§8 roster auth, ECDH-HMAC Proposal).
 * The roster is authoritative ONLY from the admin: the admin holds GK_priv and
 * MACs the roster per recipient (rk_i = HKDF(ECDH(GK_priv, IK_i))); a member
 * verifies with ECDH(IK_i, GK_pub) — commutative, so no GK_priv needed, and
 * deniable. STRICT: an epoch/roster ADVANCE is accepted only with a valid admin
 * MAC; same-epoch key redistribution (a member handing over its sending key)
 * needs none. The gid is bound to the GK so a real gid cannot be paired with a
 * forged GK.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { generateX25519, x25519FromPriv } from '../lib/x25519.ts'
import { b64, unb64, randomBytes } from '../lib/wc.ts'
import { GroupManager, softwareGk, type GroupId, type Member } from '../lib/group.ts'
import type { SkdFields } from '../lib/envelope.ts'

const P = { networkId: 'grmac', dateUTC: '2026-08-03' }
async function softId(): Promise<GroupId> {
  const k = await generateX25519()
  return { pub: b64(k.pub), ecdh: async (p: string) => k.dh(unb64(p)) }
}
type Peer = { id: GroupId; mgr: GroupManager }
async function peer(): Promise<Peer> { const id = await softId(); return { id, mgr: new GroupManager(id, P) } }

/** Admin A creates a group {A, B}; returns A's SKD for B (carrying a roster MAC). */
async function setup() {
  const A = await peer(), B = await peer()
  const { gk, pub: gkPub } = await softwareGk()
  const roster: Member[] = [{ pub: A.id.pub }, { pub: B.id.pub }]
  const gid = await A.mgr.createGroup(gkPub, roster, gk)
  const skdB = (await A.mgr.skdFor(gid, B.id.pub))!
  return { A, B, gid, skdB }
}

test('the admin SKD carries a roster MAC and a member accepts it', async () => {
  const { A, B, gid, skdB } = await setup()
  assert.ok(skdB.rmac, 'the admin SKD carries a roster MAC')
  await B.mgr.applySkd(A.id.pub, skdB) // must not throw
  assert.ok(B.mgr.session(gid), 'B established the group')
})

test('an epoch advance WITHOUT a roster MAC is rejected (strict)', async () => {
  const { A, B, skdB } = await setup()
  const noMac: SkdFields = { ...skdB }; delete noMac.rmac
  await assert.rejects(B.mgr.applySkd(A.id.pub, noMac), /roster MAC/)
})

test('a tampered roster fails the MAC and is rejected', async () => {
  const { A, B, skdB } = await setup()
  const tampered: SkdFields = { ...skdB, roster: [...skdB.roster, b64(randomBytes(32))] } // smuggle in a member
  await assert.rejects(B.mgr.applySkd(A.id.pub, tampered), /roster MAC/)
})

test('an SKD whose gid does not match its GK is rejected (binding)', async () => {
  const { A, B, skdB } = await setup()
  const forgedGk: SkdFields = { ...skdB, gkPub: b64(randomBytes(32)) } // real gid, attacker GK
  await assert.rejects(B.mgr.applySkd(A.id.pub, forgedGk), /does not match its GK/)
})

test('same-epoch key redistribution needs NO roster MAC', async () => {
  const { A, B, gid, skdB } = await setup()
  await B.mgr.applySkd(A.id.pub, skdB) // B is now at epoch 0
  const aSame = (await A.mgr.skdFor(gid))! // no recipient named → no rmac
  assert.equal(aSame.rmac, undefined)
  await B.mgr.applySkd(A.id.pub, aSame) // same epoch, key-only → must not throw
})
