/**
 * patch.mjs — teach the generated Android project to stay awake.
 *
 * `tauri android init` writes the whole Android project from a template, into a
 * gitignored directory, on every build. That is a good property — nothing to
 * drift, nothing stale — and it means anything we need in that project has to
 * be applied AFTER init, the way `minSdk` already is.
 *
 * Everything here asserts its anchor and throws if it is missing. A silent
 * no-op would produce an APK that installs, runs, and quietly fails to be
 * reachable in a pocket, which is the exact bug this exists to fix. If Tauri
 * changes its template, this must break loudly in CI rather than ship.
 *
 * The transforms are exported so `test/android-patch.test.ts` can run them
 * against the real template text without an Android toolchain.
 */

import { readFileSync, writeFileSync, copyFileSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

export const PERMISSIONS = [
  // The service itself, and its type. Both are required from Android 14.
  'android.permission.FOREGROUND_SERVICE',
  'android.permission.FOREGROUND_SERVICE_SPECIAL_USE',
  // Without this the foreground notification is suppressed (the service still
  // runs) and every message notification is silently dropped.
  'android.permission.POST_NOTIFICATIONS',
  // Voice notes. Declared because the feature ships; whether Android's WebView
  // then passes getUserMedia through is NOT verified — wry installs the
  // WebChromeClient, and on Linux the equivalent bridge had to be answered by
  // hand (see `enable_webrtc` in lib.rs). If recording is refused on a phone,
  // that bridge is where to look, not here.
  'android.permission.RECORD_AUDIO',
  // Deliberately NOT android.permission.CAMERA: the QR scanner has never been
  // run on Android, and a permission an app declares and never uses is one it
  // has to justify to Play for nothing.
]

export function patchManifest(xml) {
  const anchor = '<uses-permission android:name="android.permission.INTERNET" />'
  if (!xml.includes(anchor)) throw new Error('manifest: the INTERNET permission anchor is gone')
  if (xml.includes('OnchatoService')) return xml // already patched

  const perms = PERMISSIONS.map((p) => `    <uses-permission android:name="${p}" />`).join('\n')
  xml = xml.replace(anchor, anchor + '\n' + perms)

  const close = '    </application>'
  if (!xml.includes(close)) throw new Error('manifest: no </application> to insert the service before')
  const service = [
    '',
    '        <!-- Reachability. See android/OnchatoService.kt for why a messenger',
    '             with no store-and-forward needs the process to stay alive. -->',
    '        <service',
    '            android:name=".OnchatoService"',
    '            android:exported="false"',
    '            android:foregroundServiceType="specialUse">',
    '            <property',
    '                android:name="android.app.PROPERTY_SPECIAL_USE_FGS_SUBTYPE"',
    '                android:value="peer-to-peer messaging with no push server; the app must hold its own connection to receive messages" />',
    '        </service>',
    '',
  ].join('\n')
  return xml.replace(close, service + close)
}

export function patchActivity(kt) {
  if (kt.includes('OnchatoService')) return kt // already patched
  const anchor = `  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
  }`
  if (!kt.includes(anchor)) throw new Error('MainActivity: the onCreate anchor is gone')

  const body = `  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
    // Asked here rather than at the moment a notification is drawn: by then the
    // app is in the background, where a permission dialog cannot be shown.
    val wanted = arrayOf(
      android.Manifest.permission.POST_NOTIFICATIONS,
      android.Manifest.permission.RECORD_AUDIO,
    ).filter { checkSelfPermission(it) != android.content.pm.PackageManager.PERMISSION_GRANTED }
    if (wanted.isNotEmpty()) requestPermissions(wanted.toTypedArray(), 1001)
    // Reachability starts with the app and ends with it: this is not a
    // background agent that outlives the window, it is the window's own process
    // asking not to be frozen while it is open.
    startForegroundService(android.content.Intent(this, OnchatoService::class.java))
  }

  override fun onDestroy() {
    stopService(android.content.Intent(this, OnchatoService::class.java))
    super.onDestroy()
  }`
  return kt.replace(anchor, body)
}

// ---- file side -------------------------------------------------------------
if (process.argv[1] && process.argv[1].endsWith('patch.mjs')) {
  const gen = process.argv[2]
  if (!gen) { console.error('usage: node patch.mjs <path to src-tauri/gen/android>'); process.exit(2) }
  const here = dirname(fileURLToPath(import.meta.url))
  const src = join(gen, 'app', 'src', 'main')
  const pkgDir = join(src, 'java', 'com', 'onchato', 'chat')

  mkdirSync(pkgDir, { recursive: true })
  copyFileSync(join(here, 'OnchatoService.kt'), join(pkgDir, 'OnchatoService.kt'))

  const manifest = join(src, 'AndroidManifest.xml')
  writeFileSync(manifest, patchManifest(readFileSync(manifest, 'utf8')))

  const activity = join(pkgDir, 'MainActivity.kt')
  writeFileSync(activity, patchActivity(readFileSync(activity, 'utf8')))

  console.log('android: foreground service installed into the generated project')
}
