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

/**
 * Every string the UI shows must have an English entry — because the fallback
 * is silent. `t()` returns the KEY when a locale has no entry, which is the
 * right degradation (the app shows the words it shipped rather than a raw id)
 * and is exactly why a gap is invisible to whoever made it: the Polish build
 * looks perfect and the English one is half Polish.
 *
 * Reported as "the translations need a proper review, it is a mix". It was, and
 * the cause was not missing entries so much as strings that never reached the
 * catalogue at all: `$('go').textContent = reg ? 'Zarejestruj' : 'Zaloguj'` —
 * bare Polish sitting next to translated siblings in the same expression, on the
 * sign-in button.
 *
 * So this reads the call sites, not the catalogue: every literal inside a `tr(…)`
 * and every `data-i18n*` in the markup has to be answerable in English.
 */
const HTML = readFileSync(join(import.meta.dirname, '..', 'web', 'index.html'), 'utf8')
const APP = readFileSync(join(import.meta.dirname, '..', 'web', 'src', 'app.ts'), 'utf8')
const DESK = readFileSync(join(import.meta.dirname, '..', 'web', 'src', 'desktop.ts'), 'utf8')

/** Symbols, emoji and the two language names: nothing to translate. */
const NOT_WORDS = /^[\s\p{P}\p{S}\d]*$/u
const EXEMPT = new Set(['English', 'Polski'])
/** `tr(mode === 'export' ? … : …)` puts a MODE FLAG inside the call, and the
 *  scanner cannot tell it from a caption. Every real caption is capitalised, or
 *  has a space, or carries a Polish character; a bare lowercase token is a flag. */
const LOOKS_LIKE_A_FLAG = /^[a-z][a-z0-9-]*$/

function trKeys(src: string): string[] {
  const out: string[] = []
  for (const m of src.matchAll(/\btr\(/g)) {
    // Walk to the matching close paren, collecting the quoted literals on the
    // way: `tr(cond ? 'a' : 'b')` has two keys and both must exist.
    let depth = 1
    let i = m.index! + m[0].length
    for (; i < src.length && depth > 0; i++) {
      const c = src[i]
      if (c === '(') depth++
      else if (c === ')') depth--
      else if (c === '\n') break
      else if (c === "'") {
        let lit = ''
        for (i++; i < src.length && src[i] !== "'"; i++) {
          lit += src[i] === '\\' ? src[++i] : src[i]
        }
        out.push(lit)
      }
    }
  }
  return out
}

test('every string the UI shows can be said in English', () => {
  const used = new Set<string>([
    ...trKeys(APP), ...trKeys(DESK),
    ...[...HTML.matchAll(/data-i18n(?:-title|-placeholder)?="([^"]+)"/g)].map((m) => m[1]),
  ])
  const en = new Set(keysOf('en'))
  assert.ok(used.size > 300, `only ${used.size} strings found — the extractor has lost the call sites`)

  const missing = [...used].filter((k) =>
    k && !NOT_WORDS.test(k) && !EXEMPT.has(k) && !LOOKS_LIKE_A_FLAG.test(k) && !en.has(k))
  assert.deepEqual(missing, [], `no English for:\n  ${missing.join('\n  ')}`)
})
