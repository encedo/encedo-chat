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
import { nowMs } from './time.ts'

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
