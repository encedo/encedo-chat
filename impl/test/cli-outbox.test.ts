import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Outbox, outgoingText, CAP_PER_RECIPIENT, DEFAULT_TTL_MS } from '../cli/outbox.ts'

test('queued oldest first per recipient; delivered entries leave', () => {
  const o = new Outbox()
  o.add('ewa', 'jeden', { now: 1 }); o.add('ewa', 'dwa', { now: 2 }); o.add('bob', 'b', { now: 3 })
  assert.deepEqual(o.due('ewa', 10).map((e) => e.text), ['jeden', 'dwa'])
  o.delivered(o.due('ewa', 10)[0], 10)
  assert.deepEqual(o.forRecipient('ewa').map((e) => e.text), ['dwa'])
  assert.deepEqual(o.forRecipient('bob').map((e) => e.text), ['b'], 'another recipient untouched')
})

test('an expired entry is dropped, never delivered late', () => {
  const o = new Outbox()
  o.add('ewa', 'stare', { now: 0, ttlMs: 1000 })
  o.add('ewa', 'domyślne', { now: 0 })
  assert.deepEqual(o.expire(999).map((e) => e.text), [])
  assert.deepEqual(o.expire(1000).map((e) => e.text), ['stare'])
  assert.deepEqual(o.due('ewa', 1000).map((e) => e.text), ['domyślne'])
  assert.equal(o.forRecipient('ewa')[0].expires, DEFAULT_TTL_MS, 'the default TTL is a day')
})

test('the same key merges while waiting: newest text, the count said once', () => {
  const o = new Outbox()
  const a = o.add('ewa', 'login: x', { now: 1, key: 'ssh' })
  const b = o.add('ewa', 'login: y', { now: 2, key: 'ssh' })
  const c = o.add('ewa', 'login: z', { now: 3, key: 'ssh' })
  assert.deepEqual([a.how, b.how, c.how], ['queued', 'merged', 'merged'])
  assert.equal(o.forRecipient('ewa').length, 1)
  assert.equal(outgoingText(o.forRecipient('ewa')[0]), 'login: z (+2 wcześniejszych)')
  o.add('ewa', 'dysk 92%', { now: 4, key: 'disk' })
  o.add('bob', 'login: q', { now: 5, key: 'ssh' })
  assert.equal(o.forRecipient('ewa').length, 2, 'a different key is its own entry')
  assert.equal(o.forRecipient('bob').length, 1, 'the same key to another recipient is its own entry')
})

test('online: one message per key per window; the rest wait and merge', () => {
  const o = new Outbox()
  assert.equal(o.throttled('ewa', 'ssh', 0), false, 'the first one goes')
  o.delivered({ to: 'ewa', key: 'ssh' }, 0)
  assert.equal(o.throttled('ewa', 'ssh', 30_000), true, 'inside the window: wait')
  assert.equal(o.throttled('ewa', undefined, 30_000), false, 'no key, no throttle')
  o.add('ewa', 'login 2', { now: 30_000, key: 'ssh' })
  o.add('ewa', 'login 3', { now: 40_000, key: 'ssh' })
  assert.deepEqual(o.due('ewa', 59_999), [], 'not due before the window ends')
  assert.equal(outgoingText(o.due('ewa', 60_000)[0]), 'login 3 (+1 wcześniejszych)')
})

test('a cap per recipient pushes the oldest out, and says which', () => {
  const o = new Outbox()
  for (let i = 0; i < CAP_PER_RECIPIENT; i++) o.add('ewa', 'm' + i, { now: i })
  const r = o.add('ewa', 'nowa', { now: 1000 })
  assert.deepEqual(r.dropped.map((e) => e.text), ['m0'])
  assert.equal(o.forRecipient('ewa').length, CAP_PER_RECIPIENT)
  assert.equal(o.forRecipient('ewa').at(-1)!.text, 'nowa')
})

test('an entry waiting for its key\'s window is not "due", so it does not hold up other messages', () => {
  const o = new Outbox()
  o.delivered({ to: 'ewa', key: 'ssh' }, 0)
  o.add('ewa', 'login 2', { now: 10_000, key: 'ssh' })
  assert.deepEqual(o.due('ewa', 20_000), [], 'waiting for the window, not due')
  o.add('ewa', 'zwykła', { now: 20_000 })
  assert.deepEqual(o.due('ewa', 20_000).map((e) => e.text), ['zwykła'], 'an unrelated one is due at once')
})
