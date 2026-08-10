/**
 * The one-way group silence, and the repair for it (§8).
 *
 * A sender key is handed out ONCE, over a 1:1 that can be down at that instant,
 * and the receiving side of Sender Keys cannot derive what it was never given.
 * So a member whose SKD did not arrive is deaf to exactly one sender, for the
 * life of the epoch, while every other direction looks perfect — no error, no
 * badge, nothing in a log. That asymmetry is what these tests pin: that it
 * happens, that the receiver now NOTICES it, that noticing cannot be provoked by
 * anyone who is not a member, and that handing the key over closes it.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { generateX25519 } from '../lib/x25519.ts'
import { b64, unb64, randomBytes } from '../lib/wc.ts'
import { GroupManager, softwareGk, type GroupId, type Member } from '../lib/group.ts'
import { joinGroup, type GroupRoom } from '../lib/grouproom.ts'

const P = { networkId: 'grepair', dateUTC: '2026-08-09' }
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/**
 * Wait for a condition instead of for a duration.
 *
 * These tests used fixed 30 ms sleeps, which pass alone and fail in the full
 * suite: `node --test` runs files in parallel, and an in-memory hub plus four
 * WebCrypto operations can take longer than that on a contended machine. A flaky
 * test is worse than a slow one — it teaches everyone to re-run rather than to
 * look.
 *
 * Asserting that something did NOT happen still needs a settle period; there is
 * no condition to wait for. Those keep a sleep, and a generous one.
 */
async function until(what: string, cond: () => boolean, ms = 4_000): Promise<void> {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (cond()) return
    await sleep(5)
  }
  throw new Error(`timed out after ${ms} ms waiting for: ${what}`)
}

async function softId(): Promise<GroupId> {
  const k = await generateX25519()
  return { pub: b64(k.pub), ecdh: async (peerPubB64: string) => k.dh(unb64(peerPubB64)) }
}

/** In-memory GossipSub: publish reaches every other node subscribed to the topic. */
function hub() {
  const nodes = new Map<string, (topic: string, data: Uint8Array, from: string) => void>()
  return {
    node(id: string) {
      const listeners: Array<(evt: any) => void> = []
      nodes.set(id, (topic, data, from) => { for (const h of [...listeners]) h({ detail: { topic, data, from: { toString: () => from } } }) })
      return {
        peerId: { toString: () => id },
        services: { pubsub: {
          addEventListener: (_e: string, h: (evt: any) => void) => listeners.push(h),
          removeEventListener: (_e: string, h: (evt: any) => void) => { const i = listeners.indexOf(h); if (i >= 0) listeners.splice(i, 1) },
          subscribe: () => {}, unsubscribe: () => {},
          publish: async (topic: string, data: Uint8Array) => { for (const [peer, deliver] of nodes) if (peer !== id) deliver(topic, data, id) },
        } },
      }
    },
  }
}

interface Peer {
  id: GroupId
  mgr: GroupManager
  node: any
  recv: { from: string; body: string }[]
  asked: string[]          // members we asked for a sender key
  room?: GroupRoom
}

/**
 * Three members, fully cross-distributed EXCEPT that `holes` are skipped — each
 * hole is `[senderIndex, receiverIndex]`, meaning that receiver never got that
 * sender's key. That is the whole fault, reproduced deliberately.
 */
async function makeGroup(n: number, holes: [number, number][] = []): Promise<{ gid: string; topic: string; peers: Peer[] }> {
  const net = hub()
  const peers: Peer[] = []
  for (let i = 0; i < n; i++) {
    const id = await softId()
    peers.push({ id, mgr: new GroupManager(id, P), node: net.node('n' + i), recv: [], asked: [] })
  }
  const { gk, pub: gkPub } = await softwareGk()
  const roster: Member[] = peers.map((p) => ({ pub: p.id.pub }))
  const gid = await peers[0].mgr.createGroup(gkPub, roster, gk)
  const skipped = new Set(holes.map(([s, r]) => `${s}|${r}`))
  // pass 1: the creator's SKD establishes the group for everyone (roster MAC).
  // A hole here would leave the receiver with no group at all, which is a
  // different failure; the interesting one is a group that exists and is deaf.
  for (let r = 1; r < n; r++) await peers[r].mgr.applySkd(peers[0].id.pub, (await peers[0].mgr.skdFor(gid, peers[r].id.pub))!)
  // pass 2: everyone else's sender key to everyone else — minus the holes.
  for (let s = 0; s < n; s++) for (let r = 0; r < n; r++) {
    if (s === r || (s === 0) || skipped.has(`${s}|${r}`)) continue
    await peers[r].mgr.applySkd(peers[s].id.pub, (await peers[s].mgr.skdFor(gid, peers[r].id.pub))!)
  }
  for (const p of peers) {
    p.room = await joinGroup(p.node, p.mgr.session(gid)!, {
      onMessage: (from, env) => p.recv.push({ from, body: env.body }),
      onNeedSenderKey: (memberPub) => p.asked.push(memberPub),
    })
  }
  return { gid, topic: peers[0].room!.topic, peers }
}

test('a member without one sender key is deaf to that sender ONLY, and says so', async () => {
  // peers[2] never got peers[1]'s sender key.
  const { peers } = await makeGroup(3, [[1, 2]])
  await peers[1].room!.sendText('slyszycie mnie?')
  await until('the healthy direction to deliver, and the deaf one to ask',
    () => peers[0].recv.length > 0 && peers[2].asked.length > 0)

  // The healthy direction is untouched — which is exactly why this is invisible
  // in use: the group works, for everyone except one pair, in one direction.
  assert.deepEqual(peers[0].recv, [{ from: peers[1].id.pub, body: 'slyszycie mnie?' }])
  assert.equal(peers[2].recv.length, 0, 'the member with no sender key cannot open it')
  assert.deepEqual(peers[2].asked, [peers[1].id.pub], 'and it asks that sender for the key')
  assert.deepEqual(peers[0].asked, [], 'a member that CAN read asks for nothing')

  // The other direction still works, so nothing about the deaf member looks broken.
  await peers[2].room!.sendText('ja slysze')
  await until('the other direction still works', () => peers[1].recv.length > 0)
  assert.deepEqual(peers[1].recv, [{ from: peers[2].id.pub, body: 'ja slysze' }])
})

test('a burst of unreadable frames costs ONE request, not one per frame', async () => {
  const { peers } = await makeGroup(3, [[1, 2]])
  for (let i = 0; i < 5; i++) await peers[1].room!.sendText('msg ' + i)
  await until('the first ask', () => peers[2].asked.length > 0)
  await sleep(120) // and then a quiet period: the claim is that NO second ask follows
  assert.equal(peers[2].recv.length, 0)
  assert.deepEqual(peers[2].asked, [peers[1].id.pub], 'rate-limited to one ask per member')
})

test('handing the key over closes it — on the LIVE room, with no re-join', async () => {
  const { gid, peers } = await makeGroup(3, [[1, 2]])
  await peers[1].room!.sendText('pierwsza')
  await until('the sender to be heard by the member that CAN read it', () => peers[0].recv.length > 0)
  assert.equal(peers[2].recv.length, 0)

  // What answering the request does: the sender builds an SKD for the asker and
  // it is applied. The room is holding the same GroupSession object, so it picks
  // the key up without being torn down — a repair must not cost a re-join.
  await peers[2].mgr.applySkd(peers[1].id.pub, (await peers[1].mgr.skdFor(gid, peers[2].id.pub))!)
  await peers[1].room!.sendText('druga')
  await until('the repaired member to open it', () => peers[2].recv.length > 0)
  assert.deepEqual(peers[2].recv, [{ from: peers[1].id.pub, body: 'druga' }])
})

test('a re-sent SKD carries the counter its chain is at', async () => {
  // Pinned at the wire level, not only end-to-end, because dropping this field
  // breaks nothing visible: the initial distribution (ctr 0) keeps working and
  // only the repair — the case nobody exercises by hand — silently stops.
  const { gid, peers } = await makeGroup(3)
  assert.equal((await peers[1].mgr.skdFor(gid, peers[2].id.pub))!.ctr, 0, 'nothing sent yet')
  await peers[1].room!.sendText('raz')
  await peers[1].room!.sendText('dwa')
  await until('both to reach a member', () => peers[0].recv.length === 2)
  assert.equal((await peers[1].mgr.skdFor(gid, peers[2].id.pub))!.ctr, 2, 'two messages in, the chain is at 2')
})

test('the request is never provoked by anyone who is not an authenticated member', async () => {
  const { topic, peers } = await makeGroup(3, [[1, 2]])

  // Garbage: no header, no sender_id, nothing to attribute it to.
  await peers[0].node.services.pubsub.publish(topic, randomBytes(80))
  // A REAL frame from the missing sender, with its per-recipient MAC corrupted.
  // This is the case that matters: everything about it names a genuine member,
  // and only the MAC says it is not one. If the signal fired here, a stranger on
  // the topic could aim our 1:1 traffic by replaying a member's frames.
  let real: Uint8Array | null = null
  const tap = (evt: any) => { if (evt.detail.topic === topic) real ??= evt.detail.data }
  peers[0].node.services.pubsub.addEventListener('message', tap)
  await peers[1].room!.sendText('prawdziwa')
  // Wait for BOTH: the tap on peers[0] fires synchronously as the frame is
  // delivered, while peers[2] verifies a MAC before it can ask — so waiting only
  // for the capture cleared `asked` a moment before the genuine ask arrived, and
  // the forged frame then took the blame for it. That was this test's own race.
  await until('the real frame captured AND the genuine ask recorded',
    () => real !== null && peers[2].asked.length > 0)
  assert.ok(real, 'captured a real frame to tamper with')
  peers[2].asked.length = 0 // that genuine frame legitimately asked; start clean

  const forged = real!.slice()
  forged[forged.length - 40] ^= 0xff // inside the MAC/ciphertext region
  await peers[0].node.services.pubsub.publish(topic, forged)
  await sleep(200) // absence has no condition to wait for
  assert.deepEqual(peers[2].asked, [], 'a frame that fails our MAC asks for nothing')
  assert.equal(peers[2].recv.length, 0)
})
