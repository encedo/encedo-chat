/**
 * eh2/ratchet.ts — Double Ratchet over the EH-2 handshake (docs/SPEC.md §7).
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
 *     nonce      = HKDF(MK, salt = N, info = "encedo-aead-nonce", L = 12)
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

import { subtle, hkdfBits, kdf, aeadNonce, concat, b64 } from '../lib/wc.ts'
import { nowMs } from '../lib/time.ts'
import { generateX25519, type Dh } from '../lib/x25519.ts'
import type { HandshakeResult, Kem, KemKey } from './handshake.ts'
import { mlkem768 } from './mlkem.ts'
import { plog, val } from '../lib/protolog.ts'

const enc = new TextEncoder()
const RK_INFO = enc.encode('encedo-ratchet-dh-v1')
/** The hybrid step (7.2): the X25519 output with the ML-KEM shared secret behind it. */
const RK_PQ_INFO = enc.encode('encedo-ratchet-hybrid-v1')
const MK_LABEL = 'encedo-msg-key'
const CK_LABEL = 'encedo-chain-key'

/** Frame tags + version (distinct from the handshake frames of eh2/wire.ts). */
const T_DATA = 0x10
/** A content frame whose header also carries ML-KEM material (7.2 hybrid step). */
const T_DATA_PQ = 0x11
const VERSION = 3 // one ver names one spec (SPEC.md header); 3 = the one KDF/nonce convention of spec 3.0
const HDR_LEN = 2 + 32 + 4 + 4
const PQ_CT = 0x01, PQ_PUB = 0x02
/** The largest header the wire can carry: base, flags, two u16 lengths, pq_ct and pq_pub of ML-KEM-768. */
export const HDR_MAX = HDR_LEN + 1 + 2 + 1088 + 2 + 1184

/**
 * The hybrid cadence (7.2): on every K-th own DH step, or when the last
 * ML-KEM contribution is older than T, a sender puts a fresh encapsulation
 * key in its headers; the peer's next step carries the ciphertext and mixes
 * the shared secret into the root. Both are per session, both injectable.
 */
export const PQ_EVERY_STEPS = 4
export const PQ_EVERY_MS = 30 * 60_000

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
  stats(): { nSend: number; nRecv: number; skipped: number; dhPub: string | null; pqOutstanding: boolean; pqSteps: number }
}

interface Header { dhPub: Uint8Array; pn: number; n: number; pqCt?: Uint8Array; pqPub?: Uint8Array }

// ---------------------------------------------------------------------------
// header wire
// ---------------------------------------------------------------------------

/**
 *   0x10 ‖ ver ‖ dh_pub(32) ‖ pn(u32be) ‖ n(u32be)                                   42 B
 *   0x11 ‖ ver ‖ dh_pub(32) ‖ pn ‖ n ‖ flags(1) ‖ [u16be len ‖ pq_ct] ‖ [u16be len ‖ pq_pub]
 *
 * flags: 0x01 = pq_ct present, 0x02 = pq_pub present (ct first when both).
 * The whole header is the AEAD's associated data, so neither field can be
 * stripped, swapped or added by anyone who cannot open the frame.
 */
function encodeHeader(h: Header): Uint8Array {
  const pq = !!(h.pqCt || h.pqPub)
  const len = HDR_LEN + (pq ? 1 + (h.pqCt ? 2 + h.pqCt.length : 0) + (h.pqPub ? 2 + h.pqPub.length : 0) : 0)
  const b = new Uint8Array(len)
  b[0] = pq ? T_DATA_PQ : T_DATA; b[1] = VERSION
  b.set(h.dhPub, 2)
  const dv = new DataView(b.buffer)
  dv.setUint32(34, h.pn, false)
  dv.setUint32(38, h.n, false)
  if (pq) {
    b[42] = (h.pqCt ? PQ_CT : 0) | (h.pqPub ? PQ_PUB : 0)
    let o = 43
    for (const f of [h.pqCt, h.pqPub]) {
      if (!f) continue
      dv.setUint16(o, f.length, false); b.set(f, o + 2); o += 2 + f.length
    }
  }
  return b
}

function decodeHeader(frame: Uint8Array): { h: Header; len: number } | null {
  if (frame.length < HDR_LEN + 16) return null // 16 = minimum GCM tag
  if (frame[1] !== VERSION) return null
  const dv = new DataView(frame.buffer, frame.byteOffset, frame.byteLength)
  const h: Header = { dhPub: frame.slice(2, 34), pn: dv.getUint32(34, false), n: dv.getUint32(38, false) }
  if (frame[0] === T_DATA) return { h, len: HDR_LEN }
  if (frame[0] !== T_DATA_PQ) return null
  const flags = frame[42]
  if (!flags || flags & ~(PQ_CT | PQ_PUB)) return null
  let o = 43
  for (const which of [PQ_CT, PQ_PUB]) {
    if (!(flags & which)) continue
    if (o + 2 > frame.length) return null
    const n = dv.getUint16(o, false); o += 2
    if (!n || o + n > frame.length) return null
    const field = frame.slice(o, o + n); o += n
    if (which === PQ_CT) h.pqCt = field; else h.pqPub = field
  }
  if (frame.length < o + 16) return null
  return { h, len: o }
}

// ---------------------------------------------------------------------------
// KDFs
// ---------------------------------------------------------------------------

async function dhStep(rk: Uint8Array, ikm: Uint8Array, info: Uint8Array = RK_INFO): Promise<{ rk: Uint8Array; ck: Uint8Array }> {
  const out = await hkdfBits(ikm, rk, info, 64)
  return { rk: out.slice(0, 32), ck: out.slice(32) }
}
const sameBytes = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((v, i) => v === b[i])

const messageKey = (ck: Uint8Array) => kdf(MK_LABEL, ck)
const chainNext = (ck: Uint8Array) => kdf(CK_LABEL, ck)

// The root step keeps HKDF(ikm, salt = RK, info = label): the root key IS the
// context there, which is the one convention (lib/wc.ts kdf) spelled out.
async function aeadKey(mk: Uint8Array): Promise<{ key: CryptoKey; nonce: (n: number) => Promise<Uint8Array> }> {
  const key = await subtle.importKey('raw', mk, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt'])
  return { key, nonce: (n: number) => aeadNonce(mk, n) }
}

// ---------------------------------------------------------------------------
// skipped-key store (bounded — §7.3)
// ---------------------------------------------------------------------------

interface Skipped { mk: Uint8Array; ts: number }

class SkippedKeys {
  /** chain pub (b64) -> (n -> key) */
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
  /** The KEM of the hybrid step (default ML-KEM-768); a seeded one for a KAT. */
  kem?: Kem
  /** Hybrid cadence (7.2): every K-th own DH step, or after T ms since the last ML-KEM contribution. */
  pqEverySteps?: number
  pqEveryMs?: number
  /** Test seam: the ratchet's ephemeral X25519 keys, fixed for a KAT. */
  generateDh?: () => Promise<Dh>
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
  const kem = opts.kem ?? mlkem768
  const pqEvery = opts.pqEverySteps ?? PQ_EVERY_STEPS
  const pqEveryMs = opts.pqEveryMs ?? PQ_EVERY_MS
  const newDh = opts.generateDh ?? generateX25519

  /**
   * The hybrid step's state (7.2).
   *
   * `pqKey` is our encapsulation key, outstanding: its public half rides in
   * EVERY header we send until the peer's ciphertext arrives, because a frame
   * can be lost and a lost step frame must not cost the session its PQ
   * contribution - the peer learns the key from whichever frame reaches it.
   * `pendingSs`/`pendingCt` are what we owe the peer: encapsulated when its
   * key arrived, mixed into our NEXT DH step and carried in every header of
   * that chain (`ctInFlight`) until the peer's next key shows it has stepped
   * past it - again so that no single lost frame can leave the two roots
   * apart. A step the peer makes before it has seen our key is classical and
   * is accepted as such (the keys crossed; ours stays outstanding); what
   * cannot happen is a ciphertext under a key we never issued, or a header
   * altered in flight - the header is the AEAD's associated data.
   */
  let pqKey: KemKey | null = null
  let pendingSs: Uint8Array | null = null
  let pendingCt: Uint8Array | null = null
  let ctInFlight: Uint8Array | null = null
  let seenPeerPqPub: Uint8Array | null = null
  let stepsSincePq = 0
  let lastPqAt = now()
  let pqStepsDone = 0

  // Root state. The first DH step consumes the handshake's DH(EK_r, EK_i).
  let rk = hs.sk
  let dhSelf: Dh | null = hs.ekSelf
  let dhPeerPub = hs.ekPeerPub
  let ckSend: Uint8Array | null = null
  let ckRecv: Uint8Array | null = null
  let nSend = 0, nRecv = 0, pn = 0
  /** Set when the next send must open a new sending chain with a fresh key. */
  let stepBeforeSend: boolean

  plog('§7.2', `${hs.role} first DH step: RK_0=${val(rk)} ikm=${val(hs.firstStepIkm)}`)
  const first = await dhStep(rk, hs.firstStepIkm)
  plog('§7.2', `${hs.role} first DH step -> RK=${val(first.rk)} CK=${val(first.ck)}`)
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
      dhSelf = await newDh()
      const dh = await dhSelf.dh(dhPeerPub)
      let step: { rk: Uint8Array; ck: Uint8Array }
      if (pendingSs) {
        // The hybrid step: the peer's key was answered, its secret goes in with the DH.
        const ikm = concat(dh, pendingSs)
        step = await dhStep(rk, ikm, RK_PQ_INFO)
        ikm.fill(0); pendingSs.fill(0); pendingSs = null
        ctInFlight = pendingCt; pendingCt = null
        stepsSincePq = 0; lastPqAt = now(); pqStepsDone++
        plog('§7.2', `DH ratchet (send, HYBRID): new DH_self=${val(dhSelf.pub)} x peer=${val(dhPeerPub)} + ML-KEM ss -> RK=${val(step.rk)} CK_send=${val(step.ck)}`)
      } else {
        step = await dhStep(rk, dh)
        stepsSincePq++
        plog('§7.2', `DH ratchet (send): new DH_self=${val(dhSelf.pub)} x peer=${val(dhPeerPub)} -> RK=${val(step.rk)} CK_send=${val(step.ck)}`)
      }
      dh.fill(0)
      rk.fill(0); rk = step.rk
      if (ckSend) ckSend.fill(0)
      ckSend = step.ck
      pn = nSend
      nSend = 0
      stepBeforeSend = false
      // Time for a fresh encapsulation key of our own? Only when none is outstanding.
      if (!pqKey && (stepsSincePq >= pqEvery || now() - lastPqAt >= pqEveryMs)) {
        pqKey = await kem.generate()
        plog('§7.2', `hybrid: issuing an encapsulation key (${kem.name}) after ${stepsSincePq} classical step(s)`)
      }
    }
    const mk = await messageKey(ckSend!)
    const next = await chainNext(ckSend!)
    plog('§7.2', `send n=${nSend} pn=${pn}: CK->CK' (${val(ckSend!)} -> ${val(next)}) MK=${val(mk)}`)
    ckSend!.fill(0); ckSend = next

    const header = encodeHeader({
      dhPub: dhSelf!.pub, pn, n: nSend,
      ...(ctInFlight ? { pqCt: ctInFlight } : {}),
      ...(pqKey ? { pqPub: pqKey.pub } : {}),
    })
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
  /** The peer's encapsulation key arrived (on any frame that opened): answer it once. */
  async function notePeerPqPub(pub: Uint8Array | undefined): Promise<void> {
    if (!pub || (seenPeerPqPub && sameBytes(seenPeerPqPub, pub))) return
    const { ct: pqCt, ss } = await kem.encapsulate(pub)
    if (pendingSs) pendingSs.fill(0)
    pendingSs = ss; pendingCt = pqCt; seenPeerPqPub = pub
    plog('§7.2', `hybrid: encapsulated to the peer's key; the secret goes into our next DH step`)
  }

  async function decrypt(frame: Uint8Array): Promise<Uint8Array | null> {
    const decoded = decodeHeader(frame)
    if (!decoded) return null
    const { h, len: hdrLen } = decoded
    const header = frame.slice(0, hdrLen)
    const ct = frame.slice(hdrLen)
    skipped.prune(now())

    // 1. A key we already derived for a message that overtook this one?
    const stashed = skipped.peek(h.dhPub, h.n)
    if (stashed) {
      const pt = await tryOpen(stashed, header, ct, h.n)
      if (pt) { stashed.fill(0); skipped.drop(h.dhPub, h.n); await notePeerPqPub(h.pqPub) }
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

      plog('§7.2', `recv n=${h.n} (was at ${nRecv}${walk.keys.length ? `, stashed ${walk.keys.length} skipped` : ''}): MK=${val(mk)} -> CK'=${val(nextCk)}`)
      for (let i = 0; i < walk.keys.length; i++) skipped.put(h.dhPub, nRecv + i, walk.keys[i], now())
      wipeAll(mk, ckRecv, walk.ck !== ckRecv ? walk.ck : null)
      ckRecv = nextCk
      nRecv = h.n + 1
      await notePeerPqPub(h.pqPub)
      return pt
    }

    // 3. The conversation turned: close the current receiving chain (holding
    //    what never arrived), step the root with the peer's new key, then walk
    //    the new chain — all of it provisional until the frame verifies.
    if (!dhSelf) return null // we have no ratchet key yet, so we cannot step
    // A ciphertext is an answer to a key we issued; one under no key of ours is
    // not a frame we can place (and will not open - the header is AAD).
    if (h.pqCt && !pqKey) return null
    const closing = ckRecv ? await advance(ckRecv, nRecv, h.pn) : null
    const dh = await dhSelf.dh(h.dhPub)
    let ikm = dh, info = RK_INFO, ss: Uint8Array | null = null
    if (h.pqCt) {
      try { ss = await pqKey!.decapsulate(h.pqCt) } catch { dh.fill(0); return null }
      ikm = concat(dh, ss); info = RK_PQ_INFO
    }
    const step = await dhStep(rk, ikm, info)
    dh.fill(0); ikm.fill(0); ss?.fill(0)
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

    plog('§7.2', `DH ratchet (recv): peer key ${val(dhPeerPub)} -> ${val(h.dhPub)}, RK=${val(step.rk)} CK_recv=${val(step.ck)}`
      + `; n=${h.n} pn=${h.pn}${closing?.keys.length ? `, ${closing.keys.length} key(s) held from the closed chain` : ''}`)
    if (closing) for (let i = 0; i < closing.keys.length; i++) skipped.put(dhPeerPub, nRecv + i, closing.keys[i], now())
    for (let i = 0; i < walk.keys.length; i++) skipped.put(h.dhPub, i, walk.keys[i], now())
    wipeAll(mk, rk, ckRecv, closing?.ck ?? null, walk.ck !== step.ck ? walk.ck : null, step.ck)
    rk = step.rk
    ckRecv = nextCk
    dhPeerPub = h.dhPub
    nRecv = h.n + 1
    stepBeforeSend = true
    // The peer stepped past the chain that carried our ciphertext: it is in.
    ctInFlight = null
    if (h.pqCt) {
      pqKey = null; stepsSincePq = 0; lastPqAt = now(); pqStepsDone++
      plog('§7.2', `DH ratchet (recv, HYBRID): the peer answered our key; ML-KEM ss is in the root`)
    }
    await notePeerPqPub(h.pqPub)
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
    stats: () => ({ nSend, nRecv, skipped: skipped.size, dhPub: dhSelf ? b64(dhSelf.pub) : null, pqOutstanding: !!pqKey, pqSteps: pqStepsDone }),
  }
}
