import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { parseNetworkProfile } from '../lib/network.ts'
import { registerNetwork, signNetwork, rootPubFor } from '../lib/netprofile.ts'
import {
  builtinNetwork, networkById, resolveActive, bindingOf, setBinding, setLastNet, nodesKey, transportKey,
  softBindingKey, hemBindingKey, LAST_NET_KEY,
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
const acme = () => signNetwork({
  v: 1, networkId: 'acme', operator: 'ACME S.A.', rootPub: rootPubFor(KEY), seq: 1, made: NOW - DAY, expires: NOW + 90 * DAY,
  nodes: [{ name: 'n1', addr: ADDR }], stores: ['https://files.acme.example'], app: { origin: 'https://chat.acme.example', path: '/' },
  profileUrls: ['https://acme.example/onchato/network.json'], feedback: null, home: 'https://acme.example/', policy: {},
}, KEY)

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
