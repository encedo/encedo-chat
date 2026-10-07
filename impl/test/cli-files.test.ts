import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { safeName, freePath, mimeOf, humanSize, saveFile } from '../cli/files.ts'

test('a received name cannot leave the download directory or hide itself', () => {
  assert.equal(safeName('../../etc/passwd'), 'passwd')
  assert.equal(safeName('C:\\\\Windows\\\\x.dll'.replace(/\\\\/g, '\\')).includes('\\'), false)
  assert.equal(safeName('.bashrc'), 'bashrc', 'not a dot-file by accident')
  assert.equal(safeName('a\u202eb.txt'), 'a_b.txt', 'no direction override')
  assert.equal(safeName('   '), 'plik', 'never empty')
  assert.equal(safeName('raport q3.pdf'), 'raport q3.pdf', 'an ordinary name is kept')
})

test('an existing file is never overwritten', () => {
  const d = mkdtempSync(join(process.env.TMPDIR || tmpdir(), 'onchato-dl-'))
  assert.equal(freePath(d, 'a.txt'), join(d, 'a.txt'))
  writeFileSync(join(d, 'a.txt'), 'x'); writeFileSync(join(d, 'a (2).txt'), 'x')
  assert.equal(freePath(d, 'a.txt'), join(d, 'a (3).txt'))
})

test('types and sizes', () => {
  assert.equal(mimeOf('x.PDF'), 'application/pdf'); assert.equal(mimeOf('x.unknown'), 'application/octet-stream')
  assert.equal(humanSize(512), '512 B'); assert.equal(humanSize(150_000), '146 kB'); assert.equal(humanSize(3 * 1048576), '3.0 MB')
})

test('an expired file is refused before anything is fetched', async () => {
  const meta: any = { cid: 'never-fetched', exp: 1000, name: 'x', key: '', alg: 'A256GCM-chunked-v1', size: 1, chunk: 1, chunks: 1 }
  await assert.rejects(saveFile(meta, tmpdir(), 2000), /wygasł/)
})
