/**
 * The few messages somebody chose to keep.
 *
 * Two properties carry this module. A blob is readable only by the identity and
 * the conversation it was written for — everything else, including our own group
 * cache, gets `null` rather than an exception, because this runs while a
 * conversation is being painted. And a full room REFUSES the next pin instead of
 * dropping the oldest: silently discarding what somebody deliberately kept is
 * the one failure that would make the feature worse than not having it.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from '../lib/wc.ts'
import { sealPins, openPins, withPin, withoutPin, PIN_LIMIT, type Pin } from '../lib/pincache.ts'
import { sealCache } from '../lib/gcache.ts'

const BASE = randomBytes(32)
const ROOM = 'a1b2c3d4e5f60718'
const pin = (id: string, ts: number): Pin => ({ id, text: 'trzymaj to ' + id, ts, mine: false, pinnedAt: 9 })

test('a sealed list comes back as it went in', async () => {
  const pins = [pin('m1', 100), pin('m2', 200)]
  const got = await openPins(BASE, ROOM, await sealPins(BASE, ROOM, pins))
  assert.deepEqual(got, pins)
})

test('another identity, another room, or a tampered blob: null, not a throw', async () => {
  const blob = await sealPins(BASE, ROOM, [pin('m1', 100)])
  assert.equal(await openPins(randomBytes(32), ROOM, blob), null, 'another identity must not open it')
  assert.equal(await openPins(BASE, 'ffffffffffffffff', blob), null, 'another conversation must not open it')
  assert.equal(await openPins(BASE, ROOM, 'not base64 at all !!!'), null)
  assert.equal(await openPins(BASE, ROOM, ''), null)
})

test('the group cache and the pin cache do not open each other', async () => {
  // Same base, same room id, different context — the salts are what separate them.
  const group = await sealCache(BASE, ROOM, new TextEncoder().encode('{"snap":1}'))
  assert.equal(await openPins(BASE, ROOM, group), null)
})

test('a blob that opens but says something else is still refused', async () => {
  const junk = await sealPins(BASE, ROOM, [{ id: 1 } as any, { text: 'no id' } as any, pin('ok', 5)])
  assert.deepEqual((await openPins(BASE, ROOM, junk))?.map((p) => p.id), ['ok'])
})

test('pins read in the order the messages were said, not the order they were pinned', async () => {
  let pins: Pin[] = []
  pins = withPin(pins, pin('late', 900))!
  pins = withPin(pins, pin('early', 100))!
  assert.deepEqual(pins.map((p) => p.id), ['early', 'late'])
})

test('a full room refuses the next one instead of dropping the oldest', () => {
  let pins: Pin[] = []
  for (let i = 0; i < PIN_LIMIT; i++) pins = withPin(pins, pin('m' + i, i))!
  assert.equal(pins.length, PIN_LIMIT)
  assert.equal(withPin(pins, pin('one-too-many', 999)), null)
  assert.ok(pins.some((p) => p.id === 'm0'), 'the oldest is still there')
})

test('pinning the same message twice changes nothing, and says so', () => {
  const pins = withPin([], pin('m1', 100))!
  assert.equal(withPin(pins, pin('m1', 100)), pins, 'the same list back = nothing to write')
})

test('unpinning something that is not pinned is not an error', () => {
  const pins = withPin([], pin('m1', 100))!
  assert.deepEqual(withoutPin(pins, 'm1'), [])
  assert.deepEqual(withoutPin(pins, 'never-pinned'), pins)
})
