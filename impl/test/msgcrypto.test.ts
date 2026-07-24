import { test } from 'node:test'
import assert from 'node:assert/strict'
import { msgKeyFromSecret, encryptMsg, tryDecryptMsg } from '../lib/msgcrypto.ts'

const P = { networkId: 'main', dateUTC: '2026-07-24' }

test('interim message encrypt/decrypt roundtrip (unicode)', () => {
  const key = msgKeyFromSecret(Buffer.alloc(32, 9), P)
  const ct = encryptMsg('hello 🌳 spotkanie', key)
  assert.equal(tryDecryptMsg(ct, key), 'hello 🌳 spotkanie')
})

test('wrong key returns null, never throws', () => {
  const k1 = msgKeyFromSecret(Buffer.alloc(32, 1), P)
  const k2 = msgKeyFromSecret(Buffer.alloc(32, 2), P)
  assert.equal(tryDecryptMsg(encryptMsg('secret', k1), k2), null)
})

test('non-chat payloads (announce / garbage) return null', () => {
  const key = msgKeyFromSecret(Buffer.alloc(32, 3), P)
  assert.equal(tryDecryptMsg(new TextEncoder().encode('{"v":1,"peer":"x","mac":"y"}'), key), null)
  assert.equal(tryDecryptMsg(new TextEncoder().encode('not json at all'), key), null)
})

test('msgKey is scoped by network + date', () => {
  const ss = Buffer.alloc(32, 7)
  const a = msgKeyFromSecret(ss, { networkId: 'main', dateUTC: '2026-07-24' })
  const b = msgKeyFromSecret(ss, { networkId: 'main', dateUTC: '2026-07-25' })
  assert.notEqual(a.toString('hex'), b.toString('hex'))
})
