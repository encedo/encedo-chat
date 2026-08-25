/**
 * qr.ts — a QR code for an invite link and for a key fingerprint.
 *
 * ## Why this is ours rather than a dependency
 *
 * Everything bundled here runs in the same context as the identity key, so a
 * package added for a convenience is attack surface bought with somebody else's
 * release process. QR is not cryptography — it is a fully specified encoding
 * with published tables — so writing it costs a few hundred lines once and adds
 * nothing to the supply chain. The rule this project actually holds ("do not
 * invent cryptography") is untouched: there is no secret and no key here.
 *
 * The risk of hand-rolling it is not that it fails loudly; it is a wrong ECC
 * table producing a code that LOOKS like a QR and does not scan. That is what
 * `test/qr.test.ts` is for: the vectors in it come from an independent
 * implementation, and one of them is decoded rather than compared.
 *
 * ## Scope, deliberately small
 *
 * Byte mode, error-correction level L, versions 1–10 (up to 271 bytes) — an
 * invite link is ~130–160 characters and a fingerprint far less. Level L
 * because the payload is short, the code is drawn on a screen rather than
 * printed on a box, and a lower level means a smaller, denser-scanning code.
 * Anything longer than version 10 is refused rather than silently truncated.
 */

/** Total codewords, data codewords, EC codewords per block, and the block split (level L). */
interface VersionSpec {
  /** data codewords available (all blocks together) */
  data: number
  /** EC codewords per block */
  ec: number
  /** [count, dataPerBlock] groups — group 2 is absent when it is not used */
  groups: Array<[number, number]>
  /** centres of the alignment patterns; empty for version 1 */
  align: number[]
  /** bits of padding after the interleaved codewords */
  remainder: number
}

/** Level L, versions 1–10. Verified against an independent encoder — see the test. */
const VERSIONS: VersionSpec[] = [
  { data: 19, ec: 7, groups: [[1, 19]], align: [], remainder: 0 },                      // 1
  { data: 34, ec: 10, groups: [[1, 34]], align: [6, 18], remainder: 7 },                // 2
  { data: 55, ec: 15, groups: [[1, 55]], align: [6, 22], remainder: 7 },                // 3
  { data: 80, ec: 20, groups: [[1, 80]], align: [6, 26], remainder: 7 },                // 4
  { data: 108, ec: 26, groups: [[1, 108]], align: [6, 30], remainder: 7 },              // 5
  { data: 136, ec: 18, groups: [[2, 68]], align: [6, 34], remainder: 7 },               // 6
  { data: 156, ec: 20, groups: [[2, 78]], align: [6, 22, 38], remainder: 0 },           // 7
  { data: 194, ec: 24, groups: [[2, 97]], align: [6, 24, 42], remainder: 0 },           // 8
  { data: 232, ec: 30, groups: [[2, 116]], align: [6, 26, 46], remainder: 0 },          // 9
  { data: 274, ec: 18, groups: [[2, 68], [2, 69]], align: [6, 28, 50], remainder: 0 },  // 10
]

// ---- GF(256) ---------------------------------------------------------------
// The Reed-Solomon field of the QR spec: primitive polynomial 0x11D.
const EXP = new Uint8Array(512)
const LOG = new Uint8Array(256)
{
  let x = 1
  for (let i = 0; i < 255; i++) {
    EXP[i] = x
    LOG[x] = i
    x <<= 1
    if (x & 0x100) x ^= 0x11d
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255]
}
const mul = (a: number, b: number) => (a === 0 || b === 0 ? 0 : EXP[LOG[a] + LOG[b]])

/** Generator polynomial for `n` EC codewords: ∏ (x - α^i). */
function generator(n: number): Uint8Array {
  let g = new Uint8Array([1])
  for (let i = 0; i < n; i++) {
    const next = new Uint8Array(g.length + 1)
    for (let j = 0; j < g.length; j++) {
      next[j] ^= g[j]
      next[j + 1] ^= mul(g[j], EXP[i])
    }
    g = next
  }
  return g
}

/** The EC codewords for one block. */
function ecBlock(data: Uint8Array, ecLen: number): Uint8Array {
  const g = generator(ecLen)
  const rem = new Uint8Array(data.length + ecLen)
  rem.set(data)
  for (let i = 0; i < data.length; i++) {
    const factor = rem[i]
    if (factor === 0) continue
    for (let j = 0; j < g.length; j++) rem[i + j] ^= mul(g[j], factor)
  }
  return rem.slice(data.length)
}

// ---- bit stream ------------------------------------------------------------
class Bits {
  readonly out: number[] = []
  push(value: number, len: number) {
    for (let i = len - 1; i >= 0; i--) this.out.push((value >>> i) & 1)
  }
  get length() { return this.out.length }
}

/** The smallest version that holds `len` bytes, or 0 when nothing here does. */
function pickVersion(len: number): number {
  for (let v = 1; v <= VERSIONS.length; v++) {
    const spec = VERSIONS[v - 1]
    const countBits = v < 10 ? 8 : 16
    if (4 + countBits + len * 8 <= spec.data * 8) return v
  }
  return 0
}

// ---- matrix ----------------------------------------------------------------
/** -1 = free, 0/1 = module, 2/3 = reserved (function pattern) written as 0/1. */
type Grid = Int8Array[]

const newGrid = (size: number): Grid =>
  Array.from({ length: size }, () => new Int8Array(size).fill(-1))

function placeFinder(g: Grid, row: number, col: number) {
  for (let r = -1; r <= 7; r++) {
    for (let c = -1; c <= 7; c++) {
      const rr = row + r, cc = col + c
      if (rr < 0 || cc < 0 || rr >= g.length || cc >= g.length) continue
      const inner = r >= 0 && r <= 6 && c >= 0 && c <= 6
        && (r === 0 || r === 6 || c === 0 || c === 6 || (r >= 2 && r <= 4 && c >= 2 && c <= 4))
      g[rr][cc] = inner ? 1 : 0
    }
  }
}

function functionPatterns(version: number): { grid: Grid; reserved: boolean[][] } {
  const size = version * 4 + 17
  const grid = newGrid(size)
  const reserved = Array.from({ length: size }, () => new Array<boolean>(size).fill(false))
  const mark = (r: number, c: number) => { if (r >= 0 && c >= 0 && r < size && c < size) reserved[r][c] = true }

  placeFinder(grid, 0, 0); placeFinder(grid, 0, size - 7); placeFinder(grid, size - 7, 0)
  for (const [r0, c0] of [[0, 0], [0, size - 8], [size - 8, 0]] as const) {
    for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) mark(r0 + r, c0 + c)
  }

  // timing
  for (let i = 8; i < size - 8; i++) {
    grid[6][i] = i % 2 === 0 ? 1 : 0; reserved[6][i] = true
    grid[i][6] = i % 2 === 0 ? 1 : 0; reserved[i][6] = true
  }

  // alignment: every pair of centres except the three that collide with finders
  const centres = VERSIONS[version - 1].align
  for (const r of centres) {
    for (const c of centres) {
      if ((r === 6 && c === 6) || (r === 6 && c === size - 7) || (r === size - 7 && c === 6)) continue
      for (let dr = -2; dr <= 2; dr++) {
        for (let dc = -2; dc <= 2; dc++) {
          grid[r + dr][c + dc] = Math.max(Math.abs(dr), Math.abs(dc)) === 1 ? 0 : 1
          reserved[r + dr][c + dc] = true
        }
      }
    }
  }

  // the module that is always dark
  grid[size - 8][8] = 1; reserved[size - 8][8] = true
  // format information areas
  for (let i = 0; i < 9; i++) { mark(8, i); mark(i, 8) }
  for (let i = 0; i < 8; i++) { mark(8, size - 1 - i); mark(size - 1 - i, 8) }
  // version information (7 and up)
  if (version >= 7) {
    for (let i = 0; i < 6; i++) for (let j = 0; j < 3; j++) { mark(i, size - 11 + j); mark(size - 11 + j, i) }
  }
  return { grid, reserved }
}

/** Zig-zag placement, right to left, skipping the timing column. */
function placeData(grid: Grid, reserved: boolean[][], bits: number[]) {
  const size = grid.length
  let i = 0, upward = true
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5 // the vertical timing pattern is not a data column
    for (let step = 0; step < size; step++) {
      const row = upward ? size - 1 - step : step
      for (const col of [right, right - 1]) {
        if (reserved[row][col]) continue
        grid[row][col] = i < bits.length ? (bits[i] as 0 | 1) : 0
        i++
      }
    }
    upward = !upward
  }
}

const MASKS: Array<(r: number, c: number) => boolean> = [
  (r, c) => (r + c) % 2 === 0,
  (r) => r % 2 === 0,
  (_r, c) => c % 3 === 0,
  (r, c) => (r + c) % 3 === 0,
  (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
  (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0,
  (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0,
  (r, c) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0,
]

/** The spec's four penalty rules — lower is better. */
function penalty(g: Grid): number {
  const n = g.length
  let score = 0
  const line = (get: (i: number, j: number) => number) => {
    for (let i = 0; i < n; i++) {
      let run = 1
      for (let j = 1; j < n; j++) {
        if (get(i, j) === get(i, j - 1)) { run++; continue }
        if (run >= 5) score += run - 2
        run = 1
      }
      if (run >= 5) score += run - 2
    }
  }
  line((i, j) => g[i][j]); line((i, j) => g[j][i])

  for (let r = 0; r < n - 1; r++) {
    for (let c = 0; c < n - 1; c++) {
      const v = g[r][c]
      if (v === g[r][c + 1] && v === g[r + 1][c] && v === g[r + 1][c + 1]) score += 3
    }
  }

  // Rule 3: the 1:1:3:1:1 ratio of a finder, with four light modules on one
  // side. The line is padded with light on both ends because the world outside
  // the symbol IS light — leaving that out under-counts patterns at the edges
  // and picks a different mask than every other encoder.
  const A = [1, 0, 1, 1, 1, 0, 1, 0, 0, 0, 0]
  const B = [0, 0, 0, 0, 1, 0, 1, 1, 1, 0, 1]
  const scanLine = (line: number[]) => {
    const padded = [0, 0, 0, 0, ...line, 0, 0, 0, 0]
    for (let j = 0; j + 11 <= padded.length; j++) {
      if (A.every((v, k) => padded[j + k] === v)) score += 40
      if (B.every((v, k) => padded[j + k] === v)) score += 40
    }
  }
  for (let i = 0; i < n; i++) {
    scanLine(Array.from(g[i]))
    scanLine(Array.from({ length: n }, (_, k) => g[k][i]))
  }

  let dark = 0
  for (const row of g) for (const v of row) dark += v
  const ratio = (dark * 100) / (n * n)
  score += Math.floor(Math.abs(ratio - 50) / 5) * 10
  return score
}

/** BCH(15,5) for the format information, level L = 01. */
function formatBits(mask: number): number {
  const data = (0b01 << 3) | mask
  let rem = data << 10
  for (let i = 4; i >= 0; i--) if ((rem >>> (i + 10)) & 1) rem ^= 0b10100110111 << i
  return ((data << 10) | rem) ^ 0b101010000010010
}

/** BCH(18,6) for the version information (versions 7 and up). */
function versionBits(version: number): number {
  let rem = version << 12
  for (let i = 5; i >= 0; i--) if ((rem >>> (i + 12)) & 1) rem ^= 0b1111100100101 << i
  return (version << 12) | rem
}

/**
 * Encode `text` as a QR matrix: `out[row][col]`, 1 = dark.
 * Throws when the text does not fit version 10 at level L (271 bytes).
 */
export function qrMatrix(text: string, forceMask?: number): number[][] {
  const data = new TextEncoder().encode(text)
  const version = pickVersion(data.length)
  if (!version) throw new Error(`QR: ${data.length} bytes is more than this encoder holds (max 271)`)
  const spec = VERSIONS[version - 1]

  // 1. bit stream: mode, length, payload, terminator, padding
  const bits = new Bits()
  bits.push(0b0100, 4)
  bits.push(data.length, version < 10 ? 8 : 16)
  for (const b of data) bits.push(b, 8)
  const capacity = spec.data * 8
  bits.push(0, Math.min(4, capacity - bits.length))
  while (bits.length % 8 !== 0) bits.push(0, 1)
  const codewords: number[] = []
  for (let i = 0; i < bits.length; i += 8) {
    let v = 0
    for (let j = 0; j < 8; j++) v = (v << 1) | bits.out[i + j]
    codewords.push(v)
  }
  for (let pad = 0; codewords.length < spec.data; pad++) codewords.push(pad % 2 === 0 ? 0xec : 0x11)

  // 2. split into blocks, Reed-Solomon each, interleave
  const dataBlocks: Uint8Array[] = []
  const ecBlocks: Uint8Array[] = []
  let at = 0
  for (const [count, size] of spec.groups) {
    for (let b = 0; b < count; b++) {
      const block = Uint8Array.from(codewords.slice(at, at + size)); at += size
      dataBlocks.push(block)
      ecBlocks.push(ecBlock(block, spec.ec))
    }
  }
  const stream: number[] = []
  const widest = Math.max(...dataBlocks.map((b) => b.length))
  for (let i = 0; i < widest; i++) for (const b of dataBlocks) if (i < b.length) stream.push(b[i])
  for (let i = 0; i < spec.ec; i++) for (const b of ecBlocks) stream.push(b[i])
  const finalBits: number[] = []
  for (const cw of stream) for (let i = 7; i >= 0; i--) finalBits.push((cw >>> i) & 1)
  for (let i = 0; i < spec.remainder; i++) finalBits.push(0)

  // 3. draw, mask, and pick the mask the spec's penalties like best
  const { grid: base, reserved } = functionPatterns(version)
  let best: { grid: Grid; mask: number; score: number } | null = null
  for (let mask = forceMask ?? 0; mask <= (forceMask ?? 7); mask++) {
    const grid = base.map((row) => Int8Array.from(row))
    placeData(grid, reserved, finalBits)
    const fn = MASKS[mask]
    for (let r = 0; r < grid.length; r++) {
      for (let c = 0; c < grid.length; c++) {
        if (!reserved[r][c] && fn(r, c)) grid[r][c] ^= 1
      }
    }
    writeFormat(grid, mask)
    if (version >= 7) writeVersion(grid, version)
    const score = penalty(grid)
    if (!best || score < best.score) best = { grid, mask, score }
  }
  return best!.grid.map((row) => Array.from(row, (v) => (v === 1 ? 1 : 0)))
}

function writeFormat(g: Grid, mask: number) {
  const size = g.length
  const bits = formatBits(mask)
  const bit = (i: number) => (bits >>> i) & 1
  // Column 8 and row 8, in that order — the spec numbers these modules by
  // (x, y), and writing them as (row, col) transposes the whole word: the code
  // still draws, and no scanner can read the mask out of it.
  for (let i = 0; i <= 5; i++) g[i][8] = bit(i)
  g[7][8] = bit(6); g[8][8] = bit(7); g[8][7] = bit(8)
  for (let i = 9; i <= 14; i++) g[8][14 - i] = bit(i)
  for (let i = 0; i <= 7; i++) g[8][size - 1 - i] = bit(i)
  for (let i = 8; i <= 14; i++) g[size - 15 + i][8] = bit(i)
  g[size - 8][8] = 1 // always dark
}

function writeVersion(g: Grid, version: number) {
  const size = g.length
  const bits = versionBits(version)
  for (let i = 0; i < 18; i++) {
    const b = (bits >>> i) & 1
    const r = Math.floor(i / 3), c = i % 3
    g[r][size - 11 + c] = b
    g[size - 11 + c][r] = b
  }
}

/**
 * The matrix as an SVG string, with the quiet zone the spec requires (4 modules
 * — without it a scanner has nothing to lock onto, which is the usual reason a
 * hand-made QR "does not work" on one phone and does on another).
 *
 * Colours come from the caller so the code can be drawn in the app's palette;
 * both are opaque on purpose, because a QR on a translucent background is a QR
 * that scans in one theme and not the other.
 */
export function qrSvg(text: string, opts: { size?: number; dark?: string; light?: string } = {}): string {
  const m = qrMatrix(text)
  const quiet = 4
  const n = m.length + quiet * 2
  const dark = opts.dark ?? '#000'
  const light = opts.light ?? '#fff'
  let path = ''
  for (let r = 0; r < m.length; r++) {
    for (let c = 0; c < m.length; c++) {
      if (m[r][c]) path += `M${c + quiet} ${r + quiet}h1v1h-1z`
    }
  }
  const px = opts.size ?? 200
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${n} ${n}" width="${px}" height="${px}" shape-rendering="crispEdges">`
    + `<rect width="${n}" height="${n}" fill="${light}"/><path d="${path}" fill="${dark}"/></svg>`
}
