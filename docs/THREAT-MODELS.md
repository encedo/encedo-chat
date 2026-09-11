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
2. **The direct plane reveals your IP to your conversation peer** (WebRTC ICE), and every direct attempt consults a STUN server that sees the client's IP and negotiation timing — **the operator's own since 2026-09-03** (`PROTOCOL.md` §13), where it used to be Google's; the address is one the operator necessarily has, since the client is holding a connection to the same host. **Since 2026-09-03 it is off by default**: content goes through the node unless the user selects direct in Settings, so neither exposure is paid by anyone who does not ask for it. What that buys is IP privacy from the PEER — the node still sees the client's address, as it must to carry a connection, and the relay-blind plane that would narrow *that* is parked (`ARCHITECTURE.md` Transport). The Linux desktop is node-only whatever the setting says (no WebRTC in its webview).
3. A global passive observer capable of traffic correlation across links defeats network-level privacy (no mixnet). Out of scope — stated, not hand-waved.
4. Compromised endpoint (malware, physical access) defeats everything; HEM confines *key theft* but not live-session abuse — which is in turn time-boxed by the forced re-handshake (4–8 h, §9.3). The hardened shell tier that would narrow webview compromise is roadmap (`PROTOCOL.md` §3.2) — today ratchet state lives in the webview on every platform.
5. Availability of a conversation requires both parties online — by design (instant-only), but it is also the DoS surface: jam the rendezvous, prevent the meeting.
6. **The file store sees file metadata** (`PROTOCOL.md` S11): blob size, timing, fetch pattern and IPs for ~5 minutes per file, on an unauthenticated public gateway. Text has no such surface.
7. **Authentication is classical until Phase 3** (`PROTOCOL.md` S9): confidentiality is PQ-hybrid now, but a future CRQC-equipped adversary could impersonate users in *new* handshakes. Mitigated by the in-band migration path (target 2030 — before CRQC estimates of 2035+). Past traffic is never at risk.
8. **The MQTT fall-back transport trades metadata for reach**: any connected client can observe every room's activity/timing/size (a static broker ACL cannot scope reads to runtime-secret rooms — README). Content stays E2E. Do not enable it where cross-room metadata to a connected observer is unacceptable; GossipSub does not have this surface.

---

## Attack scenarios — what an attacker actually does

The sections above state properties; this one states *stories*, because a limit
is easy to nod at and a scenario is not. Everything here is written from the
attacker's side: what they do, what it gets them, what stops them, and what
still hurts. A few are deliberately far-fetched — they are kept because the
boundary they illuminate is real, and an absurd scenario that has an answer is
worth more than a plausible one that does not.

Nothing below is a discovered vulnerability. This is the map, drawn on purpose.

### A. The endpoint — the attacker is inside the app

**A1. Modified JavaScript served to the web client.** The bundle comes from our
own host; whoever controls that host, or the TLS path to it, controls the code
running in every browser tab. That code inherits the session's full authority:
it can ask the HEM for an ECDH against any peer key, read and rewrite the
contact book, mint groups — all without the key ever leaving the device, which
is exactly the point. **The HEM is not a control against this**; it confines
key *theft*, not key *use*. The stale-bundle banner is likewise not a control:
it compares a content hash to decide "you are out of date", not "you are
authentic". The packaged builds are signed (updater minisign, Android
keystore), the web bundle is not — which is the whole argument for
recommending the packaged app where it matters, and the known price of the web
convenience tier.

**A2. A malicious browser extension.** Same authority as A1 with none of the
work: no host to compromise, no certificate to forge. Entirely outside this
project's reach. The packaged shell has no extension surface, which is an
argument for it that costs us nothing to make.

**A3. Theft of the password-derived key pair.** Authorisation derives an X25519
pair from `PBKDF2(password, eid)` where `eid` is a **stable** salt, and holds it
in memory so later authorisations need no password. That pair is therefore
*password-equivalent*: exfiltrated once, it authorises device operations from
anywhere with network reach to the HEM, until the password changes — longer
than a stolen 5-minute token by any measure. **Planned control**: authorisation
through the authenticator app instead of a password, which requires a human
action on a second device per authorisation; with multi-scope tokens in newer
firmware, one interaction can cover a burst of work. That trade — one deliberate
tap against silent reuse — is the security-versus-convenience decision this
system has to make explicitly rather than by default.

**A4. Ordinary malware that never touches the app.** Screen capture,
accessibility APIs, a keylogger. Defeats everything, by definition (limit 4).
The corollary is worth saying out loud once: a phone camera pointed at the
screen is a complete break of a messenger with perfect cryptography, and no
protocol change will ever address it.

**A5. A covert second session on the same identity.** §9.1 has both copies
stand down, so parallel use is *noisy* rather than silent — the user sees the
duplicate notice. It does not help against code riding the session already
open in the same page, which is A1.

### B. The operator — the "safe even from its maker" test

**B1. A malicious or seized discovery node.** Sees ciphertext frames, sizes,
timing, client IPs and topic ids. Cannot read content, cannot forge an Announce
(the MAC key derives from the pair secret it does not have), cannot join a room
undetected. It *can* deny service, and it can build a metadata graph — which is
why the node is replaceable and self-hostable by design.

**B2. A poisoned release.** CI holds the signing keys; a compromised workflow or
a stolen minisign key ships a signed backdoor to every desktop that auto-updates.
This is the **highest-leverage attack on the entire system** — better than any
cryptanalysis, because the update channel is trusted by construction. The
shipped controls are per-artifact signatures and public code; the missing one is
an **offline operator root key**, which the assets table already records as an
open item rather than a control.

**B3. The operator serving A1 deliberately.** The same code path as a
compromise, minus the compromise. Stated because "safe even from its maker" is
only meaningful if the ways the maker could betray it are written down: the web
tier can be backdoored per-session, per-user, invisibly. The packaged tier
cannot, without leaving a signed artifact behind — a copy of the crime.

**B4. The file store.** Ciphertext for minutes, plus size, timing and fetch IPs
on a public unauthenticated gateway; the upload door has to stay open (a browser
app holds no secret), so its defence is tempo, not authentication — per-IP rate
limits since 2026-09-11.

### C. The network

**C1. TLS or DNS hijack of the app's origin.** Delivers A1 without touching our
hosts. Certificate transparency and HSTS raise the cost; nothing in the product
detects it. The packaged app narrows this to the update channel, where a
signature is checked.

**C2. The user's own router.** Observed benignly on 2026-09-11: a firmware
update restarted it and every client on that network dropped simultaneously for
about seventy seconds. A hostile router does the same indefinitely (denial), or
mints a trusted certificate and becomes C1.

**C3. Rendezvous flooding.** An attacker who knows a topic id can publish noise
into it. Knowing one requires being a member of that pair — or being the node,
which sees them all. Bounded by a 64 KB frame cap, a 250-topic ceiling with idle
eviction, and per-IP limits at the edge.

**C4. A global passive observer** correlating traffic across links defeats
network-level privacy. Out of scope, and stated rather than hand-waved.

### D. The peer

**D1. The contact who is not who you think.** Swapping a `pub` re-aims the whole
stack with nothing failing — the reason the contact book is listed as the trust
anchor. A *known* key that changes is caught and named ("you already hold a
contact of this name with a DIFFERENT key"); a **first** contact has nothing to
compare against, so an out-of-band fingerprint check is the only control, and
QR exists to make it cheap.

**D2. The peer who keeps everything.** Deniability means they cannot prove to a
third party that you wrote it; it has never meant they cannot keep it. Anyone
you talk to can screenshot the conversation, and no design here changes that.

### E. Physical

**E1. A stolen HEM.** Locked; useless without the password (and, with
authenticator-based authorisation, without the phone too). This is the case the
device exists for and the one it handles cleanly.

**E2. A stolen laptop with the session open.** Full authority until the window
closes, bounded by the forced re-handshake at 4–8 h, which needs the device.
There is no remote wipe and no idle lock — an honest gap, not an oversight:
both are meaningful only with a management plane this product does not have.

**E3. A memory dump of a live session.** Ratchet state, the pair secrets, the
derived authorisation keys. In-device HKDF removes the pair secret from that
dump — see the note below on what that does and does not buy.

### F. Theoretical, and one or two frankly absurd

**F1. Malicious HEM firmware.** A device that computed a DH against the
attacker's key, or leaked the identity key, would defeat everything built on
it, and the client cannot tell. The SDK exposes a device **attestation**
endpoint; the app does not call it. That is an available control left unused,
which is worth knowing before somebody assumes hardware implies verification.

**F2. A backdoored dependency.** An npm package that publishes a subtly broken
X25519 or a biased RNG. Lockfiles pin versions and the code is public; nothing
stronger is in place, and no amount of protocol design substitutes for it.

**F3. A clock pushed forward a day.** Topics and the rotation instant derive
from UTC dates, so a client with a wrong clock derives a topic nobody else is
on and simply finds an empty room — silent denial, self-healing when the clock
returns. The ±30 min overlap window absorbs ordinary skew, not sabotage.

**F4. A poisoned invite.** A QR or link adds the attacker as a contact. Against
a key you already hold, the app answers with verification; against a first
contact there is nothing to verify against except a fingerprint read aloud.

**F5. A cryptanalytically relevant quantum computer.** Confidentiality is
PQ-hybrid from day one, so recorded traffic stays shut. Authentication is
classical until Phase 3 (S9): such an adversary could impersonate users in
*new* handshakes, which is why the migration has a date and not a hope.

**F6. Coercion.** Deniability answers a judge, not a person holding the phone.
There is no duress mode, no panic wipe and no decoy profile. Listed because
somebody will otherwise assume deniability covers it.

**F7. A contact who floods you.** A 128 MB file every minute: bounded by the
upload rate limit, the file size cap, and the fact that nothing is fetched
automatically unless the recipient turned that on.

**F8. An attacker who records everything today and waits for the pair secret to
leak.** Nothing follows. The pair secret is rendezvous-only and **disjoint from
every message-key DH** — it derives topics, the Announce MAC and the rotation
instant, and never a message key. A leak years later still yields metadata
linkability of that pair, never content. This is precisely why the disjointness
is written into the protocol and not merely observed.

### What moving HKDF into the device does — and does not — buy

Deriving the rendezvous material inside the HEM (`ecdhDerive`) removes the raw
pair secret from client RAM entirely. That narrows **E3** and the
metadata-linkability limit noted against the current firmware, and it changes
the shape of what an attacker can steal: a per-window derived value expires at
the window boundary, where the raw secret was good until the identity key
itself rotated. A permanent capability becomes a time-boxed one, which is a
real gain.

It does **not** touch A1–A3. Code inside the session can still ask the device to
derive for any peer it likes; the device authorises an *operation*, never an
*intention*. The control that addresses that class is a human action per
authorisation (A3), not a better key derivation. Both are worth doing, and it is
worth not confusing one for the other.

---

## P1 — Private / casual

**Adversary**: commercial surveillance, ISP snooping, opportunistic attackers, platform data harvesting. Not targeted by a state.

**Config preset**: operator network; direct plane **available but not selected** (Settings → transport; content goes through the node until someone chooses otherwise); web or installed app; default node list. **This is the shipped default.**

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
