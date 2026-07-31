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

### Sessions and rooms — `lib/core.ts`

**One transport per client, many rooms on it.** `startSession(id, …)` owns the
libp2p node, the relay connection and its health, and the §9.1 self-topic watch;
`session.open(peer, …)` joins one room on it. `openConversation()` still exists
and is what the CLI and the tests use — it starts a private session, opens one
room, and closes both on `leave()`.

The split is not tidiness. The previous shape built a node and a relay connection
*inside* `openConversation`, which was invisible while the UI only ever held one
chat — and would have meant **a WebSocket per contact** the moment several are
open, for topics that one connection carries happily. Measured, for scale: 20
full EH-2 handshakes (both sides, ML-KEM included) take **66 ms**, and a sealed
round trip is **0.42 ms**. Twenty rooms is not a CPU problem and needs no worker;
twenty transports would have been.

Two things the refactor broke and how they are fixed — both worth knowing before
touching this again:

- **`seq` restarts per room, PeerIds no longer do.** Sharing a transport means
  leaving a room and coming back reuses the PeerId, so the peer's dedup
  (`${from}:${seq}`) silently discarded the new stream as already-seen.
  `forgetStream(peer)` clears dedup + ordering whenever a new ratchet is
  established, and on `forgetPeer`. A new stream starts wherever a new ratchet
  does.
- **Losing the network is now reported by the platform.** `session.setOffline()`
  is wired to the browser's `offline`/`online` events, which are immediate and
  certain; the heartbeat-reach and connection-count detectors stay as the
  fallback for "network up, relay unreachable". Inferring it from silence alone
  was unreliable — a socket survives a Wi-Fi drop as a zombie, and the browser
  test caught it failing about half the time.

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

### MQTT — the fall-back transport (`net/mqtt.ts`, `net/mqtt-node.ts`)

libp2p stays the main transport; MQTT is a second, fully working one, chosen per
session (`startSession({transport:'mqtt', broker})`, web `?mqtt=1`, CLI
`--mqtt`). README.md has the trade-offs and the broker setup; what matters here:

- **No dependency.** `net/mqtt.ts` is a hand-written MQTT 3.1.1 client — CONNECT,
  SUBSCRIBE, UNSUBSCRIBE, PUBLISH QoS 0, PING, DISCONNECT, over a WebSocket in
  the browser or TCP in Node. The subset is the point: QoS>0, retained messages
  and persistent sessions are the features that make a broker **store** traffic,
  and not implementing them is the cheapest guarantee that we never turn them on.
- **It wears the libp2p node's shape** (`net/mqtt-node.ts`) rather than
  introducing an abstraction. That surface — subscribe/unsubscribe/publish, a
  `message` event, `getSubscribers`, `peerId`, `getConnections`, `stop` — is
  already the project's de-facto transport interface, because every test double
  mocks exactly it. So room, core, WebRTC plane, EH-2 and all tests are
  untouched.
- **Sender identity moves into the topic**: publish `ec/<topic>/<client-id>`,
  subscribe `ec/<topic>/+`. MQTT does not identify publishers, and putting the
  sender in the payload would be a wire change the crypto layer would see.
- **`publish` reports `recipients: null`** — a broker does not say who is
  listening. The room's isolation check only fires on a real zero, so it simply
  does not fire here; liveness comes from the MQTT keep-alive instead.
- `npm run mqtt-meet` is the proof: two peers discover each other, complete EH-2
  and exchange ratcheted messages over a broker, with the engine unchanged
  (~130 ms discovery, ~200 ms handshake — verified live against bs1.onchato.com
  2026-07-31, an order faster than the mesh).
- **Metadata leak — inherent, not fixable in config.** Testing the live broker
  found that a client subscribing to `#` receives **every room's** traffic (the
  ACL blocks `$SYS` but must grant read on `ec/+/+`, which is network-wide —
  rooms are runtime secrets a static ACL cannot scope to). Content stays E2E
  encrypted; the exposure is which rooms are active + timing/size. GossipSub does
  not have this (no wildcard, unguessable topics). The ACL now scopes **publish**
  to the client's own id (`pattern write ec/+/%c` — our client already publishes
  `ec/<topic>/<clientId>` with `clientId` = the connect id, so it still fits) but
  read cannot be narrowed. Documented as a fallback trade-off in README; true
  isolation needs a broker capability plugin. **The earlier claim that the ACL
  stops enumeration was wrong** — corrected 2026-07-31.

### Test harnesses — what each one actually covers

| command | what it exercises |
|---|---|
| `npm test` | unit + offline integration over a mock pubsub (`test/*.test.ts`) |
| `npm run room-sim` | seeded synthetic network: loss, duplication, reorder, staggered joins, a throttled tab |
| `npm run gui-sim` | the `core.ts` facade the GUI buttons drive, printing a timeline |
| `npm run eh2-test` / `chat-test` / `meet` | live against the **real onchato relay** |
| `npm run browser-test` | two headless **Chromium**, the real bundle, the real relay, driven through the DOM |
| `npm run browser-test:ff` | the same scenarios with **Chromium + Firefox** |
| `npm run mqtt-meet` | the whole engine over an MQTT broker instead of libp2p |

The browser harness is the only thing that covers the **WebRTC data plane** —
Node has no `RTCPeerConnection`. It speaks two protocols because the browsers do
not agree on one: CDP for Chromium, **WebDriver BiDi** for Firefox (which
dropped CDP in 129). Both are JSON over a WebSocket that Node 24 already has, so
neither needs a dependency; they live behind one `Page` class in
`net/browser-test.ts`. Two things about the Firefox side are not obvious and both
cost a debugging round: its profile must sit somewhere a **snap** can see
(`~/snap/firefox/common/…`, because snap confinement hides dot-directories, and
Firefox then silently falls back to the user's real profile and hits its lock),
and BiDi answers with structured RemoteValues rather than JSON, so results need
converting back to plain data.

**Never pipe `browser-test` through `tail`** — it buffers and hides all progress;
redirect to a file instead. And watch what it leaves behind: leaked browsers from
repeated runs are what once exhausted this machine (`pgrep -f chrome`, `free -m`).

### Returning to an open room must not rebuild it

`openChat()` used to `leave()` and rebuild unconditionally, so **tapping a
contact you are already in** — which is how you get back to the room after the
mobile back-arrow — tore the conversation down: presence:leave, ratchet stopped,
a fresh handshake, and (because the WebRTC plane restarts) one side flipping to
Relay while the peer stayed on WebRTC. Reported as "back and return desyncs; the
ratchet comes back after N seconds; Firefox WebRTC, Chromium Relay, but messages
still arrive." The guard is now: if the tapped contact is the active one and its
conversation is live, just `showChatPane(true)` + a cheap `refresh()`, no
teardown. Pinned by the `browser-test` scenario "returning to a mobile room does
not tear it down" (checks the `sess-peerid` is unchanged across the round trip —
a rebuild would mint a new one), which **fails without the guard** (verified).

### Compact layout (phones, and phones on their side)

The two-panel dashboard needs **both** dimensions, so the condition is
`@media (max-width:900px), (max-height:560px)` — narrow **or** short gets **one
pane at a time**: the contact list or the conversation, switched by `.chat-open`
on `#app`, with a back arrow in the chat header.

Width alone was wrong, and a user found it: a phone in **landscape** is 852×393,
sails past every "phone" breakpoint, and got the old stacked layout — contact
list on screen, conversation below the fold, and nothing scrolling anywhere,
because `.app{height:auto}` let the panel grow instead of `.messages` overflowing
inside it. "I cannot see the chat at all, scrolling does not work."

**`#btn-back{display:none}` must stay ABOVE the media query.** Same specificity,
so source order decides; putting it after silently disables the back button on
every phone. This has now been broken twice — check it when moving CSS around.

Pinned by the `browser-test` "phone layout" scenario, which runs **both
orientations** (390×780 and 852×393) on whichever browser is B, and by
`node net/phone-shot.ts <dir>` — screenshots at real device metrics (iPhone 16,
Galaxy S24/Ultra, landscape, tablet), including the keyboard case. A layout bug
is a visual fact; assertions about computed styles miss overlap and clipping.
Two more that are easy to get wrong:

- **Height is `--app-h`, kept in step with `visualViewport`.** A software
  keyboard does not resize `100vh` — that is the screen — so the composer ends up
  underneath it. The clamp applies **only** while a field is focused and
  something really covers the screen (>120px): `visualViewport` reports a smaller
  height for other reasons too, and an unconditional clamp shrank the app to 63%
  of the window under an emulated viewport.
- **`min-height` had to go on phones.** The desktop `.app{min-height:560px}`
  floors the height, and a floored height with the keyboard open pushes the
  composer off screen — exactly what `--app-h` exists to prevent.

Touch also gets what hover-only affordances cannot give it: `@media
(pointer:coarse)` keeps the reaction bar permanently visible, gives every target
a finger-sized minimum, and sets inputs to 16px so iOS does not zoom the page on
focus.

### Delivery contract — acks, backoff, and the ⚠ marker

**Nothing under us retransmits.** GossipSub is fire-and-forget and a DataChannel
can look open while swallowing everything, so the room does its own delivery
tracking: `msg` and `file` envelopes carry an `id`, the receiver replies with an
`ack` envelope, and an unconfirmed message is re-sent on a widening backoff —
**1.5 s, 4 s, 8 s, 15 s, 15 s, capped at 60 s** total. The budget only keeps
running **while the peer is still announcing**; the clock is about a lost frame,
not an absent peer, and a peer that went quiet stops the retries rather than
burning them. Silence from a peer that has never sent an `ack` at all is read as
"old build", not as loss, and is never reported.

**Running out of budget does not throw the message away.** The bytes stay in
`resendable`, the bubble gets a ⚠ marker with a **↻** button, and
`conversation.resend(id)` sends them again **under the same id** — so the marker
the user is looking at is the one that turns into ✓. This replaced the earlier
contract where a message was declared lost after a few seconds and silently
dropped; a laptop that sleeps for a minute now costs a click, not a retype.

**A backlog leaves in the order it was written.** `room.flushPending()` re-sends
everything still unconfirmed, oldest first (`pending` is a Map, so insertion
order *is* send order), and restarts each message's budget — a message deserves
a full one from a transport that exists, not the remains of one it spent while
offline. `sentAt` still records when the user pressed enter, so delivery times
stay honest; `since` carries the budget. Core calls it whenever the relay
connection comes back and on `refresh()`.

**Two different silences, told apart.** `onLink` (core) reports *our own*
transport — `online` / `reconnecting` / `offline` — driven by libp2p's
`connection:close`, a 10 s poll, and above all by **what the transport actually
delivers**: GossipSub reports how many peers a publish reached, and two
heartbeats in a row reaching zero means we are talking to ourselves whatever
`getConnections()` claims (`onIsolated` → hang up, then re-dial). That is the
honest signal — an offline machine keeps a connection object nothing has tried
to write to, which is why a cut network used to look perfectly healthy. Core re-dials by itself with backoff
instead of waiting for the tab to be focused. Separately, the room now reports a
peer as `quiet` after ~35 s without an Announce (2.5 missed heartbeats), well
before the 90 s that count as `leave`: the ratchet is untouched and one Announce
takes it back to `active`. Before this there was a minute and a half in which a
green badge and a dead connection looked exactly alike.

**Signalling retries too.** An offer or an answer rides GossipSub, which is
fire-and-forget, and nothing here used to re-send — so one lost frame put a
conversation on the relay for its whole life, and whether that happened was
luck. The offering side (lower PeerId; the answering side must not fight it) now
re-offers after 10 s without a proven channel, three attempts, then stays on the
relay. `test/webrtc-plane.test.ts` covers this and the rebind with an injected
link (`makeLink`) — `RTCPeerConnection` does not exist in Node.

**The first unconfirmed re-send demotes the direct path — but only if content is
actually riding it.** A DataChannel that goes deaf mid-conversation is worse than
the relay, so one stall hands content back to GossipSub for the rest of the
conversation (`onStall` → `plane.demote()`, no second chance). The narrower
condition is the point: an ordinary GossipSub drop used to trigger the same ban
and permanently punish WebRTC for the relay's hiccup. Both halves are pinned by
tests. Relatedly, a channel is trusted only after a `0x00`-prefixed ping/pong
round trip proves both directions — `onopen` alone has lied in testing, with both
badges reading "Direct" while content vanished.

### EH-2 + Double Ratchet — `impl/eh2/` (the default since 2026-07-30)

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
- **The ratchet serialises its own calls, and must keep doing so.** `encrypt`
  reads `ckSend`/`nSend`, awaits WebCrypto four times, then writes them back;
  `decrypt` does the same to the receiving side. Two calls issued in one tick
  interleave, derive a message key from the *same* chain key, stamp the *same*
  `n`, and both advance the chain — the peer can open at most one of those
  frames and its receiving chain stays behind the sender's **permanently**. It
  presents as "messages stop arriving" with a green badge and nothing in any
  log. This is not a theoretical race: the room sends content without awaiting
  it (`void emitContent(...)`), so an ack for an incoming message races a typing
  notice, and a flush of pending messages races itself. The fix is a promise
  chain around `encrypt`/`decrypt` in `ratchetFrom`; `test/eh2-ratchet.test.ts`
  pins it with a same-tick burst.
- **The msg3 gate is structural**: on the responder the `Session` does not exist
  until `mac_i` verifies, so early data from the initiator has nothing to open it.
- **KATs** (`test/eh2-handshake.test.ts`, `test/eh2-mlkem.test.ts`) pin the
  schedule with fixed keys — re-record deliberately, and use them when porting
  to `core-rs`.
- **The session has a bounded lifetime (§7.3).** A fresh EH-2 is forced after a
  randomised 4–8 h (`Eh2Options.sessionLifetimeMs`; the randomisation stops a
  fleet re-keying in lockstep). It is not housekeeping: it caps classical-PCS
  exposure, and it is the hard stop on a stolen unlocked device, because the
  ratchet itself never touches the HSM but the re-handshake does (§9.3). It is
  transparent — the running ratchet keeps carrying content until the replacement
  is live, and the ratchet it replaces is kept for 60 s so frames already in
  flight under it still open (the two sides do not switch at the same instant).
- ML-KEM is the **one** third-party crypto dependency (WebCrypto has no ML-KEM);
  everything else is `crypto.subtle`.

**Wiring (on by default, both sides must agree):** `room.ts`'s `[EH-2 seam]`
gives each peer its own handshake + ratchet when `keys.eh2` is set; handshake
frames ride the control plane unsealed (told apart by their type byte), the lower
peer id initiates, and content typed before the handshake completes is queued.
`openConversation({eh2, onSecurity})` is the switch and **`core.ts` stays a
mechanism — it does not default it**; the front-ends set the policy: web is EH-2
unless `?eh2=0` (the E2E badge goes 🤝 → 🔐), CLI unless `ec chat <name>
--no-eh2`. Two peers on different settings cannot read each other, so the escape
hatch is a decision for both ends. **Verified live** on the onchato relay:
`npm run eh2-test` (`net/eh2-chat-test.ts`), and `npm run gui-sim` drives the
same facade the GUI buttons use, printing a timeline.

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

### Two windows, one identity — and other peers that are not the contact

A pair topic can contain more than the two people it was derived for. A **second
tab logged into the same identity** derives the same topic and the same Announce
MAC key, so its announces verify perfectly and each tab takes the other for the
contact. The handshake can never succeed — each side expects the CONTACT's
identity key and is offered its own — and without a stop rule the two retried
each other forever: badge flickering 🔐/⚠, conversation dead, flapping that
outlived the extra tab (reported live, 2026-07-30).

What settles it:

- **`initiator_id` is the one conclusive statement about identity.** msg1 carries
  it, derived from the sender's IK, and the responder compares it with the
  contact it holds a key for. That check cannot be an accident of timing, so one
  occurrence is enough: the peer is ignored for 5 minutes and the UI is told.
  **Do not use a failed MAC for this** — honest peers that open handshakes at the
  same moment produce `mac_i` failures routinely, and an earlier attempt at this
  blacklisted the room's real contact within seconds.
- **The retry escalation slows down, it never stops.** A link losing a third of
  its frames needs many attempts before the first handshake lands (`room-sim`'s
  35%-loss profile fails outright if this ever gives up), so all the backoff buys
  is quiet: one attempt per 15 s instead of one per second.
- **Two live windows both keep their sessions.** `retireOtherPeers` only retires
  a PeerId that has stopped announcing (a reload goes silent instantly; a second
  tab does not). Retiring on every new establishment handed the whole
  conversation to whichever window handshaked last — which is what "everything
  stopped working when I opened a second tab" was.
- **The badge shows the best state, not the last event.** A room can hold several
  peer ids; rendering whichever fired last made it flicker while a good session
  was carrying messages.

### One identity, one session — the self-topic (§9.1) — `lib/selfsession.ts`

Each client subscribes to a topic derived from its **own** identity key
(`deriveSelfRoom`: `ss = ECDH(IK, IK_pub)`, then the ordinary §5 derivation). Only
the holder of that IK can derive the topic or produce a valid Announce on it, so
anything valid arriving there is another window of *us*.

**Both duplicates stand down** (the user's call, 2026-07-30). The spec hands the
session to the newer window; we close **both** and make the user re-enter one
deliberately. Fail-closed: nothing in the client can tell which window the user
meant, and if one of them is not the user at all, letting it win by arriving
second is the wrong default. A page **reload is unaffected** — that window is
gone before the new one starts, so it never announces.

Details that are load-bearing:

- **The window that steps down publishes one last Announce on its way out.**
  Without it the rule half-fires: the settled window hears the newcomer and goes
  silent immediately, so the newcomer — still inside its own opening window —
  may never hear anything and carries on alone. (Caught by the test, not by
  reasoning.)
- **The mechanism diverges from the spec's, deliberately.** §9.1 compares the
  announce timestamp with the local session start, which assumes the announce
  carries the *session start*; §5.5's carries the *send* time, so a literal
  implementation has every newcomer evict itself on the first heartbeat. A
  `since` field would fix it — §5.5 is frozen for the audit, so the decision is
  made from local knowledge instead. **If the spec is ever reopened, adding
  `since` to the Announce is the change to make.**
- Wired in `openConversation` (it owns the libp2p node) and **best effort**: if
  the self-topic cannot be derived — a HEM that refuses an ECDH against its own
  public key, say — the conversation runs on without the rule rather than
  failing. When the app grows to several conversations at once this belongs in an
  app-level session manager, one watch per identity rather than per room.
- Both front-ends honour it: the web clears the transcript and says what to do,
  the CLI prints and exits.
- **Capacity note:** every client now holds **two** relay topics (pair + self).
  The relay's topic budget and eviction are sized per topic — halve the client
  estimate.

### ⚠️ INTERIM (fallback only — on its way out)

- `lib/msgcrypto.ts` — a **static AES-256-GCM sealed box** keyed from ss (HKDF);
  seals **opaque bytes** (the envelope lives inside). Real E2E vs the relay but
  **no forward secrecy / no ratchet**. Reachable only via `?eh2=0` / `--no-eh2`,
  kept as an escape hatch while EH-2 settles; **delete it** (with
  `interimSession`) once nothing needs the fallback.
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
- **EH-2 + Double Ratchet is the default content crypto** since the two-browser
  validation passed (Chromium + Firefox, handshake in ~2 s). The interim box is
  now only `?eh2=0` / `--no-eh2` and is scheduled for deletion.
- **WebRTC direct data plane (P1) done + verified live** (two browsers,
  DataChannel both ways, badge ⚪ Relay → 🟢 WebRTC Direct). Ready to deploy.
- Known follow-ups in the EH-2 area: bounded session lifetime / re-handshake
  (§7.3, "stage 7"), skipped-key persistence across restarts, and §9 takeover.
- Commits ahead of origin; the user pushes (SSH passphrase).
