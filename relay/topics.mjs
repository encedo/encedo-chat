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

/**
 * May the idle sweep drop this topic? Only when nothing happened on it for
 * `ttlMs` AND no client on this relay holds it through the pick stream.
 *
 * The second half is new (2026-09-29). A light client's topics are held by its
 * PICK, not by traffic: a hidden tab that Chrome throttles to one timer a
 * minute can leave a quiet presence or group topic without a frame for over
 * two minutes. The sweep then unsubscribed the relay from it, the pick entry
 * stayed, and the client - told nothing - no longer heard anyone reaching it
 * through another relay. A held topic is not abandoned; when its holder's
 * stream closes, the pick goes and the ordinary TTL applies again.
 */
export function evictable({ now, lastSeen = 0, holders = 0, ttlMs }) {
  return holders === 0 && now - lastSeen > ttlMs
}

/**
 * Siblings to reset: connected, yet nothing has come FROM them for `maxSilenceMs`.
 *
 * Every relay announces its load on the mesh every 30 s, flood-published to
 * each sibling, so a connected sibling that has sent us nothing for three
 * rounds is not quiet - its stream to us is dead. Seen in production
 * (2026-09-29): when a relay reconnected while the old connection was still
 * open, the survivor kept writing its GossipSub stream into the OLD one. The
 * TCP link stayed up, the load topic still arrived the long way round through
 * the third relay, and every client topic between the two relays was silently
 * cut in one direction. Only closing the connection cleanly fixed it, so that
 * is what the watchdog does. The clock starts at connect, not at zero.
 */
export function staleSiblings({ now, connected, lastHeard, connectedAt, maxSilenceMs, lastDup = new Map() }) {
  return connected.filter((id) => now - Math.max(lastHeard.get(id) ?? 0, lastDup.get(id) ?? 0, connectedAt.get(id) ?? now) > maxSilenceMs)
}

/**
 * Siblings that only DUPLICATES proved alive: no first copy for `maxSilenceMs`,
 * but a copy that lost the race did arrive over their link.
 *
 * `gossipsub:message` names one source per message, the first to deliver it,
 * and drops later copies without an event. In a triangle every announce of A
 * reaches B twice - directly and through C - and when the two routes are
 * equally fast (bs1-bs2 direct 28 ms, through bs3 12 + 16 ms) C can win
 * several rounds in a row. The watchdog then saw a silent sibling and reset a
 * healthy link (bs2 alone: 3, 7, 10 resets on 2026-10-02..04; bs3, the middle
 * of the triangle, never). A copy that came over THE link proves the link, so
 * `staleSiblings` counts it; this names the cases where it made the
 * difference, for the log.
 */
export function dupOnlySiblings({ now, connected, lastHeard, connectedAt, maxSilenceMs, lastDup }) {
  const stale = new Set(staleSiblings({ now, connected, lastHeard, connectedAt, maxSilenceMs, lastDup }))
  return staleSiblings({ now, connected, lastHeard, connectedAt, maxSilenceMs }).filter((id) => !stale.has(id))
}

/**
 * A new connection from a sibling we are ALREADY connected to: is this the
 * overlap that leaves GossipSub writing into a dead connection?
 *
 * That overlap is the moment the mesh fault of 2026-09-29 is born: the peer
 * reconnected before we noticed its old connection died, no peer:connect
 * fires for the new one, and our stream stays on the old. The watchdog
 * (staleSiblings) repairs it after 105 s of silence; catching the overlap
 * repairs it at once, by closing EVERY connection to that sibling so the
 * re-dial starts clean. Two fresh connections (both sides dialling at start)
 * are not an overlap - the older one must be older than `minAgeMs` - and a
 * sibling is reset at most once per `minGapMs`, so this cannot flap.
 */
export function overlapReset({ now, openedAt, lastReset = 0, minAgeMs = 30_000, minGapMs = 60_000 }) {
  // openedAt: open times of this sibling's OTHER connections (not the new one).
  return openedAt.some((t) => now - t > minAgeMs) && now - lastReset > minGapMs
}

/**
 * After a sibling link was lost, may THIS relay dial it now?
 *
 * Both relays of a pair have each other in --peers, so after a reset both
 * re-dialled within the same 10 s and the pair got two fresh connections at
 * once. libp2p then drops one, and GossipSub's stream sometimes stayed on the
 * dropped one: the direction was dead again two minutes after the watchdog
 * had reset it (seen four times in the night of 2026-09-30, each costing two
 * to eight minutes). So one side goes first, deterministically: the relay
 * with the smaller PeerId dials at once; the other waits `graceMs` and dials
 * only if the link is still down - the fallback for a pair where the first
 * one cannot or does not dial. The first dial after start is never held back.
 */
export function mayRedial({ selfId, peerId, now, lostAt, graceMs = 20_000 }) {
  if (lostAt == null) return true            // never connected, or start-up
  if (String(selfId) < String(peerId)) return true
  return now - lostAt >= graceMs
}
