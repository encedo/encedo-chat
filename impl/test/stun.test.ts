/**
 * The STUN responder (`infra/stun/stun.mjs`) — what it answers, and above all
 * what it refuses to answer.
 *
 * A UDP responder replies to a source address nobody verified, so every extra
 * thing it is willing to send is a reflector somebody else can aim. These tests
 * are mostly about the refusals.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
// @ts-ignore — a plain .mjs beside the deploy files, imported for its pure half
import { bindingRequestId, bindingResponse, ipBytes, limiter } from '../../infra/stun/stun.mjs'

const COOKIE = 0x2112a442
const TID = Buffer.from('0123456789ab', 'utf8') // 12 bytes

function req({ type = 0x0001, cookie = COOKIE, len = 0, attrs = Buffer.alloc(0) } = {}) {
  const b = Buffer.alloc(20 + attrs.length)
  b.writeUInt16BE(type, 0)
  b.writeUInt16BE(len, 2)
  b.writeUInt32BE(cookie, 4)
  TID.copy(b, 8)
  attrs.copy(b, 20)
  return b
}

test('a well-formed Binding Request is recognised by its transaction id', () => {
  assert.deepEqual(bindingRequestId(req()), TID)
  // Attributes are ignored, not parsed — but the length has to describe them.
  const attrs = Buffer.alloc(8)
  assert.deepEqual(bindingRequestId(req({ len: 8, attrs })), TID)
})

test('anything that is not exactly a Binding Request gets no answer', () => {
  assert.equal(bindingRequestId(req({ type: 0x0101 })), null, 'a success RESPONSE is not a request')
  assert.equal(bindingRequestId(req({ type: 0x0011 })), null, 'an indication is not a request')
  assert.equal(bindingRequestId(req({ type: 0x0003 })), null, 'TURN Allocate — we do not relay')
  assert.equal(bindingRequestId(req({ cookie: 0xdeadbeef })), null, 'no magic cookie')
  assert.equal(bindingRequestId(Buffer.alloc(12)), null, 'too short to be a header')
  assert.equal(bindingRequestId(req({ len: 4 })), null, 'declared length longer than the datagram')
  assert.equal(bindingRequestId(req({ len: 2, attrs: Buffer.alloc(2) })), null, 'length not a whole 4-byte word')
  assert.equal(bindingRequestId('not a buffer' as any), null)
})

test('the answer is a Binding Success carrying the XORed address', () => {
  const out = bindingResponse(TID, '203.0.113.9', 54321, 'IPv4')!
  assert.equal(out.length, 32, '20 header + 4 attribute header + 8 value')
  assert.equal(out.readUInt16BE(0), 0x0101)
  assert.equal(out.readUInt16BE(2), 12, 'the length counts attributes only')
  assert.equal(out.readUInt32BE(4), COOKIE)
  assert.deepEqual(out.subarray(8, 20), TID, 'the transaction id comes back as it went')
  assert.equal(out.readUInt16BE(20), 0x0020, 'XOR-MAPPED-ADDRESS')
  assert.equal(out.readUInt8(25), 0x01, 'family IPv4')
  // Undo the XOR the way a client does.
  assert.equal(out.readUInt16BE(26) ^ (COOKIE >>> 16), 54321)
  const addr = (out.readUInt32BE(28) ^ COOKIE) >>> 0
  assert.equal([addr >>> 24, (addr >>> 16) & 255, (addr >>> 8) & 255, addr & 255].join('.'), '203.0.113.9')
})

test('IPv6 is XORed with the cookie AND the transaction id', () => {
  const out = bindingResponse(TID, '2a03:b0c0:2:f0::1', 443, 'IPv6')!
  assert.equal(out.length, 44)
  assert.equal(out.readUInt8(25), 0x02, 'family IPv6')
  const mask = Buffer.concat([Buffer.from([0x21, 0x12, 0xa4, 0x42]), TID])
  const got = Buffer.alloc(16)
  for (let i = 0; i < 16; i++) got[i] = out.readUInt8(28 + i) ^ mask[i]
  assert.deepEqual(got, ipBytes('2a03:b0c0:2:f0::1', true))
})

test('an IPv4 client on the v6 socket is answered as IPv4', () => {
  // Dual-stack sockets report `::ffff:a.b.c.d`; an ICE agent that got a 16-byte
  // v6 candidate for a v4 client would offer an address it cannot reach.
  assert.deepEqual(ipBytes('::ffff:203.0.113.9', true), Buffer.from([203, 0, 113, 9]))
})

test('addresses that are not addresses produce no answer at all', () => {
  assert.equal(ipBytes('999.1.1.1', false), null)
  assert.equal(ipBytes('1.2.3', false), null)
  assert.equal(ipBytes('nonsense', false), null)
  assert.equal(bindingResponse(TID, 'nonsense', 1, 'IPv4'), null)
})

test('a source that asks too fast is dropped, and recovers on its own', () => {
  let t = 0
  const gate = limiter({ perSec: 10, burst: 5, now: () => t })
  for (let i = 0; i < 5; i++) assert.ok(gate.allow('203.0.113.9'), `burst ${i}`)
  assert.equal(gate.allow('203.0.113.9'), false, 'the sixth in the same instant is dropped')
  assert.ok(gate.allow('198.51.100.1'), 'a different source has its own bucket')
  t += 500 // half a second → five more tokens
  assert.ok(gate.allow('203.0.113.9'))
})

test('the bucket table cannot grow without bound', () => {
  // The one thing a spoofed-source flood can actually cost us.
  let t = 0
  const gate = limiter({ max: 10, now: () => t })
  for (let i = 0; i < 25; i++) gate.allow(`203.0.113.${i}`)
  assert.ok(gate.size <= 10, `table held ${gate.size}`)
  t += 120_000
  gate.sweep()
  assert.equal(gate.size, 0, 'idle buckets are swept')
})
