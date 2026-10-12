import { test } from 'node:test'
import assert from 'node:assert/strict'
import { offsetFromProbe, anchorClock, MAX_ANCHOR_MS } from '../lib/clock.ts'
import { nowMs, setClockOffset, clockOffsetMs } from '../lib/time.ts'
import { rendezvousDay } from '../lib/presence.ts'

test('the offset is the node clock minus the midpoint of the round trip, in the middle of the Date second', () => {
  const sentAt = 1_700_000_000_000, receivedAt = sentAt + 200
  const node = new Date(sentAt + 4 * 60_000).toUTCString() // the node says four minutes later
  const off = offsetFromProbe({ dateHeader: node, sentAt, receivedAt })!
  // Date.toUTCString drops the ms (sentAt lands on a whole second here), then +500 for the midpoint, minus rtt/2.
  assert.equal(off, 4 * 60_000 + 500 - 100)
})

test('nothing usable: no header, garbage, or a round trip too long to place', () => {
  assert.equal(offsetFromProbe({ dateHeader: null, sentAt: 0, receivedAt: 10 }), null)
  assert.equal(offsetFromProbe({ dateHeader: 'yesterday-ish', sentAt: 0, receivedAt: 10 }), null)
  assert.equal(offsetFromProbe({ dateHeader: new Date(0).toUTCString(), sentAt: 0, receivedAt: 9_000 }), null)
})

test('the offset is a soft hint: clamped to ten minutes either way', () => {
  const sentAt = 1_700_000_000_000
  const far = new Date(sentAt + 5 * 3_600_000).toUTCString()
  assert.equal(offsetFromProbe({ dateHeader: far, sentAt, receivedAt: sentAt + 10 }), MAX_ANCHOR_MS)
  const back = new Date(sentAt - 5 * 3_600_000).toUTCString()
  assert.equal(offsetFromProbe({ dateHeader: back, sentAt, receivedAt: sentAt + 10 }), -MAX_ANCHOR_MS)
})

test('two clients four minutes apart derive the same rendezvous day once both are anchored', () => {
  // A pair whose rotation instant falls at 00:02:00 on the shifted clock: one
  // client's device is 4 min behind the truth, the other's is right. Without an
  // anchor the slow one is still on yesterday when the fast one has moved.
  const offsetSec = 0
  const truth = Date.UTC(2026, 9, 12, 0, 1, 0) // 00:01 UTC: one minute into the new day
  const slowLocal = truth - 4 * 60_000
  assert.notEqual(rendezvousDay(slowLocal, offsetSec * 1000), rendezvousDay(truth, offsetSec * 1000), 'unanchored, the two disagree')
  const off = offsetFromProbe({ dateHeader: new Date(truth).toUTCString(), sentAt: slowLocal, receivedAt: slowLocal + 100 })!
  assert.equal(rendezvousDay(slowLocal + off, offsetSec * 1000), rendezvousDay(truth, offsetSec * 1000), 'anchored, they agree')
})

test('anchorClock sets nowMs() from the first node that answers with a Date, and leaves it alone otherwise', async () => {
  const before = clockOffsetMs()
  try {
    const node = Date.now() + 3 * 60_000
    const fakeFetch = (async (url: string) => {
      if (String(url).includes('dead')) throw new Error('ECONNREFUSED')
      if (String(url).includes('mute')) return new Response('ok', { status: 200 }) // no Date: an old node without CORS exposure
      return new Response('ok', { status: 200, headers: { date: new Date(node).toUTCString() } })
    }) as unknown as typeof fetch
    const r = await anchorClock(['dead.example', 'mute.example', 'bs9.example'], { fetch: fakeFetch })
    assert.equal(r?.host, 'bs9.example')
    assert.ok(Math.abs(nowMs() - Date.now() - 3 * 60_000) < 1_500, 'the protocol clock now runs three minutes ahead of the device')
    const r2 = await anchorClock(['dead.example'], { fetch: fakeFetch })
    assert.equal(r2, null)
    assert.ok(Math.abs(clockOffsetMs() - 3 * 60_000) < 1_500, 'a failed probe does not reset the anchor')
  } finally { setClockOffset(before) }
})
