# nginx — the site config, in the repository

`onchato.com` is the whole `sites-available` file for the web host: the app, the
two store operations proxied to the IPFS RPC (`/f`), the relay's WebSocket and
the ACME challenge. It lived on one laptop and on the server, and the two could
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
scp infra/nginx/onchato.com <host>:/etc/nginx/sites-available/onchato.com
ssh <host> 'nginx -t && systemctl reload nginx'
```

⚠️ **`sites-enabled` holds a symlink to `sites-available`, and it must stay a
symlink.** A copy there is the trap this deployment has already fallen into: two
files, one edited, one served, and no error anywhere.

```bash
ssh <host> 'ls -l /etc/nginx/sites-enabled/'   # -> onchato.com -> ../sites-available/onchato.com
```

## The relay nodes (bs2, bs3, …) — two more files

A relay-only box does not get a copy of `onchato.com`; it gets
`relay-node.conf`, a **template** (`__HOST__` → the node's name, rendered with
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
* **`/f` answers CORS.** The web app is same-origin with the store and does not
  need it; the packaged desktop and Android builds load from `tauri://localhost`
  and do. Without those headers nginx answers correctly and the webview throws
  the answer away, which reads in the app as "files do not work".

## The favicon is NOT here

It is `impl/web/favicon.ico`, copied into `dist/` by the build. The web root is
`dist/`, and the build CLEANS that directory, so anything placed there by hand
survives until the next deploy and no longer — which is the kind of bug that
gets rediscovered every few months.
