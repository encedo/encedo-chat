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
  /** Content stopped being confirmed: hand it back to the relay and stay there. */
  demote(): void
  stop(): void
}

export function attachWebRTC(room: RoomDataPlane, self: string, opts: { onState?: (s: string) => void } = {}): WebRTCPlane {
  let link: WebRTCLink | null = null
  /** Which PeerId `link` was built for. A reload gives the peer a new one. */
  let linkPeer: string | null = null
  /** Once the direct path has failed to deliver, it does not get a second turn
   *  with THIS peer instance — a channel that looks open but drops content is
   *  worse than the relay, and it already cost us undelivered messages. */
  let demoted = false

  /**
   * Build the link for `peer`, replacing one built for a PeerId that is gone.
   *
   * The replacement is the point. A link is bound to the PeerId it was created
   * for — every signal it sends is addressed to it — so when the peer reloads
   * and comes back under a new PeerId, the old link addresses a corpse. The
   * receiver drops those signals (`env.to !== self`), no DataChannel is ever
   * negotiated, and the conversation silently spends the rest of its life on the
   * relay. Keeping the first link forever is what caused exactly that.
   */
  const onPeer = (peer: string) => {
    if (peer === self) return
    if (link && linkPeer === peer) return
    if (link) {
      opts.onState?.(`rebind ${linkPeer?.slice(0, 12)}… → ${peer.slice(0, 12)}…`)
      try { link.close() } catch {}
      room.setContentSend(null) // the old channel is gone; relay until the new one proves itself
      // A new PeerId is a new peer instance, so it gets a clean slate: the ban
      // was on the channel we just closed, not on the person.
      demoted = false
    }
    linkPeer = peer
    link = webrtcLink({
      initiator: self < peer, // deterministic: lower PeerId offers
      sendSignal: (sig) => room.sendSignal(peer, sig),
      onData: (bytes) => room.injectContent(bytes, peer),
      onOpen: () => { if (!demoted && linkPeer === peer) room.setContentSend((sealed) => link!.send(sealed)) }, // content → DataChannel
      onClose: () => { if (linkPeer === peer) room.setContentSend(null) }, // fall back to GossipSub
      onState: opts.onState,
    })
  }

  return {
    onPeer,
    demote() {
      if (demoted) return
      demoted = true
      opts.onState?.('demoted=relay')
      room.setContentSend(null)
    },
    onSignal(from, env) {
      // Never silent. A signal addressed to a PeerId we no longer answer to is
      // the fingerprint of a peer that has not noticed we reloaded, and the
      // version of this code that just returned left no trace of it at all —
      // a session stuck on the relay with nothing in the log to explain why.
      if (env.to !== self) {
        opts.onState?.(`signal for ${env.to.slice(0, 12)}…, we are ${self.slice(0, 12)}… — dropped`)
        return
      }
      if (linkPeer !== from) onPeer(from) // first signal, or the peer came back under a new PeerId
      void link?.handleSignal(env.sig)
    },
    stop() { try { link?.close() } catch {} ; link = null; linkPeer = null; room.setContentSend(null) },
  }
}
