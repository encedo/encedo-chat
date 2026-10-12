# onchato

A synchronous, HSM-anchored, post-quantum-hybrid peer-to-peer messenger.
Minimal infrastructure, metadata-privacy by design, end-to-end encrypted with
long-term keys held in an Encedo HEM (hardware security module).

- **Instant-only** — both parties online during a conversation; no offline
  messages, no server-side history, no mailbox. Rooms are deterministic and
  crypto-derived ("meet in the park"). The transcript lives in RAM: a reload
  takes it — **except what you pin**. A pinned message is sealed into that one
  browser under your own identity key, never leaves it, and is never announced
  to the other side; the app says so before it keeps the first one. Contacts,
  groups and settings do persist (the contact book MAC'd against key swaps, the
  group state encrypted) — what never persists unasked is a message.
- **Minimal infra** — operator-run libp2p discovery nodes (two today: bs1 and
  bs2; the list ships compiled in and can be refreshed by IPFS CID); anyone can
  run their own network. Content travels WebRTC-direct where the platform can,
  and through the relay as ciphertext where it cannot.
- **PQ-hybrid confidentiality from day one** — X25519 + ML-KEM-768.
- **Dual-use** — one core, two channels: enterprise (Encedo) and the open
  network (onchato).

> **Status: shipping 0.5.x** — web ([onchato.com](https://onchato.com)),
> desktop (Linux/Windows/macOS, Tauri 2) and Android (signed APK from Actions)
> from one engine. `docs/` is the protocol of record, kept 1:1 with the code;
> `CLAUDE.md` records the implementation notes and the operational lessons.

## What it does today

1:1 conversations (EH-2 handshake + Double Ratchet, PQ-hybrid), groups (Sender
Keys, deniable ECDH-HMAC auth), encrypted file sharing over a TTL'd IPFS store,
voice notes, replies / edits / reactions / mentions, per-pair daily topic
rotation, presence without a handshake, pinned messages, profile
export/import, QR invites, a Polish/English UI, desktop tray + updater, an
Android foreground service so a phone in a pocket stays reachable.

## Identity: a software profile, or a HEM

An identity here is one X25519 long-term key. Where that key lives is the only
choice this product asks you to make before anything else, and the two answers
differ in what an attacker has to reach to become you.

**A software profile** keeps the key in this browser (or this app's storage),
sealed with a password at 1M PBKDF2 rounds. It costs nothing, works everywhere,
and travels by file export. Its limit is honest: while you are signed in, the
key is in the process's memory, so whoever owns the machine at that moment owns
the identity.

**A HEM** (Encedo hardware security module) keeps the key in the device and
never hands it out. The app cannot export it, a backup cannot contain it, and a
compromised laptop cannot copy it — it can only ask the device to *use* it, for
as long as it is plugged in and unlocked.

### What the device is actually asked to do

Establishing things, never carrying them:

| moment | what HEM does | how often |
|---|---|---|
| sign in | derives a key pair from your password, mints a token | once per session |
| first contact with a peer | `ECDH(IK_me, IK_peer)` — the pair secret behind the rendezvous topic, the presence MAC and the rotation offset | once per contact per session |
| EH-2 handshake | one `ECDH` the protocol cannot do without (§6.3) | per handshake, and §7.3 forces a fresh one every 4–8 h per peer |
| adding / renaming / removing a HEM contact | the peer's public key is stored in the device | per change |
| creating a group | the group key is minted inside the HSM (§8) | per group, per re-key |

**Sending and receiving messages does not touch it at all.** Once a session
stands, the Double Ratchet runs locally on WebCrypto — the device is for
*establishing*, and message-rate work would make it the bottleneck. Measured
costs are in [`hem_usage.md`](hem_usage.md).

### Lifecycle, and what happens when the device goes away

- **Unlocking is once per session.** The password derives a key pair that stays
  in memory; individual authorisations are 5-minute tokens the SDK renews by
  itself, without asking again.
- **The session ends when the window closes.** There is no idle timeout: signing
  out is a reload. The identity survives (it is in the device), the transcript
  and the ratchets do not — they are ephemeral by design.
- **Unplug the HEM mid-session and conversations keep running.** The ratchets
  are local, so messages keep flowing until §7.3 forces a fresh handshake —
  **4–8 h per peer, randomised**, so they do not all stop at once.
- **What stops immediately** is anything that needs the key: a new conversation,
  a new contact, a new group. Presence keeps working, because the pair secret
  for this session is already derived.
- **Signing in again needs the device.** That is the point of it.

## Documentation

- [`docs/PROTOCOL.md`](docs/PROTOCOL.md) — protocol & cryptography (identity,
  rendezvous, EH-2 handshake, ratchet, groups, session management, PQ roadmap,
  implementation guide, flow diagrams). **Describes what ships.**
- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — product & infrastructure.
- [`docs/THREAT-MODELS.md`](docs/THREAT-MODELS.md) — deployment profiles P1–P3.

`CLAUDE.md` holds the implementation notes (HEM/SDK reality, engine internals,
deploy lessons) for agents and developers.

## Layout

```
docs/         the specs (protocol of record)
impl/         the app: engine (lib/, eh2/, net/), web UI (web/), CLI (cli/),
              Tauri desktop + Android shell (src-tauri/), tests (test/)
relay/        the rendezvous/transport node (bs1/bs2 run this)
infra/        node list, tag-driven deploy units, nginx config, IPFS TTL sweeper
hem-sdk-js/   Encedo HEM SDK (git submodule)
.github/      CI + release workflows (desktop, Android, tests)
```

## Local development

Requires **Node.js ≥ 22** (developed on 24; tests and CLI run the TypeScript
directly via native type-stripping). The web bundle and both Tauri shells are
built with webpack (`npm run web:build`).

```bash
# clone with the HEM SDK submodule
git clone --recurse-submodules git@github.com:encedo/encedo-chat.git
# or, if already cloned:
git submodule update --init --recursive

cd encedo-chat/impl
npm test                 # ~380 unit + offline integration tests, ~30 s
npm run web:dev          # the app on a local dev server
npm run browser-test     # two headless browsers, the real bundle, the real relay
```

## Checking the file encryption yourself

Shared files are encrypted in the browser and uploaded to an IPFS node that
holds nothing but ciphertext; the key rides in the message envelope, over the
ratchet or a group sender key, and never reaches the store. `file-decrypt.ts`
exists so that is a thing you can verify rather than a thing you are told.

Open the app with `?debug=1` and send or download a file. The console prints one
line per file:

```
[ec 12.44s] file evidence · {"cid":"Qm…","name":"raport.pdf","size":5242880,"key":"…","chunk":4194304,"chunks":2,"alg":"A256GCM-chunked-v1"}
```

Paste it — quotes included — into the tool:

```bash
cd impl

# the positive case: fetch the blob the node is holding, open it, write the file
node net/file-decrypt.ts '{"cid":"Qm…", … }'

# the negative control: same blob, no key, nothing to see
node net/file-decrypt.ts '{"cid":"Qm…","size":…,"chunk":…,"chunks":…,"alg":"…"}' --no-key

# through a public gateway instead of the app's proxy — same CID, same bytes
node net/file-decrypt.ts '{…}' --gateway https://ipfs.encedo.com

# against a different deployment's proxy (default: https://onchato.com)
node net/file-decrypt.ts '{…}' --origin https://chat.example.com
```

The run prints the ciphertext length and its first bytes, then either recovers
the original and reports whether any plaintext appears in the stored blob, or —
given a wrong key — refuses. A wrong key, a tampered blob, a reordered chunk and
a truncated file all land in that same refusal, by design: none of them may
yield partial plaintext.

`--out <path>` chooses where the plaintext goes; without it the file lands in a
**fresh temporary directory** under the manifest's name — deliberately never the
working directory, where a decrypted private file would sit one `git add -A`
away from being published. **A 404 means the file expired** — uploads live
minutes, and nothing here can bring one back, which is the other half of the
claim.

The evidence line is a complete capability to that one file. It is behind
`?debug=1` for that reason, and bounded anyway by the same expiry.

## Self-hosting

Running an independent network is a first-class, encouraged path (own nodes
from a public image, own signing key). See `docs/ARCHITECTURE.md`.

## License

[MIT](LICENSE).
