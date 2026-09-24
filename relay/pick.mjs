/**
 * pick.mjs — the client says which topic it wants; the relay delivers it.
 *
 * Protocol `/onchato/pick/1`, the first half of the light-client plan
 * (~/.claude memory light-client-plan; research in
 * ~/develop/chat/GOSSIPSUB-FANOUT-RESEARCH.md). The pattern is Waku's Filter:
 * a client that connects to ONE relay does not need to be a GossipSub peer to
 * RECEIVE -- it needs to name a topic and be handed what arrives on it. So it
 * opens one long-lived stream, sends PICK <topic>, and from then on gets
 * DELIVER frames. No mesh, no heartbeats, no subscription announcements on the
 * client's side.
 *
 * ## Why only the receive side
 *
 * The send side (Waku's LightPush) is NOT here, and the reason is in the
 * client, not the relay. `lib/room.ts` keys the EH-2 session and the ratchet
 * by the GossipSub publisher id (`evt.detail.from`). A relay publishing on a
 * client's behalf would sign as itself, so every message would arrive as
 * `from = relay` and every session would collapse into one. Carrying the
 * origin inside the payload would change the wire format for every existing
 * client. Either answer is a change to the client's identity model, which is
 * stage 2's business and the user's decision. For now a light client still
 * PUBLISHES through GossipSub (signed by itself, `from` correct for everybody)
 * and RECEIVES through pick.
 *
 * ## What the relay knows -- exactly as much as before
 *
 * A picked topic is recorded per peer the same way a subscription is. The
 * relay learns nothing it did not learn from GossipSub; it carries less.
 * Written into PROTOCOL.md §12 so nobody reads "light client" as "the relay
 * sees less".
 *
 * ## REFUSED -- the first non-silent refusal
 *
 * A GossipSub subscription past the topic cap is refused with NO signal to the
 * client; the room simply looks empty. A PICK gets an answer: REFUSED <topic>.
 * That is the single biggest practical gain of this protocol and it costs one
 * frame type.
 *
 * ## Frames
 *
 * Each frame is length-prefixed on the stream (it-length-prefixed). Inside:
 *
 *   client -> relay   0x01 PICK    topic
 *                     0x02 DROP    topic
 *   relay  -> client  0x11 DELIVER u8 fromLen, from, u8 topicLen, topic, data
 *                     0x12 REFUSED topic
 *
 * Topics are 52 base32 characters and peer ids are ~52, so a one-byte length
 * is enough and anything longer is refused as malformed rather than parsed.
 */

export const PROTOCOL = '/onchato/pick/1'

export const T = Object.freeze({ PICK: 0x01, DROP: 0x02, DELIVER: 0x11, REFUSED: 0x12 })

const enc = new TextEncoder()
const dec = new TextDecoder()
const MAX_NAME = 255

/** A topic or peer id that fits its one-byte length and looks like ours. */
function nameBytes(s) {
  const b = enc.encode(String(s))
  if (!b.length || b.length > MAX_NAME) throw new Error(`name of ${b.length} bytes does not fit a frame`)
  return b
}

export function encodePick(topic) { const t = nameBytes(topic); return concat([T.PICK], t) }
export function encodeDrop(topic) { const t = nameBytes(topic); return concat([T.DROP], t) }
export function encodeRefused(topic) { const t = nameBytes(topic); return concat([T.REFUSED], t) }

export function encodeDeliver(from, topic, data) {
  const f = nameBytes(from), t = nameBytes(topic)
  return concat([T.DELIVER, f.length], f, [t.length], t, data)
}

function concat(...parts) {
  const arrs = parts.map((p) => (p instanceof Uint8Array ? p : Uint8Array.from(p)))
  const out = new Uint8Array(arrs.reduce((n, a) => n + a.length, 0))
  let o = 0
  for (const a of arrs) { out.set(a, o); o += a.length }
  return out
}

/**
 * Parse one frame, or null. Everything here arrived from the network, so a
 * frame that does not fit its own lengths is rubbish, not "mostly right".
 */
export function decodeFrame(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length < 2) return null
  const type = bytes[0]
  if (type === T.PICK || type === T.DROP || type === T.REFUSED) {
    if (bytes.length - 1 > MAX_NAME) return null
    return { type, topic: dec.decode(bytes.subarray(1)) }
  }
  if (type === T.DELIVER) {
    let o = 1
    const fl = bytes[o++]; if (!fl || o + fl > bytes.length) return null
    const from = dec.decode(bytes.subarray(o, o + fl)); o += fl
    const tl = bytes[o++]; if (!tl || o + tl > bytes.length) return null
    const topic = dec.decode(bytes.subarray(o, o + tl)); o += tl
    return { type, from, topic, data: bytes.subarray(o) }
  }
  return null
}

/**
 * Who picked what, and where to deliver it.
 *
 * `sink` is whatever writes a frame to that peer's stream. Kept per (peer,
 * topic) so a peer that picks the same topic twice holds one slot, and a peer
 * that drops it twice frees one -- the same reason quota.mjs is a Set and not
 * a counter.
 */
export function makePicks() {
  const byTopic = new Map() // topic -> Map(peer -> sink)
  const byPeer = new Map()  // peer -> Set(topic)
  return {
    add(peer, topic, sink) {
      const p = String(peer)
      let m = byTopic.get(topic); if (!m) { m = new Map(); byTopic.set(topic, m) }
      m.set(p, sink)
      let s = byPeer.get(p); if (!s) { s = new Set(); byPeer.set(p, s) }
      s.add(topic)
    },
    drop(peer, topic) {
      const p = String(peer)
      byTopic.get(topic)?.delete(p)
      if (byTopic.get(topic)?.size === 0) byTopic.delete(topic)
      byPeer.get(p)?.delete(topic)
      if (byPeer.get(p)?.size === 0) byPeer.delete(p)
    },
    /** The peer went away: every topic it picked is released. Returns them. */
    forget(peer) {
      const p = String(peer)
      const topics = [...(byPeer.get(p) ?? [])]
      for (const t of topics) this.drop(p, t)
      return topics
    },
    /** Sinks to deliver a message on `topic` to, minus the sender. */
    sinksFor(topic, exceptPeer = null) {
      const m = byTopic.get(topic); if (!m) return []
      const out = []
      for (const [p, sink] of m) if (p !== String(exceptPeer)) out.push(sink)
      return out
    },
    holders(topic) { return byTopic.get(topic)?.size ?? 0 },
    topicsOf(peer) { return [...(byPeer.get(String(peer)) ?? [])] },
    topics() { return [...byTopic.keys()] },
  }
}
