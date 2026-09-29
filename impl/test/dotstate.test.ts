import { test } from 'node:test'
import assert from 'node:assert/strict'
import { dotFor } from '../lib/dotstate.ts'

test('green needs a channel AND a peer answering now', () => {
  for (const p of ['join', 'active', 'away']) assert.equal(dotFor({ secured: true, presence: p }), 'ok', p)
})

test('a channel with a silent peer is not green (2026-09-29: green on a deaf conversation)', () => {
  assert.equal(dotFor({ secured: true, presence: 'quiet' }), '')
  assert.equal(dotFor({ secured: true, presence: 'leave' }), '')
  assert.equal(dotFor({ secured: true, presence: null }), '')
  // ...unless the light watch still hears the peer: then it is reachable, not secured-and-live.
  assert.equal(dotFor({ secured: true, presence: 'quiet', announcing: true }), 'online')
})

test('announcing without a channel is orange; nothing at all is grey', () => {
  assert.equal(dotFor({ secured: false, presence: 'active' }), 'online')
  assert.equal(dotFor({ secured: false, presence: null, announcing: true }), 'online')
  assert.equal(dotFor({ secured: false, presence: 'leave' }), '')
  assert.equal(dotFor({ secured: false, presence: undefined }), '')
})
