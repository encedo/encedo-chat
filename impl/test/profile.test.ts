/**
 * The sealed software profile: what opens it, what does not, and what a stored
 * blob is allowed to say about itself.
 *
 * Rounds are dropped to something trivial here. The real 1,000,000 exists to
 * cost an attacker time; paying that per assertion would cost only ours, and
 * every property under test is independent of the number.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { seal, unseal, reseal, isSealedProfile, BadPassword, DEFAULT_ITERATIONS } from '../lib/profile.ts'

const ID = JSON.stringify({ handle: 'Lab1', pub: 'AAAA', priv: { kty: 'OKP', d: 'secret-scalar' } })
const FAST = 100

test('a profile opens with its password and yields exactly what went in', async () => {
  const blob = await seal('correct horse', ID, FAST)
  assert.equal(await unseal('correct horse', blob), ID)
})

test('a wrong password is refused as BadPassword, not as a generic failure', async () => {
  // The login screen shows "wrong password" for this and "something broke" for
  // anything else, so the TYPE is the contract, not just the throw.
  const blob = await seal('correct horse', ID, FAST)
  await assert.rejects(() => unseal('correct horde', blob), BadPassword)
})

test('the private key is nowhere in the stored blob', async () => {
  // The whole point: what sits in localStorage used to be readable JSON.
  const blob = await seal('pw', ID, FAST)
  assert.ok(!JSON.stringify(blob).includes('secret-scalar'))
  assert.ok(!JSON.stringify(blob).includes('Lab1'))
})

test('two profiles with the SAME password get different salts and ciphertexts', async () => {
  // Per-profile salt: cracking one password must not open the other, and equal
  // ciphertexts would leak that two profiles share a password.
  const a = await seal('same', ID, FAST)
  const b = await seal('same', ID, FAST)
  assert.notEqual(a.salt, b.salt)
  assert.notEqual(a.ct, b.ct)
})

test('the blob carries its own iteration count, so raising the default is safe', async () => {
  // A profile made today must still open after DEFAULT_ITERATIONS goes up.
  const old = await seal('pw', ID, FAST)
  assert.equal(old.iter, FAST)
  assert.equal(await unseal('pw', old), ID)
})

test('a tampered ciphertext does not open', async () => {
  const blob = await seal('pw', ID, FAST)
  const bytes = Buffer.from(blob.ct, 'base64'); bytes[0] ^= 1
  await assert.rejects(() => unseal('pw', { ...blob, ct: bytes.toString('base64') }), BadPassword)
})

test('an absurd iteration count is refused rather than obeyed', () => {
  // Otherwise a tampered blob is a denial of service that reads as a slow phone.
  assert.equal(isSealedProfile({ v: 1, kdf: 'PBKDF2-SHA256', iter: 1e12, salt: 'a', iv: 'b', ct: 'c' }), false)
  assert.equal(isSealedProfile({ v: 1, kdf: 'PBKDF2-SHA256', iter: 100, salt: 'a', iv: 'b', ct: 'c' }), true)
})

test('anything that is not a sealed profile is rejected before the AEAD', () => {
  for (const bad of [null, {}, { v: 2, kdf: 'PBKDF2-SHA256', iter: 1, salt: '', iv: '', ct: '' },
                     { v: 1, kdf: 'scrypt', iter: 1, salt: '', iv: '', ct: '' }]) {
    assert.equal(isSealedProfile(bad), false)
  }
})

test('changing the password needs the old one and preserves the identity', async () => {
  const blob = await seal('old', ID, FAST)
  const moved = await reseal('old', 'new', blob)
  assert.equal(await unseal('new', moved), ID)
  await assert.rejects(() => unseal('old', moved), BadPassword)
})

test('an empty password is refused at seal time', async () => {
  await assert.rejects(() => seal('', ID, FAST), /needs a password/)
})

test('the shipped default is the one that was agreed', () => {
  assert.equal(DEFAULT_ITERATIONS, 1_000_000)
})
