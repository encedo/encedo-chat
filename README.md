# onchato

A synchronous, HSM-anchored, post-quantum-hybrid peer-to-peer messenger.
Minimal infrastructure, metadata-privacy by design, end-to-end encrypted with
long-term keys held in an Encedo HEM (hardware security module).

- **Instant-only** — both parties online during a conversation; no offline
  messages, no server-side history, no mailbox. Rooms are deterministic and
  crypto-derived ("meet in the park"). The transcript lives in RAM: a reload
  takes it — **except what you pin**. A pinned message is sealed into that one
  browser under your own identity key, never leaves it, and is never announced
  to the other side; the app says so before it keeps the first one. Contacts,
  groups and settings do persist (the contact book MAC'd against key swaps, the
  group state encrypted) — what never persists unasked is a message.
- **Minimal infra** — operator-run libp2p discovery nodes (two today: bs1 and
  bs2; the list ships compiled in and can be refreshed by IPFS CID); anyone can
  run their own network. Content travels WebRTC-direct where the platform can,
  and through the relay as ciphertext where it cannot.
- **PQ-hybrid confidentiality from day one** — X25519 + ML-KEM-768.
- **Dual-use** — one core, two channels: enterprise (Encedo) and the open
  network (onchato).

> **Status: shipping 0.5.x** — web ([onchato.com](https://onchato.com)),
> desktop (Linux/Windows/macOS, Tauri 2) and Android (signed APK from Actions)
> from one engine. `docs/` is the protocol of record, kept 1:1 with the code;
> `CLAUDE.md` records the implementation notes and the operational lessons.

## What it does today

1:1 conversations (EH-2 handshake + Double Ratchet, PQ-hybrid), groups (Sender
Keys, deniable ECDH-HMAC auth), encrypted file sharing over a TTL'd IPFS store,
voice notes, replies / edits / reactions / mentions, per-pair daily topic
rotation, presence without a handshake, pinned messages, profile
export/import, QR invites, a Polish/English UI, desktop tray + updater, an
Android foreground service so a phone in a pocket stays reachable.

## Documentation

- [`docs/PROTOCOL.md`](docs/PROTOCOL.md) — protocol & cryptography (identity,
  rendezvous, EH-2 handshake, ratchet, groups, session management, PQ roadmap,
  implementation guide, flow diagrams). **Describes what ships.**
- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — product & infrastructure.
- [`docs/THREAT-MODELS.md`](docs/THREAT-MODELS.md) — deployment profiles P1–P3.

`CLAUDE.md` holds the implementation notes (HEM/SDK reality, engine internals,
deploy lessons) for agents and developers.

## Layout

```
docs/         the specs (protocol of record)
impl/         the app: engine (lib/, eh2/, net/), web UI (web/), CLI (cli/),
              Tauri desktop + Android shell (src-tauri/), tests (test/)
relay/        the rendezvous/transport node (bs1/bs2 run this)
infra/        node list, tag-driven deploy units, nginx config, IPFS TTL sweeper
skin/         the original UI mockups (the shipped UI is impl/web/, long diverged)
hem-sdk-js/   Encedo HEM SDK (git submodule)
.github/      CI + release workflows (desktop, Android, tests)
```

## Local development

Requires **Node.js ≥ 22** (developed on 24; tests and CLI run the TypeScript
directly via native type-stripping). The web bundle and both Tauri shells are
built with webpack (`npm run web:build`).

```bash
# clone with the HEM SDK submodule
git clone --recurse-submodules git@github.com:encedo/encedo-chat.git
# or, if already cloned:
git submodule update --init --recursive

cd encedo-chat/impl
npm test                 # ~380 unit + offline integration tests, ~30 s
npm run web:dev          # the app on a local dev server
npm run browser-test     # two headless browsers, the real bundle, the real relay
```

## Transports: libp2p (default) and MQTT (fall-back)

Rendezvous, presence and WebRTC signalling ride a pub/sub transport. **libp2p +
GossipSub is the main one.** MQTT over WebSocket is a fully working **fall-back**
— the same engine, the same crypto, a broker instead of a mesh — chosen per
session and invisible to everything above it:

```bash
# web:  add ?mqtt=1        → wss://bs1.onchato.com/mqtt (the relay host)
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
- **Weaker metadata privacy than GossipSub — a real trade-off, not a config
  knob.** Content stays end-to-end encrypted, but on MQTT any connected client
  can subscribe to `#` and receive **every room's** traffic: which rooms are
  active (who is talking to whom), and message timing and size. A static broker
  ACL cannot prevent it — members need read on `ec/<their-room>/+`, and since the
  room is a runtime secret the only static grant that covers it is `ec/+/+`,
  which grants read on all rooms to everyone. Verified against the live broker
  (2026-07-31): `#` swept a room message; only `$SYS` was blocked. Under
  GossipSub, topics are unguessable and there is no wildcard subscribe, so this
  does not arise. **Do not enable MQTT where cross-room metadata to a connected
  client is unacceptable.** True isolation would need a broker auth plugin that
  treats the room secret as a subscribe capability — see the caveat below.

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

`/etc/mosquitto/encedo.acl` — copy `relay/mqtt/encedo.acl` verbatim. It blocks
`$SYS`, scopes **publish** to the client's own id (no sender-forging within a
room), and leaves **read** on `ec/+/+` — which, as the file itself documents and
the point above explains, is broad by necessity and does **not** isolate rooms.
Read it before deploying; it is honest about what it cannot do.

**MQTT metadata caveat — how true isolation would be built (not shipped).** To
stop `#` sweeps, the broker would need a per-connection capability check: a
client subscribing to `ec/R/+` must prove it knows `R`, without the broker
learning `R` outside that check. A mosquitto auth plugin can do this (username
carries the room, password carries an HMAC the plugin verifies against a
per-room key the operator provisions), but it re-introduces per-room state the
transport is designed to avoid. Until then, MQTT is the reach-over-privacy
fallback: it connects clients GossipSub cannot, at the cost of cross-room
metadata to a connected observer.

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

The state of this on the dev machine (2026-07-31, unchanged since): the **TCP
path is verified** (`npm run mqtt-meet` against the packaged broker — discovery
127 ms, EH-2 202 ms, messages both ways). The **WebSocket listener and the ACL
are not** — AppArmor confines mosquitto to `/etc/mosquitto`, so they need the
install above and a root shell. Run the block, and the last line proves the
browser's transport path.

## Checking the file encryption yourself

Shared files are encrypted in the browser and uploaded to an IPFS node that
holds nothing but ciphertext; the key rides in the message envelope, over the
ratchet or a group sender key, and never reaches the store. `file-decrypt.ts`
exists so that is a thing you can verify rather than a thing you are told.

Open the app with `?debug=1` and send or download a file. The console prints one
line per file:

```
[ec 12.44s] file evidence · {"cid":"Qm…","name":"raport.pdf","size":5242880,"key":"…","chunk":4194304,"chunks":2,"alg":"A256GCM-chunked-v1"}
```

Paste it — quotes included — into the tool:

```bash
cd impl

# the positive case: fetch the blob the node is holding, open it, write the file
node net/file-decrypt.ts '{"cid":"Qm…", … }'

# the negative control: same blob, no key, nothing to see
node net/file-decrypt.ts '{"cid":"Qm…","size":…,"chunk":…,"chunks":…,"alg":"…"}' --no-key

# through a public gateway instead of the app's proxy — same CID, same bytes
node net/file-decrypt.ts '{…}' --gateway https://ipfs.encedo.com

# against a different deployment's proxy (default: https://onchato.com)
node net/file-decrypt.ts '{…}' --origin https://chat.example.com
```

The run prints the ciphertext length and its first bytes, then either recovers
the original and reports whether any plaintext appears in the stored blob, or —
given a wrong key — refuses. A wrong key, a tampered blob, a reordered chunk and
a truncated file all land in that same refusal, by design: none of them may
yield partial plaintext.

`--out <path>` chooses where the plaintext goes; without it the file lands in a
**fresh temporary directory** under the manifest's name — deliberately never the
working directory, where a decrypted private file would sit one `git add -A`
away from being published. **A 404 means the file expired** — uploads live
minutes, and nothing here can bring one back, which is the other half of the
claim.

The evidence line is a complete capability to that one file. It is behind
`?debug=1` for that reason, and bounded anyway by the same expiry.

## Self-hosting

Running an independent network is a first-class, encouraged path (own nodes
from a public image, own signing key). See `docs/ARCHITECTURE.md`.

## License

[MIT](LICENSE).
