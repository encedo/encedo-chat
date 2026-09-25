/**
 * quota.mjs — how many topics ONE peer may make this relay carry.
 *
 * ## The hole this closes
 *
 * Until now the only limit was global: `--max-topics`, 250 of them for the
 * whole node. Nothing counted who asked. So one connection could subscribe to
 * 250 invented topic names and fill the node, after which every REAL room is
 * refused — and refused SILENTLY, because the client is told nothing and an
 * empty room is indistinguishable from "the other person is not online".
 *
 * nginx does not help here and it is worth saying why, because it looks like it
 * should: it caps connections (20 per address) and request rate, but a
 * subscription is a message INSIDE an already-open WebSocket. From nginx's side
 * that is one long-lived connection doing nothing unusual.
 *
 * The cost of the attack was one socket. The cost of the defence is this file.
 *
 * ## What a fair number looks like
 *
 * Measured 2026-09-23: four topics per client, because a topic is created per
 * CONTACT rather than per client. Somebody with forty contacts is a heavy user,
 * not an attacker, so the ceiling is set well above the real distribution —
 * generous to people, and still taking the lever away from one socket.
 *
 * ## What it does NOT do
 *
 * It does not stop somebody opening twenty sockets from one address (nginx
 * caps that) or twenty addresses. It removes the cheap version: one connection,
 * whole node. Anything past that costs the attacker real resources and, since
 * 2026-09-23, trips the health alarm on `topics_refused`.
 *
 * Siblings are exempt. A sibling relay is not a client and its subscriptions
 * are either ignored (`--local-topics-only`) or are the whole network's,
 * which no per-peer number could sensibly bound.
 */

/**
 * Per client: one topic per contact (presence), per group, per published
 * invite, plus the self-topic and the load topic -- and twice that for the
 * hour around a daily rotation. 40 (the first value) refused people with
 * ~35 contacts; 150 carries a large address book through a rotation and is
 * still a small share of a node's --max-topics (1600), so one socket cannot
 * fill a node. Changed 2026-09-25.
 */
export const DEFAULT_PER_PEER = 150

/**
 * Who asked for what.
 *
 * Kept per peer rather than as a count, because unsubscribing the same topic
 * twice must not free a slot that was never taken -- a counter would drift
 * downwards under a peer that repeats itself, and drift is worse than a wrong
 * constant: it is a limit that stops meaning anything after a while.
 */
export function makeQuota(limit = DEFAULT_PER_PEER) {
  const held = new Map() // peer -> Set(topic)

  return {
    /** May this peer add this topic? Records it when yes. */
    claim(peer, topic) {
      const key = String(peer)
      let set = held.get(key)
      if (!set) { set = new Set(); held.set(key, set) }
      if (set.has(topic)) return true // already theirs: not a new claim
      if (set.size >= limit) return false
      set.add(topic)
      return true
    },

    /** They dropped it. */
    release(peer, topic) {
      const set = held.get(String(peer))
      if (!set) return
      set.delete(topic)
      if (!set.size) held.delete(String(peer))
    },

    /** They went away: everything they held goes with them. */
    forget(peer) { held.delete(String(peer)) },

    /** For the log and the tests. */
    countFor(peer) { return held.get(String(peer))?.size ?? 0 },
    peers() { return held.size },
  }
}
