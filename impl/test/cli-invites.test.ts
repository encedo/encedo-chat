import { test } from 'node:test'
import assert from 'node:assert/strict'
import { InviteStore, parseDuration, expired, INVITES_SALT, publishedLink, type PubInvite } from '../cli/invites.ts'
import { readSealedKV, writeSealedKV } from '../lib/sealedstore.ts'
import { decodeInvite } from '../lib/invite.ts'
import { inviteKey } from '../lib/inbox.ts'
import { generateX25519 } from '../lib/x25519.ts'
import { kdf } from '../lib/wc.ts'
import type { KV } from '../lib/migrate.ts'
import { namesFromKey } from '../lib/storenames.ts'

const memKV = (): KV => { const m = new Map<string, string>(); return { keys: () => [...m.keys()], get: (k) => m.get(k) ?? null, set: (k, v) => { m.set(k, v) } } }
const base = crypto.getRandomValues(new Uint8Array(32)), kid = 'a1b2c3d4e5f60718'
const N = await namesFromKey(crypto.getRandomValues(new Uint8Array(32)), kid)

test('an invite the app sealed is read by the CLI, and one the CLI made is read the way the app reads it', async () => {
  const kv = memKV()
  const appInv: PubInvite = { id: 'app00001', label: 'z aplikacji', secret: 'c2VjcmV0c2VjcmV0c2VjcmV0c2VjcmV0c2VjcmV0MDA=', created: 1 }
  await writeSealedKV(kv, base, N, 'invites', [appInv])   // app.ts writeSealed
  assert.ok(!kv.get(N.fixed.invites)!.includes('z aplikacji'), 'sealed, not plain')
  const store = new InviteStore(kv, base, N)
  assert.deepEqual((await store.invites()).map((i) => i.label), ['z aplikacji'])
  await store.create('z terminala', 3_600_000, 1000)
  const asApp = await readSealedKV<PubInvite[]>(kv, base, N, 'invites', Array.isArray) // app.ts readSealed
  assert.deepEqual(asApp!.map((i) => i.label), ['z terminala', 'z aplikacji'], 'newest first, as the app lists them')
  assert.equal(asApp![0].expires, 1000 + 3_600_000)
  assert.equal(await store.revoke(asApp![1].id), true)
  assert.deepEqual((await store.invites()).map((i) => i.label), ['z terminala'])
  assert.equal(await store.revoke('nope'), false)
})

test('a store from before sealing (plain JSON) is still read; another identity\'s key cannot open it', async () => {
  const kv = memKV()
  kv.set(N.fixed.invites, JSON.stringify([{ id: 'old', label: 'stare', secret: 'x', created: 1 }]))
  assert.equal((await new InviteStore(kv, base, N).invites())[0].label, 'stare')
  const kv2 = memKV()
  await writeSealedKV(kv2, base, N, 'invites', [{ id: 'z', label: 'tajne', secret: 's', created: 1 }])
  const other = crypto.getRandomValues(new Uint8Array(32))
  assert.deepEqual(await new InviteStore(kv2, other, N).invites(), [], 'a different §10 key opens nothing')
})

test('the waiting knocks and the ignore list round-trip in the app\'s shapes', async () => {
  const store = new InviteStore(memKV(), base, N)
  await store.saveWaiting(new Map([['pubA', { inbox: 'in', name: 'ala', since: 5 }]]))
  assert.deepEqual([...(await store.waiting())], [['pubA', { inbox: 'in', name: 'ala', since: 5 }]])
  await store.ignore('AA:BB'); await store.ignore('AA:BB')
  assert.deepEqual((await store.ignored()).map((r) => r.fp), ['AA:BB'], 'ignoring twice keeps one entry')
})

test('the published link carries the inbox and the invite key the watch opens with; durations and expiry', async () => {
  const inv: PubInvite = { id: 'i', label: 'l', secret: newSecret(), created: 0, expires: 100 }
  const me = await generateX25519()
  const id = { pub: btoa(String.fromCharCode(...me.pub)), handle: 'ala', ecdh: async (p: string) => me.dh(Uint8Array.from(atob(p), (c) => c.charCodeAt(0))) }
  const got = decodeInvite((await publishedLink('https://app.onchato.com', '/', id, inv)).split('#')[1])
  assert.equal(got?.inbox, inv.secret)
  // The same key the inbox watch derives from this identity - not the identity key.
  const want = await inviteKey(Uint8Array.from(atob(inv.secret), (c) => c.charCodeAt(0)), async (l, c, n) => kdf(l, await me.dh(me.pub), c, n))
  assert.equal(got?.key, btoa(String.fromCharCode(...want.pub)))
  assert.notEqual(got?.key, id.pub)
  assert.equal(parseDuration('30m'), 1_800_000); assert.equal(parseDuration('24h'), 86_400_000); assert.equal(parseDuration('7d'), 604_800_000)
  for (const bad of ['', '0h', '5', '2w', '-1h']) assert.throws(() => parseDuration(bad))
  assert.equal(expired(inv, 99), false); assert.equal(expired(inv, 100), true)
  assert.equal(expired({ ...inv, expires: undefined }, 1e15), false, 'no term, never expires')
})
function newSecret() { return btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32)))) }
