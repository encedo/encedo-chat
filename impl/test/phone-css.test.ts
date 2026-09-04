/**
 * Which media block a phone rule actually lives in.
 *
 * This exists because of a bug that took three wrong guesses to find. The rule
 * collapsing the header badges to glyphs was written for phones and landed in
 * `@media (max-height:560px)` — the SHORT-screen block, not the phone block
 * (`max-width:900px, max-height:560px`). So it fired on a 360x545 viewport and
 * not on 360x641: the same phone, two browsers, different toolbar heights,
 * opposite results. It looked like a browser difference, a cache problem and a
 * desktop-mode setting before it turned out to be a stylesheet nesting mistake.
 *
 * A browser cannot catch this cheaply — the badges live inside a `hidden` pane
 * until a conversation opens, so a headless check has to log in first. Parsing
 * the stylesheet and evaluating the media conditions against real viewport
 * sizes is exact, needs no browser, and runs in milliseconds.
 *
 * The sizes are measured, not invented: 360x545 is Brave on the reporter's
 * Android 15 phone, 360x641 is Chrome on the same device.
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

test('the composer keeps a text field however wide the attachment chip is', () => {
  // Reported from a portrait phone: picking a file left no visible input. The
  // chip and the input are siblings in one flex row, and `min-width:0` made the
  // INPUT the item that collapsed first. A floor moves that role to the chip,
  // which can afford it — a filename has an ellipsis, a text field has nothing.
  const rule = HTML.match(/\.composer-field input\{([^}]*)\}/)
  assert.ok(rule, '.composer-field input rule not found')
  const min = rule![1].match(/min-width:\s*([^;}]+)/)?.[1]?.trim()
  assert.ok(min && !/^0(\D|$)/.test(min), `the text field may not shrink to nothing (min-width: ${min})`)
})

test('the attachment chip stays shorter than the field it sits in', () => {
  // The chip's height is set by the padding on its cross. At a finger-sized 8px
  // it grew the composer enough to push the input out of a portrait phone, so
  // the tap target has to come from somewhere that costs no layout.
  const x = HTML.match(/\.composer-field \.attach-chip \.x\{([^}]*)\}/)
  assert.ok(x, '.attach-chip .x rule not found')
  const pad = parseInt(x![1].match(/padding:\s*(\d+)/)?.[1] ?? '99', 10)
  assert.ok(pad <= 4, `padding on the cross sets the chip height; ${pad}px is too tall for a phone composer`)
  assert.match(HTML, /\.composer-field \.attach-chip \.x::after\{[^}]*position:absolute/,
    'the cross needs an overlay to stay finger-sized without growing the chip')
})

test('the settings drawer stacks above the scrim, and modals above the drawer', () => {
  // The drawer opens the scrim with it, so a drawer BELOW the scrim is a drawer
  // whose every click and scroll is swallowed by the overlay — reported as
  // "settings is dead, and it will not scroll". The two-browser harness cannot
  // catch it: it clicks elements through CDP, which never hit-tests.
  const z = (sel: string) => {
    const m = HTML.match(new RegExp(`\\${sel}\\{([^}]*)\\}`))
    assert.ok(m, `${sel} rule not found`)
    const v = m![1].match(/z-index:\s*(\d+)/)?.[1]
    assert.ok(v, `${sel} has no z-index`)
    return parseInt(v!, 10)
  }
  assert.ok(z('.scrim') < z('.drawer'), `scrim ${z('.scrim')} must sit under drawer ${z('.drawer')}`)
  assert.ok(z('.drawer') < z('.modal'), `drawer ${z('.drawer')} must sit under modal ${z('.modal')}`)
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
