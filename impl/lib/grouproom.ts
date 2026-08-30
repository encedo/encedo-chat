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
 *
 * Rotation: the topic carries `date_UTC` (§5.3), and the date used to be frozen
 * at session start — two members whose sessions started on different UTC days
 * derived DIFFERENT topics and silently could not hear each other (the defect
 * the 2026-08-30 audit flagged in the spec). The room now walks the date itself:
 * groups roll at plain UTC midnight (there is no pair secret to derive an offset
 * from), and within the same ±30 min guard the pairs use (§5.4, offset 0) BOTH
 * adjacent days' topics are live — keepalives go to all of them, sends go to the
 * current day's. Both members run the same clock rule, so they cross together.
 */

import type { GroupSession } from './group.ts'
import { envMsg, envReaction, envFile, encodeEnvelope, decodeEnvelope, type MsgEnv, type ReactionEnv, type FileEnv, type FileMeta } from './envelope.ts'
import type { QuoteRef } from './quote.ts'
import { nowMs } from './time.ts'
import { activeDatesForOffset, type RotationConfig } from './presence.ts'

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
  /** Rotation overrides — TESTS ONLY. `now` fakes the clock, `tickMs` tightens
   *  the re-evaluation interval, `overlapMs` the §5.4 guard. Production runs on
   *  the real clock with the defaults. */
  rotation?: RotationConfig & { now?: () => number; tickMs?: number }
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
  const rot = opts.rotation ?? {}
  const rnow = rot.now ?? nowMs
  let seq = 0
  let stopped = false

  // unref so timers never keep a Node process alive (tests, CLI) — a no-op in
  // the browser, where setTimeout returns a number, so the heartbeat still runs.
  const unref = (t: any) => { try { t?.unref?.() } catch {} return t }
  const keepaliveOn = (t: string) => { try { node.services.pubsub.publish(t, KEEPALIVE).catch(() => {}) } catch {} }

  // ---- the live day-topics (rotation) ---------------------------------------
  // `byDate` is the truth (date → topic); `live` is the handler's fast lookup.
  // `primary` is the current day's topic — the only one we SEND on; the adjacent
  // day inside the guard is subscribe+keepalive only, so a member on the other
  // side of the boundary still hears us on the day it considers current.
  const byDate = new Map<string, string>()
  const live = new Set<string>()
  let primary = ''
  const pending: ReturnType<typeof setTimeout>[] = []

  let syncing = false
  const syncTopics = async () => {
    if (stopped || syncing) return
    syncing = true
    try { await syncTopicsInner() } finally { syncing = false }
  }
  const syncTopicsInner = async () => {
    const dates = activeDatesForOffset(rnow(), 0, rot)
    for (const d of dates) {
      if (byDate.has(d)) continue
      const t = await session.topicFor(d)
      if (stopped) return
      byDate.set(d, t)
      live.add(t)
      node.services.pubsub.subscribe(t)
      // Early beacons — the relay's mesh grafts over hundreds of ms after
      // (re)subscribing, so the first heartbeat would otherwise reach nobody
      // (same trick as join/presence).
      for (const ms of [1_000, 3_000, 7_000]) pending.push(unref(setTimeout(() => { if (!stopped) keepaliveOn(t) }, ms)))
      log(`group topic live for ${d}: ${t.slice(0, 12)}…`)
    }
    for (const [d, t] of byDate) {
      if (dates.includes(d)) continue
      byDate.delete(d)
      live.delete(t)
      try { node.services.pubsub.unsubscribe(t) } catch {}
      log(`group topic retired for ${d}`)
    }
    primary = byDate.get(dates[0])!
  }
  await syncTopics()
  // The rollover check. 60 s of granularity against a ±30 min guard is plenty,
  // and one cheap date computation a minute costs nothing.
  const rotTimer = unref(setInterval(() => { void syncTopics().catch(() => {}) }, rot.tickMs ?? 60_000))

  const handler = async (evt: any) => {
    if (stopped || !live.has(evt.detail.topic)) return
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
  log(`joined group on ${primary.slice(0, 12)}…`)

  // Keepalive: publish is fire-and-forget; a NoPeers error just means nobody is on
  // the topic right now, which the next tick handles. Every LIVE topic gets one —
  // inside the guard window the adjacent day's mesh must stay warm too, or the
  // member who crosses first would graft into a cold mesh.
  const keepalive = () => { for (const t of live) keepaliveOn(t) }
  // Jittered steady heartbeat (self-rescheduling so members don't sync into a herd).
  let kaTimer: ReturnType<typeof setTimeout> | null = null
  const scheduleKeepalive = () => {
    kaTimer = unref(setTimeout(() => { if (stopped) return; keepalive(); scheduleKeepalive() }, KEEPALIVE_MS + Math.floor(Math.random() * KEEPALIVE_JITTER_MS)))
  }
  scheduleKeepalive()

  const broadcast = async (bytes: Uint8Array) => {
    const frame = await session.send(bytes)
    try {
      const r = await node.services.pubsub.publish(primary, frame)
      log(`published ${frame.length} B → ${primary.slice(0, 8)}… (recipients: ${r?.recipients?.length ?? '?'})`)
    } catch (e: any) {
      log(`publish FAILED on ${primary.slice(0, 8)}…: ${e?.message ?? e}`)
      throw e
    }
  }

  return {
    get topic() { return primary },
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
      // connection, but re-assert every live topic and burst keepalives so the
      // mesh re-grafts promptly instead of waiting a whole heartbeat. Also
      // re-check the date — a laptop that slept through midnight wakes up here.
      if (stopped) return
      void syncTopics().catch(() => {})
      for (const t of live) { try { node.services.pubsub.subscribe(t) } catch {} }
      for (const ms of [0, 800, 2_000]) unref(setTimeout(() => { if (!stopped) keepalive() }, ms))
    },
    stop() {
      stopped = true
      // The session outlives the room (the manager owns it), so hand it back
      // without our handler rather than leaving a stopped room reachable.
      if (session.onNeedSenderKey) session.onNeedSenderKey = undefined
      for (const b of pending) clearTimeout(b)
      if (kaTimer) clearTimeout(kaTimer)
      clearInterval(rotTimer)
      try { node.services.pubsub.removeEventListener('message', handler) } catch {}
      for (const t of live) { try { node.services.pubsub.unsubscribe(t) } catch {} }
      live.clear(); byDate.clear()
    },
  }
}
