import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { safetyHalf, safetyNumber, safetyGroups, safetyQr, parseSafetyQr, SAFETY_LABEL, SAFETY_ITERATIONS } from '../lib/safety.ts'

const key = (seed: number) => Uint8Array.from({ length: 32 }, (_, i) => (i * 31 + seed * 7 + 1) & 255)
const A = key(1), B = key(2), C = key(3)

/** The same construction written a second time on node:crypto, so the module
 *  is checked against the spec text and not against itself. */
function reference(pub: Uint8Array): string {
  let h = createHash('sha512').update(Buffer.concat([Buffer.from(SAFETY_LABEL), Buffer.from([0]), pub])).digest()
  for (let i = 0; i < SAFETY_ITERATIONS; i++) h = createHash('sha512').update(Buffer.concat([h, pub])).digest()
  let s = ''
  for (let c = 0; c < 6; c++) s += String(Number(h.readBigUInt64BE(c * 5) >> 24n) % 100000).padStart(5, '0')
  return s
}

test('each half is the specified construction, checked against an independent implementation', async () => {
  assert.equal(await safetyHalf(A), reference(A))
  assert.equal(await safetyHalf(B), reference(B))
})

test('a pinned vector: both sides of every build must print exactly this', async () => {
  // Re-record only on purpose: changing it changes every safety number shown.
  assert.equal(await safetyNumber(A, B), '897494180181853560540105217708970786679801027359594318225986')
})

test('both people see the same number; another key gives another', async () => {
  const ab = await safetyNumber(A, B)
  assert.equal(ab, await safetyNumber(B, A), 'the order of the keys must not matter')
  assert.match(ab, /^\d{60}$/)
  assert.notEqual(ab, await safetyNumber(A, C), 'a swapped contact key must change the number')
  assert.notEqual(ab, await safetyNumber(C, B), 'a swapped own key must change the number')
  // Each half belongs to one key: the half of the key that stayed is still there.
  const hA = await safetyHalf(A)
  assert.ok((await safetyNumber(A, C)).includes(hA))
})

test('shown as twelve groups of five', async () => {
  const g = safetyGroups(await safetyNumber(A, B))
  assert.equal(g.length, 12)
  for (const x of g) assert.match(x, /^\d{5}$/)
})

test('the QR payload round-trips; anything else is not a safety code', async () => {
  const n = await safetyNumber(A, B)
  assert.equal(parseSafetyQr(safetyQr(n)), n)
  assert.equal(parseSafetyQr('  ' + safetyQr(n) + '\n'), n, 'whitespace from a scanner is tolerated')
  assert.equal(parseSafetyQr('https://onchato.com/chat#i=abc'), null, 'an invite is not a safety code')
  assert.equal(parseSafetyQr(safetyQr(n).slice(0, -1)), null, 'a truncated number is refused')
  assert.equal(parseSafetyQr('onchato-sn1:' + 'x'.repeat(60)), null)
})

test('a key of the wrong length is refused, not hashed', async () => {
  await assert.rejects(safetyHalf(new Uint8Array(31)), /32 bytes/)
})
