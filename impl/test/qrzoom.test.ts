/**
 * The camera-zoom plan for the QR scanner.
 *
 * Capabilities come from a driver, so the tests are mostly about what a driver
 * is allowed to be: absent, half-filled, or reporting a number where a range
 * was expected.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { PREFERRED_START, clampToStep, zoomPlan } from '../lib/qrzoom.ts'

test('a camera with a real range opens at arm’s length, not at 1x', () => {
  const p = zoomPlan({ zoom: { min: 1, max: 8, step: 0.1 } })!
  assert.deepEqual(p, { min: 1, max: 8, step: 0.1, start: PREFERRED_START })
})

test('every camera opens on the whole frame, however far it can zoom', () => {
  // This used to open as far in as the lens allowed, on the reasoning that a
  // code is held at arm's length. A Galaxy S24 disproved it (2026-09-10):
  // zoomed in, the scanner starts INSIDE the code and decodes nothing until
  // somebody backs away. The whole frame is where a code is either readable or
  // obviously too far, and the slider is right there for the rest.
  const short = zoomPlan({ zoom: { min: 1, max: 1.5 } })!
  assert.equal(short.start, 1)
  assert.ok(short.step > 0 && short.step <= 0.5, `step ${short.step}`)
  const long = zoomPlan({ zoom: { min: 1, max: 8 } })!
  assert.equal(long.start, 1)
  // A camera whose range does not include 1x opens at the nearest thing it has.
  const cropped = zoomPlan({ zoom: { min: 2, max: 6 } })!
  assert.equal(cropped.start, 2)
})

test('no control at all rather than one that cannot move', () => {
  // Every desktop webcam, and phones whose driver says nothing. A slider that
  // refuses is worse than no slider: it claims a feature and then denies it.
  assert.equal(zoomPlan(null), null)
  assert.equal(zoomPlan(undefined), null)
  assert.equal(zoomPlan({}), null)
  assert.equal(zoomPlan({ zoom: 1 } as any), null, 'a bare number is the CURRENT zoom, not a range')
  assert.equal(zoomPlan({ zoom: { min: 1, max: 1 } }), null, 'min == max has nothing to offer')
  assert.equal(zoomPlan({ zoom: { min: 4, max: 2 } }), null, 'backwards range')
  assert.equal(zoomPlan({ zoom: { min: 'a', max: 'b' } } as any), null)
  assert.equal(zoomPlan({ zoom: { min: 1, max: Infinity } } as any), null)
})

test('a missing or nonsense step becomes a usable one', () => {
  for (const step of [undefined, 0, -1, 'x', 999]) {
    const p = zoomPlan({ zoom: { min: 1, max: 5, step } } as any)!
    assert.ok(p.step > 0, `step ${JSON.stringify(step)} -> ${p.step}`)
    assert.ok(p.step <= 4, 'a step wider than the range is not a step')
  }
})

test('values snap to the grid, inside the range, without float dust', () => {
  assert.equal(clampToStep(2.04, 1, 8, 0.1), 2)
  assert.equal(clampToStep(0, 1, 8, 0.1), 1, 'below the floor')
  assert.equal(clampToStep(99, 1, 8, 0.1), 8, 'above the ceiling')
  // min + k*step is exactly where binary floats go wrong: 1 + 8*0.1 is
  // 1.8000000000000003, and that reaches applyConstraints as it is.
  assert.equal(clampToStep(1.8, 1, 8, 0.1), 1.8)
  assert.equal(clampToStep(7.99, 1, 8, 0.3), 8, 'the range wins over the grid at the end')
})
