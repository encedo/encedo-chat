# Reproducible builds

What is reproducible, what is verified, and how to verify it yourself.

## The chain

```
git tag vX.Y.Z  ->  tree hash of the tag  ->  web build (CIDv1 of index.html)  ->  bytes https://app.onchato.com/ serves
```

- **Source.** The tag names a commit; the commit names a tree; `git rev-parse vX.Y.Z^{tree}` is the content hash of every file that went into the build. That hash, not the tag name, is what the release report records.
- **Build.** `npm ci && npm run web:build` in `impl/` on the tagged tree, with a clean working copy (the build stamps `+` into the bundle when the tree is dirty, and the hash moves with it) and no `EC_ALLOW_KEYS` (the deploy script sets none). The result is `impl/web/dist`; `index.html` carries an SRI hash for the one script it loads; that bundle is the only one (no lazily loaded chunks) and carries the encryption module inlined, so the CIDv1 (raw, sha2-256) of `index.html` covers everything a browser executes on the app origin. The other pages of `dist` are redirected off that origin.
- **Served.** The web host builds the same way from the same tag by itself (`infra/deploy-on-tag.sh`); the bytes it serves at `https://app.onchato.com/` have the same CID when everything above held.

## What CI does, per tag

`desktop.yml` runs three jobs on every version tag:

1. `release CID` builds on the GitHub runner (Node 24), states the CIDs in the draft release notes, and keeps the build as an artifact.
2. `reproduce in a container` builds the same tag again in a pinned `node:24-bookworm` image — a second toolchain, the same tree.
3. `reproducible chain` requires the two CIDs to be identical, then polls the host for up to twenty minutes until it serves that CID, and attaches `reproducible-vX.Y.Z.md` to the release with the tree hash, both CIDs and the host's state. It fails the workflow when the builds differ or the host never serves what they agree on.

## The operator's approval

A tag makes the build live; it is verifiable from the moment the operator approves it: `node scripts/approve-web.mjs --host onchato vX.Y.Z` builds the tag on the operator's machine, requires the same CID from CI's report and from the host, and signs the release manifest naming it with the root key in the YubiKey. From then on `https://onchato.com/release/manifest.json` carries `web.cid`, verifiable against `infra/root.pub`, and `scripts/web-monitor.mjs` (hourly in CI) compares it with what the host serves.

## Verifying by hand

```bash
git clone --recursive https://github.com/encedo/encedo-chat && cd encedo-chat
git checkout vX.Y.Z
cd impl && npm ci && npm run web:build && cd ..
node scripts/release-cid.mjs                          # the CID of what you built
node scripts/release-cid.mjs --check https://app.onchato.com/   # against what is served
git rev-parse vX.Y.Z^{tree}                           # the source hash the report names
```

Measured across machines and Node versions (`CLAUDE.md`): the same commit gives the same CID; a mismatch is a statement about the server or the tree, not noise.

## What is not covered

- **Desktop and Android bundles.** Packaging stamps timestamps and signatures (minisign, the Android keystore, Azure Artifact Signing), so two builds differ byte for byte even from one tree. What covers them is the signature under the CI key that the release manifest names (`ARCHITECTURE.md`, Distribution) — a different guarantee: that the bytes came from the pipeline, not that anyone can rebuild them.
- **The node list and the manifest** are content-addressed and signed respectively; they are not builds.
- **The relay.** Deployed from the tree by `git pull`; there is no artifact to reproduce.
