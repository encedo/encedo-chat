# Running your own onchato network

Your people keep using our apps: desktop, Android, iOS, or the web at
`app.onchato.com`. You run the network under them. Once they join it, every
connection goes to your server, and none to ours: messages, presence, files,
voice notes. The apps themselves (the web page, the installers and their
updates) still come from us.

This guide was followed end to end on a fresh VPS for the test network
`blbx.pl` (2026-10-19). What went wrong there is in "When something is wrong".

## Quick start: a network in a few minutes

**You need:**

- a fresh VPS with Ubuntu (tested on 26.04), 1 vCPU and 1 GB of RAM at least.
  One vCPU carries about 400 connected people (measured). With the file store,
  plan 2 GB.
- a DNS name pointing at it, for example `chat.example.com`. If your home domain
  (`example.com`) points at the same server too, the network gets a public page
  there with its join code.
- SSH access as root (or sudo).

On the server:

```bash
curl -fsSLO https://github.com/encedo/encedo-chat/releases/latest/download/onchato-setup.sh
sha256sum onchato-setup.sh     # compare with the SHA-256 in the release notes
less onchato-setup.sh          # read it: it runs as root
sudo bash onchato-setup.sh
```

The script first checks and prepares the machine:

- it updates the system (`apt upgrade`);
- it installs Docker (with compose and buildx) from Ubuntu's packages;
- it checks that ports 80, 443 and 3478/udp are free and that the DNS name
  points at this machine.

On a system it does not know it says what is missing and stops. Install Docker
yourself (https://docs.docker.com/engine/install/) and run it again.

Then it asks:

| question | example | what it means |
|---|---|---|
| the server's name | `chat.example.com` | where the apps connect |
| your organisation's name | `Acme` | what people see when they join |
| an e-mail for the certificate | `it@example.com` | Let's Encrypt writes there before a certificate lapses |
| files and voice notes? | `1` | 1: a store on this server; 2: an existing store; 3: text only. See "Files" |
| keep statistics? | `y` | connections and traffic per 15 minutes, kept 30 days, for a dashboard (Redis, a few MB of RAM); without them only a line in the relay's log |
| who can join | `1` | 1: anyone with the join code; 2: only devices you let in, with an 8-digit code from your authenticator. See "Who can join" |
| where the signing key is kept | `1` | 1: derived from a passphrase on this server; 2: on your own computer or a YubiKey. See "The key" |

With the key on the server it then asks for the passphrase, twice.

It sets everything up, checks it from outside, and ends like this:

```
[ok] https://chat.example.com/health answers (DNS, TLS, nginx)
[ok] the relay takes a WebSocket (101)
[ok] STUN answers on 3478/udp
[ok] the network profile is served, signed, with CORS
[ok] files: the store on this node takes a file and gives it back prefixed
[ok] the network page https://example.com/ is served
https://chat.example.com/onchato/network.json#onchato-net=bafkrei...
(the QR code)
[ok] the network example.com is running
     Operator key fingerprint: 2f8c 0444 54ff 8fc1 9d25 bc00 5136 d859
     The network page, with the code: https://example.com/
```

On the test VPS the whole run took under a minute. If the system update needs a
reboot, the script says so at the end; the network comes back by itself.

**Your people join:**

- **On a phone:** the sign-in screen, "another network", then scan the code (on
  the network page, or the one printed above).
- **On a desktop:** paste the link instead.

Then they compare the organisation's name and the fingerprint, and create their
identity. Contacts are added as usual, with an invite.

## The key

The network profile says where your server is and what the rules are. It is
signed by your key, and every device that joins remembers that key. **You cannot
change where the key lives later without starting a new network**, so the
script asks once:

- **On this server, from a passphrase** (the default). You choose a passphrase:
  several unrelated words, 16 characters or more. The key is derived from it
  with Argon2id and a random salt, and is never stored. The server keeps only
  the salt and the public key, in `/var/lib/onchato/root.kdf`. **Back up that
  file and keep the passphrase, separately.** Both are needed to sign, and
  neither alone is enough. The passphrase cannot be changed later, because it is
  the key. The profile is valid for a year, and
  `sudo bash onchato-setup.sh --renew` asks for the passphrase and signs it again.
- **On your own computer**, optionally in a YubiKey. The script writes
  `profile.json` and `nodes.json` and prints one command to run on your computer
  (`onchato-ops network sign ...`, appendix B). You copy the signed
  `network.json` back, and the script checks and publishes it. You sign again
  every 120 days; `network check` says how many days are left.

Every new signature gives the profile a new version and a new join code (the
link carries the file's hash). Devices that already joined pick up the new
version by themselves, at sign-in and once a day. Only the printed code
changes, and the network page always shows the current one.

## The app on your own address

The script asks whether this server should also serve the onchato app, at
`https://<your server>/` (the default: yes). Then people open your address and
are in your network at once: no link to import, no choice of network. The app
is the release's own build for operators (`onchato-web-operator.tar.gz`),
downloaded with the script's release and refused unless it hashes to what the
release stamped into the script; `--update` brings the next one. Beside it the
node serves `network.js`, your signed network profile, which the page adopts.

What changes with it: the profile, the invite links and the company sign-in's
redirect URI name your address instead of `app.onchato.com`. Browsers keep data
per address, so identities made in the browser at `app.onchato.com` do not
appear at yours by themselves - move them with the profile export, or make new
ones. The desktop and phone apps are not affected.

## Files and voice notes

Files and voice notes are encrypted on the phone and parked in a store for five
minutes, until the other side downloads them. The script offers three choices:

1. **A store on this server:** Kubo, an IPFS implementation, set up as a
   private store. It runs offline, with its API on loopback only, no public
   gateway and no IPFS network. In front of it runs the same upload service as
   ours, which puts eight bytes in front of every upload, so the store never
   gives a file back byte for byte and an uploaded web page is never served as
   one. A sweeper deletes everything after five minutes. It needs about 200 MB
   of RAM.
2. **An existing store, at an address you give**, for example
   `https://onchato.com`. The script uploads a small test file, downloads it
   again, and accepts the store only when it answers the way the apps need: the
   prefix and the CORS headers. Your users' files, encrypted, then go there.
3. **None:** text and calls only.

## Who can join

The script asks at setup (and again with `--access`):

1. **Anyone with the join code** (an open network). The network page shows the
   code publicly, so treat it like an open door.
2. **Only devices you let in.** Joining then takes the join code **and** a
   current 8-digit code from your authenticator app.
3. **Only people with a company account.** Joining takes the join code and a
   sign-in at your identity provider (below: "Sign-in with company accounts").

**Setting up choice 2.** At the end of the setup the script shows a QR code.
Add it **once** to an authenticator that shows 8 digits: Google Authenticator,
Aegis or 2FAS. Not Microsoft Authenticator: it shows 6 digits, and those are not
accepted. You can see the QR again later:

- `sudo bash onchato-setup.sh --access-qr`;
- or the dashboard's button, which shows it for 15 seconds; every showing is
  logged.

**How a person joins.** They join the network as usual. On the first sign-in,
the app asks for "a code from the administrator": you read them the current
code, or send it, and it is valid for about a minute. The app enrols the device
and connects. The terminal client asks the same way, or takes `--access-code`.

**What the node knows.** In such a network every device dials with a fixed
number of its own: a key unrelated to the person's identity key, one per
identity on that device. So the node recognises a device from one session to the
next, but does not know who it is. The app says this on the screen where people
join. In an open network, and in ours, every session uses a fresh number
instead.

**Managing devices.** On the server:

```bash
A="docker run --rm --user 1000:1000 -v onchato_node-data:/data onchato-ops access"
$A list --dir /data/allow                     # devices, with the name each gave and when
$A label <end of a PeerId> "Jan, phone" --dir /data/allow
$A revoke <end of a PeerId> --dir /data/allow  # off the list; the node drops it within seconds
$A unlock --dir /data/allow                   # after too many wrong codes, see below
```

**Guessing the code.**

- Each code works once.
- An address gets 5 wrong tries per 10 minutes.
- After 20 wrong codes in total, adding devices **locks** until you unlock it.
  The dashboard and `access list` show the lock. Someone with the join code can
  then annoy you (nobody new gets in), but cannot get in.

**Sign-in with company accounts (OIDC), instead of the code.** For a company
with an identity provider (Entra ID, Google Workspace, Keycloak, Encedo OIDC):
a device gets in when its owner signs in there; nobody reads out codes. Your
node is the OIDC client and keeps the client secret; the app only opens the
sign-in and brings the result back.

1. At the provider, register a confidential web client with the authorization
   code flow and PKCE, redirect URI `https://app.onchato.com/oidc.html` (or
   your own app address + `/oidc.html`), scope `openid` (plus `email` when you
   limit by domain or record e-mails). The script prints the redirect URI too:
   with the app on your own address it is `https://<your server>/oidc.html`.
2. Choose 3 under "who can join?" - at the first setup, or later with
   `sudo bash onchato-setup.sh --access`. The script asks for the provider's
   address and checks it (discovery, the code flow, PKCE), then the client id
   and secret (the secret goes to `/etc/onchato/oidc.secret`, mode 600, and
   into the node), an optional e-mail domain and group, and what the node
   records. The profile is signed anew: the old join link and QR stop working,
   and devices learn the new rule at their next sign-in.

`OIDC_RECORD` is your policy. `none` (the default): the list holds the device's
number and the name it gave, as with codes. `sub`: also the provider's account
id, a pseudonym. `email`: the e-mail, so `access list` shows whose device it is.
A failed sign-in counts against the address (5 per 10 minutes) but never locks
enrolment for everyone. The desktop and phone apps open the sign-in in the
system browser, which hands the result back through `onchato://` (the browser
asks once whether to open onchato; on Android, tap "Open onchato" on the
page); when it does not, the page shows a code to paste into the app.

## The dashboard

Every node runs a read-only dashboard that listens on its own loopback only,
so nothing new faces the internet. Open it through SSH (the port on the left is
any free port of yours):

```bash
ssh -L 8088:127.0.0.1:8088 root@chat.example.com     # then open http://localhost:8088
```

It shows:

- the node: connections and topics against their limits, CPU, messages and
  refusals per second, the certificate, the relay's version, and whether each
  service answers (relay, STUN, nginx, the file store, Redis);
- 24 hours of connections (with statistics on);
- the network profile: version, expiry, fingerprint, and every address it is
  served at, with its HTTP status and CORS header;
- the file store, the disk and the memory.

It holds no key and cannot change anything. A network of several nodes can be
watched from one place by running it on your own machine, over SSH to every
node the profile lists:

```bash
node node/dash/dash.mjs https://chat.example.com/onchato/network.json   # then http://localhost:8088
```

## Keeping it running

| command | what it does |
|---|---|
| `sudo bash onchato-setup.sh --check` | every test from the setup, again |
| `sudo bash onchato-setup.sh --update` | the latest release, rebuilt and checked; update within one release of the apps (the app of release N works with the server of release N-1) |
| `sudo bash onchato-setup.sh --renew` | sign the profile again (the key on the server: asks for the passphrase) |
| `sudo bash onchato-setup.sh` | change an answer: it remembers them in `/etc/onchato/setup.env` and offers them as defaults |

- **Certificates** renew by themselves (certbot in its own container). Let's
  Encrypt issues at most five certificates per name per week, so a machine you
  rebuild often should use `CERT_MODE=staging` in the environment while
  testing. The apps refuse staging certificates.
- **Backups:** `/var/lib/onchato` (above all `root.kdf`) and, kept apart from
  it, the passphrase. The node's own key is in a Docker volume. If it is lost,
  the node gets a new address, and you sign a new profile.
- **SSH:** some VPS images allow root to log in with a password. The script
  warns when that is so. Keys only is safer:
  `printf 'PasswordAuthentication no\nPermitRootLogin prohibit-password\n' > /etc/ssh/sshd_config.d/00-local.conf && systemctl reload ssh`.
  A firewall that is already on keeps its SSH rule; the script only opens 80,
  443 and 3478/udp.

## What you never see

Message content, files and voice notes are end-to-end encrypted, with the keys
on your people's devices. Your server sees IP addresses, times and opaque topic
names, not who talks to whom. Contact lists and group membership stay on the
devices. A person can reach someone only with that person's invitation.

**Joining is a new identity.** Someone who already uses onchato gets a second
identity for your network; their existing one is untouched.

---

## Appendix A: what the script installs

| piece | where | reachable from outside |
|---|---|---|
| relay | container, behind nginx at `/relay` | 443 only (the relay itself listens on loopback 9001) |
| STUN | container | 3478/udp, the only port not behind nginx |
| nginx + certificates | containers | 80, 443 |
| network profile | `https://<server>/onchato/network.json`, with CORS | 443 |
| network page | `https://<home domain>/`, when that domain points here | 443 |
| file store (choice 1) | Kubo (offline) + the upload service + the sweeper | 443 at `/f` only |
| statistics (optional) | Redis, 30 days, loopback | no |
| dashboard | container, 127.0.0.1:8088 (SSH tunnel) | no |
| enrolment (choice 2 of "who can join") | container, behind nginx at `/onchato/enroll` | 443 only |

On the test VPS, checked from outside: 5001, 4001, 8089, 9202, 6379, 9001 and
9003 are closed. Everything lives in `/opt/onchato` (code, built on the server
from a release tag, with no image registry), `/var/lib/onchato` (profile, page,
`root.kdf`) and Docker volumes (the node's key, certificates, the store).

**More than one server:** each server runs the script. Then each node's
`/opt/onchato/node/node.env` gets the others' addresses (`PEERS`, `SIBLINGS`,
`V6_HOST`; the mesh runs over IPv6 port 9002), and the profile lists all nodes
(`nodes.json`, signed again).

## Appendix B: the tool, by hand

`scripts/onchato-ops.mjs`, in a checkout of this repository (Node 24). On the
server it runs in a container, so the server needs no Node.

```bash
node scripts/onchato-ops.mjs network key --yubikey               # or --file <keyfile>, --passphrase[-new] <root.kdf>
node scripts/onchato-ops.mjs network sign profile.json --nodes nodes.json --sign-yubikey --out network.json
node scripts/onchato-ops.mjs network check network.json --online # what an app will see, CORS included
node scripts/onchato-ops.mjs network link <url of network.json> network.json --png join.png
```

`sign` fills in the key, the dates and the version number (one above the file
it replaces). It refuses another key or a lower version, and it opens the
result the way an app will before writing it.

The profile, for reference:

```json
{
  "v": 1, "networkId": "example.com", "operator": "Acme",
  "app": { "origin": "https://app.onchato.com", "path": "/" },
  "stores": ["https://chat.example.com"],
  "profileUrls": ["https://chat.example.com/onchato/network.json"],
  "feedback": null, "home": "https://example.com/",
  "policy": { "transport": "node-only" }
}
```

- `policy.transport: "node-only"` keeps all content on your servers.
- `policy.softwareProfiles: false` allows only HEM-backed identities.
- `feedback: null` shows no feedback form.

## Appendix C: without Docker

`infra/bs-setup.sh --host chat.example.com --domain example.com` installs a node
with systemd, the way our own nodes run (`relay/DEPLOY.md` explains every step).
For a domain other than ours:

- the node gets a key of its own;
- the geoblock is off unless you pass `--geoblock`;
- the mesh is `--peers`/`--siblings`, or a single node.

It installs no file store and no network page. Sign the profile with
`onchato-ops` (appendix B).

## Appendix D: when something is wrong

| symptom | look at |
|---|---|
| the script stops on DNS | the A record must point at this server (wait for it to propagate) |
| the app cannot fetch the profile | `--check`, or `network check --online`: the HTTP status and CORS |
| "a file other than the one the link names" | the profile was signed again after the code was printed: use the network page, or print a new code |
| people do not see each other | `--check`: the `/health` and WebSocket lines |
| new conversations are refused | the server is full (topic limit): a second server, or a larger machine |
| files or voice notes fail | `--check`, the "files" line; with choice 3 there is no store |
| a file arrives as an error after a while | files live five minutes: the other side must download them in time |
| direct calls never connect | expected with `node-only`; otherwise 3478/udp in the firewall |
| a public invite shows no QR code (apps before 0.7.59) | a long name in another network was too long for the old encoder; copy the link instead |

Found while setting up `blbx.pl`, and fixed:

- `/etc/os-release` overwrote the network's home page;
- a hardened `umask` left the code unreadable to the containers;
- Docker without buildx used the wrong ignore file;
- the sweeper's ledger appeared a minute after the first upload could arrive.
