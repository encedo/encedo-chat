/**
 * webm.ts — write the true length into a recording, because nobody else will.
 *
 * ## The problem this exists for
 *
 * A file from `MediaRecorder` is written WHILE it is spoken, so at the moment
 * the header goes out nobody knows how long the take will be. What lands in the
 * container depends on the engine and on how the recorder was driven:
 *
 * - Chromium, one `dataavailable` at the end: the muxer goes back and finalises
 *   the file. `Info > Duration` is there, `Segment` has a real size, there is a
 *   `SeekHead`. This is the good case, and it is the case the app hits today.
 * - Anything streaming (a timeslice, and some engines always): `Segment` size is
 *   unknown, there is no `SeekHead`, and `Info` has NO `Duration` at all. The
 *   player then answers `Infinity` — or, on WebKitGTK, a number with no
 *   relationship to reality.
 *
 * A player cannot fix that honestly: it can only guess by seeking past the end
 * and hoping the engine confesses, which is exactly the guess that shipped in
 * 0.3.11 and printed "2 seconds" for a seven-second note. So the length is
 * written HERE, once, into the bytes — and then every player on every platform,
 * including the recipient's, reads the same truth without being asked twice.
 *
 * ## Why this is safe to do to a file
 *
 * Two cases, and only two, are touched:
 *
 * 1. `Duration` already exists → its float is overwritten IN PLACE. Not one
 *    byte moves, so nothing that points into the file can be wrong afterwards.
 * 2. `Duration` is missing AND the file has no `SeekHead` and no `Cues` → the
 *    element is inserted into `Info`, growing it. Nothing in such a file stores
 *    an offset, so there is nothing to keep in step.
 *
 * Anything else — a file with a `SeekHead` but no `Duration`, a container that
 * is not WebM, bytes that do not parse — is returned UNCHANGED. Half-patching a
 * file whose seek table then points into the middle of an element would trade a
 * wrong number for a broken file, and the player has an honest fallback for an
 * unknown length; it has none for corruption.
 */

const ID_SEGMENT = 0x18538067
const ID_SEEKHEAD = 0x114d9b74
const ID_INFO = 0x1549a966
const ID_TIMECODESCALE = 0x2ad7b1
const ID_DURATION = 0x4489
const ID_CLUSTER = 0x1f43b675
const ID_CUES = 0x1c53bb6b

/** EBML's default, and what every `MediaRecorder` we have seen writes: one tick
 *  is a nanosecond × this, i.e. a millisecond. `Duration` counts those ticks. */
const DEFAULT_TIMECODE_SCALE = 1_000_000

interface Elem { id: number; start: number; content: number; size: number; end: number; unknown: boolean }

/** An element id is a VINT whose marker bit is kept — the id IS those bytes. */
function readId(b: Uint8Array, p: number): { id: number; width: number } {
  const first = b[p]
  if (first === undefined || first === 0) throw new Error('not an EBML id')
  let width = 1
  for (let mask = 0x80; !(first & mask); mask >>= 1) width++
  if (width > 4 || p + width > b.length) throw new Error('EBML id out of range')
  let id = 0
  for (let i = 0; i < width; i++) id = id * 256 + b[p + i]
  return { id, width }
}

/** A size is a VINT whose marker bit is dropped. All-ones means "unknown", which
 *  is how a live muxer says "I will stop when I stop". */
function readSize(b: Uint8Array, p: number): { size: number; width: number; unknown: boolean } {
  const first = b[p]
  if (first === undefined || first === 0) throw new Error('not an EBML size')
  let width = 1
  for (let mask = 0x80; !(first & mask); mask >>= 1) width++
  if (p + width > b.length) throw new Error('EBML size out of range')
  let size = first & (0xff >> width)
  let unknown = size === (0xff >> width)
  for (let i = 1; i < width; i++) {
    size = size * 256 + b[p + i]
    if (b[p + i] !== 0xff) unknown = false
  }
  return { size, width, unknown }
}

function readElem(b: Uint8Array, p: number, limit: number): Elem {
  const { id, width } = readId(b, p)
  const s = readSize(b, p + width)
  const content = p + width + s.width
  const end = s.unknown ? limit : content + s.size
  if (end > limit) throw new Error('EBML element runs past its parent')
  return { id, start: p, content, size: s.size, end, unknown: s.unknown }
}

/** Children of `parent`, stopping at the first Cluster: everything this module
 *  cares about (Info, SeekHead, Tracks) is written before the audio starts, and
 *  walking megabytes of clusters to learn nothing is a waste on a phone. */
function* children(b: Uint8Array, from: number, to: number): Generator<Elem> {
  let p = from
  while (p < to) {
    const e = readElem(b, p, to)
    yield e
    if (e.id === ID_CLUSTER) return
    if (e.unknown) return
    p = e.end
  }
}

function uintOf(b: Uint8Array, e: Elem): number {
  let v = 0
  for (let i = e.content; i < e.end; i++) v = v * 256 + b[i]
  return v
}

/** VINT with the marker bit set, at a chosen width. Returns null when the value
 *  does not fit — the caller then leaves the file alone rather than guessing. */
function sizeVint(value: number, width: number): Uint8Array | null {
  if (width < 1 || width > 8) return null
  const max = Math.pow(2, 7 * width) - 1
  if (value >= max) return null // all-ones is reserved for "unknown"
  const out = new Uint8Array(width)
  let v = value
  for (let i = width - 1; i >= 0; i--) { out[i] = v & 0xff; v = Math.floor(v / 256) }
  out[0] |= 0x80 >> (width - 1)
  return out
}

function locate(b: Uint8Array) {
  let segment: Elem | undefined
  for (const e of children(b, 0, b.length)) if (e.id === ID_SEGMENT) { segment = e; break }
  if (!segment) return null

  let info: Elem | undefined
  let hasOffsets = false
  for (const e of children(b, segment.content, segment.end)) {
    if (e.id === ID_INFO) info = e
    if (e.id === ID_SEEKHEAD || e.id === ID_CUES) hasOffsets = true
    if (e.id === ID_CLUSTER) break
  }
  if (!info || info.unknown) return null

  let duration: Elem | undefined
  let scale = DEFAULT_TIMECODE_SCALE
  for (const e of children(b, info.content, info.end)) {
    if (e.id === ID_DURATION) duration = e
    if (e.id === ID_TIMECODESCALE) scale = uintOf(b, e) || DEFAULT_TIMECODE_SCALE
  }
  return { segment, info, duration, scale, hasOffsets }
}

/** The length this file claims, in seconds — or null if it claims none. Written
 *  for the tests, and the honest answer to "did the stamp take?". */
export function readWebmDuration(bytes: Uint8Array): number | null {
  try {
    const at = locate(bytes)
    if (!at?.duration) return null
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    const ticks = at.duration.size === 4 ? view.getFloat32(at.duration.content)
      : at.duration.size === 8 ? view.getFloat64(at.duration.content)
      : null
    return ticks === null ? null : (ticks * at.scale) / 1e9
  } catch { return null }
}

/**
 * Write `seconds` into the file's `Info > Duration`, and hand back the bytes.
 *
 * Returns the ORIGINAL array whenever the length cannot be written safely — the
 * caller sends what it has either way, and a player that must measure for
 * itself is a smaller problem than a file no player will open.
 */
export function stampWebmDuration(bytes: Uint8Array, seconds: number): Uint8Array {
  if (!(seconds > 0) || !Number.isFinite(seconds)) return bytes
  try {
    const at = locate(bytes)
    if (!at) return bytes
    const ticks = (seconds * 1e9) / at.scale

    // Case 1: the element is there. Overwrite the float; nothing moves.
    if (at.duration) {
      if (at.duration.size !== 4 && at.duration.size !== 8) return bytes
      const out = bytes.slice()
      const view = new DataView(out.buffer, out.byteOffset, out.byteLength)
      if (at.duration.size === 4) view.setFloat32(at.duration.content, ticks)
      else view.setFloat64(at.duration.content, ticks)
      return out
    }

    // Case 2: no element, and no seek table to invalidate by growing Info.
    if (at.hasOffsets) return bytes

    const elem = new Uint8Array(11)
    elem[0] = 0x44; elem[1] = 0x89; elem[2] = 0x88 // id 0x4489, size 8
    new DataView(elem.buffer).setFloat64(3, ticks)

    const infoSizeAt = at.info.start + readId(bytes, at.info.start).width
    const infoSizeWidth = at.info.content - infoSizeAt
    const infoSize = sizeVint(at.info.size + elem.length, infoSizeWidth)
    if (!infoSize) return bytes // would need a wider size field: not worth the shift

    // The segment's own size only exists in a finalised file; a growing child
    // has to be added to it, and if that no longer fits at the width the muxer
    // chose, this file is left alone.
    let segSize: Uint8Array | null = null
    let segSizeAt = 0
    if (!at.segment.unknown) {
      segSizeAt = at.segment.start + readId(bytes, at.segment.start).width
      segSize = sizeVint(at.segment.size + elem.length, at.segment.content - segSizeAt)
      if (!segSize) return bytes
    }

    const out = new Uint8Array(bytes.length + elem.length)
    out.set(bytes.subarray(0, at.info.end), 0)
    out.set(elem, at.info.end)
    out.set(bytes.subarray(at.info.end), at.info.end + elem.length)
    out.set(infoSize, infoSizeAt)
    if (segSize) out.set(segSize, segSizeAt)
    return out
  } catch { return bytes }
}
