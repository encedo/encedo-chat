/**
 * announce.ts — rendezvous presence message (docs/PROTOCOL.md §5.5).
 *
 * Announce = { v, peer, nonce, ts, mac } where
 *   mac = HMAC-SHA256(announce_mac_key, v | peer | nonce | ts)
 * Only holders of the pair's announce_mac_key (derived from ss) can produce or
 * verify a valid Announce — so presence on the topic is authenticated.
 *
 * JSON wire form for now (debuggable, like v5); Protobuf later.
 */

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { fromString, toString } from 'uint8arrays'

const REPLAY_WINDOW_MS = 5 * 60 * 1000   // ±5 min (§5.4)

function computeMac(macKey: Buffer, v: number, peer: string, nonce: string, ts: number): string {
  return createHmac('sha256', macKey).update(`${v}|${peer}|${nonce}|${ts}`).digest('base64')
}

export function buildAnnounce(peerId: string, macKey: Buffer): Uint8Array {
  const v = 1
  const nonce = randomBytes(16).toString('base64')
  const ts = Date.now()
  const mac = computeMac(macKey, v, peerId, nonce, ts)
  return fromString(JSON.stringify({ v, peer: peerId, nonce, ts, mac }), 'utf8')
}

export interface VerifyResult { ok: boolean; peer?: string; nonce?: string; reason?: string }

export function verifyAnnounce(data: Uint8Array, macKey: Buffer, nowMs = Date.now()): VerifyResult {
  let m
  try { m = JSON.parse(toString(data, 'utf8')) } catch { return { ok: false, reason: 'parse' } }
  if (m.v !== 1) return { ok: false, reason: 'version' }
  if (typeof m.peer !== 'string' || typeof m.nonce !== 'string' || typeof m.ts !== 'number' || typeof m.mac !== 'string')
    return { ok: false, reason: 'shape' }
  if (Math.abs(nowMs - m.ts) > REPLAY_WINDOW_MS) return { ok: false, reason: 'timestamp' }
  const expect = computeMac(macKey, m.v, m.peer, m.nonce, m.ts)
  const a = Buffer.from(expect), b = Buffer.from(m.mac)
  if (a.length !== b.length || !timingSafeEqual(a, b)) return { ok: false, reason: 'mac' }
  return { ok: true, peer: m.peer, nonce: m.nonce }
}
