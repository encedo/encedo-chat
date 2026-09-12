import { test } from 'node:test'
import assert from 'node:assert/strict'
import { wrapBlob, unwrapBlob, hasEnvelope, MAGIC, VERSION, HEADER_LEN } from '../lib/fileenvelope.ts'

test('a wrapped blob comes back byte for byte', () => {
  const cipher = Uint8Array.from({ length: 1000 }, (_, i) => (i * 7) & 0xff)
  const wrapped = wrapBlob(cipher)
  assert.equal(wrapped.length, cipher.length + HEADER_LEN)
  assert.deepEqual([...unwrapBlob(wrapped)], [...cipher])
})

test('the header is what the guard will look for', () => {
  const w = wrapBlob(new Uint8Array(4))
  assert.deepEqual([...w.subarray(0, 4)], [...MAGIC])
  assert.equal(w[4], VERSION)
  // The reserved bytes are zero, so a future flag cannot be confused with noise.
  assert.deepEqual([...w.subarray(5, 8)], [0, 0, 0])
})

test('an empty file still carries a full header', () => {
  const w = wrapBlob(new Uint8Array(0))
  assert.equal(w.length, HEADER_LEN)
  assert.equal(unwrapBlob(w).length, 0)
})

test('a blob from an older build is still readable', () => {
  // Packaged apps update on their own schedule, so for one release both shapes
  // are legitimate. Nothing here may reject the bare ciphertext.
  const bare = Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8, 9])
  assert.equal(hasEnvelope(bare), false)
  assert.deepEqual([...unwrapBlob(bare)], [...bare])
})

test('ciphertext that happens to start with the magic is not mistaken for a header', () => {
  // Random bytes hit four fixed bytes once in 4 billion; the version byte then
  // decides, and this is the case that must not silently lose eight bytes.
  const unlucky = new Uint8Array([...MAGIC, 0x7f, 0, 0, 0, 0xaa, 0xbb])
  assert.throws(() => unwrapBlob(unlucky), /version 127/)
})

test('a truncated body cannot pass as a header', () => {
  for (const n of [0, 1, 4, 7]) {
    const short = new Uint8Array(MAGIC.subarray(0, Math.min(n, 4)))
    const padded = new Uint8Array(n)
    padded.set(short)
    assert.equal(hasEnvelope(padded), false, `length ${n}`)
    assert.equal(unwrapBlob(padded).length, n)
  }
})

test('unwrap does not copy the ciphertext', () => {
  // An 80 MB file is the reason: a copy here would double peak memory on a phone.
  const cipher = Uint8Array.from({ length: 64 }, (_, i) => i)
  const body = unwrapBlob(wrapBlob(cipher))
  assert.equal(body.byteOffset, HEADER_LEN)
})
