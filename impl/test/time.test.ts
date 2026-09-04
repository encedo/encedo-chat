/**
 * Which clock a timestamp is shown on — and which one the protocol computes on.
 *
 * These are two different answers and the file exists to keep them apart:
 * a bubble is stamped on the READER's clock, while the rendezvous day is UTC on
 * every machine or two peers derive different topics and never meet.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { localHHMM, utcHHMM, utcDateOf, addUTCDays } from '../lib/time.ts'

/** Run `fn` as if the machine stood in `tz`. Node reads TZ per call. */
function inTZ<T>(tz: string, fn: () => T): T {
  const had = process.env.TZ
  process.env.TZ = tz
  try { return fn() } finally { if (had === undefined) delete process.env.TZ; else process.env.TZ = had }
}

// 2026-07-15T22:40:00Z — chosen so the local day differs from the UTC day in
// both directions: it is already the 16th in Warsaw, still the 15th in UTC.
const TS = Date.parse('2026-07-15T22:40:00Z')

test('a bubble is stamped on the reader’s clock', () => {
  assert.equal(inTZ('UTC', () => localHHMM(TS)), '22:40')
  assert.equal(inTZ('Europe/Warsaw', () => localHHMM(TS)), '00:40') // CEST, +2
  assert.equal(inTZ('America/New_York', () => localHHMM(TS)), '18:40') // EDT, −4
  assert.equal(inTZ('Asia/Kolkata', () => localHHMM(TS)), '04:10') // +5:30 — not a whole hour
})

test('hours and minutes are always two digits', () => {
  const t = Date.parse('2026-01-05T09:07:00Z')
  assert.equal(inTZ('UTC', () => localHHMM(t)), '09:07')
  assert.equal(inTZ('UTC', () => localHHMM(Date.parse('2026-01-05T00:00:00Z'))), '00:00')
})

test('the UTC form is still there, and still UTC', () => {
  // The room-rotation countdown and the debug log print this one: it is ABOUT
  // UTC, so a timezone must not touch it.
  for (const tz of ['UTC', 'Europe/Warsaw', 'Pacific/Kiritimati']) {
    assert.equal(inTZ(tz, () => utcHHMM(TS)), '22:40', tz)
  }
})

test('the rendezvous day is UTC wherever the machine stands', () => {
  // The load-bearing one (§5.4): both members of a pair derive the topic from
  // this date. If it ever followed the local clock, two people in different
  // zones would sit in different rooms for hours a day and it would present as
  // a dead relay. Kiritimati is +14 and Niue 11 — a 25-hour spread.
  for (const tz of ['UTC', 'Europe/Warsaw', 'Pacific/Kiritimati', 'Pacific/Niue']) {
    assert.equal(inTZ(tz, () => utcDateOf(TS)), '2026-07-15', tz)
    assert.equal(inTZ(tz, () => addUTCDays(utcDateOf(TS), 1)), '2026-07-16', tz)
  }
})
