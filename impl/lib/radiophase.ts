/**
 * radiophase.ts — one radio wake for everything periodic.
 *
 * ## The cost being paid for
 *
 * On a phone, battery is not spent on bytes — it is spent on WAKES. A cellular
 * radio that has just transmitted stays in a high-power "tail" state for
 * seconds; traffic arriving every few seconds keeps it there continuously,
 * which is the single worst traffic shape mobile silicon knows. This client's
 * steady state is exactly that shape when left alone: one Announce per watched
 * contact per 15 s, the self-topic's, every open room's, a keepalive per
 * group — each on its own `setInterval`, phased by whenever it happened to be
 * created, so N topics meant up to N scattered wakes per cycle.
 *
 * ## What this module changes — and what it deliberately does not
 *
 * Every periodic PUBLISH aligns to one per-session phase: timers created here
 * fire at `phase + k|period`, so all publishers with the same period (and
 * they all use RADIO_TICK_MS) fire in the same instant — the frames leave in
 * one burst, the radio wakes once per cycle instead of N times. Nothing else
 * moves: same frames, same sizes, same 15 s cadence, nothing new on the wire.
 *
 * The phase is RANDOM PER SESSION, and that is load-bearing: aligned to the
 * wall clock instead, every client on the network would publish in the same
 * global instants and the relay would eat the whole userbase four times a
 * minute — the §5.4 midnight-rotation stampede in miniature. A random phase
 * gives this device one wake per cycle and gives the relay arrivals spread
 * exactly as they are today. It also inherits the job of grouproom's old
 * per-member jitter (members of one topic must not herd): members herd only
 * if they share a phase, and no two sessions do.
 *
 * Local bookkeeping (sweeps, link watches, rotation ticks) stays on plain
 * setInterval — it touches no radio, so aligning it buys nothing.
 */

export const RADIO_TICK_MS = 15_000

/** This session's slot inside the cycle. Random: see the herd note above. */
const radioPhase = Math.random() * RADIO_TICK_MS

/**
 * ## The screen-off profile
 *
 * A phone in a pocket does not need to say "still here" four times a minute.
 * `setRadioProfile('background')` stretches every timer created with
 * `slowable: true` to 4x its period — the watches (contact dots, the
 * self-topic) and the group keepalives ride it, so an idle backgrounded
 * phone wakes the radio once a minute instead of four times.
 *
 * What deliberately does NOT slow: the open rooms' announce heartbeats.
 * Their receivers time a peer out on the 35 s "quiet" and 90 s "leave"
 * thresholds, §5.5 carries no cadence field the sender could declare a
 * slowdown in (frozen spec), and a phone that flaps quiet/leave on every
 * lost frame is worse than the battery it saves. The watches' 90 s dot TTL
 * tolerates a 60 s cadence as-is; a single lost beacon can blink a dot for
 * under a minute, which is the price of the 4x and accepted (the user's
 * decision, 2026-09-02). Background periods are multiples of the base tick,
 * so slowed timers still land ON the shared grid — one wake carries whatever
 * is due.
 */
export type RadioProfile = 'active' | 'background'
let profile: RadioProfile = 'active'
const rearms = new Set<() => void>()

export function setRadioProfile(p: RadioProfile) {
  if (p === profile) return
  profile = p
  // Re-arm the slowable timers now: coming back to 'active', a timer armed
  // for a minute away would otherwise keep the dot dark long after unlock.
  for (const r of [...rearms]) r()
}

/**
 * A repeating timer that fires at `radioPhase + k|periodMs` instead of
 * "creation time + k|periodMs". Drop-in for the publish heartbeats'
 * setInterval; returns the stop function. The first fire comes within one
 * period (possibly almost immediately — callers already tolerate that, their
 * announces are nonce-deduped and their keepalives idempotent).
 * `slowable: true` opts the timer into the screen-off profile above.
 */
export function alignedTimer(
  fn: () => void,
  periodMs = RADIO_TICK_MS,
  opts: { slowable?: boolean } = {},
): () => void {
  let t: any
  let stopped = false
  const period = () => (opts.slowable && profile === 'background' ? periodMs * 4 : periodMs)
  const arm = () => {
    clearTimeout(t)
    const p = period()
    const into = (((Date.now() - radioPhase) % p) + p) % p
    t = setTimeout(() => {
      if (stopped) return
      try { fn() } catch {}
      arm()
    }, p - into || p)
    ;(t as any).unref?.()
  }
  arm()
  const rearm = () => { if (!stopped) arm() }
  if (opts.slowable) rearms.add(rearm)
  return () => { stopped = true; rearms.delete(rearm); clearTimeout(t) }
}
