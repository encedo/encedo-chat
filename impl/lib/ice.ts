/**
 * ice.ts — which STUN servers a direct attempt is allowed to consult.
 *
 * One list, because there were two: `net/webrtc.ts` defaulted to Google's
 * public server and `lib/webrtc-probe.ts` diagnosed against it separately, so
 * "which third party does this product talk to" had two answers and neither was
 * in the specs. The answer is now **nobody**: STUN runs on our own nodes
 * (`infra/stun/stun.mjs`, the user's decision 2026-09-03 — "no dependency on
 * anybody, only the VPS"). A STUN server learns the client's IP and the timing
 * of every negotiation; ours are hosts the client is already holding a WSS
 * connection to, so the operator learns an address it necessarily has and
 * nobody else learns anything.
 *
 * **The list is DERIVED from the node list, never written out here.** A node is
 * a machine that carries this network's traffic, and since `relay/DEPLOY.md`
 * §4b it runs STUN on the default port as part of being one — so the hosts a
 * client already dials are exactly the hosts it can ask. That means a
 * hardcoded second copy would be the bug this project has already paid for
 * once: `DEFAULT_NODES` used to be typed out beside `infra/nodes.json` and the
 * two drifted, so a fresh client dialled one node while the published file
 * carried two. Here it is worse than drift — a hardcoded STUN list would keep
 * pointing at old hosts after someone edits their nodes in Settings or loads a
 * published list by CID.
 *
 * Consequences worth knowing:
 *
 *  - A node the user added by hand that does NOT answer STUN costs nothing:
 *    ICE asks all of them in parallel and one reflexive answer is enough.
 *  - `MAX_STUN` caps how many are asked. Every server means another round of
 *    requests from every ICE gathering, and the answers are the same address.
 *  - `?stun=<url>` replaces the derived list for one page load (`stun:`/`stuns:`
 *    only — this value reaches `RTCPeerConnection`, and a `turn:` URL there
 *    would route media somewhere a link chose). `?stun=0` asks nobody, leaving
 *    host candidates, which is what a pair on one LAN uses anyway.
 */

/** How many nodes are asked. One answer is enough; the rest is noise. */
export const MAX_STUN = 3

/** The default STUN port — every node runs it there (`relay/DEPLOY.md` §4b). */
export const STUN_PORT = 3478

/**
 * The one host named in code, and only for a caller with no node list — today
 * that is the self-test when it is run before a session exists. Everything on
 * the message path derives its servers from the nodes instead.
 */
export const STUN_FALLBACK_HOST = 'bs1.onchato.com'

/**
 * The host inside a multiaddr, for the address forms a node list can hold.
 * `null` for anything else, including a hostname pasted without a protocol —
 * which the node list already refuses for dialling (`lib/nodelist.ts`).
 */
export function hostOf(addr: string): string | null {
  const m = /^\/(?:dns4|dns6|dnsaddr|ip4|ip6)\/([^/]+)\//.exec(addr)
  return m ? m[1] : null
}

/** `stun:<host>:3478` for the first few nodes, in the order they are dialled. */
export function stunFromNodes(addrs: string[], max = MAX_STUN): { urls: string }[] {
  const hosts: string[] = []
  for (const a of addrs) {
    const h = hostOf(a)
    if (h && !hosts.includes(h)) hosts.push(h)
    if (hosts.length >= max) break
  }
  return hosts.map((h) => ({ urls: `stun:${h}:${STUN_PORT}` }))
}

/**
 * The servers for this page load: the nodes, unless `?stun=` says otherwise.
 * `addrs` is what the client actually dials (`chosenRelays()` in the web app),
 * so editing the node list moves this with it.
 */
export function iceServersFor(search: string, addrs: string[]): { urls: string }[] {
  const v = new URLSearchParams(search).get('stun')
  if (v === '0') return []
  if (v && /^stuns?:[^\s]+$/i.test(v)) return [{ urls: v }]
  return stunFromNodes(addrs)
}
