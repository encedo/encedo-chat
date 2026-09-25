import { test } from 'node:test'
import assert from 'node:assert/strict'
import { makeMetrics, metricsHandler, readCommit } from './metrics.mjs'

const clock = () => { let t = 1_000_000; return { now: () => t, add: (ms) => { t += ms } } }

test('totals only grow, and reading does not reset them', () => {
  const m = makeMetrics()
  m.msg(100); m.msg(50); m.push(); m.topic('add'); m.topic('evict'); m.topic('refuse')
  const a = m.snapshot().totals
  assert.deepEqual(a, { msgs: 2, bytes: 150, pushes: 1, refused: 1, topics_added: 1, topics_evicted: 1 })
  assert.deepEqual(m.snapshot().totals, a, 'a second reader sees the same counts')
  m.msg(1)
  assert.equal(m.snapshot().totals.msgs, 3)
})

test('CPU is the share of the last complete window, not of the process life', () => {
  const c = clock()
  let used = 0
  const m = makeMetrics({ now: c.now, cpuUsage: () => ({ user: used, system: 0 }) })
  c.add(5000); used += 1_000_000 // 1 s of CPU in a 5 s window
  m.sample()
  assert.equal(m.snapshot().cpu_pct, 20)
  c.add(5000) // idle window
  m.sample()
  assert.equal(m.snapshot().cpu_pct, 0)
})

test('the worst loop stall in the window is reported, then the window starts clean', () => {
  const m = makeMetrics()
  m.lag(12); m.lag(80); m.lag(30)
  m.sample()
  assert.equal(m.snapshot().lag_ms, 80)
  m.sample()
  assert.equal(m.snapshot().lag_ms, 0)
})

test('gauges from the caller are passed through as they are', () => {
  const m = makeMetrics()
  const s = m.snapshot({ node: 'bs3', conns: 7, topics: 21, pct: 3 })
  assert.equal(s.node, 'bs3'); assert.equal(s.conns, 7); assert.equal(s.topics, 21); assert.equal(s.pct, 3)
  assert.ok(s.rss > 0 && s.heap > 0)
})

function call(handler, method, url) {
  const res = { code: 0, headers: {}, body: '', writeHead(c, h) { this.code = c; this.headers = h }, end(b) { this.body = b } }
  handler({ method, url }, res)
  return res
}

test('GET /metrics answers JSON; anything else is 404', () => {
  const h = metricsHandler(() => ({ ok: 1 }))
  const r = call(h, 'GET', '/metrics')
  assert.equal(r.code, 200)
  assert.equal(r.headers['content-type'], 'application/json')
  assert.deepEqual(JSON.parse(r.body), { ok: 1 })
  assert.equal(call(h, 'GET', '/').code, 404)
  assert.equal(call(h, 'POST', '/metrics').code, 404)
  assert.equal(call(h, 'GET', '/metrics?x').code, 404)
})

test('a reading that throws is a 500 with the reason, not a crash', () => {
  const h = metricsHandler(() => { throw new Error('boom') })
  const r = call(h, 'GET', '/metrics')
  assert.equal(r.code, 500)
  assert.match(r.body, /boom/)
})

test('the commit is read from .git: a branch ref, a packed ref, a detached HEAD, or nothing', () => {
  const sha = 'fac40ed' + '0'.repeat(33)
  const fs = (files) => ({ readFile: (p) => { const k = p.replace('/repo/.git/', ''); if (!(k in files)) throw new Error('ENOENT'); return files[k] } })
  assert.equal(readCommit('/repo', fs({ HEAD: 'ref: refs/heads/main\n', 'refs/heads/main': sha + '\n' })), 'fac40ed')
  assert.equal(readCommit('/repo', fs({ HEAD: 'ref: refs/heads/main\n', 'packed-refs': `# pack\n${sha} refs/heads/main\n` })), 'fac40ed')
  assert.equal(readCommit('/repo', fs({ HEAD: sha + '\n' })), 'fac40ed')
  assert.equal(readCommit('/repo', fs({})), null)
  assert.equal(readCommit('/repo', fs({ HEAD: 'ref: refs/heads/main\n', 'refs/heads/main': 'garbage' })), null)
})
