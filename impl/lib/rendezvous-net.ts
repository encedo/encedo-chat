/**
 * rendezvous-net.ts — join a deterministic room over libp2p GossipSub and detect
 * peer presence (docs/PROTOCOL.md §5.4–5.6).
 *
 * Given a running libp2p node (already dialed to a discovery relay), the room
 * topic, and the announce_mac_key: subscribe, publish our own Announce (start +
 * heartbeat), and verify inbound Announces. Each fresh MAC-valid peer fires
 * onPeer(peerId). Identity here is the ephemeral libp2p PeerId, authenticated by
 * the shared macKey — only someone holding it can post a valid Announce.
 */

import { buildAnnounce, verifyAnnounce } from './announce.ts'

export interface JoinOpts {
  onPeer?: (peerId: string) => void
  onLeave?: (peerId: string) => void
  heartbeatMs?: number
  initialDelayMs?: number
  presenceTtlMs?: number
}

export function joinRoom(node, topic: string, macKey: Buffer, opts: JoinOpts = {}) {
  const onPeer = opts.onPeer ?? (() => {})
  const onLeave = opts.onLeave ?? (() => {})
  const heartbeatMs = opts.heartbeatMs ?? 60_000
  const initialDelayMs = opts.initialDelayMs ?? 1_500
  const presenceTtlMs = opts.presenceTtlMs ?? Math.max(heartbeatMs * 3, 30_000)
  const self = node.peerId.toString()
  const seenNonces = new Set<string>()
  const lastSeen = new Map<string, number>()

  const handler = (evt) => {
    if (evt.detail.topic !== topic) return
    const res = verifyAnnounce(evt.detail.data, macKey)
    if (!res.ok || res.peer === self) return
    if (seenNonces.has(res.nonce!)) return           // duplicate protection
    seenNonces.add(res.nonce!)
    const fresh = !lastSeen.has(res.peer!)
    lastSeen.set(res.peer!, Date.now())
    if (fresh) onPeer(res.peer!)
  }
  node.services.pubsub.addEventListener('message', handler)
  node.services.pubsub.subscribe(topic)

  const announce = () => {
    node.services.pubsub.publish(topic, buildAnnounce(self, macKey)).catch(() => {})
  }
  const t0 = setTimeout(announce, initialDelayMs)     // let the mesh form first
  const hb = setInterval(announce, heartbeatMs)

  // expire peers that stopped announcing
  const sweep = setInterval(() => {
    const now = Date.now()
    for (const [peer, t] of lastSeen) {
      if (now - t > presenceTtlMs) { lastSeen.delete(peer); onLeave(peer) }
    }
  }, Math.min(heartbeatMs, 15_000))

  return {
    presentPeers: () => [...lastSeen.keys()],
    stop: () => {
      clearTimeout(t0); clearInterval(hb); clearInterval(sweep)
      node.services.pubsub.removeEventListener('message', handler)
      try { node.services.pubsub.unsubscribe(topic) } catch {}
    },
  }
}
