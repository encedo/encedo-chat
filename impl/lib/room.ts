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
  encodeEnvelope, decodeEnvelope, envMsg, envTyping, envPresence, envReaction, envFile, envRtc, envAck, envGroupSkd,
  type MsgEnv, type ReactionEnv, type FileEnv, type FileMeta, type TypingState, type PresenceState, type RtcEnv, type AckEnv,
  type GroupSkdEnv, type SkdFields,
} from './envelope.ts'
import { nowMs } from './time.ts'

/**
 * EH-2 content crypto (docs/PROTOCOL.md §6–7). Content is sealed by a per-peer
 * Double Ratchet established over this topic:
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
  /**
   * Force a fresh EH-2 after this long (§7.3 bounded session lifetime).
   * Default: a random 4–8 h. Tests use seconds.
   */
  sessionLifetimeMs?: number
}

/** `macKey` authenticates Announce (§5.5); `eh2` seals content (§6–7). */
export interface RoomKeys { macKey: CryptoKey; eh2: Eh2Options }
/**
 * `quiet` is not something the peer says — it is us noticing that it has stopped
 * announcing, well before the 90 s that count as leaving. It is a warning, not a
 * verdict: the ratchet is untouched and one Announce takes it back to `active`.
 */
export type PresenceEvent = 'join' | 'active' | 'away' | 'quiet' | 'leave'
export interface ChatOpts {
  /**
   * `meta.outOfOrder` marks a message that belongs behind one already shown —
   * the gap it left was filled after the fact. Front-ends that can place it
   * (the web transcript) should; the terminal just says so.
   */
  onMessage?: (from: string, m: MsgEnv, meta: { outOfOrder: boolean }) => void
  onTyping?: (from: string, state: TypingState) => void
  onPresence?: (from: string, ev: PresenceEvent) => void
  onReaction?: (from: string, r: ReactionEnv) => void
  onFile?: (from: string, f: FileEnv) => void
  onSignal?: (from: string, env: RtcEnv) => void // WebRTC signaling (control plane)
  /** A group Sender-Key Distribution arrived over this 1:1 ratchet (§8) — the
   *  session routes it to the group manager. */
  onGroupSkd?: (from: string, skd: GroupSkdEnv) => void
  /**
   * The one peer in this pair room now answers to a different PeerId (it
   * reloaded, or its transport restarted) — `old` is dead, `now` is live.
   * Anything holding per-PeerId state, the WebRTC plane above all, has to move.
   */
  onPeerReplaced?: (old: string, now: string) => void
  /**
   * Our heartbeats are reaching nobody, so whatever the transport claims about
   * its connections, it is not carrying anything. Whoever owns the transport
   * (core) should re-dial.
   */
  onIsolated?: () => void
  /**
   * Somebody is in our room whose handshake does not verify. Most often that is
   * a second window logged into the SAME identity (it holds the Announce key, so
   * it looks like the contact until the MACs fail); it can also be a contact
   * whose IK has changed. The UI should say so — the user is the only one who
   * can close a duplicate tab.
   */
  onForeign?: (peer: string) => void
  /** The peer's client confirmed it holds this message (`ms` = time in flight). */
  onDelivered?: (id: string, ms: number) => void
  /** Gave up after retrying: the peer very likely never got it. */
  onUndelivered?: (id: string) => void
  /**
   * A message already marked ⚠ turns out to have arrived after all — the
   * confirmation came back once the peer woke up. `ms` is how long it took,
   * counted from the first send, so the UI can say how late it was.
   */
  onLateDelivered?: (id: string, ms: number) => void
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
  const onGroupSkd = opts.onGroupSkd ?? (() => {})
  const onDelivered = opts.onDelivered ?? (() => {})
  const onUndelivered = opts.onUndelivered ?? (() => {})
  const onLateDelivered = opts.onLateDelivered ?? (() => {})
  const onStall = opts.onStall ?? (() => {})
  const onPeerReplaced = opts.onPeerReplaced ?? (() => {})
  const onIsolated = opts.onIsolated ?? (() => {})
  const onForeign = opts.onForeign ?? (() => {})
  /** Heartbeats that must reach nobody before we call the transport dead. */
  const ISOLATED_AFTER = 2
  const heartbeatMs = opts.heartbeatMs ?? 15_000
  // Be generous: a browser throttles timers in a hidden tab (Firefox to about
  // once a minute), so a peer that is merely in a background window must not
  // look dead. This is a presence heuristic, nothing security-relevant.
  const ttlMs = Math.max(heartbeatMs * 6, 90_000)
  /** Two and a half missed heartbeats: late enough not to fire on jitter, early enough to matter. */
  const quietMs = Math.max(heartbeatMs * 2.5, 35_000)
  const self = node.peerId.toString()
  const seenNonces = new Set<string>()
  const seenSeq = new Set<string>() // dedup msg/reaction/file by `${from}:${seq}` (both planes)
  const lastSeen = new Map<string, number>()

  /** Peers we have already reported as quiet, so it is said once, not every sweep. */
  const quiet = new Set<string>()

  /**
   * Forget everything we know about a peer's message STREAM (dedup + ordering).
   *
   * Sequence numbers are per sender and start at 1 for each room, which was
   * harmless while every room had its own transport and therefore its own
   * PeerId. Sharing one transport across rooms broke that: leaving a room and
   * coming back reuses the PeerId, the counter restarts, and the peer discards
   * the new messages as ones it has already seen — silently, because that is
   * exactly what dedup is for. A new stream starts wherever a new ratchet does.
   */
  const forgetStream = (peer: string) => {
    topSeq.delete(peer)
    for (const k of [...seenSeq]) if (k.startsWith(`${peer}:`)) seenSeq.delete(k)
  }

  const touch = (peer: string) => {
    const fresh = !lastSeen.has(peer)
    lastSeen.set(peer, nowMs())
    if (quiet.delete(peer)) { log(`${short(peer)} is answering again`); onPresence(peer, 'active') }
    if (fresh) {
      log(`peer visible: ${short(peer)}`)
      onPresence(peer, 'join')
      // Answer a newcomer at once instead of making it wait for our heartbeat:
      // discovery has to be mutual before the lower id can open the handshake.
      void announce()
    }
    maybeHandshake(peer) // opens the EH-2 handshake if it is our turn
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
  /**
   * `sentAt` is when the user pressed enter — it is what the delivery time in
   * the UI means. `since` is when the current re-send budget started, which a
   * flush after a reconnect resets: the message deserves a full budget from a
   * transport that exists, not the remains of one it spent while offline.
   */
  interface Pending { bytes: Uint8Array; sentAt: number; since: number; tries: number; timer: any }
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
  /** When each of those was first sent — so a confirmation that finally shows up can say how late it is. */
  const firstSentAt = new Map<string, number>()
  const keepForResend = (id: string, bytes: Uint8Array, sentAt: number) => {
    resendable.set(id, bytes)
    firstSentAt.set(id, firstSentAt.get(id) ?? sentAt)
    if (resendable.size > MAX_RESENDABLE) {
      const oldest = resendable.keys().next().value as string
      resendable.delete(oldest)
      firstSentAt.delete(oldest)
    }
  }

  const clearPending = (id: string) => {
    const p = pending.get(id)
    if (p) { clearTimeout(p.timer); pending.delete(id) }
  }

  const armRetry = (id: string) => {
    const p = pending.get(id)
    if (!p) return
    const waited = nowMs() - p.since
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
          keepForResend(id, p.bytes, p.sentAt)
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
    pending.set(id, { bytes, sentAt: nowMs(), since: nowMs(), tries: 0, timer: null })
    armRetry(id)
  }

  const firstSeq = (from: string, seq: number): boolean => {
    const k = `${from}:${seq}`
    if (seenSeq.has(k)) return false
    seenSeq.add(k)
    return true
  }

  /**
   * Highest `seq` handed to the UI per sender, so we can say whether what just
   * arrived belongs BEHIND something already on screen.
   *
   * Nothing is held back waiting for a gap to close: a message that is here is
   * shown now. But arriving late and arriving last are different facts, and only
   * the sender's `seq` can tell them apart — the transport re-sends, and a
   * DataChannel and the relay can deliver the same conversation out of step. The
   * UI uses this to slot the straggler where it was written instead of pretending
   * it was typed last.
   */
  const topSeq = new Map<string, number>()
  const outOfOrder = (from: string, seq: number): boolean => {
    const top = topSeq.get(from)
    if (top === undefined || seq > top) { topSeq.set(from, seq); return false }
    return true
  }

  const dispatch = (from: string, env: any) => {
    switch (env.t) {
      case 'msg':
        touch(from)
        void confirm(env.id) // even for a duplicate: the first ack may be what got lost
        if (firstSeq(from, env.seq)) {
          const late = outOfOrder(from, env.seq)
          if (late) log(`message ${env.id} from ${short(from)} arrived out of order (seq ${env.seq} after ${topSeq.get(from)})`)
          onMessage(from, env as MsgEnv, { outOfOrder: late })
        }
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
      case 'group-skd': onGroupSkd(from, env as GroupSkdEnv); break
      case 'ack': {
        touch(from)
        acking.add(from)
        const a = env as AckEnv
        const p = pending.get(a.ref)
        if (p) {
          clearPending(a.ref)
          resendable.delete(a.ref)
          firstSentAt.delete(a.ref)
          onDelivered(a.ref, nowMs() - p.sentAt)
          break
        }
        // A confirmation for something we already gave up on. It happens: the
        // peer was asleep, or in a tunnel, and answered after the budget ran
        // out. Dropping it here (which is what this code used to do) left a ⚠
        // on a message that HAD arrived — the worst of the two possible lies.
        const sentAt = firstSentAt.get(a.ref)
        if (sentAt !== undefined) {
          resendable.delete(a.ref)
          firstSentAt.delete(a.ref)
          const late = nowMs() - sentAt
          log(`late confirmation for ${a.ref} — it did arrive, ${Math.round(late / 1000)}s after it was sent`)
          onLateDelivered(a.ref, late)
        }
        break
      }
      default: break // unknown type → ignore (forward-compat)
    }
  }

  // ---- [EH-2 seam] --------------------------------------------------------
  // Each peer gets its own EH-2 handshake and its own Double Ratchet.
  const sessions = new Map<string, Session>()
  /** `h` is null only for the moment between reserving the slot and having keys. */
  interface Attempt {
    h: Eh2Handshake | null
    role: 'initiator' | 'responder'
    startedAt: number
    /**
     * Set when this attempt is abandoned. Its handshake promise can still
     * resolve afterwards — the frames were already in flight — and installing
     * the session it produces is how a room ends up with two ratchets seconds
     * apart, of which the peer only holds one. Checking `handshakes.get(peer)`
     * is not enough: a fresh attempt for the same peer replaces the entry, so
     * the stale promise sees "not me" only until the next attempt reuses it.
     */
    cancelled?: boolean
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

  const sessionFor = (peer: string): Session | undefined => sessions.get(peer)

  /**
   * The ratchet a peer had until the last re-handshake, kept briefly so a
   * re-key does not eat the frames that were already in flight under it.
   *
   * The two sides do not switch at the same instant — the initiator switches
   * when msg2 comes back, the responder only when msg3 arrives — and content
   * sealed under the old ratchet can overtake msg3. Without this, every forced
   * re-handshake would cost a message or two and look exactly like loss.
   */
  const previous = new Map<string, { session: Session; until: number }>()
  const PREVIOUS_GRACE_MS = 60_000

  /**
   * When each live ratchet was established, and how long it may live (§7.3).
   *
   * The **bounded session lifetime** is not housekeeping — it is a security
   * boundary in two directions. It caps how long a compromise of the classical
   * DH chain matters (post-compromise security), and it is the hard stop on a
   * stolen unlocked device: the ratchet itself never touches the HSM, so an
   * attacker holding the machine can read a live session indefinitely — until
   * the forced re-handshake, which needs `ecdh(IK, ·)` inside the HSM they do
   * not have (§9.3). The self-topic takeover in §9.1 is coordination between
   * honest clients; THIS is the control.
   *
   * The window is randomised per session so that a fleet of clients does not
   * re-key in lockstep, which would be a metadata signal of its own.
   */
  const establishedAt = new Map<string, number>()
  const lifetimeMs = eh2?.sessionLifetimeMs
    ?? 4 * 3_600_000 + Math.floor(Math.random() * 4 * 3_600_000) // 4–8 h

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
    const a = handshakes.get(peer)
    if (a) a.cancelled = true
    clearTimeout(attemptTimers.get(peer))
    clearInterval(resendTimers.get(peer))
    attemptTimers.delete(peer)
    resendTimers.delete(peer)
    handshakes.delete(peer)
  }

  /** A peer that left takes its ratchet with it — a new visit re-handshakes. */
  const forgetPeer = (peer: string) => {
    clearAttempt(peer)
    forgetStream(peer)
    sessions.delete(peer)
    previous.delete(peer)
    establishedAt.delete(peer)
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
      // …but only if that PeerId has actually stopped answering. A reloaded tab
      // goes silent the instant it reloads, so this fires within a heartbeat.
      // A SECOND tab of the same identity does not: it keeps announcing, and
      // retiring it would hand the whole conversation to whichever window
      // handshaked last — which is precisely what "everything stopped working
      // when I opened a second tab" was. Two live windows both get the
      // messages; `emitContent` already seals for every session.
      const silence = nowMs() - (lastSeen.get(old) ?? 0)
      if (silence < heartbeatMs * 1.5) {
        dbg(`${short(old)} still announcing (${Math.round(silence / 1000)}s ago) — keeping its session alongside ${short(keep)}`)
        continue
      }
      log(`${short(old)} came back as ${short(keep)} → retiring the old session (reload or transport restart)`)
      forgetPeer(old)
      lastSeen.delete(old)
      onPeerReplaced(old, keep)
    }
  }

  const beginHandshake = async (peer: string, role: 'initiator' | 'responder', msg1?: Uint8Array): Promise<Attempt | null> => {
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
          if (attempt.cancelled) { log(`ignoring a handshake with ${short(peer)} that completed after it was abandoned`); return }
          if (handshakes.get(peer) !== attempt) return // superseded by a newer attempt
          clearAttempt(peer)
          stuck.delete(peer)
          const old = sessions.get(peer)
          if (old) previous.set(peer, { session: old, until: nowMs() + PREVIOUS_GRACE_MS })
          forgetStream(peer) // new ratchet ⇒ new stream: its `seq` starts from 1 again
          failedAttempts.delete(peer) // a success wipes the record — those failures were crossfire
          backoffUntil.delete(peer)
          everEstablished.add(peer)
          sessions.set(peer, s)
          establishedAt.set(peer, nowMs())
          retireOtherPeers(peer)
          log(`EH-2 established with ${short(peer)} (${role}) — ratchet live, ${queued.length} queued frame(s) to flush`)
          eh2.onState?.(peer, 'established')
          void flushQueued()
        },
        (err: any) => {
          if (attempt.cancelled || handshakes.get(peer) !== attempt) return
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
  /**
   * Handshakes that keep failing with the same peer, and the backoff that stops
   * them from becoming a loop.
   *
   * The case that produced this: a second tab logged into the SAME identity. It
   * derives the same pair topic and the same Announce MAC key, so its announces
   * verify perfectly and each tab takes the other for the contact — but the
   * handshake can never succeed, because each side expects the CONTACT's
   * identity key and is offered its own. With no backoff the two tabs retried
   * each other for as long as they were open: a badge flickering 🔐/⚠, a
   * conversation that had stopped working, and — because the retry timer does
   * not care whether anyone is listening — flapping that outlived the tab.
   *
   * Deliberately NOT keyed on the kind of failure. A failed MAC looks conclusive
   * ("wrong identity") but is not: two honest peers that open handshakes at the
   * same moment produce them routinely, and an early version of this blacklisted
   * its own real contact that way. Most of these attempts do not even get that
   * far — they simply time out. What IS diagnostic is the pattern: a peer that
   * announces steadily and never completes a handshake. Backing off then is
   * right whatever the cause — a duplicate tab, a rotated contact key, or a link
   * that only carries Announces.
   *
   * Nothing is permanent: the backoff expires and the next Announce tries again.
   */
  const RETRY_SOON_MS = [200, 1_400] as const // jittered, as before
  /**
   * The escalation SLOWS DOWN, it never stops. A link that loses a third of its
   * frames needs a lot of attempts before the first handshake lands — the
   * simulator's 35%-loss profile fails outright if this ever gives up, and a
   * first cut of these numbers cost it a run — so the only thing being bought
   * here is quiet: eventually one attempt per 10 s instead of one per second,
   * for a pair that is getting nowhere. Anything conclusive about
   * identity is handled by `notOurContact`, not by counting.
   */
  const CALM_AFTER = 16
  const CALM_MS = 3_000
  const GIVE_ROOM_AFTER = 24
  const GIVE_ROOM_MS = 10_000
  /** How long we stay away from a peer that told us it is not our contact. */
  const NOT_OURS_MS = 5 * 60_000
  const failedAttempts = new Map<string, number>()
  const backoffUntil = new Map<string, number>()
  /**
   * PeerIds we have completed a handshake with at least once. This is what keeps
   * the backoff off our real contact: a peer that has worked before gets the
   * fast retry for as long as it is here, whatever went wrong now. Only a peer
   * that has NEVER once completed a handshake — while announcing steadily — is
   * treated as structurally hopeless.
   */
  const everEstablished = new Set<string>()
  let warnedForeign = false

  /** True while we are deliberately not trying this peer. */
  const inBackoff = (peer: string) => nowMs() < (backoffUntil.get(peer) ?? 0)

  /**
   * This peer told us who it is, and it is not the contact we hold a key for.
   * No amount of retrying changes that, so stop — and say so, because the only
   * person who can act on it is the user (usually by closing a second window).
   */
  const declaredForeign = new Set<string>()
  const notOurContact = (peer: string) => {
    if (declaredForeign.has(peer)) return
    declaredForeign.add(peer)
    backoffUntil.set(peer, nowMs() + NOT_OURS_MS)
    clearAttempt(peer)
    lastSeen.delete(peer)
    quiet.delete(peer)
    stuck.delete(peer)
    log(`${short(peer)} is in our room but identifies as someone else — not the contact we hold a key for.`
      + ' Ignoring it for 5 min. Most often this is a second window logged into the same identity.')
    eh2?.onState?.(peer, 'failed')
    onPresence(peer, 'leave')
    if (!warnedForeign) { warnedForeign = true; onForeign(peer) }
  }

  const giveUp = (peer: string) => {
    if (sessions.has(peer)) return
    const n = (failedAttempts.get(peer) ?? 0) + 1
    failedAttempts.set(peer, n)
    eh2.onState?.(peer, 'failed')
    stuck.add(peer)
    if (!lastSeen.has(peer)) { log(`EH-2 attempt with ${short(peer)} gave up; it is not announcing — leaving it`); return }

    const fast = RETRY_SOON_MS[0] + Math.floor(Math.random() * RETRY_SOON_MS[1])
    let wait: number
    if (everEstablished.has(peer) || n < CALM_AFTER) wait = fast
    else if (n < GIVE_ROOM_AFTER) wait = CALM_MS
    else wait = GIVE_ROOM_MS
    if (!everEstablished.has(peer) && (n === CALM_AFTER || n === GIVE_ROOM_AFTER)) {
      log(`${n} handshakes with ${short(peer)} in a row got nowhere while it keeps announcing`
        + ` — backing off for ${Math.round(wait / 1000)}s.`
        + ' Most often this is a second window logged into the same identity, which cannot authenticate as the contact.')
      if (!warnedForeign) { warnedForeign = true; onForeign(peer) }
    } else {
      log(`EH-2 attempt with ${short(peer)} gave up — retrying in ${wait} ms`)
    }
    backoffUntil.set(peer, nowMs() + wait)
    const t = setTimeout(() => maybeHandshake(peer), wait)
    ;(t as any).unref?.()
  }

  /** Seen a peer: open the handshake if it is our turn (idempotent). */
  const maybeHandshake = (peer: string) => {
    if (peer === self || inBackoff(peer)) return
    if (sessions.has(peer) || handshakes.has(peer)) return
    // Do not keep offering to somebody who has stopped answering at all; the
    // next Announce brings them back.
    if (!lastSeen.has(peer)) return
    // Whoever is in a room initiates on discovery — we do NOT wait for the lower
    // id. That wait deadlocked the presence→conversation upgrade: the peer we
    // want may only be in the light presence layer (announcing, but not in a
    // room), so it will never initiate, and if it held the lower id nobody
    // would. Both initiating is fine — a crossed pair of msg1s is resolved by
    // the tie-break in onHandshakeFrame (lower id keeps initiator, higher yields).
    void beginHandshake(peer, 'initiator')
  }

  const onHandshakeFrame = async (data: Uint8Array, from: string): Promise<void> => {
    if (from === self) return
    if (inBackoff(from)) { dbg(`handshake frame from ${short(from)} ignored — backing off`); return }
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
    } catch (e: any) {
      const why = String(e?.message ?? e)
      // The one conclusive statement about identity in the whole handshake: msg1
      // carries an `initiator_id` derived from the sender's IK, and this check
      // compares it with the contact we hold a key for. Unlike a failed MAC —
      // which honest crossfire produces routinely, and which an earlier version
      // of this code wrongly took as proof — it cannot be an accident of timing.
      // Whoever sent that frame is not our contact.
      if (/initiator_id does not match/.test(why)) notOurContact(from)
      else dbg(`handshake frame from ${short(from)} did not apply: ${why}`)
      /* the attempt is already gone; giveUp() schedules the next one */
    }
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
    // A throw here (the ratchet raises one when a header claims a jump past the
    // §7.3 skip bound) used to escape into the pubsub handler and vanish, which
    // looked identical to a frame that simply was not ours.
    let pt: Uint8Array | null
    try { pt = await s.decrypt(data) }
    catch (e: any) { log(`frame from ${short(from)} rejected by the ratchet: ${e?.message ?? e}`); return false }
    if (pt === null) {
      // Still in flight under the ratchet we just replaced?
      const prev = previous.get(from)
      if (!prev || nowMs() > prev.until) return false
      try { pt = await prev.session.decrypt(data) } catch { return false }
      if (pt === null) return false
      dbg(`frame from ${short(from)} opened with the previous ratchet (in flight across the re-key)`)
    }
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

  /**
   * Consecutive heartbeats that reached nobody.
   *
   * `getConnections()` is not a health check: a machine that goes offline (lid
   * closed, network dropped, a tab whose sockets were cut) keeps a connection
   * object that nothing has yet tried to write to, so the client sits there
   * looking connected. What cannot be faked is delivery — GossipSub tells us how
   * many peers a publish actually went to, and a heartbeat that reaches zero of
   * them twice running means we are talking to ourselves.
   */
  let unheard = 0
  const announce = async () => {
    try {
      const bytes = await buildAnnounce(self, keys.macKey)
      const res: any = await node.services.pubsub.publish(topic, bytes).catch(() => null)
      // Test doubles do not report recipients; absence is not evidence.
      const reach = res?.recipients?.length
      if (typeof reach !== 'number') return
      if (reach > 0) {
        if (unheard >= ISOLATED_AFTER) log('heartbeat is reaching the relay again')
        unheard = 0
        return
      }
      if (++unheard === ISOLATED_AFTER) {
        log(`${unheard} heartbeats reached nobody — the transport looks dead`)
        onIsolated()
      }
    } catch {}
  }

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
    for (const [peer, t] of lastSeen) {
      const silent = now - t
      if (silent > ttlMs) {
        lastSeen.delete(peer)
        quiet.delete(peer)
        log(`no Announce from ${short(peer)} for ${Math.round(silent / 1000)}s → presence off (ratchet kept)`)
        onPresence(peer, 'leave')
      } else if (silent > quietMs && !quiet.has(peer)) {
        // Between "answering" and "gone" there is a minute and a half of a green
        // badge and no messages. Name that gap while it is happening instead of
        // letting the user work it out from the silence.
        quiet.add(peer)
        log(`no Announce from ${short(peer)} for ${Math.round(silent / 1000)}s → going quiet`)
        onPresence(peer, 'quiet')
      }
    }

    for (const [peer, session] of previous) if (now > session.until) previous.delete(peer)

    // Retire a session whose PeerId has stopped announcing while another one is
    // live. This is the second half of the rule in `retireOtherPeers`: the
    // decision cannot be made at establishment time (the reloaded tab may still
    // be within its last heartbeat), so it is re-checked here until it is clear.
    if (sessions.size > 1) {
      const alive = [...sessions.keys()].filter((p) => now - (lastSeen.get(p) ?? 0) < heartbeatMs * 1.5)
      if (alive.length) {
        for (const peer of [...sessions.keys()]) {
          if (alive.includes(peer)) continue
          log(`${short(peer)} stopped announcing and another session is live → retiring it`)
          forgetPeer(peer)
          lastSeen.delete(peer)
          onPeerReplaced(peer, alive[alive.length - 1])
        }
      }
    }

    // §7.3 bounded session lifetime. Only the side that normally initiates
    // starts it, so the two do not open crossing handshakes; the other answers
    // as it would to any msg1. Nothing is torn down here — the running ratchet
    // keeps carrying content until the replacement is live, which is what makes
    // this "transparent to the UI" rather than a visible reconnect.
    for (const [peer, at] of establishedAt) {
      if (now - at < lifetimeMs || !sessions.has(peer)) continue
      if (handshakes.has(peer) || !lastSeen.has(peer)) continue
      if (!(self < peer)) continue
      log(`session with ${short(peer)} is ${Math.round((now - at) / 60_000)} min old → forcing a fresh EH-2 (§7.3)`)
      establishedAt.set(peer, now) // do not fire again while this attempt runs
      void beginHandshake(peer, 'initiator')
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
    if (!sessions.size) {
      if (queued.length < maxQueued) { queued.push(bytes); dbg(`no session yet → queued (${queued.length})`) }
      else log('queue full — dropping outgoing frame')
      return
    }
    for (const s of sessions.values()) {
      try { const sealed = await s.encrypt(bytes); dbg(`→ content ${sealed.length} B via ${contentSend === gossipContent ? 'relay' : 'WebRTC'}`); contentSend(sealed) }
      catch (e: any) { log(`send failed: ${e?.message ?? e}`) }
    }
  }
  const emitGossip = async (bytes: Uint8Array) => {
    for (const s of sessions.values()) { try { gossip(await s.encrypt(bytes)) } catch {} }
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
    /** Hand a group's Sender-Key Distribution to this contact over the ratchet (§8). */
    sendGroupSkd: (skd: SkdFields) => emitContent(encodeEnvelope(envGroupSkd(seq++, skd))),
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
    /**
     * Send everything still unconfirmed again, oldest first, and restart its
     * schedule. For use the moment the transport comes back: each message
     * otherwise waits out its own private backoff, so a backlog leaves in
     * whatever order the timers happen to fire — which is how a reconnect
     * turned three queued messages into three out-of-order ones.
     *
     * `pending` is a Map, so insertion order IS send order; that is the whole
     * mechanism. Nothing is re-queued that the peer already confirmed.
     */
    flushPending: () => {
      const ids = [...pending.keys()]
      if (!ids.length) return
      log(`flushing ${ids.length} unconfirmed message(s) in order`)
      for (const id of ids) {
        const p = pending.get(id)
        if (!p) continue
        clearTimeout(p.timer)
        void emitContent(p.bytes)
        p.tries = 0
        p.since = nowMs() // fresh budget; `sentAt` still says when it was written
        armRetry(id)
      }
    },
    /** Peers with a live EH-2 ratchet (empty in interim mode) — for the UI badge. */
    secured: () => (eh2 ? [...sessions.keys()] : []),
    stop: () => {
      // Handshake timers first, and by peer: `clearAttempt` owns both the
      // timeout and the msg1 re-sender, and clearing the maps without it left
      // the re-sender publishing into a room nobody is listening to any more —
      // a stopped conversation still shouting msg1 at its old topic.
      for (const p of new Set([...handshakes.keys(), ...attemptTimers.keys(), ...resendTimers.keys()])) clearAttempt(p)
      sessions.clear(); previous.clear(); establishedAt.clear()
      handshakes.clear(); queued.length = 0; resendable.clear(); firstSentAt.clear()
      clearInterval(t0); clearInterval(hb); clearInterval(sweep)
      for (const t of earlyBeacons) clearTimeout(t)
      for (const id of [...pending.keys()]) clearPending(id)
      node.services.pubsub.removeEventListener('message', handler)
      try { node.services.pubsub.unsubscribe(topic) } catch {}
    },
  }
}
