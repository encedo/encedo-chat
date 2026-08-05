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
    proxy_send_timeout 300s;

    proxy_set_header Origin     "";
    proxy_set_header Referer    "";
    proxy_set_header User-Agent "encedo-proxy";
    proxy_ssl_server_name on;
    rewrite ^ /api/v0/add?pin=false&to-files=/ec/$msec-$request_id break;
    proxy_pass https://rpc.ipfs.encedo.com;
}

# Download by CID. The regex is the allow-list: nothing else reaches the node.
location ~ ^/f/(?<cid>[A-Za-z0-9]+)$ {
    limit_except GET { deny all; }
    proxy_method POST;                # Kubo rejects GET on /api/v0/*
    proxy_set_header Origin     "";
    proxy_set_header Referer    "";
    proxy_set_header User-Agent "encedo-proxy";
    proxy_ssl_server_name on;
    rewrite ^ /api/v0/cat?arg=$cid break;
    proxy_pass https://rpc.ipfs.encedo.com;
}
```

### Four things here are not obvious, and each one cost a failed request

**Strip every marker of browser identity.** Kubo refuses anything that looks
like it came from a browser — an `Origin` it does not allow, a `Referer`, or a
`User-Agent` beginning with `Mozilla`. That is its CSRF defence and it is
correct: a browser must never drive an admin API. But this hop is
server-to-server, so it should carry none of those. All three, or the request is
refused with a bare `403 - Forbidden` from the node, which looks exactly like an
nginx permission problem and is not one. Verified header by header:
`Mozilla/5.0` is refused, `Chrome/150` is not, so it is the prefix.

The alternative — adding onchato.com to Kubo's allowed origins — would open the
RPC to a browser origin, which is the thing this whole arrangement exists to
prevent.

**`rewrite … break`, not variables in `proxy_pass`.** A variable in `proxy_pass`
makes nginx resolve the host per request, which needs a `resolver` directive or
it refuses to start. After a rewrite the target is constant and resolved once.

**`proxy_method POST`.** Kubo has rejected `GET` on `/api/v0/*` since 0.5. The
browser fetches `/f/<cid>` with GET, so without this every download is a 405.

**A named capture, `(?<cid>…)`.** `rewrite ^ … $1` resets the positional
captures — `$1` there refers to the *rewrite's* groups, and `^` has none, so the
CID arrives empty and Kubo answers "path does not have enough components". A
named capture survives, and it does not duplicate the pattern the way repeating
the regex inside the rewrite would.

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
