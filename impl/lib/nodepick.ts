/**
 * nodepick.ts — which relay to dial FIRST.
 *
 * ## Why order alone is not enough
 *
 * The published list is ordered, and the order is a deployment decision: since
 * 2026-09-14 it is bs3, bs2, bs1, because bs1 was taking almost every client
 * (200 dials a day against 13 and 8) while also being the web host. That lever
 * works, and it is all-or-nothing — the first node takes roughly everybody and
 * the rest take the remainder. With relays of DIFFERENT sizes (a large node and
 * two micro ones) neither answer is right: pointing everybody at the large one
 * wastes the others, and moving the order around just moves the pile.
 *
 * A weight is the missing middle: bs4 seven times out of ten, bs2 twice, bs1
 * once. Only the FIRST choice is drawn. The rest of the list stays in its
 * published order as the failover chain (3b), which is tested and works.
 *
 * ## What a weight is NOT
 *
 * It is not an operational lever. The list is fetched by a CID compiled into
 * the app and checked against the content it returns, so changing a weight
 * means changing the file, which changes the CID, which needs a release —
 * exactly like changing the order today. That is deliberate: nobody can swap
 * the relay list under a running client.
 *
 * It is also not load. A weight is a guess made at release time; a node that
 * fills up does not stop being picked. Reported load is the next step and this
 * is what it will bias — which is why the drawing is probabilistic from the
 * start rather than "pick the best", since "pick the best" sends everybody to
 * the same place at the same moment.
 *
 * ## The part worth knowing before choosing numbers
 *
 * Since relays stopped carrying every topic (`relay/topics.mjs`), where people
 * land decides how often a ROOM spans two nodes, and a spanning room costs two
 * subscriptions instead of one. Two people draw independently, so the chance a
 * room spans is `1 - sum(p^2)`: all on one node 0%, 70/20/10 about 46%, and an
 * even third each 67%. Spreading evenly is the most expensive option, not the
 * fairest one.
 */

/**
 * NEXT, AND NOT YET BUILT: load, and the hysteresis it needs.
 *
 * Relays already announce how full they are (`relay/load.mjs`) — a whole
 * percent, on the mesh, every 30 s. What is missing is this side reading it,
 * and the intended shape is `effective = w * (1 - pct/100)`: load CORRECTS the
 * weight, it does not replace it. A weight says things a measurement cannot,
 * such as bs1 being the web host and therefore wanted as a spare however empty
 * it looks.
 *
 * HYSTERESIS IS PART OF THE FEATURE, not a refinement of it, and it is easier
 * to see why before the code exists than after somebody reports it.
 *
 * Without it the mechanism fights itself. Every client sees the same numbers at
 * the same moment, so the emptiest node is the obvious answer for ALL of them
 * at once; they move together, it stops being the emptiest, and the next round
 * sends the same crowd somewhere else. The load figure makes clients
 * synchronised rather than independent, which is the one thing a load balancer
 * must not do — and each move costs a reconnect, a re-subscribe and a gap in
 * presence for everybody in the room.
 *
 * So switching needs all four, and the numbers want measuring rather than
 * guessing:
 *
 *   - a MARGIN: move only if the other node is better by enough to be worth a
 *     reconnect, not by one percent of noise;
 *   - a DWELL: that margin has to hold across several announcements, so a
 *     momentary spike moves nobody;
 *   - a COOLDOWN: at most one move per client per long interval, whatever the
 *     numbers say afterwards;
 *   - and a DIE ROLL: even when all three agree, move only with some
 *     probability, so the crowd disperses instead of marching.
 *
 * The first three are ordinary. The fourth is the one that actually breaks the
 * synchronisation, because the first three still fire for everybody at the same
 * instant — they only delay the stampede.
 *
 * A move must also never interrupt a live conversation: a relay that is merely
 * busy is still working, and the reason to leave it is that it is FULL.
 */
export interface WeightedNode { addr: string; w?: number }

/**
 * Index of the node to dial first, given a roll in [0, 1).
 *
 * Pure, and the roll is an argument rather than `Math.random()` inside: a
 * distribution is only testable if the dice are the caller's.
 *
 * WITH NO WEIGHTS AT ALL IT RETURNS 0 — the first enabled node, which is what
 * this has always done. That is not a fallback, it is the point: the mechanism
 * ships inert, and adding weights to the published file later is the only
 * change needed to turn it on.
 */
export function pickFirst(nodes: WeightedNode[], roll: number): number {
  if (nodes.length <= 1) return 0
  const weights = nodes.map((n) => (typeof n.w === 'number' && n.w > 0 ? n.w : 0))
  const total = weights.reduce((a, b) => a + b, 0)
  // Nobody carries a weight (the published list today), or every weight is
  // zero: a UNIFORM draw. Until 2026-09-25 the order decided here, which sent
  // every client to the first node of the list -- a room of people at a demo
  // all on one 1-vCPU node while two others idled. The user's call: spread
  // them, and accept that the list's order no longer means "preferred" (it
  // still decides the failover chain after the drawn node, see orderFrom).
  const r = Number.isFinite(roll) ? Math.min(Math.max(roll, 0), 0.999999) : 0
  if (total <= 0) return Math.floor(r * nodes.length)
  // A weight of 0 next to non-zero weights means "failover only" — a node that
  // should stay reachable without being aimed at. bs1 is that node: it is the
  // web host as well, so it is wanted as a spare however empty it looks.
  let acc = 0
  const target = Math.min(Math.max(roll, 0), 0.999999) * total
  for (let i = 0; i < weights.length; i++) {
    acc += weights[i]
    if (target < acc) return i
  }
  return weights.findIndex((w) => w > 0) // unreachable in theory; a real answer anyway
}

/**
 * The list to dial, with the drawn node moved to the front.
 *
 * The rest keeps its published order, so the failover chain is unchanged: this
 * decides where to START, not what to fall through to.
 */
export function orderFrom<T extends WeightedNode>(nodes: T[], first: number): T[] {
  if (first <= 0 || first >= nodes.length) return nodes.slice()
  const out = nodes.slice()
  const [picked] = out.splice(first, 1)
  out.unshift(picked)
  return out
}

// ---------------------------------------------------------------------------
// Load-aware choice: "power of two choices" at login, hysteresis afterwards.
// ---------------------------------------------------------------------------
//
// Every relay announces how full it is (relay/load.mjs, a percent every 30 s)
// and replays the latest reading of every node to a client that asks. So a
// client can dial the drawn node, read the whole picture in its first second,
// and then decide once whether to stay. The rules, and why:
//
// - LOGIN, power of two choices: compare the node we are on with ONE other
//   drawn at random (weighted like the first draw), and move only if the other
//   is lighter by MOVE_GAP points. Picking "the least loaded" instead sends
//   every client that reads the same 30-second-old numbers to the same node
//   (a herd); two random choices keep the herd apart and still pull the peak
//   down sharply compared with a plain draw.
// - DURING THE SESSION, hysteresis: move only when our node has been HOT for
//   HOT_FOR_MS, some other node is below COOL, and then only with probability
//   REBALANCE_P per check -- a full room must drain gradually, not jump at once.
// - A reading older than LOAD_STALE_MS is no reading at all; a node without one
//   is never chosen on the strength of an imagined 0 %.
//
// Pure, so every rule below has a test; lib/core.ts wires it to the transport.

export interface LoadReading { node: string; pct: number; at: number }
export const MOVE_GAP = 20
export const HOT = 85
export const COOL = 60
export const HOT_FOR_MS = 60_000
export const REBALANCE_P = 0.2
export const LOAD_STALE_MS = 90_000

/** 'bs3' out of a relay multiaddr (`/dns4/bs3.onchato.com/...`) -- the name nodes announce under. */
export function nodeKey(addr: string): string {
  const host = addr.match(/\/dns[46]?\/([^/]+)/)?.[1] ?? addr.match(/\/ip[46]\/([^/]+)/)?.[1] ?? addr
  return host.split('.')[0]
}

const fresh = (r: LoadReading | undefined, now: number): r is LoadReading =>
  !!r && now - r.at <= LOAD_STALE_MS && r.at <= now + 30_000

/**
 * At login: stay (null) or move to the returned node key. `candidates` are the
 * enabled nodes' keys, `weights` their capacity weights (missing = 1).
 */
export function loginChoice(current: string, candidates: string[], loads: Map<string, LoadReading>,
  weights: Map<string, number>, roll: number, now: number): string | null {
  const others = candidates.filter((k) => k !== current)
  if (!others.length) return null
  const mine = loads.get(current)
  if (!fresh(mine, now)) return null
  // The second choice, drawn like the first so capacity still counts.
  const ws = others.map((k) => Math.max(0, weights.get(k) ?? 1))
  const total = ws.reduce((a, b) => a + b, 0)
  const r = (Number.isFinite(roll) ? Math.min(Math.max(roll, 0), 0.999999) : 0) * (total || others.length)
  let acc = 0, other = others[0]
  for (let i = 0; i < others.length; i++) { acc += total ? ws[i] : 1; if (r < acc) { other = others[i]; break } }
  const theirs = loads.get(other)
  if (!fresh(theirs, now)) return null
  return mine.pct - theirs.pct >= MOVE_GAP ? other : null
}

/**
 * During the session: move (the returned key) or stay (null). `hotSince` is
 * when our node was first seen at or above HOT in the current streak, or null.
 */
export function rebalanceChoice(current: string, candidates: string[], loads: Map<string, LoadReading>,
  hotSince: number | null, roll: number, now: number): string | null {
  const mine = loads.get(current)
  if (!fresh(mine, now) || mine.pct < HOT) return null
  if (hotSince === null || now - hotSince < HOT_FOR_MS) return null
  if (!(roll < REBALANCE_P)) return null
  let best: LoadReading | null = null, bestKey: string | null = null
  for (const k of candidates) {
    if (k === current) continue
    const r = loads.get(k)
    if (!fresh(r, now) || r.pct >= COOL) continue
    if (!best || r.pct < best.pct) { best = r; bestKey = k }
  }
  return bestKey
}
