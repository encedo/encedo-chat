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
  const cidrs = []
  for (const [list, v, bits] of [[v4, 4, V4_BITS], [v6, 6, V6_BITS]]) {
    for (const [a, b] of mergeRanges(list)) for (const [n, p] of rangeToCidrs(a, b, bits)) cidrs.push(`${formatIp(v, n)}/${p}`)
  }
  return { cidrs, per, rows }
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
