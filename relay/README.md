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

## Scaling guidelines — what to add, and when (measured 2026-07-31)

Two sources of numbers: the live cheap VPS (behind nginx, real internet), and a
Docker rig on the dev box (relay and nginx in CPU/RAM-capped containers,
`docker stats` reading each side — full VMs are impossible here, no `/dev/kvm`).
Absolute rates differ by hardware; the **shape** and the **per-unit costs** are
what transfer. Run them yourself: `npm run relay-saturate` / `relay-flood` /
`relay-chatload` (from `impl/`, `RELAY=` to point at a target).

### Size for TWO content paths — WebRTC is not guaranteed

Content goes **direct over WebRTC** when it can, and **through the relay**
(GossipSub) when it cannot — hard NAT, a browser that refuses WebRTC, or a
relay-only deployment. These load the relay completely differently, so size for
both and treat the WebRTC success ratio as a business input.

**Variant A — WebRTC carries content (the light path).** The relay only ever
sees rendezvous + the one-time EH-2 handshake + a presence heartbeat every 15 s.
Steady-state content cost: **zero**. What you are buying is:

- **Connection setup — the CPU wall, and it is TLS in nginx, not the relay.**
  Under a raw-connection flood the nginx container pegged **100 % of its core at
  ~1500–1700 TLS handshakes/s** (dev box, RSA-2048, no session cache) while the
  relay behind it sat at 25–30 %. The real VPS managed ~430/s on its slower
  core. TLS handshakes are independent CPU work across nginx workers, so the rate
  **scales linearly with cores** — the transferable unit is *per-core handshakes
  per second* (≈0.6 ms CPU/handshake on the dev core). *Caveat: the 1→2 core
  doubling could not be confirmed from one host — the load generator also does
  TLS and ran out of cores; needs a second box to prove, but the per-connection
  independence makes linearity safe to assume until a shared limit (NIC, accept
  queue) intervenes.*
- **Concurrency — the RAM wall.** Measured server-side: idle relay ~63 MB, and
  **~0.25 MB per held connection** (63 → 192 MB across 520 sessions). So roughly
  **~4000 sessions per GB** after the base. Held sessions are near-free on CPU —
  this ceiling is memory, not compute.

**Variant B — the relay carries content (the fallback).** Everything above,
plus every message transits GossipSub. Measured with 30 chatting pairs
(`relay-chatload`):

- **CPU stays cheap** — ~2–6 % of one core for ~19 msg/s aggregate, i.e.
  hundreds of small messages/sec per core. CPU is not the content bottleneck.
- **Bandwidth is the bottleneck** — on the order of a **few KB of relay traffic
  per message** (the body is ~250 B sealed; the rest is fan-out + GossipSub
  control + WS/TCP framing). This scales with *talking*, linearly, and is what
  exhausts a cheap VPS's network allowance long before its CPU.
- RAM creeps up modestly (GossipSub message cache), still connection-count-bound.

### The sizing recipe

For **U** concurrent users, average **R** messages/sec each, WebRTC success
fraction **w**:

- **RAM** = base + `U × 0.25 MB` → the concurrency ceiling. (≈ 4000 users/GB.)
- **Setup CPU** (TLS) = sized to the *reconnect storm*, not the average: a
  deploy or a topic rollover makes many clients redial at once. Provision cores
  for the peak handshake rate; enable `ssl_session_cache` and the raised inbound
  limits (see below) to cut it. This is where **adding CPU** helps — and it is
  nginx's core, so scaling/offloading **TLS** is the lever, not the relay.
- **Relay bandwidth** = `U × R × (1 − w) × ~3 KB`. This is the number that
  decides whether one box survives the day WebRTC does not work. Example: 4000
  users, 0.2 msg/s each, only 50 % on WebRTC → `4000 × 0.2 × 0.5 × 3 KB ≈
  1.2 MB/s ≈ 10 Mbit/s` — fine on one VPS; at `w = 0` and heavier chat it climbs
  fast and pushes you to shard.

**So: scale RAM for how many are connected, CPU (nginx/TLS) for how fast they
(re)connect, and bandwidth for how much they talk when WebRTC is unavailable.**
Past a few thousand users any of the three tips over — and because topics shard
cleanly (topic → small node-set), the answer there is **horizontal**: more small
nodes, each carrying its slice of connections, handshakes and content. Vertical
scaling buys headroom on one axis; sharding buys all three at once.

## Capacity & the DoS surface (measured 2026-07-31, current cheap VPS)

Numbers from `impl/`, all client-side (no SSH to the box, so its CPU/RAM/fd are
inferred from external behaviour, not read):

- **`npm run relay-saturate`** — held libp2p connections, ramped slowly so
  arrival-rate limits do not interfere. **517 concurrent sessions held, none
  pruned over 30 s.** That is our own `maxConnections: 520`, not the VPS —
  memory grew linearly (~1 MB/client on the *client* side) and the relay
  accepted flat to its own cap. To find the real hardware ceiling, raise the cap
  and re-run.
- **`npm run relay-flood churn`** — raw `wss://…/relay` connect+close as fast as
  possible (an attacker does not finish the libp2p handshake; nginx still does a
  full TLS handshake per attempt). This is the front door's ceiling:

  | concurrency | successful/s | failures | connect p50/p95 | real user served? |
  |---|---|---|---|---|
  | 200 | 430/s | 0 | 450 / 615 ms | ✔ |
  | 600 | 290/s | 126 | 1293 / 3998 ms | ✖ locked out |
  | 1200 | 66/s | 2292 | 1812 / 4835 ms | ✖ locked out |

  Throughput **falls** as concurrency rises — saturation, almost certainly nginx
  TLS-handshake CPU on a ~1 vCPU box. Knee ~600 concurrent; collapse ~1200. It
  **recovers within ~20 s** of the flood stopping (meet passes, front door back
  to 162 ms) — `Restart=always` and the short-burst nature make it self-heal.

- **The cheap DoS is the relay's inbound limits, not bandwidth.** With the stock
  libp2p defaults still in production (`inboundConnectionThreshold: 5/s`,
  `maxIncomingPendingConnections: 10`, and every client arriving from
  `127.0.0.1` behind nginx), a flood of only a **few hundred half-open sockets**
  — or any churn above ~5 conn/s aggregate — starves the pool and **new
  legitimate users cannot connect at all**, while nginx is barely warm. The
  raised limits in `relay.mjs` (`500/s`, `128` pending) plus `limit_req` at nginx
  are precisely this mitigation; deploy them before treating the flood numbers as
  representative.

**Sizing take.** One cheap VPS front-ended by nginx sustains a few hundred TLS
handshakes/sec and ~500 concurrent chat sessions before the app cap. Chat is
bursty, not 1:1 concurrent, but past a few thousand users this wants **horizontal
sharding** (topic → small node-set, the sharding note in `docs/`): TLS CPU is the
per-node limiter and scales cleanly by adding small nodes or offloading TLS. The
single most cost-effective hardening is the inbound-limit fix above — it turns a
trivial few-hundred-socket DoS into a real bandwidth problem.

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
