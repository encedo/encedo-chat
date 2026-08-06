# Infra for file sharing (IPFS)

Two machines, and the split between them is the security boundary. The node
answers on three names, and they are three different trust levels rather than
three spellings of one:

- **`onchato.com`** — nginx serves the app and proxies exactly two operations to
  the node. The browser talks only here.
- **`rpc.ipfs.encedo.com`** — the Kubo RPC, behind HAProxy: an IP allow-list,
  `POST` only, and an exact list of two paths (`/api/v0/add`, `/api/v0/cat`).
- **`ipfs.encedo.com`** — the read gateway, and it is **deliberately public**.
  Knowing a CID is the capability: the blob is ciphertext, and the key travels
  in the envelope over the ratchet, never here.
- **`webui.ipfs.encedo.com`** — the management console, on a narrower IP list
  plus HTTP basic auth. It reaches the **full** admin API, on purpose, because a
  console that cannot call `files` or `config` is not a console. The IP list and
  the password are the only controls on that route, which is why the list is
  shorter than the RPC's.

A browser must never reach the RPC directly. **Kubo's RPC is an admin API** —
`config`, `shutdown`, `files`, `key` and `repo/gc` live at the same endpoint as
`add`. IP allow-listing is what keeps that safe, and it only stays workable
because the allowed set is a handful of servers; it could never admit end-user
phones on mobile networks.

The gateway being open is a decision, not an oversight, and it is worth being
explicit about what it costs: anyone holding a CID can read that blob without
authenticating, from outside any rate limit or log. That is acceptable because
the CID only ever travels inside an authenticated envelope and the bytes are
useless without a key that never reaches this machine. It is **not** acceptable
to let the same CIDs reach the DHT — see below.

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

**4. Do not announce content to the public DHT.** The reason is not privacy —
it is that **announcing breaks the TTL**. A provider record invites foreign
nodes to fetch the blob and cache it, and once a copy exists elsewhere, `files
rm` plus `repo gc` end *our* copy's life, not the file's. The five-minute lease
is enforceable only while ours is the only copy. Announcing also ties this
node's PeerID to a list of CIDs with timestamps, which is the transfer metadata
the rest of the product goes out of its way not to keep.

Nothing is lost by turning it off. Every reader comes through our own HTTP — the
app via `/f/<cid>`, anyone else via the gateway — and neither path consults the
DHT. Announcing serves only foreign peer-to-peer retrieval, which is exactly the
traffic this node does not exist to serve.

```bash
docker exec ipfs1 ipfs config Gateway.NoFetch     # true: the gateway serves only what is local
docker exec ipfs1 ipfs config Routing.Type        # "not found" = unset = the default, which is `auto`
docker exec ipfs1 ipfs config show | grep -B2 -A10 -iE '"(provide|reprovider)"'
```

**Check the key name against the running version rather than assuming it** — the
announcing config moved from `Reprovider.*` to `Provide.*` between releases, and
which one applies depends on the binary in front of you. `Reprovider.Interval 0`
or `Provide.Enabled false` disables it; restart the container afterwards.

If selective announcing is ever wanted, the strategies are `all`, `pinned`,
`mfs` and `pinned+mfs`. **Granularity stops at the whole MFS — there is no
per-path selector**, so `mfs` cannot be narrowed to `/ec`. Today `/ec` is all
that MFS holds, which makes the two equivalent by accident rather than by
guarantee: anything else ever written to MFS joins the announcement.

`Routing.Type=none` is the blunt version and goes too far — it also stops the
node *fetching*, which is how the WebUI got here (`ipfs pin add`, since
`Gateway.NoFetch=true` stops the gateway but not bitswap). `autoclient` is the
middle setting: still fetches, no longer answers strangers' DHT queries.

Verify with a public gateway, before and after — a success proves you are
discoverable, while a single failure proves little, since public gateways time
out for their own reasons:

```bash
curl -sI --max-time 25 https://dweb.link/ipfs/<cid> | head -1
```

**5. Install the expiry job** as a sidecar on the docker network. Kubo's RPC is
not published to the host, so this is the way in that does not require opening a
port or handing cron the docker socket (root on the host, for a job that deletes
directory entries).

Copy `ipfs-ttl.sh` to the host and run `ipfs-ttl-run.sh`, which holds the exact
invocation — network, mount, environment — so it does not have to be remembered:

```bash
scp infra/ipfs-ttl.sh   root@<node>:/opt/my_project/docker/ipfs_ttl/ttl.sh
scp infra/ipfs-ttl-run.sh root@<node>:/opt/my_project/docker/ipfs_ttl/
ssh root@<node> sh /opt/my_project/docker/ipfs_ttl/ipfs-ttl-run.sh
```

**Prove the wiring before the first real sweep.** A TTL nothing can exceed makes
the run a no-op, so it tests exactly one thing — whether the container resolves
`ipfs1` — and destroys nothing if the answer is no:

```bash
docker run --rm --network www_network \
  -v /opt/my_project/docker/ipfs_ttl/ttl.sh:/opt/ttl.sh:ro \
  -e IPFS_API=http://ipfs1:5001 -e TTL=999999999 \
  alpine:3 sh -c "apk add --no-cache curl >/dev/null && sh /opt/ttl.sh"
```

`docker run` rather than a compose service: this is one container, and the
stack's compose file belongs to another project. The cost is that nothing
recreates it automatically — hence the script. A reboot is covered, though:
`--restart unless-stopped` brings it back, and the sidecar tolerates `ipfs1`
starting later, so start order does not matter.

A `while` loop rather than cron: the image has no cron daemon, `sleep 60` does
the same for less, and the output lands in `docker logs` with the rest of the
stack's.

Two details that each cost a confusing failure. **`sh /opt/ttl.sh`, not
`/opt/ttl.sh`** — a bind mount carries the host's permissions, and a missing
execute bit surfaces as "not found", which reads like a broken mount. And
**Docker silently creates a directory** when a bind-mount source is absent, so a
typo in the path mounts an empty directory over the script; `ipfs-ttl-run.sh`
checks for the file first for that reason.

This works because **the RPC lockdown lives at HAProxy, not in Kubo** —
`files/*` and `repo/gc` are refused from outside and remain reachable inside the
network. Worth stating rather than rediscovering: that lockdown protects against
the world, not between containers. Giving `ipfs1` and `ipfs-ttl` a network of
their own is what would close that, if it ever matters.

The script takes its address from `IPFS_API`, so nothing about it is
container-specific; a host cron works too, wherever the API is reachable. What
it must never be pointed at is `rpc.ipfs.encedo.com` — `files/*` and `repo/gc`
are blocked there deliberately, and cleanup taking the internal path is the
design rather than a workaround.

```bash
docker logs -f ipfs-ttl         # the first sweep clears everything already past its TTL
```

That first sweep is not gentle — every entry older than the TTL goes at once,
and `repo gc` follows. On the deployment where this was first installed it
removed 36 entries and about 245 MB. `TTL=86400 sh ipfs-ttl-run.sh` buys a quiet
pass to read the logs against; re-run without it to go live.

**`repo gc` collects every unpinned block, not only ours.** The WebUI survives
because it is pinned. Anything else that lands on this node without a pin will
not survive the next sweep, which is worth knowing before using it as a scratch
store for something else.

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

# on the IPFS host — the ledger, and that it drains on its own
docker exec ipfs1 ipfs files ls -l /ec
docker exec ipfs1 ipfs repo stat
docker logs --tail 20 ipfs-ttl                 # quiet once /ec is empty
```

The one that counts is not any of these: **send a file in the app, wait past the
TTL, and press Download.** It must say "expired" and not "failed". That is the
only exercise of the branch separating the two — `getBlob` turns 404 and 410
into `ExpiredError` and everything else into a failure — and until the sweeper
ran, nothing expired, so that branch had never once executed in production.

The app's own check is `impl/net/ipfs-test.ts`: it pushes ciphertext through
`/f`, reads it back, and verifies the round trip decrypts — which is also the
first thing that confirms Kubo's `/add` response is shaped the way the client
parses it.
