/**
 * The sealed per-identity stores (SPEC.md 10): only a sealed blob of this
 * identity is read. Plain JSON in its place - the format before 0.7.34, whose
 * reader went in 0.8.2 - is ignored, so the seal is not optional for anybody
 * who can write the store.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from '../lib/wc.ts'
import { readSealedKV, writeSealedKV, STORES, SALTS } from '../lib/sealedstore.ts'
import { namesFromKey } from '../lib/storenames.ts'
import { PREFS_SALT } from '../lib/prefs.ts'
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

test('a sealed store round-trips for its identity and opens for nobody else', async () => {
  const kv = mem()
  await writeSealedKV(kv, BASE, N, 'invites', [{ id: 'a', secret: 's3cret' }])
  assert.ok(!isJson(kv.get(N.fixed.invites)), 'what lands is sealed')
  assert.deepEqual(await readSealedKV(kv, BASE, N, 'invites', Array.isArray), [{ id: 'a', secret: 's3cret' }])
  kv.set(NO.fixed.invites, kv.get(N.fixed.invites)!)
  assert.equal(await readSealedKV(kv, BASE, NO, 'invites', Array.isArray), null, 'sealed for another identity: does not open')
  assert.equal(await readSealedKV(kv, BASE, N, 'invites', (v) => !Array.isArray(v)), null, 'opened but not the expected shape: ignored')
})

test('plain JSON where a sealed store goes is ignored, never read; without a base nothing is opened or written', async () => {
  const logs: string[] = []
  const kv = mem({ [N.fixed.ignored]: '[]', [N.fixed.gleft]: '{"g":{"epoch":2}}' })
  assert.equal(await readSealedKV(kv, BASE, N, 'ignored', Array.isArray, (m) => logs.push(m)), null, 'the downgrade: "nobody is ignored" is not obeyed')
  assert.equal(await readSealedKV(kv, BASE, N, 'gleft', () => true), null, 'an old plain store is not read')
  assert.ok(logs.some((l) => /not a sealed record/.test(l)), logs.join('|'))
  assert.equal(await readSealedKV(kv, null, N, 'gleft', () => true), null)
  await writeSealedKV(kv, null, N, 'seen', { x: 1 })
  assert.equal(kv.get(N.fixed.seen), null, 'no base, no write - never plaintext')
})

test('one list of stores and salts, and every module reads its salt from it', () => {
  assert.deepEqual([INVITES_SALT, WAITING_SALT, IGNORED_SALT, OUTBOX_SALT, PREFS_SALT, LEFT_SALT],
    [SALTS.invites, SALTS.waiting, SALTS.ignored, SALTS.outbox, SALTS.prefs, SALTS.gleft])
  assert.equal(new Set(Object.values(SALTS)).size, STORES.length, 'a salt per store, no two alike')
})
