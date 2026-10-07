import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { qrBlocks, qrForTerminal } from '../cli/termqr.ts'
import { qrMatrix } from '../lib/qr.ts'

const jsQR = (createRequire(import.meta.url)('../web/src/vendor/jsqr.cjs') as any)
const decode = (jsQR.default ?? jsQR) as (d: Uint8ClampedArray, w: number, h: number) => { data: string } | null

/** The terminal text back into pixels: each character is one module wide and two tall. */
function raster(lines: string[], scale = 6) {
  const cols = [...lines[0]].length, rows = lines.length * 2
  const w = cols * scale, h = rows * scale
  const px = new Uint8ClampedArray(w * h * 4).fill(255)
  lines.forEach((line, li) => [...line].forEach((ch, c) => {
    const top = ch === '█' || ch === '▀', bottom = ch === '█' || ch === '▄'
    for (const [dark, r] of [[top, li * 2], [bottom, li * 2 + 1]] as const) {
      if (!dark) continue
      for (let y = r * scale; y < (r + 1) * scale; y++) for (let x = c * scale; x < (c + 1) * scale; x++) {
        const i = (y * w + x) * 4; px[i] = px[i + 1] = px[i + 2] = 0
      }
    }
  }))
  return { px, w, h }
}

test('the terminal QR decodes back to exactly what it encodes', () => {
  for (const text of [
    'https://app.onchato.com/#i=eyJwIjoiblJOT3ZwcWRBNlIxL1VySkpKZUFKOEY5QStKOVppa3BVTlhHSW5LZE1IRT0iLCJuIjoiYWxhIn0',
    'onchato-sn1:' + '0123456789'.repeat(6),
  ]) {
    const { px, w, h } = raster(qrBlocks(text))
    assert.equal(decode(px, w, h)?.data, text)
  }
})

test('half blocks carry every module: two rows per line, a quiet zone all round', () => {
  const text = 'HELLO'
  const m = qrMatrix(text), lines = qrBlocks(text)
  assert.equal([...lines[0]].length, m.length + 4, 'two quiet modules each side')
  assert.equal(lines.length, Math.ceil((m.length + 4) / 2))
  assert.equal(lines[0].trim(), '', 'the first line is quiet zone only')
  // A wrong mapping (here: top and bottom swapped) must not decode to the same text.
  const swapped = lines.map((l) => [...l].map((ch) => ch === '▀' ? '▄' : ch === '▄' ? '▀' : ch).join(''))
  const { px, w, h } = raster(swapped)
  assert.notEqual(decode(px, w, h)?.data, text)
})

test('the printed form forces dark-on-light, so a dark terminal theme cannot invert it', () => {
  const out = qrForTerminal('HELLO').split('\n')
  for (const l of out) { assert.ok(l.startsWith('\x1b[30;47m')); assert.ok(l.endsWith('\x1b[0m')) }
})
