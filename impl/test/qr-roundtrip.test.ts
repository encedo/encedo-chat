import { test } from 'node:test'
import assert from 'node:assert/strict'
import { qrMatrix } from '../lib/qr.ts'
import jsQR from '../web/src/vendor/jsqr.cjs'

/**
 * Our encoder against the decoder we vendored — the two halves that never met.
 *
 * `lib/qr.ts` writes QR codes and has done since the beginning; reading them
 * was the browser's job until 2026-09-23, when it turned out WebKit has no
 * `BarcodeDetector` and an iPhone therefore could not scan in ANY browser. The
 * decoder now ships with us, so for the first time both halves are ours to
 * test, and they are tested together: an encoder that is subtly wrong and a
 * decoder that is subtly forgiving would each pass alone.
 *
 * No canvas and no browser. jsQR takes RGBA bytes, and a QR code is a grid of
 * black and white squares, so the "image" is built here — which also makes the
 * quiet zone explicit, and the quiet zone is the thing people forget.
 */

/** A matrix as RGBA pixels: `scale` pixels per module, `quiet` modules of margin. */
function render(m: number[][], scale = 4, quiet = 4) {
  const n = m.length
  const side = (n + quiet * 2) * scale
  const px = new Uint8ClampedArray(side * side * 4).fill(255) // white paper
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      if (!m[y][x]) continue
      for (let dy = 0; dy < scale; dy++) {
        for (let dx = 0; dx < scale; dx++) {
          const py = (y + quiet) * scale + dy
          const pxx = (x + quiet) * scale + dx
          const i = (py * side + pxx) * 4
          px[i] = px[i + 1] = px[i + 2] = 0
        }
      }
    }
  }
  return { px, side }
}

const decode = (text: string, scale?: number) => {
  const { px, side } = render(qrMatrix(text), scale)
  return (jsQR as any)(px, side, side, { inversionAttempts: 'dontInvert' })?.data ?? null
}

test('a code we draw is a code the shipped decoder reads', () => {
  const text = 'https://onchato.com/#i=AbCdEf0123456789-_xyz'
  assert.equal(decode(text), text)
})

test('the sizes an invite actually reaches still decode', () => {
  // Measured, not invented: a real `inviteLink` is 109 characters for a short
  // name and 158 for a 40-character one. The range below brackets that and
  // then goes past it, because a longer payload means a denser grid and
  // density is where a decoder gives up first.
  //
  // It stops at 240 for a reason worth writing down: `qrMatrix` refuses
  // anything over 271 bytes ("more than this encoder holds"), so beyond that
  // there is no code to read and the failure would be ours, not the decoder's.
  for (const n of [20, 86, 135, 240]) {
    const text = 'https://onchato.com/#i=' + 'x'.repeat(n)
    assert.equal(decode(text), text, `payload of ${n} chars did not survive`)
  }
})

test('a code drawn small still decodes, because a camera frame is scaled down', () => {
  // The scanner scales frames to ~640px before decoding (QR_DECODE_PX in
  // app.ts), so a module can end up only a few pixels across. Two pixels per
  // module is the honest floor to hold.
  const text = 'https://onchato.com/#i=ShortEnoughToStayCoarse'
  assert.equal(decode(text, 2), text)
})

test('white noise is not a QR code', () => {
  // A decoder that answers something for anything would pass every test above
  // and hand the app garbage from a camera pointed at a wall.
  const side = 200
  const px = new Uint8ClampedArray(side * side * 4)
  let seed = 12345
  for (let i = 0; i < px.length; i += 4) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff
    const v = seed % 256
    px[i] = px[i + 1] = px[i + 2] = v
    px[i + 3] = 255
  }
  assert.equal((jsQR as any)(px, side, side, { inversionAttempts: 'dontInvert' }), null)
})
