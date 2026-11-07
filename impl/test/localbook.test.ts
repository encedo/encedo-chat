/**
 * The sealed local contact book, over a key-value store (SPEC.md 4.4, 10).
 *
 * localstore.test.ts pins the seal; this pins the policy around it. Two
 * properties carry the weight: the names and keys of whoever this identity
 * knows never reach storage in the clear - not on write and not left behind by
 * an older format - and a book that does not verify is `tampered`, kept as
 * evidence, never read as empty and never written over. Since 0.8.2 only the
 * sealed format is read: the plain and MAC'd formats of the builds before
 * 0.7.34 are `tampered` - an untouched old profile and a substitute look the
 * same.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { openLocalBook, cacheBaseOf } from '../lib/localbook.ts'
import { generateX25519 } from '../lib/x25519.ts'
import type { KV } from '../lib/migrate.ts'
import { namesFromKey, type Names } from '../lib/storenames.ts'
import { randomBytes } from '../lib/wc.ts'

const b64 = (u: Uint8Array) => btoa(String.fromCharCode(...u))
const memKV = (): KV & { dump(): Record<string, string>; writes: string[] } => {
  const m = new Map<string, string>()
  const writes: string[] = []
  return { keys: () => [...m.keys()], get: (k) => m.get(k) ?? null, set: (k, v) => { m.set(k, v); writes.push(v) }, dump: () => Object.fromEntries(m), writes }
}
async function softId() {
  const k = await generateX25519()
  return { handle: 'x', pub: b64(k.pub), ecdh: async (p: string) => k.dh(Uint8Array.from(atob(p), (c) => c.charCodeAt(0))) }
}
const KID = '5954eb6d5a1dd906ec78fe9dae5645e3'
const OTHER_KID = '0123456789abcdef0123456789abcdef'
// One identity's storage names for the whole file (lib/storenames.ts); BOOK is where its book lives.
const N: Names = await namesFromKey(randomBytes(32), KID)
const N2: Names = await namesFromKey(randomBytes(32), OTHER_KID)
const BOOK = N.fixed.book
const REAL = 'iv3Q1qyn2LhfwPVy7UvnKi/f0yiqZLeY4GALWq5ilzA='
const MINE = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA='
const until = async (cond: () => boolean, ms = 2000) => { const t0 = Date.now(); while (!cond()) { if (Date.now() - t0 > ms) throw new Error('timed out: ' + cond.toString()); await new Promise((r) => setTimeout(r, 5)) } }
const sealed = (raw: string | null) => { if (raw === null) return false; try { JSON.parse(raw); return false } catch { return true } }
/** No stored value may name a contact or carry its key - checked on EVERY write, not only the last. */
const leaks = (kv: ReturnType<typeof memKV>, ...needles: string[]) => kv.writes.filter((w) => needles.some((n) => w.includes(n)))

async function setup() {
  const kv = memKV(); const id = await softId(); const base = (await cacheBaseOf(id, N, kv))!
  return { kv, id, base }
}

test('only a sealed book is read: a bare array or a v1 signed book is tampered, kept as evidence, never written over', async () => {
  for (const plain of [
    JSON.stringify([{ name: 'Ala Nowak', pub: MINE }]),                                  // the pre-MAC bare array
    JSON.stringify({ v: 1, mac: 'AAAA', body: JSON.stringify([{ name: 'Ola', pub: MINE }]) }), // the v1 MAC'd packing
  ]) {
    const { kv, base } = await setup()
    kv.set(BOOK, plain)
    const { book, verdict } = await openLocalBook(N, kv, base)
    assert.equal(verdict, 'tampered', plain.slice(0, 30))
    assert.deepEqual(await book.list(), [], 'a tampered book shows nothing')
    await assert.rejects(book.add('X', MINE), /refusing to write over it/)
    assert.equal(kv.get(BOOK), plain, 'the evidence is left where it was')
  }
})

test('no book yet is an empty book, ok, and the first write seals it', async () => {
  const { kv, base } = await setup()
  const { book, verdict } = await openLocalBook(N, kv, base)
  assert.equal(verdict, 'ok')
  await book.add('Ala Nowak', REAL)
  await until(() => sealed(kv.get(BOOK)))
  assert.deepEqual(leaks(kv, 'Ala Nowak', REAL), [])
  const again = await openLocalBook(N, kv, base)
  assert.equal(again.verdict, 'ok')
  assert.deepEqual((await again.book.list()).map((c) => c.name), ['Ala Nowak'])
})

test('a sealed book that does not open is tampered, never an empty book that the next write seals over', async () => {
  const { kv, base } = await setup()
  const { book } = await openLocalBook(N, kv, base)
  await book.add('Ala Nowak', REAL)
  await until(() => sealed(kv.get(BOOK)))
  const good = kv.get(BOOK)!
  const raw = Uint8Array.from(atob(good), (c) => c.charCodeAt(0)); raw[raw.length - 1] ^= 1
  const flipped = b64(raw)
  for (const blob of [flipped, good.slice(0, 20), 'AAAA']) {
    kv.set(BOOK, blob)
    const r = await openLocalBook(N, kv, base)
    assert.equal(r.verdict, 'tampered', 'blob ' + blob.slice(0, 12))
    assert.deepEqual(await r.book.list(), [])
    await assert.rejects(r.book.add('X', MINE), /refusing to write over it/)
    assert.equal(kv.get(BOOK), blob)
  }
})

test('a book sealed for another identity does not open as this one', async () => {
  const { kv, base } = await setup()
  const other = await openLocalBook(N2, kv, base)
  await other.book.add('Cudzy Ktos', REAL)
  await until(() => sealed(kv.get(N2.fixed.book)))
  kv.set(BOOK, kv.get(N2.fixed.book)!)
  assert.equal((await openLocalBook(N, kv, base)).verdict, 'tampered')
})

test('the plain text never touches storage: what lands is sealed, or nothing', async () => {
  const { kv, base } = await setup()
  kv.writes.length = 0
  const { book } = await openLocalBook(N, kv, base)
  await book.add('Ala Nowak', REAL)
  const now = kv.get(BOOK)
  assert.ok(now === null || sealed(now), 'nothing plain was written ahead of the seal')
  assert.equal((await book.list()).length, 1, 'reads see the change at once')
  await until(() => sealed(kv.get(BOOK)))
  await book.rename((await book.list())[0], 'Alicja Lis')
  await until(() => kv.writes.length >= 2) // one sealed write per change (no marker since 0.8.2)
  assert.deepEqual(leaks(kv, 'Ala Nowak', 'Alicja Lis', REAL), [])
})

test('edits made in quick succession land in the order they were made', async () => {
  const { kv, base } = await setup()
  const { book } = await openLocalBook(N, kv, base)
  const keys = Array.from({ length: 6 }, (_, i) => b64(new Uint8Array(32).fill(i + 1)))
  for (const [i, k] of keys.entries()) void book.add('c' + i, k)
  await until(() => kv.writes.filter((w) => sealed(w)).length >= 6)
  await new Promise((r) => setTimeout(r, 20))
  const again = await openLocalBook(N, kv, base)
  assert.equal(again.verdict, 'ok')
  assert.deepEqual((await again.book.list()).map((c) => c.name), ['c0', 'c1', 'c2', 'c3', 'c4', 'c5'])
})

test('without an ECDH base the book still works, plain and unsigned', async () => {
  const kv = memKV()
  const { book, verdict } = await openLocalBook(N, kv, null)
  assert.equal(verdict, 'unsigned')
  await book.add('Ala Nowak', REAL)
  assert.deepEqual(JSON.parse(kv.get(BOOK)!), [{ name: 'Ala Nowak', pub: REAL }])
})
