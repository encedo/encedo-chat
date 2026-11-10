import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createDecipheriv } from 'node:crypto'
import {
  sealSlot, openSlot, isUnlockSlot, readSlot, passwordDue, withPasswordAt, slotAllowed,
  SlotRefused, UNLOCK_LABEL, PASSWORD_EVERY_MS, unlockSlotKey,
} from '../lib/unlockslot.ts'
import { kdf } from '../lib/wc.ts'

const NOW = 1_800_000_000_000
const DAY = 86_400_000
const SECRET = new Uint8Array(32).fill(7)
const META = { kind: 'webauthn-prf' as const, rpId: 'app.example', credId: 'Y3JlZA==', prfSalt: Buffer.alloc(32, 1).toString('base64'), synced: true }
const PLAIN = JSON.stringify({ handle: 'Lab1', priv: 'x'.repeat(44) })

test('the slot key is HKDF(info = onchato-soft-unlock-v1, empty salt) - pinned against node:crypto', async () => {
  // Computed with node:crypto hkdfSync, an implementation independent of lib/wc.ts.
  const k = await kdf(UNLOCK_LABEL, SECRET)
  assert.equal(Buffer.from(k).toString('hex'), '248c67f1a44a5eb67269cf824ccbf610f870d824667ca8ad53ce8d0f28d8a17b')
})

test('a slot is AES-256-GCM under that key with the profile name as AAD (opened outside the module)', async () => {
  const slot = await sealSlot(SECRET, PLAIN, 'Lab1', META, NOW)
  const key = Buffer.from(await kdf(UNLOCK_LABEL, SECRET))
  const ct = Buffer.from(slot.ct, 'base64')
  const d = createDecipheriv('aes-256-gcm', key, Buffer.from(slot.iv, 'base64'))
  d.setAAD(Buffer.from('Lab1'))
  d.setAuthTag(ct.subarray(ct.length - 16))
  const out = Buffer.concat([d.update(ct.subarray(0, ct.length - 16)), d.final()]).toString()
  assert.equal(out, PLAIN)
})

test('the same secret and name open the slot; the record carries what the passkey needs', async () => {
  const slot = await sealSlot(SECRET, PLAIN, 'Lab1', META, NOW)
  assert.ok(isUnlockSlot(slot))
  assert.equal(slot.pwAt, NOW)
  assert.equal(slot.synced, true)
  assert.equal(await openSlot(SECRET, slot, 'Lab1'), PLAIN)
  assert.equal(unlockSlotKey('Lab1'), 'ec-soft-unlock-Lab1')
})

test('another secret, another name or an altered record is refused', async () => {
  const slot = await sealSlot(SECRET, PLAIN, 'Lab1', META, NOW)
  await assert.rejects(openSlot(new Uint8Array(32).fill(8), slot, 'Lab1'), SlotRefused)
  await assert.rejects(openSlot(SECRET, slot, 'Lab2'), SlotRefused)
  const ct = Buffer.from(slot.ct, 'base64'); ct[0] ^= 1
  await assert.rejects(openSlot(SECRET, { ...slot, ct: ct.toString('base64') }, 'Lab1'), SlotRefused)
  await assert.rejects(openSlot(new Uint8Array(16), slot, 'Lab1'), /32 bytes/)
})

test('readSlot takes only a well-formed record', async () => {
  const slot = await sealSlot(SECRET, PLAIN, 'Lab1', META, NOW)
  assert.deepEqual(readSlot(JSON.stringify(slot)), slot)
  assert.equal(readSlot(null), null)
  assert.equal(readSlot('{not json'), null)
  assert.equal(readSlot(JSON.stringify({ ...slot, v: 2 })), null)
  assert.equal(readSlot(JSON.stringify({ ...slot, kind: 'native' })), null)
  assert.equal(readSlot(JSON.stringify({ ...slot, synced: 'yes' })), null)
  assert.equal(readSlot(JSON.stringify({ ...slot, pwAt: -1 })), null)
})

test('the password is due after 14 days without it, or when the stamp is in the future', async () => {
  const slot = await sealSlot(SECRET, PLAIN, 'Lab1', META, NOW)
  assert.equal(PASSWORD_EVERY_MS, 14 * DAY)
  assert.equal(passwordDue(slot, NOW), false)
  assert.equal(passwordDue(slot, NOW + 14 * DAY - 1), false)
  assert.equal(passwordDue(slot, NOW + 14 * DAY), true)
  assert.equal(passwordDue(slot, NOW - 2 * DAY), true)
  assert.equal(passwordDue(withPasswordAt(slot, NOW + 14 * DAY), NOW + 14 * DAY), false)
})

test('a network policy decides which slots may be used', () => {
  assert.equal(slotAllowed(undefined, true), true)
  assert.equal(slotAllowed('any', true), true)
  assert.equal(slotAllowed('device-bound', false), true)
  assert.equal(slotAllowed('device-bound', true), false)
  assert.equal(slotAllowed('none', false), false)
})

test('a keystore slot (the Android app) seals the same way and keeps its wrapped secret', async () => {
  const KS = { kind: 'android-keystore' as const, alias: 'ab'.repeat(16), wiv: 'aXY=', wct: 'Y3Q=', synced: false }
  const slot = await sealSlot(SECRET, PLAIN, 'Lab1', KS, NOW)
  assert.equal(slot.kind, 'android-keystore')
  assert.ok(isUnlockSlot(slot))
  assert.deepEqual(readSlot(JSON.stringify(slot)), slot)
  assert.equal(await openSlot(SECRET, slot, 'Lab1'), PLAIN)
  await assert.rejects(openSlot(SECRET, slot, 'Lab2'), SlotRefused)
  assert.equal('rpId' in slot, false, 'no WebAuthn fields on a keystore slot')
  // The keystore is device-bound by construction: a record claiming otherwise is not a slot.
  assert.equal(readSlot(JSON.stringify({ ...slot, synced: true })), null)
  assert.equal(readSlot(JSON.stringify({ ...slot, alias: 'Lab1' })), null, 'the alias is random hex, never a name')
  assert.equal(readSlot(JSON.stringify({ ...slot, wct: '' })), null)
  // And a passkey slot without its relying party is not one either.
  const prf = await sealSlot(SECRET, PLAIN, 'Lab1', META, NOW)
  assert.equal(readSlot(JSON.stringify({ ...prf, rpId: '' })), null)
})
