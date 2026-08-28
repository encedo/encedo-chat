import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { stampWebmDuration, readWebmDuration } from '../web/src/webm.ts'

/**
 * The bug these tests are the answer to.
 *
 * A voice note recorded in 0.3.11 showed "2 seconds" for a seven-second take on
 * the web and something like twenty hours in the desktop build, and the player's
 * bar, countdown and seek were all wrong in the same way, because all three read
 * one number. The number came from asking the ENGINE how long a file was that
 * carries no length — a question with no reliable answer, asked in a way (seek
 * past the end, read on the next `timeupdate`) that raced the engine and lost.
 *
 * So the length is written into the file at Stop instead, and these are the two
 * shapes a `MediaRecorder` actually produces. Both fixtures are real Chromium
 * output, recorded through the same code path the app uses:
 *
 * - `rec-finalised.webm` — one `dataavailable` at the end, so the muxer went
 *   back and finished the file: `Info > Duration` present, `Segment` sized, a
 *   `SeekHead` full of offsets.
 * - `rec-streaming.webm` — recorded with a timeslice, so it was written straight
 *   out: unknown `Segment` size, no `SeekHead`, and no `Duration` at all. This
 *   is the file that answers `Infinity`, and the one the user was looking at.
 */
const fixture = (name: string) => new Uint8Array(readFileSync(join(import.meta.dirname, 'fixtures', name)))

test('a finalised recording has its length overwritten in place', () => {
  const before = fixture('rec-finalised.webm')
  assert.ok((readWebmDuration(before) ?? 0) > 0.1, 'fixture should already carry a length')

  const after = stampWebmDuration(before, 12.5)
  assert.ok(Math.abs((readWebmDuration(after) ?? 0) - 12.5) < 0.01)
  // Not one byte moves. Anything else would leave the SeekHead in this file
  // pointing at the middle of an element.
  assert.equal(after.length, before.length)
  const differing = [...after].filter((b, i) => b !== before[i]).length
  assert.ok(differing > 0 && differing <= 4, `only the float should differ, ${differing} bytes did`)
})

test('a streamed recording gets a length it never had', () => {
  const before = fixture('rec-streaming.webm')
  assert.equal(readWebmDuration(before), null, 'fixture should carry no length')

  const after = stampWebmDuration(before, 7.25)
  assert.ok(Math.abs((readWebmDuration(after) ?? 0) - 7.25) < 0.001)
  // id + size + eight bytes of float, and nothing else.
  assert.equal(after.length, before.length + 11)
  // The audio itself is untouched: everything from the insertion point on is the
  // same bytes in the same order.
  const tail = before.length - 200
  assert.deepEqual([...after.subarray(after.length - 200)], [...before.subarray(tail)])
})

test('the input array is never modified', () => {
  const before = fixture('rec-finalised.webm')
  const copy = before.slice()
  stampWebmDuration(before, 33)
  assert.deepEqual([...before], [...copy])
})

/**
 * The refusal is the safety, so it is tested like a feature.
 *
 * A file that stores offsets (`SeekHead`, `Cues`) and has NO `Duration` cannot
 * be grown without moving everything those offsets point at. We do not chase
 * that: the bytes come back untouched and the player measures for itself. A
 * wrong length is a wrong label; a mis-patched container is a file nothing will
 * open.
 */
test('a file whose offsets would break is left completely alone', () => {
  const ebml = (id: number[], content: number[]) => [...id, 0x80 | content.length, ...content]
  const seekHead = ebml([0x11, 0x4d, 0x9b, 0x74], ebml([0x53, 0xac], [0x2a]))
  const info = ebml([0x15, 0x49, 0xa9, 0x66], ebml([0x2a, 0xd7, 0xb1], [0x0f, 0x42, 0x40]))
  const segment = ebml([0x18, 0x53, 0x80, 0x67], [...seekHead, ...info])
  const bytes = new Uint8Array(segment)

  assert.equal(readWebmDuration(bytes), null)
  assert.equal(stampWebmDuration(bytes, 9), bytes, 'the very same array should come back')
})

test('what is not a recording is not touched', () => {
  for (const junk of [new Uint8Array(0), new Uint8Array([0]), new Uint8Array([1, 2, 3, 4, 5]),
    new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 0x84, 1, 2, 3, 4])]) {
    assert.equal(stampWebmDuration(junk, 5), junk)
    assert.equal(readWebmDuration(junk), null)
  }
})

test('a length that is not a length is refused', () => {
  const before = fixture('rec-streaming.webm')
  for (const bad of [0, -3, NaN, Infinity]) assert.equal(stampWebmDuration(before, bad), before)
})

/**
 * `Duration` counts ticks of `TimecodeScale`, not seconds — every recorder we
 * have seen writes the EBML default of a millisecond, but a file that says
 * otherwise must still read back as the right number of SECONDS. Getting this
 * backwards would be the same class of bug as the one being fixed: a number
 * shown confidently in the wrong unit.
 */
test('the timecode scale is honoured, not assumed', () => {
  const ebml = (id: number[], content: number[]) => [...id, 0x80 | content.length, ...content]
  // 100 000 ns per tick — a tenth of a millisecond, ten times the usual rate.
  const info = ebml([0x15, 0x49, 0xa9, 0x66], ebml([0x2a, 0xd7, 0xb1], [0x01, 0x86, 0xa0]))
  const before = new Uint8Array(ebml([0x18, 0x53, 0x80, 0x67], info))

  const after = stampWebmDuration(before, 3)
  assert.ok(Math.abs((readWebmDuration(after) ?? 0) - 3) < 0.001, 'three seconds should read back as three')
  // Info is the last element here, so the float it just gained is the tail.
  const view = new DataView(after.buffer, after.byteOffset, after.byteLength)
  assert.equal(view.getFloat64(after.length - 8), 30_000, 'three seconds is 30 000 ticks at this scale')
})
