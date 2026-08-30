/**
 * announce.ts — rendezvous presence message (docs/PROTOCOL.md §5.5). WebCrypto only.
 *
 * Announce = { v, peer, nonce, ts, mac },  mac = HMAC-SHA256(macKey, v|peer|nonce|ts).
 * macKey is a CryptoKey; verify uses subtle.verify (constant-time). Only holders
 * of the pair's announce_mac_key can produce or verify a valid Announce.
 */

import { subtle, randomBytes, b64, unb64 } from './wc.ts'

const enc = new TextEncoder()
const dec = new TextDecoder()
const REPLAY_WINDOW_MS = 5 * 60 * 1000   // ±5 min (§5.4)

const macMessage = (v: number, peer: string, nonce: string, ts: number) => enc.encode(`${v}|${peer}|${nonce}|${ts}`)

export async function buildAnnounce(peerId: string, macKey: CryptoKey): Promise<Uint8Array> {
  const v = 1
  const nonce = b64(randomBytes(16))
  const ts = Date.now()
  const sig = new Uint8Array(await subtle.sign('HMAC', macKey, macMessage(v, peerId, nonce, ts)))
  return enc.encode(JSON.stringify({ v, peer: peerId, nonce, ts, mac: b64(sig) }))
}

export interface VerifyResult { ok: boolean; peer?: string; nonce?: string; reason?: string }

export async function verifyAnnounce(data: Uint8Array, macKey: CryptoKey, nowMs = Date.now()): Promise<VerifyResult> {
  let m: any
  try { m = JSON.parse(dec.decode(data)) } catch { return { ok: false, reason: 'parse' } }
  if (m?.v !== 1) return { ok: false, reason: 'version' }
  if (typeof m.peer !== 'string' || typeof m.nonce !== 'string' || typeof m.ts !== 'number' || typeof m.mac !== 'string')
    return { ok: false, reason: 'shape' }
  if (Math.abs(nowMs - m.ts) > REPLAY_WINDOW_MS) return { ok: false, reason: 'timestamp' }
  let ok = false
  try { ok = await subtle.verify('HMAC', macKey, unb64(m.mac), macMessage(m.v, m.peer, m.nonce, m.ts)) } catch { ok = false }
  if (!ok) return { ok: false, reason: 'mac' }
  return { ok: true, peer: m.peer, nonce: m.nonce }
}

/**
 * The dedup set for accepted nonces — bounded, because the replay window is.
 *
 * `verifyAnnounce` refuses any timestamp outside ±5 min, so a nonce seen ten
 * minutes ago can never be replayed successfully; remembering it forever costs
 * memory for nothing. Every watch used to keep a plain Set that only grew — a
 * session left open for days accumulated one entry per heartbeat per topic.
 * This keeps the same has/add surface and prunes on insert, amortized: a Map
 * iterates in insertion order and the timestamps only move forward, so the
 * sweep stops at the first entry still young enough to matter.
 */
export function nonceCache(windowMs = 2 * REPLAY_WINDOW_MS) {
  const seen = new Map<string, number>()
  return {
    has: (n: string) => seen.has(n),
    add: (n: string) => {
      const now = Date.now()
      seen.set(n, now)
      if (seen.size <= 256) return
      for (const [k, t] of seen) {
        if (now - t > windowMs) seen.delete(k)
        else break
      }
    },
    get size() { return seen.size },
  }
}
