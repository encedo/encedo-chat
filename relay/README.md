# onchato relay

The single rendezvous/transport node behind **bs1.onchato.com** — libp2p GossipSub
(message fan-out) + circuit-relay-v2 (reservations). **Transport-only:** it forwards
encrypted frames and grants reservations; it never sees plaintext or keys. Both v5
and v6 clients use it unchanged.

Lives in `encedo-chat/relay/` so the whole system is one repo (web client + relay).

## Run

```bash
npm ci
npm run relay -- --port 9001 --pass bs1.onchato.com --host bs1.onchato.com
```

Flags:
- `--pass` — Ed25519 seed → the relay's **PeerId** (printed on startup). **Keep stable.**
- `--port` — WS listen port (nginx proxies WSS → this).
- `--host` — prints the production WSS multiaddr for clients.
- `--peers <ma>…` — other relays to dial on startup (mesh).

## ⚠️ The pass IS the identity

`--pass bs1.onchato.com` seeds PeerId
`12D3KooWP6SpQxgcUDdAU1CdY3dcvSrkxHPki7FRtMLLYiGxcDmp`. Clients carry that multiaddr
**hardcoded**:

```
/dns4/bs1.onchato.com/tcp/443/wss/http-path/%2Frelay/p2p/12D3KooWP6Sp…cDmp
```

Change the pass → new PeerId → **every client breaks**. Keep it exactly `bs1.onchato.com`.

## Deploy (host build, like the web)

On the onchato host (`/opt/github/encedo-chat`):

```bash
cd /opt/github/encedo-chat
git pull
cd relay && npm ci
sudo systemctl restart onchato-relay
sudo journalctl -u onchato-relay -f    # PeerId 12D3KooWP6Sp… + the topic budget line
```

First-time systemd install:

```bash
# the unit ships with WorkingDirectory=/opt/github/encedo-chat/relay — change it
# if your clone lives elsewhere, then:
sudo cp onchato-relay.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now onchato-relay
sudo journalctl -u onchato-relay -f      # confirm PeerId 12D3KooWP6Sp… on startup
```

Node 18+ (plain ESM). Runs as `www-data` by default — the clone dir must be readable
by it (`sudo chgrp -R www-data /opt/github/encedo-chat && sudo chmod -R g+rX` if not).

### Did it actually take? (check, don't assume)

`git pull` changes nothing until the service restarts — the code is in the
running process's memory. Startup prints exactly three things worth reading:

```
🔑 Pass: "bs1.onchato.com" → PeerId: 12D3KooWP6Sp…cDmp   ← unchanged, or every client breaks
✅ Relay uruchomiony na porcie 9001
📦 Tematy: limit 250 równoczesnych, eviction po 120s ciszy (sweep 30s)
```

If that does not match the build you expect, walk these in order — each rules
out a different cause:

| check | what a bad answer means |
|---|---|
| `git log --oneline -1` | the pull went to a different clone, or you are on another branch |
| `grep -c "max-topics" relay.mjs` | the pull did not land (local changes blocking the merge?) |
| `systemctl show onchato-relay -p ExecMainStartTimestamp` | it never restarted |
| `systemctl cat onchato-relay \| grep -E 'WorkingDirectory\|ExecStart'` | systemd runs a different directory (e.g. an old v5 checkout) |
| `ss -ltnp \| grep :9001` | a stale process still holds the port, so the new one cannot bind |

A missing log line proves the deploy is unverified — not that the code is
absent. Confirm on disk (`git log`, `grep`) before concluding anything.

## nginx (bs1.onchato.com)

Relay listens on `127.0.0.1:9001` (WS); nginx terminates TLS and proxies `/relay` (WSS):

```nginx
server {
    listen 443 ssl;
    server_name bs1.onchato.com;

    ssl_certificate     /etc/letsencrypt/live/bs1.onchato.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/bs1.onchato.com/privkey.pem;
    include /etc/letsencrypt/options-ssl-nginx.conf;
    ssl_dhparam /etc/letsencrypt/ssl-dhparams.pem;

    location /relay {
        proxy_pass         http://127.0.0.1:9001;
        proxy_http_version 1.1;
        proxy_set_header   Upgrade    $http_upgrade;
        proxy_set_header   Connection "upgrade";
        proxy_set_header   Host       $host;
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
    }
    location /health { return 200 "bs1 ok\n"; add_header Content-Type text/plain; }
}
```

## Peer scoring — why IP colocation is OFF

GossipSub scores peers, and by default penalises several peers sharing one IP:
in a public blockchain mesh that is a sybil signal. Here it is a household, an
office or a VPN — ordinary users.

**And behind nginx it is not even per-user: every client arrives from
`127.0.0.1`.** The proxy terminates TLS and opens its own TCP connection to the
relay, so libp2p sees one address for the entire world (`X-Forwarded-For` is an
HTTP header — the libp2p peer store never sees it). The colocation counter is
therefore global, and two further details turn that into an outage:

- a peer whose score is **not positive** keeps its stats *and its IP* for
  `retainScore` (**1 h**) after it disconnects, and our clients sit at exactly
  0 (no per-topic score params), so one address accumulates slots as people
  come and go — a tester reloading the page a dozen times does it alone;
- once past the threshold the newcomer is **graylisted**: the relay still
  accepts the connection and the meshsub streams, then silently drops its RPCs,
  subscriptions included. Nothing appears in the log. The room simply never
  forms, which is indistinguishable from a broken client.

Hence `scoreParams: createPeerScoreParams({ IPColocationFactorWeight: 0 })` —
mandatory, not a preference, for any relay behind a reverse proxy. (Preserving
real client IPs would need PROXY protocol between nginx and libp2p, which the
WebSockets transport does not speak; and even then the penalty would be wrong
for our topology.)
Reproduce and verify with `node net/relay-colocation-test.ts <relay-multiaddr>`
(from `impl/`): it churns 14 peers from one IP and then checks whether a fresh
subscription is still accepted.

## Inbound connection limits — why they are raised (same trap, second floor)

libp2p defends itself against connection floods **per host**: at most
`inboundConnectionThreshold` new inbound connections per second (default **5**)
and `maxIncomingPendingConnections` in flight at once (default **10**). Behind
nginx those are not per user — they are limits on the entire network, for the
same reason the colocation score was: every client arrives from `127.0.0.1`.

Measured against the live relay before the change:

| how clients arrive | result |
|---|---|
| 8 dials, one at a time | 8 of 8 connect |
| 8 dials at once | **3 refused** mid-Noise handshake |
| 24 dials at once (local relay, stock defaults) | **19 refused** |
| 24 dials at once (local relay, raised) | 0 refused, 117 ms |

The client sees `EncryptionFailedError: unexpected end of input` — the socket
closes during the handshake — and **the relay logs nothing at all**. Any event
that makes a few dozen clients dial together (a deploy, a network blip, a
morning) walks straight into it.

So `inboundConnectionThreshold: 500` and `maxIncomingPendingConnections: 128`.
That deliberately removes libp2p's flood protection, which was ineffective here
anyway — **it has to be replaced at the edge**, where the real client address is
known. In the `/relay` location:

```nginx
# http{} once:
#   limit_conn_zone $binary_remote_addr zone=relay_conn:10m;
#   limit_req_zone  $binary_remote_addr zone=relay_req:10m rate=10r/s;
location /relay {
    # …existing proxy_pass / Upgrade headers…
    limit_conn relay_conn 20;                  # per real IP
    limit_req  zone=relay_req burst=30 nodelay;
}
```

Measure it with `node net/relay-load.ts` (from `impl/`): waves of pairs, each
doing a real EH-2 handshake and a message both ways, reporting dial / discovery
/ handshake / round-trip percentiles plus this machine's own RSS and CPU — so a
slow wave can be attributed to the right side. `STAGGER_MS=700` spreads the
arrivals for a relay that still has the stock defaults.

**Where onchato stands** (2026-07-31, cheap VPS, staggered so the old limit did
not bite): 40 clients / 20 rooms, **zero failures**, dial 324 ms p50 (flat from
10 to 40 clients — it is TLS + round trip, not load), handshake ~1.2 s,
message round trip ~135 ms. Against a local relay with the limits raised: 80
clients, zero failures, dial 88 ms p50. Nothing about the VPS was the
constraint; the default was.

## Tunables (relay.mjs)

- `maxConnections: 520`, `maxReservations: 256`, `maxMessageSize: 65536` (64 KB).
- GossipSub mesh `D:8, Dlo:6, Dhi:12` (tuned for ~25 clients/topic).
- `--max-topics` (default **250**) — cap on **concurrent live** topics. It is soft
  in time: a topic with no activity for `--idle-ttl` (default **120 s**) is
  evicted, so the slot returns. Clients heartbeat an Announce every ~15 s, so a
  room anyone is actually in is refreshed continuously and never evicted — keep
  `--idle-ttl` well above 15 s.
  **When the cap does bite, the client sees nothing** — no error, just an empty
  room, which looks like a broken app. The relay logs
  `[!topic] LIMIT … REFUSING` for exactly that case; watch for it.
  (This is what bit us on 2026-07-29: the deployed relay still ran the
  pre-eviction build with a hard cap of 50, had refused every new topic for a
  while, and only a restart cleared it.)
- The per-message log is **metadata only** (truncated topic, sender prefix, byte
  count) — the payload is ciphertext and logging it only parked user metadata in
  journald.
