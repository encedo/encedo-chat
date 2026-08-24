/**
 * edits.ts — when a correction may still replace what somebody said.
 *
 * Editing means something narrower here than it does in Signal or WhatsApp, and
 * the difference is not a gap to close later — it follows from the product. A
 * transcript on this system is ephemeral: it lives on the screens of the people
 * in the room and a reload takes it. So a correction can only reach a client
 * that is still holding the message it corrects, and "it did not apply" is an
 * ordinary outcome rather than an edge case.
 *
 * That is why editing is **1:1 only** (decided 2026-08-24). A 1:1 correction
 * rides the same delivery tracking a message does, so the sender is TOLD when it
 * did not land — "they still see the old text" — which is the one thing that
 * makes the feature honest. A group broadcast has no acknowledgements, so there
 * the sender could only be told "sent", and a correction nobody can vouch for is
 * worse than no correction: it invites you to believe you fixed something.
 *
 * The rules below are here rather than in the UI because they are the kind of
 * thing that gets re-derived slightly differently in two places.
 */

import { nowMs } from './time.ts'

/**
 * How long after sending a message its author may still correct it. Fifteen
 * minutes, as WhatsApp: long enough for a typo or a sentence that came out
 * wrong, short enough that nobody rewrites a conversation somebody else has
 * already read and moved on from.
 */
export const EDIT_WINDOW_MS = 15 * 60_000

/**
 * Extra slack allowed on the RECEIVING side. `ts` is the sender's clock (see
 * `lib/time.ts` — envelopes carry the sender's UTC ms), so a receiver enforcing
 * the window exactly would refuse honest corrections from a device whose clock
 * runs a few minutes ahead or behind. The window is a product rule, not a
 * security boundary; being generous by five minutes costs nothing it protects.
 */
export const EDIT_SKEW_MS = 5 * 60_000

/** May I still correct my own message, sent at `sentTs`? */
export const canEdit = (sentTs: number, now: number = nowMs()): boolean =>
  now - sentTs <= EDIT_WINDOW_MS && now - sentTs >= -EDIT_SKEW_MS

/**
 * Should an incoming correction be applied to the message it names?
 *
 * `target` is what we hold for that message id, or `undefined` when we hold
 * nothing — which is the common case after a reload, and is simply a correction
 * that arrives too late to have anything to change.
 *
 * The rule that matters is `mine`: a correction only ever rewrites the words of
 * the person who sent it. In a 1:1 that means an incoming edit may touch THEIR
 * messages and never ours — otherwise the other end of a conversation could
 * quietly rewrite what we are on record as having said.
 */
export function acceptEdit(target: { mine: boolean; ts: number } | undefined, now: number = nowMs()): boolean {
  if (!target) return false
  if (target.mine) return false // nobody edits our words but us
  return canEdit(target.ts, now)
}
