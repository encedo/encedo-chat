/**
 * "@somebody" in a group message.
 *
 * The body is plain text and stays plain text; this module returns ranges. What
 * it decides is WHO a mention means, and that decision is deliberately narrow:
 * a hint that is not exactly one member of this group's roster stays a word.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { b64 } from '../lib/wc.ts'
import { findMentions, splitByMentions, pubHint, mentionText, mentionName, resolveMention, closeMentions, mentionsPub } from '../lib/mentions.ts'

/** A public key whose first four bytes are known, so the hint is predictable. */
const keyOf = (a: number, b: number, c: number, d: number): string =>
  b64(Uint8Array.from([a, b, c, d, ...Array.from({ length: 28 }, (_, i) => i)]))

const ALA = keyOf(0x3a, 0x7f, 0x1c, 0x02)
const BOB = keyOf(0xff, 0x00, 0x11, 0x22)

test('the hint is the first four bytes of the key, in hex', () => {
  assert.equal(pubHint(ALA), '3a7f1c02')
  assert.equal(mentionText('Ala', ALA), '@Ala#3a7f1c02')
})

test('the token that travels is found again, with its offsets', () => {
  const t = 'hej @Ala#3a7f1c02 popatrz'
  const [m] = findMentions(t)
  assert.equal(m.text, '@Ala#3a7f1c02')
  assert.equal(t.slice(m.start, m.end), m.text)
  assert.equal(m.name, 'Ala')
  assert.equal(m.hint, '3a7f1c02')
})

test('two mentions in a row stay two mentions', () => {
  const found = findMentions('@Ala#3a7f1c02 @Bob#ff001122 co wy na to')
  assert.deepEqual(found.map((m) => m.hint), ['3a7f1c02', 'ff001122'])
})

test('a name with a space survives; the sentence around it does not get eaten', () => {
  const [m] = findMentions('pytaj @Ala Nowak#3a7f1c02, ona wie')
  assert.equal(m.name, 'Ala Nowak')
  assert.equal(m.text, '@Ala Nowak#3a7f1c02')
})

test('an email address is not a mention of whoever follows the @', () => {
  assert.equal(findMentions('pisz na ala@example.com#3a7f1c02').length, 0)
})

test('a hint outside the roster resolves to nobody — the UI leaves it as text', () => {
  // The claim "this person is here" is one a message does not get to make.
  assert.equal(resolveMention('deadbeef', [ALA, BOB]), null)
  assert.equal(resolveMention('3a7f1c02', [ALA, BOB]), ALA)
})

test('two members sharing a hint refuse, rather than pick one', () => {
  const twin = b64(Uint8Array.from([0x3a, 0x7f, 0x1c, 0x02, 9, 9, 9, 9]))
  assert.equal(resolveMention('3a7f1c02', [ALA, twin]), null)
})

test('splitByMentions covers the whole string, in order', () => {
  const t = 'a @Ala#3a7f1c02 b @Bob#ff001122'
  assert.equal(splitByMentions(t).map((p) => p.text).join(''), t)
  assert.deepEqual(splitByMentions(t).filter((p) => p.mention).map((p) => p.mention!.name), ['Ala', 'Bob'])
  assert.deepEqual(splitByMentions('bez wzmianek'), [{ text: 'bez wzmianek' }])
})

test('a hand-typed @name is finished on the way out', () => {
  const roster = [{ pub: ALA, name: 'Ala' }, { pub: BOB, name: 'Bob' }]
  assert.equal(closeMentions('hej @Ala, widzisz?', roster), 'hej @Ala#3a7f1c02, widzisz?')
  assert.equal(closeMentions('@Ala i @Bob', roster), '@Ala#3a7f1c02 i @Bob#ff001122')
  // The longest name that fits wins, so a member called "Ala Nowak" is not
  // mentioned as the other member called "Ala".
  const both = [{ pub: ALA, name: 'Ala' }, { pub: BOB, name: 'Ala Nowak' }]
  assert.equal(closeMentions('@Ala Nowak zerknij', both), '@Ala Nowak#ff001122 zerknij')
})

test('two members with the same name are left alone, not guessed', () => {
  const twins = [{ pub: ALA, name: 'Ala' }, { pub: BOB, name: 'Ala' }]
  assert.equal(closeMentions('@Ala halo', twins), '@Ala halo')
})

test('a token that is already complete is not touched twice', () => {
  const roster = [{ pub: ALA, name: 'Ala' }]
  const once = closeMentions('@Ala tak', roster)
  assert.equal(closeMentions(once, roster), once)
})

test('a mention of somebody who is not a contact of the sender still travels', () => {
  // Empty name: the reader has their own name for the key anyway.
  assert.equal(mentionText('', ALA), '@#3a7f1c02')
  const [m] = findMentions('popatrz @#3a7f1c02')
  assert.equal(m.name, '')
  assert.equal(m.hint, '3a7f1c02')
})

test('mentionsPub answers the only question the unread mark asks', () => {
  assert.ok(mentionsPub('no i @Ala#3a7f1c02 ?', ALA))
  assert.ok(!mentionsPub('no i @Ala#3a7f1c02 ?', BOB))
  assert.ok(!mentionsPub('zwykła wiadomość', ALA))
})

test('what the picker pointed at settles a tie its name cannot', () => {
  // Two members called Ala: the sentence alone is ambiguous, the click is not.
  const twins = [{ pub: ALA, name: 'Ala' }, { pub: BOB, name: 'Ala' }]
  const picked = new Map([['ala', BOB]])
  assert.equal(closeMentions('@Ala halo', twins, picked), '@Ala#ff001122 halo')
  // ...and it settles nothing else: an unpicked name is still resolved from the
  // roster, or left alone.
  assert.equal(closeMentions('@Ala halo', twins, new Map([['bob', BOB]])), '@Ala halo')
})

test('the name the picker writes is the name closeMentions looks for', () => {
  // A contact called "A#B @C" would otherwise be written into the composer in a
  // form the parser can never read back.
  const odd = [{ pub: ALA, name: 'A#B @C' }]
  const written = '@' + mentionName(odd[0].name)
  assert.equal(written, '@AB C')
  assert.equal(closeMentions(written + ' halo', [{ pub: ALA, name: mentionName(odd[0].name) }]), '@AB C#3a7f1c02 halo')
})
