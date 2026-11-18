/**
 * An outward link in a packaged shell goes to the system browser, on the
 * phones too. The webview turns `target="_blank"` into a new-window request
 * nobody handles, so without the click catcher in web/src/app.ts the link
 * dies silently. The phones were once excluded from it, and "Open" in a
 * message link's warning did nothing on Android until 0.8.13 (2026-11-18).
 * Source checks: no browser test runs inside a packaged shell.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const app = readFileSync(new URL('../web/src/app.ts', import.meta.url), 'utf8')
const lib = readFileSync(new URL('../src-tauri/src/lib.rs', import.meta.url), 'utf8')

/** The capture-phase click catcher for `a[target="_blank"]`, up to its `}, true)`. */
function catcher(src: string): string {
  const start = src.indexOf("if (isDesktopShell()) document.addEventListener('click'")
  assert.ok(start >= 0, 'the outward-link click catcher is gone')
  const end = src.indexOf('}, true)', start)
  assert.ok(end > start)
  return src.slice(start, end)
}

test('the outward-link catcher hands every http(s) target=_blank anchor to the host', () => {
  const c = catcher(app)
  assert.match(c, /a\[target="_blank"\]/)
  assert.match(c, /openExternal\(a\.href\)/)
  assert.match(c, /e\.preventDefault\(\)/)
})

test('the catcher does not leave the phones out', () => {
  assert.doesNotMatch(catcher(app), /isMobileShell/, 'a phone would drop the click: "Open" does nothing')
})

test('the phone shell registers desk_open_url, so the catcher has someone to ask', () => {
  const mobile = lib.slice(lib.indexOf('mod mobile {'))
  const handler = mobile.slice(mobile.indexOf('generate_handler!['))
  assert.match(handler.slice(0, handler.indexOf(']')), /\bdesk_open_url\b/)
  assert.match(mobile, /fn desk_open_url\(app: AppHandle, url: String\)/)
})
