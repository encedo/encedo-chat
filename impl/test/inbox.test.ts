/**
 * The inbox watch (`lib/inbox.ts`) — listening on a topic anybody may publish to.
 *
 * The happy path is one knock arriving. Everything else in here is about the
 * topic being PUBLIC: junk, repeats, floods, and somebody else's cover traffic
 * all arrive on it, and none of them may reach the caller.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { watchInbox } from '../lib/inbox.ts'
import { sealKnock, decoyKnock, FRAME_LEN } from '../lib/knock.ts'
import { topicFromSecret, rotationOffsetSec } from '../lib/rendezvous.ts'
import { activeDatesForOffset } from '../lib/presence.ts'
import { generateX25519 } from '../lib/x25519.ts'

const P = { networkId: 'test', dateUTC: '2026-09-15' }
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** A pubsub anybody can publish to, which is the situation being modelled. */
function hub() {
  const listeners: Array<(evt: any) => void> = []
  const published: Array<{ topic: string; data: Uint8Array }> = []
  const subscribed = new Set<string>()
  return {
    published, subscribed,
    /** Somebody out there publishes onto a topic. */
    deliver(topic: string, data: Uint8Array) {
      for (const h of [...listeners]) h({ detail: { topic, data, from: { toString: () => 'them' } } })
    },
    node: {
      services: {
        pubsub: {
          addEventListener: (_e: string, h: (evt: any) => void) => listeners.push(h),
          removeEventListener: (_e: string, h: (evt: any) => void) => {
            const i = listeners.indexOf(h); if (i >= 0) listeners.splice(i, 1)
          },
          subscribe: (t: string) => subscribed.add(t),
          unsubscribe: (t: string) => subscribed.delete(t),
          publish: async (topic: string, data: Uint8Array) => { published.push({ topic, data }) },
        },
      },
    },
  }
}

const secret = (fill = 9) => new Uint8Array(32).fill(fill)
/** A clock the test drives, so nothing waits on wall time. */
const clock = (start = Date.UTC(2026, 8, 15, 12)) => { let t = start; return { now: () => t, add: (ms: number) => { t += ms } } }

/** The day the watch is really on, which the rotation offset decides - not P.dateUTC. */
async function currentDay(inbox: Uint8Array, at: number) {
  return activeDatesForOffset(at, (await rotationOffsetSec(inbox, P)) * 1000)[0]
}

async function opened(inbox: Uint8Array) {
  const h = hub()
  const j = await generateX25519()
  const got: any[] = []
  const c = clock()
  const w = watchInbox(h.node, inbox, j, P, {
    now: c.now, tickMs: 5, decoyEveryMs: 1_000, onKnock: (k) => got.push(k),
  })
  await sleep(40)
  // The topic comes from what the watch actually subscribed to. Recomputing it
  // here would duplicate the derivation and, as the first version of this file
  // proved, get the DAY wrong while looking right.
  const topic = [...h.subscribed][0]
  return { h, j, got, w, c, topic }
}

test('a knock arrives, opened, with the day it came in on', async () => {
  const inbox = secret()
  const { h, j, got, w, c, topic } = await opened(inbox)
  const src = await generateX25519()
  h.deliver(topic, await sealKnock(inbox, j.pub, { ik: src.pub, name: 'Informator', note: 'mam materialy' }))
  await sleep(30)
  assert.equal(got.length, 1)
  assert.deepEqual([...got[0].ik], [...src.pub])
  assert.equal(got[0].name, 'Informator')
  // The day the watch is on, which the rotation offset decides - not P.dateUTC.
  assert.equal(got[0].dateUTC, await currentDay(inbox, c.now()))
  w.stop()
})

test('it subscribes to the topic the invite names, on the current day, and lets go on stop', async () => {
  const inbox = secret(3)
  const { h, w, c, topic } = await opened(inbox)
  assert.ok(topic, 'never subscribed to anything')
  const want = await topicFromSecret(inbox, { ...P, dateUTC: await currentDay(inbox, c.now()) })
  assert.equal(topic, want, 'subscribed to a topic this invite does not name')
  // And it is genuinely this secret's topic, not any secret's.
  const other = await topicFromSecret(secret(4), { ...P, dateUTC: await currentDay(secret(4), c.now()) })
  assert.notEqual(topic, other)
  w.stop()
  assert.ok(!h.subscribed.has(topic), 'still subscribed after stop')
})

test('junk on a public topic is dropped in silence', async () => {
  const inbox = secret()
  const { h, got, w, topic } = await opened(inbox)
  h.deliver(topic, new Uint8Array(0))
  h.deliver(topic, new Uint8Array(FRAME_LEN))                 // right size, opens to nothing
  h.deliver(topic, new Uint8Array(FRAME_LEN).fill(7))
  h.deliver(topic, new Uint8Array(12).fill(1))
  await sleep(30)
  assert.equal(got.length, 0)
  w.stop()
})

test('a knock for a DIFFERENT invite of the same Journalist does not surface', async () => {
  const mine = secret(1), theirs = secret(2)
  const { h, j, got, w, topic } = await opened(mine)
  const src = await generateX25519()
  // Sealed for another invite, delivered onto this one's topic.
  h.deliver(topic, await sealKnock(theirs, j.pub, { ik: src.pub, name: 'X', note: '' }))
  await sleep(30)
  assert.equal(got.length, 0)
  w.stop()
})

test('cover traffic never reaches the caller', async () => {
  const inbox = secret()
  const { h, j, got, w, topic } = await opened(inbox)
  for (let i = 0; i < 5; i++) h.deliver(topic, await decoyKnock(inbox, j.pub))
  await sleep(30)
  assert.equal(got.length, 0, 'a decoy was surfaced as a knock')
  w.stop()
})

test('the same frame twice is one knock', async () => {
  const inbox = secret()
  const { h, j, got, w, topic } = await opened(inbox)
  const src = await generateX25519()
  const frame = await sealKnock(inbox, j.pub, { ik: src.pub, name: 'Ala', note: '' })
  h.deliver(topic, frame)
  h.deliver(topic, frame)
  h.deliver(topic, frame)
  await sleep(30)
  assert.equal(got.length, 1)
  w.stop()
})

test('a flood is capped — attention is what an unwanted contact would take', async () => {
  const inbox = secret()
  const h = hub()
  const j = await generateX25519()
  const got: any[] = []
  const c = clock()
  const w = watchInbox(h.node, inbox, j, P, {
    now: c.now, tickMs: 5, decoyEveryMs: 1_000, maxPerMin: 3, onKnock: (k) => got.push(k),
  })
  await sleep(40)
  const topic = [...h.subscribed][0]
  for (let i = 0; i < 12; i++) {
    const src = await generateX25519()
    h.deliver(topic, await sealKnock(inbox, j.pub, { ik: src.pub, name: 'spam ' + i, note: '' }))
  }
  await sleep(60)
  assert.equal(got.length, 3, `cap not applied, got ${got.length}`)
  w.stop()
})

test('a decoy goes out on its own, and it is a real frame on the right topic', async () => {
  const inbox = secret(5)
  const h = hub()
  const j = await generateX25519()
  const c = clock()
  const w = watchInbox(h.node, inbox, j, P, {
    now: c.now, tickMs: 5, decoyEveryMs: 1_000, onKnock: () => {},
  })
  // Settle FIRST. `decoy()` awaits the watch's own setup chain, so after this
  // the subscription and the seed exist and the measurement below is about the
  // schedule rather than about how loaded the test runner is. Then start from
  // a clean count. Waiting a plausible number of milliseconds instead is what
  // made this file flaky under the full parallel suite.
  await w.decoy()
  const topic = [...h.subscribed][0]
  h.published.length = 0
  for (let i = 0; i < 20; i++) { c.add(200); await sleep(25) }
  const mine = h.published.filter((p) => p.topic === topic)
  assert.ok(mine.length >= 1, 'no cover traffic was published at all')
  assert.ok(mine.length <= 8, `far too much cover traffic: ${mine.length}`)
  for (const p of mine) assert.equal(p.data.length, FRAME_LEN, 'a decoy must be the size of a knock')
  w.stop()
})

test('the decoy schedule is deterministic for one identity, and differs per invite', async () => {
  // Two clients of the SAME identity must produce ONE stream, or the rate would
  // say how many devices are listening (§4.6). Two DIFFERENT invites must not
  // line up, or an adversary holding both could recognise one person.
  const j = await generateX25519()
  const run = async (inbox: Uint8Array) => {
    const h = hub(); const c = clock()
    const w = watchInbox(h.node, inbox, j, P, { now: c.now, tickMs: 5, decoyEveryMs: 1_000, onKnock: () => {} })
    await w.decoy()               // settle the setup chain, then measure the schedule
    h.published.length = 0
    const at: number[] = []
    for (let i = 0; i < 20; i++) {
      const before = h.published.length
      c.add(200); await sleep(25)
      if (h.published.length > before) at.push(c.now())
    }
    w.stop()
    return at
  }
  const a1 = await run(secret(1))
  const a2 = await run(secret(1))
  const b1 = await run(secret(2))
  assert.deepEqual(a1, a2, 'the same identity and invite produced two different schedules')
  assert.ok(a1.length > 0, 'the schedule produced nothing to compare')
  assert.notDeepEqual(a1, b1, 'two invites of one identity shared a schedule')
})

test('the schedule depends on the IDENTITY too, not only on the invite', async () => {
  // The mirror of the test above, and the one that proves the seed really is the
  // self-ECDH (§4.6): the same invite watched by two different Journalists must
  // not produce the same cover traffic. If the seed were the invite secret -
  // which is public - these would line up, and every holder of the link could
  // subtract the decoys and read off the real knocks.
  const inbox = secret(6)
  const run = async (j: Awaited<ReturnType<typeof generateX25519>>) => {
    const h = hub(); const c = clock()
    const w = watchInbox(h.node, inbox, j, P, { now: c.now, tickMs: 5, decoyEveryMs: 1_000, onKnock: () => {} })
    await w.decoy()               // settle the setup chain, then measure the schedule
    h.published.length = 0
    const at: number[] = []
    for (let i = 0; i < 20; i++) {
      const before = h.published.length
      c.add(200); await sleep(25)
      if (h.published.length > before) at.push(c.now())
    }
    w.stop()
    return at
  }
  const a = await run(await generateX25519())
  const b = await run(await generateX25519())
  assert.ok(a.length > 0, 'no cover traffic to compare')
  assert.notDeepEqual(a, b, 'two identities sharing an invite produced the same schedule')
})
