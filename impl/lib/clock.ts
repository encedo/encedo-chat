/**
 * clock.ts - the clock anchor (PROTOCOL.md 5.4).
 *
 * Every rendezvous derivation and every replay window reads the local clock,
 * and the local clock is whatever the device says. The daily rotation hides
 * ordinary skew under a 30-minute guard, the replay windows under +/-5 min
 * (S8); a clock off by more is a client in an empty room with nothing to say
 * why. The node already answers `/health` on every dial, and an HTTP answer
 * carries a `Date` header, so the one fact needed - how far this device's
 * clock is from the node's - is one round trip away.
 *
 * SNTP-style: the node's time is taken to be true at the midpoint of the
 * round trip, so offset = node_time - (sent + rtt/2). `Date` has one-second
 * resolution, so half a second is added to land in the middle of the second.
 * The result is a SOFT hint, clamped to +/-10 minutes: a node that is itself
 * wrong by hours must not drag every client with it, and a clamp that large
 * still covers every device clock seen in the wild. A round trip over 5 s
 * says nothing precise and is not used.
 *
 * What it changes: `nowMs()` in lib/time.ts, which the protocol reads for
 * Announce timestamps and their replay check, handshake timestamps, and the
 * rendezvous day. Timers, intervals and anything measuring a duration keep
 * `Date.now()`: an offset that moves must never stretch or shrink a wait.
 */

import { setClockOffset } from './time.ts'

export const MAX_ANCHOR_MS = 10 * 60_000
export const MAX_RTT_MS = 5_000

export interface Probe { dateHeader: string | null; sentAt: number; receivedAt: number }

/**
 * The offset to add to the local clock, or null when the probe says nothing
 * usable (no header, an unparsable one, a round trip too long to place it).
 */
export function offsetFromProbe(p: Probe): number | null {
  if (!p.dateHeader) return null
  const node = Date.parse(p.dateHeader)
  if (!Number.isFinite(node)) return null
  const rtt = p.receivedAt - p.sentAt
  if (rtt < 0 || rtt > MAX_RTT_MS) return null
  const localAtNode = p.sentAt + rtt / 2
  const off = node + 500 - localAtNode
  return Math.max(-MAX_ANCHOR_MS, Math.min(MAX_ANCHOR_MS, Math.round(off)))
}

/**
 * Ask the first node that answers, and set the clock offset from it. Returns
 * what was set, or null when no node gave a usable answer (the offset is then
 * left as it was - a lost probe must not reset a good anchor).
 */
export async function anchorClock(
  hosts: string[],
  o: { fetch?: typeof fetch; timeoutMs?: number; log?: (m: string) => void } = {},
): Promise<{ host: string; offsetMs: number } | null> {
  const f = o.fetch ?? fetch
  for (const host of [...new Set(hosts)].slice(0, 3)) {
    try {
      const sentAt = Date.now()
      const r = await f(`https://${host}/health`, { cache: 'no-store', signal: AbortSignal.timeout(o.timeoutMs ?? 6000) })
      const receivedAt = Date.now()
      const offsetMs = offsetFromProbe({ dateHeader: r.headers.get('date'), sentAt, receivedAt })
      if (offsetMs === null) continue
      setClockOffset(offsetMs)
      o.log?.(`clock: anchored to ${host}, local clock is ${offsetMs >= 0 ? 'behind' : 'ahead'} by ${Math.abs(offsetMs)} ms`)
      return { host, offsetMs }
    } catch { /* down, offline, or no CORS on an old node: try the next */ }
  }
  return null
}
