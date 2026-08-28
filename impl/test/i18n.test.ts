import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * The catalogue's own header says a duplicate key is not a syntax error and
 * that the later one silently wins. It was right, and nothing was checking:
 * `'Pobieram…'` sat in the table twice, translated once as "Downloading…" and
 * once as "Fetching…", and the English build had been showing the second for as
 * long as both existed. Nobody can see that by reading — the file is 450 lines
 * of near-identical shape — so it is checked here instead.
 */
const src = readFileSync(join(import.meta.dirname, '..', 'web', 'src', 'i18n.ts'), 'utf8')

function keysOf(locale: string): string[] {
  const lines = src.split('\n')
  const start = lines.findIndex((l) => l.startsWith(`  ${locale}: {`))
  assert.ok(start > 0, `no ${locale} block — this test has lost its file`)
  const end = lines.findIndex((l, i) => i > start && l.startsWith('  },'))
  return lines.slice(start + 1, end)
    .map((l) => /^    '((?:[^'\\]|\\.)*)':/.exec(l)?.[1])
    .filter((k): k is string => !!k)
}

for (const locale of ['pl', 'en']) {
  test(`the ${locale} catalogue has no key twice`, () => {
    const keys = keysOf(locale)
    // A test that finds nothing passes for the wrong reason.
    assert.ok(keys.length > (locale === 'en' ? 400 : 4), `only ${keys.length} keys read`)
    const seen = new Set<string>()
    const dupes = new Set<string>()
    for (const k of keys) (seen.has(k) ? dupes : seen).add(k)
    assert.deepEqual([...dupes], [], `duplicate key(s): ${[...dupes].join(' · ')}`)
  })
}
