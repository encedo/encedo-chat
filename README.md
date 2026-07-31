# Encedo Chat

A synchronous, HSM-anchored, post-quantum-hybrid peer-to-peer messenger.
Minimal infrastructure, metadata-privacy by design, end-to-end encrypted with
long-term keys held in an Encedo HEM (hardware security module).

- **Instant-only** — both parties online during a conversation; no offline
  messages, no server-side history, no mailbox. Rooms are deterministic and
  crypto-derived ("meet in the park").
- **Minimal infra** — a small set of operator-run libp2p discovery nodes;
  anyone can run their own network. Messages travel WebRTC-direct, or through a
  blind relay when direct is impossible.
- **PQ-hybrid confidentiality from day one** — X25519 + ML-KEM-768.
- **Dual-use** — one core, two channels: enterprise (Encedo Chat) and the open
  network (onchato).

> **Status: design phase.** The protocol and architecture are complete and
> under external cryptographic audit (see `docs/`). Implementation is just
> beginning — `impl/` is a spike, not yet a runnable app.

## Documentation

The design is the source of truth and lives in [`docs/`](docs/):

- [`docs/PROTOCOL.md`](docs/PROTOCOL.md) — protocol & cryptography (identity,
  rendezvous, EH-2 handshake, ratchet, groups, session management, PQ roadmap,
  implementation guide, flow diagrams).
- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — product & infrastructure.
- [`docs/THREAT-MODELS.md`](docs/THREAT-MODELS.md) — deployment profiles P1–P3.

`CLAUDE.md` holds implementation notes (HEM/SDK reality, spike plan) for agents
and developers. UI mockups (replaceable skins) are in [`skin/`](skin/).

## Layout

```
docs/         design specs (audit target)
skin/         UI mockups — open ui-mockup.html in a browser
impl/         TS spike (rendezvous spine first; crypto held pending audit)
hem-sdk-js/   Encedo HEM SDK (git submodule)
```

## Local development

Requires **Node.js ≥ 22** (Node 24 runs the TypeScript spike directly via
native type-stripping — no build step for the current slice).

```bash
# clone with the HEM SDK submodule
git clone --recurse-submodules git@github.com:encedo/encedo-chat.git
# or, if already cloned:
git submodule update --init --recursive

cd encedo-chat/impl
npm test            # once the HEM slice lands
```

The UI mockups are static — open `skin/ui-mockup.html` (or the terminal-styled
`skin/ui-mockup-hacker.html`) directly in a browser to preview the interface.

## Transports: libp2p (default) and MQTT (fall-back)

Rendezvous, presence and WebRTC signalling ride a pub/sub transport. **libp2p +
GossipSub is the main one.** MQTT over WebSocket is a fully working **fall-back**
— the same engine, the same crypto, a broker instead of a mesh — chosen per
session and invisible to everything above it:

```bash
# web:  add ?mqtt=1        → wss://<same host>/mqtt
#       or ?mqtt=wss://broker.example/mqtt
# CLI:  ec chat <name> --mqtt [mqtt://127.0.0.1:1883]
# proof it runs unchanged (needs a local broker):
cd impl && npm run mqtt-meet
```

**Why it exists.** libp2p is a mesh with a roadmap we want (peer routing, circuit
relay for the relay-blind data plane in `docs/PROTOCOL.md` §13); MQTT is a star
with a broker. Having both means an operator who cannot or will not run a libp2p
node can still run the network on infrastructure they already understand.

**What it buys**

- Far smaller client: MQTT is a few hundred lines with **no dependency**
  (`impl/net/mqtt.ts`), against ~900 KB of libp2p in the browser bundle.
- No mesh to form. GossipSub needs hundreds of milliseconds to graft before the
  first frame goes anywhere, and much of the room's retry machinery exists for
  that window. Measured locally: **peers discover each other in ~130 ms and
  finish the EH-2 handshake in ~200 ms**, against 1–2 s through the relay.
- Ordinary operations: any broker, standard monitoring, standard scaling.

**What it costs**

- A star, not a mesh: federation means broker bridging or clustering, not peers
  finding each other.
- No path to the relay-blind data plane (§13) — that design needs circuit relay.
  The direct WebRTC plane (P1) works identically on both transports.
- The broker learns nothing new about content (everything is end-to-end
  encrypted), but it must be configured against **wildcard subscriptions** — see
  below. Under GossipSub a peer must already know a topic to join it; under MQTT
  a single `#` subscription would otherwise enumerate every room.

**Topic mapping.** `ec/<room-topic>/<client-id>` for publishing,
`ec/<room-topic>/+` for subscribing — the sender id lives in the topic because
MQTT does not identify publishers. Room topics are 32-byte derived secrets, so
knowing one is the authorisation to be in the room.

**QoS 0 only, no retained messages, no persistent sessions.** These are not
missing features; they are the features that would make the broker *store*
traffic, and this product does not store messages anywhere. Delivery
confirmations, re-sends and ordering are handled above the transport and work the
same on both.

### Running a broker

Local development (Debian/Ubuntu):

```bash
sudo apt install mosquitto mosquitto-clients
# the packaged default already listens on 127.0.0.1:1883 for anonymous clients
cd impl && npm run mqtt-meet          # two peers meet, handshake and talk
```

Production, alongside the existing site — **nginx terminates TLS, mosquitto never
faces the internet**. Ready-to-copy files live in `relay/mqtt/`:

```bash
sudo cp relay/mqtt/mosquitto.conf /etc/mosquitto/conf.d/encedo-chat.conf
sudo cp relay/mqtt/encedo.acl     /etc/mosquitto/encedo.acl
sudo systemctl restart mosquitto
# then paste relay/mqtt/nginx-mqtt.conf into the onchato.com server block
```

`/etc/mosquitto/conf.d/encedo-chat.conf`:

```conf
# Bind to loopback only: the internet reaches this through nginx, never directly.
listener 9101 127.0.0.1
protocol websockets

allow_anonymous true          # identity is cryptographic, not an account (see below)
per_listener_settings false
acl_file /etc/mosquitto/encedo.acl

# Nothing is stored. A broker that persists is a broker that has our ciphertext
# to hand over; this product keeps messages only on the participants' screens.
persistence false
retain_available false
max_queued_messages 0
queue_qos0_messages false
autosave_interval 0

# Fit the traffic we actually send, and refuse the rest.
message_size_limit 65536      # handshake frames are ~1.2 KB; 64 KB is generous
max_keepalive 120
max_inflight_messages 20
max_connections 5000

log_type error
log_type warning
log_timestamp true
connection_messages false     # do not log a line per client id
```

`/etc/mosquitto/encedo.acl` — **this is the security-critical file**:

```conf
# One rule, and it is the whole model: a client may read and write inside a
# single room, and rooms are named by a secret only its two members can derive.
#
# `ec/+/+` matches exactly one room and one sender. It does NOT match `ec/#`,
# so a client cannot subscribe to everything and enumerate the network — which
# is the one property MQTT does not give us for free.
topic readwrite ec/+/+

# Deny the broker's own telemetry outright.
topic deny $SYS/#
```

nginx, next to the existing site (the relay already lives at `/relay`):

```nginx
location /mqtt {
    proxy_pass http://127.0.0.1:9101;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;

    # Long-lived sockets: the client pings every 15 s, so anything above that
    # only kills healthy connections.
    proxy_read_timeout 300s;
    proxy_send_timeout 300s;

    # Cheap abuse control at the edge, where it belongs.
    limit_conn mqtt_conn 20;      # per IP; define: limit_conn_zone $binary_remote_addr zone=mqtt_conn:10m;
    limit_req  zone=mqtt_req burst=50 nodelay;  # limit_req_zone … zone=mqtt_req:10m rate=30r/s;
}
```

**Verify before exposing it** — the ACL is the whole access model, so prove it
rather than trust it:

```bash
ss -ltnp | grep 9101                      # bound to 127.0.0.1 ONLY
mosquitto_sub -h 127.0.0.1 -p 9101 -t '#' -C 1   # must be REFUSED (this is the point)
mosquitto_sub -h 127.0.0.1 -p 9101 -t 'ec/abc/+' -C 1 &  # must be accepted
mosquitto_pub -h 127.0.0.1 -p 9101 -t 'ec/abc/me' -m hi
journalctl -u mosquitto -n 20             # no 'persistence' warnings, no per-client lines
cd impl && npm run mqtt-meet ws://127.0.0.1:9101  # the WebSocket path, end to end
```

The state of this on the dev machine: the **TCP path is verified**
(`npm run mqtt-meet` against the packaged broker — discovery 127 ms, EH-2 202 ms,
messages both ways). The **WebSocket listener and the ACL are not** — AppArmor
confines mosquitto to `/etc/mosquitto`, so they need the install above and a root
shell. Run the block, and the last line proves the browser's transport path.

## Self-hosting

Running an independent network is a first-class, encouraged path (own nodes
from a public image, own signing key). See `docs/ARCHITECTURE.md`.

## License

[MIT](LICENSE).
