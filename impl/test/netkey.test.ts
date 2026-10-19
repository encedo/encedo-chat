import { test } from 'node:test'
import assert from 'node:assert/strict'
import { loadOrCreateNetKey, netPeerId } from '../lib/netkey.ts'
import { namesFromKey } from '../lib/storenames.ts'

function memKV() {
  const m = new Map<string, string>()
  return { get: (k: string) => m.get(k) ?? null, set: (k: string, v: string) => void m.set(k, v), remove: (k: string) => void m.delete(k), m }
}
const rnd = () => crypto.getRandomValues(new Uint8Array(32))

test('one stable key per identity: made once, the same PeerId on every later start, sealed at rest', async () => {
  const kv = memKV(), base = rnd(), names = await namesFromKey(rnd(), 'aa'.repeat(16))
  const a = await loadOrCreateNetKey(kv, base, names)
  const b = await loadOrCreateNetKey(kv, base, names)
  assert.ok(a && b)
  assert.equal(netPeerId(b!), netPeerId(a!), 'a restart changed the PeerId')
  assert.match(netPeerId(a!), /^12D3KooW/)
  const stored = kv.get(names.fixed.netkey)!
  assert.ok(stored && !stored.includes('{'), 'the key is stored in the clear')
})

test('two identities on one device are two devices to the node', async () => {
  const kv = memKV(), base = rnd()
  const a = await loadOrCreateNetKey(kv, base, await namesFromKey(rnd(), 'aa'.repeat(16)))
  const b = await loadOrCreateNetKey(kv, base, await namesFromKey(rnd(), 'bb'.repeat(16)))
  assert.notEqual(netPeerId(a!), netPeerId(b!))
})

test('a stored key that does not open is never replaced (that would lock the device out); no base, no key', async () => {
  const kv = memKV(), names = await namesFromKey(rnd(), 'aa'.repeat(16))
  await loadOrCreateNetKey(kv, rnd(), names)
  const before = kv.get(names.fixed.netkey)
  assert.equal(await loadOrCreateNetKey(kv, rnd(), names), null, 'opened under another base')
  assert.equal(kv.get(names.fixed.netkey), before, 'the unreadable key was overwritten')
  assert.equal(await loadOrCreateNetKey(memKV(), null, names), null)
})
