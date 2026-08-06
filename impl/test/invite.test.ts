/**
 * Invite links, and specifically what a hostile one is not allowed to do.
 *
 * The payload comes out of a URL somebody else composed, so every field is
 * attacker-chosen. The round trip is the easy half; the rest of this file is
 * the refusals.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { encodeInvite, decodeInvite, inviteLink, MAX_NAME } from '../lib/invite.ts'

const PUB = Buffer.alloc(32, 7).toString('base64')      // a well-formed 32-byte key
const SHORT = Buffer.alloc(16, 7).toString('base64')

test('an invite survives the round trip', () => {
  const got = decodeInvite('#' + encodeInvite({ pub: PUB, name: 'Alicja' }))
  assert.deepEqual(got, { pub: PUB, name: 'Alicja' })
})

test('the payload rides in the fragment, so the server never sees it', () => {
  // Not cosmetic: in the path or the query, the web host would log who invited
  // whom. The '#' is what keeps that off the server.
  const link = inviteLink('https://onchato.com', '/', { pub: PUB, name: 'Alicja' })
  assert.ok(link.includes('#i='), link)
  assert.equal(link.split('#')[0], 'https://onchato.com/')
})

test('the link is URL-safe — no +, / or = in the fragment', () => {
  // Those characters survive in practice but get mangled by chat apps and mail
  // clients that guess where a link ends, which is exactly how invites travel.
  // The payload only — the `i=` in front is the separator and its `=` is meant.
  const payload = encodeInvite({ pub: Buffer.alloc(32, 255).toString('base64'), name: 'Żółw' }).slice(2)
  assert.equal(/[+/=]/.test(payload), false, payload)
})

test('non-ASCII names come back intact', () => {
  const got = decodeInvite('#' + encodeInvite({ pub: PUB, name: 'Zażółć gęślą' }))
  assert.equal(got?.name, 'Zażółć gęślą')
})

test('a key of the wrong length is refused here, not inside an ECDH later', () => {
  const frag = 'i=' + Buffer.from(JSON.stringify({ p: SHORT, n: 'x' })).toString('base64url')
  assert.equal(decodeInvite('#' + frag), null)
})

test('a name is stripped of control characters and capped', () => {
  const nasty = 'Ala\n‮gnp.txt' + 'x'.repeat(200)
  const frag = 'i=' + Buffer.from(JSON.stringify({ p: PUB, n: nasty })).toString('base64url')
  const got = decodeInvite('#' + frag)
  assert.ok(got)
  assert.equal(/[\n‮]/.test(got!.name), false, got!.name)
  assert.ok(got!.name.length <= MAX_NAME)
})

test('a name that is only control characters is refused, not silently emptied', () => {
  const frag = 'i=' + Buffer.from(JSON.stringify({ p: PUB, n: '​‮\n' })).toString('base64url')
  assert.equal(decodeInvite('#' + frag), null)
})

test('rubbish in the fragment is null, never a throw', () => {
  // This runs on every page load, including fragments meant for something else.
  for (const h of ['', '#', '#debug=1', '#i=', '#i=!!!!', '#i=' + Buffer.from('[]').toString('base64url'),
                   '#i=' + Buffer.from('{"p":1,"n":2}').toString('base64url'),
                   '#i=' + Buffer.from('{"n":"only a name"}').toString('base64url')]) {
    assert.equal(decodeInvite(h), null, h)
  }
})

test('a fragment that is not ours is left alone', () => {
  assert.equal(decodeInvite('#access_token=abc'), null)
})
