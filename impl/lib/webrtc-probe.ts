/**
 * webrtc-probe.ts — does WebRTC actually work here, and if not, at which step.
 *
 * ## Why a name check is not an answer
 *
 * `capabilities.ts` asks `typeof RTCPeerConnection === 'function'` and that is
 * exactly the kind of test its own header warns about: a webview can expose the
 * constructor and then fail to negotiate anything. WebKitGTK is the case in
 * hand — the binding table carries `RTCPeerConnection`, `RTCDataChannel` and
 * `RTCIceCandidate`, so the cheap probe says yes, and whether a DataChannel
 * ever opens is a different question entirely. Answering it took a debugging
 * session once; this file makes it a button.
 *
 * ## The stages, and why each one is separate
 *
 * They fail apart, and which one fails is the whole diagnosis:
 *
 * 1. **construct** — the object exists and can be built. A webview compiled
 *    without the feature throws right here.
 * 2. **datachannel** — SCTP is wired up. Present in some builds that cannot
 *    negotiate.
 * 3. **sdp** — an offer is produced, and it describes what we need: a
 *    `m=application` section and a DTLS fingerprint. An offer without them is a
 *    stack that will never carry data.
 * 4. **ice** — the ICE agent runs and produces at least one HOST candidate,
 *    with no STUN server involved. This asks about the platform only.
 * 5. **loopback** — two peer connections in this very page complete a
 *    handshake and pass a byte over a DataChannel. **This is the answer.** It
 *    needs no network, no relay and no STUN, so it cannot be spoiled by a
 *    firewall: if it passes, the platform can do WebRTC, and any failure to
 *    reach a real peer is about the network. If it fails, no amount of
 *    networking will help.
 * 6. **stun** — a reflexive candidate from the SAME server the app uses. This
 *    one is about the NETWORK, not the platform, and it is reported as such: a
 *    machine that cannot reach a STUN server will talk through the relay even
 *    on a webview that does WebRTC perfectly.
 *
 * The split between 5 and 6 is the point of the whole file. "Direct does not
 * work" has two completely different causes and one symptom, and until now the
 * only way to tell them apart was to read a transport badge and guess.
 */

import { STUN_FALLBACK_HOST, STUN_PORT } from './ice.ts'

export interface ProbeStage {
  id: string
  /** What this step is about: the webview, or the network it sits on. */
  about: 'platform' | 'network'
  ok: boolean
  /** Wall time, so a stage that "worked" after eight seconds is visible as such. */
  ms: number
  error?: string
  /** What was found, when finding it is the interesting part. */
  detail?: string
}

export interface WebrtcProbeResult {
  /** The platform can carry a direct DataChannel (stages 1–5). */
  ok: boolean
  /** A reflexive address was found, so a direct link to a REMOTE peer is
   *  plausible from this network (stage 6). */
  reflexive: boolean
  stages: ProbeStage[]
}

/**
 * The STUN server this probe dials, when the caller does not name one.
 *
 * WARNING: It is only a fallback for a caller that has no node list to hand. The app
 * passes what it actually uses (`lib/ice.ts` derives it from the nodes, because
 * a node runs STUN as part of being a node) — probing a server the app does not
 * use would answer a question nobody asked, which is exactly what this constant
 * did while it named Google's.
 */
const DEFAULT_PROBE_STUN = `stun:${STUN_FALLBACK_HOST}:${STUN_PORT}`

const LOOPBACK_MS = 10_000
const ICE_MS = 4_000
const STUN_MS = 6_000

/**
 * What an offer says about the stack that produced it. Pure, so it is testable
 * where `RTCPeerConnection` does not exist — which is everywhere the unit
 * suite runs.
 */
export function inspectSdp(sdp: string): { app: boolean; dtls: boolean; ice: boolean } {
  return {
    app: /^m=application[ \t]/m.test(sdp),
    dtls: /^a=fingerprint:/m.test(sdp),
    ice: /^a=ice-ufrag:/m.test(sdp),
  }
}

/** Candidate types in an SDP or a candidate line, counted by kind. */
export function candidateTypes(lines: string[]): Record<string, number> {
  const out: Record<string, number> = {}
  for (const l of lines) {
    const m = /\btyp\s+(host|srflx|prflx|relay)\b/.exec(l)
    if (m) out[m[1]] = (out[m[1]] ?? 0) + 1
  }
  return out
}

const now = () => (typeof performance === 'object' ? performance.now() : Date.now())
const err = (e: any) => `${e?.name ?? 'Error'}: ${e?.message ?? e}`

/**
 * Run the whole thing. Never throws: a probe that fails to report is worse than
 * a missing feature, because it turns a diagnosis into a second bug.
 *
 * `onStage` fires as each step lands, so the UI fills in rather than sitting
 * blank for ten seconds — the loopback step alone can take several.
 */
export async function probeWebrtc(onStage?: (s: ProbeStage) => void, stun = DEFAULT_PROBE_STUN): Promise<WebrtcProbeResult> {
  const stages: ProbeStage[] = []
  const RTC = (globalThis as any).RTCPeerConnection as typeof RTCPeerConnection | undefined
  const open: RTCPeerConnection[] = []

  const run = async (id: string, about: 'platform' | 'network', fn: () => Promise<string | undefined>) => {
    const t0 = now()
    let s: ProbeStage
    try {
      const detail = await fn()
      s = { id, about, ok: true, ms: Math.round(now() - t0), detail }
    } catch (e: any) {
      s = { id, about, ok: false, ms: Math.round(now() - t0), error: err(e) }
    }
    stages.push(s); onStage?.(s)
    return s.ok
  }
  const skip = (id: string, about: 'platform' | 'network', why: string) => {
    const s: ProbeStage = { id, about, ok: false, ms: 0, error: why }
    stages.push(s); onStage?.(s)
  }

  try {
    if (typeof RTC !== 'function') {
      skip('construct', 'platform', 'RTCPeerConnection nie istnieje w tym webview')
      for (const id of ['datachannel', 'sdp', 'ice', 'loopback']) skip(id, 'platform', 'pominięte — brak RTCPeerConnection')
      skip('stun', 'network', 'pominięte — brak RTCPeerConnection')
      return { ok: false, reflexive: false, stages }
    }

    let pc: RTCPeerConnection | null = null
    let ch: RTCDataChannel | null = null
    let offer: RTCSessionDescriptionInit | null = null

    const built = await run('construct', 'platform', async () => {
      pc = new RTC({ iceServers: [] }); open.push(pc)
      return undefined
    })
    if (!built) {
      for (const id of ['datachannel', 'sdp', 'ice', 'loopback']) skip(id, 'platform', 'pominięte — nie udało się utworzyć połączenia')
      skip('stun', 'network', 'pominięte')
      return { ok: false, reflexive: false, stages }
    }

    const hasChannel = await run('datachannel', 'platform', async () => {
      ch = pc!.createDataChannel('onchato-probe') // the label the app uses, near enough
      return `label=${ch.label}`
    })

    const hasSdp = hasChannel && await run('sdp', 'platform', async () => {
      offer = await pc!.createOffer()
      await pc!.setLocalDescription(offer)
      const i = inspectSdp(offer.sdp ?? '')
      if (!i.app) throw new Error('oferta nie ma sekcji m=application (brak SCTP)')
      if (!i.dtls) throw new Error('oferta nie ma odcisku DTLS (a=fingerprint)')
      if (!i.ice) throw new Error('oferta nie ma poświadczeń ICE (a=ice-ufrag)')
      return 'm=application + DTLS + ICE'
    })

    // Host candidates only — no STUN in the config, so anything that shows up
    // was produced by the ICE agent from local interfaces. A platform answer.
    if (hasSdp) {
      await run('ice', 'platform', async () => {
        const seen = await gather(pc!, ICE_MS)
        const types = candidateTypes(seen)
        if (!seen.length) throw new Error('ICE nie wyprodukowało ani jednego kandydata')
        return Object.entries(types).map(([k, v]) => `${v}x ${k}`).join(', ')
      })
    } else {
      skip('ice', 'platform', 'pominięte — brak poprawnej oferty')
    }

    // The one that decides. Two connections in this page, no network at all.
    if (hasSdp) {
      await run('loopback', 'platform', async () => await loopback(RTC, open))
    } else {
      skip('loopback', 'platform', 'pominięte — brak poprawnej oferty')
    }

    // And the network question, kept apart from every platform one above.
    await run('stun', 'network', async () => {
      const p = new RTC({ iceServers: [{ urls: stun }] }); open.push(p)
      p.createDataChannel('stun-probe')
      await p.setLocalDescription(await p.createOffer())
      const seen = await gather(p, STUN_MS, (c) => /\btyp\s+srflx\b/.test(c))
      const types = candidateTypes(seen)
      if (!types.srflx) throw new Error(`brak adresu odbitego od ${stun} — sieć albo zapora blokuje STUN`)
      return `${types.srflx}x srflx`
    })
  } finally {
    for (const p of open) { try { p.close() } catch {} }
  }

  const platform = stages.filter((s) => s.about === 'platform')
  return {
    ok: platform.length > 0 && platform.every((s) => s.ok),
    reflexive: stages.some((s) => s.id === 'stun' && s.ok),
    stages,
  }
}

/**
 * Collect ICE candidates until gathering ends, `want` is satisfied, or the
 * budget runs out. A timeout is not a failure by itself — several stacks never
 * deliver the terminating null — so what was collected is returned either way
 * and the caller decides whether it was enough.
 */
function gather(pc: RTCPeerConnection, budgetMs: number, want?: (c: string) => boolean): Promise<string[]> {
  return new Promise((resolve) => {
    const seen: string[] = []
    const done = () => { pc.onicecandidate = null; clearTimeout(timer); resolve(seen) }
    const timer = setTimeout(done, budgetMs)
    pc.onicecandidate = (ev) => {
      if (!ev.candidate) return done() // end of gathering
      const c = ev.candidate.candidate
      if (c) seen.push(c)
      if (want && c && want(c)) done()
    }
  })
}

/**
 * Two peer connections in one page, joined to each other by hand, passing one
 * byte over a DataChannel.
 *
 * No STUN and no relay: the candidates are local interfaces, so this says
 * whether the WEBVIEW can do WebRTC and nothing about the network. That
 * separation is the reason the probe exists.
 */
async function loopback(RTC: typeof RTCPeerConnection, open: RTCPeerConnection[]): Promise<string> {
  const a = new RTC({ iceServers: [] }); open.push(a)
  const b = new RTC({ iceServers: [] }); open.push(b)
  // Trickle both ways. `addIceCandidate` before a remote description throws on
  // some stacks, so anything early is queued rather than dropped.
  const queued: RTCIceCandidate[] = []
  let bReady = false
  a.onicecandidate = (e) => { if (e.candidate) void b.addIceCandidate(e.candidate).catch(() => {}) }
  b.onicecandidate = (e) => {
    if (!e.candidate) return
    if (bReady) void a.addIceCandidate(e.candidate).catch(() => {})
    else queued.push(e.candidate)
  }

  const ch = a.createDataChannel('onchato-probe')
  const opened = new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(
      `DataChannel nie otworzył się w ${LOOPBACK_MS / 1000} s (a=${a.iceConnectionState}/${a.connectionState}, b=${b.iceConnectionState}/${b.connectionState})`)), LOOPBACK_MS)
    // Both halves: an open channel that cannot carry a byte is a stack that
    // negotiated and then swallowed the data — which is a real failure mode,
    // and `onopen` alone has lied in this project before (see `webrtc-plane`).
    b.ondatachannel = (ev) => {
      ev.channel.onmessage = (m) => {
        clearTimeout(timer)
        resolve(typeof m.data === 'string' ? `przeszło ${m.data.length} B` : 'przeszły bajty')
      }
    }
    ch.onopen = () => { try { ch.send('onchato') } catch (e) { clearTimeout(timer); reject(e) } }
  })

  await a.setLocalDescription(await a.createOffer())
  await b.setRemoteDescription(a.localDescription!)
  bReady = true
  for (const c of queued) void a.addIceCandidate(c).catch(() => {})
  await b.setLocalDescription(await b.createAnswer())
  await a.setRemoteDescription(b.localDescription!)
  return await opened
}

/** One line per stage — for the log, and for pasting into a bug report. */
export function formatWebrtcProbe(r: WebrtcProbeResult): string {
  const line = (s: ProbeStage) =>
    `${s.ok ? '[ok]' : '[fail]'} ${s.id} [${s.about}] ${s.ms} ms`
    + (s.detail ? ` — ${s.detail}` : '')
    + (s.error ? ` — ${s.error}` : '')
  return [
    `webrtc: platforma ${r.ok ? 'UMIE' : 'NIE UMIE'}; adres odbity ${r.reflexive ? 'jest' : 'brak'}`,
    ...r.stages.map(line),
  ].join('\n')
}
