/**
 * webrtc-plane.ts — the browser WebRTC upgrader for a room (the §13 direct data
 * plane). Wires a `webrtcLink` on top of a joined room: once two peers are in
 * the room, the lower PeerId initiates; signaling (SDP/ICE) rides the room's
 * GossipSub (encrypted `t:'rtc'` envelopes); once the DataChannel opens, message
 * content prefers it (relay-blind, direct P2P), falling back to GossipSub if the
 * link drops. Browser-only — `webrtcLink` uses RTCPeerConnection.
 */

import { webrtcLink, type Signal, type WebRTCLink } from './webrtc.ts'

/** The subset of a room (joinChat return) the upgrader needs. */
export interface RoomDataPlane {
  sendSignal: (to: string, sig: Signal) => void
  setContentSend: (fn: ((sealed: Uint8Array) => void) | null) => void
  injectContent: (sealed: Uint8Array, from: string) => void
}

export interface WebRTCPlane {
  onPeer(peer: string): void // call when a peer joins the room (presence 'join')
  onSignal(from: string, env: { to: string; sig: Signal }): void // route a t:'rtc' envelope
  stop(): void
}

export function attachWebRTC(room: RoomDataPlane, self: string, opts: { onState?: (s: string) => void } = {}): WebRTCPlane {
  let link: WebRTCLink | null = null

  const onPeer = (peer: string) => {
    if (link || peer === self) return
    link = webrtcLink({
      initiator: self < peer, // deterministic: lower PeerId offers
      sendSignal: (sig) => room.sendSignal(peer, sig),
      onData: (bytes) => room.injectContent(bytes, peer),
      onOpen: () => room.setContentSend((sealed) => link!.send(sealed)), // content → DataChannel
      onClose: () => room.setContentSend(null), // fall back to GossipSub
      onState: opts.onState,
    })
  }

  return {
    onPeer,
    onSignal(from, env) {
      if (env.to !== self) return
      if (!link) onPeer(from) // a signal may arrive before we saw their presence
      void link?.handleSignal(env.sig)
    },
    stop() { try { link?.close() } catch {} ; room.setContentSend(null) },
  }
}
