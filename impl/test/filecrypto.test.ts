/**
 * File bodies: chunked AES-256-GCM, and the three ways a chunked file can be
 * attacked without touching a single byte of ciphertext.
 *
 * Reordering and truncation are the ones worth the tests. An attacker who can
 * serve the blob — our own IPFS node included — cannot forge a chunk, but it
 * can hand back the same chunks in a different order or stop early, and a naive
 * scheme accepts both silently.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  planChunks, newFileKey, encryptBytes, decryptBytes, encryptChunk, decryptChunk,
  chunkCipherLen, DEFAULT_CHUNK, MAX_FILE,
} from '../lib/filecrypto.ts'
import { randomBytes } from '../lib/wc.ts'

const CHUNK = 1024 // small, so the tests exercise many chunks cheaply

test('round trip, across chunk boundaries', async () => {
  const k = newFileKey()
  for (const size of [0, 1, CHUNK - 1, CHUNK, CHUNK + 1, CHUNK * 3, CHUNK * 3 + 7]) {
    const plain = randomBytes(size)
    const { manifest, cipher } = await encryptBytes(k, plain, CHUNK)
    assert.equal(manifest.size, size)
    assert.deepEqual(await decryptBytes(k, manifest, cipher), plain, `size ${size}`)
  }
})

test('an empty file is one chunk, not zero', async () => {
  // Otherwise "empty" and "truncated to nothing" are the same blob.
  const m = planChunks(0, CHUNK)
  assert.equal(m.chunks, 1)
  const k = newFileKey()
  const { cipher } = await encryptBytes(k, new Uint8Array(0), CHUNK)
  assert.equal(cipher.length, 16, 'a tag, and nothing else')
})

test('the ciphertext says nothing the plaintext did not', async () => {
  const k = newFileKey()
  const plain = new TextEncoder().encode('poufny raport kwartalny'.repeat(50))
  const { cipher } = await encryptBytes(k, plain, CHUNK)
  assert.ok(!Buffer.from(cipher).includes(Buffer.from('raport')), 'no plaintext survives in the blob')
})

test('a wrong key does not open it', async () => {
  const { manifest, cipher } = await encryptBytes(newFileKey(), randomBytes(CHUNK * 2), CHUNK)
  await assert.rejects(decryptBytes(newFileKey(), manifest, cipher))
})

test('REORDERED chunks are refused — the index is in the AAD', async () => {
  const k = newFileKey()
  const m = planChunks(CHUNK * 2, CHUNK)
  const a = await encryptChunk(k, m, 0, randomBytes(CHUNK))
  // Chunk 0 offered as chunk 1: same bytes, same key, different position.
  await assert.rejects(decryptChunk(k, m, 1, a), 'a chunk must only open at its own index')
})

test('a TRUNCATED file is refused — the count is in the AAD too', async () => {
  const k = newFileKey()
  const plain = randomBytes(CHUNK * 3)
  const { manifest, cipher } = await encryptBytes(k, plain, CHUNK)

  // Dropping the tail and claiming a shorter file: every chunk names how many
  // there should be, so chunks written for a 3-chunk file will not open as a
  // 2-chunk one — even though the bytes are untouched.
  const short = { ...manifest, chunks: 2, size: CHUNK * 2 }
  const cut = cipher.subarray(0, chunkCipherLen(manifest, 0) + chunkCipherLen(manifest, 1))
  await assert.rejects(decryptBytes(k, short, cut))
})

test('a blob of the wrong length is rejected before the AEAD', async () => {
  // A short fetch should read as a short fetch, not as a wrong key.
  const k = newFileKey()
  const { manifest, cipher } = await encryptBytes(k, randomBytes(CHUNK * 2), CHUNK)
  await assert.rejects(decryptBytes(k, manifest, cipher.subarray(0, cipher.length - 5)), /manifest says/)
})

test('a flipped bit anywhere fails, and yields nothing partial', async () => {
  const k = newFileKey()
  const { manifest, cipher } = await encryptBytes(k, randomBytes(CHUNK * 2), CHUNK)
  const bad = cipher.slice(); bad[CHUNK + 4] ^= 1
  await assert.rejects(decryptBytes(k, manifest, bad))
})

test('the chunk size is a wire field, so a non-default one still opens', async () => {
  const k = newFileKey()
  const plain = randomBytes(5000)
  const { manifest, cipher } = await encryptBytes(k, plain, 777)
  assert.equal(manifest.chunk, 777)
  assert.deepEqual(await decryptBytes(k, manifest, cipher), plain)
})

test('an unknown algorithm is refused rather than guessed', async () => {
  const k = newFileKey()
  const { manifest, cipher } = await encryptBytes(k, randomBytes(64), CHUNK)
  await assert.rejects(decryptBytes(k, { ...manifest, alg: 'A128GCM-v9' as any }, cipher), /unknown file algorithm/)
})

test('the limits are enforced, not advisory', () => {
  assert.throws(() => planChunks(MAX_FILE + 1), /limit/)
  assert.throws(() => planChunks(10, 0), /chunk size/)
  assert.throws(() => planChunks(10, 999 * 1024 * 1024), /chunk size/)
  assert.equal(planChunks(MAX_FILE).chunk, DEFAULT_CHUNK)
})
