# v6 — Threat models

Status: **draft, developed in parallel with `ARCHITECTURE.md`.**

Layering: `PROTOCOL.md` owns the **crypto-layer threat model** — adversaries in §2.2, weaknesses S1–S10 in §11.3, PQ phasing in §15. This document is the **deployment layer on top**: profiles P1–P3 as configuration presets (transport mode, network, cache, distribution channel), not separate builds. Users/deployments pick the profile matching their adversary. The enterprise channel (Encedo Chat: EPA, OIDC) and the open channel (onchato) are both expressed through these presets.

## Assets

| Asset | Where it lives |
|---|---|
| Message content | endpoints only (E2E; nothing stored anywhere) |
| Social graph (who talks to whom, when) | partially observable as rendezvous metadata on discovery nodes |
| User IP / location | visible to discovery node; in direct mode also to the conversation peer |
| Long-term identity keys | HEM (HSM) on the user's side |
| Node list / app integrity | operator root key (offline) |
| Service availability | discovery nodes (redundant, replaceable, self-hostable) |

## Baseline guarantees (all profiles)

- E2E with **post-quantum hybrid confidentiality from day 1** (EH-2: X25519 + ML-KEM-768) — "harvest now, decrypt later" is defeated in Phase 1; nodes see ciphertext flows only. No server-side storage of anything — a seized node yields its own key and live connection metadata, never messages or history.
- **Deniability** in 1:1 (MAC transcript auth, identity key never signs) and **forward secrecy** (ephemeral keys + Double Ratchet with bounded session lifetime, forced re-key every 4–8 h).
- **Single active session with dead man's switch** (`PROTOCOL.md` §9): a stolen device without the user's HSM cannot start new sessions, compute future topics, or post valid announces; an **already-open session survives at most until the next forced re-handshake (4–8 h)**, which requires the HSM. A new login force-closes honest clients immediately; against a malicious client the lifetime timer is the guaranteed bound (`PROTOCOL.md` §9.3).
- Ephemeral client PeerIds, rotating room IDs (24 h, coupled rotation) — cross-day linkage at the transport layer is broken by design.
- Signed releases and signed node list, verifiable regardless of delivery channel.
- Anyone can audit (public code) and anyone can exit to a self-hosted network (`--network`, Docker image) — the operator is replaceable, which is itself a security property: **the product must remain safe even from its maker.**

## Known limits (all profiles — honest boundaries)

1. Discovery node sees client IPs and rendezvous metadata (ephemeral PeerId ↔ roomID ↔ IP, timing). Rotation limits linkage over time; it does not hide the IP.
2. **Direct mode reveals your IP to your conversation peer** (WebRTC ICE). Relay-only mode exists precisely for this.
3. A global passive observer capable of traffic correlation across links defeats network-level privacy (no mixnet). Out of scope — stated, not hand-waved.
4. Compromised endpoint (malware, physical access) defeats everything; HEM confines *key theft* but not live-session abuse — which is in turn time-boxed by the forced re-handshake (4–8 h, `PROTOCOL.md` §9.3).
5. Availability of a conversation requires both parties online — by design (instant-only), but it is also the DoS surface: jam the rendezvous, prevent the meeting.
6. **Presence leak via self-topic** (`PROTOCOL.md` S2): anyone who already knows a user's IK_pub can compute their self-topic and confirm whether their session is active. Content is MAC-protected; the leak is activity, not identity. Accepted for enterprise; relevant to weigh for the open channel.
7. **Authentication is classical until Phase 3** (`PROTOCOL.md` S9): confidentiality is PQ-hybrid now, but a future CRQC-equipped adversary could impersonate users in *new* handshakes. Mitigated by the in-band migration path (PQ identity distributed over the still-authenticated channel, target 2030 — before CRQC estimates of 2035+). Past traffic is never at risk.

---

## P1 — Private / casual

**Adversary**: commercial surveillance, ISP snooping, opportunistic attackers, platform data harvesting. Not targeted by a state.

**Config preset**: operator network; direct mode allowed (WebRTC preferred); web or installed app; default node list channels.

**What the adversary gets**: nothing of content; ISP sees TLS to a chat-looking service (or plain WSS to a node); peer sees your IP (acceptable here — you're talking to a contact you chose).

**Residual risk**: metadata at the discovery node (operator honesty assumed in this profile); IP exposure to peers.

## P2 — Hostile network environment

**Adversary**: national censor or hostile local network operator; targeted network surveillance of the *user*; active blocking of known endpoints. The operator (us) is still trusted.

**Config preset**: **relay-only mode** (no direct dials — IP never exposed to peers); Tor/VPN underneath (TCP/WSS path is Tor-compatible); **installed app only** (web channel is takedown-able and injectable); node list verified out-of-band (signature check is automatic; obtaining the list via IPFS/mirror rather than the primary domain).

**What this defeats**: peer-side IP discovery, domain seizure (app already installed, list re-fetchable from any channel), endpoint blocking (nodes behind nginx on 443/WSS blend with ordinary TLS; node list can rotate to fresh addresses).

**Residual risk**: discovery-node metadata (mitigated by Tor: node sees exit IP); rendezvous jamming/DoS by the censor; traffic correlation if the adversary observes both user's uplink and the node.

## P3 — Critical infrastructure / state-level target

**Adversary**: nation-state with legal power over the operator, ability to seize or compel nodes, supply-chain leverage, long-term targeted collection.

**Key posture change: the operator is *outside* the trust boundary.** The deployment must not depend on our infrastructure, our node list, or our goodwill.

**Config preset**: fully independent network — own nodes from the public Docker image, own `--network` id, own root key signing own node list and (ideally reproducible) builds; relay-only mode; HEM mandatory for all identities; installed app only; deployment inside controlled network perimeter where applicable.

**What this defeats**: everything P2 defeats, plus compelled-operator scenarios — there is nothing the operator can be compelled to hand over or sabotage that affects this deployment.

**Residual risk**: the deployment's own opsec (root key handling, node hosting jurisdiction); endpoint compromise; global traffic correlation (out of scope — if this is in the adversary model, this product alone is insufficient and must sit behind additional network anonymization).

---

## Profile → configuration matrix

| Setting | P1 | P2 | P3 |
|---|---|---|---|
| Transport mode | direct + fallback | relay-only | relay-only |
| Network | operator | operator | self-hosted |
| App channel / tier | PWA or Tauri | Tauri (hardened tier) | Tauri, reproducible build |
| Tor/VPN | optional | recommended | per deployment policy |
| Node list source | any signed channel | non-primary channels | own root key |
| Identity backend | software keystore or PPA (open item — `PROTOCOL.md` assumes HSM) | PPA/HEM recommended | EPA or PPA mandatory |
| Local cache | encrypted (HSM-unlockable) by default | ephemeral by default | ephemeral, enforced |

## Open questions

1. Rendezvous DoS resistance (P2/P3): can a censor who learns nothing from roomIDs still jam rendezvous wholesale? (Blocking nodes ≈ blocking HTTPS; but targeted flooding of the mesh needs rate-limit design.)
2. Reproducible builds — required for P3 credibility; toolchain implications TBD.
3. Metadata minimization at discovery nodes: what do nodes *log*? Default should be: nothing. Needs an explicit no-log configuration and statement.
4. ~~E2E scheme properties per profile~~ — **resolved**: deniability, FS, PCS-with-bounded-window and PQ phasing are defined in `PROTOCOL.md` (§6.4, §11.2–11.3, §15) and hold uniformly across profiles.
5. Identity backend for the open channel's P1: `PROTOCOL.md` assumes IK in an HSM (PPA/EPA); a zero-hardware onboarding path (software keystore, reduced assurance) is a product decision for onchato — see `ARCHITECTURE.md` open item 8.
