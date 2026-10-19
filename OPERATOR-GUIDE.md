# Running your own onchato network

> **DRAFT (2026-10-19).** The setup script and the node image run on a real
> server (the test network `blbx.pl`, set up from the v0.7.58 tag), but the
> script is **not yet attached to releases**: until it is, take it from the
> repository (`node/onchato-setup.sh`, raw from a release tag). The guide moves
> to `docs/` once it has been followed step by step.

Your people keep using our apps (desktop, Android, iOS, or the web at
`app.onchato.com`). You run the network under them: after they join it, every
connection goes to your server, none to ours.

## Quick start: a network in about five minutes

**You need** a fresh VPS (Ubuntu 24.04 or Debian 12, 1 vCPU, 1 GB RAM carries
about 400 people), and a DNS name pointing at it, e.g. `n1.blbx.pl`.

On the server:

```bash
curl -fsSLO https://github.com/encedo/encedo-chat/releases/latest/download/onchato-setup.sh
less onchato-setup.sh          # read it: it will run as root
sudo bash onchato-setup.sh
```

The script checks the machine first (system, Docker, free ports 80, 443 and
3478, that the DNS name points here) and installs Docker if it is missing. On a
system it does not know, it says what is missing and stops.

Then it asks:

| question | example | what it means |
|---|---|---|
| The server's name | `n1.blbx.pl` | where the apps connect |
| Your organisation's name | `Acme (test)` | what people see when they join |
| An e-mail for the certificate | `it@blbx.pl` | Let's Encrypt writes there before a certificate lapses |
| Files and voice notes? | 1 | 1: a store on this server (deleted after 5 minutes); 2: an existing store you name (tested first, e.g. https://onchato.com); 3: none, text only |
| Where is the signing key kept? | on this server | see "The key" below; then the passphrase, twice |

It sets everything up, checks it from outside, and ends with:

```
[ok] the network acme-blbx is running
     Operator key fingerprint: 2f92 0d9f c25f f4bd fe98 cd0b f8d0 0d78
     Join link: https://n1.blbx.pl/onchato/network.json#onchato-net=bafkrei...
     (QR code below - print it or put it on your intranet)
```

**Your people join**: in the app, on the sign-in screen, "another network",
scan the QR code (or paste the link), check the organisation name and the
fingerprint, and create their identity. That is all.

## The key

The network profile (where your server is, what the rules are) is signed by
your key, and every phone that joins remembers that key. **You cannot change
where the key lives later without starting a new network**, so the script asks
once:

- **On this server, from a passphrase** (the default). You choose a passphrase
  (several unrelated words, 16+ characters); the key is derived from it with
  Argon2id and a random salt, and is never stored. The server keeps only the
  salt and the public key (`/var/lib/onchato/root.kdf`). **Back up that file and
  remember the passphrase, separately**: both are needed to sign, neither alone
  is enough. The passphrase cannot be changed later. The profile is valid a
  year; `sudo bash onchato-setup.sh --renew` asks for the passphrase and signs it
  again (`--check` warns 30 days ahead).
- **On your own computer**, optionally in a YubiKey. The script prepares the
  profile and shows one command to run on your computer
  (`onchato-ops network sign ...`, appendix B); you copy the signed file back and
  the script checks and publishes it. You re-sign every 120 days (the
  `network check` command tells you how many are left).

## Who can join

Today: anyone who has the QR code. Treat it like a door code. A join code
from the administrator on top of the QR code (for small teams), and sign-in
through your company directory (for larger ones), are planned
(`OPERATOR-NODE-PLAN.md`, section 4).

## Keeping it running

- **Updates:** `sudo bash onchato-setup.sh --update`. Update the server within
  one release of the apps (the app of release N works with the server of
  release N-1).
- **Checking:** `sudo bash onchato-setup.sh --check` does every test the setup
  did, again.
- **Changing an answer:** run the script again; it remembers your answers
  (`/etc/onchato/setup.env`) and offers them as defaults. A new server name or
  new rules make a new profile version, which the apps pick up by themselves
  within a day.
- **Backups:** `/var/lib/onchato` (above all `root.kdf`) and, kept apart from it, the passphrase.

## What you never see

Message content, files and voice notes are end-to-end encrypted, with the keys
on your people's devices. Your server sees IP addresses, times and opaque topic
names, not who talks to whom. Contact lists and group membership stay on the
devices. A person can reach someone only with that person's invitation.

**Joining is a new identity.** Someone who already uses onchato gets a second
identity for your network; their existing one is untouched.

---

## Appendix A: what the script installs

| piece | where | port |
|---|---|---|
| relay | container, reached through nginx at `/relay` | 443 (loopback 9001) |
| STUN | container | 3478/udp, the only port not behind nginx |
| nginx + certificate | containers | 80, 443 |
| file store (optional) | Kubo + the upload prefixer + the sweeper | behind nginx at `/f` |
| network profile | served by nginx at `/onchato/network.json`, with CORS | 443 |

The firewall is opened for 22, 80, 443 and 3478/udp only. Everything lives in
`/opt/onchato` (code, built on the server from a release tag, no image
registry) and `/var/lib/onchato` (data, the server's own random node key).

More than one server: run the script on each and answer "join an existing
network"; the servers connect to each other over IPv6 port 9002.

## Appendix B: the tool, by hand

`scripts/onchato-ops.mjs`, in a checkout of this repository (Node 24):

```bash
node scripts/onchato-ops.mjs network key --yubikey                # or --file <keyfile>: the key and its fingerprint
node scripts/onchato-ops.mjs network sign profile.json --sign-yubikey --out network.json
node scripts/onchato-ops.mjs network check network.json --online  # what an app will see, CORS included
node scripts/onchato-ops.mjs network link <url of network.json> network.json --svg join.svg
```

`sign` fills in the key, the dates and the version number (one above the file
it replaces), refuses another key or a lower version, and opens the result the
way an app will before writing it. A re-signed file has a new hash: print a new
QR code after every upload; the old one is refused, safely.

The profile, for reference:

```json
{
  "v": 1, "networkId": "acme-blbx", "operator": "Acme (test)",
  "app": { "origin": "https://app.onchato.com", "path": "/" },
  "stores": ["https://n1.blbx.pl"],
  "profileUrls": ["https://n1.blbx.pl/onchato/network.json"],
  "feedback": null, "home": "https://blbx.pl/",
  "policy": { "transport": "node-only" }
}
```

`policy.transport: "node-only"` keeps all content on your servers;
`policy.softwareProfiles: false` allows only HEM-backed identities;
`feedback: null` shows no feedback form.

## Appendix C: when something is wrong

| symptom | look at |
|---|---|
| the script stops on DNS | the A record must point at this server's address (wait for it to propagate) |
| the app cannot fetch the profile | `--check`, or `network check --online`: HTTP status and CORS |
| "a file other than the one the link names" | re-signed after the QR code was printed: print a new one |
| people do not see each other | `--check`: the `/health` and WebSocket lines |
| new conversations are refused | the server is full (topic limit): a second server, or a larger machine |
| direct calls never connect | that is expected with `node-only`; otherwise 3478/udp in the firewall |

Installing without the script, step by step: `relay/DEPLOY.md`.
