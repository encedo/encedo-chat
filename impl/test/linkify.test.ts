/**
 * Finding URLs in a message body — and refusing the ones that are traps.
 *
 * The body is plain text and stays plain text; this module returns ranges, so
 * no path here can produce markup. What it decides is which URLs the UI is
 * allowed to offer to open, and that decision is the security boundary: the
 * message came from someone else.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { findLinks, splitByLinks } from '../lib/linkify.ts'

test('finds plain http and https URLs', () => {
  const l = findLinks('zobacz https://onchato.com/a i http://example.org')
  assert.equal(l.length, 2)
  assert.equal(l[0].text, 'https://onchato.com/a')
  assert.ok(l[0].href && !l[0].warn)
  assert.equal(l[1].text, 'http://example.org')
})

test('a URL at the end of a sentence does not eat the punctuation', () => {
  assert.equal(findLinks('tu: https://a.example/b.')[0].text, 'https://a.example/b')
  assert.equal(findLinks('(https://a.example/x)')[0].text, 'https://a.example/x')
  // ...but a bracket that is part of the URL stays part of it.
  assert.equal(findLinks('https://a.example/wiki/X_(Y)')[0].text, 'https://a.example/wiki/X_(Y)')
})

test('only http and https — a message does not get to propose anything else', () => {
  for (const s of ['javascript:alert(1)', 'data:text/html,<script>', 'file:///etc/passwd', 'ftp://x.example']) {
    assert.equal(findLinks(`klik ${s} tutaj`).length, 0, `${s} must not be offered`)
  }
})

test('credentials in the authority are refused, not opened', () => {
  // Reads as the bank, goes to the attacker. There is no honest use of this here.
  const [l] = findLinks('https://bank.example.com@attacker.tld/login')
  assert.equal(l.warn, 'credentials')
  assert.equal(l.href, undefined, 'refused URLs carry no href for the UI to use')
})

test('a non-ASCII host is flagged with what the browser will really resolve', () => {
  const [l] = findLinks('https://аpple.com/x') // Cyrillic а
  assert.equal(l.warn, 'idn')
  assert.ok(l.asciiHost?.startsWith('xn--'), `expected punycode, got ${l.asciiHost}`)
  assert.ok(l.href, 'still openable — flagged, not refused')
})

test('an ASCII host is not flagged', () => {
  assert.equal(findLinks('https://apple.com/x')[0].warn, undefined)
})

test('bare hosts are NOT linked — guessing a scheme is guessing intent', () => {
  assert.equal(findLinks('wejdź na www.example.com albo example.com').length, 0)
})

test('splitByLinks covers the whole body, in order', () => {
  const body = 'a https://x.example b https://y.example c'
  const parts = splitByLinks(body)
  assert.equal(parts.map((p) => p.text).join(''), body, 'nothing is dropped or duplicated')
  assert.deepEqual(parts.filter((p) => p.link).map((p) => p.text), ['https://x.example', 'https://y.example'])
})

test('a body with no URL is one plain piece', () => {
  assert.deepEqual(splitByLinks('bez linków'), [{ text: 'bez linków' }])
})
