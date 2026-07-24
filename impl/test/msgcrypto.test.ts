import { test } from 'node:test'
import assert from 'node:assert/strict'
import { msgKeyFromSecret, encryptMsg, tryDecryptMsg } from '../lib/msgcrypto.ts'

const P = { networkId: 'main', dateUTC: '2026-07-24' }

test('interim message encrypt/decrypt roundtrip (unicode)', async () => {
  const key = await msgKeyFromSecret(new Uint8Array(32).fill(9), P)
  const ct = await encryptMsg('hello 🌳 spotkanie', key)
  assert.equal(await tryDecryptMsg(ct, key), 'hello 🌳 spotkanie')
})

test('wrong key returns null, never throws', async () => {
  const k1 = await msgKeyFromSecret(new Uint8Array(32).fill(1), P)
  const k2 = await msgKeyFromSecret(new Uint8Array(32).fill(2), P)
  assert.equal(await tryDecryptMsg(await encryptMsg('secret', k1), k2), null)
})

test('non-chat payloads (announce / garbage) return null', async () => {
  const key = await msgKeyFromSecret(new Uint8Array(32).fill(3), P)
  assert.equal(await tryDecryptMsg(new TextEncoder().encode('{"v":1,"peer":"x","mac":"y"}'), key), null)
  assert.equal(await tryDecryptMsg(new TextEncoder().encode('not json at all'), key), null)
})

test('msgKey differs by date (cross-date decrypt fails)', async () => {
  const ss = new Uint8Array(32).fill(7)
  const k1 = await msgKeyFromSecret(ss, { networkId: 'main', dateUTC: '2026-07-24' })
  const k2 = await msgKeyFromSecret(ss, { networkId: 'main', dateUTC: '2026-07-25' })
  assert.equal(await tryDecryptMsg(await encryptMsg('hi', k1), k2), null)
})
