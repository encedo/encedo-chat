/**
 * diag.ts - the flight recorder.
 *
 * ## Why this exists
 *
 * Two always-on desktops sat in the tray overnight and neither showed a dot
 * beside the other in the morning (2026-09-09). The relay's own log answered
 * half of it - both machines published all night, so nothing had crashed and
 * no socket had died - and could not answer the other half, because a relay
 * sees what arrives, never what a client HEARD. The client is the only witness
 * to that, and in a packaged app its witness statement goes to a console
 * nobody can open.
 *
 * So the events that decide whether a contact looks present are written down,
 * with a wall clock, to a file that survives a restart. It is a diary of the
 * CONNECTION, not of the conversation - see `isLifecycle`.
 *
 * ## What it must never do
 *
 * Not one byte of what anybody said goes in here. This product's promise is
 * that transcripts die with the page; a diagnostic file that quietly outlives
 * them would be a worse bug than the one it was written to find. The app's own
 * log carries message text (`sent "..."`), so lines are admitted by an
 * ALLOWLIST of connection vocabulary rather than filtered by a blocklist -
 * anything unrecognised is dropped, which is the only direction that fails
 * safely. `test/diag.test.ts` holds that line.
 *
 * ## Volume
 *
 * A night has to be readable in one screen. Steady state is one summary line
 * every five minutes plus the handful of things that actually happened, so a
 * night is ~150 lines - not a trace, a diary.
 */

/** How many lines are kept in memory for the "copy the log" button. */
const KEEP = 2000

/**
 * A periodic probe that fires this much later than it was due means the
 * process was not running - a frozen webview, a slept machine, a suspended
 * app. It is the one measurement nothing else can stand in for, so it gets a
 * line of its own the moment it happens.
 */
export const STALL_MS = 45_000

/**
 * Words that belong to the connection rather than to a conversation. A log
 * line is written down only if it contains one of these.
 *
 * Every entry is a phrase this codebase actually logs (core.ts's relay and
 * re-dial lines, presence.ts's contact transitions, the rotation ticks). Kept
 * deliberately short: a line nobody planned for is a line that may carry
 * something private, and the cost of dropping it is a gap in a diary, not a
 * lost message.
 */
const LIFECYCLE = [
  'relay', 're-dial', 'redial', 'connection', 'node list', 'network',
  'presence', 'contact online', 'contact silent', 'watch', 'rotation', 'rotat',
  'session closing', 'offline', 'online', 'reconnect', 'transport', 'topic',
  'handshake', 'ratchet', 'mesh', 'subscribe', 'announce',
]

/** Is this log line about the connection? Unrecognised lines are dropped. */
export function isLifecycle(line: string): boolean {
  const l = line.toLowerCase()
  // A quoted string is how this app logs content ('sent "..."'), and no
  // connection line has ever needed one. Refused before the allowlist, so a
  // sentence that happens to contain "online" cannot ride in on it.
  if (l.includes('"')) return false
  return LIFECYCLE.some((w) => l.includes(w))
}

/** Whole seconds, for a diary a person reads. */
export const secs = (ms: number): string => `${Math.round(ms / 1000)}s`

export interface DiagOpts {
  /** Clock seam for tests. */
  now?: () => number
  /** Ring size; the default is a night with room to spare. */
  keep?: number
}

export interface Diag {
  /** Write an event down. */
  note(line: string): void
  /** Offer an app log line; kept only if `isLifecycle` says so. */
  fromLog(line: string): void
  /**
   * A sample from the periodic probe: how late this tick was. Past `STALL_MS`
   * it is written down immediately - that is the process having been stopped,
   * which is exactly what a summary five minutes later would blur away.
   */
  tick(lateMs: number): void
  /** Close the window: one summary line, counters reset. `extra` is whatever
   *  the caller can say about the transport right now. */
  summary(extra: string): void
  /** Lines written since the last take, and clear them - for the file sink. */
  take(): string[]
  /** Everything still in the ring, for the copy button. */
  all(): string[]
}

export function newDiag(opts: DiagOpts = {}): Diag {
  const now = opts.now ?? (() => Date.now())
  const keep = opts.keep ?? KEEP
  const ring: string[] = []
  let pending: string[] = []
  let worstLate = 0
  let ticks = 0

  const note = (line: string) => {
    const at = new Date(now()).toISOString().replace('T', ' ').slice(0, 19)
    const entry = `${at} ${line}`
    ring.push(entry)
    if (ring.length > keep) ring.splice(0, ring.length - keep)
    pending.push(entry)
  }

  return {
    note,
    fromLog(line) { if (isLifecycle(line)) note(`log ${line}`) },
    tick(lateMs) {
      ticks++
      if (lateMs > worstLate) worstLate = lateMs
      if (lateMs >= STALL_MS) note(`STALL the process was away for ${secs(lateMs)}`)
    },
    summary(extra) {
      note(`5m late=${secs(worstLate)} ticks=${ticks} ${extra}`.trim())
      worstLate = 0
      ticks = 0
    },
    take() { const out = pending; pending = []; return out },
    all() { return [...ring] },
  }
}
