# v6 — Architecture

Status: **design of record for a shipping product** (onchato 0.7.x: web at `app.onchato.com`, desktop, Android, and a terminal client — one engine in `impl/`). Sections marked **TBD** or **roadmap** are not built; everything else describes what runs. Earlier concept-phase drafts are in git.

## Document map

| Document | Role |
|---|---|
| `PROTOCOL.md` | **The single source of truth for the protocol and all cryptography** — identity, rendezvous, EH-2, ratchet, groups, session management, transport mapping, security analysis (weakness register S1–S14), metadata analysis, PQ roadmap, implementation map (§17), archived HEM platform notes (§19), and **flow diagrams** (§20, Mermaid — rendered natively by GitHub). Absorbed the former `encedo-chat` spec and `onchato` notes, which have been removed. |
| this file | Product & infrastructure layer: goals, network roles, node operations, transport modes, distribution, modularity/UI, threat-profile presets |
| `THREAT-MODELS.md` | Deployment profiles P1–P3 mapped onto the protocol's threat model (`PROTOCOL.md` §2.2, §11.3 S1–S14) |

## What is promised, what is measured, what is roadmap

| Claim | Shipped and measured | Roadmap |
|---|---|---|
| HSM-anchored identity | the IK never leaves the HEM; every new session, topic and Announce needs a device call; a stolen unlocked client lives at most one lifetime (4–8 h) | HKDF inside the HSM (closes S13); enrollment by attestation |
| PQ confidentiality | EH-2 is X25519 + ML-KEM-768; TLS to the HEM is X25519MLKEM768; recorded traffic needs both broken | — |
| PQ post-compromise security | the hybrid ratchet: every fourth DH step, or every 30 minutes, mixes an ML-KEM-768 secret into the root (`PROTOCOL.md` §7.2) | — |
| Hardened tier | none: keys and ratchet state live in the webview on every platform (S1, S5) | Rust core, WASM first, then native |
| Relay-blind plane | none: the node sees every client's address; direct is peer-to-peer and opt-in | circuit-relay-v2 streams, blocked on libp2p v3 |
| Offline root key | a manifest signed by an Ed25519 key in the operator's YubiKey names the node list's CID and the CI updater key, with an expiry; every client carries the public half, and a node-list refresh is refused without it | the desktop updater verifying the manifest before it installs, which is when the bundle's CID joins the manifest and signing becomes per release |
| Reproducible chain | the bundle is reproducible (measured, `scripts/release-cid.mjs`) | tag → source CID → binary, verified in CI per release |
| Enrollment | out-of-band: QR, link, safety number; published invites | attestation-gated enrollment into a tenant directory |

## Product definition

Instant-only P2P chat — the IRC / "meet in the park" model:

- Both parties are online during the conversation. **No offline messages, no mailbox, no network-side delivery receipts, no push notifications, no server-side history.** (In a 1:1 the receiving *client* acknowledges each message to its sender — `PROTOCOL.md` §7.3 — which is a liveness contract between two endpoints, not a receipt kept by anybody; groups have none. The CLI daemon may queue text on its own disk for a contact who is offline — §13 — the network still holds nothing.) A conversation is arranged (out of band or by standing agreement) and happens in a deterministic, crypto-derived room.
- Ephemerality is a security feature: nodes store nothing, so there is nothing to seize, subpoena, or leak.

### Goals

1. **Resilient to infrastructure failure** — any single discovery node is sufficient; anyone can run their own network.
2. **Resistant to takedown** — multi-jurisdiction nodes, signed distribution over multiple channels, installed app independent of any domain.
3. **Pseudonymity, and zero content or history at the node** — honest scope: rotating identifiers by default, so the node cannot name anyone; node-only transport for IP privacy from the peer (shipped as the default setting); a relay-blind plane for IP privacy from the node (parked). What the node does see, stated plainly: a conversation as a pair of connections holding one topic, how many topics each connection holds, and the rhythm of its Announces (`PROTOCOL.md` §12). Full anonymity against a global observer (mixnet-class) is explicitly out of scope.
4. **E2E security** — content readable only by endpoints; long-term keys in HSM (Encedo HEM).

Positioning: dual-use secure messenger (private, commercial, military / critical-infrastructure deployments). Threat profiles in `THREAT-MODELS.md` map to configuration presets of one product.

**One core, two go-to-market channels** (decided 2026-07-23): the same protocol core ships as (a) **Encedo Chat** — enterprise/tenant deployments (EPA HSM, OIDC, DORA/NIS2 compliance framing) and (b) **onchato** — the open public network (self-hosting, community UIs, takedown resistance). Enterprise is the protocol's native audience and maps to a P3-style preset with EPA/OIDC; the open network runs P1/P2 presets. Neither is "the real product" — both are configurations of one codebase.

## Network roles

### Discovery nodes (operator-run; three in production, bs1 + bs2 + bs3)

- Plain libp2p nodes: GossipSub + circuit-relay-v2 reservations behind nginx (WSS on 443), interconnected over a direct IPv6 mesh (public IPv4 between the nodes is blocked). bs3 (a second jurisdiction) has been live since 2026-09-03; `relay/README.md` is the operational manual.
- **Role: discovery + signaling + the ciphertext fallback content path.** Since 0.6.24 a client is a **light client** by default: one stream to its node, `/onchato/pick/1` (PICK/DROP a topic, PUSH bytes, DELIVER back — `PROTOCOL.md` §12/§13), and GossipSub runs between the nodes only; `?light=0` makes a client a full GossipSub peer again. What the node carries for a client: rendezvous, handshake frames, and — where the direct plane is not in use, for groups always — sealed content as opaque bytes. The node never sees plaintext or keys.
- **Policy at the edge (since 0.7.4):** nginx answers every onchato path, and the STUN responder stays silent, for addresses geolocated in sanctioned countries (HTTP 451 — the list is `infra/geoip/`, built weekly from DB-IP Country Lite), and drops connections from an operator-kept **abuse list** of addresses, networks and ASNs (444; the list lives outside the repo and is pushed to the nodes with `infra/geoip/onchato-block`). The client probes `/health` on up to three nodes and turns a 451 into "not available in your region" (`lib/regioncheck.ts`). This is an operator decision about who the main network serves, not a protocol property: a self-hosted network carries none of it.
- Stateless beyond their identity key. A Docker image of the **node** for one-command self-hosting is **roadmap**; today the recipe is `relay/README.md` (clone → `npm ci` → systemd). (The `Dockerfile` at the repo root is the **CLI** image, not the node's.)
- Node identity: deterministic from the `--pass` seed — the pass is the hostname by convention, so a node's PeerId (and the multiaddr clients will carry) is derivable on a laptop before the machine exists.
- Topic management: a large limit + **TTL eviction** (a topic with no traffic for `--idle-ttl` is dropped; heartbeats keep live rooms perpetually fresh) — per-pair daily rooms mean many short-lived topics.
- Two operational lessons that are now configuration, not choice (`relay/README.md`): GossipSub's IP-colocation scoring is **off** (behind the proxy every client arrives from loopback — the penalty graylisted the whole user base), and libp2p's per-host inbound limits are raised, replaced by per-real-IP `limit_conn`/`limit_req` at nginx.
- **Load announcements:** each node publishes `{ v, n, pct, at }` on a constant topic shaped like a room topic (so it is not a marker), `pct = max(connections/limit, topics/limit)`; a node replays the others' latest to a client as it joins. That is what the client's node choice below reads.
- **What a node records** (`PROTOCOL.md` §12): refusals; topics joined and evicted, with the full topic id; connections opened and closed, with a truncated PeerId; a per-message journal line (truncated topic, sender prefix, byte count) only behind a flag the production nodes leave off; aggregate per-window counters (messages, bytes, topics, connections, distinct sender prefixes, CPU, memory) kept in Redis for 30 days; a JSON metrics endpoint on loopback, read over SSH; nginx's access log with the real address, which nginx also hands to the relay process as `X-Real-IP` — read only in the full-trace `DUMP` mode, which exists for debugging and never runs on a production node. Nothing per user, nothing of content.

#### What the production nodes run, and what each switch buys

The relay is one process with everything optional off by default; a node is turned into a production node by its systemd unit (`relay/onchato-relay.service`), which is the one place the numbers live. The three nodes run, in effect:

```
node relay.mjs --port 9001 --pass <node>.onchato.com --host <node>.onchato.com
  --peers <the other two> --v6-port 9002 --v6-host <public IPv6> --siblings <the other two>
  --local-topics-only --leaf-announce --pick --announce-load
  --max-connections 400 --max-topics 1600 --max-topics-per-peer 150
  --stats 15 --quiet-msgs --stats-redis redis://127.0.0.1:6379 --stats-node <node> --stats-ttl-days 30
  --metrics-port 9003
```

| Switch | What it buys |
|---|---|
| listen on `127.0.0.1` (the default) | only nginx reaches the WebSocket port; the per-IP limits in front of it cannot be walked around with a direct connection |
| `--v6-port` / `--siblings` | the inter-node mesh runs over the provider's IPv6 network on its own port; *siblings* are the peers whose subscriptions count as routing, so a client (every one of which arrives from loopback) cannot be mistaken for a node |
| `--local-topics-only` | a node carries only the topics its own clients hold, not the whole network's — an observer that dials one node sees one node's share (`PROTOCOL.md` §12) |
| `--leaf-announce` | a client is told only about the topics it holds; a sibling is told everything. Without it every connection received the node's whole topic list (hundreds of kilobytes, a storm on restart) |
| `--pick` | the light client's stream (`PROTOCOL.md` §13.2) — the default transport since 0.6.24 |
| `--announce-load` | the node publishes its load for the clients' node choice; a node without it listens and replays, but says nothing about itself |
| `--max-connections`, `--max-topics`, `--max-topics-per-peer` | the ceilings. Sized from measurement: a topic costs ~28 kB and a client holds about four, so topics ≈ 4 × connections; the per-peer quota stops one socket from claiming the whole node (its refusal is silent to a GossipSub peer, said to a light client) |
| `--stats 15 --quiet-msgs` | one counters line per fifteen minutes instead of a line per frame (~50 000 a day on a node) |
| `--stats-redis …`, `--metrics-port 9003` | the same counters into Redis for 30 days, and the live JSON on loopback for the operator's dashboard |

Beside the flags, three things run that a reader of the protocol would not guess: a **mesh watchdog** — a sibling that stays silent for 3.5 announcement rounds (105 s) while connected has a dead stream, and the node closes that connection so the mesh re-forms (the one cure for a stream that is open and carries nothing); a **health push** every minute from each node to the operator's uptime monitor, proving the relay process rather than nginx is alive (the push URL is a token kept outside the repo); and a **dashboard** on the operator's machine that reads the loopback metrics, Redis and the feedback file over SSH. None of these touches a frame.

### Third-party nodes and networks

- **Independent network**: first-class by construction — a network id is mixed into every topic derivation, so two networks never collide even if their nodes accidentally connect. The app compiles it in (`EC_NETWORK` at build time, `main` by default) and the terminal client takes `--network`; an independent network is therefore a build of the app with its own id and its own node list — there is no flag on an installed app, by design — plus the flag on the CLI.
- **Federating into the operator mesh**: gated by the published node list. Open federation reconsidered later — a foreign mesh node sees rendezvous metadata (PeerIds, IPs, topics), so this is a policy decision, not blocked technically.

### Clients

- Browser (web entry channel) and installed app (desktop/Android — the channel with the resilience guarantees).
- Client libp2p **PeerId is ephemeral**: freshly generated on every app start / page reload (key never persisted). An established room keeps its PeerId and its topic across the daily rotation (`PROTOCOL.md` §5.4) — the rotation bounds *discovery* correlation.
- Node selection: the client compiles in the node list (`infra/nodes.json`: `{ v: 1, nodes: [{ name, addr, w? }] }`, at most 24 entries, `addr` a multiaddr ending in `/p2p/<PeerId>`, `w` an optional capacity weight, clamped to 1000; a longer list is cut at 24, and an `updated` stamp in the file is ignored); among the nodes the user has left enabled it **draws** the first (by capacity weight, uniform when the list carries none), then reads every node's announced load from that node and, if a second random choice is lighter by 20 points, moves once at login ("power of two choices"); later — checked every 20 s, at most one move per 10 minutes — it moves only when its node has stayed ≥ 85 % for a minute and another is < 60 %, and then only a fifth of the time per check (hysteresis, `lib/nodepick.ts`). The rest of the list is the failover chain. The list can be refreshed by its compiled-in IPFS CID. No GeoDNS. The network id a web client mixes into its derivations is a build constant (`EC_NETWORK`, `main` by default); the terminal client takes `--network`.

## Identity model

| Layer | Identity | Lifetime |
|---|---|---|
| Application | **IK — one native X25519 key, purpose=`ecdh`** — in an Encedo HEM (HSM), or as a **software profile** (password-sealed on device, `PROTOCOL.md` §4.5 — the zero-hardware onboarding path, and the packaged clients' default) + contact pubkeys | permanent |
| libp2p transport | Ephemeral PeerId | one session |
| Discovery node | Keypair derived from the node's `--pass` seed, PeerId pinned in the compiled-in node list | permanent |

Key properties (`PROTOCOL.md` §4):

- **IK never signs anything** — mutual authentication is MAC-based on the handshake transcript (deniability); groups too (ECDH-HMAC, §8). No dual-use, no curve conversion; on a HEM the purpose flag is enforced by hardware. (The HEM `x25519` dual key type ships in firmware as a platform capability, but Chat's IK does not use it.)
- Chat's HSM crypto surface is **one call** — raw `ecdh` — plus key management. Current firmware has no in-HSM HKDF, so IK-derived derivations run client-side over the raw output; the exposure and its closure are recorded in `PROTOCOL.md` §4.3/S13. Zero firmware changes needed for Phase 1.
- Contacts are imported **out-of-band** (QR / invite link + fingerprint verification); the stored book is MAC'd against key swaps (`PROTOCOL.md` §4.4).
- A **published invite** is the second door (`PROTOCOL.md` §5.7-5.9): one long-lived link its owner may hang anywhere, naming a **public** topic that strangers can knock on. Several per identity, each retirable alone. It trades an exposed topic for reachability without a prior exchange — the fingerprint comparison above is unchanged, and accepting a knock is what creates the contact.
- **Single active session per identity** (`PROTOCOL.md` §9): a duplicate is detected on the self-topic and **both copies stand down** — the user re-enters one deliberately; a stolen device without the HSM dies at the next forced re-handshake.
- Identity is proven inside the session layer (EH-2 MACs), never at the transport layer. The transport knows only throwaway PeerIds.

## Rendezvous — deterministic rotating rooms

`PROTOCOL.md` §5 is authoritative; summary:

```
topic = base32( HKDF-SHA256(
  ikm  = ECDH(IK_a_priv, IK_b_pub),          // identity backend call — same value both sides
  salt = "encedo-chat-rendezvous-v1",
  info = network_id || 0x00 || date_UTC       // date on the pair's shifted clock (§5.4)
) )[0:52]
```

- **1:1**: both sides compute the same topic offline, with zero discovery chatter. "I am X and want to talk to Y" resolves from keys + date; no directory service. Topics are indistinguishable from random without the shared secret (circular knowledge requirement for observers).
- **Groups**: Sender Keys over a client-side `group_secret` topic (`PROTOCOL.md` §5.3/§8), scale assumption 3–5 members (max 8–10); MLS deferred, not rejected.
- **Rotation** (`PROTOCOL.md` §5.4): each pair rolls over at its **own secret instant** derived from the pair secret — rotations spread across 24 h (no midnight re-subscribe spike) and both members cross together; a ±30 min guard double-subscribes the adjacent day.
- **Presence** (`PROTOCOL.md` §5.5): `Announce` messages on active topics (ephemeral PeerId + nonce + timestamp + HMAC keyed from the pair's shared secret), heartbeat every 15 s with early join beacons, replay/duplicate protection. Only holders of the shared secret can produce or verify announces. A light per-contact watch gives presence dots without handshakes and hands the topic over warm when a conversation opens.
- **Self-topic** (`PROTOCOL.md` §5.2): derived from a self-DH (`ECDH(IK, IK_pub)`), computable **only by the identity holder**; carries MAC'd announces for duplicate-session detection.
- `network_id` keeps independent networks disjoint at the rendezvous layer (see Third-party nodes and networks); it is part of the normative key schedule.

## Transport

Two planes (`PROTOCOL.md` §13):

| Plane | Mechanism | Carries |
|---|---|---|
| Control | client ↔ node: `/onchato/pick/1` (the light client, default since 0.6.24; a full GossipSub peer with `?light=0`) · node ↔ node: GossipSub | rendezvous topics, Announce/presence, self-topic, EH-2 frames, WebRTC signaling, group keepalive |
| Data | **WebRTC DataChannel** (1:1, opportunistic — the browser's, or on the Linux desktop the host's) with **the node as the ciphertext fallback** — and as the only path for groups | ratchet / sender-key content |

The session layer (EH-2, ratchet) is transport-agnostic; everything the node carries is ciphertext + metadata to it.

- **WebRTC signaling** rides the pair topic as ratchet-sealed `rtc` envelopes (`PROTOCOL.md` §7.4) — the node learns that a pair is negotiating, never the addresses. This whole path runs only where the user selected the direct plane (node-only is the default since 2026-09-03; the setting has three positions — *relay*, *auto*, and *direct-only*, in which the node carries no content at all — `PROTOCOL.md` §13). ICE then consults **our own STUN servers on the three nodes** (`infra/stun/`, since 2026-09-03; Google's public one before that) for reflexive addresses — so the only party that sees a client's IP and negotiation timing is the operator already carrying that client's connection (`PROTOCOL.md` §13). The offering side (lower PeerId) re-offers on loss; a channel is trusted only after a two-way ping proves it, and one stall demotes the conversation to the relay for its remaining life.
- **The relay-blind data plane (circuit-relay-v2 streams) is parked**, blocked upstream: on the pinned libp2p 2.2.x generation the destination-side STOP handling is broken, and the v3 upgrade waits for a GossipSub release compatible with libp2p v3. When it lands, it narrows the node path's exposure from "the node sees GossipSub frames" to "one node sees flow metadata of an opaque NOISE tunnel". That is a different promise from the **transport switch that has shipped** (Settings → *Tylko przez węzeł* / *Automatycznie* / *Tylko bezpośrednio*): the switch decides whether the PEER learns your address, the parked plane would decide whether the NODE does. Since 2026-09-03 the switch defaults to node-only — direct is opt-in — and the badge still reports what the pair actually got (⚪ relay / 🟢 direct). On the Linux desktop WebKitGTK has no `RTCPeerConnection` (measured), so since 0.5.78 the **Tauri host opens the DataChannel itself** (`webrtc-rs`, `src-tauri/src/rtc.rs`, behind the same link interface the browser implements); frames cross the IPC as base64, and because the host advertises no message size the client keeps every frame under 65 536 bytes (`PROTOCOL.md` §13.1).
- **No TURN.** Rationale: a TURN server sees the same metadata as a blind relay (IPs, timing, volume) so there is no security gain; it adds a separate service, credential management, and a protocol that is easy to fingerprint and block — whereas the libp2p node behind nginx on 443/WSS is indistinguishable from ordinary TLS web traffic. Voice/video calls are out of scope, so the one scenario that would justify TURN never arises. Hard-NAT pairs fall back to the relay.

## E2E encryption — **resolved; full detail in `PROTOCOL.md` §6–§8, §11, §15**

`PROTOCOL.md` is authoritative. Summary of what was adopted and why it fits this product:

- **EH-2 handshake** (`PROTOCOL.md` §6): interactive Noise-XX-style, 1.5 RTT, three X25519 DHs + ephemeral **ML-KEM-768** encapsulation combined in HKDF → post-quantum **hybrid confidentiality from day 1** ("harvest now, decrypt later" defeated). MAC-based mutual auth → **deniability** (no signatures anywhere in the 1:1 path). KCI-resistant, replay-protected.
- **No prekeys, no prekey server** — the instant-only/synchronous model eliminates them (prekeys exist to reach *offline* recipients). This was the decisive argument for EH-2 over the earlier X3DH direction; the X3DH design is shelved as the blueprint for a hypothetical future offline-delivery extension (`PROTOCOL.md` §19).
- **Double Ratchet** (`PROTOCOL.md` §7) client-side, **hybrid** — every fourth DH step, or every 30 minutes, mixes an ML-KEM-768 secret into the root, so post-compromise security is post-quantum inside a session too — with a **bounded session lifetime** (forced re-handshake every 4–8 h, the hard stop of a stolen unlocked device).
- **Groups** (`PROTOCOL.md` §8): Sender Keys with pairwise distribution over EH-2 sessions; **per-recipient ECDH-HMACs** give insider-unforgeability with deniability intact — no signature anywhere in the protocol.
- **PQ roadmap** (`PROTOCOL.md` §15): Phase 1 hybrid confidentiality now → Phase 2 PQ identity distributed in-band over the classically-authenticated channel → Phase 3 full PQ handshake by 2030 (recommended construction: long-term ML-KEM in HSM — de-risked by the confirmed fact that HEM already has ML-KEM in firmware). External positioning stays honest: "PQ confidentiality now, PQ authentication by 2030", never "fully post-quantum from day 1".

The v5 scheme (shared passphrase, PBKDF2 → AES-GCM) is testbed-only and is fully superseded.

## History & local persistence

The network stores nothing for the text path (shared files: ciphertext for minutes on an operator IPFS store — `PROTOCOL.md` §7.5). Locally, what ships (`PROTOCOL.md` §10):

| Store | Behaviour |
|---|---|
| Transcript | **RAM only, always** — a reload takes it; there is no history setting |
| Pinned messages | opt-in per message, encrypted per room, capped at 32 |
| Group state | always cached, encrypted (a group must survive a reload) |
| Contact book | persistent, MAC'd against key swaps |
| Published invites, knocks in progress, dismissed knocks, last-heard per contact | sealed (`PROTOCOL.md` §10) |
| CLI daemon outbox | sealed; text waiting for an offline contact, 24 h |

All keyed off one identity-gated base (`ECDH(IK, emp_pub)`); a stolen disk without the identity is ciphertext plus a public value — plus the names of the stores, which carry the identity's KID and the room (`PROTOCOL.md` §10). Plain preferences (language, theme, node list edits, transport choice, the last profile's name and sign-in method, notification and auto-fetch settings) are not sealed — they carry no contact, key or timing. The packaged desktop additionally writes a plain **connection diary** on disk (link state and contacts' dots lighting or going dark, by key prefix, with a clock; never message text) that a wipeout does not remove — `PROTOCOL.md` §10 states it. A per-profile ephemeral-enforced mode (the P3 posture) is **roadmap** — today there is no policy switch that disables pinning or the group cache. History is per-device by construction (ratchet state is not portable — `PROTOCOL.md` §9.4); a device switch starts empty, with the sealed **profile export** (§10) moving identity/contacts/groups — never a transcript.

## Distribution & trust

Everything public — security from cryptography, not obscurity. The operator of the main network is **fully transparent**: public code (app + infra, one repo), public node list, public deployment recipes.

What ships today:

- Code on GitHub; the web app served from `app.onchato.com` (an origin of its own since 0.7.0 — browser storage shares it with nothing, least of all the file store); installed apps from GitHub Releases (a tag builds desktop for five targets and a **signed Android APK**; the web host self-deploys on the same tag). The desktop updater fetches `latest.json` from GitHub; the web app re-fetches its own `index.html` to notice a new bundle (shortly after load, every six hours, and when the tab becomes visible, at most hourly). The in-app feedback form posts to the operator (`/feedback`: kind, text, an optional contact line, language, version/commit/shell, how the copy was installed, and — only when the box is ticked — the user agent, the window size and the Diagnostics report); the sink keeps no address.
- **The node list is signed, through the release manifest.** `infra/nodes.json` is compiled into every client; a runtime refresh fetches `https://onchato.com/release/manifest.json` and its `.sig`, verifies the signature against the compiled-in root key (`infra/root.pub`) and the manifest's dates, and only then fetches the list the manifest names by CID and checks it against that CID. Publishing a new list means signing a new manifest, not shipping a build. A domain seizure does not remove the nodes an installed app already carries.
- Release signing is **three CI-held keys** under **one offline root**: minisign for the desktop updater (the draft release is the publish gate), the Android keystore (repository secrets), and Windows **Azure Trusted Signing** (behind the `release` environment's reviewer gate — a tagged build waits for approval before it signs); above them the operator signs a **manifest** with an Ed25519 key that lives in a YubiKey (PIV, Ed25519 from firmware 5.7) and on no machine that builds — `scripts/release-manifest.mjs --sign-yubikey`, PIN and touch per signature, or `--unsigned` and `--attach-sig` when the token is elsewhere; the result is copied to the web host's `/var/lib/onchato/release/`, outside the repository. The manifest carries the node list's CID, the updater's public key, the version and commit it was made at, and an expiry of 120 days; it is signed when the node list or a CI key changes or before it expires, **not per release**. The web bundle's CID is an optional field that nothing enforces until the desktop updater reads the manifest — stating it would be a promise nobody checks, so a release is not gated on a signature today. The desktop `.deb`/`.rpm` never self-update — they are told, not replaced.
- **Reproducibility, measured:** the same commit yields the same web bundle on another machine and another Node version; `scripts/release-cid.mjs` computes the bundle's CID and SRI and can compare them with what `app.onchato.com` serves. What is **not** built is the rest of the chain — the signed source tag → source CID → binary link that would let a third party verify a shipped binary from the source alone (the P3-grade chain), and the updater reading the manifest before it installs. The web app additionally on IPFS is roadmap too.
- Web app remains the low-friction entry channel; resilience guarantees are claimed for the installed app only.

### Self-hosting as a promoted path

Running your own network is not merely tolerated — it is **encouraged**. Today's recipe is `relay/README.md` (VPS + nginx + systemd, node identity derivable in advance); the productized form — a node Docker image + "a $5 VPS behind your domain, full network up in 15 minutes" — is roadmap. This is simultaneously a resilience property (exit from the operator is always available), the P3 deployment story, and a distribution channel.

## Desktop / mobile: Tauri 2 (`PROTOCOL.md` §3.2)

**What ships:** the Tauri 2 shells (Linux/Windows/macOS `.deb`/`.rpm`/AppImage/installers + an Android APK) wrap the **same web bundle** in a native window — all crypto and transport run in the webview on every platform. An **iOS** build exists from the same shell and runs on a device (iOS 26 minimum — the first WKWebView whose WebCrypto has X25519; an older one is refused at install rather than failing at sign-in); it is built by hand on a Mac, has no CI job and is not distributed yet (`MOBILE-PLAN.md`). The shell's value is platform reach, and it is real product surface:

- Desktop: tray + close-to-tray (probed against the actual desktop — no tray host means close quits, honestly), autostart, native notifications (own D-Bus path on Linux), single-instance, **self-updater** (minisign; `.deb`/`.rpm` get a notification + link, never a silent replace).
- Android: a **foreground service** (`specialUse`) keeps the process alive so a phone in a pocket stays reachable — the honest price of no store-and-forward, paid as a permanent notification; local notifications, no FCM (no Google server between two people).
- Desktop, measured (2026-09-14): the packaged app has the direct plane on Windows (WebView2) and macOS (WKWebView) natively; on **Linux** WebKitGTK as shipped by Ubuntu is built without a WebRTC backend and exposes no `RTCPeerConnection`, so there the **Tauri host opens the DataChannel** (`webrtc-rs`, since 0.5.78) behind the same link interface — the Linux build has the direct plane too, through the host rather than the webview (`PROTOCOL.md` §3.2/§13).

**Roadmap — the hardened tier:** a Rust `core-rs` (native for Tauri, WASM for the web) holding keys, ratchet state and the HEM client outside the webview, with transport behind a trait. That is the isolation story earlier drafts described; it is not the build, and claims about webview-compromise resistance must not be made until it is.

### Build & release pipeline

- **What runs:** `desktop.yml` (tags + manual dispatch) builds linux-amd64/arm64, macOS, Windows, Windows-arm64 via `tauri-action` into a **draft release** — the draft is the deliberate publish gate for the updater's `latest.json`. `android.yml` builds and **signs** the APK (keystore from repository secrets; missing secrets fail the job by name) and an unsigned `.aab` for Play App Signing. `ci.yml` runs the test suite and the group scenarios of the two-browser harness, against the live bs1 node.
- The web host self-deploys on a pushed tag (`infra/deploy-on-tag.sh` + systemd timer — pull model, no production credential in any runner). The deploy builds with the development switches in (`PROTOCOL.md` §12: `?debug`, `?keys`); a release build sets `EC_ALLOW_KEYS=0`. Two more build-time switches: `EC_NETWORK` (the network id) and `EC_DIARY=0` (no connection diary on disk, `PROTOCOL.md` §10).
- The pipeline later grows reproducible-build verification and an iOS job.

## Modularity & UI

**The UI is decoupled in fact, not yet in packaging.** The application core is headless — `impl/lib/` + `impl/eh2/` + `impl/net/` contain no DOM access, and the seam is `lib/core.ts` (`startSession` / `session.open` / `openConversation`, an `Identity` contract, event callbacks). Three consumers prove it: the web UI, the CLI, and the test harnesses — none with privileged access.

- **Not yet done:** publishing the core as a versioned package (`@encedo/chat-core`) and turning the web UI into a mountable component — measured and priced in `EMBED-PLAN.md` (the core needs no architectural work; the UI does).
- Why it matters: alternative UIs from the community, white-labeling, and auditability — the security-critical surface is the small core, not the skin.
- Both shells (web, Tauri) wrap the same engine + the same UI today.

### Reference UI notes

Look & feel is open; a reference skin beyond the shipped web UI is a question to come back to. Agreed regardless of skin:

- The mental model is an **arranged meeting, not a mailbox** — rooms as meetings, presence, no fake message history (no "recent messages" previews: there is no history to preview).
- **Security state must be visible and honest**: the security badge (🤝 → 🔐) and the transport badge (⚪ relay / 🟢 direct) report the measured state of *this* conversation, never a configured wish. Capability probing separates REQUIRED (refuse to start, say why) from DEGRADED (say so, carry on) — a platform that cannot do WebRTC or notifications is told, not silently downgraded.
- Avatars/identicons derived locally from keys — never fetched from a server.
- Slash commands exist in the CLI (`onchato`: windows, queries, groups and their administration, `/add`, `/verify`, `/invite`, knocks and their acceptance, files, `/me`, `/react`, `/quit` and more — `CLI.md`); the web UI has none. Moving the parser into the core so every skin gets them is an open refinement, not a shipped property.

## Explicit non-goals

- Offline messaging, network-side message history, simultaneous multi-device (single active session — `PROTOCOL.md` §9). If offline delivery ever becomes a product goal, the archived X3DH/prekeys design is the starting blueprint (`PROTOCOL.md` §16, §19 anticipate exactly this).
- Anonymity against a global passive observer (traffic correlation) — requires a mixnet; recorded as a boundary in the threat models.
- **Live voice/video calls — permanently out of this codebase.** A separate, existing service; possible later pairing at the product level (the Google Chat + Meet model). This also settles TURN: it never comes back here. **Recorded voice notes ship** — they travel as ordinary encrypted files (`PROTOCOL.md` §7.5) and add nothing to the wire.
- Being a Slack/Teams replacement. This is a focused instant messenger; channels-and-integrations platforms are a different product.

## Open items

| # | Item | Status / blocked on |
|---|---|---|
| 1 | ~~Signing model~~ — **resolved**: an offline root key signs a per-release manifest over the bundle, the node list and the CI updater key (Distribution); still open: the updater verifying it before an install | updater |
| 2 | Open federation policy | operational experience |
| 3 | Core↔UI packaging (`@encedo/chat-core`, mountable UI) | priced in `EMBED-PLAN.md` |
| 4 | Self-hosting recipe (Docker image + manual + $5-VPS guide) | today: `relay/README.md` |
| 5 | Reproducible builds — the build is repeatable (measured, `scripts/release-cid.mjs`); what remains is the signed tag → source CID → binary chain | P3 requirement |
| 6 | Relay-blind data plane (hides the address from the NODE; the peer-facing switch already ships) | GossipSub release for libp2p v3 (Transport) |
| 7 | Hardened tier (`core-rs` outside the webview) | roadmap (`PROTOCOL.md` §3.2) |
| 8 | ~~Identity backend for the open channel~~ — **resolved: the software profile ships** (`PROTOCOL.md` §4.5) | — |
| 9 | Spec open questions (`PROTOCOL.md` §16 — the remaining ones: device enrollment, IK rotation, lib audit, serialization) | pre-1.0 |
| 10 | HEM side-items: `x25519` dual key type (decided: ships) + attestation PoP variant; **HKDF-in-HSM firmware** (closes S13) | HEM firmware roadmap |
| 11 | ~~Network id as a parameter~~ — **resolved**: `EC_NETWORK` at build time for the app, `--network` on the terminal client | — |
| 12 | ~~A per-message size bound at the node~~ — **resolved**: `relay/limits.mjs` (a PUSH past 64 KiB refused, an oversize GossipSub message ignored, 1 MiB per inbound RPC) | — |
