/**
 * outbox.ts - the daemon's notification queue (CLI-PLAN.md stage 4b).
 *
 * The network stores nothing (instant-only), so a notification for somebody
 * who is not online waits HERE, on the bot's side, sealed to disk so a restart
 * or a reboot does not lose it, and goes out when they are online again.
 *
 * Rules, all decided by this class and nothing else:
 *   - oldest first, per recipient;
 *   - a time-to-live: an alert from yesterday is noise, not news - an expired
 *     entry is dropped (and reported), never delivered late;
 *   - coalescing by `key`: a waiting entry with the same recipient and key is
 *     REPLACED by the newest text and counts what it swallowed; and while the
 *     recipient is online, one message per key per `every` window - the rest
 *     merge into the next one (a brute-force run must not become 500 pings);
 *   - a cap per recipient: an absent admin cannot grow the queue for ever;
 *     the oldest goes first.
 * No I/O here: the daemon persists `entries` and does the sending.
 */

export interface Entry {
  qid: string
  to: string            // recipient pub
  text: string
  created: number       // when first queued (TTL counts from here)
  expires: number
  key?: string
  merged: number        // how many earlier ones this entry replaced
}

export const DEFAULT_TTL_MS = 24 * 3_600_000
export const DEFAULT_EVERY_MS = 60_000
export const CAP_PER_RECIPIENT = 100

/** The text that goes out: the newest, with what it swallowed said once. */
export const outgoingText = (e: Entry) => e.merged ? `${e.text} (+${e.merged} wcześniejszych)` : e.text

export class Outbox {
  entries: Entry[] = []
  private lastSent = new Map<string, number>()   // to|key -> when one went out
  private seq = 0
  constructor(entries: Entry[] = []) { this.entries = entries.slice() }

  /**
   * A new notification. Returns what happened to it: 'merged' into a waiting
   * one with the same key, or 'queued' as its own entry (possibly pushing the
   * oldest out - reported in `dropped`).
   */
  add(to: string, text: string, opts: { now: number; ttlMs?: number; key?: string }): { entry: Entry; how: 'queued' | 'merged'; dropped: Entry[] } {
    const now = opts.now, expires = now + (opts.ttlMs ?? DEFAULT_TTL_MS)
    if (opts.key) {
      const same = this.entries.find((e) => e.to === to && e.key === opts.key)
      if (same) {
        same.merged += 1; same.text = text; same.expires = Math.max(same.expires, expires)
        return { entry: same, how: 'merged', dropped: [] }
      }
    }
    const entry: Entry = { qid: `${now.toString(36)}-${(++this.seq).toString(36)}`, to, text, created: now, expires, key: opts.key, merged: 0 }
    this.entries.push(entry)
    const mine = this.entries.filter((e) => e.to === to)
    const dropped = mine.length > CAP_PER_RECIPIENT ? mine.slice(0, mine.length - CAP_PER_RECIPIENT) : []
    if (dropped.length) this.entries = this.entries.filter((e) => !dropped.includes(e))
    return { entry, how: 'queued', dropped }
  }

  /** Expired entries, removed and returned (for the log). */
  expire(now: number): Entry[] {
    const gone = this.entries.filter((e) => e.expires <= now)
    if (gone.length) this.entries = this.entries.filter((e) => e.expires > now)
    return gone
  }

  /**
   * What may go to `to` now, oldest first: everything without a key, and a
   * keyed entry only once its `every` window since the last one has passed.
   */
  due(to: string, now: number, everyMs = DEFAULT_EVERY_MS): Entry[] {
    return this.entries
      .filter((e) => e.to === to)
      .filter((e) => !e.key || now - (this.lastSent.get(`${to}|${e.key}`) ?? -Infinity) >= everyMs)
      .sort((a, b) => a.created - b.created)
  }

  /** Should a NEW keyed message to an online recipient wait (merge) instead of going now? */
  throttled(to: string, key: string | undefined, now: number, everyMs = DEFAULT_EVERY_MS): boolean {
    return !!key && now - (this.lastSent.get(`${to}|${key}`) ?? -Infinity) < everyMs
  }

  /** It was delivered: out of the queue, and its key's window starts now. */
  delivered(e: Entry | { to: string; key?: string; qid?: string }, now: number) {
    if (e.qid) this.entries = this.entries.filter((x) => x.qid !== e.qid)
    if (e.key) this.lastSent.set(`${e.to}|${e.key}`, now)
  }

  forRecipient(to: string): Entry[] { return this.entries.filter((e) => e.to === to) }
}
