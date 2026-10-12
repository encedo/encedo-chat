import { test } from 'node:test'
import assert from 'node:assert/strict'
import { verifyManifest, signManifest, rootPubOf, type Manifest } from '../lib/manifest.ts'

const PRIV = Buffer.from(new Uint8Array(32).fill(9)).toString('base64')
const OTHER = Buffer.from(new Uint8Array(32).fill(8)).toString('base64')
const PUB = rootPubOf(PRIV)
const NOW = 1_800_000_000_000
const good: Manifest = {
  v: 1, version: '0.7.13', commit: 'abcdef1', made: NOW - 1000, expires: NOW + 86_400_000,
  web: { cid: 'bafkreia', bundle: 'app.x.bundle.js', sri: 'sha384-x' }, nodes: { cid: 'bafkreib' }, ci: { updater_pubkey: 'k' },
}
const bytes = (m: unknown) => new TextEncoder().encode(JSON.stringify(m))

test('a manifest signed by the root key verifies, and comes back parsed', () => {
  const raw = bytes(good)
  const v = verifyManifest(raw, signManifest(raw, PRIV), PUB, NOW)
  assert.ok(v.ok && v.manifest.nodes.cid === 'bafkreib')
})

test('a manifest without the web field is a manifest: the bundle is attested only when the updater will check it', () => {
  const { web, ...noWeb } = good
  const raw = bytes(noWeb)
  const v = verifyManifest(raw, signManifest(raw, PRIV), PUB, NOW)
  assert.ok(v.ok && v.manifest.web === undefined && v.manifest.nodes.cid === 'bafkreib')
  const half = bytes({ ...good, web: { cid: 'x' } })
  assert.deepEqual(verifyManifest(half, signManifest(half, PRIV), PUB, NOW), { ok: false, why: 'shape' }, 'a web field present is a whole one')
})

test('a byte changed after signing, or another key, is a signature failure', () => {
  const raw = bytes(good)
  const sig = signManifest(raw, PRIV)
  const edited = bytes({ ...good, nodes: { cid: 'bafkreiX' } })
  assert.deepEqual(verifyManifest(edited, sig, PUB, NOW), { ok: false, why: 'signature' })
  assert.deepEqual(verifyManifest(raw, signManifest(raw, OTHER), PUB, NOW), { ok: false, why: 'signature' })
  assert.deepEqual(verifyManifest(raw, 'not base64!!', PUB, NOW), { ok: false, why: 'signature' })
})

test('expired, from the future, or the wrong shape: refused even with a good signature', () => {
  const expired = bytes({ ...good, expires: NOW - 1 })
  assert.deepEqual(verifyManifest(expired, signManifest(expired, PRIV), PUB, NOW), { ok: false, why: 'expired' })
  const future = bytes({ ...good, made: NOW + 11 * 60_000, expires: NOW + 86_400_000 * 2 })
  assert.deepEqual(verifyManifest(future, signManifest(future, PRIV), PUB, NOW), { ok: false, why: 'future' })
  const shape = bytes({ ...good, nodes: {} })
  assert.deepEqual(verifyManifest(shape, signManifest(shape, PRIV), PUB, NOW), { ok: false, why: 'shape' })
  const v2 = bytes({ ...good, v: 2 })
  assert.deepEqual(verifyManifest(v2, signManifest(v2, PRIV), PUB, NOW), { ok: false, why: 'shape' })
})
