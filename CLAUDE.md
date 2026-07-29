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
duplicated key derivation or presence state machine. That paid off: **EH-2
slotted in as two options** (`eh2`, `onSecurity`) with no UI surgery, and the
§13 data plane will too. `test/core.test.ts` pins `deriveRoom` == the direct
rendezvous derivation (no drift).

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

### EH-2 + Double Ratchet — `impl/eh2/` (built, opt-in)

The cryptographer green-lit implementing §6–7 as written (fix-forward if the
review turns something up), so the real scheme now exists next to the interim
box. Built in six stages, each with automatic tests and its own commit:

| file | what |
|---|---|
| `eh2/wire.ts` | canonical msg1/2/3 + the `h1` / `h2_partial` / `h3` transcript (§6.1–6.2) |
| `eh2/handshake.ts` | the two state machines, `ikm` in **responder perspective** (§6.3), `SK`, `mac_r` / `mac_i` |
| `eh2/mlkem.ts` | ML-KEM-768 (`@noble/post-quantum`) filling the `ss` slot of the hybrid |
| `eh2/ratchet.ts` | Double Ratchet (§7): DH step, MK/CK chains, HKDF nonces, AES-GCM with the header as AAD, bounded skipped keys |
| `eh2/establish.ts` | drives the three frames (`startHandshake`), hands back a `Session` |
| `lib/x25519.ts` | X25519 as a `Dh` capability — a local ephemeral or the HEM's IK behind one interface |

Notes that matter for anyone touching this:

- **Serialization must stay canonical.** `h1` hashes `serialize(msg1)` and salts
  `SK`; two encodings of one frame = two different session keys.
- **One HSM call per side.** Each party does exactly one DH with its own IK
  (raw `ecdh`, §4.3) — the other two DHs are local ephemerals. `Dh` hides which
  is which, so a HEM identity and a software identity are interchangeable.
- **`decrypt` is transactional.** Keys are derived on the side and the state
  advances only after the AEAD verifies. The naive version (found in testing)
  let a forged frame burn the live chain key, and a forged `dh_pub` step the
  **root key** — an unauthenticated desync. Do not "simplify" this back.
- **The msg3 gate is structural**: on the responder the `Session` does not exist
  until `mac_i` verifies, so early data from the initiator has nothing to open it.
- **KATs** (`test/eh2-handshake.test.ts`, `test/eh2-mlkem.test.ts`) pin the
  schedule with fixed keys — re-record deliberately, and use them when porting
  to `core-rs`.
- ML-KEM is the **one** third-party crypto dependency (WebCrypto has no ML-KEM);
  everything else is `crypto.subtle`.

**Wiring (opt-in, both sides must agree):** `room.ts`'s `[EH-2 seam]` gives each
peer its own handshake + ratchet when `keys.eh2` is set; handshake frames ride
the control plane unsealed (told apart by their type byte), the lower peer id
initiates, and content typed before the handshake completes is queued. Enable
with `openConversation({eh2: true, onSecurity})` — web: `?eh2=1` (the E2E badge
goes 🤝 → 🔐), CLI: `ec chat <name> --eh2`. **Verified live** on the onchato
relay: `npm run eh2-test` (`net/eh2-chat-test.ts`), and `npm run gui-sim` drives
the same facade the GUI buttons use, printing a timeline.

**Handshake frames get dropped — treat that as normal, not exceptional.**
GossipSub is fire-and-forget and a joining peer's mesh grafts over hundreds of
ms, so the opening frames of a handshake routinely reach nobody. Three
mechanisms cover it, and removing any one of them brings back a hang that looks
like broken crypto: the opening frame is **re-sent** a few times while an
attempt waits; an attempt that stays silent **times out and is retried**; and
after a failure **either side may initiate**, because a lost msg3 leaves the
responder — the side that never initiates — as the only one that knows anything
is wrong. A msg1 also restarts a responder that already holds a session (peer
reloaded / rotated its PeerId); the session is replaced only once msg3 verifies.
Discovery itself is gated on the relay joining the topic (~0.5 s), which is why
the room announces as soon as `getSubscribers(topic)` is non-empty rather than
after a fixed delay.

### ⚠️ INTERIM (still the default path)

- `lib/msgcrypto.ts` — a **static AES-256-GCM sealed box** keyed from ss (HKDF);
  seals **opaque bytes** (the envelope lives inside). Real E2E vs the relay but
  **no forward secrecy / no ratchet**. Still what a conversation uses unless EH-2
  is switched on; remove once EH-2 is the default.
- `lib/session.ts` — the **crypto seam**. The room talks to a `Session`
  (`encrypt`/`decrypt`), not to a key: `interimSession` wraps the box above,
  `eh2Session` wraps the ratchet. Same interface, so room / envelope / transport
  never learned which scheme is in use. `test/session.test.ts` covers both.
- **Content prefers a direct WebRTC DataChannel** once two peers are in the room
  — content goes P2P (relay-blind); GossipSub through the relay carries presence
  + WebRTC signaling and is the content **fallback**. This is the **direct (P1)**
  profile: peers see each other's IPs. Everything still on GossipSub (presence,
  signaling, fallback content) is ciphertext + metadata to the relay. The
  **relay-blind / anonymous** plane (blind circuit-relay, no IP exposure —
  `docs/PROTOCOL.md` §13) is still the later step (see Directions).

## Deploy (onchato.com) — two parts, one host

The host builds; nothing is uploaded. Clone lives at **`/opt/github/encedo-chat`**.
The two halves are independent — deploy either alone.

**Relay (`bs1.onchato.com`) — a service, so it MUST be restarted:**

```bash
cd /opt/github/encedo-chat && git pull
cd relay && npm ci
sudo systemctl restart onchato-relay
journalctl -u onchato-relay -n 12 --no-pager
```

Three startup lines say it worked: the PeerId (**must** stay
`12D3KooWP6Sp…cDmp` — clients have it hardcoded), the port, and the topic
budget (`📦 Tematy: limit … eviction …`). If the log looks like the previous
build, check in this order: `git log --oneline -1` (did the pull land, and in
*this* clone?), `grep -c "max-topics" relay/relay.mjs` (is the code on disk?),
`systemctl show onchato-relay -p ExecMainStartTimestamp` (did it actually
restart?), `systemctl cat onchato-relay | grep -E 'WorkingDirectory|ExecStart'`
(is systemd running this directory at all?).

**Web — static files, so there is NO service to restart:**

```bash
cd /opt/github/encedo-chat && git pull
git submodule update --init --recursive     # hem-sdk-js: the build imports it directly
cd impl && npm ci && npm run web:build      # → impl/web/dist (what nginx serves)
```

`sudo systemctl reload nginx` only if you changed nginx config. Verify with
`curl -s https://onchato.com/ | grep -o 'app\.[a-z0-9]*\.bundle\.js'` — the
content hash must change; if it did not, the build did not land where nginx
serves from. Bundle names are hashed but `index.html` is not, so keep its
cache short (users otherwise keep requesting the previous hash).

**Deploy lessons paid for once (2026-07-29):** a stale relay silently refused
every new topic and looked exactly like a broken client — always check the
relay first when "rooms don't work". And a missing log line means the deploy
is unverified, not that the feature is missing: confirm with `git log` +
`grep` on the host, not by eye on the log.

**The relay can be healthy and still ignore you.** Same day, second cause with
the same symptom: GossipSub graylisted clients by IP colocation. Behind nginx
that is fatal rather than merely wrong — the proxy makes **every** client
arrive from `127.0.0.1`, so the penalty counts all users as one address, and a
non-positive score keeps a peer's IP reserved for an hour after it disconnects
(page reloads during testing are enough to fill it). Connections and meshsub streams looked fine, the log said nothing.
Scoring is now configured with `IPColocationFactorWeight: 0`; the reproduction
lives in `impl/net/relay-colocation-test.ts`. When rooms do not form, the
question to ask is not "is the relay up" but **"does the relay act on our
subscription"** — `pubsub.getSubscribers(topic)` on the client answers it, and
`[+topic]` in the relay log confirms it.

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

- Specs (`docs/`) still the audit target — **do not edit them here**. The
  cryptographer cleared implementation of §6–7 as written; if the review lands
  changes, they go into `docs/` by the user and into `impl/eh2/` as fixes.
- **EH-2 + Double Ratchet built and live-verified** (`impl/eh2/`, opt-in via
  `?eh2=1` / `--eh2`; `npm run eh2-test` passes against the onchato relay).
  Default content crypto is **still the interim box** until the two-browser
  validation says otherwise.
- **WebRTC direct data plane (P1) done + verified live** (two browsers,
  DataChannel both ways, badge ⚪ Relay → 🟢 WebRTC Direct). Ready to deploy.
- Known follow-ups in the EH-2 area: bounded session lifetime / re-handshake
  (§7.3, "stage 7"), skipped-key persistence across restarts, and §9 takeover.
- Commits ahead of origin; the user pushes (SSH passphrase).
