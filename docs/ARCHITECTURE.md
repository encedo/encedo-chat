# v6 — Architecture

Status: **design of record for a shipping product** (onchato 0.5.x: web, desktop, Android — one engine in `impl/`). Sections marked **TBD** or **roadmap** are not built; everything else describes what runs. Earlier concept-phase drafts are in git.

## Document map

| Document | Role |
|---|---|
| `PROTOCOL.md` | **The single source of truth for the protocol and all cryptography** — identity, rendezvous, EH-2, ratchet, groups, session management, transport mapping, security analysis (weakness register S1–S13), metadata analysis, PQ roadmap, implementation map (§17), archived HEM platform notes (§19), and **flow diagrams** (§20, Mermaid — rendered natively by GitHub). Absorbed the former `encedo-chat` spec and `onchato` notes, which have been removed. |
| this file | Product & infrastructure layer: goals, network roles, node operations, transport modes, distribution, modularity/UI, threat-profile presets |
| `THREAT-MODELS.md` | Deployment profiles P1–P3 mapped onto the protocol's threat model (`PROTOCOL.md` §2.2, §11.3 S1–S13) |

## Product definition

Instant-only P2P chat — the IRC / "meet in the park" model:

- Both parties are online during the conversation. **No offline messages, no mailbox, no delivery receipts, no push notifications, no server-side history.** A conversation is arranged (out of band or by standing agreement) and happens in a deterministic, crypto-derived room.
- Ephemerality is a security feature: nodes store nothing, so there is nothing to seize, subpoena, or leak.

### Goals

1. **Resilient to infrastructure failure** — any single discovery node is sufficient; anyone can run their own network.
2. **Resistant to takedown** — multi-jurisdiction nodes, signed distribution over multiple channels, installed app independent of any domain.
3. **Network-level privacy** — honest scope: pseudonymity with rotating identifiers by default; a relay-only mode for IP privacy. Full anonymity against a global observer (mixnet-class) is explicitly out of scope.
4. **E2E security** — content readable only by endpoints; long-term keys in HSM (Encedo HEM).

Positioning: dual-use secure messenger (private, commercial, military / critical-infrastructure deployments). Threat profiles in `THREAT-MODELS.md` map to configuration presets of one product.

**One core, two go-to-market channels** (decided 2026-07-23): the same protocol core ships as (a) **Encedo Chat** — enterprise/tenant deployments (EPA HSM, OIDC, DORA/NIS2 compliance framing) and (b) **onchato** — the open public network (self-hosting, community UIs, takedown resistance). Enterprise is the protocol's native audience and maps to a P3-style preset with EPA/OIDC; the open network runs P1/P2 presets. Neither is "the real product" — both are configurations of one codebase.

## Network roles

### Discovery nodes (operator-run; two in production, bs1 + bs2)

- Plain libp2p nodes: GossipSub + circuit-relay-v2 reservations behind nginx (WSS on 443), interconnected over a direct IPv6 mesh (public IPv4 between the nodes is blocked). A third node's PeerId is precomputed; `relay/README.md` is the operational manual.
- **Role: discovery + signaling + the ciphertext fallback content path.** GossipSub carries rendezvous, handshake frames, and — where WebRTC cannot be established, for groups always, and for the Linux desktop always — sealed content as opaque bytes (`PROTOCOL.md` §13). The node never sees plaintext or keys.
- Stateless beyond their identity key. A Docker image for one-command self-hosting is **roadmap**; today the recipe is `relay/README.md` (clone → `npm ci` → systemd).
- Node identity: deterministic from the `--pass` seed — the pass is the hostname by convention, so a node's PeerId (and the multiaddr clients will carry) is derivable on a laptop before the machine exists.
- Topic management: a large limit + **TTL eviction** (a topic with no traffic for `--idle-ttl` is dropped; heartbeats keep live rooms perpetually fresh) — per-pair daily rooms mean many short-lived topics.
- Two operational lessons that are now configuration, not choice (`relay/README.md`): GossipSub's IP-colocation scoring is **off** (behind the proxy every client arrives from loopback — the penalty graylisted the whole user base), and libp2p's per-host inbound limits are raised, replaced by per-real-IP `limit_conn`/`limit_req` at nginx.

### Third-party nodes and networks

- **Independent network**: first-class, supported from day one. A `--network <id>` parameter is mixed into all topic names and rendezvous derivation — two networks never collide even if their nodes accidentally connect.
- **Federating into the operator mesh**: gated by the published node list. Open federation reconsidered later — a foreign mesh node sees rendezvous metadata (PeerIds, IPs, topics), so this is a policy decision, not blocked technically.

### Clients

- Browser (web entry channel) and installed app (desktop/Android — the channel with the resilience guarantees).
- Client libp2p **PeerId is ephemeral**: freshly generated on every app start / page reload (key never persisted). An established room keeps its PeerId and its topic across the daily rotation (`PROTOCOL.md` §5.4) — the rotation bounds *discovery* correlation.
- Node selection: the client compiles in the node list (`infra/nodes.json`), dials it in order and fails over down it; the user can reorder or override locally, and the list can be refreshed by its compiled-in IPFS CID. No GeoDNS.

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
- `network_id` keeps independent networks disjoint at the rendezvous layer (see `--network` under Network roles); it is part of the normative key schedule.

## Transport

Two planes (`PROTOCOL.md` §13):

| Plane | Mechanism | Carries |
|---|---|---|
| Control | GossipSub over the discovery node | rendezvous topics, Announce/presence, self-topic, EH-2 frames, WebRTC signaling, group keepalive |
| Data | **WebRTC DataChannel** (1:1, browsers, opportunistic) with **GossipSub through the node as the ciphertext fallback** — and as the only path for groups and for the Linux desktop | ratchet / sender-key content |

The session layer (EH-2, ratchet) is transport-agnostic; everything the node carries is ciphertext + metadata to it.

- **WebRTC signaling** rides the pair topic as ratchet-sealed `rtc` envelopes (`PROTOCOL.md` §7.4) — the node learns that a pair is negotiating, never the addresses. This whole path runs only where the user selected the direct plane (node-only is the default since 2026-09-03). ICE then consults a **public STUN server** (Google's by default, configurable) for reflexive addresses — a third party that sees client IPs and negotiation timing (`PROTOCOL.md` §13). The offering side (lower PeerId) re-offers on loss; a channel is trusted only after a two-way ping proves it, and one stall demotes the conversation to the relay for its remaining life.
- **The relay-blind data plane (circuit-relay-v2 streams) is parked**, blocked upstream: on the pinned libp2p 2.2.x generation the destination-side STOP handling is broken, and the v3 upgrade waits for a GossipSub release compatible with libp2p v3. When it lands, it narrows the node path's exposure from "the node sees GossipSub frames" to "one node sees flow metadata of an opaque NOISE tunnel". That is a different promise from the **transport switch that has shipped** (Settings → *Tylko przez węzeł* / *Automatycznie*): the switch decides whether the PEER learns your address, the parked plane would decide whether the NODE does. Since 2026-09-03 the switch defaults to node-only — direct is opt-in — and the badge still reports what the pair actually got (⚪ relay / 🟢 direct). The Linux desktop is relay-only today by platform limitation (WebKitGTK has no `RTCPeerConnection` — measured; `PROTOCOL.md` §3.2).
- **No TURN.** Rationale: a TURN server sees the same metadata as a blind relay (IPs, timing, volume) so there is no security gain; it adds a separate service, credential management, and a protocol that is easy to fingerprint and block — whereas the libp2p node behind nginx on 443/WSS is indistinguishable from ordinary TLS web traffic. Voice/video calls are out of scope, so the one scenario that would justify TURN never arises. Hard-NAT pairs fall back to the relay.
- **MQTT** is a second, fully working transport (per-session choice, `?mqtt=1` / `--mqtt`): the engine unchanged over a broker, for operators who cannot run libp2p — at a documented metadata cost (a connected client can observe every room's activity; README).

## E2E encryption — **resolved; full detail in `PROTOCOL.md` §6–§8, §11, §15**

`PROTOCOL.md` is authoritative. Summary of what was adopted and why it fits this product:

- **EH-2 handshake** (`PROTOCOL.md` §6): interactive Noise-XX-style, 1.5 RTT, three X25519 DHs + ephemeral **ML-KEM-768** encapsulation combined in HKDF → post-quantum **hybrid confidentiality from day 1** ("harvest now, decrypt later" defeated). MAC-based mutual auth → **deniability** (no signatures anywhere in the 1:1 path). KCI-resistant, replay-protected.
- **No prekeys, no prekey server** — the instant-only/synchronous model eliminates them (prekeys exist to reach *offline* recipients). This was the decisive argument for EH-2 over the earlier X3DH direction; the X3DH design is shelved as the blueprint for a hypothetical future offline-delivery extension (`PROTOCOL.md` §19).
- **Double Ratchet** (`PROTOCOL.md` §7) client-side, with **bounded session lifetime** (forced re-handshake every 4–8 h → hard upper bound on classical-PCS exposure, weakness S10).
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

All keyed off one identity-gated base (`ECDH(IK, emp_pub)`); a stolen disk without the identity is ciphertext plus a public value. A per-profile ephemeral-enforced mode (the P3 posture) is **roadmap** — today there is no policy switch that disables pinning or the group cache. History is per-device by construction (ratchet state is not portable — `PROTOCOL.md` §9.4); a device switch starts empty, with the sealed **profile export** (§10) moving identity/contacts/groups — never a transcript.

## Distribution & trust

Everything public — security from cryptography, not obscurity. The operator of the main network is **fully transparent**: public code (app + infra, one repo), public node list, public deployment recipes.

What ships today:

- Code on GitHub; the web app served from the domain; installed apps from GitHub Releases (a tag builds desktop for five targets and a **signed Android APK**; the web host self-deploys on the same tag).
- **The node list is pinned by content addressing, not signed**: `infra/nodes.json` is compiled into every client, and a runtime refresh fetches a **compiled-in IPFS CID** — the CID is the whole of the list's integrity, at the cost that publishing a new list means shipping a build. A domain seizure does not remove the nodes an installed app already carries.
- Release signing is **three CI-held keys**, none of them an offline root: minisign for the desktop updater (the draft release is the publish gate), the Android keystore (repository secrets), and Windows Azure Trusted Signing (wired, not yet enabled). The desktop `.deb`/`.rpm` never self-update — they are told, not replaced.
- **Roadmap, deliberately not claimed as built:** an offline operator root key over releases + node list; the web app additionally on IPFS; **reproducible builds** (the P3-grade chain: signed source tag → source CID → reproducible build → signed binary — without that link a CID of the source says nothing about the binary).
- Web app remains the low-friction entry channel; resilience guarantees are claimed for the installed app only.

### Self-hosting as a promoted path

Running your own network is not merely tolerated — it is **encouraged**. Today's recipe is `relay/README.md` (VPS + nginx + systemd, node identity derivable in advance); the productized form — Docker image + "a $5 VPS behind your domain, full network up in 15 minutes" — is roadmap. This is simultaneously a resilience property (exit from the operator is always available), the P3 deployment story, and a distribution channel.

## Desktop / mobile: Tauri 2 (`PROTOCOL.md` §3.2)

**What ships:** the Tauri 2 shells (Linux/Windows/macOS `.deb`/`.rpm`/AppImage/installers + an Android APK) wrap the **same web bundle** in a native window — all crypto and transport run in the webview on every platform. The shell's value is platform reach, and it is real product surface:

- Desktop: tray + close-to-tray (probed against the actual desktop — no tray host means close quits, honestly), autostart, native notifications (own D-Bus path on Linux), single-instance, **self-updater** (minisign; `.deb`/`.rpm` get a notification + link, never a silent replace).
- Android: a **foreground service** (`specialUse`) keeps the process alive so a phone in a pocket stays reachable — the honest price of no store-and-forward, paid as a permanent notification; local notifications, no FCM (no Google server between two people).
- Linux desktop caveat, measured: WebKitGTK exposes no `RTCPeerConnection`, so the desktop build is **relay-only** (`PROTOCOL.md` §3.2/§13).

**Roadmap — the hardened tier:** a Rust `core-rs` (native for Tauri, WASM for the web) holding keys, ratchet state and the HEM client outside the webview, with transport behind a trait. That is the isolation story earlier drafts described; it is not the build, and claims about webview-compromise resistance must not be made until it is.

### Build & release pipeline

- **What runs:** `desktop.yml` (tags + manual dispatch) builds linux-amd64/arm64, macOS, Windows, Windows-arm64 via `tauri-action` into a **draft release** — the draft is the deliberate publish gate for the updater's `latest.json`. `android.yml` builds and **signs** the APK (keystore from repository secrets; missing secrets fail the job by name) and an unsigned `.aab` for Play App Signing. `ci.yml` runs the test suite and the two-browser harness.
- The web host self-deploys on a pushed tag (`infra/deploy-on-tag.sh` + systemd timer — pull model, no production credential in any runner).
- The pipeline later grows Windows signing activation (wired, waiting on an Azure tenant) and reproducible-build verification.

## Modularity & UI

**The UI is decoupled in fact, not yet in packaging.** The application core is headless — `impl/lib/` + `impl/eh2/` + `impl/net/` contain no DOM access, and the seam is `lib/core.ts` (`startSession` / `session.open` / `openConversation`, an `Identity` contract, event callbacks). Three consumers prove it: the web UI, the CLI, and the test harnesses — none with privileged access.

- **Not yet done:** publishing the core as a versioned package (`@encedo/chat-core`) and turning the web UI into a mountable component — measured and priced in `EMBED-PLAN.md` (the core needs no architectural work; the UI does).
- Why it matters: alternative UIs from the community, white-labeling, and auditability — the security-critical surface is the small core, not the skin.
- Both shells (web, Tauri) wrap the same engine + the same UI today.

### Reference UI notes

Look & feel is open — two clickable mockups exist sharing **the same DOM skeleton and logic, differing only in the stylesheet** (a working demonstration of the skin-swap principle): `ui-mockup.html` (light, dashboard-style; accepted as the starting point) and `ui-mockup-hacker.html` (terminal skin in v5's GitHub-dark palette). Agreed regardless of skin:

- The mental model is an **arranged meeting, not a mailbox** — rooms as meetings, presence, no fake message history (no "recent messages" previews: there is no history to preview).
- **Security state must be visible and honest**: the security badge (🤝 → 🔐) and the transport badge (⚪ relay / 🟢 direct) report the measured state of *this* conversation, never a configured wish. Capability probing separates REQUIRED (refuse to start, say why) from DEGRADED (say so, carry on) — a platform that cannot do WebRTC or notifications is told, not silently downgraded.
- Avatars/identicons derived locally from keys — never fetched from a server.
- Slash commands exist in the CLI (`/who`, `/me`, `/react`, `/quit`); the web UI has none. Moving the parser into the core so every skin gets them is an open refinement, not a shipped property.

## Explicit non-goals

- Offline messaging, network-side message history, simultaneous multi-device (single active session — `PROTOCOL.md` §9). If offline delivery ever becomes a product goal, the archived X3DH/prekeys design is the starting blueprint (`PROTOCOL.md` §16, §19 anticipate exactly this).
- Anonymity against a global passive observer (traffic correlation) — requires a mixnet; recorded as a boundary in the threat models.
- **Live voice/video calls — permanently out of this codebase.** A separate, existing service; possible later pairing at the product level (the Google Chat + Meet model). This also settles TURN: it never comes back here. **Recorded voice notes ship** — they travel as ordinary encrypted files (`PROTOCOL.md` §7.5) and add nothing to the wire.
- Being a Slack/Teams replacement. This is a focused instant messenger; channels-and-integrations platforms are a different product.

## Open items

| # | Item | Status / blocked on |
|---|---|---|
| 1 | Signing model details (offline root key over releases + node list) | open — today: CID-pinned list + three CI keys (Distribution) |
| 2 | Open federation policy | operational experience |
| 3 | Core↔UI packaging (`@encedo/chat-core`, mountable UI) | priced in `EMBED-PLAN.md` |
| 4 | Self-hosting recipe (Docker image + manual + $5-VPS guide) | today: `relay/README.md` |
| 5 | Reproducible builds (closes the CID→binary trust chain) | toolchain work, P3 requirement |
| 6 | Relay-blind data plane (hides the address from the NODE; the peer-facing switch already ships) | GossipSub release for libp2p v3 (Transport) |
| 7 | Hardened tier (`core-rs` outside the webview) | roadmap (`PROTOCOL.md` §3.2) |
| 8 | ~~Identity backend for the open channel~~ — **resolved: the software profile ships** (`PROTOCOL.md` §4.5) | — |
| 9 | Spec open questions (`PROTOCOL.md` §16 — the remaining ones: device enrollment, IK rotation, lib audit, serialization) | pre-1.0 |
| 10 | HEM side-items: `x25519` dual key type (decided: ships) + attestation PoP variant; **HKDF-in-HSM firmware** (closes S13) | HEM firmware roadmap |
