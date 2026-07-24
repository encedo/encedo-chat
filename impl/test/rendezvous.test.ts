import { test } from 'node:test'
import assert from 'node:assert/strict'
import { generateKeyPairSync, diffieHellman, hkdfSync } from 'node:crypto'
import { topicFromSecret } from '../lib/rendezvous.ts'

test('X25519 ECDH is commutative → Alice and Bob derive the same topic', () => {
  const a = generateKeyPairSync('x25519')  // "Alice" (here software; in the real test her HEM)
  const b = generateKeyPairSync('x25519')  // "Bob"
  const ssA = diffieHellman({ privateKey: a.privateKey, publicKey: b.publicKey })
  const ssB = diffieHellman({ privateKey: b.privateKey, publicKey: a.publicKey })
  assert.deepEqual(new Uint8Array(ssA), new Uint8Array(ssB), 'ss must match')

  const p = { networkId: 'main', dateUTC: '2026-07-24' }
  assert.equal(topicFromSecret(ssA, p), topicFromSecret(ssB, p), 'topic must match')
})

test('topic: 52-char lowercase base32, deterministic, scoped by network + date', () => {
  const ss = Buffer.alloc(32, 7)
  const t = topicFromSecret(ss, { networkId: 'main', dateUTC: '2026-07-24' })
  assert.match(t, /^[a-z2-7]{52}$/)
  assert.equal(t, topicFromSecret(ss, { networkId: 'main', dateUTC: '2026-07-24' }), 'deterministic')
  assert.notEqual(t, topicFromSecret(ss, { networkId: 'other', dateUTC: '2026-07-24' }), 'network-scoped')
  assert.notEqual(t, topicFromSecret(ss, { networkId: 'main', dateUTC: '2026-07-25' }), 'date-scoped (rotation)')
})

test('HKDF-SHA256 arg order matches RFC 5869 test vector A.1', () => {
  // Guards against the classic salt/info swap in hkdfSync(digest, ikm, salt, info, len).
  const ikm  = Buffer.alloc(22, 0x0b)
  const salt = Buffer.from('000102030405060708090a0b0c', 'hex')
  const info = Buffer.from('f0f1f2f3f4f5f6f7f8f9', 'hex')
  const okm  = Buffer.from(hkdfSync('sha256', ikm, salt, info, 42)).toString('hex')
  assert.equal(okm,
    '3cb25f25faacd57a90434f64d0362f2a2d2d0a90cf1a5a4c5db02d56ecc4c5bf34007208d5b887185865')
})
