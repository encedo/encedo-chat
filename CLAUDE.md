# CLAUDE.md — v6 implementation notes

Working notes for building v6. **The design docs are authoritative for the
protocol; this file is authoritative for implementation reality.** When they
disagree, it means the current hardware/SDK does not yet match the target
design — record the gap here, do **not** edit the specs to match today's
firmware.

- `docs/PROTOCOL.md` — protocol & crypto (audit target). Describes the **intended**
  design, including in-HSM HKDF.
- `docs/ARCHITECTURE.md` — product & infrastructure.
- `docs/THREAT-MODELS.md` — deployment profiles P1–P3.
- These three go to an external cryptographer for audit — **do not modify
  without explicit instruction.**

## Repo layout (this repo — `encedo/encedo-chat`)

- `docs/` — the three audit specs (PROTOCOL, ARCHITECTURE, THREAT-MODELS).
- `skin/` — UI mockups (replaceable skins; `ui-mockup.html`, `ui-mockup-hacker.html`).
- `impl/` — the TS spike (grows toward the §17 monorepo).
- `relay/` — the onchato **bs1 relay** (libp2p GossipSub + circuit-relay-v2),
  self-contained + deployable (pull → `npm ci` → systemd `onchato-relay`).
  Transport-only; v5 + v6 share it. `--pass bs1.onchato.com` seeds the fixed
  PeerId (`12D3KooWP6Sp…cDmp`) — never change it or every client breaks.
- `hem-sdk-js/` — the Encedo HEM SDK as a **git submodule** (→ `encedo/hem-sdk-js`).
  Our HEM client — do not fork; update via `git submodule update --remote`.
- `CLAUDE.md` (this file), `README.md`, `LICENSE` at root.

The v5 deployment (`encedo/onchato.com`) and older iterations live in a separate
local workspace, not in this repo.

## HEM / SDK reality vs. design  ← the important one

**Design (in the specs):** the HSM exposes `ecdh` in two modes — raw, and
`ecdh`+**HKDF executed inside the HSM** (salt/info/L as arguments) — so that
IK-derived secrets (rendezvous topics, announce MAC keys, cache key) never
leave the device. `docs/PROTOCOL.md` §4.3 is written against this.

**Current firmware / `hem-sdk-js`:** **no in-HSM HKDF yet.** `ecdh` returns the
**raw** 32-byte shared secret only (the REST endpoint has an optional `alg`
hash, but the SDK does not expose it). **HKDF-in-HEM is coming in a newer
firmware, per the protocol's assumptions** — the specs describe that target and
stay as-is.

**Consequence for the spike, until the newer FW ships:** compute the
rendezvous/MAC/cache HKDF **client-side over the raw `ecdh` output**. This is a
temporary *implementation detail*, not a protocol change. Note for the record
(and for the cryptographer, when relevant): on current FW the pair secret
`ss = ECDH(IK_a, IK_b)` transits client RAM — it is rendezvous-only and
disjoint from the message-key DHs, so message confidentiality is unaffected;
the exposure is metadata-linkability of that pair until IK rotation. When the
FW lands, move the derivation in-device and the gap closes.

EH-2 needs raw `ecdh` regardless (it concatenates the DH outputs client-side),
so the handshake path is unaffected by the firmware phase.

**Newer FW — `api/search` returns public keys** (per operator). Today
`searchKeys` returns only `{kid,label,type,description}`, so the HEM contact book
(`lib/core.ts` `hemContactBook.list`) does one `getPubKey` per contact to fetch
each `pub`. When that FW ships, `api/search` returns the public data in a single
call — drop the per-kid loop and read `pub` straight off the search entry.

## SDK facts (from `hem-sdk-js`: `.d.ts`, `EXAMPLES.md`, `CLAUDE.md`)

The SDK **is** our HEM client — `new HEM(url)` points at a real device or, in
dev, at a local software stub (the OIDC-style model). Dependency-free,
browser + Node. Private keys never leave the device.

Auth = **scoped JWT**: `authorizePassword(password, scope)` (PBKDF2-600k +
X25519 done client-side → device-issued token) or `authorizeRemote` (mobile
push). Crypto ops need a `keymgmt:use:<kid>` scope. This answers open question
P1 (HSM auth mechanism).

Runtime uses:

| SDK method | Use |
|---|---|
| `authorizePassword` / `authorizeRemote` | scoped JWT |
| `createKeyPair(token, label, 'CURVE25519', descrB64)` | IK at onboarding (SDK sets mode `ECDH`) → `{kid}` |
| `importPublicKey(token, label, 'CURVE25519', pubBytes, descrB64)` | store a contact's IK_pub |
| `ecdh(token, kid, peerPubB64)` | **raw 32-byte shared secret** — EH-2 DHs + rendezvous base |
| `searchKeys(token, descr)` / `listKeys` / `getPubKey` | resolve contacts (search pattern encoded by SDK) |
| `deleteKey(token, kid)` | contact removal, IK rotation |
| `deriveKey(token, label, type, descrB64, kid, peerPubB64)` | **deterministic key provisioning** — makes the *same* key on two HEMs without private-key import (HSMs don't import privkeys). Provisioning/HA, **not** on the message path |

Available in the HSM, not used in Phase 1 but relevant later:
`hmacHash`/`hmacVerify`, `cipherEncrypt`/`Decrypt`/`Wrap`/`Unwrap`,
**`mlkemEncaps`/`mlkemDecaps`, `mldsaSign`/`mldsaVerify`**. The ML-KEM/ML-DSA
primitives being in the HSM **de-risk Phase 3** (long-term PQ identity — §15).

Gotchas (from the SDK's own CLAUDE.md): `createKeyPair`/`deriveKey` need a
`mode` field (CURVE25519→`ECDH`, ED25519→`ExDSA`); `searchKeys` pattern is
base64 with a leading `^`; endpoint spec of record is the sibling PHP repo
`hem-api-tester`. REST base is `/api/...` (`/api/crypto/ecdh`,
`/api/keymgmt/create|search|delete|derive`).

## Spike (decided 2026-07-24)

- **Stack:** TS on the v5 base (js-libp2p). Node 24 strips types natively —
  run `.ts` directly, zero deps for the HEM slice. Rust `core-rs` port is a
  later step, after the crypto is blessed.
- **HEM in dev:** software stub matching the SDK's endpoints (OIDC model). The
  stub must reproduce the SDK auth handshake — read `hem-sdk-js/hem-sdk.js`
  (`authorizePassword`, `#buildEjwt`, `#deriveX25519`, `#req`). Reference:
  `hem-api-tester` (PHP) if available.
- **VM (onchato.com):** localhost for M1; VM at the integration milestone.
- **Sequencing vs crypto review:** build the crypto-review-independent spine
  first (HEM client, rendezvous, Announce, discovery). **Hold EH-2 + ratchet
  (§6–7) until the cryptographer responds.**

### M1 — rendezvous spine (demoable in the UI)

Two browser windows (mockup wired to the engine) discover each other in the
deterministic room via one node: derive the day's topic, subscribe, exchange
Announce (HMAC), verify, show "peer in the room". No handshake yet.

Slice order: (0) freeze message shapes; (1) HEM stub + SDK smoke test
(createKeyPair + ecdh commutativity); (2) topic derivation + Announce; (3) node
(v5 relay evolved: `--network`, `--key-file`, TTL eviction, rendezvous-only);
(4) wire the mockup for manual two-window testing.

## Implementation progress (impl/)

Node 24 native TS (run `.ts` directly, no build). `npm test` = offline unit
tests; live integration scripts hit the real onchato relay.

Working end-to-end, verified live:

- **HEM identity via `hem-sdk-js`** — `alice` CLI: register (CURVE25519 IK,
  `ETSEIC:self,<h>,ik,<iat>` DESCR), list (searchKeys), pubkey, against a real
  HEM (my.ence.do). Auth-by-KID pattern from encedo-pgp.
- **Deterministic rendezvous (§5)** — `lib/rendezvous.ts`: topic + announce MAC
  key from `ss = ECDH(IK_a, IK_b)` + network + date. **Verified: real HEM (Alice)
  and software (Bob) derive the identical topic + macKey** → HEM raw `ecdh` ==
  node X25519, no endianness issue.
- **Presence + meeting over libp2p** — `net/onchato.ts` (relay multiaddr computed
  from `--pass bs1.onchato.com` → `12D3KooWP6Sp…cDmp`), `net/peer.ts` (v5 config +
  http-path ws filter), `lib/announce.ts` (§5.5 HMAC), `lib/rendezvous-net.ts`.
  `net/meet.ts` PASS: two peers meet via the real relay.
- **Interactive CLI chat** — `lib/room.ts` (joinChat), `cli/repl.ts` +
  `cli/chat-session.ts` (IRC-style, /who /me /react /quit). `bob join` /
  `alice join` open a live encrypted chat with typing / away / graceful-leave
  presence. `net/chat-test.ts` PASS.

### Message envelope (codec layer) — `lib/envelope.ts`

The plaintext inside the interim seal is a **versioned JSON envelope**, not a
raw string. One shape: `{ v, t, id, ts, seq, …payload }` — `t` is the type
discriminator, `id` a short per-message id (reactions/replies), `ts` Unix epoch
**ms (UTC)**, `seq` per-sender monotonic (dedup/order, **UX only, not
security**). Types: `msg` (text, `format:'plain'` — **never raw HTML**; `md`
safe-subset reserved), `typing`, `presence` (`active|away|leave`), `reaction`
(live), `file` (**reserved** — content encrypted BEFORE IPFS upload, envelope
carries CID + content key; own mini-design, TBD, cryptographer-relevant).
Unknown `t` decodes to `UnknownEnv` and is ignored → **forward-compat**.

Strict layering: `msgcrypto` seals/opens **opaque bytes** (type-agnostic),
`envelope` does Envelope⇄bytes, `room` orchestrates (build→encode→seal→publish;
open→decode→dispatch-by-type). The envelope is **EH-2-independent** — the same
bytes get sealed by the ratchet later, codec unchanged. All time via
`lib/time.ts` (**UTC only**). `test/envelope.test.ts` covers roundtrip +
validation + forward-compat.

Presence: Announce/HMAC (§5.5) stays for authenticated discovery/liveness;
`presence` / `typing` / `away` / `leave` travel as **encrypted meta-messages**
(relay blind). Ctrl+C and `/quit` → `presence:leave` last-will + clean
`node.stop()`.

### Core facade — `lib/core.ts`

The single **headless API both front-ends consume** (the "backend↔GUI" seam):
`Identity` (HEM or software, `ecdh`), `deriveRoom(id, peerPub, params) →
{topic, keys}`, and `openConversation(id, peerPub, {relay, …events}) →
Conversation` — which packs transport (peer + relay dial) + join + the
typing/away/leave presence machine behind `sendText / sendReaction /
noteActivity / noteAway / who / leave`. Web `app.ts` and the CLI
`chat-session.ts` (via bob/alice/ec) are now **pure UI** over this — no
duplicated key derivation or presence state machine. EH-2 / the §13 data plane
slot into `openConversation` without touching a UI. `test/core.test.ts` pins
`deriveRoom` == the direct rendezvous derivation (no drift).

### WebRTC direct data plane (§13 direct / P1)

Content moves off the relay onto a **direct WebRTC DataChannel** when two peers
are in the room; GossipSub carries only presence + the encrypted WebRTC signaling
(`t:'rtc'` envelopes) and is the content **fallback**. `room.ts` splits control
vs content (`setContentSend` / `injectContent`); `net/webrtc.ts` (`webrtcLink` —
RTCPeerConnection + DataChannel + STUN) and `net/webrtc-plane.ts` (`attachWebRTC`:
lower PeerId initiates, signaling rides the room) wire it;
`openConversation({webrtc:true, onWebrtcState})` enables it and reports the
transport for the UI badge (⚪ Relay → 🟢 WebRTC Direct). **Verified live**: two
browsers, DataChannel content both ways, badge flips. Browser-only — Node/CLI
stays on GossipSub. This is the **direct (P1)** profile (peers see IPs); the
relay-blind plane is still parked (Directions).

**Software identity (`browserSoftwareIdentity`)** — a WebCrypto X25519 keypair in
the browser (localStorage, no HEM), same `Identity` contract, for dev / no-HEM /
two-browser testing. ECDH via `crypto.subtle` (no 3rd-party crypto), byte-for-byte
== node/HEM raw X25519, so it interoperates with HEM identities. `localOnlyManager`
gives it a local-only contact book.

### ⚠️ INTERIM (must be replaced before shipping)

- `lib/msgcrypto.ts` — a **static AES-256-GCM sealed box** keyed from ss (HKDF);
  now seals **opaque bytes** (the envelope lives inside). Real E2E vs the relay
  but **no forward secrecy / no ratchet**. Placeholder until **EH-2 + Double
  Ratchet** (`docs/PROTOCOL.md` §6–7), held for the cryptographer.
- `lib/session.ts` — the **crypto seam** (EH-2 prep). The room talks to a
  `Session` (`encrypt`/`decrypt`), not to a key. `interimSession` wraps the box
  above; `eh2Session` is a **throwing stub**. When the design is blessed, EH-2
  drops in behind the SAME interface → room / envelope / transport unchanged.
  Establishment note: EH-2 handshake frames are a **separate pre-session wire**
  (NOT a sealed envelope — the session key doesn't exist yet), authenticated
  like Announce (see the `[EH-2 seam]` marker in `room.ts`); the per-message
  ratchet header rides INSIDE `Session`'s own wire, invisible to the room.
  `test/session.test.ts` covers the interim path + that the EH-2 stub throws.
- **Content prefers a direct WebRTC DataChannel** once two peers are in the room
  — content goes P2P (relay-blind); GossipSub through the relay carries presence
  + WebRTC signaling and is the content **fallback**. This is the **direct (P1)**
  profile: peers see each other's IPs. Everything still on GossipSub (presence,
  signaling, fallback content) is ciphertext + metadata to the relay. The
  **relay-blind / anonymous** plane (blind circuit-relay, no IP exposure —
  `docs/PROTOCOL.md` §13) is still the later step (see Directions).

## Directions

- **CLI as a full-product client** (a terminal alternative to the web GUI over
  the same protocol) — noted, **parallel, last step**; do not focus here now.
- **Web GUI (mockup skin)** — `web/index.html` is the dashboard skin from
  `skin/ui-mockup.html` (sidebar + chat panel + settings drawer, light/dark),
  wired to the engine: HEM login, contacts (localStorage) + **peer import**
  (add-peer modal: name + pubkey), envelope chat (typing/away/leave/reactions),
  UTC times, live room-rotation countdown. Unbacked mockup bits (Groups/Network
  tabs, P1–P3 profiles, direct/relay modes) are visual placeholders.
- **Data plane §13 — parked, blocked on the libp2p ecosystem.** Investigation
  (`net/circuit-probe.ts`, `net/circuit-two.ts`): the onchato relay **does**
  support circuit-relay-v2 (reservations + HOP CONNECT verified live). But on the
  pinned **libp2p 2.2.x** generation circuit-relay-v2's **destination-side STOP
  handling is broken** (relay "could not read response from B" → CONNECTION_FAILED;
  reproduced locally + in separate processes, full debug). A clean **v3 upgrade is
  impossible**: `@chainsafe/libp2p-gossipsub` (latest 14.1.2) is still on
  `@libp2p/interface ^2` while circuit-relay-v2 4.x needs interface ^3 — gossipsub
  hasn't migrated to libp2p v3, and we need gossipsub for rendezvous. **Revisit
  when gossipsub ships a v3 release** (then circuit-relay-v2 4.x should give the
  relay-blind / relay-only plane). **The WebRTC-direct plane (P1) is now built +
  verified in v6** (see "WebRTC direct data plane" above): content goes P2P over a
  DataChannel, GossipSub is the fallback — that covers the direct profile (peers
  see IPs). What stays parked is specifically the **relay-blind / anonymous**
  plane (no IP exposure).

## Status

- Specs (`docs/`) frozen pending cryptographer feedback — expect changes to
  EH-2/ratchet. Everything in `impl/` so far is EH-2-independent.
- **WebRTC direct data plane (P1) done + verified live** (two browsers,
  DataChannel both ways, badge ⚪ Relay → 🟢 WebRTC Direct). Ready to deploy.
- Commits ahead of origin; the user pushes (SSH passphrase).
