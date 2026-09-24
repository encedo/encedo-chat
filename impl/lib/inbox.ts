/**
 * inbox.ts — listening on the topic an invite names (DISCOVERY-PROPOSAL.md §2).
 *
 * A Journalist publishes a link; the secret in it names a topic; this watches
 * that topic for knocks. It is deliberately NOT a presence watch: there is no
 * Announce, no liveness, no peer to be online — only frames arriving from
 * people this side has never heard of.
 *
 * ## The topic is public, and everything here follows from that
 *
 * Every other topic in this protocol is the image of a secret two people
 * share. This one is the image of a secret printed on a web page, so anyone
 * who read the page can subscribe to it AND publish to it. Three consequences
 * are handled here rather than upstream:
 *
 * - **Hostile input is ordinary.** `openKnock` returns null rather than
 *   throwing, and everything that fails to open is dropped without a word.
 * - **Repeats and floods are ordinary.** A frame is surfaced once, and only so
 *   many per minute reach the caller; past that they are counted and dropped,
 *   because the thing an unwanted contact would try to take is attention.
 * - **Silence is informative, so it is removed.** See the decoys below.
 *
 * ## Decoys, and why the seed is not the invite secret
 *
 * Cover traffic makes "somebody knocked" stop meaning anything, because it
 * happens anyway (§6.1). The schedule is deterministic so that two clients of
 * the same identity produce ONE stream rather than two — the rate would
 * otherwise reveal how many devices are listening — and so that a restart
 * resumes the same schedule with nothing stored.
 *
 * The seed is `ECDH(IK, IK_pub)` bound to the invite, which only the holder of
 * that identity can compute (the §9.1 self-topic trick). It must NOT be the
 * invite secret: that is public, so every holder of the link could compute
 * when the decoys fall, subtract them, and read off the real knocks — leaving
 * a watcher better off than with no decoys at all (§4.6).
 *
 * The decoy is also the keepalive, and that is what sets the interval. The relay
 * evicts a topic idle for 120 s (`relay.mjs` IDLE_TTL), and an evicted topic does
 * not come back on its own: the relay unsubscribes, so nothing we publish there
 * reaches anyone and no knock is ever routed to us again, while this side goes on
 * reporting that it is listening. The arithmetic that matters is the WORST gap,
 * not the average: one decoy per slot at a uniformly random instant in the slot
 * means two consecutive decoys can be almost two slots apart (late in one slot,
 * early in the next), so the slot has to be under HALF the eviction TTL. At 90 s
 * it was not, and measured gaps of 102 s and 129 s evicted live inboxes.
 */

import { hkdfBits } from './wc.ts'
import { topicFromSecret, rotationOffsetSec, type RvParams } from './rendezvous.ts'
import { activeDatesForOffset, type RotationConfig } from './presence.ts'
import { openKnock, decoyKnock, sealKnock, type Knock } from './knock.ts'
import type { Dh } from './x25519.ts'
import { nowMs } from './time.ts'

const te = new TextEncoder()
const SEED_LABEL = te.encode('encedo-chat-invite-decoy-v1')
const SLOT_LABEL = te.encode('encedo-chat-invite-decoy-slot-v1')

/** Half the relay's 120 s idle eviction, so the worst gap (just under two
 *  slots) still refreshes the topic with margin for a missed tick. */
export const DECOY_EVERY_MS = 45_000
/** Knocks surfaced per minute before the rest are counted and dropped. */
const MAX_PER_MIN = 20
/** Ephemeral keys remembered, so one frame is surfaced once. */
const SEEN_MAX = 512

export interface InboxKnock {
  /** The Source's identity public key — the thing the Journalist could not derive. */
  ik: Uint8Array
  /** Claimed, never verified. Shown next to a fingerprint, never instead of one. */
  name: string
  note: string
  /** The rendezvous day it arrived on, so the caller can open the room there. */
  dateUTC: string
}

export interface InboxOpts extends RotationConfig {
  onKnock(k: InboxKnock): void
  onLog?(m: string): void
  /** Injected in tests. */
  now?(): number
  tickMs?: number
  decoyEveryMs?: number
  maxPerMin?: number
}

export interface InboxWatch {
  /** Publish one decoy now, whatever the schedule says. Tests and a first run. */
  decoy(): Promise<void>
  /**
   * Run one pass NOW and settle it.
   *
   * The interval fires the same pass and forgets the promise, which is right in
   * production and impossible to test against: a test that drives the clock has
   * to know when the pass that clock triggered has FINISHED, and `step` awaits
   * a key derivation on the way. Waiting a few milliseconds of real time
   * instead is what made `inbox.test.ts` fail twice in CI on a loaded runner
   * while passing on every desk -- the pass simply had not run yet. Give the
   * watch a `tickMs` longer than the test and drive it through here, and no
   * real time is involved at all.
   */
  pump(): Promise<void>
  stop(): void
}

const u32 = (n: number) => new Uint8Array([(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255])
const readU32 = (b: Uint8Array) => ((b[0] << 24) | (b[1] << 16) | (b[2] << 8) | b[3]) >>> 0

/**
 * Watch one invite's inbox.
 *
 * `dh` is the Journalist's identity — `dhFromEcdh(id.pub, id.ecdh)` for a HEM
 * or a software profile alike. It opens the knocks AND seeds the decoys, which
 * is why nothing else has to be passed in.
 */
export function watchInbox(
  node: any,
  inbox: Uint8Array,
  dh: Dh,
  params: RvParams,
  opts: InboxOpts,
): InboxWatch {
  const log = opts.onLog ?? (() => {})
  const now = opts.now ?? nowMs
  const tickMs = opts.tickMs ?? 1_000
  const decoyEvery = opts.decoyEveryMs ?? DECOY_EVERY_MS
  const maxPerMin = opts.maxPerMin ?? MAX_PER_MIN

  const topics = new Map<string, string>()      // dateUTC -> topic
  const seen: string[] = []                     // ephemeral keys, oldest first
  const seenSet = new Set<string>()
  let surfaced: number[] = []                   // timestamps, for the rate cap
  let dropped = 0
  let stopped = false
  let offsetMs = 0
  let seed: Uint8Array | null = null

  const b64 = (b: Uint8Array) => btoa(String.fromCharCode(...b))

  const remember = (ephB64: string) => {
    seenSet.add(ephB64)
    seen.push(ephB64)
    if (seen.length > SEEN_MAX) { const old = seen.shift()!; seenSet.delete(old) }
  }

  const handler = async (evt: any) => {
    if (stopped) return
    const topic: string = evt.detail?.topic
    let date: string | undefined
    for (const [d, t] of topics) if (t === topic) date = d
    if (!date) return

    const frame: Uint8Array = evt.detail.data
    // The ephemeral key is unique per frame, so it is the identity of the frame
    // for de-duplication - and it costs nothing, being in the clear already.
    const eph = frame.length >= 32 ? b64(frame.subarray(0, 32)) : null
    if (!eph || seenSet.has(eph)) return
    remember(eph)

    let k: Knock | null = null
    try { k = await openKnock(inbox, dh, frame) } catch { k = null }
    if (!k) return                 // not for us, or not a knock at all: silence
    if (k.decoy) return            // ours, or somebody else's cover traffic

    const t = now()
    surfaced = surfaced.filter((x) => t - x < 60_000)
    if (surfaced.length >= maxPerMin) {
      dropped++
      if (dropped === 1 || dropped % 50 === 0) log(`inbox: over the rate cap, dropped ${dropped}`)
      return
    }
    surfaced.push(t)
    opts.onKnock({ ik: k.ik, name: k.name, note: k.note, dateUTC: date })
  }

  /** The decoy schedule: one per slot, at an instant only this identity knows. */
  const slotOf = (t: number) => Math.floor(t / decoyEvery)
  let curSlot = -1
  let fireAt = 0
  let fired = false

  // Reported once per change, never per decoy: a topic nobody carries is the
  // difference between "listening" and "reachable", and it is invisible from
  // here otherwise - publishing into an empty topic succeeds quietly
  // (`allowPublishToZeroTopicPeers`), which is how an evicted inbox looks.
  let carried: boolean | null = null

  const publishDecoy = async () => {
    if (stopped) return
    const topic = topics.get(activeDatesForOffset(now(), offsetMs, opts)[0])
    if (!topic) return
    try {
      const res: any = await node.services.pubsub.publish(topic, await decoyKnock(inbox, dh.pub))
      // Test doubles do not report recipients; absence is not evidence.
      const reach = res?.recipients?.length
      if (typeof reach !== 'number') return
      const now = reach > 0
      if (carried !== now) {
        carried = now
        log(now
          ? `inbox: ${topic.slice(0, 12)}... is being carried again`
          : `inbox: nobody is carrying ${topic.slice(0, 12)}... - no knock can reach us there`)
      }
    } catch {}
  }

  const planSlot = async (n: number) => {
    const h = await hkdfBits(seed!, SLOT_LABEL, u32(n), 4)
    curSlot = n
    fireAt = n * decoyEvery + (readU32(h) % decoyEvery)
    fired = false
  }

  // Serialised like the rotating presence watch: `topicFromSecret` is async, so
  // two ticks must not both decide to subscribe to the same day.
  let chain: Promise<void> = Promise.resolve()
  const tick = () => { chain = chain.then(step).catch(() => {}) }

  const step = async () => {
    if (stopped) return
    const t = now()
    const want = activeDatesForOffset(t, offsetMs, opts)
    for (const d of want) {
      if (topics.has(d) || stopped) continue
      topics.set(d, '')                                   // reserve before the await
      const topic = await topicFromSecret(inbox, { ...params, dateUTC: d })
      if (stopped) { topics.delete(d); return }
      topics.set(d, topic)
      try { node.services.pubsub.subscribe(topic) } catch {}
      log(`inbox: listening on ${topic.slice(0, 12)}... (${d})`)
    }
    for (const [d, topic] of [...topics]) {
      if (want.includes(d)) continue
      topics.delete(d)
      if (topic) { try { node.services.pubsub.unsubscribe(topic) } catch {} }
      log(`inbox: rotated off ${topic.slice(0, 12)}... (${d})`)
    }

    const n = slotOf(t)
    if (n !== curSlot) {
      // A slot whose instant fell between two ticks must still be paid, or the
      // gap to the next one spans three slots and the relay evicts the topic
      // underneath us. Paying it late costs one frame close to another, which is
      // cover traffic doing its job; dropping it costs the inbox.
      const overdue = curSlot >= 0 && !fired
      await planSlot(n)
      if (overdue) await publishDecoy()
    }
    if (!fired && t >= fireAt) { fired = true; await publishDecoy() }
  }

  const timer = setInterval(tick, tickMs)
  ;(timer as any).unref?.()

  // Everything async is kicked off here rather than in the caller: the offset
  // and the seed are both derivations, and the first tick needs them.
  chain = (async () => {
    offsetMs = (await rotationOffsetSec(inbox, params)) * 1000
    seed = await hkdfBits(await dh.dh(dh.pub), SEED_LABEL, inbox, 32)
  })().then(step).catch(() => {})

  try { node.services.pubsub.addEventListener('message', handler) } catch {}

  return {
    async decoy() { await chain; await publishDecoy() },
    async pump() { tick(); await chain },
    stop() {
      stopped = true
      clearInterval(timer)
      try { node.services.pubsub.removeEventListener('message', handler) } catch {}
      for (const t of topics.values()) if (t) { try { node.services.pubsub.unsubscribe(t) } catch {} }
      topics.clear()
    },
  }
}

/**
 * Knock once on somebody's published invite — the Source's half.
 *
 * Publish-only, and deliberately: subscribing would put this client in the
 * topic's subscriber set for no gain, and the frame reaches the Journalist
 * through the relay, which is already subscribed because the Journalist is
 * listening. If nobody is listening the relay has evicted the topic and the
 * knock reaches nobody — that is §4.7, not a failure to handle here.
 *
 * The day is computed the same way the watch computes it, so both sides land on
 * the same topic without agreeing on anything but the secret.
 */
export async function sendKnock(
  node: any,
  inbox: Uint8Array,
  journalistPub: Uint8Array,
  params: RvParams,
  body: { ik: Uint8Array; name: string; note?: string },
  opts: RotationConfig & { now?(): number; waitMs?: number } = {},
): Promise<number | null> {
  const now = opts.now ?? nowMs
  const offsetMs = (await rotationOffsetSec(inbox, params)) * 1000
  const dateUTC = activeDatesForOffset(now(), offsetMs, opts)[0]
  const topic = await topicFromSecret(inbox, { ...params, dateUTC })

  // A knock is usually the FIRST thing a fresh session does - somebody clicked a
  // link, the app came up, and this runs seconds later. At that moment the node
  // may not yet know that anyone carries this topic, and publishing then reaches
  // nobody without failing (`allowPublishToZeroTopicPeers`), which costs the
  // Source the whole 90 s until the next attempt. So wait, briefly, the way the
  // room waits for the relay to join a topic before announcing.
  //
  // Waiting is not enough since the relay announces to a client only the topics
  // that client HOLDS (relay/leaf.mjs, 2026-09-24): a peer that only wants to
  // publish is told nothing, and its publish goes to nobody -- the browser
  // harness caught exactly this once the flag was on. So the knocker subscribes
  // for the duration of the knock. It costs one transient topic on the peer's
  // quota and tells the relay nothing the publish would not: the frame itself
  // names the topic. Unsubscribed right after, whatever happened.
  const deadline = now() + (opts.waitMs ?? 8_000)
  try { node.services.pubsub.subscribe(topic) } catch {}
  try {
    while (now() < deadline) {
      try { if (node.services.pubsub.getSubscribers(topic).length > 0) break } catch { break }
      await new Promise((r) => setTimeout(r, 250))
    }
    const res: any = await node.services.pubsub.publish(topic, await sealKnock(inbox, journalistPub, body))
    // Absence is not evidence (test doubles report nothing); zero is.
    const reach = res?.recipients?.length
    return typeof reach === 'number' ? reach : null
  } finally {
    try { node.services.pubsub.unsubscribe(topic) } catch {}
  }
}
