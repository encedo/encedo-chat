/**
 * xfer.ts — one file, straight down the DataChannel, as its own little protocol.
 *
 * Everything here is PURE: no DOM, no channel, no clock of its own. The caller
 * hands frames in, gets frames and events out, and calls `tick(now)` for the
 * timers. That is what makes the whole state machine testable without a browser,
 * which matters more than usual here — the only place this can run for real is
 * two browsers with a live DataChannel, and that is the slowest test we have.
 *
 * **Why so little of it.** The channel (`net/webrtc.ts`) is a default
 * `createDataChannel`, so SCTP delivers reliably and in order. Retransmission,
 * windows and gap tracking — the parts a transfer protocol usually consists of —
 * are already done underneath. What is left is: agreeing to start, moving
 * bytes without filling memory, showing progress honestly, and stopping.
 *
 * So RECEIPTS ARE NOT DELIVERY. They move the sender's progress bar and prove
 * the receiver is still there; one lost costs a stale percentage, never data.
 * They arrive at `receiptEvery()` — between fifty and a hundred per transfer
 * whatever the size, computed identically on both sides from the offer, so
 * there is nothing to negotiate.
 *
 * A chunk that arrives out of order IS a hard failure, not something to repair:
 * the channel guarantees order, so a gap means the channel is not what we think
 * it is, and carrying on would write a corrupt file to somebody's disk.
 *
 * Groups are out by construction (no acks, N channels) and so is the packaged
 * desktop (WebKitGTK has no RTCPeerConnection). One transfer at a time, 1:1,
 * and the store path in `app.ts` stays exactly as it is for everything else.
 */

/** Frames share the channel's control prefix; content frames start at 0x10. */
export const CTRL = 0x00
/** Subtypes. 0x50/0x4f are the channel's own ping/pong and are not ours. */
export const T = {
  OFFER: 0x01, ACCEPT: 0x02, REJECT: 0x03,
  CHUNK: 0x04, RECEIPT: 0x05, CANCEL: 0x06, DONE: 0x07,
} as const

/** 64 KiB: the largest chunk every browser sends without splitting it. */
export const CHUNK = 64 * 1024
/**
 * 512 MiB. The receiver holds the whole file in memory until it is saved, so
 * this is a memory limit, not a policy one — it moves when the receiving side
 * streams to disk (File System Access, Chromium only, hence not in v1).
 */
export const MAX_DIRECT = 512 * 1024 * 1024
/** How long an offer waits for a person to answer it. */
export const ACCEPT_MS = 30_000
/** Silence from a peer mid-transfer. Generous: a big file on a slow link. */
export const STALL_MS = 60_000

/**
 * Between 50 and 100 receipts per transfer, whatever the size — `ceil` means
 * the count lands under a hundred rather than on it, and never above. Both
 * sides derive it from the offer, so there is nothing to negotiate.
 */
export function receiptEvery(chunks: number): number {
  return Math.max(1, Math.ceil(chunks / 100))
}

export interface Offer {
  id: number          // 32-bit, random: correlates frames and rejects stale ones
  name: string
  size: number
  mime: string
  chunk: number
  chunks: number
}

export type Why =
  | 'rejected' | 'timeout' | 'cancelled-local' | 'cancelled-peer'
  | 'too-big' | 'empty' | 'busy' | 'out-of-order' | 'bad-frame' | 'channel'

export type Ev =
  | { t: 'accepted' }
  | { t: 'offer'; offer: Offer }
  | { t: 'progress'; done: number; total: number }
  | { t: 'done' }
  | { t: 'failed'; why: Why }

const enc = new TextEncoder()
const dec = new TextDecoder()

const u32 = (v: number) => {
  const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, v >>> 0); return b
}
const readU32 = (b: Uint8Array, at: number) =>
  new DataView(b.buffer, b.byteOffset, b.byteLength).getUint32(at)

function frame(sub: number, id: number, rest?: Uint8Array): Uint8Array {
  const out = new Uint8Array(6 + (rest?.length ?? 0))
  out[0] = CTRL; out[1] = sub
  out.set(u32(id), 2)
  if (rest) out.set(rest, 6)
  return out
}

/** True for anything this module owns; the channel keeps its ping/pong. */
export function isXfer(b: Uint8Array): boolean {
  return b.length >= 6 && b[0] === CTRL && b[1] >= T.OFFER && b[1] <= T.DONE
}

export const encodeOffer = (o: Offer) =>
  frame(T.OFFER, o.id, enc.encode(JSON.stringify(
    { name: o.name, size: o.size, mime: o.mime, chunk: o.chunk, chunks: o.chunks })))

export function decodeOffer(b: Uint8Array): Offer | null {
  if (!isXfer(b) || b[1] !== T.OFFER) return null
  try {
    const j = JSON.parse(dec.decode(b.subarray(6)))
    const o: Offer = {
      id: readU32(b, 2),
      name: String(j.name ?? '').slice(0, 200),
      size: Number(j.size), mime: String(j.mime ?? 'application/octet-stream').slice(0, 100),
      chunk: Number(j.chunk), chunks: Number(j.chunks),
    }
    // A wrong geometry is not a rounding difference — it means the two sides
    // would disagree about where the file ends.
    if (!Number.isInteger(o.size) || o.size < 0 || !Number.isInteger(o.chunks)) return null
    if (o.chunk !== CHUNK || o.chunks !== Math.max(1, Math.ceil(o.size / CHUNK))) return null
    return o
  } catch { return null }
}

export const encodeChunk = (id: number, index: number, body: Uint8Array) => {
  const out = new Uint8Array(10 + body.length)
  out[0] = CTRL; out[1] = T.CHUNK
  out.set(u32(id), 2); out.set(u32(index), 6); out.set(body, 10)
  return out
}

/** Random enough to tell one transfer from the next; not a security value. */
export function newId(): number {
  const b = new Uint8Array(4); crypto.getRandomValues(b); return readU32(b, 0) >>> 0
}

// ---------------------------------------------------------------- sender ----

export interface Sender {
  readonly state: 'offering' | 'sending' | 'done' | 'failed'
  readonly offer: Offer
  /** The frame to put on the channel first. */
  open(now: number): Uint8Array
  /** Next chunk index to read and send, or null when everything is out. */
  next(): number | null
  /** Frame for a chunk the caller has read; advances `next()`. */
  chunk(index: number, body: Uint8Array): Uint8Array
  onFrame(b: Uint8Array, now: number): Ev[]
  tick(now: number): Ev[]
  cancel(): Uint8Array
  /** Bytes the peer has confirmed, for the progress bar. */
  acked(): number
}

export function createSender(file: { name: string; size: number; mime: string }, id = newId()): Sender {
  const chunks = Math.max(1, Math.ceil(file.size / CHUNK))
  const offer: Offer = { id, name: file.name, size: file.size, mime: file.mime || 'application/octet-stream', chunk: CHUNK, chunks }
  let state: Sender['state'] = 'offering'
  let sentIdx = 0, ackedIdx = -1, last = 0

  const fail = (why: Why): Ev[] => { state = 'failed'; return [{ t: 'failed', why }] }

  return {
    get state() { return state },
    get offer() { return offer },
    open(now) { last = now; return encodeOffer(offer) },
    next() { return state === 'sending' && sentIdx < chunks ? sentIdx : null },
    chunk(index, body) { sentIdx = index + 1; return encodeChunk(id, index, body) },
    acked() { return Math.min(file.size, (ackedIdx + 1) * CHUNK) },
    cancel() { state = 'failed'; return frame(T.CANCEL, id) },
    tick(now) {
      if (state === 'offering' && now - last > ACCEPT_MS) return fail('timeout')
      if (state === 'sending' && now - last > STALL_MS) return fail('channel')
      return []
    },
    onFrame(b, now) {
      // A frame from a transfer that is over, or from another one entirely, is
      // not an error: both sides may still have one in flight when a transfer
      // ends. Ignoring it beats failing the live one.
      if (!isXfer(b) || readU32(b, 2) !== id) return []
      last = now
      switch (b[1]) {
        case T.ACCEPT:
          if (state !== 'offering') return []
          state = 'sending'
          return [{ t: 'accepted' }]
        case T.REJECT: return state === 'offering' ? fail('rejected') : []
        case T.CANCEL: return state === 'done' ? [] : fail('cancelled-peer')
        case T.RECEIPT: {
          if (state !== 'sending' || b.length < 10) return []
          const i = readU32(b, 6)
          if (i > ackedIdx) ackedIdx = i
          return [{ t: 'progress', done: Math.min(file.size, (ackedIdx + 1) * CHUNK), total: file.size }]
        }
        case T.DONE:
          if (state !== 'sending') return []
          state = 'done'
          return [{ t: 'progress', done: file.size, total: file.size }, { t: 'done' }]
      }
      return []
    },
  }
}

// -------------------------------------------------------------- receiver ----

export interface Receiver {
  readonly state: 'offered' | 'receiving' | 'done' | 'failed'
  readonly offer: Offer
  accept(now: number): Uint8Array
  reject(): Uint8Array
  cancel(): Uint8Array
  onFrame(b: Uint8Array, now: number): { evs: Ev[]; reply?: Uint8Array }
  tick(now: number): Ev[]
  /** The pieces, in order. The caller turns them into a Blob and saves it. */
  parts(): Uint8Array[]
  received(): number
}

/** `null` when the offer is not one we can take — the caller says why. */
export function openOffer(b: Uint8Array): { offer: Offer } | { why: Why } | null {
  const o = decodeOffer(b)
  if (!o) return null
  if (o.size > MAX_DIRECT) return { why: 'too-big' }
  if (o.size === 0) return { why: 'empty' }
  return { offer: o }
}

export function createReceiver(offer: Offer): Receiver {
  let state: Receiver['state'] = 'offered'
  let want = 0, got = 0, last = 0
  const parts: Uint8Array[] = []
  const every = receiptEvery(offer.chunks)
  const fail = (why: Why): Ev[] => { state = 'failed'; return [{ t: 'failed', why }] }

  return {
    get state() { return state },
    get offer() { return offer },
    parts: () => parts,
    received: () => got,
    accept(now) { state = 'receiving'; last = now; return frame(T.ACCEPT, offer.id) },
    reject() { state = 'failed'; return frame(T.REJECT, offer.id) },
    cancel() { state = 'failed'; return frame(T.CANCEL, offer.id) },
    tick(now) {
      if (state === 'receiving' && now - last > STALL_MS) return fail('channel')
      return []
    },
    onFrame(b, now) {
      if (!isXfer(b) || readU32(b, 2) !== offer.id) return { evs: [] }
      last = now
      if (b[1] === T.CANCEL) return { evs: state === 'done' ? [] : fail('cancelled-peer') }
      if (b[1] !== T.CHUNK) return { evs: [] }
      if (state !== 'receiving') return { evs: [] }
      if (b.length < 10) return { evs: fail('bad-frame') }

      const i = readU32(b, 6)
      // The channel is ordered, so a gap means it is not the channel we think
      // it is. Repairing here would mean writing a file we cannot vouch for.
      if (i !== want) return { evs: fail('out-of-order') }
      const body = b.subarray(10)
      const expect = Math.min(CHUNK, offer.size - got)
      if (body.length !== expect) return { evs: fail('bad-frame') }

      parts.push(new Uint8Array(body))
      got += body.length
      want++

      const evs: Ev[] = [{ t: 'progress', done: got, total: offer.size }]
      if (want >= offer.chunks) {
        state = 'done'
        evs.push({ t: 'done' })
        return { evs, reply: frame(T.DONE, offer.id) }
      }
      // A receipt every `every` chunks, and never on the last one — the DONE
      // frame is that one's confirmation.
      if (want % every === 0) {
        const r = new Uint8Array(4); r.set(u32(want - 1))
        return { evs, reply: frame(T.RECEIPT, offer.id, r) }
      }
      return { evs }
    },
  }
}
