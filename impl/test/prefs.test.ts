import { test } from 'node:test'
import assert from 'node:assert/strict'
import { loadPrefs, savePrefs, PREFS_PREFIX, LEGACY } from '../lib/prefs.ts'
import { openLocal } from '../lib/localstore.ts'
import type { KV } from '../lib/migrate.ts'

const memKV = (): KV => { const m = new Map<string, string>(); return { keys: () => [...m.keys()], get: (k) => m.get(k) ?? null, set: (k, v) => { m.set(k, v) }, remove: (k) => { m.delete(k) } } }
const base = new Uint8Array(32).fill(3)
const KID = 'a'.repeat(32)

test('preferences round-trip sealed, and open for nobody else', async () => {
  const kv = memKV()
  await savePrefs(kv, base, KID, { notify: 'name', mediaAuto: true })
  const raw = kv.get(PREFS_PREFIX + KID)!
  assert.ok(raw && !raw.includes('name'), 'the stored blob is not the JSON')
  assert.deepEqual(await loadPrefs(kv, base, KID), { notify: 'name', mediaAuto: true })
  assert.equal(await openLocal(base, 'encedo-chat-prefs-v1', 'b'.repeat(32), raw), null, 'another identity cannot open it')
  assert.deepEqual(await loadPrefs(kv, base, 'b'.repeat(32)), {}, 'and sees nothing')
})

test('the plain keys of an older build are read once, sealed, and removed', async () => {
  const kv = memKV()
  kv.set(LEGACY.notify + KID, 'quiet'); kv.set(LEGACY.mediaAuto + KID, '1')
  assert.deepEqual(await loadPrefs(kv, base, KID), { notify: 'quiet', mediaAuto: true })
  assert.equal(kv.get(LEGACY.notify + KID), null); assert.equal(kv.get(LEGACY.mediaAuto + KID), null)
  assert.ok(kv.get(PREFS_PREFIX + KID), 'sealed in their place')
  assert.deepEqual(await loadPrefs(kv, base, KID), { notify: 'quiet', mediaAuto: true }, 'the second read comes from the seal')
})

test('a sealed value wins over a stale plain key; without a base nothing is sealed or removed', async () => {
  const kv = memKV()
  await savePrefs(kv, base, KID, { notify: 'off' })
  kv.set(LEGACY.notify + KID, 'name')
  assert.equal((await loadPrefs(kv, base, KID)).notify, 'off')
  assert.equal(kv.get(LEGACY.notify + KID), null, 'the stale key is still cleaned up')
  const kv2 = memKV(); kv2.set(LEGACY.mediaAuto + KID, '1')
  assert.deepEqual(await loadPrefs(kv2, null, KID), { mediaAuto: true }, 'honoured for the session')
  assert.equal(kv2.get(LEGACY.mediaAuto + KID), '1', 'but not removed: there is nowhere sealed to put it')
})
