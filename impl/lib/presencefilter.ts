/**
 * The contact list's presence filter: one button beside the search box that
 * steps All -> Online -> Offline -> All. Asked for 2026-11-09 by someone with
 * 20+ contacts of whom a handful are online at any time.
 *
 * Deliberately NOT remembered anywhere: every start is "all", so a list that
 * looks short is never a filter someone forgot they had set.
 */
export type PresenceFilter = 'all' | 'online' | 'offline'

export function nextPresenceFilter(f: PresenceFilter): PresenceFilter {
  return f === 'all' ? 'online' : f === 'online' ? 'offline' : 'all'
}

export interface PresenceRow {
  /** The row's dot is lit - green or orange (lib/dotstate.ts), grey is offline. */
  online: boolean
  /** Unread messages: the pill is how a background arrival is announced, so a
   *  filter must never hide it. */
  unseen: number
  /** The conversation open on screen: its row must not vanish from under the
   *  finger when the peer drops offline mid-chat. */
  active: boolean
}

export function presenceKeeps(f: PresenceFilter, r: PresenceRow): boolean {
  if (f === 'all' || r.unseen > 0 || r.active) return true
  return f === 'online' ? r.online : !r.online
}
