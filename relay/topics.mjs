/**
 * topics.mjs — whose subscription is worth joining a topic for.
 *
 * ## The problem this exists to fix
 *
 * A relay subscribes when a connected peer announces a subscription. Relays are
 * connected to EACH OTHER, so one client's subscription on bs3 propagates to
 * bs1 and bs2, which subscribe too — and from then on every node carries every
 * message. Measured over a week: bs1 1,374,952 messages, bs2 1,374,977, bs3
 * 1,377,985. Identical, because they are copies of one another.
 *
 * The consequence is not waste, it is a ceiling. **The network can only be as
 * big as its SMALLEST node**, because each one carries all of it. Growing bs3
 * changes nothing while bs1 and bs2 are 1 GB machines: they hit `--max-topics`
 * first and start REFUSING rooms, which the client is never told about — it
 * simply never sees anybody in the room.
 *
 * ## What changes
 *
 * Join a topic when one of OUR OWN CLIENTS asks for it, not when a sibling
 * relay mentions it. GossipSub already routes per topic; subscribing to
 * everything is us defeating that. A room whose people all sit on bs3 then
 * never touches bs1, and a room split across two relays works exactly as
 * before: both have a local client, so both subscribe, and the message crosses
 * once between two directly-connected nodes.
 *
 * ## Why the sibling set is CONFIGURED rather than inferred
 *
 * Clients arrive through nginx, so every one of them looks like 127.0.0.1 —
 * guessing by address is how the GossipSub colocation score once killed live
 * rooms here. Direction of connection does not work either: bs1 dials nobody
 * (the others dial IT), so it has no `--peers` to learn from. A list of peer
 * ids is checkable and cannot drift into a wrong answer.
 *
 * ## Which way it fails
 *
 * A sibling missing from the list is read as a client, so the relay subscribes
 * to its topics: no saving, no breakage. The opposite — a client mistaken for a
 * sibling, which would silently stop its rooms from forming — can only happen
 * if somebody puts a client's peer id in `--siblings`, and peer ids are not
 * guessable. The safe direction is the likely one.
 */

/** The peer id at the end of a multiaddr, or null when it carries none. */
export function peerIdOf(multiaddr) {
  const m = /\/p2p\/([A-Za-z0-9]+)\s*$/.exec(String(multiaddr).trim())
  return m ? m[1] : null
}

/**
 * Every relay we know about: the ones named explicitly, plus the ones we dial.
 *
 * Both, because neither alone is enough. `--peers` only names the nodes THIS
 * one dials — bs2 dials bs1 and never hears of bs3, which dials it — and bs1
 * dials nothing at all. `--siblings` is the complete answer and `--peers` is a
 * free correction when it is incomplete.
 */
export function siblingSet(explicit = [], peers = []) {
  const out = new Set()
  for (const id of explicit) {
    const s = String(id).trim()
    if (s) out.add(peerIdOf(s) ?? s) // a bare id, or a whole multiaddr
  }
  for (const addr of peers) {
    const id = peerIdOf(addr)
    if (id) out.add(id)
  }
  return out
}

/**
 * Do we join the topic this peer just announced?
 *
 * `localOnly` off is the behaviour that has run since the beginning: join
 * whatever anybody mentions. It stays the default so the code can be deployed
 * inert and turned on one node at a time.
 */
export function shouldJoin(peerId, { siblings, localOnly }) {
  if (!localOnly) return true
  return !siblings.has(String(peerId))
}
