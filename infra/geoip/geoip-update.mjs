#!/usr/bin/env node
// geoip-update.mjs - refresh the block lists on a node (GEOBLOKADA.md).
//
//   node infra/geoip/geoip-update.mjs                 # countries + abuse list, nginx -t, reload
//   node infra/geoip/geoip-update.mjs --abuse-only    # only the abuse list (onchato-block push, the daily timer)
//   node infra/geoip/geoip-update.mjs --csv f.csv.gz  # countries from a local file (tests, offline)
//   node infra/geoip/geoip-update.mjs --dry           # build and report, write nothing
//
// Two lists, two answers:
//
// COUNTRIES (sanctions) - DB-IP "IP to Country Lite" (CC BY 4.0) for this month,
//   or the last one early in a month; the countries in infra/geoip/blocked-countries.
//   -> NGINX_OUT (geo $onchato_geo_blocked: 451 with a page) and STUN_OUT.
//
// ABUSE - /etc/onchato/abuse.list, kept OUTSIDE the repo (addresses are personal
//   data; the list is operational): addresses, CIDRs, ASnnn, `until=` dates,
//   maintained from the operator's machine with onchato-block. ASnnn entries
//   resolve through DB-IP ASN Lite (CC BY 4.0), cached per month and fetched only
//   when the list has one.
//   -> ABUSE_NGINX (geo $onchato_abuse: 444, connection dropped) and ABUSE_STUN.
//
// Each list fails on its own: a download, a sanity check or a line that does not
// parse leaves THAT list's previous files in place - never an empty one - and the
// run exits non-zero so the timer shows it. If `nginx -t` rejects a new list, the
// previous one is put back. Zero dependencies: Node's fetch and zlib.

import { readFileSync, writeFileSync, renameSync, existsSync, copyFileSync, mkdirSync, readdirSync, unlinkSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { gunzipSync } from 'node:zlib'
import { execFileSync, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { buildBlockList, parseCountries, parseAbuseList, buildAbuse } from './geoip.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const argv = process.argv.slice(2)
const opt = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d }
const has = (k) => argv.includes(k)

const COUNTRIES = opt('--countries', join(HERE, 'blocked-countries'))
const NGINX_OUT = opt('--nginx-out', '/etc/nginx/onchato-geo-blocked.conf')
const STUN_OUT = opt('--stun-out', '/var/lib/onchato/geoip/blocked-cidrs.txt')
const ABUSE_LIST = opt('--abuse-list', '/etc/onchato/abuse.list')
const ABUSE_NGINX = opt('--abuse-nginx-out', '/etc/nginx/onchato-abuse-blocked.conf')
const ABUSE_STUN = opt('--abuse-stun-out', '/var/lib/onchato/geoip/abuse-cidrs.txt')
const CACHE = opt('--cache', '/var/lib/onchato/geoip')
const DRY = has('--dry'), NO_RELOAD = has('--no-reload'), ABUSE_ONLY = has('--abuse-only')
// A node without nginx (bs-setup.sh --no-cert) still runs STUN: build its lists,
// skip the nginx ones rather than fail on a missing binary.
const HAVE_NGINX = has('--nginx-out') || has('--abuse-nginx-out') || spawnSync('nginx', ['-v'], { stdio: 'ignore' }).status === 0
// Below these the download is broken, not the world changed: the country file
// has ~700k rows, the ASN file ~470k, and every listed country has had ranges
// since DB-IP began.
const MIN_ROWS = 300_000, MIN_ASN_ROWS = 200_000
const TODAY = new Date().toISOString().slice(0, 10)

const say = (m) => console.log(`[geoip] ${m}`)
let failed = 0
const fail = (m) => { console.error(`[geoip] ERROR: ${m}`); failed++ }

function months() {
  const now = new Date()
  return [0, 1].map((back) => {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - back, 1))
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`
  })
}

/** The DB-IP file `kind` (country-lite | asn-lite): this month, else last month. */
async function download(kind) {
  for (const m of months()) {
    const url = `https://download.db-ip.com/free/dbip-${kind}-${m}.csv.gz`
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(180_000) })
      if (!r.ok) { say(`${kind} ${m}: HTTP ${r.status}`); continue }
      const gz = Buffer.from(await r.arrayBuffer())
      say(`${kind} ${m}: ${gz.length} B`)
      return { gz, month: m }
    } catch (e) { say(`${kind} ${m}: ${e?.message ?? e}`) }
  }
  return null
}

/** ASN Lite, cached per month in CACHE (7 MB; only fetched when the list has ASnnn). */
async function asnCsv() {
  mkdirSync(CACHE, { recursive: true })
  for (const m of months()) {
    const f = join(CACHE, `dbip-asn-lite-${m}.csv.gz`)
    if (existsSync(f)) return { csv: gunzipSync(readFileSync(f)).toString('utf8'), source: `DB-IP ASN Lite ${m} (cached)` }
  }
  const got = await download('asn-lite')
  if (got) {
    const f = join(CACHE, `dbip-asn-lite-${got.month}.csv.gz`)
    if (!DRY) {
      writeFileSync(f, got.gz)
      for (const old of readdirSync(CACHE)) if (/^dbip-asn-lite-.*\.csv\.gz$/.test(old) && join(CACHE, old) !== f) unlinkSync(join(CACHE, old))
    }
    return { csv: gunzipSync(got.gz).toString('utf8'), source: `DB-IP ASN Lite ${got.month}` }
  }
  // Nothing new reachable: an older cached file still beats dropping the AS entries.
  const any = readdirSync(CACHE).filter((f) => /^dbip-asn-lite-.*\.csv\.gz$/.test(f)).sort().pop()
  if (any) return { csv: gunzipSync(readFileSync(join(CACHE, any))).toString('utf8'), source: `DB-IP ASN Lite (cached ${any})` }
  return null
}

function writeAtomic(path, text) {
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.new`
  writeFileSync(tmp, text, { mode: 0o644 })
  renameSync(tmp, path)
}

/** Write an nginx list; `nginx -t`, and put the previous file back if it fails. */
function writeNginx(path, text) {
  if (!HAVE_NGINX) return true
  const prev = existsSync(path) ? `${path}.prev` : null
  if (prev) copyFileSync(path, prev)
  writeAtomic(path, text)
  if (NO_RELOAD) return true
  try { execFileSync('nginx', ['-t'], { stdio: 'pipe' }); return true }
  catch (e) {
    if (prev) renameSync(prev, path)
    fail(`nginx -t rejected ${path} - the previous one is back: ${String(e.stderr ?? e).trim().split('\n').pop()}`)
    return false
  }
}

const header = (source, what) => `# ${source}, built ${new Date().toISOString()} - ${what}. IP Geolocation by DB-IP (https://db-ip.com), CC BY 4.0.\n`
let wrote = false

// ---- countries (sanctions) ---------------------------------------------------
async function countries() {
  const list = parseCountries(readFileSync(COUNTRIES, 'utf8'))
  if (!list.length) return fail(`no countries in ${COUNTRIES}`)
  let csv, source
  if (opt('--csv')) { const f = opt('--csv'); csv = (f.endsWith('.gz') ? gunzipSync(readFileSync(f)) : readFileSync(f)).toString('utf8'); source = f }
  else {
    const got = await download('country-lite')
    if (!got) return fail('no DB-IP country file could be downloaded - the previous country lists stay in place')
    csv = gunzipSync(got.gz).toString('utf8'); source = `DB-IP Country Lite ${got.month}`
  }
  const { cidrs, per, rows } = buildBlockList(csv, list)
  say(`countries: ${rows} rows; ${list.map((c) => `${c} ${per[c]}`).join(', ')} ranges -> ${cidrs.length} CIDRs`)
  if (rows < MIN_ROWS) return fail(`only ${rows} rows (expected > ${MIN_ROWS}) - refusing a truncated file`)
  const empty = list.filter((c) => !per[c])
  if (empty.length) return fail(`no ranges for ${empty.join(', ')} - refusing a list that silently stopped blocking`)
  if (DRY) return
  const head = header(source, `sanctions: ${list.join(' ')}`)
  if (!writeNginx(NGINX_OUT, head + cidrs.map((c) => `${c} 1;`).join('\n') + '\n')) return
  writeAtomic(STUN_OUT, head + cidrs.join('\n') + '\n') // after nginx: a refused list leaves STUN's old one too
  wrote = true
  say(`countries: wrote ${HAVE_NGINX ? `${NGINX_OUT} and ` : ''}${STUN_OUT}`)
}

// ---- the abuse list ----------------------------------------------------------
async function abuse() {
  const text = existsSync(ABUSE_LIST) ? readFileSync(ABUSE_LIST, 'utf8') : ''
  if (!existsSync(ABUSE_LIST)) say(`abuse: no ${ABUSE_LIST} - an empty list`)
  const parsed = parseAbuseList(text, TODAY)
  for (const b of parsed.invalid) console.error(`[geoip] abuse line ${b.line}: ${b.why}`)
  if (parsed.invalid.length) return fail(`${parsed.invalid.length} line(s) of ${ABUSE_LIST} do not parse - the previous abuse lists stay in place`)
  for (const e of parsed.expired) say(`abuse: expired ${e.text} (until ${e.until})${e.comment ? ` - ${e.comment}` : ''}`)
  let asn = null
  if (parsed.active.some((e) => e.kind === 'asn')) {
    asn = await asnCsv()
    if (!asn) return fail('the list has AS entries and no ASN database is reachable or cached - the previous abuse lists stay in place')
    const rows = asn.csv.split('\n').length
    if (rows < MIN_ASN_ROWS) return fail(`ASN file has only ${rows} rows - refusing it`)
  }
  const { cidrs, asnPer } = buildAbuse(parsed, asn?.csv)
  const none = Object.entries(asnPer).filter(([, n]) => !n).map(([a]) => `AS${a}`)
  if (none.length) say(`abuse: WARNING ${none.join(', ')} announce(s) no ranges in ${asn.source} - a typo?`)
  const nets = parsed.active.filter((e) => e.kind === 'net').length, asns = parsed.active.length - nets
  say(`abuse: ${parsed.active.length} active (${nets} address/network, ${asns} AS${asns ? `: ${Object.entries(asnPer).map(([a, n]) => `AS${a} ${n}`).join(', ')} ranges` : ''}), ${parsed.expired.length} expired -> ${cidrs.length} CIDRs`)
  if (DRY) return
  const head = header(asn?.source ?? 'abuse list', `abuse: ${parsed.active.length} entries from ${ABUSE_LIST}`)
  if (!writeNginx(ABUSE_NGINX, head + cidrs.map((c) => `${c} 1;`).join('\n') + '\n')) return
  writeAtomic(ABUSE_STUN, head + cidrs.join('\n') + '\n')
  wrote = true
  say(`abuse: wrote ${HAVE_NGINX ? `${ABUSE_NGINX} and ` : ''}${ABUSE_STUN}`)
}

if (!ABUSE_ONLY) await countries()
await abuse()
if (wrote && HAVE_NGINX && !NO_RELOAD) { execFileSync('systemctl', ['reload', 'nginx']); say('nginx reloaded') }
if (DRY) say('dry run: nothing written')
process.exit(failed ? 1 : 0)
