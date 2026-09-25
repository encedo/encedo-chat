#!/usr/bin/env node
/**
 * infra/dash/dash.mjs -- a live view of the relay nodes, on this machine.
 *
 *   node infra/dash/dash.mjs            # then open http://localhost:8088
 *   node infra/dash/dash.mjs --port 8090 --every 5
 *
 * Every few seconds it asks each node for its live numbers over SSH
 * (`ssh bsN curl 127.0.0.1:9003/metrics`) -- the relay serves them on
 * loopback only, so SSH is the one way in and nothing is exposed. Every few
 * minutes it also reads the last 24 h of 15-minute windows from each node's
 * Redis (the same `st:<node>:<window>` hashes the `[stats]` line writes).
 *
 * The node list is the table at the bottom of relay/onchato-relay.service:
 * one list, not a second copy. Zero dependencies; it needs working SSH to the
 * nodes (the same keys the operator already uses) and nothing else.
 *
 * Colours follow the health alarm (infra/health/relay-health.sh): below 75 %
 * fine, 75-90 % warning, 90 % and up alarm. A node that stopped answering is
 * shown GREY with the age of its last reading -- never as healthy-from-before.
 */

import { createServer } from 'http'
import { spawn } from 'child_process'
import { readFileSync } from 'fs'
import { homedir } from 'os'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const args = process.argv.slice(2)
const opt = (name, dflt) => { const i = args.indexOf(name); return i >= 0 && args[i + 1] ? args[i + 1] : dflt }
const PORT = Number(opt('--port', 8088))
const EVERY_S = Number(opt('--every', 5))
const METRICS_PORT = Number(opt('--metrics-port', 9003))
const KEEP = Math.ceil((30 * 60) / EVERY_S)          // 30 minutes of live samples
const HISTORY_EVERY_MS = 5 * 60_000
const WINDOW_MS = 15 * 60_000

const here = dirname(fileURLToPath(import.meta.url))
const TEMPLATE = join(here, '..', '..', 'relay', 'onchato-relay.service')
// `--local <port>`: one node called "local", read straight from
// http://127.0.0.1:<port>/metrics -- a relay on this machine, for development.
const LOCAL = opt('--local', null)
const NODES = LOCAL ? ['local'] : readFileSync(TEMPLATE, 'utf8').split('\n')
  .map((l) => l.match(/^# (bs\d+)\s+(12D3KooW\S+)/)).filter(Boolean).map((m) => m[1])
if (!NODES.length) { console.error(`no node table in ${TEMPLATE}`); process.exit(1) }

const CONTROL = join(homedir(), '.ssh', 'cm-onchato-dash-%h')
function ssh(host, command, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const p = spawn('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=5',
      '-o', 'ControlMaster=auto', '-o', `ControlPath=${CONTROL}`, '-o', 'ControlPersist=120', host, command])
    let out = '', err = ''
    const t = setTimeout(() => { p.kill(); reject(new Error('timeout')) }, timeoutMs)
    p.stdout.on('data', (d) => { out += d })
    p.stderr.on('data', (d) => { err += d })
    p.on('close', (code) => { clearTimeout(t); code === 0 ? resolve(out) : reject(new Error(err.trim().split('\n').pop() || `ssh exit ${code}`)) })
  })
}

/** Per node: live samples, the last reading, the last error, the 24 h windows. */
const state = Object.fromEntries(NODES.map((n) => [n, { samples: [], last: null, error: null, history: [] }]))

async function pollOne(node) {
  const s = state[node]
  try {
    const raw = LOCAL
      ? await (await fetch(`http://127.0.0.1:${LOCAL}/metrics`, { signal: AbortSignal.timeout(3000) })).text()
      : await ssh(`${node}.onchato.com`, `curl -s --max-time 3 http://127.0.0.1:${METRICS_PORT}/metrics`)
    const m = JSON.parse(raw)
    const t = Date.parse(m.at) || Date.now()
    const prev = s.last
    const dt = prev ? (t - prev.t) / 1000 : 0
    const rate = (k) => (prev && dt > 0 && m.totals[k] >= prev.totals[k] ? (m.totals[k] - prev.totals[k]) / dt : null)
    const sample = {
      t, pct: m.pct, conns: m.conns, clients: m.conns_clients, mesh: m.conns_mesh, maxConns: m.max_conns,
      topics: m.topics, maxTopics: m.max_topics, cpu: m.cpu_pct, rss: m.rss, heap: m.heap, lag: m.lag_ms,
      msgs: rate('msgs'), pushes: rate('pushes'), refused: rate('refused'), commit: m.commit, uptime: m.uptime_s,
      totals: m.totals,
    }
    s.last = sample; s.error = null
    s.samples.push(sample); if (s.samples.length > KEEP) s.samples.shift()
  } catch (e) {
    s.error = { at: Date.now(), msg: String(e?.message ?? e) }
  }
}

async function historyOne(node) {
  if (LOCAL) return // no Redis history for a development relay
  const now = Math.floor(Date.now() / WINDOW_MS)
  const from = now - 96
  // One SSH round trip: a shell loop over the 96 windows of the last 24 h.
  const cmd = `for b in $(seq ${from} ${now}); do echo "$b $(redis-cli hmget st:${node}:$b conns topics cpu_pct rss msgs | tr '\\n' ' ')"; done`
  try {
    const out = await ssh(`${node}.onchato.com`, cmd, 20000)
    state[node].history = out.trim().split('\n').map((l) => {
      const [b, conns, topics, cpu, rss, msgs] = l.trim().split(/\s+/)
      const num = (v) => (v === undefined || v === '' ? null : Number(v))
      return { t: Number(b) * WINDOW_MS, conns: num(conns), topics: num(topics), cpu: num(cpu), rss: num(rss), msgs: num(msgs) }
    })
  } catch { /* keep the previous history; the live card says whether the node answers */ }
}

const tick = () => Promise.all(NODES.map(pollOne))
const history = () => Promise.all(NODES.map(historyOne))
setInterval(tick, EVERY_S * 1000); void tick()
setInterval(history, HISTORY_EVERY_MS); void history()

const PAGE = readFileSync(join(here, 'index.html'), 'utf8')
createServer((req, res) => {
  if (req.url === '/data') {
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
    res.end(JSON.stringify({ now: Date.now(), every: EVERY_S, nodes: NODES, state }))
    return
  }
  if (req.url === '/' || req.url === '/index.html') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(PAGE); return
  }
  res.writeHead(404); res.end()
}).listen(PORT, '127.0.0.1', () => {
  console.log(`onchato dash: http://localhost:${PORT}  (${NODES.join(', ')}, every ${EVERY_S}s over SSH, metrics port ${METRICS_PORT})`)
})
