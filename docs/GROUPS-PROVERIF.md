# Groups in ProVerif

A symbolic model of Sender-Key groups (`SPEC.md` §8) and what ProVerif 2.05 proves about it. It sits beside the EH-2 model (`EH2-PROVERIF.md`): same directory (`docs/proverif/`), same `run.sh`, which checks every result against what it must be, including the controls and the mutants.

Groups are half of the system and the most original part of its cryptography. The pairwise MAC instead of a signature and the admin's authority through an ECDH-derived roster MAC are the two places no standard construction covers. This model checks them.

## What is modelled

`docs/proverif/groups.pvl` follows `SPEC.md` §8:

```
group_id  = H(GK_pub)                 sender_id = H(IK_pub)
mk_ij     = HKDF(ECDH(IK_i, IK_j), salt = group_id ‖ epoch, "encedo-group-msg-mac")
rk_i      = HKDF(ECDH(GK,   IK_i), salt = group_id ‖ epoch, "encedo-chat-group-roster-mac")
frame     = header (gid, sender_id, epoch, ctr) ‖ AEAD(MK, envelope, aad = header)
            ‖ one (recipient_id, HMAC(mk_ij, header ‖ ct)) per other member
group-skd = { gid, GK_pub, epoch, chain, roster, rmac? }      rmac = HMAC(rk_i, roster in order)
```

The receiving rules are the ones `SPEC.md` §8.2–8.3 states.
- **Frames.** A receiver verifies *its own* MAC before anything else, then decrypts with the sender's chain.
- **Rosters.** A member takes a roster only from an SKD whose sender is `roster[0]`, for a `gid` equal to `H(GK_pub)`, under an `rmac` that verifies with the member's own `rk_i`.
- **Sender keys.** A sender key is taken only from a sender the attested roster holds.
- **Storage.** Chains and rosters are kept per group id, as the client keeps a session per `gid`.

**The world.** Admin A holds GK; B, C and D are members. Epoch 0 is {A, B, C, D}. Epoch 1 removes D, leaving {A, B, C}. Every member sends any number of messages in every epoch it belongs to. A *corrupt* member is handed whole to the attacker: its identity key and both directions of every 1:1 session it has, and so every chain key anyone gave it.

**Abstractions**, stated so a reviewer can judge them:
- **The 1:1 sessions** an SKD rides are authenticated private channels, one per ordered pair. Their properties are what `EH2-PROVERIF.md` proves.
- **The per-message key** is `HKDF(chain, ctr)` for a fresh public counter. The hash-chain walk, and its forward secrecy within an epoch, are not modelled; `SPEC.md` §8.2 claims none against a held chain key.
- **Primitives:** X25519 is a DH group, HKDF, HMAC and H are random oracles, and the AEAD is ideal.
- **Not modelled:**
  - the topic and `group_secret`, which address the group rather than protect it;
  - the repair path and held frames (§8.4);
  - the keepalive;
  - deniability;
  - the HEM marker (§8.6).

## Results

| Scenario | File | Attacker holds | Query | Result |
|---|---|---|---|---|
| Groups work | `groups-auth.pv` | nobody | C accepts from A at epoch 0; B from C at epoch 1; B takes a roster (reachability) | reachable (sanity) |
| Sender authentication | `groups-auth.pv` | nobody | a member accepts m from y ⇒ y sent m in that epoch | **true** |
| Confidentiality | `groups-secrecy.pv` | nobody | what is sent to epoch 0 and epoch 1 | **secret** |
| **Insider forgery** | `groups-insider.pv` | member **B**, with every chain key B was given | C accepts m "from A" ⇒ A sent m (and in general: an accept ⇒ the sender sent it, unless sender or receiver is corrupt) | **true** |
| **Admin authority** | `groups-roster.pv` | member **C** | a member takes a roster for this group ⇒ the admin attested exactly that roster to it, at that epoch | **true** |
| **Removal** | `groups-removal.pv` | **D**, removed at epoch 1 | epoch 1 secret from D; no member but D accepts anything from D at epoch 1 | **secret / true** |
| Mutant: no receiver MAC | built by `run.sh` | B | insider forgery | **attack found** (expected) |
| Mutant: no roster MAC | built by `run.sh` | C | admin authority | **attack found** (expected) |
| Mutant: D not removed | built by `run.sh` | D | removal | **attack found** (expected) |

**Insider forgery** is the property the group design rests on. B holds A's chain key, because every member does, so B can encrypt anything a member would decrypt as A's. What B cannot produce is `HMAC(mk_AC, …)`: `mk_AC` comes from `ECDH(IK_A, IK_C)`, and B holds neither private key. Nothing proves authorship to a third party either (§8.2), but that is deniability, which is outside the model.

**Admin authority** holds against a member that is fully in the attacker's hands. C can found a group of its own and be its admin, which is a different `gid` and legitimate. For *this* group, though, C cannot make B take a roster the admin did not attest to B.

**Removal**: D keeps computing its pairwise MACs with the others at epoch 1, since nothing revokes ECDH. It is the attested roster that refuses D's sender key, and the fresh epoch-1 chains that D never receives, that keep D out.

## How the model was checked, and what it caught in itself

**Mutants.** Each takes one mechanism of §8 out, and each makes ProVerif find the attack that mechanism stops:
- remove the receiver's own MAC check, and B makes C accept "A's" message;
- remove the `rmac` check, and C plants a roster;
- keep D in epoch 1, and D reads it while members accept from it.

**Reachability.** The queries in `groups-auth.pv` show that sessions really complete, so the true results are not vacuous.

**Corrections to the model.** The first version kept chains and rosters per epoch only, without the group id. ProVerif answered with counterexamples: a member founding a group of its own got its sender key filed beside the real group's. Those were defects of the model, not of the protocol, because the client keys every group's state by `gid` (`lib/group.ts`, `GroupManager`; the `gid = H(GK_pub)` binding in `applySkd`). The model now does too.

## What it does not show

- Forward secrecy and post-compromise security *within* an epoch: there are none against a held chain key (§8.2), and the chain walk is abstracted.
- The repair path (§8.4: re-request, held frames, re-sends), the dissolution and the owed invitations (§8.3).
- Deniability.
- Computational strength. A symbolic model assumes perfect primitives.

## Running it

`./docs/proverif/run.sh` runs these with the EH-2 scenarios; see `EH2-PROVERIF.md` for the container. A single scenario:

```bash
proverif -lib docs/proverif/groups docs/proverif/groups-insider.pv
```
