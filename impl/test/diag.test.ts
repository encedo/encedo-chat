/**
 * The flight recorder (`lib/diag.ts`) - and the one property it must never
 * lose: it is a diary of the CONNECTION, never of the conversation.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { newDiag, isLifecycle, STALL_MS, secs } from '../lib/diag.ts'

const at = (ms: number) => () => ms

test('nothing anybody said can get into the file', () => {
  // The app logs sends as `sent "the first forty characters..."`. A diagnostic
  // file that outlived a transcript would be a worse bug than the one this was
  // written to find, so the admission test is an allowlist and a quoted string
  // is refused outright - including one that contains connection words.
  assert.equal(isLifecycle('sent "do zobaczenia jutro" (id 3f9a)'), false)
  assert.equal(isLifecycle('sent "the relay is down, call me" (id 77)'), false)
  assert.equal(isLifecycle('file evidence · {"cid":"bafy...","key":"..."}'), false)
  // ...and a line nobody planned for is dropped rather than guessed about.
  assert.equal(isLifecycle('something new nobody wrote a rule for'), false)
})

test('the connection lines are kept', () => {
  assert.ok(isLifecycle('lost the relay connection'))
  assert.ok(isLifecycle('re-dial failed (timeout) — again in 2000 ms'))
  assert.ok(isLifecycle('relay connection restored — announcing and flushing what is waiting'))
  assert.ok(isLifecycle('contact silent on 3f9a1c... -> offline'))
  assert.ok(isLifecycle('node list updated (3): bs1, bs2, bs3'))
})

test('a stall is written down the moment it happens', () => {
  // Five minutes later a summary would report the worst lateness and lose WHEN
  // it happened - and when is the whole question: a process that was away
  // between 03:11 and 03:19 explains a dot that was dark at 03:12.
  const d = newDiag({ now: at(1_757_000_000_000) })
  d.tick(1_200)
  assert.equal(d.take().length, 0, 'an on-time tick is not an event')
  d.tick(STALL_MS + 5_000)
  const out = d.take()
  assert.equal(out.length, 1)
  assert.match(out[0], /STALL the process was away for 50s/)
})

test('a summary closes the window and starts a new one', () => {
  const d = newDiag({ now: at(1_757_000_000_000) })
  d.tick(3_000); d.tick(9_000); d.tick(1_000)
  d.summary('link=online peers=1 topics=4')
  const first = d.take()[0]
  assert.match(first, /late=9s ticks=3 link=online peers=1 topics=4/)
  d.tick(2_000)
  d.summary('link=online peers=1 topics=4')
  assert.match(d.take()[0], /late=2s ticks=1/, 'the window did not reset')
})

test('every line carries a wall clock, not an uptime', () => {
  // An uptime is useless the morning after: the question is "what happened at
  // 03:14", and only a wall clock answers it.
  const d = newDiag({ now: at(Date.UTC(2026, 8, 9, 3, 14, 5)) })
  d.note('vis visible')
  assert.equal(d.take()[0], '2026-09-09 03:14:05 vis visible')
})

test('the ring keeps the newest and forgets the oldest', () => {
  const d = newDiag({ now: at(0), keep: 3 })
  for (const n of ['a', 'b', 'c', 'd']) d.note(n)
  assert.deepEqual(d.all().map((l) => l.slice(-1)), ['b', 'c', 'd'])
  // `take` is for the file and empties; `all` is for the copy button and does not.
  assert.equal(d.take().length, 4)
  assert.equal(d.all().length, 3)
})

test('seconds are rounded for a person, not a machine', () => {
  assert.equal(secs(0), '0s')
  assert.equal(secs(1_499), '1s')
  assert.equal(secs(61_000), '61s')
})
