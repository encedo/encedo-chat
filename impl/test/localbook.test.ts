/**
 * The signed local contact book, over a key-value store (PROTOCOL.md 4.4).
 *
 * bookmac.test.ts pins the primitive; this pins the policy around it - above
 * all the one the 2026-10-12 audit found missing: a book that has ever been
 * signed is never again accepted as "pre-MAC". Without that, swapping a key
 * did not need a forged MAC - a bare array was accepted and re-signed.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { openLocalBook, cacheBaseOf } from '../lib/localbook.ts'
import { generateX25519 } from '../lib/x25519.ts'
import { unpack } from '../lib/bookmac.ts'
import type { KV } from '../lib/migrate.ts'

const b64 = (u: Uint8Array) => btoa(String.fromCharCode(...u))
const memKV = (): KV & { dump(): Record<string, string> } => {
  const m = new Map<string, string>()
  return { keys: () => [...m.keys()], get: (k) => m.get(k) ?? null, set: (k, v) => { m.set(k, v) }, dump: () => Object.fromEntries(m) }
}
async function softId() {
  const k = await generateX25519()
  return { handle: 'x', pub: b64(k.pub), ecdh: async (p: string) => k.dh(Uint8Array.from(atob(p), (c) => c.charCodeAt(0))) }
}
const KID = '5954eb6d5a1dd906ec78fe9dae5645e3'
const BOOK = 'ec-local-contacts-' + KID
const REAL = 'iv3Q1qyn2LhfwPVy7UvnKi/f0yiqZLeY4GALWq5ilzA='
const MINE = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA='
const until = async (cond: () => boolean, ms = 2000) => { const t0 = Date.now(); while (!cond()) { if (Date.now() - t0 > ms) throw new Error('timed out: ' + cond.toString()); await new Promise((r) => setTimeout(r, 5)) } }

test('a fresh profile with a pre-MAC book is accepted, and the first write signs it', async () => {
  const kv = memKV(); const id = await softId(); const base = await cacheBaseOf(id, KID, kv)
  kv.set(BOOK, JSON.stringify([{ name: 'Ala', pub: REAL }]))
  const { book, verdict } = await openLocalBook(KID, kv, base)
  assert.equal(verdict, 'unsigned')
  assert.equal((await book.list())[0].pub, REAL)
  await book.add('Ola', MINE)
  await until(() => unpack(kv.get(BOOK)).mac !== null)
  assert.equal(kv.get(BOOK + '-signed'), '1', 'the marker lands with the signed text')
  const again = await openLocalBook(KID, kv, base)
  assert.equal(again.verdict, 'ok')
  assert.equal((await again.book.list()).length, 2)
})

test('once signed, a bare array put back in its place is tampering, not a pre-MAC book', async () => {
  const kv = memKV(); const id = await softId(); const base = await cacheBaseOf(id, KID, kv)
  const { book } = await openLocalBook(KID, kv, base)
  await book.add('Ala', REAL)
  await until(() => unpack(kv.get(BOOK)).mac !== null)
  // The attack: drop the MAC, swap the key. No forgery needed before this test.
  kv.set(BOOK, JSON.stringify([{ name: 'Ala', pub: MINE }]))
  const { book: b2, verdict } = await openLocalBook(KID, kv, base)
  assert.equal(verdict, 'tampered')
  assert.deepEqual(await b2.list(), [], 'a tampered book shows nothing')
  await assert.rejects(b2.add('X', MINE), /refusing to write over it/)
  assert.ok(kv.get(BOOK)!.includes(MINE), 'the evidence is left where it was')
})

test('a signed book from before the marker existed sets it on first open', async () => {
  const kv = memKV(); const id = await softId(); const base = await cacheBaseOf(id, KID, kv)
  const { book } = await openLocalBook(KID, kv, base)
  await book.add('Ala', REAL)
  await until(() => unpack(kv.get(BOOK)).mac !== null)
  kv.set(BOOK + '-signed', '') // as if written by a build that had no marker
  const kv2 = memKV(); for (const [k, v] of Object.entries(kv.dump())) if (k !== BOOK + '-signed') kv2.set(k, v)
  const { verdict } = await openLocalBook(KID, kv2, base)
  assert.equal(verdict, 'ok')
  assert.equal(kv2.get(BOOK + '-signed'), '1')
})

test('the plain text never touches storage: what lands is signed, or nothing', async () => {
  const kv = memKV(); const id = await softId(); const base = await cacheBaseOf(id, KID, kv)
  const { book } = await openLocalBook(KID, kv, base)
  await book.add('Ala', REAL)
  // Synchronously after the write: either the previous content (nothing) or the packed form.
  const now = kv.get(BOOK)
  assert.ok(now === null || unpack(now).mac !== null, 'no bare array was written ahead of the signature')
  assert.equal((await book.list()).length, 1, 'reads see the change at once')
  await until(() => unpack(kv.get(BOOK)).mac !== null)
})
