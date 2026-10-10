#!/usr/bin/env node
// geoip-update.mjs - refresh the country block list on a node (GEOBLOKADA.md).
//
//   node infra/geoip/geoip-update.mjs                 # download, build, swap, nginx -t, reload
//   node infra/geoip/geoip-update.mjs --csv f.csv.gz  # build from a local file (tests, offline)
//   node infra/geoip/geoip-update.mjs --dry           # build and report, write nothing
//
// Downloads DB-IP "IP to Country Lite" (CC BY 4.0) for this month - or the last
// one, early in a month before the new file is up - keeps the countries listed in
// infra/geoip/blocked-countries, and writes two files atomically:
//   NGINX_OUT  `<cidr> 1;` lines for the `geo` block in /etc/nginx/conf.d/onchato-geo.conf
//   STUN_OUT   plain CIDRs for infra/stun/stun.mjs
// A download or a sanity check that fails leaves the PREVIOUS lists in place -
// never an empty one - and exits non-zero so the timer shows it failed. If
// `nginx -t` rejects the new list, the previous one is put back.
//
// Zero dependencies: Node's fetch and zlib.

import { readFileSync, writeFileSync, renameSync, existsSync, copyFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { gunzipSync } from 'node:zlib'
import { execFileSync, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { buildBlockList, parseCountries } from './geoip.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const argv = process.argv.slice(2)
const opt = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d }
const has = (k) => argv.includes(k)

const COUNTRIES = opt('--countries', join(HERE, 'blocked-countries'))
const NGINX_OUT = opt('--nginx-out', '/etc/nginx/onchato-geo-blocked.conf')
const STUN_OUT = opt('--stun-out', '/var/lib/onchato/geoip/blocked-cidrs.txt')
const DRY = has('--dry'), NO_RELOAD = has('--no-reload')
// A node without nginx (bs-setup.sh --no-cert) still runs STUN: build its list,
// skip the nginx one rather than fail on a missing binary.
const HAVE_NGINX = has('--nginx-out') || spawnSync('nginx', ['-v'], { stdio: 'ignore' }).status === 0
// Below these the download is broken, not the world changed: the full file has
// ~700k rows, and every listed country has had ranges since DB-IP began.
const MIN_ROWS = 300_000

const say = (m) => console.log(`[geoip] ${m}`)
const die = (m) => { console.error(`[geoip] ERROR: ${m}`); process.exit(1) }

async function download() {
  const now = new Date()
  const months = [0, 1].map((back) => {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - back, 1))
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`
  })
  for (const m of months) {
    const url = `https://download.db-ip.com/free/dbip-country-lite-${m}.csv.gz`
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(120_000) })
      if (!r.ok) { say(`${m}: HTTP ${r.status}`); continue }
      const gz = Buffer.from(await r.arrayBuffer())
      say(`${m}: ${gz.length} B from ${url}`)
      return { csv: gunzipSync(gz).toString('utf8'), source: `DB-IP Country Lite ${m}` }
    } catch (e) { say(`${m}: ${e?.message ?? e}`) }
  }
  die('no DB-IP file could be downloaded - the previous lists stay in place')
}

function writeAtomic(path, text) {
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.new`
  writeFileSync(tmp, text, { mode: 0o644 })
  renameSync(tmp, path)
}

const countries = parseCountries(readFileSync(COUNTRIES, 'utf8'))
if (!countries.length) die(`no countries in ${COUNTRIES}`)
const { csv, source } = opt('--csv') ? { csv: (opt('--csv').endsWith('.gz') ? gunzipSync(readFileSync(opt('--csv'))) : readFileSync(opt('--csv'))).toString('utf8'), source: opt('--csv') } : await download()
const { cidrs, per, rows } = buildBlockList(csv, countries)
say(`${rows} rows; ${countries.map((c) => `${c} ${per[c]}`).join(', ')} ranges -> ${cidrs.length} CIDRs`)
if (rows < MIN_ROWS) die(`only ${rows} rows (expected > ${MIN_ROWS}) - refusing a truncated file`)
const empty = countries.filter((c) => !per[c])
if (empty.length) die(`no ranges for ${empty.join(', ')} - refusing a list that silently stopped blocking`)
if (DRY) { say('dry run: nothing written'); process.exit(0) }

const stamp = `# ${source}, built ${new Date().toISOString()} for ${countries.join(' ')}. IP Geolocation by DB-IP (https://db-ip.com), CC BY 4.0.\n`
const prev = HAVE_NGINX && existsSync(NGINX_OUT) ? `${NGINX_OUT}.prev` : null
if (prev) copyFileSync(NGINX_OUT, prev)
if (HAVE_NGINX) writeAtomic(NGINX_OUT, stamp + cidrs.map((c) => `${c} 1;`).join('\n') + '\n')
else say('no nginx here: the STUN list only')

if (HAVE_NGINX && !NO_RELOAD) {
  try { execFileSync('nginx', ['-t'], { stdio: 'pipe' }) }
  catch (e) {
    if (prev) renameSync(prev, NGINX_OUT)
    die(`nginx -t rejected the new list - the previous one is back: ${String(e.stderr ?? e).trim().split('\n').pop()}`)
  }
  execFileSync('systemctl', ['reload', 'nginx'])
  say('nginx reloaded')
}
// STUN after nginx: if nginx refused the list, STUN keeps the old one too.
writeAtomic(STUN_OUT, stamp + cidrs.join('\n') + '\n')
say(`wrote ${HAVE_NGINX ? `${NGINX_OUT} and ` : ''}${STUN_OUT}`)
