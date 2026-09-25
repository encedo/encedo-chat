/**
 * metrics.mjs — the relay's live numbers, for a dashboard, on loopback only.
 *
 * The `[stats]` line (stats.mjs) says what happened over fifteen minutes; a
 * load test and an operator watching one need what is happening NOW. So this
 * keeps two kinds of number:
 *
 *   gauges   -- read at the moment of the request: connections (clients and
 *               mesh apart), topics, the announced load percent, memory;
 *   totals   -- monotonic since start: messages, bytes, pushes, refusals,
 *               topics added and evicted. A reader turns two readings into a
 *               rate; nothing here resets on read, so two dashboards do not
 *               steal each other's counts.
 *
 * CPU and loop lag need a window, so a 5 s sampler keeps the last one; a
 * request gets the most recent complete window, never a partial one.
 *
 * Served by relay.mjs on 127.0.0.1 only (`--metrics-port`). There is no
 * version of this that listens on a public address: the numbers are metadata
 * (how many people, when they talk), and the dashboard reaches them over SSH.
 */

export const SAMPLE_MS = 5_000

export function makeMetrics({ now = () => Date.now(), cpuUsage = () => process.cpuUsage(), memoryUsage = () => process.memoryUsage() } = {}) {
  const totals = { msgs: 0, bytes: 0, pushes: 0, refused: 0, topics_added: 0, topics_evicted: 0 }
  let last = { cpu_pct: 0, lag_ms: 0, window_s: 0 }
  let t0 = now(), cpu0 = cpuUsage(), lagMax = 0

  return {
    msg(size) { totals.msgs++; totals.bytes += size | 0 },
    push() { totals.pushes++ },
    topic(what) {
      if (what === 'add') totals.topics_added++
      else if (what === 'evict') totals.topics_evicted++
      else if (what === 'refuse') totals.refused++
    },
    /** How late a 1 s timer fired: the loop's stall. The worst in the window wins. */
    lag(ms) { if (ms > lagMax) lagMax = ms },
    /** Close a sampling window: CPU share over it, and its worst stall. */
    sample() {
      const t = now(), c = cpuUsage()
      const elapsed = Math.max(1, t - t0)
      const usedMs = (c.user - cpu0.user + c.system - cpu0.system) / 1000
      last = { cpu_pct: Math.round((usedMs / elapsed) * 1000) / 10, lag_ms: Math.round(lagMax), window_s: Math.round(elapsed / 100) / 10 }
      t0 = t; cpu0 = c; lagMax = 0
    },
    /** One reading. `gauges` is what only the caller can see right now. */
    snapshot(gauges = {}) {
      const mem = memoryUsage()
      return {
        at: new Date(now()).toISOString(),
        ...gauges,
        cpu_pct: last.cpu_pct,
        lag_ms: last.lag_ms,
        cpu_window_s: last.window_s,
        rss: mem.rss,
        heap: mem.heapUsed,
        uptime_s: Math.round(process.uptime()),
        totals: { ...totals },
      }
    },
  }
}

/**
 * The HTTP handler: GET /metrics -> JSON, everything else 404. Kept separate
 * from the server so a test can call it without opening a port.
 */
export function metricsHandler(read) {
  return (req, res) => {
    if (req.method !== 'GET' || (req.url !== '/metrics' && req.url !== '/metrics/')) {
      res.writeHead(404, { 'content-type': 'text/plain' }); res.end('not found\n'); return
    }
    let body
    try { body = JSON.stringify(read()) } catch (e) {
      res.writeHead(500, { 'content-type': 'text/plain' }); res.end(`metrics failed: ${e?.message ?? e}\n`); return
    }
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
    res.end(body)
  }
}
