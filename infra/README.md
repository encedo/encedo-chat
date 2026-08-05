# Infra for file sharing (IPFS)

Two hosts, and the split between them is the security boundary:

- **`onchato.com`** — nginx serves the app and proxies exactly two operations to
  the node. The browser talks only here.
- **`ipfs.encedo.com`** — the Kubo node. Its RPC accepts one IP: the web host's.
  No gateway, no public discovery, and a job that expires uploads.

A browser must never reach the node directly. **Kubo's RPC is an admin API** —
`config`, `shutdown`, `files`, `key` and `repo/gc` live at the same endpoint as
`add`. IP allow-listing is what keeps that safe, and it only stays workable
because the allowed set is one address; it could never admit end-user phones on
mobile networks.

---

## On the web host (`onchato.com`)

```nginx
# Upload: ciphertext in, CID out. The blob is already encrypted; this host does
# no crypto and learns nothing but a size.
location = /f {
    limit_except POST { deny all; }
    client_max_body_size 128m;
    proxy_request_buffering off;      # stream it; buffering 128 MB fills /tmp
    proxy_read_timeout 300s;
    proxy_pass https://rpc.ipfs.encedo.com/api/v0/add?pin=false&to-files=/ec/$msec-$request_id;
}

# Download by CID. The regex is the allow-list: nothing else reaches the node.
location ~ ^/f/([A-Za-z0-9]+)$ {
    limit_except GET { deny all; }
    proxy_pass https://rpc.ipfs.encedo.com/api/v0/cat?arg=$1;
}
```

`pin=false` matters: the MFS entry is what keeps a blob alive, so expiry is a
`files rm` away rather than a pin to hunt down. `$msec-$request_id` is the
name the expiry job reads — seconds are enough, and the request id makes it
unique.

Certificates are Let's Encrypt on both sides, so no `proxy_ssl_verify off`.
Turning verification off on the path our ciphertext travels would be a bad habit
even against a backend we own.

## On the IPFS host (`ipfs.encedo.com`)

**1. Create the uploads directory once.**

```bash
ipfs files mkdir -p /ec
```

**2. Expose `cat` beside `add`; keep everything else blocked.** In particular
`files/*` and `repo/gc` stay unreachable — expiry runs locally, so nothing off
this machine needs them.

**3. Allow the web host's IP** on the RPC. That single address replaces any
notion of user authentication, and deliberately so: an authenticated upload
service would learn *who* uploaded *what* and *when*, which is precisely the
metadata the rest of the product avoids. The content is useless without a key
that never touches this host, and abuse is bounded by the size cap, the rate
limit and a five-minute life.

**4. Do not announce content to the public DHT.** Otherwise anyone who learns a
CID can fetch the ciphertext from the network — still encrypted, but it leaks
that a file of that size exists. Check what the node is doing before changing
anything:

```bash
ipfs config Routing.Type
ipfs config Reprovider.Strategy
```

For a node that only ever serves its own uploads, `Routing.Type=none` is the
blunt and reliable answer; it also stops the node fetching foreign content, so
confirm that is what you want before setting it. **Verify against the running
version** — these keys have moved between Kubo releases.

**5. Install the expiry job.**

```bash
install -m 755 infra/ipfs-ttl-gc.sh /usr/local/bin/ipfs-ttl-gc.sh
crontab -l 2>/dev/null | { cat; echo '*/1 * * * * /usr/local/bin/ipfs-ttl-gc.sh >> /var/log/ipfs-ttl-gc.log 2>&1'; } | crontab -
```

Why a ledger in MFS rather than `repo gc` on a timer: GC removes everything
unpinned *whenever it runs*, so a file uploaded ten seconds before a sweep lives
ten seconds. An MFS entry keeps its blocks alive, so nothing expires early, and
the directory listing is the upload log — CID and timestamp together, with
nothing beside it to fall out of sync and nothing to restore if the job dies.

Actual lifetime is `TTL` plus up to one sweep. Say "five minutes, collected
within a minute" in the UI; do not promise a precision the mechanism lacks.

---

## Checking it works

```bash
# from the web host — the whole path, end to end
echo hello | curl -sF file=@- https://onchato.com/f
curl -s https://onchato.com/f/<cid>            # → hello

# on the IPFS host — the ledger, and that it drains
ipfs files ls -l /ec
sleep 360 && /usr/local/bin/ipfs-ttl-gc.sh     # the entry should go
```

The app's own check is `impl/net/ipfs-test.ts`: it pushes ciphertext through
`/f`, reads it back, and verifies the round trip decrypts — which is also the
first thing that confirms Kubo's `/add` response is shaped the way the client
parses it.
