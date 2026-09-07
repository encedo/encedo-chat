/**
 * qrzoom.ts - what to do with a camera's zoom capability, if it has one.
 *
 * The QR scanner used to take whatever frame the camera offered. On a phone
 * with several rear lenses `facingMode: 'environment'` often lands on the wide
 * one, so a code held at arm's length is a small patch of a large frame and
 * `BarcodeDetector` has too few pixels to read it (reported 2026-09-07: "1:1,
 * impractical"). The camera's own zoom is the fix - it crops in the capture
 * pipeline, so the code arrives bigger AND sharper, unlike scaling a picture
 * that has already been taken.
 *
 * This module is the part worth testing: capabilities are a MediaTrack detail
 * that varies per device and per browser, and the arithmetic on them should not
 * live inside a click handler. Everything here is pure.
 */

/** What `getCapabilities()` may hand back. Every field is untrusted. */
export interface ZoomCaps {
  zoom?: { min?: unknown; max?: unknown; step?: unknown } | number
}

export interface ZoomPlan {
  min: number
  max: number
  /** Slider granularity - never 0, or the control cannot move. */
  step: number
  /** Where to open. Scanning happens at arm's length, so it is not `min`. */
  start: number
}

/** Where to start, when the camera can go that far. */
export const PREFERRED_START = 2

const num = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) ? v : null

/**
 * `null` means "no zoom control" and the UI shows nothing - which is the case
 * on every desktop webcam and on phones whose driver does not expose the
 * capability. A control that cannot move is worse than no control: it says the
 * feature exists and then refuses.
 */
export function zoomPlan(caps: ZoomCaps | null | undefined): ZoomPlan | null {
  const z = caps?.zoom
  // Some implementations report the CURRENT zoom as a bare number. That is a
  // value, not a range, and there is nothing to offer.
  if (!z || typeof z !== 'object') return null
  const min = num((z as any).min)
  const max = num((z as any).max)
  if (min === null || max === null || !(max > min)) return null

  // A step of 0, a missing step, or one wider than the range itself all mean
  // "the driver did not say"; twenty notches is a slider a thumb can use.
  const raw = num((z as any).step)
  const step = raw !== null && raw > 0 && raw <= max - min ? raw : Math.max((max - min) / 20, 0.01)

  return { min, max, step, start: clampToStep(Math.min(PREFERRED_START, max), min, max, step) }
}

/** Snap a value into the range, on the step grid the driver asked for. */
export function clampToStep(value: number, min: number, max: number, step: number): number {
  const v = Math.min(Math.max(value, min), max)
  if (!(step > 0)) return v
  // The ends are reachable even when they are off the grid. `max = 8, step =
  // 0.3` puts the last notch at 7.9, and a zoom control whose maximum cannot
  // be selected is a control that lies about its range - which is also how an
  // <input type=range> behaves, so the slider and this agree.
  if (v >= max - step / 2) return max
  if (v <= min + step / 2) return min
  const snapped = min + Math.round((v - min) / step) * step
  const bounded = Math.min(Math.max(snapped, min), max)
  // Kill the float dust `min + k*step` leaves behind (1.7999999999999998).
  return Math.round(bounded * 1000) / 1000
}
