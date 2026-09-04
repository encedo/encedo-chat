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
 * WARNING: This has now been wrong in both directions, so the reasoning is written
 * down rather than the conclusion.
 *
 * 0.3.14 stamped what `decodeAudioData` answered. 0.3.15 overruled it with the
 * wall clock as a floor, on the theory that a short stamp CUTS playback — which
 * is true, and which was the wrong fix, because the decode was not wrong. A
 * recording from the field settled it: the header said 6012 ms (the clock) and
 * the media held three clusters ending at 2367 ms. The samples were simply not
 * there, and the floor turned "a short note" into "a note that plays silence
 * for the rest of its length".
 *
 * So the SAMPLES decide. The clock is a fallback for a platform that will not
 * decode its own recording, and nothing more — and when the two disagree the
 * disagreement is the finding, not a number to smooth over: see `micDied`,
 * which is what a gap that size actually means.
 */
export function chooseLength(decoded: number | null, elapsedMs: number): number {
  if (decoded && Number.isFinite(decoded) && decoded > 0) return decoded
  return elapsedMs / 1000
}

/** A gap this big between the clock and the samples is not measurement error —
 *  it is capture that stopped. Half a second covers device start-up and the
 *  encoder's tail; anything beyond it is missing audio. */
export const micDied = (decoded: number | null, elapsedMs: number): boolean =>
  !!decoded && Number.isFinite(decoded) && elapsedMs / 1000 - decoded > 0.5

async function decodedLength(bytes: Uint8Array): Promise<number | null> {
  try {
    const Ctx = (globalThis as any).AudioContext ?? (globalThis as any).webkitAudioContext
    if (!Ctx) return null
    const ctx = new Ctx()
    try {
      const buf = await ctx.decodeAudioData(bytes.slice().buffer)
      return buf.duration > 0 ? buf.duration : null
    } finally { void ctx.close?.() }
  } catch { return null /* the platform will not decode its own recording */ }
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
  /** The microphone stopped delivering before Stop was pressed: the take is
   *  `got` seconds long where `wanted` seconds were recorded. Told rather than
   *  hidden — a note that plays half of what somebody said, with nothing on
   *  screen about it, is the worst version of this. */
  onShort?: (got: number, wanted: number) => void
}): Promise<Recording> {
  // WARNING: `{ audio: true }`, and the constraints that were here in 0.4.3 are gone
  // because they made it WORSE. Measured on Chromium, same machine, same
  // microphone, three requests:
  //
  //     { audio: true }                              -> mono, 48 kHz
  //     { channelCount: 1, echoCancellation: false } -> STEREO, 44.1 kHz
  //     { channelCount: { exact: 1 }, ... }            -> STEREO, 44.1 kHz
  //
  // Two findings in that, both counter-intuitive. Asking for mono does not get
  // mono — `exact` does not either. And turning echo cancellation OFF is what
  // changes the channel count and the rate: it unhooks capture from WebRTC's
  // audio processing and hands over the raw device, which is stereo at 44.1 kHz
  // and then has to be resampled to 48 kHz and encoded as two channels. The
  // default path through the processor delivers exactly what Opus wants.
  //
  // So the default is not laziness here, it is the measurement. A voice note
  // has no far end to echo, but the cancellation is not what we were paying
  // for — the pipeline behind it is.
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
  const release = () => { for (const t of stream.getTracks()) { try { t.stop() } catch {} } }

  // The track dying is the fault we are chasing, and it announces itself: a
  // device that goes away fires `ended`, one that is taken over fires `mute`.
  // Neither stops the recorder, which goes on writing nothing — so they are
  // caught here, reported, and remembered for the caller to act on.
  const track = stream.getAudioTracks()[0]
  let died: string | null = null
  if (track) {
    track.addEventListener('ended', () => { died ??= 'ended' })
    track.addEventListener('mute', () => { died ??= 'mute' })
    try { ecWarn('mic: ' + JSON.stringify(track.getSettings())) } catch {}
  }

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

  // WARNING: A timeslice, and 250 ms rather than none — the value it had in 0.3.8,
  // which is the build reported as the last one where recording was right.
  //
  // 0.3.11 removed it, reasoning that a two-minute cap makes the single
  // allocation irrelevant and that fine clusters make some players walk
  // unevenly. Both still true and both beside the point: without a slice the
  // ENTIRE take lives inside the recorder until `stop()`, so whatever the
  // platform loses there, it loses all of. With one, a take can lose at most
  // the last slice — which is why this is 250 ms and not the 1000 ms of 0.4.2.
  // A quarter second of somebody's sentence is a bounded loss; a second is a
  // word.
  rec.start(250)

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
            const decoded = await decodedLength(raw)
            const secs = chooseLength(decoded, elapsed)
            if (micDied(decoded, elapsed) || died) o.onShort?.(secs, elapsed / 1000)
            // Worth a line when the two disagree: it is the fingerprint of an
            // engine that mis-decodes its own recording, and the reason the
            // clock is a floor rather than a fallback.
            // Everything needed to tell a short recording from a short take,
            // in one line: the samples against the clock, how many pieces the
            // recorder handed over, and whether the microphone said it was
            // going away before we asked it to.
            if (micDied(decoded, elapsed) || died) {
              ecWarn(`SHORT: ${decoded?.toFixed(2)}s of audio vs ${(elapsed / 1000).toFixed(2)}s recorded`
                + ` · track ${died ?? 'live'} · ${chunks.length} chunk(s), ${raw.length} B, ${mime}`)
            }
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
