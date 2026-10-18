# Operator node plan: the Docker node image (C4), bs-setup for any domain, access tiers

Status (2026-10-18): **built and tested locally** - the relay's `--key-file`,
the image + compose (`node/`), the setup script (`node/onchato-setup.sh`,
`--local-test` passes end to end), the passphrase key. Not yet: `bs-setup.sh
--domain`, the file store in the image, the script as a release asset. Phase C of operator networks
(`docs/ARCHITECTURE.md`, "Another operator's network"). The guide an operator
follows is drafted beside this one in `OPERATOR-GUIDE.md`. When this ships, the
guide moves to `docs/` and this file goes to `docs/archive/`.

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

### B in more detail (to settle before code)

- Join: scan the QR, the app asks for the admin's code, `POST /enroll {code}`
  to a node returns a random device ticket; the node stores its hash.
- The code: the admin's TOTP (authenticator app; the node holds the secret) or
  one-time codes issued from the CLI/panel. Open: which, or both.
- **A 6-digit code is brute-forceable** across a 30 s window unless enrollment
  is rate-limited hard (per IP and globally) or the code is longer (8 base32
  characters). Decide with the rate numbers.
- Revocation: `onchato-ops access revoke <device>`; tickets have no expiry of
  their own, or a long one with silent renewal - open.
- Privacy: the operator learns which device is online and when (it already sees
  the address). Write it into `docs/THREAT-MODELS.md` when built.

### C (to refine)

Desktop signs in through OIDC (PKCE in the browser; the system browser + deep
link in a packaged app), the phone pairs by a QR code the desktop shows. Mobile
OIDC directly is harder (system browser, app links), hence pairing first. Web
can be tested against `encedo-oidc` now.

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
7. C and D with an enterprise pilot.

## Open questions

1. B: TOTP, one-time codes, or both; code length vs enrollment rate limits.
2. B: ticket lifetime and renewal.
3. Does the Acme test carry files (`STORE=1`, Kubo on the same VM) from day one?
4. The Acme app address: `app.onchato.com` until C6, or a web front on
   `blbx.pl` built with `EC_NETWORK_PROFILE`.
