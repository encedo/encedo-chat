# Deploying a relay node from a clean Ubuntu — step by step

Read top to bottom and type what is in the boxes. At the end you have a relay
node that clients reach at `wss://<host>/relay`, that is meshed with the
existing nodes, and that restarts on its own. **Ubuntu 26.04 LTS** is the
baseline; every step also works on 24.04 and 22.04 (bs1 and bs2 run those).
Budget: about 30 minutes, most of it waiting for `apt`.

Background — what each piece is and why it is shaped this way — lives in
[`README.md`](README.md). This file is only the order of operations.

## 0. Before you touch the machine

**The VM.** 1 vCPU / 1 GB is enough (bs2 is exactly that; sizing in README →
Scaling guidelines). A public IPv4 address. IPv6 is optional. SSH as a user
with `sudo`, or as root — the boxes below use `sudo` and work for both.

**The name.** Nodes are `bsN.onchato.com`. The name is more than a label: by
convention it is also the relay's `--pass`, and the pass seeds the node's
PeerId, which every client will carry in its node list. Decide the name now
and never change it afterwards.

**DNS — an explicit A record, not the wildcard.** `*.onchato.com` is a wildcard
CNAME to `onchato.com` (bs1's box). A name you have not published therefore
already *resolves* — to the wrong machine, which answers with bs1's
certificate. Create `A bsN.onchato.com → <the VM's IPv4>` and, if the VM has
IPv6 and you want clients to use it, `AAAA → <its IPv6>` (the nginx site below
listens on both). Wait until it resolves from the outside:

```bash
dig +short A bs4.onchato.com        # → the VM's address, and NOT 38.109.11.30 (bs1)
```

**The PeerId, computed before the node exists.** On a laptop with this repo:

```bash
cd encedo-chat/relay && npm ci
node -e '
  import("@libp2p/crypto/keys").then(async ({generateKeyPairFromSeed}) => {
    const {peerIdFromPrivateKey} = await import("@libp2p/peer-id")
    const {createHash} = await import("node:crypto")
    const key = await generateKeyPairFromSeed("Ed25519", createHash("sha256").update(process.argv[1]).digest())
    console.log(peerIdFromPrivateKey(key).toString())
  })' bs4.onchato.com
```

For **bs4.onchato.com** this prints `12D3KooWNanmFHKtW2BB4r58VUJ6er1w3r2mB8gEbnnqaha8CGKo`.
(The same one-liner named bs3's id before bs3 existed, and bs3's log printed
exactly that id when it came up on 2026-09-03 — the method is proven.)
Write yours down — step 4 checks the running node against it, and the address
you will publish in step 9 is:

```
/dns4/<host>/tcp/443/wss/http-path/%2Frelay/p2p/<PeerId>
```

Everything below assumes one shell variable. Set it in every new session:

```bash
HOST=bs4.onchato.com
```

## 1. System and firewall

```bash
sudo apt-get update && sudo apt-get -y upgrade
sudo apt-get install -y ufw curl git jq
sudo hostnamectl set-hostname ${HOST%%.*}        # optional: "bs4" in the prompt and the journal
                                                 # (skip on DigitalOcean: cloud-init restores its own name at every boot)

sudo ufw default deny incoming
sudo ufw default allow outgoing
sudo ufw allow OpenSSH
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw allow 3478/udp                          # STUN (§4b) — the only UDP door
sudo ufw --force enable
sudo ufw status verbose
```

Four ports and nothing else. The relay itself listens on `0.0.0.0:9001`, but
it is reached only by nginx over loopback, and loopback is not filtered by
ufw — so **9001 stays closed** and clients notice nothing. 3478/udp is the one
exception to "everything goes through nginx": nginx speaks TCP and STUN is UDP,
so that service faces the world directly (§4b). Do not open it: an
open 9001 is a plain-WS door around every limit nginx enforces. (bs1 has one
extra listener, IPv6 port 9002, for exactly one reason: its provider blocks
IPv4 between its VMs, so bs2 meshes with it over IPv6. ufw restricts that port
to bs2's address. A node outside that provider needs nothing of the kind.)

## 2. Node.js 22 LTS

From NodeSource, the same package bs1 and bs2 run. The `nodistro` suite is
identical on every Ubuntu release, so there is no codename to get wrong:

```bash
sudo apt-get install -y ca-certificates gnupg
curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key \
  | sudo gpg --dearmor -o /usr/share/keyrings/nodesource.gpg
sudo tee /etc/apt/sources.list.d/nodesource.sources >/dev/null <<EOF
Types: deb
URIs: https://deb.nodesource.com/node_22.x
Suites: nodistro
Components: main
Architectures: $(dpkg --print-architecture)
Signed-By: /usr/share/keyrings/nodesource.gpg
EOF
sudo apt-get update && sudo apt-get install -y nodejs
node -v      # v22.x
npm -v
```

(26.04's own archive ships Node 22 as well — `apt-get install nodejs npm` is
an acceptable alternative there. 24.04 ships 18 and 22.04 ships 12; on those
NodeSource is the only sane path, which is why the guide uses it everywhere.)

## 3. The code

The relay runs from a clone of this repository, the same clone `git pull`
updates later. Root owns it; the service reads it as `www-data`, which the
default permissions allow.

```bash
sudo mkdir -p /opt/github
sudo git clone https://github.com/encedo/encedo-chat.git /opt/github/encedo-chat
cd /opt/github/encedo-chat/relay
sudo npm ci
sudo -u www-data test -r node_modules/libp2p/package.json && echo "www-data can read it"
```

Pin what you deploy: `sudo git -C /opt/github/encedo-chat checkout v0.5.40`
(or the tag you mean) instead of `main`, if you want the node on exactly the
build the clients ship with.

## 4. The service

The unit file in the repo is bs1's. Yours differs in three places — the pass,
the name it prints, and `--peers`, the other nodes it dials to join the mesh
(one address per node, the addresses of the nodes that exist today):

```bash
sudo tee /etc/systemd/system/onchato-relay.service >/dev/null <<EOF
# onchato libp2p relay — $HOST (encedo-chat/relay). Generated per relay/DEPLOY.md.
# --pass IS the PeerId: never change it once the address is published.
[Unit]
Description=onchato libp2p relay $HOST (encedo-chat)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=www-data
WorkingDirectory=/opt/github/encedo-chat/relay
ExecStart=/usr/bin/node relay.mjs --port 9001 --pass $HOST --host $HOST \\
  --peers /dns4/bs1.onchato.com/tcp/443/wss/http-path/%%2Frelay/p2p/12D3KooWP6SpQxgcUDdAU1CdY3dcvSrkxHPki7FRtMLLYiGxcDmp \\
          /dns4/bs2.onchato.com/tcp/443/wss/http-path/%%2Frelay/p2p/12D3KooWJJJtAk9m6yTUdKwqUYpxcyWLZTVNgyrpZheyK161NT1y \\
          /dns4/bs3.onchato.com/tcp/443/wss/http-path/%%2Frelay/p2p/12D3KooWLcDzqtSAetckwdzzqYbLTsN6wHFx8T4uKr5Yn1GUvSt5
Restart=always
RestartSec=5
Environment=NODE_ENV=production
LimitNOFILE=65536

[Install]
WantedBy=multi-user.target
EOF
sudo systemctl daemon-reload
sudo systemctl enable --now onchato-relay
sudo journalctl -u onchato-relay -n 25 --no-pager
```

`%%2Frelay` is not a typo: systemd expands `%` in `ExecStart`, so the
multiaddr's `%2F` has to be written `%%2F` there. Everywhere else (a shell,
`nodes.json`, a browser) it is `%2F`.

**Read the log before going on.** Six lines matter:

```
Pass: "bs4.onchato.com" -> PeerId: 12D3KooWNanm...CGKo   <- MUST equal the PeerId from step 0
  [ok] /dns4/bs1.onchato.com/tcp/443/wss/http-path/%2Frelay...   <- mesh to bs1 is up
  [ok] /dns4/bs2.onchato.com/tcp/443/wss/http-path/%2Frelay...   <- mesh to bs2 is up
  [ok] /dns4/bs3.onchato.com/tcp/443/wss/http-path/%2Frelay...   <- mesh to bs3 is up
[ok] Relay uruchomiony na porcie 9001
Tematy: limit 250 równoczesnych, eviction po 120s ciszy (sweep 30s)
```

A different PeerId means the pass is wrong; fix the unit now, because an
address published with the wrong id fails for every client that ever caches
it. A `[fail] ... ponawiam` line is retried every 10 s (see Troubleshooting if it
never turns into `[ok]`). Nothing reaches the node from outside yet — that is
the next two steps.

## 4b. STUN

One more service on the same clone, and a small one: it tells a client the
address the outside world sees, which is the single fact WebRTC needs before it
can try a direct connection. Before 2026-09-03 the app asked Google's public
STUN server for it; now it asks the nodes it is already connected to.

```bash
sudo cp /opt/github/encedo-chat/infra/stun/onchato-stun.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now onchato-stun
journalctl -u onchato-stun -n 5 --no-pager
```

Two lines say it worked — `[ok] STUN udp4 0.0.0.0:3478` and `[ok] STUN udp6 [::]:3478`.
The IPv6 one is best-effort: a host without IPv6 logs an error for it and keeps
serving IPv4 (the v4 socket failing, by contrast, exits — that one is not
optional).

From your laptop, before anyone relies on it:

```bash
node impl/net/stun-probe.ts $HOST --bad
```

It prints the public address the node saw you from, then fires the datagrams the
service must IGNORE (a TURN Allocate, a wrong magic cookie, a truncated header)
and fails if any of them is answered. That second half is the one worth running:
a UDP responder that answers more than it must is a reflector somebody else can
aim at a third party.

⚠️ **`ufw allow 3478/udp` (§1) is what makes this reachable.** Everything else on
these machines is behind nginx, so it is easy to assume this is too — it is not,
because nginx does not proxy UDP.

⚠️ **Do this BEFORE §9 (publishing the node).** Clients do not carry a list of
STUN servers; they ask the nodes they dial, on the default port, because running
STUN is part of being a node (`impl/lib/ice.ts`). A node that reaches the
published list without this service answers a client's Binding Request with
nothing, and the client waits out the ICE timeout before falling back.

## 5. The certificate

nginx's stock default site serves `/var/www/html` on port 80 for any name,
which is all HTTP-01 needs, so the certificate is issued *before* the relay
site exists (the site references the certificate files, and nginx refuses to
load a site whose certificate is missing).

```bash
sudo apt-get install -y nginx certbot
sudo certbot certonly --webroot -w /var/www/html -d $HOST \
  --agree-tos -m you@example.com --no-eff-email \
  --deploy-hook 'systemctl reload nginx'
sudo ls /etc/letsencrypt/live/$HOST/         # fullchain.pem privkey.pem …
systemctl list-timers certbot.timer          # renewal runs twice a day from here on
```

`--deploy-hook` is what makes a renewed certificate actually get *used* —
without it nginx keeps serving the old one until someone reloads it. If
certbot fails with "unauthorized" or a connection error, DNS is the first
suspect: see Troubleshooting.

## 6. nginx

The site is a template in the repo, rendered with the hostname; the per-IP
limit zones it uses are a second file that belongs in `conf.d` (they are
http-level and cannot live in a site):

```bash
cd /opt/github/encedo-chat
sudo cp infra/nginx/relay-limits.conf /etc/nginx/conf.d/relay-limits.conf
sed "s/__HOST__/$HOST/g" infra/nginx/relay-node.conf | sudo tee /etc/nginx/sites-available/$HOST >/dev/null
sudo ln -s /etc/nginx/sites-available/$HOST /etc/nginx/sites-enabled/$HOST
sudo nginx -t && sudo systemctl reload nginx
sudo certbot renew --dry-run --no-random-sleep-on-renew   # proves renewal survives the redirect
```

(`--no-random-sleep-on-renew` matters only when stdin is not a terminal —
over `ssh host 'cmd'` or from a script certbot otherwise sleeps a random 0–8
minutes before it does anything, which looks exactly like a hang.)

`sites-enabled/$HOST` must stay a **symlink** — a copy there is two files, one
edited and one served, and no error anywhere (`infra/nginx/README.md`).

## 7. Does it work from the outside?

From your laptop, in this order — each check proves one more layer:

```bash
HOST=bs4.onchato.com
curl -s https://$HOST/health                  # → "bs4.onchato.com ok"   (DNS + TLS + nginx)
curl -sS -i -N --max-time 3 \
  -H 'Connection: Upgrade' -H 'Upgrade: websocket' -H 'Sec-WebSocket-Version: 13' \
  -H "Sec-WebSocket-Key: $(head -c16 /dev/urandom | base64)" \
  https://$HOST/relay 2>/dev/null | head -1   # → HTTP/1.1 101 Switching Protocols   (nginx ↔ relay)
```

(`curl` then complains that it cannot speak WebSocket — that is expected; the
`101` is the answer.) Now the real thing, a libp2p node dialling yours, from
the repo checkout on the laptop:

```bash
cd encedo-chat/relay
node relay.mjs --port 9379 --pass laptop \
  --peers /dns4/$HOST/tcp/443/wss/http-path/%2Frelay/p2p/<PeerId from step 0>
# expect:  [ok] /dns4/bs4.onchato.com/tcp/443/wss/http-path/%2Frelay...   then Ctrl+C
```

An `[ok]` means the whole path works: TLS, the `/relay` upgrade, the Noise
handshake, and that the node really holds the PeerId you published. The full
proof — two browsers on two different nodes meeting in a room — is the
harness (`impl/`, needs the dev setup; write the log to a file, never pipe it
through `tail`):

```bash
cd encedo-chat/impl
RELAY_A=/dns4/bs1.onchato.com/tcp/443/wss/http-path/%2Frelay/p2p/12D3KooWP6SpQxgcUDdAU1CdY3dcvSrkxHPki7FRtMLLYiGxcDmp \
RELAY_B=/dns4/$HOST/tcp/443/wss/http-path/%2Frelay/p2p/<PeerId> \
npm run browser-test > browser-test.log 2>&1; tail -3 browser-test.log
```

## 8. The mesh — why only the new node dials

Step 4 already meshed the node: `--peers` makes it dial bs1, bs2 and bs3 at
start and re-dial any of them it is not connected to, every 10 s. The link is
bidirectional, so **the existing nodes need no change and no restart** — a
pair split across bs1 and the new node meets through that link. When the new
node restarts, it re-dials; when bs1 restarts, the new node notices within 10 s
and re-dials. On the existing nodes you can see it arrive (this is how bs3's
arrival was confirmed on 2026-09-03 — a `[+]` on bs1 and on bs2, no `[-]`):

```bash
ssh bs1.onchato.com 'journalctl -u onchato-relay -n 50 --no-pager | grep "\[+\] 12D3KooWNanm"'
```

One address per peer in `--peers`, always: two addresses for the same PeerId
make libp2p treat the second as a duplicate dial and log noise every 10 s.

## 9. Publishing the node — last, and only once it answers

`infra/nodes.json` is compiled into every client; a node listed there before
it answers costs every fresh client a failed dial at start-up. Only after
step 7 is green:

1. Append `{ "name": "<host>", "addr": "<the multiaddr from step 0>" }` to
   `infra/nodes.json` and bump its `updated` date. Then `cd impl && npm test`:
   `test/nodelist.test.ts` parses the real file and rejects a copy-paste slip
   (an address that is another node's, two entries with one id) — CI runs the
   same and goes red on `main` otherwise.
2. Publish the new list to the IPFS store (`ipfs add -Q infra/nodes.json` on
   the store host — `infra/README.md`) and put the CID in `OFFICIAL_NODES_CID`
   in `impl/web/src/app.ts`: the in-app "load the official list" button reads
   that CID and nothing else.
3. Add the node's address to the `--peers` line in step 4 of this file, so the
   *next* node dials this one too, and note it in README → "Adding a node"
   (the precomputed ids live there).
4. Version bump + `release:` commit + tag, per the release ritual in the root
   `CLAUDE.md`. The tag ships the list in the web, desktop and Android builds.

Until a build with the new list ships, the node serves only clients that add
its address by hand (the app's Network tab) — which is exactly the right
audience for a node's first days.

## 10. Operating it

**Update** (relay code changed — the tag-driven web deploy never restarts a
relay, and there is no web on this box anyway):

```bash
cd /opt/github/encedo-chat && sudo git pull && cd relay && sudo npm ci
sudo systemctl restart onchato-relay
sudo journalctl -u onchato-relay -n 15 --no-pager      # PeerId unchanged, both [ok] lines, budget line
```

README → "Did it actually take?" is the checklist when the log looks like the
old build. Restart **one node at a time** and give clients a minute between
them; they fail over down the list, but two nodes gone at once is the one
outage the list cannot absorb.

**Look at it:**

```bash
sudo journalctl -u onchato-relay -f                    # [+]/[-] peers, [+topic]/[-topic] rooms
sudo ss -tn state established '( sport = :9001 )' | wc -l   # client connections (via nginx)
curl -s https://$HOST/health
sudo ufw status numbered
sudo certbot certificates
```

**Debugging a live problem — the DUMP.** `DUMP=<dir>` makes the relay write
every observable action (connections with the real client IP from nginx's
`X-Real-IP`, subscriptions, every forwarded frame, reservations) to JSONL.
It is switched on with a systemd drop-in, never by editing the unit, and the
banner line `DUMP ON` is the proof it is running. **Never leave it on a
production node** — the files are precisely the metadata the design promises
not to keep. On/off/reading: [`README.md` → Dump](README.md#dump-debug--audit--dumpdir-never-on-production).

**Roll back:** `sudo git -C /opt/github/encedo-chat checkout v0.5.39 && cd
/opt/github/encedo-chat/relay && sudo npm ci && sudo systemctl restart
onchato-relay`. The PeerId comes from the pass, not the code, so a rollback is
invisible to clients.

**Decommission:** remove the node from `infra/nodes.json` and ship a build
*first*, keep the node up until that build has been out for a while, then
`sudo systemctl disable --now onchato-relay`. Clients with the old list keep
trying it — the failover survives that, but it costs them a dial each start.

## 11. When something is wrong

| symptom | cause → fix |
|---|---|
| `certbot` fails: "unauthorized", or the challenge hits another server | DNS still points at the wildcard (bs1) or has not propagated. `dig +short A $HOST` from outside must show *this* VM. Also: port 80 open in ufw, nginx running, `curl http://$HOST/` answering |
| `nginx -t`: `zero size shared memory zone "relay_conn"` / `unknown limit_conn_zone` | `relay-limits.conf` is not in `/etc/nginx/conf.d/`, or was named without `.conf` |
| `nginx -t`: `limit_conn_zone "relay_conn" is already bound` | the zones are declared twice — only on the web host, whose `onchato.com` config already has them; do not install `relay-limits.conf` there |
| `nginx -t`: cannot load certificate `/etc/letsencrypt/live/<host>/…` | step 5 did not finish, or `HOST` was set differently when the site was rendered — `grep server_name /etc/nginx/sites-enabled/$HOST` |
| `certbot renew --dry-run` prints nothing for minutes, looks hung | not hung: without a terminal on stdin (`ssh host 'cmd'`, a script) certbot sleeps a random 0–8 min first (`Non-interactive renewal: random delay` in `/var/log/letsencrypt/letsencrypt.log`). Wait, or add `--no-random-sleep-on-renew`. A second `certbot` started meanwhile says `Another instance of Certbot is already running` |
| `/health` answers, the `101` check gives `502` | the relay is not listening on 9001: `systemctl status onchato-relay`, `ss -ltnp \| grep 9001` |
| `/health` answers with bs1's certificate or `bs1 ok` | you are talking to bs1 — the wildcard CNAME; see the first row |
| log: PeerId differs from step 0 | `--pass` differs from the hostname you computed for — compare `systemctl cat onchato-relay` letter by letter |
| log: `[fail] /dns4/bs1... (...) — ponawiam` forever | the VM cannot reach that node on 443 (`curl -s https://bs1.onchato.com/health`), or the PeerId in the address is not the one that node runs (`journalctl` on *that* node prints it). A wrong id looks like a broken network: libp2p refuses the connection after the handshake |
| `EACCES` in the log, service restarting | `www-data` cannot read the clone — `sudo chmod -R o+rX /opt/github/encedo-chat` |
| `EADDRINUSE :9001` | a previous relay process still holds the port — `ss -ltnp \| grep 9001`, kill it, restart the unit |
| clients connect but rooms never form | the topic budget, not the network — README → Tunables and "The relay can be healthy and still ignore you" in the root `CLAUDE.md` |
| IPv6 clients time out, IPv4 works | an `AAAA` record exists but the address is not on the VM, or ufw's IPv6 rules are missing (`sudo ufw status` shows `(v6)` rows when `IPV6=yes` in `/etc/default/ufw`) |
| a lot of `[+]`/`[-]` for one peer id | its client is flapping (mobile network) — normal. Many *different* ids from one address hitting `limit_conn` is what the limits are for; nginx logs `limiting connections by zone` in `error.log` |
