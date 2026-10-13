/**
 * senderkey.ts — group Sender Keys (docs/SPEC.md §8, ECDH-HMAC Proposal).
 *
 * Each group MEMBER has one sending chain: a symmetric hash-ratchet that yields a
 * fresh message key per message and steps forward, giving per-message forward
 * secrecy within an epoch. Recipients hold a copy of that chain and walk it to
 * each message's counter. There is NO DH ratchet here — post-compromise recovery
 * for a group comes from epoch rotation on a membership change, not the chain.
 *
 *   MK_n        = HKDF(chain_n, "encedo-group-msg")
 *   chain_{n+1} = HKDF(chain_n, "encedo-group-chain")
 *   nonce       = HKDF(MK_n, salt = n, info = "encedo-aead-nonce")  // the one nonce of 1:1 and groups
 *   ct          = AES-256-GCM(MK_n, nonce, plaintext, aad = header)
 *
 * Authentication is a per-recipient HMAC, NOT a signature (deniability, S3
 * removed): the pairwise key `mk_ij = HKDF(ECDH(IK_i,IK_j), ...)` is derived by the
 * caller (it needs the identities) — this module only applies/verifies the HMAC
 * over `header || ct`. The AEAD tag protects the body under the chain key; the
 * HMAC is what stops an INSIDER (who holds the sender's chain, so could re-seal a
 * body) from forging a message as another member to a third party.
 *
 * WebCrypto only (HKDF + AES-GCM + HMAC); no third-party crypto.
 */

import { subtle, kdf, aeadNonce, randomBytes, concat } from './wc.ts'
import { nowMs } from './time.ts'

const enc = new TextEncoder()
const MK_LABEL = 'encedo-group-msg'
const CK_LABEL = 'encedo-group-chain'

/** Bounded catch-up: a header claiming a jump past this many messages is dropped
 *  (DoS — a peer must not make us derive unbounded keys). Group chains are not
 *  DH-reset, so the window is a plain per-chain cap. */
export const MAX_SKIP = 2000
export const SKIPPED_TTL_MS = 24 * 60 * 60 * 1000

const msgKey = (ck: Uint8Array) => kdf(MK_LABEL, ck)
const chainNext = (ck: Uint8Array) => kdf(CK_LABEL, ck)

// The nonce is the same construction as the 1:1 ratchet's (lib/wc.ts
// aeadNonce): from the single-use MK and the counter it seals. MK never seals
// twice, so the counter adds nothing cryptographically; it removes the second
// construction an auditor had to hold (S7).
async function aeadSeal(mk: Uint8Array, n: number, header: Uint8Array, pt: Uint8Array): Promise<Uint8Array> {
  const key = await subtle.importKey('raw', mk, { name: 'AES-GCM' }, false, ['encrypt'])
  return new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv: await aeadNonce(mk, n), additionalData: header }, key, pt))
}
async function aeadOpen(mk: Uint8Array, n: number, header: Uint8Array, ct: Uint8Array): Promise<Uint8Array | null> {
  const key = await subtle.importKey('raw', mk, { name: 'AES-GCM' }, false, ['decrypt'])
  try { return new Uint8Array(await subtle.decrypt({ name: 'AES-GCM', iv: await aeadNonce(mk, n), additionalData: header }, key, ct)) }
  catch { return null }
}

// ---------------------------------------------------------------------------
// per-recipient MAC (the caller supplies mk_ij = HKDF(ECDH(IK_i,IK_j), ...))
// ---------------------------------------------------------------------------

async function hmacKey(macKey: Uint8Array): Promise<CryptoKey> {
  return subtle.importKey('raw', macKey, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify'])
}
/** MAC over `header || ct` for one recipient. */
export async function tag(macKey: Uint8Array, header: Uint8Array, ct: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await subtle.sign('HMAC', await hmacKey(macKey), concat(header, ct)))
}
/** Constant-time verify (WebCrypto `verify` compares the tag internally). */
export async function verify(macKey: Uint8Array, header: Uint8Array, ct: Uint8Array, mac: Uint8Array): Promise<boolean> {
  return subtle.verify('HMAC', await hmacKey(macKey), mac, concat(header, ct))
}

// ---------------------------------------------------------------------------
// sending chain (my own)
// ---------------------------------------------------------------------------

export interface SendChain { key: Uint8Array; n: number }
/** Fresh sending chain (a new sender key for a member at a new epoch). */
export function newSendChain(): SendChain { return { key: randomBytes(32), n: 0 } }
/** A sending chain seeded from a distributed key (for tests / re-import). */
export function sendChainFrom(key: Uint8Array): SendChain { return { key: key.slice(), n: 0 } }

/** Seal `plaintext` at the chain's current position, then advance. Returns the
 *  counter used (goes into the header the caller MACs) and the ciphertext. */
export async function seal(chain: SendChain, header: Uint8Array, plaintext: Uint8Array): Promise<{ n: number; ct: Uint8Array }> {
  const mk = await msgKey(chain.key)
  const n = chain.n
  const ct = await aeadSeal(mk, n, header, plaintext)
  const next = await chainNext(chain.key)
  chain.key.fill(0); chain.key = next; chain.n++
  mk.fill(0)
  return { n, ct }
}

// ---------------------------------------------------------------------------
// receiving chain (a copy of one sender's chain)
// ---------------------------------------------------------------------------

export interface ReceiverOpts { maxSkip?: number; ttlMs?: number; now?: () => number }

/**
 * One sender's receiving chain. Walks forward to a message's counter, holding the
 * message keys it skips over so a message that overtook this one can still open
 * later (bounded — §7.3-style DoS cap). Transactional: state moves only once the
 * AEAD opens the frame, so a forged/tampered frame cannot burn the chain.
 */
export class SenderReceiver {
  private key: Uint8Array
  private n = 0
  private skipped = new Map<number, { mk: Uint8Array; ts: number }>()
  private maxSkip: number
  private ttlMs: number
  private now: () => number

  constructor(chainKey: Uint8Array, opts: ReceiverOpts = {}) {
    this.key = chainKey.slice()
    this.maxSkip = opts.maxSkip ?? MAX_SKIP
    this.ttlMs = opts.ttlMs ?? SKIPPED_TTL_MS
    this.now = opts.now ?? nowMs
  }

  private prune(): void {
    const t = this.now()
    for (const [n, s] of this.skipped) if (t - s.ts > this.ttlMs) { s.mk.fill(0); this.skipped.delete(n) }
  }

  /** Decrypt the message at counter `n`, or null if it does not open (foreign,
   *  tampered, or a replay of a spent key). Throws on a jump past the skip bound. */
  async open(n: number, header: Uint8Array, ct: Uint8Array): Promise<Uint8Array | null> {
    this.prune()

    // 1. A key we derived for a message that overtook this one.
    const stashed = this.skipped.get(n)
    if (stashed) {
      const pt = await aeadOpen(stashed.mk, n, header, ct)
      if (pt) { stashed.mk.fill(0); this.skipped.delete(n) }
      return pt
    }
    if (n < this.n) return null // already passed and not stashed -> replay

    if (n - this.n > this.maxSkip) throw new Error(`senderkey: skip of ${n - this.n} over the ${this.maxSkip} bound`)

    // 2. Walk forward from where we are to n, deriving the keys passed over.
    //    PURE until the AEAD verifies (nothing committed on failure).
    let cur = this.key
    const passed: { n: number; mk: Uint8Array; ck: Uint8Array }[] = []
    for (let i = this.n; i < n; i++) {
      const mk = await msgKey(cur)
      const next = await chainNext(cur)
      passed.push({ n: i, mk, ck: next })
      cur = next
    }
    const mkN = await msgKey(cur)
    const nextCk = await chainNext(cur)
    const pt = await aeadOpen(mkN, n, header, ct)
    if (!pt) {
      mkN.fill(0); nextCk.fill(0)
      for (const p of passed) { p.mk.fill(0); p.ck.fill(0) }
      return null // do NOT advance — a forged frame must not burn the chain
    }
    // Commit: stash the skipped keys, advance to n+1.
    const t = this.now()
    for (const p of passed) { this.skipped.set(p.n, { mk: p.mk, ts: t }); p.ck.fill(0) }
    this.key.fill(0); this.key = nextCk
    this.n = n + 1
    mkN.fill(0)
    return pt
  }

  stats(): { n: number; skipped: number } { return { n: this.n, skipped: this.skipped.size } }

  /** The live chain position for persistence (§10). Skipped keys are intentionally
   *  dropped — a restore loses only in-flight out-of-order frames, never the chain. */
  snapshot(): { key: Uint8Array; n: number } { return { key: this.key.slice(), n: this.n } }
  /** Rebuild a receiver at a saved chain position (raw bytes; caller deserializes). */
  static from(key: Uint8Array, n: number, opts: ReceiverOpts = {}): SenderReceiver {
    const r = new SenderReceiver(key, opts); r.n = n; return r
  }
}
