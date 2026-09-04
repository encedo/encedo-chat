/**
 * ice.ts — which STUN servers a direct attempt is allowed to consult.
 *
 * One list, because there were two: `net/webrtc.ts` defaulted to Google's
 * public server and `lib/webrtc-probe.ts` diagnosed against it separately, so
 * "which third party does this product talk to" had two answers and neither was
 * in the specs.
 *
 * **It is our own nodes now, and that is the whole point** (the user's
 * decision, 2026-09-03: "no dependency on anybody — only the VPS"). A STUN
 * server learns the client's IP and the timing of every negotiation. Google's
 * knew both, for a product whose design goes out of its way not to need a third
 * party. Ours run on `infra/stun/stun.mjs`, on the same hosts the client is
 * already holding a WSS connection to — so the operator learns an address it
 * necessarily has, and nobody else learns anything.
 *
 * Three of them because there are three nodes: ICE queries them in parallel and
 * one reflexive answer is enough, so a node being down costs nothing. They are
 * NOT read from `infra/nodes.json` — that file is the relay list, its shape is
 * published by CID and compiled into every build, and a STUN URL is not a
 * libp2p multiaddr. A node list refreshed at runtime therefore does not move
 * this; when a fourth node ships, both files get a line.
 *
 * `?stun=<url>` replaces the list for one page load (`stun:` or `stuns:` only)
 * — for testing a node before it is in a build, and for a support conversation
 * that needs to rule the servers out. `?stun=0` turns STUN off entirely: ICE
 * then offers host candidates only, which is what a LAN pair has anyway.
 */

export const STUN_HOSTS = ['bs1.onchato.com', 'bs2.onchato.com', 'bs3.onchato.com']

/** The default list, in the shape `RTCPeerConnection` wants. */
export const ICE_SERVERS: { urls: string }[] = STUN_HOSTS.map((h) => ({ urls: `stun:${h}:3478` }))

/** What the self-test dials (`lib/webrtc-probe.ts`) — the first of ours. */
export const PROBE_STUN = ICE_SERVERS[0].urls

/**
 * The list for this page load, honouring `?stun=`. Anything that is not a
 * `stun:`/`stuns:` URL is ignored rather than passed on: this value reaches
 * `RTCPeerConnection` and a `turn:` URL there would send traffic somewhere a
 * URL parameter chose.
 */
export function iceServersFor(search: string): { urls: string }[] {
  const v = new URLSearchParams(search).get('stun')
  if (v == null || v === '') return ICE_SERVERS
  if (v === '0') return []
  return /^stuns?:[^\s]+$/i.test(v) ? [{ urls: v }] : ICE_SERVERS
}
