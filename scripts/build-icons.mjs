/**
 * build-icons.mjs - the whole onchato icon set, from one geometry.
 *
 * Spec: docs/icon-spec.md. Nothing here is drawn by hand: the two paths
 * below are the only geometry in the project, every SVG is generated from
 * them, and every PNG is rasterised from a generated SVG. `make icons`
 * rebuilds the lot from nothing.
 *
 * The order matters: SVG sources -> svgo (with a pixel check that geometry did
 * not move) -> raster -> ico -> preview -> acceptance report.
 */

import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'
import { optimize } from 'svgo'
import pngToIco from 'png-to-ico'
import opentype from 'opentype.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const OUT = join(ROOT, 'assets', 'icon')
const dirs = ['src', 'web', 'android', 'ios', 'lockup', 'preview']

// ---- the whole design ------------------------------------------------------

/**
 * The mark: two vertical strokes. The left one is broken (a mouth, speaking),
 * the right one bends inward once (an ear, listening). Coordinates are the
 * spec's, in a 100x100 space, and they are not to be adjusted - the gap and the
 * depth of the ear are the design.
 */
const MASTER = {
  width: 8,
  paths: ['M36 14V44', 'M36 62V92', 'M64 14V38C52 44 52 62 64 68V92'],
}
/** For 16 and 32 px. NOT the master scaled down: a thinner stroke and a wider
 *  gap are what keep the two readable when a pixel is a whole unit. */
const SMALL = {
  width: 10,
  paths: ['M36 12V40', 'M36 66V94', 'M64 12V36C50 42 50 64 64 70V94'],
}

const COLORS = {
  // Not #000000: pure black bands on OLED when the background animates.
  black: '#0A0A0A',
  // The spec left this as #TODO with #2EE59D as a working value; this is the
  // app's own dark-theme accent (--accent in impl/web/index.html), so the icon
  // and the product agree. One constant, one `make icons` to change it.
  green: '#35C99E',
  white: '#FFFFFF',
}

const svg = (viewBox, body, extra = '') =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${viewBox}"${extra}>\n${body}\n</svg>\n`

/** The mark as a <g>, scaled so its INKED box (stroke included) is `h` tall and
 *  centred in a `size` square. Round caps stick out by half a stroke, which is
 *  why the box is computed rather than assumed. */
function markGroup(mark, { size, heightFraction, stroke, extraAttrs = '' }) {
  const half = mark.width / 2
  const box = { x0: 36 - half, y0: (mark === SMALL ? 12 : 14) - half, x1: 64 + half, y1: (mark === SMALL ? 94 : 92) + half }
  const s = (size * heightFraction) / (box.y1 - box.y0)
  const tx = size / 2 - ((box.x0 + box.x1) / 2) * s
  const ty = size / 2 - ((box.y0 + box.y1) / 2) * s
  const paths = mark.paths.map((d) => `    <path d="${d}"/>`).join('\n')
  return `  <g transform="translate(${round(tx)} ${round(ty)}) scale(${round(s)})" fill="none" stroke="${stroke}" stroke-width="${mark.width}" stroke-linecap="round"${extraAttrs}>\n${paths}\n  </g>`
}

const round = (n) => Math.round(n * 1000) / 1000

/** The mark alone, filling its own 100-space (variant C). */
function markSvg(mark) {
  const paths = mark.paths.map((d) => `  <path d="${d}"/>`).join('\n')
  return svg('0 0 100 100', paths, ` fill="none" stroke="currentColor" stroke-width="${mark.width}" stroke-linecap="round"`)
}

/** A 512 tile: rounded (22%) or square, mark at `heightFraction` of the side. */
function tileSvg({ bg, fg, rounded = true, heightFraction = 0.7, size = 512 }) {
  const rx = rounded ? ` rx="${size * 0.22}"` : ''
  const body = [
    `  <rect width="${size}" height="${size}"${rx} fill="${bg}"/>`,
    markGroup(MASTER, { size, heightFraction, stroke: fg }),
  ].join('\n')
  return svg(`0 0 ${size} ${size}`, body)
}

// ---- sources ---------------------------------------------------------------

const sources = {
  'src/mark.svg': markSvg(MASTER),
  'src/mark-small.svg': markSvg(SMALL),
  'src/tile-dark.svg': tileSvg({ bg: COLORS.black, fg: COLORS.green }),
  'src/tile-green.svg': tileSvg({ bg: COLORS.green, fg: COLORS.black }),
  // Not in the spec's list, but the spec asks for an iOS PNG with no rounding:
  // iOS applies its own mask, so a rounded source would be clipped twice.
  'src/tile-dark-square.svg': tileSvg({ bg: COLORS.black, fg: COLORS.green, rounded: false }),
  'src/tile-dark-maskable.svg': tileSvg({ bg: COLORS.black, fg: COLORS.green, heightFraction: 0.6 }),

  // A favicon that follows the reader's theme: the mark is dark on a light
  // browser chrome and green on a dark one. Two rules, no script.
  'web/favicon.svg': svg('0 0 100 100',
    [
      '  <style>',
      `    :root { color: ${COLORS.black}; }`,
      `    @media (prefers-color-scheme: dark) { :root { color: ${COLORS.green}; } }`,
      '  </style>',
      SMALL.paths.map((d) => `  <path d="${d}"/>`).join('\n'),
    ].join('\n'),
    ` fill="none" stroke="currentColor" stroke-width="${SMALL.width}" stroke-linecap="round"`),

  // Android adaptive icon: three layers, 108dp, the mark inside the 66dp safe
  // zone (0.611 of the side) so no launcher mask can clip it.
  'android/ic_launcher_foreground.svg': svg('0 0 108 108',
    markGroup(MASTER, { size: 108, heightFraction: 66 / 108, stroke: COLORS.green })),
  'android/ic_launcher_background.svg': svg('0 0 108 108',
    `  <rect width="108" height="108" fill="${COLORS.black}"/>`),
  'android/ic_launcher_monochrome.svg': svg('0 0 108 108',
    markGroup(MASTER, { size: 108, heightFraction: 66 / 108, stroke: '#000000' })),
  // The status bar draws this as a silhouette in whatever colour it likes;
  // white with alpha is what Android expects to be handed.
  'android/ic_notification.svg': svg('0 0 24 24',
    markGroup(SMALL, { size: 24, heightFraction: 0.92, stroke: COLORS.white })),
}

// ---- the wordmark ----------------------------------------------------------

/**
 * "onchato" as outlines. No <text>, no embedded font: a lockup that needs a
 * font installed is a lockup that renders differently on every machine.
 */
const FONTS = [
  '/usr/share/fonts/truetype/ubuntu/UbuntuSans[wdth,wght].ttf',
  '/usr/share/fonts/truetype/noto/NotoSans-Regular.ttf',
  '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
]
function wordPaths(text, fontSize) {
  const file = FONTS.find((f) => existsSync(f))
  if (!file) throw new Error('no font found for the lockup - see FONTS in this script')
  const font = opentype.loadSync(file)
  const path = font.getPath(text, 0, 0, fontSize)
  const bb = path.getBoundingBox()
  return { d: path.toPathData(2), bb, font: file }
}

function lockupSvg({ markColor, textColor, bg = null }) {
  const H = 100                      // the mark's own space
  const markInk = { h: 92 - 14 + MASTER.width, w: 64 - 36 + MASTER.width }
  const fontSize = 62                // cap height reads about the mark's gapless run
  const word = wordPaths('onchato', fontSize)
  const gap = 0.6 * markInk.h
  const markX = 0
  const textX = markInk.w + gap
  const width = round(textX + word.bb.x2)
  const height = H
  const yText = round(H / 2 - (word.bb.y1 + word.bb.y2) / 2)
  const body = [
    bg ? `  <rect width="${width}" height="${height}" fill="${bg}"/>` : null,
    `  <g transform="translate(${round(markX - (36 - MASTER.width / 2))} 0)" fill="none" stroke="${markColor}" stroke-width="${MASTER.width}" stroke-linecap="round">`,
    MASTER.paths.map((d) => `    <path d="${d}"/>`).join('\n'),
    '  </g>',
    `  <g transform="translate(${round(textX)} ${yText})" fill="${textColor}">`,
    `    <path d="${word.d}"/>`,
    '  </g>',
  ].filter(Boolean).join('\n')
  return { svg: svg(`0 0 ${width} ${height}`, body), font: word.font }
}

// ---- build -----------------------------------------------------------------

const report = []
const ok = (m) => report.push(`[ok]   ${m}`)
const bad = (m) => report.push(`[fail] ${m}`)

for (const d of dirs) mkdirSync(join(OUT, d), { recursive: true })

const lock = lockupSvg({ markColor: 'currentColor', textColor: 'currentColor' })
sources['lockup/lockup-horizontal.svg'] = lock.svg
sources['lockup/lockup-dark.svg'] = lockupSvg({ markColor: COLORS.green, textColor: COLORS.green, bg: COLORS.black }).svg
sources['lockup/lockup-light.svg'] = lockupSvg({ markColor: COLORS.black, textColor: COLORS.black }).svg

/** svgo, and proof it did not move anything: both versions are rasterised and
 *  compared pixel for pixel. Comparing the path strings would fail on a
 *  rewrite that means the same thing (V30 for V44 after a relative move). */
async function writeOptimised(rel, source) {
  // svgo 4 keeps viewBox in preset-default; criterion 5 wants it kept, so this
  // is the whole configuration.
  const out = optimize(source, { multipass: true, plugins: ['preset-default'] }).data
  const [a, b] = await Promise.all([raster(source, 256), raster(out, 256)])
  const diff = pixelDiff(a, b)
  if (diff > 0.002) bad(`svgo changed ${rel} (${(diff * 100).toFixed(2)}% of pixels)`)
  writeFileSync(join(OUT, rel), out)
  return out
}

/**
 * An SVG carrying only a viewBox has no intrinsic pixel size, so sharp renders
 * it at 72 dpi against the viewBox units. Asking for a big PNG by resizing that
 * would upscale a small raster; the density is computed instead, which makes
 * librsvg draw at the target size in the first place. (Left at a fixed value it
 * also blows the pixel limit: 2400 dpi on a 512 viewBox is a 17k-px image.)
 */
function densityFor(svgText, size) {
  const vb = /viewBox="0 0 ([\d.]+) ([\d.]+)"/.exec(svgText)
  const side = vb ? Math.max(Number(vb[1]), Number(vb[2])) : 100
  return Math.min(2400, Math.max(72, (72 * size) / side))
}

async function raster(svgText, size) {
  return sharp(Buffer.from(svgText), { density: densityFor(svgText, size) })
    .resize(size, size, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .raw().ensureAlpha().toBuffer()
}

function pixelDiff(a, b) {
  if (a.length !== b.length) return 1
  let n = 0
  for (let i = 0; i < a.length; i += 4) {
    for (let c = 0; c < 4; c++) if (Math.abs(a[i + c] - b[i + c]) > 8) { n++; break }
  }
  return n / (a.length / 4)
}

const written = {}
for (const [rel, source] of Object.entries(sources)) written[rel] = await writeOptimised(rel, source)
ok(`${Object.keys(sources).length} SVG sources written and svgo-clean`)

// ---- rasterise -------------------------------------------------------------

/** PNG: sRGB, 8-bit, no metadata, lossless. `flatten` where the platform
 *  refuses alpha (iOS, apple-touch-icon). */
async function png(srcRel, outRel, size, { flatten = false } = {}) {
  let p = sharp(Buffer.from(written[srcRel]), { density: densityFor(written[srcRel], size) }).resize(size, size)
  if (flatten) p = p.flatten({ background: COLORS.black })
  const buf = await p.png({ compressionLevel: 9, effort: 10, palette: false }).toBuffer()
  writeFileSync(join(OUT, outRel), buf)
  return buf
}

await png('src/mark-small.svg', 'web/favicon-16.png', 16)   // placeholder, replaced below
for (const [size, name] of [[16, 'favicon-16.png'], [32, 'favicon-32.png'], [48, 'favicon-48.png']]) {
  // Variant A on a full-bleed black square: a favicon is not rounded, the
  // browser decides what to do with the corners.
  const source = svg('0 0 100 100', [
    `  <rect width="100" height="100" fill="${COLORS.black}"/>`,
    `  <g fill="none" stroke="${COLORS.green}" stroke-width="${SMALL.width}" stroke-linecap="round">`,
    SMALL.paths.map((d) => `    <path d="${d}"/>`).join('\n'),
    '  </g>',
  ].join('\n'))
  // palette:false everywhere - "sRGB, 8 bit" read literally, and one mode for
  // every file beats a palette here and true colour there.
  const buf = await sharp(Buffer.from(source), { density: densityFor(source, size) }).resize(size, size)
    .png({ compressionLevel: 9, effort: 10, palette: false }).toBuffer()
  writeFileSync(join(OUT, 'web', name), buf)
}
writeFileSync(join(OUT, 'web/favicon.ico'), await pngToIco([16, 32, 48].map((s) => join(OUT, 'web', `favicon-${s}.png`))))
// From the SQUARE tile: iOS masks this itself, and flattening a rounded tile
// only works while the background happens to be the same black the corners are
// filled with - change the tile colour and the corners would go black.
await png('src/tile-dark-square.svg', 'web/apple-touch-icon.png', 180, { flatten: true })
await png('src/tile-dark.svg', 'web/icon-192.png', 192)
await png('src/tile-dark.svg', 'web/icon-512.png', 512)
await png('src/tile-dark-maskable.svg', 'web/icon-512-maskable.png', 512)
await png('src/tile-dark-square.svg', 'ios/AppIcon-1024.png', 1024, { flatten: true })
ok('PNGs rasterised (sRGB, 8-bit, no metadata)')

writeFileSync(join(OUT, 'web/site.webmanifest'), JSON.stringify({
  name: 'onchato', short_name: 'onchato', theme_color: COLORS.black, background_color: COLORS.black,
  display: 'standalone', start_url: '/chat',
  icons: [
    { src: 'icon-192.png', sizes: '192x192', type: 'image/png' },
    { src: 'icon-512.png', sizes: '512x512', type: 'image/png' },
    { src: 'icon-512-maskable.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
  ],
}, null, 2) + '\n')

// ---- acceptance ------------------------------------------------------------

/** Is this pixel the mark rather than the background? */
const isInk = (buf, i) => buf[i + 1] > 90 && buf[i + 1] > buf[i] + 20

async function measure16() {
  const size = 16
  const buf = await sharp(join(OUT, 'web/favicon-16.png')).raw().ensureAlpha().toBuffer()
  // The left stroke sits at x ~ 36% of the width.
  const x = Math.round(size * 0.36)
  const col = []
  for (let y = 0; y < size; y++) col.push(isInk(buf, (y * size + x) * 4))
  let runs = [], cur = 0
  for (const on of col) { if (on) cur++; else if (cur) { runs.push(cur); cur = 0 } }
  if (cur) runs.push(cur)
  const gaps = []
  let g = 0, started = false
  for (const on of col) {
    if (on) { started = true; if (g) { gaps.push(g); g = 0 } }
    else if (started) g++
  }
  // A horizontal cut crosses BOTH strokes, so the width is the longest single
  // run in that row - counting every inked pixel measured the two together and
  // reported a 4 px stroke on a 16 px icon.
  const yCut = Math.round(size * 0.22)
  let w = 0, run = 0
  for (let xx = 0; xx < size; xx++) {
    if (isInk(buf, (yCut * size + xx) * 4)) { run++; if (run > w) w = run } else run = 0
  }
  return { segments: runs.length, gap: gaps.length ? Math.max(...gaps) : 0, stroke: w }
}

const m = await measure16()
;(m.gap >= 3 ? ok : bad)(`favicon-16: gap in the left stroke is ${m.gap} px (needs >= 3)`)
;(m.stroke >= 1.5 ? ok : bad)(`favicon-16: stroke is ${m.stroke} px (needs >= 1.5)`)
;(m.segments === 2 ? ok : bad)(`favicon-16: the left stroke is ${m.segments} segment(s) - it must read as two`)

/** The mark's inked bounding box, as fractions of the side. */
async function markBoxOf(input, size, fromSvg = false) {
  const buf = fromSvg
    ? await sharp(Buffer.from(input), { density: densityFor(input, size) }).resize(size, size).raw().ensureAlpha().toBuffer()
    : await sharp(input).resize(size, size).raw().ensureAlpha().toBuffer()
  let x0 = size, y0 = size, x1 = -1, y1 = -1
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    if (isInk(buf, (y * size + x) * 4)) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y }
  }
  return { x0: x0 / size, y0: y0 / size, x1: (x1 + 1) / size, y1: (y1 + 1) / size }
}

// Both renders come from the SVG, and the difference is expressed in pixels of
// the SMALLER one - that is what "identical within 1 px" can mean when the
// small render is antialiased and a half-pixel there is five at 512.
const big = await markBoxOf(written['src/tile-dark.svg'], 512, true)
const small = await markBoxOf(written['src/tile-dark.svg'], 48, true)
const drift = Math.max(...['x0', 'y0', 'x1', 'y1'].map((k) => Math.abs(big[k] - small[k]))) * 48
;(drift <= 1 ? ok : bad)(`tile-dark at 512 vs 48: the mark's box differs by ${drift.toFixed(2)} px at 48-scale (needs <= 1)`)

const mask = await markBoxOf(join(OUT, 'web/icon-512-maskable.png'), 512)
const corners = [[mask.x0, mask.y0], [mask.x1, mask.y0], [mask.x0, mask.y1], [mask.x1, mask.y1]]
const worst = Math.max(...corners.map(([x, y]) => Math.hypot(x - 0.5, y - 0.5)))
;(worst <= 0.4 ? ok : bad)(`maskable: the mark's furthest corner is at r=${worst.toFixed(3)} of the side (safe zone is 0.4)`)

const forbidden = /<text|<tspan|Gradient|<filter|@font-face|<font/i
const dirty = Object.entries(written).filter(([, s]) => forbidden.test(s)).map(([r]) => r)
;(dirty.length === 0 ? ok : bad)(`no gradients, filters, fonts or <text> (${dirty.join(', ') || 'clean'})`)

const noViewBox = Object.entries(written).filter(([, s]) => !/viewBox="0 0 /.test(s)).map(([r]) => r)
;(noViewBox.length === 0 ? ok : bad)(`every viewBox starts at 0 0 (${noViewBox.join(', ') || 'clean'})`)

// ---- preview ---------------------------------------------------------------

// The one that matters is 16 px seen large: an icon fails there first.
for (const s of [16, 32]) {
  await sharp(join(OUT, 'web', `favicon-${s}.png`))
    .resize(s * 8, s * 8, { kernel: 'nearest' })
    .png({ compressionLevel: 9 }).toFile(join(OUT, 'preview', `favicon-${s}-x8.png`))
}

const previewFiles = [
  ['web/favicon-16.png', 16], ['web/favicon-32.png', 32], ['web/favicon-48.png', 48],
  ['web/apple-touch-icon.png', 180], ['web/icon-192.png', 192], ['web/icon-512.png', 512],
  ['web/icon-512-maskable.png', 512], ['ios/AppIcon-1024.png', 1024],
]
writeFileSync(join(OUT, 'preview/preview.html'), `<!doctype html>
<meta charset="utf-8"><title>onchato icon set</title>
<style>
  body { font: 14px system-ui, sans-serif; margin: 0; }
  section { padding: 24px 28px; }
  .light { background: #f4f6f5; color: #16211d; }
  .dark { background: #0A0A0A; color: #e7f2ee; }
  h2 { font-size: 13px; letter-spacing: .08em; text-transform: uppercase; opacity: .6; font-weight: 600; margin: 0 0 14px; }
  .row { display: flex; flex-wrap: wrap; gap: 22px; align-items: flex-end; }
  figure { margin: 0; text-align: center; }
  figcaption { font-size: 11px; opacity: .65; margin-top: 6px; font-family: ui-monospace, monospace; }
  img { image-rendering: auto; display: block; }
  .zoom img { image-rendering: pixelated; border: 1px solid rgba(128,128,128,.4); }
  .svgrow img { height: 96px; }
</style>
${['light', 'dark'].map((theme) => `
<section class="${theme}">
  <h2>rasters - ${theme} background</h2>
  <div class="row">
    ${previewFiles.map(([f, s]) => `<figure><img src="../${f}" width="${Math.min(s, 128)}" height="${Math.min(s, 128)}" alt=""><figcaption>${f.split('/').pop()}<br>${s}px</figcaption></figure>`).join('\n    ')}
  </div>
  <h2 style="margin-top:26px">16 and 32 px, magnified 8x (the gap and the ear must survive)</h2>
  <div class="row zoom">
    <figure><img src="favicon-16-x8.png" alt=""><figcaption>favicon-16 x8</figcaption></figure>
    <figure><img src="favicon-32-x8.png" alt=""><figcaption>favicon-32 x8</figcaption></figure>
  </div>
  <h2 style="margin-top:26px">svg sources</h2>
  <div class="row svgrow">
    ${['src/mark.svg', 'src/mark-small.svg', 'src/tile-dark.svg', 'src/tile-green.svg', 'web/favicon.svg',
       'android/ic_launcher_foreground.svg', 'android/ic_launcher_monochrome.svg', 'android/ic_notification.svg']
      .map((f) => `<figure><img src="../${f}" alt=""><figcaption>${f}</figcaption></figure>`).join('\n    ')}
  </div>
  <h2 style="margin-top:26px">lockup</h2>
  <div class="row svgrow">
    ${['lockup/lockup-horizontal.svg', 'lockup/lockup-dark.svg', 'lockup/lockup-light.svg']
      .map((f) => `<figure><img src="../${f}" alt="" style="height:56px;width:auto"><figcaption>${f.split('/').pop()}</figcaption></figure>`).join('\n    ')}
  </div>
</section>`).join('\n')}
`)
ok('preview/preview.html written')

// ---- what the app actually consumes -----------------------------------------

/**
 * The pieces the Tauri CLI needs, and the manifest that tells it about the
 * Android layers.
 *
 * `tauri icon` is used for the base set rather than sharp because two of those
 * formats are not sharp's to write: `.icns` and the Windows `Square*Logo` set.
 * It takes a manifest, so our own foreground / background / monochrome go in
 * as well - without them Android would get a launcher icon derived from the
 * square tile, and no themed (monochrome) icon at all.
 *
 * `default` is the ROUNDED tile on transparency: macOS and Windows draw the
 * source as-is, and a full-bleed black square is not what an app icon looks
 * like on either. iOS gets `bg_color` flattened under it instead.
 */
const TAURI_SRC = join(OUT, 'tauri-src')
mkdirSync(TAURI_SRC, { recursive: true })
async function tauriSource(rel, name, size = 1024) {
  const s = written[rel]
  const buf = await sharp(Buffer.from(s), { density: densityFor(s, size) })
    .resize(size, size).png({ compressionLevel: 9, palette: false }).toBuffer()
  writeFileSync(join(TAURI_SRC, name), buf)
}
await tauriSource('src/tile-dark.svg', 'app-icon.png')
await tauriSource('android/ic_launcher_foreground.svg', 'android-foreground.png')
await tauriSource('android/ic_launcher_monochrome.svg', 'android-monochrome.png')
writeFileSync(join(TAURI_SRC, 'icon.json'), JSON.stringify({
  default: 'app-icon.png',
  // No `android_bg`. Our background is one flat colour, and handing the CLI an
  // image makes it emit five densities of PNG AND point the adaptive icon at
  // `@mipmap/ic_launcher_background`. With bg_color alone it writes a colour
  // resource and points at `@color/...`, which is both smaller and what
  // `src-tauri/android/patch.mjs` rewrites when it copies the icons into the
  // generated project - change this and that patcher stops matching.
  bg_color: COLORS.black,
  android_fg: 'android-foreground.png',
  android_monochrome: 'android-monochrome.png',
  // 100, not the default: the foreground already places the mark inside the
  // 66dp safe zone (ic_launcher_foreground.svg), so scaling it again would
  // shrink it twice and leave the launcher icon swimming in its own tile.
  android_fg_scale: 100,
}, null, 2) + '\n')
ok('tauri-src/ + icon.json written (run: make icons-app)')

/**
 * The web side, straight into the app: `impl/web/favicon.ico` is copied into
 * dist by webpack's own hook, and `impl/web/icons/` rides along with it.
 */
const WEB = join(ROOT, 'impl', 'web')
mkdirSync(join(WEB, 'icons'), { recursive: true })
writeFileSync(join(WEB, 'favicon.ico'), readFileSync(join(OUT, 'web/favicon.ico')))
for (const f of ['apple-touch-icon.png', 'icon-192.png', 'icon-512.png', 'icon-512-maskable.png', 'site.webmanifest']) {
  writeFileSync(join(WEB, 'icons', f), readFileSync(join(OUT, 'web', f)))
}
/**
 * The tab icon goes into the HTML as a data URI rather than a file: it costs no
 * request, it survives in the packaged app with no network, and it cannot 404
 * out of a dist/ that is emptied on every build. Both pages carry the same one.
 */
const faviconDataUri = 'data:image/svg+xml,' + encodeURIComponent(written['web/favicon.svg'])
  .replace(/'/g, '%27').replace(/"/g, '%22')
/**
 * The lockup, inlined between markers in the login card and the boot splash.
 * Inline for the same reason as the tab icon - no request, no 404 out of a
 * cleaned dist/, works with no network in the packaged app - and generated
 * rather than pasted so it cannot drift from `assets/icon/lockup/`.
 */
const LOCKUP = /<!--lockup-->[\s\S]*?<!--\/lockup-->/g
{
  const file = join(WEB, 'index.html')
  const html = readFileSync(file, 'utf8')
  const inline = written['lockup/lockup-horizontal.svg'].trim()
  if (!LOCKUP.test(html)) bad('index.html: no <!--lockup--> markers to fill')
  else writeFileSync(file, html.replace(LOCKUP, `<!--lockup-->${inline}<!--/lockup-->`))
}
ok('the lockup is inlined in the login card and the splash')

/** The LOCKUP on the empty conversation pane, where a tree used to sit. */
const EMPTY_MARK = /<!--emptymark-->[\s\S]*?<!--\/emptymark-->/g
{
  const file = join(WEB, 'index.html')
  const html = readFileSync(file, 'utf8')
  const inline = written['lockup/lockup-horizontal.svg'].trim()
  if (!EMPTY_MARK.test(html)) bad('index.html: no <!--emptymark--> markers to fill')
  else writeFileSync(file, html.replace(EMPTY_MARK, `<!--emptymark-->${inline}<!--/emptymark-->`))
}
ok('the lockup is inlined on the empty conversation pane')

const ICON_LINK = /<link rel="icon" href="data:image\/svg\+xml,[^"]*">/
for (const page of ['index.html', 'landing.html']) {
  const file = join(WEB, page)
  const html = readFileSync(file, 'utf8')
  // The link MISSING is the failure. An unchanged file is not: a second run
  // writes the same tag, and reporting that as an error made `make icons-app`
  // fail on its own second invocation.
  if (!ICON_LINK.test(html)) { bad(`${page}: no inline favicon link to replace`); continue }
  writeFileSync(file, html.replace(ICON_LINK, `<link rel="icon" href="${faviconDataUri}">`))
}
ok('impl/web: favicon.ico, icons/, and the inline tab icon in both pages')

/**
 * The status-bar icon, which nothing else generates.
 *
 * `tauri icon` writes the launcher mipmaps and stops there, so these five
 * drawables are ours - and being ours is exactly why the old speech bubble
 * survived a full icon swap and turned up in the notification shade on a phone
 * (reported 2026-09-06, after 0.5.50 changed everything else).
 *
 * Two things about the format, both learned from a phone at 0.5.9 and written
 * down in `android/patch.mjs` and `OnchatoService.kt`:
 *
 *  - it is a SILHOUETTE. Android throws the colour away and tints the alpha, so
 *    the mark is drawn white and only its shape matters;
 *  - the status bar renders the resource FULL-BLEED, unlike a launcher icon
 *    with its safe zone. Reusing `ic_launcher_monochrome` there (glyph at ~44%
 *    of the canvas) shipped a mark visibly smaller than every other icon in the
 *    bar. The old bubble filled 0.92 of its canvas; this matches it.
 */
const STAT_FILL = 0.92
const STAT_DPI = { mdpi: 24, hdpi: 36, xhdpi: 48, xxhdpi: 72, xxxhdpi: 96 }
const ANDROID_RES = join(ROOT, 'impl', 'src-tauri', 'icons', 'android')
for (const [dpi, size] of Object.entries(STAT_DPI)) {
  const source = svg(`0 0 ${size} ${size}`,
    markGroup(SMALL, { size, heightFraction: STAT_FILL, stroke: COLORS.white }))
  const buf = await sharp(Buffer.from(source), { density: densityFor(source, size) })
    .resize(size, size).png({ compressionLevel: 9, effort: 10, palette: false }).toBuffer()
  mkdirSync(join(ANDROID_RES, `drawable-${dpi}`), { recursive: true })
  writeFileSync(join(ANDROID_RES, `drawable-${dpi}`, 'ic_stat_onchato.png'), buf)
}
ok(`ic_stat_onchato in ${Object.keys(STAT_DPI).length} densities (status bar - nothing else writes these)`)

console.log(`\nonchato icons -> ${OUT}`)
console.log(`font for the lockup: ${lock.font}`)
console.log(`green: ${COLORS.green}   black: ${COLORS.black}\n`)
for (const line of report) console.log('  ' + line)
const failed = report.filter((r) => r.startsWith('[fail]')).length
console.log(failed ? `\n${failed} check(s) FAILED\n` : '\nall checks passed\n')
process.exit(failed ? 1 : 0)
