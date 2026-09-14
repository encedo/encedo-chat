/**
 * webrtc-tauri.ts — the browser link's twin, with the DataChannel in Rust.
 *
 * WebKitGTK (the Linux desktop) has no `RTCPeerConnection`, so on that one
 * platform the channel lives in the Tauri host (`src-tauri/src/rtc.rs`,
 * webrtc-rs) and this module drives it through commands. It implements the
 * SAME `WebRTCLink` as `net/webrtc.ts`, byte for byte where it matters — the
 * channel label, the 0x00 0x50 / 0x00 0x4f liveness probe, `ready` only after
 * the round trip — so the plane, the room, the ratchet and the file transfer
 * cannot tell which of the two they are talking to. That is the whole point:
 * a Linux desktop and a browser meet on equal terms.
 *
 * Events come by POLLING (`rtc_poll`), at 20 ms while something is happening
 * and 100 ms when nothing is, which is how the rest of this shell talks to its
 * host. Content travels base64 inside JSON in both directions — one IPC call
 * per frame, and a third more bytes on the wire than the frame itself.
 */
import type { Signal, WebRTCLink, WebRTCOpts } from './webrtc.ts'

type Internals = { invoke: (cmd: string, args?: Record<string, unknown>) => Promise<any> }
const internals = (): Internals | undefined => (globalThis as any).__TAURI_INTERNALS__

/** Is the Rust channel there? Answered once per page load — it is a build fact. */
let avail: Promise<boolean> | null = null
export function tauriRtcAvailable(): Promise<boolean> {
  if (!avail) {
    const i = internals()
    avail = i ? i.invoke('rtc_available').then((v: any) => v === true).catch(() => false) : Promise.resolve(false)
  }
  return avail
}

/**
 * The host's own loopback: two connections in the Tauri process, a channel
 * between them, 64 KiB across. The Diagnostyka probe's `loopback` stage on
 * this platform — it needs no network and no peer, so a pass means the stack
 * works and a failure to reach a real peer is about the network.
 */
export async function tauriRtcSelftest(): Promise<{ bytes: number; ms: number }> {
  const i = internals()
  if (!i) throw new Error('not the desktop shell')
  const r = await i.invoke('rtc_selftest')
  return { bytes: Number(r?.bytes ?? 0), ms: Number(r?.ms ?? 0) }
}

const CTRL = 0x00
const PING = new Uint8Array([CTRL, 0x50])
const PONG = new Uint8Array([CTRL, 0x4f])
const HIGH_WATER = 8 * 1024 * 1024
const PROBE_TRIES = 4
const PROBE_EVERY_MS = 700
const POLL_BUSY_MS = 20
const POLL_IDLE_MS = 100

let nextId = 1

function toB64(bytes: Uint8Array): string {
  // In slices: String.fromCharCode over a 64 KiB array would spread 65 536
  // arguments onto the stack, which some engines refuse.
  let bin = ''
  for (let i = 0; i < bytes.length; i += 8192) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 8192) as unknown as number[])
  return btoa(bin)
}
function fromB64(s: string): Uint8Array {
  const bin = atob(s)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

export function webrtcLinkTauri(opts: WebRTCOpts): WebRTCLink {
  const i = internals()
  if (!i) throw new Error('not the desktop shell')
  const id = nextId++
  const call = <T = unknown>(cmd: string, args: Record<string, unknown> = {}) => i.invoke(cmd, { id, ...args }) as Promise<T>

  let ready = false
  let closed = false
  let opened = false
  // The browser link buffers ICE until a remote description exists, because
  // adding a candidate before it is an error there — and here too: webrtc-rs
  // refuses a candidate for a session it has not been told about. And every
  // command has to wait for rtc_create, since the plane may hand us an offer
  // in the same tick it built us.
  let remoteSet = false
  const pendingIce: Signal[] = []
  let created!: Promise<void>
  let buffered = 0
  let onLow: (() => void) | null = null
  let probeTimer: any = null
  let pollTimer: any = null
  let polling = false
  const stopProbe = () => { clearInterval(probeTimer); probeTimer = null }

  // base64 inside JSON, not a raw body. The raw path compiled and could not
  // be exercised by anything but a packaged app — where it turned out that
  // nothing ever left the webview. This costs a third more per chunk and
  // works on every IPC transport Tauri has, which is the trade the receive
  // side already makes.
  const sendRaw = (bytes: Uint8Array) => {
    if (closed) return
    void call('rtc_send', { b64: toB64(bytes) }).catch((e: any) => opts.onState?.(`send-failed: ${e?.message ?? e}`))
  }

  const startProbe = () => {
    let tries = 0
    const probe = () => {
      if (ready) return stopProbe()
      if (++tries > PROBE_TRIES) { stopProbe(); opts.onState?.('probe=failed'); return }
      sendRaw(PING)
    }
    probe()
    probeTimer = setInterval(probe, PROBE_EVERY_MS)
  }

  const handle = (ev: any) => {
    switch (ev.t) {
      case 'ice': opts.sendSignal({ kind: 'ice', candidate: ev.candidate }); return
      case 'state':
        opts.onState?.('conn=' + ev.conn)
        if (ev.conn === 'failed' || ev.conn === 'closed' || ev.conn === 'disconnected') {
          if (ready) { ready = false; opts.onClose?.() }
        }
        return
      case 'open': if (!opened) { opened = true; startProbe() }; return
      case 'close': stopProbe(); if (ready) { ready = false; opts.onClose?.() }; return
      case 'low': { const f = onLow; onLow = null; f?.(); return }
      case 'data': {
        const bytes = fromB64(ev.b64)
        // Same dispatch as the browser link: every 0x00 frame is control.
        if (bytes.length >= 2 && bytes[0] === CTRL) {
          if (bytes.length === 2 && bytes[1] === PING[1]) { sendRaw(PONG); return }
          if (bytes.length === 2 && bytes[1] === PONG[1] && !ready) {
            stopProbe(); ready = true
            opts.onState?.('probe=ok')
            opts.onOpen?.()
          } else if (bytes.length > 2) opts.onControl?.(bytes)
          return
        }
        opts.onData(bytes)
        return
      }
    }
  }

  // Adaptive polling: fast while events flow, slow when the link is idle.
  const schedule = (ms: number) => { clearTimeout(pollTimer); pollTimer = setTimeout(poll, ms); (pollTimer as any).unref?.() }
  const poll = async () => {
    if (closed || polling) return
    polling = true
    let busy = false
    try {
      const r = await call<{ events: any[]; buffered: number }>('rtc_poll')
      buffered = r.buffered
      const wasLow = buffered < HIGH_WATER
      for (const ev of r.events) handle(ev)
      busy = r.events.length > 0
      if (wasLow && onLow) { const f = onLow; onLow = null; f() }
    } catch (e: any) {
      if (!closed) opts.onState?.(`poll-failed: ${e?.message ?? e}`)
    } finally { polling = false }
    if (!closed) schedule(busy ? POLL_BUSY_MS : POLL_IDLE_MS)
  }

  // Create, and if we are the offering side, offer — the same order the
  // browser link follows, so signalling on the far end sees no difference.
  created = (async () => {
    try {
      await call('rtc_create', { initiator: opts.initiator, ice: (opts.iceServers ?? []).flatMap((s: any) => Array.isArray(s.urls) ? s.urls : [s.urls]) })
      schedule(POLL_BUSY_MS)
      if (opts.initiator) {
        const sdp = await call<string>('rtc_offer')
        opts.sendSignal({ kind: 'offer', sdp })
      }
    } catch (e: any) { opts.onState?.(`create-failed: ${e?.message ?? e}`) }
  })()
  const flushIce = async () => {
    remoteSet = true
    for (const sig of pendingIce.splice(0)) {
      if (sig.kind === 'ice') { try { await call('rtc_ice', { candidate: sig.candidate }) } catch (e: any) { opts.onState?.(`ice-add-failed: ${e?.message ?? e}`) } }
    }
  }

  return {
    get ready() { return ready },
    async handleSignal(sig: Signal) {
      try {
        await created
        if (closed) return
        if (sig.kind === 'offer') {
          const sdp = await call<string>('rtc_answer', { sdp: sig.sdp })
          opts.sendSignal({ kind: 'answer', sdp })
          await flushIce()
        } else if (sig.kind === 'answer') {
          await call('rtc_set_answer', { sdp: sig.sdp })
          await flushIce()
        } else if (sig.kind === 'ice') {
          if (remoteSet) await call('rtc_ice', { candidate: sig.candidate })
          else pendingIce.push(sig)
        }
      } catch (e: any) {
        opts.onState?.(`signal-failed(${sig.kind}): ${e?.message ?? e}`)
      }
    },
    send(bytes: Uint8Array) { if (ready) sendRaw(bytes) },
    sendControl(bytes: Uint8Array) { if (ready) sendRaw(bytes) },
    buffered() { return buffered },
    drain() {
      if (buffered < HIGH_WATER) return Promise.resolve()
      return new Promise<void>((res) => { onLow = res })
    },
    close() {
      closed = true
      stopProbe(); clearTimeout(pollTimer)
      if (ready) { ready = false; opts.onClose?.() }
      void call('rtc_close').catch(() => {})
    },
  }
}
