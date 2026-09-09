/**
 * redis.mjs - the window's counters, into Redis, on a plain socket.
 *
 * ## The shape
 *
 * One hash per (node, window), where the window is `floor(epoch / period)` -
 * the pattern this project has used before, and still the simplest thing that
 * works: the writer holds no state, the key names itself from the clock, and
 * `EXPIRE` on the key is the whole of retention. Nothing to sweep, nothing to
 * roll over, nothing to coordinate.
 *
 *   HINCRBY  st:bs1:1757000  msgs 4812          # additive: survives a restart
 *   HINCRBY  st:bs1:1757000  bytes 831488       #   mid-window, which is exactly
 *   ...                                         #   when the numbers matter
 *   HSET     st:bs1:1757000  topics 213 conns 131 cpu_pct 3.4 rss 148897792 ...
 *   EXPIRE   st:bs1:1757000  2592000
 *
 * and the same additive fields again into `st:all:<window>`, so three nodes
 * writing independently produce the network's total with no collector in the
 * middle. Only the fields that MEAN something summed go there: messages and
 * bytes do, CPU does not, and "distinct publishers" does not either - the same
 * client on two nodes would be counted twice, and a plausible wrong number is
 * worse than an absent one.
 *
 * ## No dependency
 *
 * RESP is a text protocol and this needs four commands, so it is written here
 * rather than pulled in - the same call as the STUN server. Forty lines against
 * a package tree, on a machine whose whole job is to stay up.
 *
 * ## No consequences
 *
 * Fire and forget: replies are drained and ignored, a dead socket reconnects on
 * the next window, and nothing here can throw into the relay. A statistic that
 * can take a relay down is not worth having.
 */

import net from 'net'

/** Which window an instant falls in. The key's whole identity. */
export const bucketOf = (atMs, windowMs) => Math.floor(atMs / windowMs)

/** Fields that may be added up across nodes. Everything else is per-node. */
export const ADDITIVE = [
  'msgs', 'bytes', 'topics_added', 'topics_evicted', 'topics_refused',
  'conns_up', 'conns_down',
]

/** Fields that are true at the instant the window closed, not over it. */
export const GAUGES = [
  'topics', 'conns', 'publishers', 'max_bytes', 'cpu_pct', 'rss', 'heap', 'lag_ms', 'window_s',
]

/** One RESP command: an array of bulk strings. */
export function resp(...parts) {
  let out = `*${parts.length}\r\n`
  for (const p of parts) {
    const s = String(p)
    out += `$${Buffer.byteLength(s)}\r\n${s}\r\n`
  }
  return out
}

/**
 * The whole write for one window, as bytes. Pure, so what goes on the wire can
 * be asserted without a server: the commands, their order, and the fact that
 * only ADDITIVE fields reach the shared key.
 */
export function commandsFor(snap, { node, windowMs, ttlSec, atMs = Date.parse(snap.at) }) {
  const b = bucketOf(atMs, windowMs)
  const mine = `st:${node}:${b}`
  const all = `st:all:${b}`
  let out = ''
  for (const f of ADDITIVE) {
    const v = snap[f] ?? 0
    out += resp('HINCRBY', mine, f, v)
    out += resp('HINCRBY', all, f, v)
  }
  const gauges = ['HSET', mine]
  for (const f of GAUGES) gauges.push(f, snap[f] ?? 0)
  out += resp(...gauges)
  // The node's own live figures are summable across nodes: how many rooms and
  // how many clients the NETWORK is carrying is a number worth having.
  out += resp('HINCRBY', all, 'topics', snap.topics ?? 0)
  out += resp('HINCRBY', all, 'conns', snap.conns ?? 0)
  out += resp('EXPIRE', mine, ttlSec)
  out += resp('EXPIRE', all, ttlSec)
  return out
}

/** `redis://[:pass@]host:port[/db]` -> the pieces, with the defaults. */
export function parseUrl(url) {
  const u = new URL(url)
  return {
    host: u.hostname || '127.0.0.1',
    port: parseInt(u.port || '6379', 10),
    pass: decodeURIComponent(u.password || '') || null,
    db: u.pathname && u.pathname.length > 1 ? parseInt(u.pathname.slice(1), 10) : 0,
  }
}

/**
 * A writer that connects lazily and never complains twice: the first failure
 * says so, and the rest are silent until it works again - a relay that cannot
 * reach its statistics database must not fill the log with the fact.
 */
export function redisSink({ url, node, windowMs, ttlSec, log = console.log }) {
  const cfg = parseUrl(url)
  let sock = null
  let complained = false

  const drop = () => { try { sock?.destroy() } catch {} sock = null }

  const connect = () => {
    const s = net.connect({ host: cfg.host, port: cfg.port })
    s.setNoDelay(true)
    s.on('error', (e) => {
      if (!complained) { log(`[stats] redis unreachable (${e.message}) — counters stay in the log`); complained = true }
      if (sock === s) drop()
    })
    // Replies are of no interest - but they must be read, or the kernel buffer
    // fills and the socket stalls.
    s.on('data', () => {})
    s.on('close', () => { if (sock === s) sock = null })
    let hello = ''
    if (cfg.pass) hello += resp('AUTH', cfg.pass)
    if (cfg.db) hello += resp('SELECT', cfg.db)
    if (hello) s.write(hello)
    return s
  }

  return {
    write(snap) {
      try {
        if (!sock || sock.destroyed) sock = connect()
        sock.write(commandsFor(snap, { node, windowMs, ttlSec }), (e) => { if (e) drop() })
        complained = false
      } catch { drop() } // never into the relay
    },
    stop() { drop() },
  }
}
