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
  encodeEnvelope, decodeEnvelope, envMsg, envTyping, envPresence, envReaction, envFile, envRtc, envAck,
  type MsgEnv, type ReactionEnv, type FileEnv, type FileMeta, type TypingState, type PresenceState, type RtcEnv, type AckEnv,
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
  /**
   * The one peer in this pair room now answers to a different PeerId (it
   * reloaded, or its transport restarted) — `old` is dead, `now` is live.
   * Anything holding per-PeerId state, the WebRTC plane above all, has to move.
   */
  onPeerReplaced?: (old: string, now: string) => void
  /** The peer's client confirmed it holds this message (`ms` = time in flight). */
  onDelivered?: (id: string, ms: number) => void
  /** Gave up after retrying: the peer very likely never got it. */
  onUndelivered?: (id: string) => void
  /**
   * A message went unconfirmed long enough to be re-sent. The transport we are
   * using may be the problem, so this is the moment to stop trusting it — the
   * data plane owner (core) drops back to the relay before the retry goes out.
   */
  onStall?: () => void
  heartbeatMs?: number
  /** Delay before the first Announce (tests shorten it; the mesh needs a moment). */
  firstAnnounceMs?: number
  /** Delays before each re-send of unconfirmed content (tests shorten these). */
  retryMs?: number[]
  /** After the last re-send, how long to wait for a confirmation before ⚠. */
  giveUpMs?: number
  /** Hard cap on how long one message may keep being re-sent, however present the peer looks. */
  maxInflightMs?: number
  /**
   * Where this room narrates itself. The engine has no console of its own —
   * the web app sends this to the browser console, the CLI ignores it. `debug`
   * lines are per-frame and only interesting when something is wrong.
   */
  onLog?: (msg: string, level?: 'info' | 'debug') => void
}

export function joinChat(node, topic: string, keys: RoomKeys, opts: ChatOpts = {}) {
  const log = opts.onLog ?? (() => {})
  const dbg = (m: string) => log(m, 'debug')
  const short = (s: string) => s.slice(0, 12) + '…'
  const onMessage = opts.onMessage ?? (() => {})
  const onTyping = opts.onTyping ?? (() => {})
  const onPresence = opts.onPresence ?? (() => {})
  const onReaction = opts.onReaction ?? (() => {})
  const onFile = opts.onFile ?? (() => {})
  const onSignal = opts.onSignal ?? (() => {})
  const onDelivered = opts.onDelivered ?? (() => {})
  const onUndelivered = opts.onUndelivered ?? (() => {})
  const onStall = opts.onStall ?? (() => {})
  const onPeerReplaced = opts.onPeerReplaced ?? (() => {})
  const heartbeatMs = opts.heartbeatMs ?? 15_000
  // Be generous: a browser throttles timers in a hidden tab (Firefox to about
  // once a minute), so a peer that is merely in a background window must not
  // look dead. This is a presence heuristic, nothing security-relevant.
  const ttlMs = Math.max(heartbeatMs * 6, 90_000)
  const self = node.peerId.toString()
  const seenNonces = new Set<string>()
  const seenSeq = new Set<string>() // dedup msg/reaction/file by `${from}:${seq}` (both planes)
  const lastSeen = new Map<string, number>()

  const touch = (peer: string) => {
    const fresh = !lastSeen.has(peer)
    lastSeen.set(peer, nowMs())
    if (fresh) {
      log(`peer visible: ${short(peer)}`)
      onPresence(peer, 'join')
      // Answer a newcomer at once instead of making it wait for our heartbeat:
      // discovery has to be mutual before the lower id can open the handshake.
      void announce()
    }
    maybeHandshake(peer) // [EH-2 seam] — no-op unless keys.eh2 is set
  }
  /**
   * Delivery confirmation (§ envelope `ack`). Content rides GossipSub once and
   * is not retransmitted by the transport, so a dropped frame is a message that
   * silently never happened. The receiver acks what it hands to the UI; the
   * sender re-sends the SAME envelope (same id and seq, so the peer's dedup
   * makes a duplicate invisible) and gives up after the last try.
   *
   * Instant-only product: this is "arrived", never "read".
   */
  /**
   * The first budget here (1.5 s + 4 s, then 4 s to judge) was shorter than the
   * outages this transport actually produces. A hidden tab's throttled timers,
   * or a GossipSub mesh re-grafting, go quiet for ~10 s — long enough to burn
   * every re-send — and a healthy conversation was stamping messages ⚠ while
   * the peer was merely mid-gap, answering again seconds later. So the backoff
   * now runs for as long as the peer is still announcing itself; only a peer
   * that has genuinely gone quiet, or the hard cap, ends it.
   */
  const RETRIES = opts.retryMs ?? [1_500, 4_000, 8_000, 15_000, 15_000] // delays before each RE-send
  const GIVE_UP_MS = opts.giveUpMs ?? 8_000       // …then this long for the confirmation to arrive
  const MAX_INFLIGHT_MS = opts.maxInflightMs ?? 60_000 // hard cap, however present the peer looks
  /** Re-sending is pointless with nobody in the room to receive it. */
  const peerPresent = () => lastSeen.size > 0
  interface Pending { bytes: Uint8Array; sentAt: number; tries: number; timer: any }
  const pending = new Map<string, Pending>()
  /** Peers known to send acks. A client that predates them must not be marked ⚠. */
  const acking = new Set<string>()

  /**
   * Content we gave up on, kept so the user can send it again by hand (the ↻ in
   * the UI). The envelope is reused verbatim — same id, same seq — so a peer
   * that did get the first copy silently dedups it, and an ack lands on the
   * marker the user is already looking at.
   */
  const MAX_RESENDABLE = 50
  const resendable = new Map<string, Uint8Array>()
  const keepForResend = (id: string, bytes: Uint8Array) => {
    resendable.set(id, bytes)
    if (resendable.size > MAX_RESENDABLE) resendable.delete(resendable.keys().next().value as string)
  }

  const clearPending = (id: string) => {
    const p = pending.get(id)
    if (p) { clearTimeout(p.timer); pending.delete(id) }
  }

  const armRetry = (id: string) => {
    const p = pending.get(id)
    if (!p) return
    const waited = nowMs() - p.sentAt
    const delay = RETRIES[p.tries]
    // The first two tries are unconditional — a peer that vanished mid-sentence
    // still deserves them. Past that, re-sending only makes sense while someone
    // is there to receive it, and never beyond the cap.
    const keepTrying = delay !== undefined && waited + delay <= MAX_INFLIGHT_MS && (p.tries < 2 || peerPresent())
    if (!keepTrying) {
      // Out of re-sends. Keep waiting a little longer before judging: the last
      // copy is still in flight, and the confirmation for it arrives after it,
      // not with it.
      p.timer = setTimeout(() => {
        if (!pending.has(id)) return
        pending.delete(id)
        // Only complain about peers we know DO confirm; silence from a client
        // that predates acks means "old build", not "lost message".
        if ([...lastSeen.keys()].some((peer) => acking.has(peer))) {
          log(`no confirmation for message ${id} after ${p.tries + 1} sends over ${Math.round((nowMs() - p.sentAt) / 1000)}s → marking undelivered`)
          keepForResend(id, p.bytes)
          onUndelivered(id)
        }
      }, GIVE_UP_MS)
      ;(p.timer as any).unref?.()
      return
    }
    p.timer = setTimeout(() => {
      if (!pending.has(id)) return
      p.tries++
      dbg(`no ack for ${id} in ${delay} ms → re-sending (try ${p.tries + 1})`)
      // Only the DIRECT path loses its turn. A frame dropped on GossipSub is
      // ordinary (it is fire-and-forget, and that is what the retry is for) —
      // banning WebRTC for the rest of the conversation because the relay
      // hiccuped would punish the wrong transport.
      if (p.tries === 1 && contentSend !== gossipContent) { log('unconfirmed on the direct path — falling back to the relay'); onStall() }
      void emitContent(p.bytes)
      armRetry(id)
    }, delay)
    ;(p.timer as any).unref?.()
  }

  /** Confirm a piece of content we just handed to the UI. */
  const confirm = (ref: string) => emitContent(encodeEnvelope(envAck(seq++, ref)))

  /** Track an outgoing content envelope until the peer confirms it. */
  const trackDelivery = (id: string, bytes: Uint8Array) => {
    pending.set(id, { bytes, sentAt: nowMs(), tries: 0, timer: null })
    armRetry(id)
  }

  const firstSeq = (from: string, seq: number): boolean => {
    const k = `${from}:${seq}`
    if (seenSeq.has(k)) return false
    seenSeq.add(k)
    return true
  }

  const dispatch = (from: string, env: any) => {
    switch (env.t) {
      case 'msg':
        touch(from)
        void confirm(env.id) // even for a duplicate: the first ack may be what got lost
        if (firstSeq(from, env.seq)) onMessage(from, env as MsgEnv)
        break
      case 'reaction': touch(from); if (firstSeq(from, env.seq)) onReaction(from, env as ReactionEnv); break
      case 'file':
        touch(from)
        void confirm(env.id)
        if (firstSeq(from, env.seq)) onFile(from, env as FileEnv)
        break
      case 'typing': touch(from); onTyping(from, env.state as TypingState); break
      case 'presence': {
        const st = env.state as PresenceState
        if (st === 'leave') { lastSeen.delete(from); forgetPeer(from); onPresence(from, 'leave') }
        else { touch(from); onPresence(from, st) } // 'active' | 'away'
        break
      }
      case 'rtc': onSignal(from, env as RtcEnv); break
      case 'ack': {
        touch(from)
        acking.add(from)
        const a = env as AckEnv
        const p = pending.get(a.ref)
        if (p) { clearPending(a.ref); resendable.delete(a.ref); onDelivered(a.ref, nowMs() - p.sentAt) }
        break
      }
      default: break // unknown type → ignore (forward-compat)
    }
  }

  // ---- [EH-2 seam] --------------------------------------------------------
  // With `keys.eh2` set, each peer gets its own handshake and its own ratchet;
  // without it the room keeps using the interim static key (`keys.session`).
  const sessions = new Map<string, Session>()
  /** `h` is null only for the moment between reserving the slot and having keys. */
  interface Attempt {
    h: Eh2Handshake | null
    role: 'initiator' | 'responder'
    startedAt: number
    /** Responder: the msg1 this attempt answers, and the msg2 it answered with. */
    msg1?: Uint8Array
    reply?: Uint8Array
  }
  const sameBytes = (a?: Uint8Array, b?: Uint8Array) =>
    !!a && !!b && a.length === b.length && a.every((v, i) => v === b[i])
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
    acking.delete(peer)
  }

  /**
   * A pair topic has exactly one other person in it, so a second live session
   * means the same person came back under a new PeerId — a page reload, or a
   * transport that restarted. The previous identity is then a corpse that still
   * costs us: `emitContent` seals for **every** session, so each message goes out
   * twice and the copy under the dead ratchet is garbage the peer logs as an
   * "undecodable frame". Its presence entry is worse than useless too — the
   * delivery budget reads it as "the peer is still announcing".
   *
   * Retire it the moment the replacement is live. No `leave` event goes to the
   * UI: the person did not leave, their PeerId changed, and telling the UI
   * otherwise would flip the badge to "gone" exactly when they came back.
   */
  const retireOtherPeers = (keep: string) => {
    for (const old of [...sessions.keys()]) {
      if (old === keep) continue
      log(`${short(old)} came back as ${short(keep)} → retiring the old session (reload or transport restart)`)
      forgetPeer(old)
      lastSeen.delete(old)
      onPeerReplaced(old, keep)
    }
  }

  const beginHandshake = async (peer: string, role: 'initiator' | 'responder', msg1?: Uint8Array): Promise<Attempt | null> => {
    if (!eh2) return null
    clearAttempt(peer) // a fresh attempt always replaces the previous one
    // Reserve the slot BEFORE the first await: generating the ephemerals takes
    // a tick, and two Announces arriving back to back would otherwise both pass
    // the "already handshaking?" check and start two handshakes.
    const attempt: Attempt = { h: null, role, startedAt: nowMs(), msg1 }
    handshakes.set(peer, attempt)
    try {
      const h = await startHandshake({ role, ik: eh2.ik, peerIkPub: eh2.peerIkPub, ratchet: eh2.ratchet })
      if (handshakes.get(peer) !== attempt) return null // superseded while we generated keys
      attempt.h = h
      log(`EH-2 ${role} attempt → ${short(peer)}`)
      eh2.onState?.(peer, 'handshaking')
      h.session.then(
        (s) => {
          if (handshakes.get(peer) !== attempt) return // superseded by a newer attempt
          clearAttempt(peer)
          stuck.delete(peer)
          sessions.set(peer, s)
          retireOtherPeers(peer)
          log(`EH-2 established with ${short(peer)} (${role}) — ratchet live, ${queued.length} queued frame(s) to flush`)
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
    log(`EH-2 attempt with ${short(peer)} gave up — will retry`)
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
      // A REPEAT of the msg1 we are already answering (the initiator re-sends
      // it while waiting). Restarting here would be a bug with a very visible
      // symptom: the initiator completes against our first msg2, we would have
      // moved to a new EK_r, and its msg3 would fail mac_i — the pair loops
      // "established → handshaking" forever. Answer with the SAME msg2 instead.
      if (attempt?.role === 'responder' && sameBytes(attempt.msg1, data)) {
        dbg(`msg1 repeat from ${short(from)} → re-sending the same msg2`)
        if (attempt.reply) gossip(attempt.reply)
        return
      }
      // Their msg1 crossed our fresh one: the lower id holds its ground, the
      // higher yields — deterministic, so exactly one side backs down.
      const mine = attempt
      if (mine?.role === 'initiator' && self < from && nowMs() - mine.startedAt < 2_000) return
      // Otherwise a NEW msg1 starts a fresh responder attempt: the peer may
      // have reloaded, retried after a lost frame, or rotated its PeerId.
      // Accepting it is safe even with a live session — the session is only
      // replaced once msg3 verifies, which needs the peer's real IK.
      attempt = (await beginHandshake(from, 'responder', data)) ?? undefined
    } else if (!attempt) return // stray msg2/msg3 with no attempt of ours → ignore
    if (!attempt?.h) return
    try {
      const reply = await attempt.h.feed(data)
      if (reply) { attempt.reply = reply; gossip(reply) }
    } catch { /* the attempt is already gone; giveUp() schedules the next one */ }
  }

  const flushQueued = async () => {
    if (!queued.length || !sessions.size) return
    const pending = queued.splice(0, queued.length)
    for (const bytes of pending) await emitContent(bytes)
  }

  /**
   * A frame we could neither open as content nor authenticate as an Announce.
   * Silence here is what made a two-browser stall impossible to diagnose: an
   * undecryptable frame left no trace at all, so "the ratchet desynced" and
   * "the transport died" produced identical logs — nothing in either. Rate
   * limited, because a real desync makes every frame arrive like this.
   */
  let undecodable = 0
  let undecodableAt = 0
  const noteUndecodable = (from: string, bytes: number) => {
    undecodable++
    const t = nowMs()
    if (undecodable > 1 && t - undecodableAt < 10_000) return
    undecodableAt = t
    log(`undecodable frame from ${short(from)} (${bytes} B) — opens as neither content nor Announce; ${undecodable} so far`)
  }

  // decrypt + decode + dispatch a sealed frame (from GossipSub OR the DataChannel)
  const processSealed = async (data: Uint8Array, from: string): Promise<boolean> => {
    const s = sessionFor(from)
    if (!s) return false
    const pt = await s.decrypt(data)
    if (pt === null) return false
    if (from !== self) {
      const env = decodeEnvelope(pt)
      dbg(`← content ${data.length} B from ${short(from)} → ${env ? (env as any).t : 'undecodable'}`)
      if (env) dispatch(from, env)
    }
    return true
  }

  const handler = async (evt) => {
    if (evt.detail.topic !== topic) return
    const from = evt.detail.from.toString()
    if (eh2 && isHandshakeFrame(evt.detail.data)) {
      dbg(`← msg${evt.detail.data[0]} from ${short(from)} (${evt.detail.data.length} B)`)
      await onHandshakeFrame(evt.detail.data, from)
      return
    }
    if (await processSealed(evt.detail.data, from)) return
    // not sealed → authenticated Announce (presence/discovery, §5.5)
    const res = await verifyAnnounce(evt.detail.data, keys.macKey)
    if (!res.ok) { noteUndecodable(from, evt.detail.data.length); return }
    if (res.peer === self) return
    if (seenNonces.has(res.nonce!)) return
    seenNonces.add(res.nonce!)
    // Announces are the one thing that keeps flowing when content stops, so say
    // so: "the transport is alive but nothing decrypts" and "the transport is
    // gone" are different failures, and they used to produce the same log.
    dbg(`← announce from ${short(res.peer!)}`)
    touch(res.peer!)
  }
  node.services.pubsub.addEventListener('message', handler)
  node.services.pubsub.subscribe(topic)
  log(`joined topic ${topic.slice(0, 12)}… as ${short(self)} (${eh2 ? 'EH-2' : 'interim key'})`)

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
    if (meshReady || nowMs() - startedAt >= firstAnnounceMs) {
      log(meshReady
        ? `relay joined the topic after ${nowMs() - startedAt} ms → announcing`
        : `no subscriber report after ${firstAnnounceMs} ms → announcing anyway`)
      announceFirst()
    }
  }, Math.max(10, Math.min(50, firstAnnounceMs)))
  const hb = setInterval(announce, heartbeatMs)
  const sweep = setInterval(() => {
    const now = nowMs()
    // NOTE: silence drops presence, NOT the ratchet. Tearing the session down
    // on a guess is how a throttled background tab turned into "the badge is
    // green but nothing sends" — the peer was still there, we had thrown its
    // keys away. An actual leave (below) does clear it; so does a new handshake.
    for (const [peer, t] of lastSeen) if (now - t > ttlMs) {
      lastSeen.delete(peer)
      log(`no Announce from ${short(peer)} for ${Math.round((now - t) / 1000)}s → presence off (ratchet kept)`)
      onPresence(peer, 'leave')
    }
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
      if (!sessions.size) {
        if (queued.length < maxQueued) { queued.push(bytes); dbg(`no session yet → queued (${queued.length})`) }
        else log('queue full — dropping outgoing frame')
        return
      }
      for (const s of sessions.values()) {
        try { const sealed = await s.encrypt(bytes); dbg(`→ content ${sealed.length} B via ${contentSend === gossipContent ? 'relay' : 'WebRTC'}`); contentSend(sealed) }
        catch (e: any) { log(`send failed: ${e?.message ?? e}`) }
      }
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
    sendText: (body: string) => {
      const e = envMsg(seq++, body)
      const bytes = encodeEnvelope(e)
      void emitContent(bytes)
      trackDelivery(e.id, bytes) // resend until the peer confirms, then mark it
      return e.id // the UI keys its ✓ / ⚠ off this
    },
    /**
     * Send a given-up message again, by hand. Keeps the original id, so the ✓/⚠
     * marker the user is looking at is the one that updates. Returns false if
     * there is nothing to resend (unknown id) or a try is already in flight.
     */
    resend: (id: string) => {
      const bytes = resendable.get(id)
      if (!bytes || pending.has(id)) return false
      log(`resending ${id} by hand`)
      void emitContent(bytes)
      trackDelivery(id, bytes)
      return true
    },
    sendTyping: (state: TypingState) => emitContent(encodeEnvelope(envTyping(seq++, state))),
    sendPresence: (state: PresenceState) => emitContent(encodeEnvelope(envPresence(seq++, state))),
    sendReaction: (to: string, emoji: string) => emitContent(encodeEnvelope(envReaction(seq++, to, emoji))),
    sendFile: (f: FileMeta) => {
      const e = envFile(seq++, f)
      const bytes = encodeEnvelope(e)
      void emitContent(bytes)
      trackDelivery(e.id, bytes)
      return e.id
    },
    // WebRTC signaling — always over GossipSub (the DataChannel isn't up yet)
    sendSignal: (to: string, sig: any) => emitGossip(encodeEnvelope(envRtc(seq++, to, sig))),
    // data-plane hooks used by the browser WebRTC upgrader
    setContentSend: (fn: ((sealed: Uint8Array) => void) | null) => { contentSend = fn ?? gossipContent },
    injectContent: (sealed: Uint8Array, from: string) => { void processSealed(sealed, from) },
    who: () => [...lastSeen.keys()],
    /** Announce now — e.g. when a tab becomes visible after being throttled. */
    refresh: () => { void announce() },
    /** Peers with a live EH-2 ratchet (empty in interim mode) — for the UI badge. */
    secured: () => (eh2 ? [...sessions.keys()] : []),
    stop: () => {
      // Handshake timers first, and by peer: `clearAttempt` owns both the
      // timeout and the msg1 re-sender, and clearing the maps without it left
      // the re-sender publishing into a room nobody is listening to any more —
      // a stopped conversation still shouting msg1 at its old topic.
      for (const p of new Set([...handshakes.keys(), ...attemptTimers.keys(), ...resendTimers.keys()])) clearAttempt(p)
      sessions.clear(); handshakes.clear(); queued.length = 0; resendable.clear()
      clearInterval(t0); clearInterval(hb); clearInterval(sweep)
      for (const t of earlyBeacons) clearTimeout(t)
      for (const id of [...pending.keys()]) clearPending(id)
      node.services.pubsub.removeEventListener('message', handler)
      try { node.services.pubsub.unsubscribe(topic) } catch {}
    },
  }
}
