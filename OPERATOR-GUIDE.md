# Running your own onchato network

> **DRAFT (2026-10-18).** This describes the target path: the Docker node image
> (`OPERATOR-NODE-PLAN.md`, C4) is **not built yet**, and the commands in
> sections 3 and 4 are its planned interface. Everything that uses
> `scripts/onchato-ops.mjs` (sections 2, 5, 6) works today. The guide is checked
> step by step against a real one-node network (`acme-blbx` on `blbx.pl`) before
> it moves to `docs/`.

You keep the apps (ours: the web app, desktop, Android, iOS, the CLI) and run
the network under them: the nodes people connect to, a place for shared files,
and a signed profile that tells the apps where all of it is. Your users join by
scanning a QR code; nothing has to be rebuilt.

## 1. What you run, and what you never see

| piece | what it does | sees |
|---|---|---|
| **node** (relay) | carries encrypted frames between people who are online | IP addresses, timing, opaque topic names |
| **STUN** | tells a device its public address, only if direct connections are on | IP addresses |
| **file store** (optional) | keeps encrypted file blobs for a few days | sizes, upload times |
| **network profile** | one signed file: your nodes, stores, addresses, rules | - |
| **root key** | signs the profile; the apps pin it at first join | - |

You never see message content, files or voice notes (end-to-end encrypted,
keys on the devices and in HEM), who talks to whom (topics derive from secrets
only the two people hold), contact lists or group membership. A person in your
network can reach someone only with that person's invitation.

**A person joins your network as a new identity.** An identity lives in one
network for good; joining yours does not move anyone's existing onchato
identity, and leaving it means making another one.

## 2. The root key

The key that signs your profile. Every device that joins pins it; losing it
means a new network (new id, everyone joins again), so keep a copy offline.

Best: a YubiKey (PIV slot 9c, Ed25519, firmware 5.7 or newer), with `opensc`
and `ykcs11` installed. Then the key never exists on a disk:

```bash
node scripts/onchato-ops.mjs network key --yubikey          # its public half and fingerprint
```

Or a key file (simpler, weaker - keep it off any machine that builds or serves):

```bash
node scripts/onchato-ops.mjs network key --file ~/acme-root.key   # creates it, mode 600, never overwrites
```

Write the **fingerprint** down where your users can compare it (your intranet,
a printed sheet): the app shows it when they join.

## 3. A node (planned: the Docker image)

**Machine:** a VPS with a public IPv4 (and IPv6 if you will run more than one
node), 1 vCPU and 1 GB RAM carry about 400 connected people (measured), Ubuntu
24.04, Docker with the compose plugin. **DNS:** an A (and AAAA) record for the
node's name, e.g. `n1.blbx.pl`, pointing at it.

**Firewall** - four doors and nothing else:

```bash
sudo ufw default deny incoming && sudo ufw default allow outgoing
sudo ufw allow OpenSSH
sudo ufw allow 80/tcp && sudo ufw allow 443/tcp
sudo ufw allow 3478/udp          # STUN, the only port not behind nginx
sudo ufw --force enable
```

The relay itself listens on loopback only and is reached through nginx, which
enforces the per-address limits. Never open its port (9001).

**Install** (planned interface):

```bash
git clone https://github.com/encedo/encedo-chat.git /opt/onchato && cd /opt/onchato/node
cp node.env.example node.env      # NODE_HOST=n1.blbx.pl, NETWORK_ID=acme-blbx, ACME_EMAIL=...
docker compose build --build-arg GIT_COMMIT=$(git rev-parse HEAD)
docker compose up -d
docker compose exec relay check   # what is running vs what node.env asks for
```

At first start the node makes its own key (in the data volume, never shown) and
prints its **PeerId**. The node's address in your profile is:

```
/dns4/n1.blbx.pl/tcp/443/wss/http-path/%2Frelay/p2p/<PeerId>
```

**Check it from outside**, each step proving one more layer:

```bash
curl -s https://n1.blbx.pl/health        # "n1.blbx.pl ok": DNS, TLS, nginx
curl -sS -i -N --max-time 3 -H 'Connection: Upgrade' -H 'Upgrade: websocket' \
  -H 'Sec-WebSocket-Version: 13' -H "Sec-WebSocket-Key: $(head -c16 /dev/urandom | base64)" \
  https://n1.blbx.pl/relay 2>/dev/null | head -1     # "HTTP/1.1 101": nginx reaches the relay
node impl/net/stun-probe.ts n1.blbx.pl --bad          # STUN answers, and ignores junk
```

**More nodes** mesh with each other over IPv6 port 9002, every node with every
other, open only to their addresses: `PEERS` and `SIBLINGS` in each node's
`node.env`, one `ufw allow from <their IPv6> to any port 9002 proto tcp` per
other node.

## 4. The file store (optional)

Without it your network carries text and calls but no files or voice notes.
With `STORE=1` the compose file adds Kubo, the upload prefixer (every upload
gets eight bytes in front, so the store never serves a file back byte for byte)
and the sweeper (blobs are deleted after the time the app promises). Name it in
the profile's `stores` as the node's origin, e.g. `https://n1.blbx.pl`.

## 5. The network profile

Write the parts that are yours (`acme-profile.json`):

```json
{
  "v": 1,
  "networkId": "acme-blbx",
  "operator": "Acme (test)",
  "app": { "origin": "https://app.onchato.com", "path": "/" },
  "stores": ["https://n1.blbx.pl"],
  "profileUrls": ["https://blbx.pl/onchato/network.json"],
  "feedback": null,
  "home": "https://blbx.pl/",
  "policy": { "transport": "node-only" }
}
```

and the node list (`acme-nodes.json`):

```json
{ "v": 1, "nodes": [ { "name": "n1.blbx.pl", "addr": "/dns4/n1.blbx.pl/tcp/443/wss/http-path/%2Frelay/p2p/<PeerId>" } ] }
```

- `networkId`: letters, digits, `.`, `-`, `_`; it is mixed into every topic, so
  two networks never meet even if their nodes connect. `main` is ours.
- `app`: where invitation links point. Until you run a web front of your own,
  ours.
- `feedback: null`: the app shows no feedback form. A URL: reports go to you.
- `policy`: `"transport": "node-only"` keeps all content on your nodes (no
  direct device-to-device connections); `"softwareProfiles": false` allows only
  HEM-backed identities.

Sign it (the key, the dates and the sequence number are filled in for you; a
re-sign goes one above the file it replaces, and the result is opened the way
an app will open it before it is written):

```bash
node scripts/onchato-ops.mjs network sign acme-profile.json --sign-yubikey \
  --nodes acme-nodes.json --out network.json          # PIN + touch; or --sign ~/acme-root.key
```

**Serve it** at every `profileUrls` address, byte for byte, with CORS (the
apps fetch it from their own origin):

```nginx
location = /onchato/network.json {
    add_header Access-Control-Allow-Origin "*" always;
    add_header Cache-Control "no-cache" always;
    alias /var/www/onchato/network.json;
}
```

Then check what an app will see, including every address and its CORS header:

```bash
node scripts/onchato-ops.mjs network check network.json --online
```

The profile is valid 120 days by default (`--days`). The apps refresh it by
themselves at sign-in and once a day, so a change of nodes reaches everyone
without them doing anything. **Re-sign and upload before it expires**: an
expired profile still works, but every app says so.

## 6. Letting people in

Print the join link and its QR code:

```bash
node scripts/onchato-ops.mjs network link https://blbx.pl/onchato/network.json network.json --svg join.svg
```

The link carries the file's address and its hash, so whatever server it is
fetched from, the app accepts only exactly that file. **Every re-sign changes
the hash**: print a new code after each upload (the old one is refused, safely).

In the app: the sign-in card, "another network", scan or paste, compare the
operator name and fingerprint, then make the new identity. On a desktop the
whole file can be pasted or opened instead.

**Who can join.** Today the network is open to anyone who has the QR code (tier
A). A join code from the admin (tier B) and sign-in through your directory (C)
are planned (`OPERATOR-NODE-PLAN.md`, section 4). Until then, treat the QR code
as you would a door code.

## 7. Keeping it running

- **Updates:** `git pull && docker compose build && docker compose up -d`. The
  app of release N works with the node of release N-1 (`SECURITY.md`,
  Versions): update your nodes within one release of the apps.
- **Expiry:** the profile (120 days) and the TLS certificate (renewed by the
  certbot service). `network check` prints the days left.
- **Abuse:** limits are per address in nginx; `infra/geoip/onchato-block` adds
  addresses, networks or ASNs to a block list with an expiry.
- **Backups:** the root key (offline) and the node's data volume (its key; a
  lost node key means a new PeerId and a new profile version).
- **Live numbers:** the node serves connection and topic counts on loopback;
  read them over SSH (the admin panel, planned, does this for you).

## 8. When something is wrong

| symptom | look at |
|---|---|
| the app says the profile cannot be fetched | `network check --online`: HTTP status and CORS per address |
| "a file other than the one the link names" | the file was re-signed after the QR was printed: print a new one |
| people do not see each other | `curl https://<node>/health`, then the WebSocket check in section 3 |
| a node refuses new conversations | the topic limit (`docker compose logs relay`, `Tematy: limit`): more nodes or a larger `MAX_TOPICS` |
| direct calls never connect | STUN: `stun-probe.ts`, and 3478/udp in the firewall; or `node-only` is on |
