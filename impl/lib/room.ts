/**
 * room.ts — presence + encrypted chat over one rendezvous topic, with a
 * pluggable content data plane.
 *
 *   control plane (GossipSub):  Announce (presence/discovery) + WebRTC signaling
 *   data plane   (settable):    message content — GossipSub by default, or a
 *                               direct WebRTC DataChannel once it's up (§13).
 *
 * Outgoing content: envelope → encode → seal → contentSend (WebRTC or GossipSub).
 * Signaling (t:'rtc') + Announce always ride GossipSub.
 * Incoming (from GossipSub OR the DataChannel): decrypt → decode → dispatch;
 * t:'rtc' routes to onSignal, everything else to the UI callbacks.
 */

import { buildAnnounce, verifyAnnounce } from './announce.ts'
import type { Session } from './session.ts'
import {
  encodeEnvelope, decodeEnvelope, envMsg, envTyping, envPresence, envReaction, envFile, envRtc,
  type MsgEnv, type ReactionEnv, type FileEnv, type FileMeta, type TypingState, type PresenceState, type RtcEnv,
} from './envelope.ts'
import { nowMs } from './time.ts'

export interface RoomKeys { macKey: CryptoKey; session: Session }
export type PresenceEvent = 'join' | 'active' | 'away' | 'leave'
export interface ChatOpts {
  onMessage?: (from: string, m: MsgEnv) => void
  onTyping?: (from: string, state: TypingState) => void
  onPresence?: (from: string, ev: PresenceEvent) => void
  onReaction?: (from: string, r: ReactionEnv) => void
  onFile?: (from: string, f: FileEnv) => void
  onSignal?: (from: string, env: RtcEnv) => void // WebRTC signaling (control plane)
  heartbeatMs?: number
}

export function joinChat(node, topic: string, keys: RoomKeys, opts: ChatOpts = {}) {
  const onMessage = opts.onMessage ?? (() => {})
  const onTyping = opts.onTyping ?? (() => {})
  const onPresence = opts.onPresence ?? (() => {})
  const onReaction = opts.onReaction ?? (() => {})
  const onFile = opts.onFile ?? (() => {})
  const onSignal = opts.onSignal ?? (() => {})
  const heartbeatMs = opts.heartbeatMs ?? 15_000
  const ttlMs = Math.max(heartbeatMs * 3, 30_000)
  const self = node.peerId.toString()
  const seenNonces = new Set<string>()
  const seenSeq = new Set<string>() // dedup msg/reaction/file by `${from}:${seq}` (both planes)
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

  const dispatch = (from: string, env: any) => {
    switch (env.t) {
      case 'msg': touch(from); if (firstSeq(from, env.seq)) onMessage(from, env as MsgEnv); break
      case 'reaction': touch(from); if (firstSeq(from, env.seq)) onReaction(from, env as ReactionEnv); break
      case 'file': touch(from); if (firstSeq(from, env.seq)) onFile(from, env as FileEnv); break
      case 'typing': touch(from); onTyping(from, env.state as TypingState); break
      case 'presence': {
        const st = env.state as PresenceState
        if (st === 'leave') { lastSeen.delete(from); onPresence(from, 'leave') }
        else { touch(from); onPresence(from, st) } // 'active' | 'away'
        break
      }
      case 'rtc': onSignal(from, env as RtcEnv); break
      default: break // unknown type → ignore (forward-compat)
    }
  }

  // decrypt + decode + dispatch a sealed frame (from GossipSub OR the DataChannel)
  const processSealed = async (data: Uint8Array, from: string): Promise<boolean> => {
    const pt = await keys.session.decrypt(data)
    if (pt === null) return false
    if (from !== self) { const env = decodeEnvelope(pt); if (env) dispatch(from, env) }
    return true
  }

  const handler = async (evt) => {
    if (evt.detail.topic !== topic) return
    const from = evt.detail.from.toString()
    if (await processSealed(evt.detail.data, from)) return
    // not sealed → authenticated Announce (presence/discovery, §5.5)
    const res = await verifyAnnounce(evt.detail.data, keys.macKey)
    if (!res.ok || res.peer === self) return
    if (seenNonces.has(res.nonce!)) return
    seenNonces.add(res.nonce!)
    touch(res.peer!)
  }
  node.services.pubsub.addEventListener('message', handler)
  node.services.pubsub.subscribe(topic)

  const gossip = (bytes: Uint8Array) => { node.services.pubsub.publish(topic, bytes).catch(() => {}) }
  const announce = async () => { try { gossip(await buildAnnounce(self, keys.macKey)) } catch {} }
  const t0 = setTimeout(announce, 1500)
  const hb = setInterval(announce, heartbeatMs)
  const sweep = setInterval(() => {
    const now = nowMs()
    for (const [peer, t] of lastSeen) if (now - t > ttlMs) { lastSeen.delete(peer); onPresence(peer, 'leave') }
  }, Math.min(heartbeatMs, 15_000))

  // data plane: content is sealed then sent here — GossipSub by default, or a
  // direct WebRTC DataChannel once the browser upgrader sets it (§13).
  const gossipContent = (sealed: Uint8Array) => gossip(sealed)
  let contentSend: (sealed: Uint8Array) => void = gossipContent

  let seq = 1
  const emitContent = async (bytes: Uint8Array) => { try { contentSend(await keys.session.encrypt(bytes)) } catch {} }
  const emitGossip = async (bytes: Uint8Array) => { try { gossip(await keys.session.encrypt(bytes)) } catch {} }

  return {
    sendText: (body: string) => emitContent(encodeEnvelope(envMsg(seq++, body))),
    sendTyping: (state: TypingState) => emitContent(encodeEnvelope(envTyping(seq++, state))),
    sendPresence: (state: PresenceState) => emitContent(encodeEnvelope(envPresence(seq++, state))),
    sendReaction: (to: string, emoji: string) => emitContent(encodeEnvelope(envReaction(seq++, to, emoji))),
    sendFile: (f: FileMeta) => emitContent(encodeEnvelope(envFile(seq++, f))),
    // WebRTC signaling — always over GossipSub (the DataChannel isn't up yet)
    sendSignal: (to: string, sig: any) => emitGossip(encodeEnvelope(envRtc(seq++, to, sig))),
    // data-plane hooks used by the browser WebRTC upgrader
    setContentSend: (fn: ((sealed: Uint8Array) => void) | null) => { contentSend = fn ?? gossipContent },
    injectContent: (sealed: Uint8Array, from: string) => { void processSealed(sealed, from) },
    who: () => [...lastSeen.keys()],
    stop: () => {
      clearTimeout(t0); clearInterval(hb); clearInterval(sweep)
      node.services.pubsub.removeEventListener('message', handler)
      try { node.services.pubsub.unsubscribe(topic) } catch {}
    },
  }
}
