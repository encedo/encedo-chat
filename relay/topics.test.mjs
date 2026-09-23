import { test } from 'node:test'
import assert from 'node:assert/strict'
import { peerIdOf, siblingSet, shouldJoin } from './topics.mjs'

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
