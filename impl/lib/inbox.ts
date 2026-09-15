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
 * The decoy is also the keepalive. The relay evicts a topic idle for 120 s, so
 * an inbox nobody knocks on would quietly stop being routed; the default
 * interval sits under that.
 */

import { hkdfBits } from './wc.ts'
import { topicFromSecret, rotationOffsetSec, type RvParams } from './rendezvous.ts'
import { activeDatesForOffset, type RotationConfig } from './presence.ts'
import { openKnock, decoyKnock, type Knock } from './knock.ts'
import type { Dh } from './x25519.ts'
import { nowMs } from './time.ts'

const te = new TextEncoder()
const SEED_LABEL = te.encode('encedo-chat-invite-decoy-v1')
const SLOT_LABEL = te.encode('encedo-chat-invite-decoy-slot-v1')

/** Under the relay's 120 s idle eviction, with room for a missed tick. */
const DECOY_EVERY_MS = 90_000
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

  const publishDecoy = async () => {
    if (stopped) return
    const topic = topics.get(activeDatesForOffset(now(), offsetMs, opts)[0])
    if (!topic) return
    try { await node.services.pubsub.publish(topic, await decoyKnock(inbox, dh.pub)) } catch {}
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
    if (n !== curSlot) await planSlot(n)
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
    stop() {
      stopped = true
      clearInterval(timer)
      try { node.services.pubsub.removeEventListener('message', handler) } catch {}
      for (const t of topics.values()) if (t) { try { node.services.pubsub.unsubscribe(t) } catch {} }
      topics.clear()
    },
  }
}
