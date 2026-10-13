/**
 * Roster authority lives in the engine (SPEC.md §8.3 / §8.4).
 *
 * The audit of 2026-10-11 found the front-ends keeping a roster of their own,
 * adopted from ANY same-epoch SKD, and handing out `group_secret` + the own
 * sending chain to whoever that roster named. The engine was right all along
 * (a roster advances only under the admin's MAC); the leak was that it said
 * nothing when it refused, so the layer above could not tell a refusal from
 * a handoff. These tests pin the engine's word on every outcome, and that the
 * engine itself never builds a distribution for somebody outside the roster -
 * so a caller that forgets to ask cannot leak anyway.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { generateX25519 } from '../lib/x25519.ts'
import { b64, unb64, randomBytes } from '../lib/wc.ts'
import { GroupManager, softwareGk, type GroupId, type Member, type SkdFields } from '../lib/group.ts'

const P = { networkId: 'gauth', dateUTC: '2026-10-11' }

async function softId(): Promise<GroupId> {
  const k = await generateX25519()
  return { pub: b64(k.pub), ecdh: async (p: string) => k.dh(unb64(p)) }
}
type Peer = { id: GroupId; mgr: GroupManager }
const peer = async (): Promise<Peer> => { const id = await softId(); return { id, mgr: new GroupManager(id, P) } }
const hand = async (from: Peer, gid: string, to: Peer) => to.mgr.applySkd(from.id.pub, (await from.mgr.skdFor(gid, to.id.pub))!)

/** A, B, C at epoch 0 with every sender key shared; A administers. */
async function boot() {
  const A = await peer(), B = await peer(), C = await peer()
  const { gk, pub: gkPub } = await softwareGk()
  const roster: Member[] = [A, B, C].map((p) => ({ pub: p.id.pub }))
  const gid = await A.mgr.createGroup(gkPub, roster, gk)
  for (const m of [B, C]) await hand(A, gid, m)
  for (const s of [A, B, C]) for (const r of [A, B, C]) if (s !== r) await hand(s, gid, r)
  return { A, B, C, gid, gkPub }
}

test('applySkd says what it did: joined / rekeyed / senderkey', async () => {
  const A = await peer(), B = await peer()
  const { gk, pub: gkPub } = await softwareGk()
  const gid = await A.mgr.createGroup(gkPub, [{ pub: A.id.pub }, { pub: B.id.pub }], gk)
  assert.equal(await B.mgr.applySkd(A.id.pub, (await A.mgr.skdFor(gid, B.id.pub))!), 'joined')
  assert.equal(await A.mgr.applySkd(B.id.pub, (await B.mgr.skdFor(gid, A.id.pub))!), 'senderkey')
  await A.mgr.rekey(gid, [{ pub: A.id.pub }, { pub: B.id.pub }])
  assert.equal(await B.mgr.applySkd(A.id.pub, (await A.mgr.skdFor(gid, B.id.pub))!), 'rekeyed')
  assert.deepEqual(B.mgr.roster(gid), [A.id.pub, B.id.pub], 'the roster the engine holds is the admin-attested one')
  assert.equal(B.mgr.isMember(gid, A.id.pub), true)
})

test('a same-epoch SKD from outside the roster is refused and changes nothing', async () => {
  const { A, B, gid, gkPub } = await boot()
  const X = await peer() // a contact of B, never a member
  const before = B.mgr.roster(gid)
  const forged: SkdFields = {
    gid: b64(unb64((await A.mgr.skdFor(gid, B.id.pub))!.gid)), gkPub: b64(gkPub), epoch: 0,
    secret: b64(randomBytes(32)), chain: b64(randomBytes(32)), ctr: 0,
    roster: [...before, X.id.pub], // X writes itself in
  }
  assert.equal(await B.mgr.applySkd(X.id.pub, forged), 'refused')
  assert.deepEqual(B.mgr.roster(gid), before, 'the roster did not move')
  assert.equal(B.mgr.isMember(gid, X.id.pub), false)
})

test('the engine never builds a distribution for a non-member, whatever the caller asks', async () => {
  const { B, gid } = await boot()
  const X = await peer()
  assert.equal(await B.mgr.skdFor(gid, X.id.pub), null, 'no SKD for an outsider')
  assert.notEqual(await B.mgr.skdFor(gid), null, 'the unaddressed form (a member re-distributing) still works')
})

test('a removed member guessing the next epoch gets neither the roster nor a key', async () => {
  const { A, B, C, gid, gkPub } = await boot()
  // A removes C: epoch 1, distributed to B only.
  await A.mgr.rekey(gid, [{ pub: A.id.pub }, { pub: B.id.pub }])
  await hand(A, gid, B)
  assert.equal(B.mgr.isMember(gid, C.id.pub), false, 'C is out at epoch 1')
  // C still holds the contact, GK_pub and the old gid; it guesses epoch 1 and
  // names itself in the roster. No roster MAC - C has no GK_priv.
  const skdC = (await C.mgr.skdFor(gid))!
  const forged: SkdFields = { ...skdC, epoch: 1, roster: [A.id.pub, B.id.pub, C.id.pub], rmac: undefined }
  assert.equal(await B.mgr.applySkd(C.id.pub, forged), 'refused')
  assert.deepEqual(B.mgr.roster(gid), [A.id.pub, B.id.pub])
  // ...and the repair path cannot be aimed at B either.
  assert.equal(await B.mgr.skdFor(gid, C.id.pub), null, 'B builds no SKD for C')
})

test('an older-epoch SKD from a current member is stale: ignored, the chain untouched', async () => {
  const { A, B, gid } = await boot()
  const old = (await B.mgr.skdFor(gid, A.id.pub))!          // B's key at epoch 0
  await A.mgr.rekey(gid, [{ pub: A.id.pub }, { pub: B.id.pub }])
  await hand(A, gid, B)
  await hand(B, gid, A)                                      // B's fresh epoch-1 key
  assert.equal(await A.mgr.applySkd(B.id.pub, old), 'stale')
  // B's epoch-1 frames still open at A: the stale copy did not overwrite the key.
  const frame = await B.mgr.session(gid)!.send(new TextEncoder().encode('still readable'))
  assert.equal(new TextDecoder().decode((await A.mgr.session(gid)!.receive(frame))!.pt), 'still readable')
})
