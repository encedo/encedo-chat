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
 * How long the take really is, in seconds — and never LESS than the clock.
 *
 * ⚠️ The asymmetry here is the whole function, and getting it wrong shipped a
 * worse bug than the one it fixed. A length written into the container is
 * OBEYED: a player told the file is two seconds long stops after two seconds,
 * whatever else is in there. So
 *
 *   too long  → the bar ends a moment early and the player corrects itself the
 *               first time the sound runs past it. Cosmetic.
 *   too short → the recording is CUT. Somebody's ten-second message plays as a
 *               fragment and the rest is unreachable.
 *
 * `decodeAudioData` is the accurate answer in principle — the sample count IS
 * the length — but it is not reliable enough to be trusted BELOW the clock:
 * measured on Firefox, a 3.19 s take decoded as 1.913 s, and stamping that
 * number is exactly how "I recorded ten seconds and it plays two" happened.
 *
 * So the clock is a floor. It runs a little long (it starts when the recorder
 * is told to start, and a microphone takes about a quarter-second to deliver
 * its first frames), and a little long is the safe direction.
 */
export function chooseLength(decoded: number | null, elapsedMs: number): number {
  const clock = elapsedMs / 1000
  if (!decoded || !Number.isFinite(decoded) || decoded <= 0) return clock
  return Math.max(decoded, clock)
}

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

  // ⚠️ A timeslice, again — and the reason is not the one it was removed for.
  //
  // 0.3.11 took it out on the grounds that a two-minute cap makes the allocation
  // irrelevant and that 250 ms clusters make some players walk through a file
  // unevenly. Both are still true and both are beside the point: WITHOUT a
  // timeslice the entire take lives inside the recorder until `stop()`, and
  // whatever the platform loses there, it loses all of. Reported as ten seconds
  // recorded and under two seconds of sound in the file — the clock was right,
  // the length was right, and the audio was not there.
  //
  // With a slice the recorder hands us the bytes as it goes, so a take can only
  // ever lose its last second. A second, not 250 ms: the objection to fine
  // clusters was real, and one per second is few enough to be nothing while
  // still bounding the loss.
  //
  // This does NOT prove where the audio went — the diagnosis is still open, and
  // `[voice] decoded … vs clock …` in the console is what settles it. It bounds
  // the damage while that is answered.
  rec.start(1000)

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
            // Worth a line when the two disagree: it is the fingerprint of an
            // engine that mis-decodes its own recording, and the reason the
            // clock is a floor rather than a fallback.
            // The one line that settles where a short recording went. A clock
            // that ran ten seconds against two seconds of samples is not a
            // measurement problem, it is missing audio — and the chunk count
            // says whether the recorder was handing bytes over as it went or
            // holding them all until the end.
            if (decoded && Math.abs(decoded - elapsed / 1000) > 0.75) {
              ecWarn(`decoded ${decoded.toFixed(2)}s vs clock ${(elapsed / 1000).toFixed(2)}s`
                + ` — stamping ${secs.toFixed(2)}s · ${chunks.length} chunk(s), ${raw.length} B, ${mime}`)
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
