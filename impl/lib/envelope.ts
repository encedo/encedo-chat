/**
 * envelope.ts — the message envelope (codec layer). Pure: Envelope <-> bytes.
 *
 * The plaintext INSIDE the interim AES-GCM seal (msgcrypto.ts) is a JSON
 * envelope: one versioned shape, a type discriminator `t`, and per-message meta
 * (id / ts / seq). New meta types (reaction, file, …) slot in here without
 * touching crypto or transport. An unknown `t` still decodes (to UnknownEnv) so
 * older clients ignore future messages gracefully — forward-compat.
 *
 * EH-2-independent: this is the application payload. Today the interim key seals
 * it; later the EH-2 ratchet seals the SAME bytes — this codec is unchanged.
 *
 * Text format: `plain` only for now. `md` (a SAFE Markdown-lite subset rendered
 * by our own renderer to safe DOM) is reserved — we NEVER put raw HTML on the
 * wire or render it.
 *
 * Timestamps: `ts` is Unix epoch ms (UTC) — see lib/time.ts.
 */

import { randomBytes, b64 } from './wc.ts'
import { nowMs } from './time.ts'

export const ENVELOPE_V = 1

export type MsgFormat = 'plain' // reserved: 'md' (safe subset, never raw HTML)
export type TypingState = 'start' | 'stop'
export type PresenceState = 'active' | 'away' | 'leave'

export interface BaseEnv {
  v: number // envelope version
  t: string // type discriminator
  id: string // short per-message id (for reactions/replies/acks)
  ts: number // sender clock, Unix epoch ms (UTC)
  seq: number // per-sender monotonic (dedup/order; UX only, NOT security)
}
export interface MsgEnv extends BaseEnv { t: 'msg'; body: string; format: MsgFormat }
export interface TypingEnv extends BaseEnv { t: 'typing'; state: TypingState }
export interface PresenceEnv extends BaseEnv { t: 'presence'; state: PresenceState }
export interface ReactionEnv extends BaseEnv { t: 'reaction'; to: string; emoji: string }
export interface FileEnv extends BaseEnv {
  t: 'file'
  cid: string // IPFS content id (content is encrypted BEFORE upload — see `key`)
  name: string
  size: number
  mime: string
  exp?: number // expiry (epoch ms, UTC) — IPFS auto-drops after N hours
  key?: string // content key to decrypt the fetched blob (reserved; design TBD)
}
/** A valid envelope whose `t` this build doesn't know — carried for forward-compat. */
export interface UnknownEnv extends BaseEnv { [k: string]: unknown }

export type KnownEnv = MsgEnv | TypingEnv | PresenceEnv | ReactionEnv | FileEnv
export type Envelope = KnownEnv | UnknownEnv
export type FileMeta = Omit<FileEnv, keyof BaseEnv>

const td = new TextDecoder()
const te = new TextEncoder()

/** Short per-message id (base64 of 6 random bytes). */
export const mkId = (): string => b64(randomBytes(6))

const base = (t: string, seq: number): BaseEnv => ({ v: ENVELOPE_V, t, id: mkId(), ts: nowMs(), seq })

// builders (fill v/id/ts); the room supplies the monotonic seq
export const envMsg = (seq: number, body: string, format: MsgFormat = 'plain'): MsgEnv => ({ ...base('msg', seq), body, format })
export const envTyping = (seq: number, state: TypingState): TypingEnv => ({ ...base('typing', seq), state })
export const envPresence = (seq: number, state: PresenceState): PresenceEnv => ({ ...base('presence', seq), state })
export const envReaction = (seq: number, to: string, emoji: string): ReactionEnv => ({ ...base('reaction', seq), to, emoji })
export const envFile = (seq: number, f: FileMeta): FileEnv => ({ ...base('file', seq), ...f })

export const encodeEnvelope = (e: Envelope): Uint8Array => te.encode(JSON.stringify(e))

const FORMATS = new Set<string>(['plain'])
const TYPING = new Set<string>(['start', 'stop'])
const PRESENCE = new Set<string>(['active', 'away', 'leave'])

/**
 * Parse + validate. Returns null for a non-envelope / wrong version / malformed
 * KNOWN type (drop). A valid base with an unknown `t` returns as UnknownEnv so
 * the dispatcher can ignore it without treating it as corrupt (forward-compat).
 */
export function decodeEnvelope(bytes: Uint8Array): Envelope | null {
  let m: any
  try { m = JSON.parse(td.decode(bytes)) } catch { return null }
  if (m?.v !== ENVELOPE_V) return null
  if (typeof m.t !== 'string' || typeof m.id !== 'string' || typeof m.ts !== 'number' || typeof m.seq !== 'number') return null
  switch (m.t) {
    case 'msg': return (typeof m.body === 'string' && FORMATS.has(m.format)) ? (m as MsgEnv) : null
    case 'typing': return TYPING.has(m.state) ? (m as TypingEnv) : null
    case 'presence': return PRESENCE.has(m.state) ? (m as PresenceEnv) : null
    case 'reaction': return (typeof m.to === 'string' && typeof m.emoji === 'string') ? (m as ReactionEnv) : null
    case 'file': return (typeof m.cid === 'string' && typeof m.name === 'string' && typeof m.size === 'number' && typeof m.mime === 'string') ? (m as FileEnv) : null
    default: return m as UnknownEnv // forward-compat: dispatcher ignores unknown types
  }
}
