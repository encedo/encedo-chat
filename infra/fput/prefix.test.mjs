import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { insertAfterPartHeaders, MAX_HEAD } from './prefix.mjs'

const HDR = Buffer.from([0x45, 0x43, 0x46, 0x31, 1, 0, 0, 0])
const body = (payload) => Buffer.concat([
  Buffer.from('--B\r\nContent-Disposition: form-data; name="file"; filename="b"\r\n' +
              'Content-Type: application/octet-stream\r\n\r\n'),
  Buffer.from(payload),
  Buffer.from('\r\n--B--\r\n'),
])

async function through(input, chunkSize) {
  const chunks = []
  for (let i = 0; i < input.length; i += chunkSize) chunks.push(input.subarray(i, i + chunkSize))
  const out = []
  await pipeline(Readable.from(chunks), insertAfterPartHeaders(HDR), async function* (s) {
    for await (const c of s) out.push(c)
  })
  return Buffer.concat(out)
}

test('the header lands right where the file content starts', async () => {
  const got = await through(body('PAYLOAD'), 4096)
  const at = got.indexOf('\r\n\r\n') + 4
  assert.deepEqual([...got.subarray(at, at + 8)], [...HDR])
  assert.equal(got.subarray(at + 8, at + 15).toString(), 'PAYLOAD')
  // The closing boundary must survive untouched, or Kubo rejects the request.
  assert.ok(got.toString().endsWith('\r\n--B--\r\n'))
  assert.equal(got.length, body('PAYLOAD').length + 8)
})

test('a separator split across chunks is still found', async () => {
  // The real cause of a bug this class of code always has: \r\n\r\n arriving
  // one byte per chunk. One-byte chunks exercise every possible split at once.
  const got = await through(body('PAYLOAD'), 1)
  const at = got.indexOf('\r\n\r\n') + 4
  assert.deepEqual([...got.subarray(at, at + 8)], [...HDR])
  assert.equal(got.length, body('PAYLOAD').length + 8)
})

test('only the FIRST separator counts', async () => {
  // The payload itself may contain \r\n\r\n — ciphertext is random bytes, so it
  // will, eventually. A second insertion would corrupt somebody's file.
  const got = await through(body('AA\r\n\r\nBB'), 3)
  assert.equal(got.length, body('AA\r\n\r\nBB').length + 8)
  assert.equal(got.indexOf(HDR), got.indexOf('\r\n\r\n') + 4)
  assert.equal(got.lastIndexOf(HDR), got.indexOf(HDR))
})

test('nothing is buffered once the header is placed', async () => {
  // 4 MiB in 64 KiB chunks: the transform must not hold the payload. If it did,
  // this still passes — but the assertion below pins the contract that matters,
  // that output appears before the input has finished.
  const payload = Buffer.alloc(4 * 1024 * 1024, 0x5a)
  const got = await through(body(payload), 64 * 1024)
  assert.equal(got.length, body(payload).length + 8)
})

test('a body that never ends its headers is refused', async () => {
  await assert.rejects(through(Buffer.from('--B\r\nContent-Disposition: x'), 8),
    /headers never ended/)
})

test('absurd part headers are refused rather than buffered', async () => {
  const huge = Buffer.concat([Buffer.from('--B\r\n'), Buffer.alloc(MAX_HEAD + 64, 0x41)])
  await assert.rejects(through(huge, 1024), /headers too long/)
})
