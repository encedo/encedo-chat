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
import type { Dh } from './x25519.ts'
import type { RatchetOpts } from '../eh2/ratchet.ts'
import { startHandshake, isHandshakeFrame, type Eh2Handshake } from '../eh2/establish.ts'
import { T_MSG1 } from '../eh2/wire.ts'
import {
  encodeEnvelope, decodeEnvelope, envMsg, envTyping, envPresence, envReaction, envFile, envRtc,
  type MsgEnv, type ReactionEnv, type FileEnv, type FileMeta, type TypingState, type PresenceState, type RtcEnv,
} from './envelope.ts'
import { nowMs } from './time.ts'

/**
 * EH-2 mode (docs/PROTOCOL.md §6–7). When present, content is sealed by a
 * per-peer ratchet established over this topic instead of by a static key:
 *
 *   - the three handshake frames travel UNSEALED on the control plane (they
 *     have to — the session key is what they produce), authenticated by their
 *     own MACs, not by the Announce key;
 *   - who initiates is decided by peer id (lower initiates), the same tie-break
 *     the WebRTC plane uses, so two peers never cross;
 *   - content typed before the handshake finishes is queued, not dropped.
 */
export interface Eh2Options {
  /** Our long-term identity key (HEM IK in production). */
  ik: Dh
  /** The peer's IK public — from the contact book. */
  peerIkPub: Uint8Array
  onState?: (peer: string, state: 'handshaking' | 'established' | 'failed') => void
  ratchet?: RatchetOpts
  /** Max plaintext frames held while the handshake runs. */
  maxQueued?: number
}

/** Exactly one of `session` (interim static key) or `eh2` is used for content. */
export interface RoomKeys { macKey: CryptoKey; session?: Session; eh2?: Eh2Options }
export type PresenceEvent = 'join' | 'active' | 'away' | 'leave'
export interface ChatOpts {
  onMessage?: (from: string, m: MsgEnv) => void
  onTyping?: (from: string, state: TypingState) => void
  onPresence?: (from: string, ev: PresenceEvent) => void
  onReaction?: (from: string, r: ReactionEnv) => void
  onFile?: (from: string, f: FileEnv) => void
  onSignal?: (from: string, env: RtcEnv) => void // WebRTC signaling (control plane)
  heartbeatMs?: number
  /** Delay before the first Announce (tests shorten it; the mesh needs a moment). */
  firstAnnounceMs?: number
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
    maybeHandshake(peer) // [EH-2 seam] — no-op unless keys.eh2 is set
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

  // ---- [EH-2 seam] --------------------------------------------------------
  // With `keys.eh2` set, each peer gets its own handshake and its own ratchet;
  // without it the room keeps using the interim static key (`keys.session`).
  const sessions = new Map<string, Session>()
  const handshakes = new Map<string, Eh2Handshake>()
  const queued: Uint8Array[] = []
  const eh2 = keys.eh2
  const maxQueued = eh2?.maxQueued ?? 32

  const sessionFor = (peer: string): Session | undefined => (eh2 ? sessions.get(peer) : keys.session)

  const beginHandshake = async (peer: string, role: 'initiator' | 'responder'): Promise<Eh2Handshake | null> => {
    if (!eh2) return null
    try {
      const h = await startHandshake({ role, ik: eh2.ik, peerIkPub: eh2.peerIkPub, ratchet: eh2.ratchet })
      handshakes.set(peer, h)
      eh2.onState?.(peer, 'handshaking')
      h.session.then(
        (s) => {
          sessions.set(peer, s)
          handshakes.delete(peer)
          eh2.onState?.(peer, 'established')
          void flushQueued()
        },
        () => { handshakes.delete(peer); eh2.onState?.(peer, 'failed') }, // retried on the next Announce
      )
      for (const f of h.initial) gossip(f)
      return h
    } catch { return null }
  }

  /** Seen a peer: if we are the lower id, open the handshake (idempotent). */
  const maybeHandshake = (peer: string) => {
    if (!eh2 || peer === self || sessions.has(peer) || handshakes.has(peer)) return
    if (self < peer) void beginHandshake(peer, 'initiator')
  }

  const onHandshakeFrame = async (data: Uint8Array, from: string): Promise<void> => {
    if (!eh2 || from === self) return
    let h = handshakes.get(from)
    if (!h) {
      if (data[0] !== T_MSG1 || sessions.has(from)) return // stray frame, or a peer racing us
      h = await beginHandshake(from, 'responder')
      if (!h) return
    }
    try {
      const reply = await h.feed(data)
      if (reply) gossip(reply)
    } catch { /* the failure already moved the state; a retry starts on the next Announce */ }
  }

  const flushQueued = async () => {
    if (!queued.length || !sessions.size) return
    const pending = queued.splice(0, queued.length)
    for (const bytes of pending) await emitContent(bytes)
  }

  // decrypt + decode + dispatch a sealed frame (from GossipSub OR the DataChannel)
  const processSealed = async (data: Uint8Array, from: string): Promise<boolean> => {
    const s = sessionFor(from)
    if (!s) return false
    const pt = await s.decrypt(data)
    if (pt === null) return false
    if (from !== self) { const env = decodeEnvelope(pt); if (env) dispatch(from, env) }
    return true
  }

  const handler = async (evt) => {
    if (evt.detail.topic !== topic) return
    const from = evt.detail.from.toString()
    if (eh2 && isHandshakeFrame(evt.detail.data)) { await onHandshakeFrame(evt.detail.data, from); return }
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
  const t0 = setTimeout(announce, opts.firstAnnounceMs ?? 1500)
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
  /**
   * Seal and send. In EH-2 mode there is one ratchet per peer, so the frame is
   * sealed once per established session; anything typed before the handshake
   * completes waits in `queued` (bounded) rather than being lost.
   */
  const emitContent = async (bytes: Uint8Array) => {
    if (eh2) {
      if (!sessions.size) { if (queued.length < maxQueued) queued.push(bytes); return }
      for (const s of sessions.values()) { try { contentSend(await s.encrypt(bytes)) } catch {} }
      return
    }
    try { contentSend(await keys.session!.encrypt(bytes)) } catch {}
  }
  const emitGossip = async (bytes: Uint8Array) => {
    if (eh2) {
      for (const s of sessions.values()) { try { gossip(await s.encrypt(bytes)) } catch {} }
      return
    }
    try { gossip(await keys.session!.encrypt(bytes)) } catch {}
  }

  return {
    sendText: (body: string) => { const e = envMsg(seq++, body); void emitContent(encodeEnvelope(e)); return e.id }, // returns msg id (for reactions)
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
    /** Peers with a live EH-2 ratchet (empty in interim mode) — for the UI badge. */
    secured: () => (eh2 ? [...sessions.keys()] : []),
    stop: () => {
      sessions.clear(); handshakes.clear(); queued.length = 0
      clearTimeout(t0); clearInterval(hb); clearInterval(sweep)
      node.services.pubsub.removeEventListener('message', handler)
      try { node.services.pubsub.unsubscribe(topic) } catch {}
    },
  }
}
