import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync, statSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { loadOrCreateSeed } from './nodekey.mjs'

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
