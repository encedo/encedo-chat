# infra/geoip — the sanctions block list

onchato is not provided in the countries listed in `blocked-countries`
(RKV policy, 2026-10-10; the reasoning is in the operator note `GEOBLOKADA.md`,
outside the repo). Every node refuses them on every path:

| piece | what it does |
|---|---|
| `blocked-countries` | the list — the ONE place it lives |
| `geoip.mjs` | CSV -> CIDRs (IPv4 + IPv6, BigInt), and the matcher STUN uses; zero deps |
| `geoip-update.mjs` | downloads DB-IP Country Lite (CC BY 4.0), checks it, swaps two files atomically, `nginx -t`, reload |
| `onchato-geoip.service` / `.timer` | weekly (+ 10 min after boot) |
| `unavailable.html` | the page behind HTTP 451, in EN/ES/RU/FA/AR/KO/PL, self-contained |
| `../nginx/onchato-geo.conf` | `geo` block -> `$onchato_geo_deny` (conf.d, http level) |
| `../nginx/onchato-geoblock.conf` | `include snippets/onchato-geoblock.conf;` in each onchato `server` on 443 |
| `../stun/stun.mjs` | reads `/var/lib/onchato/geoip/blocked-cidrs.txt`, no answer to listed addresses |
| `impl/lib/regioncheck.ts` | the app and the CLI ask a node's `/health`; a 451 shows "not available in your region" |

Files on a node: `/etc/nginx/onchato-geo-blocked.conf` (nginx list),
`/var/lib/onchato/geoip/blocked-cidrs.txt` (STUN list),
`/var/www/onchato-geo/__onchato_unavailable.html`. `bs-setup.sh` installs all of
it (step 7b) and `--check` verifies it.

Two things learnt the hard way (2026-10-10): the error page is an internal
redirect that runs the server-level `if` again, and nginx caches a `map` for the
whole request — so the test is `$onchato_geo_deny` from two `volatile` maps, or
the page 451s itself and nginx answers a bare 451 without body or CORS.

A failed download or a list that looks wrong (too few rows, a country with no
ranges) leaves the PREVIOUS lists in place and fails the unit
(`journalctl -u onchato-geoip`). Change the country list: edit
`blocked-countries`, pull, `sudo node infra/geoip/geoip-update.mjs` on each node.

## The abuse list

Separate from the sanctions: addresses, networks and whole operators that
abused the service (terms, section 4). nginx drops them with **444** (no page,
checked BEFORE the 451), STUN does not answer.

- Kept on the operator's machine, NOT in the repo (addresses are personal data):
  `~/.config/onchato-ops/abuse.list` (`$ONCHATO_ABUSE_LIST`), and on each node
  as `/etc/onchato/abuse.list` (600).
- Maintained with `infra/geoip/onchato-block` (link it into `~/.local/bin`):
  ```
  onchato-block add 203.0.113.0/24 --days 30 handshake flood on /relay
  onchato-block add AS64500 scanning /f for a week
  onchato-block del 203.0.113.0/24
  onchato-block list | push | status
  ```
  Entries: address, CIDR (not shorter than /8 / /16 - a whole operator goes in
  as ASnnn), or ASnnn (DB-IP ASN Lite, cached per month, fetched only when the
  list has one); `--days N` / `--until YYYY-MM-DD` make it temporary.
  Every change is checked (`abuse-check.mjs`) before it is saved, and each node
  checks again: a line that does not parse keeps the previous list.
- `onchato-abuse.timer` rebuilds daily (00:10 UTC) so `until=` entries stop.
- Node files: `/etc/nginx/onchato-abuse-blocked.conf` (`$onchato_abuse`),
  `/var/lib/onchato/geoip/abuse-cidrs.txt` (STUN reads both lists).

Tests: `node --test infra/geoip/geoip.test.mjs`, `impl/test/stun.test.ts`,
`impl/test/regioncheck.test.ts`. The nginx side was checked in a container:
abuse -> connection dropped (also when the address is on both lists), sanctions
only -> 451, neither -> 200.
