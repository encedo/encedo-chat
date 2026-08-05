import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  encodeEnvelope, decodeEnvelope, envMsg, envTyping, envPresence, envReaction, envFile, ENVELOPE_V,
} from '../lib/envelope.ts'

const te = new TextEncoder()
const rt = (e: any) => decodeEnvelope(encodeEnvelope(e)) as any

test('msg roundtrip preserves unicode body + format + seq', () => {
  const d = rt(envMsg(1, 'cześć 🌳'))
  assert.equal(d.t, 'msg'); assert.equal(d.body, 'cześć 🌳'); assert.equal(d.format, 'plain'); assert.equal(d.seq, 1)
})

test('typing / presence / reaction / file roundtrip', () => {
  assert.equal(rt(envTyping(2, 'start')).state, 'start')
  assert.equal(rt(envPresence(3, 'away')).state, 'away')
  const r = rt(envReaction(4, 'abc', '👍')); assert.equal(r.to, 'abc'); assert.equal(r.emoji, '👍')
  // A file envelope carries everything needed to decrypt what it points at: the
  // single-use key, the chunking, the algorithm. All of it is REQUIRED — an
  // envelope missing any of it describes a blob nobody can open, and accepting
  // it would put a permanently broken bubble in the transcript.
  const meta = { cid: 'Qm123', name: 'a.txt', size: 10, mime: 'text/plain', key: 'AAAA', chunk: 4096, chunks: 1, alg: 'A256GCM-chunked-v1' }
  const f = rt(envFile(5, meta)); assert.equal(f.name, 'a.txt'); assert.equal(f.size, 10)
  assert.equal(f.chunks, 1); assert.equal(f.key, 'AAAA')
  for (const missing of ['key', 'chunk', 'chunks', 'alg']) {
    const bad: any = { ...meta }; delete bad[missing]
    assert.equal(rt(envFile(5, bad) as any), null, `a file envelope without ${missing} must not decode`)
  }
})

test('every envelope carries v / id / ts / seq', () => {
  const d = rt(envMsg(7, 'x'))
  assert.equal(d.v, ENVELOPE_V); assert.equal(typeof d.id, 'string'); assert.equal(typeof d.ts, 'number'); assert.equal(d.seq, 7)
})

test('unknown type decodes (forward-compat); bad shape / version / garbage drop', () => {
  const unknown = decodeEnvelope(te.encode(JSON.stringify({ v: 1, t: 'future', id: 'x', ts: 1, seq: 1, foo: 42 }))) as any
  assert.equal(unknown?.t, 'future') // valid base, unknown type → carried
  assert.equal(decodeEnvelope(te.encode(JSON.stringify({ v: 1, t: 'msg', id: 'x', ts: 1, seq: 1 }))), null) // msg missing body
  assert.equal(decodeEnvelope(te.encode(JSON.stringify({ v: 2, t: 'msg', id: 'x', ts: 1, seq: 1, body: 'a', format: 'plain' }))), null) // wrong version
  assert.equal(decodeEnvelope(te.encode('nonsense')), null)
})

test('full pipe: envelope → encode → decode (crypto-agnostic — the Session seals opaque bytes)', async () => {
  const pt = encodeEnvelope(envMsg(9, 'end to end'))
  assert.notEqual(pt, null)
  const d = decodeEnvelope(pt!) as any
  assert.equal(d.body, 'end to end'); assert.equal(d.seq, 9)
})
