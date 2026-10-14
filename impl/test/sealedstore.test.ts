/**
 * The sealed per-identity stores (SPEC.md 10): plain JSON is taken once, from
 * an older build, and never again.
 *
 * Before 2026-10-14 `readSealedKV` accepted plain JSON for ever, so the seal was
 * optional for anyone who can write the store - the downgrade the contact
 * book's marker had closed two days earlier. These pin the closing: sign-in
 * seals what is still plain and sets the identity's `sealed` record, after which a plain
 * value in a sealed store is ignored.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from '../lib/wc.ts'
import { readSealedKV, writeSealedKV, sealPlainStores, STORES, SALTS } from '../lib/sealedstore.ts'
import { namesFromKey } from '../lib/storenames.ts'
import { loadPrefs, LEGACY, PREFS_SALT } from '../lib/prefs.ts'
import { INVITES_SALT, WAITING_SALT, IGNORED_SALT } from '../cli/invites.ts'
import { OUTBOX_SALT } from '../cli/queue.ts'
import { LEFT_SALT } from '../lib/gleft.ts'

const KID = '5954eb6d5a1dd906ec78fe9dae5645e3'
const OTHER = '0123456789abcdef0123456789abcdef'
const BASE = randomBytes(32)
const N = await namesFromKey(randomBytes(32), KID)
const NO = await namesFromKey(randomBytes(32), OTHER)
const mem = (seed: Record<string, string> = {}) => {
  const m = new Map(Object.entries(seed))
  return { m, keys: () => [...m.keys()], get: (k: string) => m.get(k) ?? null, set: (k: string, v: string) => { m.set(k, v) }, remove: (k: string) => { m.delete(k) } }
}
const isJson = (s: string | null) => { try { JSON.parse(s ?? ''); return true } catch { return false } }

test('sign-in seals every store this identity still has in the clear, and only those', async () => {
  const plain = { [N.fixed.invites]: '[{"id":"a","secret":"s3cret"}]', [N.fixed.ignored]: '[{"fp":"AA:BB"}]', [N.fixed.seen]: '{"x":{"heard":1}}' }
  const kv = mem({ ...plain, [NO.fixed.invites]: '[{"id":"cudze"}]', 'ec-lang': 'pl' })
  await writeSealedKV(kv, BASE, N, 'waiting', [['pub', { inbox: 'i' }]])
  const blob = kv.get(N.fixed.waiting)
  assert.equal(await sealPlainStores(kv, BASE, N), 3)
  for (const k of Object.keys(plain)) assert.ok(!isJson(kv.get(k)), k + ' sealed')
  assert.equal(kv.get(N.fixed.waiting), blob, 'an already sealed store is not rewritten')
  assert.equal(kv.get(NO.fixed.invites), '[{"id":"cudze"}]', 'another identity is not ours to seal')
  assert.equal(kv.get(N.fixed.sealed), '1')
  assert.deepEqual(await readSealedKV(kv, BASE, N, 'invites', Array.isArray), [{ id: 'a', secret: 's3cret' }])
})

test('after the marker, a plain value put where a sealed store was is ignored', async () => {
  const kv = mem()
  await writeSealedKV(kv, BASE, N, 'ignored', [{ fp: 'AA:BB' }])
  await sealPlainStores(kv, BASE, N)
  // The downgrade: drop the blob, put back an empty list - "nobody is ignored".
  kv.set(N.fixed.ignored, '[]')
  const logs: string[] = []
  assert.equal(await readSealedKV(kv, BASE, N, 'ignored', Array.isArray, (m) => logs.push(m)), null)
  assert.ok(logs.some((l) => /plain JSON .* ignored/.test(l)), logs.join('|'))
})

test('before the marker an older build\'s plain store is still read, and without a base nothing is sealed', async () => {
  const kv = mem({ [N.fixed.gleft]: '{"g":{"epoch":2}}' })
  assert.deepEqual(await readSealedKV(kv, BASE, N, 'gleft', () => true), { g: { epoch: 2 } })
  assert.equal(await sealPlainStores(kv, null, N), 0)
  assert.equal(kv.get(N.fixed.sealed), null, 'no marker without a base - it would lock out stores nobody sealed')
  assert.equal(kv.get(N.fixed.gleft), '{"g":{"epoch":2}}')
})

test('the plain preference keys of an older build are folded before the marker and refused after it', async () => {
  const before = mem({ [LEGACY.mediaAuto + KID]: '1' })
  assert.equal((await loadPrefs(before, BASE, N)).mediaAuto, true)
  const after = mem({ [N.fixed.sealed]: '1', [LEGACY.mediaAuto + KID]: '1', [LEGACY.notify + KID]: 'full' })
  const p = await loadPrefs(after, BASE, N)
  assert.equal(p.mediaAuto, undefined, 'somebody switching auto-fetch on through the store is not obeyed')
  assert.equal(p.notify, undefined)
  assert.equal(after.get(LEGACY.mediaAuto + KID), null)
  assert.equal(after.get(LEGACY.notify + KID), null)
})

test('one list of stores and salts, and every module reads its salt from it', () => {
  assert.deepEqual([INVITES_SALT, WAITING_SALT, IGNORED_SALT, OUTBOX_SALT, PREFS_SALT, LEFT_SALT],
    [SALTS.invites, SALTS.waiting, SALTS.ignored, SALTS.outbox, SALTS.prefs, SALTS.gleft])
  assert.equal(new Set(Object.values(SALTS)).size, STORES.length, 'a salt per store, no two alike')
})
