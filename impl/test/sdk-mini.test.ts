/**
 * The client ships the HEM SDK stripped to the methods it calls
 * (lib/hem-sdk.mini.js, built by scripts/sdk-mini.mjs from the submodule).
 * Two ways that can go wrong silently, and the check for each:
 *
 *   - the code starts calling an SDK method the list does not keep: it is
 *     undefined at run time, on a HEM path no automated test reaches. Every
 *     `.method(` in the client that names a method of the SDK's HEM must be
 *     in the keep list.
 *   - the submodule or the list moved and the stripped file did not: its
 *     first line carries the sha256 of both, recomputed here.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const impl = join(dirname(fileURLToPath(import.meta.url)), '..')
const sdkSrc = join(impl, '..', 'hem-sdk-js', 'hem-sdk.js')
const keepPath = join(impl, 'lib', 'hem-sdk.keep.json')
const miniPath = join(impl, 'lib', 'hem-sdk.mini.js')
const keep: string[] = JSON.parse(readFileSync(keepPath, 'utf8')).methods
const sha = (p: string) => createHash('sha256').update(readFileSync(p)).digest('hex')

/** The public methods of class HEM in the SDK source. */
function sdkMethods(): Set<string> {
  const src = readFileSync(sdkSrc, 'utf8')
  const body = src.slice(src.indexOf('export class HEM'), src.indexOf('export class Attest'))
  return new Set([...body.matchAll(/^ {2}(?:async \*?|\*)?([a-zA-Z]\w*)\(/gm)].map((m) => m[1]).filter((n) => n !== 'constructor'))
}

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f)
    if (statSync(p).isDirectory()) return f === 'node_modules' || f === 'dist' ? [] : sources(p)
    return /\.ts$/.test(f) ? [p] : []
  })
}

test('every SDK method the client calls is kept in the stripped build', () => {
  const methods = sdkMethods()
  assert.ok(methods.size > 50 && methods.has('ecdhHkdf') && methods.has('uploadFirmware'), `read ${methods.size} SDK methods`)
  const missing = new Map<string, string>()
  for (const file of ['lib', 'cli', 'net', 'eh2', 'web/src'].flatMap((d) => sources(join(impl, d)))) {
    for (const [, name] of readFileSync(file, 'utf8').matchAll(/\bhem\??\.([a-zA-Z]\w*)\(/g)) {
      if (methods.has(name) && !keep.includes(name)) missing.set(name, file.slice(impl.length + 1))
    }
  }
  assert.deepEqual([...missing], [], 'add these to lib/hem-sdk.keep.json and run node scripts/sdk-mini.mjs')
  for (const k of keep) assert.ok(methods.has(k), `${k} in the keep list is not an SDK method`)
})

test('the stripped build is current: built from this submodule and this list', () => {
  const first = readFileSync(miniPath, 'utf8').split('\n')[0]
  const m = first.match(/sha256=([0-9a-f]{64}) keep=([0-9a-f]{64})/)
  assert.ok(m, `no build stamp in ${first}`)
  assert.equal(m![1], sha(sdkSrc), 'hem-sdk-js moved since lib/hem-sdk.mini.js was built: node scripts/sdk-mini.mjs')
  assert.equal(m![2], sha(keepPath), 'the keep list changed since the build: node scripts/sdk-mini.mjs')
})

test('the stripped build has every kept method and not the others', async () => {
  const { HEM, HemError } = await import('../lib/hem-sdk.mini.js')
  const h = new HEM('https://hem.invalid')
  for (const k of keep) assert.equal(typeof h[k], 'function', k)
  for (const k of ['uploadFirmware', 'exdsaSign', 'attest', 'initialize']) assert.equal(h[k], undefined, `${k} is not shipped`)
  assert.equal(typeof HemError, 'function')
})
