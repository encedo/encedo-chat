# fput — eight bytes between the upload and the store

`POST /f` accepts a file from anyone and that is how it should stay: an authenticated
upload would know who sent what and when, which is exactly what the rest of the
product avoids. This service does not change that decision — it changes **what can
be pulled out of the store**.

## What it does

It prepends eight bytes (`ECF1` + version + reserve, `impl/lib/fileenvelope.ts`) to
the start of every upload before it reaches Kubo. Nobody strips them along the way
— neither `/f` nor the public gateway. Only the client strips them, when decrypting.

**What goes in is not what comes out.** The store no longer hands back anything
1:1, so it cannot be used as file hosting, and a browser gets
`application/octet-stream` from the gateway instead of a page: Kubo detects the
type from the first bytes, and those are binary. Verified on a live upload —
`<!doctype html>` comes back as `text/html`, `ECF1…<!doctype html>` as
`application/octet-stream`.

## What it does not do

**It does not refuse.** Anyone who knows our format can still park 128 MB here for
five minutes, and without authentication that cannot be told apart from our
ciphertext. What goes away is a concrete harm: a clickable page under our domain,
and after it Safe Browsing, after which the app opens for nobody. What remains is
a locker for bytes that nobody will open either as a page or as a program.

## How it is wired

    client -> nginx `location = /f` -> 127.0.0.1:9202 -> rpc.ipfs.encedo.com /api/v0/add

nginx stays the edge: rate limits, `limit_conn`, CORS, `limit_except`,
`client_max_body_size 128m` and **`proxy_request_buffering off`**. Without the last
one nginx writes the whole body to a temporary file before the service sees anything.

Moved here from nginx: the entry name in the sweeper's ledger
(`/ec/<epoch>-<unique>` — an entry outside this scheme **never expires**, and
`ipfs-ttl.sh` will not report it as an error), `pin=false`, and `User-Agent:
encedo-proxy`, because Kubo rejects headers starting with "Mozilla".

`GET /f/<cid>` **does not go through this service** — it is still nginx straight to
Kubo. All downloading bypasses Node, and the prefix stays in place anyway.

## Running and checking

    node fput.mjs                              # 127.0.0.1:9202
    IPFS_RPC=http://127.0.0.1:5001 node fput.mjs
    node --test *.test.mjs                     # offline, against a fake Kubo

After deploying, two checks that must give OPPOSITE answers:

    # a foreign page: goes in, but the gateway refuses to render it
    C=$(curl -s -F file=@evil.html https://onchato.com/f | grep -o '"Hash":"[^"]*"' | cut -d'"' -f4)
    curl -sI https://ipfs.encedo.com/ipfs/$C | grep -i content-type   # must be octet-stream

    # our file: uploads and opens in the app, and disappears after the TTL
    docker exec ipfs1 ipfs files ls /ec | tail -3

## A note for anyone changing this

Nothing here may be read "in full". A single `await req.text()` or any ready-made
multipart parser and 128 MB lands in memory or on disk — and that is the only
reason this file is written as a stream.
