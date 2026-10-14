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
import { sealPins, openPins, pinsName, migrateLegacyPins, withPin, withoutPin, PIN_LIMIT, type Pin } from '../lib/pincache.ts'
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

const KID = '5954eb6d5a1dd906ec78fe9dae5645e3'
const PEER = 'iv3Q1qyn2LhfwPVy7UvnKi/f0yiqZLeY4GALWq5ilzA='
const GID = '00112233445566778899aabbccddeeff'
const mem = (seed: Record<string, string> = {}) => {
  const m = new Map(Object.entries(seed))
  return { m, keys: () => [...m.keys()], get: (k: string) => m.get(k) ?? null, set: (k: string, v: string) => { m.set(k, v) }, remove: (k: string) => { m.delete(k) } }
}

test('a room\'s storage name says nothing about the room, and is the same every time', async () => {
  const n1 = await pinsName(BASE, KID, PEER)
  assert.match(n1, new RegExp('^ec-pin-' + KID + '-[0-9a-f]{32}$'))
  assert.ok(!n1.includes(PEER) && !n1.includes(PEER.slice(0, 8)), 'no trace of the contact key')
  assert.equal(await pinsName(BASE, KID, PEER), n1)
  assert.notEqual(await pinsName(BASE, KID, GID), n1, 'two rooms, two names')
  assert.notEqual(await pinsName(randomBytes(32), KID, PEER), n1, 'without the identity\'s base the name cannot be computed')
})

test('pins under the old name move to the keyed one, and the old name is gone', async () => {
  const kv = mem({
    [`ec-pins-${KID}-${PEER}`]: await sealPins(BASE, PEER, [pin('m1', 1)]),
    [`ec-pins-${KID}-${GID}`]: await sealPins(BASE, GID, [pin('g1', 2), pin('g2', 3)]),
    [`ec-pins-${KID}-junk`]: 'AAAA',
    [`ec-pins-ffffffffffffffffffffffffffffffff-${PEER}`]: 'not ours',
  })
  assert.equal(await migrateLegacyPins(kv, BASE, KID), 2)
  assert.deepEqual(kv.keys().filter((k) => k.startsWith('ec-pins-' + KID)), [], 'every old name of this identity is gone, the unreadable one too')
  assert.ok(kv.get('ec-pins-ffffffffffffffffffffffffffffffff-' + PEER), 'another identity\'s is not ours to touch')
  assert.deepEqual((await openPins(BASE, PEER, kv.get(await pinsName(BASE, KID, PEER))!))!.map((p) => p.id), ['m1'])
  assert.deepEqual((await openPins(BASE, GID, kv.get(await pinsName(BASE, KID, GID))!))!.map((p) => p.id), ['g1', 'g2'])
  assert.equal(await migrateLegacyPins(kv, BASE, KID), 0, 'a second run has nothing to do')
})

test('a keyed name already written wins over an old copy', async () => {
  const name = await pinsName(BASE, KID, PEER)
  const kv = mem({ [name]: await sealPins(BASE, PEER, [pin('new', 9)]), [`ec-pins-${KID}-${PEER}`]: await sealPins(BASE, PEER, [pin('old', 1)]) })
  await migrateLegacyPins(kv, BASE, KID)
  assert.deepEqual((await openPins(BASE, PEER, kv.get(name)!))!.map((p) => p.id), ['new'])
  assert.equal(kv.get(`ec-pins-${KID}-${PEER}`), null)
})
