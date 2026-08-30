# Performance & capacity — measured numbers

Everything we measured, with the **conditions** each number was taken under (a
rate without the box and config it ran on is meaningless). Newest work at the
bottom of each section. Reproduce with the tools in `impl/net/` (`npm run
relay-load / relay-saturate / relay-flood / relay-hsrate / relay-chatload`).

## Test rigs

| name | spec | role |
|---|---|---|
| **dev box** | aarch64 VMware VM, 4 cores, ~15 GB, Node 24 | where most local Docker measurements ran; has Docker (no `/dev/kvm`, so no real VMs) |
| **laptop** | Intel i7-11gen, **8 cores, 32 GB**, x86_64, Ubuntu, Node 24 (user-local) | the stress/load-generator box; fast per-core. Repo at `~/ec-src/impl`, relay at `~/ec-relay/relay` |
| **onchato / bs1** | **2 vCPU / 2 GB RAM**, Ubuntu 24.04, **AMD EPYC 7551P (Zen 1, 2017) @ ~2.0 GHz/vCPU**, AES-NI + SHA-NI present, VM guest (shared host) | production relay behind nginx (TLS) at `bs1.onchato.com` |

**Methodology caveats that shaped these numbers** — read before trusting any of them:
- **You cannot measure a VPS's ceiling from a home connection.** The laptop's
  home NAT/uplink throttles at ~250 conn/s and both ends stay idle — you measure
  the home router, not the server.
- **Client and server on one host contaminate CPU tests.** The load generator
  also does crypto (TLS/Noise), so on a single box it steals cores from the
  thing under test. The relay-vCPU law needed the laptop (separate box).
- **Per-core speed varies wildly.** The laptop's i7 core is ~2× the onchato
  EPYC-Zen1 core, so laptop handshake rates **overestimate** onchato's.

---

## Crypto (engine cost, no network)

Dev box (aarch64), EH-2 = X25519 triad + ML-KEM-768 + transcript. Reproducible:
**`npm run crypto-bench`** (`net/crypto-bench.ts` — in-process, offline, both
sides of every handshake; re-run of 2026-08-30 confirmed the 2026-07-31 ad-hoc
numbers within noise):

| operation | cost |
|---|---|
| 20 full EH-2 handshakes, **both sides** | 52 ms → **2.6 ms each** |
| 1000 message seal+open round trips (one ratchet) | 418 ms → **0.42 ms/msg** |

→ Crypto is never the bottleneck. 20 contacts' handshakes ≈ 50–70 ms; no worker
thread needed. A HEM identity adds one device round-trip per side per handshake
on top (nothing per message — `hem_usage.md`).

---

## Memory per held connection (server-side)

Docker container relay, **1 vCPU / 512 MB cap** (dev box), read via `docker stats`:

| relay state | RSS |
|---|---|
| idle | ~63 MB |
| 520 held libp2p sessions | ~192 MB |

→ **~0.25 MB (250 KB) per connection → ~4000 sessions / GB** after base. Held
sessions are near-free on CPU; this ceiling is RAM. (Confirmed again on onchato:
1658 sessions ≈ ~410 MB relay RAM.)

---

## Connection-setup CPU — two limits, only one scales with cores

### nginx TLS (scales with cores — multi-worker)
Docker, nginx pinned with `taskset`, raw-WS churn (measures TLS only):

- **~1500–1700 TLS handshakes/s per core** (dev box, RSA-2048, no session cache);
  the relay behind it sat at 25–30 %.
- Real cheap VPS earlier: **~430/s** (slower core; AES-NI helps).
- Independent per-worker work → scales ~linearly with cores.

### Relay Noise/libp2p (does NOT scale with cores — single Node process)
Laptop (i7), `relay-hsrate`, relay `taskset`-pinned, load from other cores:

| relay cores | clients | handshakes/s | relay CPU |
|---|---|---|---|
| 1 | 1 | 253 | 86 % |
| 2 | 1 | 256 | 88 % |
| 1 | 2 | 257 | 94 % |
| 2 | 2 | 269 | **106 %** |

→ **~260 real libp2p handshakes/s per process on a fast i7 core, flat from 1 to 2
cores** (CPU stays at ~one core's worth). A single relay process is
**one-core-bound**; a second vCPU buys it nothing. **Scale the relay
horizontally** (more processes / nodes, sharded by topic), not vertically.

For **real** clients (who do Noise), the per-node setup ceiling is the relay's
~260/s, not nginx — nginx can feed far faster than one relay accepts.

---

## Content through the relay (Variant B — WebRTC NOT carrying content)

Docker relay, `relay-chatload`, 30 chatting pairs, ~19 msg/s aggregate:

- **CPU cheap**: 2–6 % of one core.
- **Bandwidth is the limit**: order **a few KB of relay traffic per message**
  (body ~250 B sealed; rest is GossipSub fan-out/control + WS/TCP framing).
- RAM crept 70 → 94 MB (GossipSub message cache).

→ When WebRTC fails and content rides the relay, the box becomes **bandwidth**-
bound, not CPU-bound. Sizing: `bandwidth ≈ users × msg/s × (1 − webrtc_fraction) × ~3 KB`.

---

## DDoS / flood behaviour (onchato, real VPS)

### Front door under churn (dev box → onchato, PRE-hardening)
Raw-WS connect+close (nginx TLS), escalating concurrency:

| concurrency | successful/s | failures | latency p50/p95 |
|---|---|---|---|
| 200 | 430 | 0 | 450 / 615 ms |
| 600 | 290 | 126 | 1293 / 3998 ms (knee) |
| 1200 | 66 | 2292 | 1812 / 4835 ms (collapse) |

→ Throughput **falls** as concurrency rises = saturation (nginx TLS CPU, ~1 vCPU).
**Recovers within ~20 s** of the flood stopping (`Restart=always`).

### The cheap DoS (fixed by commit `2a1306a`)
libp2p defaults `inboundConnectionThreshold: 5/s` + `maxIncomingPendingConnections: 10`,
and **behind nginx every client is `127.0.0.1`**, so those are limits on the
whole network:

| how clients arrive | pre-fix | post-fix |
|---|---|---|
| 8 dials at once | **3 refused** | 8/8 |
| 24 dials at once | **19 refused** | 24/24 |
| all-at-once load 5/10/20/40 pairs | **0/20** (locked out) | **40/40, 0 fail** |

Fix: `inboundConnectionThreshold: 500`, `maxIncomingPendingConnections: 128`,
and move rate-limiting to nginx `limit_conn`/`limit_req` (where the real IP is
known). Verified live post-deploy: bursts 8/8 and 24/24, all-at-once 40/40.

### Flood from the laptop (home network) → hardened onchato
Churn from the 8-core laptop; **laptop stayed 90 % idle** yet throughput capped
at ~250/s → **the home NAT/uplink was the limit, not onchato**. onchato served
real users (probes from a different IP) throughout a 4000-concurrent flood. The
hardened config shrugged it off.

---

## Concurrency ceiling (held sessions) — onchato

`relay-saturate`, slow ramp (holding idle connections; the home NAT throttles
rate but not held count). Two config walls found and removed:

| stage | result | wall |
|---|---|---|
| pre-fix | capped at **517**, none dropped | relay connection cap 520 (today the `--max-connections` flag) |
| raised the cap → 50000 | sailed past 517, **hard cap ~1010** | nginx `worker_connections` default (~1024) — sharp plateau, refusals climb steeply |
| raised nginx `worker_connections` | passed 1010, reached **1658 held**, **none dropped** | none hit on onchato — refusals crept in **gradually** (1.7 %, from ~1100) = the **home path** saturating, not the server |

Client at 1658 had huge headroom (1032 fd of 1 048 576, conntrack 1103/262144,
RSS 1.9 GB/32 GB, cores idle) → the ~1010 walls were **server-side config**, and
the 1658 stop was the **home test rig**, not onchato. At 1658, onchato relay used
only **~410 MB of its 2 GB**.

→ **onchato holds ≥1658 concurrent sessions with room to spare; its true ceiling
is unmeasured from home.** Needs a datacenter load box (Hetzner) to reach it.

---

## Capacity verdict for onchato (2 vCPU / 2 GB, EPYC Zen1 @ 2 GHz)

Derived from the laws above (⚠ estimates past 1658 — the measured point):

- **Concurrency (RAM-bound):** ~1.6 GB usable after OS/base ÷ ~0.35 MB/conn
  (relay + nginx) ≈ **~3000–4500 concurrent connections ≈ ~1500–2000 conversations**.
  Measured 1658 barely touched RAM. Strong for the tier.
- **New-connection rate (CPU-bound, the tighter axis on this old slow core):**
  relay is single-core-bound and the Zen1 core is ~½ the i7's, so estimate
  **~130–180 handshakes/s per node** (below the laptop's 260/s; not measured
  directly on onchato). A 3000-client reconnect storm ≈ 20–40 s on one node.
- **nginx TLS is AES-NI accelerated** (`aes`/`sha_ni` present) → the TLS side is
  fine despite the old CPU; the relay Noise rate is the real per-node limit.
- It is a **VM on a shared EPYC host** → possible noisy-neighbour variance;
  measure the rate on onchato itself or a matched Hetzner spec, don't extrapolate
  from the fast laptop.

**What to scale:** RAM for *how many are connected*, nginx cores for *TLS rate*,
**more relay processes/nodes (sharded by topic) for real connection-setup rate**
— the relay does not scale vertically. Past a few thousand users, horizontal.

---

## Still unmeasured (needs a datacenter load box — Hetzner)

- onchato's **true concurrency ceiling** (home path caps at ~1658; box has headroom).
- onchato's **true handshake rate** (~130–180/s is an estimate; laptop is too fast, home path too slow).
- The **relay-vCPU law's absolute per-core rate** on a production-class core.

Plan: Hetzner VM (datacenter path, no home router) → `relay-flood` / `relay-saturate`
against onchato with the DDoS-protection limits temporarily raised
(`--max-topics`, `--max-connections` on the relay; nginx `worker_connections`
plus the per-IP `limit_conn relay_conn` / `limit_req relay_req` pair on
`/relay`). **Revert to the versioned `infra/nginx/onchato.com` after — those
limits are the DDoS protection** (libp2p's own is deliberately off, see
`relay/README.md`).

⚠️ All numbers here predate the group keepalive (`lib/grouproom.ts`: a 1-byte
frame per member per ~20 s ± 8 s on every group topic). Variant B gains a
constant term proportional to open groups that the `U × R × (1−w) × ~3 KB`
formula does not carry.
