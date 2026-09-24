/**
 * The `wire` level of the protocol log (`?debug=2`): one line per frame at the
 * client's edge -- plane, topic, the sender the frame names, its kind and size,
 * and the first 32 bytes in hex. Evidence, not a secret: it must stay silent
 * unless asked for, and it must never print more than the head of a frame.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { enableProtoLog, wlog, frameKind } from '../lib/protolog.ts'

test('silent unless the wire level is on', () => {
  const lines: string[] = []
  enableProtoLog({ events: true, wire: false, sink: (l) => lines.push(l) })
  wlog('<-', 'node', 'topic-abcdefghijk', 'peer', Uint8Array.from([0x10, 1, 2]))
  assert.deepEqual(lines, [])
})

test('one line per frame: plane, topic, sender, kind, size, and only the head of the bytes', () => {
  const lines: string[] = []
  enableProtoLog({ events: true, wire: true, sink: (l) => lines.push(l) })
  const frame = new Uint8Array(100).fill(0xab); frame[0] = 0x10
  wlog('<-', 'direct', 'abcdefghijklmnop', '12D3KooWP6SpQxgcUDdAU1CdY3dcvSrkxHPki7FRtMLLYiGxcDmp', frame)
  assert.equal(lines.length, 1)
  const l = lines[0]
  assert.match(l, /^\[wire\] <- direct/)
  assert.match(l, /topic=abcdefghijkl\.\.\./)
  assert.match(l, /from=12D3KooWP6SpQxgc\.\.\./)
  assert.match(l, /100 B ratchet content/)
  const hexPart = l.split('| ')[1]
  assert.equal(hexPart, '10' + 'ab'.repeat(31) + '...', 'exactly 32 bytes, then an ellipsis')
  enableProtoLog({ events: false, wire: false })
})

test('frame kinds by first byte', () => {
  assert.equal(frameKind(Uint8Array.from([0x01, 0])), 'EH-2 msg1')
  assert.equal(frameKind(Uint8Array.from([0x03, 0])), 'EH-2 msg3')
  assert.equal(frameKind(Uint8Array.from([0x20, 0])), 'group message')
  assert.equal(frameKind(Uint8Array.from([0x21])), 'group keepalive')
  assert.equal(frameKind(new TextEncoder().encode('{"v":1}')), 'announce (JSON, MAC-ed)')
  assert.equal(frameKind(new Uint8Array(348).fill(0x55)), 'knock (inbox)')
})
