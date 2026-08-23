/**
 * The quote a reply carries (`lib/quote.ts`) and what the codec does with it.
 *
 * Two properties are worth a test rather than a reading: the snippet is bounded
 * and never cuts a code point in half, and a `re` that does not decode costs
 * the QUOTE and not the message it rode in on — a reply whose decoration is
 * malformed still has to arrive as the sentence somebody wrote.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { makeQuote, quoteSnippet, isQuoteRef, QUOTE_MAX } from '../lib/quote.ts'
import { encodeEnvelope, decodeEnvelope, envMsg, envFile } from '../lib/envelope.ts'
import { pubHint } from '../lib/mentions.ts'
import { b64 } from '../lib/wc.ts'

const te = new TextEncoder()
const rt = (e: any) => decodeEnvelope(encodeEnvelope(e)) as any
const raw = (o: any) => decodeEnvelope(te.encode(JSON.stringify(o))) as any

test('a snippet is one line, bounded, and never half a character', () => {
  assert.equal(quoteSnippet('  a\n b\tc  '), 'a b c') // one line: a quote is drawn as one
  const long = 'ą'.repeat(QUOTE_MAX + 40)
  const cut = quoteSnippet(long)
  assert.equal([...cut].length, QUOTE_MAX + 1) // the ellipsis is the extra one
  assert.ok(cut.endsWith('…'))
  // Emoji are surrogate pairs: slicing by UTF-16 units would leave half of one,
  // which renders as a replacement character in somebody else's bubble.
  const emoji = '🌳'.repeat(QUOTE_MAX + 5)
  assert.ok([...quoteSnippet(emoji)].every((c) => c === '🌳' || c === '…'))
  assert.equal(quoteSnippet(''), '')
})

test('the author travels as a key hint, not a name', () => {
  const pub = b64(new Uint8Array([0x3a, 0x7f, 0x1c, 0x02, 0x99, 0x11]))
  const q = makeQuote('mid1', 'cześć', pub)
  assert.equal(q.au, '3a7f1c02')
  assert.equal(q.au, pubHint(pub))     // the same hint a mention of them would carry
  assert.ok(!JSON.stringify(q).includes('name'))
  assert.equal(makeQuote('mid1', 'x').au, undefined) // author unknown → no claim about one
})

test('isQuoteRef refuses what could not be rendered', () => {
  assert.ok(isQuoteRef({ id: 'a', text: '' }))
  assert.ok(isQuoteRef({ id: 'a', text: 'x', au: 'deadbeef' }))
  assert.ok(!isQuoteRef(null))
  assert.ok(!isQuoteRef({ text: 'x' }))                       // no id: nothing to point at
  assert.ok(!isQuoteRef({ id: '', text: 'x' }))
  assert.ok(!isQuoteRef({ id: 'a'.repeat(65), text: 'x' }))
  assert.ok(!isQuoteRef({ id: 'a', text: 'x'.repeat(401) }))   // an unbounded quote is not one
  assert.ok(!isQuoteRef({ id: 'a', text: 'x', au: 'ZZZZ' }))
  assert.ok(!isQuoteRef({ id: 'a', text: 'x', au: '3a7f1c0' })) // seven hex chars: not four bytes
})

test('a reply roundtrips through the envelope', () => {
  const q = makeQuote('abc123', 'the message being answered')
  const d = rt(envMsg(1, 'yes, that', 'plain', q))
  assert.equal(d.body, 'yes, that')
  assert.deepEqual(d.re, q)
  // A file answers a message the same way a sentence does.
  const meta = { cid: 'Qm1', name: 'a.txt', size: 3, mime: 'text/plain', key: 'AAAA', chunk: 4096, chunks: 1, alg: 'A256GCM-chunked-v1', re: q }
  assert.deepEqual(rt(envFile(2, meta as any)).re, q)
})

test('a message without a reply carries no field at all', () => {
  const d = rt(envMsg(1, 'plain talk'))
  assert.ok(!('re' in d)) // absent, not null: an old build sees exactly what it saw before
})

test('a broken quote loses itself, never the message', () => {
  const base = { v: 1, t: 'msg', id: 'x', ts: 1, seq: 1, body: 'the sentence', format: 'plain' }
  for (const bad of [{ text: 'no id' }, { id: 'a', text: 5 }, { id: 'a', text: 'x', au: 'nothex!!' }, 'not-an-object', 42]) {
    const d = raw({ ...base, re: bad })
    assert.equal(d?.body, 'the sentence', `a re of ${JSON.stringify(bad)} must not drop the message`)
    assert.equal(d.re, undefined)
  }
  // A file's quote is held to the same rule, and its own fields still are not:
  // a file missing its key is undecryptable and must not decode at all.
  const file = { v: 1, t: 'file', id: 'x', ts: 1, seq: 1, cid: 'Qm1', name: 'a.txt', size: 1, mime: 'text/plain', key: 'AAAA', chunk: 1, chunks: 1, alg: 'A256GCM-chunked-v1' }
  assert.equal(raw({ ...file, re: { id: 'a' } })?.name, 'a.txt')
  assert.equal(raw({ ...file, re: { id: 'a' } })?.re, undefined)
})
