/**
 * netprofile.ts - an operator's network, as a signed file a person can carry.
 *
 * The public network is compiled in (`infra/network.json`, lib/network.ts). Any
 * other network reaches an installed app as an ENVELOPE: the operator's profile
 * (its exact bytes) and an Ed25519 signature over them by the operator's root
 * key, whose public half is inside the profile. The first import shows a person
 * the operator's name and the key's fingerprint to compare on another channel;
 * from then on the key is PINNED on this device, and a refresh of the profile
 * is accepted only under that key and only with a sequence number that does
 * not go backwards (a replayed older profile would hand clients an old node
 * list).
 *
 * A network is joined only as a NEW identity (the user's decision, 2026-10-18):
 * nothing here moves an existing identity, and nothing a link carries can add a
 * network - an envelope is imported by a deliberate act (a file, a scan).
 *
 *   envelope = { "onchato-network": 1, "profile": base64(profile bytes), "sig": base64(Ed25519(profile bytes)) }
 *
 * The same envelope is what an operator serves at its `profileUrls` for
 * refresh, and what goes into a QR code or a file.
 */
import { ed25519 } from '@noble/curves/ed25519'
import { parseNodeList, type PublishedNode } from './nodelist.ts'
import type { AppAddress } from './network.ts'
import { cidV1Raw, cidMatches, isVerifiableCid } from './cid.ts'

/** The id the compiled-in public network uses; no imported network may claim it. */
export const PUBLIC_NETWORK_ID = 'main'

export interface NetworkPolicy {
  /** `node-only`: the direct (WebRTC) plane is not offered in this network. */
  transport?: 'node-only'
  /** false: identities in this network must be HEM-backed. */
  softwareProfiles?: boolean
  /** false: a managed device (MDM) shows no public network beside this one. */
  allowPublic?: boolean
}

/** What an operator signs. */
export interface OperatorProfile {
  v: 1
  networkId: string
  operator: string
  /** The operator's root key, Ed25519 public, base64 (32 bytes): it signs this profile. */
  rootPub: string
  /** Grows with every new version of the profile. */
  seq: number
  made: number
  expires: number
  nodes: PublishedNode[]
  stores: string[]
  app: AppAddress
  legacyApp: AppAddress[]
  /** Where the signed envelope is served, for refresh. */
  profileUrls: string[]
  /** null: this network takes no feedback, and the app offers no form. */
  feedback: string | null
  home: string
  policy: NetworkPolicy
}

export interface NetworkEnvelope { 'onchato-network': 1; profile: string; sig: string }

/** Why an envelope was refused: unreadable, forged, claims the public network's id, out of date, under another key than the one pinned, or older than the one held. */
export type RefuseWhy = 'shape' | 'signature' | 'reserved' | 'expired' | 'future' | 'key' | 'rollback'

export type OpenResult =
  | { ok: true; profile: OperatorProfile; envelope: NetworkEnvelope }
  | { ok: false; why: RefuseWhy; detail?: string }

const MAX_LIST = 8
const FUTURE_TOLERANCE_MS = 10 * 60_000

const b64d = (s: string) => Uint8Array.from(atob(s.trim()), (c) => c.charCodeAt(0))
const b64e = (u: Uint8Array) => btoa(String.fromCharCode(...u))

function isLoopback(host: string) { return host === 'localhost' || host === '127.0.0.1' || host === '[::1]' }

function httpsUrl(v: unknown, what: string): URL {
  if (typeof v !== 'string') throw new Error(`${what} is missing`)
  const u = new URL(v)
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && isLoopback(u.hostname))) throw new Error(`${what} must be https`)
  if (u.username || u.password || u.search || u.hash) throw new Error(`${what} carries credentials, a query or a fragment`)
  return u
}
function bareOrigin(v: unknown, what: string): string {
  const u = httpsUrl(v, what)
  if (u.pathname !== '/' || String(v).replace(/\/$/, '') !== u.origin) throw new Error(`${what} must be a bare origin`)
  return u.origin
}
function appAddress(v: any, what: string): AppAddress {
  if (!v || typeof v.path !== 'string' || !v.path.startsWith('/')) throw new Error(`${what}.path must start with /`)
  return { origin: bareOrigin(v.origin, `${what}.origin`), path: v.path }
}
function list<T>(v: unknown, what: string, each: (x: unknown, w: string) => T, allowEmpty = false): T[] {
  if (!Array.isArray(v) || (!allowEmpty && !v.length) || v.length > MAX_LIST) throw new Error(`${what} must be a list of 1-${MAX_LIST}`)
  return v.map((x, i) => each(x, `${what}[${i}]`))
}

/** Validate the profile's content. Throws with the reason. */
export function parseOperatorProfile(raw: unknown): OperatorProfile {
  const o = raw as any
  if (!o || typeof o !== 'object' || o.v !== 1) throw new Error('not a version 1 network profile')
  if (typeof o.networkId !== 'string' || !/^[A-Za-z0-9._-]{1,64}$/.test(o.networkId)) throw new Error('networkId must be 1-64 letters, digits, dot, dash or underscore')
  if (typeof o.operator !== 'string' || !o.operator.trim() || o.operator.length > 100) throw new Error('operator must be a name of 1-100 characters')
  let root: Uint8Array
  try { root = b64d(String(o.rootPub)) } catch { throw new Error('rootPub is not base64') }
  if (root.length !== 32) throw new Error('rootPub must be a 32-byte Ed25519 key')
  if (!Number.isSafeInteger(o.seq) || o.seq < 0) throw new Error('seq must be a whole number')
  if (!Number.isSafeInteger(o.made) || !Number.isSafeInteger(o.expires) || o.expires <= o.made) throw new Error('made/expires must be dates with expires after made')
  const nodes = parseNodeList(JSON.stringify({ v: 1, nodes: o.nodes }))
  const policy: NetworkPolicy = {}
  const p = o.policy ?? {}
  if (p.transport !== undefined) { if (p.transport !== 'node-only') throw new Error('policy.transport may only be "node-only"'); policy.transport = 'node-only' }
  if (p.softwareProfiles !== undefined) { if (typeof p.softwareProfiles !== 'boolean') throw new Error('policy.softwareProfiles must be true or false'); policy.softwareProfiles = p.softwareProfiles }
  if (p.allowPublic !== undefined) { if (typeof p.allowPublic !== 'boolean') throw new Error('policy.allowPublic must be true or false'); policy.allowPublic = p.allowPublic }
  return {
    v: 1,
    networkId: o.networkId,
    operator: o.operator.trim(),
    rootPub: b64e(root),
    seq: o.seq,
    made: o.made,
    expires: o.expires,
    nodes,
    stores: list(o.stores, 'stores', bareOrigin),
    app: appAddress(o.app, 'app'),
    legacyApp: list(o.legacyApp ?? [], 'legacyApp', (x, w) => appAddress(x, w), true),
    profileUrls: list(o.profileUrls, 'profileUrls', (x, w) => httpsUrl(x, w).href),
    feedback: o.feedback === null ? null : httpsUrl(o.feedback, 'feedback').href,
    home: httpsUrl(o.home, 'home').href,
    policy,
  }
}

/**
 * Open an envelope: signature (under the key inside the profile), content,
 * dates, and - when this network is already known here - the pinned key and
 * the sequence. Returns the reason when it refuses; never a partial result.
 */
export function openEnvelope(raw: unknown, now: number, pinned?: { rootPub: string; seq: number }, opts: { allowExpired?: boolean } = {}): OpenResult {
  let env: any = raw
  if (typeof raw === 'string') { try { env = JSON.parse(raw) } catch { return { ok: false, why: 'shape', detail: 'not JSON' } } }
  if (!env || env['onchato-network'] !== 1 || typeof env.profile !== 'string' || typeof env.sig !== 'string') {
    return { ok: false, why: 'shape', detail: 'not an onchato network file' }
  }
  let bytes: Uint8Array, doc: any
  try { bytes = b64d(env.profile); doc = JSON.parse(new TextDecoder().decode(bytes)) } catch { return { ok: false, why: 'shape', detail: 'the profile is not readable' } }
  let profile: OperatorProfile
  try { profile = parseOperatorProfile(doc) } catch (e: any) { return { ok: false, why: 'shape', detail: e.message } }
  let good = false
  try { good = ed25519.verify(b64d(env.sig), bytes, b64d(profile.rootPub)) } catch { good = false }
  if (!good) return { ok: false, why: 'signature' }
  if (profile.networkId === PUBLIC_NETWORK_ID) return { ok: false, why: 'reserved' }
  if (pinned && pinned.rootPub !== profile.rootPub) return { ok: false, why: 'key' }
  if (pinned && profile.seq < pinned.seq) return { ok: false, why: 'rollback' }
  if (now > profile.expires && !opts.allowExpired) return { ok: false, why: 'expired' }
  if (profile.made > now + FUTURE_TOLERANCE_MS) return { ok: false, why: 'future' }
  return { ok: true, profile, envelope: { 'onchato-network': 1, profile: env.profile, sig: env.sig.trim() } }
}

/** Sign a profile (the operator's tool; tests). The bytes signed are exactly the JSON produced here. */
export function signNetwork(profile: unknown, rootPrivB64: string): NetworkEnvelope {
  const bytes = new TextEncoder().encode(JSON.stringify(profile))
  return { 'onchato-network': 1, profile: b64e(bytes), sig: b64e(ed25519.sign(bytes, b64d(rootPrivB64))) }
}

/** The Ed25519 public key for a private one, base64 (tests, the operator's tool). */
export function rootPubFor(rootPrivB64: string): string {
  return b64e(ed25519.getPublicKey(b64d(rootPrivB64)))
}

/**
 * The fingerprint a person compares: SHA-256 of the root key, first 16 bytes,
 * as eight groups of four hex digits.
 */
export async function rootFingerprint(rootPubB64: string): Promise<string> {
  const h = new Uint8Array(await crypto.subtle.digest('SHA-256', b64d(rootPubB64) as BufferSource))
  const hex = Array.from(h.slice(0, 16), (b) => b.toString(16).padStart(2, '0')).join('')
  return hex.match(/.{4}/g)!.join(' ')
}

// ---- the device's registry ---------------------------------------------------

/** Where the imported networks live: public data (signed profiles), so not sealed. */
export const REGISTRY_KEY = 'ec-networks'

export interface KVLike { get(k: string): string | null; set(k: string, v: string): void; remove?(k: string): void }

export interface KnownNetwork { profile: OperatorProfile; envelope: NetworkEnvelope; expired: boolean }

/**
 * Every imported network, by id. A stored profile that has expired is still
 * returned (it names the nodes the network had; the app says it expired);
 * one that no longer opens at all (a damaged store) is left out of the answer,
 * not deleted.
 */
export function loadRegistry(kv: KVLike, now: number): Map<string, KnownNetwork> {
  const out = new Map<string, KnownNetwork>()
  let raw: any = {}
  try { raw = JSON.parse(kv.get(REGISTRY_KEY) || '{}') } catch { raw = {} }
  for (const [id, env] of Object.entries(raw ?? {})) {
    const r = openEnvelope(env, now, undefined, { allowExpired: true })
    if (r.ok && r.profile.networkId === id) out.set(id, { profile: r.profile, envelope: r.envelope, expired: now > r.profile.expires })
  }
  return out
}

export type RegisterResult =
  | { ok: true; profile: OperatorProfile; replaced: boolean }
  | { ok: false; why: RefuseWhy; detail?: string }

/**
 * Add a network, or refresh one already here. A network id already known keeps
 * its pinned key: an envelope under another key is refused (`key`), never
 * swapped in - a new key is a new network, joined as a new identity.
 */
export function registerNetwork(kv: KVLike, raw: unknown, now: number): RegisterResult {
  const known = loadRegistry(kv, now)
  let peek: OperatorProfile | null = null
  const first = openEnvelope(raw, now)
  if (first.ok) peek = first.profile
  const pinned = peek ? known.get(peek.networkId)?.profile : undefined
  const r = pinned ? openEnvelope(raw, now, { rootPub: pinned.rootPub, seq: pinned.seq }) : first
  if (!r.ok) return r
  let all: any = {}
  try { all = JSON.parse(kv.get(REGISTRY_KEY) || '{}') } catch { all = {} }
  all[r.profile.networkId] = r.envelope
  kv.set(REGISTRY_KEY, JSON.stringify(all))
  return { ok: true, profile: r.profile, replaced: !!pinned }
}

/**
 * Refresh a known network from the addresses its profile names: every one is
 * asked, each answer goes through registerNetwork (pinned key, seq never
 * backwards), and the highest seq that opens is kept - the same reasoning as
 * the release manifest: a source can replay an older profile, so one current
 * source must be enough to win. Resolves with the profile now held, and what
 * each source said.
 */
export async function refreshNetwork(
  kv: KVLike, id: string, now: number, fetchImpl: typeof fetch = fetch,
): Promise<{ ok: true; profile: OperatorProfile; changed: boolean; tried: { url: string; why: string }[] } | { ok: false; why: string; tried: { url: string; why: string }[] }> {
  const held = loadRegistry(kv, now).get(id)
  if (!held) return { ok: false, why: 'unknown', tried: [] }
  const tried: { url: string; why: string }[] = []
  const answers = await Promise.all(held.profile.profileUrls.map(async (url) => {
    try {
      const res = await fetchImpl(url, { cache: 'no-store' })
      if (!res.ok) { tried.push({ url, why: 'http' }); return null }
      const r = openEnvelope(await res.text(), now, { rootPub: held.profile.rootPub, seq: held.profile.seq })
      if (!r.ok) { tried.push({ url, why: r.why }); return null }
      if (r.profile.networkId !== id) { tried.push({ url, why: 'shape' }); return null }
      return r
    } catch { tried.push({ url, why: 'http' }); return null }
  }))
  let best: { profile: OperatorProfile; envelope: NetworkEnvelope } | null = null
  for (const a of answers) if (a && (!best || a.profile.seq > best.profile.seq)) best = a
  if (!best) return tried.length ? { ok: false, why: tried[0].why, tried } : { ok: false, why: 'http', tried }
  const changed = best.profile.seq > held.profile.seq
  if (changed) { const r = registerNetwork(kv, best.envelope, now); if (!r.ok) return { ok: false, why: r.why, tried } }
  return { ok: true, profile: changed ? best.profile : held.profile, changed, tried }
}

/**
 * A network arriving inside a moved profile (lib/migrate.ts). Accepted like an
 * import from the sign-in card - signature, the pinned key of a network already
 * here - with two differences that follow from what the file is: an EXPIRED
 * profile is kept (it still names the network's nodes, and the identity in the
 * file belongs to that network whatever its date), and an OLDER one than the
 * device holds is not an error - the device's newer copy simply stays.
 */
export function importNetwork(kv: KVLike, raw: unknown, now: number):
  { ok: true; id: string; kept: 'added' | 'newer' | 'already' } | { ok: false; why: RefuseWhy; detail?: string } {
  const r = openEnvelope(raw, now, undefined, { allowExpired: true })
  if (!r.ok) return r
  const held = loadRegistry(kv, now).get(r.profile.networkId)
  if (held && held.profile.rootPub !== r.profile.rootPub) return { ok: false, why: 'key' }
  if (held && r.profile.seq <= held.profile.seq) return { ok: true, id: r.profile.networkId, kept: 'already' }
  let all: any = {}
  try { all = JSON.parse(kv.get(REGISTRY_KEY) || '{}') } catch { all = {} }
  all[r.profile.networkId] = r.envelope
  kv.set(REGISTRY_KEY, JSON.stringify(all))
  return { ok: true, id: r.profile.networkId, kept: held ? 'newer' : 'added' }
}

// ---- a short pointer, for a QR code ----------------------------------------

/**
 * A network profile is 1-1.5 KB and grows with every node - a dense QR code.
 * A POINTER is ~120 characters whatever the network's size: where the signed
 * file is served, and the CID of its exact bytes, in the fragment (which a
 * browser never sends to the server):
 *
 *   https://acme.example/onchato/network.json#onchato-net=bafkrei...
 *
 * The address can be any server at all: bytes that do not hash to the CID are
 * refused before anything is parsed, and the bytes that do are then checked
 * like any other profile (signature, dates, pinned key). A CID alone would not
 * do - fetching by CID needs a store, and the new network's store is inside
 * the profile not yet held. The full envelope stays accepted wherever text is
 * (a file, a paste): it is what works offline.
 */
export const POINTER_TAG = 'onchato-net='

export interface NetworkPointer { url: string; cid: string }

/** A pointer in some text, or null. Only a CIDv1 of raw sha2-256 bytes is accepted - the one form lib/cid.ts can check. */
export function parseNetworkPointer(text: string): NetworkPointer | null {
  const m = /(https?:\/\/[^\s#]+)#onchato-net=(b[a-z2-7]{50,})/.exec(text.trim())
  if (!m) return null
  let u: URL
  try { u = new URL(m[1]) } catch { return null }
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && isLoopback(u.hostname))) return null
  if (u.username || u.password) return null
  if (!isVerifiableCid(m[2])) return null
  return { url: u.href, cid: m[2] }
}

/** The pointer for a file served at `url` with exactly these bytes (the operator's tool; tests). */
export async function pointerFor(url: string, fileBytes: Uint8Array): Promise<string> {
  return `${url.split('#')[0]}#${POINTER_TAG}${await cidV1Raw(fileBytes)}`
}

/** Fetch what a pointer names and check it IS what the pointer names; the text, or why not. */
export async function fetchPointed(p: NetworkPointer, fetchImpl: typeof fetch = fetch): Promise<{ ok: true; text: string } | { ok: false; why: 'http' | 'cid' }> {
  let bytes: Uint8Array
  try {
    const res = await fetchImpl(p.url, { cache: 'no-store' })
    if (!res.ok) return { ok: false, why: 'http' }
    bytes = new Uint8Array(await res.arrayBuffer())
  } catch { return { ok: false, why: 'http' } }
  if (!await cidMatches(p.cid, bytes)) return { ok: false, why: 'cid' }
  return { ok: true, text: new TextDecoder().decode(bytes) }
}
