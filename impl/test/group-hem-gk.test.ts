/**
 * GK inside the HEM (§8, bucket A) — the admin's group key as an HSM object.
 *
 * Bucket B made GK a raw scalar the client held and persisted. Bucket A moves
 * it behind `AdminGk`: the private half lives in the HEM, `dh` is an `ecdh`
 * call, and persistence stores a KID instead of key material. Members are
 * unaffected — they verify with `ECDH(IK_i, GK_pub)` either way — so the two
 * backings MUST be indistinguishable from outside, which is the first test here.
 *
 * The rest is about HSM traffic. Every roster MAC is an `ecdh`, and a
 * membership change re-MACs the whole roster, so the naive version would call
 * the device once per member per change. The secret depends on (GK, member) and
 * NOT on the epoch, so it is memoised: a change costs one call per NEW member
 * and nothing for anyone already there. That bound is a load-bearing property
 * of this design, not an optimisation — it is what makes a 10-person group
 * usable on a hardware token — so it is pinned here.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { generateX25519, x25519FromPriv } from '../lib/x25519.ts'
import { b64, unb64, randomBytes } from '../lib/wc.ts'
import { GroupManager, softwareGk, groupIdFromGK, type GroupId, type Member, type GkBackend } from '../lib/group.ts'
import { hemGkBackend } from '../lib/core.ts'
import { parseMarker, hemKid } from '../lib/gmarker.ts'

const P = { networkId: 'gkhem', dateUTC: '2026-08-04' }
const dec = (b64s: string) => new TextDecoder().decode(unb64(b64s))

async function softId(): Promise<GroupId> {
  const k = await generateX25519()
  return { pub: b64(k.pub), ecdh: async (p: string) => k.dh(unb64(p)) }
}

/**
 * A HEM that is real X25519 underneath and counts what it was asked to do.
 * Real crypto matters: a stub returning fixed bytes would let a broken roster
 * MAC pass, and the point of the first test is that members cannot tell the
 * backings apart.
 */
function fakeHem() {
  const keys = new Map<string, { priv: Uint8Array; pub: Uint8Array; label: string; descr: string }>()
  const calls = { ecdh: 0, createKeyPair: 0, getPubKey: 0, authorize: 0, updateKey: 0, deleteKey: 0, importPublicKey: 0, searchKeys: 0 }
  let n = 0
  return {
    calls,
    keys,
    async authorizePassword(_pw: string | null, scope: string) { calls.authorize++; return `tok:${scope}` },
    async createKeyPair(_t: string, label: string, type: string, descr: string) {
      calls.createKeyPair++
      assert.equal(type, 'CURVE25519', 'GK must be an X25519 key')
      const priv = randomBytes(32)
      const pub = (await x25519FromPriv(priv)).pub
      const kid = `kid-${++n}`
      keys.set(kid, { priv, pub, label, descr })
      return { kid }
    },
    async updateKey(_t: string, kid: string, label: string, descr: string) {
      calls.updateKey++
      const k = keys.get(kid); if (!k) throw new Error('no such kid')
      keys.set(kid, { ...k, label, descr })
      return {}
    },
    async deleteKey(_t: string, kid: string) {
      calls.deleteKey++
      if (!keys.delete(kid)) throw new Error('no such kid')
      return {}
    },
    async getPubKey(_t: string, kid: string) {
      calls.getPubKey++
      const k = keys.get(kid); if (!k) throw new Error('no such kid')
      return { pubkey: b64(k.pub), type: 'CURVE25519', updated: 0 }
    },
    async ecdh(_t: string, kid: string, peerPubB64: string) {
      calls.ecdh++
      const k = keys.get(kid); if (!k) throw new Error('no such kid')
      return (await x25519FromPriv(k.priv)).dh(unb64(peerPubB64))
    },
    // Anchored PREFIX matching, as the device does it — the owner filter is the
    // whole scoping mechanism, so a stub that ignored the prefix would let a
    // broken one pass.
    async searchKeys(_t: string, pat: string) {
      calls.searchKeys++
      return [...keys.entries()]
        .filter(([, k]) => dec(k.descr).startsWith(pat))
        .map(([kid, k]) => ({ kid, label: k.label, type: 'CURVE25519', description: unb64(k.descr) }))
    },
    // A device holds one public key ONCE, whatever DESCR it sits under: the KID
    // indexes the key's content. Modelled here, because it is the rule the
    // member-marker path has to survive rather than assume away.
    async importPublicKey(_t: string, label: string, type: string, pub: Uint8Array, descr: string) {
      calls.importPublicKey++
      assert.equal(type, 'CURVE25519')
      const kid = await hemKid(pub)
      if (keys.has(kid)) throw new Error('key already present')
      keys.set(kid, { priv: new Uint8Array(0), pub, label, descr })
      return { kid }
    },
  }
}

type Peer = { id: GroupId; mgr: GroupManager }
async function peer(backend?: GkBackend): Promise<Peer> {
  const id = await softId()
  return { id, mgr: new GroupManager(id, P, backend) }
}

test('a HEM-backed GK is indistinguishable from a software one to a member', async () => {
  const hem = fakeHem()
  const A = await peer(hemGkBackend(hem)), B = await peer()
  const roster: Member[] = [{ pub: A.id.pub }, { pub: B.id.pub }]
  const gid = await A.mgr.createGroupWithNewKey('chat-gk-test', roster)

  const skdB = (await A.mgr.skdFor(gid, B.id.pub))!
  assert.ok(skdB.rmac, 'the admin still MACs the roster — GK_priv being in the HSM is invisible here')
  await B.mgr.applySkd(A.id.pub, skdB) // verifies with ECDH(IK_B, GK_pub); must not throw
  assert.ok(B.mgr.session(gid), 'the member established the group')

  // gid is still SHA-256(GK_pub)[0:16] — the HSM changed where the private half
  // lives, not what identifies the group.
  const gkPub = unb64(skdB.gkPub)
  assert.equal(A.mgr.gidHexOf(await groupIdFromGK(gkPub)), gid)
  assert.equal(hem.calls.createKeyPair, 1, 'one keypair per group')
  assert.equal(hem.calls.getPubKey, 1, 'createKeyPair returns only a kid, so exactly one getPubKey')
})

test('GK_priv never leaves the HSM: nothing persisted is key material', async () => {
  const hem = fakeHem()
  const A = await peer(hemGkBackend(hem))
  const gid = await A.mgr.createGroupWithNewKey('chat-gk-test', [{ pub: A.id.pub }])

  const snap = A.mgr.snapshot().find((s) => A.mgr.gidHexOf(unb64(s.gid)) === gid)!
  assert.ok(snap.gkKid, 'the snapshot references the HSM key')
  assert.equal(snap.gkPriv, undefined, 'and carries NO private scalar — the bucket-A win')
  // The scalar the HSM holds must not appear anywhere in what we would write to disk.
  const priv = hem.keys.get(snap.gkKid!)!.priv
  assert.ok(!JSON.stringify(snap).includes(b64(priv)), 'no GK scalar anywhere in the snapshot')
})

test('the roster-MAC secret is memoised: a rekey with the same members costs no HSM calls', async () => {
  const hem = fakeHem()
  const A = await peer(hemGkBackend(hem))
  const B = await peer(), C = await peer()
  const roster: Member[] = [{ pub: A.id.pub }, { pub: B.id.pub }, { pub: C.id.pub }]
  const gid = await A.mgr.createGroupWithNewKey('chat-gk-test', roster)

  // First distribution: one ecdh per recipient, unavoidable.
  await A.mgr.skdFor(gid, B.id.pub)
  await A.mgr.skdFor(gid, C.id.pub)
  const afterFirst = hem.calls.ecdh
  assert.equal(afterFirst, 2, 'one ecdh per member the first time')

  // MACing the same members again — same epoch — must not touch the device.
  await A.mgr.skdFor(gid, B.id.pub)
  await A.mgr.skdFor(gid, C.id.pub)
  assert.equal(hem.calls.ecdh, afterFirst, 'a repeat SKD is free')

  // A membership change bumps the epoch and re-MACs the whole roster. The epoch
  // enters through HKDF, AFTER the ECDH, so the memo still holds: removing C and
  // re-MACing for B costs nothing.
  await A.mgr.rekey(gid, [{ pub: A.id.pub }, { pub: B.id.pub }])
  await A.mgr.skdFor(gid, B.id.pub)
  assert.equal(hem.calls.ecdh, afterFirst, 'a rekey re-MACs an existing member without the HSM')

  // Only a genuinely new member costs a call.
  const D = await peer()
  await A.mgr.rekey(gid, [{ pub: A.id.pub }, { pub: B.id.pub }, { pub: D.id.pub }])
  await A.mgr.skdFor(gid, B.id.pub)
  await A.mgr.skdFor(gid, D.id.pub)
  assert.equal(hem.calls.ecdh, afterFirst + 1, 'exactly one new ecdh, for the new member only')
})

test('a memoised secret is still the RIGHT secret — the member verifies after a rekey', async () => {
  const hem = fakeHem()
  const A = await peer(hemGkBackend(hem)), B = await peer()
  const roster: Member[] = [{ pub: A.id.pub }, { pub: B.id.pub }]
  const gid = await A.mgr.createGroupWithNewKey('chat-gk-test', roster)
  await B.mgr.applySkd(A.id.pub, (await A.mgr.skdFor(gid, B.id.pub))!)

  // Rekey (the MAC key changes: same ECDH, new epoch through HKDF). If the memo
  // leaked the epoch, this MAC would be stale and B would reject it.
  const C = await peer()
  await A.mgr.rekey(gid, [{ pub: A.id.pub }, { pub: B.id.pub }, { pub: C.id.pub }])
  const skd2 = (await A.mgr.skdFor(gid, B.id.pub))!
  await B.mgr.applySkd(A.id.pub, skd2) // must not throw
  assert.equal(B.mgr.session(gid)!.epoch, 1, 'B moved to the new epoch')
})

test('a snapshot restores admin authority through the backend, not through key material', async () => {
  const hem = fakeHem()
  const backend = hemGkBackend(hem)
  const A = await peer(backend), B = await peer()
  const roster: Member[] = [{ pub: A.id.pub }, { pub: B.id.pub }]
  const gid = await A.mgr.createGroupWithNewKey('chat-gk-test', roster)
  const snaps = A.mgr.snapshot()

  // A fresh manager — a reload — rebuilds the admin capability from the KID.
  const A2 = new GroupManager(A.id, P, backend)
  await A2.restore(snaps)
  const skd = (await A2.skdFor(gid, B.id.pub))!
  assert.ok(skd.rmac, 'the restored admin can still MAC a roster')
  await B.mgr.applySkd(A.id.pub, skd) // and a member accepts it
  assert.ok(B.mgr.session(gid), 'the member established the group from the restored admin')

  // Without the backend the KID is inert — exactly the point of storing a
  // reference: a stolen cache alone does not confer admin authority.
  const A3 = new GroupManager(A.id, P)
  await A3.restore(snaps)
  const none = (await A3.skdFor(gid, B.id.pub))!
  assert.equal(none.rmac, undefined, 'a KID without its HSM MACs nothing')
})

test('bucket-B snapshots still restore (software GK migration)', async () => {
  const A = await peer(), B = await peer()
  const { gk, pub: gkPub } = await softwareGk()
  const roster: Member[] = [{ pub: A.id.pub }, { pub: B.id.pub }]
  const gid = await A.mgr.createGroup(gkPub, roster, gk)
  const snaps = A.mgr.snapshot()
  assert.ok(snaps[0].gkPriv, 'a software admin still persists its scalar')
  assert.equal(snaps[0].gkKid, undefined)

  const A2 = new GroupManager(A.id, P) // no backend, as before bucket A
  await A2.restore(snaps)
  const skd = (await A2.skdFor(gid, B.id.pub))!
  assert.ok(skd.rmac, 'a pre-bucket-A group keeps working')
  await B.mgr.applySkd(A.id.pub, skd)
  assert.ok(B.mgr.session(gid))
})

test('the marker is written at creation and rewritten on every membership change', async () => {
  const hem = fakeHem()
  const A = await peer(hemGkBackend(hem)), B = await peer(), C = await peer()
  const roster: Member[] = [{ pub: A.id.pub }, { pub: B.id.pub }]
  const gid = await A.mgr.createGroupWithNewKey('chat-gk-zespol', roster, 'Zespół')

  // 1. Born with a marker — no separate write.
  const kid = [...hem.keys.keys()][0]
  const born = parseMarker(dec(hem.keys.get(kid)!.descr))!
  assert.ok(born, 'the DESCR is a group marker')
  assert.equal(born.adminKid, (await hemKid(unb64(A.id.pub))).slice(0, 8), 'admin hint = whom to re-sync from')
  assert.equal(born.hints.length, 2, 'the roster blob is there from birth')
  assert.equal(born.name, 'Zespół')
  assert.equal(hem.calls.updateKey, 0, 'creation needs no update')

  // 2. Membership change -> exactly one rewrite, carrying the NEW roster.
  await A.mgr.rekey(gid, [{ pub: A.id.pub }, { pub: B.id.pub }, { pub: C.id.pub }])
  assert.equal(await A.mgr.writeMarker(gid, 'Zespół'), true)
  assert.equal(hem.calls.updateKey, 1, 'one HSM call per change, not per member')
  const after = parseMarker(dec(hem.keys.get(kid)!.descr))!
  assert.equal(after.hints.length, 3, 'the blob follows the roster')
  assert.notDeepEqual(after.hints, born.hints)

  // 3. Message activity must never touch it.
  const before = hem.calls.updateKey
  await A.mgr.skdFor(gid, B.id.pub)
  assert.equal(hem.calls.updateKey, before, 'sending keys are not marker business')
})

test('a software group has no HSM marker to write, and says so', async () => {
  const A = await peer()
  const gid = await A.mgr.createGroupWithNewKey('chat-gk-x', [{ pub: A.id.pub }], 'g')
  assert.equal(await A.mgr.writeMarker(gid, 'g'), false, 'no backend, no marker — not an error')
})

test('a member cannot rewrite a marker: writeMarker is admin-only', async () => {
  const hem = fakeHem()
  const A = await peer(hemGkBackend(hem)), B = await peer(hemGkBackend(hem))
  const roster: Member[] = [{ pub: A.id.pub }, { pub: B.id.pub }]
  const gid = await A.mgr.createGroupWithNewKey('chat-gk-y', roster, 'g')
  await B.mgr.applySkd(A.id.pub, (await A.mgr.skdFor(gid, B.id.pub))!)
  const before = hem.calls.updateKey
  assert.equal(await B.mgr.writeMarker(gid, 'g'), false, 'B holds no GK, so it has no marker of its own to rewrite')
  assert.equal(hem.calls.updateKey, before)
})

test('deleting a group locks everyone out and destroys the HSM key', async () => {
  const hem = fakeHem()
  const A = await peer(hemGkBackend(hem, 'admin-kid-0000')), B = await peer()
  const roster: Member[] = [{ pub: A.id.pub }, { pub: B.id.pub }]
  const gid = await A.mgr.createGroupWithNewKey('chat-gk-doomed', roster, 'g')
  await B.mgr.applySkd(A.id.pub, (await A.mgr.skdFor(gid, B.id.pub))!)
  const topicBefore = await B.mgr.session(gid)!.topic()
  const kid = [...hem.keys.keys()][0]

  await A.mgr.deleteGroup(gid)

  assert.equal(A.mgr.session(gid), undefined, 'the admin dropped its local state')
  assert.equal(hem.keys.has(kid), false, 'the GK is gone from the HSM')
  // B still HAS the group — nothing here reaches another device — but it is on
  // the old topic, and the admin is on a new one B was never told about.
  assert.ok(B.mgr.session(gid), 'the member keeps its copy; a delete is not remote')
  assert.equal(await B.mgr.session(gid)!.topic(), topicBefore, 'and stays on the topic that is now abandoned')
})

test('a destroyed group cannot be revived: no GK, no roster MAC, no epoch', async () => {
  const hem = fakeHem()
  const A = await peer(hemGkBackend(hem, 'admin-kid-0000')), B = await peer()
  const gid = await A.mgr.createGroupWithNewKey('chat-gk-doomed', [{ pub: A.id.pub }, { pub: B.id.pub }], 'g')
  await A.mgr.deleteGroup(gid)
  assert.equal(await A.mgr.skdFor(gid, B.id.pub), null, 'there is nothing left to distribute')
  assert.equal(await A.mgr.writeMarker(gid, 'g'), false, 'and no marker to rewrite')
})

test('a member has no group to delete — leaving is a local act', async () => {
  const hem = fakeHem()
  const A = await peer(hemGkBackend(hem, 'admin-kid-0000')), B = await peer(hemGkBackend(hem, 'b-kid-0000'))
  const gid = await A.mgr.createGroupWithNewKey('chat-gk-x', [{ pub: A.id.pub }, { pub: B.id.pub }], 'g')
  await B.mgr.applySkd(A.id.pub, (await A.mgr.skdFor(gid, B.id.pub))!)
  const kid = [...hem.keys.keys()][0]
  await B.mgr.deleteGroup(gid) // B holds no GK: this drops B's state and nothing else
  assert.ok(hem.keys.has(kid), 'a member cannot destroy the admin\'s group key')
  assert.ok(A.mgr.session(gid), 'and the admin still has the group')
})

// ---- a member's own record of the group (§8 Proposal, 2026-08-09) ----------

test("a member imports GK_pub, and its marker names itself as owner and the admin as admin", async () => {
  const hemA = fakeHem(), hemB = fakeHem()
  const A = await peer(hemGkBackend(hemA)), B = await peer(hemGkBackend(hemB))
  const roster: Member[] = [{ pub: A.id.pub }, { pub: B.id.pub }]
  const gid = await A.mgr.createGroupWithNewKey('chat-gk-test', roster)
  await B.mgr.applySkd(A.id.pub, (await A.mgr.skdFor(gid, B.id.pub))!)

  assert.equal(await B.mgr.writeMemberMarker(gid, 'Zespół'), true)
  assert.equal(hemB.calls.importPublicKey, 1, 'exactly one entry per group')
  // The fake stores what the device is given, and a DESCR reaches it base64'd.
  const [entry] = [...hemB.keys.values()].filter((k) => dec(k.descr).startsWith('ETSEIC:chan'))
  assert.ok(entry, 'GK_pub is in the device')
  assert.equal(entry.label, 'Onchato-Group-Zespół')

  const m = parseMarker(dec(entry.descr))!
  assert.equal(m.ownerKid, (await hemKid(unb64(B.id.pub))).slice(0, 8), 'the group is B\'s')
  assert.equal(m.adminKid, (await hemKid(unb64(A.id.pub))).slice(0, 8), 'and A administers it')
  assert.notEqual(m.ownerKid, m.adminKid)
  assert.equal(m.hints.length, 0, 'no membership graph copied onto a member\'s device')
  assert.equal(m.name, 'Zespół')

  // What it must NOT hold: the topic seed or anything that opens a message.
  const [rec] = B.mgr.snapshot()
  assert.ok(!dec(entry.descr).includes(rec.secret), 'group_secret is not in the device')
  assert.ok(!dec(entry.descr).includes(rec.send.key), 'nor a sender key')
})

test("an admin writes no member record — it already holds the key pair", async () => {
  const hem = fakeHem()
  const A = await peer(hemGkBackend(hem))
  const gid = await A.mgr.createGroupWithNewKey('chat-gk-test', [{ pub: A.id.pub }])
  assert.equal(await A.mgr.writeMemberMarker(gid, 'g'), false)
  assert.equal(hem.calls.importPublicKey, 0)
})

test('a rename updates the one record, and leaving takes it away', async () => {
  const hemA = fakeHem(), hemB = fakeHem()
  const A = await peer(hemGkBackend(hemA)), B = await peer(hemGkBackend(hemB))
  const gid = await A.mgr.createGroupWithNewKey('chat-gk-test', [{ pub: A.id.pub }, { pub: B.id.pub }])
  await B.mgr.applySkd(A.id.pub, (await A.mgr.skdFor(gid, B.id.pub))!)

  await B.mgr.writeMemberMarker(gid, 'stara')
  await B.mgr.writeMemberMarker(gid, 'nowa')
  assert.equal(hemB.calls.importPublicKey, 1, 'the second write updates, it does not import again')
  assert.equal(hemB.calls.updateKey, 1)
  const markers = () => [...hemB.keys.values()].filter((k) => dec(k.descr).startsWith('ETSEIC:chan'))
  assert.equal(parseMarker(dec(markers()[0].descr))!.name, 'nowa')

  await B.mgr.dropMemberMarker(gid)
  assert.equal(markers().length, 0, 'a group left behind would come back on the next device')
})

test('a second identity already holding this GK degrades to no record, not to a crash', async () => {
  // One device, two identities, both in the same group: the device refuses the
  // second import because the key content is already there. The group must keep
  // working from the local cache.
  const hem = fakeHem()
  const A = await peer(hemGkBackend(hem)), B = await peer(hemGkBackend(hem)), C = await peer(hemGkBackend(hem))
  const gid = await A.mgr.createGroupWithNewKey('chat-gk-test', [{ pub: A.id.pub }, { pub: B.id.pub }, { pub: C.id.pub }])
  await B.mgr.applySkd(A.id.pub, (await A.mgr.skdFor(gid, B.id.pub))!)
  await C.mgr.applySkd(A.id.pub, (await A.mgr.skdFor(gid, C.id.pub))!)

  assert.equal(await B.mgr.writeMemberMarker(gid, 'g'), true)
  assert.equal(await C.mgr.writeMemberMarker(gid, 'g'), false, 'refused, and said so instead of throwing')
  assert.equal(hem.calls.importPublicKey, 2, 'it was attempted')
})

test('the device lists the groups of ONE identity, and the id comes off GK_pub', async () => {
  // Two identities on one device (one fake HEM), each in a group of its own:
  // both markers sit under the same ETSEIC:chan prefix, so without the owner
  // filter each identity would list the other's group.
  const hem = fakeHem()
  const admin = await peer(hemGkBackend(hem))
  const B = await peer(hemGkBackend(hem)), C = await peer(hemGkBackend(hem))
  const g1 = await admin.mgr.createGroupWithNewKey('gk1', [{ pub: admin.id.pub }, { pub: B.id.pub }], 'jeden')
  const g2 = await admin.mgr.createGroupWithNewKey('gk2', [{ pub: admin.id.pub }, { pub: C.id.pub }], 'dwa')
  await B.mgr.applySkd(admin.id.pub, (await admin.mgr.skdFor(g1, B.id.pub))!)
  await C.mgr.applySkd(admin.id.pub, (await admin.mgr.skdFor(g2, C.id.pub))!)
  await B.mgr.writeMemberMarker(g1, 'jeden')
  await C.mgr.writeMemberMarker(g2, 'dwa')

  const bKid = await hemKid(unb64(B.id.pub))
  const mine = await B.mgr.deviceGroups(bKid)
  assert.equal(mine.length, 1, "one identity does not see the other's groups")
  assert.equal(mine[0].gidHex, g1, 'the group id is derived from GK_pub, not stored')
  assert.equal(mine[0].name, 'jeden')
  assert.equal(mine[0].adminHint, (await hemKid(unb64(admin.id.pub))).slice(0, 8))

  // And the recovery precondition: knowing the group exists is not being in it.
  assert.equal(B.mgr.has(g1), true)
  assert.equal(B.mgr.has(g2), false)
})

test('a device entry can be dropped for a group we cannot get back into', async () => {
  const hem = fakeHem()
  const A = await peer(hemGkBackend(hem)), B = await peer(hemGkBackend(hem))
  const gid = await A.mgr.createGroupWithNewKey('gk', [{ pub: A.id.pub }, { pub: B.id.pub }], 'g')
  await B.mgr.applySkd(A.id.pub, (await A.mgr.skdFor(gid, B.id.pub))!)
  await B.mgr.writeMemberMarker(gid, 'g')

  const bKid = await hemKid(unb64(B.id.pub))
  const [entry] = await B.mgr.deviceGroups(bKid)
  await B.mgr.forgetDeviceGroup(entry.kid)
  assert.equal((await B.mgr.deviceGroups(bKid)).length, 0)
})
