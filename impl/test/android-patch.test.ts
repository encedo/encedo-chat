import { test } from 'node:test'
import assert from 'node:assert/strict'
import { patchManifest, patchActivity, PERMISSIONS } from '../src-tauri/android/patch.mjs'

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
