import { test } from 'node:test'
import assert from 'node:assert/strict'
import { markLeft, leftCovers, unmarkLeft, isLeftMap, LEFT_MAX } from '../lib/gleft.ts'

test('a left group covers its epoch and every older one, never a newer one', () => {
  const m = markLeft({}, 'g1', 3)
  assert.equal(leftCovers(m, 'g1', 3), true, 'the epoch we left at')
  assert.equal(leftCovers(m, 'g1', 1), true, 'a stale copy')
  assert.equal(leftCovers(m, 'g1', 4), false, 'the admin rekeyed: a fresh distribution')
  assert.equal(leftCovers(m, 'g2', 0), false, 'a group never left')
  assert.equal(leftCovers(unmarkLeft(m, 'g1'), 'g1', 3), false, 'rejoined: forgotten')
})

test('leaving twice keeps the later epoch; the map is capped oldest-first', () => {
  let m = markLeft(markLeft({}, 'g1', 5), 'g1', 2)
  assert.equal(m.g1, 5)
  m = {}
  for (let i = 0; i < LEFT_MAX + 3; i++) m = markLeft(m, 'g' + i, i)
  assert.equal(Object.keys(m).length, LEFT_MAX)
  assert.equal('g0' in m, false, 'the oldest departure made room')
  assert.equal('g' + (LEFT_MAX + 2) in m, true)
})

test('what comes back from storage is checked for shape', () => {
  assert.equal(isLeftMap({ a: 1 }), true)
  assert.equal(isLeftMap({}), true)
  assert.equal(isLeftMap([]), false)
  assert.equal(isLeftMap({ a: -1 }), false)
  assert.equal(isLeftMap({ a: 'x' }), false)
  assert.equal(isLeftMap(null), false)
})
