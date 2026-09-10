/**
 * Contact state (`lib/seen.ts`) - the record that would have caught the pair of
 * machines announcing at each other's ghosts for two days.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { contactState, seenLabel, noteSeen, noteAdded, COLD_AFTER_MS } from '../lib/seen.ts'

const NOW = Date.UTC(2026, 8, 10, 12, 0, 0)
const DAY = 86_400_000

test('a contact announcing right now is online, whatever the record says', () => {
  assert.equal(contactState(undefined, NOW, true), 'online')
  assert.equal(contactState({ a: NOW - 30 * DAY }, NOW, true), 'online')
})

test('freshly added and not heard from yet is NEW, not a problem', () => {
  assert.equal(contactState({ a: NOW - 60_000 }, NOW, false), 'new')
  assert.equal(contactState({ a: NOW - 2 * DAY }, NOW, false), 'new')
})

test('added days ago and never once heard from is COLD', () => {
  // The state the app had no word for: 48 hours of announcing into a topic
  // nobody was on. Either they have never switched on, or they are holding a
  // key that no longer matches - and the app must not pick between those.
  assert.equal(contactState({ a: NOW - COLD_AFTER_MS }, NOW, false), 'cold')
  assert.equal(contactState({ a: NOW - 30 * DAY }, NOW, false), 'cold')
})

test('heard from once is never cold again, however long the silence', () => {
  // Somebody on holiday for a month has a working key and no case to answer.
  // The date says how long it has been; the app does not editorialise.
  assert.equal(contactState({ a: NOW - 90 * DAY, s: NOW - 30 * DAY }, NOW, false), 'quiet')
})

test('a contact from before this record existed is not accused of anything', () => {
  // First run of a build that keeps this: contacts have no `a` and no `s`. A
  // working contact must not come up as "never answered" on the strength of the
  // app having only just started looking.
  assert.equal(contactState(undefined, NOW, false), 'new')
  assert.equal(contactState({}, NOW, false), 'new')
})

test('the label is the reader\'s own clock, in parts a translator can use', () => {
  const at = (h: number, m: number, dayOffset = 0) =>
    new Date(new Date(NOW).getFullYear(), new Date(NOW).getMonth(), new Date(NOW).getDate() + dayOffset, h, m).getTime()

  assert.deepEqual(seenLabel({ s: at(9, 5) }, NOW), { kind: 'today', hhmm: '09:05' })
  assert.deepEqual(seenLabel({ s: at(23, 40, -1) }, NOW), { kind: 'yesterday', hhmm: '23:40' })
  const older = seenLabel({ s: at(14, 32, -5) }, NOW)
  assert.equal(older.kind, 'date')
  assert.match(JSON.stringify(older), /"hhmm":"14:32"/)
  assert.deepEqual(seenLabel(undefined, NOW), { kind: 'never' })
  assert.deepEqual(seenLabel({ a: NOW }, NOW), { kind: 'never' }, 'being added is not being heard')
})

test('folding a sighting in keeps the later one and remembers the first', () => {
  const added = noteAdded(undefined, 1000)
  assert.deepEqual(added, { a: 1000 })
  const heard = noteSeen(added, 5000)
  assert.deepEqual(heard, { a: 1000, s: 5000 })
  // An out-of-order write (a late transition, a clock nudge) must not move the
  // record backwards.
  assert.deepEqual(noteSeen(heard, 2000), { a: 1000, s: 5000 })
  // Heard from a contact that was never formally added: it counts as both.
  assert.deepEqual(noteSeen(undefined, 7000), { a: 7000, s: 7000 })
})
