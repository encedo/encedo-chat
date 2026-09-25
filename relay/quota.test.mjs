import { test } from 'node:test'
import assert from 'node:assert/strict'
import { makeQuota, DEFAULT_PER_PEER } from './quota.mjs'

test('one peer cannot take the whole node', () => {
  // The attack this exists to stop: one socket, 250 invented topic names, and
  // every real room after that is refused silently.
  const q = makeQuota(40)
  for (let i = 0; i < 40; i++) assert.ok(q.claim('napastnik', `t${i}`), `odmowa przy ${i}`)
  assert.equal(q.claim('napastnik', 't40'), false, 'the 41st was allowed through')
  // And the node is still open to everybody else, which is the point.
  assert.ok(q.claim('ktos-inny', 't0'))
})

test('the limit is per peer, not shared', () => {
  const q = makeQuota(2)
  assert.ok(q.claim('a', 'x')); assert.ok(q.claim('a', 'y'))
  assert.equal(q.claim('a', 'z'), false)
  assert.ok(q.claim('b', 'z'), 'one peer at its limit blocked another')
})

test('asking twice for the same topic is not a second claim', () => {
  // Re-announcing a subscription is ordinary GossipSub behaviour, and counting
  // it again would lock a well-behaved client out of its own rooms.
  const q = makeQuota(2)
  assert.ok(q.claim('a', 'x'))
  assert.ok(q.claim('a', 'x'))
  assert.ok(q.claim('a', 'x'))
  assert.equal(q.countFor('a'), 1)
  assert.ok(q.claim('a', 'y'), 'repeats ate the allowance')
})

test('dropping the same topic twice does not hand back a slot twice', () => {
  // Why this is a Set and not a counter: a peer that unsubscribes twice would
  // otherwise drift the count downwards, and a limit that drifts stops meaning
  // anything a few hours in.
  const q = makeQuota(2)
  q.claim('a', 'x'); q.claim('a', 'y')
  q.release('a', 'x'); q.release('a', 'x'); q.release('a', 'x')
  assert.ok(q.claim('a', 'z'))
  assert.equal(q.claim('a', 'w'), false, 'a repeated release invented a slot')
})

test('a peer that leaves takes its claims with it', () => {
  const q = makeQuota(2)
  q.claim('a', 'x'); q.claim('a', 'y')
  assert.equal(q.claim('a', 'z'), false)
  q.forget('a')
  assert.equal(q.countFor('a'), 0)
  assert.ok(q.claim('a', 'z'), 'a reconnecting peer stayed blocked by its old session')
  assert.equal(q.peers(), 1)
})

test('releasing the last topic forgets the peer entirely', () => {
  // Otherwise every peer that ever connected stays in the map for ever, which
  // is a slow leak on a process meant to run for months.
  const q = makeQuota(2)
  q.claim('a', 'x')
  q.release('a', 'x')
  assert.equal(q.peers(), 0)
})

test('a peer id is compared as text, whatever libp2p hands over', () => {
  const q = makeQuota(1)
  const asObject = { toString: () => 'peer-1' }
  assert.ok(q.claim(asObject, 'x'))
  assert.equal(q.claim('peer-1', 'y'), false, 'the same peer counted twice over')
})

test('the default is generous against the measured usage', () => {
  // Four topics per client measured on production; forty leaves a heavy user
  // with ten times their share and still takes the lever from one socket.
  assert.ok(DEFAULT_PER_PEER >= 2 * 70, 'a 70-contact address book must survive a rotation window')
  assert.ok(DEFAULT_PER_PEER * 10 <= 1600, 'still a small share of a node, so one socket cannot fill it')
  assert.ok(DEFAULT_PER_PEER < 250)
})
