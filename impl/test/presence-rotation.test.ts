/**
 * Topic rotation across UTC days (`lib/presence.ts` `activeDatesForOffset` /
 * `rendezvousDay` + `lib/rendezvous.ts` `rotationOffsetSec`). Each pair rotates
 * its topic at its OWN instant `midnight + offset` (offset derived from the pair
 * secret, §5.4), so the user base spreads across 24 h instead of spiking at
 * midnight; around that instant both days are live (the overlap) so the two
 * members cross on a shared topic. The mechanism is "shift the clock back by the
 * offset, then apply plain 00:00 rollover".
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { activeDatesForOffset, rendezvousDay, nextRotationAfter, watchPresenceRotating } from '../lib/presence.ts'
import { rotationOffsetSec, announceMacKey } from '../lib/rendezvous.ts'
import { buildAnnounce } from '../lib/announce.ts'
import { T_MSG1 } from '../eh2/wire.ts'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const HOUR = 3_600_000
const at = (iso: string) => Date.parse(iso) // ms for a UTC instant

// ---- pure schedule ---------------------------------------------------------

test('offset 0 is the plain 00:00 rollover', () => {
  assert.deepEqual(activeDatesForOffset(at('2026-07-31T12:00:00Z'), 0), ['2026-07-31'])
  const before = activeDatesForOffset(at('2026-07-31T23:50:00Z'), 0)
  assert.ok(before.includes('2026-07-31') && before.includes('2026-08-01'), `got ${before}`)
  const after = activeDatesForOffset(at('2026-08-01T00:05:00Z'), 0)
  assert.ok(after.includes('2026-08-01') && after.includes('2026-07-31'), `got ${after}`)
})

test('the offset moves the rotation instant off midnight', () => {
  // A pair whose offset is 06:00 rotates at 06:00, not 00:00.
  const t = at('2026-07-31T06:00:00Z')
  assert.equal(activeDatesForOffset(t, 0).length, 1, 'offset 0: midday-ish, no overlap')
  assert.equal(activeDatesForOffset(t, 6 * HOUR).length, 2, 'offset 6h: this IS its rollover → overlap')
})

test('rendezvousDay lags by the offset', () => {
  // 1h offset → the pair rolls to the new day at 01:00, not 00:00.
  assert.equal(rendezvousDay(at('2026-07-31T00:30:00Z'), HOUR), '2026-07-30', 'before 01:00 it is still yesterday')
  assert.equal(rendezvousDay(at('2026-07-31T01:30:00Z'), HOUR), '2026-07-31', 'after 01:00 it is today')
  assert.equal(rendezvousDay(at('2026-07-31T12:00:00Z'), 0), '2026-07-31', 'offset 0 is the calendar date')
})

test('different offsets put different pairs in overlap at the same instant (spread)', () => {
  const t = at('2026-07-31T04:00:00Z')
  // offset 4h → rolling now (overlap); offset 12h → nowhere near its instant.
  assert.equal(activeDatesForOffset(t, 4 * HOUR).length, 2)
  assert.equal(activeDatesForOffset(t, 12 * HOUR).length, 1)
})

// ---- the offset derivation -------------------------------------------------

test('rotationOffsetSec is in range, deterministic, and spreads by pair', async () => {
  const P = { networkId: 'main', dateUTC: '2026-07-31' }
  const a = await rotationOffsetSec(new Uint8Array(32).fill(0x11), P)
  const a2 = await rotationOffsetSec(new Uint8Array(32).fill(0x11), P)
  const b = await rotationOffsetSec(new Uint8Array(32).fill(0x22), P)
  assert.ok(a >= 0 && a < 86400, `in-range: ${a}`)
  assert.equal(a, a2, 'deterministic for the same pair secret')
  assert.notEqual(a, b, 'a different pair secret gives a different instant')
})

test('rotationOffsetSec ignores the date but not the network', async () => {
  const ss = new Uint8Array(32).fill(0x55)
  const d1 = await rotationOffsetSec(ss, { networkId: 'main', dateUTC: '2026-07-31' })
  const d2 = await rotationOffsetSec(ss, { networkId: 'main', dateUTC: '2027-01-01' })
  const n2 = await rotationOffsetSec(ss, { networkId: 'other', dateUTC: '2026-07-31' })
  assert.equal(d1, d2, 'date-independent → stable per pair, cacheable')
  assert.notEqual(d1, n2, 'network-scoped like the topic')
})

// ---- composed watch over a mock hub ---------------------------------------

function hub() {
  const nodes = new Map<string, (topic: string, data: Uint8Array, from: string) => void>()
  return {
    node(id: string) {
      const listeners: Array<(evt: any) => void> = []
      nodes.set(id, (topic, data, from) => {
        for (const h of [...listeners]) h({ detail: { topic, data, from: { toString: () => from } } })
      })
      return {
        peerId: { toString: () => id },
        services: {
          pubsub: {
            addEventListener: (_e: string, h: (evt: any) => void) => listeners.push(h),
            removeEventListener: (_e: string, h: (evt: any) => void) => {
              const i = listeners.indexOf(h); if (i >= 0) listeners.splice(i, 1)
            },
            subscribe: () => {}, unsubscribe: () => {},
            publish: async (topic: string, data: Uint8Array) => {
              for (const [peer, deliver] of nodes) if (peer !== id) deliver(topic, data, id)
            },
          },
        },
      }
    },
  }
}
async function macKey() { return announceMacKey(new Uint8Array(32).fill(0x33), { networkId: 'test', dateUTC: 'x' }) }
const deriveFor = (mac: CryptoKey) => async (dateUTC: string) => ({ topic: `pair-${dateUTC}`, macKey: mac })

test('normally one day is watched; a contact there lights online', async () => {
  const net = hub(); const mac = await macKey()
  let online = false
  const me = watchPresenceRotating(net.node('me'), 'me', deriveFor(mac), {
    now: () => at('2026-07-31T12:00:00Z'), offsetMs: 0, heartbeatMs: 1000, tickMs: 10_000,
    onOnline: () => { online = true }, onOffline: () => { online = false }, onIncomingHandshake: () => {},
  })
  await sleep(30)
  await net.node('contact').services.pubsub.publish('pair-2026-07-31', await buildAnnounce('contact', mac))
  await sleep(30)
  assert.equal(online, true)
  me.stop()
})

test('in the offset overlap, a contact on the adjacent day lights online', async () => {
  const net = hub(); const mac = await macKey()
  let online = false
  // offset 12h → this pair rotates at 12:00; at 11:55 it is in the overlap and
  // watches BOTH rendezvous days: shifted clock = 2026-07-30T23:55, so the days
  // are 2026-07-30 and (5 min ahead) 2026-07-31.
  const me = watchPresenceRotating(net.node('me'), 'me', deriveFor(mac), {
    now: () => at('2026-07-31T11:55:00Z'), offsetMs: 12 * HOUR, heartbeatMs: 1000, tickMs: 10_000,
    onOnline: () => { online = true }, onOffline: () => { online = false }, onIncomingHandshake: () => {},
  })
  await sleep(40)
  await net.node('contact').services.pubsub.publish('pair-2026-07-31', await buildAnnounce('contact', mac))
  await sleep(30)
  assert.equal(online, true, 'the adjacent-day topic during the offset overlap is watched')
  me.stop()
})

test('an incoming handshake is surfaced with the day it arrived on', async () => {
  const net = hub(); const mac = await macKey()
  let gotDate = ''
  const me = watchPresenceRotating(net.node('me'), 'me', deriveFor(mac), {
    now: () => at('2026-07-31T11:55:00Z'), offsetMs: 12 * HOUR, heartbeatMs: 1000, tickMs: 10_000,
    onOnline: () => {}, onOffline: () => {},
    onIncomingHandshake: (_f, _from, dateUTC) => { gotDate = dateUTC },
  })
  await sleep(40)
  const msg1 = new Uint8Array([T_MSG1, 0x01, 0xaa, 0xbb, 0xcc])
  await net.node('contact').services.pubsub.publish('pair-2026-07-31', msg1)
  await sleep(30)
  assert.equal(gotDate, '2026-07-31', 'upgrade is pinned to the topic the handshake used')
  me.stop()
})

// nextRotationAfter: the per-pair countdown instant used by the UI badge. The
// topic rotates at `midnight + offset`; this is where rendezvousDay increments.
test('nextRotationAfter: offset 0 → the next plain 00:00 UTC boundary', () => {
  const now = Date.UTC(2026, 7, 3, 12, 0, 0) // 2026-08-03 12:00 UTC
  assert.equal(nextRotationAfter(now, 0), Date.UTC(2026, 7, 4, 0, 0, 0))
})

test('nextRotationAfter: an offset earlier in the day → rotation is TOMORROW at midnight+offset', () => {
  const now = Date.UTC(2026, 7, 3, 12, 0, 0)
  // pair rotates at 06:00 UTC; 12:00 is past it, so next is tomorrow 06:00
  assert.equal(nextRotationAfter(now, 6 * 3600 * 1000), Date.UTC(2026, 7, 4, 6, 0, 0))
})

test('nextRotationAfter: an offset later in the day → rotation is still TODAY', () => {
  const now = Date.UTC(2026, 7, 3, 12, 0, 0)
  // pair rotates at 18:00 UTC; 12:00 is before it, so next is today 18:00
  assert.equal(nextRotationAfter(now, 18 * 3600 * 1000), Date.UTC(2026, 7, 3, 18, 0, 0))
})

test('nextRotationAfter: strictly after now, and it is exactly where rendezvousDay flips', () => {
  const now = Date.UTC(2026, 7, 3, 9, 17, 42)
  for (const offH of [0, 6, 13, 23]) {
    const off = offH * 3600 * 1000
    const next = nextRotationAfter(now, off)
    assert.ok(next > now, `offset ${offH}h: next must be after now`)
    // the day is the same 1 ms before the instant and different at/after it
    assert.notEqual(rendezvousDay(next, off), rendezvousDay(next - 1, off),
      `offset ${offH}h: the rendezvous day must change exactly at the rotation instant`)
  }
})

test('nextRotationAfter: two different offsets give different instants (spread, not a spike)', () => {
  const now = Date.UTC(2026, 7, 3, 12, 0, 0)
  assert.notEqual(nextRotationAfter(now, 3 * 3600 * 1000), nextRotationAfter(now, 15 * 3600 * 1000))
})
