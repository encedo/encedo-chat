# MVP — release plan for 0.9 (ARCHIVE)

> **Archive, state as of 2026-09-18 (0.6.3).** Most items have long been
> out of date: iOS builds, Linux has a direct channel through the host, the
> five-person group test has passed, Diagnostics is in Settings, the contact
> book is sealed. It stays as a record of the plan, not as a plan.

What has to be **done**, what has to be **tested** and what has to be **signed** to
ship onchato 0.9 on four targets: **web, desktop, Android, iOS**.

File name: `MVP.md`, not `MCP.md` — in this repo `MCP` would mean something else
(Model Context Protocol), and this is a release plan.

> State as of 2026-09-18: **0.6.3 in production**. `npm test` 567/567,
> `browser-test` PASS (37 scenarios), CI green. The release path has been verified
> many times; **Windows is signed since 0.6.3** (Azure Artifact Signing,
> RKV certificate — see §5), and the web deploys itself via a systemd timer after a tag.
>
> Since 0.6.3 the app is in the hands of people outside the project, so §6.1 stops being
> a list for the author and becomes **the script the tester gets**.

---

## 1. What 0.9 is meant to mean

**0.9 = the first version you can give to a stranger without a user manual and
without assistance.** This is the only criterion that holds the rest of this document together:

- it installs from a signed package on its platform,
- you can talk to a second person with it **without help from a third**,
- when it cannot do something (WebRTC on desktop, the QR scanner on Linux), it **says so
  plainly** instead of staying silent or pretending,
- data loss is **reversible or announced** — never silent.

What 0.9 does **not** need: multi-device, history after restart,
live voice calls, app stores (other than Play, if we make it), OIDC.

---

## 2. State today, honestly, per target

| | web | desktop (Linux) | desktop (Win/macOS) | Android | iOS |
|---|---|---|---|---|---|
| builds | ✅ | ✅ | ✅ in Actions | ✅ in Actions | ❌ not attempted |
| signed | n/a | ❌ (updater: minisign) | ✅ **Windows since 0.6.3** / macOS ❌ | ✅ **APK, dev key from secrets** / `.aab` deliberately not (Play App Signing) | ❌ |
| 1:1 + groups | ✅ | ✅ | ✅ Win (0.6.3) / ❓ macOS | ✅ | ❌ |
| WebRTC direct | ✅ | ❌ **missing in WebKitGTK** | ❓ | ❓ (the webview has the API, the `wry` bridge unverified) | ❓ |
| notifications | ✅ | ✅ | ❓ | ✅ | ❓ |
| tray / background | n/a | ⚠️ depends on the desktop | ❓ | ✅ **foreground service, confirmed on a device** | ❓ |
| voice notes | ✅ | ✅ (the VM audio was to blame, not the code) | ❓ | ❓ | ❓ |
| QR scanner | ❌ (no API) | ❌ | ✅ should | ✅ should | ✅ |

❓ = **built, but nobody has run it**. The evidence comes from four targets (web,
desktop-Linux, **Windows since 2026-09-17** and Android); **macOS and iOS still without a
single run**.

---

## 3. Blockers — no 0.9 without these

### B1. ~~Nobody has run Windows~~ — ✅ DONE; **macOS still not**
2026-09-17: the signed **ARM64** `.exe` from the 0.6.3 release installed on a
real machine and a conversation works. SmartScreen warned about an untrusted source —
that is **reputation, not the signature**, and it builds up over months on the publisher's identity
(reputation is not to be gamed; decision recorded 2026-09-18).
(Android dropped off this list in 2026-08: the signed APK from Actions installed,
the §6.1 path walked through on a device.)

**macOS remains**: a `.dmg` artifact is produced in every release and nobody has ever
run it. Unsigned, so installation goes through "Otwórz mimo to" ("Open Anyway").

### B2. ~~Android does not survive sleep~~ — ✅ DONE
Foreground service (`OnchatoService.kt`, type `specialUse`, injected by
`patch.mjs`); **background delivery confirmed on a device**. For every
release the regression test from §6.2 remains: screen off for 10 minutes, the message
arrives.

### B3. ~~Software profile migration~~ — ✅ DONE
`lib/migrate.ts` + import on the sign-in card, exactly in the agreed scope:
export of the **whole** profile in one sealed file (the name INSIDE the
seal), password = profile password, a name collision = a loud refusal, the wording
"przenosisz" ("you are moving"). Tests `test/migrate.test.ts` + a scenario in `browser-test`.

### B4. ~~A third rendezvous node~~ — ✅ DONE
**Correction:** `bs2` is healthy — it passed the whole group scenario of
`browser-test` run exclusively on it. The earlier "bs2 is down" was **my
operating error**: `RELAY_NODE` takes a full multiaddr, and I gave a hostname,
which ended up in the node list as an invalid address.

~~The real risk remains: two nodes are two points of failure, not a spare.~~
**✅ DONE 2026-09-03**: `bs3` is up (DigitalOcean AMS3, deployed per
`relay/DEPLOY.md`) and is in `infra/nodes.json`. The mesh triangle is closed —
check with `ss :9002 ESTAB` on the node, not by inferring from the log.

### B5. Specifications consistent with the code — ✅ DONE
`re` and `edit` **were already** described in §7.4 (it was the note in `CLAUDE.md` that was
out of date and misled me — corrected). Comparing the envelope types with the code
found one real gap: **`rtc`**, the WebRTC signalling envelope, was travelling
on the wire and was not in the specification. Added. The type list in §7.4 now matches
`lib/envelope.ts` name for name, `group-skd`/`group-skd-req` included.

### B6. ~~Lies in the code and in the UI~~ — ✅ DONE (`69fc2b9`)
The comments about WebRTC now say the opposite, in line with the measurement ("włączone —
i nic nie zmieniło", "enabled — and it changed nothing"); the contact-removal dialog went through `tr()` with an entry
in the catalogue. The guard `test/i18n.test.ts` reads call sites since 0.5.8, so
a bare string on a UI path breaks the build.

---

## 4. To do — working list

The order is the order of risk: first whatever can overturn the plan.

1. ~~Android stage C~~ — ✅ (B2).
2. ~~Profile migration~~ — ✅ (B3).
3. ~~Windows signing~~ — ✅ **WORKS since 0.6.3** (2026-09-17). The trap
   that cost the first run: GitHub sends the OIDC subject in two
   forms **per repository** (`use_immutable_subject`), and the entry in Azure
   must match literally. Recipe: `AZURE-SIGNING-NEXT-APP.md`.
4. ~~Fixes from B6~~ — ✅.
5. **iOS** — only after creating an Apple ID: `npm run tauri -- ios init`, build,
   install on a device. The icons and the `identifier` (`com.onchato.chat`) are ready.
6. **Live test of a 4–5 person group** — the oldest unpaid debt. Since 0.6.3
   finally feasible: there are testers with Windows.
7. **Flakes to watch**: group reload in the full `browser-test`,
   the mentions scenario. If they come back in CI, capture the log, do not "just run it again".
8. ~~Download page~~ — ✅ IT EXISTS: `landing.html` detects the system and offers
   the right artifact from the latest release, and about iOS it says plainly "No iOS yet."
9. **Updater with a signed installer** — 0.6.3 is the first signed
   release and was installed **by hand**, so the path "the app downloads
   and swaps itself for the signed package by itself" has never been exercised.
   Check it on the 0.6.3 → 0.6.4 transition, before there are more testers.

---

## 5. Signing and distribution

| target | how | state |
|---|---|---|
| **Windows** | **Azure Artifact Signing** (formerly Trusted Signing) **via OIDC**, the pattern from `encedo-wg-hsm` — **no secrets**, driven by repo variables (`AZURE_CLIENT_ID`, `AZURE_TENANT_ID`, `AZURE_SUBSCRIPTION_ID`, `TRUSTED_SIGNING_ENDPOINT/ACCOUNT/PROFILE`). Signing handed to Tauri through `signCommand`, so that the **loose `.exe`** is signed too, not just the installers | ✅ **works since 0.6.3**, verified by parsing the released binary: chain *Microsoft Identity Verification Root CA 2020* → *ID Verified Code Signing PCA 2021* → *ID Verified CS AOC CA 04*, `C=PL`, RFC3161 timestamp, the loose `.exe` signed too. Note: the command `sign code trusted-signing` is **deprecated**, its successor is `sign code artifact-signing` |
| **macOS** | unsigned — installation through "Otwórz mimo to" ("Open Anyway"). Signing = an Apple Developer subscription; decision together with iOS | deliberately deferred |
| **Linux** | `.deb` + `.rpm` + AppImage unsigned; distribution from GitHub Releases | works |
| **Android** | CI signs the **APK** with the developer key from secrets (`zipalign` + `apksigner` v2/v3 + `verify`; missing secrets = the job fails with a list of names); `.aab` deliberately unsigned for Play App Signing; two separate artifacts | ✅ works, APK installed from Actions |
| **desktop updater** | minisign (`tauri signer`), private key in secrets (`TAURI_SIGNING_PRIVATE_KEY` + `_PASSWORD`), pubkey in `tauri.conf.json`; `latest.json` in the draft release | ✅ the code works; see the gate below |
| **web** | auto-deploy: the host itself does pull+build after a tag (`infra/deploy-on-tag.sh` + systemd timer; PULL model — no production key sits in the runner); the relay is deliberately NOT restarted | ✅ works |
| **iOS** | requires an Apple account; TestFlight to start | blocked by the account |

**Automatic updates — built (0.4.0); two facts govern them.**
(a) **The draft release is the gate**: the tag builds `latest.json`, but the draft's assets
are not public, so until "Publish release" is clicked the updater gets a 404 —
on purpose, publication = release. After every tag check that the draft has
`latest.json` at all (without the signing secrets the build goes green and silently
does not create it). (b) `desk_update_kind` = `system` for `.deb`/`.rpm` — distribution
packages get **a notification + a link**, never a swap; self-update
applies to AppImage/Windows/macOS. A swap test only makes sense on Win/macOS
(AppImage does not start on a VM without 3D — EGL_BAD_PARAMETER).

---

## 6. Tests — the same path on every platform

There is one script, because there is one question: *can two strangers get through to each other*.
A pass = all items on the given platform, **on the package from Actions**, not
on a build from a laptop.

### 6.1 Main path (every target)
1. Installation from the release artifact. The app starts, shows the icon and the version.
2. Creating an identity: HEM **and** a software profile with a password.
3. Adding a contact: an invite link **and** a QR code (where there is a camera).
4. A 1:1 conversation: text, emoji, reply (↩), correction (✏), reaction.
5. File: sending, receiving, expiry after a few minutes.
6. Image: paste from the clipboard, preview at the sender immediately, "Pokaż" ("Show") at the recipient.
7. Voice note: recording, sending, playback on the other side.
8. Group: creation, invitation, broadcast, `@` mention, removing a member
   (the removed one stops seeing), adding back.
9. Pinning a message and its return after an app restart.
10. Network cut for 30 s: ⚠ on the message, ↻ delivers it after the return.
11. A notification when the window is not in front; **message content never in the banner**.
12. Signing out and back in: contacts and groups are there, the transcript is not.
13. **Diagnostics**: the capability report and the WebRTC test tell the truth about the platform
    — **hidden behind `?debug=1`** (a decision from 0.3.x), so the step requires entering
    with that parameter.

### 6.2 Additionally per target
- **web**: Chromium and Firefox; phone in portrait and landscape; the on-screen
  keyboard does not cover the field; page reload in the middle of a conversation.
- **desktop**: closing the window (tray **or** exit — depending on the desktop),
  a second launch raises the existing window, autostart after a system restart,
  dragging a file onto the window.
- **Android**: **screen off for 10 minutes → the message arrives** (this is the
  stage C test, not a formality), screen rotation, return from the background, sharing a file to
  the app.
- **iOS**: the same as Android, once there is an account.

### 6.3 Security test that must pass before a release
1. The blob in the file store **does not contain** plaintext (the harness checks this,
   repeat by hand in production).
2. A notification carries no content in any of the three modes.
3. Removing a contact cuts off reachability (the other side stops getting through).
4. Removal from a group: the removed one does **not** read messages after the epoch rotation.
5. Wipeout erases all `ec-*` keys and returns to sign-in.
6. A second tab with the same identity: both sessions stop, the message explains it.
7. **Substitution of `pub` in the contact book is detected at sign-in**
   (`lib/bookmac.ts`: `tampered` = the book is not used and NOT overwritten — the evidence
   remains). Today this is the only defence of the trust anchor and nobody walks
   through it by hand.

---

## 7. Deliberately outside 0.9

Written down so they do not come back as "maybe also": multi-device, OIDC and
device registration, history after restart (sync from a member **rejected** —
it bypasses the epoch lockout), voice/video calls (a separate project, embedding
later), telemetry (**decided: none**), the relay-blind plane (§13,
waiting for gossipsub v3), TURN (**decided: no**).

---

## 8. Order (state as of 2026-08-30)

1. ~~§6.1 on Android from the artifact~~ — ✅ walked through, stage C confirmed.
2. ~~Profile migration and `SPEC.md`~~ — ✅ both.
3. ~~Windows with signing~~ and ~~`bs3`~~ and ~~the download page~~ — ✅ all three.
4. **Now**: the updater swap on Windows (§4 item 9) with the 0.6.4 release, then
   §6.1 walked through **by testers**, not by me — and §6.3, which still
   nobody has walked through by hand.
5. macOS: the first run of the `.dmg` (B1) — the artifact has been produced for a long time.
6. At the end: iOS, if there is an account; if not — 0.9 ships without iOS and that is
   fine, and the download page no longer lies about it.

**Versions along the way**: the number grows with every package (0.6.x). The tag `v0.9.0`
is fired only when §6.1 has passed on web, desktop and Android.
