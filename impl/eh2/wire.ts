/**
 * eh2/wire.ts — EH-2 handshake wire format + transcript hashes (docs/PROTOCOL.md §6.1–6.2).
 *
 * STAGE 1 of the EH-2 build. Pure serialization: no keys, no DH, no MACs are
 * computed here — this layer only turns the three handshake frames into bytes
 * and back, and derives the transcript hashes those bytes feed.
 *
 *   I → R  msg1 { version, ek_i_pub, pq_pub, timestamp, initiator_id }
 *   R → I  msg2 { version, ek_r_pub, pq_ct,  timestamp, mac_r }
 *   I → R  msg3 { version, mac_i }
 *
 * **Canonical and deterministic by construction** — fixed field order, fixed
 * widths, explicit lengths, no optional fields, no trailing bytes accepted.
 * That property is load-bearing: `h1` hashes the *serialized* msg1, so if two
 * implementations could encode the same frame two ways, `SK` would differ.
 * (§7.3 names Protobuf v1 as the eventual wire truth; protobuf is NOT canonical
 * by nature, so a transcript over it would need this same discipline. Until
 * `proto/` exists this encoding is the wire format, and it is trivially
 * re-expressible as a protobuf message with deterministic serialization.)
 *
 * The handshake frames are a SEPARATE pre-session wire — they are not sealed
 * envelopes (the session key does not exist yet, that is the point of §6).
 * Malformed input is a protocol error, not a "not for us" case: decode throws
 * `WireError` and the caller MUST abort the handshake rather than continue.
 */

import { sha256, concat } from '../lib/wc.ts'

/** Wire version. Bump only with a spec revision — the peer rejects anything else. */
export const EH2_VERSION = 1

/** Frame type tags (first byte). */
export const T_MSG1 = 0x01
export const T_MSG2 = 0x02
export const T_MSG3 = 0x03

/** Fixed field widths (bytes). */
const X25519_PUB = 32
const MAC = 32
const TS = 8
const INITIATOR_ID = 8

/** ML-KEM-768 sizes (FIPS 203) — checked so a wrong-parameter-set peer fails loudly here. */
export const MLKEM768_PK = 1184
export const MLKEM768_CT = 1088

export class WireError extends Error {
  constructor(message: string) {
    super(`EH-2 wire: ${message}`)
    this.name = 'WireError'
  }
}

export interface Msg1 {
  /** EK_i_pub — initiator's ephemeral X25519 public key. */
  ekPub: Uint8Array
  /** ML-KEM-768 encapsulation key (initiator's ephemeral PQ public key). */
  pqPub: Uint8Array
  /** Unix epoch **ms**, UTC (replay window ±5 min, §6.4). */
  ts: number
  /** SHA-256(IK_i_pub)[0:8] — non-security hint so R can resolve the contact (§6.1). */
  initiatorId: Uint8Array
}

export interface Msg2 {
  /** EK_r_pub — responder's ephemeral X25519 public key. */
  ekPub: Uint8Array
  /** ML-KEM-768 ciphertext (encapsulated against msg1.pqPub). */
  pqCt: Uint8Array
  /** Unix epoch ms, UTC. This is `ts_r` in the h2_partial transcript. */
  ts: number
  /** HMAC-SHA256(SK, "responder" || h2_partial). */
  macR: Uint8Array
}

export interface Msg3 {
  /** HMAC-SHA256(SK, "initiator" || h3). */
  macI: Uint8Array
}

// ---------------------------------------------------------------------------
// primitives
// ---------------------------------------------------------------------------

function u64be(n: number): Uint8Array {
  if (!Number.isSafeInteger(n) || n < 0) throw new WireError(`timestamp must be a non-negative safe integer, got ${n}`)
  const b = new Uint8Array(TS)
  new DataView(b.buffer).setBigUint64(0, BigInt(n), false)
  return b
}

function readU64be(b: Uint8Array, off: number): number {
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength).getBigUint64(off, false)
  if (v > BigInt(Number.MAX_SAFE_INTEGER)) throw new WireError('timestamp out of safe range')
  return Number(v)
}

function u16be(n: number): Uint8Array {
  if (!Number.isInteger(n) || n < 0 || n > 0xffff) throw new WireError(`length ${n} does not fit u16`)
  return new Uint8Array([(n >> 8) & 0xff, n & 0xff])
}

function fixed(name: string, v: Uint8Array, len: number): Uint8Array {
  if (!(v instanceof Uint8Array)) throw new WireError(`${name} must be a Uint8Array`)
  if (v.length !== len) throw new WireError(`${name} must be ${len} B, got ${v.length}`)
  return v
}

/** Read the header (type, version) and return the offset of the first field. */
function header(b: Uint8Array, want: number, name: string): number {
  if (b.length < 2) throw new WireError(`${name}: truncated header`)
  if (b[0] !== want) throw new WireError(`${name}: wrong frame type 0x${b[0].toString(16)}`)
  if (b[1] !== EH2_VERSION) throw new WireError(`${name}: unsupported version ${b[1]} (expected ${EH2_VERSION})`)
  return 2
}

function exact(b: Uint8Array, off: number, name: string): void {
  if (off !== b.length) throw new WireError(`${name}: ${b.length - off} trailing byte(s)`)
}

function slice(b: Uint8Array, off: number, len: number, name: string): Uint8Array {
  if (off + len > b.length) throw new WireError(`${name}: truncated`)
  return b.slice(off, off + len)
}

// ---------------------------------------------------------------------------
// msg1
// ---------------------------------------------------------------------------

/** `0x01 | ver | ek_i_pub(32) | len(pq_pub) u16 | pq_pub | ts u64 | initiator_id(8)` */
export function encodeMsg1(m: Msg1): Uint8Array {
  fixed('msg1.ekPub', m.ekPub, X25519_PUB)
  fixed('msg1.pqPub', m.pqPub, MLKEM768_PK)
  fixed('msg1.initiatorId', m.initiatorId, INITIATOR_ID)
  return concat(
    new Uint8Array([T_MSG1, EH2_VERSION]),
    m.ekPub,
    u16be(m.pqPub.length), m.pqPub,
    u64be(m.ts),
    m.initiatorId,
  )
}

export function decodeMsg1(b: Uint8Array): Msg1 {
  let o = header(b, T_MSG1, 'msg1')
  const ekPub = slice(b, o, X25519_PUB, 'msg1.ekPub'); o += X25519_PUB
  if (o + 2 > b.length) throw new WireError('msg1.pqPub: truncated length')
  const pqLen = (b[o] << 8) | b[o + 1]; o += 2
  if (pqLen !== MLKEM768_PK) throw new WireError(`msg1.pqPub must be ${MLKEM768_PK} B (ML-KEM-768), got ${pqLen}`)
  const pqPub = slice(b, o, pqLen, 'msg1.pqPub'); o += pqLen
  if (o + TS > b.length) throw new WireError('msg1.ts: truncated')
  const ts = readU64be(b, o); o += TS
  const initiatorId = slice(b, o, INITIATOR_ID, 'msg1.initiatorId'); o += INITIATOR_ID
  exact(b, o, 'msg1')
  return { ekPub, pqPub, ts, initiatorId }
}

// ---------------------------------------------------------------------------
// msg2
// ---------------------------------------------------------------------------

/** `0x02 | ver | ek_r_pub(32) | len(pq_ct) u16 | pq_ct | ts u64 | mac_r(32)` */
export function encodeMsg2(m: Msg2): Uint8Array {
  fixed('msg2.ekPub', m.ekPub, X25519_PUB)
  fixed('msg2.pqCt', m.pqCt, MLKEM768_CT)
  fixed('msg2.macR', m.macR, MAC)
  return concat(
    new Uint8Array([T_MSG2, EH2_VERSION]),
    m.ekPub,
    u16be(m.pqCt.length), m.pqCt,
    u64be(m.ts),
    m.macR,
  )
}

export function decodeMsg2(b: Uint8Array): Msg2 {
  let o = header(b, T_MSG2, 'msg2')
  const ekPub = slice(b, o, X25519_PUB, 'msg2.ekPub'); o += X25519_PUB
  if (o + 2 > b.length) throw new WireError('msg2.pqCt: truncated length')
  const ctLen = (b[o] << 8) | b[o + 1]; o += 2
  if (ctLen !== MLKEM768_CT) throw new WireError(`msg2.pqCt must be ${MLKEM768_CT} B (ML-KEM-768), got ${ctLen}`)
  const pqCt = slice(b, o, ctLen, 'msg2.pqCt'); o += ctLen
  if (o + TS > b.length) throw new WireError('msg2.ts: truncated')
  const ts = readU64be(b, o); o += TS
  const macR = slice(b, o, MAC, 'msg2.macR'); o += MAC
  exact(b, o, 'msg2')
  return { ekPub, pqCt, ts, macR }
}

// ---------------------------------------------------------------------------
// msg3
// ---------------------------------------------------------------------------

/** `0x03 | ver | mac_i(32)` */
export function encodeMsg3(m: Msg3): Uint8Array {
  fixed('msg3.macI', m.macI, MAC)
  return concat(new Uint8Array([T_MSG3, EH2_VERSION]), m.macI)
}

export function decodeMsg3(b: Uint8Array): Msg3 {
  let o = header(b, T_MSG3, 'msg3')
  const macI = slice(b, o, MAC, 'msg3.macI'); o += MAC
  exact(b, o, 'msg3')
  return { macI }
}

// ---------------------------------------------------------------------------
// transcript (§6.2)
// ---------------------------------------------------------------------------

/**
 * `h1 = SHA-256(serialize(msg1))` — the HKDF salt for SK, which is what makes
 * every session's SK unique (replay protection, §6.4).
 */
export function h1(msg1Bytes: Uint8Array): Promise<Uint8Array> {
  return sha256(msg1Bytes)
}

/**
 * `h2_partial = SHA-256(serialize(msg1) || EK_r_pub || ct || ts_r)`.
 *
 * Note the spec's exact shape: msg2's *fields* enter the hash, not its
 * serialization — mac_r cannot be inside the transcript it authenticates, and
 * the type/version bytes stay out. `ts_r` uses the same 8-byte big-endian
 * encoding as the wire, so both sides hash identical bytes.
 */
export function h2Partial(msg1Bytes: Uint8Array, ekRPub: Uint8Array, pqCt: Uint8Array, tsR: number): Promise<Uint8Array> {
  fixed('h2_partial.ekRPub', ekRPub, X25519_PUB)
  fixed('h2_partial.pqCt', pqCt, MLKEM768_CT)
  return sha256(concat(msg1Bytes, ekRPub, pqCt, u64be(tsR)))
}

/** `h3 = SHA-256(h2_partial || mac_r)` — binds R's authenticator into I's MAC. */
export function h3(h2partial: Uint8Array, macR: Uint8Array): Promise<Uint8Array> {
  fixed('h3.h2partial', h2partial, 32)
  fixed('h3.macR', macR, MAC)
  return sha256(concat(h2partial, macR))
}

/**
 * `initiator_id = SHA-256(IK_i_pub)[0:8]` — a contact-book lookup hint only.
 * Never treat it as authentication: it is public and unauthenticated until
 * `mac_i` verifies (§6.2, msg3 gating).
 */
export async function initiatorId(ikIPub: Uint8Array): Promise<Uint8Array> {
  fixed('initiatorId.ikIPub', ikIPub, X25519_PUB)
  return (await sha256(ikIPub)).slice(0, INITIATOR_ID)
}
