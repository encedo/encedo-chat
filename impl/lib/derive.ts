/**
 * derive.ts - the identity backend's derivation seam (docs/SPEC.md 4.3).
 *
 * Every IK-derived key on the wire is one HKDF over one ECDH with the identity
 * key: HKDF(ikm = ECDH(IK, peer), salt = ctx, info = label, L). Where the
 * backend can run that in-device (HEM firmware with ecdh+HKDF in one call), the
 * raw shared secret never exists in client memory; where it cannot, the client
 * derives over the raw `ecdh` output and wipes it at once.
 *
 * Consumers call `deriveWith(id, ...)` and never `id.ecdh` for a rendezvous,
 * announce, rotation, group-MAC or decoy derivation. The raw `ecdh` remains for
 * the three uses that need the bytes themselves: the EH-2 handshake (four
 * components are concatenated under one HKDF), the knock key (a DH with a
 * stranger's one-shot ephemeral) and the cache base of section 10.
 *
 * FIRMWARE SEAM: when the SDK exposes the in-device call, only the backends'
 * `derive` implementations change (lib/core.ts hemIdentityFrom and
 * hemGkBackend); every consumer is already on this function.
 */

import { kdf } from './wc.ts'

/** The derivation an identity backend offers beside raw `ecdh`. */
export type Derive = (label: string, peerPubB64: string, ctx: Uint8Array, len: number, peerKid?: string) => Promise<Uint8Array>

/** What a consumer needs from an identity: raw ecdh, and the derivation when the backend has it. */
export interface Deriving {
  ecdh(peerPubB64: string, peerKid?: string): Promise<Uint8Array>
  derive?: Derive
}

/** `HKDF(ECDH(IK, peer), salt = ctx, info = label, L)` through the backend's own
 *  derivation when it has one, else over its raw ecdh (the secret wiped after). */
export async function deriveWith(id: Deriving, label: string, peerPubB64: string, ctx: Uint8Array, len = 32, peerKid?: string): Promise<Uint8Array> {
  if (id.derive) return id.derive(label, peerPubB64, ctx, len, peerKid)
  const ss = await id.ecdh(peerPubB64, peerKid)
  try { return await kdf(label, ss, ctx, len) } finally { ss.fill(0) }
}

/** The client-side realisation of `derive` over a raw ecdh - what a software
 *  identity uses (its key is on this device anyway), and what the HEM backend
 *  uses until the firmware derives in-device. */
export function deriveOverEcdh(ecdh: (peerPubB64: string, peerKid?: string) => Promise<Uint8Array>): Derive {
  return async (label, peerPubB64, ctx, len, peerKid) => {
    const ss = await ecdh(peerPubB64, peerKid)
    try { return await kdf(label, ss, ctx, len) } finally { ss.fill(0) }
  }
}
