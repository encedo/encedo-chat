# HEM usage — what touches the device, and what it costs

Which operations reach the HSM, why, and how much they cost. Two views of the
same thing: **by protocol section** (does §5 need the device? does §7?) and **by
what the user is doing** (signing in, adding a contact, sending a message).

Numbers are measured, from `?debug=1` traces of a real device over the local
network, 2026-08-10 (Firefox, `my.ence.do` at 192.168.7.1, HTTPS with connection
reuse), with `keymgmt:get` accepted by the firmware. Reproduce by signing in with
`?debug=1` and filtering:

```bash
grep -E '^\[(HEM|§|ec )' log.txt
```

**The one line to remember:** a message costs **nothing**. Every ratchet step,
every sender key, every reaction and typing notice is client-side. What the
device is for is *establishing* things — identity, rendezvous, a handshake, a
cache key — and every cost below is a setup cost, paid once per session, per
contact, or per group.

---

## 1. Cost of one call

| operation | measured | why |
|---|---|---|
| bare round trip | **~0.6 s** | `getStatus`, `getVersion`, `searchKeys`, `getPubKey` |
| `authorizePassword`, **new** scope | **~2.5 s** | TWO round trips: `GET /api/auth/token` for the challenge, then `POST` with the signed eJWT |
| `authorizePassword`, cached scope | **0** | in-memory, and it says `‹cached›` in the trace |
| `ecdh` / `ecdhKid` | **~1.5 s** | one round trip plus X25519 on the device |
| `hemCheckin` | **~1.5 s** | three requests, two of them to the broker |

Two properties worth knowing before optimising anything:

- **PBKDF2 runs once per session, not per token.** `authorizePassword(password,
  …)` derives and caches the X25519 key pair; every later call passes `null` and
  reuses it. A 2.5 s token is two round trips, not key derivation.
- **A token lives 5 minutes** (`expSeconds = 300`, purged by the SDK's cache).
  So `‹cached›` holds within a burst of work. A conversation that goes quiet and
  then re-handshakes pays for a fresh token first.
- **`ecdh(kid, extKid)` is not faster than `ecdh(kid, pub)`** — measured
  1.5–1.7 s against 1.1–2.1 s, the same order. The device dominates; the payload
  does not. Use whichever is natural.

---

## 2. By protocol

### §4 — Identity & keys

| what | calls |
|---|---|
| **register** | `authorizePassword(gen)` + `createKeyPair` + read the new key's public half |
| **sign in** | `authorizePassword(list)` + `searchKeys("ETSEIC:self1,")` + read my own public key |
| **contact book** | `searchKeys("ETSEIC:peer1,<ownerKid>,")` + **one `getPubKey` per contact** |
| **add / rename / remove a contact** | a token for the scope (`imp` / `upd` / `del`) + the operation |

The per-contact `getPubKey` exists because the current firmware does not return
public keys from `key_search`. It is the single biggest scaling term in sign-in
— see §6 below.

### §5 — Rendezvous

Every topic and Announce key comes from **one** pair secret, `ss = ECDH(IK_me,
IK_peer)`, and that is the only device call in this section.

| derivation | device |
|---|---|
| pair topic (§5.1) | no — HKDF over `ss`, client-side |
| self topic (§5.2/§9.1) | one `ecdh` against our own public key |
| group topic (§5.3) | no — HKDF over `group_secret`, which never leaves the client |
| rotation offset (§5.4) | no — HKDF over `ss`, and date-independent |
| Announce MAC key (§5.5) | no — HKDF over `ss` |

`ss` is computed **once per contact per session** and shared by the presence
watch, the rotation offset and the room (`pairSecret` in `lib/core.ts`). The
promise is memoised, not the result, so callers racing each other share one
device call rather than starting three — which is what they used to do.

**The daily rollover is free.** `ss` carries no date; only the HKDF `info` does.

### §6 — EH-2 handshake

**One raw `ecdh` per handshake**, and it is unavoidable: §6.3 needs one DH
between our IK and the peer's ephemeral key. The other two DHs are our own
ephemerals, computed locally, and ML-KEM is entirely client-side.

It recurs on every re-handshake — §7.3 forces a fresh session every 4–8 h per
peer — and a re-handshake after a quiet period also pays for a fresh token.

### §7 — Double Ratchet

**Zero.** Root key, chain keys, message keys, the DH ratchet, skipped-key
handling: all client-side, all `crypto.subtle`. A conversation can run for hours
without the device being present at all.

### §8 — Groups

| what | device |
|---|---|
| send / receive a group message | **no** |
| sender key distribution | no — it rides the 1:1 ratchet |
| group topic, epoch rotation | no |
| **per-recipient MAC key `mk_ij`** | one `ecdh` per member, **memoised for the session** |
| creating a group | `createKeyPair` (GK) + read its public half + one `ecdh` per member for the roster MAC |
| membership change | `updateKey` (the marker) + one `ecdh` per **new** member; existing members cost nothing, because `ECDH(GK, IK_i)` does not depend on the epoch |
| a member's own record | `importPublicKey` of `GK_pub` at joining, `updateKey` on rename, `deleteKey` on leaving |
| reading the device's group list | `searchKeys("ETSEIC:chan")` + one `getPubKey` per group |

So a group of five costs four `ecdh` on the first message of a session, and
nothing thereafter.

### §10 — Local cache

```
base  = ECDH(IK, emp_pub)                              ← ONE device call per session
k_gid = HKDF(base, "encedo-chat-group-cache-v1", gid)  ← client-side, per group
blob  = iv ‖ AES-256-GCM(k_gid, iv, group state)
```

`emp_pub` is a random X25519 public key sitting in plain sight in
`localStorage`. The private half of IK never leaves the device, so **only the IK
holder can derive `base`** — a stolen laptop yields ciphertext and a public key.
`base` is memoised for the session, so reading the cache at start-up costs one
call and every later write costs none.

Two consequences worth stating: clearing `localStorage` loses `emp_pub` and with
it every cached group (by design — history is not synced), and a **software**
identity derives `base` locally, so its cache opens with no device at all.

---

## 3. By what the user is doing

### Signing in

Measured on a device with one contact and one group: **17 device calls, ~22.7 s
of device time** (wall clock is less — some overlap).

```
device version              0.68 s     the badge probe
device status               0.58 s     the gate
checkin                     1.62 s
token keymgmt:list          1.65 s     the session's first token
key search ETSEIC:self1,    0.58 s     which identities are on this device
token keymgmt:get           1.66 s     ONE token, every public key from here on
my own public key           0.58 s
key search ETSEIC:peer1,…   0.71 s     the contact book, scoped to this identity
token keymgmt:use:<myIK>    2.35 s     for the ECDHs; the only per-key token left
ecdh (self-topic §9.1)      0.63 s
ecdh (cache base §10)       1.25 s
  per contact:  public key 0.6–1.1 s + ecdh (pair secret) 1.25 s
ecdh (EH-2, per conversation opened) 0.62 s
```

Total device time in that trace: **15.3 s**, with one contact and one group —
and the group's marker read is not in it at all, because recovery now runs
twenty seconds after sign-in rather than competing with the room.

As a formula:

```
sign-in ≈ 12.3 s + 2.4 s × contacts        (today)
        ≈ 11.7 s + 1.3 s × contacts        (if key_search also returned public keys)
```

| contacts | today | before `keymgmt:get` |
|---|---|---|
| 1 | 14.7 s | 16.6 s |
| 5 | 24.2 s | 35.4 s |
| 10 | 36.1 s | 58.9 s |

**The win is in the slope, not the intercept.** One broad token costs 1.66 s and
replaces one 2.5 s token per contact, so with a single contact it saves under a
second; with ten it saves twenty-three. The per-contact term is what matters at
any real size, and it is **serial** — `watchContacts` awaits each contact in
turn.

Reading the device's group list (`ETSEIC:chan`, ~4.2 s with one group) is
**recovery, not the way in**, so it runs twenty seconds after sign-in rather than
competing with the room the user is waiting for.

### While the app is running

| the user… | device calls |
|---|---|
| sends or receives a 1:1 message | **none** |
| sends or receives a group message | **none** (after `mk_ij`, once per member per session) |
| reacts, types, goes away, comes back | **none** |
| sends a file | **none** — the content key is random and the bytes are encrypted locally |
| crosses the daily topic rotation | **none** |
| opens a conversation with a contact | one `ecdh` for the EH-2 handshake |
| is re-handshaked by §7.3 (every 4–8 h) | one `ecdh`, plus a token if the last one expired |
| adds a contact | broad `key_search` (the collision precheck) + `imp` token + `importPublicKey`, then the book reloads |
| renames or removes a contact | one token for the scope + the operation |
| creates a group | `createKeyPair` + read the public half + one `ecdh` per member |
| adds or removes a group member | `updateKey` + one `ecdh` per NEW member |
| joins a group | `importPublicKey` of `GK_pub`, then one `ecdh` per member on first traffic |
| leaves a group | `deleteKey` |
| signs out | none |

---

## 4. What changes with the newer firmware

**`key_search` returning public keys** removes the per-contact `getPubKey`
**and** the token that exists only to authorise it — together ~3.2 s per contact
and per group. On the measured trace that is 29% of all device time with a
single contact; with ten it is half a minute.

**`keymgmt:get`** does most of that today, and the firmware accepts it
(confirmed on a device, 2026-08-10): it is KID-independent, so one token reads
every public key instead of one token per key. The client tries it once and
remembers the answer (`pubKeyReader` in `lib/core.ts`), so a device that wanted
the narrow scope would still work.

**HKDF inside the HSM** (the §4.3 target) changes the shape of §5, and not
entirely for the better:

- messages stay at **zero** — the ratchet does not care where HKDF runs;
- EH-2 keeps its one raw `ecdh` — §4.3 keeps raw mode for the handshake;
- but the pair topic and the Announce MAC key become **device calls**, per
  contact **per day**, where today they are free HKDFs over a cached `ss`.

So the daily rollover stops being free, and sign-in needs two calls per contact
instead of one — unless the client caches the **derived per-day values** (the
topic string, the Announce key). That is the cache to build when the firmware
lands, and it is a much easier one to justify than caching `ss`: a topic is a
public identifier and the Announce key authenticates presence, not content.

Caching `ss` itself is deliberately **not** done. It is the secret whose entire
security story is that it stays rendezvous-only and short-lived in RAM, and the
newer firmware exists precisely to stop it reaching the client at all.

---

## 5. Rules for anything added later

- **Never call the device on a message path.** If a feature needs the HSM per
  message, the design is wrong — look at how `mk_ij` is memoised instead.
- **Cache the promise, not the result.** Two callers racing for the same secret
  should share one device call; caching the result only helps the second one.
- **A failure is not an answer.** Every memo here drops its entry when the call
  rejects, or a device that was briefly asleep is remembered as a fact.
- **Scope width follows what is being authorised.** A broad scope for reading
  public keys costs nothing — the material is public. `use:<KID>` for an ECDH,
  and `imp`/`upd`/`del`, stay narrow.
- **Measure before optimising the wrong thing.** `ecdh(kid, extKid)` looked like
  a speed-up and is not; the wins were all in *fewer* calls.
