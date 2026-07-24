# v6 — Architecture (high-level concept)

Status: **concept phase — no code yet.** v5 remains the working testbed (see `../v5/`).
This document captures the agreed design; sections marked **TBD** are open.

## Document map

| Document | Role |
|---|---|
| `PROTOCOL.md` | **The single source of truth for the protocol and all cryptography** — identity, rendezvous, EH-2, ratchet, groups, session management, transport mapping, security analysis (weakness register S1–S10), metadata analysis, PQ roadmap, implementation guide (§17), archived HEM platform notes (§19), and **flow diagrams** (§20, Mermaid — rendered natively by GitHub). Absorbed the former `encedo-chat` spec and `onchato` notes, which have been removed. |
| this file | Product & infrastructure layer: goals, network roles, node operations, transport modes, distribution, modularity/UI, threat-profile presets |
| `THREAT-MODELS.md` | Deployment profiles P1–P3 mapped onto the protocol's threat model (`PROTOCOL.md` §2.2, §11.3 S1–S10) |

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

### Discovery nodes (operator-run, 3–5)

- Plain libp2p nodes: GossipSub + circuit-relay-v2 behind nginx (WSS on 443). One per country/region; interconnected in a GossipSub mesh (ring / partial mesh is sufficient — as in v5).
- **Role: discovery + signaling + blind relay fallback only.** They never carry chat messages in GossipSub (change vs v5 — see Transport).
- Stateless beyond their identity key → trivial to package as a **Docker image**; spinning up an independent network takes minutes.
- Node identity: **production** — random key generated once, persisted on disk (`--key-file`); **development** — deterministic from `--pass` (stable PeerId across restarts, faster iteration). Production PeerIds are pinned in the signed node list.
- Topic management: v5's `MAX_TOPICS = 50` cap is replaced by a large limit + **TTL eviction** (unsubscribe topics with no subscribers after N minutes) — per-pair daily rooms mean many short-lived topics.

### Third-party nodes and networks

- **Independent network**: first-class, supported from day one. A `--network <id>` parameter is mixed into all topic names and rendezvous derivation — two networks never collide even if their nodes accidentally connect.
- **Federating into the operator mesh**: gated by an allowlist (node list signed by the operator key). Open federation reconsidered later — a foreign mesh node sees rendezvous metadata (PeerIds, IPs, topics), so this is a policy decision, not blocked technically.

### Clients

- Browser (web entry channel) and installed app (desktop/mobile — the channel with the resilience guarantees).
- Client libp2p **PeerId is ephemeral**: freshly generated on every app start / page reload (already v5 behaviour — key never persisted). For sessions running across midnight UTC, PeerId rotates **together with room rotation** — correlation breaks exactly when the room identifier breaks; mid-day rotation adds nothing.
- Node selection ("per location"): the app dials 2–3 candidates from the signed bootstrap list in parallel and keeps the fastest; the rest remain as spares. No GeoDNS.

## Identity model

| Layer | Identity | Lifetime |
|---|---|---|
| Application | **IK — one native X25519 key, purpose=`ecdh`, in Encedo HEM (HSM)** + contact pubkeys with fingerprints in DESCR (the "mini database") | permanent |
| libp2p transport | Ephemeral PeerId | one session / one room-rotation window |
| Discovery node | Stable keypair on disk, PeerId pinned in signed node list | permanent |

Key properties (`PROTOCOL.md` §4):

- **IK never signs anything** — mutual authentication is MAC-based on the handshake transcript (deniability). No dual-use, no curve conversion; the purpose flag is enforced by HEM hardware. (The HEM `x25519` dual key type ships in firmware as a platform capability, but Chat's IK does not use it.)
- Chat's HSM crypto surface is **one call** — `ecdh` in two modes: raw (handshake only) or with **in-HSM HKDF** (topics, announce MACs, cache key — raw pair secrets never reach client memory); plus key management (`key_generate`, `key_delete`, `key_search`). Zero firmware changes needed for Phase 1 (`PROTOCOL.md` §4.3).
- Contacts are imported **out-of-band** (QR / fingerprint verification); integrity protected by fingerprint-in-DESCR checks.
- **Single active session per identity** with self-topic takeover and dead man's switch (`PROTOCOL.md` §9): a new login gracefully shuts down the previous device; a stolen device without HSM access is inert.
- Identity is proven inside the session layer (EH-2 MACs), never at the transport layer. The transport knows only throwaway PeerIds.

## Rendezvous — deterministic rotating rooms

`PROTOCOL.md` §5 is authoritative; summary with our one extension (`network_id`):

```
topic = base32( HKDF-SHA256(
  ikm  = ECDH(IK_a_priv, IK_b_pub),          // in HSM — same value both sides
  salt = "encedo-chat-rendezvous-v1",
  info = network_id || 0x00 || date_UTC       // network_id + domain separator: the v6 extension
) )[0:52]
```

- **1:1**: both sides compute the same topic offline, with zero discovery chatter. "I am X and want to talk to Y" resolves from keys + date; no directory service. Topics are indistinguishable from random without the shared secret (circular knowledge requirement for observers).
- **Groups**: Sender Keys (`PROTOCOL.md` §8), scale assumption 3–5 members (max 8–10); MLS deferred, not rejected.
- **Rotation boundary** (`PROTOCOL.md` §5.4): within ±5 min of midnight UTC subscribe to `[yesterday, today, tomorrow]`; publish always on sender's `today`; accept on timestamp ±5 min + any of the three topics.
- **Presence — resolved** (`PROTOCOL.md` §5.5): `Announce` messages on active topics (ephemeral PeerId + nonce + timestamp + HMAC keyed from the pair's shared secret), heartbeat every 60 s, replay/duplicate protection. Only holders of the shared secret can produce or verify announces.
- **Self-topic** (`PROTOCOL.md` §5.2): derived from own IK_pub, carries MAC'd announces for session-takeover detection. Publicly computable by anyone knowing IK_pub — a deliberate, documented presence-leak tradeoff (S2).
- `network_id` keeps independent networks disjoint at the rendezvous layer (see `--network` under Network roles) — to be folded into the normative key schedule at the next revision.

## Transport

Two planes with strictly separated roles:

| Plane | Mechanism | Carries |
|---|---|---|
| Control | GossipSub over the discovery mesh | rendezvous topics, Announce/presence, self-topic, WebRTC signaling |
| Data | 1) WebRTC DataChannel / direct stream → 2) circuit-relay-v2 stream (fallback) | EH-2 handshake + ratchet messages (the "direct streams") |

The session layer (EH-2, ratchet) rides entirely on the data plane and is transport-agnostic; our two transport modes below sit **under** it and are invisible to the protocol. The rule "GossipSub carries rendezvous only, never message content" is stated identically in `PROTOCOL.md` §13.

- **Change vs v5**: chat messages are never flooded over GossipSub. The fallback for peers that cannot establish WebRTC (symmetric NAT) is a **circuit-relay-v2 stream** through one discovery node. The endpoints run their own NOISE handshake through the tunnel — the relay forwards opaque bytes (blind relay). This narrows metadata exposure from "entire mesh sees the encrypted blob" to "one node sees flow metadata".
- Relay data-path limits: circuit-relay-v2 defaults (~2 min / ~128 KB, designed for signaling only) are raised on our nodes for the data path.
- **No TURN.** Rationale: a TURN server sees the same metadata as a blind relay (IPs, timing, volume) so there is no security gain; it adds a separate service, credential management, and a protocol that is easy to fingerprint and block — whereas the libp2p node behind nginx on 443/WSS is indistinguishable from ordinary TLS web traffic. Voice/video is out of scope for this product (separate service — see Non-goals), so the one scenario that would justify TURN never arises.
- **Two transport modes** (user-selectable, bound to threat profiles):
  - **Direct mode** — WebRTC preferred; best resilience/least infra, but peers see each other's IPs.
  - **Relay-only mode ("anonymous")** — never dial direct; IP hidden from the peer; TCP-only path is Tor/VPN-compatible (WebRTC/UDP is not).
- WebRTC signaling: v5's manual `_signal/<peerId>` GossipSub topics are kept for the first iteration (proven working); migration to the `@libp2p/webrtc` transport (native SDP exchange over circuit relay) is a candidate refactor afterwards.

## E2E encryption — **resolved; full detail in `PROTOCOL.md` §6–§8, §11, §15**

`PROTOCOL.md` is authoritative. Summary of what was adopted and why it fits this product:

- **EH-2 handshake** (`PROTOCOL.md` §6): interactive Noise-XX-style, 1.5 RTT, three X25519 DHs + ephemeral **ML-KEM-768** encapsulation combined in HKDF → post-quantum **hybrid confidentiality from day 1** ("harvest now, decrypt later" defeated). MAC-based mutual auth → **deniability** (no signatures anywhere in the 1:1 path). KCI-resistant, replay-protected.
- **No prekeys, no prekey server** — the instant-only/synchronous model eliminates them (prekeys exist to reach *offline* recipients). This was the decisive argument for EH-2 over the earlier X3DH direction; the X3DH design is shelved as the blueprint for a hypothetical future offline-delivery extension (`PROTOCOL.md` §19).
- **Double Ratchet** (`PROTOCOL.md` §7) client-side (Rust core in the Tauri variant) with **bounded session lifetime** (forced re-handshake every 4–8 h → hard upper bound on classical-PCS exposure, weakness S10).
- **Groups** (`PROTOCOL.md` §8): Sender Keys with pairwise distribution over EH-2 sessions; ephemeral per-epoch Ed25519 signing keys prevent insider forgery (accepted deniability reduction in groups).
- **PQ roadmap** (`PROTOCOL.md` §15): Phase 1 hybrid confidentiality now → Phase 2 PQ identity distributed in-band over the classically-authenticated channel → Phase 3 full PQ handshake by 2030 (recommended construction: long-term ML-KEM in HSM — de-risked by the confirmed fact that HEM already has ML-KEM in firmware). External positioning stays honest: "PQ confidentiality now, PQ authentication by 2030", never "fully post-quantum from day 1".

The v5 scheme (shared passphrase, PBKDF2 → AES-GCM) is testbed-only and is fully superseded.

## History & local cache (per profile)

The network stores **nothing**, ever — no store-and-forward, no server-side history (unchanged). Local, device-only cache is a per-profile default (`PROTOCOL.md` §10 modes bound to our profiles):

| Profile | Default | Notes |
|---|---|---|
| P1 | **Encrypted cache** — key derived via HSM ECDH, unlockable only with the user's HEM | stolen disk without HSM = unreadable; user may switch to ephemeral |
| P2 | **Ephemeral** (RAM only) | user may opt into encrypted cache |
| P3 | **Ephemeral, enforced by policy** | no persistence option exposed |

History is per-device by construction (ratchet state is not portable across devices — `PROTOCOL.md` §9.4); a device switch starts empty.

## Distribution & trust

Everything public — security from cryptography, not obscurity. The operator of the main network is **fully transparent**: public code (app + infra), public node list, public deployment recipes.

- Code on GitHub; frontend served from the domain **and** IPFS; installed apps via signed releases.
- **IPFS CID as non-repudiation**: content addressing makes every published artifact immutable and independently verifiable — a CID proves *what* the code is. It complements, not replaces, the signature, which proves *who* published it. The full trust chain for P3-grade credibility: signed source tag → source CID on IPFS → **reproducible build** → signed release binary. Without the reproducible-build link, a CID of the source says nothing about the binary.
- **Operator root key (offline)** signs exactly two artifacts: application releases and the **node list** (bootstrap PeerIds + multiaddrs, small JSON). Signing model details **TBD**.
- The node list is published over multiple independent channels (GitHub, IPFS, domain, DESCR artifacts in HEM keys); the app accepts it from *any* channel because it verifies the signature, not the origin. This — plus the installed app — is the direct answer to domain seizure.
- Web app remains the low-friction entry channel; resilience guarantees are claimed for the installed app only.

### Self-hosting as a promoted path

Running your own network is not merely tolerated — it is **encouraged and productized**. Deliverable: Docker image + manual + ready-made recipes ("a $5 VPS behind your domain, full network up in 15 minutes"). This is simultaneously a resilience property (exit from the operator is always available), the P3 deployment story, and a distribution channel.

## Desktop / mobile: Tauri 2 — two client tiers (`PROTOCOL.md` §3.2, §17.1)

- **Tauri 2 = hardened tier** (desktop Win/macOS/Linux + mobile iOS/Android): **Rust core** runs rust-libp2p, all ephemeral crypto, ratchet state, and the HEM client **outside the webview**; the webview receives only plaintext-to-render and UI events over IPC. Webview compromise (XSS, npm supply chain in the UI layer) does not reach keys or ratchet state. Binary single-digit MB; built-in updater with signed updates.
- **PWA = convenience tier** (zero-install onboarding in the browser): js-libp2p + WebCrypto/`@noble` in the JS context. Same protocol, weaker isolation — honest tiering, not a bug.
- **One `core-rs`, two targets** (`PROTOCOL.md` §3.2 / §17.1): the Rust core compiles natively for Tauri and to WASM for the PWA; `core-ts` degrades to thin glue (transport adapter, bindings). One handshake, one ratchet, one set of test vectors, one audit. Transport lives behind a trait — rust-libp2p (Tauri) and js-libp2p (PWA) are injected adapters.
- **The old "WebRTC in WebKitGTK" spike is dissolved for desktop** — networking is in the Rust process, not the webview. What replaces it: an **interop test** rust-libp2p ↔ browser js-libp2p over WebRTC (Tauri↔PWA conversations), and WebRTC in real browsers for the PWA tier (unproblematic).

### Build & release pipeline

- **GitHub Actions matrix build for all 3 desktop platforms, set up at MVP stage** (`tauri-action` covers this off the shelf). The pipeline is proven early — "przestrzelone" — so release day is never the first time it runs.
- Trigger policy: build on **tags + manual dispatch**, not on every push (Tauri matrix builds are slow and costly). Day-to-day development uses the web build; CI artifacts double as test binaries for the rust-libp2p ↔ js-libp2p WebRTC interop test (open item 6).
- Same pipeline later grows signing (operator root key) and reproducible-build verification.

## Modularity & UI

**Decided: the UI is a replaceable module, decoupled from day one.** The application core is headless; any UI — including community-built and white-label ones — talks to it through one narrow, versioned interface.

- **Headless core** (`core/`): libp2p node, rendezvous, transport modes, E2E crypto, identity (HEM adapter). Framework-agnostic TS/JS package with no DOM access. API surface kept small: commands (`join / leave / send / setProfile`), events (`message / presence / transport-state / rotation`), and a state snapshot.
- **UI packages** (`ui-*/`): consume the core API and nothing else. The reference UI is just the first consumer with **no privileged access** — the proof of decoupling is that the reference UI needs nothing a community UI doesn't get.
- Why: alternative UIs from the GitHub community, easy adaptation and white-labeling, and auditability — the security-critical surface is the small core, not the skin.
- Both shells (web, Tauri) wrap the same core + a chosen UI package.

### Reference UI notes

Look & feel is open — two clickable mockups exist sharing **the same DOM skeleton and logic, differing only in the stylesheet** (a working demonstration of the skin-swap principle): `ui-mockup.html` (light, dashboard-style; accepted as the starting point) and `ui-mockup-hacker.html` (terminal skin in v5's GitHub-dark palette). Agreed regardless of skin:

- The mental model is an **arranged meeting, not a mailbox** — rooms as meetings, presence, no fake message history (no "recent messages" previews: there is no history to preview).
- **Security state must be visible and honest**: current transport (direct vs relay-only), active profile (P1/P2/P3), room rotation. The v5 badge (🟢 direct / ⚪ relay) is the seed of this.
- Avatars/identicons derived locally from keys — never fetched from a server.
- **Slash commands in the message input** (`/join`, `/who`, `/mode relay`, `/quit`) — full keyboard-only operation. Decided: these map 1:1 onto the core↔UI command API, so the parser lives in the core and every skin gets them for free; in the terminal skin they are the stylistically native way to operate the app.

## Explicit non-goals

- Offline messaging, network-side message history, simultaneous multi-device (single active session — `PROTOCOL.md` §9). If offline delivery ever becomes a product goal, the archived X3DH/prekeys design is the starting blueprint (`PROTOCOL.md` §16, §19 anticipate exactly this).
- Anonymity against a global passive observer (traffic correlation) — requires a mixnet; recorded as a boundary in the threat models.
- **Voice/video — permanently out of this codebase.** It lives in a separate, existing service; possible later pairing at the product level (the Google Chat + Meet model). This also settles TURN: it never comes back here.
- Being a Slack/Teams replacement. This is a focused instant messenger; channels-and-integrations platforms are a different product.

## Open items

Resolved in `PROTOCOL.md` (2026-07-23): E2E scheme, presence (Announce), HEM integration surface (three calls), Tauri webview-WebRTC spike (dissolved — rust-libp2p in the Rust core).

| # | Item | Blocked on |
|---|---|---|
| 1 | Signing model details (root key handling, formats) | — |
| 2 | Open federation policy | operational experience |
| 3 | Reference UI skin choice + core↔UI API definition (slash commands; `PROTOCOL.md` §17.5 component list) | iteration |
| 4 | Self-hosting recipe (Docker image + manual + $5-VPS guide) | MVP |
| 5 | Reproducible builds (closes the CID→binary trust chain) | toolchain work, P3 requirement |
| 6 | Interop test: rust-libp2p ↔ js-libp2p over WebRTC (Tauri↔PWA pairs) | first coding session |
| 7 | Fold `network_id` + group-topic derivation into `PROTOCOL.md` normative key schedule | next revision |
| 8 | Identity backend for the open channel's P1 (software keystore vs PPA required — `PROTOCOL.md` assumes HSM) | product decision |
| 9 | Spec open questions P1–P8 (OIDC auth, EPA rate limits, serialization format, GossipSub DoS, device enrollment, IK rotation, lib audit, cache backend) | pre-implementation |
| 10 | HEM side-items from archived notes: `x25519` dual key type (decided: ships) + attestation PoP variant for dual-pubkey slots | HEM firmware roadmap |
