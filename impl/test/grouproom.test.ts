/**
 * Group over the transport (`lib/grouproom.ts`): broadcast on a shared GossipSub
 * topic through a mock hub. Covers a 3-member text/reaction round, that a
 * garbage/forged frame on the topic surfaces nothing (session.receive gates it),
 * and a scale round at 8 members.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { generateX25519, x25519FromPriv } from '../lib/x25519.ts'
import { b64, unb64, randomBytes } from '../lib/wc.ts'
import { GroupManager, softwareGk, type GroupId, type Member } from '../lib/group.ts'
import { joinGroup, type GroupRoom } from '../lib/grouproom.ts'
import { makeQuote } from '../lib/quote.ts'
import { pubHint } from '../lib/mentions.ts'

const P = { networkId: 'groom', dateUTC: '2026-08-01' }
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

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

interface Peer { id: GroupId; mgr: GroupManager; node: any; recv: { from: string; body: string; re?: any }[]; react: { from: string; to: string; emoji: string }[]; room?: GroupRoom }

/** n members, cross-distributed sender keys, each joined to the group room. */
async function makeGroup(n: number): Promise<{ gid: string; topic: string; peers: Peer[] }> {
  const net = hub()
  const peers: Peer[] = []
  for (let i = 0; i < n; i++) {
    const id = await softId()
    peers.push({ id, mgr: new GroupManager(id, P), node: net.node('n' + i), recv: [], react: [] })
  }
  const { gk, pub: gkPub } = await softwareGk()
  const roster: Member[] = peers.map((p) => ({ pub: p.id.pub }))
  const gid = await peers[0].mgr.createGroup(gkPub, roster, gk)
  // pass 1: creator's SKD to everyone (so they establish the group) — per-recipient (roster MAC)
  for (const r of peers.slice(1)) await r.mgr.applySkd(peers[0].id.pub, (await peers[0].mgr.skdFor(gid, r.id.pub))!)
  // pass 2: everyone's SKD to everyone else (fills all sender keys)
  for (const s of peers) for (const r of peers) if (r !== s) await r.mgr.applySkd(s.id.pub, (await s.mgr.skdFor(gid, r.id.pub))!)
  for (const p of peers) {
    p.room = await joinGroup(p.node, p.mgr.session(gid)!, {
      onMessage: (from, env) => p.recv.push({ from, body: env.body, re: env.re }),
      onReaction: (from, env) => p.react.push({ from, to: env.to, emoji: env.emoji }),
    })
  }
  return { gid, topic: peers[0].room!.topic, peers }
}

test('3 members: a text broadcast reaches the others, not the sender', async () => {
  const { peers } = await makeGroup(3)
  const id = await peers[0].room!.sendText('czesc grupo')
  await sleep(30)
  assert.deepEqual(peers[1].recv, [{ from: peers[0].id.pub, body: 'czesc grupo', re: undefined }])
  assert.deepEqual(peers[2].recv, [{ from: peers[0].id.pub, body: 'czesc grupo', re: undefined }])
  assert.equal(peers[0].recv.length, 0, 'the sender does not receive its own broadcast')
  assert.ok(id.length > 0)
})

test('a reply arrives quoting what it answers', async () => {
  const { peers } = await makeGroup(3)
  const first = await peers[0].room!.sendText('kto niesie namiot?')
  await sleep(30)
  await peers[1].room!.sendText('ja', makeQuote(first, 'kto niesie namiot?', peers[0].id.pub))
  await sleep(30)
  // The quote reaches the third member too — including the member who is not
  // either party to it, which is the case a 1:1 cannot show.
  const q = peers[2].recv.find((m) => m.body === 'ja')?.re
  assert.equal(q?.id, first)
  assert.equal(q?.text, 'kto niesie namiot?')
  assert.equal(q?.au, pubHint(peers[0].id.pub)) // whose words, as a key, not as a name
})

test('a reaction is delivered to the group', async () => {
  const { peers } = await makeGroup(3)
  await peers[1].room!.sendReaction('msg-7', '👍')
  await sleep(30)
  assert.deepEqual(peers[0].react, [{ from: peers[1].id.pub, to: 'msg-7', emoji: '👍' }])
  assert.deepEqual(peers[2].react, [{ from: peers[1].id.pub, to: 'msg-7', emoji: '👍' }])
})

test('a garbage/forged frame on the topic surfaces nothing', async () => {
  const { topic, peers } = await makeGroup(3)
  await peers[0].node.services.pubsub.publish(topic, randomBytes(80)) // not a valid group-msg
  await sleep(30)
  assert.equal(peers[1].recv.length, 0)
  assert.equal(peers[2].recv.length, 0)
  // a real one still flows afterwards
  await peers[0].room!.sendText('real')
  await sleep(30)
  assert.deepEqual(peers[1].recv, [{ from: peers[0].id.pub, body: 'real', re: undefined }])
})

test('scale: 8 members, one broadcast reaches the other 7', async () => {
  const { peers } = await makeGroup(8)
  await peers[3].room!.sendText('do wszystkich')
  await sleep(50)
  const got = peers.filter((p) => p.recv.some((m) => m.body === 'do wszystkich'))
  assert.equal(got.length, 7, 'all members except the sender received it')
  assert.equal(peers[3].recv.length, 0)
})
