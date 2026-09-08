/**
 * The composer's height (`lib/composer.ts`).
 *
 * The box grows with the text and stops before it swallows the conversation.
 * Every case here is one the DOM would only show on a screen.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { boxHeight, boxLines, LINES_CLOSED, LINES_OPEN } from '../lib/composer.ts'

const M = (scroll: number) => ({ line: 20, pad: 20, scroll })

test('one line of text is one line of box', () => {
  assert.equal(boxHeight(M(40), false), 40)
  assert.equal(boxLines(boxHeight(M(40), false), M(40)), 1)
})

test('it grows with the text, up to four lines', () => {
  assert.equal(boxHeight(M(60), false), 60)  // two lines
  assert.equal(boxHeight(M(100), false), 100) // four
  // Five lines of text: the box stays at four and the text scrolls inside it.
  assert.equal(boxHeight(M(120), false), 20 * LINES_CLOSED + 20)
})

test('and shrinks again', () => {
  // The regression this guards: `scrollHeight` read WITHOUT releasing the
  // height reports the height the box already has, and the box never comes
  // back down. Here the caller has released it, and the arithmetic follows.
  assert.equal(boxHeight(M(40), false), 40)
})

test('opened, it starts at four lines and goes to twelve', () => {
  assert.equal(boxHeight(M(40), true), 20 * LINES_CLOSED + 20, 'an empty opened box is still four lines')
  assert.equal(boxHeight(M(200), true), 200)
  assert.equal(boxHeight(M(400), true), 20 * LINES_OPEN + 20)
})

test('a browser that cannot measure a line still gets a usable box', () => {
  // `line-height: normal` computes to the string "normal", which parses to NaN.
  // NaN spreads through Math.min and ends as height:"NaNpx", which is ignored -
  // so the box would sit at its default size and the feature would be gone.
  const nan = { line: NaN, pad: NaN, scroll: NaN }
  const h = boxHeight(nan, false)
  assert.ok(Number.isFinite(h) && h > 0, `unusable height: ${h}`)
  assert.equal(boxHeight({ line: NaN, pad: 20, scroll: 200 }, false), 20 * LINES_CLOSED + 20)
})

test('the cap is a cap, not a target', () => {
  // A tall empty box is the failure mode people notice: the composer must not
  // open at four lines when there is nothing in it.
  assert.ok(boxHeight(M(40), false) < boxHeight(M(100), false))
})
