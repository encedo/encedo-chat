/**
 * xfer-session.ts — the moving parts around `lib/xfer.ts`: real timers, real
 * file slices, real backpressure. One conversation, one transfer at a time.
 *
 * The split is the same one the rest of the engine uses: `xfer.ts` decides
 * WHAT is legal and this file decides WHEN things happen. Everything here is
 * still testable offline, because the channel arrives as a handle
 * (`XferHost.direct()`) and the file as anything with `slice()`.
 *
 * Two rules that are easy to lose in a refactor:
 *
 * - **No channel, no transfer.** `direct()` returns null before the link proves
 *   itself, after a demotion and once it is gone; every one of those means the
 *   answer is no, never "use the relay instead". At ~1 MB/s per room the relay
 *   would be a slower copy of the store we already have (`TRANSFER-DESIGN.md`).
 * - **One at a time.** A second offer is refused with a reason rather than
 *   queued: two transfers sharing one channel's backpressure is a race nobody
 *   would enjoy debugging, and the UI says "poczekaj" perfectly well.
 */
import {
  createSender, createReceiver, decodeOffer, isXfer, CHUNK, MAX_DIRECT, T,
  type Offer, type Sender, type Receiver, type Why,
} from './xfer.ts'

/** Anything with a name, a size and slices — a browser `File`, or a test double. */
export interface FileLike {
  name: string
  size: number
  type?: string
  slice(start: number, end: number): { arrayBuffer(): Promise<ArrayBuffer> }
}

export interface Direct {
  send(b: Uint8Array): void
  buffered(): number
  drain(): Promise<void>
}

export interface XferHost {
  /** The proven channel, or null — which is also "may we offer a transfer". */
  direct(): Direct | null
  /** Injectable clock, for tests. */
  now?(): number
}

export type XferEv =
  /** Somebody wants to send us a file; the UI asks the person. */
  | { t: 'offer'; name: string; size: number; mime: string }
  | { t: 'accepted' }
  | { t: 'progress'; dir: 'in' | 'out'; done: number; total: number }
  | { t: 'done'; dir: 'out' }
  | { t: 'received'; name: string; mime: string; blob: Blob }
  | { t: 'failed'; dir: 'in' | 'out'; why: Why }

export type OfferResult = 'ok' | 'busy' | 'no-channel' | 'too-big' | 'empty'

export interface XferSession {
  offer(file: FileLike): OfferResult
  /** Frames arriving off the channel (`WebRTCPlane.onControl`). */
  onFrame(bytes: Uint8Array): void
  accept(): void
  reject(): void
  cancel(): void
  busy(): boolean
  /** The offer waiting for an answer, for a UI that repaints after a reload. */
  pending(): Offer | null
  stop(): void
}

const TICK_MS = 1000

export function createXferSession(host: XferHost, onEvent: (e: XferEv) => void): XferSession {
  const now = () => host.now?.() ?? Date.now()
  let send: Sender | null = null
  let recv: Receiver | null = null
  let file: FileLike | null = null
  let pumping = false

  const clear = () => { send = null; recv = null; file = null }

  const emit = (evs: { t: string; [k: string]: any }[], dir: 'in' | 'out') => {
    for (const e of evs) {
      if (e.t === 'progress') onEvent({ t: 'progress', dir, done: e.done, total: e.total })
      else if (e.t === 'accepted') onEvent({ t: 'accepted' })
      else if (e.t === 'failed') { onEvent({ t: 'failed', dir, why: e.why }); clear() }
      else if (e.t === 'done' && dir === 'out') { onEvent({ t: 'done', dir: 'out' }); clear() }
    }
  }

  const timer: any = setInterval(() => {
    if (send) emit(send.tick(now()), 'out')
    if (recv) emit(recv.tick(now()), 'in')
  }, TICK_MS)
  // A library timer must not be the reason a Node process refuses to exit.
  timer?.unref?.()

  /** Read and push chunks until the file is out, the channel is full, or it dies. */
  async function pump() {
    if (pumping) return
    pumping = true
    try {
      while (send && send.state === 'sending' && file) {
        const i = send.next()
        if (i === null) break
        const d = host.direct()
        if (!d) { emit([{ t: 'failed', why: 'channel' }], 'out'); return }
        // Wait BEFORE reading: a slice held while the channel drains is a slice
        // sitting in memory for no reason.
        await d.drain()
        if (!send || send.state !== 'sending') return
        const start = i * CHUNK
        const body = new Uint8Array(await file.slice(start, Math.min(start + CHUNK, file.size)).arrayBuffer())
        if (!send || send.state !== 'sending') return
        try { d.send(send.chunk(i, body)) }
        catch { emit([{ t: 'failed', why: 'channel' }], 'out'); return }
      }
    } finally { pumping = false }
  }

  return {
    busy: () => !!(send || recv),
    pending: () => (recv && recv.state === 'offered' ? recv.offer : null),
    offer(f) {
      if (send || recv) return 'busy'
      const d = host.direct()
      if (!d) return 'no-channel'
      if (f.size > MAX_DIRECT) return 'too-big'
      if (f.size === 0) return 'empty'
      file = f
      send = createSender({ name: f.name, size: f.size, mime: f.type || 'application/octet-stream' })
      d.send(send.open(now()))
      return 'ok'
    },
    accept() {
      const d = host.direct()
      if (!recv || recv.state !== 'offered') return
      if (!d) { onEvent({ t: 'failed', dir: 'in', why: 'channel' }); clear(); return }
      d.send(recv.accept(now()))
    },
    reject() {
      const d = host.direct()
      if (!recv) return
      try { d?.send(recv.reject()) } catch {}
      clear()
    },
    cancel() {
      const d = host.direct()
      const m = send ?? recv
      if (!m) return
      try { d?.send(m.cancel()) } catch {}
      onEvent({ t: 'failed', dir: send ? 'out' : 'in', why: 'cancelled-local' })
      clear()
    },
    onFrame(b) {
      if (!isXfer(b)) return
      const t = now()

      if (b[1] === T.OFFER) {
        const o = decodeOffer(b)
        if (!o) return                       // not an offer we can read at all
        const say = (why: Why) => {
          // Always ANSWER a refusal: the alternative is the other side watching
          // a progress bar for thirty seconds before its own timer fires.
          try { host.direct()?.send(createReceiver(o).reject()) } catch {}
          onEvent({ t: 'failed', dir: 'in', why })
        }
        if (send || recv) return say('busy')
        if (o.size > MAX_DIRECT) return say('too-big')
        if (o.size === 0) return say('empty')
        recv = createReceiver(o)
        onEvent({ t: 'offer', name: o.name, size: o.size, mime: o.mime })
        return
      }

      if (send) {
        const evs = send.onFrame(b, t)
        const wasOffering = evs.some((e) => e.t === 'accepted')
        emit(evs, 'out')
        if (wasOffering) void pump()
        return
      }

      if (recv) {
        const out = recv.onFrame(b, t)
        if (out.reply) { try { host.direct()?.send(out.reply) } catch {} }
        const finished = out.evs.some((e) => e.t === 'done')
        emit(out.evs.filter((e) => e.t !== 'done'), 'in')
        if (finished && recv) {
          const { name, mime } = recv.offer
          const blob = new Blob(recv.parts() as BlobPart[], { type: mime })
          clear()
          onEvent({ t: 'received', name, mime, blob })
        }
      }
    },
    stop() { clearInterval(timer); clear() },
  }
}
