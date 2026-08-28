# Infra for file sharing (IPFS)

Two machines, and the split between them is the security boundary. The node
answers on three names, and they are three different trust levels rather than
three spellings of one:

- **`onchato.com`** — nginx serves the app and proxies exactly two operations to
  the node. The browser talks only here.
- **`rpc.ipfs.encedo.com`** — the Kubo RPC, behind HAProxy: an IP allow-list,
  `POST` only, and an exact list of two paths (`/api/v0/add`, `/api/v0/cat`).
- **`ipfs.encedo.com`** — the read gateway, and it is **deliberately public**.
  Knowing a CID is the capability: for a chat file the blob is ciphertext and the
  key travels in the envelope over the ratchet, never here.
- **`webui.ipfs.encedo.com`** — the management console, on a narrower IP list
  plus HTTP basic auth. It reaches the **full** admin API, on purpose, because a
  console that cannot call `files` or `config` is not a console. The IP list and
  the password are the only controls on that route, which is why the list is
  shorter than the RPC's.

This node is not only the chat store. It is also the **source of truth for
published content** — firmware and similar — which readers fetch by CID through
whatever gateway they happen to use, ours or ipfs.io or Cloudflare. That second
role is why it stays in the public network at all, and why announcing is tuned
rather than switched off; see step 4.

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
    # Kubo answers "I do not have it, and I am not allowed to look" with a 500.
    # For this store that is the ordinary end of a file's life rather than a
    # fault, so it is reported as what it is. ONLY 500 is mapped: 502 and 504
    # keep their meaning, which is that the node is not answering at all.
    proxy_intercept_errors on;
    error_page 500 = @gone;

    rewrite ^ /api/v0/cat?arg=$cid&offline=true break;
    proxy_pass https://rpc.ipfs.encedo.com;
}

# An expired file, said plainly. nginx cannot read the upstream body, so every
# 500 becomes this — acceptable because with `offline=true` there is essentially
# one way for cat to fail.
location @gone {
    internal;
    default_type application/json;
    return 404 '{"error":"expired"}';
}
```

### Five things here are not obvious, and each one cost a failed request

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

**`offline=true`, or an expired file hangs for fifty seconds.** Asked for a CID
the sweeper removed, the node does what IPFS nodes do: it goes looking for it on
the public network — a hunt for something we deleted on purpose — and blocks
until the proxy gives up. `Gateway.NoFetch` does not cover this, because that
setting governs the GATEWAY and `/f` comes in through the RPC. Measured on the
live node: 25 s and still going without the flag, 0.32 s with it.

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

**4. Announce ONLY what is pinned.** This node has two jobs that want opposite
settings, and the pin is what separates them.

It is the **source of truth for published content** — firmware among other
things — which is fetched by CID from whatever gateway the reader happens to
use: ours, ipfs.io, Cloudflare. That only works if the node **announces**.
A public gateway handed a CID asks the DHT who has it; with no provider record
there is no way to find this node, and the fetch times out. Our own gateway
would still answer, because it reads the local repository rather than the
network — which makes this failure look like "works for me" from the inside.

It is also the **short-lived store for chat files**, and there announcing is
what breaks the five-minute lease: a provider record invites foreign nodes to
fetch and cache a blob, and once a copy exists elsewhere, `files rm` plus
`repo gc` end *our* copy's life, not the file's.

The split is already built, so it costs nothing to use:

| content | how it arrives | pinned? | announced? |
|---|---|---|---|
| firmware, the node list, the WebUI | `ipfs add --pin=true` | yes | yes |
| chat files | `/f` → `add?pin=false&to-files=/ec/…` | no — an MFS entry keeps the blocks | no |

```bash
docker exec ipfs1 ipfs config --json Provide.Enabled true
docker exec ipfs1 ipfs config Provide.Strategy pinned
docker restart ipfs1 && sleep 30
docker exec ipfs1 ipfs stats provide
```

The strategies are `all`, `pinned`, `mfs` and `pinned+mfs`. **There is no
per-path selector** — `mfs` cannot be narrowed to `/ec` — which is why the pin,
and not the directory, carries the distinction.

### Verifying it, which is not the same as the command succeeding

Two checks that must give OPPOSITE answers. Either one alone proves nothing:

```bash
# published content: a THIRD-PARTY gateway must find it (-L: dweb.link and
# ipfs.io redirect to a subdomain gateway, and -I alone stops at the 301)
curl -sL -o /dev/null -w "%{http_code}\n" --max-time 60 https://ipfs.io/ipfs/<pinned-cid>

# a chat file, WITHIN its five minutes: unreachable from outside, ours serves it
curl -sL -o /dev/null -w "%{http_code}\n" --max-time 60 https://ipfs.io/ipfs/<file-cid>
curl -s  -o /dev/null -w "%{http_code}\n" https://onchato.com/f/<file-cid>
```

Get the file CID from the app: open it with `?debug=1` and read the
`file evidence` line the console prints on send.

If both gateway checks succeed, the strategy did not take. If both fail,
announcing is off altogether and published content is reachable only through
our own gateway.

**A restart opens a window in which published content is unreachable from
third-party gateways.** Announcing happens after the daemon comes up, not
during it, so `Total CIDs provided: 0` right after a restart is normal and
means exactly what it says: nothing has been published yet, and a public
gateway asked for a pinned CID in that window gets a timeout. Measured here as
a 504 followed by a 200 on the retry a few seconds later. Our own gateway
serves throughout, reading the local repository, so **the outage is invisible
from inside the deployment** — worth knowing before shipping a firmware URL
minutes after a restart.

Once a public gateway has served a CID it caches it, so that CID stops being a
usable probe: it will answer 200 afterwards whatever the DHT knows. Test with
something that has never been fetched.

### Three ways this lies to you

**`ipfs config show` prints only what is explicitly set.** An empty grep for
`Provide` or `Reprovider` means "running on defaults", not "disabled" — the same
reason `Routing.Type` answers "not found" on a node that is very much routing.
Read the behaviour, not the config.

**`ipfs config` accepts any key name you give it**, including a misspelt or
obsolete one. It writes it, the daemon ignores it, and the command reports
success. The announcing config moved from `Reprovider.*` to `Provide.*` between
releases, so this is a live trap rather than a hypothetical: on 0.42 the section
is `Provide`, and if a change appears to do nothing, suspect the key name before
suspecting the daemon.

**`ipfs stats provide` is the ground truth.** With announcing off it does not
return zero — it fails with `stats not available with current routing system
*node.NoopProvider`, the provider having been replaced by a stub. That error IS
the confirmation. With `pinned` it works again and `CIDs scheduled` reflects the
pinned set: on this deployment it fell from 2,178 under the default to the
handful that are actually pinned.

**Records already published expire on their own**, on the order of a day, so a
change to any of this is not retroactive.

### What not to do

`Routing.Type=none`, dropping the bootstrap peers, or a private swarm key would
each cut the node off from the public network. For a node that only ever served
its own users that would be tidy; for one that is the source of truth for
firmware it removes the reason it exists. Leave it in the swarm.

`Gateway.NoFetch=true` is correct and unrelated: it stops the GATEWAY pulling
foreign content on request — which is what made disk disappear when this ran as
a public gateway — while leaving bitswap able to fetch, which is how the WebUI
was installed with `ipfs pin add`.

The read gateway `ipfs.encedo.com` is public and unauthenticated **by design**:
knowing the CID is the capability. For published content that is the point. For
chat files it is acceptable because the CID only ever travels inside an
authenticated envelope and the bytes are useless without a key that never
reaches this machine.

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

---

# Auto-deploy: the host builds a release tag by itself

`deploy-on-tag.sh` + a systemd timer on the web host. Every five minutes the
host fetches, and when the tip of `main` carries a `v*` tag it has not built, it
builds it. Nothing outside the machine holds a credential to it.

**Why this way round.** The other shape is a GitHub Actions job that ssh's in.
It is easier to write and it puts a key to production inside a runner — anyone
who compromises the runner, or a workflow the runner trusts, gets a shell here.
Pulling costs one timer interval of latency and nothing else.

**What triggers it: a tag on the tip, nothing else.** `main` moves for reasons
that are not releases. ⚠️ So tag the commit you want live and push both — a tag
left behind the tip is never seen, because the check is "is HEAD tagged", not
"is there a newer tag". The tree stays on `main`: checking the tag out would
leave a detached HEAD, and the next person running the documented `git pull` by
hand would be told they are not on a branch, by a timer they did not know about.

**What it will not do.** It does not touch the relay. That is a live service
with connected clients and its own deploy in `CLAUDE.md`; a timer restarting it
silently would make every release a small outage nobody chose.

**A failed build is not recorded**, so the next tick tries again — the state
file is written last, and only after the build's output has been checked to
exist. "It deployed" is a fact in the journal with the bundle hash in it, not an
impression:

    deployed v0.3.16 — bundle app.2b7a751e….bundle.js -> app.31b9c3d4….bundle.js

Install (once, as root on the web host):

```bash
cd /opt/github/encedo-chat && git pull            # brings the script itself
install -m 755 infra/deploy-on-tag.sh /opt/github/encedo-chat/infra/deploy-on-tag.sh
cp infra/onchato-deploy.service infra/onchato-deploy.timer /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now onchato-deploy.timer

# prove it, without waiting for a tick:
systemctl start onchato-deploy.service
journalctl -t onchato-deploy -n 20 --no-pager
systemctl list-timers onchato-deploy.timer
```

To pin the deploy to a release you have not cut yet, or to redo one:

```bash
rm /var/lib/onchato-deployed-tag        # next tick rebuilds the current tag
systemctl stop onchato-deploy.timer     # and this is the off switch
```

The paths (`REPO`, `STATE`, `LOCK`) are environment variables with the
production values as defaults, which is what makes the script testable off the
host — the whole flow was exercised against a synthetic repository and a stub
`npm`: a new tag builds, the same tag does nothing, a failed build leaves the
state alone and retries, and a second instance stands down on the lock.
