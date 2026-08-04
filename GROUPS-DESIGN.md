# Groups v1 — working design (draft for the §8/§5.3 Proposal)

**Status:** working draft, not the audited spec. Feeds a `docs/PROTOCOL.md`
§8/§5.3 **Proposal** (append-only, for the cryptographer). Decisions reached in
design discussion 2026-08-01. See memory `group-design-decisions`.

**One line:** Sender Keys (messages, like Signal/WhatsApp) + decentralized
membership (like Threema, no group server) + identity in HEM. Groups are a
software layer over the existing 1:1 EH-2/ratchet — the HEM holds only identity
+ contacts + a light group marker.

---

## 1. Final design

**Scale:** 3–5 typical, max 8–10 (1:1 goes through §6–7). FS is sacred; portability
is the UX compromise, never security.

### Keys

| Key | Type | Where | Role |
|---|---|---|---|
| **IK** | X25519 | HEM | identity; 1:1 EH-2 + all derivations |
| **contact IK_pub** | X25519 pub | HEM | verify + 1:1 channel to each member |
| **GK** (group identity) | **X25519** | admin: HEM (priv+pub); member: HEM (`GK_pub`) | group marker + roster auth; **does NOT seed the topic**; stable (no per-epoch rotation) |
| **group_secret** | symmetric 32B | **client** (encrypted cache §10) | seeds the topic; admin-random; rotates per epoch; distributed over 1:1 |
| **sender chain_key** | symmetric 32B | **client** (encrypted cache) | per member; hash-ratchets forward per message (FS); fresh per epoch |
| **MK** | AES-256-GCM | client RAM | per message, from chain_key; discarded (FS) |
| `rk_i`, `mk_ij` | derived HMAC keys | **not stored** | roster + message auth (below); derived from ECDH on use |
| cache key | AES-GCM | via HEM (§10) | protects the local cache (`ECDH(IK, device_salt)`) |

### Topic

```
topic = base32(HKDF-SHA256(
          ikm  = group_secret,                        // client-side secret, NOT GK_pub
          salt = "encedo-chat-group-rendezvous-v1",
          info = network_id ‖ 0x00 ‖ date_UTC,
          L    = 32))[0:52]
```
Rotates per-epoch (group_secret changes on membership change) + daily (date_UTC).
A removed member has the old group_secret only → cannot derive the new topic.

### Message (send)

```
MK        = HKDF(chain_key, "encedo-group-msg")
header    = { gid, sender_id=SHA-256(IK_pub)[0:8], epoch, ctr }
ct        = AES-256-GCM(MK, nonce, envelope, AAD=header)
for each recipient j:
  mk_ij   = HKDF(ECDH(IK_sender, IK_j), "encedo-group-msg-mac" ‖ gid ‖ epoch)
  MAC_ij  = HMAC(mk_ij, header ‖ ct)
broadcast   { header, ct, {MAC_ij} }  →  group topic (GossipSub; not WebRTC — N²)
chain_key = HKDF(chain_key, "encedo-group-chain")     // old discarded (FS)
```
Recipient j verifies `MAC_ij` (derives `mk_ij` from its own IK + sender IK_pub),
then derives MK from the sender's chain_key and decrypts. **No signatures** →
deniable; insider-unforgeable (B lacks `mk_AC`, cannot forge A→C).

### Roster auth (admin authority, deniable)

```
rk_i  = HKDF(ECDH(GK_priv, IK_i), "encedo-chat-group-roster-mac" ‖ gid ‖ epoch)  // admin per member
MAC_i = HMAC(rk_i, roster)
```
Only the admin (holds `GK_priv`) can MAC a roster member i accepts (i verifies
with `ECDH(IK_i, GK_pub)`). Deniable (i could have made the MAC).

### Distribution

`SenderKeyDistribution { gid, GK_pub, epoch, group_secret, chain_key_sender, roster, MAC_i }`
sent **pairwise over the existing 1:1 EH-2/ratchet**. To be in a group you must
have a 1:1 channel with every member ⇒ **v1: all members are mutual contacts**
(introduction/TOFU deferred).

### Group marker (the HEM object that says "you belong to G")

**Same object for every member** — a `GK_pub` public-key entry; the admin
additionally holds `GK_priv`. Small, portable, non-secret.

- **Key material:** `GK_pub` (X25519, 32 B). Admin: the `GK` keypair (priv in HEM).
- **gid** = `SHA-256(GK_pub)[0:16]` — derived from `GK_pub`, not stored separately.
- **DESCR** (≤128 B): `CHAT:channel:<gid>:admin=<admin_KID>[:roster=<blob>]`
  - `admin_KID` — whom to ask for re-sync (KID = **`SHA1(pub)[0:16]`** per HEM; global/deterministic — same importers get the same KID).
  - **roster (optional, ≤10 members):** per member `KID[0:4]` (4 B hint) + `CRC32(concat full KIDs)` (4 B). ~44 B for 10 members → fits. Reconstruct by **HEM KID-prefix lookup**; CRC validates the mapped set (disambiguates a rare 4 B collision). **Integrity only — authenticity is the admin's `rk_i` MAC.** Must be re-written on every membership change (bounded HEM churn).

#### As implemented (`impl/lib/gmarker.ts`) — exact layout, budget, and write points

The line above is the design; this is what the code writes, and it diverges in
two places on purpose.

**Layout** — positional comma format, matching the rest of the impl's DESCRs
(`ETSEIC:self,…` / `ETSEIC:peer,…`) rather than the spec's `CHAT:channel:` colon
form. Reason on record: the HEM's `allow_keysearch` matches the **first 6 bytes**,
so `CHAT` (4) cannot be a search prefix while `ETSEIC` (6) can — the same
correction already applied to every other DESCR. `gid` is **not** stored: it is
`SHA-256(GK_pub)[0:16]`, and `GK_pub` comes back with the key.

```
ETSEIC:chan,<iat>,<admin_KID 32 hex>,<roster blob base64url>,<name>
```

**Budget — 128 BYTES, not characters.** The DESCR is a fixed 128-byte record, so
an over-long marker does not error: it **truncates**, and a truncated roster blob
decodes to a *different* roster. Names are user text, so the check must be in
UTF-8 bytes — "Zespół" is 6 characters and 8 bytes, and measuring in
`String.length` overran the field by exactly the count of non-ASCII characters.
Measured: 2 members ≈ 95 B, 5 ≈ 111 B, 10 = the ceiling.

**Fields yield in priority order**, so nothing load-bearing disappears silently:

| field | when the field is tight |
|---|---|
| `iat`, `admin_KID` | always present — identity and whom to re-sync from |
| roster blob | dropped **whole**, never partial (a partial roster is worse than none); omitted above 10 members |
| `name` | truncated first, on a character boundary; cosmetic, and held client-side anyway |

**When it is written** — three points, and only these:

1. **Group creation** — `createKeyPair(…, descr)` carries the marker from birth.
2. **Every membership change** — the roster blob is now stale, so `rekey` is
   followed by `updateKey(kid, label, descr)`. This is the "bounded HEM churn"
   above: one call per change, not per member.
3. **Never on message activity** — epochs, sender keys and the topic move
   constantly and none of them appear here.

A **member's** copy is an `importPublicKey(GK_pub)` entry carrying the same
marker, so `key_search` yields the group on their devices too.

**What the CRC is not.** It catches a 4-byte hint that resolved to the wrong key
and refuses (returns nothing rather than guessing). It does **not** make a roster
trustworthy: anyone who can write this DESCR can write a matching CRC.
Authenticity is the admin's `rk_i` MAC, always.
- **Enables:** `key_search("CHAT:channel:")` → portable group list; `GK_pub` → stable id + roster-MAC verify; `admin_KID` → whom to re-sync from; roster → local offline reconstruction of the member set.
- **Does NOT hold:** `group_secret` (topic), sender keys (content). **Leak profile:** `GK_pub` leak is harmless (group existence only); **with the roster blob, one HEM dump reveals the whole membership graph** (KID hints + your contacts, both in HEM) — the trade-off for a portable roster.
- **All-wipe with roster-in-marker:** the full roster is known to everyone from their own marker → the admin can rebuild the **same** group with the complete set (no zombie), instead of founding a new one.

Two identifiers, different jobs: **HEM KID = `SHA1(pub)[0:16]`** (key index, roster hint) vs **app fingerprint = `SHA-256(pub)`** (human out-of-band MITM check, §4.4).

### Lifecycle scenarios (summary)

- **1:1 → group:** promote — new gid, new epoch, fresh keys over the ratchets;
  old 1:1 messages stay in the 1:1 transcript, group starts fresh.
- **New member:** no history by default (FS) + optional explicit 1:1 backfill (a
  member re-encrypts chosen plaintext to the newcomer — a re-share, not key-sharing).
- **Add/remove:** epoch++, everyone regenerates chain_key + new group_secret,
  redistribute (add: incl. newcomer; remove: excl. removed → removed loses topic + keys).
- **Reload (same device):** nothing — state from the encrypted cache.
- **Single device change:** re-sync group_secret + chain_keys + roster from a
  member over re-established 1:1. History gone (FS).
- **All-wipe:** see §4.

### Chain-key lifecycle (who is online)

A `chain_key` is **per sender** and advances on **every message its owner sends**,
independent of who is listening. 3 members ⇒ 3 sending chains; each member keeps its
own + a receiving copy of the other two. **Instant-only (§10): the network stores
nothing** — a member offline when a message is sent **misses it**; the chain lets it
catch up POSITION, never recover CONTENT.

- **Sender advances regardless of audience.** A sends 3× while B, C are offline →
  A's chain `A₀→A₃`; the messages reach nobody and are gone; B/C copies of A stay at `A₀`.
- **Catch-up = fast-forward.** When a member returns, its copy of a sender's chain
  lags. On the next received message (`ctr=n`) it hash-ratchets that copy forward to `n`
  (deterministic), derives MK, decrypts. The skipped positions are messages it never
  received (unrecoverable). Bounded by a skipped-key limit (anti-DoS); a huge gap → **re-sync**
  the sender's current `chain_key` over 1:1 instead of iterating.
- **FS within the chain.** A ratcheted-past `chain_key` is discarded → even its owner
  cannot re-read its own old messages (group FS; no PCS inside an epoch).
- **Exit vs wipe (cache) — two different actions.** Closing the app / shutting the
  machine down is **LOCK**: the encrypted cache (§10, key from the HEM) **persists**; on
  return you authenticate to the HEM and **resume** every chain — no re-sync. A deliberate
  **WIPE** ("sign out & forget"; the P2/P3 default) deletes the salt → the cache is
  cryptographically dead → next start re-syncs like a new device (regenerate your own
  chain, re-fetch the others'). A normal user only LOCKs; WIPE is opt-in (or profile-enforced).
  See the §10 note below.

> **Note on §10 "logout deletes the salt".** For P1 (persistent encrypted cache) that
> line describes the **WIPE** action, not a normal exit. A normal logout/shutdown should
> **keep** the cache (it is already HEM-gated: a stolen disk without the HEM is
> unreadable), so groups resume without a re-sync. The only reason to wipe is
> **cache-forward-secrecy** — after a wipe the cached history is unrecoverable even if the
> HEM is later compromised/coerced. So: **LOCK = persist (P1 default); WIPE = deliberate /
> P2-P3.** This is a product-behaviour clarification (the crypto — cache key from HEM ECDH
> — is unchanged); flag for the cryptographer, do not edit audited §10 unilaterally.

---

## 2. Diff vs current spec

| Spec | Now | Change | Why |
|---|---|---|---|
| §8 Sender Keys | mechanism | **kept** | Signal/WhatsApp-standard, right at this scale |
| §8 **Ed25519 per-epoch signatures** | sign each msg; verify with pubkey | **REPLACED by ECDH-HMAC** (`mk_ij`) | restores deniability → **removes the S3 exception**; all-ECDH (no `exdsa_sign`) |
| §8 per-epoch **signing keypair** | generated + `signing_pub` distributed | **removed** | `mk_ij` is *derived* from IK pairs (mutual contacts) — nothing to generate/distribute |
| §5.3 group topic | `ikm = group_secret`, "to confirm" | **pinned:** `group_secret` = admin-random, **client-side**, `HKDF` client-side | **not** from `GK_pub` (that leaks the topic on HEM dump) |
| §5.3 seed origin | unspecified | **admin-random**, rejected *contributory GDH `abc·G`* | GDH = multi-round ceremony + re-key per membership change; buys only "nobody picks the (already-random) seed" — not worth it |
| §4.1 sender key/signing → client | client | **kept client** (FS) + **add GK** (X25519, HEM) | FS forbids durable message keys; GK is the only new HEM object |
| §4.2 DESCR `channel:member` per member | implied per-member entries | **DESCR = marker only** (`CHAT:channel:<gid>` + `GK_pub`); **roster NOT in DESCR** | DESCR too small for N members; roster re-synced |
| §4.3 `exdsa_sign` "not used" | not used | **still not used** — groups authenticate via HMAC | consistent |
| §14 labels | msg/chain | **+** `encedo-chat-group-rendezvous-v1`, `encedo-group-msg-mac`, `encedo-chat-group-roster-mac` | new derivations |

**Kept unchanged:** scale 3–5/8–10, MLS deferred (§11.4), no PCS within an epoch,
FS-within-chain via hash-ratchet, `encedo-group-msg` / `encedo-group-chain`.

**Net effect:** §8 becomes **all-ECDH and deniable** (drops the one signature in
the whole protocol), and §5.3 is pinned so the group topic is a real client-side
secret (no HEM-derivable topic leak).

---

## 3. Rejected alternatives (with reasons, for the auditor)

- **Deterministic HSM-derived group key** (re-derive on any device): re-derivable-
  from-HEM ⟺ **no FS**. Rejected for message keys; FS is sacred.
- **`topic = HKDF(GK_pub)`**: `GK_pub` is retrievable from HEM ⇒ HEM dump computes
  the topic. Rejected — separated marker (`GK`) from seed (`group_secret`).
- **Contributory GDH `abc·G` topic seed**: correct and HEM-native (chained `ecdh`),
  contributory, portable — but a multi-round synchronized ceremony, re-run on every
  membership change, fragile over async GossipSub. Buys "nobody picks the seed" for
  metadata that is random anyway. Not worth it.
- **`group_secret` in HEM via `cipherUnwrap`** (per-member group keypair): makes the
  topic seed durable/portable (survives all-wipe) — but adds a per-member HEM keypair,
  a wrap/unwrap ceremony, and re-wrapping on every epoch, for a partial gain (you
  re-sync sender keys anyway, and FS still loses history on all-wipe). Documented as a
  variant if all-wipe topic-survival ever becomes a priority; not v1.

---

## 4. All-wipe → **found a new group** (not partial rebuild)

If **all** members lose the client cache simultaneously, `group_secret` and the
sender keys are gone for everyone (rare, correlated total loss). Two facts settle
the handling:

1. **Losing history is FS working, not a bug.** You cannot have "FS (history
   unrecoverable)" and "history survives everyone losing everything" at once. The
   heavy models (seed in HEM) would keep the *topic* but still lose the *content*.

2. **Partial rebuild of the SAME `GK` creates zombies.** If the admin rebuilds the
   old group but does not re-add someone, that member still holds the old `GK_pub`
   (imported in HEM) and thinks they belong, but gets no new `group_secret` — a
   **zombie group**. Avoid it.

**Decision: on all-wipe, the admin founds a NEW group** — new `GK`, explicit fresh
roster, re-invite. No stale-`GK` confusion. The old group's markers are dead;
optionally the admin broadcasts a "dissolved" notice so clients prune the old marker.

Consequence: **no old-roster reconstruction is needed for all-wipe.** Single device
change (the common case) re-syncs the roster from members who still have it.

### Roster storage — evaluated (incl. the hash idea)

- **Where it lives:** client-side (encrypted cache) + re-sync from members on single
  device change. Not in DESCR (size).
- **Roster-hash-in-DESCR idea** (store `hash(sorted_roster)` — small, fits — and on
  rebuild try subsets of your contacts until the hash matches): clever, but (a) the
  reconstruction is a subset search over your contacts — fine for a small book (≤~25
  contacts → ≤ 2^25 tries), infeasible for large; (b) **made unnecessary by
  all-wipe → new group** (no old roster to reconstruct) and by roster re-sync on
  single device change. **Not adopted.** Kept here as a considered option.

---

## 5. Open items for the cryptographer

1. Bless §8 with **ECDH-HMAC** instead of Ed25519 (deniability restored; is the
   per-recipient MAC set — O(N-1) — acceptable at N≤10?).
2. Bless §5.3 topic = `HKDF(group_secret)` client-side, admin-random, per-epoch
   rotation; confirm the domain-separation salt.
3. `mk_ij` derived from the **long-term** `ECDH(IK_i, IK_j)` + epoch — auth key, not
   confidentiality; content FS is via chain_key. Confirm the FS reasoning (compromise
   → forge, not decrypt) is acceptable, or require an ephemeral auth key.
4. All-wipe = new group; is dropping old-roster recovery acceptable (it is, given FS)?

---

## 6. Implementation plan (mirrors EH-2 staging)

1. `lib/senderkey.ts` — chain_key hash-ratchet, MK, per-recipient ECDH-HMAC. KATs.
2. `lib/group.ts` — state (members, epoch, per-sender chains), `GK`, group_secret,
   topic derivation, roster + `rk_i`.
3. Distribution — `group-skd` envelope over the 1:1 ratchet; receive/store.
4. Send/receive group-msg on the group topic; MAC verify (negative-forge test).
5. Epoch rotation on add/remove (removed loses topic + keys — test).
6. Web GUI — groups in the contact/room list (fits the multi-room model).
7. **Live 4–5 user test** (equal configs); scale test at 8.

Stages 1–5 autonomous (module + test + commit), stop before 6/7 for live validation
— the EH-2 pattern.
