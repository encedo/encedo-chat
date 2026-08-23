/**
 * grouproom.ts — a group over the transport (§8/§13). Ties a `GroupSession`
 * (crypto/state) to a GossipSub topic: subscribe, broadcast group-msg frames,
 * and dispatch inbound frames through `session.receive` → envelope → handlers.
 *
 * Groups ride GossipSub through the relay (NOT WebRTC — a mesh of N members would
 * be N² channels); content stays sender-key encrypted + per-recipient MAC'd, so
 * the relay sees ciphertext + metadata only. The plaintext inside is the SAME
 * `envelope` codec as 1:1 (msg / reaction / …), so the app layer is unchanged.
 *
 * Liveness: a group is otherwise PASSIVE (it sends only when you type), so its
 * GossipSub mesh gets pruned when idle and, after relay churn, silently stops
 * delivering — the "group hung, no reconnect" bug. So it now emits a tiny
 * **keepalive** on the topic on a jittered interval, exactly as the 1:1 room's
 * Announce keeps its mesh warm; members ignore the keepalive frame. `refresh()`
 * re-warms it after the transport reconnects.
 */

import type { GroupSession } from './group.ts'
import { envMsg, envReaction, envFile, encodeEnvelope, decodeEnvelope, type MsgEnv, type ReactionEnv, type FileEnv, type FileMeta } from './envelope.ts'
import type { QuoteRef } from './quote.ts'
import { nowMs } from './time.ts'

const T_GKEEPALIVE = 0x21 // a 1-byte mesh keepalive frame — NOT a group message (T_GMSG is 0x20)
const KEEPALIVE = new Uint8Array([T_GKEEPALIVE])
const KEEPALIVE_MS = 20_000
const KEEPALIVE_JITTER_MS = 8_000
/**
 * How rarely we may ask one member for its sender key again. The answer travels
 * over a 1:1 that has to be dialled and handshaked, and the member we are asking
 * is by definition mid-conversation — so a burst of undecryptable frames (which
 * is exactly what this condition produces: every frame that member sends) must
 * cost ONE request, not one per frame.
 */
const ASK_COOLDOWN_MS = 30_000

export interface GroupRoomOpts {
  onMessage?: (from: string, env: MsgEnv) => void
  onReaction?: (from: string, env: ReactionEnv) => void
  onFile?: (from: string, env: FileEnv) => void
  /** An authenticated member is sending frames we cannot open for lack of their
   *  sender key — ask them for one (see `GroupSession.onNeedSenderKey`). Already
   *  rate-limited per member when this fires. */
  onNeedSenderKey?: (memberPub: string) => void
  onLog?: (msg: string) => void
}

export interface GroupRoom {
  /** Broadcast a text message to the group. `re` quotes the message it answers. */
  sendText(body: string, re?: QuoteRef): Promise<string>
  /** Broadcast a reaction to a message id. */
  sendReaction(to: string, emoji: string): Promise<void>
  /** Broadcast a file's metadata. Same envelope as 1:1 — the bytes are already
   *  encrypted and uploaded, and every member can fetch them with the key here. */
  sendFile(f: FileMeta): Promise<string>
  /** Re-warm the topic mesh after the transport reconnected (re-subscribe + a keepalive burst). */
  refresh(): void
  topic: string
  stop(): void
}

export async function joinGroup(node: any, session: GroupSession, opts: GroupRoomOpts = {}): Promise<GroupRoom> {
  const log = opts.onLog ?? (() => {})
  const topic = await session.topic()
  let seq = 0
  let stopped = false

  const handler = async (evt: any) => {
    if (stopped || evt.detail.topic !== topic) return
    const data: Uint8Array = evt.detail.data
    if (data.length === 1 && data[0] === T_GKEEPALIVE) return // a member's mesh keepalive — ignore
    const opened = await session.receive(data)
    // null = our own echo, an unknown sender, a forged/tampered MAC, a replay, or
    // no sender key yet — all normal enough not to surface, but a persistent drop
    // is how a distribution gap looks, so trace it under debug.
    if (!opened) { log(`dropped a ${data.length} B frame (not ours / bad MAC / no sender key)`); return }
    const env = decodeEnvelope(opened.pt)
    if (!env) return
    if (env.t === 'msg') opts.onMessage?.(opened.from, env as MsgEnv)
    else if (env.t === 'reaction') opts.onReaction?.(opened.from, env as ReactionEnv)
    else if (env.t === 'file') opts.onFile?.(opened.from, env as FileEnv)
    // unknown envelope types are ignored (forward-compat)
  }

  // Repair path: a member whose sender key never reached us is deaf-to-us in ONE
  // direction and looks perfectly healthy in the other, so nothing else in the
  // system would ever notice. The session raises this only for frames that
  // already proved our MAC, so the peer is a member and the ask is warranted.
  const lastAsk = new Map<string, number>()
  session.onNeedSenderKey = (memberPub: string) => {
    if (stopped) return
    const t = nowMs()
    if (t - (lastAsk.get(memberPub) ?? 0) < ASK_COOLDOWN_MS) return
    lastAsk.set(memberPub, t)
    log(`no sender key for ${memberPub.slice(0, 12)}… — asking them to re-send it`)
    opts.onNeedSenderKey?.(memberPub)
  }

  node.services.pubsub.addEventListener('message', handler)
  node.services.pubsub.subscribe(topic)
  log(`joined group on ${topic.slice(0, 12)}…`)

  // Keepalive: publish is fire-and-forget; a NoPeers error just means nobody is on
  // the topic right now, which the next tick handles.
  const keepalive = () => { try { node.services.pubsub.publish(topic, KEEPALIVE).catch(() => {}) } catch {} }
  // unref so the keepalive timers never keep a Node process alive (tests, CLI) — a
  // no-op in the browser, where setTimeout returns a number, so the heartbeat still runs.
  const unref = (t: any) => { try { t?.unref?.() } catch {} return t }
  // Early beacons — the relay's mesh grafts over hundreds of ms after (re)subscribing,
  // so the first heartbeat would otherwise reach nobody (same trick as join/presence).
  const beacons = [1_000, 3_000, 7_000].map((ms) => unref(setTimeout(() => { if (!stopped) keepalive() }, ms)))
  // Jittered steady heartbeat (self-rescheduling so members don't sync into a herd).
  let kaTimer: ReturnType<typeof setTimeout> | null = null
  const scheduleKeepalive = () => {
    kaTimer = unref(setTimeout(() => { if (stopped) return; keepalive(); scheduleKeepalive() }, KEEPALIVE_MS + Math.floor(Math.random() * KEEPALIVE_JITTER_MS)))
  }
  scheduleKeepalive()

  const broadcast = async (bytes: Uint8Array) => {
    const frame = await session.send(bytes)
    try {
      const r = await node.services.pubsub.publish(topic, frame)
      log(`published ${frame.length} B → ${topic.slice(0, 8)}… (recipients: ${r?.recipients?.length ?? '?'})`)
    } catch (e: any) {
      log(`publish FAILED on ${topic.slice(0, 8)}…: ${e?.message ?? e}`)
      throw e
    }
  }

  return {
    topic,
    async sendText(body: string, re?: QuoteRef) {
      const env = envMsg(seq++, body, 'plain', re)
      await broadcast(encodeEnvelope(env))
      return env.id
    },
    async sendFile(f: FileMeta) {
      const env = envFile(seq++, f)
      await broadcast(encodeEnvelope(env))
      return env.id
    },
    async sendReaction(to: string, emoji: string) {
      await broadcast(encodeEnvelope(envReaction(seq++, to, emoji)))
    },
    refresh() {
      // The transport came back: GossipSub re-sends subscriptions on the new
      // connection, but re-assert it and burst keepalives so the mesh re-grafts
      // promptly instead of waiting a whole heartbeat.
      if (stopped) return
      try { node.services.pubsub.subscribe(topic) } catch {}
      for (const ms of [0, 800, 2_000]) setTimeout(() => { if (!stopped) keepalive() }, ms)
    },
    stop() {
      stopped = true
      // The session outlives the room (the manager owns it), so hand it back
      // without our handler rather than leaving a stopped room reachable.
      if (session.onNeedSenderKey) session.onNeedSenderKey = undefined
      for (const b of beacons) clearTimeout(b)
      if (kaTimer) clearTimeout(kaTimer)
      try { node.services.pubsub.removeEventListener('message', handler) } catch {}
      try { node.services.pubsub.unsubscribe(topic) } catch {}
    },
  }
}
