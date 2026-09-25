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

// ---- load-aware choice ------------------------------------------------------
import { loginChoice, rebalanceChoice, nodeKey, MOVE_GAP, HOT, COOL, HOT_FOR_MS, REBALANCE_P, LOAD_STALE_MS } from '../lib/nodepick.ts'

const NOW = 10_000_000
const L = (node: string, pct: number, age = 5_000) => [node, { node, pct, at: NOW - age }] as [string, any]
const loads = (...e: [string, any][]) => new Map(e)
const W = new Map<string, number>()

test('nodeKey names a relay the way it announces itself', () => {
  assert.equal(nodeKey('/dns4/bs3.onchato.com/tcp/443/wss/http-path/%2Frelay/p2p/12D3KooWLc'), 'bs3')
  assert.equal(nodeKey('/ip4/127.0.0.1/tcp/9001/ws/p2p/12D3'), '127')
})

test('login: a node lighter by the gap wins the second choice', () => {
  assert.equal(loginChoice('bs3', ['bs3', 'bs2'], loads(L('bs3', 70), L('bs2', 70 - MOVE_GAP)), W, 0.5, NOW), 'bs2')
})

test('login: not lighter enough, or heavier, and we stay', () => {
  assert.equal(loginChoice('bs3', ['bs3', 'bs2'], loads(L('bs3', 70), L('bs2', 70 - MOVE_GAP + 1)), W, 0.5, NOW), null)
  assert.equal(loginChoice('bs3', ['bs3', 'bs2'], loads(L('bs3', 10), L('bs2', 60)), W, 0.5, NOW), null)
})

test('login: no fresh reading on either side means no move', () => {
  assert.equal(loginChoice('bs3', ['bs3', 'bs2'], loads(L('bs3', 90), L('bs2', 0, LOAD_STALE_MS + 1)), W, 0.5, NOW), null, 'a stale 0 % is not an invitation')
  assert.equal(loginChoice('bs3', ['bs3', 'bs2'], loads(L('bs2', 0)), W, 0.5, NOW), null, 'our own node unknown')
  assert.equal(loginChoice('bs3', ['bs3'], loads(L('bs3', 99)), W, 0.5, NOW), null, 'nowhere else to go')
})

test('login: the second choice is drawn by weight, not always the lightest', () => {
  // bs1 is empty but weight 0 (failover only): it is never the second choice.
  const ls = loads(L('bs3', 90), L('bs2', 50), L('bs1', 0))
  const w = new Map([['bs1', 0], ['bs2', 1]])
  for (let i = 0; i < 100; i++) assert.equal(loginChoice('bs3', ['bs3', 'bs2', 'bs1'], ls, w, i / 100, NOW), 'bs2')
  // Unweighted, both others get drawn -- two choices, not "the least loaded".
  const seen = new Set()
  for (let i = 0; i < 100; i++) seen.add(loginChoice('bs3', ['bs3', 'bs2', 'bs1'], ls, W, i / 100, NOW))
  assert.deepEqual([...seen].sort(), ['bs1', 'bs2'])
})

test('rebalance: hot long enough, a cool node, and the dice say yes -- move there', () => {
  const ls = loads(L('bs3', HOT), L('bs2', COOL - 1), L('bs1', 20))
  assert.equal(rebalanceChoice('bs3', ['bs3', 'bs2', 'bs1'], ls, NOW - HOT_FOR_MS, 0, NOW), 'bs1', 'the coolest')
})

test('rebalance: every condition is needed', () => {
  const ls = loads(L('bs3', HOT), L('bs2', 20))
  const c = ['bs3', 'bs2']
  assert.equal(rebalanceChoice('bs3', c, loads(L('bs3', HOT - 1), L('bs2', 20)), NOW - HOT_FOR_MS, 0, NOW), null, 'not hot')
  assert.equal(rebalanceChoice('bs3', c, ls, NOW - HOT_FOR_MS + 1, 0, NOW), null, 'not hot for long enough')
  assert.equal(rebalanceChoice('bs3', c, ls, null, 0, NOW), null, 'no hot streak recorded')
  assert.equal(rebalanceChoice('bs3', c, ls, NOW - HOT_FOR_MS, REBALANCE_P, NOW), null, 'the dice said no')
  assert.equal(rebalanceChoice('bs3', c, loads(L('bs3', HOT), L('bs2', COOL)), NOW - HOT_FOR_MS, 0, NOW), null, 'nobody cool')
  assert.equal(rebalanceChoice('bs3', c, loads(L('bs3', HOT), L('bs2', 0, LOAD_STALE_MS + 1)), NOW - HOT_FOR_MS, 0, NOW), null, 'the cool one is stale')
})

test('rebalance: over many checks only about REBALANCE_P of a hot room moves', () => {
  const ls = loads(L('bs3', 95), L('bs2', 10))
  let moved = 0
  for (let i = 0; i < 1000; i++) if (rebalanceChoice('bs3', ['bs3', 'bs2'], ls, NOW - HOT_FOR_MS, i / 1000, NOW)) moved++
  assert.ok(Math.abs(moved - 1000 * REBALANCE_P) <= 1, `moved ${moved}`)
})
