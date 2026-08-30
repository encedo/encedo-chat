import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { patchManifest, patchActivity, PERMISSIONS, patchIconBackground, RUNNING_STRING, stringsXml } from '../src-tauri/android/patch.mjs'

/**
 * The real templates, copied from tauri-cli 2.11.4 with its placeholders
 * rendered. They live here so a Tauri template change breaks a test on a laptop
 * rather than an Android build in CI — and so the anchors this patcher depends
 * on are written down where a reader can see them.
 */
const MANIFEST = `<?xml version="1.0" encoding="utf-8"?>
<manifest xmlns:android="http://schemas.android.com/apk/res/android">
    <uses-permission android:name="android.permission.INTERNET" />

    <application
        android:icon="@mipmap/ic_launcher"
        android:label="@string/app_name">
        <activity
            android:name=".MainActivity"
            android:exported="true">
        </activity>
    </application>
</manifest>
`

const ACTIVITY = `package com.onchato.chat

import android.os.Bundle
import androidx.activity.enableEdgeToEdge

class MainActivity : TauriActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
  }
}
`

test('the manifest gains the permissions a foreground service needs', () => {
  const out = patchManifest(MANIFEST)
  for (const p of PERMISSIONS) assert.ok(out.includes(p), `missing ${p}`)
  assert.ok(out.includes('android:name=".OnchatoService"'))
  // The type is the decision: `dataSync` is capped at a few hours a day, which
  // would end a conversation silently in the evening.
  assert.ok(out.includes('android:foregroundServiceType="specialUse"'))
  assert.ok(out.includes('PROPERTY_SPECIAL_USE_FGS_SUBTYPE'))
  // Inside the application element, not beside it.
  assert.ok(out.indexOf('<service') < out.indexOf('</application>'))
  assert.ok(out.indexOf('<service') > out.indexOf('<application'))
})

test('the activity starts the service and gives it back on the way out', () => {
  const out = patchActivity(ACTIVITY)
  assert.ok(out.includes('startForegroundService'))
  assert.ok(out.includes('override fun onDestroy'))
  assert.ok(out.includes('stopService'))
  // Both are asked while a window is on screen: by the time a notification is
  // drawn the app is in the background, where no dialog can be shown, and the
  // microphone is wanted the moment somebody presses record.
  assert.ok(out.includes('POST_NOTIFICATIONS'))
  assert.ok(out.includes('RECORD_AUDIO'))
  assert.ok(out.includes('super.onCreate(savedInstanceState)'))
})

test('patching twice changes nothing the second time', () => {
  const once = patchManifest(MANIFEST)
  assert.equal(patchManifest(once), once)
  const act = patchActivity(ACTIVITY)
  assert.equal(patchActivity(act), act)
})

test('a template that has moved on breaks here, loudly', () => {
  // The whole point: a silent no-op would ship an APK that installs, runs and
  // quietly fails to be reachable in a pocket.
  assert.throws(() => patchManifest('<manifest></manifest>'), /INTERNET permission anchor/)
  assert.throws(() => patchActivity('class MainActivity : TauriActivity() {}'), /onCreate anchor/)
  assert.throws(
    () => patchManifest(MANIFEST.replace('    </application>', '</application>')),
    /no <\/application>/,
  )
})

/**
 * The icon on a phone at 0.4.5 was **Tauri's logo**. Not a missing asset —
 * `src-tauri/icons/android` has every density, adaptive and monochrome — but a
 * generated project that does not take them, so the template's default survives
 * into the APK. Nothing fails and nothing is logged; the only place it shows is
 * a home screen, which is why the patcher copies them now and why the colour
 * behind them is checked here.
 *
 * The adaptive icon draws our foreground over `@color/ic_launcher_background`,
 * and that colour is the template's — left alone, our mark sits on somebody
 * else's backdrop. It is rewritten in place because two definitions of one
 * Android resource is a build error, not a preference.
 */
test('the launcher background is rewritten where the template defines it', () => {
  const xml = [
    '<?xml version="1.0" encoding="utf-8"?>',
    '<resources>',
    '    <color name="ic_launcher_background">#2F2F2F</color>',
    '</resources>',
  ].join('\n')

  const out = patchIconBackground(xml, '#FFFFFF')
  assert.ok(out, 'the colour was there and should have been replaced')
  assert.ok(out!.includes('<color name="ic_launcher_background">#FFFFFF</color>'))
  assert.ok(!out!.includes('#2F2F2F'), 'the template colour should be gone, not duplicated')
  // Exactly one definition, still.
  assert.equal(out!.match(/ic_launcher_background/g)?.length, 1)
})

test('a file that defines no such colour is left alone, so nothing is duplicated', () => {
  const other = '<resources>\n    <color name="something_else">#123456</color>\n</resources>'
  assert.equal(patchIconBackground(other, '#FFFFFF'), null)
})

/**
 * "There is an icon in the status bar all the time, as if a notification were
 * hanging there, and it is empty." Both halves were true, and the empty half is
 * fixed here: a foreground service MUST show a notification — that is Android's
 * rule, not our choice — so the only question is whether it says anything. One
 * with a title and no body reads as a fault. This one explains why the app is
 * running when nobody opened it, in the phone's own language.
 */
test('the service notification has a line to show, in both languages', () => {
  assert.deepEqual(Object.keys(RUNNING_STRING).sort(), ['values', 'values-pl'])
  for (const [dir, text] of Object.entries(RUNNING_STRING)) {
    assert.ok(text.length > 10, `${dir}: "${text}" is not a sentence`)
    const xml = stringsXml(text)
    assert.ok(xml.includes('name="onchato_running"'), `${dir}: the name the Kotlin looks up is missing`)
    assert.ok(xml.startsWith('<?xml'), `${dir}: not a resource file`)
  }
})

test('a string with XML in it is escaped, not injected', () => {
  const xml = stringsXml('tło & <b>pilne</b>')
  assert.ok(xml.includes('tło &amp; &lt;b>pilne&lt;/b>'))
  assert.ok(!xml.includes('<b>'), 'raw markup would break the resource compiler')
})

/**
 * The status-bar icon was tiny next to every other one (reported at 0.5.9),
 * because the service reused `ic_launcher_monochrome`: that layer keeps the
 * adaptive-icon safe zone (glyph ≈44% of the canvas, the launcher mask crops
 * 66/108 dp), and the status bar draws a resource full-bleed. The fix is a
 * dedicated `ic_stat_onchato` drawable, and THREE files must agree on it: the
 * PNGs checked into `icons/android/drawable-*`, the Kotlin's `setSmallIcon`,
 * and the message plugin's icon in `tauri.android.conf.json`. Any one of them
 * regressing alone fails silently on a phone — the plugin falls back to the
 * system's ℹ dialog icon, the Kotlin to a build error only if the PNGs are
 * gone too. So this pins all three, and the PNG dimensions (a regenerated
 * icon set that forgets the drawables is the likely way to lose them).
 */
test('the status-bar icon exists at every density and both notification paths name it', () => {
  const root = new URL('../src-tauri/', import.meta.url)
  const densities: Record<string, number> = { mdpi: 24, hdpi: 36, xhdpi: 48, xxhdpi: 72, xxxhdpi: 96 }
  for (const [dpi, px] of Object.entries(densities)) {
    const file = new URL(`icons/android/drawable-${dpi}/ic_stat_onchato.png`, root)
    const bytes = readFileSync(file)
    // PNG IHDR: width and height are big-endian u32 at offsets 16 and 20.
    assert.equal(bytes.readUInt32BE(16), px, `${dpi}: width should be ${px}`)
    assert.equal(bytes.readUInt32BE(20), px, `${dpi}: height should be ${px}`)
  }

  const kt = readFileSync(new URL('android/OnchatoService.kt', root), 'utf8')
  assert.ok(kt.includes('R.drawable.ic_stat_onchato'), 'the service should draw the status-bar icon')
  assert.ok(!kt.includes('setSmallIcon(R.mipmap'), 'a mipmap in the status bar is the bug this fixed')

  // ⚠️ BISECT IN PROGRESS (0.5.20): APKs die at launch from 0.5.10 onward —
  // activity gone, service icon standing — and this plugin config is the one
  // 0.5.10 change that runs in the ACTIVITY's process. It is removed
  // diagnostically; the assertion flips to pin the removal so the suite stays
  // honest about the state it tests. When the culprit is confirmed and fixed,
  // restore: conf.plugins?.notification?.icon === 'ic_stat_onchato'.
  const conf = JSON.parse(readFileSync(new URL('tauri.android.conf.json', root), 'utf8'))
  assert.equal(conf.plugins?.notification?.icon, undefined,
    'the notification plugin config is diagnostically removed — see the bisect note above')
})
