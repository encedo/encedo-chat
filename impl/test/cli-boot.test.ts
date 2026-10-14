/**
 * The terminal client starts at all.
 *
 * Every other CLI test imports the modules behind cli/onchato.ts, never the
 * entry point itself - so in 0.7.34 a duplicate `const` in signIn shipped and
 * every `onchato-cli` command died with a SyntaxError before doing anything,
 * the Docker image included, with the whole suite green. This runs the file as
 * a process, the way a user does.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const CLI = new URL('../cli/onchato.ts', import.meta.url).pathname

function run(...args: string[]) {
  const home = mkdtempSync(join(tmpdir(), 'onchato-boot-'))
  try {
    return spawnSync(process.execPath, [CLI, ...args], { env: { ...process.env, ONCHATO_HOME: home }, encoding: 'utf8', timeout: 30_000 })
  } finally { rmSync(home, { recursive: true, force: true }) }
}

test('onchato-cli parses and prints its usage', () => {
  const r = run('help')
  assert.equal(r.status, 0, r.stderr)
  assert.match(r.stdout, /onchato-cli profile new/)
})

test('a command that signs in reaches the sign-in, not a SyntaxError', () => {
  // No profile in an empty home: signIn's own refusal, which proves the whole
  // file - signIn included - was compiled and ran.
  const r = run('contacts')
  assert.doesNotMatch(r.stderr, /SyntaxError|ReferenceError|TypeError/, r.stderr)
  assert.match(r.stderr, /brak profilu/)
  assert.equal(r.status, 1)
})
