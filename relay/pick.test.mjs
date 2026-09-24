import { test } from 'node:test'
import assert from 'node:assert/strict'
import { T, PROTOCOL, encodePick, encodeDrop, encodeRefused, encodePicked, encodeDeliver, encodePush, encodeAck, decodeFrame, makePicks } from './pick.mjs'

const TOPIC = 'topic-a'
const OTHER = 'topic-b'
const ALICE = 'peer-alice'
const BOB = 'peer-bob'

test('protocol name carries a version', () => {
  assert.match(PROTOCOL, /^\/onchato\/pick\/\d+$/)
})

test('control frames round-trip', () => {
  assert.deepEqual(decodeFrame(encodePick(TOPIC)), { type: T.PICK, topic: TOPIC })
  assert.deepEqual(decodeFrame(encodeDrop(TOPIC)), { type: T.DROP, topic: TOPIC })
  assert.deepEqual(decodeFrame(encodeRefused(TOPIC)), { type: T.REFUSED, topic: TOPIC })
  assert.deepEqual(decodeFrame(encodePicked(TOPIC)), { type: T.PICKED, topic: TOPIC })
  assert.notEqual(T.PICKED, T.REFUSED, 'yes and no are different bytes')
})

test('a delivery keeps the original sender, the topic and the bytes', () => {
  // `from` is load-bearing in the client (sessions are keyed by it), so the
  // relay must pass on the GossipSub publisher id, not its own.
  const data = Uint8Array.from([9, 8, 7, 6])
  const f = decodeFrame(encodeDeliver(ALICE, TOPIC, data))
  assert.equal(f.type, T.DELIVER)
  assert.equal(f.from, ALICE)
  assert.equal(f.topic, TOPIC)
  assert.deepEqual([...f.data], [9, 8, 7, 6])
})

test('an empty payload is still a delivery', () => {
  const f = decodeFrame(encodeDeliver(ALICE, TOPIC, new Uint8Array(0)))
  assert.equal(f.data.length, 0)
})

test('a push carries the topic and the bytes untouched; an ack carries the count', () => {
  const data = Uint8Array.from([0xe1, 3, 65, 66, 67, 0x10, 9])   // an origin envelope: opaque here
  const f = decodeFrame(encodePush(TOPIC, data))
  assert.equal(f.type, T.PUSH)
  assert.equal(f.topic, TOPIC)
  assert.deepEqual([...f.data], [...data], 'the relay must never touch the payload')
  const a = decodeFrame(encodeAck(TOPIC, 3))
  assert.deepEqual(a, { type: T.ACK, topic: TOPIC, recipients: 3 })
  assert.equal(decodeFrame(encodeAck(TOPIC, 0)).recipients, 0, 'zero is an answer, not an absence')
  assert.equal(decodeFrame(encodeAck(TOPIC, 70000)).recipients, 0xffff, 'clamped to two bytes')
  assert.equal(decodeFrame(encodePush(TOPIC, new Uint8Array(0))).data.length, 0, 'an empty push is still a push')
})

test('rubbish is refused, not guessed at', () => {
  assert.equal(decodeFrame(new Uint8Array(0)), null)
  assert.equal(decodeFrame(Uint8Array.from([0x01])), null, 'a type with no topic')
  assert.equal(decodeFrame(Uint8Array.from([0x7f, 1, 2])), null, 'unknown type')
  // A delivery whose declared lengths overrun the frame.
  assert.equal(decodeFrame(Uint8Array.from([T.DELIVER, 200, 1, 2])), null)
  assert.equal(decodeFrame(Uint8Array.from([T.DELIVER, 1, 65, 200, 1])), null)
  assert.equal(decodeFrame(Uint8Array.from([T.PUSH, 200, 65])), null, 'a push whose topic overruns the frame')
  assert.equal(decodeFrame(Uint8Array.from([T.ACK, 1, 65, 0])), null, 'an ack short of its two count bytes')
  // A name that does not fit one byte of length is not encodable at all.
  assert.throws(() => encodePick('x'.repeat(256)), /does not fit/)
  assert.throws(() => encodePick(''), /does not fit/)
})

test('a message on a topic reaches everyone who picked it except the sender', () => {
  const p = makePicks()
  const got = []
  p.add(ALICE, TOPIC, () => got.push('alice'))
  p.add(BOB, TOPIC, () => got.push('bob'))
  for (const sink of p.sinksFor(TOPIC, ALICE)) sink()
  assert.deepEqual(got, ['bob'])
  assert.equal(p.sinksFor(OTHER).length, 0)
})

test('picking the same topic twice holds one slot; dropping twice frees one', () => {
  const p = makePicks()
  p.add(ALICE, TOPIC, () => {})
  p.add(ALICE, TOPIC, () => {})
  assert.equal(p.holders(TOPIC), 1)
  assert.deepEqual(p.topicsOf(ALICE), [TOPIC])
  p.drop(ALICE, TOPIC); p.drop(ALICE, TOPIC)
  assert.equal(p.holders(TOPIC), 0)
  assert.deepEqual(p.topics(), [])
})

test('a peer that leaves releases every topic it picked, and says which', () => {
  const p = makePicks()
  p.add(ALICE, TOPIC, () => {})
  p.add(ALICE, OTHER, () => {})
  p.add(BOB, TOPIC, () => {})
  const released = p.forget(ALICE)
  assert.deepEqual(released.sort(), [TOPIC, OTHER].sort())
  assert.equal(p.holders(TOPIC), 1, 'bob is still there')
  assert.equal(p.holders(OTHER), 0)
  assert.deepEqual(p.topicsOf(ALICE), [])
})

test('a peer id is compared as text, whatever libp2p hands over', () => {
  const p = makePicks()
  p.add({ toString: () => ALICE }, TOPIC, () => {})
  assert.equal(p.holders(TOPIC), 1)
  assert.equal(p.sinksFor(TOPIC, ALICE).length, 0, 'the same peer was not recognised as the sender')
})
