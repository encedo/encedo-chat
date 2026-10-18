# nginx — the site config, in the repository

`onchato.com` is the whole site file of the web host (bs1): the landing and the
app, the file store's `/f` (upload through `onchato-fput`, download straight to
the IPFS RPC — `infra/README.md`), `/feedback`, the relay's WebSocket and the
ACME challenge. It lived on one laptop and on the server, and the two could
only be compared by reading them side by side — which is how a config gains a
change nobody remembers making.

It carries **no secrets**: certificate PATHS, not certificates, and no
credentials of any kind. That is what makes it safe to keep here, and it is
worth re-checking before every commit rather than assuming.

## Deploying it

Deliberately by hand, and deliberately NOT by the deploy timer. Reloading a
proxy from a poller means a config mistake takes the site down at whatever hour
the mistake was pushed; `nginx -t` catches syntax and cannot catch a wrong
`proxy_pass`. So a person does this, having read the diff:

```bash
scp infra/nginx/onchato.com <host>:/tmp/onchato.com
ssh <host> 'sudo cp /tmp/onchato.com /etc/nginx/sites-enabled/onchato.com &&
            sudo cp /tmp/onchato.com /etc/nginx/sites-available/onchato.com &&
            sudo nginx -t && sudo systemctl reload nginx'
ssh <host> 'sudo nginx -T | grep -c "<a line only the new version has>"'   # did it land?
```

⚠️ **On bs1 `sites-enabled/onchato.com` is a plain FILE, not a symlink, and it
is the one nginx serves.** `sites-available/onchato.com` is a second plain file
that once fell behind and, compared with the repo, showed 214 phantom
differences. So: compare against and edit `sites-enabled`, and write both, so
that neither lies. Copying to `sites-available` alone changes nothing and
`nginx -t` still says "ok", because the old file is valid. The `nginx -T` grep
is the only check that proves what is loaded.

Two more traps on the same host:

- **Backups never go in `sites-enabled/`.** Everything there is globbed, so a
  `onchato.com.bak` beside the file is loaded too, binds every limit zone a
  second time and fails `nginx -t` (`"relay_conn" is already bound`). Keep
  copies outside — on bs1 in `/root/nginx-backup/`.
- **Changing the KEY of an existing `limit_*_zone` needs `systemctl restart
  nginx`, not `reload`.** The reload refuses with an `[emerg]` that lands only
  in `error.log`, and nginx carries on with the old config while the command
  reports nothing. `grep emerg /var/log/nginx/error.log` after every reload
  that touches a zone, and the same when reverting one.

## The relay nodes (bs2, bs3, …) — two more files

A relay-only box does not get a copy of `onchato.com`; it gets
`relay-node.conf`, a **template** (`__HOST__` → the node's name, `__HOME__` → the
operator's home page, rendered with
`sed`, symlinked into `sites-enabled` under the hostname), plus
`relay-limits.conf` in `/etc/nginx/conf.d/` for the two per-IP zones the site
uses — those are http-level directives and cannot live in a site file. On the
web host the same zones sit at the top of `onchato.com`, so `relay-limits.conf`
must **not** be installed there (nginx: `"relay_conn" is already bound`).

The `/relay` block is the same in both files on purpose — the timeouts, the
limits and `X-Real-IP` are what a node needs regardless of what else the box
serves. Change it in one, change it in the other. The step-by-step that uses
the template is `relay/DEPLOY.md`.

## Two things in there that look wrong and are not

* **The redirect to HTTPS is inside `location /`, not at server level.** A
  `return` on the server runs in the rewrite phase, BEFORE nginx picks a
  location — so it swallows the ACME challenge block and certbot renewals fail
  with "unauthorized" and nothing about a redirect.
* **`/f` answers CORS.** Every client is cross-origin to it: the web app has
  its own origin, `app.onchato.com`, since 0.7.0, and the packaged desktop and
  Android builds load from `tauri://localhost`. Without those headers nginx
  answers correctly and the webview throws the answer away, which reads in the
  app as "files do not work"; the download also needs CORP, because the web app
  runs under COEP `require-corp`.

## The favicon is NOT here

It is `impl/web/favicon.ico`, copied into `dist/` by the build. The web root is
`dist/`, and the build CLEANS that directory, so anything placed there by hand
survives until the next deploy and no longer — which is the kind of bug that
gets rediscovered every few months.
