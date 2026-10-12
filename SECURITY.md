# Security policy

## Reporting

Write to **office@rkv.pl** (RKV sp. z o.o., the operator of onchato and the
author of this code). Say what you found, how to reproduce it, and which
version or commit. We answer within five working days with what we think it
is, and we keep you informed until it is fixed. We do not run a bounty.

Please do not open a public issue for something that can hurt users before it
is fixed. We ask for **90 days** from the report to the public disclosure,
less by agreement once a fix has shipped; we credit the reporter unless asked
not to.

## Scope

- `impl/` - the client engine, the web app, the terminal client, the Tauri
  shells (desktop, Android, iOS).
- `relay/` - the discovery node.
- `infra/` - the operator's nginx, STUN, file-store prefixer, feedback sink,
  geoblock and deploy scripts as versioned here.
- `docs/PROTOCOL.md`, `docs/THREAT-MODELS.md` - the protocol and its threat
  model are in scope as documents: a property the spec claims and the code
  does not deliver is a finding, not a typo.

Out of scope here, with their own channels: the HEM firmware and the
`hem-sdk-js` client (Encedo), and the libraries this code depends on (report
upstream; tell us too).

## What we consider a finding

Anything that lets somebody who is not a party to a conversation read it,
forge a message or a group key, learn which identities a connection belongs
to, take over a session, or make a client derive the wrong rendezvous with the
wrong peer - and anything on a node or the file store that goes beyond what
`docs/PROTOCOL.md` 12 says the operator sees. The weakness register (`11.3`,
S1-S14) lists what is already known and accepted; a way to turn one of those
into something worse is a finding.

## Keys and signatures

Releases are signed by three CI-held keys (`docs/ARCHITECTURE.md`,
Distribution). There is no offline root key yet; that is an open item, and a
compromise of the update channel is the highest-leverage attack on this
system by our own account (`docs/THREAT-MODELS.md`, B2).

## Versions

The protocol document carries a `spec_version` and the wire a `ver`
(`docs/PROTOCOL.md`, header); before 1.0 every client updates together and
only the current version is served or accepted.
