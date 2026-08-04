# Mobile — plan (Android + iOS)

Working notes, not a spec. `docs/` stays the audit target; this file is
implementation reality, like `CLAUDE.md` and `GROUPS-DESIGN.md`.

Written 2026-08-04, after establishing what is already proven and what is not.

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

## Android

### Cheap part — a day, mostly downloading

Prerequisites (~6–8 GB): Android SDK command-line tools, platform **34**
(Android 14) and 35, build-tools, **NDK** (~2.5 GB), Rust targets
(`aarch64-linux-android` first; `armv7`, `x86_64` for emulators), JDK 17+.

```bash
cargo tauri android init          # writes src-tauri/gen/android
cargo tauri android dev           # device or emulator, hot frontend
cargo tauri android build --apk   # debug APK to sideload
```

Sideload the debug APK; a release AAB needs a keystore, which is only worth
creating when there is somewhere to publish.

**Target API 34 (Android 14) as the floor**, per the product decision. Nothing
in the engine needs anything newer.

### The real work, in order of risk

1. **Confirm the probe on the packaged app, not the browser.** The browser test
   is done and positive; the packaged one exercises the different origin. Read
   the "Platforma" row, expect WebRTC to be present (Chromium) unlike desktop.
2. **Background lifecycle — a PRODUCT decision, not an engineering one.**
   Android dozes and kills background apps, and the product is instant-only: no
   store-and-forward, no offline messages, by design. A messenger that only
   receives while foregrounded is a poor phone messenger. The two honest
   options are a **foreground service** (a permanent visible notification, real
   battery cost) or **accepting "receives while open"** and saying so in the UI.
   Everything else on this list is downstream of that choice.
3. **Notifications.** Real push means FCM, which means Google infrastructure and
   metadata about who is messaged and when — directly against the minimal-infra
   stance and the §12 metadata goals. The alternative that keeps the design
   honest is a foreground service plus local notifications, which only works if
   (2) went that way.
4. **Identity.** No HEM on the phone: either the software identity (already
   built, `browserSoftwareIdentity`) or the HEM over the network — the SDK is
   plain HTTP, so a remote HEM works unchanged.
5. **Battery and mesh.** GossipSub keepalives plus one presence watch per
   contact on a radio that wants to sleep is untested. Measure before tuning.

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
cargo tauri ios init
cargo tauri ios dev                # device or simulator
cargo tauri ios build
```

**Sequencing:** open onchato.com in mobile Safari first. It is the same WebKit
WKWebView uses, so a green probe there means the packaging is a formality and a
red one saves the whole exercise.

---

## Sequence

1. Deploy the web build with the probe. *(prerequisite for 2 and 3)*
2. ~~**iPhone, mobile Safari**~~ — **done 2026-08-04, green.**
3. **Android toolchain** → debug APK → probe on the packaged app.
4. **Decide the background model** (foreground service vs. foreground-only).
   Nothing beyond a demo APK is worth building before this.
5. iOS packaging on the Mac, if step 2 was green.
6. macOS bundle — free side effect of having the Mac, and arm64 natively.

## What is NOT in scope here

Push infrastructure, an app-store presence, and offline message delivery. The
first two follow from step 4; the third contradicts the product ("a meeting,
not a mailbox") and would be a protocol change, not a mobile feature.
