/**
 * The native unlock key's wiring (src-tauri/plugins/onchato-bio), checked the
 * way scanplugin.test.ts checks the scanner: every link of the chain fails
 * only at runtime on a phone or a Windows machine, where no test reaches.
 *
 *   web/src/passkey.ts  invoke('plugin:onchato-bio|<cmd>')
 *   capabilities/unlock.json  allow-<cmd>
 *   plugins/onchato-bio/build.rs  COMMANDS
 *   BioPlugin.kt  @Command fun <cmd>            (Android)
 *   src/hello.rs  #[tauri::command] fn <cmd>   (Windows)
 *   src/lib.rs (mobile, and desk on Windows)  .plugin(tauri_plugin_onchato_bio::init())
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
const HELLO = () => read(...PLUGIN, 'src', 'hello.rs')
/** Commands hello.rs defines AND the plugin hands to Tauri (generate_handler). */
const hello = () => {
  const rs = HELLO(), lib = read(...PLUGIN, 'src', 'lib.rs')
  const defined = new Set([...rs.matchAll(/#\[tauri::command\(rename_all = "snake_case"\)\]\s*pub async fn ([a-z_]+)\(/g)].map((m) => m[1]))
  const handed = new Set([...(lib.match(/generate_handler!\[([^\]]*)\]/)?.[1] ?? '').matchAll(/hello::([a-z_]+)/g)].map((m) => m[1]))
  return new Set([...defined].filter((c) => handed.has(c)))
}
const allowed = () => {
  const cap = JSON.parse(read('src-tauri', 'capabilities', 'unlock.json'))
  return cap.permissions.map((p: string) => {
    const [plugin, perm] = p.split(':')
    assert.equal(plugin, 'onchato-bio', `unlock.json grants ${p}, which is not the unlock plugin`)
    return perm.replace(/^allow-/, '').replace(/-/g, '_')
  })
}

test('every command the page sends exists in build.rs, the Kotlin plugin and hello.rs, and is allowed', () => {
  const sent = new Set(invoked())
  assert.deepEqual([...sent].sort(), ['enroll', 'remove', 'status', 'unlock'])
  const have = declared(), kt = kotlin(), win = hello(), ok = new Set(allowed())
  for (const c of sent) {
    assert.ok(have.has(c), `passkey.ts invokes "${c}", which build.rs does not declare`)
    assert.ok(kt.has(c), `passkey.ts invokes "${c}", which BioPlugin.kt has no @Command for`)
    // Without rename_all Tauri 2 would expect camelCase arguments (the 0.7.27 trap).
    assert.ok(win.has(c), `passkey.ts invokes "${c}", which hello.rs does not define as a snake_case command handed to generate_handler`)
    assert.ok(ok.has(c), `"${c}" is invoked but not allowed in capabilities/unlock.json`)
  }
  for (const c of ok) assert.ok(have.has(c), `unlock.json allows "${c}", which the plugin does not have`)
})

test('the plugin is registered on the phones and on Windows only, with the Kotlin class it names', () => {
  const lib = read('src-tauri', 'src', 'lib.rs')
  const calls = [...lib.matchAll(/tauri_plugin_onchato_bio::init\(\)/g)].map((m) => m.index!)
  assert.equal(calls.length, 2)
  const phone = calls.find((at) => /tauri_plugin_barcode_scanner::init\(\)\)\s*\.plugin\($/.test(lib.slice(at - 60, at)))
  assert.ok(phone !== undefined, 'registered beside the scanner, in the mobile builder')
  const win = calls.find((at) => at !== phone)!
  assert.match(lib.slice(win - 80, win), /#\[cfg\(windows\)\]\s*let b = b\.plugin\($/, 'the desktop registration is Windows only')
  // Linked only where it has a native side: the phones and Windows, never macOS or Linux.
  const cargo = read('src-tauri', 'Cargo.toml')
  const sections = cargo.split(/^(?=\[)/m).filter((sec) => sec.includes('tauri-plugin-onchato-bio'))
  assert.deepEqual(sections.map((sec) => sec.split('\n')[0]).sort(), [
    `[target.'cfg(any(target_os = "android", target_os = "ios"))'.dependencies]`,
    `[target.'cfg(windows)'.dependencies]`,
  ])
  // A Rust handler on a phone would shadow the Kotlin plugin.
  const plib = read(...PLUGIN, 'src', 'lib.rs')
  assert.match(plib, /#\[cfg\(windows\)\]\s*let b = b\.invoke_handler\(/)
  assert.match(plib, /#\[cfg\(windows\)\]\s*mod hello;/)
  const rs = read(...PLUGIN, 'src', 'lib.rs')
  const kt = read(...PLUGIN, 'android', 'src', 'main', 'java', 'BioPlugin.kt')
  const pkg = kt.match(/^package ([\w.]+)/m)?.[1]
  assert.ok(rs.includes(`"${pkg}"`), `lib.rs registers a package other than the Kotlin one (${pkg})`)
  assert.ok(rs.includes('"BioPlugin"') && /class BioPlugin\b/.test(kt))
  const cap = JSON.parse(read('src-tauri', 'capabilities', 'unlock.json'))
  assert.deepEqual(cap.platforms, ['android', 'iOS', 'windows'])
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

test('the Hello secret is a hash of a signature over a challenge bound to the slot', () => {
  const rs = HELLO()
  assert.match(rs, /const CHALLENGE: &str = "onchato-soft-unlock-hello-v1:";/)
  assert.match(rs, /format!\("\{CHALLENGE\}\{alias\}"\)/, 'the alias goes into the challenge')
  assert.match(rs, /Sha256::digest\(&sig\[\.\.\]\)/)
  // A failed enrolment leaves no credential behind.
  assert.match(rs, /Err\(e\) => \{\s*forget\(&name\);/)
  assert.doesNotMatch(rs, /[^\x00-\x7f]/, 'code is ASCII')
})
