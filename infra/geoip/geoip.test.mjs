// node --test infra/geoip/
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseIp, formatIp, rangeToCidrs, mergeRanges, buildBlockList, makeMatcher, parseCountries } from './geoip.mjs'

const cidrs = (a, b) => { const A = parseIp(a), B = parseIp(b); return rangeToCidrs(A.n, B.n, A.v === 4 ? 32 : 128).map(([n, p]) => `${formatIp(A.v, n)}/${p}`) }

test('addresses round-trip, both families', () => {
  for (const s of ['0.0.0.0', '1.2.3.4', '255.255.255.255', '::', '::1', '2001:db8::', '2a03:ec41:0:9::cf', '1:2:3:4:5:6:7:8']) assert.equal(formatIp(parseIp(s).v, parseIp(s).n), s)
  assert.deepEqual(parseIp('::ffff:1.2.3.4'), parseIp('1.2.3.4'), 'a v4-mapped address is the v4 address')
  for (const bad of ['1.2.3', '1.2.3.256', '1::2::3', 'g::1', 'abc', '']) assert.equal(parseIp(bad), null, bad)
})

test('a range becomes the fewest CIDRs that cover exactly it', () => {
  assert.deepEqual(cidrs('1.0.0.0', '1.0.3.255'), ['1.0.0.0/22'])
  assert.deepEqual(cidrs('1.0.0.1', '1.0.0.2'), ['1.0.0.1/32', '1.0.0.2/32'])
  assert.deepEqual(cidrs('10.0.0.0', '10.0.1.127'), ['10.0.0.0/24', '10.0.1.0/25'])
  assert.deepEqual(cidrs('0.0.0.0', '255.255.255.255'), ['0.0.0.0/0'])
  assert.deepEqual(cidrs('2001:db8::', '2001:db8:0:1:ffff:ffff:ffff:ffff'), ['2001:db8::/63'])
})

test('touching and overlapping ranges merge, separate ones do not', () => {
  assert.deepEqual(mergeRanges([[5n, 9n], [1n, 4n], [20n, 30n], [8n, 12n]]), [[1n, 12n], [20n, 30n]])
})

const CSV = [
  '1.0.0.0,1.0.0.255,AU', '5.160.0.0,5.160.255.255,IR', '5.161.0.0,5.161.255.255,IR', '77.88.0.0,77.88.63.255,RU',
  '8.8.8.0,8.8.8.255,US', '2a02:6b8::,2a02:6b8:ffff:ffff:ffff:ffff:ffff:ffff,RU', '2001:4860::,2001:4860:ffff:ffff:ffff:ffff:ffff:ffff,US',
].join('\n')

test('only the listed countries are kept, and each one is counted', () => {
  const r = buildBlockList(CSV, ['ir', 'RU'])
  assert.deepEqual(r.per, { IR: 2, RU: 2 })
  assert.equal(r.rows, 7)
  assert.ok(r.cidrs.includes('5.160.0.0/15'), 'two adjacent Iranian /16s merge into a /15')
  assert.ok(r.cidrs.includes('2a02:6b8::/32'))
  assert.ok(!r.cidrs.some((c) => c.startsWith('8.8.') || c.startsWith('1.0.') || c.startsWith('2001:4860')), 'nobody else')
})

test('the matcher blocks listed addresses and nothing else', () => {
  const m = makeMatcher(['# comment', '', ...buildBlockList(CSV, ['IR', 'RU']).cidrs])
  for (const ip of ['5.160.0.1', '5.161.255.255', '77.88.8.8', '::ffff:77.88.8.8', '2a02:6b8::1']) assert.equal(m(ip), true, ip)
  for (const ip of ['5.159.255.255', '5.162.0.0', '8.8.8.8', '1.0.0.1', '2001:4860::8888', 'not-an-ip']) assert.equal(m(ip), false, ip)
})

test('the country file takes comments and either layout', () => {
  assert.deepEqual(parseCountries('KP  # North Korea\nir\n# all of it\nRU BY'), ['KP', 'IR', 'RU', 'BY'])
})

import { parseAbuseList, parseAbuseEntry, asnRanges, buildAbuse } from './geoip.mjs'

test('the abuse list: entries, until=, comments; a typo is an error, never a skip', () => {
  const p = parseAbuseList([
    '# header', '', '203.0.113.7   # one address', '203.0.113.200/24  until=2026-10-10  # host bits: means .0/24',
    '2001:db8::/48 until=2026-10-09 # expired yesterday', 'as64500  # lower case is fine', '10.0.0.0/4', 'foo', '1.2.3.4 untl=2026-01-01',
  ].join('\n'), '2026-10-10')
  assert.deepEqual(p.active.map((e) => e.text), ['203.0.113.7/32', '203.0.113.0/24', 'AS64500'])
  assert.equal(p.active[1].until, '2026-10-10', 'until is inclusive: still active on that day')
  assert.deepEqual(p.expired.map((e) => e.text), ['2001:db8::/48'])
  assert.deepEqual(p.invalid.map((b) => b.line), [7, 8, 9])
  assert.match(p.invalid[0].why, /continent/, 'a too-short prefix says why, and points at ASnnn')
  assert.match(p.invalid[2].why, /untl=/)
})

test('an entry is an address, a CIDR not shorter than /8 or /16, or ASnnn', () => {
  assert.equal(parseAbuseEntry('8.0.0.0/8').text, '8.0.0.0/8')
  assert.equal(parseAbuseEntry('7.0.0.0/7'), null)
  assert.equal(parseAbuseEntry('2001::/16').text, '2001::/16')
  assert.equal(parseAbuseEntry('2001::/15'), null)
  assert.equal(parseAbuseEntry('1.2.3.4/33'), null)
  assert.equal(parseAbuseEntry('AS0'), null)
  assert.deepEqual(parseAbuseEntry('AS37963'), { kind: 'asn', asn: 37963, text: 'AS37963' })
})

const ASN_CSV = [
  '1.0.0.0,1.0.0.255,13335,"Cloudflare, Inc."', '8.128.4.0,8.128.7.255,37963,"Hangzhou Alibaba Advertising Co.,Ltd."',
  '8.128.8.0,8.128.11.255,37963,"Hangzhou Alibaba Advertising Co.,Ltd."', '2400:3200::,2400:3200:ffff:ffff:ffff:ffff:ffff:ffff,37963,Alibaba',
].join('\n')

test('ASnnn becomes the ranges that operator announces (quoted names with commas included)', () => {
  const r = asnRanges(ASN_CSV, [37963, 99999])
  assert.deepEqual(r.per, { 37963: 3, 99999: 0 }, 'an AS with no ranges is visible - a typo would otherwise block nothing')
  const { cidrs } = buildAbuse(parseAbuseList('AS37963\n203.0.113.7', '2026-10-10'), ASN_CSV)
  assert.deepEqual(cidrs, ['8.128.4.0/22', '8.128.8.0/22', '203.0.113.7/32', '2400:3200::/32'], 'adjacent ranges merge (4.0-11.255 is two aligned /22s); nothing of Cloudflare')
  const m = makeMatcher(cidrs)
  assert.equal(m('8.128.9.9'), true); assert.equal(m('1.0.0.1'), false)
  assert.throws(() => buildAbuse(parseAbuseList('AS37963', '2026-10-10')), /ASN database/, 'AS entries without the database fail loudly')
})
