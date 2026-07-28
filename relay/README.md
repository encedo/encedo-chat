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

On the onchato host, in the `encedo-chat` checkout:

```bash
git pull
cd relay
npm ci
sudo systemctl restart onchato-relay
```

First-time systemd install:

```bash
# set WorkingDirectory in onchato-relay.service to your clone path, then:
sudo cp onchato-relay.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now onchato-relay
sudo journalctl -u onchato-relay -f      # confirm PeerId 12D3KooWP6Sp… on startup
```

Node 18+ (plain ESM). Runs as `www-data` by default — the clone dir must be readable by it.

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

## Tunables (relay.mjs)

- `maxConnections: 520`, `maxReservations: 256`, `maxMessageSize: 65536` (64 KB).
- GossipSub mesh `D:8, Dlo:6, Dhi:12` (tuned for ~25 clients/topic).
- `MAX_TOPICS = 50` — **hard cap**: beyond 50 live topics new rooms are refused.
  No eviction yet — see the `TODO(eviction)` in `relay.mjs` (drop a topic on
  last-unsubscribe / TTL-evict idle ones to make the cap soft). Follow-up.
- The per-message `console.log` is debug output (ciphertext) — candidate to trim
  in production to reduce log volume + metadata in journald.
