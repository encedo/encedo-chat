import { test } from 'node:test'
import assert from 'node:assert/strict'
import { pickFirst, orderFrom } from '../lib/nodepick.ts'

const N = (addr: string, w?: number) => (w === undefined ? { addr } : { addr, w })

test('with no weights the draw is uniform: every node gets its share', () => {
  // The published list carries no weights. Until 2026-09-25 the first node won
  // every roll, and a demo room landed on one node; now the roll spreads them.
  const list = [N('a'), N('b'), N('c')]
  const hits = [0, 0, 0]
  const ROLLS = 3000
  for (let i = 0; i < ROLLS; i++) hits[pickFirst(list, i / ROLLS)]++
  for (const h of hits) assert.ok(Math.abs(h - ROLLS / 3) < ROLLS * 0.02, `uneven split ${hits}`)
  assert.equal(pickFirst(list, 0), 0)
  assert.equal(pickFirst(list, 0.34), 1)
  assert.equal(pickFirst(list, 0.99), 2)
})

test('a weight splits the choice where the weight says', () => {
  const list = [N('a', 3), N('b', 1)] // 75% / 25%
  assert.equal(pickFirst(list, 0), 0)
  assert.equal(pickFirst(list, 0.74), 0)
  assert.equal(pickFirst(list, 0.75), 1, 'the boundary belongs to the second')
  assert.equal(pickFirst(list, 0.99), 1)
})

test('over many rolls the split is the one that was asked for', () => {
  const list = [N('big', 7), N('mid', 2), N('small', 1)]
  const hits = [0, 0, 0]
  const ROLLS = 10_000
  for (let i = 0; i < ROLLS; i++) hits[pickFirst(list, i / ROLLS)]++
  // Deterministic sweep rather than Math.random(), so this cannot flicker.
  assert.equal(hits[0], 7000)
  assert.equal(hits[1], 2000)
  assert.equal(hits[2], 1000)
})

test('weight 0 is never dialled first, but stays in the list', () => {
  // What bs1 is for: the web host, wanted as a spare and not as a destination.
  const list = [N('busy', 5), N('spare', 0), N('other', 5)]
  for (let i = 0; i < 1000; i++) {
    assert.notEqual(pickFirst(list, i / 1000), 1, 'a zero-weight node was drawn')
  }
  assert.equal(orderFrom(list, 0).length, 3, 'and it is still there to fall through to')
})

test('every weight zero is treated as no weights at all: uniform, never nothing', () => {
  const list = [N('a', 0), N('b', 0)]
  assert.equal(pickFirst(list, 0.2), 0)
  assert.equal(pickFirst(list, 0.7), 1)
})

test('a NaN roll with no weights still names a node', () => {
  assert.equal(pickFirst([N('a'), N('b')], NaN), 0)
})

test('a roll outside [0,1) cannot walk off the end', () => {
  // `Math.random()` never returns 1, but a caller that computes its own roll
  // might, and an out-of-range index here would mean dialling `undefined`.
  const list = [N('a', 1), N('b', 1)]
  for (const roll of [-1, 0, 1, 2, NaN]) {
    const i = pickFirst(list, roll)
    assert.ok(i >= 0 && i < list.length, `roll ${roll} produced index ${i}`)
  }
})

test('the drawn node leads and the rest keep their published order', () => {
  // The failover chain (3b) is tested and works; this decides where to START,
  // so everything after the first must stay where the list put it.
  const list = [N('bs3'), N('bs2'), N('bs1')]
  assert.deepEqual(orderFrom(list, 1).map((n) => n.addr), ['bs2', 'bs3', 'bs1'])
  assert.deepEqual(orderFrom(list, 2).map((n) => n.addr), ['bs1', 'bs3', 'bs2'])
  assert.deepEqual(orderFrom(list, 0).map((n) => n.addr), ['bs3', 'bs2', 'bs1'])
})

test('one node, or none, is not a special case for the caller', () => {
  assert.equal(pickFirst([N('only')], 0.9), 0)
  assert.equal(pickFirst([], 0.9), 0)
  assert.deepEqual(orderFrom([], 0), [])
})
