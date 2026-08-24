/**
 * envelope.ts — the message envelope (codec layer). Pure: Envelope <-> bytes.
 *
 * The plaintext INSIDE the Session seal (lib/session.ts) is a JSON
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
import { isQuoteRef, type QuoteRef } from './quote.ts'

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
/**
 * `re` is a reply: the message this one answers, quoted (`quote.ts`). Optional
 * and additive on purpose — a build that does not know the field decodes the
 * message and shows it, which is exactly what a reply reads as without its
 * quote. Nothing in the crypto or the transport sees it.
 */
export interface MsgEnv extends BaseEnv { t: 'msg'; body: string; format: MsgFormat; re?: QuoteRef }
export interface TypingEnv extends BaseEnv { t: 'typing'; state: TypingState }
export interface PresenceEnv extends BaseEnv { t: 'presence'; state: PresenceState }
export interface ReactionEnv extends BaseEnv { t: 'reaction'; to: string; emoji: string }
/**
 * A correction: `to` is the id of the message being replaced, `body` what it
 * says now. Its own `id` is the one delivery is tracked under, so the sender can
 * be told whether the correction actually landed — which is the whole reason
 * this is a 1:1 feature (`lib/edits.ts`).
 *
 * A separate type rather than a flag on `msg`, because an edit is not a message:
 * it must not raise an unread count, ring anything, or get a bubble of its own.
 * An older build decodes it as `UnknownEnv` and ignores it — and therefore goes
 * on showing the ORIGINAL text, which is exactly why the sender is shown proof
 * of delivery rather than a quiet assumption.
 */
export interface EditEnv extends BaseEnv { t: 'edit'; to: string; body: string; format: MsgFormat }
/**
 * A file. The bytes are encrypted BEFORE they are uploaded and this envelope
 * carries everything needed to get them back — which is why it rides the
 * ratchet (or a group sender key) like any other message, and why the node
 * holding the blob learns nothing from it.
 *
 * Note what is in HERE rather than in the upload: the name, the type and the
 * true length. The store sees a nameless blob of ciphertext and its size; it
 * cannot tell a photo from a contract.
 *
 * `chunk` and `chunks` are wire fields, not conventions: the receiver cannot
 * guess the chunking, and the chunk COUNT is bound into every chunk's AAD, so
 * this is also what makes a truncated fetch detectable (`lib/filecrypto.ts`).
 */
export interface FileEnv extends BaseEnv {
  t: 'file'
  cid: string   // content id of the CIPHERTEXT — also its hash, so this authenticates the blob
  name: string  // original filename; never leaves this envelope
  size: number  // PLAINTEXT length
  mime: string
  /** Content key, base64. Single-use, generated per file. */
  key: string
  /** Plaintext bytes per chunk, as used when encrypting. */
  chunk: number
  /** How many chunks the ciphertext must contain. */
  chunks: number
  /** AEAD construction, so a future one can coexist. */
  alg: string
  /** When the store drops it (epoch ms, UTC). Advisory: the UI says "expired"
   *  rather than pretending a dead link is alive. */
  exp?: number
  /**
   * Optional caption, sent WITH the file rather than beside it.
   *
   * One envelope, not two, because delivery is tracked per message id: two
   * envelopes for one user action would put two acks and two markers on one
   * bubble, and could arrive apart or out of order, leaving a caption with no
   * file or a file with no caption to reconcile. Same plain-text rule as
   * `MsgEnv` — rendered as text nodes, never as markup.
   */
  body?: string
  /** The message this file answers, quoted — same field, same rules as `MsgEnv`. */
  re?: QuoteRef
}
/**
 * Delivery confirmation. Instant-only product: this says "it reached the other
 * client", nothing about reading it — there are no read receipts by design.
 * `ref` is the id of the message being confirmed, `rts` the receiver's clock at
 * the moment it arrived (so the sender can show how long it took).
 */
export interface AckEnv extends BaseEnv { t: 'ack'; ref: string; rts: number }
/** WebRTC signaling (SDP/ICE) relayed over the control plane (GossipSub), encrypted. */
export interface RtcEnv extends BaseEnv { t: 'rtc'; to: string; sig: any }
/**
 * Sender-Key Distribution (§8): carries a group's shared secret + the sender's
 * sending key to one member, over the 1:1 EH-2/ratchet (which authenticates it).
 * All fields base64 except `epoch`/`roster`. `rmac` is the admin's roster MAC.
 */
export interface GroupSkdEnv extends BaseEnv {
  t: 'group-skd'
  gid: string      // 16 B group id
  gkPub: string    // GK_pub (group identity key)
  epoch: number
  secret: string   // group_secret (32 B) — seeds the topic
  chain: string    // the sender's sending-chain key (32 B)
  /**
   * Which counter `chain` is AT. Omitted means 0, which is what an SKD sent
   * before the sender has said anything means — and what builds before this
   * field always meant. It matters on a RE-send: a sending chain ratchets per
   * message, so a key handed over mid-conversation is `chain@k`, and a receiver
   * that seeds it at 0 fails to open every subsequent frame, indistinguishably
   * from having received no key at all.
   */
  ctr?: number
  roster: string[] // member IK_pub, incl. admin & self
  rmac?: string    // roster MAC (rk_i), present when the sender is the admin
  name?: string    // human group name (app metadata; the crypto ignores it)
}
/**
 * Ask one member to hand its Sender-Key Distribution over again (§8), on the same
 * 1:1 ratchet an SKD itself travels on.
 *
 * This exists because a sender key is distributed exactly once, over a channel
 * that can be down at that moment — and the receiving side of Sender Keys has no
 * way to derive what it was never given. A member whose SKD did not arrive is
 * therefore deaf to that one sender **permanently**, while every other direction
 * looks perfect. The request is what turns that into a few seconds of silence.
 *
 * It carries only the group and the epoch the asker is stuck at. The answer is an
 * ordinary `group-skd`, so nothing else has to travel, and a responder that is
 * further ahead answers with its own epoch — which is the existing rekey path.
 */
export interface GroupSkdReqEnv extends BaseEnv { t: 'group-skd-req'; gid: string; epoch: number }
/** A valid envelope whose `t` this build doesn't know — carried for forward-compat. */
export interface UnknownEnv extends BaseEnv { [k: string]: unknown }

export type KnownEnv = MsgEnv | TypingEnv | PresenceEnv | ReactionEnv | EditEnv | FileEnv | RtcEnv | AckEnv | GroupSkdEnv | GroupSkdReqEnv
export type Envelope = KnownEnv | UnknownEnv
export type FileMeta = Omit<FileEnv, keyof BaseEnv>

const td = new TextDecoder()
const te = new TextEncoder()

/** Short per-message id (base64 of 6 random bytes). */
export const mkId = (): string => b64(randomBytes(6))

// Generic in `t` so the literal survives the spread: annotated `: BaseEnv` it
// widened to `string`, and every builder below then failed to be the envelope it
// says it returns. Nothing checks types at runtime here (Node strips them, the
// bundler transpiles), so this was invisible outside an editor.
const base = <T extends string>(t: T, seq: number) => ({ v: ENVELOPE_V, t, id: mkId(), ts: nowMs(), seq })

// builders (fill v/id/ts); the room supplies the monotonic seq
export const envMsg = (seq: number, body: string, format: MsgFormat = 'plain', re?: QuoteRef): MsgEnv => ({ ...base('msg', seq), body, format, ...(re ? { re } : {}) })
export const envTyping = (seq: number, state: TypingState): TypingEnv => ({ ...base('typing', seq), state })
export const envPresence = (seq: number, state: PresenceState): PresenceEnv => ({ ...base('presence', seq), state })
export const envReaction = (seq: number, to: string, emoji: string): ReactionEnv => ({ ...base('reaction', seq), to, emoji })
export const envEdit = (seq: number, to: string, body: string, format: MsgFormat = 'plain'): EditEnv => ({ ...base('edit', seq), to, body, format })
export const envFile = (seq: number, f: FileMeta): FileEnv => ({ ...base('file', seq), ...f })
export const envRtc = (seq: number, to: string, sig: any): RtcEnv => ({ ...base('rtc', seq), to, sig })
export const envAck = (seq: number, ref: string, rts: number = nowMs()): AckEnv => ({ ...base('ack', seq), ref, rts })
export type SkdFields = Omit<GroupSkdEnv, keyof BaseEnv | 't'>
export const envGroupSkd = (seq: number, f: SkdFields): GroupSkdEnv => ({ ...base('group-skd', seq), ...f })
export const envGroupSkdReq = (seq: number, gid: string, epoch: number): GroupSkdReqEnv => ({ ...base('group-skd-req', seq), gid, epoch })

export const encodeEnvelope = (e: Envelope): Uint8Array => te.encode(JSON.stringify(e))

const FORMATS = new Set<string>(['plain'])
const TYPING = new Set<string>(['start', 'stop'])
const PRESENCE = new Set<string>(['active', 'away', 'leave'])

/**
 * Parse + validate. Returns null for a non-envelope / wrong version / malformed
 * KNOWN type (drop). A valid base with an unknown `t` returns as UnknownEnv so
 * the dispatcher can ignore it without treating it as corrupt (forward-compat).
 */
/** Drop a `re` that would not render; keep the envelope it rode in on. */
const sanitizeQuote = (m: any) => { if (m.re !== undefined && !isQuoteRef(m.re)) delete m.re; return m }

export function decodeEnvelope(bytes: Uint8Array): Envelope | null {
  let m: any
  try { m = JSON.parse(td.decode(bytes)) } catch { return null }
  if (m?.v !== ENVELOPE_V) return null
  if (typeof m.t !== 'string' || typeof m.id !== 'string' || typeof m.ts !== 'number' || typeof m.seq !== 'number') return null
  switch (m.t) {
    // A quote that does not decode loses the QUOTE, never the message: the
    // sentence somebody wrote is not collateral for a broken decoration.
    case 'msg': return (typeof m.body === 'string' && FORMATS.has(m.format)) ? (sanitizeQuote(m) as MsgEnv) : null
    case 'typing': return TYPING.has(m.state) ? (m as TypingEnv) : null
    case 'presence': return PRESENCE.has(m.state) ? (m as PresenceEnv) : null
    case 'reaction': return (typeof m.to === 'string' && typeof m.emoji === 'string') ? (m as ReactionEnv) : null
    // Same body rule as `msg`: plain text, a known format, nothing else — an
    // edit replaces what a bubble says, so it cannot be looser than what put
    // the text there in the first place.
    case 'edit': return (typeof m.to === 'string' && m.to.length > 0 && typeof m.body === 'string' && FORMATS.has(m.format)) ? (m as EditEnv) : null
    // Every field is required: a file envelope missing its key, chunking or
    // algorithm is not a partially useful message, it is an undecryptable one,
    // and accepting it would put a permanently broken bubble in the transcript.
    case 'file': return (typeof m.cid === 'string' && typeof m.name === 'string'
      && typeof m.size === 'number' && m.size >= 0 && typeof m.mime === 'string'
      && typeof m.key === 'string' && typeof m.alg === 'string'
      && Number.isInteger(m.chunk) && m.chunk > 0
      && Number.isInteger(m.chunks) && m.chunks > 0
      && (m.body === undefined || typeof m.body === 'string')) ? (sanitizeQuote(m) as FileEnv) : null
    case 'rtc': return (typeof m.to === 'string' && m.sig != null) ? (m as RtcEnv) : null
    case 'ack': return (typeof m.ref === 'string' && typeof m.rts === 'number') ? (m as AckEnv) : null
    case 'group-skd': return (typeof m.gid === 'string' && typeof m.gkPub === 'string' && typeof m.epoch === 'number'
      && typeof m.secret === 'string' && typeof m.chain === 'string' && Array.isArray(m.roster)
      && (m.ctr === undefined || (Number.isInteger(m.ctr) && m.ctr >= 0))) ? (m as GroupSkdEnv) : null
    case 'group-skd-req': return (typeof m.gid === 'string' && typeof m.epoch === 'number') ? (m as GroupSkdReqEnv) : null
    default: return m as UnknownEnv // forward-compat: dispatcher ignores unknown types
  }
}
