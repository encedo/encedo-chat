import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync, statSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import { peerIdFromPrivateKey } from '@libp2p/peer-id'
import { loadOrCreateSeed, privateKeyFromSeed } from './nodekey.mjs'

const dir = () => mkdtempSync(join(tmpdir(), 'nodekey-'))

test('the first start makes a key, the next one reads the same key', () => {
  const d = dir()
  try {
    const a = loadOrCreateSeed(join(d, 'node.key'))
    assert.equal(a.made, true)
    assert.equal(a.seed.length, 32)
    assert.equal(statSync(join(d, 'node.key')).mode & 0o777, 0o600)
    const b = loadOrCreateSeed(join(d, 'node.key'))
    assert.equal(b.made, false)
    assert.ok(b.seed.equals(a.seed), 'a restart changed the PeerId')
    assert.notEqual(loadOrCreateSeed(join(d, 'other.key')).seed.toString('hex'), a.seed.toString('hex'), 'two nodes got the same key')
  } finally { rmSync(d, { recursive: true, force: true }) }
})

test('a damaged key file is refused, not replaced', () => {
  const d = dir()
  try {
    const f = join(d, 'node.key')
    writeFileSync(f, '# x\nnot-a-key\n', { mode: 0o600 })
    assert.throws(() => loadOrCreateSeed(f), /32-byte/)
    assert.equal(readFileSync(f, 'utf8'), '# x\nnot-a-key\n', 'the file was overwritten')
  } finally { rmSync(d, { recursive: true, force: true }) }
})

test('the key from a seed keeps every published PeerId (bs1-bs3 derive theirs from --pass)', () => {
  const ids = {
    'bs1.onchato.com': '12D3KooWP6SpQxgcUDdAU1CdY3dcvSrkxHPki7FRtMLLYiGxcDmp',
    'bs2.onchato.com': '12D3KooWJJJtAk9m6yTUdKwqUYpxcyWLZTVNgyrpZheyK161NT1y',
    'bs3.onchato.com': '12D3KooWLcDzqtSAetckwdzzqYbLTsN6wHFx8T4uKr5Yn1GUvSt5',
  }
  for (const [pass, id] of Object.entries(ids)) {
    const seed = createHash('sha256').update(pass).digest()
    assert.equal(peerIdFromPrivateKey(privateKeyFromSeed(seed)).toString(), id, pass)
  }
})

test('the key signs, and the signature verifies under its public key', async () => {
  const k = privateKeyFromSeed(Buffer.alloc(32, 7))
  const msg = new TextEncoder().encode('noise handshake payload')
  const sig = await k.sign(msg)
  assert.equal(await k.publicKey.verify(msg, sig), true)
  assert.equal(await k.publicKey.verify(new TextEncoder().encode('other'), sig), false)
})
