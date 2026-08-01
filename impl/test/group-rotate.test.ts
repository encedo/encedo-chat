/**
 * Epoch rotation on a membership change (`GroupManager.rekey`, §8). A membership
 * change mints a new epoch: a new group_secret (→ a new topic) and fresh sending
 * keys. The removed member, stuck at the old epoch, can neither find the new topic
 * nor open new messages; a newcomer joins at the new epoch and reads from there.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { generateX25519 } from '../lib/x25519.ts'
import { b64, unb64 } from '../lib/wc.ts'
import { GroupManager, type GroupId, type Member } from '../lib/group.ts'

const P = { networkId: 'grot', dateUTC: '2026-08-01' }
const enc = new TextEncoder()
const body = (s: string) => enc.encode(s)

async function softId(): Promise<GroupId> {
  const k = await generateX25519()
  return { pub: b64(k.pub), ecdh: async (p: string) => k.dh(unb64(p)) }
}
type Peer = { id: GroupId; mgr: GroupManager }
const skd = async (from: Peer, gid: string, to: Peer[]) => { for (const r of to) await r.mgr.applySkd(from.id.pub, from.mgr.skdFor(gid)!) }

/** Bootstrap n members (member[0] = admin) at epoch 0, all sender keys shared. */
async function boot(n: number): Promise<{ gid: string; gk: Awaited<ReturnType<typeof generateX25519>>; peers: Peer[] }> {
  const peers: Peer[] = []
  for (let i = 0; i < n; i++) { const id = await softId(); peers.push({ id, mgr: new GroupManager(id, P) }) }
  const gk = await generateX25519()
  const roster: Member[] = peers.map((p) => ({ pub: p.id.pub }))
  const gid = await peers[0].mgr.createGroup(gk.pub, roster)
  await skd(peers[0], gid, peers.slice(1))
  for (const s of peers) await skd(s, gid, peers.filter((p) => p !== s))
  return { gid, gk, peers }
}

test('removing a member rotates the epoch + topic and locks it out', async () => {
  const { gid, peers } = await boot(3)
  const [A, B, C] = peers
  const oldTopic = await A.mgr.session(gid)!.topic()

  // Admin A removes C: new roster [A, B], distribute only to B.
  await A.mgr.rekey(gid, [{ pub: A.id.pub }, { pub: B.id.pub }])
  await skd(A, gid, [B])
  await skd(B, gid, [A])

  const newTopic = await A.mgr.session(gid)!.topic()
  assert.notEqual(newTopic, oldTopic, 'the topic rotated with the epoch')
  assert.equal(await B.mgr.session(gid)!.topic(), newTopic)
  assert.equal(await C.mgr.session(gid)!.topic(), oldTopic, 'C is stuck on the old topic (never got the new secret)')

  // A broadcasts at the new epoch: B reads it, C cannot (wrong epoch → MAC fails).
  const frame = await A.mgr.session(gid)!.send(body('after removal'))
  assert.deepEqual((await B.mgr.session(gid)!.receive(frame))?.pt, body('after removal'))
  assert.equal(await C.mgr.session(gid)!.receive(frame), null, 'the removed member cannot open the new-epoch message')
})

test('adding a member: the newcomer joins at the new epoch and receives', async () => {
  const { gid, peers } = await boot(2) // A, B
  const [A, B] = peers
  const dId = await softId()
  const D: Peer = { id: dId, mgr: new GroupManager(dId, P) }

  const roster3: Member[] = [{ pub: A.id.pub }, { pub: B.id.pub }, { pub: D.id.pub }]
  await A.mgr.rekey(gid, roster3)
  await skd(A, gid, [B, D])
  await skd(B, gid, [A, D])
  await skd(D, gid, [A, B])

  const topic = await A.mgr.session(gid)!.topic()
  assert.equal(await D.mgr.session(gid)!.topic(), topic, 'the newcomer derives the same (new) topic')

  const frame = await D.mgr.session(gid)!.send(body('newcomer speaks'))
  assert.deepEqual((await A.mgr.session(gid)!.receive(frame))?.pt, body('newcomer speaks'))
  assert.deepEqual((await B.mgr.session(gid)!.receive(frame))?.pt, body('newcomer speaks'))
})
