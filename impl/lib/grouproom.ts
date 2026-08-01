/**
 * grouproom.ts — a group over the transport (§8/§13). Ties a `GroupSession`
 * (crypto/state) to a GossipSub topic: subscribe, broadcast group-msg frames,
 * and dispatch inbound frames through `session.receive` → envelope → handlers.
 *
 * Groups ride GossipSub through the relay (NOT WebRTC — a mesh of N members would
 * be N² channels); content stays sender-key encrypted + per-recipient MAC'd, so
 * the relay sees ciphertext + metadata only. The plaintext inside is the SAME
 * `envelope` codec as 1:1 (msg / reaction / …), so the app layer is unchanged.
 */

import type { GroupSession } from './group.ts'
import { envMsg, envReaction, encodeEnvelope, decodeEnvelope, type MsgEnv, type ReactionEnv } from './envelope.ts'

export interface GroupRoomOpts {
  onMessage?: (from: string, env: MsgEnv) => void
  onReaction?: (from: string, env: ReactionEnv) => void
  onLog?: (msg: string) => void
}

export interface GroupRoom {
  /** Broadcast a text message to the group. */
  sendText(body: string): Promise<string>
  /** Broadcast a reaction to a message id. */
  sendReaction(to: string, emoji: string): Promise<void>
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
    const opened = await session.receive(evt.detail.data)
    if (!opened) return // not ours, unknown sender, forged/tampered MAC, replay, or no sender key
    const env = decodeEnvelope(opened.pt)
    if (!env) return
    if (env.t === 'msg') opts.onMessage?.(opened.from, env as MsgEnv)
    else if (env.t === 'reaction') opts.onReaction?.(opened.from, env as ReactionEnv)
    // unknown envelope types are ignored (forward-compat)
  }

  node.services.pubsub.addEventListener('message', handler)
  node.services.pubsub.subscribe(topic)
  log(`joined group on ${topic.slice(0, 12)}…`)

  const broadcast = async (bytes: Uint8Array) => {
    const frame = await session.send(bytes)
    await node.services.pubsub.publish(topic, frame)
  }

  return {
    topic,
    async sendText(body: string) {
      const env = envMsg(seq++, body)
      await broadcast(encodeEnvelope(env))
      return env.id
    },
    async sendReaction(to: string, emoji: string) {
      await broadcast(encodeEnvelope(envReaction(seq++, to, emoji)))
    },
    stop() {
      stopped = true
      try { node.services.pubsub.removeEventListener('message', handler) } catch {}
      try { node.services.pubsub.unsubscribe(topic) } catch {}
    },
  }
}
