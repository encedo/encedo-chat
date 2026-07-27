/**
 * time.ts — time helpers. CONVENTION: all timestamps are UTC, always.
 *
 * `ts` fields on the wire are Unix epoch milliseconds — epoch is UTC, it has no
 * timezone. Human-facing time is formatted in UTC here (getUTC… and toISOString),
 * NEVER in the machine's local time. One source of truth for both CLI and web.
 */

export const nowMs = (): number => Date.now() // Unix epoch ms (UTC)

const p2 = (n: number): string => String(n).padStart(2, '0')

/** "HH:MM" in UTC. */
export const utcHHMM = (ts: number): string => {
  const d = new Date(ts)
  return `${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}`
}

/** "HH:MM:SS" in UTC. */
export const utcHHMMSS = (ts: number): string => `${utcHHMM(ts)}:${p2(new Date(ts).getUTCSeconds())}`

/** ISO-8601 in UTC, e.g. 2026-07-27T12:34:56.000Z. */
export const utcISO = (ts: number): string => new Date(ts).toISOString()
