/**
 * The CLI's group layer reads the roster from the engine, never from an SKD
 * (SPEC.md section 8.3: the attested roster is the only roster).
 *
 * test/group-roster-authority.test.ts proves the ENGINE refuses an outsider's
 * same-epoch SKD and builds no distribution for a non-member. This file proves
 * the layer above does not keep a roster of its own that such an SKD could
 * overwrite - the shape of the bug found on 2026-10-11 - by calling the
 * handlers directly, as if core had forwarded the refused SKD anyway (the worst
 * case), and checking that nothing is shown, distributed or renamed on its
 * account. The web app has the same structure but no offline harness; the CLI's
 * `Groups` is the same orchestration written for a terminal, and it is testable.
 */

import { namesFromKey } from '../lib/storenames.ts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { generateX25519 } from '../lib/x25519.ts'
import { b64, unb64, randomBytes } from '../lib/wc.ts'
import { GroupManager, softwareGk, type GroupId, type SkdFields } from '../lib/group.ts'
import { Groups } from '../cli/groups.ts'
import type { KV } from '../lib/migrate.ts'

const P = { networkId: 'gcli', dateUTC: '2026-10-12' }

async function softId(): Promise<GroupId> {
  const k = await generateX25519()
  return { pub: b64(k.pub), ecdh: async (p: string) => k.dh(unb64(p)) }
}
const memKV = (): KV => { const m = new Map<string, string>(); return { keys: () => [...m.keys()], get: (k) => m.get(k) ?? null, set: (k, v) => { m.set(k, v) } } }

/** One terminal client: a real engine behind a stubbed session, and a record of every SKD it hands out. */
async function client() {
  const id = await softId()
  const mgr = new GroupManager(id, P)
  const sent: { to: string; skd: SkdFields }[] = []
  const room = { stop() {}, sendText: async () => 'id', sendReaction: async () => {}, sendFile: async () => 'id' } as any
  const session = { groups: mgr, openGroup: async () => room } as any
  const groups = new Groups({
    session, me: id.pub, kv: memKV(), base: randomBytes(32), names: await namesFromKey(randomBytes(32), 'c'.repeat(32)),
    conv: async (pub) => ({ sendGroupSkd: (skd: SkdFields) => { sent.push({ to: pub, skd }) }, sendGroupSkdReq: () => {} }) as any,
    contacts: () => [],
    handlers: {},
  })
  return { id, mgr, groups, sent }
}

/** A, the admin, invites B over the engine + the CLI layer, the way core would. */
async function bootAB() {
  const A = await client(), B = await client()
  const { gk, pub: gkPub } = await softwareGk()
  const gid = await A.mgr.createGroup(gkPub, [{ pub: A.id.pub }, { pub: B.id.pub }], gk)
  const skd = (await A.mgr.skdFor(gid, B.id.pub))!
  assert.equal(await B.mgr.applySkd(A.id.pub, skd), 'joined')
  await B.groups.onInvite(A.id.pub, { ...skd, name: 'Zespół' })
  const g = B.groups.get(gid)!
  assert.deepEqual(g.members, [A.id.pub, B.id.pub])
  assert.equal(g.name, 'Zespół')
  return { A, B, gid, gkPub, skd }
}

test('an outsider\'s same-epoch SKD changes nothing in the CLI\'s view of the group', async () => {
  const { A, B, gid, gkPub, skd } = await bootAB()
  const X = await client() // a contact of B, never a member
  const forged: SkdFields = { ...skd, gkPub: b64(gkPub), secret: b64(randomBytes(32)), chain: b64(randomBytes(32)), ctr: 0, rmac: undefined, roster: [A.id.pub, B.id.pub, X.id.pub] }
  assert.equal(await B.mgr.applySkd(X.id.pub, forged), 'refused')
  // Worst case: the handler is called anyway (core no longer does this).
  await B.groups.onInvite(X.id.pub, { ...forged, name: 'pwned' })
  const g = B.groups.get(gid)!
  assert.deepEqual(g.members, [A.id.pub, B.id.pub], 'the roster shown is the attested one')
  assert.equal(g.name, 'Zespół', 'and the name was not taken from the forgery')
})

test('a re-request from outside the attested roster is not answered - even if the UI list were poisoned', async () => {
  const { B, gid, skd } = await bootAB()
  const X = await client()
  B.sent.length = 0
  await B.groups.onSkdReq(X.id.pub, { gid: skd.gid })
  assert.deepEqual(B.sent, [], 'nothing went to X')
  // Belt and braces: even a corrupted display list must not reach distribution.
  B.groups.get(gid)!.members.push(X.id.pub)
  await B.groups.onSkdReq(X.id.pub, { gid: skd.gid })
  assert.deepEqual(B.sent, [], 'the display list is not what decides')
})

test('distribution goes to the attested roster only; a member\'s request is answered', async () => {
  const { A, B, gid, skd } = await bootAB()
  B.sent.length = 0
  await B.groups.onSkdReq(A.id.pub, { gid: skd.gid })
  assert.deepEqual(B.sent.map((s) => s.to), [A.id.pub], 'A, a member, gets B\'s key')
  assert.equal(B.sent[0].skd.epoch, 0)
  assert.ok(B.sent[0].skd.chain, 'and it is a real chain key')
  assert.equal(B.groups.get(gid)!.members.length, 2)
})

test('rename is the admin\'s: roster[0] of the attested roster, not of the envelope', async () => {
  const { A, B, gid, skd } = await bootAB()
  // A legit same-epoch SKD from the admin carrying a new name renames.
  await B.mgr.applySkd(A.id.pub, skd)
  await B.groups.onInvite(A.id.pub, { ...skd, name: 'Nowa nazwa' })
  assert.equal(B.groups.get(gid)!.name, 'Nowa nazwa')
  // The same from B itself (a member, not the admin), with itself first in the envelope's roster: no.
  const mine = (await B.mgr.skdFor(gid))!
  await B.groups.onInvite(B.id.pub, { ...mine, roster: [B.id.pub, A.id.pub], name: 'Moja nazwa' })
  assert.equal(B.groups.get(gid)!.name, 'Nowa nazwa', 'a non-admin cannot rename by putting itself first')
})
