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
