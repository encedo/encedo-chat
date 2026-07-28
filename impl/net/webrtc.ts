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
  close(): void
}

export interface WebRTCOpts {
  initiator: boolean // the lower PeerId initiates (offer); the other answers
  sendSignal: (sig: Signal) => void // publish a signal to the peer (over GossipSub)
  onData: (bytes: Uint8Array) => void // incoming DataChannel bytes
  onOpen?: () => void
  onClose?: () => void
  onState?: (s: string) => void // connection/ICE state transitions (diagnostics)
  iceServers?: RTCIceServer[]
}

export function webrtcLink(opts: WebRTCOpts): WebRTCLink {
  const pc = new RTCPeerConnection({ iceServers: opts.iceServers ?? [{ urls: 'stun:stun.l.google.com:19302' }] })
  let dc: RTCDataChannel | null = null
  let ready = false
  let remoteSet = false
  const pendingIce: RTCIceCandidateInit[] = []

  const wire = (channel: RTCDataChannel) => {
    dc = channel
    dc.binaryType = 'arraybuffer'
    dc.onopen = () => { ready = true; opts.onOpen?.() }
    dc.onclose = () => { ready = false; opts.onClose?.() }
    dc.onmessage = (e) => opts.onData(new Uint8Array(e.data as ArrayBuffer))
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
    wire(pc.createDataChannel('encedo'))
    void (async () => {
      const offer = await pc.createOffer()
      await pc.setLocalDescription(offer)
      opts.sendSignal({ kind: 'offer', sdp: offer.sdp! })
    })()
  } else {
    pc.ondatachannel = (e) => wire(e.channel)
  }

  return {
    get ready() { return ready },
    async handleSignal(sig: Signal) {
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
        if (remoteSet) { try { await pc.addIceCandidate(sig.candidate) } catch {} }
        else pendingIce.push(sig.candidate)
      }
    },
    send(bytes: Uint8Array) { if (dc && ready) dc.send(bytes) },
    close() { try { dc?.close() } catch {} ; try { pc.close() } catch {} },
  }
}
