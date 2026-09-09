/**
 * stats.mjs - what this node did in the last window, in one line.
 *
 * ## Why
 *
 * The relay logs every message it forwards (~51k lines a day on bs1), which is
 * a trace, not a measurement: it answers "did this frame arrive" and cannot
 * answer "is this node keeping up", "how many rooms are live", or "how close
 * are we to the topic ceiling". Those are the questions an operator actually
 * has, and every one of them is a counter over a period.
 *
 * ## What it is careful about
 *
 * **Off unless asked.** Without `--stats` not one line of this runs - the same
 * rule DUMP follows. It is a knob for an operator, not a default behaviour.
 *
 * **Nothing identifying.** Counts, sizes and gauges. The one thing that comes
 * close is the number of DISTINCT publishers in a window, and only the number
 * survives the window - the ids are held in a Set that is dropped whole when
 * the line is printed, because "how many clients were active" is an operating
 * figure and "which ones" is a surveillance record.
 *
 * **No new exposure.** A line on stdout (journald picks it up) and, if asked,
 * the same as JSONL in a file. No port, no endpoint, nothing for the outside
 * world to reach - the rule this deployment has followed since the IPFS
 * console.
 *
 * ## The one gauge that is not obvious
 *
 * Event-loop lag. A node at 30% CPU whose loop stalls for 400 ms at a time is
 * dropping frames while every CPU graph looks calm; the delay a 1 s timer
 * actually suffers is the honest measure of "keeping up", and it costs one
 * timer.
 */

/** Bytes, for a person: 812k, 1.2M. */
export function human(n) {
  if (n < 1024) return `${n}`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)}k`
  return `${(n / 1024 / 1024).toFixed(1)}M`
}

/** Seconds of uptime as something readable at a glance. */
export function upFor(sec) {
  if (sec < 3600) return `${Math.floor(sec / 60)}m`
  if (sec < 86_400) return `${(sec / 3600).toFixed(1)}h`
  return `${(sec / 86_400).toFixed(1)}d`
}

/**
 * The counters. Pure: it is told what happened and asked for a snapshot; the
 * timers and the printing live in `startStats` below, so all the arithmetic
 * here can be tested without waiting fifteen minutes for it.
 */
export function newCounters(now = () => Date.now(), cpuUsage = () => process.cpuUsage()) {
  let since = now()
  let cpu0 = cpuUsage()
  let msgs = 0, bytes = 0, maxBytes = 0
  let added = 0, evicted = 0, refused = 0
  let up = 0, down = 0
  let lagMax = 0
  let pubs = new Set()

  return {
    msg(from, size) {
      msgs++
      bytes += size
      if (size > maxBytes) maxBytes = size
      if (from) pubs.add(from)
    },
    topic(what) {
      if (what === 'add') added++
      else if (what === 'evict') evicted++
      else if (what === 'refuse') refused++
    },
    conn(delta) { if (delta > 0) up++; else down++ },
    lag(ms) { if (ms > lagMax) lagMax = ms },

    /**
     * Close the window: a snapshot, and every counter back to zero. `gauges`
     * is what only the caller can see right now (live topics, connections).
     *
     * CPU is a DELTA over the window, not the process total - the total is a
     * number that only ever grows and says nothing about the last quarter of
     * an hour.
     */
    roll(gauges = {}) {
      const at = now()
      const elapsed = Math.max(1, at - since)
      const c = cpuUsage()
      const usedMs = (c.user - cpu0.user + c.system - cpu0.system) / 1000
      const mem = process.memoryUsage()
      const snap = {
        at: new Date(at).toISOString(),
        window_s: Math.round(elapsed / 1000),
        topics: gauges.topics ?? null,
        topics_added: added,
        topics_evicted: evicted,
        topics_refused: refused,
        msgs,
        bytes,
        max_bytes: maxBytes,
        publishers: pubs.size,
        conns: gauges.conns ?? null,
        conns_up: up,
        conns_down: down,
        cpu_pct: Math.round((usedMs / elapsed) * 1000) / 10,
        rss: mem.rss,
        heap: mem.heapUsed,
        lag_ms: Math.round(lagMax),
        uptime_s: Math.round(process.uptime()),
      }
      since = at
      cpu0 = c
      msgs = bytes = maxBytes = added = evicted = refused = up = down = lagMax = 0
      // Dropped whole, not cleared entry by entry: the ids were never wanted,
      // only how many there were.
      pubs = new Set()
      return snap
    },
  }
}

/** One line, the shape an operator reads down a screen of them. */
export function formatLine(s, windowMin) {
  return `[stats ${windowMin}m] topics=${s.topics} (+${s.topics_added} -${s.topics_evicted}`
    + `${s.topics_refused ? ` REFUSED=${s.topics_refused}` : ''}) msgs=${s.msgs} bytes=${human(s.bytes)}`
    + ` max=${human(s.max_bytes)} pubs=${s.publishers} conns=${s.conns} (+${s.conns_up} -${s.conns_down})`
    + ` cpu=${s.cpu_pct}% rss=${human(s.rss)} heap=${human(s.heap)} lag=${s.lag_ms}ms up=${upFor(s.uptime_s)}`
}

/**
 * Wire the counters to real time: a 1 s probe for loop lag, and the window
 * timer that prints. `gauges()` is called once per window, at the moment the
 * line is written, so the "now" figures belong to the same instant as the
 * counts.
 */
export function startStats({ windowMin, gauges, jsonPath = null, log = console.log, fs = null }) {
  const counters = newCounters()
  const windowMs = windowMin * 60_000
  const PROBE_MS = 1_000

  let due = Date.now() + PROBE_MS
  const probe = setInterval(() => {
    const late = Date.now() - due
    due = Date.now() + PROBE_MS
    if (late > 0) counters.lag(late)
  }, PROBE_MS)

  const timer = setInterval(() => {
    const snap = counters.roll(gauges())
    log(formatLine(snap, windowMin))
    if (jsonPath && fs) {
      // Never fatal: a full disk or a bad path must not take a relay down for
      // the sake of a statistic.
      fs.appendFile(jsonPath, JSON.stringify(snap) + '\n', () => {})
    }
  }, windowMs)

  return { stop() { clearInterval(probe); clearInterval(timer) }, counters }
}
