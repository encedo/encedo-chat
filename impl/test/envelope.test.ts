import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  encodeEnvelope, decodeEnvelope, envMsg, envTyping, envPresence, envReaction, envFile, envGroupSkdReq, ENVELOPE_V,
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

test('a file manifest past the sender\'s limits, or with a chunk count the size does not give, does not decode', () => {
  const meta = { cid: 'Qm123', name: 'a.bin', size: 10 * 1024 * 1024, mime: 'application/octet-stream', key: 'AAAA', chunk: 4 * 1024 * 1024, chunks: 3, alg: 'A256GCM-chunked-v1' }
  assert.ok(rt(envFile(5, meta)), 'a consistent 10 MiB manifest in 4 MiB chunks decodes')
  assert.ok(rt(envFile(5, { ...meta, size: 0, chunks: 1 })), 'an empty file is one chunk')
  // Receiver-side bounds (7.5): what the sender may not send, the receiver does
  // not accept either - `decryptBytes` would otherwise allocate `size` blind.
  assert.equal(rt(envFile(5, { ...meta, size: 128 * 1024 * 1024 + 1, chunks: 33 })), null, 'a file over 128 MiB')
  assert.equal(rt(envFile(5, { ...meta, chunk: 16 * 1024 * 1024 + 1, chunks: 1 })), null, 'a chunk over 16 MiB')
  assert.equal(rt(envFile(5, { ...meta, chunks: 2 })), null, 'too few chunks for the size')
  assert.equal(rt(envFile(5, { ...meta, chunks: 4 })), null, 'too many chunks for the size')
  assert.equal(rt(envFile(5, { ...meta, size: 10.5 })), null, 'a fractional size')
  assert.equal(rt(envFile(5, { ...meta, exp: 'soon' } as any)), null, 'an expiry that is not a number')
})

test('every envelope carries v / id / ts / seq', () => {
  const d = rt(envMsg(7, 'x'))
  assert.equal(d.v, ENVELOPE_V); assert.equal(typeof d.id, 'string'); assert.equal(typeof d.ts, 'number'); assert.equal(d.seq, 7)
})

test('unknown type decodes (forward-compat); bad shape / version / garbage drop', () => {
  const unknown = decodeEnvelope(te.encode(JSON.stringify({ v: 1, t: 'future', id: 'x', ts: 1, seq: 1, foo: 42 }))) as any
  assert.equal(unknown?.t, 'future') // valid base, unknown type -> carried
  assert.equal(decodeEnvelope(te.encode(JSON.stringify({ v: 1, t: 'msg', id: 'x', ts: 1, seq: 1 }))), null) // msg missing body
  assert.equal(decodeEnvelope(te.encode(JSON.stringify({ v: 2, t: 'msg', id: 'x', ts: 1, seq: 1, body: 'a', format: 'plain' }))), null) // wrong version
  assert.equal(decodeEnvelope(te.encode('nonsense')), null)
  // ik-rotate: the future-feature seam (T13) - a well-formed one is held to its
  // shape, a malformed one is dropped. Nothing dispatches it yet.
  const rot = decodeEnvelope(te.encode(JSON.stringify({ v: 1, t: 'ik-rotate', id: 'x', ts: 1, seq: 1, newPub: 'AAAA', effectiveFrom: 2 }))) as any
  assert.equal(rot?.t, 'ik-rotate'); assert.equal(rot.newPub, 'AAAA')
  assert.equal(decodeEnvelope(te.encode(JSON.stringify({ v: 1, t: 'ik-rotate', id: 'x', ts: 1, seq: 1, newPub: 'AAAA' }))), null) // no effectiveFrom
})

test('full pipe: envelope -> encode -> decode (crypto-agnostic — the Session seals opaque bytes)', async () => {
  const pt = encodeEnvelope(envMsg(9, 'end to end'))
  assert.notEqual(pt, null)
  const d = decodeEnvelope(pt!) as any
  assert.equal(d.body, 'end to end'); assert.equal(d.seq, 9)
})

test('group-skd-req roundtrip; a malformed one drops', () => {
  const d = rt(envGroupSkdReq(11, 'Z2lkYnl0ZXM=', 3))
  assert.equal(d.t, 'group-skd-req'); assert.equal(d.gid, 'Z2lkYnl0ZXM='); assert.equal(d.epoch, 3); assert.equal(d.seq, 11)
  // Both fields are required: a request naming no group, or no epoch, is not a
  // partially useful request — it is one the responder would have to guess at.
  assert.equal(decodeEnvelope(te.encode(JSON.stringify({ v: 1, t: 'group-skd-req', id: 'x', ts: 1, seq: 1 }))), null)
  assert.equal(decodeEnvelope(te.encode(JSON.stringify({ v: 1, t: 'group-skd-req', id: 'x', ts: 1, seq: 1, gid: 'a' }))), null)
})

test('an SKD without ctr still decodes (it means 0); a nonsense ctr does not', () => {
  // Builds before the counter existed sent no ctr, and their SKDs must keep
  // decoding — the field only ever meant "0" for them.
  const base = { v: 1, t: 'group-skd', id: 'x', ts: 1, seq: 1, gid: 'g', gkPub: 'k', epoch: 0, secret: 's', chain: 'c', roster: ['a'] }
  assert.ok(decodeEnvelope(te.encode(JSON.stringify(base))))
  assert.ok(decodeEnvelope(te.encode(JSON.stringify({ ...base, ctr: 7 }))))
  assert.equal(decodeEnvelope(te.encode(JSON.stringify({ ...base, ctr: -1 }))), null)
  assert.equal(decodeEnvelope(te.encode(JSON.stringify({ ...base, ctr: 'x' }))), null)
})

test('an album travels with each file, and a broken one costs the grouping, never the file', () => {
  const meta = { cid: 'Qm123', name: 'a.jpg', size: 10, mime: 'image/jpeg', key: 'AAAA', chunk: 4096, chunks: 1, alg: 'A256GCM-chunked-v1' }
  const album = { id: '0123456789abcdef', i: 1, n: 3 }
  const f = rt(envFile(5, { ...meta, album }))
  assert.deepEqual(f.album, album, 'a well-formed album survives the round trip')
  assert.equal(rt(envFile(5, meta)).album, undefined, 'no album, no field')
  for (const bad of [
    { id: 'short', i: 0, n: 2 }, { id: '0123456789ABCDEF', i: 0, n: 2 }, // not 16 lowercase hex
    { id: '0123456789abcdef', i: 2, n: 2 }, { id: '0123456789abcdef', i: -1, n: 2 }, // outside the album
    { id: '0123456789abcdef', i: 0, n: 1 }, { id: '0123456789abcdef', i: 0, n: 33 }, // one is not an album; too many
    { id: '0123456789abcdef', i: 0.5, n: 2 }, 'album', null,
  ]) {
    const d = rt(envFile(5, { ...meta, album: bad as any }))
    assert.ok(d, `a file with album ${JSON.stringify(bad)} still decodes`)
    assert.equal(d.album, undefined, `and loses the broken album ${JSON.stringify(bad)}`)
    assert.equal(d.name, 'a.jpg')
  }
})

test('a group name in an SKD is at most 64 code points, cut by the sender and again on receipt', async () => {
  const { envGroupSkd, GROUP_NAME_MAX } = await import('../lib/envelope.ts')
  const fields = { gid: 'g', gkPub: 'k', epoch: 0, secret: 's', chain: 'c', roster: ['a'] }
  const long = '🌳'.repeat(70) + 'x'   // astral code points: a UTF-16 slice would split one
  const sent = rt(envGroupSkd(1, { ...fields, name: long }))
  assert.equal([...sent.name].length, GROUP_NAME_MAX)
  assert.equal(sent.name, '🌳'.repeat(64))
  assert.equal(rt(envGroupSkd(1, { ...fields, name: 'Zespół' })).name, 'Zespół', 'a short name is untouched')
  // An older or hostile sender that did not cut it: the receiver does.
  const raw = { v: 1, t: 'group-skd', id: 'x', ts: 1, seq: 1, ...fields }
  const got = decodeEnvelope(te.encode(JSON.stringify({ ...raw, name: 'a'.repeat(500) }))) as any
  assert.equal(got.name.length, 64)
  // A name that is not a string costs the name, never the key distribution.
  const odd = decodeEnvelope(te.encode(JSON.stringify({ ...raw, name: { evil: 1 } }))) as any
  assert.equal(odd?.t, 'group-skd')
  assert.equal('name' in odd, false)
})
