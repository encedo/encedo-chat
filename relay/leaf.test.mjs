import { test } from 'node:test'
import assert from 'node:assert/strict'
import { leafAnnouncements, shapeProblems } from './leaf.mjs'

/**
 * A stand-in with exactly the shape the patch relies on, and a log of every
 * RPC it would have sent. The real class is TypeScript-private here, so this is
 * also the documentation of which properties we depend on.
 */
function fakePubsub() {
  const sent = []
  return {
    sent,
    topics: new Map(),          // topic -> Set(peer)
    subscriptions: new Set(),   // ours
    // `to` is recorded AS GIVEN: the real sendRpc looks the stream up by the
    // peer's string, so an object here is a send that silently goes nowhere.
    sendSubscriptions(toPeer, topics, subscribe) { sent.push({ to: toPeer, topics: [...topics], subscribe }) },
    handleReceivedSubscription(from, topic, subscribe) {
      let s = this.topics.get(topic); if (!s) { s = new Set(); this.topics.set(topic, s) }
      if (subscribe) s.add(String(from)); else s.delete(String(from))
    },
  }
}
const BS1 = 'relay-bs1'

test('a sibling relay is still told everything', () => {
  const p = fakePubsub()
  leafAnnouncements(p, { siblings: new Set([BS1]) })
  p.subscriptions.add('t1'); p.subscriptions.add('t2')
  p.sendSubscriptions(BS1, ['t1', 't2'], true)
  assert.deepEqual(p.sent, [{ to: BS1, topics: ['t1', 't2'], subscribe: true }])
})

test('a fresh client is told nothing — it has asked for nothing', () => {
  // The connect-time broadcast: 6000 topics to a peer that wants one of them.
  const p = fakePubsub()
  leafAnnouncements(p, { siblings: new Set([BS1]) })
  for (let i = 0; i < 50; i++) p.subscriptions.add(`t${i}`)
  p.sendSubscriptions('client-a', [...p.subscriptions], true)
  assert.equal(p.sent.length, 0, 'a client that holds nothing was sent the list')
})

test('a client is told about exactly the topics it holds', () => {
  const p = fakePubsub()
  leafAnnouncements(p, { siblings: new Set([BS1]) })
  p.topics.set('mine', new Set(['client-a']))
  p.topics.set('theirs', new Set(['client-b']))
  p.sendSubscriptions('client-a', ['mine', 'theirs', 'nobodys'], true)
  assert.deepEqual(p.sent, [{ to: 'client-a', topics: ['mine'], subscribe: true }])
})

test('the order that makes a room form: record, then announce, then filter', () => {
  // client announces T  ->  recorded  ->  relay subscribes  ->  announce filtered
  // to holders. If the filter ran before the recording, the client would be
  // told nothing and its room would silently never form.
  const p = fakePubsub()
  leafAnnouncements(p, { siblings: new Set([BS1]) })
  p.handleReceivedSubscription('client-a', 'T', true)      // step 1
  p.subscriptions.add('T')                                  // step 2 (what subscribe() does)
  p.sendSubscriptions('client-a', ['T'], true)              // step 3 (what subscribe() sends)
  assert.ok(p.sent.some((r) => r.to === 'client-a' && r.topics.includes('T')), 'the client never learnt the relay carries T')
})

test('a second client joining a room the relay already carries is told so', () => {
  // subscribe(T) is NOT called again when we already hold T, so the broadcast
  // path never fires. The receive hook has to answer instead.
  const p = fakePubsub()
  leafAnnouncements(p, { siblings: new Set([BS1]) })
  p.subscriptions.add('T')                                  // relay already in T (client-a's doing)
  p.handleReceivedSubscription('client-b', 'T', true)
  assert.deepEqual(p.sent, [{ to: 'client-b', topics: ['T'], subscribe: true }])
})

test('the answer to a second joiner is addressed by STRING, whatever object the library hands over', () => {
  // The library calls handleReceivedSubscription with a PeerId object and
  // sendRpc with a string key. Answering with the object is a silent no-op:
  // the room looks like it formed and the client publishes to nobody.
  const p = fakePubsub()
  leafAnnouncements(p, { siblings: new Set([BS1]) })
  p.subscriptions.add('T')
  const peerIdLike = { toString: () => 'client-b' }
  p.handleReceivedSubscription(peerIdLike, 'T', true)
  assert.equal(p.sent.length, 1, 'the second joiner was told')
  assert.equal(typeof p.sent[0].to, 'string', `addressed by ${typeof p.sent[0].to}, the stream lookup needs a string`)
  assert.equal(p.sent[0].to, 'client-b')
})

test('a client announcing a topic we do NOT hold gets no answer yet', () => {
  // The answer comes a moment later, from subscribe(T) via the filtered
  // broadcast -- not from here. Answering here too would double it.
  const p = fakePubsub()
  leafAnnouncements(p, { siblings: new Set([BS1]) })
  p.handleReceivedSubscription('client-a', 'T', true)
  assert.equal(p.sent.length, 0)
})

test('an unknown relay is a leaf, not a sibling', () => {
  // Somebody else's node dialling us did not earn our topic list by doing so.
  const p = fakePubsub()
  leafAnnouncements(p, { siblings: new Set([BS1]) })
  p.subscriptions.add('t1')
  p.sendSubscriptions('relay-somebody-elses', ['t1'], true)
  assert.equal(p.sent.length, 0)
})

test('unsubscribe announcements are filtered the same way', () => {
  const p = fakePubsub()
  leafAnnouncements(p, { siblings: new Set([BS1]) })
  p.topics.set('T', new Set(['client-a']))
  p.sendSubscriptions('client-a', ['T', 'U'], false)
  assert.deepEqual(p.sent, [{ to: 'client-a', topics: ['T'], subscribe: false }])
})

test('the patch refuses a library whose shape moved, instead of running unpatched', () => {
  const broken = { sendSubscriptions() {}, topics: new Map() } // no handleReceivedSubscription, no subscriptions
  assert.ok(shapeProblems(broken).length >= 2)
  assert.throws(() => leafAnnouncements(broken, { siblings: new Set() }), /library shape changed/)
  // And a well-shaped one passes.
  assert.deepEqual(shapeProblems(fakePubsub()), [])
})

test('restore() puts the original methods back', () => {
  const p = fakePubsub()
  const orig = p.sendSubscriptions
  const { restore } = leafAnnouncements(p, { siblings: new Set() })
  assert.notEqual(p.sendSubscriptions, orig)
  restore()
  assert.equal(p.sendSubscriptions, orig)
})
