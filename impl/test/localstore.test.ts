/**
 * The sealed local stores (`lib/localstore.ts`).
 *
 * The happy path is one round trip. Everything else here is about the property
 * the salt exists for: a blob from one store must not open as another, because
 * that is the failure a refactor introduces silently and nothing else catches.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { sealLocal, openLocal } from '../lib/localstore.ts'

const base = (fill = 7) => new Uint8Array(32).fill(fill)
const SALT_A = 'encedo-chat-test-a-v1'
const SALT_B = 'encedo-chat-test-b-v1'

test('what goes in comes back out', async () => {
  const value = { rows: [{ fp: '02:05:4F:53', at: 1_700_000_000_000 }], n: 2 }
  const blob = await sealLocal(base(), SALT_A, 'kid-1', value)
  assert.deepEqual(await openLocal(base(), SALT_A, 'kid-1', blob), value)
})

test('the plaintext is not in the blob', async () => {
  const blob = await sealLocal(base(), SALT_A, 'kid-1', { note: 'w sprawie przetargu' })
  // The whole point: a device at rest must not hand over what was written.
  assert.ok(!blob.includes('przetarg'))
  assert.ok(!Buffer.from(blob, 'base64').toString('utf8').includes('przetarg'))
})

test('a blob from one store does not open as another', async () => {
  const blob = await sealLocal(base(), SALT_A, 'kid-1', { secret: 1 })
  // Same base, same scope, different salt — this is what stops a pin blob being
  // readable as an invite blob after somebody "tidies up" the constants.
  assert.equal(await openLocal(base(), SALT_B, 'kid-1', blob), null)
})

test('another identity cannot open it, and neither can another scope', async () => {
  const blob = await sealLocal(base(1), SALT_A, 'kid-1', { secret: 1 })
  assert.equal(await openLocal(base(2), SALT_A, 'kid-1', blob), null)
  assert.equal(await openLocal(base(1), SALT_A, 'kid-2', blob), null)
})

test('junk is null, never a throw', async () => {
  // Everything a localStorage key can really hold: another format, a truncated
  // write, something that is not base64 at all, and an empty string.
  for (const junk of ['', 'not base64 at all!!', 'AAAA', '[]', '{"plain":"old format"}']) {
    assert.equal(await openLocal(base(), SALT_A, 'kid-1', junk), null, `threw or opened: ${junk}`)
  }
})

test('two seals of the same value differ', async () => {
  // A fresh iv per write, so writing the same list twice does not show that
  // nothing changed.
  const a = await sealLocal(base(), SALT_A, 'kid-1', { x: 1 })
  const b = await sealLocal(base(), SALT_A, 'kid-1', { x: 1 })
  assert.notEqual(a, b)
  assert.deepEqual(await openLocal(base(), SALT_A, 'kid-1', b), { x: 1 })
})
