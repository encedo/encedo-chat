import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { parseNetworkProfile } from '../lib/network.ts'
import { registerNetwork, signNetwork, rootPubFor } from '../lib/netprofile.ts'
import {
  builtinNetwork, networkById, resolveActive, bindingOf, setBinding, setLastNet, nodesKey, transportKey,
  softBindingKey, hemBindingKey, LAST_NET_KEY, autoRefreshNetwork,
} from '../lib/activenet.ts'

const NOW = 1_800_000_000_000
const DAY = 86_400_000
const KEY = Buffer.from(new Uint8Array(32).fill(5)).toString('base64')
const ADDR = '/dns4/n1.acme.example/tcp/443/wss/http-path/%2Frelay/p2p/12D3KooWLcDzqtSAetckwdzzqYbLTsN6wHFx8T4uKr5Yn1GUvSt5'
const NET = parseNetworkProfile(JSON.parse(readFileSync(new URL('../../infra/network.json', import.meta.url), 'utf8')))
const PUBLISHED = JSON.parse(readFileSync(new URL('../../infra/nodes.json', import.meta.url), 'utf8')).nodes
const builtin = builtinNetwork(NET, PUBLISHED)

function memKV() {
  const m = new Map<string, string>()
  return { get: (k: string) => m.get(k) ?? null, set: (k: string, v: string) => void m.set(k, v), remove: (k: string) => void m.delete(k), m }
}
const acme = (seq = 1, nodes = [{ name: 'n1', addr: ADDR }], key = KEY) => signNetwork({
  v: 1, networkId: 'acme', operator: 'ACME S.A.', rootPub: rootPubFor(key), seq, made: NOW - DAY, expires: NOW + 90 * DAY,
  nodes, stores: ['https://files.acme.example'], app: { origin: 'https://chat.acme.example', path: '/' },
  profileUrls: ['https://acme.example/onchato/network.json'], feedback: null, home: 'https://acme.example/', policy: {},
}, key)

test('a fresh device is in the built-in network, on the keys it always used', () => {
  const kv = memKV()
  const a = resolveActive(kv, builtin, NOW)
  assert.equal(a, builtin)
  assert.equal(a.id, 'main')
  assert.equal(nodesKey(a), 'ec-nodes')
  assert.equal(transportKey(a), 'ec-transport')
  assert.equal(bindingOf(kv, softBindingKey('ala'), builtin), 'main')
})

test('the page opens in the network the last identity signed in to; its node list has its own key', () => {
  const kv = memKV()
  assert.ok(registerNetwork(kv, acme(), NOW).ok)
  setLastNet(kv, 'acme', builtin)
  const a = resolveActive(kv, builtin, NOW)
  assert.equal(a.id, 'acme')
  assert.equal(a.builtin, false)
  assert.equal(a.feedback, null)
  assert.equal(a.nodes[0].addr, ADDR)
  assert.equal(nodesKey(a), 'ec-nodes:acme')
  assert.equal(transportKey(a), 'ec-transport:acme')
})

test('a last network that is gone from this device falls back to the built-in one', () => {
  const kv = memKV()
  kv.set(LAST_NET_KEY, 'nowhere')
  assert.equal(resolveActive(kv, builtin, NOW), builtin)
  assert.equal(networkById(kv, 'nowhere', builtin, NOW), null)
})

test('bindings: the built-in network is the ABSENCE of a record, any other is written down', () => {
  const kv = memKV()
  setBinding(kv, softBindingKey('ala'), 'acme', builtin)
  setBinding(kv, hemBindingKey('0123abcd'), 'main', builtin)
  assert.equal(kv.get('ec-soft-net-ala'), 'acme')
  assert.equal(kv.get('ec-hem-net-0123abcd'), null)
  setBinding(kv, softBindingKey('ala'), 'main', builtin)
  assert.equal(kv.get('ec-soft-net-ala'), null)
  setLastNet(kv, 'acme', builtin); assert.equal(kv.get(LAST_NET_KEY), 'acme')
  setLastNet(kv, 'main', builtin); assert.equal(kv.get(LAST_NET_KEY), null)
})

// ---- the quiet refresh ------------------------------------------------------
const ADDR2 = ADDR.replace('n1.acme', 'n2.acme')
const serving = (env: unknown) => (async () => new Response(JSON.stringify(env))) as any as typeof fetch

function joined() {
  const kv = memKV()
  assert.ok(registerNetwork(kv, acme(), NOW).ok)
  setLastNet(kv, 'acme', builtin)
  return { kv, n: resolveActive(kv, builtin, NOW) }
}

test('the quiet refresh takes a newer profile, and a kept list that IS the old profile follows it', async () => {
  const { kv, n } = joined()
  kv.set(nodesKey(n), JSON.stringify([{ name: 'n1', addr: ADDR, enabled: true }]))
  const r = await autoRefreshNetwork(kv, n, NOW, serving(acme(2, [{ name: 'n2', addr: ADDR2 }])))
  assert.ok(r.changed && r.nodesFollowed && r.profile.seq === 2)
  assert.deepEqual(JSON.parse(kv.get(nodesKey(n))!).map((x: any) => x.addr), [ADDR2])
  assert.equal(networkById(kv, 'acme', builtin, NOW)!.nodes[0].addr, ADDR2, 'the next load starts from the new profile')
})

test('a list the person edited is left alone; nothing kept means nothing to rewrite', async () => {
  for (const kept of [[{ name: 'mine', addr: ADDR2, enabled: true }], [{ name: 'n1', addr: ADDR, enabled: false }], null]) {
    const { kv, n } = joined()
    if (kept) kv.set(nodesKey(n), JSON.stringify(kept))
    const r = await autoRefreshNetwork(kv, n, NOW, serving(acme(2, [{ name: 'n3', addr: ADDR2.replace('n2', 'n3') }])))
    assert.ok(r.changed && !r.nodesFollowed)
    assert.equal(kv.get(nodesKey(n)), kept ? JSON.stringify(kept) : null)
  }
})

test('the quiet refresh refuses what the button refuses: another key, an older seq; the built-in network asks nobody', async () => {
  const { kv, n } = joined()
  const OTHER = Buffer.from(new Uint8Array(32).fill(9)).toString('base64')
  const forged = await autoRefreshNetwork(kv, n, NOW, serving(acme(5, [{ name: 'x', addr: ADDR2 }], OTHER)))
  assert.deepEqual(forged, { changed: false, why: 'key' })
  assert.ok(registerNetwork(kv, acme(3), NOW).ok)
  const old = await autoRefreshNetwork(kv, n, NOW, serving(acme(2)))
  assert.deepEqual(old, { changed: false, why: 'rollback' })
  let asked = false
  assert.deepEqual(await autoRefreshNetwork(kv, builtin, NOW, (async () => { asked = true; return new Response('') }) as any), { changed: false })
  assert.equal(asked, false)
})

test('the same version served again changes nothing, not even a kept list', async () => {
  const { kv, n } = joined()
  const kept = JSON.stringify([{ name: 'n1', addr: ADDR, enabled: true }])
  kv.set(nodesKey(n), kept)
  assert.deepEqual(await autoRefreshNetwork(kv, n, NOW, serving(acme(1, [{ name: 'n2', addr: ADDR2 }]))), { changed: false })
  assert.equal(kv.get(nodesKey(n)), kept)
})
