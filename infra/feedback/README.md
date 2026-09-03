# feedback — where the in-app form lands

The app's **💬 Feedback** button (web, desktop and Android alike) POSTs one small
JSON document to `https://onchato.com/feedback`. `feedback.mjs` appends it to a
JSONL file and answers `{ok:true,id}`. There is nothing else to it, on purpose:
no account, no session, no database — a demo-day tester should be able to say
"the button did nothing" in under ten seconds, and nothing should stand in the
way of that.

## What a record holds — and what it never does

```json
{"id":"3f9a1c2b7d4e","ts":"2026-09-03T10:12:44.120Z","kind":"bug",
 "text":"…","contact":"optional","lang":"pl",
 "app":{"version":"0.5.39","commit":"abc1234","shell":"desktop","update":"self",
        "ua":"Mozilla/5.0 …","screen":"1280x800"},
 "diag":"platform: …  (the Settings › Diagnostics report, if the sender left it on)"}
```

Nothing about the sender's identity, keys, contacts or conversations is ever
sent — the form shows the exact document before it goes. The client address is
**not** stored: nginx does not forward it (no `X-Real-IP`), so the service has
no way to. The access log nginx keeps anyway is the only place an IP exists,
and the form says so.

## Running it on the host

```bash
sudo cp infra/feedback/onchato-feedback.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now onchato-feedback
journalctl -u onchato-feedback -n 5 --no-pager     # 📮 … on http://127.0.0.1:9201/feedback → /var/lib/onchato/feedback.jsonl
```

`StateDirectory=onchato` makes systemd create `/var/lib/onchato` owned by
`www-data`, so no `mkdir`/`chown` by hand. Then the nginx block (`location =
/feedback` in `infra/nginx/onchato.com` — CORS for the packaged apps, a per-IP
rate limit, a 32 KB body cap) goes out the usual way: `scp` to
`sites-available`, `nginx -t`, reload.

Smoke test from anywhere:

```bash
curl -s https://onchato.com/feedback -H 'content-type: application/json' \
  -d '{"kind":"question","text":"ping from curl","app":{"version":"test"}}'
# → {"ok":true,"id":"…"}
```

## Reading it

```bash
tail -f /var/lib/onchato/feedback.jsonl
jq -r '"\(.ts) [\(.kind)] \(.app.version) \(.app.shell) — \(.text)"' /var/lib/onchato/feedback.jsonl
jq -r 'select(.contact) | "\(.contact): \(.text)"' /var/lib/onchato/feedback.jsonl   # the ones that want a reply
```

Importing into SQLite later is one line when the file gets long enough to want
it (`sqlite3 fb.db ".import --csv …"` after a `jq -r @csv`), which is why it
starts as a file and not as a database.
