import { test } from 'node:test'
import assert from 'node:assert/strict'
import { loadPrefs, savePrefs } from '../lib/prefs.ts'
import { namesFromKey } from '../lib/storenames.ts'
import { openLocal } from '../lib/localstore.ts'
import type { KV } from '../lib/migrate.ts'

const memKV = (): KV => { const m = new Map<string, string>(); return { keys: () => [...m.keys()], get: (k) => m.get(k) ?? null, set: (k, v) => { m.set(k, v) }, remove: (k) => { m.delete(k) } } }
const base = new Uint8Array(32).fill(3)
const KID = 'a'.repeat(32)
const N = await namesFromKey(new Uint8Array(32).fill(7), KID)
const NB = await namesFromKey(new Uint8Array(32).fill(7), 'b'.repeat(32))

test('preferences round-trip sealed, and open for nobody else', async () => {
  const kv = memKV()
  await savePrefs(kv, base, N, { notify: 'name', mediaAuto: true })
  const raw = kv.get(N.fixed.prefs)!
  assert.ok(raw && !raw.includes('name'), 'the stored blob is not the JSON')
  assert.deepEqual(await loadPrefs(kv, base, N), { notify: 'name', mediaAuto: true })
  assert.equal(await openLocal(base, 'encedo-chat-prefs-v1', 'b'.repeat(32), raw), null, 'another identity cannot open it')
  assert.deepEqual(await loadPrefs(kv, base, NB), {}, 'and sees nothing')
})

test('only the sealed blob counts: the plain keys of a build before 0.7.34 are not read; no base is all defaults', async () => {
  const kv = memKV()
  kv.set('ec-notify-' + KID, 'quiet'); kv.set('ec-autoimg-' + KID, '1')
  assert.deepEqual(await loadPrefs(kv, base, N), {}, 'somebody switching auto-fetch on through the store is not obeyed')
  await savePrefs(kv, base, N, { notify: 'off' })
  assert.deepEqual(await loadPrefs(kv, base, N), { notify: 'off' })
  assert.deepEqual(await loadPrefs(kv, null, N), {}, 'no base: nothing can be opened, the defaults hold')
})
