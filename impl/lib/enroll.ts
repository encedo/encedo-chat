/**
 * enroll.ts - the device side of joining a network that admits devices by list
 * (relay/enroll.mjs is the node side; OPERATOR-NODE-PLAN.md, access tier B).
 *
 * The device asks its network's node for a challenge, signs it with the stable
 * libp2p key it dials with (lib/netkey.ts) - together with the administrator's
 * code when enrolling - and gets onto the node's list, or learns whether it is
 * on it. The messages must match relay/enroll.mjs byte for byte; a test holds
 * the two together.
 */
import { privateKeyFromProtobuf } from '@libp2p/crypto/keys'
import { netPeerId } from './netkey.ts'
import type { ActiveNetwork } from './activenet.ts'

export const enrollMessage = (networkId: string, nonce: string, code: string) => new TextEncoder().encode(`onchato-enroll-v1\n${networkId}\n${nonce}\n${code}`)
export const statusMessage = (networkId: string, nonce: string) => new TextEncoder().encode(`onchato-status-v1\n${networkId}\n${nonce}`)

/** Where a network's nodes enrol devices: the first node's host. */
export function enrollUrl(net: Pick<ActiveNetwork, 'nodes'>): string | null {
  for (const n of net.nodes) {
    const host = (n.addr.match(/\/dns[46]?\/([^/]+)/) ?? [])[1]
    if (host) return `https://${host}/onchato/enroll`
  }
  return null
}

export type EnrollResult =
  | { ok: true }
  | { ok: false; error: 'code' | 'locked' | 'slow-down' | 'challenge' | 'signature' | 'not-set-up' | 'network' | string; why?: string }

const b64 = (u: Uint8Array) => btoa(String.fromCharCode(...u))

async function signed(url: string, peerKey: Uint8Array, msgOf: (nonce: string) => Uint8Array, fetchImpl: typeof fetch) {
  const ch = await (await fetchImpl(`${url}/challenge`, { cache: 'no-store' })).json()
  if (typeof ch?.nonce !== 'string') throw new Error('no challenge')
  const sig = b64(await privateKeyFromProtobuf(peerKey).sign(msgOf(ch.nonce)))
  return { nonce: ch.nonce as string, sig, peerId: netPeerId(peerKey) }
}

/** Put this device on the network's list with the administrator's code. */
export async function enrollDevice(url: string, networkId: string, peerKey: Uint8Array, code: string, label = '', fetchImpl: typeof fetch = fetch): Promise<EnrollResult> {
  try {
    const s = await signed(url, peerKey, (n) => enrollMessage(networkId, n, code), fetchImpl)
    const res = await fetchImpl(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...s, code, label }) })
    const body: any = await res.json().catch(() => ({}))
    return res.ok && body?.ok ? { ok: true } : { ok: false, error: body?.error ?? `http-${res.status}`, why: body?.why }
  } catch (e: any) { return { ok: false, error: 'network', why: String(e?.message ?? e) } }
}

/** Is this device on the list? null when the node cannot be asked. */
export async function deviceStatus(url: string, networkId: string, peerKey: Uint8Array, fetchImpl: typeof fetch = fetch): Promise<{ listed: boolean; locked: boolean } | null> {
  try {
    const s = await signed(url, peerKey, (n) => statusMessage(networkId, n), fetchImpl)
    const res = await fetchImpl(`${url}/status`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(s) })
    if (!res.ok) return null
    const b: any = await res.json()
    return { listed: !!b.listed, locked: !!b.locked }
  } catch { return null }
}

// ---- the company variant: a sign-in at the network's identity provider ---------
// (relay/oidc.mjs is the node side.) The node is the OIDC client and holds the
// secret; the device only starts the sign-in, carries the authorization code
// back and signs it with its key. The nonce in the request binds the sign-in to
// the node's challenge and this device's PeerId - recomputed by the node.

const b64url = (u: Uint8Array) => btoa(String.fromCharCode(...u)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
const sha256 = async (s: string) => new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)))

/** The nonce the sign-in request carries; relay/oidc.mjs computes the same. */
export const oidcNonce = async (networkId: string, challengeNonce: string, peerId: string) =>
  b64url(await sha256(`onchato-oidc-v1\n${networkId}\n${challengeNonce}\n${peerId}`))

export interface OidcStart { nonce: string; authorize: string; clientId: string; redirectUri: string; scope: string }

/**
 * Everything to open the provider's sign-in with: the node's challenge (good for
 * 10 minutes) and its client details, plus this device's PKCE pair and state.
 * `issuer` comes from the SIGNED profile: the node's sign-in address must be on
 * the provider's host, or a node could send people to sign in anywhere.
 */
export async function oidcBegin(url: string, networkId: string, peerKey: Uint8Array, issuer: string, fetchImpl: typeof fetch = fetch, statePrefix = '') {
  const r = await fetchImpl(`${url}/challenge?for=oidc`, { cache: 'no-store' })
  const ch: OidcStart = await r.json()
  if (!r.ok || typeof ch?.nonce !== 'string' || typeof ch.authorize !== 'string') throw new Error((ch as any)?.why ?? 'the node did not start a sign-in')
  if (new URL(ch.authorize).host !== new URL(issuer).host) throw new Error(`the node's sign-in address (${new URL(ch.authorize).host}) is not the network's provider (${new URL(issuer).host})`)
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)))
  // `d.` marks a sign-in started by a packaged app (desktop or phone): oidc.html sends
  // it on to onchato:// instead of to a browser window of the app.
  const state = statePrefix + b64url(crypto.getRandomValues(new Uint8Array(16)))
  const q = new URLSearchParams({
    response_type: 'code', client_id: ch.clientId, redirect_uri: ch.redirectUri, scope: ch.scope || 'openid', state,
    nonce: await oidcNonce(networkId, ch.nonce, netPeerId(peerKey)), code_challenge: b64url(await sha256(verifier)), code_challenge_method: 'S256',
  })
  return { challenge: ch.nonce, verifier, state, authorizeUrl: `${ch.authorize}${ch.authorize.includes('?') ? '&' : '?'}${q}` }
}

/** Put this device on the list with the code its owner's sign-in returned. */
export async function enrollDeviceOidc(url: string, networkId: string, peerKey: Uint8Array, challenge: string, code: string, verifier: string, label = '', fetchImpl: typeof fetch = fetch): Promise<EnrollResult> {
  try {
    const sig = b64(await privateKeyFromProtobuf(peerKey).sign(enrollMessage(networkId, challenge, 'oidc:' + code)))
    const res = await fetchImpl(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ method: 'oidc', peerId: netPeerId(peerKey), nonce: challenge, code, verifier, sig, label }) })
    const body: any = await res.json().catch(() => ({}))
    return res.ok && body?.ok ? { ok: true } : { ok: false, error: body?.error ?? `http-${res.status}`, why: body?.why }
  } catch (e: any) { return { ok: false, error: 'network', why: String(e?.message ?? e) } }
}
