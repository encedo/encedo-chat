/**
 * eh2/ratchet.ts — Double Ratchet over the EH-2 handshake (docs/PROTOCOL.md §7).
 *
 * Signal-style, `RK_0 = SK`. Two ratchets turn one handshake into per-message
 * keys: a symmetric one that advances a chain key on every message (per-message
 * forward secrecy), and a DH one that mixes a fresh X25519 output into the root
 * key whenever the direction of the conversation turns (post-compromise
 * recovery).
 *
 *     DH step:   RK', CK = HKDF(ikm = X25519(DH_self, DH_peer), salt = RK,
 *                               info = "encedo-ratchet-dh-v1", L = 64)
 *     MK         = HKDF(CK, info = "encedo-msg-key",   L = 32)
 *     CK'        = HKDF(CK, info = "encedo-chain-key", L = 32)
 *     nonce      = HKDF(MK, info = "encedo-aead-nonce" || N, L = 12)
 *     frame      = header || AES-256-GCM(MK, nonce, plaintext, aad = header)
 *     header     = { dh_pub, pn, n }
 *
 * Seeding (§6.2): the handshake already computed `DH(EK_r, EK_i)`, so the first
 * DH step runs at construction from that value — the initiator gets a sending
 * chain immediately and the responder the matching receiving chain, without R
 * having to keep `EK_r_priv` alive. R generates its own ratchet key the first
 * time it sends.
 *
 * Late/out-of-order messages are handled by deriving and holding the skipped
 * message keys, under the §7.3 bounds (1000 per chain, 5 chains back, 24 h) —
 * those bounds are DoS protection: a peer claiming a huge `n` must not be able
 * to make us derive unbounded keys.
 *
 * WebCrypto only (HKDF + AES-GCM + X25519); no third-party crypto here.
 */

import { subtle, hkdfBits, concat, b64 } from '../lib/wc.ts'
import { nowMs } from '../lib/time.ts'
import { generateX25519, type Dh } from '../lib/x25519.ts'
import type { HandshakeResult } from './handshake.ts'

const enc = new TextEncoder()
const RK_INFO = enc.encode('encedo-ratchet-dh-v1')
const MK_INFO = enc.encode('encedo-msg-key')
const CK_INFO = enc.encode('encedo-chain-key')
const NONCE_INFO = enc.encode('encedo-aead-nonce')
const NO_SALT = new Uint8Array(0)

/** Frame tag + version (distinct from the handshake frames of eh2/wire.ts). */
const T_DATA = 0x10
const VERSION = 1
const HDR_LEN = 2 + 32 + 4 + 4

/** §7.3 bounds. */
export const MAX_SKIP_PER_CHAIN = 1000
export const MAX_CHAINS_BACK = 5
export const SKIPPED_TTL_MS = 24 * 60 * 60 * 1000

export class RatchetError extends Error {
  constructor(message: string) {
    super(`ratchet: ${message}`)
    this.name = 'RatchetError'
  }
}

export interface Ratchet {
  /** Seal a plaintext into a self-describing frame (header + AEAD). */
  encrypt(plaintext: Uint8Array): Promise<Uint8Array>
  /** Open a frame, or null if it is not ours / not decryptable. */
  decrypt(frame: Uint8Array): Promise<Uint8Array | null>
  /** Diagnostics for tests and the security panel — counters in the CURRENT
   *  chains (they reset on every DH step), never secrets. */
  stats(): { nSend: number; nRecv: number; skipped: number; dhPub: string | null }
}

interface Header { dhPub: Uint8Array; pn: number; n: number }

// ---------------------------------------------------------------------------
// header wire
// ---------------------------------------------------------------------------

function encodeHeader(h: Header): Uint8Array {
  const b = new Uint8Array(HDR_LEN)
  b[0] = T_DATA; b[1] = VERSION
  b.set(h.dhPub, 2)
  const dv = new DataView(b.buffer)
  dv.setUint32(34, h.pn, false)
  dv.setUint32(38, h.n, false)
  return b
}

function decodeHeader(frame: Uint8Array): Header | null {
  if (frame.length < HDR_LEN + 16) return null // 16 = minimum GCM tag
  if (frame[0] !== T_DATA || frame[1] !== VERSION) return null
  const dv = new DataView(frame.buffer, frame.byteOffset, frame.byteLength)
  return { dhPub: frame.slice(2, 34), pn: dv.getUint32(34, false), n: dv.getUint32(38, false) }
}

// ---------------------------------------------------------------------------
// KDFs
// ---------------------------------------------------------------------------

async function dhStep(rk: Uint8Array, ikm: Uint8Array): Promise<{ rk: Uint8Array; ck: Uint8Array }> {
  const out = await hkdfBits(ikm, rk, RK_INFO, 64)
  return { rk: out.slice(0, 32), ck: out.slice(32) }
}

const messageKey = (ck: Uint8Array) => hkdfBits(ck, NO_SALT, MK_INFO, 32)
const chainNext = (ck: Uint8Array) => hkdfBits(ck, NO_SALT, CK_INFO, 32)

async function aeadKey(mk: Uint8Array): Promise<{ key: CryptoKey; nonce: (n: number) => Promise<Uint8Array> }> {
  const key = await subtle.importKey('raw', mk, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt'])
  return {
    key,
    nonce: async (n: number) => {
      const nb = new Uint8Array(4)
      new DataView(nb.buffer).setUint32(0, n, false)
      return hkdfBits(mk, NO_SALT, concat(NONCE_INFO, nb), 12)
    },
  }
}

// ---------------------------------------------------------------------------
// skipped-key store (bounded — §7.3)
// ---------------------------------------------------------------------------

interface Skipped { mk: Uint8Array; ts: number }

class SkippedKeys {
  /** chain pub (b64) → (n → key) */
  private chains = new Map<string, Map<number, Skipped>>()
  private ttlMs: number
  private maxChains: number

  // No parameter properties: Node runs this .ts in strip-only mode.
  constructor(ttlMs: number, maxChains: number) {
    this.ttlMs = ttlMs
    this.maxChains = maxChains
  }

  put(dhPub: Uint8Array, n: number, mk: Uint8Array, now: number): void {
    const k = b64(dhPub)
    let chain = this.chains.get(k)
    if (!chain) {
      chain = new Map()
      this.chains.set(k, chain)
      // Map preserves insertion order: the oldest chain is the first key.
      while (this.chains.size > this.maxChains) {
        const oldest = this.chains.keys().next().value as string
        for (const s of this.chains.get(oldest)!.values()) s.mk.fill(0)
        this.chains.delete(oldest)
      }
    }
    chain.set(n, { mk, ts: now })
  }

  /** Look, don't consume — the key is only spent once the AEAD actually opens. */
  peek(dhPub: Uint8Array, n: number): Uint8Array | null {
    return this.chains.get(b64(dhPub))?.get(n)?.mk ?? null
  }

  drop(dhPub: Uint8Array, n: number): void {
    const k = b64(dhPub)
    const chain = this.chains.get(k)
    if (!chain) return
    chain.delete(n)
    if (chain.size === 0) this.chains.delete(k)
  }

  prune(now: number): void {
    for (const [k, chain] of this.chains) {
      for (const [n, s] of chain) {
        if (now - s.ts > this.ttlMs) { s.mk.fill(0); chain.delete(n) }
      }
      if (chain.size === 0) this.chains.delete(k)
    }
  }

  get size(): number {
    let n = 0
    for (const c of this.chains.values()) n += c.size
    return n
  }
}

// ---------------------------------------------------------------------------
// the ratchet
// ---------------------------------------------------------------------------

export interface RatchetOpts {
  maxSkipPerChain?: number
  maxChainsBack?: number
  skippedTtlMs?: number
  now?: () => number
}

/**
 * Build the conversation's ratchet from a completed handshake. Call it only
 * after `responderComplete()` on R's side — before that the initiator is
 * unauthenticated and must not be given a live session (§6.2 msg3 gating).
 */
export async function ratchetFrom(hs: HandshakeResult, opts: RatchetOpts = {}): Promise<Ratchet> {
  const maxSkip = opts.maxSkipPerChain ?? MAX_SKIP_PER_CHAIN
  const ttl = opts.skippedTtlMs ?? SKIPPED_TTL_MS
  const now = opts.now ?? nowMs
  const skipped = new SkippedKeys(ttl, opts.maxChainsBack ?? MAX_CHAINS_BACK)

  // Root state. The first DH step consumes the handshake's DH(EK_r, EK_i).
  let rk = hs.sk
  let dhSelf: Dh | null = hs.ekSelf
  let dhPeerPub = hs.ekPeerPub
  let ckSend: Uint8Array | null = null
  let ckRecv: Uint8Array | null = null
  let nSend = 0, nRecv = 0, pn = 0
  /** Set when the next send must open a new sending chain with a fresh key. */
  let stepBeforeSend: boolean

  const first = await dhStep(rk, hs.firstStepIkm)
  hs.firstStepIkm.fill(0)
  hs.sk.fill(0) // RK_0 is consumed by the first step — the handshake result dies here
  rk = first.rk
  if (hs.role === 'initiator') {
    ckSend = first.ck        // I can send at once; R derives the matching recv chain
    stepBeforeSend = false
  } else {
    ckRecv = first.ck        // R reads I's first chain; its own send needs a new key
    stepBeforeSend = true
  }

  async function encrypt(plaintext: Uint8Array): Promise<Uint8Array> {
    if (stepBeforeSend || !ckSend) {
      dhSelf = await generateX25519()
      const step = await dhStep(rk, await dhSelf.dh(dhPeerPub))
      rk.fill(0); rk = step.rk
      if (ckSend) ckSend.fill(0)
      ckSend = step.ck
      pn = nSend
      nSend = 0
      stepBeforeSend = false
    }
    const mk = await messageKey(ckSend!)
    const next = await chainNext(ckSend!)
    ckSend!.fill(0); ckSend = next

    const header = encodeHeader({ dhPub: dhSelf!.pub, pn, n: nSend })
    const { key, nonce } = await aeadKey(mk)
    const ct = new Uint8Array(await subtle.encrypt(
      { name: 'AES-GCM', iv: await nonce(nSend), additionalData: header }, key, plaintext,
    ))
    mk.fill(0)
    nSend++
    return concat(header, ct)
  }

  /**
   * Walk a chain key forward, handing back the message keys passed over. PURE:
   * it touches no shared state, which is what lets `decrypt` stay transactional
   * (a forged frame must not be able to burn our chain — or worse, our root).
   */
  async function advance(ck: Uint8Array, from: number, to: number): Promise<{ keys: Uint8Array[]; ck: Uint8Array }> {
    if (to - from > maxSkip) {
      throw new RatchetError(`peer skipped ${to - from} messages, over the ${maxSkip} bound — drop the frame (§7.3)`)
    }
    const keys: Uint8Array[] = []
    let cur = ck
    for (let i = from; i < to; i++) {
      keys.push(await messageKey(cur))
      const next = await chainNext(cur)
      if (cur !== ck) cur.fill(0)
      cur = next
    }
    return { keys, ck: cur }
  }

  const wipeAll = (...bufs: (Uint8Array | null)[]) => { for (const b of bufs) b?.fill(0) }

  /** Open with a candidate message key. Does NOT consume it — the caller decides. */
  async function tryOpen(mk: Uint8Array, header: Uint8Array, ct: Uint8Array, n: number): Promise<Uint8Array | null> {
    const { key, nonce } = await aeadKey(mk)
    try {
      const pt = await subtle.decrypt({ name: 'AES-GCM', iv: await nonce(n), additionalData: header }, key, ct)
      return new Uint8Array(pt)
    } catch {
      return null
    }
  }

  /**
   * Open a frame. **Transactional**: every derivation happens on the side, and
   * the ratchet's state moves only once the AEAD has verified the frame. That
   * is the difference between "an attacker can inject noise" and "an attacker
   * can desync or reset the conversation" — a forged header carrying an unknown
   * `dh_pub` must never be able to step our root key.
   *
   * Returns null for anything that does not open (foreign frame, tamper, replay
   * of a spent key). Throws `RatchetError` only when a header claims a jump past
   * the §7.3 skip bound: drop that frame, and treat a stream of them as an
   * attacker or a hopeless desync.
   */
  async function decrypt(frame: Uint8Array): Promise<Uint8Array | null> {
    const h = decodeHeader(frame)
    if (!h) return null
    const header = frame.slice(0, HDR_LEN)
    const ct = frame.slice(HDR_LEN)
    skipped.prune(now())

    // 1. A key we already derived for a message that overtook this one?
    const stashed = skipped.peek(h.dhPub, h.n)
    if (stashed) {
      const pt = await tryOpen(stashed, header, ct, h.n)
      if (pt) { stashed.fill(0); skipped.drop(h.dhPub, h.n) }
      return pt
    }

    const sameKey = h.dhPub.every((b, i) => b === dhPeerPub[i])
    if (sameKey && !ckRecv) return null // that key never opened a receiving chain

    // 2. Same chain: walk forward from where we are.
    if (sameKey) {
      if (h.n < nRecv) return null // spent (or never ours) — replay
      const walk = await advance(ckRecv!, nRecv, h.n)
      const mk = await messageKey(walk.ck)
      const nextCk = await chainNext(walk.ck)
      const pt = await tryOpen(mk, header, ct, h.n)
      // Nothing committed: wipe the scratch, but never the live chain key
      // (`walk.ck` IS `ckRecv` when the frame was in order).
      if (!pt) { wipeAll(mk, nextCk, walk.ck !== ckRecv ? walk.ck : null, ...walk.keys); return null }

      for (let i = 0; i < walk.keys.length; i++) skipped.put(h.dhPub, nRecv + i, walk.keys[i], now())
      wipeAll(mk, ckRecv, walk.ck !== ckRecv ? walk.ck : null)
      ckRecv = nextCk
      nRecv = h.n + 1
      return pt
    }

    // 3. The conversation turned: close the current receiving chain (holding
    //    what never arrived), step the root with the peer's new key, then walk
    //    the new chain — all of it provisional until the frame verifies.
    if (!dhSelf) return null // we have no ratchet key yet, so we cannot step
    const closing = ckRecv ? await advance(ckRecv, nRecv, h.pn) : null
    const ikm = await dhSelf.dh(h.dhPub)
    const step = await dhStep(rk, ikm)
    ikm.fill(0)
    const walk = await advance(step.ck, 0, h.n)
    const mk = await messageKey(walk.ck)
    const nextCk = await chainNext(walk.ck)
    const pt = await tryOpen(mk, header, ct, h.n)
    if (!pt) {
      wipeAll(
        mk, nextCk, step.rk, step.ck,
        walk.ck !== step.ck ? walk.ck : null,
        ...walk.keys, ...(closing?.keys ?? []),
        closing && closing.ck !== ckRecv ? closing.ck : null, // the live chain survives
      )
      return null
    }

    if (closing) for (let i = 0; i < closing.keys.length; i++) skipped.put(dhPeerPub, nRecv + i, closing.keys[i], now())
    for (let i = 0; i < walk.keys.length; i++) skipped.put(h.dhPub, i, walk.keys[i], now())
    wipeAll(mk, rk, ckRecv, closing?.ck ?? null, walk.ck !== step.ck ? walk.ck : null, step.ck)
    rk = step.rk
    ckRecv = nextCk
    dhPeerPub = h.dhPub
    nRecv = h.n + 1
    stepBeforeSend = true
    return pt
  }

  /**
   * One at a time. Both halves of the ratchet are multi-step state machines that
   * await WebCrypto between reading state and writing it back — `encrypt` reads
   * `ckSend`/`nSend`, awaits four times, then advances them. Two calls issued in
   * the same tick therefore interleave: both derive a message key from the SAME
   * chain key and stamp the SAME `n`, then both advance the chain. The peer can
   * open at most one of those frames and its receiving chain is left behind the
   * sender's for good — messages "not arriving" with the badge still green, and
   * no error anywhere.
   *
   * That is not exotic: the room fires content without awaiting it (`void
   * emitContent(...)`), so an ack for an incoming message races the typing
   * notice, and a flush of pending messages races itself. Serialising here fixes
   * every caller at once, and nothing above needs to know.
   *
   * `queue` is a promise chain that survives failures — a rejected call must not
   * wedge the ones behind it.
   */
  let queue: Promise<unknown> = Promise.resolve()
  const serial = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = queue.then(fn, fn)
    queue = run.then(() => undefined, () => undefined)
    return run
  }

  return {
    encrypt: (plaintext) => serial(() => encrypt(plaintext)),
    decrypt: (frame) => serial(() => decrypt(frame)),
    stats: () => ({ nSend, nRecv, skipped: skipped.size, dhPub: dhSelf ? b64(dhSelf.pub) : null }),
  }
}
