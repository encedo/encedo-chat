import { test } from 'node:test'
import assert from 'node:assert/strict'
import { TopicValidatorResult } from '@libp2p/interface'
import { MAX_FRAME_BYTES, oversize, frameValidator, loadValidator } from './limits.mjs'

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

test('the load topic carries only relays: a sibling or this node, never a client', () => {
  const v = loadValidator(new Set(['sib']), 'self')
  const msg = (from) => ({ from: from && { toString: () => from }, data: new Uint8Array(10) })
  assert.equal(v('t', msg('sib')), TopicValidatorResult.Accept)
  assert.equal(v('t', msg('self')), TopicValidatorResult.Accept)
  assert.equal(v('t', msg('client')), TopicValidatorResult.Ignore, 'a client speaking for a node')
  assert.equal(v('t', msg(undefined)), TopicValidatorResult.Ignore, 'an unsigned message names nobody')
  assert.notEqual(v('t', msg('client')), TopicValidatorResult.Reject, 'the forwarder may be a sibling in good faith')
  assert.equal(v('t', { from: { toString: () => 'sib' }, data: new Uint8Array(MAX_FRAME_BYTES + 1) }), TopicValidatorResult.Ignore)
})
