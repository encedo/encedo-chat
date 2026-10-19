#!/usr/bin/env node
/**
 * node/dash/dash.mjs - the operator's dashboard for a network set up with
 * onchato-setup.sh, run on the operator's own machine.
 *
 *   node node/dash/dash.mjs https://chat.example.com/onchato/network.json
 *   node node/dash/dash.mjs network.json --port 8090 --ssh-user root --every 10
 *   node node/dash/dash.mjs --on-node            (in the node's `dash` container)
 *
 * Two ways to run it. ON THE NODE (the default of onchato-setup.sh): a container
 * that listens on 127.0.0.1 only, reads everything from the node's loopback -
 * no SSH, and deliberately no Docker socket (that would be root on the host);
 * the services are judged by their answers - and the admin opens it through an
 * SSH tunnel: `ssh -L 8088:127.0.0.1:8088 root@<node>`, then localhost:8088.
 * FROM THE ADMIN'S MACHINE: every node of the profile over SSH, for a network
 * of several nodes seen from one place.
 *
 * Read only. It knows the network from its signed profile (the nodes, the
 * stores, the addresses), asks each node over SSH for what the node keeps on
 * loopback - the relay's live numbers (127.0.0.1:9003), the containers, the
 * disk, the file store's ledger, 24 h of statistics from Redis - and checks
 * from outside what the apps see: every profile address with its CORS header,
 * and each node's certificate. Nothing on the nodes listens for it, and it never
 * holds the network key: signing stays with `onchato-ops`.
 *
 * The page is served on 127.0.0.1 only. Same idea as infra/dash (our nodes),
 * shaped for a node of the Docker image. Code is ASCII (repo rule).
 */
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { connect as tlsConnect } from 'node:tls'
import { homedir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { connect as tcpConnect } from 'node:net'
import { createSocket } from 'node:dgram'
import { randomBytes } from 'node:crypto'
import { statfsSync } from 'node:fs'
import { openEnvelope, rootFingerprint } from '../../impl/lib/netprofile.ts'

const args = process.argv.slice(2)
const opt = (n, d) => { const i = args.indexOf(n); return i >= 0 && args[i + 1] ? args[i + 1] : d }
const WITH_VALUE = ['--port', '--ssh-user', '--every']
const ON_NODE = args.includes('--on-node')
const SOURCE = args.find((a, i) => !a.startsWith('--') && !WITH_VALUE.includes(args[i - 1]))
  ?? (ON_NODE ? '/data/profile/network.json' : undefined)
if (!SOURCE) {
  console.error('usage: node node/dash/dash.mjs <https://.../network.json | network.json> [--port 8088] [--ssh-user root] [--every 10]')
  process.exit(2)
}
const PORT = Number(opt('--port', 8088))
const SSH_USER = opt('--ssh-user', 'root')
const EVERY_S = Number(opt('--every', 10))
const WINDOW_MS = 15 * 60_000
const here = dirname(fileURLToPath(import.meta.url))

// ---- the network, from its profile ----------------------------------------------
const net = { at: 0, error: null, profile: null, fingerprint: null, urls: [] }
async function readProfile() {
  try {
    const text = SOURCE.startsWith('https://') || SOURCE.startsWith('http://')
      ? await (await fetch(SOURCE, { cache: 'no-store', signal: AbortSignal.timeout(8000) })).text()
      : readFileSync(SOURCE, 'utf8')
    const r = openEnvelope(text, Date.now(), undefined, { allowExpired: true })
    if (!r.ok) throw new Error(`the profile does not open (${r.why}${r.detail ? ': ' + r.detail : ''})`)
    net.profile = r.profile
    net.fingerprint = await rootFingerprint(r.profile.rootPub)
    net.error = null
  } catch (e) { net.error = String(e?.message ?? e) }
  net.at = Date.now()
  if (!net.profile) return
  // What the apps get from every address the profile names, as the apps ask (CORS).
  net.urls = await Promise.all(net.profile.profileUrls.map(async (url) => {
    try {
      const res = await fetch(url, { cache: 'no-store', headers: { Origin: net.profile.app.origin }, signal: AbortSignal.timeout(8000) })
      const cors = res.headers.get('access-control-allow-origin')
      const o = res.ok ? openEnvelope(await res.text(), Date.now(), undefined, { allowExpired: true }) : null
      return { url, status: res.status, cors, seq: o?.ok ? o.profile.seq : null, sameKey: o?.ok ? o.profile.rootPub === net.profile.rootPub : false }
    } catch (e) { return { url, error: String(e?.message ?? e) } }
  }))
}

const hostOf = (addr) => (addr.match(/\/dns[46]?\/([^/]+)/) ?? addr.match(/\/ip[46]\/([^/]+)/) ?? [])[1]
const nodes = () => ON_NODE
  ? [{ name: process.env.NODE_HOST, host: process.env.NODE_HOST }]
  : (net.profile?.nodes ?? []).map((n) => ({ name: n.name, host: hostOf(n.addr) })).filter((n) => n.host)

// ---- per node, over SSH -----------------------------------------------------------
const CONTROL = join(homedir(), '.ssh', 'cm-onchato-opdash-%h')
function ssh(host, command, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const p = spawn('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=6', '-o', 'ControlMaster=auto',
      '-o', `ControlPath=${CONTROL}`, '-o', 'ControlPersist=120', `${SSH_USER}@${host}`, command])
    let out = '', err = ''
    const t = setTimeout(() => { p.kill(); reject(new Error('timeout')) }, timeoutMs)
    p.stdout.on('data', (d) => { out += d })
    p.stderr.on('data', (d) => { err += d })
    p.on('close', (code) => { clearTimeout(t); code === 0 ? resolve(out) : reject(new Error(err.trim().split('\n').pop() || `ssh exit ${code}`)) })
  })
}

// One round trip: sections between markers, parsed here (no jq needed there).
const LIVE = [
  'echo "##metrics"; curl -s --max-time 3 http://127.0.0.1:9003/metrics || true',
  'echo; echo "##ps"; docker ps -a --filter name=onchato- --format "{{.Names}}|{{.State}}|{{.Status}}" 2>/dev/null || true',
  'echo "##df"; df -P / | tail -1',
  'echo "##mem"; free -m | sed -n 2p',
  'echo "##ledger"; docker exec onchato-kubo-1 ipfs files ls /ec 2>/dev/null | wc -l || true',
  'echo "##repo"; docker exec onchato-kubo-1 ipfs repo stat -s 2>/dev/null | awk \'/RepoSize/{print $2}\' || true',
  'echo "##env"; grep -E "^(STORE|REDIS_PORT|HOME_SITE|COMPOSE_PROFILES)=" /opt/onchato/node/node.env 2>/dev/null || true',
].join('; ')

const state = {}
function sections(out) {
  const s = {}; let k = null
  for (const line of out.split('\n')) {
    const m = line.match(/^##(\w+)$/)
    if (m) { k = m[1]; s[k] = []; continue }
    if (k && line.trim()) s[k].push(line)
  }
  return s
}

async function pollNode({ name, host }) {
  const st = (state[name] ??= { host, samples: [], history: [], cert: null })
  try {
    const s = sections(await ssh(host, LIVE))
    let m = null
    try { m = JSON.parse((s.metrics ?? []).join('')) } catch {}
    const prev = st.last
    const t = m ? Date.parse(m.at) || Date.now() : Date.now()
    const dt = prev?.m && m ? (t - prev.t) / 1000 : 0
    const rate = (k) => (prev?.m && m && dt > 0 && m.totals[k] >= prev.m.totals[k] ? (m.totals[k] - prev.m.totals[k]) / dt : null)
    const df = (s.df?.[0] ?? '').trim().split(/\s+/)
    const mem = (s.mem?.[0] ?? '').trim().split(/\s+/)
    const env = Object.fromEntries((s.env ?? []).map((l) => l.split('=')))
    st.last = {
      t, m, msgsPerS: rate('msgs'), refusedPerS: rate('refused'),
      containers: (s.ps ?? []).map((l) => { const [n, state, status] = l.split('|'); return { name: n.replace(/^onchato-|-1$/g, ''), state, status } }),
      disk: df.length > 4 ? { size: Number(df[1]) * 1024, used: Number(df[2]) * 1024, pct: Number(String(df[4]).replace('%', '')) } : null,
      mem: mem.length > 2 ? { total: Number(mem[1]), used: Number(mem[2]) } : null,
      store: env.STORE === 'here' ? { ledger: Number(s.ledger?.[0] ?? NaN), repo: Number(s.repo?.[0] ?? NaN) } : null,
      stats: Boolean(env.REDIS_PORT), redisPort: env.REDIS_PORT, homeSite: env.HOME_SITE || null,
    }
    if (m) { st.samples.push({ t, conns: m.conns, topics: m.topics }); if (st.samples.length > 360) st.samples.shift() }
    st.error = null
  } catch (e) { st.error = { at: Date.now(), msg: String(e?.message ?? e) } }
}

async function historyNode({ name, host }) {
  const st = state[name]
  if (!st?.last?.stats) return
  const now = Math.floor(Date.now() / WINDOW_MS), from = now - 96
  const key = host.split('.')[0] // the relay's --stats-node: NODE_HOST up to the first dot (node/entry.sh)
  const cmd = `docker exec onchato-redis-1 sh -c 'for b in $(seq ${from} ${now}); do echo "$b $(redis-cli -p ${Number(st.last.redisPort) || 6379} hmget st:${key}:$b conns topics msgs | tr "\\n" " ")"; done'`
  try {
    const out = await ssh(host, cmd, 30000)
    const num = (v) => (v === undefined || v === '' ? null : Number(v))
    st.history = out.trim().split('\n').map((l) => { const [b, c, tp, ms] = l.trim().split(/\s+/); return { t: Number(b) * WINDOW_MS, conns: num(c), topics: num(tp), msgs: num(ms) } })
  } catch {}
}

// ---- on the node: the same readings from loopback ----------------------------------
const L = (ms) => AbortSignal.timeout(ms)
const tcpOpen = (port) => new Promise((ok) => { const c = tcpConnect({ host: '127.0.0.1', port }); c.setTimeout(2000); c.on('connect', () => { c.destroy(); ok(true) }); c.on('error', () => ok(false)); c.on('timeout', () => { c.destroy(); ok(false) }) })
/** A few Redis commands over one connection (RESP), arrays of strings back. */
function redis(port, cmds) {
  return new Promise((resolve, reject) => {
    const c = tcpConnect({ host: '127.0.0.1', port }); let buf = ''
    c.setTimeout(4000); c.on('timeout', () => { c.destroy(); reject(new Error('redis timeout')) }); c.on('error', reject)
    c.on('connect', () => c.write(cmds.map((a) => `*${a.length}\r\n` + a.map((x) => `$${Buffer.byteLength(String(x))}\r\n${x}\r\n`).join('')).join('')))
    c.on('data', (d) => {
      buf += d
      const out = []; let i = 0
      const line = () => { const j = buf.indexOf('\r\n', i); if (j < 0) throw 0; const l = buf.slice(i, j); i = j + 2; return l }
      const one = () => { const l = line(); if (l[0] === '$') { const n = Number(l.slice(1)); if (n < 0) return null; if (buf.length < i + n + 2) throw 0; const v = buf.slice(i, i + n); i += n + 2; return v } if (l[0] === '*') { const n = Number(l.slice(1)); const a = []; for (let k = 0; k < n; k++) a.push(one()); return a } return l.slice(1) }
      try { for (let k = 0; k < cmds.length; k++) out.push(one()) } catch { return }
      c.end(); resolve(out)
    })
  })
}
/** STUN: a Binding Request to loopback 3478, answered within a second. */
const stunAnswers = () => new Promise((ok) => {
  const s = createSocket('udp4'); const tid = randomBytes(12)
  const req = Buffer.concat([Buffer.from([0x00, 0x01, 0x00, 0x00, 0x21, 0x12, 0xa4, 0x42]), tid])
  const t = setTimeout(() => { s.close(); ok(false) }, 1000)
  s.on('message', (m) => { if (m.subarray(8, 20).equals(tid)) { clearTimeout(t); s.close(); ok(true) } })
  s.send(req, 3478, '127.0.0.1')
})
const kubo = async (path) => (await fetch(`http://127.0.0.1:5001/api/v0/${path}`, { method: 'POST', headers: { 'user-agent': 'onchato-dash' }, signal: L(4000) })).json()

async function pollLocal({ name }) {
  const st = (state[name] ??= { host: name, samples: [], history: [], cert: null })
  const env = process.env
  let m = null
  try { m = await (await fetch('http://127.0.0.1:9003/metrics', { signal: L(3000) })).json() } catch {}
  const prev = st.last, t = m ? Date.parse(m.at) || Date.now() : Date.now()
  const dt = prev?.m && m ? (t - prev.t) / 1000 : 0
  const rate = (k) => (prev?.m && m && dt > 0 && m.totals[k] >= prev.m.totals[k] ? (m.totals[k] - prev.m.totals[k]) / dt : null)
  const store = env.STORE === 'here'
  const services = [['relay', Boolean(m)], ['stun', await stunAnswers()], ['nginx', await tcpOpen(443)]]
  let storeInfo = null
  if (store) {
    let ledger = NaN, repo = NaN, up = false
    try { const ls = await kubo('files/ls?arg=/ec'); ledger = (ls.Entries ?? []).length; up = true } catch {}
    try { repo = (await kubo('repo/stat?size-only=true')).RepoSize } catch {}
    services.push(['kubo', up], ['fput', await tcpOpen(9202)])
    storeInfo = { ledger, repo }
  }
  if (env.REDIS_PORT) { let ok = false; try { ok = (await redis(Number(env.REDIS_PORT), [['PING']]))[0] === 'PONG' } catch {}; services.push(['redis', ok]) }
  let disk = null
  try { const f = statfsSync('/data/profile'); disk = { size: f.blocks * f.bsize, used: (f.blocks - f.bfree) * f.bsize, pct: Math.round(((f.blocks - f.bfree) / f.blocks) * 100) } } catch {}
  let mem = null
  try { const mi = Object.fromEntries(readFileSync('/proc/meminfo', 'utf8').split('\n').map((l) => l.split(/:\s+/)).filter((a) => a.length === 2).map(([k, v]) => [k, parseInt(v)])); mem = { total: Math.round(mi.MemTotal / 1024), used: Math.round((mi.MemTotal - mi.MemAvailable) / 1024) } } catch {}
  st.last = {
    t, m, msgsPerS: rate('msgs'), refusedPerS: rate('refused'),
    containers: services.map(([n, ok]) => ({ name: n, state: ok ? 'running' : 'down' })),
    disk, mem, store: storeInfo, stats: Boolean(env.REDIS_PORT), redisPort: env.REDIS_PORT, homeSite: env.HOME_SITE || null,
  }
  if (m) { st.samples.push({ t, conns: m.conns, topics: m.topics }); if (st.samples.length > 360) st.samples.shift() }
  st.error = m ? null : { at: Date.now(), msg: 'the relay does not answer on 127.0.0.1:9003' }
}

async function historyLocal({ name }) {
  const st = state[name]
  if (!st?.last?.stats) return
  const now = Math.floor(Date.now() / WINDOW_MS), key = name.split('.')[0]
  const bs = Array.from({ length: 97 }, (_, k) => now - 96 + k)
  try {
    const rows = await redis(Number(st.last.redisPort), bs.map((b) => ['HMGET', `st:${key}:${b}`, 'conns', 'topics', 'msgs']))
    const num = (v) => (v == null || v === '' ? null : Number(v))
    st.history = rows.map((r, k) => ({ t: bs[k] * WINDOW_MS, conns: num(r[0]), topics: num(r[1]), msgs: num(r[2]) }))
  } catch {}
}

/** Days left on the certificate the world gets from <host>:443 (on the node: through loopback, by name). */
function certDays(host) {
  return new Promise((resolve) => {
    const s = tlsConnect({ host: ON_NODE ? '127.0.0.1' : host, port: 443, servername: host, timeout: 6000 }, () => {
      const c = s.getPeerCertificate()
      s.end()
      resolve({ days: Math.floor((Date.parse(c.valid_to) - Date.now()) / 86_400_000), issuer: c.issuer?.O ?? c.issuer?.CN ?? '?', ok: s.authorized })
    })
    s.on('error', (e) => resolve({ error: String(e?.message ?? e) }))
    s.on('timeout', () => { s.destroy(); resolve({ error: 'timeout' }) })
  })
}

async function slow() {
  await readProfile()
  await Promise.all(nodes().map(async (n) => {
    await (ON_NODE ? historyLocal(n) : historyNode(n))
    const st = (state[n.name] ??= { host: n.host, samples: [], history: [] })
    st.cert = await certDays(n.host)
    const home = st.last?.homeSite
    st.homeCert = home ? { host: home, ...(await certDays(home)) } : null
  }))
}
const fast = () => Promise.all(nodes().map(ON_NODE ? pollLocal : pollNode))

// ---- the page ----------------------------------------------------------------------
const PAGE = readFileSync(join(here, 'index.html'), 'utf8')
createServer((req, res) => {
  if (req.url === '/data') {
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
    res.end(JSON.stringify({ now: Date.now(), every: EVERY_S, source: SOURCE, onNode: ON_NODE, net, nodes: nodes(), state }))
    return
  }
  if (req.url === '/' || req.url === '/index.html') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-security-policy': "default-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'" })
    res.end(PAGE); return
  }
  res.writeHead(404); res.end()
}).on('error', (e) => {
  console.error(e?.code === 'EADDRINUSE' ? `port ${PORT} is taken - another dashboard? (--port <n>)` : `dash: ${e?.message ?? e}`)
  process.exit(1)
}).listen(PORT, '127.0.0.1', async () => {
  // Listening first, reading after: the page says "connecting" for a few seconds
  // rather than the port refusing while the first round of reads runs.
  await slow(); await fast()
  setInterval(fast, EVERY_S * 1000)
  setInterval(slow, 5 * 60_000)
  const p = net.profile
  console.log(`onchato operator dash: http://localhost:${PORT}  (${p ? `${p.operator}, ${p.networkId}, ${nodes().length} node(s)` : `profile: ${net.error}`}; every ${EVERY_S}s ${ON_NODE ? 'on this node, loopback only' : `over SSH as ${SSH_USER}`})`)
})
