/**
 * room.ts — presence + interim encrypted chat over one rendezvous topic.
 *
 * Orchestration layer: it owns none of the lower layers, it wires them —
 *   crypto     (msgcrypto: seal/open opaque bytes),
 *   codec      (envelope: Envelope <-> bytes, typed),
 *   transport  (libp2p gossipsub).
 * Outgoing: build envelope → encode → seal → publish.
 * Incoming: open → decode → dispatch by type to callbacks.
 *
 * Authenticated presence (Announce/HMAC, §5.5) rides the same topic for
 * discovery/liveness. Richer in-session state (typing / away / leave) travels
 * as ENCRYPTED meta-messages, so the relay stays blind to them.
 *
 * NOTE (interim): content rides GossipSub through the relay (v5 model — relay
 * sees ciphertext + timing). Target moves content to a direct/blind data plane
 * (docs/PROTOCOL.md §13). Later.
 */

import { buildAnnounce, verifyAnnounce } from './announce.ts'
import { seal, open } from './msgcrypto.ts'
import {
  encodeEnvelope, decodeEnvelope, envMsg, envTyping, envPresence, envReaction, envFile,
  type MsgEnv, type ReactionEnv, type FileEnv, type FileMeta, type TypingState, type PresenceState,
} from './envelope.ts'
import { nowMs } from './time.ts'

export interface RoomKeys { macKey: CryptoKey; msgKey: CryptoKey }
export type PresenceEvent = 'join' | 'active' | 'away' | 'leave'
export interface ChatOpts {
  onMessage?: (from: string, m: MsgEnv) => void
  onTyping?: (from: string, state: TypingState) => void
  onPresence?: (from: string, ev: PresenceEvent) => void
  onReaction?: (from: string, r: ReactionEnv) => void
  onFile?: (from: string, f: FileEnv) => void
  heartbeatMs?: number
}

export function joinChat(node, topic: string, keys: RoomKeys, opts: ChatOpts = {}) {
  const onMessage = opts.onMessage ?? (() => {})
  const onTyping = opts.onTyping ?? (() => {})
  const onPresence = opts.onPresence ?? (() => {})
  const onReaction = opts.onReaction ?? (() => {})
  const onFile = opts.onFile ?? (() => {})
  const heartbeatMs = opts.heartbeatMs ?? 15_000
  const ttlMs = Math.max(heartbeatMs * 3, 30_000)
  const self = node.peerId.toString()
  const seenNonces = new Set<string>()
  const seenSeq = new Set<string>() // dedup msg/reaction/file by `${from}:${seq}`
  const lastSeen = new Map<string, number>()

  const touch = (peer: string) => {
    const fresh = !lastSeen.has(peer)
    lastSeen.set(peer, nowMs())
    if (fresh) onPresence(peer, 'join')
  }
  const firstSeq = (from: string, seq: number): boolean => {
    const k = `${from}:${seq}`
    if (seenSeq.has(k)) return false
    seenSeq.add(k)
    return true
  }

  const handler = async (evt) => {
    if (evt.detail.topic !== topic) return
    const from = evt.detail.from.toString()

    // sealed envelope? (our encrypted channel)
    const pt = await open(evt.detail.data, keys.msgKey)
    if (pt !== null) {
      if (from === self) return
      const env = decodeEnvelope(pt)
      if (!env) return
      switch (env.t) {
        case 'msg': touch(from); if (firstSeq(from, env.seq)) onMessage(from, env as MsgEnv); break
        case 'reaction': touch(from); if (firstSeq(from, env.seq)) onReaction(from, env as ReactionEnv); break
        case 'file': touch(from); if (firstSeq(from, env.seq)) onFile(from, env as FileEnv); break
        case 'typing': touch(from); onTyping(from, (env as any).state as TypingState); break
        case 'presence': {
          const st = (env as any).state as PresenceState
          if (st === 'leave') { lastSeen.delete(from); onPresence(from, 'leave') }
          else { touch(from); onPresence(from, st) } // 'active' | 'away'
          break
        }
        default: break // unknown type → ignore (forward-compat)
      }
      return
    }

    // not sealed → authenticated Announce (presence/discovery, §5.5)
    const res = await verifyAnnounce(evt.detail.data, keys.macKey)
    if (!res.ok || res.peer === self) return
    if (seenNonces.has(res.nonce!)) return
    seenNonces.add(res.nonce!)
    touch(res.peer!)
  }
  node.services.pubsub.addEventListener('message', handler)
  node.services.pubsub.subscribe(topic)

  const announce = async () => {
    try { await node.services.pubsub.publish(topic, await buildAnnounce(self, keys.macKey)) } catch {}
  }
  const t0 = setTimeout(announce, 1500)
  const hb = setInterval(announce, heartbeatMs)
  const sweep = setInterval(() => {
    const now = nowMs()
    for (const [peer, t] of lastSeen) if (now - t > ttlMs) { lastSeen.delete(peer); onPresence(peer, 'leave') }
  }, Math.min(heartbeatMs, 15_000))

  let seq = 1
  const emit = async (bytes: Uint8Array) => {
    try { await node.services.pubsub.publish(topic, await seal(bytes, keys.msgKey)) } catch {}
  }

  return {
    sendText: (body: string) => emit(encodeEnvelope(envMsg(seq++, body))),
    sendTyping: (state: TypingState) => emit(encodeEnvelope(envTyping(seq++, state))),
    sendPresence: (state: PresenceState) => emit(encodeEnvelope(envPresence(seq++, state))),
    sendReaction: (to: string, emoji: string) => emit(encodeEnvelope(envReaction(seq++, to, emoji))),
    sendFile: (f: FileMeta) => emit(encodeEnvelope(envFile(seq++, f))),
    who: () => [...lastSeen.keys()],
    stop: () => {
      clearTimeout(t0); clearInterval(hb); clearInterval(sweep)
      node.services.pubsub.removeEventListener('message', handler)
      try { node.services.pubsub.unsubscribe(topic) } catch {}
    },
  }
}
