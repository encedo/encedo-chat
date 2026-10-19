import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync, unlinkSync, utimesSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { parseAllowlist, refuse, watchAllowlist } from './allowlist.mjs'

const A = '12D3KooWCFSDy7y2BPVXNHbXArZP711UGubaUfpb3inMGPwJmCxb'
const B = '12D3KooWETFuqVqjexJQWc63EATd84gCigZLzw1ZX8FKvRLjgHLt'
const SIB = '12D3KooWLcDzqtSAetckwdzzqYbLTsN6wHFx8T4uKr5Yn1GUvSt5'

test('the list: one PeerId per line with an optional label; comments and junk are not entries', () => {
  const { ids, bad } = parseAllowlist(`# devices\n${A} Jan, phone\n\n  ${B}   # laptop\nnot-a-peer\n12D3KooWshort\n`)
  assert.deepEqual([...ids].sort(), [A, B].sort())
  assert.deepEqual(bad, [5, 6])
})

test('siblings always in, listed devices in, everyone else out', () => {
  const allowed = new Set([A]), siblings = new Set([SIB])
  assert.equal(refuse(A, allowed, siblings), false)
  assert.equal(refuse(SIB, allowed, siblings), false)
  assert.equal(refuse(B, allowed, siblings), true)
  assert.equal(refuse(B, new Set(), new Set()), true, 'an empty list lets nobody in')
})

test('the file is followed: an added device gets in, a removed one is reported; a vanished file keeps the last list', async () => {
  const d = mkdtempSync(join(tmpdir(), 'allow-')), f = join(d, 'peers.txt')
  try {
    writeFileSync(f, `${A}\n`)
    const changes = []
    const w = watchAllowlist(f, { everyMs: 20, log: () => {}, onChange: (ids) => changes.push([...ids]) })
    assert.ok(w.has(A) && !w.has(B))
    writeFileSync(f, `${B}\n`); utimesSync(f, new Date(), new Date(Date.now() + 5000))
    await new Promise((r) => setTimeout(r, 120))
    assert.ok(w.has(B) && !w.has(A), 'the edit was not picked up')
    assert.deepEqual(changes.at(-1), [B])
    unlinkSync(f)
    await new Promise((r) => setTimeout(r, 120))
    assert.ok(w.has(B), 'a missing file opened or closed the node')
    w.stop()
  } finally { rmSync(d, { recursive: true, force: true }) }
})
