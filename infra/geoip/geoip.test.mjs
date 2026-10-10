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
