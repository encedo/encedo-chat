# v6 — SPEC.md

Normative protocol specification of the shipped implementation (`impl/`). **`spec_version` 3.0.** On the wire: `ver = 3` on the EH-2 frames and the ratchet header, `version = 3` on the group frame, `v = 3` on the Announce, `v = 1` on the application envelope. One `ver` names one spec version: a client accepts exactly the versions written here and nothing earlier, and the known-answer vectors of `docs/kat/` (§12) belong to this version.

This document states what is on the wire, what is derived and how, and what a conforming client accepts or refuses. It is kept 1:1 with the code: a wire behaviour the client has and this document omits, or the reverse, is a defect in one of them. The reasoning behind the choices, the alternatives considered, the roadmap and the open questions are in `RATIONALE.md`; product and infrastructure in `ARCHITECTURE.md`; deployment profiles and adversary tiers in `THREAT-MODELS.md`.

---

## 1. Conventions

- `a ‖ b` (also written `a || b`) is byte concatenation. `u8`, `u16be`, `u32be`, `u64be` are unsigned big-endian integers of that width. `∅` is the empty byte string.
- `HKDF-SHA256(ikm, salt, info, L)` is RFC 5869 with SHA-256. **Every derivation in this document uses one convention:** the label is `info`, the context (a date and network id, `h1`, a root key, a group id and epoch, an invite secret, a message counter) is `salt`, and `salt = ∅` where there is no context (§14, "KDF convention"). Swapping the two derives a different key. The local stores of §10 are the stated exception.
- `HMAC` is HMAC-SHA-256; `SHA-256` and `SHA-512` are FIPS 180-4; `AES-256-GCM` has a 96-bit nonce and a 128-bit tag; `X25519` is RFC 7748; `ML-KEM-768` is FIPS 203.
- `base32` is RFC 4648, lowercase, no padding. `base64` is standard with padding unless `base64url` is named.
- Byte strings written as `"..."` are UTF-8 without a terminator.
- A frame parses exactly or not at all: trailing bytes, a length that does not fit, or an unknown version are rejected, and rejection is silent on the wire.

---

## 2. Goals and assumptions

### 2.1 Security goals

| Goal | Meaning |
|---|---|
| Confidentiality | Message content is available only to the conversation's participants |
| Integrity | In-transit modification is detected |
| Mutual authentication | Both sides authenticate through their long-term identity key |
| Forward secrecy (FS) | Compromise of a long-term key does not expose past sessions |
| Post-compromise security (PCS) | Compromise of ratchet state heals after new ratchet steps |
| PQ hybrid | Confidentiality holds if either X25519 or ML-KEM-768 survives |
| Deniability | After a session, neither side holds cryptographic proof that the other authored a message |
| Metadata privacy | An off-path network observer cannot determine who talks to whom from transport traffic alone (what a discovery node sees is §11.4) |

### 2.2 Adversaries

In scope: a passive network observer (all libp2p traffic, GossipSub topics, DataChannel flows; TLS 1.3, DTLS and libp2p Noise are not broken); an active MITM on the transport; compromise of a long-term identity key; compromise of ratchet state (device theft with a live session); compromise of individual message keys; quantum "harvest now, decrypt later".

Out of scope: compromise of the HSM itself; compromise of the endpoint (plaintext at display time); statistical traffic analysis (timing and size); coercion; flooding of the rendezvous nodes beyond what the per-address limits at the reverse proxy absorb.

### 2.3 Environment assumptions

- The HSM implements its primitives correctly and protects private keys.
- TLS 1.3 between client and HSM negotiates X25519MLKEM768.
- HSM and client have a CSPRNG.
- Clocks are within ±5 min of UTC (§5.4 states the anchor the client applies).
- Contact public keys are imported out of band (QR, invite link, admin enrollment) and verified out of band (§4.4). The protocol does not establish trust.

### 2.4 Model

Synchronous: both parties are online for a message to cross; the network stores nothing for the text path (the one bounded exception is a shared file's ciphertext, §7.5; a client may keep an outbox of its own, §13). One active session per identity (§9). Contacts are imported out of band. Groups use sender keys over the pairwise sessions (§8).

---

## 3. Architecture

```
UI                          replaceable front-ends (web, CLI, shells)
Core API                    commands / events / snapshot
Message layer               application envelope (§7.4) · local cache (§10)
Session layer               EH-2 handshake (§6) · Double Ratchet (§7) · Sender Keys (§8)
Identity & rendezvous       IK in the identity backend · deterministic topics · Announce · self-topic (§4, §5, §9)
Transport                   control + fallback content through a node; 1:1 direct content over WebRTC (§13)
libp2p                      WebSocket Secure, Noise, yamux; pick stream or GossipSub
Identity backend            HEM REST over TLS 1.3, or a password-sealed software key (§4.5)
```

The protocol assumes no security property of libp2p beyond hop-to-hop transport encryption; every guarantee comes from the session layer.

### 3.1 Responsibility split

- **Identity backend** (HSM or software identity): key management (create, import, delete, search) and two operations on `IK`: raw `ecdh`, and the derivation `HKDF(ECDH(IK, peer), salt = ctx, info = label, L)` for every rendezvous, Announce, rotation, invite and group-MAC key (§4.3). No frame received from the network reaches the identity backend except a contact's handshake: a msg1 reaches the one DH with `IK` only once its initiator tag has matched (§6.1). A backend that cannot derive in-device derives over its raw `ecdh` output in the client; the labels, contexts and outputs are identical either way.
- **Client**: all ephemeral operations (EK, ML-KEM keygen/encapsulation/decapsulation, AEAD, ratchet), all HKDFs, session state, cache, presence.
- **libp2p**: publish/subscribe for rendezvous, handshake frames and the fallback content path; a WebRTC DataChannel where both ends can open one.

### 3.2 Clients

One TypeScript engine is consumed by the web app, the terminal client and the Tauri 2 shells (Linux, Windows, macOS, Android, iOS). The shells wrap the same web bundle: the engine runs in the webview on every platform, except the handshake and ratchet keys, which the shells hand to their host process (below), and the Linux DataChannel. Crypto comes from WebCrypto (X25519, HKDF, HMAC, SHA-256, AES-GCM, PBKDF2) and from `@noble/post-quantum` for ML-KEM-768, the single third-party crypto dependency on the message path. On the Linux desktop the webview exposes no `RTCPeerConnection`; there the Tauri host opens the DataChannel (`webrtc-rs`) behind the same link interface the browser implements, and because the host advertises no `a=max-message-size`, every DataChannel frame is bounded at 65 536 bytes (§13.1).

The hardened tier is `core-rs`: a Rust implementation of §6–§7 (the handshake, the ratchet, the hybrid step) that the clients run as a WASM module (the default; `?core=ts`, `--core ts` select the TypeScript engine, and a platform that cannot load the module falls back to it). Both produce and accept the same frames, and the known-answer vectors of §12 pin both. In the module, `EK`, the ML-KEM keys, `SK` and every ratchet key live in its linear memory and are zeroed there; the identity key's one DH per handshake stays with the identity backend. In the Tauri shells (desktop and mobile) the same crate runs natively in the host process and is the default there (`?core=wasm`, `?core=ts` select the others): those keys then live outside the webview process altogether. A host that does not answer falls back to the module, and a module that does not load falls back to the TypeScript engine, for the rest of the process. The native host's commands are driven through Tauri's own command dispatch by an automated harness (`impl/test/native-ipc.test.ts`); the platform webview's message transport underneath is validated on devices by hand.

### 3.3 No application server

There is no prekey server, directory service or message relay for text. The central points are the identity backend (an HSM, per tenant or personal), the discovery nodes (§5.6) and, for shared files only, an operator-run store that holds ciphertext for minutes (§7.5).

---

## 4. Identity and keys

| Key | Type | Where | Lifetime | Used for |
|---|---|---|---|---|
| **IK** | X25519, purpose `ecdh` (HEM flag) | HSM, or password-sealed on device (§4.5) | permanent | EH-2 DHs, every rendezvous derivation. **Never signs.** |
| **EK** | X25519 | client RAM | one handshake (the initiator's EK is also its first ratchet key, §6.2) | EH-2 forward secrecy |
| ML-KEM pair | ML-KEM-768 | client RAM | one handshake; one hybrid step (§7.2) | PQ hybrid component |
| Ratchet state (RK/CK/MK) | symmetric | client RAM | session | per-message keys |
| Sender key (`chain_key`) | symmetric | client, sealed cache (§10) | group epoch | group messages (§8) |
| **GK** | X25519 | admin: a keypair in the identity backend; member: the `GK_pub` entry | group lifetime | group marker and roster MAC (§8) |
| `emp_pub` | X25519 public value | localStorage, plain | per profile | the device half of the §10 cache base |
| libp2p PeerId | Ed25519 (libp2p) | client RAM | one app start | transport only; unlinked to IK |
| Node key | Ed25519 (libp2p) | derived from the node's `--pass` seed | permanent | node identity, pinned in the node list (§5.6) |

### 4.1 Key per purpose

`IK` signs nothing: the handshake authenticates by MAC (§6), groups by ECDH-derived HMACs (§8), and topics rest on ECDH alone. **There is no signature anywhere in the protocol.** `IK` is native X25519 with the HEM purpose flag `ecdh`; no key is shared with another product; no dormant key is provisioned.

### 4.2 Identity records (DESCR)

Two HSM fields: `label` (32 bytes of UTF-8, what the device's own key list shows) and `descr` (128 bytes, fixed record, silently truncated by the device; what the client searches and reads). `key_search` matches an anchored prefix on the first six bytes, so every prefix is at least six bytes and carries a generation digit.

```
IK     label  Onchato-IK-<handle>                       (truncated to fit)
       DESCR  ETSEIC:self1,<handle>
PEER   label  Onchato-Peer-<name>                       (truncated to fit)
       DESCR  ETSEIC:peer1,<owner_KID base64url>,<name>
GROUP  the marker of §8.6, on the GK_pub entry
```

- **The identity's id is the KID of its own IK entry**, `KID = SHA-1(pub)[0:16]` — the device's index on key content, so the same identity on another device has the same id.
- **Contacts are scoped by the owning identity's KID**: `ETSEIC:peer1,<owner_KID>,` returns one identity's contacts. Fixed-width identifiers come first, free text last, and the name is read as the whole tail (it may contain the delimiter).
- **A public key is held once per device**: the device refuses to import a key it already holds under any DESCR. The client predicts this from the KID (one broad `key_search("ETSEIC:peer1,")` on the add path) and names the identity that already holds the contact.
- All per-identity client state is keyed by the KID, never by the handle. The one record keyed by name is the sealed software identity itself (`ec-soft-id-<name>`, §4.5).
- **Fingerprint** = `SHA-256(pub)[0:8]`, shown as sixteen uppercase hex digits in colon-separated pairs. It identifies a key (telling entries apart, keying local records such as §5.7's ignore list); it does not verify one — verification is the safety number of §4.4.1.
- **Invite link**: URL fragment `#i=base64url(JSON { p, n, r?, s?, k? })` — `p` the public key (base64, exactly 32 bytes), `n` a display name (≤ 64 characters, with control, format and line/paragraph-separator characters stripped; empty after that rejects the link), `r` marks a reply to an invite when present and truthy (clients write `1`) (the receiver adds the contact without sending its own key back), `s` the 32-byte `invite_secret` of a published invite (§5.7, base64), `k` that invite's 32-byte `invite_pub` (§5.8, base64). `s` and `k` come together or not at all; either without the other, or either of another length, rejects the whole link. A link without them is an ordinary one-to-one invite.

### 4.3 Identity-backend operations

| Operation | Use | Frequency |
|---|---|---|
| `ecdh(kid, peer_pub)` → raw 32 B | the one DH with `IK` in EH-2 (§6.2); the cache base (§10) | one per handshake; one per session |
| `derive(kid, peer_pub, ctx, label, L)` → `HKDF(ECDH(IK, peer_pub), salt = ctx, info = label, L)` | pair and self topic (§5.1–5.2), Announce MAC keys (§5.5), rotation offset (§5.4), invite key and decoy seed (§5.8–5.9), the group MAC keys `mk_ij` and `rk_i` (§8.1) | topic and MAC key once per contact per day (two days inside the rotation guard); the offset once per contact; two per published invite per session; one per member per group epoch |
| `key_generate(X25519, purpose = ecdh)` | `IK` at onboarding; `GK` at group creation | once per identity, once per group |
| `key_import(pub)` | a contact's `IK_pub`; a member's `GK_pub` (§8.6) | once per contact, once per group |
| `key_delete(kid)` | contact removal, group leave, IK rotation | rare |
| `key_search(prefix)` | identities, contacts, group markers | sign-in and add paths |
| `getPubKey(kid)` | read a public half | per contact and group at sign-in |

Signing and the HSM's own ML-KEM/ML-DSA are not used. Everything else (HMAC, AES-GCM, ML-KEM, ratchet, every HKDF) is client-side.

The client never holds a pair secret: what it memoises are the derived values of a day (a topic, an Announce key, an offset, an epoch's MAC key). On a backend that derives in-device, `ECDH(IK_a, IK_b)` never leaves the device; on one that derives in the client (the current HEM firmware, a software identity) the raw output exists for the duration of one HKDF and is wiped. Either way the material is rendezvous-only and disjoint from the message-key DHs: what a compromised client can leak is pair-linkability for the days whose keys it holds, never content (§11.3, S13). EH-2 needs raw mode: its DH outputs are concatenated client-side and wiped after `SK` is derived.

### 4.4 Contact integrity

A swapped contact key is a complete MITM, so integrity of the stored key is critical; the list of contacts is also who the identity knows, so where it is stored on the device it is sealed as well. Per store:

- **HEM-held contacts**: modification is a privileged HSM operation behind a scoped token; the KID indexes key content.
- **The local contact book** (software identities; contacts a HEM identity keeps on this device rather than in the HEM) is sealed with AES-256-GCM under `k = HKDF(base, salt = "encedo-chat-contact-book-v2", info = idKey, L = 32)`, `base` from §10, and opened at sign-in. A book that does not open is `tampered`, never empty: it is not used and not overwritten. A book in an older format is judged as it was then and sealed at once, before it is used: a bare list from before any protection is accepted (`unsigned`), and a signed one (`{v:1, mac, body}`, `HMAC-SHA-256` under `HKDF(base, salt = "encedo-chat-contact-book-v1", info = idKey, L = 32)` over the stored body) is accepted if its MAC verifies and is `tampered` if not. A marker records that a protected book has been written for the identity, after which a bare list in its place is `tampered`. The plain list is never written. Without `base` (an identity that refuses ECDH) the book is kept plain and unprotected.
- **At import**: out-of-band verification (§4.4.1) and pinning of what was verified.

#### 4.4.1 Safety number

One string per pair, identical on both screens:

```
half(pub)  = h_5200, where  h_0 = SHA-512("encedo-chat-safety-v1" ‖ 0x00 ‖ pub)
                            h_i = SHA-512(h_(i-1) ‖ pub)
             first 30 bytes -> six 5-byte big-endian integers, each mod 100000,
             zero-padded to 5 digits -> 30 digits
number     = min(half(IK_a), half(IK_b)) ‖ max(...)       (string order; 60 digits)
QR payload = "onchato-sn1:" ‖ number
```

Each half is bound to one key. Nothing travels; both clients compute it from keys they hold, and it changes only when an identity key does. Shown as twelve groups of five; a client that scans the other screen's QR reports match or mismatch against its own number.

### 4.5 Software identity

An identity backend without hardware: a WebCrypto X25519 keypair generated on device, the private half sealed with a password — PBKDF2-SHA256, 1 000 000 iterations, a per-profile random salt, then AES-256-GCM — in localStorage, or in the terminal client's `store.json` (§10). It implements the same contract as a HEM (one `ecdh`) and interoperates byte for byte with HEM identities.

Assurance: the key is on disk under a password. Theft of the sealed blob plus a guessed password is the identity; the §9.3 boundary does not apply (a re-handshake needs no device); the profile export of §10 carries the whole identity under the same password. Wherever a password is chosen (profile creation, password change) the client estimates its strength locally and refuses one under about 60 bits. The floor is not applied at sign-in or to the export.

---

## 5. Rendezvous and discovery

### 5.1 Pair topic

```
shared_secret  = ECDH(IK_a_priv, IK_b_pub)                // equal on both sides
topic_material = HKDF-SHA256(ikm  = shared_secret,
                             salt = network_id ‖ 0x00 ‖ date_UTC,
                             info = "encedo-chat-rendezvous-v1",
                             L    = 32)
topic          = base32(topic_material)[0:52]
```

- `date_UTC` is `YYYY-MM-DD` on the pair's shifted clock (§5.4).
- `network_id` is `main` in the shipped clients (the terminal peers take it as `--network`); `0x00` separates it from the date.
- The topic is indistinguishable from random without `shared_secret`; mapping a topic to a pair requires both `IK_pub`s.
- `ss` is computed lazily, on first use per contact per session, and memoised.

### 5.2 Self-topic

The §5.1 construction with `ss = ECDH(IK_a_priv, IK_a_pub)`, the key's DH with itself. Only the IK holder computes that value, so the self-topic is not computable from `IK_pub`. The same `ss` keys the Announce MAC (§5.5): anything validly MAC'd on the self-topic is another window of the same identity (§9.1). The self-topic rotates at the identity's own instant, `offset = rotationOffsetSec(self ss)` (§5.4), under the same ±30 min guard. Derivation is best effort: an identity whose backend refuses a self-ECDH runs without §9.1.

### 5.3 Group topic

```
topic = base32(HKDF-SHA256(ikm  = group_secret,
                           salt = network_id ‖ 0x00 ‖ date_UTC,
                           info = "encedo-chat-group-rendezvous-v1",
                           L    = 32))[0:52]
```

`group_secret` is a random 32-byte value the admin generates and distributes pairwise with the sender keys (§8.3) over existing 1:1 sessions; it rotates on every membership change (new epoch, new secret, new topic). It lives client-side in the sealed cache (§10), never in the HSM, and never seeds anything but the topic. `GK` never seeds the topic.

The topic rotates per epoch and daily at the group's own instant, `offset = rotationOffsetSec(group_secret)` (§5.4). Within the ±30 min guard the room holds both adjacent days' topics: keepalives (§8.5) go to every live topic, sends to the current day's; a 60 s tick walks the date.

### 5.4 Daily rotation at a per-key instant

```
rotation_material = HKDF-SHA256(ikm  = shared_secret,      // the topic's own key: pair ss, self ss, group_secret, invite_secret
                                salt = network_id ‖ 0x00,  // no date: the offset is stable per key
                                info = "encedo-chat-rotation-v1",
                                L    = 4)
offset_seconds    = u32be(rotation_material) mod 86400
```

The rendezvous day of a topic is `utcDate(now − offset_seconds)`; it is the `date_UTC` of §5.1–5.3 and §5.7. Both holders of the key derive the same offset and cross together.

- Within ±30 min of the instant a client subscribes both adjacent days' topics (two, never three); otherwise the current day only. It announces on every active topic; a contact is online if it announces on any of them; content is published on the current day's topic.
- A conversation held open across a rotation keeps its topic while the other side is still on it. A room on an older day's topic moves to the current day's topic in place, keeping its sessions and unconfirmed messages, once nobody is left on the old topic (checked once a minute) or when the contact's handshake arrives on another active day's topic, in which case the room follows that day.
- **Clock source.** The protocol clock is the device clock plus an anchor: once a node is reached, and hourly after that, the client reads the `Date` header of the node's `/health` answer and takes the node's time as true at the midpoint of the round trip (`offset = node_time + 0.5 s − (sent + rtt/2)`); a round trip over 5 s is not used; the offset is clamped to ±10 min; a failed probe keeps the previous anchor. Announce and handshake timestamps, their replay checks and the rendezvous day read the anchored clock; timers and durations read the device clock. The time source is the operator's: a node can move a client's protocol clock by at most the clamp, which can push that client outside the ±5 min replay window (a denial the node can cause anyway by not delivering) but not the rendezvous day of a pair apart (two anchors differ by at most 20 min, inside the ±30 min rotation guard).
- Two implementations must agree on this schedule exactly.
- Test hook: `forcedRotationSec` (web `?rot=<hour>`) overrides every offset with one fixed time of day; absent the flag, the derivation above is the only schedule.

### 5.5 Announce (presence)

Published on pair topics and the self-topic, never on group topics (§8.5). On a pair topic: at join, beacons at 1 s, 3 s and 7 s, then a heartbeat every 15 s. A room gates its first Announce on the node appearing among the topic's subscribers or 1.5 s, whichever is first; a light watch announces at once. Every 15 s publisher of a session fires on one shared radio phase (a random per-session offset of the 15 s grid); a light watch slows to 60 s while the page is hidden on any host but the desktop shell; a room never slows. A newly heard announcer is answered at once (a watch at most once per 3 s). On the self-topic: one Announce at subscribe, a heartbeat every 10 s, and a farewell Announce on §9.1 stand-down.

**Wire encoding:** a UTF-8 JSON object `{ v, peer, nonce, ts, mac }` with `v = 3` (any other value is refused), `peer` the sender's PeerId string, `nonce` base64 of 16 random bytes, `ts` unix milliseconds, and

```
announce_mac_key = HKDF-SHA256(ikm  = shared_secret,        // the pair ss; the self-DH value on the self-topic
                               salt = network_id ‖ 0x00 ‖ date_UTC,
                               info = "encedo-chat-announce-mac-v1",
                               L    = 32)
mac = base64( HMAC-SHA256(announce_mac_key, ASCII("<v>|<peer>|<nonce>|<ts>")) )
```

The MAC input is the ASCII string of the four fields joined with `|`. The receiver checks `v` and shape, then `|ts − now| ≤ 5 min`, then the MAC (constant time), then deduplicates by nonce (a per-watch cache pruned past twice the replay window); on success it maps the contact to `peer`. `IK_pub` never appears on the wire.

**Presence without a conversation.** Each contact gets a light watch on the pair topic: subscribe, Announce on the heartbeat, report whether the contact announces. The watch also hears an incoming EH-2 msg1 and hands the topic over to a full room. A watch knows announcing, and gone after ~90 s of silence; a room adds `quiet` after 2.5 missed heartbeats (37.5 s, never under 35 s).

### 5.6 Discovery nodes

Operator-run libp2p nodes (GossipSub between nodes, circuit-relay-v2 reservations, nginx in front on WSS/443). Network isolation is cryptographic: `network_id` enters every topic derivation, and the node has no network flag. A node's key derives from its `--pass` seed, so its PeerId is known before the machine exists.

A node bounds concurrent live topics (hard cap), topics per peer (quota) and idle topics (TTL eviction: a topic silent for the idle TTL returns its slot; a topic with heartbeats is never evicted; a topic a light client holds on its stream is not evicted while the stream lives). When a cap bites, a GossipSub peer sees an empty room; a light client is told (`REFUSED`, §13.2). The numbers are operational (`ARCHITECTURE.md`). The 65 536-byte frame bound of §7.4 is enforced at both ends: by the client before publishing, and by the node — a PUSH past it is answered with reach 0 and not published, a GossipSub message past it is dropped by a validator on every carried topic, and one inbound RPC is bounded at 1 MiB.

**Node list.** Compiled into the client and refreshable through the release manifest: a file the operator signs with an offline Ed25519 key whose public half every client carries, naming the list's IPFS CID (and the CI updater key) with an expiry; the client verifies signature and dates, fetches the list by CID and checks the bytes (`ARCHITECTURE.md`, Distribution). The client draws its first node among the enabled ones (weighted by capacity), may move once at login to a node announcing a load at least 20 points lower than a second draw, later moves only after its node has stayed ≥ 85 % for a minute while another is under 60 % (a fifth of the time per 20 s check, at most once per ten minutes), and fails over down the list. Load announcements are JSON `{ v, n, pct, at }`, `pct = max(connections/limit, topics/limit)`, on a constant topic shaped like a room topic, replayed at once to a light client that picks it (§13.2). The user may disable nodes or override the list locally.

### 5.7 Published invites

An identity may mint any number of invites, each a random 32-byte `invite_secret` carried in a link (§4.2, `s`) and retirable on its own. The **inviter** publishes and listens; the **answerer** reads the link and knocks.

```
topic_material = HKDF-SHA256(ikm  = invite_secret,
                             salt = network_id ‖ 0x00 ‖ date_UTC,
                             info = "encedo-chat-rendezvous-v1",
                             L    = 32)
topic          = base32(topic_material)[0:52]        // rotates per §5.4 with offset = rotationOffsetSec(invite_secret)
```

The topic is public: anyone who read the link can subscribe and publish. The inviter's client treats hostile input as the ordinary case: a frame that does not open is dropped silently; the last 512 ephemeral keys are remembered so one frame is tried once (the ephemeral is remembered before the frame is tried, and a capped frame is remembered too), and the ephemeral of each of its own decoys is remembered before it is published, so its own cover traffic is never opened; at most 60 frames per minute are opened, counted before opening; at most 20 knocks per minute are surfaced and the rest counted and dropped. The budgets are per inbox topic. Opening is a local X25519 with the invite key (§5.8), never an identity-backend call. Dismissed knocks are kept as the knocker's fingerprint (§4.2) in a sealed list (§10, capped at 512), a local filter only.

The answerer subscribes to the inbox topic for the attempt (up to ~8 s), publishes the knock (§5.8), unsubscribes, and re-knocks every 90 s with the same `name` and `note` until it sees the inviter on the pair topic it can already derive. Knocks in progress are kept sealed across a reload (§10).

### 5.8 Knock frame

One frame on the inbox topic, always exactly 348 bytes, published bare (no origin envelope, §13):

```
frame = eph_pub (32) ‖ AES-256-GCM ciphertext (300) ‖ tag (16)

invite_priv = HKDF-SHA256(ikm  = ECDH(IK_priv, IK_pub),          // the §5.2 self-DH; inviter only
                          salt = invite_secret,
                          info = "encedo-chat-invite-key-v1", L = 32)     // an X25519 scalar (RFC 7748 clamping)
invite_pub  = X25519(invite_priv, 9)                              // the link's `k` (§4.2)

k ‖ nonce = HKDF-SHA256(ikm  = ECDH(eph_priv, invite_pub)        // answerer
                             = ECDH(invite_priv, eph_pub)        // inviter
                        salt = invite_secret,
                        info = "encedo-chat-invite-knock-v2",
                        L    = 44)                               // 32 B key ‖ 12 B nonce

plaintext (300 B, zero-padded) = kind (1) ‖ ik (32) ‖ nameLen (1) ‖ name (64) ‖ noteLen (2) ‖ note (200)
kind: 0x00 decoy, 0x01 real
```

A fresh ephemeral per frame; the key seals exactly once, so the nonce is derived, not carried. The invite key is derived, not stored: one identity-backend derivation per invite per session, the same in every window and on every device of the identity, computable only by the `IK` holder and never from the link; once derived it is held in client memory. A frame on the public topic therefore costs a local X25519 and never an identity-backend call. The invite secret is the context as well, so a knock opens only under the invite it came through. Every frame is the same length. `name` (≤ 64 B) and `note` (≤ 200 B) are claimed, never verified; accepting a knock creates the contact, and §4.4 applies unchanged. Opening returns nothing on every failure and never raises.

### 5.9 Cover traffic on the inbox

The inviter's own client publishes decoy frames (`kind = 0x00`), sealed to its own `invite_pub` like any knock, on its own inbox topic:

```
seed    = HKDF-SHA256(ikm  = ECDH(IK_priv, IK_pub),          // the §5.2 self-DH
                      salt = invite_secret,
                      info = "encedo-chat-invite-decoy-v1", L = 32)
instant = slot * 45_000 + (u32be(HKDF-SHA256(seed,
                      salt = u32be(slot),
                      info = "encedo-chat-invite-decoy-slot-v1", L = 4)) mod 45_000)
```

`slot` counts 45 s periods. The seed is the self-DH, never the invite secret: a schedule computable from the link would let any link holder subtract the decoys. The schedule is deterministic, so every window of one identity produces one stream and a restart resumes it with nothing stored. A slot whose instant fell while the client was not ticking is paid late with one frame. The decoy is also the keepalive of a full GossipSub peer's inbox topic (§5.6 eviction). Invite secrets live sealed on disk (§10).

What an observer of an inbox topic learns: that a 348-byte frame was published, and when (§11.3, S14).

### 5.10 Decoy subscriptions

Per connection a node sees how many topics it carries - the size of the contact list - and which of them hop together (§11.4). A client holds **up to 8** extra topics, `min(contacts, 8)`, indistinguishable from the pair topics of contacts who are offline: the same 52-character base32 shape, the same Announce cadence (§5.5: the beacons, the 15 s heartbeat on the session's radio phase, the hidden-tab slowdown), each rotating daily at its own per-topic instant under the §5.4 guard. They raise the floor under the contact-list count and blur which topics are a client's real pairs.

```
seed      = HKDF-SHA256(ikm = ECDH(IK_priv, IK_pub), salt = network_id ‖ 0x00, info = "encedo-chat-decoy-v1",        L = 32)
offset_i  = u32be(HKDF-SHA256(seed, salt = u8(i), info = "encedo-chat-decoy-offset-v1", L = 4)) mod 86400
topic_i   = base32(HKDF-SHA256(seed, salt = u8(i) ‖ network_id ‖ 0x00 ‖ date_UTC, info = "encedo-chat-decoy-topic-v1", L = 32))[0:52]
```

- The Announces carry a MAC under a **random per-session key** nobody else holds, so no peer ever verifies one and no peer ever answers - which is exactly how a pair topic reads when its contact is away. A decoy therefore invites no traffic and completes no handshake.
- The seed is the §5.2 self-DH (`ECDH(IK, IK_pub)`, computable only by the identity holder) and **date-independent**, so the set is stable across a restart. A decoy set that changed on every reload while the real topics stayed would mark itself as the decoys.
- **Decoys yield.** The node refusing any topic means it is full (§13.2 `REFUSED`), and cover traffic must never cost a real room its slot: a refusal drops every decoy for the rest of the session. The per-peer topic quota (§5.6) already covers the 8, since a client holds about 4 real topics; the node-wide cap is the lever the operator sizes against the decoys (`ARCHITECTURE.md`).
- Off is possible per client (the engine's `decoys` option); on by default in the shipped clients.
- **What decoys do not do.** They are cover against an honest node and an observer of its subscription list. A node that refuses a topic on purpose makes a client drop its decoys and then sees the real set; the client cannot tell a full node from one that forces the drop. They do not hide pairs either: two connections holding one topic and hopping together every day stay visible (§11.4), and over weeks a decoy reads as a topic that never has a second subscriber.

---

## 6. Handshake — EH-2

Interactive, 1.5 round trips (msg1 → msg2 → msg3), producing `SK` (32 B) = `RK_0`. The frames ride the pair topic unsealed, told apart from content by their type byte. Whoever is in the room initiates on discovery; crossed msg1s are settled on receipt: the lower PeerId keeps its own in-flight attempt (2 s window) and ignores the incoming msg1, the higher one yields and responds.

Delivery discipline (GossipSub is fire-and-forget):

- the opening frame is sent and repeated up to three times, 700 ms apart, while an attempt waits; a silent attempt is abandoned after 6 s and retried after a random 200 ms – 1.6 s; a peer that has never completed a handshake in this room is backed off to 3 s after sixteen silent attempts and 10 s after twenty-four; one that has is always retried fast; the loop never stops. While a backoff runs, handshake frames from that peer are not processed;
- a byte-identical repeat of msg1 gets the stored msg2 replayed, not a fresh attempt;
- a new msg1 restarts a responder that already holds a session; the session is replaced only once msg3 verifies;
- a msg1 whose `initiator_tag` (§6.1) is not the contact's makes the responder ignore that peer for 5 minutes, and for another 5 if it is still sending after that;
- content typed before establishment queues in a bounded buffer of 32 envelopes and flushes when the session is live; overflow is dropped;
- a pair topic may hold more than one live session with the same contact (§9.1, or a peer mid-reload): every outgoing envelope is sealed and published once per live session.

### 6.1 Messages

```
I → R  msg1 { version, ek_i_pub, pq_pub (ML-KEM-768), timestamp, initiator_tag }
R → I  msg2 { version, ek_r_pub, pq_ct, timestamp, mac_r }
I → R  msg3 { version, mac_i }
```

Serialization (`h1 = SHA-256(serialize(msg1))` salts `SK`):

```
msg1 = 0x01 ‖ ver(1) ‖ ek_i_pub(32) ‖ u16be(|pq_pub|) ‖ pq_pub(1184) ‖ u64be(ts_ms) ‖ initiator_tag(32)     // 1260 B
msg2 = 0x02 ‖ ver(1) ‖ ek_r_pub(32) ‖ u16be(|pq_ct|)  ‖ pq_ct(1088)  ‖ u64be(ts_ms) ‖ mac_r(32)
msg3 = 0x03 ‖ ver(1) ‖ mac_i(32)
```

`ver = 3`. Timestamps are checked to ±5 min on the anchored clock (§5.4).

```
k_tag         = HMAC-SHA256(announce_key, "encedo-eh2-initiator-tag-v1")   // announce_key: the pair's Announce MAC key of the day (§5.5)
initiator_tag = HMAC-SHA256(k_tag, IK_i_pub)                                 // 32 bytes
```

R checks the tag before any DH: equal to the tag over the contact's `IK_pub`, proceed; equal to the tag over R's own `IK_pub`, a second window of R's own identity; anything else, not the contact. Either mismatch is the 5-minute rule above. The tag is readable only by the pair and changes with every rotation; it is not an authenticator — the MACs of §6.2 decide. A room that moves to another day's topic (§5.4) drops any attempt in flight and starts over under that topic's key.

### 6.2 Key schedule

```
h1  = SHA-256(serialize(msg1))
ss  = ML-KEM-768 encapsulate (R) / decapsulate (I)
ikm = DH(IK_r, EK_i) ‖ DH(EK_r, IK_i) ‖ DH(EK_r, EK_i) ‖ ss
SK  = HKDF-SHA256(ikm, salt = h1, info = "encedo-handshake-v2", L = 32)

h2_partial = SHA-256(serialize(msg1) ‖ EK_r_pub ‖ pq_ct ‖ u64be(ts_r))
mac_r = HMAC-SHA256(SK, "responder" ‖ h2_partial)      // R authenticates to I (msg2)
h3    = SHA-256(h2_partial ‖ mac_r)
mac_i = HMAC-SHA256(SK, "initiator" ‖ h3)               // I authenticates to R (msg3)
```

Each side makes exactly one identity-backend ECDH (the DH involving its own `IK`); the other two DHs are local.

- **Erasure.** `dh1`, `dh2` and `ss` are wiped as soon as `SK` is derived. `dh3` survives until the first ratchet step consumes it (§7.2). In `core-rs` (WASM and native, §3.2) the key types of `sk_i` and the `EK` private halves and every derived secret are zeroed on drop (`x25519-dalek` and `ml-kem` built with `zeroize`); in the TypeScript engine `sk_i` is dropped with its decapsulation closure and the `EK` private halves are non-extractable WebCrypto keys. `EK_i_priv` lives longest: R seeds the ratchet's first `DH_peer_pub` with `EK_i_pub` from msg1, so I keeps `EK_i_priv` as its initial ratchet private key until the first DH step replaces it.
- **msg3 gates the responder.** I holds `SK` after msg2 and may transmit after msg3; R MUST NOT accept any ratchet message from I until `mac_i` verifies.
- **`pq_ct` binding.** The ciphertext enters `SK` only through `ss`; it is authenticated through `h2_partial` inside both MACs.

### 6.3 DH ordering

Both sides concatenate in responder perspective: `DH(IK_r, EK_i) ‖ DH(EK_r, IK_i) ‖ DH(EK_r, EK_i) ‖ ss`. The initiator computes the same values by X25519 commutativity.

### 6.4 Properties

- **Mutual authentication.** R authenticates I through `mac_i` (needs `DH(IK_i, EK_r)`, hence `IK_i_priv`); I authenticates R through `mac_r` symmetrically.
- **Forward secrecy.** `SK` needs the wiped ephemerals; a later `IK` compromise does not recover it.
- **PQ hybrid.** `SK` confidentiality holds while either ECDLP (X25519) or MLWE (ML-KEM-768) is hard; concatenation in HKDF is the combiner. EH-2 is a MAC-authenticated AKE whose classical component is a NIKE; the argument lives at the AKE level.
- **Deniability.** Both MACs are under `SK`, shared by both parties; neither holds proof of the other's authorship.
- **KCI resistance.** Holding `IK_r_priv` does not allow impersonating a third party to R: `mac_i` needs `IK_i_priv`.
- **Replay.** Timestamps ±5 min; `h1` salts `SK`, so every session's `SK` differs; Announce nonces are deduplicated (§5.5).

---

## 7. Messaging — Double Ratchet

`RK_0 = SK`.

### 7.1 State (per session)

```
DR_State { RK, CK_send, CK_recv, DH_self_priv, DH_self_pub, DH_peer_pub,
           N_send, N_recv, PN, skipped_keys: map<(DH_pub, N), MK>,
           pq_key (own ML-KEM keypair, outstanding), pending_ss ‖ pending_ct (the peer's key answered, for the next step),
           ct_in_flight, steps_since_pq, last_pq_at }
```

### 7.2 Steps

```
DH step:        RK', CK = HKDF-SHA256(ikm = X25519(DH_self, DH_peer), salt = RK,
                                      info = "encedo-ratchet-dh-v1", L = 64)
Hybrid step:    RK', CK = HKDF-SHA256(ikm = X25519(DH_self, DH_peer) ‖ ss, salt = RK,
                                      info = "encedo-ratchet-hybrid-v1", L = 64)     // ss: ML-KEM-768 shared secret
Message key:    MK       = HKDF-SHA256(CK, salt = ∅, info = "encedo-msg-key",   L = 32)
Chain advance:  CK'      = HKDF-SHA256(CK, salt = ∅, info = "encedo-chain-key", L = 32)
Nonce:          12 B     = HKDF-SHA256(MK, salt = u32be(N), info = "encedo-aead-nonce", L = 12)
AEAD:           AES-256-GCM(MK, nonce, plaintext, aad = header)
Header:         0x10 ‖ ver(1) ‖ dh_pub(32) ‖ pn(u32be) ‖ n(u32be)                                              // 42 B
                0x11 ‖ ver(1) ‖ dh_pub(32) ‖ pn ‖ n ‖ flags(1) ‖ [u16be len ‖ pq_ct] ‖ [u16be len ‖ pq_pub]   // ≤ 2 319 B
                flags: 0x01 pq_ct present, 0x02 pq_pub present (ct first when both); ver = 3
                the whole header, whichever form, is the AAD
```

**First root step.** At ratchet construction both sides run one DH step with `ikm = dh3` (§6.2) against `RK = SK`, after which `SK` is wiped: the initiator obtains `CK_send`, the responder `CK_recv` (the responder has no sending chain until its own first DH step). The initiator's first header carries `dh_pub = EK_i_pub`.

**Hybrid step.** A sender that has made K = 4 DH steps of its own since the last ML-KEM contribution, or whose last contribution is older than T = 30 min, generates an ML-KEM-768 keypair at its next step and carries `pq_pub` (1184 B) in the header of every frame it sends until the key is answered. The peer, on opening any frame that carries a key it has not answered, encapsulates (`ct`, `ss`) and holds both; at its next DH step it mixes `ss` into the root under the hybrid label and carries `pq_ct` (1088 B) in the header of every frame of that chain until the sender's next key shows it has stepped past it. The sender, on a step frame carrying `pq_ct`, decapsulates with its outstanding key and runs the same hybrid step; the key is then spent. One outstanding key per side; keys cannot cross, because a side steps only on receiving the chain that carries the other's key. A `pq_ct` under no outstanding key, or any altered header, opens nothing and moves nothing. Skipped-key handling is unchanged by the hybrid step.

The nonce is the same function for a 1:1 frame and a group frame (§8.2); `MK` seals exactly once.

### 7.3 Rules

- `MK` is single-use and wiped after use; a state snapshot after message *n* cannot open messages before *n*.
- **Skipped keys.** A single counter jump larger than 1000 is refused; skipped keys are kept for at most 5 receiving chains (the current and its predecessors); unclaimed keys expire after 24 h. `decrypt` is transactional: state advances only after the AEAD verifies.
- **Session lifetime.** A fresh EH-2 is forced in the background every 4–8 h (randomised per session; the lower PeerId initiates). The replaced ratchet is kept 60 s so frames in flight under it still open. A re-key attempt that dies is retried within seconds by whichever side noticed; the lifetime clock moves only when the new ratchet is live. A device switch forces a fresh EH-2 (new PeerId); a relay reconnect keeps the live ratchet and re-sends the backlog; the daily rotation does not break an established stream. The timer is also the hard bound of §9.3.
- **Content plane.** Sealed content rides a direct WebRTC DataChannel when the user has selected it and both ends can open one (§13), else GossipSub through the node, as ratchet ciphertext either way. Groups and the terminal client always use the node. A DataChannel (label `onchato`) is trusted only after a two-byte ping/pong (`0x00 0x50` / `0x00 0x4f`, up to 4 probes at 700 ms) proves both directions; the first unconfirmed re-send while content rides it demotes the conversation to the node for its remaining life (not in the direct-only setting, §13).
- **Delivery contract.** `msg` and `file` envelopes carry an `id`; the receiver replies with `ack { ref, rts }`; an unconfirmed message is re-sent under the same `id` at 1.5 s, 4 s, 8 s, 15 s, 15 s, within a 60 s budget plus 8 s of grace before the failure verdict. The first send and the first two re-sends are unconditional; from the third re-send the clock runs only while the peer is announcing. Running out of budget keeps the bytes for a manual re-send; a reconnect re-sends the backlog oldest first with fresh budgets. A message sent while nobody is announcing is parked and marked once the unconditional sends and the grace are spent (13.5 s: re-sends at 1.5 s and 5.5 s, then 8 s), and goes out by itself, oldest first, when a session with the peer comes up. At most 50 parked and 50 re-sendable messages are kept per room.
- The ratchet seals opaque bytes: nothing in the key schedule, the header or the AAD depends on the payload encoding.

### 7.4 Application payload

What §7.2 seals is a JSON envelope `{ v, t, id, ts, seq, …payload }`. `v = 1` (any other value is refused); `t` discriminates the type; `id` is 6 random bytes as 8 base64 characters (a received `re.id` is accepted at 1–64 characters; `ack.ref`, `reaction.to` and `edit.to` need only be strings, and a reference that matches nothing is a no-op); `ts` is the sender's UTC clock in ms; `seq` is a per-sender counter for de-duplication and display order, not a security counter. An unknown `t` decodes as an opaque envelope and is ignored.

**Size.** A published frame is at most 65 536 bytes (§5.6, §13.1), so a text `body` is capped at 62 464 bytes of its JSON encoding: 3 072 bytes of headroom for the envelope, the ratchet header (up to 2 319 B) and the origin envelope (§13). The composer refuses beyond it.

**Types**, exactly these eleven:

| `t` | payload | notes |
|---|---|---|
| `msg` | `{ body, format: 'plain', re? }` | text, never markup; a body beginning `ACTION ` is a terminal client's `/me` display convention |
| `typing` | `state: start \| stop` | sent on input; `stop` after ~4 s idle |
| `presence` | `active \| away \| leave` | `away` after ~60 s idle |
| `reaction` | `{ to, emoji }` | no removal; a reaction is a message |
| `edit` | `{ to, body, format }` | below |
| `knock` | empty | below |
| `file` | `{ cid, key, name, size, mime, chunk, chunks, alg, exp, body?, re?, album? }` | §7.5 |
| `ack` | `{ ref, rts }` | the delivery contract (§7.3) |
| `rtc` | `{ to, sig }` | WebRTC signalling (§13) |
| `group-skd`, `group-skd-req` | §8.3 | group distribution, over the 1:1 ratchet |

One further type is reserved: `ik-rotate { newPub, effectiveFrom }` (identity-key rotation, `RATIONALE.md`). The decoder knows its shape and drops a malformed one; no client builds it and none acts on it.

**Mention** — `@Name#<hint>` inside a `msg` body: the visible name the sender used (no `@` or `#`, collapsed whitespace, ≤ 48 characters) followed by `#` and 8 hex characters, the first 4 bytes of the mentioned member's public key. The receiver resolves the hint against the participants of that conversation and renders its own name for that key; a hint matching nobody or two people renders as plain text.

**Reply** — `re = { id, au?, text }` on `msg` or `file`: the id of the message answered, optionally the first 4 bytes of its author's public key as a hint, and a copy of its text (160 code points, plus U+2026 when clamped; a receiver accepts up to 400 UTF-16 code units). The author is a key hint, never a name; an unresolvable or ambiguous hint is shown without a name. A malformed `re` is dropped and the message kept.

**Correction** — `edit = { to, body, format }` replaces the displayed text of an earlier message. `body` is never empty. The receiver accepts a correction only from the peer whose message it names, and only within 15 minutes of that message, plus 5 minutes of tolerance for a future-stamped message. 1:1 only. A correction is a request to display different text, not a capability to remove it: there is no delete-for-everyone. It is acknowledged under its own `id`. Neither `re` nor `edit` changes the key schedule, the header or the AAD.

**Album** — `album = { id, i, n }` on `file`: `id` 16 lowercase hex characters, random per pick; `i` the file's 0-based position; `n` the number of files (a sender picks at most 10; a receiver accepts `2 ≤ n ≤ 32`, `0 ≤ i < n`). Each file of an album is a complete, independent `file` message with its own key, CID, `id`, `ack` and re-sends; the caption and `re` ride on `i = 0`; files are sent in `i` order. A malformed `album` is dropped and the file kept.

**Knock** — an empty envelope between two contacts, sealed by the ratchet: "I am here, are you?". Not the inbox knock of §5.8. Not tracked for delivery, not re-sent, not acknowledged. Rate-limited: the sender's control locks for 10 s; a receiver ignores a second knock from the same peer within 5 s. 1:1 only.

**Signalling** — `rtc = { to, sig }` carries one WebRTC offer, answer or ICE candidate, sealed by the ratchet and addressed by `to`; a signal for another peer on the topic is reported, not acted on. The offering side (the lower PeerId) makes three attempts in total, the offer and two re-offers each after 10 s without a proven channel, then stays on the node. 1:1 only.

### 7.5 Files

A shared file (images, documents, voice notes: a recording of up to 120 s as a `file` with an audio MIME type, `name` = `glosowka-<UTC date and time to the minute>.<ext>`) is too large for the message path: its ciphertext rests briefly on an operator-run IPFS store while the envelope carries the key.

**Encryption**, `alg = "A256GCM-chunked-v1"`, before any byte leaves the device:

- One single-use random 32-byte key per file, carried in the `file` envelope over the 1:1 ratchet or the group sender key.
- The plaintext is split into chunks of `chunk` bytes (4 MiB default; `chunk` is a manifest field; hard caps 16 MiB per chunk and 128 MiB per file, enforced by the sender and again by the receiver's decoder, which also refuses a chunk count that does not follow from `size`). Each chunk is sealed with AES-256-GCM under nonce `0x00000000 ‖ u64be(chunk_index)` and AAD `u32be(chunk_index) ‖ u32be(chunk_count)`.
- A wrong key, a tampered, reordered or truncated blob all land in one refusal; no partial plaintext is yielded.
- The manifest `{ name, size, mime, chunk, chunks, alg, exp }` and the CID (CIDv0, dag-pb, computed by the store over the stored bytes, storage prefix included) ride the same authenticated envelope as the key. The client does not recompute the CID; integrity rests on the AEAD.

**Storage framing.** The store holds `"ECF1" ‖ u8(version = 1) ‖ 0x000000 ‖ ciphertext`. The operator's upload endpoint writes the prefix; nothing on the way out removes it; the client skips it when decrypting. A reader that finds the magic with an unknown version refuses; a blob without the magic is passed through unchanged (the AEAD decides).

**Storage.** The client uploads to the operator's origin (`/f`, proxied to the store) and fetches the same way; the operator's public gateway serves the same bytes. A blob is not announced to the IPFS network, is unpinned, and is swept after a TTL of about 5 minutes (`exp` tells the receiver when to stop offering the download). The store holds ciphertext and never sees a key. A received file is downloaded when the user asks for it; an opt-in per-identity setting fetches pictures and audio from a 1:1 peer automatically up to 2 MiB per file, never in a group, and never plays a voice note by itself. Files are not pinnable (§10).

A file may also travel on the DataChannel itself while the direct plane carries content (§13.1); nothing above applies to it.

---

## 8. Groups — Sender Keys, all-ECDH

A group is a layer over the 1:1 sessions: each member has its own sending chain, everyone broadcasts on a shared topic derived from `group_secret` (§5.3), and messages are authenticated by per-recipient ECDH-derived HMACs. No signatures; deniability holds as in 1:1. Scale: 3–5 members, at most 8–10 (the marker's roster blob holds ten, §8.6; the frame's MAC count is one byte; the client enforces no cap).

### 8.1 Keys and derivations

```
group_id   = SHA-256(GK_pub)[0:16]
sender_id  = SHA-256(IK_pub)[0:8]                                        // recipient_id likewise
mk_ij      = HKDF-SHA256(ECDH(IK_i, IK_j), salt = group_id ‖ u32be(epoch), info = "encedo-group-msg-mac",         L = 32)
rk_i       = HKDF-SHA256(ECDH(GK,   IK_i), salt = group_id ‖ u32be(epoch), info = "encedo-chat-group-roster-mac", L = 32)
MK         = HKDF-SHA256(chain_key, salt = ∅, info = "encedo-group-msg",   L = 32)   // per message
chain_key' = HKDF-SHA256(chain_key, salt = ∅, info = "encedo-group-chain", L = 32)  // forward; the old key is discarded
```

Per group: `GK`, a per-group X25519 keypair the admin generates in its identity backend (members hold `GK_pub`), stable for the group's life; `group_secret`, random 32 B, admin-generated, client-side only, rotated per epoch; per member a sending `chain_key`, client-side in the sealed cache (§10).

### 8.2 Message wire format

```
frame  = 0x20 ‖ version(1) ‖ header(32) ‖ macCount(1) ‖ { recipient_id(8) ‖ mac(32) }* ‖ ct      // version = 3
header = group_id(16) ‖ sender_id(8) ‖ u32be(epoch) ‖ u32be(ctr)                                  // also the AAD
ct     = AES-256-GCM(MK, nonce = HKDF-SHA256(MK, salt = u32be(ctr), info = "encedo-aead-nonce", L = 12), envelope, aad = header)
mac    = HMAC-SHA256(mk_ij, header ‖ ct)                                                           // one per other member
```

The plaintext is the §7.4 envelope; a group receiver dispatches only `msg`, `reaction` and `file` and ignores the 1:1-only types. A recipient locates its `recipient_id`, verifies its MAC before deriving anything, walks its copy of the sender's chain to `ctr` and decrypts. A single jump of more than 2000 past the chain's position is refused (frame dropped, chain untouched); derived-but-unused keys expire after 24 h; a larger gap is repaired by re-distribution (§8.4). A frame consisting of the single byte `0x21` is the topic keepalive (§8.5).

Properties: member B lacks `mk_AC`, so B cannot forge A→C even holding A's chain key; C holds `mk_AC`, so nothing proves authorship to a third party. A compromised `IK` forges, it does not decrypt. Forward secrecy within a chain; no post-compromise security within an epoch — a compromised `chain_key` reads that sender until the next epoch.

### 8.3 Distribution and membership

```
group-skd     { gid, gkPub, epoch, secret, chain, ctr?, roster[], rmac?, name? }   // over the 1:1 ratchet
group-skd-req { gid, epoch }                                                        // over the 1:1 ratchet
```

`group-skd` fields: the group id and `GK_pub`; the epoch; `secret` = `group_secret`; `chain` = the sender's current sending-chain key with `ctr`, the counter the chain stands at (absent ⇒ 0); `roster`, the member `IK_pub`s with `roster[0]` the admin; `rmac`, the admin's roster MAC, present when the sender is the admin; optionally `name`, the group's display name, taken only from `roster[0]`.

**Roster MAC:** `rmac = HMAC-SHA256(rk_i, UTF-8(roster.join("\n")))` over the public keys in the order sent. A receiver additionally requires `roster[0]` to be the sender of an `rmac`-bearing SKD and, across epochs, that `roster[0]` does not change; either failure rejects the distribution whole.

- **Precondition.** Sender keys ride 1:1 sessions; every member holds a 1:1 session with the admin, and pairs that cannot open a 1:1 cannot read each other in the group.
- **Admin authority is cryptographic.** A member accepts a roster only under a verifying `rmac` (it derives `rk_i` from `ECDH(IK_i, GK_pub)`) and binds `gid == SHA-256(GK_pub)[0:16]`. A distribution at a newer epoch replaces the session (fresh sender key); the same epoch keeps it and takes only the sender key, and only from a sender the attested roster already holds (a same-epoch SKD from outside the roster is refused whole); an older epoch is ignored. The attested roster is the only roster: display, distribution, re-request answers (§8.4) and renames all read it.
- **Membership change = admin rekey.** `epoch + 1`, a new `group_secret` (new topic), fresh sender chains, distributed to those who remain: on add including the newcomer, on remove excluding the removed member, who can then neither find the topic nor pass the epoch-scoped MACs.
- **Dissolution** is a rekey to a one-member roster, distributed to nobody, followed by destroying `GK`. The admin first sends one last `msg` with a fixed text on the old topic; nothing on the wire tells the network, and a member's room stays open on the old topic with its keepalive until that member leaves.
- **Queued distributions.** A distribution that cannot be sent now is queued and flushed when that member's 1:1 comes up.
- **Leaving is local.** A member stops its room, deletes its marker (§8.6), drops the group's state and its sealed blob, and records the group id and the epoch it left at (§10). A key for that epoch or older is dropped even under a verifying `rmac`; a key at a newer epoch joins as any group does.
- **Owed invitations.** The admin keeps, per group and epoch, whom it still owes the SKD (§10), and re-sends it at +10 s, +30 s and +90 s after the change, after a reload, and whenever that member's presence lights; the receipt is that member's own `group-skd` for the group at the owed epoch. A member re-sends its own key to the whole roster at +10 s and +30 s after joining and after every new epoch.

### 8.4 Repair — the sender-key re-request

- On a group frame whose per-recipient MAC verifies and for which no chain exists, or whose counter is past the gap bound of §8.2, the member asks that sender over the 1:1: `group-skd-req { gid, epoch }`. The answer is an ordinary `group-skd` (a responder at a newer epoch answers at its own). The request fires only after MAC verification, and the responder re-checks the attested roster before answering.
- Rate-limited to one ask per member per 30 s.
- The triggering frame is held, not dropped: up to 32 frames per sender for 2 minutes, opened in arrival order when that sender's key arrives; only MAC-verified frames are held; each passes `receive` again on release. A frame from before the counter the key is handed over at stays unreadable.
- For the first 30 s after joining a topic, each frame a member sends is published again, byte for byte, at +2 s and +6 s; a receiver past that `ctr` drops the copy.
- An SKD sent with no session yet, or within 5 s of one being established, is re-sent at +2.5 s and +6 s as the same envelope. A receiver never winds a chain back: an SKD whose `ctr` is below the chain it holds for that member does not replace it, and is used only to open frames held for that member through a throwaway receiver; a higher `ctr` is taken.
- A repair is not an epoch rotation.
- The same request is the recovery path for a member returning on a new device (§8.6); an unknown epoch is sent as 0.

### 8.5 Topic keepalive

Every member publishes the single byte `0x21` on the group topic every 15 s on the session's shared radio phase (§5.5; 60 s while the page is hidden on any host but the desktop shell), with beacons at 1 s, 3 s and 7 s after each topic goes live and a burst at 0, 800 ms and 2 s after a reconnect. It travels inside the origin envelope (§13). Receivers ignore it. Announces are never sent on group topics.

### 8.6 Identity-backend marker — portable membership

One DESCR per group, on the `GK_pub` entry, found by `key_search("ETSEIC:chan")`; this version writes and reads generation 1 only:

```
admin   ETSEIC:chan1:<owner hint>:<admin hint>:<name ≤ 16 chars>:<roster blob base64url>
member  ETSEIC:chan1:<owner hint>:<admin hint>:<name ≤ 16 chars>:
```

- Every identifier is a lookup hint: the first 4 bytes of a KID as 6 base64url characters (8 in hex contexts). `owner hint` = the owning identity's KID; `admin hint` = the KID of `roster[0]`. A hint selects a candidate among keys the device holds; the admin's `rmac` decides.
- No `group_id` field (derivable from `GK_pub`), no timestamp (the device records its own).
- Budget 128 bytes; over-length truncates silently, so fields yield in priority order: hints always survive; the roster blob (admin only, ≤ 10 members: 4-byte KID hints plus a CRC32 of the full KIDs) is dropped whole, never partially; the name truncates first, on a character boundary, with `:` and `,` replaced by spaces.
- An admin's marker is written at creation and rewritten on membership change or rename; a member's is written at join and rewritten on rename; both are deleted on leave; never on message activity. The group name an SKD carries is at most 64 code points: the sender cuts it there, a receiver cuts a longer one, and a `name` that is not a string is dropped while the distribution is kept; the marker holds 16. A member's import can be refused (one copy of a public key per device); the group then runs from the local cache without a portable record.
- **Recovery.** The entry yields `GK_pub` (hence `gid`), the admin hint and the name, never `group_secret` or sender keys. The returning member asks over the 1:1 (§8.4) 20 s after sign-in. A removed member is refused at the roster check silently; after 45 s without an answer the client says so and offers to drop the device entry.
- **All-wipe** (every member loses client state): the admin founds a new group with a fresh `GK`.

### 8.7 Labels

`encedo-chat-group-rendezvous-v1` (§5.3), `encedo-group-msg`, `encedo-group-chain`, `encedo-group-msg-mac`, `encedo-chat-group-roster-mac`.

---

## 9. Session management

One active session per identity.

### 9.1 Duplicate detection on the self-topic

At start a client generates its PeerId, subscribes the self-topic (§5.2), publishes its Announce immediately (heartbeat every 10 s), and arms a 3 s settling window during which Announces are collected and not acted on. On a valid self-topic Announce with `peer != mine`, **both copies stand down**: each closes its session and leaves the user to re-enter one deliberately. The window that stands down publishes one last Announce on its way out. A reload is unaffected: the old window is gone before the new one announces. The rule is best effort (§5.2).

### 9.2 Stand-down

Close all rooms; unsubscribe all topics; clear ratchet state from RAM; clear the transcript (the sealed cache of §10 stays); tell the user what happened.

### 9.3 Device theft without the identity backend

An attacker holding the device but not the HSM cannot start any EH-2, compute the next day's topics or post valid Announces: each needs `ecdh(IK, ·)`. It can keep reading an already-open session: the ratchet runs on ephemeral keys in client RAM. The hard stop is the session lifetime of §7.3: the next forced re-handshake needs the HSM. Self-topic detection is a coordination mechanism for honest clients, not a security control. For a software identity (§4.5) this boundary does not exist.

### 9.4 Ratchet state is not portable

A device switch requires a fresh EH-2 per contact; history is per device.

---

## 10. Local persistence

The transcript is RAM-only. What persists is the stores below, keyed off one device-bound, identity-gated base, plus the sealed profile of §4.5, which seals under the password's PBKDF2 instead:

```
base = ECDH(IK_priv, emp_pub)          // one identity-backend call per session, memoised
```

`emp_pub` is a random X25519 public value generated at first run and stored in plain sight (`ec-gcache-emp-<KID>`); deriving `base` requires the IK holder plus this device-local value. Every store derives from the one `base`. These stores keep the label in the salt and the scope in `info` — the reverse of the wire convention of §1 — because they are on-device only.

| store | key schedule | protects |
|---|---|---|
| group state | `HKDF(base, salt = "encedo-chat-group-cache-v1", info = group_id as hex, L = 32)` → AES-256-GCM per group | `group_secret`, sender chains, roster with member device KIDs, epoch, name, the admin's `GK` scalar for a software identity, the device KIDs of `GK_pub`, owed invitations (§8.3) |
| pinned messages | `HKDF(base, salt = "encedo-chat-pin-cache-v1", info = roomId, L = 32)` → AES-256-GCM per room | messages the user kept; 32 per room, refused not evicted; files not pinnable |
| contact book | `HKDF(base, salt = "encedo-chat-contact-book-v2", info = idKey, L = 32)` → AES-256-GCM | names and public keys of the identity's local contacts, and their integrity (§4.4) |
| published invites | `HKDF(base, salt = "encedo-chat-invites-v1", info = idKey, L = 32)` → AES-256-GCM | the `invite_secret` of every published link (§5.7) |
| knocks in progress | `HKDF(base, salt = "encedo-chat-waiting-v1", info = idKey, L = 32)` → AES-256-GCM | whom this client is knocking, with `name` and `note` (§5.7) |
| dismissed knocks | `HKDF(base, salt = "encedo-chat-ignored-v1", info = idKey, L = 32)` → AES-256-GCM | fingerprints (§4.2) of dismissed knockers, capped at 512 |
| last heard | `HKDF(base, salt = "encedo-chat-seen-v1", info = idKey, L = 32)` → AES-256-GCM | per contact: when it was added and when its last verified Announce was heard |
| groups left | `HKDF(base, salt = "encedo-chat-group-left-v1", info = idKey, L = 32)` → AES-256-GCM | group id and epoch of every group left (§8.3), capped at 256 |
| preferences | `HKDF(base, salt = "encedo-chat-prefs-v1", info = idKey, L = 32)` → AES-256-GCM | notification mode, media auto-fetch (§7.5) |
| outbox (terminal daemon) | `HKDF(base, salt = "encedo-chat-outbox-v1", info = idKey, L = 32)` → AES-256-GCM | the sender-side queue of §13 |

`idKey` is the identity's KID (§4.2) as 32 lowercase hex characters; `roomId` is the peer's public key for a 1:1 and the group id as hex for a group. A sealed value is stored as `base64(iv(12) ‖ ct)`. A store that predates its seal is read as plain JSON and re-sealed at its next write.

**Key names are in the clear**: every store sits under `ec-<store>-<KID>` and, for pins and group state, `…-<room>`. Stores kept plain, because they carry no contact, key or timing: the node list with the user's edits (`ec-nodes`), the transport choice (`ec-transport`), language, theme, layout, the close-to-tray preference, the last profile name and sign-in method.

The terminal client keeps the same records under the same keys in `~/.config/onchato/store.json` (mode 0600).

**Lock vs wipe.** Sign-out keeps the cache. A wipeout deletes every `ec-*` key including `emp_pub`, after which the cached data is cryptographically dead. Deleting one software profile deletes its sealed identity and every `ec-*` key carrying its KID, the same set an export takes minus the device-level settings; the KID of a profile that is not open is inside its seal, so deleting it takes its password, and without the password only a wipeout removes its state.

**Connection diary (desktop shell).** The packaged desktop app, unless built with `EC_DIARY=0`, appends lifecycle lines with a wall clock to `connection.log` in its log directory (512 KiB, rotated once): link state, a contact's presence lighting or going dark (the contact named by the first 12 characters of its public key), rotation ticks, hidden/visible transitions. Lines are admitted by an allowlist of connection vocabulary; it never holds message text; it is plain; a wipeout removes it with its rotated half.

**Profile export** (software identities): the whole profile — identity, contacts, groups, pins, the sealed stores and the plain preferences — as one blob (`.ocmig`, marker `onchato-migration`) sealed under the profile password. The owner's name is inside the seal; import refuses a name collision, and an identity already present under another name (its KID found in any key), and verifies the source before writing; it is a move, not a copy. The file is offline-attackable: file plus guessed password is the identity.

---

## 11. Security considerations

### 11.1 Primitives

| Primitive | Algorithm | Standard |
|---|---|---|
| ECDH | X25519 | RFC 7748 |
| Signatures | none; every authentication is an HMAC | — |
| PQ KEM | ML-KEM-768 (NIST level 3) | FIPS 203 |
| Hash | SHA-256 (SHA-512 in the safety number) | FIPS 180-4 |
| KDF | HKDF-SHA256 | RFC 5869 |
| MAC | HMAC-SHA256 | RFC 2104 |
| AEAD | AES-256-GCM, 96-bit nonce, 128-bit tag | NIST SP 800-38D |
| Password KDF | PBKDF2-SHA256, 1 000 000 iterations | RFC 8018 |
| Random | CSPRNG (WebCrypto `getRandomValues`) | — |

No custom primitive anywhere; the implementation composes library primitives.

### 11.2 Claims

- **Confidentiality (classical):** ECDLP hardness (X25519) and AES-256-GCM.
- **Confidentiality (quantum):** MLWE hardness (ML-KEM-768); AES-256 keeps 128 bits under Grover.
- **Integrity and authentication:** HMAC-SHA256 and the GCM tag.
- **FS:** ephemeral `EK` on both sides; an `IK` compromise does not recover `SK`. Per-message FS from single-use `MK`.
- **PCS:** classical from every DH step; post-quantum from every hybrid step (at most K = 4 steps or T = 30 min, counted in ratchet steps: a step needs a frame from the other side, which the `ack` of every `msg`, `file` and `edit` provides; a conversation of unacknowledged types alone does not step); a hard bound from the session lifetime (§7.3). None within a group epoch (§8.2).
- **Hybrid:** `SK`, and every root key after a hybrid step, is confidential while either ECDLP or MLWE is hard; argued at the AKE level (§6.4).
- **Deniability:** no signature in the protocol; every MAC key is shared by its verifier.

### 11.3 Register of known weaknesses

Numbers are stable identifiers; the retired ones are listed in `RATIONALE.md`.

- **S1 — ephemeral keys outside the HSM.** Script compromise during a handshake can use the ephemeral keys wherever they live: in the TypeScript engine as non-extractable WebCrypto keys with `dh3` and `sk_i` in JS memory; in the WASM module in linear memory of the same realm, readable by a compromised page. In the Tauri shells the native host core keeps them outside the webview, where a compromised page can drive handshakes over IPC but cannot read the keys (§3.2).
- **S4 — subscription timing.** An observer with a node's view sees which topics are subscribed and when; correlating a topic to a pair still needs both `IK_pub`s. Mitigated by rotation and ephemeral PeerIds; see §11.4.
- **S5 — ML-KEM private key client-side.** `sk_i` is in client RAM during the handshake, and a hybrid step's key between its creation and its answer. Active attacker plus endpoint compromise only.
- **S8 — ±5 min replay window.** A clock further off than the §5.4 anchor can correct is refused as replay or lets a replay through; a UX/security compromise.
- **S9 — classical authentication.** Confidentiality is PQ-hybrid; authentication rests on X25519. A future active quantum MITM is the one unaddressed threat (`RATIONALE.md`, PQ roadmap). Retrospective impersonation proof is impossible even with a broken `IK` (no signatures).
- **S11 — the file store sees file metadata.** The store and its gateway observe blob size, timing, uploader and downloader addresses, and the fetch pattern of a CID for the blob's ~5-minute life (§7.5). Content is covered by the AEAD.
- **S12 — software-identity assurance.** A password-sealed `IK` on disk is offline-guessable after theft, has no hardware bound on §9.3, and travels whole in the §10 export. The HEM path is the assurance tier.
- **S13 — the pair secret transits client RAM on firmware without in-device HKDF.** On the current HEM firmware each rendezvous derivation runs in the client over the raw `ECDH(IK_a, IK_b)` for the duration of one HKDF (§4.3); the client memoises only derived values. Rendezvous-only material; exposure is pair-linkability for the days derived, not content. Closes when the firmware derives in-device.
- **S14 — a published invite topic is public.** Anyone who read the link can subscribe and publish (§5.7). An observer learns that a 348-byte frame was published and when, never by whom; cover traffic (§5.9) removes the signal in "a knock happened". Seeding the decoy schedule from the invite secret would destroy this. Flooding the topic costs the inviter at most 60 local X25519 per minute and pushes real knocks past the open cap until it stops (a real knock is re-sent every 90 s); it never reaches the identity backend (§5.8). Once derived, `invite_priv` is in client memory for the session: a compromised client can read the knocks of that invite, as it can read everything else it receives.

### 11.4 What each party can see

**A passive observer** sees libp2p packets with ephemeral PeerIds, pseudorandom 52-character topic names, MAC'd Announces, DTLS DataChannels and Noise-wrapped relayed ciphertext, and TLS to the HSM. It does not see identities (`IK_pub` is off the wire except inside MACs verifiable only by the pair), which identities a connection or topic belongs to, or content.

**A discovery node**, and **any peer that dials one** (GossipSub announces a node's subscriptions to every connected peer; `--local-topics-only` limits that to the node's own clients' topics), sees which topics are active and their frame sizes and timing. The node sees a conversation as a pair of connections holding one topic, renewed daily on the next day's topic; per connection, how many topics it holds (the size of the contact list) - raised and blurred by the decoy subscriptions of §5.10 - and the rhythm of its Announces; on the direct plane, that a pair is negotiating (`rtc` is sealed, so not the addresses). The node cannot name anyone. What a node records is operational (`ARCHITECTURE.md`): a line per refusal, per topic joined or evicted with the full topic id, per connection with a truncated PeerId; aggregate counters; the real client address in the reverse proxy's log.

**The STUN server** (the nodes themselves, §13) sees a client's address and negotiation timing on every direct attempt; direct is opt-in. **The file store** sees S11. **The operator** is also reached for the `/health` probe of up to three nodes, a re-fetch of `index.html` to notice a new bundle, the signed release manifest, and an explicit feedback form that keeps no address.

**The origin envelope's `from`** (§13) is a state key, not an identity claim: a receiver files a frame under it; identity is proven by EH-2 and integrity by the AEAD and the group MAC, so a forged `from` files a frame where it does not open.

**An active MITM on the transport** can delay, drop, inject (rejected by MAC or AEAD) and replay (rejected by timestamp, nonce or ratchet). It cannot decrypt, complete a handshake or impersonate.

**A compromised HSM operator** sees `ecdh` queries and results and can run `ecdh(IK_a, ·)` — one of three DHs, never `SK`; it can log usage patterns (when and against which public key). Mitigation is operational: audit logs visible to the tenant, multi-operator controls on privileged operations.

**Harvest now, decrypt later** needs both X25519 and ML-KEM-768 broken; the HSM transport is PQ-hybrid as well.

Two URL switches exist for development: `?debug=1` narrates the protocol to the console with values elided (`?debug=2` adds the first 64 bytes of each frame); `?keys=1` prints secret material. A release build sets `EC_ALLOW_KEYS=0`, which compiles the second out.

---

## 12. Verification

Known-answer vectors in `docs/kat/` pin the EH-2 schedule (classical with a seeded stand-in KEM; hybrid with seeded ML-KEM-768), the hybrid ratchet exchange and the group sender chain, with fixed byte inputs so that a second implementation can reproduce them. The tests read them; `scripts/export-kat.mjs` is the only writer. `npm test` runs offline and deterministic: `SK_i == SK_r`, forward secrecy, insider-forge negatives, wire-format pins, §8 repair and roster authority, §9.1 stand-down, §10 stores. The two-browser harness drives the real bundle against a real node through the DOM, including the ciphertext-only check on the file store. Not covered by automation: the HEM device paths.

---

## 13. Transport

| Plane | Carries | Mechanism |
|---|---|---|
| Control | rendezvous subscriptions, Announce, EH-2 frames, `rtc`, group keepalive | client ↔ node: `/onchato/pick/1` (§13.2), or a full GossipSub peer (`?light=0`); node ↔ node: GossipSub |
| Data (1:1) | ratchet content | WebRTC DataChannel when selected and available (§7.3) |
| Data (fallback; groups always) | ratchet and sender-key ciphertext | through the node |

**Origin envelope.** Every frame a client publishes on a pair, self or group topic is wrapped:

```
0xE1 ‖ len(u8) ‖ from (UTF-8, len bytes) ‖ frame
```

`from` is the publisher's PeerId string (opaque to the protocol; a non-libp2p client may put any per-session identifier). A receiver takes `from` and `frame` from the envelope when the first byte is `0xE1`, and from the transport otherwise; a tagged frame whose length does not fit is dropped. `0xE1` collides with no frame family (`0x01`–`0x03`, `0x10`/`0x11`, `0x20`/`0x21`, Announce `0x7B`). Inbox topics are excluded: a knock is published bare.

**Direct plane.** Off by default; a per-device setting with three positions: *relay* (content always through the node), *auto* (direct when the channel comes up), *direct-only* (the node carries rendezvous, handshake and signalling, never content; a message with no channel waits in the delivery contract and the stall rule of §7.3 does not demote). One side declining is enough. ICE learns its reflexive address from the nodes themselves (`stun:<node>:3478`, the first three enabled nodes; Binding Requests only, no TURN); `?stun=<url>` and `?stun=0` override for a page load; `?webrtc=0` negotiates no channel; `?lb=0` disables the load-aware node choice of §5.6.

**Terminal daemon outbox.** A terminal client running unattended keeps text for an offline contact in a sealed queue on its own disk (§10; 24 h, at most 100 entries per recipient, oldest dropped) and sends it as an ordinary ratchet message when the contact's presence returns. An entry sent with a key replaces the waiting entry under the same key; the text that goes carries ` (+N wcześniejszych)` as a display suffix; keyed sends to an online recipient are throttled to one per key per 60 s. Group messages are never queued.

### 13.1 Direct file transfer

A file may travel on the DataChannel as its own frames, with no store involved, only while the direct plane carries content; it never falls back to the node. 1:1 only.

Frames share the channel's control prefix `0x00` (content frames begin at `0x10`), followed by a subtype and a `u32be` transfer id: `0x01` offer, `0x02` accept, `0x03` reject, `0x04` chunk, `0x05` receipt, `0x06` cancel, `0x07` done; `0x50`/`0x4f` remain the liveness ping and pong. The offer carries JSON `{ name, size, mime, chunk, chunks, body? }` (the transfer id is the frame's `u32be` field) (`body` an optional caption; the encoded offer ≤ 4 096 bytes — the sender clamps `name` to 200 and `mime` to 100 code units, measures, and refuses past the ceiling; a receiver refuses a frame past the ceiling, and `size = 0`); a receiver that computes a different geometry from `size` answers `reject`. A chunk frame is exactly 65 536 bytes: `0x04 ‖ id ‖ u32be(index) ‖ bytes` with 65 526 bytes of body, in order. A receipt is `0x05 ‖ id ‖ u32be(last index received)`, one every `max(1, ceil(chunks/100))` chunks; the final chunk is confirmed by `done`.

The channel is reliable and ordered; there is no retransmission, window or gap repair, and a chunk out of order fails the transfer. The receiver is asked before any byte moves; an offer unanswered for 30 s is withdrawn by the sender with `cancel`; silence mid-transfer for 60 s fails it; either side may cancel. 512 MiB ceiling; one transfer at a time per conversation.

### 13.2 `/onchato/pick/1` — the light client's stream

A light client is a libp2p peer at the door (WebSocket Secure, Noise, yamux, `identify`) that joins no GossipSub mesh: it opens one long-lived stream to its node. Frames are length-prefixed (unsigned varint); the first byte is the type:

```
client → node   0x01 PICK     topic
                0x02 DROP     topic
                0x03 PUSH     u8 len ‖ topic ‖ data
node → client   0x11 DELIVER  u8 len ‖ from ‖ u8 len ‖ topic ‖ data
                0x12 REFUSED  topic
                0x13 ACK      u8 len ‖ topic ‖ u16be reach
                0x14 PICKED   topic
```

- `topic` and `from` are UTF-8, 1–255 bytes; a frame whose lengths do not fit is dropped.
- **PICK** is answered with **PICKED** (the node now carries the topic) or **REFUSED** (quota or cap, §5.6). **DROP** releases the topic; closing the stream releases everything it picked. A PICK of the load topic (§5.6) is answered with the last load announcement of every node.
- **PUSH** publishes `data` unchanged into GossipSub on the client's behalf (the node does not open the origin envelope) and hands the same bytes to the node's other pick-holders of the topic; no prior PICK is needed. **ACK** carries the reach, clamped to 16 bits, correlated to pushes in order per topic. A client without an ACK after 5 s reports no evidence to its isolation detector; a reach of 0 is "alone".
- **DELIVER**'s `from` is the GossipSub publisher the node saw (the node itself for a pushed frame); a receiver reads the sender from the origin envelope inside `data`.
- No authentication and no per-stream rate limit on the protocol itself; flood control is the reverse proxy's per-address limits on the WebSocket handshake, and the per-peer topic quota.
- On reconnect the client dials again and re-PICKs every topic it still holds on a fresh stream; until PICKED returns, that topic's subscriber list is empty.

---

## 14. Constants

| Constant | Value |
|---|---|
| **KDF convention** | `HKDF-SHA256(ikm, salt = context, info = label, L)`: date and network for the rendezvous keys (§5), `h1` for `SK` (§6.2), `RK` for a root step and ∅ for a chain walk (§7.2, §8.1), `group_id ‖ epoch` for the group MAC keys (§8.1), `invite_secret` for the invite key, the knock key and the decoy seed (§5.8, §5.9), `u32be(slot)` for the decoy instant (§5.9), the message counter for the AEAD nonce (§7.2, §8.2). The local stores of §10 put the label in the salt |
| Wire versions | EH-2 frames and ratchet header `ver = 3`; group frame `version = 3`; Announce `v = 3`; envelope `v = 1` |
| HKDF labels (rendezvous) | `encedo-chat-rendezvous-v1`, `encedo-chat-announce-mac-v1`, `encedo-chat-rotation-v1` |
| HKDF labels (handshake, ratchet) | `encedo-handshake-v2`, `encedo-ratchet-dh-v1`, `encedo-ratchet-hybrid-v1`, `encedo-msg-key`, `encedo-chain-key`, `encedo-aead-nonce` |
| HKDF labels (groups) | `encedo-chat-group-rendezvous-v1`, `encedo-group-msg`, `encedo-group-chain`, `encedo-group-msg-mac`, `encedo-chat-group-roster-mac` |
| HKDF labels (published invites) | `encedo-chat-invite-key-v1`, `encedo-chat-invite-knock-v2`, `encedo-chat-invite-decoy-v1`, `encedo-chat-invite-decoy-slot-v1` |
| HKDF labels (decoy subscriptions, §5.10) | `encedo-chat-decoy-v1`, `encedo-chat-decoy-offset-v1`, `encedo-chat-decoy-topic-v1` |
| Decoy subscriptions (§5.10) | `min(contacts, 8)`; random per-session MAC key; drop all on any refusal |
| HKDF labels (local stores, §10) | `encedo-chat-group-cache-v1`, `encedo-chat-pin-cache-v1`, `encedo-chat-contact-book-v1`, `encedo-chat-invites-v1`, `encedo-chat-waiting-v1`, `encedo-chat-ignored-v1`, `encedo-chat-seen-v1`, `encedo-chat-group-left-v1`, `encedo-chat-prefs-v1`, `encedo-chat-outbox-v1` |
| EH-2 initiator tag (§6.1) | label `encedo-eh2-initiator-tag-v1` under the day's Announce key → `k_tag`; `initiator_tag = HMAC-SHA256(k_tag, IK_i_pub)`, 32 B; msg1 1260 B |
| Hybrid ratchet cadence (§7.2) | a key every K = 4 own DH steps or T = 30 min; `pq_pub` 1184 B on every frame until answered; `pq_ct` 1088 B on every frame of the answering chain |
| Safety number (§4.4.1) | label `encedo-chat-safety-v1`, 5200 SHA-512 iterations per half, 60 digits; QR prefix `onchato-sn1:` |
| Fingerprint (§4.2) | `SHA-256(pub)[0:8]`, 16 hex digits; identification only |
| KID (§4.2) | `SHA-1(pub)[0:16]` |
| Topic | base32 RFC 4648, lowercase, no padding, 52 characters |
| Frame type bytes | `0x01`–`0x03` EH-2 · `0x10` ratchet content · `0x11` ratchet content with ML-KEM fields · `0x20` group message · `0x21` group keepalive · `0xE1` origin envelope (outermost on pair, self and group topics; never on inbox topics) · on the pick stream only: `0x01`–`0x03`, `0x11`–`0x14` (§13.2) · on the DataChannel: `0x00` control prefix (§13.1) |
| Ratchet header (§7.2) | 42 B, or ≤ 2 319 B with ML-KEM fields; the whole header is the AAD |
| Group frame (§8.2) | type `0x20`, header 32 B (gid 16 ‖ sender 8 ‖ epoch 4 ‖ ctr 4), one 8+32 B MAC entry per other member |
| Knock frame (§5.8) | 348 B always: `eph_pub` 32 + ct 300 + tag 16; plaintext `kind` 1 + `ik` 32 + `nameLen` 1 + `name` 64 + `noteLen` 2 + `note` 200 |
| Frame and text size | published frame ≤ 65 536 B (client and node, §5.6; the DataChannel ceiling); `msg.body` ≤ 62 464 B of JSON |
| Envelope (§7.4) | `v = 1`; `id` 6 random bytes as 8 base64 characters |
| Clock | ±5 min tolerance on Announce and handshake timestamps; anchor from a node's `Date` header, clamped ±10 min, hourly (§5.4) |
| Rotation (§5.4) | the instant derives from the topic's own key; ±30 min guard, two topics, 60 s re-check |
| Announce (§5.5) | 15 s heartbeat on the session's radio phase, beacons 1 s/3 s/7 s (pair topics; a light watch 60 s while hidden off the desktop shell; a newcomer answered at once, ≤ 1 per 3 s in a watch); 10 s on the self-topic, no beacons |
| Presence thresholds | `quiet` after 2.5 heartbeats (37.5 s, floor 35 s); gone after ~90 s |
| Inbox (§5.7–5.9) | 60 frames/min opened, counted before opening; own decoys never opened; 20 knocks/min surfaced; 512 ephemerals remembered; 512 dismissed; decoy every 45 s slot at a derived instant; the answerer listens ~8 s and re-knocks every 90 s |
| Handshake retry (§6) | attempt silent 6 s; msg1 + 3 repeats 700 ms apart; retry after random 200 ms–1.6 s; 3 s after 16 and 10 s after 24 silent attempts for a peer never established; crossed-msg1 window 2 s; mismatched-tag ignore 5 min |
| Pre-establishment queue (§6) | 32 envelopes |
| Skipped keys | 1:1: gap bound 1000, 5 chains, 24 h; group: gap bound 2000 per sender chain, 24 h |
| Session lifetime (§7.3) | 4–8 h randomised, then a forced re-handshake (lower PeerId initiates); replaced ratchet kept 60 s |
| Delivery backoff (§7.3) | 1.5 s, 4 s, 8 s, 15 s, 15 s; budget 60 s + 8 s grace; first two re-sends unconditional; 50 parked + 50 re-sendable per room |
| WebRTC (§7.3, §7.4) | ping/pong `0x00 0x50` / `0x00 0x4f`, 4 probes × 700 ms; 3 offer attempts 10 s apart; channel label `onchato` |
| Typing and away (§7.4) | `stop` after ~4 s idle; `away` after ~60 s |
| Edit (§7.4) | 15 min from the message; +5 min tolerance for a future-stamped message |
| Reply (§7.4) | 160 code points sent (+ U+2026 when clamped), ≤ 400 UTF-16 code units accepted; 4-byte author hint |
| Mention (§7.4) | name ≤ 48 characters; 4-byte key hint as 8 hex characters |
| Album (§7.4) | `id` 16 hex; sender ≤ 10 files; receiver `2 ≤ n ≤ 32` |
| Ratchet knock (§7.4) | sender locks 10 s; receiver ignores repeats within 5 s |
| Files (§7.5) | chunk 4 MiB default, 16 MiB max; file ≤ 128 MiB; a pick ≤ 10 files and 128 MiB together; store TTL ~5 min; voice note ≤ 120 s; auto-fetch opt-in, ≤ 2 MiB, 1:1 only; storage prefix `"ECF1" ‖ 0x01 ‖ 0x000000` |
| Group scale | 3–5 typical, 8–10 max (not enforced); roster blob ≤ 10 members |
| Group keepalive (§8.5) | `0x21` every 15 s on the radio phase (60 s hidden off the desktop shell); beacons 1 s/3 s/7 s per topic; reconnect burst 0/800 ms/2 s |
| Group SKD (§8.3, §8.4) | owed invitations at +10 s/+30 s/+90 s, on reload, on presence; own key at +10 s/+30 s after join or epoch; a fresh SKD on a young 1:1 (< 5 s) again at +2.5 s/+6 s; re-request one per member per 30 s; held frames 32 per sender for 2 min; early frames repeated at +2 s/+6 s for the first 30 s of a topic; recovery ask 20 s after sign-in, give up after 45 s |
| DESCR (§4.2, §8.6) | `descr` 128 B, `label` 32 B; group name ≤ 16 characters in the marker, ≤ 64 in an SKD; invite name ≤ 64 characters |
| Self-topic settling window (§9.1) | 3 s |
| Password (§4.5) | PBKDF2-SHA256 1 000 000 iterations; floor ≈ 60 bits where a password is chosen |
| Pins (§10) | 32 per room, refused not evicted |
| Outbox (§13) | 24 h, 100 per recipient; keyed sends 1 per key per 60 s |
| Pick stream (§13.2) | names ≤ 255 B; ACK awaited 5 s; one inbound RPC ≤ 1 MiB |
| Direct transfer (§13.1) | chunk frame 65 536 B = 10 B header + 65 526 B body; offer ≤ 4 096 B; 30 s offer, 60 s stall, 512 MiB; receipts every `max(1, ceil(chunks/100))` |
| Node choice (§5.6) | move at login if a second draw is ≥ 20 points lower; later if own node ≥ 85 % for a minute and another < 60 %, 1 in 5 checks per 20 s, ≤ once per 10 min |

---

## 15. Glossary

**IK** identity key (long-term X25519, purpose `ecdh`; in an HSM or password-sealed on device) · **EK** ephemeral X25519 per handshake · **SK** 32 B handshake output = `RK_0` · **RK/CK/MK** ratchet root / chain / message key · **GK** per-group X25519 key (§8) · **KID** `SHA-1(pub)[0:16]`, the HEM's index on key content · **DESCR** HSM key-metadata field · **HEM** Hardware Encryption Module firmware (REST API); **PPA/EPA** personal / enterprise appliance · **EH-2** the handshake of §6 · **self-topic** per-identity topic for duplicate-session detection (§9.1) · **Announce** rendezvous presence message · **FS / PCS / KCI** forward secrecy / post-compromise security / key-compromise impersonation · **ML-KEM** FIPS 203 KEM · **CRQC** cryptographically relevant quantum computer · **Sender key** a member's symmetric sending chain, distributed pairwise (§8) · **light client** a client on the pick stream (§13.2) · **origin envelope** the `0xE1` wrapper of §13.
