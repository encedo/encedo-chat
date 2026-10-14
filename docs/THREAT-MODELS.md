# v6 — Threat models

Status: **deployment-layer threat model for the shipping product** (onchato 0.7.x). Where a posture is designed but not built, the row says so — an auditor must be able to tell a control from an intention.

Layering: `SPEC.md` owns the **crypto-layer threat model** — adversaries in §2.2, weaknesses S1–S14 in §11.3; the PQ phasing is in `RATIONALE.md`. This document is the **deployment layer on top**: profiles P1–P3 as configuration presets, not separate builds. Users/deployments pick the profile matching their adversary. The enterprise channel (Encedo Chat: EPA, OIDC) and the open channel (onchato) are both expressed through these presets.

## Assets

| Asset | Where it lives |
|---|---|
| Message content | endpoints only (E2E; the network stores none of it) |
| Shared files (§7.5) | **ciphertext at rest for ~5 minutes** on an operator IPFS node; the CID is the capability, the key never leaves the envelope; the read gateway is public and unauthenticated |
| Social graph (who talks to whom, when) | partially observable as rendezvous metadata on discovery nodes |
| User IP / location | visible to the discovery node and the file store; on the direct plane also to the conversation peer |
| Long-term identity keys | HEM (HSM) — or, for a **software profile** (`SPEC.md` §4.5), a password-sealed blob on the user's disk: a different assurance tier, named as such |
| **The contact book — the trust anchor** | on device. Swapping a contact's `pub` re-aims the entire stack at the attacker with nothing failing (`SPEC.md` §4.4); the shipped control is a keyed MAC over the stored book, verified at sign-in, with tampering surfaced and never overwritten |
| **The profile export file** (§10) | wherever the user puts it — one sealed blob carrying identity + contacts + groups under the profile password; offline-attackable, file + guessed password = the identity |
| Node list / app integrity | a **manifest signed by the operator's root key in a YubiKey** (Ed25519; the public half is compiled into every client, `infra/root.pub`) names, with an expiry, the node list's CID and the CI updater key — and, from the operator's approval of each release (`scripts/approve-web.mjs`), the web app's CID, which an hourly monitor compares with what the host serves (`ARCHITECTURE.md` Distribution). A node-list refresh verifies the manifest's signature and date first, then fetches the list and checks it against the CID named (`lib/cid.ts`; CIDv1/raw/sha2-256 only — anything it cannot verify is refused). The list arrives through the operator's own `/f`, and the manifest through the operator's `/release/`: whoever shapes those responses without the root key changes nothing. Installers: three CI-held keys (updater minisign, Android keystore, Windows Azure Trusted Signing — behind the `release` environment's reviewer gate); the manifest names the updater key, so a client can tell a rotated one from a replaced one — the desktop updater refuses an installer whose signing key the manifest does not name, and refuses without a manifest at all |
| Service availability | discovery nodes (redundant, replaceable, self-hostable) |

## Baseline guarantees (all profiles)

- E2E with **post-quantum hybrid confidentiality from day 1** (EH-2: X25519 + ML-KEM-768) — "harvest now, decrypt later" is defeated in Phase 1; nodes see ciphertext flows only. No server-side storage of messages — a seized node yields its own key and live connection metadata, never messages or history. (Files: minutes of ciphertext, the one bounded exception.)
- **Deniability everywhere** (1:1 **and** groups — MAC/HMAC auth throughout, no signature in the protocol) and **forward secrecy** (ephemeral keys + Double Ratchet with bounded session lifetime, forced re-key every 4–8 h), with **post-quantum post-compromise security** inside a session (the ratchet mixes an ML-KEM secret into its root every fourth step or every 30 minutes, `SPEC.md` §7.2).
- **Single active session** (`SPEC.md` §9): a stolen device without the user's HSM cannot start new sessions, compute future topics, or post valid announces; an **already-open session survives at most until the next forced re-handshake (4–8 h)**, which requires the HSM. A detected duplicate makes **both** honest copies stand down (the user re-enters one deliberately); against a malicious client the lifetime timer is the guaranteed bound (§9.3). ⚠️ For a **software profile** the hardware bound does not exist — the re-handshake needs only the on-disk key; the seal password is the boundary (S12).
- Ephemeral client PeerIds; rotating room IDs (24 h, at a per-pair secret instant) bound discovery-layer linkage.
- Releases verifiable (per-artifact signing above); the node list pinned by content addressing.
- Anyone can audit (public code) and anyone can exit to a self-hosted network (own nodes per `relay/README.md`, and a build carrying its own network id and node list — `ARCHITECTURE.md`, Third-party networks) — the operator is replaceable, which is itself a security property: **the product must remain safe even from its maker.**

## Known limits (all profiles — honest boundaries)

1. Discovery node sees client IPs and rendezvous metadata (ephemeral PeerId ↔ roomID ↔ IP, timing). It sees a conversation as a **pair of sockets** on one topic, the number of topics each socket holds, and the Announce rhythm (`SPEC.md` §11.4). Rotation limits linkage over time; it does not hide the IP, and the pair re-appears together on the next day's topic. (One accidental narrowing: behind the reverse proxy the libp2p layer itself sees every client as loopback — the real IP exists in nginx's logs and in the `X-Real-IP` header nginx forwards to the relay, which reads it only in its debugging dump mode.)
2. **The direct plane reveals your IP to your conversation peer** (WebRTC ICE), and every direct attempt consults a STUN server that sees the client's IP and negotiation timing — **the operator's own since 2026-09-03** (`SPEC.md` §13), where it used to be Google's; the address is one the operator necessarily has, since the client is holding a connection to the same host. **Since 2026-09-03 it is off by default**: content goes through the node unless the user selects direct in Settings, so neither exposure is paid by anyone who does not ask for it. What that buys is IP privacy from the PEER — the node still sees the client's address, as it must to carry a connection, and the relay-blind plane that would narrow *that* is parked (`ARCHITECTURE.md` Transport). On the Linux desktop the channel is opened by the Tauri host rather than the webview (`SPEC.md` §3.2) — same exposure, same switch.
3. A global passive observer capable of traffic correlation across links defeats network-level privacy (no mixnet). Out of scope — stated, not hand-waved.
4. Compromised endpoint (malware, physical access) defeats everything; HEM confines *key theft* but not live-session abuse — which is in turn time-boxed by the forced re-handshake (4–8 h, §9.3). In the Tauri shells the handshake and ratchet keys live in the host process (`SPEC.md` §3.2, since 0.7.31; Diagnostyka shows which engine a session used), so a compromised webview can drive the session but not read its keys; in a browser they live in the page (the WASM module).
5. Availability of a conversation requires both parties online — by design (instant-only), but it is also the DoS surface: jam the rendezvous, prevent the meeting.
6. **The file store sees file metadata** (`SPEC.md` S11): blob size, timing, fetch pattern and IPs for ~5 minutes per file, on an unauthenticated public gateway. Text has no such surface.
7. **Authentication is classical until Phase 3** (`SPEC.md` S9): confidentiality is PQ-hybrid now, but a future CRQC-equipped adversary could impersonate users in *new* handshakes. Mitigated by the in-band migration path (target 2030 — before CRQC estimates of 2035+). Past traffic is never at risk.
8. **The operator's network is not provided everywhere — a sanctions geoblock (since 0.7.4).** Every node of the main network answers HTTP 451 on every onchato path, and its STUN responder stays silent, for addresses geolocated (DB-IP Country Lite, refreshed weekly) in **KP, IR, CU, RU, BY, SY**; the app and the CLI probe a node's `/health` and say "not available in your region" rather than failing silently (`ARCHITECTURE.md`, `infra/geoip/`). Alongside it an operator-kept **abuse list** (addresses, networks, whole ASNs, each with an expiry) is dropped at the edge (444); it lives on the operator's machine, never in the repo. **Why — the regulatory reasoning, recorded so the threat model is honest about who is excluded and by whose decision:** the operator (RKV sp. z o.o., an EU company) is bound by the EU's restrictive measures, and its distribution channels (GitHub, Google Play, the App Store) are US-governed and bound by OFAC's. North Korea is the one case where the block follows almost directly from law (UN, EU and US regimes together). For the other five the block is **the operator's risk policy, not a legal obligation**: EU measures are mostly *targeted* (asset freezes and a prohibition on making resources available to listed persons — hence the terms-of-service clause that listed persons and entities may not use the service), the Russia/Belarus service bans (art. 5n of Regulation 833/2014) are aimed at companies and the state rather than private messaging, Syria's economic sanctions were lifted in May 2025 with targeted ones remaining, and for Iran OFAC's General License D-2 (2022) explicitly permits personal-communication software — which is why some messengers still serve it. What tips the decision is enforcement practice on the US side: where a prohibition does apply, regulators have penalised the *absence* of IP-based blocking (the Kraken settlement, 2022), and a GeoIP block is what counts as "reasonable measures" — it is accepted that a VPN walks around it, and no more than that is expected. Open-source cryptographic software is itself outside dual-use export control (Regulation 2021/821). **Cost, stated plainly:** the list excludes people for whom an encrypted messenger matters most, and GeoIP is coarse (the occupied regions of Ukraine cannot be told apart from UA/RU ranges). **Scope:** this is a property of the *operator's* network, enforced at its reverse proxy — not of the protocol, not of the code, and a self-hosted network (own nodes and an own build, `relay/README.md`, `ARCHITECTURE.md`) carries none of it; the P3 posture is self-hosted precisely so that no operator policy stands between a deployment and its users. The country list lives in one file (`infra/geoip/blocked-countries`) and the reasoning in the operator's legal notes; neither is legal advice and both are to be reviewed with counsel.

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

**A1b. The development switches in the bundle.** The build under audit answers
two URL parameters (`SPEC.md` §11.4): `?debug=1` narrates the protocol to
the browser console with values elided, and `?keys=1` prints the secret
material itself — chain keys, the pair secrets from the device. Both reach
only the console of a page the user opened with that address, so they add
nothing to A1 (code that runs in the page already has it all); what they add
is a *paste* surface — a console copied into a bug report carries whatever
the switch printed. A release build is made with `EC_ALLOW_KEYS=0`, which
compiles the second switch out so that no address can bring it back; the
first stays, and prints no secrets.

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
shipped controls are per-artifact signatures, public code, and - since 0.7.13 -
an **operator root key in a YubiKey** whose manifest names the CI updater key,
so a swapped CI key no longer verifies against what every client carries.
The desktop updater reads the manifest before it downloads and again before
it installs: no manifest, no update; a manifest naming another updater key,
no update. What this leaves: a CI compromise that keeps the CI key and ships a
backdoor signed with it, on a release whose manifest is current. Closing that
is the bundle's own CID under the root signature, per release, which is a
signing step per release and a decision deferred for now.

**B3. The operator serving A1 deliberately.** The same code path as a
compromise, minus the compromise. Stated because "safe even from its maker" is
only meaningful if the ways the maker could betray it are written down: the web
tier can be backdoored per-session, per-user, invisibly. The packaged tier
cannot, without leaving a signed artifact behind — a copy of the crime.
What narrows it for the web: the CID of `index.html` pins every byte the app
origin executes (one bundle under SRI, with the encryption module inlined into
it), each release's CID is signed with the root key once the operator has built
the tag independently and found the same CID (`scripts/approve-web.mjs`), and an
hourly monitor turns red when the served CID is neither the signed one nor one
CI built for a recent tag. That catches a swap served to everyone. It cannot
catch a swap served to one chosen person: only a check on the client's side can
(a verifying extension, the packaged app, or a manager on a device the person
already trusts), and none is shipped for the web.

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
which sees them all. Bounded by per-IP connection and request limits at the
edge, by the node's topic ceilings (per node and per peer, with idle
eviction — the production numbers are in `ARCHITECTURE.md`), and by the 64 KiB
frame bound, enforced by the client and by the node alike — a PUSH past it is
refused, a GossipSub message past it ignored, one inbound RPC bounded at 1 MiB
(`SPEC.md` §5.6).

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

**F4b. An inbox nobody was invited to.** A published invite (`SPEC.md`
§5.7) names a topic from a secret printed on a page, so everyone who read the
page can subscribe to it and publish to it — by design, since that is what
makes it answerable by a stranger. What an observer gets is that a fixed-size
frame arrived and when, never from whom, and cover traffic (§5.9) empties even
that of meaning. What a flooder gets is the recipient's attention: bounded at
20 surfaced knocks a minute, which protects attention and is not a security
boundary. The answer to an unwanted inbox is to retire that invite, which is
why there are several and why each dies alone.

**F5. A cryptanalytically relevant quantum computer.** Confidentiality is
PQ-hybrid from day one, so recorded traffic stays shut. Authentication is
classical until Phase 3 (S9): such an adversary could impersonate users in
*new* handshakes, which is why the migration has a date and not a hope.

**F6. Coercion.** Deniability answers a judge, not a person holding the phone.
There is no duress mode, no panic wipe and no decoy profile. Listed because
somebody will otherwise assume deniability covers it.

**F7. A contact who floods you.** A 128 MB file every minute: bounded by the
file size cap, by the per-IP upload limits (twenty uploads a minute, four at
once — a file a minute sits well inside them, so they bound a flood, not this),
and above all by the fact that nothing is fetched unless the recipient asks —
auto-fetch is off by default and, when turned on, stops at 2 MiB and at 1:1
peers (`SPEC.md` §7.5).

**F8. An attacker who records everything today and waits for the pair secret to
leak.** Nothing follows. The pair secret is rendezvous-only and **disjoint from
every message-key DH** — it derives topics, the Announce MAC and the rotation
instant, and never a message key. A leak years later still yields metadata
linkability of that pair, never content. This is precisely why the disjointness
is written into the protocol and not merely observed.

### Blast radius — what each compromise actually costs

Scenarios say what an attacker does. This says what it *costs*, which is the
question anybody deciding whether to deploy this asks first. Three columns on
purpose: what is lost, for how long, and — the column usually missing — what is
**not** lost, because a compromise that takes everything and one that takes a
session are not the same event and must not read the same way.

"History" appears in none of these rows for one reason: there is none. A
transcript lives in the page and dies with it. What persists on a device is the
contact book, the group cache (sealed at rest under a key derived from the
identity — on a HEM profile, unsealing it needs the device) and the settings.

| Compromise | What is lost | For how long | What is NOT lost |
|---|---|---|---|
| **Web bundle replaced / malicious extension** (A1, A2) | full use of the identity: impersonation toward any contact, the contact book, new groups | while the window is open; with a stolen authorisation pair, until the password changes | past traffic (ephemeral, and forward-secret), the identity key itself (never leaves the HEM), any other device |
| **Packaged app backdoored via the update channel** (B2) | the same, on every machine that auto-updated | until a clean build is installed | the identity key; past traffic. But this is the widest-reaching event in the system, which is why the offline root key is an open item |
| **Laptop stolen, session open** | the live session: read and write as the user | until the window closes, bounded by the forced re-handshake at **4–8 h per peer** (needs the device) | everything after that, absent the HEM and the password; no remote wipe exists, so this bound is the control |
| **Laptop stolen, session closed — HEM profile** | nothing usable — except, on a packaged desktop built with the diary on (the default; `EC_DIARY=0` builds it out), the plain connection diary: which contacts (by 12 characters of key) were seen when (`SPEC.md` §10) | — | the identity (in the device), the group cache (sealed under a device-derived key), future sessions |
| **Laptop stolen, session closed — software profile** | the sealed identity blob, open to offline guessing at 1M PBKDF2 rounds; the same plain diary on the desktop | until the password is guessed; forever if it is weak | nothing else, and this row is precisely the tier difference the product asks users to choose with open eyes |
| **HEM stolen on its own** | nothing | — | everything: it is locked, and unlocking needs the password — with authenticator-based authorisation, the phone too |
| **Password stolen on its own (HEM profile)** | nothing by itself | — | everything, until the attacker also reaches the device. This is the property the second factor exists to keep |
| **Authorisation key pair exfiltrated** (A3) | the ability to authorise device operations from anywhere with network reach to the HEM | **until the password changes** — the salt is stable, so this outlives every token | content already sent; the key itself |
| **Discovery node seized or hostile** (B1) | metadata: client IPs, topic ids, sizes, timing, and the ability to deny service | while that node carries the client — a client can move to another, or self-host | all content, every key, the ability to forge an Announce or join a room |
| **File store seized** (B4) | ciphertext blobs, their sizes, fetch times and fetcher IPs | **~5 minutes per file**, by retention | file contents (the key rides in the envelope, never in the store), text messages, which never touch it |
| **A contact's device compromised** | everything you ever sent *that contact* | permanently — they hold it | every other conversation; and deniability still denies a third party the proof that you wrote it |
| **Pair secret `ss` leaked — today** | metadata linkability of that one pair: their topics and Announce MACs, past and future | until that identity key rotates | **all content, always** — `ss` is rendezvous-only and disjoint from every message-key DH |
| **Pair secret leaked — after in-device HKDF** | the same, for one rotation window | until the window ends | the same, plus the secret itself, which never left the device |
| **Profile export file stolen** (§10) | identity, contacts and groups in one sealed blob, open to offline guessing | until the password is guessed | nothing, if the password holds. The file is the single densest asset this product produces — treat it accordingly |

Two readings worth taking from the table rather than from any single row.

**The HEM's value is visible in the "for how long" column, not in "what is
lost".** Almost every row where the device is present ends in a bound: the
window closes, the re-handshake falls due, the rotation window ends. Where it is
absent — the software profile, the export file — the bound is a password and the
attacker's patience.

**The two rows that end in "until the password changes" are the ones worth
engineering away**, and both are the same defect: a long-lived authorisation
secret sitting in a process. That is the case for a human action per
authorisation, and the reason a second factor changes the shape of this table
rather than merely adding a step.

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

**Config preset**: node-only transport — shipped as the **default user setting** (Settings → transport: no `rtc` envelopes are sent, no STUN is consulted, limit 2), but **not yet as an enforced preset** a user cannot flip, nor as a build that pins it; Tor/VPN underneath (the TCP/WSS path is Tor-compatible; WebRTC/UDP is not, which is why direct must stay off), **installed app only** (web channel is takedown-able and injectable), node list carried by the installed build rather than fetched from the primary domain.

**What this defeats (as shipped)**: domain seizure (app already installed with its node list), endpoint blocking (nodes behind nginx on 443/WSS blend with ordinary TLS; the list can rotate via a new build), peer-side IP exposure as long as the setting is left at its default. **What needs the enforced preset**: peer-side IP privacy that does not depend on a preference.

**Residual risk**: discovery-node metadata (mitigated by Tor: node sees exit IP); rendezvous jamming/DoS by the censor; traffic correlation if the adversary observes both the user's uplink and the node.

## P3 — Critical infrastructure / state-level target

**Adversary**: nation-state with legal power over the operator, ability to seize or compel nodes, supply-chain leverage, long-term targeted collection.

**Key posture change: the operator is *outside* the trust boundary.** The deployment must not depend on our infrastructure, our node list, or our goodwill.

**Config preset**: fully independent network — own nodes (`relay/README.md`; Docker image is roadmap), own build carrying its own network id and node list (`EC_NETWORK` at build time; `--network` on the terminal client); HEM mandatory for all identities (**never** software profiles); installed app only; deployment inside a controlled network perimeter where applicable. Two P3 prerequisites are **open items, named**: an enforced node-only transport (the setting ships, the lock does not — limit 2) and an ephemeral-enforced cache policy (no switch exists today — pins and the group cache are always available); reproducible builds are verified per release for the web (`docs/REPRODUCIBLE.md`), not for the installers.

**What this defeats**: compelled-operator scenarios — an independent deployment carries nothing the operator can be compelled to hand over or sabotage.

**Residual risk**: the deployment's own opsec (signing-key handling, node hosting jurisdiction, **profile-export files** — treat the file as the identity); endpoint compromise; global traffic correlation (out of scope — if this is in the adversary model, this product alone is insufficient and must sit behind additional network anonymization).

---

## Profile → configuration matrix

| Setting | P1 | P2 | P3 |
|---|---|---|---|
| Transport | node-only by default, direct opt-in (shipped) | node-only as the user's setting (shipped); **enforced preset not built — Tor under WSS today** | node-only **(same gap)** |
| Network | operator (applies the sanctions geoblock, limit 8) | operator (same) | self-hosted (no operator policy) |
| App channel | web or installed | installed only | installed only; the web build is reproducible and verified per release in CI (`docs/REPRODUCIBLE.md`), the installers are not |
| Tor/VPN | optional | recommended | per deployment policy |
| Node list source | compiled-in + CID refresh | the installed build's own copy | own build, own list |
| Identity backend | software profile (shipped, §4.5) or PPA | PPA/HEM recommended | EPA or PPA **mandatory** |
| Local stores (§10) | identity-gated encrypted stores; transcript RAM-only | same (wipeout is the user's action) | ephemeral-enforced **(no policy switch yet — open item)** |

## Open questions

1. Rendezvous DoS resistance (P2/P3): can a censor who learns nothing from roomIDs still jam rendezvous wholesale? (Blocking nodes ≈ blocking HTTPS; per-IP limits at nginx are the deployed flood control — `relay/README.md`.)
2. Reproducible builds — **answered for the web** (`docs/REPRODUCIBLE.md`: two independent builds per tag, the host checked against them, the report a release asset); the installers remain unreproducible by packaging, so P3 credibility for them rests on the signature chain, not on a rebuild.
3. Node logging — **answered by the running config and now written down** (`SPEC.md` §11.4): the per-message journal line is a flag the production nodes leave off; topics joined and evicted are logged with the full topic id, connections with a truncated PeerId; aggregate counters are kept 30 days; the JSON metrics endpoint stays on loopback; the real address exists in nginx's access log and in a header the relay reads only in its debugging dump mode; payloads never. A formal no-log statement for third-party operators remains to be written.
4. ~~E2E scheme properties per profile~~ — **resolved**: defined in `SPEC.md` (§6.4, §11.2–11.3) and the PQ roadmap of `RATIONALE.md`, uniform across profiles.
5. ~~Identity backend for the open channel~~ — **resolved: the software profile ships** (`SPEC.md` §4.5), with its assurance difference recorded as S12 and in the Assets table.
