# EH-2 in ProVerif

A symbolic model of the EH-2 handshake (`SPEC.md` §6) and what ProVerif 2.05 proves about it. The model lives in `docs/proverif/`; `run.sh` runs every scenario and checks each result against what it must be, so a change that breaks a property, or a negative control that stops finding its attack, fails the script.

This is the formal model `RATIONALE.md` §4 says EH-2 gives up by not being Noise KKhfs literally: EH-2 itself, with its three deviations (no `ss` DH, one HKDF over the concatenation, explicit MAC confirmation), the `initiator_tag` and the responder-perspective DH ordering.

## What is modelled

`docs/proverif/eh2.pvl` follows `SPEC.md` §6 term for term:

```
msg1  = (EK_i, pq_pub, ts_i, initiator_tag)
        initiator_tag = HMAC(HMAC(announce_key, "encedo-eh2-initiator-tag-v1"), IK_i)
        announce_key  = HKDF(ECDH(IK_i, IK_r), date, "encedo-chat-announce-mac-v1")
SK    = HKDF(salt = H(msg1), ikm = DH(IK_r,EK_i) ‖ DH(EK_r,IK_i) ‖ DH(EK_r,EK_i) ‖ ss, "encedo-handshake-v2")
msg2  = (EK_r, pq_ct, ts_r, mac_r)      mac_r = HMAC(SK, "responder" ‖ H(msg1 ‖ EK_r ‖ pq_ct ‖ ts_r))
msg3  = mac_i                           mac_i = HMAC(SK, "initiator" ‖ H(h2_partial ‖ mac_r))
```

The responder checks the initiator tag before computing anything else. It accepts the initiator only once `mac_i` verifies (the msg3 gate). The initiator accepts the responder once `mac_r` verifies.

**The world.** Two honest identities, A and B, and C, whose private key the attacker holds (`Corrupt(C)`). Each honest identity runs an unbounded number of sessions, as initiator and as responder, with the other honest identity and with C. The attacker controls the network.

**Events.**
- `BeginI(IK_i, IK_r, SK)`: the initiator sends msg3.
- `EndI`: the initiator accepts after `mac_r`.
- `BeginR`: the responder sends msg2.
- `EndR`: the responder accepts after `mac_i`.

Secrecy is tested through a private witness, which each side seals under SK at the end of a session between honest parties.

**Abstractions**, stated so a reviewer can judge them:

- **X25519** is a Diffie-Hellman group, `exp(exp(g,a),b) = exp(exp(g,b),a)`. Small subgroups and clamping are not modelled.
- **HKDF, HMAC, SHA-256** are random oracles. Concatenation is a tuple, so it is injective.
- **ML-KEM** comes in two variants, chosen per scenario:
  - `kem-ideal.pvl`: the ciphertext reveals nothing and only the right secret key decapsulates.
  - `kem-public.pvl`: the ciphertext *is* the shared secret, so the attacker knows every `ss`.
- **Timestamps** are chosen by the attacker. The ±5 min window is not modelled. Replay is excluded by fresh ephemerals, which the injective queries check.
- **Type and version bytes** are folded into the tuple shapes.

## Results

| Scenario | File | KEM | Query | Result |
|---|---|---|---|---|
| The handshake completes | `eh2-auth.pv` | public | `EndR(A,B)`, `EndI(A,B)` reachable | reachable (sanity) |
| R authenticates I | `eh2-auth.pv` | public | `inj-event(EndR(x,y,k)) ⇒ inj-event(BeginI(x,y,k)) ∨ Corrupt(x)` | **true** |
| I authenticates R | `eh2-auth.pv` | public | `inj-event(EndI(x,y,k)) ⇒ inj-event(BeginR(x,y,k)) ∨ Corrupt(y)` | **true** |
| SK secrecy | `eh2-secrecy.pv` | ideal | `attacker(secret_I)`, `attacker(secret_R)` | **secret** |
| Forward secrecy | `eh2-fs.pv` | ideal | both identity keys leaked after the sessions | **secret** |
| KCI, B as responder | `eh2-kci.pv` | public | B's key leaked from the start; B accepts A only if A ran | **true** |
| KCI, B as initiator | `eh2-kci.pv` | public | the same leak; B accepts A only if A answered | **true** |
| KCI control | `eh2-kci.pv` | public | with B's key the attacker poses as B to A | false (expected) |
| PQ: X25519 broken | `eh2-pq-dh-broken.pv` | ideal | every X25519 secret (identities and ephemerals) leaked after the sessions | **secret** |
| PQ: ML-KEM broken | `eh2-pq-kem-broken.pv` | ideal | every ML-KEM secret key and both identity keys leaked after the sessions | **secret** |
| Negative control | `eh2-control-all-broken.pv` | ideal | everything leaked after the sessions | broken (expected) |
| Mutant: no `DH(EK_r, IK_i)` | built by `run.sh` | public | R authenticates I | **attack found** (expected); I authenticates R still true |

The injective queries cover more than identity binding. The agreement is on `(IK_i, IK_r, SK)`, so a run that accepts is matched by exactly one run of the peer with the same identities and the same key. That excludes replay, unknown-key-share and identity misbinding between A, B and C.

Run times with ProVerif 2.05 on one core are 3 to 4 minutes per file (`run.sh` prints them).

### Why authentication is checked with the public KEM

EH-2 authenticates through the X25519 DHs. The MACs are keyed by SK, and SK needs `DH(EK_r, IK_i)` or `DH(IK_r, EK_i)`, that is, an identity private key (`SPEC.md` §6.4). The KEM contributes confidentiality only. Proving authentication against an attacker who knows every `ss` is a stronger result than proving it with an ideal KEM, so it holds a fortiori.

It is also the only form that terminates. With the ideal KEM, no query about the initiator accepting finished: the file was cut after 15 minutes, and the query run alone after about 20. The cause was the initiator decapsulating an attacker-chosen ciphertext; with the public KEM the same query terminates in minutes.

### The negative controls

A model that never finds an attack proves nothing, so three results are expected to come out the other way:
- **Reachability** (`eh2-auth.pv`): both sides really complete a session, so the agreements are not true merely because nobody ever accepts.
- **The KCI control**: the leak of B's key really took effect.
- **`eh2-control-all-broken.pv`**: with every secret leaked, the attacker computes SK. This shows the leak plumbing used by the FS and PQ scenarios works. If it stopped working, those scenarios would come out "secret" for nothing.

`run.sh` treats a control that changes its result as a failure.

**A mutant**, built by `run.sh` from `eh2.pvl` and thrown away after: EH-2 without `DH(EK_r, IK_i)`. An attacker holding its own ephemeral then derives SK without A's private key. ProVerif must find the attack on "R authenticates I", and does in a few seconds, while "I authenticates R" stays true because `DH(IK_r, EK_i)` still needs B's key. That is the evidence that the model can see a real protocol defect, and not only a leak the scenario put there.

## What it does not show

- **Deniability.** It is an observational property; ProVerif's correspondence and secrecy queries do not express it. The argument (both MACs are under SK, which both parties hold) is in `SPEC.md` §6.4.
- **The ratchet** (§7), the hybrid step, the session lifetime and groups (§8) are outside this model.
- **Computational strength.** A symbolic model assumes perfect primitives. The hybrid combiner argument (concatenation inside HKDF) is the one `RATIONALE.md` §4 makes, not one this model makes.
- **The timestamp window and the clock anchor** (§5.4).
- **Implementation.** The model is of the specification. That the code implements it is what the known-answer vectors of `docs/kat/` and the TS↔Rust interop tests pin.

## Running it

```bash
# ProVerif 2.05 on PATH:
./docs/proverif/run.sh

# or in a container (opam, about five minutes to build once):
docker build -t proverif-local - <<'EOF'
FROM ocaml/opam:debian-12-ocaml-4.14
RUN opam update -y && opam install -y proverif && opam clean -a -c
ENTRYPOINT ["opam", "exec", "--", "proverif"]
EOF
PVDIR=/w PROVERIF="docker run --rm -v $PWD/docs/proverif:/w proverif-local" ./docs/proverif/run.sh
```

A single scenario: `proverif -lib docs/proverif/kem-ideal -lib docs/proverif/eh2 docs/proverif/eh2-fs.pv`. The KEM library always comes first; `run.sh` says which one each scenario uses.
