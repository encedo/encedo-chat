import { test } from 'node:test'
import assert from 'node:assert/strict'
import { assessPassword, ENFORCE_MIN } from '../lib/passmeter.ts'

test('empty is the weakest thing there is', () => {
  const s = assessPassword('')
  assert.equal(s.bits, 0)
  assert.equal(s.score, 0)
})

test('top-list passwords are weak whatever they wear', () => {
  // Verbatim, dressed up in l33t, capitalised, and with the "make it
  // special" tail — one password, one verdict.
  for (const pw of ['password', 'P@ssw0rd', 'Password1!', 'qwerty', 'zaq12wsx', 'haslo123', 'polska']) {
    const s = assessPassword(pw)
    assert.equal(s.score, 0, `${pw} scored ${s.score}`)
    assert.equal(s.advice, 'common', `${pw} advised ${s.advice}`)
  }
})

test('sequences and repeats are a rule, not length', () => {
  // None of these sit on the common list (abcd1234 does — the list answers
  // first, and that is its own test above); these fall to the run detector.
  for (const pw of ['jklm4567', 'aaaaaaaaaaaa', 'abababababab']) {
    const s = assessPassword(pw)
    assert.equal(s.score, 0, `${pw} scored ${s.score}`)
    assert.equal(s.advice, 'patterns', `${pw} advised ${s.advice}`)
  }
})

test('a trailing year is a calendar, not four characters', () => {
  const year = assessPassword('Krakowiak2024')
  const same = assessPassword('KrakowiakXqwp'.slice(0, 13))
  assert.ok(year.bits < same.bits, `${year.bits} should be under ${same.bits}`)
})

test('short single-class is weak, long passphrases are strong', () => {
  // No dictionary here beyond the common list (a documented limit), so a
  // short lowercase word rates on length and class alone: at best average,
  // and told to grow.
  const word = assessPassword('korytarz')
  assert.ok(word.score <= 1, `scored ${word.score}`)
  assert.equal(word.advice, 'short')
  const phrase = assessPassword('korek maslo zima traktor')
  assert.equal(phrase.score, 3)
  assert.equal(phrase.advice, 'ok')
  assert.equal(assessPassword('Zielony-Rower-42').score, 3)
})

test('adding characters never weakens the estimate', () => {
  const base = 'Jesien'
  let prev = assessPassword(base).bits
  for (const more of ['Jesien!', 'Jesien!k', 'Jesien!kot', 'Jesien!kotWraca']) {
    const next = assessPassword(more).bits
    assert.ok(next >= prev, `${more}: ${next} < ${prev}`)
    prev = next
  }
})

test('deterministic, and the floor is the full meter', () => {
  assert.deepEqual(assessPassword('Zielony-Rower-42'), assessPassword('Zielony-Rower-42'))
  // Enforced since 2026-09-03: below this a password is REFUSED where one is
  // chosen (profile creation, change password). Moving this number changes
  // what the app accepts, so it is pinned here rather than left to the UI.
  assert.equal(ENFORCE_MIN, 3)
})

test('the floor refuses what a breach corpus is made of, and accepts a phrase', () => {
  // The two lists are the argument for the floor being the TOP bucket rather
  // than the first green one: what it turns away is the 8-to-11-character
  // shape, and what it costs everyone else is one more word.
  for (const pw of ['lubieplacki', 'M0jPies!', 'onchato2026', 'h4rdP4ss', 'Ka9!zQ']) {
    assert.ok(assessPassword(pw).score < ENFORCE_MIN, `${pw} would have been accepted`)
  }
  for (const pw of ['kot pies dom', 'zielonyRower', 'sobota-kawa', 'Zielona7Kanapa', 'poziomka lampa wiatr']) {
    assert.ok(assessPassword(pw).score >= ENFORCE_MIN, `${pw} would have been refused`)
  }
})

test('the harnesses can still create a profile', () => {
  // Copies of SOFT_PASS in net/browser-test.ts and net/phone-shot.ts. Both
  // walk the real creation form, so a floor they fail turns every browser
  // scenario and every screenshot into "the profile was not created" — with
  // nothing in the failure naming this rule. Tightening the estimator is
  // allowed; taking these two down with it silently is not.
  for (const pw of ['harness-passphrase', 'phone-shot-passphrase']) {
    assert.ok(assessPassword(pw).score >= ENFORCE_MIN, `${pw} no longer clears the floor`)
  }
})
