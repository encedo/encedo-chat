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

import { readFileSync, writeFileSync, copyFileSync, mkdirSync, readdirSync, existsSync } from 'node:fs'
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
  // The QR scanner. This was DELIBERATELY absent while the scanner had never
  // been run on Android — and then somebody ran it (0.5.16, live): the modal
  // opened, the video stayed a grey placeholder, and the app said "Permission
  // denied" while the system's permission screen listed no camera row at all,
  // because a permission the manifest does not declare cannot even be asked
  // for. A phone is the scanner's natural home, so the old justification is
  // now backwards: this is a permission the app declares and visibly uses.
  'android.permission.CAMERA',
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
      android.Manifest.permission.CAMERA,
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

/**
 * The launcher icon, copied in — because `android init` does not.
 *
 * Reported from a phone at 0.4.5: the app on the home screen wears **Tauri's
 * logo**. The assets are not missing and never were — `src-tauri/icons/android`
 * holds the right ones, every density, adaptive and monochrome included. The
 * generated project simply does not take them, and the template's own default
 * survives into the APK. Nothing fails, nothing is logged, and the only place it
 * shows is a home screen.
 *
 * So this copies them where the build looks, next to everything else this file
 * puts into a tree that is regenerated on every run. It ASSERTS, like the rest
 * of the patcher: a missing source or an empty copy stops the build rather than
 * shipping somebody else's brand again.
 *
 * ⚠️ The colour is ours too. The adaptive icon draws `ic_launcher_foreground`
 * over `@color/ic_launcher_background`, and that colour belongs to whatever
 * icon the template shipped — leaving it makes our mark sit on Tauri's
 * backdrop. It is rewritten where the template defines it, and created only
 * when it defines it nowhere, because two definitions of one resource is a
 * build error rather than a preference.
 */
export function patchIconBackground(xml, colour) {
  const found = /(<color name="ic_launcher_background">)([^<]*)(<\/color>)/.exec(xml)
  if (!found) return null
  return xml.replace(found[0], found[1] + colour + found[3])
}

const ICON_BACKGROUND = '#FFFFFF'

/**
 * The one string the foreground-service notification shows, in both languages.
 *
 * It is a RESOURCE rather than a literal in the Kotlin because Android picks
 * the file by the phone's language for free, and because a notification that
 * says only "onchato" reads as an empty notification hanging in the shade —
 * which is exactly how it was reported. What it needs to say is why the app is
 * running when nobody opened it.
 */
export const RUNNING_STRING = {
  'values': 'Receiving messages in the background',
  'values-pl': 'Odbiera wiadomości w tle',
}

export function stringsXml(text) {
  return '<?xml version="1.0" encoding="utf-8"?>\n<resources>\n'
    + `    <string name="onchato_running">${text.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</string>\n`
    + '</resources>\n'
}

function installIcons(from, res) {
  if (!existsSync(from)) throw new Error(`android icons: ${from} is not there — has \`tauri icon\` been run?`)
  // mipmap-*: the launcher set `tauri icon` generates. drawable-*: ours —
  // `ic_stat_onchato`, the status-bar silhouette. The launcher's monochrome
  // layer keeps the adaptive-icon safe zone (glyph ≈44% of the canvas), and the
  // status bar draws a resource full-bleed, so reusing it there shipped an icon
  // visibly smaller than every other one in the bar (reported at 0.5.9). The
  // drawables carry the same mark cropped and rescaled to status-bar padding.
  const dirs = readdirSync(from).filter((d) => d.startsWith('mipmap') || d.startsWith('drawable'))
  if (!dirs.length) throw new Error('android icons: no mipmap-*/drawable-* directories to copy')

  let copied = 0
  for (const dir of dirs) {
    mkdirSync(join(res, dir), { recursive: true })
    for (const file of readdirSync(join(from, dir))) {
      copyFileSync(join(from, dir, file), join(res, dir, file))
      copied++
    }
  }
  if (!copied) throw new Error('android icons: the mipmap directories are empty')
  // Both notification paths name this resource — the service in Kotlin and the
  // message plugin via `tauri.android.conf.json` — and a missing drawable is a
  // BUILD error there and a silent system fallback here. Fail loudly instead.
  if (!existsSync(join(res, 'drawable-xxxhdpi', 'ic_stat_onchato.png')))
    throw new Error('android icons: ic_stat_onchato.png did not land in res/drawable-xxxhdpi')

  // Wherever the template keeps its colours, that is where ours goes.
  const values = readdirSync(res).filter((d) => d.startsWith('values'))
  let placed = false
  for (const dir of values) {
    for (const file of readdirSync(join(res, dir))) {
      if (!file.endsWith('.xml')) continue
      const path = join(res, dir, file)
      const next = patchIconBackground(readFileSync(path, 'utf8'), ICON_BACKGROUND)
      if (next) { writeFileSync(path, next); placed = true }
    }
  }
  if (!placed) {
    mkdirSync(join(res, 'values'), { recursive: true })
    writeFileSync(join(res, 'values', 'ic_launcher_background.xml'),
      `<?xml version="1.0" encoding="utf-8"?>\n<resources>\n    <color name="ic_launcher_background">${ICON_BACKGROUND}</color>\n</resources>\n`)
  }

  for (const [dir, text] of Object.entries(RUNNING_STRING)) {
    mkdirSync(join(res, dir), { recursive: true })
    writeFileSync(join(res, dir, 'onchato_strings.xml'), stringsXml(text))
  }
  console.log(`android: ${copied} icon file(s) installed, background ${ICON_BACKGROUND}, service strings in ${Object.keys(RUNNING_STRING).length} language(s)`)
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

  installIcons(join(here, '..', 'icons', 'android'), join(src, 'res'))

  console.log('android: foreground service installed into the generated project')
}
