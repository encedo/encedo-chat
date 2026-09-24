/**
 * leaf.mjs — tell a client only about the topics it holds. Tell a relay everything.
 *
 * ## What it changes
 *
 * GossipSub sends our whole subscription list to every peer that connects, and
 * every new subscription to every peer we have (`sendSubscriptions`, twice in
 * `@chainsafe/libp2p-gossipsub`). That is the right thing in the topology it was
 * built for -- equals routing for each other -- and pure cost in ours: a client
 * connects to ONE relay and never to another client, so the only fact it can
 * use is "you carry my topic". At 6000 topics that is ~360 KB per connection
 * and a ~700 MB storm when a node restarts and everybody comes back at once.
 * Measured on bs3: a peer that asked for nothing was sent 13 topics in 12 s.
 * See ~/develop/chat/GOSSIPSUB-FANOUT-RESEARCH.md for why the protocol does it
 * and why none of its five reasons applies to a leaf.
 *
 * So: a SIBLING relay is told everything, because it routes. A LEAF (anybody
 * else) is told only the topics it has itself announced to us. Two hooks:
 *
 *   sendSubscriptions          -- filter what goes out, per recipient
 *   handleReceivedSubscription -- when a leaf tells us it holds T and we
 *                                 already hold T, tell it so. Without this a
 *                                 second client joining a room the relay
 *                                 already carries would never learn the relay
 *                                 is in it: `subscribe(T)` is not called again,
 *                                 so nothing would be announced.
 *
 * ## The order that makes it work, spelled out
 *
 *   client announces T  ->  handleReceivedSubscription records "client holds T"
 *                       ->  relay.mjs sees subscription-change, calls subscribe(T)
 *                       ->  subscribe(T) announces T to peers -- filtered to
 *                           peers holding T, which now includes the client.
 *
 * Because recording happens BEFORE the relay subscribes, the filter sees the
 * client as a holder at the moment it matters. If those two steps were ever
 * reordered, the client would be told nothing and its room would silently not
 * form. That is the one failure this patch can introduce, and it is what
 * `net/shard-test.ts` against two local relays exists to catch.
 *
 * ## Not a fork
 *
 * A patch on the running instance, over methods that are TypeScript-private
 * and therefore plain properties at runtime. Guarded: if the pinned library no
 * longer has the shapes this relies on, the relay REFUSES to start with the flag
 * on, rather than running unpatched and looking fine.
 */

/** The library version these hooks were written against. `package.json` pins it. */
export const WRITTEN_AGAINST = '14.1.2'

/**
 * What the patch needs from the instance. Checked before anything is replaced,
 * so a library that moved on fails loudly at startup instead of quietly at 3am.
 */
export function shapeProblems(pubsub) {
  const problems = []
  if (typeof pubsub?.sendSubscriptions !== 'function') problems.push('sendSubscriptions is not a function')
  if (typeof pubsub?.handleReceivedSubscription !== 'function') problems.push('handleReceivedSubscription is not a function')
  if (!(pubsub?.topics instanceof Map)) problems.push('topics is not a Map')
  if (!(pubsub?.subscriptions instanceof Set)) problems.push('subscriptions is not a Set')
  return problems
}

/**
 * Install the two hooks. Returns what was replaced, so a test can undo it.
 *
 * `siblings` is the set of relay peer ids (topics.mjs). Anybody not in it is a
 * leaf -- including a relay somebody else runs, which is exactly right: it did
 * not earn our topic list by dialling us.
 */
export function leafAnnouncements(pubsub, { siblings, log = () => {} }) {
  const problems = shapeProblems(pubsub)
  if (problems.length) throw new Error(`leaf announcements: library shape changed (${problems.join('; ')}) — written against ${WRITTEN_AGAINST}`)

  // Originals kept unbound so restore() puts back the very same functions;
  // bound copies are what the hooks call.
  const origSend = pubsub.sendSubscriptions, origRecv = pubsub.handleReceivedSubscription
  const send = origSend.bind(pubsub)
  const recv = origRecv.bind(pubsub)

  pubsub.sendSubscriptions = (toPeer, topics, subscribe) => {
    const peer = toPeer.toString()
    if (siblings.has(peer)) return send(toPeer, topics, subscribe)
    // A leaf hears about a topic only if it holds that topic itself.
    const theirs = topics.filter((t) => pubsub.topics.get(t)?.has(peer))
    if (theirs.length) send(toPeer, theirs, subscribe)
    else if (topics.length) log(`leaf ${peer.slice(0, 12)}...: withheld ${topics.length} topic(s) it does not hold`)
  }

  pubsub.handleReceivedSubscription = (from, topic, subscribe) => {
    recv(from, topic, subscribe)
    // `from` is a PeerId OBJECT here (the library's own call site hands over
    // the connection's peer), while `sendRpc` finds the stream by the peer's
    // STRING (`streamsOutbound.get(id)`). Pass the object and the lookup
    // misses, the library logs at debug level and sends nothing -- which is
    // what happened in production on 2026-09-24: a client joining a room the
    // relay already carried was never told, and with floodPublish it then
    // published to nobody. Always the string.
    const peer = from.toString()
    // They hold T now, and so do we: say so, to them alone. For a sibling the
    // normal broadcast already covers it.
    if (subscribe && !siblings.has(peer) && pubsub.subscriptions.has(topic)) send(peer, [topic], true)
  }

  return { restore() { pubsub.sendSubscriptions = origSend; pubsub.handleReceivedSubscription = origRecv } }
}
