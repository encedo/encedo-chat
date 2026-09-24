import { test } from 'node:test'
import assert from 'node:assert/strict'
import { TAG, wrap, unwrap, isTagged, origin } from '../lib/origin.ts'
import { T_MSG1, T_MSG2, T_MSG3 } from '../eh2/wire.ts'

const PEER = '12D3KooWP6SpQxgcUDdAU1CdY3dcvSrkxHPki7FRtMLLYiGxcDmp'
const RELAY = { toString: () => '12D3KooWRelay' }
const frame = Uint8Array.from([0x10, 1, 2, 3, 4])

test('a wrapped frame comes back with its sender and its bytes untouched', () => {
  const w = wrap(PEER, frame)
  assert.equal(w[0], TAG)
  assert.equal(w[1], PEER.length)
  const u = unwrap(w)
  assert.ok(u)
  assert.equal(u.from, PEER)
  assert.deepEqual([...u.frame], [...frame])
})

test('origin() prefers the envelope over the transport', () => {
  // This is the whole point: a relay publishing on a client's behalf is the
  // transport sender, and the handler must not see it.
  const o = origin({ detail: { data: wrap(PEER, frame), from: RELAY } })
  assert.ok(o)
  assert.equal(o.from, PEER)
  assert.deepEqual([...o.data], [...frame])
})

test('origin() falls back to the transport for an untagged frame', () => {
  const o = origin({ detail: { data: frame, from: RELAY } })
  assert.ok(o)
  assert.equal(o.from, RELAY.toString())
  assert.equal(o.data, frame, 'the same bytes, not a copy')
})

test('a tagged frame that does not fit its length is dropped, not guessed at', () => {
  assert.equal(unwrap(Uint8Array.from([TAG, 0, 0x41])), null, 'zero-length sender')
  assert.equal(unwrap(Uint8Array.from([TAG, 200, 0x41, 0x42])), null, 'sender longer than the frame')
  assert.equal(unwrap(Uint8Array.from([TAG])), null, 'tag alone')
  assert.equal(origin({ detail: { data: Uint8Array.from([TAG, 9, 0x41]), from: RELAY } }), null,
    'origin() does not fall back to the transport for a broken envelope')
})

test('an empty inner frame is still a frame', () => {
  const u = unwrap(wrap(PEER, new Uint8Array(0)))
  assert.ok(u)
  assert.equal(u.frame.length, 0)
})

test('a sender that does not fit one byte of length cannot be wrapped', () => {
  assert.throws(() => wrap('x'.repeat(256), frame), /does not fit/)
  assert.throws(() => wrap('', frame), /does not fit/)
  assert.equal(wrap('x'.repeat(255), frame)[1], 255)
})

test('the tag collides with no frame family on a pair, self or group topic', () => {
  // The inventory the module comment relies on. If a new family ever starts
  // with 0xE1 this fails before it reaches a topic.
  const firstBytes = [T_MSG1, T_MSG2, T_MSG3, 0x10 /* ratchet */, 0x20, 0x21 /* group */, 0x7b /* '{' */]
  for (const b of firstBytes) assert.notEqual(b, TAG)
  for (const b of firstBytes) assert.equal(isTagged(Uint8Array.from([b, 0x01, 0x02])), false)
})
