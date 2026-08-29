import { test } from 'node:test'
import assert from 'node:assert/strict'
import { signBook, checkBook, pack, unpack } from '../lib/bookmac.ts'

const base = new Uint8Array(32).fill(7)
const KID = '5954eb6d5a1dd906ec78fe9dae5645e3'
const book = (pub: string) => JSON.stringify([{ name: 'MVP-C1', pub }])
const REAL = 'iv3Q1qyn2LhfwPVy7UvnKi/f0yiqZLeY4GALWq5ilzA='
const MINE = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA='

test('a book we signed verifies', async () => {
  const body = book(REAL)
  const raw = pack(body, await signBook(base, KID, body))
  assert.deepEqual(await checkBook(base, KID, raw), { verdict: 'ok', body })
})

/**
 * The attack this exists for, in the form it actually takes.
 *
 * The contact book sat in localStorage as plain JSON. Anything that can write
 * that file — malware running as the user, someone with five minutes at the
 * keyboard, a restored backup — swaps one `pub` and the app then derives the
 * rendezvous with the attacker, handshakes with the attacker, and encrypts to
 * the attacker. Nothing below notices, because nothing below failed: every
 * layer worked perfectly on the key it was handed.
 */
test('a swapped public key does not verify', async () => {
  const mac = await signBook(base, KID, book(REAL))
  const swapped = pack(book(MINE), mac)
  assert.equal((await checkBook(base, KID, swapped)).verdict, 'tampered')
})

test('a name may not be edited either', async () => {
  const body = book(REAL)
  const mac = await signBook(base, KID, body)
  const renamed = pack(JSON.stringify([{ name: 'Bank', pub: REAL }]), mac)
  assert.equal((await checkBook(base, KID, renamed)).verdict, 'tampered')
})

/**
 * The signature is bound to the identity, so a book cannot be moved between
 * profiles by copying the file. Carrying contacts over is a thing the app will
 * do deliberately, by writing them under the new identity's own signature.
 */
test('a book signed by another identity does not verify here', async () => {
  const body = book(REAL)
  const raw = pack(body, await signBook(base, 'a-different-kid-entirely', body))
  assert.equal((await checkBook(base, KID, raw)).verdict, 'tampered')
})

test('a different identity secret does not verify either', async () => {
  const body = book(REAL)
  const raw = pack(body, await signBook(new Uint8Array(32).fill(9), KID, body))
  assert.equal((await checkBook(base, KID, raw)).verdict, 'tampered')
})

/**
 * ⚠️ The case that decides whether this can ship. Every book in the wild is
 * unsigned, and refusing them would lock people out of their own contacts to
 * introduce a security feature — a worse outcome than the risk being closed. So
 * an unsigned book is read, and signed on the next write.
 */
test('a book from before this existed is accepted, not refused', async () => {
  const body = book(REAL)
  assert.deepEqual(await checkBook(base, KID, body), { verdict: 'unsigned', body })
})

test('nothing stored at all is an empty unsigned book', async () => {
  for (const raw of [null, '', 'to nie jest json', '{"v":1}', '42']) {
    const r = await checkBook(base, KID, raw)
    assert.equal(r.verdict, 'unsigned', `dla ${JSON.stringify(raw)}`)
    assert.equal(r.body, '[]')
  }
})

test('a mac that is not even base64 is tampering, not a crash', async () => {
  assert.equal((await checkBook(base, KID, pack(book(REAL), '!!!not base64!!!'))).verdict, 'tampered')
})

/**
 * The signature covers the stored TEXT, verbatim. Recomputing it from a parsed
 * and re-serialised list would make the check depend on key order and escaping
 * agreeing forever, and its failure mode is a false accusation of tampering.
 */
test('the body is verified exactly as stored, whitespace included', async () => {
  const body = '[ {"name":"MVP-C1","pub":"' + REAL + '"} ]'
  const raw = pack(body, await signBook(base, KID, body))
  const r = await checkBook(base, KID, raw)
  assert.equal(r.verdict, 'ok')
  assert.equal(r.body, body, 'the caller must get back what was signed, not a reformat')
})

test('unpack tells a signed book from a bare list', () => {
  assert.deepEqual(unpack('[{"name":"a","pub":"b"}]'), { body: '[{"name":"a","pub":"b"}]', mac: null })
  assert.deepEqual(unpack(pack('[]', 'bWFj')), { body: '[]', mac: 'bWFj' })
})
