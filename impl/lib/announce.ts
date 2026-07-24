/**
 * announce.ts — rendezvous presence message (docs/PROTOCOL.md §5.5).
 *
 * Announce = { v, peer, nonce, ts, mac },  mac = HMAC-SHA256(macKey, v|peer|nonce|ts).
 * Only holders of the pair's announce_mac_key (from ss) can produce or verify a
 * valid Announce. Browser+Node: @noble/hashes, no Buffer. JSON wire form.
 */

import { hmac } from '@noble/hashes/hmac'
import { sha256 } from '@noble/hashes/sha2'
import { randomBytes } from '@noble/hashes/utils'
import { fromString, toString } from 'uint8arrays'

const enc = new TextEncoder()
const REPLAY_WINDOW_MS = 5 * 60 * 1000   // ±5 min (§5.4)

function computeMac(macKey: Uint8Array, v: number, peer: string, nonce: string, ts: number): string {
  return toString(hmac(sha256, macKey, enc.encode(`${v}|${peer}|${nonce}|${ts}`)), 'base64')
}

// constant-time-ish compare (interim; EH-2 path will use audited primitives)
function ctEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  let d = 0
  for (let i = 0; i < a.length; i++) d |= a[i] ^ b[i]
  return d === 0
}

export function buildAnnounce(peerId: string, macKey: Uint8Array): Uint8Array {
  const v = 1
  const nonce = toString(randomBytes(16), 'base64')
  const ts = Date.now()
  const mac = computeMac(macKey, v, peerId, nonce, ts)
  return fromString(JSON.stringify({ v, peer: peerId, nonce, ts, mac }), 'utf8')
}

export interface VerifyResult { ok: boolean; peer?: string; nonce?: string; reason?: string }

export function verifyAnnounce(data: Uint8Array, macKey: Uint8Array, nowMs = Date.now()): VerifyResult {
  let m: any
  try { m = JSON.parse(toString(data, 'utf8')) } catch { return { ok: false, reason: 'parse' } }
  if (m?.v !== 1) return { ok: false, reason: 'version' }
  if (typeof m.peer !== 'string' || typeof m.nonce !== 'string' || typeof m.ts !== 'number' || typeof m.mac !== 'string')
    return { ok: false, reason: 'shape' }
  if (Math.abs(nowMs - m.ts) > REPLAY_WINDOW_MS) return { ok: false, reason: 'timestamp' }
  const expect = computeMac(macKey, m.v, m.peer, m.nonce, m.ts)
  if (!ctEqual(fromString(expect, 'base64'), fromString(m.mac, 'base64'))) return { ok: false, reason: 'mac' }
  return { ok: true, peer: m.peer, nonce: m.nonce }
}
