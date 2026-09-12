/**
 * The Content Security Policy in index.html.
 *
 * Parsed rather than eyeballed, because the two mistakes this policy invites
 * are both silent. One is loosening `script-src`, which voids the only
 * directive that decides whether foreign code runs. The other is TIGHTENING
 * `connect-src`, which looks like an improvement and breaks signing in with a
 * HEM: the device's address is typed by the person at login and can never be
 * on a list compiled into the build. The first version of this policy did
 * exactly that, and no test or browser run caught it — the harness only ever
 * uses software profiles.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const HTML = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'web', 'index.html'), 'utf8')
const policy = (): Record<string, string[]> => {
  const m = HTML.match(/<meta http-equiv="Content-Security-Policy" content="([^"]+)"/)
  assert.ok(m, 'no CSP in index.html')
  return Object.fromEntries(m![1].split(';').map((d) => {
    const [name, ...values] = d.trim().split(/\s+/)
    return [name, values]
  }))
}

test('everything is denied by default', () => {
  assert.deepEqual(policy()['default-src'], ["'none'"])
})

test('no foreign code may run, and no inline script may be nameless', () => {
  const script = policy()['script-src']
  assert.ok(script.includes("'self'"))
  assert.equal(script.includes("'unsafe-inline'"), false, "an inline script must be named by hash, never allowed wholesale")
  assert.equal(script.includes("'unsafe-eval'"), false)
  // The hash is substituted at build time from the EMITTED page (webpack.config.cjs);
  // the source carries the placeholder, and losing it fails the build.
  assert.ok(script.some((v) => v === '__CSP_SCRIPT_HASHES__' || v.startsWith("'sha256-")),
    'the inline script lost its hash placeholder')
})

test('a HEM at an address nobody could know at build time still works', () => {
  // The failure this exists to prevent. A person signs in by typing their
  // device's URL — a LAN address, a name on their own network, anything.
  const connect = policy()['connect-src']
  const reachable = (url: string) => connect.some((v) =>
    v === url || (v === 'https:' && url.startsWith('https://')) || (v === 'wss:' && url.startsWith('wss://')))
  for (const url of ['https://192.168.1.50', 'https://hem.local', 'https://10.0.0.7:8443']) {
    assert.ok(reachable(url), `signing in with a HEM at ${url} would be refused`)
  }
  // ...and a relay the user added by hand, which is the same argument.
  assert.ok(reachable('wss://relay.example.org'))
  // What stays shut.
  assert.equal(connect.includes('http:'), false, 'plaintext stays out')
  assert.equal(connect.includes('*'), false)
})

test('the policy names no host, so a self-hosted build changes nothing here', () => {
  const m = HTML.match(/<meta http-equiv="Content-Security-Policy" content="([^"]+)"/)!
  assert.equal(/onchato\.com|encedo\.com/.test(m[1]), false,
    'a hostname in the policy is a line every self-hoster would have to edit')
})

test('the rest of the doors stay locked', () => {
  const p = policy()
  assert.deepEqual(p['object-src'], ["'none'"])
  assert.deepEqual(p['base-uri'], ["'none'"])
  assert.deepEqual(p['form-action'], ["'none'"])
})
