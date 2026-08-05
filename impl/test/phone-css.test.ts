/**
 * Which media block a phone rule actually lives in.
 *
 * This exists because of a bug that took three wrong guesses to find. The rule
 * collapsing the header badges to glyphs was written for phones and landed in
 * `@media (max-height:560px)` — the SHORT-screen block, not the phone block
 * (`max-width:900px, max-height:560px`). So it fired on a 360×545 viewport and
 * not on 360×641: the same phone, two browsers, different toolbar heights,
 * opposite results. It looked like a browser difference, a cache problem and a
 * desktop-mode setting before it turned out to be a stylesheet nesting mistake.
 *
 * A browser cannot catch this cheaply — the badges live inside a `hidden` pane
 * until a conversation opens, so a headless check has to log in first. Parsing
 * the stylesheet and evaluating the media conditions against real viewport
 * sizes is exact, needs no browser, and runs in milliseconds.
 *
 * The sizes are measured, not invented: 360×545 is Brave on the reporter's
 * Android 15 phone, 360×641 is Chrome on the same device.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const HTML = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'web', 'index.html'), 'utf8')

/** Every `@media` condition wrapping `needle`, outermost first. */
function enclosingMedia(css: string, needle: string): string[] {
  const at = css.indexOf(needle)
  assert.ok(at > 0, `rule not found in index.html: ${needle}`)
  const out: string[] = []
  let depth = 0
  for (let i = at; i > 0; i--) {
    const c = css[i]
    if (c === '}') depth++
    else if (c === '{') {
      if (depth === 0) {
        const head = css.slice(css.lastIndexOf('\n', i), i).trim()
        if (head.startsWith('@media')) out.unshift(head.slice(6).trim())
      } else depth--
    }
  }
  return out
}

/**
 * Evaluate a CSS media condition for a viewport. Handles the only forms this
 * stylesheet uses: `max-width`, `max-height`, `pointer`, and comma = OR.
 */
function matches(cond: string, w: number, h: number, coarse = true): boolean {
  return cond.split(',').some((clause) => {
    const parts = clause.match(/\(([^)]+)\)/g) ?? []
    return parts.every((p) => {
      const [k, v] = p.slice(1, -1).split(':').map((x) => x.trim())
      if (k === 'max-width') return w <= parseInt(v, 10)
      if (k === 'min-width') return w >= parseInt(v, 10)
      if (k === 'max-height') return h <= parseInt(v, 10)
      if (k === 'min-height') return h >= parseInt(v, 10)
      if (k === 'pointer') return v === (coarse ? 'coarse' : 'fine')
      throw new Error(`unhandled media feature: ${k}`)
    })
  })
}

/** Viewports that actually occur, with what each one is. */
const PHONES = [
  { name: 'Brave / Android 15', w: 360, h: 545 },
  { name: 'Chrome / Android 15', w: 360, h: 641 }, // taller: less browser chrome
  { name: 'Galaxy S24', w: 360, h: 780 },
  { name: 'iPhone 16', w: 393, h: 852 },
  { name: 'iPhone 16 landscape', w: 852, h: 393 },
]
const DESKTOP = { name: 'desktop', w: 1440, h: 900 }

test('the header badges collapse on EVERY phone, not only short ones', () => {
  const media = enclosingMedia(HTML, '.chat-head .badge .b-txt{display:none}')
  assert.equal(media.length, 1, 'expected exactly one wrapping media query')
  for (const p of PHONES) {
    assert.ok(matches(media[0], p.w, p.h),
      `${p.name} (${p.w}×${p.h}) does not match "${media[0]}" — the badges keep their labels there`)
  }
})

test('and they keep their labels on a desktop, where there is room', () => {
  const media = enclosingMedia(HTML, '.chat-head .badge .b-txt{display:none}')
  assert.equal(matches(media[0], DESKTOP.w, DESKTOP.h), false,
    'the collapse rule must not reach a desktop viewport')
})

test('the one-pane layout switch covers the same set', () => {
  // The rule that makes the app show a single pane. If these two ever disagree
  // about what a phone is, the header collapses on devices that are showing the
  // desktop layout, or the reverse — which is exactly the class of bug above.
  const media = enclosingMedia(HTML, '.app.chat-open .sidebar{display:none}')
  for (const p of PHONES) {
    assert.ok(matches(media[media.length - 1], p.w, p.h), `${p.name} must get the one-pane layout`)
  }
  assert.equal(matches(media[media.length - 1], DESKTOP.w, DESKTOP.h), false)
})
