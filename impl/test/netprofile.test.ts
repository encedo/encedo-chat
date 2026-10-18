import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  openEnvelope, signNetwork, rootPubFor, rootFingerprint, registerNetwork, loadRegistry,
  parseOperatorProfile, REGISTRY_KEY, PUBLIC_NETWORK_ID,
} from '../lib/netprofile.ts'

const KEY = Buffer.from(new Uint8Array(32).fill(5)).toString('base64')
const OTHER = Buffer.from(new Uint8Array(32).fill(6)).toString('base64')
const NOW = 1_800_000_000_000
const DAY = 86_400_000
const ADDR = '/dns4/n1.acme.example/tcp/443/wss/http-path/%2Frelay/p2p/12D3KooWLcDzqtSAetckwdzzqYbLTsN6wHFx8T4uKr5Yn1GUvSt5'

const profile = (over: Record<string, unknown> = {}, key = KEY) => ({
  v: 1, networkId: 'acme', operator: 'ACME S.A.', rootPub: rootPubFor(key), seq: 1,
  made: NOW - DAY, expires: NOW + 90 * DAY,
  nodes: [{ name: 'n1', addr: ADDR }],
  stores: ['https://files.acme.example'],
  app: { origin: 'https://chat.acme.example', path: '/' },
  profileUrls: ['https://acme.example/onchato/network.json'],
  feedback: null, home: 'https://acme.example/',
  policy: { transport: 'node-only', softwareProfiles: false },
  ...over,
})
const env = (over: Record<string, unknown> = {}, key = KEY) => signNetwork(profile(over, key), key)

function memKV() {
  const m = new Map<string, string>()
  return { get: (k: string) => m.get(k) ?? null, set: (k: string, v: string) => void m.set(k, v), remove: (k: string) => void m.delete(k), m }
}

test('a signed profile opens, as an object or as the JSON text of a file', () => {
  for (const raw of [env(), JSON.stringify(env())]) {
    const r = openEnvelope(raw, NOW)
    assert.ok(r.ok, JSON.stringify(r))
    assert.equal(r.profile.networkId, 'acme')
    assert.equal(r.profile.feedback, null)
    assert.deepEqual(r.profile.policy, { transport: 'node-only', softwareProfiles: false })
    assert.deepEqual(r.profile.legacyApp, [])
  }
})

test('the signature is over the exact bytes: one byte changed, or another key, and it is refused', () => {
  const e = env()
  const bytes = Buffer.from(e.profile, 'base64')
  bytes[bytes.length - 2] ^= 1
  assert.deepEqual(openEnvelope({ ...e, profile: bytes.toString('base64') }, NOW).ok, false)
  // A profile naming key A but signed by key B.
  const forged = signNetwork(profile(), OTHER)
  const r = openEnvelope(forged, NOW)
  assert.ok(!r.ok && r.why === 'signature')
})

test('no imported network may claim the public network\'s id', () => {
  const r = openEnvelope(env({ networkId: PUBLIC_NETWORK_ID }), NOW)
  assert.ok(!r.ok && r.why === 'reserved')
})

test('dates: expired and future profiles are refused on import, an expired one may be read back from the device', () => {
  const old = env({ made: NOW - 100 * DAY, expires: NOW - DAY })
  assert.equal((openEnvelope(old, NOW) as any).why, 'expired')
  assert.ok(openEnvelope(old, NOW, undefined, { allowExpired: true }).ok)
  assert.equal((openEnvelope(env({ made: NOW + DAY }), NOW) as any).why, 'future')
})

test('content that would point a client at half a network is refused, with the reason', () => {
  const bad: [Record<string, unknown>, RegExp][] = [
    [{ nodes: [] }, /no nodes/],
    [{ stores: ['http://files.acme.example'] }, /https/],
    [{ app: { origin: 'https://chat.acme.example/x', path: '/' } }, /bare origin/],
    [{ profileUrls: [] }, /profileUrls/],
    [{ policy: { transport: 'direct' } }, /node-only/],
    [{ rootPub: 'AAAA' }, /32-byte/],
    [{ seq: -1 }, /seq/],
  ]
  for (const [over, why] of bad) assert.throws(() => parseOperatorProfile(profile(over)), why, JSON.stringify(over))
})

test('the registry pins the first key: a refresh under another key is refused, a lower seq too, a higher one replaces', () => {
  const kv = memKV()
  const first = registerNetwork(kv, env({ seq: 3 }), NOW)
  assert.ok(first.ok && !first.replaced)
  // Same id, another operator key: a new key is a new network, never swapped in.
  const swapped = registerNetwork(kv, env({ seq: 9 }, OTHER), NOW)
  assert.ok(!swapped.ok && swapped.why === 'key')
  // An older version of the same network.
  const back = registerNetwork(kv, env({ seq: 2 }), NOW)
  assert.ok(!back.ok && back.why === 'rollback')
  const newer = registerNetwork(kv, env({ seq: 4, nodes: [{ name: 'n2', addr: ADDR.replace('n1.', 'n2.') }] }), NOW)
  assert.ok(newer.ok && newer.replaced)
  const known = loadRegistry(kv, NOW)
  assert.equal(known.get('acme')?.profile.seq, 4)
  assert.equal(known.get('acme')?.profile.nodes[0].name, 'n2')
})

test('the registry keeps an expired network readable and says so; a damaged entry is left out, not trusted', () => {
  const kv = memKV()
  assert.ok(registerNetwork(kv, env({ expires: NOW + DAY }), NOW).ok)
  const later = loadRegistry(kv, NOW + 2 * DAY)
  assert.equal(later.get('acme')?.expired, true)
  const all = JSON.parse(kv.get(REGISTRY_KEY)!)
  all.acme.sig = all.acme.sig.replace(/^./, (c: string) => (c === 'A' ? 'B' : 'A'))
  kv.set(REGISTRY_KEY, JSON.stringify(all))
  assert.equal(loadRegistry(kv, NOW).size, 0)
})

test('the fingerprint is eight groups of four hex digits, and differs between keys', async () => {
  const a = await rootFingerprint(rootPubFor(KEY))
  assert.match(a, /^([0-9a-f]{4} ){7}[0-9a-f]{4}$/)
  assert.notEqual(a, await rootFingerprint(rootPubFor(OTHER)))
})
