/**
 * The message-length limit (`lib/msgsize.ts`).
 *
 * The interesting cases are all about the gap between what a person sees and
 * what goes on the wire - which is the whole reason this is measured in bytes.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { bodyBytes, fitsOnWire, overBy, MAX_BODY, WIRE_MAX, WARN_AT, kb } from '../lib/msgsize.ts'

test('an ordinary message is nowhere near the limit', () => {
  assert.ok(fitsOnWire('Do zobaczenia jutro o dziesiątej.'))
  assert.ok(overBy('cześć') < -60_000)
})

test('a Polish character costs two bytes, an emoji four', () => {
  // The reason a character count is the wrong measure. `JSON.stringify` adds
  // the two quotes, which is why each of these is two more than the payload.
  assert.equal(bodyBytes('abc'), 3 + 2)
  assert.equal(bodyBytes('żółw'), 2 + 2 + 2 + 1 + 2, 'three two-byte letters, one one-byte, two quotes')
  assert.equal(bodyBytes('👋'), 4 + 2)
})

test('newlines and quotes nearly double on the way out', () => {
  // The shape the multi-line composer made easy to type: a message that is
  // mostly line breaks. Each one is a backslash and an n inside the JSON.
  const lines = '\n'.repeat(1000)
  assert.equal(bodyBytes(lines), 2000 + 2)
  const quotes = '"'.repeat(1000)
  assert.equal(bodyBytes(quotes), 2000 + 2)
  // So a text of 40k line breaks does NOT fit, even though 40k characters of
  // prose would - and the count is what says so.
  assert.equal(fitsOnWire('\n'.repeat(40_000)), false)
  assert.equal(fitsOnWire('a'.repeat(40_000)), true)
})

test('the budget leaves room for the envelope and the seal', () => {
  // A body exactly at the limit plus the fixed cost must still be under the
  // relay's ceiling, or the check would pass and the publish would be dropped.
  assert.ok(MAX_BODY + 1_024 <= WIRE_MAX)
  assert.equal(fitsOnWire('a'.repeat(MAX_BODY - 2)), true, 'a body that exactly fits must be allowed')
  assert.equal(fitsOnWire('a'.repeat(MAX_BODY)), false, 'the quotes count too')
})

test('over the limit, the app can say by how much', () => {
  const text = 'a'.repeat(MAX_BODY + 500)
  assert.equal(overBy(text), 502) // 500 characters plus the two quotes
  assert.match(kb(overBy(text)), /^0\.5 KB$/)
})

test('the counter stays quiet until it is nearly a problem', () => {
  assert.ok(WARN_AT > 50_000 && WARN_AT < MAX_BODY)
  assert.ok(bodyBytes('a normal sentence, however wordy') < WARN_AT)
})
