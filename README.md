# Encedo Chat

A synchronous, HSM-anchored, post-quantum-hybrid peer-to-peer messenger.
Minimal infrastructure, metadata-privacy by design, end-to-end encrypted with
long-term keys held in an Encedo HEM (hardware security module).

- **Instant-only** — both parties online during a conversation; no offline
  messages, no server-side history, no mailbox. Rooms are deterministic and
  crypto-derived ("meet in the park").
- **Minimal infra** — a small set of operator-run libp2p discovery nodes;
  anyone can run their own network. Messages travel WebRTC-direct, or through a
  blind relay when direct is impossible.
- **PQ-hybrid confidentiality from day one** — X25519 + ML-KEM-768.
- **Dual-use** — one core, two channels: enterprise (Encedo Chat) and the open
  network (onchato).

> **Status: design phase.** The protocol and architecture are complete and
> under external cryptographic audit (see `docs/`). Implementation is just
> beginning — `impl/` is a spike, not yet a runnable app.

## Documentation

The design is the source of truth and lives in [`docs/`](docs/):

- [`docs/PROTOCOL.md`](docs/PROTOCOL.md) — protocol & cryptography (identity,
  rendezvous, EH-2 handshake, ratchet, groups, session management, PQ roadmap,
  implementation guide, flow diagrams).
- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — product & infrastructure.
- [`docs/THREAT-MODELS.md`](docs/THREAT-MODELS.md) — deployment profiles P1–P3.

`CLAUDE.md` holds implementation notes (HEM/SDK reality, spike plan) for agents
and developers. UI mockups (replaceable skins) are in [`skin/`](skin/).

## Layout

```
docs/         design specs (audit target)
skin/         UI mockups — open ui-mockup.html in a browser
impl/         TS spike (rendezvous spine first; crypto held pending audit)
hem-sdk-js/   Encedo HEM SDK (git submodule)
```

## Local development

Requires **Node.js ≥ 22** (Node 24 runs the TypeScript spike directly via
native type-stripping — no build step for the current slice).

```bash
# clone with the HEM SDK submodule
git clone --recurse-submodules git@github.com:encedo/encedo-chat.git
# or, if already cloned:
git submodule update --init --recursive

cd encedo-chat/impl
npm test            # once the HEM slice lands
```

The UI mockups are static — open `skin/ui-mockup.html` (or the terminal-styled
`skin/ui-mockup-hacker.html`) directly in a browser to preview the interface.

## Self-hosting

Running an independent network is a first-class, encouraged path (own nodes
from a public image, own signing key). See `docs/ARCHITECTURE.md`.

## License

[MIT](LICENSE).
