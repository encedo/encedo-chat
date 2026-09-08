/**
 * composer.ts - how tall the message box should be.
 *
 * The composer was a single-line `<input>`, so a paragraph scrolled sideways
 * through a slot one line high and longer messages were, in the words of the
 * report (2026-09-08), "awkward to write". It is a textarea now, and a textarea
 * does not grow on its own in every browser we ship to - `field-sizing:content`
 * is Chromium-only at the time of writing, and the packaged desktop runs
 * WebKitGTK.
 *
 * So the height is computed, and the arithmetic lives here rather than inside a
 * DOM handler: it has edges worth pinning (a box that will not shrink again, a
 * box that eats the conversation, a browser that reports nonsense for
 * `line-height`) and none of them need a browser to test.
 */

export interface BoxMetrics {
  /** One line of text, in pixels — `line-height`, as computed. */
  line: number
  /** The box's own vertical padding, top plus bottom. */
  pad: number
  /** What the content wants, measured with the height released (`scrollHeight`). */
  scroll: number
}

/** Closed: it grows to this and then scrolls, or the composer eats the room. */
export const LINES_CLOSED = 4
/** Opened by the handle: starts at LINES_CLOSED, goes to here. */
export const LINES_OPEN = 12

/**
 * The height to set, in pixels.
 *
 * `scroll` must be measured with the box's height released, because
 * `scrollHeight` on a box that is already tall enough reports the height it
 * HAS — read it while a four-line height is set and a message cut back to one
 * word keeps its four lines forever.
 *
 * A browser that cannot say how tall a line is (`normal`, or a font that has
 * not loaded) reports NaN, and NaN spreads: `Math.min` of it is NaN, and a
 * height of "NaNpx" is ignored, leaving the box at its default. One line is
 * assumed instead, which is wrong by a few pixels rather than wrong by a
 * feature.
 */
export function boxHeight(m: BoxMetrics, open: boolean): number {
  const line = m.line > 0 && Number.isFinite(m.line) ? m.line : 20
  const pad = Number.isFinite(m.pad) && m.pad > 0 ? m.pad : 0
  const cap = line * (open ? LINES_OPEN : LINES_CLOSED) + pad
  // Opened, the box is at least four lines even when it is empty: the handle
  // was pressed to make room, and a box that springs back the moment the text
  // is deleted has not made any.
  const floor = open ? line * LINES_CLOSED + pad : line + pad
  const want = Number.isFinite(m.scroll) ? m.scroll : floor
  return Math.round(Math.max(floor, Math.min(want, cap)))
}

/** How many lines that height is, for anything that wants to say so. */
export const boxLines = (px: number, m: BoxMetrics): number =>
  Math.max(1, Math.round((px - (m.pad > 0 ? m.pad : 0)) / (m.line > 0 ? m.line : 20)))
