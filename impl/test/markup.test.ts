import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const html = readFileSync(join(import.meta.dirname, '..', 'web', 'index.html'), 'utf8')

/**
 * Two ids the same is not a style question — it is a control that does nothing.
 *
 * `Anuluj` in the recording window was dead for exactly this reason: the first
 * voice implementation left a hidden chip in the composer carrying
 * `id="rec-cancel"`, and `getElementById` answers with the FIRST one. The
 * handler was attached to an invisible leftover and the button people press had
 * none. Reported as "Cancel does not work", and it was true.
 *
 * The browser harness could not catch it: it clicks by id too, so it clicked
 * the same hidden leftover and passed. This is the check that would have.
 */
test('every id in the markup is unique', () => {
  const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1])
  // A test that finds nothing to check passes for the wrong reason.
  assert.ok(ids.length > 50, `only ${ids.length} ids found — the markup or this regex has moved`)
  const seen = new Set<string>()
  const dupes = new Set<string>()
  for (const id of ids) (seen.has(id) ? dupes : seen).add(id)
  assert.deepEqual([...dupes], [], `duplicate id(s): ${[...dupes].join(', ')}`)
})

/**
 * A CSS animation that names a keyframe nobody defined does not fail — it does
 * nothing, quietly. Deleting the recording chip took `@keyframes recblink` with
 * it and left the window's dot referring to it.
 */
test('every animation names a keyframe that exists', () => {
  const style = /<style>([\s\S]*?)<\/style>/.exec(html)?.[1] ?? ''
  const defined = new Set([...style.matchAll(/@keyframes\s+([\w-]+)/g)].map((m) => m[1]))
  const used = [...style.matchAll(/animation:\s*([\w-]+)/g)].map((m) => m[1])
    .filter((n) => n !== 'none')
  assert.ok(used.length > 0, 'no animations found — this test would pass on an empty file')
  for (const name of used) assert.ok(defined.has(name), `animation "${name}" has no @keyframes`)
})

/**
 * `data-i18n` on an element whose text was changed and never re-translated is
 * the other silent one — the catalogue is keyed by the Polish text, so a key
 * that no longer matches simply falls through to Polish in an English UI.
 */
test('every data-i18n key matches the element it is on', () => {
  for (const m of html.matchAll(/data-i18n="([^"]*)"[^>]*>([^<]*)</g)) {
    const [, key, text] = m
    if (!key || !text.trim()) continue
    assert.equal(text.trim(), key.trim(), `data-i18n key and text differ: "${key}" vs "${text.trim()}"`)
  }
})
