# Operator node plan: the Docker node image (C4), bs-setup for any domain, access tiers

Status (2026-10-19): **built, tested locally and on a real server (blbx.pl)** - the relay's `--key-file`,
the image + compose (`node/`), the setup script (`node/onchato-setup.sh`,
`--local-test` passes end to end), the passphrase key. `bs-setup.sh --domain` (the systemd way, dry-run tested; not yet installed on a
machine) and the script as a release asset (from 0.7.59). The file store (Kubo offline + the
prefixer + the sweeper, profile `store`, tested locally) and the network page on
the home domain (live on blbx.pl) are in. Phase C of operator networks
(`docs/ARCHITECTURE.md`, "Another operator's network"). The guide an operator
follows is `docs/OPERATOR.md`. When phase C is done this file goes to
`docs/archive/`.

First deployment it is built against: a one-node test network "Acme" on
`blbx.pl` (`acme-blbx`), on a VM that is being prepared.

## 1. What a node is today

One machine, systemd units, installed by `infra/bs-setup.sh` following
`relay/DEPLOY.md`:

| piece | today | port |
|---|---|---|
| relay | `relay/relay.mjs`, unit `onchato-relay` (`relay/onchato-relay.service`) | 9001 (behind nginx `/relay`), 9002 IPv6 mesh |
| STUN | `infra/stun/stun.mjs`, unit `onchato-stun` | 3478/udp, **not** behind nginx |
| nginx | `infra/nginx/relay-node.conf` (+ limits, geoblock, abuse list) | 443 |
| certificate | certbot, webroot | 80 |
| statistics | Redis, `--stats-redis`, 30 days | loopback |
| live numbers | `--metrics-port 9003`, read by `infra/dash` over SSH | loopback |
| health push | `infra/health/` timer to an uptime monitor | outbound |
| geoblock + abuse list | `infra/geoip/` timers, `onchato-block` | - |

The file store (Kubo + `infra/fput` prefixer + TTL sweeper) and the web app
live on bs1 only.

## 2. The image (C4)

**One image, `onchato-node`, several roles; one `docker compose` file.** The
same code our nodes run, no fork.

| service | from | notes |
|---|---|---|
| `relay` | `onchato-node` | `node relay.mjs ...`, flags rendered from one env file |
| `stun` | `onchato-node` | same image, other command |
| `nginx` | `nginx:stable` | **our template** (`relay-node.conf`), rendered for the operator's domain; one source of truth with production |
| `certbot` | `certbot/certbot` | webroot, renew loop |
| `redis` | `redis:7` | optional (statistics, panel history) |
| `kubo` + `fput` + sweeper | `ipfs/kubo` + `onchato-node` | optional: the file store, for a network that carries files |

- **`network_mode: host`** for relay, STUN and nginx: UDP 3478, the IPv6 mesh
  and the real client address for the limits, without Docker's NAT in between.
- **The node key is random and unique**, made at first start in the data volume
  (`/data/node.key`, 0600). The relay needs a `--key-file <path>` flag beside
  `--pass` (code change). Our bs1-bs3 keep `--pass` until 0.9 (the user's
  decision, 2026-10-16): no rotation before then.
- **Build like `encedo-oidc`**: `git clone` on the server, `docker build
  --build-arg GIT_COMMIT=$(git rev-parse HEAD)`, no image registry. A cosign
  signature from CI can come later.
- **Configuration is one file**, `node.env`: `NODE_HOST`, `NETWORK_ID`,
  `MAX_CONNS` (default by cores: 400 on 1-2 vCPU, measured), `MAX_TOPICS`
  (4 x conns), `PEERS`, `SIBLINGS`, `V6_HOST`, `ACME_EMAIL`, `GEOBLOCK=0`,
  `STORE=0|1`, `HEALTH_PUSH_URL`. The compose file and the template read it;
  nothing is edited by hand inside a container.
- **The network profile is served by the same nginx**: a volume with
  `network.json` at `/onchato/network.json`, `Access-Control-Allow-Origin: *`,
  `Cache-Control: no-cache`. That is where `onchato-ops network sign` output is
  copied to.
- **Geoblock off by default** for other operators (opt-in, `GEOBLOCK=1`); ours
  stays on (RKV policy). The abuse list works the same in both.
- **Health**: `docker compose ps` + the relay's own startup lines (PeerId,
  port, `Tematy: limit`, `Polaczenia:`). A `check` command in the image prints
  what `bs-setup.sh --check` prints today.
- **Upgrade**: `git pull && docker compose build && docker compose up -d`. The
  N-1 promise (`SECURITY.md`, Versions): the app of release N works with the
  relay of N-1, so an operator may update nodes after the apps, never more than
  one release later.

Not in the image: the web app front (C6) and the admin panel (section 5).

### The setup script (`onchato-setup.sh`, the user's call 2026-10-18)

The operator's whole path is one download and one run: the guide's quick start.

- **Delivery**: a release asset (`releases/latest/download/onchato-setup.sh`),
  its SHA-256 in the release notes; the guide says download, read, run.
  `curl | sudo bash` works but is not what the guide leads with. The script
  checks out the SAME tag it came from, so script, image and apps stay in the
  N-1 window.
- **Preflight**: root, Ubuntu 24.04 / Debian 12 (apt), x86_64 or arm64, free
  80/443/3478, the DNS name resolving to this machine, RAM. Docker missing on a
  known system: installed from apt (`docker.io` + compose plugin). Anything
  else: say what is missing, point at the guide, stop.
- **Questions** (answers kept in `/etc/onchato/setup.env`, offered as defaults
  on a re-run): server name, organisation name, certificate e-mail, files yes/no,
  where the root key lives; derived without asking: `networkId` from the
  domain, `profileUrls` on the node itself, `app` = `app.onchato.com`,
  `feedback: null`, `policy.transport: node-only`. Advanced (flags, not
  questions): more nodes, HEM-only, a feedback URL.
- **The root key, asked once and said to be permanent** (devices pin it):
  - *on the server* (default, the user's call 2026-10-18): the key is
    DERIVED from a passphrase, Argon2id (256 MiB, 4 passes) with a random
    16-byte salt; `/var/lib/onchato/root.kdf` (0600) holds only the salt, the
    parameters and the public key (`onchato-ops network key --passphrase-new`,
    `sign --sign-passphrase`). The salt is private: the public key is in every
    profile, so a public salt would let anyone guess offline. Validity 365 days;
    `--renew` asks for the passphrase (no unattended renewal: the server holds
    nothing that signs). The passphrase cannot change - it is the key.
  - *on the operator's computer*: the script writes `profile.json`, prints the
    `onchato-ops network sign` command (YubiKey or key file), waits for the
    signed `network.json` to be copied back, checks it (`openEnvelope` under
    the expected key) and publishes it. No auto-renewal.
- **End**: the external checks (`/health`, the WebSocket 101, STUN,
  `network check --online`), then the fingerprint, the join link and its QR
  code in the terminal (`qrForTerminal`).
- **`--check`** reruns every test; **`--update`** = fetch the latest release
  tag, rebuild, restart, check.
- **Target: about five minutes** on a 1-vCPU VM, most of it the image build and
  the certificate.

## 3. `bs-setup.sh` for any domain

The script stays for systemd installs (our nodes, and operators who prefer no
Docker). Today it assumes `bsN.onchato.com` in five places. Changes:

1. `--domain <d>` (default `onchato.com`); the `bsN.` name check, the wildcard
   DNS hint and the default host only apply to our domain.
2. `--key-file` instead of `--pass` for any new node outside our network (needs
   the relay flag above); `--pass` stays for bs1-bs3.
3. The nginx site rendered from `relay-node.conf` with the domain substituted:
   the `return 301 https://onchato.com` fallback becomes the operator's `home`.
4. Geoblock and the abuse timer: `--geoblock` opt-in; `--check` reports them as
   "off" rather than `bad` when not chosen.
5. The node table at the bottom of `onchato-relay.service` is OUR mesh; for
   another domain the script asks for peers/siblings or runs single-node.
6. Unit names stay `onchato-*` (they name the software, not the network).

`--check` keeps rendering the template and diffing it against what systemd
runs, for any domain.

## 4. Access: who may connect (decisions 2026-10-18)

What already holds without any gate: content is end-to-end encrypted, topics
derive from pair secrets, and reaching a person needs their invitation. A gate
protects the operator's capacity and policy ("our nodes for our people"), not
confidentiality.

| tier | how one joins | for |
|---|---|---|
| **A. Open** | the QR code / profile only; a clone of onchato, a parallel network. A leaked QR lets anyone in. | open communities, tests |
| **B. Join code** | the QR code **and** a code from the admin (TOTP-like, short-lived); the device gets a ticket the admin can revoke | **small deployments** |
| **C. Sign-in and pairing** | sign in on the desktop (OIDC; test on the web with `encedo-oidc`), then pair the phone from the desktop, as Slack does | enterprise |
| **C+. Sign-in, anonymous tickets** | as C, but the node gets blind-signed tickets (Privacy Pass): it learns "someone of ours", not who | enterprise, EU workforce privacy |
| **D. Device certificates** | MDM-provisioned | enterprise |

The decided shape:

- **One gate on the node, many ways to a ticket.** The node accepts a
  connection that carries a valid device ticket; B and C differ only in how the
  ticket is obtained. A is the gate switched off.
- **Where the ticket rides**: in the WebSocket path (`wss://<node>/relay/<ticket>`),
  because a browser cannot set a header on a WebSocket; nginx checks it with
  `auth_request` against a small verifier on the node. `/f` the same; STUN stays
  open (it only reflects an address).
- **The profile says which tier** (a new `access` field, signed with the rest),
  so the app knows to ask for a code before the first connection.
- **The ticket is a network credential, not the identity.** In C, the account
  that signs in (and the paired phone) is the network's identity of the person;
  it is not the onchato profile and never touches its keys.

### B in more detail (PARKED 2026-10-19: needs more analysis before code)

- Join: scan the QR, the app asks for the admin's code, `POST /enroll {code}`
  to a node returns a random device ticket; the node stores its hash.
- **The code (the user's decisions, 2026-10-19): TOTP, 8 digits**, from the
  administrator's authenticator. Tested on the admin's phone with an
  `otpauth://...&digits=8` QR: **Google Authenticator shows the correct 8 digits;
  Microsoft Authenticator ignores `digits` and shows 6** (the correct 6-digit code
  of the same seed). So: Google Authenticator (or Aegis, 2FAS, FreeOTP), not
  Microsoft's. The admin adds the network's seed once (an
  `otpauth://...&digits=8` QR the setup prints) and reads codes out to the people
  joining. Checked **when a device registers**, never on the network page: the
  page and its join code can stay public and long-lived, TOTP does not protect
  them and does not need to. Why 8: one guess hits with ~3 in a million at 6
  digits (the neighbouring 30 s windows accepted), so even 20 failures an hour
  network-wide reach ~50% over a year; at 8 digits ~0.5%. Registration is still
  rate-limited per address and network-wide, with a pause after repeated
  failures. To verify on the admin's phone before release: Microsoft
  Authenticator shows 8 digits from our QR.
- Revocation: `onchato-ops access revoke <device>`; tickets have no expiry of
  their own, or a long one with silent renewal - open.
- Privacy: the operator learns which device is online and when (it already sees
  the address). Write it into `docs/THREAT-MODELS.md` when built.

### B as chosen (2026-10-19): a stable PeerId on an allowlist

The user's idea, after a bearer token was rejected for breaking "no tracking":
in a network whose profile says `policy.access: "allowlist"`, each identity
keeps its own libp2p key (sealed with its profile), so its PeerId is stable;
the node lets in only PeerIds on its list. A device joins once, with the
administrator's TOTP code (8 digits), proving it holds the key; revoking is
taking it off the list. It is tracking, but explicit and bounded: only with that
policy (never the public network, never an open one), said on the consent
screen, a pseudonym (a key unrelated to the identity key), one key per identity
per network. Proof of possession is the Noise handshake itself - no bearer
secret on the wire, in a URL or in a log.

**Step 0, done 2026-10-19** (a throwaway probe, libp2p 2.2 as pinned):
- `connectionGater.denyInboundEncryptedConnection(peerId)` refuses a peer off
  the list right after the Noise handshake; a listed one connects;
- a stored key (`privateKeyToProtobuf`/`privateKeyFromProtobuf`) gives the same
  PeerId on every start;
- taking a peer off the list and closing its connections drops it within a
  second.
- Found: the refused client sees only a generic error (`MuxerUnavailableError`,
  unexpected end of input), indistinguishable from a network fault. The app
  needs another way to learn "not on the list" (e.g. a signed status check at
  the enrol endpoint) so it says so and stops retrying.
- TOTP: the implementation matches RFC 6238's 8-digit SHA-1 vectors, and the
  codes on the admin's phone matched it: Google Authenticator 8 digits
  (94577281), Microsoft Authenticator 6 (383121, `digits` ignored).

The estimate and order (two releases: the gate, the profile field and the
stable key first, inert; then enrolment, screens, setup and dashboard) are in
the session notes of 2026-10-19; about 25-35 hours.

**Release 1, built 2026-10-19 (inert until a network sets the policy):**
`relay --allow-peers` (relay/allowlist.mjs), `policy.access: "allowlist"`
(lib/netprofile.ts), the stable key per identity (lib/netkey.ts, sealed record
`netkey`, SPEC 10, not exported), passed by the app and the CLI only under that
policy; the node image passes `ALLOW_PEERS`. Proven by net/allowlist-test.ts.

**Release 2, next:** the enrolment service (`/onchato/enroll`: challenge,
signature by the device key, TOTP 8 digits, limits, a pause after repeated
failures), the app's "code from the administrator" step and the consent text
about the stable device number, a clear "not on the list" instead of retrying
(the refused client sees only a generic error - a signed status check at the
enrol endpoint), onchato-setup.sh (open / admin code; the TOTP seed and its
`otpauth://...&digits=8` QR), `onchato-ops access list/revoke/label`, and the
dashboard: devices with last seen, and **a button that shows the authenticator
QR for 15 seconds, then hides it** (the user's idea, 2026-10-19; the dash
container then reads the seed - acceptable, it is behind the SSH tunnel; every
showing logged).

### C (to refine)

Desktop signs in through OIDC (PKCE in the browser; the system browser + deep
link in a packaged app), the phone pairs by a QR code the desktop shows. Mobile
OIDC directly is harder (system browser, app links), hence pairing first. Web
can be tested against `encedo-oidc` now.

### C+: anonymous tickets (Privacy Pass) - an option on top of C

**Why.** A C ticket names the account, so the node's log becomes a presence
record per employee ("j.nowak connected 07:52 from X, left 16:10"). End-to-end
encryption does not touch that. In the EU it is a works-council and GDPR matter,
and a node log is what gets breached or subpoenaed.

**How** (IETF Privacy Pass: RFC 9576 architecture, 9577 HTTP auth, 9578
issuance; blind RSA, RFC 9474 - the publicly verifiable token type):

1. The app signs in (OIDC) to the **issuer** (beside `encedo-oidc`), makes a
   batch of random tokens (e.g. 50), blinds them, and has the issuer sign them;
   the issuer checks the account is active and within its quota, and never sees
   the tokens.
2. The app unblinds: valid signatures on tokens the issuer never saw.
3. Each connection carries one token (in the WebSocket path, the same gate as
   B/C). The node verifies it offline with the issuer's public key and records
   it as spent.

The issuer knows "account X took 50 tokens on Tuesday"; the node knows "a valid
token connected at 07:52". Joining the two logs does not link a token to an
account - that is the mathematics, not a policy.

**Limits, to be written into `docs/THREAT-MODELS.md` with it:**

- **The address stays.** One operator running issuer and node, a device taking
  tokens and connecting from the same IP: linkable by address and time. It
  holds when tokens are fetched ahead and in batches (not just before a
  connection), or behind carrier NAT. What it removes for certain is the name in
  the node's logs - the logs that leak.
- **No revoking a single token** (nobody knows whose it is). Revocation = the
  issuer stops issuing to the account + the issuer key rotates (e.g. every
  24 h), so a dismissed account loses access within one rotation, not at once.
- **Tokens are spent.** One per connection, and a phone reconnects many times a
  day: batch size and per-account quota to be chosen. The quota is also the
  abuse control, kept at the issuer, without the node knowing who is who.
- **The node keeps a spent list**, cleared at each key rotation.

**Fit and cost.** Same gate on the node; only the ticket type changes, so the
verifier is built pluggable from the start (B: a device ticket, C: an OIDC
ticket, C+: a blind-signed token). Work: an issuance endpoint beside
`encedo-oidc`, the verifier + spent list on the node, a token batch in the app.
Libraries exist (`@cloudflare/blindrsa-ts`, `@cloudflare/privacypass-ts`,
RFC-conformant); an RSA-2048 token is about 400 base64 characters, fine in a
path. It is the network-access layer, not the end-to-end protocol, so EH-2 and
the review are untouched. Watch: anonymous rate-limited credentials (ARC, an
IETF draft) - multi-use tokens, not a standard yet.

**Order:** after B and C, as an enterprise option. Its pitch: "the node knows an
employee is connected, not which one" - a single-sign-on gate cannot say that.

## 5. The admin panel

An overlay over the same commands, like `infra/dash` today: it runs on the
admin's machine and reads the nodes over SSH (loopback metrics, Redis). It never
holds the root key (profiles are signed with the YubiKey outside it), and the
nodes expose nothing new for it. Mock-up: https://claude.ai/artifact/UiG3XiHd2hLNrxKg166eaz.
After C4 and the Acme deployment.

## 6. Order

1. Relay `--key-file` + the image + compose (C4), tested locally.
2. `onchato-setup.sh` over it (preflight, questions, key choice, checks, QR),
   as a release asset.
3. `bs-setup.sh --domain`.
4. Acme on `blbx.pl` with the script, the guide corrected against what really
   happened.
5. Access tier B (design note above settled first).
6. The panel as an extension of `infra/dash`.
7. C and D with an enterprise pilot; C+ (anonymous tickets) as its option.

## Open questions

1. B: TOTP, one-time codes, or both; code length vs enrollment rate limits.
2. B: ticket lifetime and renewal.
3. Does the Acme test carry files (`STORE=1`, Kubo on the same VM) from day one?
4. The Acme app address: `app.onchato.com` until C6, or a web front on
   `blbx.pl` built with `EC_NETWORK_PROFILE`.
