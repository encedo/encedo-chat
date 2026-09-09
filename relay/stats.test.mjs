/**
 * The relay's counters (`stats.mjs`).
 *
 * All the arithmetic is here so that none of it has to be discovered on a
 * production node fifteen minutes at a time. The clock and the CPU reading are
 * injected; nothing in this file waits for anything.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { newCounters, formatLine, human, upFor } from './stats.mjs'

/** A clock and a CPU meter that only move when told to. */
function rig(startMs = 1_757_000_000_000) {
  let t = startMs
  let user = 0, system = 0
  return {
    advance(ms, cpuMs = 0) { t += ms; user += cpuMs * 1000 },
    counters: newCounters(() => t, () => ({ user, system })),
  }
}

test('a window counts what happened in it, and only that', () => {
  const r = rig()
  r.counters.msg('12D3a', 176)
  r.counters.msg('12D3b', 900)
  r.counters.msg('12D3a', 176) // the same publisher twice is one publisher
  r.counters.topic('add'); r.counters.topic('add'); r.counters.topic('evict')
  r.counters.conn(1); r.counters.conn(1); r.counters.conn(-1)
  r.advance(900_000)
  const s = r.counters.roll({ topics: 213, conns: 131 })

  assert.equal(s.msgs, 3)
  assert.equal(s.bytes, 1252)
  assert.equal(s.max_bytes, 900)
  assert.equal(s.publishers, 2, 'publishers is DISTINCT peers, not messages')
  assert.equal(s.topics_added, 2)
  assert.equal(s.topics_evicted, 1)
  assert.equal(s.conns_up, 2)
  assert.equal(s.conns_down, 1)
  assert.equal(s.topics, 213, 'a gauge is read at the moment the window closes')
  assert.equal(s.window_s, 900)
})

test('the next window starts empty', () => {
  // The failure this guards is the one that makes a counter useless: totals
  // that only grow say nothing about the last fifteen minutes.
  const r = rig()
  r.counters.msg('12D3a', 100)
  r.advance(900_000)
  r.counters.roll({ topics: 1, conns: 1 })
  r.advance(900_000)
  const s = r.counters.roll({ topics: 1, conns: 1 })
  assert.equal(s.msgs, 0)
  assert.equal(s.bytes, 0)
  assert.equal(s.publishers, 0)
  assert.equal(s.max_bytes, 0)
})

test('who published is forgotten; how many did is kept', () => {
  // The ids are held only to count them. Nothing in the snapshot may carry one
  // - a relay that logs which clients were active over time has written a
  // record nobody asked it to keep.
  const r = rig()
  r.counters.msg('12D3KooWEwMT', 176)
  r.advance(60_000)
  const s = r.counters.roll({ topics: 1, conns: 1 })
  assert.equal(s.publishers, 1)
  assert.equal(JSON.stringify(s).includes('12D3'), false, 'a peer id reached the snapshot')
})

test('CPU is the share of the window, not the life of the process', () => {
  const r = rig()
  r.advance(900_000, 45_000) // 45 s of CPU in a 900 s window = 5%
  const s = r.counters.roll({ topics: 0, conns: 0 })
  assert.equal(s.cpu_pct, 5)
  // A second, idle window must not inherit the first one's work.
  r.advance(900_000, 0)
  assert.equal(r.counters.roll({ topics: 0, conns: 0 }).cpu_pct, 0)
})

test('the worst loop stall in the window is what gets reported', () => {
  // The average is the number that hides the problem: a node stalling for
  // 400 ms once a minute forwards nothing during those 400 ms, and an average
  // over 900 s calls it 7 ms.
  const r = rig()
  r.counters.lag(12); r.counters.lag(430); r.counters.lag(8)
  r.advance(900_000)
  assert.equal(r.counters.roll({ topics: 0, conns: 0 }).lag_ms, 430)
})

test('refusals are shouted, because nothing else says a room failed', () => {
  // A client refused at the topic ceiling gets no error - it simply never sees
  // anyone in the room. In a screenful of these lines that has to catch an eye.
  const r = rig()
  r.counters.topic('refuse')
  r.advance(900_000)
  const line = formatLine(r.counters.roll({ topics: 250, conns: 400 }), 15)
  assert.match(line, /REFUSED=1/)
  const quiet = rig()
  quiet.advance(900_000)
  assert.equal(/REFUSED/.test(formatLine(quiet.counters.roll({ topics: 3, conns: 4 }), 15)), false,
    'a window with no refusals must not carry the word at all')
})

test('the line holds every figure an operator came for', () => {
  const r = rig()
  r.counters.msg('a', 1024)
  r.advance(900_000, 9_000)
  const line = formatLine(r.counters.roll({ topics: 213, conns: 131 }), 15)
  for (const bit of ['[stats 15m]', 'topics=213', 'msgs=1', 'bytes=1.0k', 'pubs=1', 'conns=131', 'cpu=1%', 'rss=', 'heap=', 'lag=', 'up=']) {
    assert.ok(line.includes(bit), `the line is missing ${bit}: ${line}`)
  }
})

test('sizes and uptimes are written for a person', () => {
  assert.equal(human(900), '900')
  assert.equal(human(1024), '1.0k')
  assert.equal(human(812 * 1024), '812k')
  assert.equal(human(3 * 1024 * 1024), '3.0M')
  assert.equal(upFor(120), '2m')
  assert.equal(upFor(3600 * 13), '13.0h')
  assert.equal(upFor(86_400 * 2), '2.0d')
})
