# Groups v1 — design record

**Status:** the design record behind `docs/PROTOCOL.md` §8/§5.3 — decisions
reached 2026-08-01, built through 2026-08, brought up to the shipped state
2026-08-30. **`docs/PROTOCOL.md` is normative for what is on the wire**; this
file keeps the reasoning, the rejected alternatives, and the marker layout
detail. Where the two disagree, PROTOCOL.md wins.

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
| cache key | AES-GCM | via HEM (§10) | protects the local cache (from `base = ECDH(IK, emp_pub)`, salt `encedo-chat-group-cache-v1`) |

### Topic

```
topic = base32(HKDF-SHA256(
          ikm  = group_secret,                        // client-side secret, NOT GK_pub
          salt = "encedo-chat-group-rendezvous-v1",
          info = network_id ‖ 0x00 ‖ date_UTC,
          L    = 32))[0:52]
```
Rotates per-epoch (group_secret changes on membership change) and daily at
plain UTC midnight, with the pairs' ±30 min guard (offset 0) and a 60 s
re-check — the room walks the date itself, keepalives warm both live topics
inside the guard, sends go to the current day's (`PROTOCOL.md` §5.3, fixed
2026-08-30 after the audit flagged the frozen-date defect).
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

`SenderKeyDistribution { gid, GK_pub, epoch, group_secret, chain_key_sender,
ctr, roster, MAC_i }` sent **pairwise over the existing 1:1 EH-2/ratchet**. To
be in a group you must have a 1:1 channel with every member ⇒ **v1: all members
are mutual contacts** (introduction/TOFU deferred). What the code actually
enforces is one-sided: the creation modal offers only entries from the contact
book, and mutuality follows from the fact that the SKD cannot arrive until the
1:1 opens — there is no explicit mutuality check.

Two parts of distribution exist because "sent once" fails in practice:

- **`ctr` — the counter the chain key is at.** A sending chain ratchets per
  message, so a key handed over mid-conversation is `chain@k`; a receiver seeded
  at 0 can never open anything. Absent ⇒ 0, so old SKDs stay valid.
- **The repair path (§8 in PROTOCOL.md).** A lost SKD makes one member deaf to
  exactly one sender with no error anywhere. The receiver notices at the one
  safe point — MAC verified, no chain — and asks over the 1:1 (`group-skd-req`,
  rate-limited to one ask per member per 30 s); the responder re-checks the
  roster before answering, because a removed member still holds the contact and
  the old gid.

### Topic liveness — the keepalive (a wire behaviour, not an implementation detail)

A group is passive for hours and GossipSub prunes idle mesh links; after relay
churn a silent topic quietly stops delivering. So every member publishes a
**1-byte keepalive frame** (`0x21`, distinct from the `0x20` message frame) on
the group topic every 20–28 s (20 s + 0–8 s of jitter), with early beacons at [1 s, 3 s,
7 s] after join and a burst at [0, 800 ms, 2 s] after a reconnect. Receivers
ignore the byte; the point is that the mesh sees traffic. The frame is plain
and unauthenticated — it carries nothing and authenticates nothing. Announces
are **not** sent on group topics at all.

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

**Layout — generation 1, colon-separated after a versioned prefix.**
`MARKER_SEARCH = 'ETSEIC:chan'` finds every generation (the HEM's
`allow_keysearch` matches the **first 6 bytes**, so `CHAT` (4) cannot be a
search prefix while `ETSEIC` (6) can — the same correction applied to every
other DESCR); `MARKER_PREFIX = 'ETSEIC:chan1:'` is the only form this build
writes **or reads** — the earlier comma-separated form is not parsed (pinned by
test); the generation digit exists so the NEXT change can leave old records
inert rather than misread. `gid` is **not** stored: it is `SHA-256(GK_pub)[0:16]`, and `GK_pub`
comes back with the key.

```
ETSEIC:chan1:<owner hint>:<admin hint>:<name ≤16 chars>:<roster blob base64url>
```

Shape decisions, each of which bought room or scope:

- **No `iat`.** The HSM already timestamps its own key records; spending ten of
  128 bytes to repeat what the key entry answers is not a trade worth making.
- **`ownerHint` (4 bytes of the owning identity's KID)** exists only because
  **members** write markers too: on an admin's marker the admin IS the owner,
  but a multi-identity device needs to know which of its identities a member
  marker belongs to. It went in BEFORE `adminHint`, redefining generation 1 in
  place (sound only because the test HEMs were being erased; the digit stays
  in the format, unspent, for the first change after MVP).
- **The admin is a 4-byte hint** (8 hex chars), like every roster member —
  the full KID appears only in the legacy format. Four bytes are grindable
  (~2^32), so a hint only **selects a candidate** among keys the device already
  holds; the admin's `rk_i` MAC is what decides, never this field. KIDs are
  `SHA1(pub)[0:16]` per the HEM (verified on a real device 2026-08-07);
  `SHA-256(pub)` is the app fingerprint (§4.4), a different identifier for a
  different job.
- **Name capped at 16 characters.** It is a label, held client-side anyway.
- **Roster blob LAST**, so the one optional, variable-length, occasionally
  absent field disturbs nothing before it.

**Budget — 128 BYTES, not characters.** The DESCR is a fixed 128-byte record, so
an over-long marker does not error: it **truncates**, and a truncated roster blob
decodes to a *different* roster. Names are user text, so the check must be in
UTF-8 bytes — "Zespół" is 6 characters and 8 bytes. With the owner hint the
header is 27 bytes: measured with the real builder, an **admin marker with 10
members and a 16-char ASCII name is ~103 of 128**; a member's is ~44.
`test/gmarker.test.ts` pins `byteLen ≤ 128`
at the maxima rather than a per-size table, because the table is what rotted
twice.

**Fields yield in priority order**, so nothing load-bearing disappears silently:

| field | when the field is tight |
|---|---|
| `owner hint`, `admin hint` | always present — whose group, and whom to re-sync from |
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
header and **no roster blob** (`writeMemberMarker`), so `key_search` yields the
group on their devices too. It returns `false` rather than throwing when the
import is refused — a second identity on the same device that is in the same
group cannot hold `GK_pub` twice, and the group then runs from the local cache
with no portable record. `GK` survives a rekey, so the entry is written once at
join, rewritten on rename, deleted on leave. Recovery (`deviceGroups(ownerKid)`
→ ask over the 1:1) yields `GK_pub` and the gid, never the topic or keys.

**What the CRC is not.** It catches a 4-byte hint that resolved to the wrong key
and refuses (returns nothing rather than guessing). It does **not** make a roster
trustworthy: anyone who can write this DESCR can write a matching CRC.
Authenticity is the admin's `rk_i` MAC, always.
- **Enables:** `key_search("ETSEIC:chan")` → portable group list; `GK_pub` → stable id + roster-MAC verify; `admin hint` → whom to re-sync from; roster → local offline reconstruction of the member set.
- **Does NOT hold:** `group_secret` (topic), sender keys (content). **Leak profile:** `GK_pub` leak is harmless (group existence only); **with the roster blob, one HEM dump reveals the whole membership graph** (KID hints + your contacts, both in HEM) — the trade-off for a portable roster.
- **All-wipe with roster-in-marker:** the full roster is known to everyone from their own marker → the admin can rebuild the **same** group with the complete set (no zombie), instead of founding a new one.

Two identifiers, different jobs: **HEM KID = `SHA1(pub)[0:16]`** (key index, roster hint) vs **app fingerprint = `SHA-256(pub)`** (human out-of-band MITM check, §4.4).

### Lifecycle scenarios (summary)

- **1:1 → group: NOT built.** The only creation path is the new-group modal over
  the contact list; there is no entry point from an open 1:1 conversation. The
  design (new gid, new epoch, fresh keys, 1:1 transcript stays behind) remains
  valid if it is ever wanted.
- **Dissolving a group** (built, not in the original draft): a rekey to a
  one-member roster — new `group_secret`, new topic, distributed to nobody —
  then `GK` is destroyed. It is not a delete-for-others: their clients notice
  only the silence.
- **New member:** no history by default (FS) + optional explicit 1:1 backfill (a
  member re-encrypts chosen plaintext to the newcomer — a re-share, not key-sharing).
- **Add/remove:** epoch++, everyone regenerates chain_key + new group_secret,
  redistribute (add: incl. newcomer; remove: excl. removed → removed loses topic + keys).
- **Reload (same device):** nothing — state from the encrypted cache
  (`lib/gcache.ts`, §10 schedule with salt `encedo-chat-group-cache-v1`;
  `test/group-persist.test.ts`).
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

## 2. Diff vs the pre-2026-08 spec (historical — every change below is now IN `docs/PROTOCOL.md`)

| Spec (then) | Now | Change | Why |
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

## 5. Items put to the cryptographer — all four RESOLVED

Approved and now normative in `docs/PROTOCOL.md` §8/§5.3:

1. §8 with **ECDH-HMAC** instead of Ed25519 — approved; the per-recipient MAC
   set (O(N−1)) stands at N≤10.
2. §5.3 topic = `HKDF(group_secret)` client-side, admin-random, per-epoch
   rotation, salt `encedo-chat-group-rendezvous-v1` — approved.
3. `mk_ij` from the long-term `ECDH(IK_i, IK_j)` + epoch (compromise → forge,
   not decrypt) — accepted.
4. All-wipe = new group, no old-roster recovery — accepted.

---

## 6. Implementation plan — done through stage 6

1. ✅ `lib/senderkey.ts` — chain_key hash-ratchet, MK, per-recipient ECDH-HMAC. KATs.
2. ✅ `lib/group.ts` — state, `GK`, group_secret, topic derivation, roster + `rk_i`.
3. ✅ Distribution — `group-skd` over the 1:1 ratchet, plus the repair path
   (`ctr`, `group-skd-req`) that live use on 2026-08-09 proved necessary.
4. ✅ Send/receive on the group topic; MAC verify (negative-forge test).
5. ✅ Epoch rotation on add/remove (removed loses topic + keys — tested).
6. ✅ Web GUI — groups in the contact/room list, covered by `browser-test`
   scenarios (create, invite, broadcast, mentions, reload persistence).
7. **Live 4–5 user test — still owed** (equal configs; scale test at 8 exists
   only as a unit scenario in `grouproom`).
