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

// ---- several sources (fetchManifest) ----------------------------------------
import { fetchManifest, worstTry } from '../lib/manifest.ts'

/** A fake fetch serving {url: [body, status]}; anything else is a 404. */
function served(files: Record<string, [Uint8Array | string, number?]>): typeof fetch {
  return (async (input: any) => {
    const f = files[String(input)]
    if (!f) return new Response('no', { status: 404 })
    return new Response(f[0] as any, { status: f[1] ?? 200 })
  }) as typeof fetch
}
const signed = (m: Manifest, key = PRIV) => { const raw = bytes(m); return { raw, sig: signManifest(raw, key) } }

test('several sources: the NEWEST manifest that verifies wins, not the first to answer', async () => {
  const old = signed({ ...good, made: NOW - 50_000, nodes: { cid: 'bafkreiold' } })
  const fresh = signed({ ...good, made: NOW - 1_000, nodes: { cid: 'bafkreinew' } })
  const r = await fetchManifest(['https://a.example/m.json', 'https://b.example/m.json'], PUB, NOW, served({
    'https://a.example/m.json': [old.raw], 'https://a.example/m.sig': [old.sig],
    'https://b.example/m.json': [fresh.raw], 'https://b.example/m.sig': [fresh.sig],
  }))
  assert.ok(r.ok && r.manifest.nodes.cid === 'bafkreinew' && r.from === 'https://b.example/m.json')
})

test('several sources: a forged or dead source is passed over and reported, never used', async () => {
  const fresh = signed(good)
  const forged = signed({ ...good, made: NOW, nodes: { cid: 'bafkreievil' } }, OTHER)
  const r = await fetchManifest(['https://evil.example/m.json', 'https://dead.example/m.json', 'https://ok.example/m.json'], PUB, NOW, served({
    'https://evil.example/m.json': [forged.raw], 'https://evil.example/m.sig': [forged.sig],
    'https://ok.example/m.json': [fresh.raw], 'https://ok.example/m.sig': [fresh.sig],
  }))
  assert.ok(r.ok && r.manifest.nodes.cid === 'bafkreib')
  assert.deepEqual(r.tried.map((t) => t.why).sort(), ['http', 'signature'])
})

test('several sources: when none verifies, the reason given is the verification failure, not "unreachable"', async () => {
  const expired = signed({ ...good, made: NOW - 3 * 86_400_000, expires: NOW - 86_400_000 })
  const r = await fetchManifest(['https://dead.example/m.json', 'https://x.example/m.json'], PUB, NOW, served({
    'https://x.example/m.json': [expired.raw], 'https://x.example/m.sig': [expired.sig],
  }))
  assert.ok(!r.ok)
  assert.equal(worstTry(r.tried), 'expired')
  const none = await fetchManifest(['https://dead.example/m.json'], PUB, NOW, served({}))
  assert.ok(!none.ok && worstTry(none.tried) === 'http')
})
