/**
 * The pick/push adapter (`net/light.ts`) over a fake stream: the mapping from
 * the engine's node shape onto /onchato/pick/1 frames, and the two facts the
 * room reads off it -- who is on a topic (PICKED) and how far a publish went
 * (ACK). No libp2p here; the wire is covered by net/light-test.ts.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { pickAdapter } from '../net/light.ts'
import { T, decodeFrame, encodeDeliver, encodePicked, encodeRefused, encodeAck } from '../../relay/pick.mjs'

const RELAY = 'relay-peer'
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** A stream that records what the adapter sends and lets the test answer. */
function fakeStream() {
  const sent: any[] = []
  let feed: ((f: any) => void) | null = null
  let closed = 0
  let onClose: (() => void) | null = null
  const open = async (_relay: string, onFrame: (f: any) => void, close: () => void) => {
    feed = onFrame; onClose = close
    return { send: (b: Uint8Array) => sent.push(decodeFrame(b)), close: () => { closed++ } }
  }
  return { sent, open, answer: (b: Uint8Array) => feed!(decodeFrame(b)), drop: () => onClose!(), get closed() { return closed } }
}

test('subscribe is a PICK, and the relay is on the topic only once it said PICKED', async () => {
  const s = fakeStream()
  const a = pickAdapter('me', {})
  await a.attach(RELAY, s.open)
  a.pubsub.subscribe('T')
  assert.deepEqual(s.sent.map((f) => f.type), [T.PICK])
  assert.deepEqual(a.pubsub.getSubscribers('T'), [], 'not before PICKED')
  s.answer(encodePicked('T'))
  assert.deepEqual(a.pubsub.getSubscribers('T').map(String), [RELAY])
  a.pubsub.subscribe('T')
  assert.equal(s.sent.length, 1, 'picking twice sends once')
  a.pubsub.unsubscribe('T')
  assert.equal(s.sent.at(-1).type, T.DROP)
  assert.deepEqual(a.pubsub.getSubscribers('T'), [], 'gone after DROP')
})

test('REFUSED leaves the topic empty and is told to the owner', async () => {
  const s = fakeStream()
  const refused: string[] = []
  const a = pickAdapter('me', { onRefused: (t) => refused.push(t) })
  await a.attach(RELAY, s.open)
  a.pubsub.subscribe('T')
  s.answer(encodeRefused('T'))
  assert.deepEqual(a.pubsub.getSubscribers('T'), [])
  assert.deepEqual(refused, ['T'])
  // A PICKED for a topic we never asked for changes nothing.
  s.answer(encodePicked('X'))
  assert.deepEqual(a.pubsub.getSubscribers('X'), [])
})

test('publish is a PUSH whose ACK becomes the recipient count the room reads', async () => {
  const s = fakeStream()
  const a = pickAdapter('me', { ackTimeoutMs: 500 })
  await a.attach(RELAY, s.open)
  const p1 = a.pubsub.publish('T', Uint8Array.from([1]))
  const p2 = a.pubsub.publish('T', Uint8Array.from([2]))
  assert.deepEqual(s.sent.map((f) => f.type), [T.PUSH, T.PUSH])
  assert.deepEqual([...s.sent[1].data], [2], 'bytes go out as given')
  s.answer(encodeAck('T', 3))
  s.answer(encodeAck('T', 0))
  assert.equal((await p1).recipients.length, 3, 'first ack answers the first push')
  assert.equal((await p2).recipients.length, 0, 'zero is a real zero')
})

test('no ACK in time is "no evidence", not zero; no stream is an error', async () => {
  const s = fakeStream()
  const a = pickAdapter('me', { ackTimeoutMs: 50 })
  await a.attach(RELAY, s.open)
  const r = await a.pubsub.publish('T', Uint8Array.from([1]))
  assert.equal(r.recipients, null)
  a.detach()
  await assert.rejects(a.pubsub.publish('T', Uint8Array.from([1])), /no pick stream/)
})

test('a DELIVER is a message event in the shape the room expects', async () => {
  const s = fakeStream()
  const a = pickAdapter('me', {})
  await a.attach(RELAY, s.open)
  const got: any[] = []
  a.pubsub.addEventListener('message', (e) => got.push(e))
  s.answer(encodeDeliver('alice', 'T', Uint8Array.from([9, 9])))
  assert.equal(got.length, 1)
  assert.equal(got[0].detail.topic, 'T')
  assert.equal(got[0].detail.from.toString(), 'alice')
  assert.deepEqual([...got[0].detail.data], [9, 9])
})

test('losing the stream forgets the picks and answers pending pushes with nothing; a new attach re-picks', async () => {
  const s = fakeStream()
  const a = pickAdapter('me', { ackTimeoutMs: 5_000 })
  await a.attach(RELAY, s.open)
  a.pubsub.subscribe('T'); a.pubsub.subscribe('U')
  s.answer(encodePicked('T')); s.answer(encodePicked('U'))
  const pending = a.pubsub.publish('T', Uint8Array.from([1]))
  s.drop()
  assert.deepEqual(a.pubsub.getSubscribers('T'), [], 'the relay is not on our topics once the stream is gone')
  assert.equal((await pending).recipients, null)
  assert.equal(a.connected(), false)
  const s2 = fakeStream()
  await a.attach(RELAY, s2.open)
  assert.deepEqual(s2.sent.map((f) => [f.type, f.topic]).sort(), [[T.PICK, 'T'], [T.PICK, 'U']], 'everything still held is picked again')
  assert.deepEqual(a.pubsub.getSubscribers('T'), [], 'and not on the topic until PICKED comes back')
  s2.answer(encodePicked('T'))
  assert.equal(a.pubsub.getSubscribers('T').length, 1)
  await sleep(1)
})
