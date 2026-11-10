import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  collectProfile, exportProfile, openBundle, applyBundle, conflictsWith, keysOfProfile, identityHere,
  isMigrationFile, type KV,
} from '../lib/migrate.ts'
import { BadPassword } from '../lib/profile.ts'

const KID = 'a1b2c3d4'
// The identity's storage-name prefix (lib/storenames.ts) - what owns a record
// since 0.8.2; another identity's prefix for the records that must stay.
const PFX = 'ec-0011223344556677-'
const OPFX = 'ec-8899aabbccddeeff-'
const PASS = 'correct horse'

function kv(seed: Record<string, string> = {}): KV & { data: Record<string, string> } {
  const data = { ...seed }
  return {
    data,
    keys: () => Object.keys(data),
    get: (k) => (k in data ? data[k] : null),
    set: (k, v) => { data[k] = v },
  }
}

const full = () => kv({
  'ec-soft-id-Lab1': '{"v":1,"kdf":"PBKDF2-SHA256"}',
  [PFX + 'book']: 'sealed-book',
  [PFX + 'groups']: 'sealed-index',
  [PFX + 'group-g1']: 'sealed-group-state',
  [PFX + 'pin-peer']: 'sealed-pins',
  [`ec-local-contacts-${KID}`]: '[{"name":"pre-0.7.34, nobody reads it"}]',
  'ec-lang': 'pl',
  'ec-nodes': '[{"name":"bs1"}]',
  // none of these may travel
  'ec-idkey-swept': '1',
  'ec-soft-id-Inny': '{"v":1,"kdf":"PBKDF2-SHA256"}',
  [OPFX + 'book']: 'nie moje',
  'nie-nasze': 'x',
})

test('an export takes this profile and nothing else', () => {
  const keys = collectProfile(full(), 'Lab1', KID, PFX)
  assert.deepEqual(Object.keys(keys).sort(), [
    'ec-lang', 'ec-nodes',
    PFX + 'book', PFX + 'groups', PFX + 'group-g1', PFX + 'pin-peer', 'ec-soft-id-Lab1',
  ].sort())
})

test('the boot marker, another identity and foreign keys stay behind', () => {
  const keys = collectProfile(full(), 'Lab1', KID, PFX)
  // Each of these has cost something once: the marker made a test flaky, and
  // exporting a second identity would hand someone a key they did not mean to move.
  assert.equal('ec-idkey-swept' in keys, false)
  assert.equal('ec-soft-id-Inny' in keys, false)
  assert.equal(OPFX + 'book' in keys, false)
  assert.equal(`ec-local-contacts-${KID}` in keys, false, 'a KID-carrying name of a build before 0.7.34 is nobody\'s (0.8.2)')
  assert.equal('nie-nasze' in keys, false)
})

test('roundtrip: what is exported is what arrives in an empty browser', async () => {
  const file = await exportProfile(full(), 'Lab1', KID, PASS, 1_700_000_000_000, PFX)
  assert.ok(isMigrationFile(file))
  // Nothing outside the seal says whose profile this is.
  assert.equal(JSON.stringify(file).includes('Lab1'), false)

  const bundle = await openBundle(JSON.parse(JSON.stringify(file)), PASS)
  assert.equal(bundle.name, 'Lab1')
  assert.equal(bundle.kid, KID)

  const target = kv()
  const n = applyBundle(target, bundle)
  assert.equal(n, Object.keys(bundle.keys).length)
  assert.equal(target.data['ec-soft-id-Lab1'], '{"v":1,"kdf":"PBKDF2-SHA256"}')
  assert.equal(target.data[PFX + 'book'], 'sealed-book')
})

test('a wrong password is BadPassword, not a corrupted file', async () => {
  const file = await exportProfile(full(), 'Lab1', KID, PASS, 1, PFX)
  await assert.rejects(() => openBundle(file, 'nope'), (e: any) => e instanceof BadPassword)
})

test('a file that is not ours is refused before any password is asked', async () => {
  assert.equal(isMigrationFile({ hello: 'world' }), false)
  await assert.rejects(() => openBundle({ hello: 'world' }, PASS), /not an onchato migration file/)
})

test('an export with no identity in it is refused', async () => {
  await assert.rejects(() => exportProfile(kv({ 'ec-lang': 'pl' }), 'Lab1', KID, PASS, 1, PFX), /no sealed identity/)
})

test('a name already here is a refusal, never an overwrite', async () => {
  const file = await exportProfile(full(), 'Lab1', KID, PASS, 1, PFX)
  const bundle = await openBundle(file, PASS)
  const target = kv({ 'ec-soft-id-Lab1': 'SOMEBODY ELSE' })
  assert.equal(conflictsWith(target, bundle), 'Lab1')
  assert.throws(() => applyBundle(target, bundle), /already here/)
  // The thing that would have been destroyed is still there.
  assert.equal(target.data['ec-soft-id-Lab1'], 'SOMEBODY ELSE')
})

test('a doctored file cannot write outside our own storage', async () => {
  const file = await exportProfile(full(), 'Lab1', KID, PASS, 1, PFX)
  const bundle = await openBundle(file, PASS)
  bundle.keys['evil'] = 'x'
  bundle.keys['ec-idkey-swept'] = '1'
  const target = kv()
  applyBundle(target, bundle)
  assert.equal('evil' in target.data, false)
  assert.equal('ec-idkey-swept' in target.data, false)
})

test('deleting a profile takes everything under its prefix, and nothing of anybody else', () => {
  const A = '5954eb6d5a1dd906ec78fe9dae5645e3'
  const store = kv({
    'ec-soft-id-Ala': '{}', 'ec-soft-id-Ola': '{}',
    [PFX + 'book']: 'x', [PFX + 'emp']: 'pub', [PFX + 'group-g1']: 'x', [PFX + 'pin-peer']: 'x', [PFX + 'invites']: 'x',
    [OPFX + 'book']: 'x', [OPFX + 'emp']: 'pub',
    [`ec-local-contacts-${A}`]: '[]', 'ec-lang': 'pl', 'ec-last-profile': 'Ala', 'ec-idkey-swept': '1',
  })
  const gone = keysOfProfile(store, 'Ala', A, PFX)
  assert.deepEqual(gone.sort(), ['ec-soft-id-Ala', PFX + 'book', PFX + 'emp', PFX + 'group-g1', PFX + 'invites', PFX + 'pin-peer'].sort())
  for (const k of ['ec-soft-id-Ola', OPFX + 'book', OPFX + 'emp', 'ec-lang', 'ec-idkey-swept'])
    assert.ok(!gone.includes(k), 'must stay: ' + k)
  assert.deepEqual(keysOfProfile(store, 'Ala', A), ['ec-soft-id-Ala'], 'without the prefix only the sealed identity is found')
})

test('a passkey slot never leaves the device, goes with its profile, and is never written by an import', async () => {
  const store = full()
  store.set('ec-soft-unlock-Lab1', '{"v":1,"kind":"webauthn-prf"}')
  store.set('ec-soft-unlock-Other', '{"v":1,"kind":"webauthn-prf"}')
  assert.equal('ec-soft-unlock-Lab1' in collectProfile(store, 'Lab1', KID, PFX), false, 'not exported')
  const gone = keysOfProfile(store, 'Lab1', '5954eb6d5a1dd906ec78fe9dae5645e3', PFX)
  assert.ok(gone.includes('ec-soft-unlock-Lab1'), 'deleted with the profile')
  assert.ok(!gone.includes('ec-soft-unlock-Other'), 'another profile keeps its slot')

  const bundle = await openBundle(await exportProfile(store, 'Lab1', KID, PASS, 1, PFX), PASS)
  bundle.keys['ec-soft-unlock-Lab1'] = 'FROM THE FILE'
  bundle.keys['ec-soft-unlock-Ola'] = 'FROM THE FILE'
  const target = kv({ 'ec-soft-unlock-Lab1': 'AN ORPHAN' })
  ;(target as any).remove = (k: string) => { delete target.data[k] }
  applyBundle(target, bundle)
  assert.equal('ec-soft-unlock-Lab1' in target.data, false, 'an orphan slot under the name goes, the file\'s is not written')
  assert.equal('ec-soft-unlock-Ola' in target.data, false)
  assert.ok(target.data['ec-soft-id-Lab1'])
})

test('without a real KID nothing but a refusal comes back - an empty one would match every key', () => {
  const store = kv({ 'ec-soft-id-Ala': '{}', 'ec-lang': 'pl' })
  for (const bad of ['', 'a1b2', 'x'.repeat(32)]) assert.throws(() => keysOfProfile(store, 'Ala', bad), /not a KID/)
})

test('the same identity under a new name is refused, not written over its own state', async () => {
  const file = await exportProfile(full(), 'Lab1', KID, PASS, 1_700_000_000_000, PFX)
  const bundle = await openBundle(file, PASS)
  // the profile was renamed after the export: no name clashes, the KID does
  const here = kv({ 'ec-soft-id-Lab2': '{}', [PFX + 'book']: 'nowsze' })
  assert.equal(conflictsWith(here, bundle), null)
  assert.equal(identityHere(here, bundle), true)
  assert.throws(() => applyBundle(here, bundle), /already here under another name/)
  assert.equal(here.data[PFX + 'book'], 'nowsze', 'the newer book is untouched')
  assert.equal(identityHere(kv({ 'ec-lang': 'pl' }), bundle), false, 'an empty browser takes it')
})

test('a profile\'s keys are found by its storage prefix alone; a file without one (before 0.7.34) is refused', async () => {
  const A = '5954eb6d5a1dd906ec78fe9dae5645e3'
  const store = kv({
    'ec-soft-id-Ala': '{}', [PFX + 'a'.repeat(32)]: 'book', [PFX + 'b'.repeat(32)]: 'emp',
    [`ec-pins-${A}-peer`]: 'pre-0.7.34', [OPFX + 'c'.repeat(32)]: 'cudze', 'ec-lang': 'pl',
  })
  assert.deepEqual(keysOfProfile(store, 'Ala', A, PFX).sort(), ['ec-soft-id-Ala', PFX + 'a'.repeat(32), PFX + 'b'.repeat(32)].sort())
  const file = await exportProfile(store, 'Ala', A, PASS, 1, PFX)
  const bundle = await openBundle(file, PASS)
  assert.equal(bundle.prefix, PFX)
  assert.ok(!(OPFX + 'c'.repeat(32) in bundle.keys), 'another identity does not travel')
  assert.equal(identityHere(kv({ [PFX + 'f'.repeat(32)]: 'x' }), { ...bundle, kid: 'ffffffffffffffffffffffffffffffff' }), true, 'found by the prefix alone')
  assert.throws(() => keysOfProfile(store, 'Ala', A, 'ec-zz-'), /not a storage prefix/)
  const old = await exportProfile(store, 'Ala', A, PASS, 1) // no prefix: what a build before 0.7.34 wrote
  await assert.rejects(openBundle(old, PASS), /before 0\.7\.34/)
})

// ---- a profile of another network moves with its network --------------------
import { signNetwork, rootPubFor, loadRegistry, REGISTRY_KEY } from '../lib/netprofile.ts'

const NKEY = Buffer.from(new Uint8Array(32).fill(5)).toString('base64')
const NOTHER = Buffer.from(new Uint8Array(32).fill(6)).toString('base64')
const NNOW = 1_800_000_000_000
const NADDR = '/dns4/n1.acme.example/tcp/443/wss/http-path/%2Frelay/p2p/12D3KooWLcDzqtSAetckwdzzqYbLTsN6wHFx8T4uKr5Yn1GUvSt5'
const acmeEnv = (seq: number, key = NKEY, over: Record<string, unknown> = {}) => signNetwork({
  v: 1, networkId: 'acme', operator: 'ACME S.A.', rootPub: rootPubFor(key), seq, made: NNOW - 86_400_000, expires: NNOW + 86_400_000,
  nodes: [{ name: 'n1', addr: NADDR }], stores: ['https://files.acme.example'], app: { origin: 'https://chat.acme.example', path: '/' },
  profileUrls: ['https://acme.example/n.json'], feedback: null, home: 'https://acme.example/', policy: {}, ...over,
}, key)
const inAcme = () => {
  const s = full()
  s.set('ec-soft-net-Lab1', 'acme')
  s.set('ec-nodes:acme', '[{"name":"n1"}]')
  s.set('ec-transport:acme', 'relay')
  s.set('ec-nodes:other', '[{"name":"x"}]') // another network's list does not travel
  s.set(REGISTRY_KEY, JSON.stringify({ acme: acmeEnv(3) }))
  return s
}

test('network: a profile of another network takes its network, its node list and its transport, and nothing of other networks', async () => {
  const keys = collectProfile(inAcme(), 'Lab1', KID, PFX)
  assert.equal(keys['ec-soft-net-Lab1'], 'acme')
  assert.ok(keys['ec-nodes:acme'] && keys['ec-transport:acme'])
  assert.equal(keys['ec-nodes:other'], undefined)
  const bundle = await openBundle(await exportProfile(inAcme(), 'Lab1', KID, PASS, NNOW, PFX), PASS)
  assert.equal(bundle.net?.id, 'acme')
})

test('network: the device it lands on learns the network, and the identity opens in it', async () => {
  const bundle = await openBundle(await exportProfile(inAcme(), 'Lab1', KID, PASS, NNOW, PFX), PASS)
  const there = kv()
  applyBundle(there, bundle, NNOW)
  assert.equal(there.get('ec-soft-net-Lab1'), 'acme')
  assert.equal(loadRegistry(there, NNOW).get('acme')?.profile.seq, 3)
})

test('network: a device holding that network under ANOTHER key refuses the whole import; a newer copy stays newer', async () => {
  const bundle = await openBundle(await exportProfile(inAcme(), 'Lab1', KID, PASS, NNOW, PFX), PASS)
  const foreign = kv({ [REGISTRY_KEY]: JSON.stringify({ acme: acmeEnv(9, NOTHER) }) })
  assert.throws(() => applyBundle(foreign, bundle, NNOW), /another operator key/)
  assert.equal(foreign.get('ec-soft-id-Lab1'), null, 'nothing of the identity was written')
  const newer = kv({ [REGISTRY_KEY]: JSON.stringify({ acme: acmeEnv(7) }) })
  applyBundle(newer, bundle, NNOW)
  assert.equal(loadRegistry(newer, NNOW).get('acme')?.profile.seq, 7)
})

test('network: an expired network profile in the file is still taken - the identity belongs to it whatever its date', async () => {
  const s = inAcme()
  s.set(REGISTRY_KEY, JSON.stringify({ acme: acmeEnv(3, NKEY, { expires: NNOW + 1000 }) }))
  const bundle = await openBundle(await exportProfile(s, 'Lab1', KID, PASS, NNOW, PFX), PASS)
  const there = kv()
  applyBundle(there, bundle, NNOW + 86_400_000)
  assert.equal(loadRegistry(there, NNOW + 86_400_000).get('acme')?.expired, true)
})

test('network: an export refuses a binding with no network profile behind it', async () => {
  const s = full()
  s.set('ec-soft-net-Lab1', 'gone')
  await assert.rejects(exportProfile(s, 'Lab1', KID, PASS, NNOW, PFX), /not on this device/)
})

test('a record of this device (the network key, lib/netkey.ts) stays behind, though it sits under the identity prefix', () => {
  const s = full()
  const FULL_KID = 'a1b2c3d4'.repeat(4) // keysOfProfile wants a whole KID
  const PREFIX = 'ec-0123456789abcdef-'
  s.set(PREFIX + 'aa', 'sealed-book'); s.set(PREFIX + 'netkey-name', 'sealed-netkey')
  const keys = collectProfile(s, 'Lab1', FULL_KID, PREFIX, [PREFIX + 'netkey-name'])
  assert.ok(keys[PREFIX + 'aa'], 'the identity prefix stopped working')
  assert.equal(keys[PREFIX + 'netkey-name'], undefined, 'the device key went into the export')
  assert.ok(keysOfProfile(s, 'Lab1', FULL_KID, PREFIX).includes(PREFIX + 'netkey-name'), 'a deleted profile must take the device key with it')
})
