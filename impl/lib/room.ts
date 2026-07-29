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
  /** Give up on a silent attempt and start a new one after this long. */
  attemptTimeoutMs?: number
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
    if (fresh) {
      onPresence(peer, 'join')
      // Answer a newcomer at once instead of making it wait for our heartbeat:
      // discovery has to be mutual before the lower id can open the handshake.
      void announce()
    }
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
        if (st === 'leave') { lastSeen.delete(from); forgetPeer(from); onPresence(from, 'leave') }
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
  /** `h` is null only for the moment between reserving the slot and having keys. */
  interface Attempt { h: Eh2Handshake | null; role: 'initiator' | 'responder'; startedAt: number }
  const handshakes = new Map<string, Attempt>()
  /** Peers whose attempt died: we may open the next one even if we are the higher id. */
  const stuck = new Set<string>()
  const queued: Uint8Array[] = []
  const eh2 = keys.eh2
  const maxQueued = eh2?.maxQueued ?? 32

  const sessionFor = (peer: string): Session | undefined => (eh2 ? sessions.get(peer) : keys.session)

  /**
   * An attempt can simply be lost — the GossipSub mesh takes seconds to form
   * and the frames are fire-and-forget. So an attempt that produces nothing is
   * abandoned after this long and started over, rather than pending forever.
   */
  const attemptTimeoutMs = eh2?.attemptTimeoutMs ?? 6_000
  /** How often the opening frame is repeated while an attempt waits for a reply. */
  const resendMs = Math.max(100, Math.min(700, Math.floor(attemptTimeoutMs / 4)))
  const attemptTimers = new Map<string, any>()
  const resendTimers = new Map<string, any>()

  const clearAttempt = (peer: string) => {
    clearTimeout(attemptTimers.get(peer))
    clearInterval(resendTimers.get(peer))
    attemptTimers.delete(peer)
    resendTimers.delete(peer)
    handshakes.delete(peer)
  }

  /** A peer that left takes its ratchet with it — a new visit re-handshakes. */
  const forgetPeer = (peer: string) => {
    clearAttempt(peer)
    sessions.delete(peer)
    stuck.delete(peer)
  }

  const beginHandshake = async (peer: string, role: 'initiator' | 'responder'): Promise<Attempt | null> => {
    if (!eh2) return null
    clearAttempt(peer) // a fresh attempt always replaces the previous one
    // Reserve the slot BEFORE the first await: generating the ephemerals takes
    // a tick, and two Announces arriving back to back would otherwise both pass
    // the "already handshaking?" check and start two handshakes.
    const attempt: Attempt = { h: null, role, startedAt: nowMs() }
    handshakes.set(peer, attempt)
    try {
      const h = await startHandshake({ role, ik: eh2.ik, peerIkPub: eh2.peerIkPub, ratchet: eh2.ratchet })
      if (handshakes.get(peer) !== attempt) return null // superseded while we generated keys
      attempt.h = h
      eh2.onState?.(peer, 'handshaking')
      h.session.then(
        (s) => {
          if (handshakes.get(peer) !== attempt) return // superseded by a newer attempt
          clearAttempt(peer)
          stuck.delete(peer)
          sessions.set(peer, s)
          eh2.onState?.(peer, 'established')
          void flushQueued()
        },
        () => {
          if (handshakes.get(peer) !== attempt) return
          clearAttempt(peer)
          giveUp(peer)
        },
      )
      const timer = setTimeout(() => {
        if (handshakes.get(peer) !== attempt) return
        clearAttempt(peer)
        giveUp(peer)
      }, attemptTimeoutMs)
      ;(timer as any).unref?.()
      attemptTimers.set(peer, timer)
      for (const f of h.initial) gossip(f)

      // The first frames often go out while the peer's GossipSub mesh is still
      // grafting, so they reach nobody — visible as a handshake that only
      // completes on the next full attempt seconds later. Re-send the opening
      // frame a few times instead: it is cheap, and a msg1 that arrives twice
      // simply restarts the responder, which is already the defined behaviour.
      if (h.initial.length) {
        let resends = 0
        const resend = setInterval(() => {
          if (handshakes.get(peer) !== attempt || ++resends > 3) { clearInterval(resend); return }
          for (const f of h.initial) gossip(f)
        }, resendMs)
        ;(resend as any).unref?.()
        resendTimers.set(peer, resend)
      }
      return attempt
    } catch {
      if (handshakes.get(peer) === attempt) clearAttempt(peer)
      return null
    }
  }

  /**
   * An attempt died (timed out or a frame failed to verify). If the peer is
   * still around and we have no session, try again — and from now on we are
   * willing to be the initiator regardless of the id tie-break.
   *
   * That last part matters for the one case the tie-break cannot fix: a lost
   * msg3 leaves the INITIATOR with a session and the responder with nothing,
   * so the responder is the only side that knows something is wrong, and it is
   * the higher id. The jitter keeps two simultaneously-stuck peers from
   * retrying in lockstep.
   */
  const giveUp = (peer: string) => {
    if (!eh2 || sessions.has(peer)) return
    eh2.onState?.(peer, 'failed')
    stuck.add(peer)
    if (!lastSeen.has(peer)) return
    const t = setTimeout(() => maybeHandshake(peer), 200 + Math.floor(Math.random() * 1200))
    ;(t as any).unref?.()
  }

  /** Seen a peer: open the handshake if it is our turn (idempotent). */
  const maybeHandshake = (peer: string) => {
    if (!eh2 || peer === self || sessions.has(peer) || handshakes.has(peer)) return
    if (self < peer || stuck.has(peer)) void beginHandshake(peer, 'initiator')
  }

  const onHandshakeFrame = async (data: Uint8Array, from: string): Promise<void> => {
    if (!eh2 || from === self) return
    let attempt = handshakes.get(from)
    if (data[0] === T_MSG1) {
      // Their msg1 crossed our fresh one: the lower id holds its ground, the
      // higher yields — deterministic, so exactly one side backs down.
      const mine = attempt
      if (mine?.role === 'initiator' && self < from && nowMs() - mine.startedAt < 2_000) return
      // Otherwise a msg1 always starts a fresh responder attempt: the peer may
      // have reloaded, retried after a lost frame, or rotated its PeerId.
      // Accepting it is safe even with a live session — the session is only
      // replaced once msg3 verifies, which needs the peer's real IK.
      attempt = (await beginHandshake(from, 'responder')) ?? undefined
    } else if (!attempt) return // stray msg2/msg3 with no attempt of ours → ignore
    if (!attempt?.h) return
    try {
      const reply = await attempt.h.feed(data)
      if (reply) gossip(reply)
    } catch { /* the attempt is already gone; giveUp() schedules the next one */ }
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

  // The first Announce cannot go out before the relay has joined our topic —
  // published earlier it reaches nobody. Rather than guess a delay (the old
  // fixed 1.5 s, while the relay actually shows up in ~0.5 s), watch for it and
  // announce the moment it is there. Everything downstream — presence, and with
  // it the EH-2 handshake — starts a full second sooner. The timeout stays as a
  // floor for transports that cannot report subscribers (e.g. test doubles).
  const firstAnnounceMs = opts.firstAnnounceMs ?? 1500
  let announced = false
  const announceFirst = () => {
    if (announced) return
    announced = true
    clearInterval(t0)
    void announce()
    // A single announce is easy to miss: a peer that joins a moment later never
    // sees it, and one sent while that peer's mesh is still grafting is simply
    // dropped — either way discovery stalls until the next 15 s heartbeat.
    // A few early repeats (tiny frames) close that window.
    for (const delay of [1_000, 3_000, 7_000]) {
      const t = setTimeout(() => void announce(), delay)
      ;(t as any).unref?.()
      earlyBeacons.push(t)
    }
  }
  const earlyBeacons: any[] = []
  const startedAt = nowMs()
  const t0 = setInterval(() => {
    let meshReady = false
    try { meshReady = node.services.pubsub.getSubscribers(topic).length > 0 } catch {}
    if (meshReady || nowMs() - startedAt >= firstAnnounceMs) announceFirst()
  }, Math.max(10, Math.min(50, firstAnnounceMs)))
  const hb = setInterval(announce, heartbeatMs)
  const sweep = setInterval(() => {
    const now = nowMs()
    for (const [peer, t] of lastSeen) if (now - t > ttlMs) { lastSeen.delete(peer); forgetPeer(peer); onPresence(peer, 'leave') }
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
      clearInterval(t0); clearInterval(hb); clearInterval(sweep)
      for (const t of earlyBeacons) clearTimeout(t)
      node.services.pubsub.removeEventListener('message', handler)
      try { node.services.pubsub.unsubscribe(topic) } catch {}
    },
  }
}
