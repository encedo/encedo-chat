/**
 * voice.ts — a voice note, recorded here and sent as a file.
 *
 * ## Why this needs no protocol at all
 *
 * A recording is bytes with a `mime`, and this app already moves bytes with a
 * `mime`: encrypted on the device, uploaded as an opaque blob, the key riding
 * the ratchet in a `file` envelope. So a voice note is a FILE, and every
 * property of the file path — the encryption, the expiry, the caption, the
 * reply, the delivery marker — comes along without a line of new wire format.
 * Nothing in `PROTOCOL.md` changes, because nothing about the wire changes.
 *
 * It is also the reason this is not a call. A call would need signalling, a
 * live path and both people present; a voice note needs a microphone and the
 * file path we already had. The two do not share a problem.
 *
 * ## The parts that are easy to get wrong
 *
 * - **The microphone must be released on EVERY path.** Stop, cancel, an error
 *   mid-recording, the automatic stop at the limit — all four. A track left
 *   live keeps the platform's recording indicator on, which is alarming and
 *   correct: the app really would still be listening.
 * - **The length has to be written into the file BY US.** A container muxed
 *   while it is spoken carries no length, or carries one the engine invented,
 *   and every player downstream — ours, the recipient's, whatever opens the
 *   saved file — then has to guess. Stop measures the take and stamps it in;
 *   see `webm.ts` for what that costs (nothing) and when it declines (safely).
 *   A container we cannot stamp — an MP4 out of WebKit — falls back to the
 *   player measuring the samples for itself.
 * - **The container is whatever the platform will give.** Chromium records
 *   WebM/Opus, WebKit prefers MP4, and a hard-coded string means a recorder
 *   that constructs and then produces nothing. The list is tried in order and
 *   the file is named after what came out, not after what was asked for.
 * - **A recording is offered, not sent.** It lands in the same composer chip a
 *   pasted file lands in, so it can carry a caption, answer a message, or be
 *   dropped — the one door in `offerFile`.
 */

import { stampWebmDuration } from './webm.ts'

/** A failure to MEASURE must never cost the recording, so it is noted and
 *  stepped over. The app's own logger is not reachable from here — this module
 *  is deliberately free of the GUI — so the console is the record. */
const ecWarn = (e: unknown) => { try { console.warn('[voice] ' + ((e as any)?.message ?? e)) } catch {} }

/** The platform can record at all. Both halves fail apart: WebKitGTK may have
 *  one and not the other, which is why the button is hidden rather than dead. */
export const voiceSupported = (): boolean =>
  typeof (globalThis as any).MediaRecorder === 'function'
  && typeof navigator === 'object' && !!navigator.mediaDevices?.getUserMedia

/** Containers in the order we would like them, best first. Opus is the point:
 *  a minute of speech is tens of kilobytes, which matters when the store keeps
 *  the blob for minutes and the recipient may be on a phone. */
const TYPES = [
  'audio/webm;codecs=opus',
  'audio/ogg;codecs=opus',
  'audio/webm',
  'audio/mp4',
]

const extFor = (mime: string) =>
  mime.includes('ogg') ? 'ogg' : mime.includes('mp4') ? 'm4a' : mime.includes('webm') ? 'webm' : 'bin'

/**
 * How long the take really is, in seconds.
 *
 * The sample count is the only answer that cannot be argued with, so decode and
 * count. The wall clock is the fallback and it runs LONG: it starts when the
 * recorder is told to start, and a microphone takes a moment to deliver its
 * first frames — about a quarter of a second on the machines we measured.
 */
async function trueLength(bytes: Uint8Array, elapsedMs: number): Promise<number> {
  try {
    const Ctx = (globalThis as any).AudioContext ?? (globalThis as any).webkitAudioContext
    if (Ctx) {
      const ctx = new Ctx()
      try {
        const buf = await ctx.decodeAudioData(bytes.slice().buffer)
        if (buf.duration > 0) return buf.duration
      } finally { void ctx.close?.() }
    }
  } catch { /* the platform will not decode its own recording; the clock it is */ }
  return elapsedMs / 1000
}

export interface Recording {
  /** Stop and hand back the file. Releases the microphone. */
  stop(): Promise<File>
  /** Throw the recording away. Releases the microphone. */
  cancel(): void
}

/**
 * Start recording. Rejects if the microphone is refused — which is a normal
 * answer, not an error to hide: the caller turns it into a sentence.
 *
 * `onTick` fires about five times a second so the UI can show elapsed time, and
 * `onLimit` fires once when the cap is reached, so the UI can stop the way the
 * user would have.
 */
export async function startRecording(o: {
  maxMs: number
  onTick?: (ms: number) => void
  onLimit?: () => void
}): Promise<Recording> {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
  const release = () => { for (const t of stream.getTracks()) { try { t.stop() } catch {} } }

  let rec: MediaRecorder
  try {
    const MR = (globalThis as any).MediaRecorder as typeof MediaRecorder
    const mime = TYPES.find((t) => MR.isTypeSupported?.(t))
    rec = new MR(stream, mime ? { mimeType: mime } : undefined)
  } catch (e) {
    // The recorder is the thing that failed, so the microphone we opened for it
    // has to go back before the error leaves this function.
    release()
    throw e
  }

  const chunks: BlobPart[] = []
  rec.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data) }

  const t0 = Date.now()
  const tick = setInterval(() => o.onTick?.(Date.now() - t0), 200)
  // The cap is a product decision and a size one at once: this is a note, not a
  // podcast, and the store drops the blob in minutes either way.
  const limit = setTimeout(() => o.onLimit?.(), o.maxMs)
  const cleanup = () => { clearInterval(tick); clearTimeout(limit); release() }

  // No timeslice. It was there so a long recording would not be one allocation
  // at the end, which a two-minute cap makes irrelevant — and cutting the stream
  // into 250 ms clusters is a way to end up with a container some players walk
  // through unevenly. One take, one blob.
  rec.start()

  return {
    stop: () => new Promise<File>((resolve, reject) => {
      if (rec.state === 'inactive') { cleanup(); return reject(new Error('recorder already stopped')) }
      rec.onstop = () => {
        cleanup()
        const mime = rec.mimeType || 'audio/webm'
        const elapsed = Date.now() - t0
        const stamp = new Date().toISOString().slice(0, 16).replace(/[-:]/g, '').replace('T', '-')
        const name = `glosowka-${stamp}.${extFor(mime)}`
        // Measure, then write the length into the bytes. Everything after this
        // point — our preview, the recipient's player, the file on a desk
        // somewhere — reads a length instead of guessing at one.
        void (async () => {
          try {
            const raw = new Uint8Array(await new Blob(chunks, { type: mime }).arrayBuffer())
            const secs = await trueLength(raw, elapsed)
            const out = /webm|matroska/.test(mime) ? stampWebmDuration(raw, secs) : raw
            resolve(new File([out], name, { type: mime }))
          } catch (e) {
            // Measuring is a nicety; losing the recording over it is not. Send
            // the bytes as they came out.
            ecWarn(e)
            resolve(new File(chunks, name, { type: mime }))
          }
        })()
      }
      rec.onerror = (e: any) => { cleanup(); reject(e?.error ?? new Error('recording failed')) }
      try { rec.stop() } catch (e) { cleanup(); reject(e) }
    }),
    cancel: () => {
      cleanup()
      rec.onstop = null
      try { if (rec.state !== 'inactive') rec.stop() } catch {}
      chunks.length = 0
    },
  }
}
