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
  // Nobody carries a weight (today), or every weight is zero: the order decides,
  // exactly as before. Never leave the caller without a node to dial.
  if (total <= 0) return 0
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
