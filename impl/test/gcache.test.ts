/**
 * Group-state cache crypto (`lib/gcache.ts`): a per-group blob seals under a key
 * bound to (base, gid). It opens with the same pair, and fails for a wrong base,
 * a wrong gid, or a tampered blob — so one group's cache never opens another's.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { sealCache, openCache } from '../lib/gcache.ts'
import { randomBytes, unb64, b64 } from '../lib/wc.ts'

const enc = new TextEncoder()
const td = new TextDecoder()

test('seal -> open round-trips with the same base + gid', async () => {
  const base = randomBytes(32)
  const gid = 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4'
  const pt = enc.encode(JSON.stringify({ secret: 'top', n: 7 }))
  const blob = await sealCache(base, gid, pt)
  const back = await openCache(base, gid, blob)
  assert.deepEqual(back, pt)
  assert.deepEqual(JSON.parse(td.decode(back!)), { secret: 'top', n: 7 })
})

test('a different gid does not open the blob', async () => {
  const base = randomBytes(32)
  const blob = await sealCache(base, 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', enc.encode('x'))
  assert.equal(await openCache(base, 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', blob), null)
})

test('a different base does not open the blob', async () => {
  const gid = 'cccccccccccccccccccccccccccccccc'
  const blob = await sealCache(randomBytes(32), gid, enc.encode('x'))
  assert.equal(await openCache(randomBytes(32), gid, blob), null)
})

test('a tampered blob does not open (AEAD)', async () => {
  const base = randomBytes(32)
  const gid = 'dddddddddddddddddddddddddddddddd'
  const blob = await sealCache(base, gid, enc.encode('hello'))
  const bytes = unb64(blob); bytes[bytes.length - 1] ^= 0x01 // flip a ciphertext bit
  assert.equal(await openCache(base, gid, b64(bytes)), null)
})
