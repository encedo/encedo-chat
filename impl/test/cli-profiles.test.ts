import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, statSync, writeFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileKV } from '../cli/store.ts'
import { createProfile, openProfile, listProfiles, exportProfileFile, importProfileFile, identityKey, softKey } from '../cli/profiles.ts'
import { browserSoftwareIdentity } from '../lib/core.ts'
import { seal, BadPassword } from '../lib/profile.ts'
import { exportProfile, openBundle, applyBundle, type KV } from '../lib/migrate.ts'
import { openLocalBook, cacheBaseOf } from '../lib/localbook.ts'

const PW = 'kot pies dom lampa'          // clears the full meter, like the harness password
const tmp = () => mkdtempSync(join(process.env.TMPDIR || tmpdir(), 'onchato-cli-'))
/** A browser's localStorage, as the app's code sees it. */
const browserKV = (): KV => { const m = new Map<string, string>(); return { keys: () => [...m.keys()], get: (k) => m.get(k) ?? null, set: (k, v) => { m.set(k, v) } } }
const settle = () => new Promise((r) => setTimeout(r, 100)) // the book's signature is written asynchronously

test('the store is private: directory 0700, file 0600, and a broken file is not overwritten', () => {
  const dir = join(tmp(), 'home')
  const kv = fileKV(dir)
  kv.set('ec-x', '1')
  assert.equal(statSync(dir).mode & 0o777, 0o700)
  assert.equal(statSync(kv.path).mode & 0o777, 0o600)
  assert.equal(fileKV(dir).get('ec-x'), '1', 'read back by a fresh instance')
  writeFileSync(kv.path, '{ not json')
  assert.throws(() => fileKV(dir), /not valid JSON/)
  assert.equal(readFileSync(kv.path, 'utf8'), '{ not json', 'the evidence stays')
})

test('a profile is created sealed, opens with its password, and refuses a wrong one or a weak one', async () => {
  const kv = fileKV(tmp())
  const made = await createProfile(kv, 'ala', PW)
  assert.deepEqual(listProfiles(kv), ['ala'])
  const raw = kv.get(softKey('ala'))!
  assert.ok(!raw.includes('"priv"') && !raw.includes('"d"'), 'no private key in the clear')
  assert.equal((await openProfile(kv, 'ala', PW)).pub, made.pub)
  await assert.rejects(openProfile(kv, 'ala', 'kot pies dom lampka'), BadPassword)
  await assert.rejects(createProfile(kv, 'ala', PW), /już tu jest/, 'a name is never overwritten')
  await assert.rejects(createProfile(kv, 'bob', 'haslo123'), /za słabe/)
  assert.deepEqual(listProfiles(kv), ['ala'], 'nothing written for the refused ones')
})

test('a browser profile with contacts moves to the CLI and opens with the same key and the same signed book', async () => {
  // The browser side, built with the app's own calls (app.ts sign-in + makeLocalBook + export).
  const web = browserKV()
  let generated = ''
  const wid = await browserSoftwareIdentity('ewa', () => null, (v) => { generated = v })
  web.set(softKey('ewa'), JSON.stringify(await seal(PW, generated)))
  const wkey = await identityKey(wid.pub)
  const wbook = await openLocalBook(wkey, web, await cacheBaseOf(wid, wkey, web))
  await wbook.book.add('vostro1', 'MTIzNDU2Nzg5MDEyMzQ1Njc4OTAxMjM0NTY3ODkwMTI=')
  await settle()
  const file = join(tmp(), 'ewa.ocmig')
  writeFileSync(file, JSON.stringify(await exportProfile(web, 'ewa', wkey, PW, Date.now())))

  // The CLI side.
  const kv = fileKV(tmp())
  assert.deepEqual(await importProfileFile(kv, file, PW).then((r) => r.name), 'ewa')
  const id = await openProfile(kv, 'ewa', PW)
  assert.equal(id.pub, wid.pub, 'the same identity, not a new key')
  const key = await identityKey(id.pub)
  const { book, verdict } = await openLocalBook(key, kv, await cacheBaseOf(id, key, kv))
  assert.equal(verdict, 'ok', 'the signature made in the browser checks in the terminal')
  assert.deepEqual((await book.list()).map((c) => c.name), ['vostro1'])
  await assert.rejects(importProfileFile(kv, file, PW), /już tu jest/, 'a second import does not merge')
  await assert.rejects(importProfileFile(fileKV(tmp()), file, 'zle haslo zle haslo'), BadPassword)
})

test('and back: a CLI profile exported to a file opens in the browser with its contacts', async () => {
  const kv = fileKV(tmp())
  const id = await createProfile(kv, 'ops', PW)
  const key = await identityKey(id.pub)
  const { book } = await openLocalBook(key, kv, await cacheBaseOf(id, key, kv))
  await book.add('admin', 'QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVowMTIzNDU=')
  await settle()
  const file = join(tmp(), 'ops.ocmig')
  await exportProfileFile(kv, 'ops', PW, file)
  assert.equal(statSync(file).mode & 0o777, 0o600, 'the move file is private too')

  const web = browserKV()
  applyBundle(web, await openBundle(JSON.parse(readFileSync(file, 'utf8')), PW)) // what the app's import does
  const sealed = JSON.parse(web.get(softKey('ops'))!)
  const { unseal } = await import('../lib/profile.ts')
  const inner = JSON.parse(await unseal(PW, sealed))
  assert.equal(inner.pub, id.pub, 'the browser holds the CLI identity')
  const opened = await browserSoftwareIdentity('ops', () => JSON.stringify(inner), () => {})
  const wbook = await openLocalBook(key, web, await cacheBaseOf(opened, key, web))
  assert.equal(wbook.verdict, 'ok')
  assert.deepEqual((await wbook.book.list()).map((c) => c.name), ['admin'])
})

test('a contact book edited in the file behind the CLI is caught, not believed', async () => {
  const kv = fileKV(tmp())
  const id = await createProfile(kv, 'ala', PW)
  const key = await identityKey(id.pub)
  const { book } = await openLocalBook(key, kv, await cacheBaseOf(id, key, kv))
  await book.add('vostro1', 'MTIzNDU2Nzg5MDEyMzQ1Njc4OTAxMjM0NTY3ODkwMTI=')
  await settle()
  // Someone with write access to store.json swaps the contact's key.
  const raw = kv.get('ec-local-contacts-' + key)!
  kv.set('ec-local-contacts-' + key, raw.replace('MTIzNDU2', 'QUFBQUFB'))
  const again = await openLocalBook(key, kv, await cacheBaseOf(id, key, kv))
  assert.equal(again.verdict, 'tampered')
  await assert.rejects(again.book.add('x', 'QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVowMTIzNDU='), /refusing to write over it/, 'the evidence is not overwritten')
})
