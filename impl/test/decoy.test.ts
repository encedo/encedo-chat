/**
 * decoy.test.ts - decoy subscriptions (lib/decoy.ts, SPEC.md 5.10): the
 * topics look like pair topics, they announce like a pair topic whose
 * contact is away, they are stable across a restart, and they yield.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { startDecoys, decoyCount, decoyMaterial, DECOY_MAX } from '../lib/decoy.ts'
import { kdf } from '../lib/wc.ts'
import { unwrap } from '../lib/origin.ts'

const P = { networkId: 'test', dateUTC: '2026-10-13' }
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

function fakeNode() {
  const subs = new Set<string>(), published: { topic: string; data: Uint8Array }[] = []
  return {
    subs, published,
    peerId: { toString: () => 'me' },
    services: { pubsub: {
      addEventListener: () => {}, removeEventListener: () => {},
      subscribe: (t: string) => subs.add(t), unsubscribe: (t: string) => subs.delete(t),
      publish: async (topic: string, data: Uint8Array) => { published.push({ topic, data }) },
    } },
  }
}
const ikm = new Uint8Array(32).fill(0x42)
const deriveSelf = (label: string, ctx: Uint8Array, len: number) => kdf(label, ikm, ctx, len)

test('the count follows the contact list, up to the cap', () => {
  assert.equal(decoyCount(0), 0); assert.equal(decoyCount(3), 3); assert.equal(decoyCount(50), DECOY_MAX)
})

test('decoy topics are pair-shaped, distinct, and stable for the identity across a restart', async () => {
  const seed = await deriveSelf('encedo-chat-decoy-v1', new TextEncoder().encode('test\0'), 32)
  const a = await decoyMaterial(seed, 0, P), b = await decoyMaterial(seed, 1, P)
  assert.match(a.topic, /^[a-z2-7]{52}$/)
  assert.notEqual(a.topic, b.topic)
  assert.notEqual(a.offsetSec, b.offsetSec, 'each decoy hops at its own instant')
  assert.deepEqual(await decoyMaterial(seed, 0, P), a, 'deterministic: a restart resumes the same decoys')
  assert.notEqual((await decoyMaterial(seed, 0, { ...P, dateUTC: '2026-10-14' })).topic, a.topic, 'and they rotate daily')
  const other = await kdf('encedo-chat-decoy-v1', new Uint8Array(32).fill(0x43), new TextEncoder().encode('test\0'), 32)
  assert.notEqual((await decoyMaterial(other, 0, P)).topic, a.topic, 'another identity has other decoys')
})

test('decoys subscribe and announce like a pair whose contact is away, and yield on a refusal', async () => {
  const node = fakeNode()
  const d = startDecoys(node, 'me', { deriveSelf, params: P, heartbeatMs: 50, tickMs: 50 })
  await d.resize(3)
  await sleep(120)
  assert.equal(d.count(), 3)
  const topics = d.topics()
  assert.ok(topics.length >= 3)
  for (const t of topics) assert.ok(node.subs.has(t), 'each decoy topic is subscribed')
  const onDecoy = node.published.filter((p) => topics.includes(p.topic))
  assert.ok(onDecoy.length >= 3, 'each decoy announces')
  const ann = JSON.parse(new TextDecoder().decode(unwrap(onDecoy[0].data)?.frame ?? onDecoy[0].data))
  assert.equal(ann.v, 3); assert.equal(typeof ann.mac, 'string'); assert.equal(ann.peer, 'me')
  assert.ok(d.isDecoy(topics[0])); assert.equal(d.isDecoy('a-real-pair-topic'), false)

  await d.resize(1)
  assert.equal(d.count(), 1, 'shrinks with the contact list')
  d.yieldAll('test')
  assert.equal(d.count(), 0)
  for (const t of topics) assert.ok(!node.subs.has(t), 'every decoy released its slot')
  await d.resize(3)
  assert.equal(d.count(), 0, 'and they do not come back in this session')
  d.stop()
})
