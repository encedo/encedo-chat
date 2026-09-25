import { test } from 'node:test'
import assert from 'node:assert/strict'
import { LOAD_TOPIC, loadPercent, encodeLoad, decodeLoad, freshest, STALE_MS, ANNOUNCE_MS } from './load.mjs'
import { makeLoadCache, base32 } from './load.mjs'
import { createHash } from 'node:crypto'

test('the topic is shaped like every other topic, so it does not stand out', () => {
  // Room topics are 52 base32 characters out of HKDF. One readable name among
  // them would mark the traffic as ours, which is the property they exist to
  // avoid.
  assert.equal(LOAD_TOPIC.length, 52)
  assert.match(LOAD_TOPIC, /^[a-z2-7]{52}$/)
  // A constant: every node must land on the same string without agreeing on it.
  assert.equal(LOAD_TOPIC, LOAD_TOPIC)
})

test('the WORSE of the two limits is what gets published', () => {
  // Connections run out first in the ordinary case; topics run out later and
  // refuse SILENTLY. Publishing either alone would send people to a node that
  // has room by one measure and none by the other.
  assert.equal(loadPercent({ conns: 520, maxConns: 520, topics: 1, maxTopics: 250 }), 100)
  assert.equal(loadPercent({ conns: 1, maxConns: 520, topics: 250, maxTopics: 250 }), 100)
  assert.equal(loadPercent({ conns: 52, maxConns: 520, topics: 0, maxTopics: 250 }), 10)
})

test('a percent, 0 to 100, rounded towards full', () => {
  // 100 and not 99: "no point coming here" has to be sayable, and it is the one
  // reading a client must not mistake for "nearly".
  assert.equal(loadPercent({ conns: 100, maxConns: 100 }), 100)
  // Rounded UP, so 90.1% reports 91 rather than "90, go ahead"...
  assert.equal(loadPercent({ conns: 901, maxConns: 1000 }), 91)
  // ...and a node with anybody on it never reports empty.
  assert.equal(loadPercent({ conns: 1, maxConns: 520 }), 1)
  assert.equal(loadPercent({ conns: 0, maxConns: 520 }), 0)
  // Never past 100, whatever a miscounted gauge says.
  assert.equal(loadPercent({ conns: 9999, maxConns: 520 }), 100)
})

test('an announcement survives the wire', () => {
  const at = 1_700_000_000_000
  const r = decodeLoad(encodeLoad('bs3', 30, at))
  assert.deepEqual(r, { node: 'bs3', pct: 30, at })
})

test('rubbish off the network is refused, not guessed at', () => {
  const enc = (o) => new TextEncoder().encode(JSON.stringify(o))
  assert.equal(decodeLoad(new TextEncoder().encode('not json')), null)
  assert.equal(decodeLoad(enc({ v: 2, n: 'bs3', pct: 10, at: 1 })), null, 'a future version')
  assert.equal(decodeLoad(enc({ v: 1, n: '', pct: 10, at: 1 })), null, 'no name')
  assert.equal(decodeLoad(enc({ v: 1, n: 'bs3', pct: -1, at: 1 })), null, 'negative load')
  assert.equal(decodeLoad(enc({ v: 1, n: 'bs3', pct: 101, at: 1 })), null, 'over full')
  assert.equal(decodeLoad(enc({ v: 1, n: 'bs3', pct: 12.5, at: 1 })), null, 'not a whole percent')
  assert.equal(decodeLoad(enc({ v: 1, n: 'bs3', pct: Infinity, at: 1 })), null)
  assert.equal(decodeLoad(enc({ v: 1, n: 'bs3', pct: 10 })), null, 'no timestamp')
})

test('a node that went quiet stops counting', () => {
  // The failure this exists to prevent: a relay dies, its last words stay in
  // every listener, and "empty, come in" makes the dead node the most
  // attractive one on the network.
  const now = 1_700_000_000_000
  const live = { node: 'bs3', pct: 20, at: now - 1000 }
  const dead = { node: 'bs1', pct: 0, at: now - STALE_MS - 1 }
  const seen = freshest([live, dead], now)
  assert.ok(seen.has('bs3'))
  assert.ok(!seen.has('bs1'), 'a stale "empty" was still believed')
})

test('the newest reading per node wins', () => {
  const now = 1_700_000_000_000
  const seen = freshest([
    { node: 'bs3', pct: 90, at: now - 20_000 },
    { node: 'bs3', pct: 20, at: now - 1_000 },
  ], now)
  assert.equal(seen.get('bs3').pct, 20)
})

test('a reading from the future is not evidence', () => {
  // A node with a wrong clock would otherwise win every comparison for ever.
  const now = 1_700_000_000_000
  const seen = freshest([{ node: 'bs1', pct: 0, at: now + ANNOUNCE_MS * 5 }], now)
  assert.ok(!seen.has('bs1'))
})

test('the cache hands over the newest reading of every node, and nothing stale', () => {
  const c = makeLoadCache()
  const now = 1_000_000_000
  assert.equal(c.put('p1', encodeLoad('bs1', 10, now - 40_000)), true)
  c.put('p1', encodeLoad('bs1', 30, now - 5_000))      // newer: replaces
  c.put('p1', encodeLoad('bs1', 99, now - 60_000))     // older: ignored
  c.put('p2', encodeLoad('bs2', 50, now - 200_000))    // stale by the time it is asked for
  c.put('p3', encodeLoad('bs3', 70, now - 1_000))
  assert.equal(c.put('p4', new TextEncoder().encode('rubbish')), false)
  const got = c.snapshot(now).map((e) => [decodeLoad(e.data).node, decodeLoad(e.data).pct, e.from]).sort()
  assert.deepEqual(got, [['bs1', 30, 'p1'], ['bs3', 70, 'p3']])
})

test('the written-out topic is still base32(sha256("encedo-chat-relay-load-v1"))[:52]', () => {
  assert.equal(LOAD_TOPIC, base32(createHash('sha256').update('encedo-chat-relay-load-v1').digest()).slice(0, 52))
})
