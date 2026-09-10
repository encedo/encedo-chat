/**
 * seen.ts - when a contact was last heard from, and what that means.
 *
 * ## Why this exists
 *
 * A pair topic is derived from BOTH keys, so a contact who has ever announced
 * on it has proved they hold your key. The reverse is the interesting part: a
 * contact who has NEVER announced is either switched off, or holding a key that
 * no longer matches yours - and those two look identical on the wire.
 *
 * That ambiguity cost a day of misdiagnosis (2026-09-10): two machines sat in
 * their trays announcing into empty pair topics for 48 hours, each with a
 * perfectly grey dot beside a contact that could never light. Nothing in the
 * app said "this one has never once answered", because nothing was written
 * down.
 *
 * ## What it must not do
 *
 * It must not guess WHY. "Never heard from" is a fact; "the key is wrong" is a
 * conclusion the app is not entitled to draw about somebody who might simply be
 * on holiday. So the states below name what is known, and the remedy offered -
 * send them your code again - happens to fix both cases without accusing
 * anybody of either.
 *
 * Deleting is never automatic for the same reason: a fortnight offline and a
 * broken key are the same silence, and coming back from holiday to an emptied
 * contact list would be a far worse bug than the one this addresses.
 *
 * ## Where it is kept
 *
 * Deliberately NOT in the contact book. That book is a security artifact - it
 * is MAC'd, it can live in an HSM, and a HEM contact costs a device round trip
 * to rewrite. This is soft, disposable, per-device bookkeeping, so it lives in
 * its own key beside it and its loss costs nothing but a few days of "new"
 * badges.
 */

/** The record kept per contact. Short names: this map is written as JSON. */
export interface Seen {
  /** When the contact was added, or first noticed by a build that records it. */
  a?: number
  /** When they were last HEARD - a verified Announce, not a send of ours. */
  s?: number
}

/**
 * How long a contact may stay silent after being added before the app stops
 * calling it new and starts saying it has never answered.
 *
 * Three days, so that a weekend with the machine off raises nothing.
 */
export const COLD_AFTER_MS = 3 * 86_400_000

/**
 * The presence watch declares a contact gone after this much silence, so at the
 * moment it does, the last thing actually heard was about this long ago. Used
 * to stamp the going-dark transition honestly rather than as "now".
 */
export const PRESENCE_TTL_MS = 90_000

export type ContactState =
  | 'online' // announcing right now
  | 'new'    // added recently, not heard from yet - normal, and worth saying
  | 'cold'   // added a while ago, never once heard from - worth asking about
  | 'quiet'  // heard before, not now; the timestamp tells the rest

export function contactState(e: Seen | undefined, now: number, online: boolean): ContactState {
  if (online) return 'online'
  if (e?.s) return 'quiet'
  // No record of being added either: an older contact this build has not met
  // yet. Treated as new rather than cold - the app has only just started
  // keeping the record, and accusing a working contact of silence on its first
  // run would be its own bug.
  if (!e?.a) return 'new'
  return now - e.a >= COLD_AFTER_MS ? 'cold' : 'new'
}

export type SeenLabel =
  | { kind: 'never' }
  | { kind: 'today'; hhmm: string }
  | { kind: 'yesterday'; hhmm: string }
  | { kind: 'date'; hhmm: string; date: string }

/**
 * When they were last heard, in the reader's own clock and calendar.
 *
 * Parts rather than a sentence: "today" and "yesterday" are words, and words
 * belong to the translation layer, not to arithmetic. Everything here is LOCAL
 * time - this is a fact about the reader's day, not about the protocol, which
 * is UTC everywhere else.
 */
export function seenLabel(e: Seen | undefined, now: number): SeenLabel {
  if (!e?.s) return { kind: 'never' }
  const d = new Date(e.s)
  const hhmm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  const sameDay = (a: Date, b: Date) =>
    a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate()
  const today = new Date(now)
  if (sameDay(d, today)) return { kind: 'today', hhmm }
  const yesterday = new Date(now - 86_400_000)
  if (sameDay(d, yesterday)) return { kind: 'yesterday', hhmm }
  return { kind: 'date', hhmm, date: `${String(d.getDate()).padStart(2, '0')}.${String(d.getMonth() + 1).padStart(2, '0')}` }
}

/** Fold one heard-from moment into the record, keeping the later of the two. */
export function noteSeen(e: Seen | undefined, at: number): Seen {
  const cur = e ?? {}
  return { ...cur, a: cur.a ?? at, s: Math.max(cur.s ?? 0, at) }
}

/** Fold "this contact exists" in, without claiming it was ever heard. */
export function noteAdded(e: Seen | undefined, at: number): Seen {
  return { ...(e ?? {}), a: e?.a ?? at }
}
