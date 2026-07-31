/**
 * EH-2 stage 6 — the room seam (docs/PROTOCOL.md §6–7 meeting §5).
 *
 * Offline test over a mock pubsub: two rooms on one topic. What it pins is the
 * wiring, not the crypto (that is covered in eh2-*.test.ts): the handshake runs
 * by itself on discovery, content is sealed by the ratchet, and a message typed
 * before the handshake finishes still arrives.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { joinChat } from '../lib/room.ts'
import { announceMacKey } from '../lib/rendezvous.ts'
import { generateX25519 } from '../lib/x25519.ts'

const TOPIC = 'test-topic'
const P = { networkId: 'test', dateUTC: '2026-07-29' }

/**
 * Minimal in-memory GossipSub: publish reaches every other node on the topic.
 * `drop` can swallow chosen frames — the real relay does exactly that while the
 * mesh forms, and a handshake that cannot survive it stalls forever.
 */
function hub(
  drop?: (data: Uint8Array, from: string) => boolean,
  duplicate?: (data: Uint8Array) => boolean,
  /** Hold a frame back instead of dropping it — how a sleeping peer answers late. */
  delayMs?: (data: Uint8Array, from: string) => number,
) {
  const nodes = new Map<string, (topic: string, data: Uint8Array, from: string) => void>()
  return {
    node(id: string) {
      const listeners: Array<(evt: any) => void> = []
      nodes.set(id, (topic, data, from) => {
        for (const h of listeners) h({ detail: { topic, data, from: { toString: () => from } } })
      })
      return {
        peerId: { toString: () => id },
        services: {
          pubsub: {
            addEventListener: (_e: string, h: (evt: any) => void) => listeners.push(h),
            // Honour it. A no-op here left a stopped room still receiving, so a
            // "reloaded" peer went on handshaking as its own ghost — the mock
            // was kinder to a dead node than a real transport ever is.
            removeEventListener: (_e: string, h: (evt: any) => void) => {
              const i = listeners.indexOf(h)
              if (i >= 0) listeners.splice(i, 1)
            },
            subscribe: () => {},
            unsubscribe: () => {},
            publish: async (topic: string, data: Uint8Array) => {
              if (drop?.(data, id)) return
              const times = duplicate?.(data) ? 2 : 1
              const held = delayMs?.(data, id) ?? 0
              const fanOut = () => {
                for (let n = 0; n < times; n++) {
                  for (const [peer, deliver] of nodes) if (peer !== id) deliver(topic, data, id)
                }
              }
              if (held > 0) { const t = setTimeout(fanOut, held); (t as any).unref?.() } else fanOut()
            },
          },
        },
      }
    },
  }
}

const until = async (cond: () => boolean, ms = 5000) => {
  const t0 = Date.now()
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error('timed out waiting for the condition')
    await new Promise((r) => setTimeout(r, 10))
  }
}

/** Two rooms sharing a topic + Announce key, with EH-2 wired for both peers. */
async function rooms(opts: {
  collect: string[]
  drop?: (d: Uint8Array, from: string) => boolean
  backA?: string[]
  duplicate?: (d: Uint8Array) => boolean
  onDeliveredA?: (id: string, ms: number) => void
  onUndeliveredA?: (id: string) => void
  onLateDeliveredA?: (id: string, ms: number) => void
  onStallA?: () => void
  /** §7.3 bounded session lifetime — hours in production, milliseconds here. */
  sessionLifetimeMs?: number
  heartbeatMs?: number
  onMessageB?: (from: string, m: any, meta: { outOfOrder: boolean }) => void
  delayMs?: (d: Uint8Array, from: string) => number
  /**
   * A's re-send schedule. The production one runs for the better part of a
   * minute (deliberately — see room.ts), so tests state their own rather than
   * waiting it out. The default below is the schedule these tests were written
   * against, which keeps them pinning the retry *mechanism*, not the constants.
   */
  retry?: { retryMs?: number[]; giveUpMs?: number; maxInflightMs?: number }
}) {
  const net = hub(opts.drop, opts.duplicate, opts.delayMs)
  const ss = new Uint8Array(32).fill(0x5e)
  const macKey = await announceMacKey(ss, P)
  const [ikA, ikB] = [await generateX25519(), await generateX25519()]
  // ids chosen so 'peer-a' < 'peer-b' → A is the initiator
  const nodeA = net.node('peer-a')
  const nodeB = net.node('peer-b')
  const states: string[] = []
  const eh2 = (ik: any, peerPub: Uint8Array) => ({
    ik, peerIkPub: peerPub, attemptTimeoutMs: 300,
    sessionLifetimeMs: opts.sessionLifetimeMs,
    onState: (p: string, s: string) => states.push(`${p}:${s}`),
  })

  const retry = opts.retry ?? { retryMs: [1_500, 4_000], giveUpMs: 4_000 }
  const replaced: string[] = []
  const A = joinChat(nodeA, TOPIC, { macKey, eh2: eh2(ikA, ikB.pub) }, {
    firstAnnounceMs: 5,
    heartbeatMs: opts.heartbeatMs,
    onMessage: (_from, m) => opts.backA?.push(m.body),
    onDelivered: opts.onDeliveredA,
    onUndelivered: opts.onUndeliveredA,
    onLateDelivered: opts.onLateDeliveredA,
    onStall: opts.onStallA,
    onPeerReplaced: (old, now) => replaced.push(`${old}→${now}`),
    ...retry,
  })
  const B = joinChat(nodeB, TOPIC, { macKey, eh2: eh2(ikB, ikA.pub) }, {
    firstAnnounceMs: 5,
    heartbeatMs: opts.heartbeatMs,
    onMessage: (from, m, meta) => { opts.collect.push(m.body); opts.onMessageB?.(from, m, meta) },
  })
  /** A second window for B's identity — same keys, new PeerId (a page reload). */
  const rejoinB = (id: string, collect: string[], logs?: string[]) =>
    joinChat(net.node(id), TOPIC, { macKey, eh2: eh2(ikB, ikA.pub) }, {
      firstAnnounceMs: 5,
      onMessage: (_from, m) => collect.push(m.body),
      onLog: logs ? (m) => logs.push(m) : undefined,
    })
  return { A, B, states, rejoinB, replaced }
}

test('the handshake runs on discovery and content rides the ratchet', async (t) => {
  const got: string[] = []
  const { A, B, states } = await rooms({ collect: got })
  t.after(() => { A.stop(); B.stop() })

  await until(() => A.secured().includes('peer-b') && B.secured().includes('peer-a'))
  assert.ok(states.some((s) => s === 'peer-b:established' || s === 'peer-a:established'))

  A.sendText('po ratchecie')
  await until(() => got.length === 1)
  assert.deepEqual(got, ['po ratchecie'])

  A.sendText('i druga')
  await until(() => got.length === 2)
  assert.deepEqual(got, ['po ratchecie', 'i druga'])
})

test('content typed before the handshake completes is queued, not lost', async (t) => {
  const got: string[] = []
  const { A, B } = await rooms({ collect: got })
  t.after(() => { A.stop(); B.stop() })
  A.sendText('wysłane zanim uzgodniliśmy klucz') // no session yet → queued
  assert.deepEqual(A.secured(), [])

  await until(() => got.length === 1, 8000)
  assert.deepEqual(got, ['wysłane zanim uzgodniliśmy klucz'])
})

test('a lost msg1 is retried until the handshake gets through', async (t) => {
  const got: string[] = []
  let swallowed = 0
  const { A, B } = await rooms({
    collect: got,
    drop: (d) => d[0] === 0x01 && ++swallowed <= 2, // eat the first two msg1s
  })
  t.after(() => { A.stop(); B.stop() })
  await until(() => A.secured().length === 1 && B.secured().length === 1, 8000)
  assert.ok(swallowed >= 2, 'the drop actually fired')
  A.sendText('mimo zgubionych ramek')
  await until(() => got.length === 1)
})

test('a lost msg3 leaves the responder stuck — and it recovers on its own', async (t) => {
  // The nastiest case: the initiator completes and shows "established" while
  // the responder has nothing, so only the responder (the HIGHER id, which
  // normally never initiates) knows something is wrong.
  const got: string[] = []
  const back: string[] = []
  let seen = 0, dropped = 0
  const { A, B } = await rooms({
    collect: got, backA: back,
    drop: (d) => { // eat the FIRST msg3 only
      if (d[0] !== 0x03 || ++seen > 1) return false
      dropped++
      return true
    },
  })
  t.after(() => { A.stop(); B.stop() })

  await until(() => A.secured().length === 1 && B.secured().length === 1, 8000)
  assert.equal(dropped, 1, 'exactly the first msg3 was swallowed')
  A.sendText('od A po odzyskaniu')
  B.sendText('od B po odzyskaniu')
  await until(() => got.length === 1 && back.length === 1, 5000)
  assert.deepEqual(got, ['od A po odzyskaniu'])
  assert.deepEqual(back, ['od B po odzyskaniu'])
})

test('a peer that reloads re-handshakes and the conversation continues', async (t) => {
  const got: string[] = []
  const { A, B, rejoinB } = await rooms({ collect: got })
  await until(() => A.secured().length === 1 && B.secured().length === 1, 8000)
  A.sendText('przed reloadem')
  await until(() => got.length === 1)

  // B reloads: same identity key, fresh room state and a new ephemeral PeerId
  // ('peer-c' > 'peer-a', so A initiates again).
  B.stop()
  const got2: string[] = []
  const B2 = rejoinB('peer-c', got2)
  t.after(() => { A.stop(); B2.stop() })

  await until(() => A.secured().includes('peer-c') && B2.secured().includes('peer-a'), 8000)
  A.sendText('po reloadzie')
  await until(() => got2.length === 1)
  assert.deepEqual(got2, ['po reloadzie'])
})

test('the PeerId a reloaded peer left behind is retired, not kept alive', async (t) => {
  // The bug this pins cost a live session its direct channel: A kept the
  // pre-reload session, so every frame went out twice — once under a ratchet B
  // could no longer open (B logged it as an undecodable frame) — and anything
  // keyed by the old PeerId, the WebRTC plane above all, kept addressing a peer
  // that no longer existed.
  const got: string[] = []
  // Short heartbeat: retirement waits for the old PeerId to MISS one, which is
  // the only thing that tells a reload apart from a second window (see the test
  // below). In production that is ~22 s; here it is under a second.
  const { A, B, rejoinB, replaced } = await rooms({ collect: got, heartbeatMs: 300 })
  await until(() => A.secured().length === 1 && B.secured().length === 1, 8000)

  B.stop()
  const got2: string[] = []
  const logs: string[] = []
  const B2 = rejoinB('peer-c', got2, logs)
  t.after(() => { A.stop(); B2.stop() })

  await until(() => A.secured().includes('peer-c'), 8000)
  await until(() => A.secured().length === 1, 8000)
  assert.deepEqual(A.secured(), ['peer-c'], 'the old PeerId must not keep a session')
  assert.deepEqual(replaced, ['peer-b→peer-c'], 'the data plane has to be told the peer moved')

  A.sendText('po reloadzie')
  await until(() => got2.length === 1)
  assert.deepEqual(logs.filter((l) => l.includes('undecodable')), [], 'no second copy under a dead ratchet')
})

test('a repeated msg1 is answered, not restarted (no established/handshaking loop)', async (t) => {
  // The initiator re-sends msg1 while it waits. If that restarted the responder,
  // the initiator's msg3 would arrive against a transcript the responder had
  // already thrown away — mac_i fails, both sides retry, and the badge flips
  // between green and orange forever. Seen live; this pins the fix.
  const got: string[] = []
  const { A, B, states } = await rooms({ collect: got, duplicate: (d) => d[0] === 0x01 })
  t.after(() => { A.stop(); B.stop() })

  await until(() => A.secured().length === 1 && B.secured().length === 1, 8000)
  await new Promise((r) => setTimeout(r, 1500)) // let any loop show itself
  assert.equal(states.filter((s) => s.endsWith(':failed')).length, 0, `no failures: ${states.join(' ')}`)
  assert.equal(states.filter((s) => s.endsWith(':established')).length, 2, `one establish per side: ${states.join(' ')}`)
  assert.ok(A.secured().length === 1 && B.secured().length === 1, 'both still hold a session')

  A.sendText('po duplikacie')
  await until(() => got.length === 1)
})

test('a lost message is re-sent until the peer confirms it', async (t) => {
  const got: string[] = []
  const delivered: Array<[string, number]> = []
  const undelivered: string[] = []
  let contentSeen = 0
  const { A, B } = await rooms({
    collect: got,
    // swallow the first two content frames (0x10 = ratchet data) after the
    // handshake — i.e. the message and its first retry
    drop: (d) => d[0] === 0x10 && ++contentSeen <= 2,
    onDeliveredA: (id, ms) => delivered.push([id, ms]),
    onUndeliveredA: (id) => undelivered.push(id),
  })
  t.after(() => { A.stop(); B.stop() })
  await until(() => A.secured().length === 1 && B.secured().length === 1, 8000)

  const id = A.sendText('musi dojść mimo strat')
  await until(() => got.length === 1, 10_000)
  assert.deepEqual(got, ['musi dojść mimo strat'], 'exactly one copy reached the UI (duplicates deduped)')
  await until(() => delivered.length === 1, 5000)
  assert.equal(delivered[0][0], id, 'the confirmation carries the message id')
  assert.equal(undelivered.length, 0)
})

test('a frame the relay drops does not cost the direct path its turn', async (t) => {
  // The stall signal exists to abandon a DIRECT channel that looks open and
  // silently eats content. GossipSub dropping a frame is ordinary — that is
  // what the retry is for — and must not ban WebRTC for the rest of the
  // conversation.
  const got: string[] = []
  let stalls = 0
  let contentSeen = 0
  const { A, B } = await rooms({
    collect: got,
    drop: (d) => d[0] === 0x10 && ++contentSeen <= 2, // the message and its first retry
    onStallA: () => { stalls++ },
  })
  t.after(() => { A.stop(); B.stop() })
  await until(() => A.secured().length === 1 && B.secured().length === 1, 8000)

  A.sendText('relay gubi, ale to nie wina WebRTC')
  await until(() => got.length === 1, 10_000)
  assert.equal(stalls, 0, 'a relay loss is not a reason to distrust the direct path')
})

test('content that goes unconfirmed on a direct channel falls back to the relay', async (t) => {
  // The failure this comes from: both sides showed "WebRTC Direct" while the
  // DataChannel delivered nothing. The message must still arrive — over the
  // relay, after the room stops trusting the direct path.
  const got: string[] = []
  let stalls = 0
  let roomA: { setContentSend: (fn: null) => void } | null = null
  const { A, B } = await rooms({
    collect: got,
    onStallA: () => { stalls++; roomA?.setContentSend(null) }, // what core's plane.demote() does
  })
  roomA = A
  t.after(() => { A.stop(); B.stop() })
  await until(() => A.secured().length === 1 && B.secured().length === 1, 8000)

  A.setContentSend(() => {}) // a channel that is "open" and swallows everything
  A.sendText('przez martwy kanał')
  await until(() => stalls === 1, 8000)
  await until(() => got.length === 1, 10_000)
  assert.deepEqual(got, ['przez martwy kanał'], 'the relay carried what the direct channel ate')
})

test('a peer that never confirms is not reported as a failure (old client)', async (t) => {
  // Forward-compat: an older build ignores the ack type. Silence from such a
  // peer must not paint every message with a warning.
  const got: string[] = []
  const undelivered: string[] = []
  const { A, B } = await rooms({
    collect: got,
    drop: (d, from) => d[0] === 0x10 && from === 'peer-b', // B's acks never make it out
    onUndeliveredA: (id) => undelivered.push(id),
  })
  t.after(() => { A.stop(); B.stop() })
  await until(() => A.secured().length === 1 && B.secured().length === 1, 8000)

  A.sendText('do klienta bez potwierdzeń')
  await until(() => got.length === 1, 8000)
  await new Promise((r) => setTimeout(r, 6500)) // past both retries
  assert.deepEqual(undelivered, [], 'no false alarm')
})

test('an outage longer than the old budget does not kill a message on a live session', async (t) => {
  // Straight from a two-browser run: the relay went quiet for 9.4 s while both
  // peers were alive and announcing. The old budget (one re-send at 1.5 s, one
  // at 4 s, then 4 s to judge = 8.5 s) ran out first, so a healthy conversation
  // stamped the message ⚠ — and seconds later the peers were chatting again.
  // Scaled down here: the outage outlasts what the old schedule would have
  // allowed (100 + 200 + 400 = 700 ms) but not the backoff, which keeps going
  // while the peer is still present.
  const got: string[] = []
  const delivered: Array<[string, number]> = []
  const undelivered: string[] = []
  let outage = false
  const { A, B } = await rooms({
    collect: got,
    drop: (d) => d[0] === 0x10 && outage, // content and acks both stop
    onDeliveredA: (id, ms) => delivered.push([id, ms]),
    onUndeliveredA: (id) => undelivered.push(id),
    retry: { retryMs: [100, 200, 400, 800, 800], giveUpMs: 400, maxInflightMs: 10_000 },
  })
  t.after(() => { A.stop(); B.stop() })
  await until(() => A.secured().length === 1 && B.secured().length === 1, 8000)

  outage = true
  const id = A.sendText('przetrwa dziurę w łączu')
  setTimeout(() => { outage = false }, 1200)

  await until(() => got.length === 1, 8000)
  assert.deepEqual(got, ['przetrwa dziurę w łączu'], 'it arrived once the transport came back')
  await until(() => delivered.length === 1, 5000)
  assert.equal(delivered[0][0], id)
  assert.deepEqual(undelivered, [], 'a present peer is not declared unreachable mid-gap')
})

test('a message given up on can be sent again by hand', async (t) => {
  const got: string[] = []
  const delivered: Array<[string, number]> = []
  const undelivered: string[] = []
  let blackout = false
  const { A, B } = await rooms({
    collect: got,
    drop: (d) => d[0] === 0x10 && blackout,
    onDeliveredA: (id, ms) => delivered.push([id, ms]),
    onUndeliveredA: (id) => undelivered.push(id),
    retry: { retryMs: [50, 80], giveUpMs: 100, maxInflightMs: 5_000 },
  })
  t.after(() => { A.stop(); B.stop() })
  await until(() => A.secured().length === 1 && B.secured().length === 1, 8000)

  // One delivered message first: a peer is only judged once we know it acks at
  // all, so without this the loss below is treated as "old client", not ⚠.
  A.sendText('pierwsza')
  await until(() => delivered.length === 1, 5000)

  blackout = true
  const id = A.sendText('zginęła w dziurze')
  await until(() => undelivered.length === 1, 5000)
  assert.equal(undelivered[0], id)
  assert.equal(got.length, 1, 'the second one never reached the peer')

  blackout = false
  assert.equal(A.resend(id), true, 'the room still holds the envelope')
  await until(() => got.length === 2, 5000)
  assert.deepEqual(got, ['pierwsza', 'zginęła w dziurze'])
  await until(() => delivered.length === 2, 5000)
  assert.equal(delivered[1][0], id, 'the ack carries the ORIGINAL id, so the ⚠ the user is looking at turns ✓')
  assert.equal(A.resend('nie-było-takiej'), false, 'nothing to resend → false, not a throw')
})

test('a confirmation that arrives after we gave up corrects the ⚠', async (t) => {
  // The peer was asleep, not gone: it answers once it wakes. Ignoring that ack
  // (which is what the code used to do) leaves a ⚠ on a message that arrived —
  // the user is told a lie that no retry will ever clear.
  const got: string[] = []
  const lost: string[] = []
  const late: Array<[string, number]> = []
  let holdAcks = false
  const { A, B } = await rooms({
    collect: got,
    // Hold B's answers back, but only once the conversation is running: the
    // handshake and the first exchange have to get through for A to know that
    // this peer confirms at all.
    delayMs: (d, from) => (holdAcks && from === 'peer-b' && d[0] !== 0x01 && d[0] !== 0x02 && d[0] !== 0x03 ? 900 : 0),
    retry: { retryMs: [60], giveUpMs: 200, maxInflightMs: 5_000 },
    onUndeliveredA: (id) => lost.push(id),
    onLateDeliveredA: (id, ms) => late.push([id, ms]),
  })
  t.after(() => { A.stop(); B.stop() })
  await until(() => A.secured().length === 1 && B.secured().length === 1, 8000)

  A.sendText('pierwsza')
  await until(() => got.length === 1)

  holdAcks = true
  const second = A.sendText('druga — potwierdzenie utknie')
  await until(() => lost.includes(second), 3000)
  assert.deepEqual(late, [], 'nothing is late yet — it is still ⚠')

  await until(() => late.length === 1, 4000)
  assert.equal(late[0][0], second, 'the late confirmation lands on the message it belongs to')
  assert.ok(late[0][1] >= 200, 'and it reports how long that took')
  assert.equal(got.length, 2, 'the peer did have it all along')
})

test('a message that arrives behind newer ones is delivered marked, not silently last', async (t) => {
  // The receiver cannot re-thread what it was never told about: without this
  // flag a straggler looks exactly like a message typed just now, and the
  // transcript reads answer-before-question with nothing to explain it.
  const got: string[] = []
  const seen: Array<{ body: string; outOfOrder: boolean }> = []
  // Armed just before the send, so the hold lands on the message and not on an
  // Announce that happens to go out first.
  let armed = false
  const { A, B } = await rooms({
    collect: got,
    onMessageB: (_from, m, meta) => seen.push({ body: m.body, outOfOrder: meta.outOfOrder }),
    // Hold the first frame A sends once armed — the classic shape of this
    // failure: one frame takes the slow path, the next does not.
    delayMs: (_d, from) => {
      if (from !== 'peer-a' || !armed) return 0
      armed = false
      return 400
    },
  })
  t.after(() => { A.stop(); B.stop() })
  await until(() => A.secured().length === 1 && B.secured().length === 1, 8000)

  armed = true
  A.sendText('jeden')
  A.sendText('dwa')
  await until(() => seen.length === 2, 4_000)
  assert.deepEqual(seen.map((s) => s.body), ['dwa', 'jeden'], 'the transport really did reorder them')
  assert.deepEqual(seen.map((s) => s.outOfOrder), [false, true], 'only the straggler is marked')
})

test('a backlog left by an outage goes out in the order it was written', async (t) => {
  // Each message otherwise waits out its own private backoff, so what comes back
  // from an outage arrives in whatever order the timers happen to fire.
  const got: string[] = []
  let offline = true
  const { A, B } = await rooms({
    collect: got,
    // Nothing from A reaches B until the "network" comes back. Announces from A
    // are swallowed too — that is what an outage looks like.
    drop: (d, from) => offline && from === 'peer-a' && d[0] !== 0x01 && d[0] !== 0x02 && d[0] !== 0x03,
    retry: { retryMs: [30_000], giveUpMs: 30_000, maxInflightMs: 60_000 },
  })
  t.after(() => { A.stop(); B.stop() })
  await until(() => A.secured().length === 1 && B.secured().length === 1, 8000)

  A.sendText('pierwsza')
  A.sendText('druga')
  A.sendText('trzecia')
  await new Promise((r) => setTimeout(r, 200))
  assert.deepEqual(got, [], 'the outage really did swallow them')

  offline = false
  A.flushPending()
  await until(() => got.length === 3, 5000)
  assert.deepEqual(got, ['pierwsza', 'druga', 'trzecia'])
})

test('a session is replaced on a timer, without the conversation noticing (§7.3)', async (t) => {
  // The bounded lifetime is a security boundary, not housekeeping: it caps
  // classical-PCS exposure and it is the hard stop on a stolen unlocked device,
  // because the re-handshake needs the HSM the thief does not have (§9.3).
  // What must NOT happen is a visible break — content keeps flowing across it.
  const got: string[] = []
  const { A, B, states } = await rooms({ collect: got, sessionLifetimeMs: 600, heartbeatMs: 300 })
  t.after(() => { A.stop(); B.stop() })
  await until(() => A.secured().length === 1 && B.secured().length === 1, 8000)

  A.sendText('przed re-keyem')
  await until(() => got.length === 1)

  const established = () => states.filter((s) => s.endsWith(':established')).length
  const before = established()
  await until(() => established() >= before + 2, 8000) // both sides re-established
  assert.equal(A.secured().length, 1, 'still exactly one session — replaced, not accumulated')

  A.sendText('po re-keyu')
  await until(() => got.length === 2, 8000)
  assert.deepEqual(got, ['przed re-keyem', 'po re-keyu'])
})

test('a second tab on the same identity is recognised, not handshaked with forever', async (t) => {
  // Reported from a live session: a second browser tab logged into the same
  // account joined the room, and the two tabs tried to handshake with each other
  // for as long as they were open — badge flickering 🔐/⚠, conversation dead,
  // and it kept going after the extra tab was closed. They cannot succeed: each
  // expects the CONTACT's identity key and is offered its own. What they can do
  // is notice, and stop.
  const got: string[] = []
  const { A, B, rejoinB } = await rooms({ collect: got })
  await until(() => A.secured().length === 1 && B.secured().length === 1, 8000)

  const logs2: string[] = []
  const B2 = rejoinB('peer-d', [], logs2) // same identity as B, its own PeerId
  t.after(() => { A.stop(); B.stop(); B2.stop() })

  await until(() => logs2.some((l) => l.includes('identifies as someone else')), 12_000)
  // Attempts toward the OTHER TAB must stop. Attempts toward the real contact
  // are none of this test's business.
  const atTab = () => logs2.filter((l) => l.includes('attempt → peer-b')).length
  const settled = atTab()
  await new Promise((r) => setTimeout(r, 2_500))
  assert.equal(atTab(), settled, 'no further attempts once the peer is known to be foreign')

  // …and the real conversation is untouched by any of it.
  A.sendText('mimo drugiej zakładki')
  await until(() => got.includes('mimo drugiej zakładki'), 8000)
})
