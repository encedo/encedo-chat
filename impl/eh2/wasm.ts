/**
 * eh2/wasm.ts - the EH-2 handshake and the ratchet from core-rs (the Rust
 * crate at /core-rs, built to impl/core-wasm/core.wasm), behind the same
 * `Eh2Handshake` / `Session` contracts as eh2/establish.ts and eh2/ratchet.ts.
 *
 * What moves out of the JS heap: EK, the ML-KEM keys, SK, the root and chain
 * keys and every message key - they live in the module's linear memory and
 * are zeroed there. What stays with the host: the identity key's one DH per
 * handshake (the HSM's, or a software key's), which this adapter asks `ik.dh`
 * for and hands in as 32 bytes, exactly as the TS state machine does.
 *
 * The ABI is flat C (core-rs/src/ffi.rs): inputs are written into memory the
 * module allocates, outputs are read back from one per-call buffer. No
 * wasm-bindgen, so the build is one `cargo build` and the bytes are
 * reproducible from the pinned toolchain (core-rs/build.sh).
 *
 * Selection: `setCoreBackend('wasm')` (eh2/establish.ts), the default of both
 * front-ends since 0.7.21; `?core=ts` in the web app and `--core ts` in the
 * terminal client select the TS engine, and a platform that cannot load the
 * module falls back to it.
 */

import type { Eh2Handshake, StartOpts } from './establish.ts'
import type { Session } from '../lib/session.ts'
import { HandshakeError } from './handshake.ts'
import { T_MSG1, T_MSG2, T_MSG3 } from './wire.ts'
import { nowMs } from '../lib/time.ts'

interface Exports {
  memory: WebAssembly.Memory
  ec_alloc(len: number): number
  ec_free(ptr: number, len: number): void
  ec_out_ptr(): number; ec_out_len(): number
  ec_err_ptr(): number; ec_err_len(): number
  ec_drop(h: number): void
  ec_version(): number
  ec_hs_initiate(ik: number, peer: number, tag: number, now: number): number
  ec_hs_peer_ek(h: number, msg2: number, len: number): number
  ec_hs_initiator_complete(h: number, msg2: number, len: number, dh2: number, now: number): number
  ec_hs_respond(ik: number, peer: number, tag: number, msg1: number, len: number, now: number, skew: number): number
  ec_hs_responder_complete(h: number, dh1: number): number
  ec_hs_responder_finish(h: number, msg3: number, len: number): number
  ec_session(h: number, pqSteps: number, pqMs: number, maxSkip: number, now: number): number
  ec_rt_encrypt(h: number, now: number, pt: number, len: number): number
  ec_rt_decrypt(h: number, now: number, frame: number, len: number): number
  ec_rt_stats(h: number): number
}

/** A loaded module and the few helpers that move bytes across. */
export class Core {
  private x: Exports
  constructor(instance: WebAssembly.Instance) { this.x = instance.exports as unknown as Exports }
  get version(): number { return this.x.ec_version() }
  /** Copy `b` into module memory; returns [ptr, len]. Free with `free`. */
  put(b: Uint8Array): [number, number] {
    const ptr = this.x.ec_alloc(b.length)
    new Uint8Array(this.x.memory.buffer, ptr, b.length).set(b)
    return [ptr, b.length]
  }
  free([ptr, len]: [number, number]): void { this.x.ec_free(ptr, len) }
  /** The per-call output buffer, copied out (the next call overwrites it). */
  out(): Uint8Array { return new Uint8Array(this.x.memory.buffer, this.x.ec_out_ptr(), this.x.ec_out_len()).slice() }
  err(): string { return new TextDecoder().decode(new Uint8Array(this.x.memory.buffer, this.x.ec_err_ptr(), this.x.ec_err_len())) }
  /** Run `f` with the given inputs placed in memory, freeing them after. */
  with<T>(inputs: Uint8Array[], f: (ptrs: [number, number][]) => T): T {
    const ptrs = inputs.map((b) => this.put(b))
    try { return f(ptrs) } finally { for (const p of ptrs) this.free(p) }
  }
  get exports(): Exports { return this.x }
}

let loaded: Promise<Core> | null = null

/** Load the module once (from `bytes`, or from impl/core-wasm/core.wasm beside this file). */
export function loadCore(bytes?: Uint8Array): Promise<Core> {
  if (!loaded) loaded = instantiate(bytes).catch((e) => { loaded = null; throw e })
  return loaded
}

async function instantiate(bytes?: Uint8Array): Promise<Core> {
  const url = new URL('../core-wasm/core.wasm', import.meta.url)
  if (!bytes) {
    if (typeof process !== 'undefined' && (process as any).versions?.node) {
      const fs = await import('node:fs')
      bytes = new Uint8Array(fs.readFileSync(url))
    } else if (url.protocol === 'data:') {
      // The web bundle inlines the module (webpack.config.cjs), so it is under
      // the bundle's SRI. Decoded here rather than fetched: the page's CSP
      // allows no data: in connect-src, and does not need to.
      const b64 = url.href.slice(url.href.indexOf(',') + 1)
      bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))
    } else {
      bytes = new Uint8Array(await (await fetch(url)).arrayBuffer())
    }
  }
  let memory: WebAssembly.Memory | null = null
  const imports = {
    env: {
      random_fill(ptr: number, len: number) {
        // The host's CSPRNG, typed by purpose on the Rust side (rng.rs).
        crypto.getRandomValues(new Uint8Array(memory!.buffer, ptr, len))
      },
    },
  }
  const { instance } = await WebAssembly.instantiate(bytes, imports)
  memory = instance.exports.memory as WebAssembly.Memory
  const core = new Core(instance)
  if (core.version !== 3) throw new Error(`core.wasm speaks wire version ${core.version}, this engine expects 3`)
  return core
}

const registry = typeof FinalizationRegistry !== 'undefined'
  ? new FinalizationRegistry<{ core: Core; h: number }>(({ core, h }) => { try { core.exports.ec_drop(h) } catch {} })
  : null

function fail(core: Core, rc: number): never {
  throw new HandshakeError(core.err() || `core returned ${rc}`)
}

/** Wrap a ratchet handle as a `Session`. */
function sessionOf(core: Core, h: number, now: () => number): Session & { stats(): { nSend: number; nRecv: number; skipped: number; pqOutstanding: boolean; pqSteps: number; dhPub: string | null }; free(): void } {
  const x = core.exports
  const token = { core, h }
  const s = {
    async encrypt(plaintext: Uint8Array): Promise<Uint8Array> {
      return core.with([plaintext], ([[p, n]]) => {
        const rc = x.ec_rt_encrypt(h, now(), p, n)
        if (rc !== 0) throw new Error('ratchet: ' + core.err())
        return core.out()
      })
    },
    async decrypt(frame: Uint8Array): Promise<Uint8Array | null> {
      return core.with([frame], ([[p, n]]) => {
        const rc = x.ec_rt_decrypt(h, now(), p, n)
        if (rc === 0) return core.out()
        if (rc === 1) return null
        throw new Error('ratchet: ' + core.err())
      })
    },
    stats() {
      if (x.ec_rt_stats(h) !== 0) throw new Error('ratchet: ' + core.err())
      const [a, b, c, d, e, pub] = new TextDecoder().decode(core.out()).split(' ')
      return { nSend: +a, nRecv: +b, skipped: +c, pqOutstanding: d === '1', pqSteps: +e, dhPub: pub || null }
    },
    free() { registry?.unregister(token); x.ec_drop(h) },
  }
  registry?.register(s, { core, h }, token)
  return s
}

/**
 * The push-driven handshake of eh2/establish.ts, computed in the module.
 * Same frames, same gate: the responder's `session` resolves only after
 * mac_i verifies (the handle holds no ratchet before `ec_session`).
 */
export async function startHandshakeWasm(opts: StartOpts): Promise<Eh2Handshake> {
  const core = await loadCore()
  const x = core.exports
  const now = opts.now ?? nowMs
  const r = opts.ratchet ?? {}
  const pqSteps = r.pqEverySteps ?? 0, pqMs = r.pqEveryMs ?? 0, maxSkip = r.maxSkipPerChain ?? 0
  const ikPub = opts.ik.pub
  if (opts.peerIkPub.length !== 32) throw new HandshakeError('peer IK public key must be 32 B')
  if (opts.tagKey.length !== 32) throw new HandshakeError('initiator tag key must be 32 B')
  let authenticated = false
  let resolve!: (s: Session) => void
  let reject!: (e: unknown) => void
  const session = new Promise<Session>((res, rej) => { resolve = res; reject = rej })
  session.catch(() => {})
  const toSession = (h: number): Session => {
    const sh = x.ec_session(h, pqSteps, pqMs, maxSkip, now())
    if (sh <= 0) fail(core, sh)
    return sessionOf(core, sh, now)
  }

  if (opts.role === 'initiator') {
    const h = core.with([ikPub, opts.peerIkPub, opts.tagKey], ([[a], [b], [c]]) => x.ec_hs_initiate(a, b, c, now()))
    if (h <= 0) fail(core, h)
    const msg1 = core.out()
    let live = true
    return {
      initial: [msg1],
      session,
      get authenticated() { return authenticated },
      async feed(frame) {
        if (!live) throw new HandshakeError('unexpected frame after the handshake completed')
        if (frame[0] !== T_MSG2) throw new HandshakeError(`initiator expected msg2, got frame type 0x${frame[0]?.toString(16)}`)
        try {
          const rc = core.with([frame], ([[p, n]]) => x.ec_hs_peer_ek(h, p, n))
          if (rc !== 0) fail(core, rc)
          const dh2 = await opts.ik.dh(core.out())          // DH(EK_r, IK_i): the identity backend's call
          const rc2 = core.with([frame, dh2], ([[p, n], [d]]) => x.ec_hs_initiator_complete(h, p, n, d, now()))
          dh2.fill(0)
          if (rc2 !== 0) fail(core, rc2)
          const msg3 = core.out()
          live = false
          authenticated = true
          resolve(toSession(h))
          return msg3
        } catch (e) { reject(e); throw e }
      },
    }
  }

  let h = 0
  let done = false
  return {
    initial: [],
    session,
    get authenticated() { return authenticated },
    async feed(frame) {
      try {
        if (!h) {
          if (frame[0] !== T_MSG1) throw new HandshakeError(`responder expected msg1, got frame type 0x${frame[0]?.toString(16)}`)
          const rc = core.with([ikPub, opts.peerIkPub, opts.tagKey, frame], ([[a], [b], [c], [p, n]]) => x.ec_hs_respond(a, b, c, p, n, now(), 0))
          if (rc <= 0) fail(core, rc)
          h = rc
          const dh1 = await opts.ik.dh(core.out())         // DH(IK_r, EK_i): the identity backend's call
          const rc2 = core.with([dh1], ([[d]]) => x.ec_hs_responder_complete(h, d))
          dh1.fill(0)
          if (rc2 !== 0) fail(core, rc2)
          return core.out()                                 // msg2: SK exists, I is not yet authenticated
        }
        if (done) throw new HandshakeError('unexpected frame after the handshake completed')
        if (frame[0] !== T_MSG3) throw new HandshakeError(`responder expected msg3, got frame type 0x${frame[0]?.toString(16)}`)
        const rc = core.with([frame], ([[p, n]]) => x.ec_hs_responder_finish(h, p, n))
        if (rc !== 0) fail(core, rc)
        done = true
        authenticated = true
        resolve(toSession(h))
        return null
      } catch (e) { reject(e); throw e }
    },
  }
}
