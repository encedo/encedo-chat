# Reading guide for the cryptographic review

Where to start, what is normative, how to run the checks, and which code file answers which part of the specification. This file is a map, not a claim; the claims are in `SPEC.md`.

## Start here

1. **`SPEC.md`** — the normative protocol: identity, rendezvous, EH-2 handshake, Double Ratchet with the hybrid step, groups, sessions, local persistence, security considerations, constants. Flat, no history. Section numbers §4–§10, §13, §14 are the ones the code cites.
2. **`RATIONALE.md`** — why each choice was made, the alternatives rejected, the decision record, the PQ roadmap, the open questions, the implementation map, and the **review checklist** (§15, common pitfalls). Read §4 there first: it maps EH-2 onto Noise KKhfs and states the three deviations (no `ss`, one HKDF over the concatenation, MAC confirmation).
3. **`EH2-PROVERIF.md`** and **`GROUPS-PROVERIF.md`** — the symbolic models of EH-2 and of Sender-Key groups (ProVerif 2.05, `docs/proverif/`; `run.sh` checks every result, the negative controls and the mutants): what is proved, under which abstractions, and what is not modelled.
4. **`THREAT-MODELS.md`** — deployment profiles P1–P3; the crypto-layer threat model lives in `SPEC.md` §2 and §11.
5. **This guide** — the section→code table and how to run the vectors.

## What is in scope

The protocol as specified, and whether the code implements it. The weakness register `SPEC.md` §11.3 lists what is already known and accepted (S1, S4, S5, S8, S9, S11–S14); a way to turn one of those into something worse, or anything the code does that the spec does not describe (or the reverse), is a finding. `SECURITY.md` has the disclosure terms and the contact.

Out of scope: a compromised HSM, a compromised endpoint, statistical traffic analysis, coercion (`SPEC.md` §2.2).

## Known-answer vectors

Fixed inputs, fixed outputs, in `docs/kat/*.json`. Written only by `scripts/export-kat.mjs`; the tests read them. Two independent implementations reproduce them:

```
# TypeScript engine (the default clients run this)
cd impl && node --test test/eh2-handshake.test.ts test/eh2-mlkem.test.ts test/senderkey.test.ts test/eh2-ratchet.test.ts

# Rust core (the WASM engine in browsers and the terminal since 0.7.21; native in the Tauri host since 0.7.31; its IPC: `NATIVE_IPC=1 node --test test/native-ipc.test.ts` after `cargo build --example core-ipc` in impl/src-tauri)
cd core-rs && cargo test
```

Each `docs/kat/` file carries the fixed scalars, seeds and a `note` naming the construction, so a third implementation can reproduce the numbers without this repository's helpers. `test/eh2-wasm.test.ts` pins that the TypeScript and Rust engines open each other's frames in both roles, through a hybrid step, out of order.

## Reproducible build

`docs/REPRODUCIBLE.md`: the chain from a tag's tree hash to the CID two independent builds agree on to the bytes the host serves. CI rebuilds the web bundle in a clean container and the Rust module on a pinned toolchain and fails on any mismatch (`.github/workflows/desktop.yml` jobs `reproduce`/`reproducible`, `ci.yml` job `core-rs`).

## Section → code

| Spec | Code |
|---|---|
| §3.2 engine selection and fallback (TS / WASM / native host) | `impl/eh2/establish.ts` (`setCoreBackend`, `startHandshake`), `impl/eh2/wasm.ts`, `impl/eh2/native.ts`, `impl/src-tauri/src/core_native.rs`, `core-rs/src/ffi.rs`; the default is chosen in `impl/web/src/app.ts` and `impl/cli/onchato.ts`; `test/native-ipc.test.ts` + `src-tauri/examples/core-ipc.rs` (native through Tauri dispatch), `test/core-status.test.ts` (fallback reporting) |
| §4.2 identity records, DESCR, fingerprint | `impl/lib/descr.ts` |
| §4.3 the derivation seam (one DH, label/ctx) | `impl/lib/derive.ts`, `impl/lib/core.ts` (`hemIdentityFrom`, `hemGkBackend`) |
| §4.4.1 safety number | `impl/lib/safety.ts`, `test/safety.test.ts` |
| §4.5 software identity, password floor | `impl/lib/profile.ts`, `impl/lib/passmeter.ts` |
| §5.1–5.5 topics, Announce, rotation offset | `impl/lib/rendezvous.ts`, `impl/lib/announce.ts`, `test/rendezvous.test.ts` |
| §5.4 clock anchor | `impl/lib/clock.ts` |
| §5.5 presence, rotating watch | `impl/lib/presence.ts`, `test/presence.test.ts`, `test/presence-rotation.test.ts` |
| §5.7–5.9 published invites, knock, decoy cover | `impl/lib/invite.ts`, `impl/lib/knock.ts`, `impl/lib/inbox.ts` |
| §5.10 decoy subscriptions | `impl/lib/decoy.ts`, `test/decoy.test.ts` |
| §6 handshake EH-2 | `impl/eh2/wire.ts`, `impl/eh2/handshake.ts`, `impl/eh2/establish.ts`; Rust: `core-rs/src/{wire,handshake}.rs`; symbolic model: `docs/proverif/eh2.pvl` (`EH2-PROVERIF.md`) |
| §6 ML-KEM-768 | `impl/eh2/mlkem.ts` (`@noble/post-quantum`); Rust: `core-rs/src/kem.rs` (`ml-kem`) |
| §7 Double Ratchet, hybrid step | `impl/eh2/ratchet.ts`; Rust: `core-rs/src/ratchet.rs`; `test/eh2-ratchet.test.ts` |
| §7.4 application envelope | `impl/lib/envelope.ts`, `impl/lib/{quote,edits,mentions,linkify}.ts` |
| §7.5 files | `impl/lib/{filecrypto,fileenvelope,cid}.ts`, `impl/net/file-decrypt.ts` |
| §8 groups, sender keys, MAC, repair | `impl/lib/{senderkey,group,grouproom,gmarker}.ts`, `test/group*.ts`; symbolic model: `docs/proverif/groups.pvl` (`GROUPS-PROVERIF.md`) |
| §9 session management, self-topic | `impl/lib/selfsession.ts`, `impl/lib/core.ts` |
| §10 local persistence | `impl/lib/{localstore,sealedstore,gcache,pincache,bookmac,localbook,seen,gleft,prefs}.ts` |
| §13 transport, origin envelope, pick stream | `impl/lib/origin.ts`, `impl/net/{onchato,peer,light}.ts` |
| §13.1 direct file transfer | `impl/lib/{xfer,xfer-session}.ts` |
| §14 the one KDF and nonce | `impl/lib/wc.ts` (`kdf`, `aeadNonce`) |

The module boundaries that keep a review of `eh2/` independent of the transport are in `RATIONALE.md` §15 (module contracts).

## Two things to know before reading the code

- **`from` is never identity.** The origin envelope's sender field (§13) is the key a receiver files a frame under, not a claim of who sent it; identity is proven by EH-2 and integrity by the AEAD and the group MAC. `SPEC.md` §11.4 states it.
- **A development switch prints secrets.** `?keys=1` narrates key material to the console (`impl/lib/protolog.ts`); it is in the audited bundle on purpose, and a release build compiles it out with `EC_ALLOW_KEYS=0`. Use it on your own session to watch the schedule.

## Changed after the freeze: local storage hardening (2026-10-14)

Local-only changes (nothing on the wire moved), made to shrink what a copied device or profile directory reveals. Each is normative in `SPEC.md` and reasoned in `RATIONALE.md` §8; listed here so the review can find them.

- **The local contact book is sealed** (`SPEC.md` §4.4, §10): AES-256-GCM under `HKDF(base, "encedo-chat-contact-book-v2", idKey)` replaces the v1 HMAC over plain JSON. A blob that does not open is `tampered`; the v1 and pre-MAC formats are verified as before and sealed at sign-in. Code: `impl/lib/localbook.ts`; tests: `impl/test/localbook.test.ts`.
- **Deleting a software profile removes its state** (`SPEC.md` §10, "Lock vs wipe"): every key carrying its KID, not just the sealed identity; an import refuses an identity already present under another name. Code: `impl/lib/migrate.ts` (`keysOfProfile`, `identityHere`).
- **Pin storage names no longer carry the room id** (`SPEC.md` §10): `ec-pin-<KID>-<HMAC(k_name, roomId)[0:16]>`, so a 1:1's key name no longer is the contact's public key. Code: `impl/lib/pincache.ts` (`pinsName`, `migrateLegacyPins`).
- **No plain-JSON downgrade of the sealed stores** (`SPEC.md` §10): sign-in seals what an older build left plain and sets `ec-sealed-<KID>`; after it `readSealedKV` ignores plain JSON, and `loadPrefs` the plain legacy preference keys. Code: `impl/lib/sealedstore.ts` (`sealPlainStores`, `STORES`/`SALTS`, now the one place each salt is written), `impl/lib/prefs.ts`; tests: `impl/test/sealedstore.test.ts`.
