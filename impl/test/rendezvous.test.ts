import { test } from 'node:test'
import assert from 'node:assert/strict'
import { generateKeyPairSync, diffieHellman } from 'node:crypto'
import { topicFromSecret } from '../lib/rendezvous.ts'
import { hkdfBits } from '../lib/wc.ts'

test('X25519 ECDH is commutative → Alice and Bob derive the same topic', async () => {
  const a = generateKeyPairSync('x25519')
  const b = generateKeyPairSync('x25519')
  const ssA = new Uint8Array(diffieHellman({ privateKey: a.privateKey, publicKey: b.publicKey }))
  const ssB = new Uint8Array(diffieHellman({ privateKey: b.privateKey, publicKey: a.publicKey }))
  assert.deepEqual(ssA, ssB, 'ss must match')

  const p = { networkId: 'main', dateUTC: '2026-07-24' }
  assert.equal(await topicFromSecret(ssA, p), await topicFromSecret(ssB, p), 'topic must match')
})

test('topic: 52-char lowercase base32, deterministic, scoped by network + date', async () => {
  const ss = new Uint8Array(32).fill(7)
  const t = await topicFromSecret(ss, { networkId: 'main', dateUTC: '2026-07-24' })
  assert.match(t, /^[a-z2-7]{52}$/)
  assert.equal(t, await topicFromSecret(ss, { networkId: 'main', dateUTC: '2026-07-24' }), 'deterministic')
  assert.notEqual(t, await topicFromSecret(ss, { networkId: 'other', dateUTC: '2026-07-24' }), 'network-scoped')
  assert.notEqual(t, await topicFromSecret(ss, { networkId: 'main', dateUTC: '2026-07-25' }), 'date-scoped')
})

test('WebCrypto HKDF-SHA256 matches RFC 5869 test vector A.1', async () => {
  const ikm = new Uint8Array(22).fill(0x0b)
  const salt = Uint8Array.from([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12])
  const info = Uint8Array.from([0xf0, 0xf1, 0xf2, 0xf3, 0xf4, 0xf5, 0xf6, 0xf7, 0xf8, 0xf9])
  const okm = await hkdfBits(ikm, salt, info, 42)
  const hex = [...okm].map((b) => b.toString(16).padStart(2, '0')).join('')
  assert.equal(hex, '3cb25f25faacd57a90434f64d0362f2a2d2d0a90cf1a5a4c5db02d56ecc4c5bf34007208d5b887185865')
})
