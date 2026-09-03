# onchato relay

The rendezvous/transport node — libp2p GossipSub (message fan-out) +
circuit-relay-v2 (reservations). **Transport-only:** it forwards encrypted
frames and grants reservations; it never sees plaintext or keys. The production
network is **bs1 + bs2**; the list clients compile in is `infra/nodes.json`,
and the client fails over down that list (`impl/lib/nodelist.ts`,
`test/failover.test.ts`).

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
- `--max-topics` (default **250**) / `--idle-ttl` (default **120** s) — the topic
  budget; see Tunables.
- `--max-connections` (default **520**) — the connection ceiling. A flag so load
  tests raise it from `ExecStart` instead of editing the file (a local edit
  conflicts on every `git pull`).
- `--v6-port` / `--v6-host` — a second, direct IPv6 WS listener for the
  inter-relay mesh (public IPv4 between the nodes is blocked; peers dial the raw
  port, nginx is not on that path).

Environment: `DUMP=<dir>` — full JSONL trace of everything the relay observes,
for debugging and audit; **never on production** (see Dump, bottom).

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
running process's memory. Startup prints exactly four things worth reading:

```
🔑 Pass: "bs1.onchato.com" → PeerId: 12D3KooWP6Sp…cDmp   ← unchanged, or every client breaks
✅ Relay uruchomiony na porcie 9001
🔌 Połączenia: limit 520                                  ← proves --max-connections took
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

## Adding a node (bs3 and up)

**A node's identity is knowable before the machine exists.** `--pass` is the
Ed25519 seed, the convention is that the pass IS the hostname, so the PeerId —
and therefore the multiaddr clients will carry — can be derived on a laptop:

```js
import { generateKeyPairFromSeed } from '@libp2p/crypto/keys'
import { peerIdFromPrivateKey } from '@libp2p/peer-id'
import { createHash } from 'node:crypto'
const key = await generateKeyPairFromSeed('Ed25519', createHash('sha256').update('bs3.onchato.com').digest())
console.log(peerIdFromPrivateKey(key).toString())
```

Verified against the two live nodes: it reproduces `12D3KooWP6Sp…cDmp` for bs1
and `12D3KooWJJJt…1NT1y` for bs2, so the third is not a guess.

**bs3.onchato.com, precomputed:**

```
/dns4/bs3.onchato.com/tcp/443/wss/http-path/%2Frelay/p2p/12D3KooWLcDzqtSAetckwdzzqYbLTsN6wHFx8T4uKr5Yn1GUvSt5
```

Order of work, and the order matters:

1. VM, DNS `bs3.onchato.com`, certificate, nginx from the block below (it is
   host-agnostic apart from `server_name`).
2. `--pass bs3.onchato.com`, systemd unit, then check the startup lines the way
   "Did it actually take?" above says — **the PeerId in the log must equal the
   one derived here.** If it does not, the pass is wrong and every client that
   ever caches this address will fail against it.
3. `--peers` on bs1 and bs2 pointing at bs3 (and bs3 at both), so a pair split
   across nodes still meets.
4. **Only then** add it to `infra/nodes.json`. That file is what a fresh client
   compiles its defaults from, so a node listed before it answers costs every
   new client a failed dial at startup — the failover survives it, but it is a
   second of nothing for everybody.

## nginx (bs1.onchato.com)

The relay listens on `0.0.0.0:9001` (plain WS — public access is cut by the
firewall and nginx, the socket itself is not bound to loopback); nginx
terminates TLS and proxies `/relay` (WSS).

**The versioned config is `infra/nginx/onchato.com` — that file is the source of
truth**, this section only says what to look for in it: the `Upgrade`/
`Connection` headers, the hour-long read/send timeouts a long-lived WebSocket
needs, and the `limit_conn`/`limit_req` pair on `/relay` (see the inbound-limits
section below for why those limits are load-bearing, not optional). Deploy is
`scp` to `sites-enabled` + `nginx -t` + reload.

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
known. The replacement is **deployed in `infra/nginx/onchato.com`**: zones
`relay_conn`/`relay_req` in `http{}`, and in the `/relay` location
`limit_conn relay_conn 20` (per real IP) + `limit_req zone=relay_req burst=30
nodelay`. The `limit_req` bites the HTTP handshake only — an established
WebSocket lives outside it.

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

- **Connection setup — two CPU limits, and the tighter one does NOT scale with
  vCPU.** Two different pieces of work per arriving client:
  - **TLS (nginx)** *scales* with cores — nginx is multi-worker, handshakes are
    independent. Raw-connection flood: **~1500–1700 TLS handshakes/s per core**
    (dev box, RSA-2048, no session cache); the real cheap VPS ~430/s on its
    slower core.
  - **Noise + libp2p (the relay)** does **not**. The relay is a single Node
    process; measured on the i7 laptop (`relay-hsrate`, `taskset`-pinned, load
    from other cores): **~260 real libp2p handshakes/s on one core, and the same
    ~260/s given two cores** (CPU held at ~one core's worth — 94 % → 106 %, a
    marginal libuv-threadpool spillover, rate 257 → 269). A second vCPU buys the
    relay essentially nothing.

  So for **real** clients (who do Noise), the per-node ceiling is the relay's
  **~260 handshakes/s per process**, not nginx — nginx can feed far faster than
  one relay accepts. The lever is therefore **horizontal**: more relay processes
  / nodes (each its own PeerId, sharded by topic), not a bigger box. Adding vCPU
  helps nginx and nothing else; adding relay processes is what raises the setup
  rate.
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
  deploy or a topic rollover makes many clients redial at once. Provision for the peak
  handshake rate — but note (above) this splits: **nginx cores** raise TLS
  throughput, while the relay's ~260 hs/s/process is raised only by **more relay
  processes/shards**. `ssl_session_cache` + the raised inbound limits cut the
  nginx side; sharding cuts the relay side. A bigger single box does neither past
  one relay core.
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

- `--max-connections` (default **520**), `maxReservations: 256`,
  `maxMessageSize: 65536` (64 KB).
- GossipSub mesh `D:8, Dlo:6, Dhi:12, Dout:0` (tuned for ~25 clients/topic),
  `floodPublish: true`, `allowPublishToZeroTopicPeers: true`,
  `historyLength: 2` / `historyGossip: 1` (a smaller message cache than the
  default 5 windows).
- `--max-topics` (default **250**) — cap on **concurrent live** topics. It is soft
  in time: a topic with no activity for `--idle-ttl` (default **120 s**) is
  evicted, so the slot returns; the sweep runs every
  `max(2 s, min(30 s, idle-ttl/2))`. Clients heartbeat an Announce every ~15 s,
  so a room anyone is actually in is refreshed continuously and never evicted —
  keep `--idle-ttl` well above 15 s.
  **When the cap does bite, the client sees nothing** — no error, just an empty
  room, which looks like a broken app. The relay logs
  `[!topic] LIMIT … REFUSING` for exactly that case; watch for it.
  (This is what bit us on 2026-07-29: the deployed relay still ran the
  pre-eviction build with a hard cap of 50, had refused every new topic for a
  while, and only a restart cleared it.)
- The per-message log is **metadata only** (truncated topic, sender prefix, byte
  count) — the payload is ciphertext and logging it only parked user metadata in
  journald. The full frame goes to disk only under `DUMP=<dir>` (next
  section), which production never sets.

## Dump (debug / audit) — `DUMP=<dir>`, never on production

`DUMP=<dir>` makes the relay write **everything it can observe** to JSONL files
in `<dir>` (`dump.mjs`). Unset or empty = off, and off means off: no directory,
no file, no listener, no wrapper — every call site is `dump?.…`. When it is on,
the startup banner prints `🧾 DUMP ON → <dir>`, so **the absence of that line in
`journalctl -u onchato-relay` is the proof a node ran without it.**

Two purposes. Debugging (what did the relay actually see when a room "did not
form"?), and audit: seven days of dump is the relay's complete observable
surface — every address, peer id, topic and every frame byte — so an auditor
can check that none of it links a person to a conversation or decodes to
plaintext. That same completeness is why production must never set it: the
files *are* the metadata the design promises not to keep.

Two files per UTC day (dir `0700`, files `0600`), one JSON object per line,
`{ts, type, …}`, **peer ids and multiaddrs in full**:

| file | type | fields |
|---|---|---|
| `events-YYYY-MM-DD.jsonl` | `start` / `stop` | `pid`, `node`, `peer` (the relay), `flags` (`--pass` value redacted) / `signal` |
| | `conn.open` / `conn.close` | `conn` (id, pairs open with close), `peer`, `ip`, `addr` (raw multiaddr), `dir` |
| | `sub` / `unsub` | `peer`, `ip`, `topic` |
| | `topic.add` / `topic.refuse` / `topic.evict` | `topic`, `peer` (who caused it), `limit` / `idle_s` |
| | `reservation` | circuit-relay-v2 reservation: `peer`, `addr`, `expiry` |
| `payload-YYYY-MM-DD.jsonl` | `msg` | `topic`, `from` (publisher) + `ip`, `via` (the peer that handed us the frame) + `viaIp`, `id` (GossipSub msgId), `seq`, `size`, `data` (**base64 of the whole frame**) |

```json
{"ts":"2026-09-03T09:37:33.024Z","type":"conn.open","conn":"gg17v5…","peer":"12D3KooWB6CY…VMtB","ip":"203.0.113.7","addr":"/ip6/::ffff:7f00:1/tcp/47040/p2p/12D3KooWB6CY…VMtB","dir":"inbound"}
{"ts":"2026-09-03T09:37:36.111Z","type":"msg","topic":"room-1","from":"12D3KooWB6CY…VMtB","ip":"203.0.113.7","via":"12D3KooWB6CY…VMtB","viaIp":"203.0.113.7","id":"CAESIOgg…","seq":"8819469571316285728","size":7,"data":"AAEC/v9BQg=="}
```

**Where `ip` comes from.** Behind nginx every connection arrives from
`127.0.0.1` (see Peer scoring above), and the libp2p WebSocket transport never
surfaces the HTTP upgrade. So with the dump on, `dump.mjs` wraps
`http.createServer` and reads **`X-Real-IP`** off the upgrade request itself,
keyed by nginx's loopback source port — the same port libp2p reports in
`connection.remoteAddr`, so the join is exact. The `/relay` block in
`infra/nginx/onchato.com` sends that header; with the dump off it dies inside
the `ws` library after the handshake and is stored nowhere. Without the header
`ip` is `127.0.0.1`; direct peers (the IPv6 inter-relay mesh) carry their real
address either way. The dual-stack listener reports IPv4 clients as
`::ffff:7f00:1`-style mapped addresses — `ip` is folded back to dotted IPv4,
`addr` keeps the raw multiaddr.

**What it cannot see:** bytes inside a circuit-relay HOP stream — libp2p pipes
them with no hook, so only the reservation and both connections show. The
shipped client does not use circuits (`impl/net/peer.ts` has only the
WebSocket transport); all its traffic is GossipSub, which lands in
`payload-*.jsonl` whole. Note also that a peer that simply disconnects sends no
`unsub` — you see `conn.close`, and the topic's `topic.evict` after `--idle-ttl`.

Writes are synchronous appends on a held fd, so every line is on disk when the
process dies; `SIGTERM`/`SIGINT` append a `stop` line first. The relay's rate
(one Announce per client per ~15 s) makes the cost irrelevant.

### Turn it on (a drop-in, not the unit file)

```bash
sudo systemctl edit onchato-relay
```
```ini
[Service]
StateDirectory=onchato
Environment=DUMP=/var/lib/onchato/relay-dump
```
```bash
sudo systemctl restart onchato-relay
sudo journalctl -u onchato-relay -n 20 | grep '🧾'        # must show DUMP ON → …
```

Off again: `sudo systemctl revert onchato-relay && sudo systemctl restart
onchato-relay`, confirm the `🧾` line is gone, then delete the files
(`sudo shred -u /var/lib/onchato/relay-dump/*.jsonl`).

### Reading it

```bash
cd /var/lib/onchato/relay-dump
jq -r .type events-*.jsonl | sort | uniq -c                          # what happened, by kind
jq -r 'select(.ip) | .ip' events-*.jsonl | sort | uniq -c | sort -rn  # who connected, how often
jq -c 'select(.type=="topic.refuse")' events-*.jsonl                 # rooms the cap turned away
jq -c '{ts,topic,from,ip,size}' payload-*.jsonl | head               # the data plane, without bytes
jq -r .data payload-*.jsonl | base64 -d | strings -n 8 | head        # audit: readable text in ANY frame? should print nothing meaningful
jq -c 'select(.type=="conn.open" and .ip=="203.0.113.7")' events-*.jsonl   # one address's whole story
```
