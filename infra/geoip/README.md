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

Tests: `node --test infra/geoip/geoip.test.mjs`, `impl/test/stun.test.ts`,
`impl/test/regioncheck.test.ts`.
