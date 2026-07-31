/**
 * Topic rotation across UTC days (`lib/presence.ts` `activeDatesFor` +
 * `watchPresenceRotating`). The pair topic changes every UTC midnight; around
 * the boundary both days are live (the overlap) so a pair crossing midnight at
 * slightly different instants still meets, and the cutover is jittered per
 * client so the whole network does not rotate at 00:00:00 UTC at once.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { activeDatesFor, watchPresenceRotating } from '../lib/presence.ts'
import { announceMacKey } from '../lib/rendezvous.ts'
import { buildAnnounce } from '../lib/announce.ts'
import { T_MSG1 } from '../eh2/wire.ts'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const DAY = 86_400_000
const at = (iso: string) => Date.parse(iso) // ms for a UTC instant

/** In-memory pubsub shared by both ends; delivery is filtered by topic in the
 *  watch handler, so publishing on one day's topic reaches only that watch. */
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
/** One topic per day, so the day a frame lands on is legible in the routing. */
const deriveFor = (mac: CryptoKey) => async (dateUTC: string) => ({ topic: `pair-${dateUTC}`, macKey: mac })

test('far from midnight only today is live', () => {
  const days = activeDatesFor(at('2026-07-31T12:00:00Z'), 'peer-a')
  assert.deepEqual(days, ['2026-07-31'])
})

test('just before UTC midnight, tomorrow is live too (overlap)', () => {
  const days = activeDatesFor(at('2026-07-31T23:50:00Z'), 'peer-a')
  assert.ok(days.includes('2026-07-31') && days.includes('2026-08-01'), `got ${days}`)
  assert.equal(days[0], '2026-07-31', 'today stays primary')
})

test('just after UTC midnight, yesterday is still live', () => {
  const days = activeDatesFor(at('2026-08-01T00:05:00Z'), 'peer-a')
  assert.ok(days.includes('2026-08-01') && days.includes('2026-07-31'), `got ${days}`)
  assert.equal(days[0], '2026-08-01', 'the new day is primary')
})

test('the jitter shifts the window per client', () => {
  // A time inside SOME clients' overlap but not others': find one by scanning
  // the jitter-band edge. With W=1min,J=59min the edge is 1..60min before
  // midnight and differs per id, so at 40min before midnight some ids overlap
  // and some do not — the whole point (no synchronized 00:00 rotation).
  const t = at('2026-07-31T23:20:00Z') // 40 min before midnight
  const cfg = { overlapMs: 60_000, jitterMs: 59 * 60_000 }
  const ids = Array.from({ length: 40 }, (_, i) => `peer-${i}`)
  const overlapping = ids.filter((id) => activeDatesFor(t, id, cfg).length > 1)
  assert.ok(overlapping.length > 0 && overlapping.length < ids.length,
    `expected a mix, got ${overlapping.length}/${ids.length} overlapping`)
})

test('normally one day is watched; a contact there lights online', async () => {
  const net = hub(); const mac = await macKey()
  let online = false
  const me = watchPresenceRotating(net.node('me'), 'me', deriveFor(mac), {
    now: () => at('2026-07-31T12:00:00Z'), heartbeatMs: 1000, tickMs: 10_000,
    onOnline: () => { online = true }, onOffline: () => { online = false }, onIncomingHandshake: () => {},
  })
  await sleep(30) // let the initial reconcile derive + subscribe today's topic
  await net.node('contact').services.pubsub.publish('pair-2026-07-31', await buildAnnounce('contact', mac))
  await sleep(30)
  assert.equal(online, true, 'contact on today lit the dot')
  me.stop()
})

test('in the overlap, a contact on TOMORROW lights online (both days watched)', async () => {
  const net = hub(); const mac = await macKey()
  let online = false
  const me = watchPresenceRotating(net.node('me'), 'me', deriveFor(mac), {
    now: () => at('2026-07-31T23:50:00Z'), heartbeatMs: 1000, tickMs: 10_000,
    onOnline: () => { online = true }, onOffline: () => { online = false }, onIncomingHandshake: () => {},
  })
  await sleep(40) // two reconciles worth: today + tomorrow
  await net.node('contact').services.pubsub.publish('pair-2026-08-01', await buildAnnounce('contact', mac))
  await sleep(30)
  assert.equal(online, true, 'a contact announcing on tomorrow, during the overlap, is seen')
  me.stop()
})

test('an incoming handshake is surfaced with the day it arrived on', async () => {
  const net = hub(); const mac = await macKey()
  let gotDate = ''
  const me = watchPresenceRotating(net.node('me'), 'me', deriveFor(mac), {
    now: () => at('2026-07-31T23:50:00Z'), heartbeatMs: 1000, tickMs: 10_000,
    onOnline: () => {}, onOffline: () => {},
    onIncomingHandshake: (_f, _from, dateUTC) => { gotDate = dateUTC },
  })
  await sleep(40)
  const msg1 = new Uint8Array([T_MSG1, 0x01, 0xaa, 0xbb, 0xcc])
  await net.node('contact').services.pubsub.publish('pair-2026-08-01', msg1)
  await sleep(30)
  assert.equal(gotDate, '2026-08-01', 'upgrade is pinned to the topic the handshake used')
  me.stop()
})

test('addUTCDays round-trips a leap boundary', () => {
  // sanity that the day math is UTC and does not drift with the host TZ
  assert.equal(activeDatesFor(at('2026-02-28T23:59:00Z'), 'zzz', { overlapMs: 5 * 60_000, jitterMs: 0 })
    .includes('2026-03-01'), true)
  void DAY
})
