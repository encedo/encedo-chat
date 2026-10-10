// geoip.mjs - the country block list, shared by geoip-update.mjs (which builds it
// for nginx and STUN) and infra/stun/stun.mjs (which reads it). Zero dependencies.
//
// Input is DB-IP "IP to Country Lite" CSV (CC BY 4.0): `start,end,CC` per line,
// IPv4 and IPv6 ranges. Output is CIDRs, because nginx's `geo` module takes CIDRs
// for IPv6 (its `ranges` mode is IPv4 only). Everything is done in BigInt so one
// code path serves both families.

const V4_BITS = 32, V6_BITS = 128

/** Parse an IPv4 or IPv6 address to { v, n } (n a BigInt), or null. */
export function parseIp(s) {
  s = String(s).trim()
  if (s.startsWith('::ffff:') && s.includes('.')) s = s.slice(7) // v4-mapped from a dual-stack socket
  if (s.includes('.') && !s.includes(':')) {
    const p = s.split('.')
    if (p.length !== 4) return null
    let n = 0n
    for (const x of p) { const b = Number(x); if (!/^\d{1,3}$/.test(x) || b > 255) return null; n = (n << 8n) | BigInt(b) }
    return { v: 4, n }
  }
  if (!s.includes(':')) return null
  const zone = s.indexOf('%'); if (zone >= 0) s = s.slice(0, zone)
  const halves = s.split('::')
  if (halves.length > 2) return null
  const head = halves[0] ? halves[0].split(':') : [], tail = halves.length === 2 && halves[1] ? halves[1].split(':') : []
  const fill = halves.length === 2 ? 8 - head.length - tail.length : 0
  if (fill < 0 || (halves.length === 1 && head.length !== 8)) return null
  const groups = [...head, ...Array(fill).fill('0'), ...tail]
  let n = 0n
  for (const g of groups) { if (!/^[0-9a-fA-F]{1,4}$/.test(g)) return null; n = (n << 16n) | BigInt(parseInt(g, 16)) }
  return { v: 6, n }
}

/** Format { v, n } back to text (IPv6 compressed). */
export function formatIp(v, n) {
  if (v === 4) return [24n, 16n, 8n, 0n].map((s) => String((n >> s) & 255n)).join('.')
  const g = []; for (let i = 7; i >= 0; i--) g.push(Number((n >> BigInt(i * 16)) & 0xffffn).toString(16))
  // longest run of zero groups -> '::'
  let best = -1, len = 0
  for (let i = 0; i < 8;) { if (g[i] !== '0') { i++; continue } let j = i; while (j < 8 && g[j] === '0') j++; if (j - i > len && j - i > 1) { best = i; len = j - i } i = j }
  if (best < 0) return g.join(':')
  return `${g.slice(0, best).join(':')}::${g.slice(best + len).join(':')}`
}

/** The fewest CIDRs covering [start, end] inclusive, for a family of `bits`. */
export function rangeToCidrs(start, end, bits) {
  const out = []
  const B = BigInt(bits)
  while (start <= end) {
    // largest block aligned at `start` ...
    let size = start === 0n ? B : 0n
    if (start !== 0n) { let s = start; while ((s & 1n) === 0n && size < B) { s >>= 1n; size++ } }
    // ... that does not run past `end`
    while (size > 0n && start + (1n << size) - 1n > end) size--
    out.push([start, Number(B - size)])
    start += 1n << size
  }
  return out
}

/** Merge sorted or unsorted [start, end] intervals that touch or overlap. */
export function mergeRanges(list) {
  const s = list.slice().sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
  const out = []
  for (const [a, b] of s) {
    const last = out[out.length - 1]
    if (last && a <= last[1] + 1n) { if (b > last[1]) last[1] = b } else out.push([a, b])
  }
  return out
}

/**
 * From the CSV text and a set of country codes, the CIDR list (strings) and how
 * many ranges each country contributed - the second is the sanity check: a
 * country that suddenly has none means a broken download, not a peaceful world.
 */
export function buildBlockList(csv, countries) {
  const want = new Set(countries.map((c) => c.toUpperCase()))
  const per = Object.fromEntries([...want].map((c) => [c, 0]))
  const v4 = [], v6 = []
  let rows = 0
  for (const line of csv.split('\n')) {
    if (!line) continue
    rows++
    const i = line.lastIndexOf(','); if (i < 0) continue
    const cc = line.slice(i + 1).trim().replace(/"/g, '')
    if (!want.has(cc)) continue
    const j = line.indexOf(',')
    const a = parseIp(line.slice(0, j).replace(/"/g, '')), b = parseIp(line.slice(j + 1, i).replace(/"/g, ''))
    if (!a || !b || a.v !== b.v) continue
    ;(a.v === 4 ? v4 : v6).push([a.n, b.n])
    per[cc]++
  }
  return { cidrs: toCidrStrings(v4, v6), per, rows }
}

/** [start, end] BigInt ranges per family -> merged, minimal CIDR strings. */
export function toCidrStrings(v4, v6) {
  const cidrs = []
  for (const [list, v, bits] of [[v4, 4, V4_BITS], [v6, 6, V6_BITS]]) {
    for (const [a, b] of mergeRanges(list)) for (const [n, p] of rangeToCidrs(a, b, bits)) cidrs.push(`${formatIp(v, n)}/${p}`)
  }
  return cidrs
}

// ---- the abuse list (GEOBLOKADA.md, "Nadużycia") ---------------------------
//
// One entry per line, `#` starts a comment:
//   203.0.113.7                        a single address
//   203.0.113.0/24                     a network, IPv4 or IPv6
//   AS64500                            every range an operator announces (DB-IP ASN Lite)
//   ... until=2026-11-10               active up to and including that day (UTC), then ignored
// A line that does not parse is an error, never a skipped line: a typo must not
// silently leave somebody unblocked, or block somebody else.

/** Parse the abuse list. `today` is 'YYYY-MM-DD' (UTC). */
export function parseAbuseList(text, today) {
  const active = [], expired = [], invalid = []
  text.split('\n').forEach((raw, i) => {
    const line = raw.replace(/#.*/, '').trim()
    if (!line) return
    const comment = (raw.match(/#(.*)/)?.[1] ?? '').trim()
    const toks = line.split(/\s+/)
    let until = null
    const bad = (why) => invalid.push({ line: i + 1, raw: raw.trim(), why })
    const e = parseAbuseEntry(toks[0])
    const short = /\/(\d{1,3})$/.exec(toks[0])
    if (!e && short && parseIp(toks[0].split('/')[0]) && Number(short[1]) < (toks[0].includes(':') ? 16 : 8)) return bad(`"${toks[0]}": a prefix that short is a continent, not an abuser - a whole operator goes in as ASnnn`)
    if (!e) return bad(`"${toks[0]}" is not an address, a CIDR or ASnnn`)
    for (const t of toks.slice(1)) {
      const m = /^until=(\d{4}-\d{2}-\d{2})$/.exec(t)
      if (!m || isNaN(Date.parse(m[1] + 'T00:00:00Z'))) return bad(`unknown token "${t}" (only until=YYYY-MM-DD)`)
      until = m[1]
    }
    const entry = { ...e, until, comment, line: i + 1 }
    ;(until && until < today ? expired : active).push(entry)
  })
  return { active, expired, invalid }
}

/** One entry: { kind: 'net', v, start, end, text } or { kind: 'asn', asn, text }, or null. */
export function parseAbuseEntry(tok) {
  const as = /^AS(\d{1,10})$/i.exec(tok)
  if (as) { const asn = Number(as[1]); return asn > 0 && asn < 2 ** 32 ? { kind: 'asn', asn, text: `AS${asn}` } : null }
  const [ip, pfx, extra] = tok.split('/')
  if (extra !== undefined) return null
  const a = parseIp(ip); if (!a) return null
  const bits = a.v === 4 ? V4_BITS : V6_BITS
  if (pfx !== undefined && !/^\d{1,3}$/.test(pfx)) return null
  const p = pfx === undefined ? bits : Number(pfx)
  if (p < 0 || p > bits) return null
  // A prefix this short is a mistake, not an abuser: /8 of IPv4 is 16 million
  // addresses, /16 of IPv6 a continent. Whole operators go in as ASnnn.
  if (p < (a.v === 4 ? 8 : 16)) return null
  const span = 1n << BigInt(bits - p)
  const start = a.n - (a.n % span) // host bits off: 203.0.113.7/24 means 203.0.113.0/24
  return { kind: 'net', v: a.v, start, end: start + span - 1n, text: `${formatIp(a.v, start)}/${p}` }
}

/**
 * The ranges of the given ASNs from DB-IP ASN Lite CSV (`start,end,asn,"org"`),
 * and how many ranges each ASN contributed - an ASN with none is reported, since
 * a mistyped number would otherwise block nothing in silence.
 */
export function asnRanges(csv, asns) {
  const want = new Set(asns), per = Object.fromEntries([...want].map((a) => [a, 0]))
  const v4 = [], v6 = []
  for (const line of csv.split('\n')) {
    if (!line) continue
    const c1 = line.indexOf(','), c2 = line.indexOf(',', c1 + 1), c3 = line.indexOf(',', c2 + 1)
    if (c3 < 0) continue
    const asn = Number(line.slice(c2 + 1, c3))
    if (!want.has(asn)) continue
    const a = parseIp(line.slice(0, c1)), b = parseIp(line.slice(c1 + 1, c2))
    if (!a || !b || a.v !== b.v) continue
    ;(a.v === 4 ? v4 : v6).push([a.n, b.n])
    per[asn]++
  }
  return { v4, v6, per }
}

/** The abuse list's active entries (+ the ASN ranges) as CIDR strings. */
export function buildAbuse(parsed, asnCsv) {
  const v4 = [], v6 = []
  for (const e of parsed.active) if (e.kind === 'net') (e.v === 4 ? v4 : v6).push([e.start, e.end])
  const asns = parsed.active.filter((e) => e.kind === 'asn').map((e) => e.asn)
  let per = {}
  if (asns.length) {
    if (asnCsv == null) throw new Error('the list has AS entries but no ASN database was given')
    const r = asnRanges(asnCsv, asns); per = r.per
    v4.push(...r.v4); v6.push(...r.v6)
  }
  return { cidrs: toCidrStrings(v4, v6), asnPer: per }
}

/** A matcher over CIDR lines (comments and blanks ignored): addr -> boolean. */
export function makeMatcher(lines) {
  const fam = { 4: [], 6: [] }
  for (const raw of lines) {
    const l = raw.trim(); if (!l || l.startsWith('#')) continue
    const [ip, pfx] = l.split('/')
    const a = parseIp(ip); if (!a) continue
    const bits = a.v === 4 ? V4_BITS : V6_BITS
    const p = pfx === undefined ? bits : Number(pfx)
    const span = 1n << BigInt(bits - p)
    fam[a.v].push([a.n, a.n + span - 1n])
  }
  const m = { 4: mergeRanges(fam[4]), 6: mergeRanges(fam[6]) }
  const count = m[4].length + m[6].length
  const test = (addr) => {
    const a = parseIp(addr); if (!a) return false
    const r = m[a.v]; let lo = 0, hi = r.length - 1
    while (lo <= hi) {
      const mid = (lo + hi) >> 1
      if (a.n < r[mid][0]) hi = mid - 1
      else if (a.n > r[mid][1]) lo = mid + 1
      else return true
    }
    return false
  }
  test.count = count
  return test
}

/** The country list file: codes, one per line or space-separated, `#` comments. */
export function parseCountries(text) {
  return text.split('\n').map((l) => l.replace(/#.*/, '')).join(' ').split(/\s+/).filter(Boolean).map((c) => c.toUpperCase())
}
