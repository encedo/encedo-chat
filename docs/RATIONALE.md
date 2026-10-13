# v6 — Rationale

Decisions that shape the protocol and are easier to audit as a record than as
prose scattered through `PROTOCOL.md`. Each entry says what was chosen, what it
was chosen against, and what would make us revisit it. `PROTOCOL.md` stays the
norm; this file explains it.

## EH-2 against Noise: what it is, and why it is not rewritten as a Noise pattern (2026-10-12)

**The mapping.** Both parties hold each other's static key before the first
byte (contacts are imported out of band, §2.3), so the Noise pattern EH-2
resembles is **KK**, not XX:

```
Noise KK             EH-2 (§6)
-> s                 (known out of band)
<- s                 (known out of band)
-> e, es, ss         msg1: ek_i_pub, pq_pub, ts, initiator_tag     — es is deferred, ss is absent
<- e, ee, se         msg2: ek_r_pub, pq_ct, ts, mac_r              — ee, es, se all enter here
-> (payload)         msg3: mac_i
```

With the hybrid-forward-secrecy extension (`e1` / `ekem1` tokens), `pq_pub` in
msg1 is `e1` and `pq_ct` in msg2 is `ekem1`, so the shape is **KKhfs**.

**The three deviations**, which are the whole of what an auditor has to argue
about beyond the published analyses of KK:

1. **No `ss`.** Noise KK mixes the static-static DH into the first message so
   the initiator is authenticated from message one (0-RTT data). EH-2 has no
   0-RTT, and `ss = ECDH(IK_a, IK_b)` is already the rendezvous secret (§5.1):
   keeping it out of the session key keeps the two key schedules disjoint, which
   is what lets a leaked pair secret cost metadata and never content (S13, F8).
   This is a deliberate narrowing, not an omission.
2. **One HKDF over the concatenated DH outputs** (`dh1 ‖ dh2 ‖ dh3 ‖ ss_kem`,
   salted by `h1`) instead of Noise's per-token `MixKey` chain. Both are standard
   combiners; the concatenation form is the one the hybrid-KEM drafts use and is
   argued at the AKE level in §6.4. It is also what makes the single HSM call per
   side possible (§4.3): the device returns one raw DH and the client folds it in.
3. **HMAC confirmation instead of AEAD-of-empty-payload.** Noise proves key
   possession by encrypting the (possibly empty) payload under the chained key;
   EH-2 by `mac_r` / `mac_i` over the transcript. Same property (explicit key
   confirmation, mutual), same deniability (no signatures either way).

**Cost of rewriting EH-2 as literal KKhfs.** `eh2/wire.ts` and
`eh2/handshake.ts` (~600 lines) replaced by a Noise state machine (`MixHash`,
`MixKey`, `Split`), `ver` bump, every KAT re-recorded, the `initiator_tag`
re-homed as handshake payload, `core-rs` ported against the new schedule. Three
to five days of work, a wire change every client must take at once, and the
analyses it buys cover KK, not KKhfs with a deferred `es` and a MAC
confirmation — so an auditor would still be arguing the deltas, only different
ones. The Double Ratchet with its hybrid step (§7.2) sits outside Noise either
way and needs its own argument regardless.

**Decision: keep EH-2, and give the auditor this mapping.** The audit pack
(`SECURITY.md`, `docs/kat/`) states EH-2 as "Noise KKhfs with three named
deviations" and argues each; a formal model, if one is commissioned, models
EH-2 as it is rather than a Noise pattern it approximates. What would reopen
this: a reviewer who can show that one of the three deviations loses a property
KK has, or a decision to adopt a Noise library for the hardened tier so that the
handshake comes from audited code rather than our own — in which case the
rewrite buys something beyond the mapping.

## One KDF convention, one nonce (2026-10-13)

**What was chosen.** Every derivation on the wire is `HKDF-SHA256(ikm, salt =
context, info = label)`: the label names the purpose, the context is whatever
scopes the key (a date and network, `h1`, the root key, a group id and epoch,
an invite secret, a message counter) and is empty where nothing does. The AEAD
nonce of a 1:1 frame and of a group frame is the same function of the
single-use message key and its counter. `PROTOCOL.md` §14 states it; `spec_version`
3.0 and `ver = 3` on every frame that carries a version mark the change.

**What it was chosen against.** Until 3.0 two families coexisted and the spec
said so in two places: the rendezvous keys, the group MAC keys and the knock
key put the label in the *salt* and the context in `info`; the handshake output,
the ratchet steps and the chain walks put the label in `info`. Both are sound
on their own (HKDF with either argument fixed is a PRF in the other), and the
split was written down as deliberate, which is exactly the kind of sentence an
auditor has to carry through the whole document. The group nonce dropped the
counter the 1:1 nonce appended, under one label: one label, two constructions,
again both safe and again two things to remember. RFC 5869 itself puts the
application-specific string in `info` and keeps `salt` for a value that is
"ideally" independent of the key material, which is what a date or an epoch is.

**Why now.** Before 1.0 the wire moves with the spec and no client reads an
older frame, so the cost is one coordinated update, and the known-answer
vectors are re-recorded in the same commit (`docs/kat/`). After 1.0 the same
change would need a protocol version negotiation it is not worth.

**What stays.** The local stores of §10 keep the label in the salt: they never
cross the wire, and re-keying them would wipe every device's cache for a
uniformity nobody outside the device can observe. The handshake `SK` and the
ratchet root step already conformed and did not move.

**What would reopen it.** A reviewer showing that the salt position matters for
some context we use (it does not for HKDF-SHA256 with inputs of these sizes),
or a port that cannot express the convention — in which case §14 is the one
line to change, and the KATs will say whether it was changed correctly.
