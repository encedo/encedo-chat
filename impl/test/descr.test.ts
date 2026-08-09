/**
 * The HEM DESCR records for an identity and a contact (`lib/descr.ts`, §4).
 *
 * What is worth pinning here is not the string concatenation — it is the three
 * rules that make the format survive contact with a person: the name is the tail
 * and may contain the delimiter, the budget is bytes and not characters, and the
 * owner comes first so an anchored prefix can scope a search to one identity.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  DESCR_MAX, LABEL_MAX, PEER_PREFIX,
  byteLen, sliceBytes, descrText, hemKid, kidToField, kidFromField,
  selfLabel, peerLabel, buildSelfDescr, parseSelfDescr, buildPeerDescr, parsePeerDescr, peerSearchPrefix,
} from '../lib/descr.ts'

const te = new TextEncoder()
const KID_A = '0123456789abcdef0123456789abcdef'
const KID_B = 'fedcba9876543210fedcba9876543210'

test('self: roundtrip, and a handle may contain the delimiter', () => {
  assert.deepEqual(parseSelfDescr(buildSelfDescr('Alice')), { handle: 'Alice' })
  // Nothing follows the handle, so a comma in it is just a comma.
  assert.deepEqual(parseSelfDescr(buildSelfDescr('Kowalski, Jan')), { handle: 'Kowalski, Jan' })
  assert.equal(parseSelfDescr('ETSEIC:self,Alice,ik,1700000000'), null, 'the previous format is not read')
  assert.equal(parseSelfDescr(null), null)
})

test('peer: the name is the tail, so commas and colons in it survive intact', () => {
  // This is the bug the format exists to make impossible: `split(',')[1]` turned
  // "Kowalski, Jan" into "Kowalski", and nothing anywhere reported it.
  const awkward = 'Kowalski, Jan: dom'
  const d = buildPeerDescr(KID_A, awkward)!
  assert.deepEqual(parsePeerDescr(d), { ownerKid: KID_A, name: awkward })
})

test('peer: the owner scopes a search, and a foreign one is told apart', () => {
  const mine = buildPeerDescr(KID_A, 'Bob')!
  const theirs = buildPeerDescr(KID_B, 'Bob')!
  assert.ok(mine.startsWith(peerSearchPrefix(KID_A)))
  assert.ok(!mine.startsWith(peerSearchPrefix(KID_B)))
  assert.ok(theirs.startsWith(peerSearchPrefix(KID_B)))
  // No owner = every identity's contacts: what the add path needs to see.
  assert.equal(peerSearchPrefix(), PEER_PREFIX)
  assert.ok(mine.startsWith(PEER_PREFIX) && theirs.startsWith(PEER_PREFIX))
})

test('a malformed owner yields no record at all, rather than an unowned one', () => {
  // A contact written under a broken owner is invisible to the identity that
  // owns it and to every other — worse than refusing to write it.
  assert.equal(buildPeerDescr('nonsense', 'Bob'), null)
  assert.equal(buildPeerDescr(KID_A.slice(0, 8), 'Bob'), null, 'a short KID is not a KID')
  assert.equal(parsePeerDescr(`${PEER_PREFIX}!!!!,Bob`), null)
  assert.equal(parsePeerDescr(`${PEER_PREFIX}AAAA,Bob`), null, 'right alphabet, wrong length')
  assert.equal(parsePeerDescr(`${PEER_PREFIX}${kidToField(KID_A)}`), null, 'no name field at all')
})

test('the budget is bytes, and a cut never splits a character', () => {
  // "ż" is one character and two bytes; an emoji is one code point and four.
  const long = 'ż'.repeat(200)
  const d = buildPeerDescr(KID_A, long)!
  assert.ok(byteLen(d) <= DESCR_MAX, `${byteLen(d)} bytes`)
  const back = parsePeerDescr(d)!
  assert.equal(back.ownerKid, KID_A)
  assert.ok(back.name.length > 0 && [...back.name].every((c) => c === 'ż'), 'no half characters')

  const emoji = buildPeerDescr(KID_A, '🌳'.repeat(60))!
  assert.ok(byteLen(emoji) <= DESCR_MAX)
  assert.ok([...parsePeerDescr(emoji)!.name].every((c) => c === '🌳'), 'surrogate pairs stay intact')

  const self = buildSelfDescr('ą'.repeat(200))
  assert.ok(byteLen(self) <= DESCR_MAX)
  assert.ok([...parseSelfDescr(self)!.handle].every((c) => c === 'ą'))

  assert.equal(sliceBytes('abc', 2), 'ab')
  assert.equal(sliceBytes('ąbc', 1), '', 'a two-byte character does not fit one byte')
})

test('a name that fits exactly is not trimmed', () => {
  const head = byteLen(`${PEER_PREFIX}${kidToField(KID_A)},`)
  const name = 'x'.repeat(DESCR_MAX - head)
  const d = buildPeerDescr(KID_A, name)!
  assert.equal(byteLen(d), DESCR_MAX)
  assert.equal(parsePeerDescr(d)!.name, name)
})

test('the NUL padding of a 128-byte field is not part of the text', () => {
  // What comes back from the device is the whole record, zeros and all.
  const padded = new Uint8Array(DESCR_MAX)
  const body = te.encode(buildPeerDescr(KID_A, 'Bob')!)
  padded.set(body)
  assert.deepEqual(parsePeerDescr(padded), { ownerKid: KID_A, name: 'Bob' })
  assert.equal(descrText(padded), buildPeerDescr(KID_A, 'Bob'))
  assert.deepEqual(parseSelfDescr(te.encode(buildSelfDescr('Alice') + '\0\0\0')), { handle: 'Alice' })
})

test('a KID survives the field encoding, and 22 characters is what it costs', () => {
  const f = kidToField(KID_A)!
  assert.equal(f.length, 22, 'base64url of 16 bytes, unpadded')
  assert.ok(!/[+/=]/.test(f), 'url alphabet, no padding — it sits in a delimited field')
  assert.equal(kidFromField(f), KID_A)
  assert.equal(kidFromField('short'), null)
})

test('hemKid is SHA-1(pub)[0:16] — the value the device itself would issue', async () => {
  // Fixed vector: SHA-1 of the 32 zero bytes, first 16 bytes.
  const kid = await hemKid(new Uint8Array(32))
  assert.equal(kid, 'de8a847bff8c343d69b853a215e6ee77')
  assert.equal(kid.length, 32)
})

test('labels are captions: prefixed, and cut to what firmware accepts', () => {
  assert.equal(selfLabel('Alice'), 'Onchato-IK-Alice')
  assert.equal(peerLabel('Bob'), 'Onchato-Peer-Bob')
  for (const l of [selfLabel('x'.repeat(60)), peerLabel('ż'.repeat(60))]) {
    assert.ok(byteLen(l) <= LABEL_MAX, `${l} = ${byteLen(l)} bytes`)
  }
  // The caption may lose most of the name; DESCR is what the client reads, and it
  // keeps as much as the field's remaining bytes allow — 92 of them here, so 46
  // two-byte characters.
  const room = DESCR_MAX - byteLen(`${PEER_PREFIX}${kidToField(KID_A)},`)
  assert.equal(room, 92)
  assert.equal(parsePeerDescr(buildPeerDescr(KID_A, 'ż'.repeat(60))!)!.name.length, room / 2)
})
