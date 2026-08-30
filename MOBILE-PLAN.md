# Mobile — plan (Android + iOS)

Working notes, not a spec. This file is implementation reality, like `CLAUDE.md`
and `GROUPS-DESIGN.md`.

Written 2026-08-04; brought up to reality 2026-08-30. **Android is no longer a
plan** — a signed APK ships from CI on every tag, the foreground service keeps
it reachable in a pocket (confirmed on a device), and the decisions the 2026-08
draft framed as open are recorded below as decisions. iOS remains the plan it
was.

---

## What is already settled (do not re-litigate)

- **The engine runs on mobile Chromium.** onchato.com works in Chrome and Brave
  on **Android 15** — login, conversation, the lot. That is not a partial
  result: without X25519, HKDF, AES-GCM, WebSocket and localStorage the app
  cannot start at all, so all five are proven on that WebView generation.
- **WebKit does the crypto.** The Tauri desktop `.deb` runs on WebKitGTK, over a
  custom scheme, and completes EH-2. WebKitGTK is a WebKit port, so this is a
  real (not conclusive) signal for WKWebView on iOS.
- **The phone layout exists and is tested.** `@media (max-width:900px),
  (max-height:560px)` gives one pane at a time; `--app-h` tracks
  `visualViewport` so the keyboard cannot bury the composer. Pinned by the
  browser-test "phone layout" scenario in both orientations, and by
  `node net/phone-shot.ts <dir>` at real device metrics.
- **Capability probing is shipped** (`lib/capabilities.ts`). It derives with
  X25519 rather than naming it — several webviews expose the algorithm and then
  throw — and separates REQUIRED (refuse to start, say why) from DEGRADED (log
  it, carry on). Visible on a phone in the Network tab, row "Platforma"; a
  phone has no console.

### Secure context — the one that looked like a risk and mostly is not

WebCrypto needs a secure context: HTTPS, or HTTP on `localhost`. Tauri serves
from:

| platform | origin |
|---|---|
| Android, Windows | `http://tauri.localhost` (`useHttpsScheme: true` → `https://`) |
| macOS, iOS | `tauri://localhost` |
| Linux | custom scheme |

`tauri.localhost` is chosen deliberately: Chromium treats the whole `*.localhost`
suffix as potentially trustworthy (RFC 6761), so it IS a secure context and
`crypto.subtle` exists. **Android is therefore low risk.** If a device ever
disagrees, the fix is `useHttpsScheme: true` in `tauri.conf.json` — know it,
do not pre-apply it.

iOS uses a custom scheme instead, and WebKit's treatment of those as secure
contexts *was* the remaining unknown. **Answered 2026-08-04: it is fine.** The
probe was run on a real iPhone against onchato.com and reported every required
capability present — same WebKit WKWebView uses. Nothing about the crypto path
is now in doubt on any of the three platforms:

| platform | probe result |
|---|---|
| desktop (browser) | all required present |
| Android 15, Chrome + Brave | all required present, WebRTC too |
| **iOS, mobile Safari** | **all required present** |

That closes the question the whole capability probe was written to answer, and
it means `cargo tauri ios init` is worth the Mac's time.

---

## Android — built. This section records what shipped and why.

### Toolchain — the known-good set (what CI installs, `.github/workflows/android.yml`)

`platforms;android-34`, `build-tools;34.0.0`, `ndk;27.1.12297006`, JDK
**temurin 21**, and **only** the `aarch64-linux-android` Rust target — minSdk 34
means every supported phone is 64-bit ARM, and without `--target` the build
compiles four architectures (487 MB of artifacts against 7.9 MB).

```bash
npm run tauri -- android init
node src-tauri/android/patch.mjs src-tauri/gen/android   # see below — REQUIRED
npm run tauri -- android build --aab --apk --target aarch64
```

Always through `npm run`, never `npx`: the generated Gradle project calls
`npm run tauri` from its own task, and under npx that dies on
`Missing script: "tauri"` buried inside an `Io(Env(…))` error.

**The APK is signed in CI** — zipalign + apksigner (v2/v3; jarsigner is v1-only
and was rejected) + `apksigner verify`, keystore exclusively from repository
secrets (`ANDROID_KEYSTORE_B64` + passwords/alias); missing secrets fail the job
immediately, by name. The `.aab` is deliberately unsigned — Play App Signing
takes it as-is. Two separate artifacts so nobody sideloads the uninstallable one.

**`minSdk = 34`** (not "target API" — targetSdk stays the template's), patched
after `android init` and verified with two `grep`s, because a `sed` that misses
would silently leave the template's value. The typed `startForeground` call in
the service *requires* 34+.

### `patch.mjs` — the mechanism everything Android rides on

`src-tauri/gen/android` is generated and gitignored on every build, so nothing
can be edited there by hand. `src-tauri/android/patch.mjs` runs after
`android init` and injects everything ours: the manifest permissions and service
declaration, `MainActivity` hooks (permission request + service start/stop),
`OnchatoService.kt`, the launcher + status-bar icons (`android init` does NOT
take `icons/android` — the template's Tauri logo shipped once, at 0.4.5), the
launcher background colour, and the localized service string (`values/` +
`values-pl/`). Every transform **asserts its anchor and fails the build** when
the Tauri template changes; the transforms are unit-tested against real
template text in `test/android-patch.test.ts`.

### The decisions the 2026-08-04 draft left open — all taken

1. **Background lifecycle → foreground service**, `OnchatoService.kt`. Type
   `specialUse`, NOT `dataSync` — dataSync is capped at ~6 h/day on Android 15
   and would end a conversation silently in the evening. The notification is the
   honest price and says why the app runs, in the phone's language. `START_STICKY`.
   Confirmed on a device: a message arrives with the screen off.
2. **Notifications → foreground service + local notifications** (`lib/notify.ts`;
   no message text in any mode). FCM rejected as designed — no Google server
   between two people. `POST_NOTIFICATIONS` is requested in `onCreate`, before
   the app can be backgrounded.
3. **Identity → the software profile ships** (password-sealed, `lib/profile.ts`);
   a HEM is reachable over the network unchanged. The sign-in card deliberately
   lists nothing about HEM identities (the handle+address row was cut as a leak).
4. **Battery and mesh — still unmeasured.** GossipSub keepalives plus one
   presence watch per contact on a radio that wants to sleep: measure before
   tuning. The only item of the original list that is still open.

---

## iOS

A MacBook Air M5 is available, which changes the economics from what was
assumed earlier.

| | |
|---|---|
| Build | **locally on the Mac**, Xcode. Not possible from the Linux VM — and note the VM is a guest on that same Mac. |
| Test on your own iPhone | **free** — free provisioning with an ordinary Apple ID; the signature expires after 7 days and is re-signed. |
| 99 USD/yr | only for **TestFlight / App Store**, i.e. shipping to anyone else. |
| WebRTC | **present** in WKWebView — unlike desktop WebKitGTK, so the direct plane should live on iOS. |
| Crypto | Safari 17 added X25519 to WebCrypto. Do not trust the version number — this is the WebKitGTK lesson; run the probe. |
| Export compliance | E2E encryption requires the declaration at publication. |

```bash
npm run tauri -- ios init          # npm run, not npx — the Android trap applies
npm run tauri -- ios dev           # device or simulator
npm run tauri -- ios build
```

**Sequencing:** open onchato.com in mobile Safari first. It is the same WebKit
WKWebView uses, so a green probe there means the packaging is a formality and a
red one saves the whole exercise.

---

## Sequence

1. ~~Deploy the web build with the probe~~ — **done.**
2. ~~**iPhone, mobile Safari**~~ — **done 2026-08-04, green.**
3. ~~**Android toolchain** → APK~~ — **done: signed APK from CI on every tag.**
4. ~~**Decide the background model**~~ — **decided and built: foreground service.**
5. **iOS packaging on the Mac** — the one remaining step; step 2 was green.
6. ~~macOS bundle~~ — **done: `desktop.yml` builds macOS alongside Linux/Windows.**

## What is NOT in scope here

Push infrastructure, an app-store presence, and offline message delivery. The
first two follow from step 4; the third contradicts the product ("a meeting,
not a mailbox") and would be a protocol change, not a mobile feature.
