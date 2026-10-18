/**
 * activenet.ts - which network this page is in, and which network an identity
 * belongs to.
 *
 * An identity lives in ONE network for its whole life (the user's decision,
 * 2026-10-18): joining another network means a new identity. The binding is
 * kept beside the profile, unsealed, because the network has to be known
 * BEFORE the password - the node list on the sign-in screen, the region check
 * and the clock anchor all dial nodes - and it says nothing a profile's name
 * does not already say (the user's decision, same day).
 *
 *   ec-soft-net-<profile name> = networkId    (a software profile)
 *   ec-hem-net-<KID>           = networkId    (a HEM identity, on this device)
 *   absent                     = the built-in network
 *
 * The page works in ONE network from load to reload: the one the last identity
 * signed in to (`ec-last-net`). Choosing an identity of another network
 * switches by reloading, so nothing dialled, drawn or anchored for one network
 * leaks into the other.
 *
 * Node lists and the transport mode belong to the NETWORK, not the identity
 * (two identities of one network share them): the built-in network keeps the
 * keys it always had (`ec-nodes`, `ec-transport`), another network gets its
 * own (`ec-nodes:<id>`, `ec-transport:<id>`).
 */
import type { NetworkProfile, AppAddress } from './network.ts'
import { loadRegistry, refreshNetwork, type KVLike, type NetworkPolicy, type OperatorProfile } from './netprofile.ts'
import type { PublishedNode } from './nodelist.ts'

export interface ActiveNetwork {
  /** The id mixed into every derivation (SPEC 5). */
  id: string
  /** The network compiled into this build. */
  builtin: boolean
  operator: string
  /** The node list a fresh device starts from. */
  nodes: PublishedNode[]
  stores: string[]
  app: AppAddress
  legacyApp: AppAddress[]
  /** null: no feedback form in this network. */
  feedback: string | null
  home: string
  policy: NetworkPolicy
  /** An imported profile past its date: it still names its nodes, and the app says so. */
  expired: boolean
  rootPub?: string
  profileUrls?: string[]
}

export const LAST_NET_KEY = 'ec-last-net'
/** A profile to open right after a reload that switched the network. */
export const OPEN_PROFILE_KEY = 'ec-open-profile'
/** After the reload into a network just joined: open the window for its first identity. */
export const OPEN_CREATE_KEY = 'ec-open-create'

export const softBindingKey = (name: string) => `ec-soft-net-${name}`
export const hemBindingKey = (kid: string) => `ec-hem-net-${kid}`

/** The network the built-in profile describes, with the compiled-in node list. */
export function builtinNetwork(net: NetworkProfile, nodes: PublishedNode[], id = net.networkId): ActiveNetwork {
  return {
    id, builtin: true, operator: net.operator, nodes, stores: net.stores, app: net.app, legacyApp: net.legacyApp,
    feedback: net.feedback, home: net.home, policy: {}, expired: false,
  }
}

/** A network by id: the built-in one, an imported one, or null when this device does not know it. */
export function networkById(kv: KVLike, id: string | null, builtin: ActiveNetwork, now: number): ActiveNetwork | null {
  if (!id || id === builtin.id) return builtin
  const k = loadRegistry(kv, now).get(id)
  if (!k) return null
  const p = k.profile
  return {
    id: p.networkId, builtin: false, operator: p.operator, nodes: p.nodes, stores: p.stores, app: p.app,
    legacyApp: p.legacyApp, feedback: p.feedback, home: p.home, policy: p.policy, expired: k.expired,
    rootPub: p.rootPub, profileUrls: p.profileUrls,
  }
}

/** The network this page works in: the last one signed in to, or the built-in one (also when the last one is gone from this device). */
export function resolveActive(kv: KVLike, builtin: ActiveNetwork, now: number): ActiveNetwork {
  return networkById(kv, kv.get(LAST_NET_KEY), builtin, now) ?? builtin
}

/** The network an identity belongs to: its binding, or the built-in one. */
export function bindingOf(kv: KVLike, key: string, builtin: ActiveNetwork): string {
  return kv.get(key) || builtin.id
}

/** Record an identity's network; the built-in one is the absence of a record. */
export function setBinding(kv: KVLike, key: string, id: string, builtin: ActiveNetwork): void {
  if (id === builtin.id) kv.remove?.(key)
  else kv.set(key, id)
}

/** Remember the network the page should open in next time. */
export function setLastNet(kv: KVLike, id: string, builtin: ActiveNetwork): void {
  if (id === builtin.id) kv.remove?.(LAST_NET_KEY)
  else kv.set(LAST_NET_KEY, id)
}

export const nodesKey = (n: ActiveNetwork) => (n.builtin ? 'ec-nodes' : `ec-nodes:${n.id}`)
export const transportKey = (n: ActiveNetwork) => (n.builtin ? 'ec-transport' : `ec-transport:${n.id}`)

/** How often a page that stays open asks again; at sign-in it always asks. */
export const NETWORK_REFRESH_MS = 24 * 3600_000

/**
 * The quiet refresh of another network's profile (the user's call,
 * 2026-10-18): at sign-in and once a day, so an operator can move its nodes
 * without asking every person to press "load the official list". Accepted
 * exactly as by hand - the pinned key, a seq that only climbs (refreshNetwork).
 *
 * The node list a device keeps follows the new profile only while it IS the
 * old profile's list (every node on, the same addresses): a list the person
 * edited is theirs, and the button in Settings replaces it on request. With no
 * list kept at all the next load starts from the new profile anyway.
 */
export async function autoRefreshNetwork(
  kv: KVLike, n: ActiveNetwork, now: number, fetchImpl: typeof fetch = fetch,
): Promise<{ changed: false; why?: string } | { changed: true; profile: OperatorProfile; nodesFollowed: boolean }> {
  if (n.builtin) return { changed: false }
  const before = loadRegistry(kv, now).get(n.id)?.profile
  if (!before) return { changed: false, why: 'unknown' }
  const r = await refreshNetwork(kv, n.id, now, fetchImpl)
  if (!r.ok) return { changed: false, why: r.why }
  if (!r.changed) return { changed: false }
  let nodesFollowed = false
  const key = nodesKey(n)
  let kept: unknown = null
  try { kept = JSON.parse(kv.get(key) ?? 'null') } catch {}
  if (Array.isArray(kept) && kept.length) {
    const addrs = (l: { addr: string }[]) => l.map((x) => x.addr).sort().join('\n')
    const untouched = kept.every((x: any) => x && x.enabled !== false && typeof x.addr === 'string') && addrs(kept as any) === addrs(before.nodes)
    if (untouched) { kv.set(key, JSON.stringify(r.profile.nodes.map((x) => ({ ...x, enabled: true })))); nodesFollowed = true }
  }
  return { changed: true, profile: r.profile, nodesFollowed }
}
