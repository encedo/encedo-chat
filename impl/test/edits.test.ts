/**
 * Correcting a message: the window, who may rewrite whose words, and the codec.
 *
 * The rules in `lib/edits.ts` are small enough to read and exactly the kind that
 * gets re-derived slightly differently in a second place — which is why they are
 * one module with one test rather than two conditions in the UI.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { canEdit, acceptEdit, EDIT_WINDOW_MS, EDIT_SKEW_MS } from '../lib/edits.ts'
import { encodeEnvelope, decodeEnvelope, envEdit } from '../lib/envelope.ts'

const te = new TextEncoder()
const rt = (e: any) => decodeEnvelope(encodeEnvelope(e)) as any
const raw = (o: any) => decodeEnvelope(te.encode(JSON.stringify(o))) as any
const NOW = 1_800_000_000_000

test('the window is fifteen minutes, from the message', () => {
  assert.ok(canEdit(NOW, NOW))
  assert.ok(canEdit(NOW - EDIT_WINDOW_MS + 1, NOW))
  assert.ok(!canEdit(NOW - EDIT_WINDOW_MS - 1, NOW))
  // A sender's clock that runs ahead must not lock them out of their own fix.
  assert.ok(canEdit(NOW + EDIT_SKEW_MS - 1, NOW))
  assert.ok(!canEdit(NOW + EDIT_SKEW_MS + 1, NOW))
})

test('an incoming correction only ever rewrites the sender\'s own words', () => {
  const theirs = { mine: false, ts: NOW }
  const ours = { mine: true, ts: NOW }
  assert.ok(acceptEdit(theirs, NOW))
  // The one that matters: otherwise the other end of a conversation could
  // quietly rewrite what we are on record as having said.
  assert.ok(!acceptEdit(ours, NOW), 'a peer must not be able to edit OUR message')
  // Nothing held for that id — the usual case after a reload, and simply a
  // correction that arrives with nothing to correct.
  assert.ok(!acceptEdit(undefined, NOW))
  assert.ok(!acceptEdit({ mine: false, ts: NOW - EDIT_WINDOW_MS - 1 }, NOW))
})

test('an edit envelope roundtrips, and a malformed one does not decode', () => {
  const e = rt(envEdit(3, 'mid-1', 'poprawiona treść 🌳'))
  assert.equal(e.t, 'edit'); assert.equal(e.to, 'mid-1')
  assert.equal(e.body, 'poprawiona treść 🌳'); assert.equal(e.format, 'plain')
  assert.equal(e.seq, 3); assert.equal(typeof e.id, 'string')
  // The correction's OWN id is what delivery is tracked under — it is not the id
  // of the message being corrected, or an ack would confirm the wrong thing.
  assert.notEqual(e.id, e.to)

  const base = { v: 1, t: 'edit', id: 'x', ts: 1, seq: 1, to: 'mid-1', body: 'x', format: 'plain' }
  assert.equal(raw({ ...base, to: '' }), null)       // nothing to correct
  assert.equal(raw({ ...base, to: undefined }), null)
  assert.equal(raw({ ...base, body: 42 }), null)
  assert.equal(raw({ ...base, format: 'html' }), null) // the body rule is the message's rule
})

test('a build that does not know edits ignores them (forward-compat)', () => {
  // What an older client sees: a valid base with an unknown type, carried and
  // ignored — which means it goes on showing the ORIGINAL text. That is the
  // whole reason the sender is shown proof of delivery instead of assuming.
  const asUnknown = raw({ v: 1, t: 'edit-v2-someday', id: 'x', ts: 1, seq: 1, to: 'a', body: 'b' })
  assert.equal(asUnknown?.t, 'edit-v2-someday')
})
