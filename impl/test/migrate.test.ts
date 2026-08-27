import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  collectProfile, exportProfile, openBundle, applyBundle, conflictsWith,
  isMigrationFile, type KV,
} from '../lib/migrate.ts'
import { BadPassword } from '../lib/profile.ts'

const KID = 'a1b2c3d4'
const OTHER = 'ffffffff'
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
  [`ec-local-contacts-${KID}`]: '[{"name":"Ala"}]',
  [`ec-groups-${KID}`]: '["g1"]',
  [`ec-gcache-${KID}-g1`]: 'sealed-group-state',
  [`ec-pins-${KID}-peer`]: 'sealed-pins',
  [`ec-notify-${KID}`]: 'name',
  'ec-lang': 'pl',
  'ec-nodes': '[{"name":"bs1"}]',
  // none of these may travel
  'ec-idkey-swept': '1',
  'ec-soft-id-Inny': '{"v":1,"kdf":"PBKDF2-SHA256"}',
  [`ec-local-contacts-${OTHER}`]: '[{"name":"nie moje"}]',
  'nie-nasze': 'x',
})

test('an export takes this profile and nothing else', () => {
  const keys = collectProfile(full(), 'Lab1', KID)
  assert.deepEqual(Object.keys(keys).sort(), [
    'ec-lang', 'ec-nodes',
    `ec-gcache-${KID}-g1`, `ec-groups-${KID}`, `ec-local-contacts-${KID}`,
    `ec-notify-${KID}`, `ec-pins-${KID}-peer`, 'ec-soft-id-Lab1',
  ].sort())
})

test('the boot marker, another identity and foreign keys stay behind', () => {
  const keys = collectProfile(full(), 'Lab1', KID)
  // Each of these has cost something once: the marker made a test flaky, and
  // exporting a second identity would hand someone a key they did not mean to move.
  assert.equal('ec-idkey-swept' in keys, false)
  assert.equal('ec-soft-id-Inny' in keys, false)
  assert.equal(`ec-local-contacts-${OTHER}` in keys, false)
  assert.equal('nie-nasze' in keys, false)
})

test('roundtrip: what is exported is what arrives in an empty browser', async () => {
  const file = await exportProfile(full(), 'Lab1', KID, PASS, 1_700_000_000_000)
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
  assert.equal(target.data[`ec-local-contacts-${KID}`], '[{"name":"Ala"}]')
})

test('a wrong password is BadPassword, not a corrupted file', async () => {
  const file = await exportProfile(full(), 'Lab1', KID, PASS, 1)
  await assert.rejects(() => openBundle(file, 'nope'), (e: any) => e instanceof BadPassword)
})

test('a file that is not ours is refused before any password is asked', async () => {
  assert.equal(isMigrationFile({ hello: 'world' }), false)
  await assert.rejects(() => openBundle({ hello: 'world' }, PASS), /not an onchato migration file/)
})

test('an export with no identity in it is refused', async () => {
  await assert.rejects(() => exportProfile(kv({ 'ec-lang': 'pl' }), 'Lab1', KID, PASS, 1), /no sealed identity/)
})

test('a name already here is a refusal, never an overwrite', async () => {
  const file = await exportProfile(full(), 'Lab1', KID, PASS, 1)
  const bundle = await openBundle(file, PASS)
  const target = kv({ 'ec-soft-id-Lab1': 'SOMEBODY ELSE' })
  assert.equal(conflictsWith(target, bundle), 'Lab1')
  assert.throws(() => applyBundle(target, bundle), /already here/)
  // The thing that would have been destroyed is still there.
  assert.equal(target.data['ec-soft-id-Lab1'], 'SOMEBODY ELSE')
})

test('a doctored file cannot write outside our own storage', async () => {
  const file = await exportProfile(full(), 'Lab1', KID, PASS, 1)
  const bundle = await openBundle(file, PASS)
  bundle.keys['evil'] = 'x'
  bundle.keys['ec-idkey-swept'] = '1'
  const target = kv()
  applyBundle(target, bundle)
  assert.equal('evil' in target.data, false)
  assert.equal('ec-idkey-swept' in target.data, false)
})
