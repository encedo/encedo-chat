#!/usr/bin/env node
/**
 * sdk-mini.mjs - build impl/lib/hem-sdk.mini.js: the HEM SDK with only the
 * methods this project calls (impl/lib/hem-sdk.keep.json), by the SDK's own
 * rollup.mini.config.js. The client imports that file, never hem-sdk.js, so
 * the SDK code in the bundle is exactly the code an auditor reads there.
 *
 *   node scripts/sdk-mini.mjs            # after a submodule bump or a keep-list change
 *
 * The first line says what it was built from: sha256 of hem-sdk.js and of the
 * keep list. test/sdk-mini.test.ts recomputes both and fails when the file is
 * stale, and fails when the code calls an SDK method the list does not keep.
 */
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const sdk = join(root, 'hem-sdk-js')
const keep = join(root, 'impl', 'lib', 'hem-sdk.keep.json')
const out = join(root, 'impl', 'lib', 'hem-sdk.mini.js')
const ROLLUP = 'rollup@4.63.2'

const sha = (p) => createHash('sha256').update(readFileSync(p)).digest('hex')
const tmp = join(mkdtempSync(join(tmpdir(), 'sdk-mini-')), 'mini.js')
execFileSync('npx', ['--yes', ROLLUP, '-c', 'rollup.mini.config.js', '--silent'], {
  cwd: sdk, stdio: 'inherit', env: { ...process.env, KEEP: keep, OUT: tmp },
})
const stamp = `// built from hem-sdk.js sha256=${sha(join(sdk, 'hem-sdk.js'))} keep=${sha(keep)} by scripts/sdk-mini.mjs (${ROLLUP})\n`
writeFileSync(out, stamp + readFileSync(tmp, 'utf8'))
console.log(`wrote ${out} (${readFileSync(out).length} bytes)`)
