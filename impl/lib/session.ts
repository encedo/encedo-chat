/**
 * session.ts — the message-crypto SEAM (interface layer).
 *
 * `Session` is the per-message crypto contract the room talks to. It does NOT
 * know whether it's the interim static key or the real EH-2 ratchet — the room
 * only ever calls encrypt/decrypt on it. This is the seam that lets EH-2
 * (docs/PROTOCOL.md §6–7) drop in behind the SAME interface once the
 * cryptographer signs off, with zero change to room / envelope / transport.
 *
 *   interimSession — static AES-GCM key from ss (no forward secrecy); still the
 *                    scheme the live room uses until the EH-2 path is wired in
 *   eh2Session     — EH-2 handshake + Double Ratchet (eh2/), the real thing
 *
 * The application payload (the JSON envelope, lib/envelope.ts) is what gets
 * sealed; the Session owns its own wire format (for EH-2 that includes the
 * ratchet header — DH pub + counters — which the room never sees).
 */

import { msgKeyFromSecret, seal, open } from './msgcrypto.ts'
import type { RvParams } from './rendezvous.ts'
import { ratchetFrom, type RatchetOpts } from '../eh2/ratchet.ts'
import type { HandshakeResult } from '../eh2/handshake.ts'

export interface Session {
  /** Seal an outgoing plaintext → wire bytes. May advance ratchet state (EH-2). */
  encrypt(plaintext: Uint8Array): Promise<Uint8Array>
  /** Open incoming wire bytes → plaintext, or null if not ours / undecryptable. */
  decrypt(data: Uint8Array): Promise<Uint8Array | null>
}

/**
 * Interim session: a static AES-256-GCM key derived from the pair secret ss.
 * Stateless, no handshake, no forward secrecy — but already behind the Session
 * interface, so the room is decoupled from the scheme. ⚠️ Placeholder until EH-2.
 */
export async function interimSession(ss: Uint8Array, p: RvParams): Promise<Session> {
  const key = await msgKeyFromSecret(ss, p)
  return {
    encrypt: (plaintext) => seal(plaintext, key),
    decrypt: (data) => open(data, key),
  }
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
