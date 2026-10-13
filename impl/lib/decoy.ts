/**
 * decoy.ts - decoy subscriptions (SPEC.md 5.10).
 *
 * A node sees, per connection, how many topics it holds - the size of the
 * contact list - and which of them hop together. A client therefore holds
 * up to DECOY_MAX extra topics that are indistinguishable from pair topics
 * of contacts who are offline: the same 52-character shape, the same
 * Announce cadence (beacons, the 15 s heartbeat on the session's radio
 * phase, the hidden-tab slowdown - it IS a presence watch), each rotating
 * daily at its own instant with the same +/-30 min guard.
 *
 * What differs is invisible to the node: the Announces are MAC'd under a
 * random key nobody else holds, so no client ever answers, which is exactly
 * what a pair topic whose contact is away looks like. The topics derive from
 * one identity-backend derivation per session (date-independent), so a
 * restart resumes the same decoys - a set that changed on every reload while
 * the real topics stayed would mark itself.
 *
 *   seed     = derive(IK, IK_pub, ctx = network_id || 0x00, "encedo-chat-decoy-v1", 32)
 *   offset_i = u32be(HKDF(seed, salt = u8(i), info = "encedo-chat-decoy-offset-v1", 4)) mod 86400
 *   topic_i  = base32(HKDF(seed, salt = u8(i) || network_id || 0x00 || date, info = "encedo-chat-decoy-topic-v1", 32))[0:52]
 *
 * Decoys yield: a node that refuses a topic is full, and a real room must
 * never lose its slot to cover traffic, so a refusal of any real topic
 * drops every decoy for the rest of the session.
 */

import { kdf, randomBytes, subtle } from './wc.ts'
import { paramsInfo, rotationCtx, topicFromMaterial, offsetFromMaterial, type RvParams } from './rendezvous.ts'
import { watchPresenceRotating, type PresenceWatch } from './presence.ts'

export const DECOY_MAX = 8
export const DECOY_SEED_LABEL = 'encedo-chat-decoy-v1'
const OFFSET_LABEL = 'encedo-chat-decoy-offset-v1'
const TOPIC_LABEL = 'encedo-chat-decoy-topic-v1'

/** How many decoys a client with `contacts` contacts holds. */
export const decoyCount = (contacts: number): number => Math.max(0, Math.min(contacts, DECOY_MAX))

export interface DecoyOpts {
  /** HKDF(ECDH(IK, IK_pub), ctx, label, len) through the identity backend (lib/derive.ts). */
  deriveSelf(label: string, ctx: Uint8Array, len: number): Promise<Uint8Array>
  params: RvParams
  heartbeatMs?: number
  onLog?: (m: string, level?: 'info' | 'debug') => void
  /** Clock and tick seams for tests. */
  now?: () => number
  tickMs?: number
}

export interface Decoys {
  /** Hold `n` decoys (clamped to DECOY_MAX; lowered on shrink, never above a yield). */
  resize(n: number): Promise<void>
  /** Is `topic` one of ours today? */
  isDecoy(topic: string): boolean
  /** A real topic was refused: drop every decoy for the rest of the session. */
  yieldAll(why: string): void
  count(): number
  topics(): string[]
  stop(): void
}

export async function decoyMaterial(seed: Uint8Array, i: number, p: RvParams): Promise<{ topic: string; offsetSec: number }> {
  const ii = new Uint8Array([i])
  const off = offsetFromMaterial(await kdf(OFFSET_LABEL, seed, ii, 4))
  const info = paramsInfo(p)
  const ctx = new Uint8Array(1 + info.length); ctx[0] = i; ctx.set(info, 1)
  return { topic: topicFromMaterial(await kdf(TOPIC_LABEL, seed, ctx)), offsetSec: off }
}

export function startDecoys(node: any, self: string, opts: DecoyOpts): Decoys {
  const log = opts.onLog ?? (() => {})
  let seed: Promise<Uint8Array> | null = null
  const getSeed = () => (seed ??= opts.deriveSelf(DECOY_SEED_LABEL, rotationCtx(opts.params.networkId), 32))
  const running = new Map<number, { watch: PresenceWatch; topics: Set<string> }>()
  let yielded = false
  let stopped = false

  const startOne = async (i: number) => {
    const s = await getSeed()
    const { offsetSec } = await decoyMaterial(s, i, opts.params)
    const topics = new Set<string>()
    // A fresh MAC key per decoy and per session: well-formed Announces that
    // nobody can verify, which no client will ever answer.
    const macKey = await subtle.importKey('raw', randomBytes(32), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify'])
    const watch = watchPresenceRotating(node, self, async (dateUTC) => {
      const { topic } = await decoyMaterial(s, i, { ...opts.params, dateUTC })
      topics.add(topic)
      return { topic, macKey }
    }, {
      offsetMs: offsetSec * 1000,
      heartbeatMs: opts.heartbeatMs,
      onOnline: () => {}, onOffline: () => {},
      onIncomingHandshake: () => {},
      onLog: (m, l) => log(`decoy ${i}: ${m}`, l ?? 'debug'),
      now: opts.now, tickMs: opts.tickMs,
    })
    running.set(i, { watch, topics })
  }

  return {
    async resize(n: number) {
      if (stopped || yielded) return
      const want = Math.max(0, Math.min(n, DECOY_MAX))
      for (let i = 0; i < want; i++) if (!running.has(i)) { try { await startOne(i) } catch (e: any) { log(`decoy ${i} failed: ${e?.message ?? e}`); return } }
      for (const [i, r] of [...running]) if (i >= want) { r.watch.stop(true); running.delete(i) }
      log(`decoys: holding ${running.size}`, 'debug')
    },
    isDecoy(topic) { for (const r of running.values()) if (r.topics.has(topic)) return true; return false },
    yieldAll(why) {
      if (yielded) return
      yielded = true
      for (const r of running.values()) r.watch.stop(true)
      running.clear()
      log(`decoys: dropped for the rest of the session (${why})`)
    },
    count: () => running.size,
    topics: () => [...running.values()].flatMap((r) => [...r.topics]),
    stop() { stopped = true; for (const r of running.values()) r.watch.stop(true); running.clear() },
  }
}
