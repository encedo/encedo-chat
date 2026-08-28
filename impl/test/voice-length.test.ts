import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chooseLength, micDied } from '../web/src/voice.ts'

/**
 * This rule has been wrong in BOTH directions, so both mistakes are pinned.
 *
 * 0.3.14 stamped what `decodeAudioData` answered, and a container's length is
 * obeyed — a player told "two seconds" stops after two. Reported as a
 * ten-second note playing a fragment, so 0.3.15 made the wall clock a floor.
 *
 * That was the wrong fix, because the decode had been right. A recording from
 * the field settled it: the header said 6012 ms — the clock, stamped by 0.3.15 —
 * and the media held three clusters ending at 2367 ms. The samples were not
 * there. The floor had turned a short note into a note that plays silence for
 * the rest of its length, and hid the actual fault, which is capture stopping
 * mid-recording.
 *
 * So the samples decide, the clock is only a fallback, and a gap between them
 * is REPORTED rather than smoothed over.
 */
test('the samples decide how long a take is', () => {
  assert.equal(chooseLength(2, 10_000), 2)
  assert.equal(chooseLength(9.8, 10_000), 9.8)
  // The real file, in the numbers it was found with.
  assert.equal(chooseLength(2.367, 6012), 2.367)
})

test('no decode at all leaves the clock, which is all there is', () => {
  for (const bad of [null, 0, -1, NaN, Infinity]) {
    assert.equal(chooseLength(bad as any, 7_000), 7)
  }
})

test('a gap between the clock and the samples is a dead microphone', () => {
  assert.equal(micDied(2.367, 6012), true)
  // Device start-up and the encoder's tail are not a fault: a quarter of a
  // second short is what a working recording looks like.
  assert.equal(micDied(9.75, 10_000), false)
  assert.equal(micDied(4.74, 5_000), false)
  // Nothing to compare against is not evidence of anything.
  assert.equal(micDied(null, 10_000), false)
})
