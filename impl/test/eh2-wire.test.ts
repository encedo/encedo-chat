/**
 * EH-2 stage 1 — wire format + transcript (docs/PROTOCOL.md §6.1–6.2).
 *
 * What matters here is CANONICALITY: the same frame must always produce the
 * same bytes (h1 hashes those bytes -> SK depends on them), and anything that is
 * not exactly a well-formed frame must be rejected rather than half-parsed.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  EH2_VERSION, T_MSG1, T_MSG2, T_MSG3, MLKEM768_PK, MLKEM768_CT, WireError,
  encodeMsg1, decodeMsg1, encodeMsg2, decodeMsg2, encodeMsg3, decodeMsg3,
  h1, h2Partial, h3,
} from '../eh2/wire.ts'
import { sha256 } from '../lib/wc.ts'

/** Deterministic filler — no randomness, so failures reproduce exactly. */
const pat = (len: number, seed: number) => Uint8Array.from({ length: len }, (_, i) => (i * 31 + seed) & 0xff)

const M1 = { ekPub: pat(32, 1), pqPub: pat(MLKEM768_PK, 2), ts: 1_784_000_000_000, initiatorTag: pat(32, 3) }
const M2 = { ekPub: pat(32, 4), pqCt: pat(MLKEM768_CT, 5), ts: 1_784_000_001_000, macR: pat(32, 6) }
const M3 = { macI: pat(32, 7) }

test('msg1/2/3 roundtrip', async () => {
  assert.deepEqual(decodeMsg1(encodeMsg1(M1)), M1)
  assert.deepEqual(decodeMsg2(encodeMsg2(M2)), M2)
  assert.deepEqual(decodeMsg3(encodeMsg3(M3)), M3)
})

test('frames carry their type tag and version', () => {
  assert.deepEqual(encodeMsg1(M1).slice(0, 2), new Uint8Array([T_MSG1, EH2_VERSION]))
  assert.deepEqual(encodeMsg2(M2).slice(0, 2), new Uint8Array([T_MSG2, EH2_VERSION]))
  assert.deepEqual(encodeMsg3(M3).slice(0, 2), new Uint8Array([T_MSG3, EH2_VERSION]))
})

test('encoding is deterministic and canonical (re-encode is byte-identical)', () => {
  for (const [enc, dec, m] of [
    [encodeMsg1, decodeMsg1, M1], [encodeMsg2, decodeMsg2, M2], [encodeMsg3, decodeMsg3, M3],
  ] as const) {
    const a = (enc as any)(m), b = (enc as any)(m)
    assert.deepEqual(a, b, 'same input → same bytes')
    assert.deepEqual((enc as any)((dec as any)(a)), a, 'decode→encode is a fixpoint')
  }
})

test('sizes are exactly as the spec prescribes', () => {
  assert.equal(encodeMsg1(M1).length, 2 + 32 + 2 + MLKEM768_PK + 8 + 32)
  assert.equal(encodeMsg2(M2).length, 2 + 32 + 2 + MLKEM768_CT + 8 + 32)
  assert.equal(encodeMsg3(M3).length, 2 + 32)
})

test('decode rejects wrong type, wrong version, truncation and trailing bytes', () => {
  const b = encodeMsg1(M1)
  assert.throws(() => decodeMsg2(b), WireError, 'msg1 bytes are not a msg2')
  const badVer = b.slice(); badVer[1] = EH2_VERSION + 1
  assert.throws(() => decodeMsg1(badVer), /unsupported version/)
  assert.throws(() => decodeMsg1(b.slice(0, b.length - 1)), /truncated/)
  const extra = new Uint8Array(b.length + 1); extra.set(b)
  assert.throws(() => decodeMsg1(extra), /trailing/)
  assert.throws(() => decodeMsg1(new Uint8Array(0)), /truncated header/)
})

test('decode rejects a wrong ML-KEM parameter set (length field)', () => {
  const b = encodeMsg2(M2)
  const bad = b.slice()
  bad[34] = 0x00; bad[35] = 0x10 // claim a 4096 B ciphertext
  assert.throws(() => decodeMsg2(bad), /ML-KEM-768/)
})

test('encode rejects wrong field widths', () => {
  assert.throws(() => encodeMsg1({ ...M1, ekPub: pat(31, 1) }), /must be 32 B/)
  assert.throws(() => encodeMsg1({ ...M1, pqPub: pat(1183, 2) }), /must be 1184 B/)
  assert.throws(() => encodeMsg1({ ...M1, initiatorTag: pat(8, 3) }), /must be 32 B/)
  assert.throws(() => encodeMsg2({ ...M2, macR: pat(16, 6) }), /must be 32 B/)
  assert.throws(() => encodeMsg1({ ...M1, ts: -1 }), /non-negative/)
  assert.throws(() => encodeMsg1({ ...M1, ts: 1.5 }), /safe integer/)
})

test('h1 is stable and covers every msg1 field', async () => {
  const base = await h1(encodeMsg1(M1))
  assert.equal(base.length, 32)
  assert.deepEqual(await h1(encodeMsg1(M1)), base)
  assert.deepEqual(base, await sha256(encodeMsg1(M1)), 'h1 == SHA-256(serialize(msg1))')
  for (const variant of [
    { ...M1, ekPub: pat(32, 9) },
    { ...M1, pqPub: pat(MLKEM768_PK, 9) },
    { ...M1, ts: M1.ts + 1 },
    { ...M1, initiatorTag: pat(32, 9) },
  ]) {
    assert.notDeepEqual(await h1(encodeMsg1(variant)), base)
  }
})

test('h2_partial covers msg1, EK_r, ct and ts_r — and excludes mac_r', async () => {
  const m1b = encodeMsg1(M1)
  const base = await h2Partial(m1b, M2.ekPub, M2.pqCt, M2.ts)
  assert.equal(base.length, 32)
  assert.deepEqual(await h2Partial(m1b, M2.ekPub, M2.pqCt, M2.ts), base, 'deterministic')
  assert.notDeepEqual(await h2Partial(m1b, pat(32, 9), M2.pqCt, M2.ts), base)
  assert.notDeepEqual(await h2Partial(m1b, M2.ekPub, pat(MLKEM768_CT, 9), M2.ts), base)
  assert.notDeepEqual(await h2Partial(m1b, M2.ekPub, M2.pqCt, M2.ts + 1), base)
  assert.notDeepEqual(await h2Partial(encodeMsg1({ ...M1, ts: M1.ts + 1 }), M2.ekPub, M2.pqCt, M2.ts), base)
  // mac_r is not an input — it is what h2_partial authenticates.
  assert.deepEqual(await h2Partial(m1b, M2.ekPub, M2.pqCt, M2.ts), base)
})

test('h3 chains h2_partial with mac_r', async () => {
  const h2 = await h2Partial(encodeMsg1(M1), M2.ekPub, M2.pqCt, M2.ts)
  const base = await h3(h2, M2.macR)
  assert.equal(base.length, 32)
  assert.deepEqual(await h3(h2, M2.macR), base)
  assert.notDeepEqual(await h3(h2, pat(32, 9)), base, 'a different mac_r → different h3')
  assert.notDeepEqual(await h3(pat(32, 9), M2.macR), base, 'a different h2_partial → different h3')
  assert.throws(() => h3(pat(31, 1), M2.macR), /must be 32 B/)
})

test('msg1 is 1260 B, and the old frame with an 8-byte SHA-256(IK) hint is refused', () => {
  const b = encodeMsg1(M1)
  assert.equal(b.length, 1260, 'type, ver, EK_i, len, pq_pub, ts, initiator_tag(32)')
  // The pre-2026-10-12 msg1 ended in initiator_id = SHA-256(IK_i)[0:8]: 1236 B.
  // No legacy is kept before 1.0 - a frame parses exactly or not at all.
  const old = b.slice(0, b.length - 24)
  assert.equal(old.length, 1236)
  assert.throws(() => decodeMsg1(old), WireError)
})
