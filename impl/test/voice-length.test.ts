import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chooseLength } from '../web/src/voice.ts'

/**
 * The rule this pins cost a user a test round, so it is written down twice —
 * here and in `voice.ts` — and it is one sentence: **a stamped length is
 * obeyed, so it must never be shorter than the take.**
 *
 * A player told a file is two seconds long stops after two seconds whatever
 * else is in the container. Reported as "I recorded ten seconds, it shows two
 * and plays a fragment": `decodeAudioData` had answered short (measured on
 * Firefox: a 3.19 s take decoding as 1.913 s), that number went into the file,
 * and every player after that cut the recording where the header said to.
 *
 * Too long costs a bar that ends a moment early and heals itself the first time
 * the sound runs past it. The two errors are not comparable, so the clock — the
 * one measurement that cannot come out short — is a FLOOR.
 */
test('a decode that comes out short never shortens the take', () => {
  // The reported case: ten seconds recorded, the decoder claims two.
  assert.equal(chooseLength(2, 10_000), 10)
  assert.equal(chooseLength(1.913, 3190), 3.19)
})

test('a decode that is longer than the clock is believed', () => {
  // The clock starts when the recorder is told to start, so it can only run
  // long — but if the samples say otherwise, the samples are there.
  assert.equal(chooseLength(10.4, 10_000), 10.4)
})

test('no decode at all leaves the clock', () => {
  for (const bad of [null, 0, -1, NaN, Infinity]) {
    assert.equal(chooseLength(bad as any, 7_000), 7)
  }
})

test('the clock is used as given, in seconds', () => {
  assert.equal(chooseLength(null, 0), 0)
  assert.equal(chooseLength(null, 120_000), 120)
})
