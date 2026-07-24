/**
 * room.ts — presence + interim encrypted chat over one rendezvous topic.
 *
 * Combines authenticated presence (Announce, §5.5) and interim encrypted chat
 * messages (msgcrypto) on the same GossipSub topic.
 *
 * NOTE (interim): message content rides GossipSub through the relay here (the v5
 * model — relay sees ciphertext + timing). The target design moves content to a
 * direct stream / blind circuit-relay data plane (docs/PROTOCOL.md §13); that is
 * a later step, together with EH-2. Fine for the CLI now.
 */

import { buildAnnounce, verifyAnnounce } from './announce.ts'
import { encryptMsg, tryDecryptMsg } from './msgcrypto.ts'

export interface RoomKeys { macKey: Uint8Array; msgKey: Uint8Array }
export interface ChatOpts {
  onMessage?: (fromPeerId: string, text: string) => void
  onPresence?: (peerId: string, event: 'join' | 'leave') => void
  heartbeatMs?: number
}

export function joinChat(node, topic: string, keys: RoomKeys, opts: ChatOpts = {}) {
  const onMessage = opts.onMessage ?? (() => {})
  const onPresence = opts.onPresence ?? (() => {})
  const heartbeatMs = opts.heartbeatMs ?? 15_000
  const ttlMs = Math.max(heartbeatMs * 3, 30_000)
  const self = node.peerId.toString()
  const seenNonces = new Set<string>()
  const lastSeen = new Map<string, number>()

  const handler = (evt) => {
    if (evt.detail.topic !== topic) return
    const from = evt.detail.from.toString()
    // chat message?
    const text = tryDecryptMsg(evt.detail.data, keys.msgKey)
    if (text !== null) { if (from !== self) onMessage(from, text); return }
    // else presence announce
    const res = verifyAnnounce(evt.detail.data, keys.macKey)
    if (!res.ok || res.peer === self) return
    if (seenNonces.has(res.nonce!)) return
    seenNonces.add(res.nonce!)
    const fresh = !lastSeen.has(res.peer!)
    lastSeen.set(res.peer!, Date.now())
    if (fresh) onPresence(res.peer!, 'join')
  }
  node.services.pubsub.addEventListener('message', handler)
  node.services.pubsub.subscribe(topic)

  const announce = () => node.services.pubsub.publish(topic, buildAnnounce(self, keys.macKey)).catch(() => {})
  const t0 = setTimeout(announce, 1500)
  const hb = setInterval(announce, heartbeatMs)
  const sweep = setInterval(() => {
    const now = Date.now()
    for (const [peer, t] of lastSeen) if (now - t > ttlMs) { lastSeen.delete(peer); onPresence(peer, 'leave') }
  }, Math.min(heartbeatMs, 15_000))

  return {
    send: (text: string) => node.services.pubsub.publish(topic, encryptMsg(text, keys.msgKey)).catch(() => {}),
    who: () => [...lastSeen.keys()],
    stop: () => {
      clearTimeout(t0); clearInterval(hb); clearInterval(sweep)
      node.services.pubsub.removeEventListener('message', handler)
      try { node.services.pubsub.unsubscribe(topic) } catch {}
    },
  }
}
