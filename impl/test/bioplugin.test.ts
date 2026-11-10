/**
 * The Android unlock key's wiring (src-tauri/plugins/onchato-bio), checked the
 * way scanplugin.test.ts checks the scanner: every link of the chain fails
 * only at runtime on a phone, where no test reaches.
 *
 *   web/src/passkey.ts  invoke('plugin:onchato-bio|<cmd>')
 *   capabilities/unlock.json  allow-<cmd>
 *   plugins/onchato-bio/build.rs  COMMANDS
 *   BioPlugin.kt  @Command fun <cmd>
 *   src/lib.rs (mobile)  .plugin(tauri_plugin_onchato_bio::init())
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const root = join(import.meta.dirname, '..')
const read = (...p: string[]) => readFileSync(join(root, ...p), 'utf8')
const PLUGIN = ['src-tauri', 'plugins', 'onchato-bio']

const invoked = () => [...read('web', 'src', 'passkey.ts').matchAll(/plugin:onchato-bio\|([a-z_]+)/g)].map((m) => m[1])
const declared = () => {
  const m = read(...PLUGIN, 'build.rs').match(/COMMANDS: &\[&str\] = &\[([^\]]*)\]/)
  assert.ok(m, 'build.rs has no COMMANDS list')
  return new Set([...m![1].matchAll(/"([a-z_]+)"/g)].map((x) => x[1]))
}
const kotlin = () => new Set([...read(...PLUGIN, 'android', 'src', 'main', 'java', 'BioPlugin.kt')
  .matchAll(/@Command\s+fun\s+([a-zA-Z_]+)\s*\(/g)].map((m) => m[1]))
const allowed = () => {
  const cap = JSON.parse(read('src-tauri', 'capabilities', 'unlock.json'))
  return cap.permissions.map((p: string) => {
    const [plugin, perm] = p.split(':')
    assert.equal(plugin, 'onchato-bio', `unlock.json grants ${p}, which is not the unlock plugin`)
    return perm.replace(/^allow-/, '').replace(/-/g, '_')
  })
}

test('every command the page sends exists in build.rs and in the Kotlin plugin, and is allowed', () => {
  const sent = new Set(invoked())
  assert.deepEqual([...sent].sort(), ['enroll', 'remove', 'status', 'unlock'])
  const have = declared(), kt = kotlin(), ok = new Set(allowed())
  for (const c of sent) {
    assert.ok(have.has(c), `passkey.ts invokes "${c}", which build.rs does not declare`)
    assert.ok(kt.has(c), `passkey.ts invokes "${c}", which BioPlugin.kt has no @Command for`)
    assert.ok(ok.has(c), `"${c}" is invoked but not allowed in capabilities/unlock.json`)
  }
  for (const c of ok) assert.ok(have.has(c), `unlock.json allows "${c}", which the plugin does not have`)
})

test('the plugin is registered on the phones and only there, with the Kotlin class it names', () => {
  const lib = read('src-tauri', 'src', 'lib.rs')
  assert.equal(lib.match(/tauri_plugin_onchato_bio::init\(\)/g)?.length, 1)
  const at = lib.indexOf('tauri_plugin_onchato_bio::init()')
  assert.ok(lib.lastIndexOf('tauri_plugin_barcode_scanner::init()', at) > 0, 'registered beside the scanner, in the mobile builder')
  const cargo = read('src-tauri', 'Cargo.toml')
  const mobile = cargo.indexOf(`[target.'cfg(any(target_os = "android", target_os = "ios"))'.dependencies]`)
  const dep = cargo.indexOf('tauri-plugin-onchato-bio')
  assert.ok(mobile > 0 && dep > mobile && dep < cargo.indexOf('[target.', mobile + 10), 'a phone-only dependency')
  const rs = read(...PLUGIN, 'src', 'lib.rs')
  const kt = read(...PLUGIN, 'android', 'src', 'main', 'java', 'BioPlugin.kt')
  const pkg = kt.match(/^package ([\w.]+)/m)?.[1]
  assert.ok(rs.includes(`"${pkg}"`), `lib.rs registers a package other than the Kotlin one (${pkg})`)
  assert.ok(rs.includes('"BioPlugin"') && /class BioPlugin\b/.test(kt))
  const cap = JSON.parse(read('src-tauri', 'capabilities', 'unlock.json'))
  assert.deepEqual(cap.platforms, ['android', 'iOS'])
})

test('the keystore key is bound to the person, for a short window, and dies with a new fingerprint', () => {
  const kt = read(...PLUGIN, 'android', 'src', 'main', 'java', 'BioPlugin.kt')
  assert.match(kt, /setUserAuthenticationRequired\(true\)/)
  assert.match(kt, /setUserAuthenticationParameters\(AUTH_WINDOW, KeyProperties\.AUTH_BIOMETRIC_STRONG or KeyProperties\.AUTH_DEVICE_CREDENTIAL\)/)
  assert.match(kt, /setInvalidatedByBiometricEnrollment\(true\)/)
  // A short window, the key used inside the prompt's success (a per-use
  // CryptoObject key never got its auth token on a Galaxy S24).
  const win = Number(/const val AUTH_WINDOW = (\d+)/.exec(kt)?.[1])
  assert.ok(win > 0 && win <= 15, `AUTH_WINDOW ${win}`)
  assert.match(kt, /onAuthenticationSucceeded[\s\S]*?invoke\.resolve\(use\(\)\)/)
  assert.doesNotMatch(kt, /setIsStrongBoxBacked\(true\)/)
  assert.doesNotMatch(kt, /[^\x00-\x7f]/, 'code is ASCII')
})
