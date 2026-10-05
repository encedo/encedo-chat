import { test } from 'node:test'
import assert from 'node:assert/strict'
import { peerIdOf, siblingSet, shouldJoin, evictable, staleSiblings, dupOnlySiblings, overlapReset, mayRedial } from './topics.mjs'

// The real ids, so a change in their shape breaks here rather than in a room
// that quietly stops forming.
const BS1 = '12D3KooWP6SpQxgcUDdAU1CdY3dcvSrkxHPki7FRtMLLYiGxcDmp'
const BS2 = '12D3KooWJJJtAk9m6yTUdKwqUYpxcyWLZTVNgyrpZheyK161NT1y'
const BS3 = '12D3KooWLcDzqtSAetckwdzzqYbLTsN6wHFx8T4uKr5Yn1GUvSt5'
const CLIENT = '12D3KooWQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQ'

test('a peer id is read out of the multiaddrs production actually uses', () => {
  assert.equal(peerIdOf(`/ip6/2a03:ec41:0:9::cf/tcp/9002/ws/p2p/${BS1}`), BS1)
  assert.equal(peerIdOf(`/dns4/bs1.onchato.com/tcp/443/wss/http-path/%2Frelay/p2p/${BS1}`), BS1)
  assert.equal(peerIdOf('/ip4/10.0.0.1/tcp/9002/ws'), null) // no id in it at all
})

test('siblings come from the explicit list and from the nodes we dial', () => {
  // bs2's real shape: it dials bs1 and is told about bs3, which dials IT.
  const s = siblingSet([BS3], [`/ip6/2a03:ec41:0:9::cf/tcp/9002/ws/p2p/${BS1}`])
  assert.ok(s.has(BS1), 'the dialled node is a sibling')
  assert.ok(s.has(BS3), 'the named node is a sibling')
  assert.equal(s.size, 2)
})

test('a whole multiaddr in --siblings is accepted as well as a bare id', () => {
  const s = siblingSet([`/dns4/bs2.onchato.com/tcp/443/wss/p2p/${BS2}`, BS3], [])
  assert.deepEqual([...s].sort(), [BS2, BS3].sort())
})

test('with the switch OFF nothing changes, whoever is asking', () => {
  const siblings = siblingSet([BS1, BS2, BS3], [])
  // This is what has run since the beginning and stays the default, so the code
  // can be deployed inert and turned on one node at a time.
  assert.equal(shouldJoin(BS1, { siblings, localOnly: false }), true)
  assert.equal(shouldJoin(CLIENT, { siblings, localOnly: false }), true)
})

test('with the switch ON a client is joined for and a sibling is not', () => {
  const siblings = siblingSet([BS1, BS2], [])
  assert.equal(shouldJoin(CLIENT, { siblings, localOnly: true }), true, 'our own client asked')
  assert.equal(shouldJoin(BS1, { siblings, localOnly: true }), false, 'another relay merely mentioned it')
  assert.equal(shouldJoin(BS2, { siblings, localOnly: true }), false)
})

test('a sibling missing from the list fails the SAFE way', () => {
  // bs3 forgotten: it reads as a client, so we subscribe to its topics. No
  // saving, and nothing breaks. The dangerous direction — a client read as a
  // sibling, whose rooms would then never form — needs somebody to put a
  // client's peer id in the list, and peer ids are not guessable.
  const siblings = siblingSet([BS1, BS2], [])
  assert.equal(shouldJoin(BS3, { siblings, localOnly: true }), true)
})

test('the peer id is compared as text, whatever the caller hands over', () => {
  // libp2p passes a PeerId object; `evt.detail.peerId` is not a string.
  const siblings = siblingSet([BS1], [])
  const asObject = { toString: () => BS1 }
  assert.equal(shouldJoin(asObject, { siblings, localOnly: true }), false)
})

test('an idle topic is evicted only when no client holds it through a pick', () => {
  const ttlMs = 120_000, now = 1_000_000
  assert.equal(evictable({ now, lastSeen: now - 200_000, holders: 0, ttlMs }), true, 'idle and unheld: freed')
  assert.equal(evictable({ now, lastSeen: now - 200_000, holders: 1, ttlMs }), false, 'idle but picked: kept (2026-09-29)')
  assert.equal(evictable({ now, lastSeen: now - 10_000, holders: 0, ttlMs }), false, 'recent traffic: kept')
  assert.equal(evictable({ now, lastSeen: undefined, holders: 0, ttlMs }), true, 'never seen and unheld: freed')
})

test('a connected sibling that has sent nothing for too long is reset; the clock starts at connect', () => {
  const now = 1_000_000, maxSilenceMs = 105_000
  const lastHeard = new Map([['alive', now - 20_000], ['dead', now - 200_000]])
  const connectedAt = new Map([['alive', now - 500_000], ['dead', now - 500_000], ['fresh', now - 30_000], ['old-never', now - 300_000]])
  const got = staleSiblings({ now, connected: ['alive', 'dead', 'fresh', 'old-never'], lastHeard, connectedAt, maxSilenceMs })
  assert.deepEqual(got.sort(), ['dead', 'old-never'], 'silent too long, whether or not it ever spoke; a fresh link gets its grace')
  assert.deepEqual(staleSiblings({ now, connected: [], lastHeard, connectedAt, maxSilenceMs }), [], 'nothing connected, nothing to reset')
})

test('a duplicate that came over the link keeps a sibling alive; only first copies silent is not a dead link', () => {
  // 2026-10-05: bs3 won the race for bs1's announces several rounds in a row,
  // and bs2 reset a healthy bs1 link that was still delivering the copies.
  const now = 1_000_000, maxSilenceMs = 105_000
  const connectedAt = new Map([['raced', now - 900_000], ['dead', now - 900_000], ['alive', now - 900_000]])
  const lastHeard = new Map([['raced', now - 300_000], ['dead', now - 300_000], ['alive', now - 5_000]])
  const lastDup = new Map([['raced', now - 10_000], ['dead', now - 300_000]])
  const args = { now, connected: ['raced', 'dead', 'alive'], lastHeard, connectedAt, maxSilenceMs }
  assert.deepEqual(staleSiblings({ ...args, lastDup }), ['dead'], 'a recent duplicate spares the link; an old one does not')
  assert.deepEqual(staleSiblings(args).sort(), ['dead', 'raced'], 'without duplicates (the old watchdog) the raced link was reset')
  assert.deepEqual(dupOnlySiblings({ ...args, lastDup }), ['raced'], 'the log names the link that only duplicates saved')
  assert.deepEqual(dupOnlySiblings({ ...args, lastDup: new Map() }), [], 'no duplicates, nothing to report')
})

test('a reconnect over a still-open old connection is reset at once; a fresh pair or a recent reset is not', () => {
  const now = 1_000_000
  assert.equal(overlapReset({ now, openedAt: [now - 3_600_000] }), true, 'old connection still open: the overlap')
  assert.equal(overlapReset({ now, openedAt: [now - 2_000] }), false, 'both just opened (dialled each other at start)')
  assert.equal(overlapReset({ now, openedAt: [] }), false, 'no other connection: an ordinary connect')
  assert.equal(overlapReset({ now, openedAt: [now - 3_600_000], lastReset: now - 10_000 }), false, 'reset a moment ago: no flapping')
})

test('after a lost sibling link the smaller PeerId re-dials at once, the larger only after the grace', () => {
  const now = 1_000_000
  assert.equal(mayRedial({ selfId: 'A', peerId: 'B', now, lostAt: now - 1_000 }), true, 'smaller id: dial now')
  assert.equal(mayRedial({ selfId: 'B', peerId: 'A', now, lostAt: now - 1_000 }), false, 'larger id: let the other go first')
  assert.equal(mayRedial({ selfId: 'B', peerId: 'A', now, lostAt: now - 25_000 }), true, 'larger id, still down after the grace: fallback')
  assert.equal(mayRedial({ selfId: 'B', peerId: 'A', now, lostAt: undefined }), true, 'start-up: never held back')
})
