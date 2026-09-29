/**
 * dotstate.ts — what a contact's dot says, in one rule for the list and the header.
 *
 * Green used to mean "an EH-2 session exists", and a session outlives silence
 * on purpose (the ratchet is kept when a peer goes quiet, so it can come back
 * without a handshake). So green said nothing about whether anything arrives:
 * on 2026-09-29 dots stayed green on conversations that were deaf, and a green
 * dot is exactly what made "it looks fine" believable. Green now needs BOTH a
 * session and a peer that is answering right now.
 *
 *   ok      green   a secured channel AND the peer announcing (join/active/away)
 *   online  orange  the peer is announcing, no channel yet
 *   ''      grey    nobody answering - whether or not a channel exists
 *
 * `away` counts as present: a hidden tab still receives and acknowledges.
 * `quiet` (35 s without an Announce) and `leave` do not.
 */
export type Dot = 'ok' | 'online' | ''

export interface DotInput {
  /** The room holds a live EH-2 session with the peer. */
  secured: boolean
  /** The room's last presence event for the peer, or null if none yet. */
  presence: string | null | undefined
  /** A light presence watch hears the peer (contact list only). */
  announcing?: boolean
}

export function dotFor({ secured, presence, announcing = false }: DotInput): Dot {
  const present = !!presence && presence !== 'leave' && presence !== 'quiet'
  if (secured && present) return 'ok'
  if (present || announcing) return 'online'
  return ''
}
