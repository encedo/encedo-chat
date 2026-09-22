# Mobile — plan (Android + iOS)

Working notes, not a spec. This file is implementation reality, like `CLAUDE.md`
and `GROUPS-DESIGN.md`.

Written 2026-08-04; brought up to reality 2026-08-30 and again 2026-09-22.
**Android is no longer a plan** — a signed APK ships from CI on every tag, the
foreground service keeps it reachable in a pocket (confirmed on a device), and
the decisions the 2026-08 draft framed as open are recorded below as decisions.
**iOS is no longer a plan either**: it builds and runs on the simulator. It is
not yet released — no CI workflow, no device test, no signing.

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

## iOS — it runs. This section records what that took.

Built and launched on the simulator 2026-09-22. Not released: there is no CI
workflow yet (see the open items at the end of this section).

| | |
|---|---|
| Build machine | **macMini** (`ssh macmini`), macOS 27, Xcode 27, CocoaPods 1.17. Not possible from the Linux VM. **No GitHub credentials live there** — the tree goes over `rsync`. |
| Test on your own iPhone | **free** — free provisioning with an ordinary Apple ID; the signature expires after 7 days and is re-signed. |
| 99 USD/yr | only for **TestFlight / App Store**, i.e. shipping to anyone else. |
| WebRTC | **present** in WKWebView — unlike desktop WebKitGTK, so the direct plane should live on iOS. |
| Crypto | **Measured, not assumed.** WKWebView on iOS 26.3 has X25519 and the app reaches sign-in. On iOS 17.2 it does not: the capability gate fires `NotSupportedError` and sign-in is disabled. |
| Export compliance | E2E encryption requires the declaration at publication. |

```bash
npm run tauri -- ios init                          # npm run, not npx — the Android trap applies
node src-tauri/ios/patch.mjs src-tauri/gen/apple   # see below — REQUIRED
npm run tauri -- ios build --debug --target aarch64-sim
```

The third line is the **simulator** build; a device build has not been run yet.

**`minimumSystemVersion` is 26.0**, in `tauri.conf.json`. Without a floor the
app installs on systems where it cannot be used at all — no X25519 means no
shared room and no identity — so the floor exists to refuse the install rather
than ship a dead app. Verified on both sides: iOS 17.2 answers *"You need to
update this iPhone to iOS 26.0 to install this app"*, iOS 26.3 reaches sign-in.
The exact boundary is unmeasurable on this Mac — its simulator runtimes jump
from 17.2 straight to 26.3, with nothing in between.

### The four traps, all of which cost real time

1. **A black screen, and not one line of error.** The main window is
   `"create": false` in `tauri.conf.json`, because only the builder takes the
   `on_download` hook, and the hand-built window in `lib.rs` is `#[cfg(desktop)]`
   — which iOS is not. Android is rescued by `tauri.android.conf.json`; iOS had
   no such file until `tauri.ios.conf.json`, which is byte for byte the same.
   **This is the same bug Android had in 68eb14b**, on a platform where nobody
   had looked for it yet.
2. **`ios init` does not overwrite an existing `gen/apple`.** Change the config,
   re-run init, and the old `IPHONEOS_DEPLOYMENT_TARGET` stays while the build
   succeeds. `rm -rf src-tauri/gen/apple` first, then verify the value landed.
3. **`swift-rs` 1.0.7 does not compile under Xcode 27** (clang module scanning,
   AppKit). 1.0.8 does. It is a build-dependency of tauri on Apple targets only —
   `cargo tree -i swift-rs` finds nothing on Linux — so the bump is inert
   everywhere else.
4. **`failed to rename app … Directory not empty (os error 66)`** is a leftover
   `gen/apple/build/arm64-sim/onchato.app` from the previous run, not a code
   failure. `rm -rf src-tauri/gen/apple/build`.

### `Info.plist` — merged by Tauri, not by a script

`src-tauri/Info.plist` (shared with macOS) and `src-tauri/Info.ios.plist` are
both merged into the bundle **at build time, not at `init`** — after an `init`
alone the generated plist carries neither file's keys and looks broken, which is
a good way to waste an hour. So the usage descriptions are declared in those
tracked files and `patch.mjs` must never grow a competing copy.

The split is not a preference. `NSMicrophoneUsageDescription` is shared.
`NSCameraUsageDescription` is **iOS-only**: on macOS a QR scan would need
`BarcodeDetector`, which no WebKit ships, so declaring the camera there would
promise a feature that cannot work — while on iOS scanning goes through the
native `tauri-plugin-barcode-scanner`, exactly as on Android. Without the key
iOS does not refuse the camera, it **terminates the process**.

### `patch.mjs` — the iOS half, and it is small on purpose

`src-tauri/gen/apple` is generated and gitignored like its Android counterpart,
so nothing can be edited there by hand. `src-tauri/ios/patch.mjs` runs after
`ios init` and does **one** thing: installs `icons/ios` over the template's
AppIcon set, because `ios init` ignores our icons entirely and the app otherwise
wears **Tauri's logo** — the same bug Android shipped at 0.4.5, found here
before release. It asserts in both directions (a file the template wants and we
lack; a file we carry that the template never references, which is the dangerous
one, because copying it looks like success and changes nothing on the home
screen). Unit-tested against the real generated file list in
`test/ios-patch.test.ts`, so a template change breaks on a laptop rather than on
the Mac.

### Still open

- **No `.github/workflows/ios.yml`.** Until there is one, `patch.mjs` runs only
  when a human remembers, and the first CI build would ship Tauri's logo again.
- **Nothing tested on a physical device yet** — a paired iPhone is visible from
  the macMini, so this is the next step, not a blocked one.
- **No release plumbing**: signing, `latest.json`, export compliance.

---

## Sequence

1. ~~Deploy the web build with the probe~~ — **done.**
2. ~~**iPhone, mobile Safari**~~ — **done 2026-08-04, green.**
3. ~~**Android toolchain** → APK~~ — **done: signed APK from CI on every tag.**
4. ~~**Decide the background model**~~ — **decided and built: foreground service.**
5. **iOS packaging on the Mac** — **built 2026-09-22**: the app runs on the
   simulator, wearing our own icon, with the camera and microphone declared.
   What remains is a CI workflow, a physical device, and release plumbing.
6. ~~macOS bundle~~ — **done: `desktop.yml` builds macOS alongside Linux/Windows.**

## What is NOT in scope here

Push infrastructure, an app-store presence, and offline message delivery. The
first two follow from step 4; the third contradicts the product ("a meeting,
not a mailbox") and would be a protocol change, not a mobile feature.
