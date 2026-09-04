/**
 * eh2/establish.ts — driving the EH-2 handshake over a transport (§6.1, §6.2).
 *
 * The handshake is 1.5 round-trips of three frames. This module turns the two
 * state machines in eh2/handshake.ts into one push-driven object the room can
 * feed frames into as they arrive, with the ratchet already wired on the other
 * end. It does no I/O itself: `initial` is what to send now, `feed()` returns
 * what to send in reply, and `session` resolves when the conversation is safe
 * to use.
 *
 *   I: startHandshake({role:'initiator'})  -> initial [msg1]
 *      feed(msg2) -> msg3, session resolves (R authenticated by mac_r)
 *   R: startHandshake({role:'responder'})  -> initial []
 *      feed(msg1) -> msg2 (SK exists, but I is NOT yet authenticated)
 *      feed(msg3) -> null, session resolves
 *
 * **The gate (§6.2):** on the responder the `session` promise is what enforces
 * "no application data from I until mac_i verifies" — it simply does not exist
 * before then, so the room has nothing to decrypt with. `authenticated` exposes
 * the same fact for UI/telemetry.
 *
 * Who initiates is the caller's decision (the room already breaks that tie by
 * peer id for the WebRTC plane); both roles must be prepared for the peer to
 * have chosen the same, in which case one attempt fails and is retried.
 */

import type { Dh } from '../lib/x25519.ts'
import type { Session } from '../lib/session.ts'
import { ratchetFrom, type RatchetOpts } from './ratchet.ts'
import { mlkem768 } from './mlkem.ts'
import {
  initiate, initiatorComplete, respond, responderComplete,
  HandshakeError, type Kem, type InitiatorState, type ResponderState,
} from './handshake.ts'
import { T_MSG1, T_MSG2, T_MSG3 } from './wire.ts'

export interface Eh2Handshake {
  /** Frames to put on the wire immediately (initiator: msg1; responder: none). */
  readonly initial: Uint8Array[]
  /** Feed one inbound handshake frame -> a frame to send back, or null. */
  feed(frame: Uint8Array): Promise<Uint8Array | null>
  /** Resolves with the live Session once the handshake completes. */
  readonly session: Promise<Session>
  /** True once the PEER is authenticated (I: after msg2; R: after msg3). */
  readonly authenticated: boolean
}

export interface StartOpts {
  role: 'initiator' | 'responder'
  /** Our long-term identity key — the HEM's IK in production. */
  ik: Dh
  /** The peer's IK public (contact book). The responder resolves it from `initiator_id`. */
  peerIkPub: Uint8Array
  kem?: Kem
  ratchet?: RatchetOpts
  now?: () => number
}

/** Is this byte run an EH-2 handshake frame (as opposed to ratchet data)? */
export function isHandshakeFrame(frame: Uint8Array): boolean {
  return frame.length > 2 && (frame[0] === T_MSG1 || frame[0] === T_MSG2 || frame[0] === T_MSG3)
}

export async function startHandshake(opts: StartOpts): Promise<Eh2Handshake> {
  const kem = opts.kem ?? mlkem768
  const now = opts.now
  let authenticated = false
  let resolve!: (s: Session) => void
  let reject!: (e: unknown) => void
  const session = new Promise<Session>((res, rej) => { resolve = res; reject = rej })
  // The caller may await `session` later than a failure happens.
  session.catch(() => {})

  const toSession = async (result: Parameters<typeof ratchetFrom>[0]): Promise<Session> => {
    const r = await ratchetFrom(result, opts.ratchet)
    return { encrypt: (pt) => r.encrypt(pt), decrypt: (data) => r.decrypt(data) }
  }

  if (opts.role === 'initiator') {
    const started = await initiate({ ik: opts.ik, peerIkPub: opts.peerIkPub, kem, now: now?.() })
    let state: InitiatorState | null = started.state
    return {
      initial: [started.msg1],
      session,
      get authenticated() { return authenticated },
      async feed(frame) {
        if (!state) throw new HandshakeError('unexpected frame after the handshake completed')
        if (frame[0] !== T_MSG2) throw new HandshakeError(`initiator expected msg2, got frame type 0x${frame[0]?.toString(16)}`)
        try {
          const { msg3, result } = await initiatorComplete(state, frame, { now: now?.() })
          state = null
          authenticated = true // mac_r verified -> R holds IK_r_priv
          resolve(await toSession(result))
          return msg3
        } catch (e) {
          reject(e)
          throw e
        }
      },
    }
  }

  let pending: ResponderState | null = null
  return {
    initial: [],
    session,
    get authenticated() { return authenticated },
    async feed(frame) {
      try {
        if (!pending) {
          if (frame[0] !== T_MSG1) throw new HandshakeError(`responder expected msg1, got frame type 0x${frame[0]?.toString(16)}`)
          const r = await respond({ ik: opts.ik, peerIkPub: opts.peerIkPub, msg1: frame, kem, now: now?.() })
          pending = r.state
          return r.msg2 // SK exists — but I stays unauthenticated until msg3
        }
        if (frame[0] !== T_MSG3) throw new HandshakeError(`responder expected msg3, got frame type 0x${frame[0]?.toString(16)}`)
        const result = await responderComplete(pending, frame)
        pending = null
        authenticated = true
        resolve(await toSession(result))
        return null
      } catch (e) {
        reject(e)
        throw e
      }
    },
  }
}
