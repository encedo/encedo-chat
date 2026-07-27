import { test } from 'node:test'
import assert from 'node:assert/strict'
import { msgKeyFromSecret, seal, open } from '../lib/msgcrypto.ts'

const P = { networkId: 'main', dateUTC: '2026-07-24' }
const te = new TextEncoder()
const td = new TextDecoder()
const openStr = async (box: Uint8Array, key: CryptoKey) => { const o = await open(box, key); return o === null ? null : td.decode(o) }

test('interim seal/open roundtrip over bytes (unicode)', async () => {
  const key = await msgKeyFromSecret(new Uint8Array(32).fill(9), P)
  const box = await seal(te.encode('hello 🌳 spotkanie'), key)
  assert.equal(await openStr(box, key), 'hello 🌳 spotkanie')
})

test('wrong key returns null, never throws', async () => {
  const k1 = await msgKeyFromSecret(new Uint8Array(32).fill(1), P)
  const k2 = await msgKeyFromSecret(new Uint8Array(32).fill(2), P)
  assert.equal(await open(await seal(te.encode('secret'), k1), k2), null)
})

test('non-sealed payloads (announce / garbage) return null', async () => {
  const key = await msgKeyFromSecret(new Uint8Array(32).fill(3), P)
  assert.equal(await open(te.encode('{"v":1,"peer":"x","mac":"y"}'), key), null)
  assert.equal(await open(te.encode('not json at all'), key), null)
})

test('msgKey differs by date (cross-date open fails)', async () => {
  const ss = new Uint8Array(32).fill(7)
  const k1 = await msgKeyFromSecret(ss, { networkId: 'main', dateUTC: '2026-07-24' })
  const k2 = await msgKeyFromSecret(ss, { networkId: 'main', dateUTC: '2026-07-25' })
  assert.equal(await open(await seal(te.encode('hi'), k1), k2), null)
})
