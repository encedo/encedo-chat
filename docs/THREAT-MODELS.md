# v6 — Threat models

Status: **deployment-layer threat model for the shipping product** (onchato 0.5.x). Where a posture is designed but not built, the row says so — an auditor must be able to tell a control from an intention.

Layering: `PROTOCOL.md` owns the **crypto-layer threat model** — adversaries in §2.2, weaknesses S1–S13 in §11.3, PQ phasing in §15. This document is the **deployment layer on top**: profiles P1–P3 as configuration presets, not separate builds. Users/deployments pick the profile matching their adversary. The enterprise channel (Encedo Chat: EPA, OIDC) and the open channel (onchato) are both expressed through these presets.

## Assets

| Asset | Where it lives |
|---|---|
| Message content | endpoints only (E2E; the network stores none of it) |
| Shared files (§7.5) | **ciphertext at rest for ~5 minutes** on an operator IPFS node; the CID is the capability, the key never leaves the envelope; the read gateway is public and unauthenticated |
| Social graph (who talks to whom, when) | partially observable as rendezvous metadata on discovery nodes |
| User IP / location | visible to the discovery node and the file store; on the direct plane also to the conversation peer |
| Long-term identity keys | HEM (HSM) — or, for a **software profile** (`PROTOCOL.md` §4.5), a password-sealed blob on the user's disk: a different assurance tier, named as such |
| **The contact book — the trust anchor** | on device. Swapping a contact's `pub` re-aims the entire stack at the attacker with nothing failing (`PROTOCOL.md` §4.4); the shipped control is a keyed MAC over the stored book, verified at sign-in, with tampering surfaced and never overwritten |
| **The profile export file** (§10) | wherever the user puts it — one sealed blob carrying identity + contacts + groups under the profile password; offline-attackable, file + guessed password = the identity |
| Node list / app integrity | node list: a **compiled-in IPFS CID** (content addressing is the integrity; no signature); releases: three CI-held keys (updater minisign, Android keystore, Windows signing wired-but-off). An offline operator root key is an open item, not a shipped control |
| Service availability | discovery nodes (redundant, replaceable, self-hostable) |

## Baseline guarantees (all profiles)

- E2E with **post-quantum hybrid confidentiality from day 1** (EH-2: X25519 + ML-KEM-768) — "harvest now, decrypt later" is defeated in Phase 1; nodes see ciphertext flows only. No server-side storage of messages — a seized node yields its own key and live connection metadata, never messages or history. (Files: minutes of ciphertext, the one bounded exception.)
- **Deniability everywhere** (1:1 **and** groups — MAC/HMAC auth throughout, no signature in the protocol) and **forward secrecy** (ephemeral keys + Double Ratchet with bounded session lifetime, forced re-key every 4–8 h).
- **Single active session** (`PROTOCOL.md` §9): a stolen device without the user's HSM cannot start new sessions, compute future topics, or post valid announces; an **already-open session survives at most until the next forced re-handshake (4–8 h)**, which requires the HSM. A detected duplicate makes **both** honest copies stand down (the user re-enters one deliberately); against a malicious client the lifetime timer is the guaranteed bound (§9.3). ⚠️ For a **software profile** the hardware bound does not exist — the re-handshake needs only the on-disk key; the seal password is the boundary (S12).
- Ephemeral client PeerIds; rotating room IDs (24 h, at a per-pair secret instant) bound discovery-layer linkage.
- Releases verifiable (per-artifact signing above); the node list pinned by content addressing.
- Anyone can audit (public code) and anyone can exit to a self-hosted network (`--network`, `relay/README.md`) — the operator is replaceable, which is itself a security property: **the product must remain safe even from its maker.**

## Known limits (all profiles — honest boundaries)

1. Discovery node sees client IPs and rendezvous metadata (ephemeral PeerId ↔ roomID ↔ IP, timing). Rotation limits linkage over time; it does not hide the IP. (One accidental narrowing: behind the reverse proxy the libp2p layer itself sees every client as loopback — the real IP exists only in nginx's logs.)
2. **The direct plane reveals your IP to your conversation peer** (WebRTC ICE), and every direct attempt consults a **public STUN server** (Google's by default — `PROTOCOL.md` §13), a third party outside the operator that sees the client's IP and negotiation timing. A relay-only *mode* is **designed, not built** (blocked on the parked relay-blind plane — `ARCHITECTURE.md` Transport); today direct is opportunistic and the fallback is the relay, which does hide peer IPs from each other but was not built as an anonymity mode. The Linux desktop is relay-only de facto (no WebRTC in its webview).
3. A global passive observer capable of traffic correlation across links defeats network-level privacy (no mixnet). Out of scope — stated, not hand-waved.
4. Compromised endpoint (malware, physical access) defeats everything; HEM confines *key theft* but not live-session abuse — which is in turn time-boxed by the forced re-handshake (4–8 h, §9.3). The hardened shell tier that would narrow webview compromise is roadmap (`PROTOCOL.md` §3.2) — today ratchet state lives in the webview on every platform.
5. Availability of a conversation requires both parties online — by design (instant-only), but it is also the DoS surface: jam the rendezvous, prevent the meeting.
6. **The file store sees file metadata** (`PROTOCOL.md` S11): blob size, timing, fetch pattern and IPs for ~5 minutes per file, on an unauthenticated public gateway. Text has no such surface.
7. **Authentication is classical until Phase 3** (`PROTOCOL.md` S9): confidentiality is PQ-hybrid now, but a future CRQC-equipped adversary could impersonate users in *new* handshakes. Mitigated by the in-band migration path (target 2030 — before CRQC estimates of 2035+). Past traffic is never at risk.
8. **The MQTT fall-back transport trades metadata for reach**: any connected client can observe every room's activity/timing/size (a static broker ACL cannot scope reads to runtime-secret rooms — README). Content stays E2E. Do not enable it where cross-room metadata to a connected observer is unacceptable; GossipSub does not have this surface.

---

## P1 — Private / casual

**Adversary**: commercial surveillance, ISP snooping, opportunistic attackers, platform data harvesting. Not targeted by a state.

**Config preset**: operator network; direct plane allowed (WebRTC preferred); web or installed app; default node list. **This is the shipped default.**

**What the adversary gets**: nothing of content; ISP sees TLS to a chat-looking service (or plain WSS to a node); peer sees your IP (acceptable here — you're talking to a contact you chose).

**Residual risk**: metadata at the discovery node and file store (operator honesty assumed in this profile); IP exposure to peers.

## P2 — Hostile network environment

**Adversary**: national censor or hostile local network operator; targeted network surveillance of the *user*; active blocking of known endpoints. The operator (us) is still trusted.

**Config preset**: **relay-only mode — not yet built** (limit 2); until it ships, the honest P2 posture is: Tor/VPN underneath (the TCP/WSS path is Tor-compatible; WebRTC/UDP is not, so disabling direct dials matters and needs the mode), **installed app only** (web channel is takedown-able and injectable), node list carried by the installed build rather than fetched from the primary domain.

**What this defeats (as shipped)**: domain seizure (app already installed with its node list), endpoint blocking (nodes behind nginx on 443/WSS blend with ordinary TLS; the list can rotate via a new build). **What needs the mode**: guaranteed peer-side IP privacy.

**Residual risk**: discovery-node metadata (mitigated by Tor: node sees exit IP); rendezvous jamming/DoS by the censor; traffic correlation if the adversary observes both the user's uplink and the node.

## P3 — Critical infrastructure / state-level target

**Adversary**: nation-state with legal power over the operator, ability to seize or compel nodes, supply-chain leverage, long-term targeted collection.

**Key posture change: the operator is *outside* the trust boundary.** The deployment must not depend on our infrastructure, our node list, or our goodwill.

**Config preset**: fully independent network — own nodes (`relay/README.md`; Docker image is roadmap), own `--network` id, own build carrying its own node list; HEM mandatory for all identities (**never** software profiles); installed app only; deployment inside a controlled network perimeter where applicable. Three P3 prerequisites are **open items, named**: the relay-only mode (limit 2), an ephemeral-enforced cache policy (no switch exists today — pins and the group cache are always available), and reproducible builds.

**What this defeats**: compelled-operator scenarios — an independent deployment carries nothing the operator can be compelled to hand over or sabotage.

**Residual risk**: the deployment's own opsec (signing-key handling, node hosting jurisdiction, **profile-export files** — treat the file as the identity); endpoint compromise; global traffic correlation (out of scope — if this is in the adversary model, this product alone is insufficient and must sit behind additional network anonymization).

---

## Profile → configuration matrix

| Setting | P1 | P2 | P3 |
|---|---|---|---|
| Transport | direct + relay fallback (shipped) | relay-only **(mode not built — Tor under WSS today)** | relay-only **(same gap)** |
| Network | operator | operator | self-hosted |
| App channel | web or installed | installed only | installed only, reproducible build **(roadmap)** |
| Tor/VPN | optional | recommended | per deployment policy |
| Node list source | compiled-in + CID refresh | the installed build's own copy | own build, own list |
| Identity backend | software profile (shipped, §4.5) or PPA | PPA/HEM recommended | EPA or PPA **mandatory** |
| Local stores (§10) | identity-gated encrypted stores; transcript RAM-only | same (wipeout is the user's action) | ephemeral-enforced **(no policy switch yet — open item)** |

## Open questions

1. Rendezvous DoS resistance (P2/P3): can a censor who learns nothing from roomIDs still jam rendezvous wholesale? (Blocking nodes ≈ blocking HTTPS; per-IP limits at nginx are the deployed flood control — `relay/README.md`.)
2. Reproducible builds — required for P3 credibility; toolchain implications TBD.
3. Node logging — **answered by the running config**: the relay logs topic admissions/evictions, its topic budget and connection counts; per-message logging is metadata-only (truncated topic, sender prefix, byte count), payloads never. A formal no-log statement for operators remains to be written.
4. ~~E2E scheme properties per profile~~ — **resolved**: defined in `PROTOCOL.md` (§6.4, §11.2–11.3, §15), uniform across profiles.
5. ~~Identity backend for the open channel~~ — **resolved: the software profile ships** (`PROTOCOL.md` §4.5), with its assurance difference recorded as S12 and in the Assets table.
