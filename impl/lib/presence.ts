/**
 * presence.ts — the light half of the two-layer model (see core.ts `watchContacts`).
 *
 * For each contact we hold a `watchPresence` on the PAIR topic: subscribe,
 * announce ourselves (§5.5 HMAC), and report whether the contact is announcing —
 * a green dot, nothing more. **No EH-2 handshake, no ratchet, no WebRTC.** That
 * is the whole point: being visible to 20 contacts costs 20 subscriptions + a
 * heartbeat each, not 20 handshakes.
 *
 * Why the pair topic and not a shared "presence" topic: only the two members can
 * derive `ss = ECDH(IK_a, IK_b)`, so an Announce there is visible to exactly one
 * contact. A common announcement topic would leak the whole presence graph (who
 * is online, to everyone on it) — the per-pair topic is a deliberate security
 * choice, not a cost.
 *
 * **Upgrade to a conversation.** The watcher is subscribed to the topic, so it
 * hears everything on it. An EH-2 handshake frame (msg1/2/3) means the contact
 * wants to talk — the watcher hands it to `onIncomingHandshake`, and the owner
 * (core) tears this light watch down and opens the full room, which replays the
 * frame. So either side starts EH-2 just by sending; the receiver need not
 * "enter" first.
 *
 * Caveat, documented: a SECOND tab of our OWN identity also derives this topic
 * and its Announce verifies (same pair secret), so until §9.1 closes the
 * duplicate it could briefly light the dot. The clean fix is an identity tag in
 * the Announce (a spec-queue item); for now §9.1 resolves duplicates in seconds.
 */

import { buildAnnounce, verifyAnnounce } from './announce.ts'
import { isHandshakeFrame } from '../eh2/establish.ts'
import { nowMs, utcDateOf, addUTCDays, msToNextUTCMidnight, msSincePrevUTCMidnight } from './time.ts'

export interface PresenceWatch {
  /** Announce now — e.g. a tab became visible after being throttled. */
  announce(): void
  /**
   * Tear the watch down. `unsubscribe` defaults to true (full teardown); pass
   * FALSE to hand the topic OFF to a room being opened on it — the subscription
   * (and its warm GossipSub mesh) stays, so the room reuses it instead of the
   * node leaving and re-grafting, which stalled the presence→conversation upgrade.
   */
  stop(unsubscribe?: boolean): void
}

export interface PresenceOpts {
  heartbeatMs?: number
  onOnline: () => void
  onOffline: () => void
  /** An EH-2 frame arrived on the topic → the contact wants to talk; upgrade. */
  onIncomingHandshake: (frame: Uint8Array, from: string) => void
  onLog?: (msg: string, level?: 'info' | 'debug') => void
}

export function watchPresence(node: any, topic: string, macKey: CryptoKey, self: string, opts: PresenceOpts): PresenceWatch {
  const log = opts.onLog ?? (() => {})
  const heartbeatMs = opts.heartbeatMs ?? 15_000
  const ttlMs = Math.max(heartbeatMs * 6, 90_000)
  const seenNonces = new Set<string>()
  let lastSeen = 0
  let online = false
  let stopped = false

  const announce = async () => {
    if (stopped) return
    try { await node.services.pubsub.publish(topic, await buildAnnounce(self, macKey)) } catch {}
  }

  const handler = async (evt: any) => {
    if (stopped || evt.detail.topic !== topic) return
    const from = evt.detail.from?.toString?.()
    if (from === self) return
    const data: Uint8Array = evt.detail.data
    // A handshake frame is the contact opening a conversation — the light watch
    // steps aside and lets the full room take over (core handles the upgrade).
    if (isHandshakeFrame(data)) { opts.onIncomingHandshake(data, from); return }
    const res = await verifyAnnounce(data, macKey)
    if (!res.ok || !res.peer || res.peer === self) return
    if (seenNonces.has(res.nonce!)) return
    seenNonces.add(res.nonce!)
    lastSeen = nowMs()
    if (!online) { online = true; log(`contact online on ${topic.slice(0, 12)}…`); opts.onOnline() }
  }

  node.services.pubsub.addEventListener('message', handler)
  node.services.pubsub.subscribe(topic)
  void announce()

  // The first announce goes out before the relay has joined this topic's mesh,
  // so it reaches nobody — and the next heartbeat is a long way off. Without
  // these early repeats the dot took a full heartbeat (~15 s) to light; with
  // them it lights in a second or two, the same trick the room uses on join.
  const earlyBeacons = [1_000, 3_000, 7_000].map((d) => {
    const t = setTimeout(() => void announce(), d)
    ;(t as any).unref?.()
    return t
  })

  const hb = setInterval(announce, heartbeatMs)
  ;(hb as any).unref?.()
  const sweep = setInterval(() => {
    if (online && nowMs() - lastSeen > ttlMs) { online = false; log(`contact silent on ${topic.slice(0, 12)}… → offline`); opts.onOffline() }
  }, Math.min(heartbeatMs, 15_000))
  ;(sweep as any).unref?.()

  return {
    announce() { void announce() },
    stop(unsubscribe = true) {
      stopped = true
      for (const t of earlyBeacons) clearTimeout(t)
      clearInterval(hb); clearInterval(sweep)
      try { node.services.pubsub.removeEventListener('message', handler) } catch {}
      // On a handoff to a room (unsubscribe=false) the subscription and its warm
      // mesh stay; the room owns the topic from here and unsubscribes on its own
      // teardown.
      if (unsubscribe) { try { node.services.pubsub.unsubscribe(topic) } catch {} }
    },
  }
}

// ---- rotation: the same pair, but the topic changes every UTC day -----------

/** A `[0,1)` value from the peer id — deterministic (so it is testable and
 *  survives reloads) yet different per client, which is what spreads the
 *  cutover instead of every client rotating at 00:00:00 UTC together. FNV-1a. */
function unitHash(s: string): number {
  let h = 2166136261 >>> 0
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0 }
  return h / 4294967296
}

export interface RotationConfig {
  /** Base half-window each side of a UTC midnight (default 30 min). */
  overlapMs?: number
  /** Extra half-window, scaled per-client by the id hash, that smears the
   *  subscribe/unsubscribe moments across time (default 20 min). */
  jitterMs?: number
}

/**
 * Which day-topics should be LIVE for this client at `now`. Normally just
 * today; within the (jittered) overlap window around a UTC midnight, today AND
 * the adjacent day, so a pair crossing midnight at slightly different instants
 * still meets on a shared topic. Pure and deterministic — the whole rotation is
 * a function of the clock and the id, nothing hidden. `[0]` is always today
 * (the primary the room hands off to).
 */
export function activeDatesFor(now: number, self: string, cfg: RotationConfig = {}): string[] {
  const W = cfg.overlapMs ?? 30 * 60_000
  const J = cfg.jitterMs ?? 20 * 60_000
  const edge = W + unitHash(self) * J
  const today = utcDateOf(now)
  const dates = [today]
  if (msToNextUTCMidnight(now) <= edge) dates.push(addUTCDays(today, 1))
  if (msSincePrevUTCMidnight(now) < edge) dates.push(addUTCDays(today, -1))
  return dates
}

export interface RotatingPresenceOpts extends RotationConfig {
  heartbeatMs?: number
  onOnline: () => void
  onOffline: () => void
  /** An EH-2 frame arrived on `dateUTC`'s topic → upgrade the conversation ON
   *  THAT DATE, so the room lands on the exact topic the handshake is using. */
  onIncomingHandshake: (frame: Uint8Array, from: string, dateUTC: string) => void
  onLog?: (msg: string, level?: 'info' | 'debug') => void
  /** Clock seam for tests. */
  now?: () => number
  /** How often to re-evaluate the active day-set (default 60 s). */
  tickMs?: number
}

/**
 * A presence watch that rotates its pair topic across UTC days. It holds one
 * `watchPresence` per active day (see `activeDatesFor`): one topic normally,
 * two through the midnight overlap. The contact is ONLINE if it is announcing
 * on any of them, and an incoming handshake is surfaced with the day it arrived
 * on. `deriveForDate` turns a day into that day's `{topic, macKey}` — the caller
 * caches the pair `ss` once and only re-runs the (cheap) HKDF per day, never a
 * second `ecdh`.
 */
export function watchPresenceRotating(
  node: any,
  self: string,
  deriveForDate: (dateUTC: string) => Promise<{ topic: string; macKey: CryptoKey }>,
  opts: RotatingPresenceOpts,
): PresenceWatch {
  const now = opts.now ?? nowMs
  const tickMs = opts.tickMs ?? 60_000
  const watches = new Map<string, { watch: PresenceWatch; online: boolean }>()
  let aggregate = false
  let stopped = false

  const recompute = () => {
    const any = [...watches.values()].some((w) => w.online)
    if (any && !aggregate) { aggregate = true; opts.onOnline() }
    else if (!any && aggregate) { aggregate = false; opts.onOffline() }
  }

  // Serialise reconciliations: `deriveForDate` is async, so two ticks must not
  // both decide to create the same day's watch. Each runs after the last.
  let chain: Promise<void> = Promise.resolve()
  const reconcile = () => { chain = chain.then(sync).catch(() => {}) }

  const sync = async () => {
    if (stopped) return
    const want = activeDatesFor(now(), self, opts)
    for (const d of want) {
      if (watches.has(d) || stopped) continue
      const slot: { watch: PresenceWatch; online: boolean } = { watch: undefined as any, online: false }
      watches.set(d, slot) // reserve the slot before the await so a racing tick skips it
      const { topic, macKey } = await deriveForDate(d)
      if (stopped) { watches.delete(d); return }
      slot.watch = watchPresence(node, topic, macKey, self, {
        heartbeatMs: opts.heartbeatMs,
        onOnline: () => { slot.online = true; recompute() },
        onOffline: () => { slot.online = false; recompute() },
        onIncomingHandshake: (f, from) => opts.onIncomingHandshake(f, from, d),
        onLog: opts.onLog,
      })
    }
    for (const [d, slot] of [...watches]) {
      if (!want.includes(d)) { slot.watch?.stop(true); watches.delete(d) }
    }
    recompute()
  }

  reconcile()
  const timer = setInterval(reconcile, tickMs)
  ;(timer as any).unref?.()

  return {
    announce() { for (const s of watches.values()) s.watch?.announce() },
    stop(unsubscribe = true) {
      stopped = true
      clearInterval(timer)
      // Handoff (unsubscribe=false): keep today's subscription warm for the room
      // taking over (its topic == today's presence topic); always drop the
      // overlap day. Full stop: unsubscribe everything.
      const primary = utcDateOf(now())
      for (const [d, slot] of watches) slot.watch?.stop(unsubscribe || d !== primary)
      watches.clear()
    },
  }
}
