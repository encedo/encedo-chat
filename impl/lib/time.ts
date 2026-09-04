/**
 * time.ts — time helpers. One source of truth for both CLI and web.
 *
 * CONVENTION, in two halves that must not be confused:
 *
 * **Everything the protocol computes on is UTC.** `ts` fields on the wire are
 * Unix epoch milliseconds — epoch is UTC, it has no timezone — and the day
 * arithmetic below (topic rotation, §5.4) runs in UTC on every machine, which
 * is the whole reason two peers derive the same topic. Nothing here may quietly
 * become local: a local-time rendezvous day would put two people in different
 * rooms and look like a broken relay.
 *
 * **Everything shown to a PERSON is their own clock** (`localHHMM`). A message
 * timestamp is read against the reader's wall clock, so a bubble stamped in UTC
 * is simply wrong for most of the world — it was reported as messages arriving
 * "two hours ago". The conversion is free (`new Date(ts)` already renders in
 * the machine's zone) and the zone stays on the device: a timezone is a hint
 * about where somebody is, and it must never reach an envelope.
 *
 * Two places keep the UTC form on purpose, because they are ABOUT UTC or about
 * comparing machines: the room-rotation countdown (§5.4 is defined against UTC
 * midnight) and `?debug=1` protocol logs.
 */

export const nowMs = (): number => Date.now() // Unix epoch ms (UTC)

const p2 = (n: number): string => String(n).padStart(2, '0')

/** "HH:MM" in UTC. */
export const utcHHMM = (ts: number): string => {
  const d = new Date(ts)
  return `${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}`
}

/** "HH:MM" on the reader's own clock — the form a person is shown (see above). */
export const localHHMM = (ts: number): string => {
  const d = new Date(ts)
  return `${p2(d.getHours())}:${p2(d.getMinutes())}`
}

/** "HH:MM:SS" in UTC. */
export const utcHHMMSS = (ts: number): string => `${utcHHMM(ts)}:${p2(new Date(ts).getUTCSeconds())}`

/** ISO-8601 in UTC, e.g. 2026-07-27T12:34:56.000Z. */
export const utcISO = (ts: number): string => new Date(ts).toISOString()

// ---- UTC day arithmetic (topic rotation lives on it) -----------------------

/** "YYYY-MM-DD" (UTC) for an epoch-ms instant. */
export const utcDateOf = (ts: number): string => new Date(ts).toISOString().slice(0, 10)

/** Shift a "YYYY-MM-DD" by whole days, staying in UTC. */
export const addUTCDays = (date: string, days: number): string =>
  new Date(Date.parse(date + 'T00:00:00Z') + days * 86_400_000).toISOString().slice(0, 10)

/** ms from `ts` until the next UTC midnight (0 < n <= 86_400_000). */
export const msToNextUTCMidnight = (ts: number): number => {
  const d = new Date(ts)
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1) - ts
}

/** ms since the previous UTC midnight (0 <= n < 86_400_000). */
export const msSincePrevUTCMidnight = (ts: number): number => {
  const d = new Date(ts)
  return ts - Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())
}
