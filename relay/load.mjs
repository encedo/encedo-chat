/**
 * load.mjs — how full this relay is, said out loud on the mesh.
 *
 * ## Why not a file over HTTP
 *
 * The obvious shape is a JSON file per node served by its own nginx. It was
 * rejected for two reasons that only showed up when the configs were read.
 * Every node serves its own domain, and the app lives on onchato.com, so it
 * would mean three CROSS-ORIGIN fetches on every start, three CORS headers and
 * three nginx edits — against a principle this deployment keeps on purpose.
 * And a file is a write: on a 1 GB VM with an SSD, a status line every few
 * seconds is wear for a number nobody may read, so it would have to live on a
 * ramdisk, which is another thing to set up and to forget.
 *
 * Announcing it on the mesh costs none of that. The relays are already
 * connected to each other, so each one learns the others for free, and a client
 * connected to ANY of them gets the whole picture over the socket it already
 * has. Nothing is written, no port is opened, no origin is added.
 *
 * The price, stated plainly: a client only learns this AFTER connecting. A
 * freshly installed app makes its first choice from the published weights
 * (`lib/nodepick.ts`), which is exactly what weights are for; load then decides
 * the NEXT session and where to go when a node is struggling.
 *
 * ## Why the topic is unreadable
 *
 * Room topics are 52 base32 characters out of HKDF — opaque by construction, so
 * that nothing about a conversation can be read off the wire. A topic called
 * `onchato/load/v1` sitting among them would be a marker saying "this traffic
 * is onchato", which is the property the opaque ones exist to avoid. So this
 * one is derived too. It is not a secret — anybody may compute it — it simply
 * has no reason to look different from its neighbours.
 *
 * ## What is published, and what deliberately is not
 *
 * A PERCENT, not `47/250`. An exact live-room count is a population figure for
 * the whole network, readable by anyone over time; a client choosing a relay
 * needs to know how full, not how many. One percent of 520 connections is about
 * five of them, so the number is a good deal less sharp than the counters
 * behind it — which is the intent, not a rounding accident.
 *
 * Two saturations are measured and the WORSE is published, because two limits
 * can bind and they bind differently: connections (520) run out first in the
 * ordinary case and the dial then FAILS, which the person sees; topics (250)
 * run out later and the subscription is refused SILENTLY, which shows up as a
 * room where nobody ever appears.
 *
 * Memory and event-loop lag are NOT in here, and that is a measurement problem
 * rather than an oversight: nobody knows yet what a client costs in RAM (bs3
 * carries eleven of them in 185 MB, which says nothing about five hundred), and
 * the lag threshold for "struggling" has never been measured either. A figure
 * invented for them would be a plausible wrong number, which is worse than an
 * absent one. Both become measurable now that per-node statistics finally mean
 * one node (relay/topics.mjs), and they can be added when there is a number.
 */

import { createHash } from 'node:crypto'

/** RFC 4648 base32, lowercase, unpadded — the alphabet room topics use. */
function base32(bytes) {
  const A = 'abcdefghijklmnopqrstuvwxyz234567'
  let bits = 0, value = 0, out = ''
  for (const b of bytes) {
    value = (value << 8) | b
    bits += 8
    while (bits >= 5) { out += A[(value >>> (bits - 5)) & 31]; bits -= 5 }
  }
  if (bits > 0) out += A[(value << (5 - bits)) & 31]
  return out
}

/**
 * The topic relays announce on. A constant, and shaped like every other topic:
 * 52 base32 characters, so it does not stand out in a list of them.
 */
export const LOAD_TOPIC = base32(createHash('sha256').update('encedo-chat-relay-load-v1').digest()).slice(0, 52)

/** How often a relay says where it is. Small enough to react, rare enough to ignore. */
export const ANNOUNCE_MS = 30_000

/** Past this age an announcement is not used. See `freshest`. */
export const STALE_MS = 3 * ANNOUNCE_MS

/**
 * The worse of the two saturations, as a whole percent.
 *
 * 0..100 rather than 0..99: "completely full" has to be distinguishable from
 * "nearly full", and that is the one case where a client must know there is no
 * point coming here at all.
 *
 * Rounded UP, always: at 90.1% the honest answer for somebody deciding whether
 * to join is "91", not "90, go ahead". The same reason 0.4% reports as 1 rather
 * than 0 — a node with anybody on it is not empty.
 */
export function loadPercent({ conns = 0, maxConns = 1, topics = 0, maxTopics = 1 }) {
  const worst = Math.max(conns / Math.max(maxConns, 1), topics / Math.max(maxTopics, 1))
  return Math.max(0, Math.min(100, Math.ceil(Math.max(worst, 0) * 100)))
}

/**
 * One announcement: who, how full, and WHEN.
 *
 * The time is the point. A relay that dies leaves its last announcement behind
 * in every listener, and a dead node saying "empty, come in" would be the most
 * attractive one on the network. Nothing here can tell a stale reading from a
 * calm one except its age.
 */
export function encodeLoad(node, pct, atMs = Date.now()) {
  return new TextEncoder().encode(JSON.stringify({ v: 1, n: String(node).slice(0, 40), pct, at: atMs }))
}

/** Parse an announcement, or null. Everything here arrived from the network. */
export function decodeLoad(bytes) {
  let d
  try { d = JSON.parse(new TextDecoder().decode(bytes)) } catch { return null }
  if (d?.v !== 1) return null
  if (typeof d.n !== 'string' || !d.n || d.n.length > 40) return null
  // A whole percent, in range. `Number.isInteger` also refuses NaN and
  // Infinity, and a fractional value would mean a sender that is not speaking
  // this version however much it claims v:1.
  if (!Number.isInteger(d.pct) || d.pct < 0 || d.pct > 100) return null
  if (typeof d.at !== 'number' || !Number.isFinite(d.at)) return null
  return { node: d.n, pct: d.pct, at: d.at }
}

/**
 * The usable readings out of everything heard, newest per node.
 *
 * Anything older than `STALE_MS` is dropped rather than aged down: a reading
 * from a node that stopped talking says nothing about that node now, and a
 * guess in its place would be indistinguishable from a measurement.
 */
export function freshest(readings, now = Date.now()) {
  const best = new Map()
  for (const r of readings) {
    if (!r || now - r.at > STALE_MS) continue
    if (r.at > now + ANNOUNCE_MS) continue // a clock ahead of ours: not evidence
    const prev = best.get(r.node)
    if (!prev || r.at > prev.at) best.set(r.node, r)
  }
  return best
}
