/**
 * eh2/native.ts - core-rs in the Tauri HOST (T15 stage 2), behind the same
 * Eh2Handshake / Session contracts as eh2/establish.ts and eh2/wasm.ts.
 *
 * Unlike eh2/wasm.ts (the module runs in the page, sharing its realm), here the
 * EH-2 handshake and the ratchet run in the native host PROCESS (core_native.rs,
 * Tauri commands). SK, the ML-KEM keys, the ephemeral DHs and every ratchet key
 * live there, so a webview compromise cannot read them - the boundary WASM in
 * the same page cannot give. The one DH with the identity key stays in the
 * webview (it holds the software key, or talks to the HEM): a command returns
 * the peer public key to DH against, the webview computes it and hands the 32
 * bytes back.
 *
 * Available only in a Tauri shell (desktop and Android). Bytes cross the IPC as
 * base64 TEXT, never raw Uint8Array - a raw invoke body becomes a JSON array on
 * Linux/Android and does not survive (CLAUDE.md). Selected by
 * setCoreBackend('native'); the web app offers it only inside the shell.
 */

import type { Eh2Handshake, StartOpts } from './establish.ts'
import type { Session } from '../lib/session.ts'
import { HandshakeError } from './handshake.ts'
import { T_MSG1, T_MSG2, T_MSG3 } from './wire.ts'
import { nowMs } from '../lib/time.ts'
import { b64, unb64 } from '../lib/wc.ts'

type Internals = { invoke: (cmd: string, args?: Record<string, unknown>) => Promise<any> }
const internals = (): Internals | undefined => (globalThis as any).__TAURI_INTERNALS__
/** True when a native host with the core commands is reachable. */
export const nativeCoreAvailable = (): boolean => typeof internals()?.invoke === 'function'

function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const i = internals()
  if (!i) throw new HandshakeError('native core: not running in a Tauri shell')
  return i.invoke(cmd, args ?? {}) as Promise<T>
}

/** A started handshake command: a handle and the base64 frame to send/DH. */
interface Started { handle: number; out: string }
/** A ratchet open result: status 0 = plaintext, 1 = not ours / tampered / replay. */
interface Opened { status: number; pt: string }

let versionChecked: Promise<void> | null = null
function ensureVersion(): Promise<void> {
  if (!versionChecked) {
    versionChecked = invoke<number>('core_version').then((v) => {
      if (v !== 3) throw new HandshakeError(`native core speaks wire version ${v}, this engine expects 3`)
    }).catch((e) => { versionChecked = null; throw e })
  }
  return versionChecked
}

/** Wrap a ratchet handle (in the host) as a Session. */
function sessionOf(handle: number, now: () => number): Session {
  return {
    async encrypt(plaintext: Uint8Array): Promise<Uint8Array> {
      const out = await invoke<string>('core_encrypt', { handle, now_ms: now(), pt: b64(plaintext) })
      return unb64(out)
    },
    async decrypt(frame: Uint8Array): Promise<Uint8Array | null> {
      const r = await invoke<Opened>('core_decrypt', { handle, now_ms: now(), frame: b64(frame) })
      return r.status === 0 ? unb64(r.pt) : null
    },
  }
}

/** The same push-driven handshake as eh2/establish.ts, computed in the host. */
export async function startHandshakeNative(opts: StartOpts): Promise<Eh2Handshake> {
  await ensureVersion()
  const now = opts.now ?? nowMs
  const r = opts.ratchet ?? {}
  const pqSteps = r.pqEverySteps ?? 0, pqMs = r.pqEveryMs ?? 0, maxSkip = r.maxSkipPerChain ?? 0
  const ikPubB64 = b64(opts.ik.pub)
  if (opts.peerIkPub.length !== 32) throw new HandshakeError('peer IK public key must be 32 B')
  if (opts.tagKey.length !== 32) throw new HandshakeError('initiator tag key must be 32 B')
  const peerB64 = b64(opts.peerIkPub), tagB64 = b64(opts.tagKey)

  let authenticated = false
  let resolve!: (s: Session) => void
  let reject!: (e: unknown) => void
  const session = new Promise<Session>((res, rej) => { resolve = res; reject = rej })
  session.catch(() => {})

  const toSession = async (handle: number): Promise<Session> => {
    const sh = await invoke<number>('core_session', { handle, pq_every_steps: pqSteps, pq_every_ms: pqMs, max_skip: maxSkip, now_ms: now() })
    return sessionOf(sh, now)
  }
  // The host names its errors; the duplicate-window ones get the same words the TS engine uses.
  const wrap = (e: any): HandshakeError => {
    const m = String(e?.message ?? e)
    if (m.includes('second-window')) return new HandshakeError('initiator tag is our own identity: a second window, not the contact')
    if (m.includes('not-the-contact')) return new HandshakeError('initiator tag does not match the contact')
    return new HandshakeError(m)
  }

  if (opts.role === 'initiator') {
    const s = await invoke<Started>('core_initiate', { ik_pub: ikPubB64, peer_ik_pub: peerB64, tag_key: tagB64, now_ms: now() }).catch((e) => { throw wrap(e) })
    const handle = s.handle
    let live = true
    return {
      initial: [unb64(s.out)],
      session,
      get authenticated() { return authenticated },
      async feed(frame) {
        if (!live) throw new HandshakeError('unexpected frame after the handshake completed')
        if (frame[0] !== T_MSG2) throw new HandshakeError(`initiator expected msg2, got frame type 0x${frame[0]?.toString(16)}`)
        try {
          const msg2 = b64(frame)
          const ekR = unb64(await invoke<string>('core_peer_ek', { handle, msg2 }))
          const dh2 = await opts.ik.dh(ekR)                 // DH(EK_r, IK_i): the identity backend's call
          const msg3 = await invoke<string>('core_initiator_complete', { handle, msg2, dh2: b64(dh2), now_ms: now() })
          dh2.fill(0)
          live = false
          authenticated = true
          resolve(await toSession(handle))
          return unb64(msg3)
        } catch (e) { const w = wrap(e); reject(w); throw w }
      },
    }
  }

  let handle = 0
  let done = false
  return {
    initial: [],
    session,
    get authenticated() { return authenticated },
    async feed(frame) {
      try {
        if (!handle) {
          if (frame[0] !== T_MSG1) throw new HandshakeError(`responder expected msg1, got frame type 0x${frame[0]?.toString(16)}`)
          const s = await invoke<Started>('core_respond', { ik_pub: ikPubB64, peer_ik_pub: peerB64, tag_key: tagB64, msg1: b64(frame), now_ms: now(), max_skew_ms: 0 })
          handle = s.handle
          const dh1 = await opts.ik.dh(unb64(s.out))        // DH(IK_r, EK_i): the identity backend's call
          const msg2 = await invoke<string>('core_responder_complete', { handle, dh1: b64(dh1) })
          dh1.fill(0)
          return unb64(msg2)                                 // SK exists in the host; I unauthenticated until msg3
        }
        if (done) throw new HandshakeError('unexpected frame after the handshake completed')
        if (frame[0] !== T_MSG3) throw new HandshakeError(`responder expected msg3, got frame type 0x${frame[0]?.toString(16)}`)
        await invoke('core_responder_finish', { handle, msg3: b64(frame) })
        done = true
        authenticated = true
        resolve(await toSession(handle))
        return null
      } catch (e) { const w = wrap(e); reject(w); throw w }
    },
  }
}
