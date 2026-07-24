# CLAUDE.md — v6 implementation notes

Working notes for building v6. **The design docs are authoritative for the
protocol; this file is authoritative for implementation reality.** When they
disagree, it means the current hardware/SDK does not yet match the target
design — record the gap here, do **not** edit the specs to match today's
firmware.

- `docs/PROTOCOL.md` — protocol & crypto (audit target). Describes the **intended**
  design, including in-HSM HKDF.
- `docs/ARCHITECTURE.md` — product & infrastructure.
- `docs/THREAT-MODELS.md` — deployment profiles P1–P3.
- These three go to an external cryptographer for audit — **do not modify
  without explicit instruction.**

## Repo layout (this repo — `encedo/encedo-chat`)

- `docs/` — the three audit specs (PROTOCOL, ARCHITECTURE, THREAT-MODELS).
- `skin/` — UI mockups (replaceable skins; `ui-mockup.html`, `ui-mockup-hacker.html`).
- `impl/` — the TS spike (grows toward the §17 monorepo).
- `hem-sdk-js/` — the Encedo HEM SDK as a **git submodule** (→ `encedo/hem-sdk-js`).
  Our HEM client — do not fork; update via `git submodule update --remote`.
- `CLAUDE.md` (this file), `README.md`, `LICENSE` at root.

The v5 deployment (`encedo/onchato.com`) and older iterations live in a separate
local workspace, not in this repo.

## HEM / SDK reality vs. design  ← the important one

**Design (in the specs):** the HSM exposes `ecdh` in two modes — raw, and
`ecdh`+**HKDF executed inside the HSM** (salt/info/L as arguments) — so that
IK-derived secrets (rendezvous topics, announce MAC keys, cache key) never
leave the device. `docs/PROTOCOL.md` §4.3 is written against this.

**Current firmware / `hem-sdk-js`:** **no in-HSM HKDF yet.** `ecdh` returns the
**raw** 32-byte shared secret only (the REST endpoint has an optional `alg`
hash, but the SDK does not expose it). **HKDF-in-HEM is coming in a newer
firmware, per the protocol's assumptions** — the specs describe that target and
stay as-is.

**Consequence for the spike, until the newer FW ships:** compute the
rendezvous/MAC/cache HKDF **client-side over the raw `ecdh` output**. This is a
temporary *implementation detail*, not a protocol change. Note for the record
(and for the cryptographer, when relevant): on current FW the pair secret
`ss = ECDH(IK_a, IK_b)` transits client RAM — it is rendezvous-only and
disjoint from the message-key DHs, so message confidentiality is unaffected;
the exposure is metadata-linkability of that pair until IK rotation. When the
FW lands, move the derivation in-device and the gap closes.

EH-2 needs raw `ecdh` regardless (it concatenates the DH outputs client-side),
so the handshake path is unaffected by the firmware phase.

## SDK facts (from `hem-sdk-js`: `.d.ts`, `EXAMPLES.md`, `CLAUDE.md`)

The SDK **is** our HEM client — `new HEM(url)` points at a real device or, in
dev, at a local software stub (the OIDC-style model). Dependency-free,
browser + Node. Private keys never leave the device.

Auth = **scoped JWT**: `authorizePassword(password, scope)` (PBKDF2-600k +
X25519 done client-side → device-issued token) or `authorizeRemote` (mobile
push). Crypto ops need a `keymgmt:use:<kid>` scope. This answers open question
P1 (HSM auth mechanism).

Runtime uses:

| SDK method | Use |
|---|---|
| `authorizePassword` / `authorizeRemote` | scoped JWT |
| `createKeyPair(token, label, 'CURVE25519', descrB64)` | IK at onboarding (SDK sets mode `ECDH`) → `{kid}` |
| `importPublicKey(token, label, 'CURVE25519', pubBytes, descrB64)` | store a contact's IK_pub |
| `ecdh(token, kid, peerPubB64)` | **raw 32-byte shared secret** — EH-2 DHs + rendezvous base |
| `searchKeys(token, descr)` / `listKeys` / `getPubKey` | resolve contacts (search pattern encoded by SDK) |
| `deleteKey(token, kid)` | contact removal, IK rotation |
| `deriveKey(token, label, type, descrB64, kid, peerPubB64)` | **deterministic key provisioning** — makes the *same* key on two HEMs without private-key import (HSMs don't import privkeys). Provisioning/HA, **not** on the message path |

Available in the HSM, not used in Phase 1 but relevant later:
`hmacHash`/`hmacVerify`, `cipherEncrypt`/`Decrypt`/`Wrap`/`Unwrap`,
**`mlkemEncaps`/`mlkemDecaps`, `mldsaSign`/`mldsaVerify`**. The ML-KEM/ML-DSA
primitives being in the HSM **de-risk Phase 3** (long-term PQ identity — §15).

Gotchas (from the SDK's own CLAUDE.md): `createKeyPair`/`deriveKey` need a
`mode` field (CURVE25519→`ECDH`, ED25519→`ExDSA`); `searchKeys` pattern is
base64 with a leading `^`; endpoint spec of record is the sibling PHP repo
`hem-api-tester`. REST base is `/api/...` (`/api/crypto/ecdh`,
`/api/keymgmt/create|search|delete|derive`).

## Spike (decided 2026-07-24)

- **Stack:** TS on the v5 base (js-libp2p). Node 24 strips types natively —
  run `.ts` directly, zero deps for the HEM slice. Rust `core-rs` port is a
  later step, after the crypto is blessed.
- **HEM in dev:** software stub matching the SDK's endpoints (OIDC model). The
  stub must reproduce the SDK auth handshake — read `hem-sdk-js/hem-sdk.js`
  (`authorizePassword`, `#buildEjwt`, `#deriveX25519`, `#req`). Reference:
  `hem-api-tester` (PHP) if available.
- **VM (onchato.com):** localhost for M1; VM at the integration milestone.
- **Sequencing vs crypto review:** build the crypto-review-independent spine
  first (HEM client, rendezvous, Announce, discovery). **Hold EH-2 + ratchet
  (§6–7) until the cryptographer responds.**

### M1 — rendezvous spine (demoable in the UI)

Two browser windows (mockup wired to the engine) discover each other in the
deterministic room via one node: derive the day's topic, subscribe, exchange
Announce (HMAC), verify, show "peer in the room". No handshake yet.

Slice order: (0) freeze message shapes; (1) HEM stub + SDK smoke test
(createKeyPair + ecdh commutativity); (2) topic derivation + Announce; (3) node
(v5 relay evolved: `--network`, `--key-file`, TTL eviction, rendezvous-only);
(4) wire the mockup for manual two-window testing.

## Status

- Specs frozen pending cryptographer feedback — expect changes to EH-2/ratchet.
- `impl/` holds `package.json` only so far.
