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
