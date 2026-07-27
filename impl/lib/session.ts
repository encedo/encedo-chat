/**
 * session.ts — the message-crypto SEAM (interface layer).
 *
 * `Session` is the per-message crypto contract the room talks to. It does NOT
 * know whether it's the interim static key or the real EH-2 ratchet — the room
 * only ever calls encrypt/decrypt on it. This is the seam that lets EH-2
 * (docs/PROTOCOL.md §6–7) drop in behind the SAME interface once the
 * cryptographer signs off, with zero change to room / envelope / transport.
 *
 *   today:    interimSession — static AES-GCM key from ss (no forward secrecy)
 *   tomorrow: eh2Session     — X3DH-style handshake + Double Ratchet (stubbed)
 *
 * The application payload (the JSON envelope, lib/envelope.ts) is what gets
 * sealed; the Session owns its own wire format (for EH-2 that includes the
 * ratchet header — DH pub + counters — which the room never sees).
 */

import { msgKeyFromSecret, seal, open } from './msgcrypto.ts'
import type { RvParams } from './rendezvous.ts'

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
 * EH-2 session — X3DH-style handshake + Double Ratchet (docs/PROTOCOL.md §6–7).
 * NOT IMPLEMENTED — held for the cryptographer's review of the design. Left as a
 * throwing stub so nothing depends on an un-reviewed scheme.
 *
 * When blessed, establishment is INTERACTIVE (unlike the interim's immediate key
 * derivation): it exchanges handshake frames over the room — a SEPARATE
 * pre-session wire (NOT a sealed envelope; the session key doesn't exist yet),
 * authenticated like Announce. After the handshake each message carries a
 * ratchet header (DH pub + PN + N) INSIDE this Session's own wire. So the EH-2
 * factory will need transport access + the peer's IK; the `Session` it returns
 * exposes exactly the encrypt/decrypt above — room/envelope/transport unchanged.
 */
export function eh2Session(): Promise<Session> {
  throw new Error('EH-2 not implemented — held for cryptographer review (docs/PROTOCOL.md §6–7)')
}
