import { test } from 'node:test'
import assert from 'node:assert/strict'
import { interimSession, eh2Session } from '../lib/session.ts'
import { encodeEnvelope, decodeEnvelope, envMsg } from '../lib/envelope.ts'

const P = { networkId: 'main', dateUTC: '2026-07-27' }

test('interim session: envelope encrypt/decrypt roundtrip through the seam', async () => {
  const s = await interimSession(new Uint8Array(32).fill(4), P)
  const box = await s.encrypt(encodeEnvelope(envMsg(1, 'przez seam')))
  const pt = await s.decrypt(box)
  assert.notEqual(pt, null)
  assert.equal((decodeEnvelope(pt!) as any).body, 'przez seam')
})

test('interim session: cross-secret decrypt returns null', async () => {
  const a = await interimSession(new Uint8Array(32).fill(1), P)
  const b = await interimSession(new Uint8Array(32).fill(2), P)
  assert.equal(await b.decrypt(await a.encrypt(new Uint8Array([1, 2, 3]))), null)
})

test('eh2 session is a held stub (throws until the design is blessed)', () => {
  assert.throws(() => eh2Session(), /EH-2 not implemented/)
})
