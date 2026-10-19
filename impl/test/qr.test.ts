/**
 * The QR encoder (`lib/qr.ts`).
 *
 * A hand-written encoder does not fail loudly. A wrong ECC table, a transposed
 * format word, a mask written into the wrong modules — each produces something
 * that looks exactly like a QR code and cannot be scanned by anything. So the
 * vectors below were not invented here:
 *
 * - Every one of them was **decoded by an independent decoder** (`jsQR`) back
 *   into the original string, in a scratch checkout on 2026-08-25, before its
 *   hash was written down.
 * - The data, error-correction and module placement were additionally compared
 *   module-for-module against an independent ENCODER (`qrcode-generator`) with
 *   the mask forced to the same value: identical for every case.
 *
 * Neither library is a dependency of this project — they were used once, to
 * check the output, and what remains here is the fingerprint of a verified
 * matrix. That is what these hashes protect: not "the encoder still runs", but
 * "it still emits the exact bits that a real decoder read".
 *
 * The masks are forced in four of the five vectors, so that a change to the
 * penalty scoring shows up in the fifth (mask choice) and not in all of them at
 * once. On mask choice this encoder follows ISO 18004 rather than the older JIS
 * rule that `qrcode-generator` still implements; both produce valid symbols, and
 * that is the one place the two encoders legitimately differ.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { qrMatrix, qrSvg } from '../lib/qr.ts'

const hash = (m: number[][]) => createHash('sha256').update(m.map((r) => r.join('')).join('\n')).digest('hex').slice(0, 16)
const INVITE = 'https://onchato.com/chat#i=eyJwIjoiQndjSEJ3Y0hCd2NIQndjSEJ3Y0hCd2NIQndjSEJ3Y0hCd2NIQndjPSIsIm4iOiJLcnp5c3p0b2YifQ'

test('verified vectors still encode bit for bit', () => {
  const vectors: Array<[string, number | undefined, number, string]> = [
    ['HELLO', 0, 21, 'd51e6b3d78d8b096'],                                   // version 1
    [INVITE, 0, 41, '745f4d69eca89251'],                                    // version 6 — a real invite link
    ['A'.repeat(200), 0, 53, '14a820128e098547'],                           // version 9, two blocks
    ['zażółć gęślą jaźń 🌳', 0, 25, '342d4b18251f6698'],                    // UTF-8, multi-byte and astral
    ['3A:7F:1C:02:9D:BB:41:07', undefined, 25, 'e388db657d26b093'],         // a fingerprint, mask chosen by penalty
    // Versions 11-20 (2026-10-19): decoded by jsQR under all eight masks and equal
    // module for module to qrcode-generator, for the first and last length of every
    // version 9-20, before these hashes were taken.
    ['B'.repeat(300), 0, 61, '2b27b06e208f8527'],                           // version 11, four blocks
    ['C'.repeat(450), 0, 73, '09f13b47615e1ea6'],                           // version 14, two groups, four alignment centres, 3 remainder bits
    ['D'.repeat(858), 0, 97, 'faf7e53f607f2083'],                           // version 20, the largest this encoder holds
  ]
  for (const [text, mask, size, want] of vectors) {
    const m = qrMatrix(text, mask)
    assert.equal(m.length, size, `size for ${text.slice(0, 16)}`)
    assert.equal(hash(m), want, `matrix changed for ${text.slice(0, 16)} — it was decoded by jsQR at this hash`)
  }
})

test('the symbol carries the patterns a scanner looks for', () => {
  const m = qrMatrix(INVITE)
  const n = m.length
  assert.equal((n - 17) % 4, 0)
  // Three finders, and NOT a fourth in the bottom right.
  const finder = (r0: number, c0: number) =>
    m[r0][c0] === 1 && m[r0 + 6][c0 + 6] === 1 && m[r0 + 1][c0 + 1] === 0 && m[r0 + 3][c0 + 3] === 1
  assert.ok(finder(0, 0) && finder(0, n - 7) && finder(n - 7, 0))
  // Timing: alternating, starting dark, in both directions.
  for (let i = 8; i < n - 8; i++) {
    assert.equal(m[6][i], i % 2 === 0 ? 1 : 0, `horizontal timing at ${i}`)
    assert.equal(m[i][6], i % 2 === 0 ? 1 : 0, `vertical timing at ${i}`)
  }
  assert.equal(m[n - 8][8], 1, 'the module that is always dark')
})

test('the version grows with the payload, and stops', () => {
  assert.equal(qrMatrix('x').length, 21)               // 1
  assert.equal(qrMatrix('x'.repeat(30)).length, 25)    // 2
  assert.equal(qrMatrix('x'.repeat(271)).length, 57)   // 10
  assert.equal(qrMatrix('x'.repeat(272)).length, 61)   // 11 - a public invite in another network needs it
  assert.equal(qrMatrix('x'.repeat(858)).length, 97)   // 20 - the last one this encoder holds
  // Refused, not truncated: a QR that silently drops the end of an invite link
  // is a QR that pairs somebody with a broken key.
  assert.throws(() => qrMatrix('x'.repeat(859)), /more than this encoder holds/)
})

test('the SVG has the quiet zone, without which a scanner has nothing to lock onto', () => {
  const svg = qrSvg('HELLO', { size: 180 })
  const n = qrMatrix('HELLO').length
  assert.match(svg, new RegExp(`viewBox="0 0 ${n + 8} ${n + 8}"`))
  assert.match(svg, /width="180" height="180"/)
  assert.match(svg, /<rect[^>]*fill="#fff"/)      // opaque ground: a translucent QR scans in one theme only
  assert.match(svg, /shape-rendering="crispEdges"/)
  assert.ok(svg.includes('<path d="M'))
})

test('a public invite with another network and the longest name still makes a code', async () => {
  // The case that failed on blbx.pl: inbox + invite key + "t" + a 64-character name.
  const { inviteLink, setInviteNetwork, MAX_NAME } = await import('../lib/invite.ts')
  const k = Buffer.from(new Uint8Array(32).fill(7)).toString('base64')
  setInviteNetwork('a-network-id-of-reasonable-length.example')
  try {
    const url = inviteLink('https://chat.example.com', '/', { pub: k, name: 'Ż'.repeat(MAX_NAME), inbox: k, key: k } as any)
    assert.ok(url.length > 271, `the case must be past the old limit to prove anything (${url.length})`)
    assert.doesNotThrow(() => qrMatrix(url))
  } finally { setInviteNetwork('main') }
})
