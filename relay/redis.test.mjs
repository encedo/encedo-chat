/**
 * The Redis sink (`redis.mjs`): the bytes that go on the wire, and what a real
 * server makes of them.
 *
 * The encoding is pure and asserted directly - a protocol written by hand is
 * worth checking byte for byte. The end of it is checked against an actual
 * redis-server when the machine has one, because "the commands look right" and
 * "the hash holds the right numbers" are different claims.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { resp, commandsFor, bucketOf, parseUrl, redisSink, ADDITIVE, GAUGES } from './redis.mjs'

const SNAP = {
  at: '2026-09-09T18:30:00.000Z',
  window_s: 900, topics: 213, topics_added: 7, topics_evicted: 4, topics_refused: 0,
  msgs: 4812, bytes: 831488, max_bytes: 1240, publishers: 126,
  conns: 131, conns_up: 9, conns_down: 7,
  cpu_pct: 3.4, rss: 148897792, heap: 63963136, lag_ms: 12, uptime_s: 46800,
}
const WINDOW = 15 * 60_000

test('a window names its own key', () => {
  // The whole reason this pattern needs no state: the clock decides the key.
  assert.equal(bucketOf(Date.parse('2026-09-09T18:30:00Z'), WINDOW), Math.floor(Date.parse('2026-09-09T18:30:00Z') / WINDOW))
  // Two instants inside one window are one key; the next one is not.
  assert.equal(bucketOf(Date.parse('2026-09-09T18:31:00Z'), WINDOW), bucketOf(Date.parse('2026-09-09T18:44:59Z'), WINDOW))
  assert.notEqual(bucketOf(Date.parse('2026-09-09T18:44:59Z'), WINDOW), bucketOf(Date.parse('2026-09-09T18:45:01Z'), WINDOW))
})

test('the encoding is RESP, counted in bytes not characters', () => {
  assert.equal(resp('HINCRBY', 'k', 'f', 3), '*4\r\n$7\r\nHINCRBY\r\n$1\r\nk\r\n$1\r\nf\r\n$1\r\n3\r\n')
  // A password with a non-ASCII character has more bytes than characters, and
  // a length in characters would desynchronise the whole connection.
  assert.match(resp('AUTH', 'hasło'), /\$6\r\nhasło/)
})

/** The stream back into commands, so each one can be looked at on its own. */
function parseResp(out) {
  const lines = out.split('\r\n')
  const cmds = []
  let i = 0
  while (i < lines.length && lines[i].startsWith('*')) {
    const n = parseInt(lines[i].slice(1), 10)
    i++
    const parts = []
    for (let k = 0; k < n; k++) { parts.push(lines[i + 1]); i += 2 }
    cmds.push(parts)
  }
  return cmds
}

test('the shared key gets only what may be summed', () => {
  const cmds = parseResp(commandsFor(SNAP, { node: 'bs1', windowMs: WINDOW, ttlSec: 2592000 }))
  const shared = cmds.filter((c) => c[1]?.startsWith('st:all:'))
  const fields = new Set(shared.filter((c) => c[0] === 'HINCRBY').map((c) => c[2]))
  for (const f of ADDITIVE) assert.ok(fields.has(f), `${f} should reach the shared key`)
  // CPU across three machines is not a number. Neither is "distinct publishers"
  // - the same client on two nodes would be counted twice, and a plausible
  // wrong figure is worse than an absent one.
  for (const f of ['cpu_pct', 'rss', 'heap', 'lag_ms', 'publishers', 'max_bytes', 'window_s']) {
    assert.equal(fields.has(f), false, `${f} must not be added up across nodes`)
  }
  // Only the two live figures that DO mean something summed are there besides.
  assert.deepEqual([...fields].filter((f) => !ADDITIVE.includes(f)).sort(), ['conns', 'topics'])
  // ...and nothing writes gauges to it by another route.
  assert.equal(shared.some((c) => c[0] === 'HSET'), false)
  // Every gauge does reach the node's own key.
  const mineSet = cmds.find((c) => c[0] === 'HSET' && c[1].startsWith('st:bs1:'))
  for (const f of GAUGES) assert.ok(mineSet.includes(f), `${f} is missing from the node's hash`)
})

test('every counter is an increment, so a restart mid-window loses nothing', () => {
  // HSET on the node key would be simpler and would silently discard the first
  // half of a window whenever the relay restarted inside it - which is exactly
  // the window somebody will be reading.
  const out = commandsFor(SNAP, { node: 'bs1', windowMs: WINDOW, ttlSec: 60 })
  for (const f of ADDITIVE) {
    assert.match(out, new RegExp(`HINCRBY\\r\\n\\$\\d+\\r\\nst:bs1:\\d+\\r\\n\\$\\d+\\r\\n${f}\\r\\n`))
  }
  // Both keys expire, or the shared one would live forever.
  assert.equal((out.match(/EXPIRE/g) ?? []).length, 2)
})

test('the URL carries what a deployment needs and nothing else', () => {
  assert.deepEqual(parseUrl('redis://127.0.0.1:6379'), { host: '127.0.0.1', port: 6379, pass: null, db: 0 })
  assert.deepEqual(parseUrl('redis://:sekret@10.0.0.5:6380/3'), { host: '10.0.0.5', port: 6380, pass: 'sekret', db: 3 })
})

test('an unreachable Redis is not an event in the relay', () => {
  // Nothing on port 1 — the write must return quietly, not throw and not block.
  const said = []
  const sink = redisSink({ url: 'redis://127.0.0.1:1', node: 'bs1', windowMs: WINDOW, ttlSec: 60, log: (m) => said.push(m) })
  sink.write(SNAP)
  sink.write(SNAP)
  sink.stop()
  assert.ok(true, 'writing to a dead socket threw')
})

// ---- against a real server, when there is one -------------------------------
let haveRedis = true
try { execFileSync('redis-server', ['--version'], { stdio: 'ignore' }) } catch { haveRedis = false }

test('a real redis-server ends up holding the right numbers', { skip: !haveRedis && 'no redis-server on this machine' }, async () => {
  const port = 6390
  const srv = spawn('redis-server', ['--port', String(port), '--save', '', '--appendonly', 'no'], { stdio: 'ignore' })
  try {
    await new Promise((r) => setTimeout(r, 500))
    const sink = redisSink({ url: `redis://127.0.0.1:${port}`, node: 'bs1', windowMs: WINDOW, ttlSec: 3600 })
    sink.write(SNAP)
    sink.write({ ...SNAP, msgs: 100, bytes: 1000 }) // the same window again: it ADDS
    await new Promise((r) => setTimeout(r, 400))
    sink.stop()

    const key = `st:bs1:${bucketOf(Date.parse(SNAP.at), WINDOW)}`
    const cli = (...a) => execFileSync('redis-cli', ['-p', String(port), ...a], { encoding: 'utf8' }).trim()
    assert.equal(cli('HGET', key, 'msgs'), String(4812 + 100), 'two writes in one window must add up')
    assert.equal(cli('HGET', key, 'bytes'), String(831488 + 1000))
    assert.equal(cli('HGET', key, 'topics'), '213', 'a gauge is the last value, not a sum')
    assert.equal(cli('HGET', key, 'cpu_pct'), '3.4')
    const ttl = parseInt(cli('TTL', key), 10)
    assert.ok(ttl > 3500 && ttl <= 3600, `retention is not set on the key (TTL ${ttl})`)
    // And the shared key holds the network total for the same window.
    const all = `st:all:${bucketOf(Date.parse(SNAP.at), WINDOW)}`
    assert.equal(cli('HGET', all, 'msgs'), String(4812 + 100))
    assert.equal(cli('EXISTS', all), '1')
    assert.equal(cli('HGET', all, 'cpu_pct'), '', 'CPU must not be in the shared key')
  } finally {
    srv.kill()
  }
})
