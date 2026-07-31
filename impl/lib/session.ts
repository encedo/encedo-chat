/**
 * session.ts — the message-crypto SEAM (interface layer).
 *
 * `Session` is the per-message crypto contract the room talks to: it only ever
 * calls encrypt/decrypt, never touching a key. That decoupling is the point —
 * room / envelope / transport do not know which scheme is underneath, so a new
 * one (a core-rs port, a future ratchet) drops in behind this exact interface
 * with zero change above it. Today there is one implementation, `eh2Session`;
 * the seam is kept deliberately for the next.
 *
 * History: an interim static-AES-GCM box lived here as a placeholder until EH-2
 * was blessed and wired in. It was removed once EH-2 became mandatory — see the
 * commit that deleted `lib/msgcrypto.ts` (`git log --grep=interim`).
 *
 * The application payload (the JSON envelope, lib/envelope.ts) is what gets
 * sealed; the Session owns its own wire format (for EH-2 that includes the
 * ratchet header — DH pub + counters — which the room never sees).
 */

import { ratchetFrom, type RatchetOpts } from '../eh2/ratchet.ts'
import type { HandshakeResult } from '../eh2/handshake.ts'

export interface Session {
  /** Seal an outgoing plaintext → wire bytes. May advance ratchet state (EH-2). */
  encrypt(plaintext: Uint8Array): Promise<Uint8Array>
  /** Open incoming wire bytes → plaintext, or null if not ours / undecryptable. */
  decrypt(data: Uint8Array): Promise<Uint8Array | null>
}

/**
 * EH-2 session — the handshake (§6) + Double Ratchet (§7), behind this exact
 * interface. Forward secrecy per message, post-compromise recovery on every
 * turn of the conversation, PQ-hybrid session key.
 *
 * Unlike the interim box, establishment is INTERACTIVE: three handshake frames
 * travel as a SEPARATE pre-session wire (not sealed envelopes — the session key
 * does not exist yet), and only then does a Session exist. That flow lives in
 * `eh2/establish.ts` (`startHandshake`), which hands back this Session with the
 * ratchet already wired; the per-message ratchet header rides inside this
 * Session's own wire, invisible to the room.
 */
export async function eh2Session(result: HandshakeResult, opts?: RatchetOpts): Promise<Session> {
  const r = await ratchetFrom(result, opts)
  return { encrypt: (plaintext) => r.encrypt(plaintext), decrypt: (data) => r.decrypt(data) }
}
