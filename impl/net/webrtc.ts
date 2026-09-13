/**
 * webrtc.ts — browser WebRTC DataChannel link (the §13 direct data plane).
 *
 * Raw `RTCPeerConnection` + a single DataChannel. Signaling (SDP offer/answer +
 * ICE) is delivered OUT OF BAND by the caller — we carry it over GossipSub. This
 * is the v5-proven approach and deliberately NOT libp2p's `/webrtc` transport
 * (that signals over circuit-relay-v2, which is broken on our libp2p 2.2.x
 * stack). Browser-only. Content over the DataChannel is relay-blind (direct P2P;
 * peers see each other's IPs — that's the "direct"/P1 mode).
 */

export type Signal =
  | { kind: 'offer'; sdp: string }
  | { kind: 'answer'; sdp: string }
  | { kind: 'ice'; candidate: RTCIceCandidateInit }

export interface WebRTCLink {
  readonly ready: boolean
  handleSignal(sig: Signal): Promise<void> // feed a signal received from the peer
  send(bytes: Uint8Array): void
  sendControl(bytes: Uint8Array): void
  buffered(): number
  drain(): Promise<void>
  close(): void
}

export interface WebRTCOpts {
  initiator: boolean // the lower PeerId initiates (offer); the other answers
  sendSignal: (sig: Signal) => void // publish a signal to the peer (over GossipSub)
  onData: (bytes: Uint8Array) => void // incoming DataChannel bytes
  /** Control frames that are not the channel's own ping/pong (file transfer). */
  onControl?: (bytes: Uint8Array) => void
  onOpen?: () => void
  onClose?: () => void
  onState?: (s: string) => void // connection/ICE state transitions (diagnostics)
  iceServers?: RTCIceServer[]
}

/**
 * Control frames on the DataChannel. Content frames are ratchet frames (they
 * start with 0x10), so a 0x00 prefix cannot collide with one.
 *
 * Why they exist: `onopen` only means the channel was negotiated locally. It
 * has happened in testing that both sides showed "WebRTC Direct" while nothing
 * crossed — the room had handed content to a channel that never delivered. A
 * ping that comes back proves BOTH directions before the channel is trusted
 * with messages.
 */
const CTRL = 0x00
const PING = new Uint8Array([CTRL, 0x50])
const PONG = new Uint8Array([CTRL, 0x4f])
/** Pause a file transfer above this, resume when the channel drains to it. */
const LOW_WATER = 1024 * 1024
const HIGH_WATER = 8 * 1024 * 1024
const PROBE_TRIES = 4
const PROBE_EVERY_MS = 700

export function webrtcLink(opts: WebRTCOpts): WebRTCLink {
  // No default of its own, on purpose. STUN runs on the NODES (`lib/ice.ts`,
  // `infra/stun/`), so the list follows whichever nodes this client dials —
  // which only the caller knows. An empty list is a legitimate answer (`?stun=0`,
  // or a LAN pair): ICE then offers host candidates only.
  const pc = new RTCPeerConnection({ iceServers: opts.iceServers ?? [] })
  let dc: RTCDataChannel | null = null
  let ready = false
  let remoteSet = false
  const pendingIce: RTCIceCandidateInit[] = []

  let onLow: (() => void) | null = null
  let probeTimer: any = null
  const stopProbe = () => { clearInterval(probeTimer); probeTimer = null }

  const wire = (channel: RTCDataChannel) => {
    dc = channel
    dc.binaryType = 'arraybuffer'
    // Without this a send loop queues an entire file into the tab's memory in
    // seconds: `send()` never blocks and never refuses. The threshold is what
    // turns "push" into "push until told to wait".
    dc.bufferedAmountLowThreshold = LOW_WATER
    dc.onbufferedamountlow = () => { const f = onLow; onLow = null; f?.() }
    dc.onopen = () => {
      // Not ready yet — prove the round trip first.
      let tries = 0
      const probe = () => {
        if (ready) return stopProbe()
        if (++tries > PROBE_TRIES) {
          stopProbe()
          opts.onState?.('probe=failed')   // stay on the relay; nothing breaks
          return
        }
        try { channel.send(PING) } catch {}
      }
      probe()
      probeTimer = setInterval(probe, PROBE_EVERY_MS)
    }
    dc.onclose = () => { stopProbe(); if (ready) { ready = false; opts.onClose?.() } }
    dc.onmessage = (e) => {
      const bytes = new Uint8Array(e.data as ArrayBuffer)
      // EVERY 0x00 frame is control, not just the two-byte ones. Before file
      // transfer there were only ping and pong, so the length was part of the
      // test; a longer control frame would have been handed to the room as
      // content and failed to open as a ratchet frame.
      if (bytes.length >= 2 && bytes[0] === CTRL) {
        if (bytes.length === 2 && bytes[1] === PING[1]) { try { channel.send(PONG) } catch {} ; return }
        if (bytes.length === 2 && bytes[1] === PONG[1] && !ready) {
          stopProbe()
          ready = true
          opts.onState?.('probe=ok')
          opts.onOpen?.()   // only now may the room send content this way
        } else if (bytes.length > 2) opts.onControl?.(bytes)
        return
      }
      opts.onData(bytes)
    }
  }
  const flushIce = async () => {
    remoteSet = true
    for (const c of pendingIce) { try { await pc.addIceCandidate(c) } catch {} }
    pendingIce.length = 0
  }

  pc.onicecandidate = (e) => { if (e.candidate) opts.sendSignal({ kind: 'ice', candidate: e.candidate.toJSON() }) }
  pc.onconnectionstatechange = () => {
    opts.onState?.('conn=' + pc.connectionState)
    if (pc.connectionState === 'failed' || pc.connectionState === 'closed' || pc.connectionState === 'disconnected') {
      if (ready) { ready = false; opts.onClose?.() }
    }
  }
  pc.oniceconnectionstatechange = () => opts.onState?.('ice=' + pc.iceConnectionState)

  if (opts.initiator) {
    wire(pc.createDataChannel('onchato'))
    void (async () => {
      try {
        const offer = await pc.createOffer()
        await pc.setLocalDescription(offer)
        opts.sendSignal({ kind: 'offer', sdp: offer.sdp! })
      } catch (e: any) { opts.onState?.(`offer-failed: ${e?.message ?? e}`) }
    })()
  } else {
    pc.ondatachannel = (e) => wire(e.channel)
  }

  return {
    get ready() { return ready },
    async handleSignal(sig: Signal) {
      // A throw in here used to vanish completely: the caller invokes this as
      // `void handleSignal(...)`, so a failed setRemoteDescription or
      // createAnswer left NO trace and looked exactly like a peer that never
      // answered — which is how a two-Firefox session sat on the relay with
      // nothing in either log to say why.
      try {
        if (sig.kind === 'offer') {
          await pc.setRemoteDescription({ type: 'offer', sdp: sig.sdp })
          await flushIce()
          const answer = await pc.createAnswer()
          await pc.setLocalDescription(answer)
          opts.sendSignal({ kind: 'answer', sdp: answer.sdp! })
        } else if (sig.kind === 'answer') {
          await pc.setRemoteDescription({ type: 'answer', sdp: sig.sdp })
          await flushIce()
        } else if (sig.kind === 'ice') {
          if (remoteSet) { try { await pc.addIceCandidate(sig.candidate) } catch (e: any) { opts.onState?.(`ice-add-failed: ${e?.message ?? e}`) } }
          else pendingIce.push(sig.candidate)
        }
      } catch (e: any) {
        opts.onState?.(`signal-failed(${sig.kind}): ${e?.message ?? e}`)
      }
    },
    send(bytes: Uint8Array) { if (dc && ready) dc.send(bytes) },
    /** Same wire, but allowed to be longer than the two-byte ping/pong. */
    sendControl(bytes: Uint8Array) { if (dc && ready) dc.send(bytes) },
    buffered() { return dc?.bufferedAmount ?? 0 },
    /**
     * Resolves once the channel has room again. `bufferedamountlow` fires only
     * on a fall THROUGH the threshold, so a caller that is already below it
     * would wait for an event that never comes — hence the immediate return.
     */
    drain() {
      if (!dc || dc.bufferedAmount < HIGH_WATER) return Promise.resolve()
      return new Promise<void>((res) => { onLow = res })
    },
    close() {
      stopProbe()
      try { dc?.close() } catch {}
      try { pc.close() } catch {}
    },
  }
}
