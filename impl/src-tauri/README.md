# onchato — desktop (Tauri 2)

A native desktop shell over the **same web bundle** the browser app uses
(`../web/dist`). No app logic lives here — identity, EH-2 + ratchet, rendezvous
and the WebRTC/relay transport all run in the webview. On Linux that webview is
**WebKitGTK**, which is the one thing to watch (see *Caveats*).

This scaffold is developed on Debian/Ubuntu, but `targets: "all"` means one
Linux build produces **`.deb`, `.rpm` and AppImage** (see *Other distributions*).
On this machine they come out **arm64** (`aarch64`); on an x86_64 host, amd64.

## Prerequisites (Debian/Ubuntu) — one-time

System libraries (needs `sudo`):

```bash
sudo apt update
sudo apt install -y \
  build-essential curl wget file pkg-config \
  libwebkit2gtk-4.1-dev \
  libgtk-3-dev \
  libayatana-appindicator3-dev \
  librsvg2-dev \
  libssl-dev libxdo-dev
```

Rust (no sudo — installs under `~/.cargo`):

```bash
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y
. "$HOME/.cargo/env"
```

Tauri CLI (no sudo):

```bash
cargo install tauri-cli --version "^2" --locked
```

## Icons (one-time, required by the bundler)

The bundler needs the icon set referenced in `tauri.conf.json`. Generate it from
any square PNG (≥ 512×512):

```bash
cd impl
cargo tauri icon path/to/logo.png     # writes src-tauri/icons/*
```

Until a real logo exists, any placeholder PNG works for a test build.

## Build

```bash
cd impl
cargo tauri build                     # runs `npm run web:build` first (beforeBuildCommand)
```

Artifacts land in:

- `impl/src-tauri/target/release/bundle/deb/*.deb`
- `impl/src-tauri/target/release/bundle/rpm/*.rpm`
- `impl/src-tauri/target/release/bundle/appimage/*.AppImage`

Install + run the `.deb`:

```bash
sudo dpkg -i "src-tauri/target/release/bundle/deb/onchato_0.2.0_arm64.deb"
onchato            # or launch "onchato" from the app menu
```

## Other distributions

**Fedora / RHEL — the `.rpm`.** Tauri 2 builds it natively (no `rpmbuild` on the
machine), so it falls out of the same Linux build as the `.deb`. Its `Requires`
are **not** automatic the way the deb's `Depends` are: the rpm bundler writes
only what `bundle.linux.rpm.depends` lists, and an empty list gives a package
that installs cleanly and then dies at startup on a missing
`libwebkit2gtk-4.1.so.0`. That is why `tauri.conf.json` names `webkit2gtk4.1`
and `gtk3` explicitly. Those are **Fedora's** package names — openSUSE calls the
same library `libwebkit2gtk-4_1-0`, so one rpm cannot satisfy both; openSUSE
takes the AppImage.

Built on ubuntu-22.04 (glibc 2.35) the rpm runs on Fedora, because glibc is
backward compatible; the reverse would not hold, which is why CI builds on the
**oldest** distribution that still ships WebKitGTK 4.1.

**Everything else — the AppImage.** Arch, NixOS, Void, openSUSE: one file, no
package manager. It needs FUSE2 (`fuse-libs` on Fedora, `libfuse2` on Debian);
without it, `./Encedo*.AppImage --appimage-extract-and-run` works anyway.

**No Flatpak, deliberately.** On Linux the webview is WebKitGTK, so the desktop
build is relay-only (see *Caveats*) — the browser at onchato.com gives a Linux
user *more* than this app does. Another package format would ship a worse
product in nicer wrapping.

Dev mode (hot frontend via webpack-dev-server on :3000):

```bash
cd impl
cargo tauri dev
```

## Caveats — read before trusting the build

- **WebKitGTK WebCrypto X25519 is the make-or-break.** The whole crypto stack
  uses `crypto.subtle` X25519 (identity ECDH, rendezvous, EH-2). If the system
  WebKitGTK lacks it, the app cannot log in at all. Ubuntu 26.04 ships a recent
  WebKitGTK (2.48+) that should have it, but **verify on first run**: open the
  app, log in with a software identity; if it reaches the contact list, X25519
  works. If login hangs/fails, check the terminal — a `subtle` error there is the
  smoking gun. (Run from a terminal to see console output:
  `WEBKIT_DISABLE_COMPOSITING_MODE=1 encedo-chat`.)
- **WebRTC in WebKitGTK is weaker than in Chromium.** The direct data plane may
  not come up. That is **not fatal**: content falls back to the relay (GossipSub),
  so the app still works — the transport badge just stays ⚪ Relay instead of
  🟢 Direct.
- **Rendering glitches**: if the window is black/blank, try
  `WEBKIT_DISABLE_DMABUF_RENDERER=1 encedo-chat` (a common WebKitGTK+GPU issue).
- **CSP is `null`** in this test build (permissive) so the webview can reach the
  relay (wss) and HEM. Tighten it before any real distribution.

## What this is / is not

- **Is**: a thin native window around the deployed web app, for a desktop test.
- **Is not**: the eventual rust-libp2p-in-Tauri design (native transport). That
  is a later step; this test build proves the webview path end to end first.
