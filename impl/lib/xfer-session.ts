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
  createSender, createReceiver, decodeOffer, isXfer, CHUNK, MAX_DIRECT,
  MAX_OFFER_BODY, T,
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

/**
 * `id` on offer / done / received is the transfer's own 32-bit id, the one every
 * frame carried — so it is the ONE value both ends already agree on. The UI
 * builds the file bubble from these events, and a bubble needs an id both
 * sides share before anyone can react to it or answer it: a reaction names a
 * message by id, and nothing else about a direct transfer ever crossed the
 * wire under an id. Without this the transferred file was the only message in
 * a conversation that could not be reacted to (reported 2026-09-14).
 */
export type XferEv =
  /** Somebody wants to send us a file; the UI asks the person. */
  | { t: 'offer'; id: number; name: string; size: number; mime: string }
  | { t: 'accepted' }
  | { t: 'progress'; dir: 'in' | 'out'; done: number; total: number }
  | { t: 'done'; dir: 'out'; id: number }
  /**
   * `body` is the note the sender typed with the file. It rides here and NOT on
   * the `offer` event above, and that is a rule rather than an oversight: the
   * offer event draws the consent prompt, which asks one question — take a file
   * from this person, yes or no. Handing that prompt arbitrary sender text
   * would turn it into a surface for saying things to somebody who has not
   * agreed to anything yet. The note appears on the file's bubble, after the
   * transfer the person accepted.
   */
  | { t: 'received'; id: number; name: string; mime: string; blob: Blob; body?: string }
  | { t: 'failed'; dir: 'in' | 'out'; why: Why }

export type OfferResult = 'ok' | 'busy' | 'no-channel' | 'too-big' | 'empty' | 'note-too-big'

export interface XferSession {
  /** `body` is the note typed with the file; it travels in the offer frame. */
  offer(file: FileLike, body?: string): OfferResult
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
      else if (e.t === 'done' && dir === 'out') { onEvent({ t: 'done', dir: 'out', id: send ? send.offer.id : 0 }); clear() }
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
    offer(f, body) {
      if (send || recv) return 'busy'
      const d = host.direct()
      if (!d) return 'no-channel'
      if (f.size > MAX_DIRECT) return 'too-big'
      if (f.size === 0) return 'empty'
      // Refused, never trimmed. A note silently cut in half is worse than a
      // refusal, and the frame it would build is the one the channel throws on.
      // Measured as it will sit in the frame: JSON-encoded, in bytes. The same
      // measure `lib/msgsize.ts` uses for a chat body, for the same reason —
      // a newline costs two characters once stringified.
      if (body && new TextEncoder().encode(JSON.stringify(body)).length > MAX_OFFER_BODY) return 'note-too-big'
      file = f
      send = createSender({
        name: f.name, size: f.size, mime: f.type || 'application/octet-stream',
        ...(body ? { body } : {}),
      })
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
        onEvent({ t: 'offer', id: o.id, name: o.name, size: o.size, mime: o.mime })
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
          const { id, name, mime, body } = recv.offer
          const blob = new Blob(recv.parts() as BlobPart[], { type: mime })
          clear()
          onEvent({ t: 'received', id, name, mime, blob, ...(body ? { body } : {}) })
        }
      }
    },
    stop() { clearInterval(timer); clear() },
  }
}
