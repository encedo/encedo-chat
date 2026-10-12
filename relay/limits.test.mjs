import { test } from 'node:test'
import assert from 'node:assert/strict'
import { TopicValidatorResult } from '@libp2p/interface'
import { MAX_FRAME_BYTES, oversize, frameValidator } from './limits.mjs'

test('a frame at the bound passes, one byte more does not', () => {
  assert.equal(oversize(new Uint8Array(MAX_FRAME_BYTES)), false)
  assert.equal(oversize(new Uint8Array(MAX_FRAME_BYTES + 1)), true)
  assert.equal(oversize(undefined), false, 'no data is not oversize - it is somebody else\'s problem')
})

test('the topic validator ignores an oversize message and accepts the rest - never rejects', () => {
  assert.equal(frameValidator('t', { data: new Uint8Array(10) }), TopicValidatorResult.Accept)
  assert.equal(frameValidator('t', { data: new Uint8Array(MAX_FRAME_BYTES + 1) }), TopicValidatorResult.Ignore)
  assert.notEqual(frameValidator('t', { data: new Uint8Array(MAX_FRAME_BYTES + 1) }), TopicValidatorResult.Reject)
})
