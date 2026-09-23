import { test } from 'node:test'
import assert from 'node:assert/strict'
import { LOAD_TOPIC, saturation, encodeLoad, decodeLoad, freshest, STALE_MS, ANNOUNCE_MS } from './load.mjs'

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
  assert.equal(saturation({ conns: 520, maxConns: 520, topics: 1, maxTopics: 250 }), 1)
  assert.equal(saturation({ conns: 1, maxConns: 520, topics: 250, maxTopics: 250 }), 1)
  assert.equal(saturation({ conns: 52, maxConns: 520, topics: 0, maxTopics: 250 }), 0.1)
})

test('saturation is coarse, and rounds towards full', () => {
  // 0.91 answers "nearly full", not "nine tenths, go ahead".
  assert.equal(saturation({ conns: 91, maxConns: 100 }), 1)
  assert.equal(saturation({ conns: 11, maxConns: 100 }), 0.2)
  assert.equal(saturation({ conns: 0, maxConns: 520 }), 0)
  // Never past 1, whatever a miscounted gauge says.
  assert.equal(saturation({ conns: 9999, maxConns: 520 }), 1)
})

test('an announcement survives the wire', () => {
  const at = 1_700_000_000_000
  const r = decodeLoad(encodeLoad('bs3', 0.3, at))
  assert.deepEqual(r, { node: 'bs3', sat: 0.3, at })
})

test('rubbish off the network is refused, not guessed at', () => {
  const enc = (o) => new TextEncoder().encode(JSON.stringify(o))
  assert.equal(decodeLoad(new TextEncoder().encode('not json')), null)
  assert.equal(decodeLoad(enc({ v: 2, n: 'bs3', s: 0.1, at: 1 })), null, 'a future version')
  assert.equal(decodeLoad(enc({ v: 1, n: '', s: 0.1, at: 1 })), null, 'no name')
  assert.equal(decodeLoad(enc({ v: 1, n: 'bs3', s: -1, at: 1 })), null, 'negative load')
  assert.equal(decodeLoad(enc({ v: 1, n: 'bs3', s: 2, at: 1 })), null, 'over full')
  assert.equal(decodeLoad(enc({ v: 1, n: 'bs3', s: Infinity, at: 1 })), null)
  assert.equal(decodeLoad(enc({ v: 1, n: 'bs3', s: 0.1 })), null, 'no timestamp')
})

test('a node that went quiet stops counting', () => {
  // The failure this exists to prevent: a relay dies, its last words stay in
  // every listener, and "empty, come in" makes the dead node the most
  // attractive one on the network.
  const now = 1_700_000_000_000
  const live = { node: 'bs3', sat: 0.2, at: now - 1000 }
  const dead = { node: 'bs1', sat: 0, at: now - STALE_MS - 1 }
  const seen = freshest([live, dead], now)
  assert.ok(seen.has('bs3'))
  assert.ok(!seen.has('bs1'), 'a stale "empty" was still believed')
})

test('the newest reading per node wins', () => {
  const now = 1_700_000_000_000
  const seen = freshest([
    { node: 'bs3', sat: 0.9, at: now - 20_000 },
    { node: 'bs3', sat: 0.2, at: now - 1_000 },
  ], now)
  assert.equal(seen.get('bs3').sat, 0.2)
})

test('a reading from the future is not evidence', () => {
  // A node with a wrong clock would otherwise win every comparison for ever.
  const now = 1_700_000_000_000
  const seen = freshest([{ node: 'bs1', sat: 0, at: now + ANNOUNCE_MS * 5 }], now)
  assert.ok(!seen.has('bs1'))
})
