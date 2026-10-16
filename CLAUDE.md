# CLAUDE.md — v6 implementation notes

Working notes for the code in this repo. **The docs describe the SHIPPED
implementation — `docs/SPEC.md` is kept 1:1 with the code** (the user's
decision, 2026-08-30). A wire behaviour the client has and the spec omits, or
the reverse, is a defect in one of them: fix the spec in the same change, or
flag it to the user if the divergence is a decision. This file is authoritative
for operational reality — rules, traps, deploy rituals — and deliberately
carries no history: that is `git log`.

- `docs/SPEC.md` — protocol & crypto, **normative for what is on the wire**;
  flat: it states the shipped behaviour and carries no change notes.
- `docs/RATIONALE.md` — the why: rationale per area, decision record,
  alternatives, the PQ roadmap, open questions, implementation map.
- `docs/ARCHITECTURE.md` — product & infrastructure, shipped state + roadmap rows.
- `docs/THREAT-MODELS.md` — deployment profiles P1–P3, controls vs intentions.
- `docs/AUDIT.md` — the auditor's entry point; `docs/kat/` the known-answer
  vectors; `docs/proverif/` the models (CI: `proverif.yml`); `docs/PROTOCOL.md`
  is a stub pointing at SPEC.
- These go to the external cryptographer — protocol-meaningful changes need
  the user's explicit GO; editorial truth-keeping does not.

## Code is ASCII (the user's rule, 2026-09-03)

No icons, no emoji, no dingbats or box-drawing in source — not in log output,
not in comments. `[ok]` / `[fail]` / `WARNING:` / `->` say the same thing and
survive a journal, an SSH session and a grep. Three things it does NOT cover,
and each has bitten a sweep already:

- **The UI keeps its glyphs**: badges, buttons, the reaction set, `data-i18n`
  strings, `index.html`. Only comments are scrubbed in `impl/web/`.
- **Test data is data.** `quote.test.ts` proves a snippet never splits an emoji;
  `qr.test.ts` has KAT vectors; `linkify` carries a Cyrillic homograph on
  purpose. Scrub comments there, never literals.
- **Content is content.** `lib/quote.ts` appends U+2026 to a clamped quote — it
  goes in the bubble and counts against `QUOTE_MAX`.

Polish text and `§` stay. When a log line changes, the docs that quote it change
with it — `relay/README.md` and `relay/DEPLOY.md` print the relay banner, and this file
names its lines.

## Repo layout (`encedo/encedo-chat`)

- `docs/` — above.
- `impl/` — the app: engine (`lib/`, `eh2/`, `net/`), web UI (`web/`), the
  terminal client (`cli/`, `onchato-cli`; root `CLI.md`), Tauri desktop + Android +
  iOS shell (`src-tauri/`), tests (`test/`), the committed WASM core
  (`core-wasm/core.wasm`).
- `core-rs/` — the Rust core (EH-2, ratchet, sender keys), built to WASM and
  linked natively into the Tauri shells (below).
- `relay/` — the relay node (libp2p GossipSub + circuit-relay-v2 + the light
  pick/push protocol), self-contained: pull → `npm ci` → systemd
  `onchato-relay`. `--pass bs1.onchato.com` seeds the fixed PeerId
  (`12D3KooWP6Sp…cDmp`) — never change it or every client breaks. `DUMP=<dir>`
  traces every observable action to JSONL — **never on production**
  (`relay/README.md` § Dump). A new node from a clean Ubuntu is
  `infra/bs-setup.sh` / `relay/DEPLOY.md`.
- `infra/` — `nodes.json` (the compiled-in node list), `deploy-on-tag.sh` +
  systemd units (tag-driven web deploy), `nginx/` (the web host's site file and
  the relay-node template; deploy in `infra/nginx/README.md`), `fput/` (the
  upload prefixer), `feedback/`, `stun/`, `health/`, `dash/`, `release/`,
  `well-known/`, the IPFS TTL sweeper, and `geoip/` — **the sanctions
  geoblock** (KP IR CU RU BY SY get HTTP 451 on every onchato path of every
  node and no STUN answer; the app/CLI say "not available in your region",
  `lib/regioncheck.ts`) plus the **abuse list** (the tool `infra/geoip/onchato-block`
  is here; the list itself is kept on the operator's machine, never in the repo). The operator note is `GEOBLOKADA.md`
  outside the repo.
- `scripts/` — release tooling (`approve-web.mjs`, `release-manifest.mjs`,
  `release-cid.mjs`, `yubikey-sign.mjs`), `export-kat.mjs`, `web-monitor.mjs`,
  `build-icons.mjs`.
- `Dockerfile` + `.dockerignore` (allow-list) — the **CLI** image only; the
  context is the repo root because the CLI imports `hem-sdk-js/`,
  `relay/pick.mjs`/`load.mjs` and `impl/core-wasm/core.wasm`.
- `hem-sdk-js/` — the Encedo HEM SDK as a **git submodule**. Do not fork;
  update via `git submodule update --remote`.
- Root `*.md` — `README`, `SECURITY`, `CLI`, `hem_usage` (**which operations
  reach the HSM and what they cost** — read it before adding anything that talks
  to the device), plus design records and plans (`GROUPS-DESIGN`,
  `TRANSFER-DESIGN`, `DISCOVERY-PROPOSAL`, `MOBILE-PLAN`, `EMBED-PLAN`,
  `CLI-PLAN`, `performance`) — those are records, SPEC wins where they differ;
  superseded plans go to `docs/archive/`.

Older iterations (v2–v5) are the separate repo `encedo/onchato.com`.

## HEM / SDK reality vs. design  ← the important one

**Design (in the specs):** the HSM exposes `ecdh` raw and `ecdh`+**HKDF executed
inside the HSM**, so that IK-derived secrets (rendezvous topics, Announce MAC
keys, cache key) never leave the device. `docs/SPEC.md` §4.3 is written against
this.

**Current firmware / `hem-sdk-js`: no in-HSM HKDF yet.** `ecdh` returns the raw
32-byte shared secret only. HKDF-in-HEM comes with newer firmware; the specs
describe that target and stay as they are.

**The seam is built (`lib/derive.ts`).** No consumer calls `id.ecdh` for a
rendezvous, Announce, rotation, decoy-seed, group-MAC, invite or storage-name
key; they call `deriveWith(id, label, peer, ctx, L)`, and the backend's `derive`
decides where the HKDF runs. Today the HEM backend's `derive` is
`deriveOverEcdh(ecdh)` — HKDF in the client over the raw output, wiped at once.
The session memoises **derived values** (`pairDay` in `lib/core.ts`; an epoch's
`rk_i` per member in `GroupManager`), never a pair secret;
`test/derive.test.ts` pins that a backend which derives is the one asked and
its raw `ecdh` is never called.

**When the newer FW lands, change exactly this** (also in `docs/RATIONALE.md`,
open questions):

1. `hemIdentityFrom` (`lib/core.ts`): `derive:` becomes the SDK's in-device
   call — label, ctx and L go to the device; cover the public-key form and the
   two-KID form (`peerKid`).
2. `hemGkBackend` (`lib/core.ts`): the GK's `derive` likewise.
3. Nothing else in the engine. Then close S13 in `docs/SPEC.md` §11.3, drop the
   raw-output sentence of §4.3, re-measure `hem_usage.md` (ask for a batch form,
   one ECDH with a list of `(ctx, label, L)`), and run the live HEM test
   (`hem-gk-test`) — no automated test reaches a device.

Raw `ecdh` stays, by decision, for the one DH with IK inside EH-2 and the §10
cache base `ECDH(IK, emp_pub)`.

**A knock costs the device nothing.** Knocks are sealed to a per-invite key
(`inviteKey` in `lib/inbox.ts`, derived once per invite per session); opening is
a local X25519, capped at 60/min before opening; our own decoys are never
opened. `test/inbox.test.ts` "a flood of frames costs the identity backend
nothing" pins it. Never put a device call on a path a stranger can trigger.

**Newer FW — `api/search` returns public keys.** Today `searchKeys` returns only
`{kid,label,type,description}`, so `hemContactBook.list` does one `getPubKey`
per contact. When that FW ships, drop the per-kid loop.

## SDK facts (from `hem-sdk-js`)

`new HEM(url)` points at a real device or a local software stub. Auth = **scoped
JWT**: `authorizePassword(password, scope)` (PBKDF2-600k + X25519 client-side)
or `authorizeRemote` (mobile push); crypto ops need `keymgmt:use:<kid>`.

| SDK method | Use |
|---|---|
| `authorizePassword` / `authorizeRemote` | scoped JWT |
| `createKeyPair(token, label, 'CURVE25519', descrB64)` | IK at onboarding → `{kid}` |
| `importPublicKey(token, label, 'CURVE25519', pubBytes, descrB64)` | a contact's IK_pub, a group's `GK_pub` |
| `ecdh(token, kid, peerPubB64)` | **raw 32-byte shared secret** |
| `searchKeys(token, descr)` / `listKeys` / `getPubKey` | resolve contacts, identities, group markers |
| `deleteKey(token, kid)` | contact removal, IK rotation |
| `deriveKey(...)` | deterministic provisioning on two HEMs — provisioning/HA, not the message path |

In the HSM, unused today: `hmacHash`/`hmacVerify`, `cipher*`,
`mlkemEncaps`/`Decaps`, `mldsaSign`/`Verify` (de-risks the PQ identity phase).

Gotchas: the device API needs a `mode` on `create`/`derive` (CURVE25519→`ECDH`,
ED25519→`ExDSA`) — the SDK fills it from the type, so a raw REST call must; `searchKeys` pattern is base64 with a leading `^` — an
anchored prefix, which is the entire scoping mechanism for identities, contacts
(`ETSEIC:peer1,<ownerKID>,<name>`, name = the whole tail) and group markers;
`allow_keysearch` matches the **first six bytes** (hence `ETSEIC:`); `label` is
capped at 32 characters and DESCR at 128 bytes — truncate with `lib/descr.ts`'s
byte-safe helpers (`sliceBytes`, `byteLen`; `descr.ts` also builds the
identity and contact records), never `String.slice`; the device refuses to hold the same
public key twice under any DESCR (`KID = SHA-1(pub)[0:16]`). The endpoint spec
of record is the sibling PHP repo `hem-api-tester`.

## Engine map (impl/)

Node 24 runs the `.ts` directly (type stripping, no build). `npm test` = offline
unit tests.

- `lib/core.ts` — the headless facade both front-ends consume: `Identity` (HEM
  or software), `startSession` (one transport, many rooms), `session.open`,
  presence watches, rotation, node failover. The web `app.ts` and the CLI are
  pure UI over it.
- `lib/room.ts` — one conversation: control vs content planes, delivery
  tracking, the EH-2 seam, the pre-handshake queue.
- `lib/envelope.ts` — the versioned JSON envelope, `{ v, t, id, ts, seq, … }`,
  the types of `SPEC.md` §7.4; `format:'plain'` — **never raw HTML**; unknown
  `t` → `UnknownEnv`, ignored. `seq` is UX only, not security.
- `lib/session.ts` — the crypto seam: the room talks to a `Session`
  (`encrypt`/`decrypt`), today always EH-2 (TS, WASM or native engine).
- `lib/time.ts` — **two clocks on purpose**: the protocol computes in UTC (epoch
  `ts`, the §5.4 rendezvous day — go local there and two peers derive different
  topics); anything shown to a person is `localHHMM`. The timezone never reaches
  an envelope. `test/time.test.ts` pins both halves.
- `eh2/` — EH-2 + Double Ratchet (below). `net/` — libp2p peer, the light
  client, WebRTC, every live harness.
- `cli/onchato.ts` — the terminal client; keeps the browser's records in
  `~/.config/onchato/store.json`, so a profile moves between app and terminal
  through `lib/migrate.ts` unchanged. One contact book for both:
  `lib/localbook.ts`.

### Links in a message — `lib/linkify.ts`

A URL is **found but not made clickable**: the address stays inert text and a
small arrow beside it opens the destination. `linkify.ts` returns *ranges*; the
UI builds text nodes, so the message never becomes markup, and what you read is
what you would visit (no separate label to disagree with the target).

| case | behaviour |
|---|---|
| any scheme but `http`/`https` | text only |
| credentials in the authority | refused (`https://bank.example@attacker.tld`) |
| non-ASCII host | arrow, **flagged**, with the punycode |
| bare `www.` / `example.com` | not detected |
| trailing `.,;:!?`, unbalanced brackets | trimmed; balanced pairs kept |

Opening asks first and says the destination learns your IP and time; the
"don't show again" lives in RAM. Always a new tab (navigating away tears down
every ratchet) — except a link to this app's own address carrying `#i=`, which
opens add-contact in place (`ownInvite`). `rel="noopener noreferrer"` +
`referrerpolicy="no-referrer"`. **No link previews, by decision** — fetching a
thumbnail contacts a stranger's server before anyone clicks.

### Replies (`re`) and corrections (`edit`)

- **A reply is `msg`/`file` with `re = { id, au?, text }`.** The quoted text
  travels (the transcript is ephemeral, so an id-only quote would mostly render
  as "unavailable"); `QUOTE_MAX` = 160 code points, receiver accepts
  `QUOTE_MAX_WIRE` = 400 UTF-16 units. The
  author is a 4-byte key hint resolved locally — matching nobody, or two
  people, shows the words **without** a name. A broken `re` costs the quote,
  never the message.
- ⚠️ In a **1:1** the room's `onMessage(from, …)` gives the **transport PeerId**;
  in a **group** it gives the member's **identity key**. The UI fills `au` from
  `contact.pub` in a 1:1 and from `from` in a group. This pair has been
  confused three times.
- **`edit = { to, body, format }`, 1:1 only, by design**: a correction rides
  1:1 delivery tracking, so the sender is told "they still see the old text"
  when it fails; a group has no acks to vouch for it. Fifteen minutes from the
  message (`EDIT_WINDOW_MS`), 5 min skew (`EDIT_SKEW_MS`); `acceptEdit` refuses
  a correction aimed at a message of OURS; a pin is a snapshot; an empty
  correction cancels. `appendMsg` takes the log event (`MsgEv`), system lines
  use `appendSys`.

### Sessions and rooms

**One transport per client, many rooms on it** (`startSession` → `session.open`).
A WebSocket per contact would have been the alternative. Measured: 20 full EH-2
handshakes take ~50–70 ms (`performance.md`), a sealed round trip 0.42 ms — rooms are not a CPU problem.

- **`seq` restarts per room, PeerIds do not.** `forgetStream(peer)` clears
  dedup + ordering whenever a new ratchet is established and on `forgetPeer`;
  otherwise the peer's `${from}:${seq}` dedup discards the new stream.
- **Losing the network is reported by the platform** (`session.setOffline()` on
  the browser's `offline`/`online`); heartbeat reach and connection count are the
  fallback for "network up, relay unreachable". A socket survives a Wi-Fi drop
  as a zombie.

### Many open conversations, one on screen (`web/src/app.ts`)

`rooms: Map<pub, Room>` + `activePub`. A message must not **yank the view**: an
incoming conversation opens **in the background** (the handshake must complete)
and lights an unread pill.

- Each room keeps a replayable `log: Ev[]`; `record(room, ev)` renders now if
  on screen, else bumps `unseen`. **Switching is not a rebuild**: `activateRoom`
  replays the log; no conversation is ever torn down to show another
  (`openRoomFor` returns immediately for an existing room).
- **`syncPresence` excludes only the ON-SCREEN room**; every other contact keeps
  a light watch that SHARES the room's pair topic. The transports do not count
  holders, so a watch must never unsubscribe a topic an open room holds: core
  tracks `roomTopics` and passes `keep` to every watch (a rotating watch once
  unsubscribed yesterday's topic from under a background room — deaf with a
  green dot).
- Pinned by `browser-test` "an incoming message opens in the background, not in
  your face" and "returning to a mobile room does not tear it down".

### Compact layout (phones, and phones on their side)

`@media (max-width:900px), (max-height:560px)` — narrow **or** short gets one
pane at a time (`.chat-open` on `#app`, back arrow). Width alone missed a phone
in landscape (852×393).

- **`#btn-back{display:none}` must stay ABOVE the media query** — same
  specificity, so source order decides. Broken twice.
- **Equal specificity again: `.avatar-cluster.sm .ga`** re-adds the margin the
  `:first-child` reset removed. A variant rule after a reset of the same weight
  needs the reset repeated.
- **`--app-h` has never been set**: `trackViewport` was never called, so the app
  is `100dvh`. Android handles the keyboard natively (`adjustResize` + IME inset,
  `src-tauri/android/patch.mjs`). Turning it on changes iPhone Safari — decide
  with a device in hand.
- **"Short screen" means short AND wide** (`max-height:560px and
  min-aspect-ratio:3/2`); a portrait phone with the keyboard up is ~390x350.
- **No `min-height` on phones** — it pushes the composer off screen.
- `@media (pointer:coarse)`: finger-sized targets, 16px inputs (iOS zoom).
- **Back (Android key/gesture, packaged or in Chrome)** closes what is on top
  and leaves only when nothing is: while something can be closed, ONE history
  entry of ours exists (`backTarget` / `syncBack` in `app.ts`, kept in step by a
  MutationObserver). Tauri's AppPlugin walks the webview history when no JS
  listens, so without the entry Back leaves the app. A new closable surface
  goes into `backTarget` in stacking order. browser-test "Back on a phone…".
- **A bubble's controls are revealed by PRESSING it**, mouse and finger alike
  (`attachReveal`, `.tapped`): a drag that selects text is left alone, one bubble
  open at a time, file/voice bubbles use the same helper. The emoji picker is
  one popover (`#emoji-pop`) anchored to the BUTTON, never to the pointer (a
  synthetic click reports 0,0).

Pinned by `browser-test` "phone layout" (both orientations) and
`node net/phone-shot.ts <dir>` — a layout bug is a visual fact; computed-style
asserts miss clipping. **After a markup change, screenshot the neighbour AFTER
the insertion point too** — an unclosed `<div>` once hid all of Settings while
the changed modal looked perfect.

### Delivery contract — acks, backoff, ⚠

**Nothing under us retransmits.** `msg`/`file` carry an `id`, the receiver
answers `ack`, an unconfirmed message is re-sent at **1.5 s, 4 s, 8 s, 15 s,
15 s, capped at 60 s** — the budget runs only while the peer is announcing.

- **A peer that is ANNOUNCING owes a confirmation** whatever is wrong underneath
  (e.g. stuck before msg3): presence is the whole condition for ⚠.
  `test/room-eh2.test.ts` "a peer that is present but never handshakes".
- **Sending into an EMPTY room** parks the message (`parked`), marks ⚠ with
  "↻ Ponów" at once, and re-sends it oldest-first when a session is established
  or `flushPending` runs; a late ack turns it ✓.
- **Running out of budget keeps the bytes** (`resendable`); `conversation.resend(id)`
  re-sends under the **same id**.
- **A backlog leaves in the order it was written** (`pending` is a Map); each
  re-send gets a full budget; `sentAt` stays honest.
- **Two silences told apart:** `onLink` reports OUR transport
  (`online`/`reconnecting`/`offline`) — two heartbeats in a row reaching zero
  peers means isolated whatever `getConnections()` claims (`onIsolated` → re-dial
  with backoff); the room reports a peer `quiet` after 37.5 s without an Announce
  (2.5 heartbeats, floor 35 s),
  `leave` at 90 s.
- **Signalling retries**: the offering side (lower PeerId) re-offers after 10 s
  without a proven channel, three attempts. `test/webrtc-plane.test.ts`
  (`makeLink`).
- **The first unconfirmed re-send demotes the direct path — only if content is
  riding it** (`onStall` → `plane.demote()`). A channel is trusted only after a
  `0x00`-prefixed ping/pong round trip; `onopen` alone has lied.

### WebRTC direct data plane (P1)

Content moves to a DataChannel when two peers are in the room; GossipSub carries
presence + encrypted signalling (`t:'rtc'`) and is the fallback. `net/webrtc.ts`
(`webrtcLink`), `net/webrtc-plane.ts` (`attachWebRTC`, lower PeerId initiates).
**Relay is the default; direct is opt-in** (Settings → transport,
`TRANSPORT_KEY`, the user's call 2026-09-03): direct fails asymmetrically where
it fails, and with it off the peer learns no address and no STUN server is asked.

- **Linux desktop: the DataChannel lives in the host** (`src-tauri/src/rtc.rs`,
  webrtc-rs, behind `makeLink`) because WebKitGTK ships without
  `RTCPeerConnection`. webrtc-rs does not announce `a=max-message-size`, so the
  peer assumes 65536 — DataChannel messages stay ≤ 65536. Windows (WebView2) and
  macOS (WKWebView) have WebRTC natively (measured 2026-09-14).
- ⚠️ `browser-test` is the only cover of the direct plane (Node has no
  `RTCPeerConnection`) and seeds `ec-transport=auto` for both browsers; drop that
  line and the WebRTC scenarios pass by negotiating nothing.
- STUN is ours (Deploy, below). The relay-blind plane is parked (Directions; not in SPEC).

### EH-2 + Double Ratchet — `impl/eh2/`

| file | what |
|---|---|
| `eh2/wire.ts` | canonical msg1/2/3 + the `h1` / `h2_partial` / `h3` transcript |
| `eh2/handshake.ts` | the two state machines, `ikm` in responder perspective, `SK`, `mac_r`/`mac_i`, `initiator_tag` |
| `eh2/mlkem.ts` | ML-KEM-768 (`@noble/post-quantum`) |
| `eh2/ratchet.ts` | the ratchet: DH step, chains, HKDF nonces, header as AAD, bounded skipped keys |
| `eh2/establish.ts` | drives the frames, picks the engine (`setCoreBackend`), falls back |
| `eh2/wasm.ts` / `eh2/native.ts` | the same contracts over core-rs in WASM / in the Tauri host |
| `lib/x25519.ts` | X25519 as a `Dh` capability — a local ephemeral or the HEM's IK |

- **Serialization must stay canonical** — `h1` hashes `serialize(msg1)`.
- **One HSM call per side**; `Dh` hides which DH is the IK.
- **`decrypt` is transactional** — state advances only after the AEAD verifies
  (a forged frame once burned the chain key, a forged `dh_pub` the root key).
- **The ratchet serialises its own calls** (a promise chain in `ratchetFrom`).
  Two same-tick calls derive from the same chain key and desync the pair
  permanently — "messages stop arriving" with a green badge. The room sends
  without awaiting, so this is a real race. `test/eh2-ratchet.test.ts` pins it.
- **The msg3 gate is structural**: the responder's `Session` does not exist
  until `mac_i` verifies.
- **The session lifetime** (§7.3): a fresh EH-2 after a randomised 4–8 h; the
  replaced ratchet is kept 60 s for frames in flight.
- **Handshake frames get dropped — that is normal.** Three mechanisms, remove
  any and it hangs like broken crypto: the opening frame is re-sent; a silent
  attempt times out and retries; after a failure either side may initiate. A
  msg1 restarts a responder that holds a session; the session is replaced only
  once msg3 verifies. The room announces as soon as `getSubscribers(topic)` is
  non-empty.
- **KATs** (`docs/kat/`, `scripts/export-kat.mjs`) — re-record deliberately.
- EH-2 is the only content scheme, both front-ends, no opt-out.

### Two windows, one identity (§9.1, `lib/selfsession.ts`)

A second tab of the same identity derives the same pair topic and a valid
Announce. **`initiator_tag`** (`HMAC(k_tag, IK_i)` in msg1, SPEC §6.1) is the
conclusive check: the responder tests it against the contact and against its
OWN IK, which names a second window outright → that peer is ignored 5 min.
Removing the hint altogether was tried and reverted (the real contact got
re-keyed every few seconds). **Never use a failed MAC for this** — crossed
honest handshakes fail `mac_i` routinely.

- The retry escalation slows down, never stops (`room-sim`'s 35% loss needs it).
- `retireOtherPeers` retires only a PeerId that stopped announcing.
- The badge shows the best state, not the last event.
- **The self-topic** (`ss = ECDH(IK, IK_pub)`): anything valid on it is another
  window of us. **Both duplicates stand down** (the user's call, fail-closed);
  a reload is unaffected. The window that steps down publishes one last
  Announce. The mechanism diverges from a literal §9.1 reading (Announce carries
  send time, not session start) — if the spec reopens, add `since`. Best effort:
  no self-ECDH → no rule.
- Every client holds pair topics + a self topic on the relay.

### Presence and rotation — `lib/presence.ts`

Being visible must not cost a handshake: each contact gets a light
`watchPresence` on the **pair topic** (subscribe + Announce heartbeat → a green
dot). The pair topic, not a shared presence topic, is a deliberate security
choice — a shared one would leak the presence graph.

- **Upgrade on send, either side**: the watch hears a handshake frame →
  `onWantsConversation` → the app opens the room, which replays the frame.
  `maybeHandshake` always initiates (a presence peer is passive). **Handoff, not
  teardown**: `session.open` calls the watch's `stop(false)` and keeps the warm
  mesh. Early beacons `[1s, 3s, 7s]`.
- **Per-pair rotation instant (§5.4)**: `offset = rotationOffsetSec(ss)`,
  date-independent, cached per contact; `rendezvousDay(now, offset) =
  utcDate(now − offset)`; around the instant two days are active. A room held
  across a rotation is MOVED in place once nobody is left on the old topic or
  the contact handshakes on the new day (`room.retarget`, core `realign`);
  `net/rotation-pin-test.ts` pins it. An incoming handshake carries its day and
  `session.open` opens on that day.
- `?rot=<hour>` forces every pair's instant for testing.
- Tests: `test/presence.test.ts`, `test/presence-rotation.test.ts`, live
  `npm run presence-test`.

### core-rs — the Rust core, as WASM and natively

`/core-rs` implements SPEC §6–§7 (wire, handshake, ratchet with the hybrid
step) and §8's sender-key chain with RustCrypto. `cargo test` in `core-rs/`
reproduces `docs/kat/eh2-handshake-mlkem.json`, `ratchet-hybrid.json`,
`group-senderkey.json` and `group-keys.json` byte for byte
(`eh2-handshake-classical` and `invite-knock` have only TS consumers).
`core-rs/build.sh` builds **`impl/core-wasm/core.wasm` (COMMITTED)**.

- **Engines:** WASM is the default since 0.7.21; the Tauri shells run the same
  crate natively (`src-tauri/src/core_native.rs`, `eh2/native.ts`) since
  0.7.31. `?core=ts` / `--core ts` select the TS engine; a platform that cannot
  load an engine falls back by itself and says so (`coreStatus`,
  `onCoreFallback`). `test/eh2-wasm.test.ts` pins TS<->WASM interop.
- **`senderkey.rs` is not wired**: no FFI export, no native command — group
  chains and `group_secret` live in JS in every engine. Say so wherever a doc
  implies otherwise.
- **The module is a committed artifact; CI rebuilds it and checks it WORKS**
  (`ci.yml`, job `core-rs`: Rust KATs + TS<->WASM interop on the rebuilt
  module). It does NOT byte-compare — an ~18-byte toolchain residue remains
  across machines despite `--remap-path-prefix`. User-facing reproducibility is
  the web bundle CID (`docs/REPRODUCIBLE.md`). After any change under
  `core-rs/src`: `./core-rs/build.sh` (never plain `cargo build`) and commit.
- **Tauri 2 renames command arguments to camelCase.** Every `core_native.rs`
  command carries `#[tauri::command(rename_all = "snake_case")]`; without it
  (0.7.27–0.7.30) every shell silently ran on WASM. `test/native-ipc.test.ts`
  drives the real `native.ts` through Tauri's real dispatch
  (`src-tauri/examples/core-ipc.rs`, mock runtime) and is in the release gate;
  a new host command gets the attribute and a case there.
- **Tauri IPC on Linux is postMessage**: a raw invoke body arrives as a JSON
  array — never raw bodies.
- **CSP needs `'wasm-unsafe-eval'`** in `script-src`, or instantiation fails
  with a CompileError that reads like a broken file.
- **No wasm-bindgen.** Flat C ABI (`core-rs/src/ffi.rs`): `ec_alloc`/`ec_free`,
  one per-call output buffer, negative return + `ec_err_*`, handles for state;
  the host supplies randomness and the IK's one DH. Re-create memory views after
  every call.
- **A KAT with an injected KEM runs the TS path** whatever the switch.
- **What WASM buys, honestly:** keys out of the JS heap and zeroed
  deterministically — not a boundary against a compromised page. The native
  engine is.

### Groups — Sender Keys, all-ECDH (§8, `GROUPS-DESIGN.md`)

Built, wired into web and CLI, tested live with five people (0.7.0). A group is
a software layer over the 1:1 mesh: Sender Keys for content, authenticated by
**per-recipient ECDH-HMAC instead of a signature** (deniable, all-ECDH).

- `lib/senderkey.ts` — one member's chain; transactional skipped keys.
- `lib/group.ts` — `GroupSession` / `GroupManager`: `receive` verifies OUR MAC
  **before** decrypting (the insider-forge property); `rekey` on membership
  change → epoch++, new `group_secret` + topic; the removed member is locked out.
- `lib/grouproom.ts` — the topic (GossipSub through the relay, not WebRTC).
- `group-skd` / `group-skd-req` ride the 1:1 ratchet; keepalive `0x21` keeps the
  mesh from pruning an idle group.

**The one-way silence (§8 repair).** A sender key is handed out once, over a 1:1
that may not be up; a lost SKD makes one member deaf to one sender for the
epoch, with nothing failing. What holds it:

- Failed distributions queue in `pendingSkd`; the admin's owed invitations are
  sealed in the group's §10 blob (`OwedInvites`, `web/src/groupview.ts`),
  re-sent after restore, when the member's dot lights, and at 10/30/90 s
  (`chaseOwed`); the receipt is the member's own `group-skd`. A member's own key
  goes twice more after joining or a new epoch (`redistributeOwn`).
- `onGroupInvite` ignores an SKD from an older epoch (a removed member keeps
  re-sending its old one).
- **The receiver asks only after OUR MAC verifies** (`onNeedSenderKey`) — the
  group topic is public. One ask per member per 30 s; MAC-verified frames are
  **held** (32 per sender, 2 min) and re-run through `receive` when the key
  lands; for 30 s on a new topic each frame is published again at +2 s and +6 s.
  The responder **re-checks the roster** before answering.
- **`SkdFields.ctr`** — the counter the chain is at; `setSenderKey` refuses a
  lower `ctr` than it holds, and a late copy only opens HELD frames through a
  throwaway receiver.
- The UI action is "re-send my sender key", not "reset the group" — a rekey can
  drop a healthy offline member.
- A member outside my contacts is named by fingerprint and offered "add".

**The HEM marker (`lib/gmarker.ts`) must stay 1:1 with SPEC §8.6.**
`ETSEIC:chan1:<ownerHint>:<adminHint>:<name>:<roster b64url>` (admin) / empty
roster (member), on the `GK_pub` entry. `parseMarker` reads only `chan1`; no
`group_id` (derivable from the entry); hints are 4 bytes and only SELECT a
candidate — the `rk_i` MAC decides; field order is priority order (the roster
blob is dropped whole). `ownerHint` exists because members write markers too.
`writeMemberMarker` returns false, never throws, when the device refuses a
duplicate key. Recovery: `restoreGroups` → `recoverGroupsFromDevice` →
`group-skd-req`; the 45 s timeout must **not** assert removal. **No HEM path is
covered by an automated test**; two-identity walkthroughs are by hand.

### Test harnesses

| command | what it exercises |
|---|---|
| `npm test` | unit + offline integration over a mock pubsub (`test/*.test.ts`) |
| `npm run room-sim` | seeded synthetic network: loss, duplication, reorder, staggered joins |
| `npm run gui-sim` | the `core.ts` facade the GUI drives, as a timeline |
| `npm run eh2-test` / `meet` / `presence-test` / `group-test` / `hem-gk-test` / `ipfs-test` | live against the real relay (and a real HEM / the IPFS store) |
| `npm run browser-test` | two headless Chromium, the real bundle and relay, driven through the DOM |
| `npm run browser-test:ff` | the same with Chromium + Firefox (WebDriver BiDi) |
| `npm run phone-shot` | screenshots at real device metrics |
| `npm run crypto-bench` | engine-cost numbers for `performance.md` |
| `npm run relay-load` / `-saturate` / `-flood` / `-hsrate` / `-chatload` | load/DoS toolkit |
| `net/cli-*-test.ts` | CLI ↔ CLI scenarios |
| `node net/stun-probe.ts <host> [--bad]` | our STUN, and that it ignores everything else |

`browser-test` switches: `GROUP_ONLY=1`, `FAILOVER=1`, `RELAY_NODE=<full
multiaddr>` (a bare hostname looks like a dead relay), `RELAY_A`/`RELAY_B`,
`IPFS_RPC` (without it the file scenarios do not run — use the local Kubo stub),
`APP_URL`, `HEADFUL`, `SHOT`/`SHOT_DIR`, `CORE=ts`/`CORE_B=ts`, and the
transport: the light client by default, `GOSSIP_B=1` / `GOSSIP=1` for full
GossipSub. Firefox's profile must sit where a snap can see it
(`~/snap/firefox/common/…`).

- **Storage names say nothing** (`lib/storenames.ts`): every per-identity
  record is `ec-<idTag>-<tag>`, HMACs under `nk`. Code that stores per-identity
  state takes a `Names` (`names.fixed.book`, `await names.scoped('group', gid)`)
  and never builds a name from the KID; group ids come from `names.groups(kv)`.
  The page exposes `window.__storeNames`; the harness checks no name carries a
  KID, contact key or group id.
- **A change to a storage key or the login flow breaks the harness** — change
  both in the same commit (the harness seeds and reads storage directly).
- **Pins** (`lib/pincache.ts`, `names.scoped('pin', roomId)`): read once per
  page-load per room; the 33rd is refused, not evicted; files are not pinnable;
  a restored pin carries no delivery state and no reactions.
- **The seal password floor is the full meter** (`lib/passmeter.ts`
  `ENFORCE_MIN = 3`): enforced at profile creation and password change, never at
  sign-in or `mig-pass`. `SOFT_PASS` in both harnesses must clear it
  (`test/passmeter.test.ts`).
- **A test that depends on an ORDER needs a margin**, not a plausible number —
  `node --test` runs files in parallel and a loaded loop stalls longer than
  you think. Use `until(what, cond)`, not sleeps.
- **Prove a test can fail**: unit tests get a positive and a negative case; a
  harness scenario is proven once by breaking the code.
- **Never pipe `browser-test` through `tail`** — redirect to a file. Watch
  leaked browsers (`pgrep -f chrome`, `free -m`).

## Deploy (onchato.com)

Pieces: the **relays** (bs1 on the web host, bs2 and bs3 on their own VMs,
every-to-every mesh on 9002; the compiled-in list is `infra/nodes.json`,
refreshable by CID), the **web app**, the **IPFS file store** (separate host,
`infra/README.md`), and the **tag-driven auto-deploy**. The model is PULL: the
host builds, nothing is uploaded, no production credential sits in a CI runner.
Clone: **`/opt/github/encedo-chat`**.

**The release ritual:**

```bash
# locally: bump the version (package.json, package-lock.json, tauri.conf.json,
# Cargo.toml, Cargo.lock) in its own commit, then
git push && git tag v0.X.Y && git push --tags
```

The tag triggers `desktop.yml` (five desktop targets → **draft** release — the
draft is the updater's publish gate; signing waits for approval in the `release`
environment) and `android.yml`, and the host's timer (`infra/onchato-deploy.timer`
→ `deploy-on-tag.sh`) rebuilds the web — ⚠️ a tag BEHIND the tip is never seen;
tag the commit you want live. Logs: `journalctl -t onchato-deploy`.

**Every release ends with the operator's approval of the web build:**

```bash
node scripts/approve-web.mjs --host onchato vX.Y.Z     # builds the tag, 3 CIDs must agree, PIN + touch, uploads, checks
```

It re-signs the release manifest with the new `web` entry, version, commit and
dates — so every web approval also renews the 120-day expiry — and refuses to
change the node list or the updater key.
Host config: `~/.config/onchato-ops/hosts/onchato.json`. Until it runs, the
hourly web monitor reports PENDING. `--dry-run` checks without the token.

**The manifest's other fields** (node list CID, CI updater key) are changed with
`release-manifest.mjs`, from the TAGGED checkout that carries them, and then
the same tag is approved:

```bash
node scripts/release-manifest.mjs --sign-yubikey --out /tmp/rel      # PIN + touch
node scripts/release-manifest.mjs --verify /tmp/rel
scp /tmp/rel/manifest.json /tmp/rel/manifest.sig bs1.onchato.com:/var/lib/onchato/release/
node scripts/approve-web.mjs --host onchato vX.Y.Z                   # puts the web entry back
```

⚠️ **`release-manifest.mjs` writes from scratch: without `--with-web` there is no
`web` entry**, so uploading it alone un-approves the live web build (monitor:
PENDING). `approve-web.mjs` refuses a tag whose node list or updater key is not
the signed one — hence manifest first, approval second (`relay/DEPLOY.md` step 9).

The root key lives in the user's YubiKey (PIV 9c, Ed25519), on no machine that
builds; `infra/root.pub` is compiled into every client. **TRAP: the desktop
updater refuses any update unless the manifest names the updater key the build
trusts and has not expired** — rotating the minisign key means re-signing the
manifest FIRST.

**The relay is NOT restarted by the timer** — by hand, when relay code changed:

```bash
cd /opt/github/encedo-chat && git pull && cd relay && npm ci
sudo systemctl restart onchato-relay
journalctl -u onchato-relay -n 12 --no-pager
```

Among the startup lines, four prove the config: the PeerId (**must** stay
`12D3KooWP6Sp…cDmp`), the port, `Tematy: limit …` and `Połączenia:` (proves
`--max-connections`). If the log looks
like the previous build: `git log --oneline -1`, `grep -c "max-topics"
relay/relay.mjs`, `systemctl show onchato-relay -p ExecMainStartTimestamp`,
`systemctl cat onchato-relay | grep -E 'WorkingDirectory|ExecStart'`. **After
every relay deploy run the full `browser-test`.**

**Web by hand** (when the timer cannot wait):

```bash
cd /opt/github/encedo-chat && git pull
git submodule update --init --recursive     # hem-sdk-js
cd impl && npm run web:deploy               # → impl/web/dist (what nginx serves)
```

`web:deploy` runs `npm ci` only when `package-lock.json` changed; the webpack
cache is `impl/.webpack-cache` (outside `node_modules` on purpose). Verify with
`curl -s https://app.onchato.com/ | grep -o 'app\.[a-z0-9]*\.bundle\.js'` — or
grep the bundle's own `v<version> (<commit>)` stamp.

**The app has its own origin: `https://app.onchato.com/`** (since 0.6.47;
`onchato.com/chat` is a 301 keeping `#i=`). Browser storage shares its origin
with nothing — not the landing, not `/f`. `/f` and `/feedback` stay on
`onchato.com`; the app calls them cross-origin (`SITE_ORIGIN`; CORS + CORP are
load-bearing under COEP `require-corp`). Old invite links are `LEGACY_PATH`.
Moving the origin wipes every browser's local state — never casually.

**nginx** is versioned at `infra/nginx/onchato.com`; the procedure and its traps
(on bs1 the served file is a plain one in `sites-enabled`; backups never inside
`sites-enabled`; a changed limit-zone key needs restart, not reload) are in
`infra/nginx/README.md`. It carries the `/relay` per-IP limits (libp2p's own are
off), the `/f` and `/feedback` blocks.

**STUN is ours** (`infra/stun/stun.mjs`, `onchato-stun` on every node; the
user's call: no third party learns the IP and timing of every attempt). The
client holds no STUN list: `lib/ice.ts` derives `stun:<host>:3478` from the
nodes it dials. Not coturn on purpose (TURN is one line from an open relay; no
TURN, decided). **3478/udp is the only port not behind nginx** — easy to forget
in `ufw`. Check a node with `node impl/net/stun-probe.ts <host> --bad`.

**Upload prefixer** (`infra/fput/`): `POST /f` goes to `onchato-fput`
(127.0.0.1:9202), which prepends eight bytes to every upload, so the store never
hands back a byte-identical file and an uploaded page is not served as HTML. It
owns the sweeper ledger name (`/ec/<epoch-seconds>-<unique>` — any other shape
**never expires**), `pin=false` and the neutral `User-Agent`. Install once,
restart by hand.

**Feedback sink** (`infra/feedback/`): `POST /feedback` → `feedback.mjs`
(127.0.0.1:9201), JSONL in `/var/lib/onchato/feedback.jsonl`. nginx sends **no**
client address to it — the form promises that. Install once, restart by hand.

**Android grants a WebView permission by AND.** wry asks for every permission of
a request in one call and grants only if all are true; one undeclared entry
(MODIFY_AUDIO_SETTINGS for the microphone) is a silent false. Both are in
`PERMISSIONS` (`src-tauri/android/patch.mjs`), pinned by
`test/android-patch.test.ts`. In a packaged build, "the platform cannot" usually
means "the host did not answer" — check the host side first.

**Key material in the console is a BUILD decision.** `?debug=1` narrates with
values elided; `?keys=1` prints secrets. `EC_ALLOW_KEYS=0 npm run web:deploy`
compiles the capability out (`__EC_ALLOW_KEYS__`).

**When rooms don't work, check the relay first.** A stale relay silently refused
new topics; and GossipSub graylisted everyone by IP colocation because behind
nginx every client is `127.0.0.1` — scoring now has `IPColocationFactorWeight: 0`
(`impl/net/relay-colocation-test.ts`). The question is "does the relay act on our
subscription": `pubsub.getSubscribers(topic)` on the client, `[+topic]` in the
relay log. A missing log line means the deploy is unverified, not that the
feature is missing.

## Directions

- **Relay-blind data plane (`ARCHITECTURE.md` Transport, `RATIONALE.md`) — parked, blocked on the libp2p ecosystem.** The
  relay supports circuit-relay-v2 (reservations + HOP CONNECT verified live,
  `net/circuit-probe.ts`, `net/circuit-two.ts`), but on the pinned libp2p 2.2.x
  the destination-side STOP handling is broken, and v3 is blocked because
  `@chainsafe/libp2p-gossipsub` is still on `@libp2p/interface ^2`. Revisit when
  gossipsub ships a v3 release. The direct (P1) plane is built.
- **Remaining UI placeholders:** the P1–P3 profile presets — they wait on the
  relay-blind plane.
- **Several identities in one HEM — built** (SPEC §4.2: identity records,
  contacts scoped by owner KID, sign-in picker sorted by handle with a short KID
  beside it).
- **Newer HEM firmware** — the seam above, and `api/search` with public keys.

## Status

- Protocol spec 3.0 (`docs/SPEC.md`, 2026-10-13) describes the shipped code and
  is with the external cryptographer (review tag `review-2026-10-14`).
- EH-2 + Double Ratchet is the only content crypto; engines: WASM (default),
  native in the shells, TS as fallback.
- Groups, files + voice notes over IPFS (§7.5), notifications
  (`lib/notify.ts`), the sealed contact book and storage names (§4.4, §10),
  profile export/import (`lib/migrate.ts`), software profiles (§4.5), the CLI +
  Docker image, the Tauri desktop (Linux, Windows signed, macOS) + Android + iOS
  shells with updater — shipped.
- Known follow-ups: skipped-key persistence across restarts; the light client's
  stage 3 after battery measurements; storage migrations from 0.7.34 come out in
  0.8.0 (moved from 0.7.40, the user's call 2026-10-16).
- The tree is normally clean at a tag; the release ritual is in Deploy above.
