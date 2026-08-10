/**
 * eh2/handshake.ts — the EH-2 handshake state machines (docs/PROTOCOL.md §6).
 *
 * Interactive, Noise-XX-flavored, 1.5 round-trips, mutually authenticated by
 * MACs over the transcript (no signatures → deniability, §6.4). Output: `SK`
 * (32 B) = the ratchet's `RK_0`.
 *
 *   I: initiate()            → msg1 ──────────────▶ respond()            :R
 *   I: initiatorComplete()  ◀────────── msg2 ←──── (R holds SK, sends mac_r)
 *   I: (holds SK)            → msg3 ──────────────▶ responderComplete()  :R
 *
 * **DH ordering is responder-perspective (§6.3)** — the classic "SK doesn't
 * match" bug. Both sides build:
 *
 *     ikm = DH(IK_r, EK_i) || DH(EK_r, IK_i) || DH(EK_r, EK_i) || ss
 *     SK  = HKDF-SHA256(ikm, salt = h1, info = "encedo-handshake-v2", L = 32)
 *
 * Each side performs exactly ONE DH with its own long-term IK — that one goes
 * through the HSM in raw mode; the other two are local ephemeral DHs. The `Dh`
 * interface hides which is which, so this module works identically with a HEM
 * identity and a software one.
 *
 * Layering: this module computes and verifies, it does NOT do I/O. The caller
 * moves the three frames over whatever transport it has and decides who the
 * peer is (contact-book resolution via `initiator_id`).
 *
 * ⚠️ msg3 gating (§6.2): until `responderComplete()` returns, the initiator is
 * UNAUTHENTICATED — R must not accept application or ratchet data from it.
 * ⚠️ PQ: `ss` comes from the injected `Kem`. Stage 2 of the build runs the
 * classical schedule alone; ML-KEM-768 plugs in behind this interface (stage 3)
 * without touching the key schedule.
 */

import { subtle, hkdfBits, concat } from '../lib/wc.ts'
import { plog, val } from '../lib/protolog.ts'
import { nowMs } from '../lib/time.ts'
import type { Dh } from '../lib/x25519.ts'
import { generateX25519 } from '../lib/x25519.ts'
import {
  encodeMsg1, decodeMsg1, encodeMsg2, decodeMsg2, encodeMsg3, decodeMsg3,
  h1 as hashMsg1, h2Partial, h3 as hashH3, initiatorId,
} from './wire.ts'

const enc = new TextEncoder()
const SK_INFO = enc.encode('encedo-handshake-v2')
const LABEL_R = enc.encode('responder')
const LABEL_I = enc.encode('initiator')

/** Replay window on handshake timestamps (§6.4). */
export const MAX_SKEW_MS = 5 * 60_000

export class HandshakeError extends Error {
  constructor(message: string) {
    super(`EH-2: ${message}`)
    this.name = 'HandshakeError'
  }
}

// ---------------------------------------------------------------------------
// KEM seam (ML-KEM-768 lands behind this in stage 3)
// ---------------------------------------------------------------------------

export interface KemKey {
  /** Encapsulation key, on the wire as msg1.pqPub. */
  pub: Uint8Array
  /** Recover `ss` from the peer's ciphertext. */
  decapsulate(ct: Uint8Array): Promise<Uint8Array>
}

export interface Kem {
  readonly name: string
  /** Initiator: fresh per-handshake encapsulation keypair (ephemeral, never from the HSM). */
  generate(): Promise<KemKey>
  /** Responder: encapsulate against the initiator's key → (ct, ss). */
  encapsulate(pub: Uint8Array): Promise<{ ct: Uint8Array; ss: Uint8Array }>
}

// ---------------------------------------------------------------------------
// result
// ---------------------------------------------------------------------------

export interface HandshakeResult {
  role: 'initiator' | 'responder'
  /** SK — 32 B, becomes the ratchet's RK_0. */
  sk: Uint8Array
  /**
   * Initiator: EK_i, kept as its FIRST ratchet private key (§6.2 — this is the
   * one ephemeral that outlives the handshake, until the first DH-ratchet step
   * replaces it). Responder: null — R seeds from EK_i_pub and generates its own
   * ratchet key when it first sends.
   */
  ekSelf: Dh | null
  /** The peer's EK public — the ratchet's initial `DH_peer_pub`. */
  ekPeerPub: Uint8Array
  /**
   * `DH(EK_r, EK_i)`, already computed for `ikm`. It is exactly the input the
   * first DH-ratchet step needs, and both sides have it — so the ratchet can
   * start without R keeping `EK_r_priv` alive past the handshake. Consumed
   * immediately by the ratchet (stage 4), then dropped.
   */
  firstStepIkm: Uint8Array
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/** Best-effort erasure. JS cannot guarantee it (GC copies), but leaving live
 *  references to DH outputs is strictly worse — §6.2 asks for zeroization. */
function wipe(...bufs: Uint8Array[]): void {
  for (const b of bufs) b.fill(0)
}

function checkSkew(ts: number, now: number, what: string, maxSkewMs: number): void {
  if (Math.abs(now - ts) > maxSkewMs) {
    throw new HandshakeError(`${what} timestamp outside the ±${maxSkewMs / 60_000} min window (skew ${now - ts} ms)`)
  }
}

async function deriveSK(dh1: Uint8Array, dh2: Uint8Array, dh3: Uint8Array, ss: Uint8Array, h1: Uint8Array): Promise<Uint8Array> {
  const ikm = concat(dh1, dh2, dh3, ss)
  try {
    return await hkdfBits(ikm, h1, SK_INFO, 32)
  } finally {
    wipe(ikm, dh1, dh2, ss) // dh3 survives: it is the first ratchet step's input
  }
}

async function macKey(sk: Uint8Array): Promise<CryptoKey> {
  return subtle.importKey('raw', sk, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify'])
}

async function mac(sk: CryptoKey, label: Uint8Array, transcript: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await subtle.sign('HMAC', sk, concat(label, transcript)))
}

/** Constant-time by construction — WebCrypto compares the tag, we never do. */
async function macVerify(sk: CryptoKey, label: Uint8Array, transcript: Uint8Array, tag: Uint8Array): Promise<boolean> {
  return subtle.verify('HMAC', sk, tag, concat(label, transcript))
}

// ---------------------------------------------------------------------------
// initiator
// ---------------------------------------------------------------------------

export interface InitiatorState {
  ik: Dh
  peerIkPub: Uint8Array
  ekI: Dh
  pq: KemKey
  msg1Bytes: Uint8Array
  maxSkewMs: number
}

/**
 * I: generate the ephemerals and emit msg1. Nothing is authenticated yet — msg1
 * is public material; the transcript that binds it is hashed into SK.
 */
export async function initiate(opts: {
  ik: Dh
  peerIkPub: Uint8Array
  kem: Kem
  now?: number
  maxSkewMs?: number
  /** Inject EK_i instead of generating it — known-answer tests only. */
  ek?: Dh
}): Promise<{ msg1: Uint8Array; state: InitiatorState }> {
  const { ik, peerIkPub, kem } = opts
  if (peerIkPub.length !== 32) throw new HandshakeError('peer IK public key must be 32 B')
  const ekI = opts.ek ?? await generateX25519()
  const pq = await kem.generate()
  const msg1 = encodeMsg1({
    ekPub: ekI.pub,
    pqPub: pq.pub,
    ts: opts.now ?? nowMs(),
    initiatorId: await initiatorId(ik.pub),
  })
  plog('§6.1', `I → msg1: EK_i=${val(ekI.pub)} pq_pub=${val(pq.pub)} initiator_id=${val(await initiatorId(ik.pub))} (${msg1.length} B)`)
  return { msg1, state: { ik, peerIkPub, ekI, pq, msg1Bytes: msg1, maxSkewMs: opts.maxSkewMs ?? MAX_SKEW_MS } }
}

/**
 * I: consume msg2 → derive SK, verify R's MAC (this is where R gets
 * authenticated), emit msg3. After this the initiator may send immediately.
 */
export async function initiatorComplete(
  state: InitiatorState,
  msg2Bytes: Uint8Array,
  opts: { now?: number } = {},
): Promise<{ msg3: Uint8Array; result: HandshakeResult }> {
  const msg2 = decodeMsg2(msg2Bytes)
  checkSkew(msg2.ts, opts.now ?? nowMs(), 'msg2', state.maxSkewMs)

  // Responder perspective (§6.3), computed from I's side via X25519 commutativity.
  const dh1 = await state.ekI.dh(state.peerIkPub)   // DH(IK_r, EK_i)
  const dh2 = await state.ik.dh(msg2.ekPub)         // DH(EK_r, IK_i)  ← the HSM call
  const dh3 = await state.ekI.dh(msg2.ekPub)        // DH(EK_r, EK_i)
  const ss = await state.pq.decapsulate(msg2.pqCt)

  const h1 = await hashMsg1(state.msg1Bytes)
  // Logged BEFORE the derivation: deriveSK wipes dh1/dh2/ss on its way out (only
  // dh3 survives, as the first ratchet step's input), so reading them afterwards
  // prints zeros and looks like a broken DH.
  plog('§6.3', `I ikm (responder perspective): DH(IK_r,EK_i)=${val(dh1)} DH(EK_r,IK_i)=${val(dh2)} DH(EK_r,EK_i)=${val(dh3)} mlkem_ss=${val(ss)}`)
  const sk = await deriveSK(dh1, dh2, dh3, ss, h1)
  plog('§6.2', `I h1=${val(h1)} → SK=${val(sk)}`)

  const key = await macKey(sk)
  const h2p = await h2Partial(state.msg1Bytes, msg2.ekPub, msg2.pqCt, msg2.ts)
  if (!(await macVerify(key, LABEL_R, h2p, msg2.macR))) {
    wipe(sk, dh3)
    throw new HandshakeError('mac_r does not verify — responder is not the expected peer (or the transcript was tampered with)')
  }

  plog('§6.2', `I verified mac_r over h2_partial=${val(h2p)} — responder authenticated`)
  const h3 = await hashH3(h2p, msg2.macR)
  const macI = await mac(key, LABEL_I, h3)
  plog('§6.1', `I → msg3: h3=${val(h3)} mac_i=${val(macI)}`)
  return {
    msg3: encodeMsg3({ macI }),
    result: { role: 'initiator', sk, ekSelf: state.ekI, ekPeerPub: msg2.ekPub, firstStepIkm: dh3 },
  }
}

// ---------------------------------------------------------------------------
// responder
// ---------------------------------------------------------------------------

export interface ResponderState {
  sk: Uint8Array
  h3: Uint8Array
  ekPeerPub: Uint8Array
  firstStepIkm: Uint8Array
}

/**
 * R: consume msg1 → derive SK, emit msg2 with `mac_r` (this authenticates R to
 * I). R holds SK here but MUST NOT accept data from I until msg3 verifies.
 *
 * `peerIkPub` is the caller's contact-book resolution of `msg1.initiator_id`;
 * the id itself is only a hint (§6.1), so we re-check it against the key the
 * caller supplied — a mismatch means the wrong contact was resolved.
 */
export async function respond(opts: {
  ik: Dh
  peerIkPub: Uint8Array
  msg1: Uint8Array
  kem: Kem
  now?: number
  maxSkewMs?: number
  /** Inject EK_r instead of generating it — known-answer tests only. */
  ek?: Dh
}): Promise<{ msg2: Uint8Array; state: ResponderState }> {
  const { ik, peerIkPub, kem } = opts
  if (peerIkPub.length !== 32) throw new HandshakeError('peer IK public key must be 32 B')
  const msg1 = decodeMsg1(opts.msg1)
  const now = opts.now ?? nowMs()
  checkSkew(msg1.ts, now, 'msg1', opts.maxSkewMs ?? MAX_SKEW_MS)

  const expectId = await initiatorId(peerIkPub)
  if (!expectId.every((b, i) => b === msg1.initiatorId[i])) {
    throw new HandshakeError('initiator_id does not match the resolved contact IK')
  }

  const ekR = opts.ek ?? await generateX25519()
  const { ct, ss } = await kem.encapsulate(msg1.pqPub)

  const dh1 = await ik.dh(msg1.ekPub)      // DH(IK_r, EK_i)  ← the HSM call
  const dh2 = await ekR.dh(peerIkPub)      // DH(EK_r, IK_i)
  const dh3 = await ekR.dh(msg1.ekPub)     // DH(EK_r, EK_i)

  const h1 = await hashMsg1(opts.msg1)
  plog('§6.3', `R ikm: DH(IK_r,EK_i)=${val(dh1)} DH(EK_r,IK_i)=${val(dh2)} DH(EK_r,EK_i)=${val(dh3)} mlkem_ss=${val(ss)}`)
  const sk = await deriveSK(dh1, dh2, dh3, ss, h1)
  plog('§6.2', `R h1=${val(h1)} → SK=${val(sk)}`)

  // EK_r_priv is not retained past this point: dh3 already carries everything
  // the first ratchet step needs (§6.2 zeroization, see HandshakeResult).
  const tsR = now
  const key = await macKey(sk)
  const h2p = await h2Partial(opts.msg1, ekR.pub, ct, tsR)
  const macR = await mac(key, LABEL_R, h2p)

  plog('§6.1', `R → msg2: EK_r=${val(ekR.pub)} pq_ct=${val(ct)} mac_r=${val(macR)}`)
  return {
    msg2: encodeMsg2({ ekPub: ekR.pub, pqCt: ct, ts: tsR, macR }),
    state: { sk, h3: await hashH3(h2p, macR), ekPeerPub: msg1.ekPub, firstStepIkm: dh3 },
  }
}

/**
 * R: verify msg3. **This is the gate** — only after it returns may R accept
 * application/ratchet data from I (§6.2). A failure means the initiator could
 * not derive SK, i.e. it does not hold IK_i_priv: abort the connection.
 */
export async function responderComplete(state: ResponderState, msg3Bytes: Uint8Array): Promise<HandshakeResult> {
  const { macI } = decodeMsg3(msg3Bytes)
  const key = await macKey(state.sk)
  if (!(await macVerify(key, LABEL_I, state.h3, macI))) {
    wipe(state.sk, state.firstStepIkm)
    throw new HandshakeError('mac_i does not verify — initiator is not authenticated, drop the session')
  }
  plog('§6.2', 'R verified mac_i — initiator authenticated, the session may accept data')
  return {
    role: 'responder',
    sk: state.sk,
    ekSelf: null,
    ekPeerPub: state.ekPeerPub,
    firstStepIkm: state.firstStepIkm,
  }
}
