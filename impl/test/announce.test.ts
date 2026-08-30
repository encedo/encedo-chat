import { test } from 'node:test'
import assert from 'node:assert/strict'
import { nonceCache } from '../lib/announce.ts'

/**
 * The dedup set must stay BOUNDED. Every watch keeps one, a heartbeat adds an
 * entry every 15 s per topic, and a session left open for days used to grow a
 * plain Set without limit — found in the 2026-08-30 audit. The cache may
 * remember a nonce for longer than the ±5 min replay window (pruning is
 * amortized), but it must never remember the whole session.
 */
test('nonce cache forgets what the replay window can no longer use', () => {
  const orig = Date.now
  let now = 1_000_000
  Date.now = () => now
  try {
    const c = nonceCache(10 * 60_000)

    for (let i = 0; i < 300; i++) c.add('young-' + i)
    assert.ok(c.has('young-0'), 'a fresh nonce is remembered')
    assert.ok(c.size >= 300, 'nothing young is evicted — dedup still works')

    now += 11 * 60_000 // everything above is now past the window
    for (let i = 0; i < 300; i++) c.add('later-' + i)
    assert.ok(!c.has('young-0'), 'a nonce older than the window is forgotten')
    assert.ok(c.has('later-0'), 'the current generation is still deduplicated')
    assert.ok(c.size < 400, `stays bounded across generations (size=${c.size})`)
  } finally {
    Date.now = orig
  }
})

test('the cache answers has() the way the old Set did', () => {
  const c = nonceCache()
  assert.equal(c.has('x'), false)
  c.add('x')
  assert.equal(c.has('x'), true)
})
