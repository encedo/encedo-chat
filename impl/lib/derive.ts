/**
 * derive.ts - the identity backend's derivation seam (docs/SPEC.md 4.3).
 *
 * Every IK-derived key on the wire is one HKDF over one ECDH with the identity
 * key: HKDF(ikm = ECDH(IK, peer), salt = ctx, info = label, L). A HEM runs that
 * in-device (firmware 1.3, `ecdhHkdf`), so the raw shared secret never exists
 * in client memory; a software identity derives over its own `ecdh` output and
 * wipes it at once.
 *
 * Consumers call `deriveWith(id, ...)` and never `id.ecdh` for a rendezvous,
 * announce, rotation, group-MAC or decoy derivation. The raw `ecdh` remains for
 * the three uses that need the bytes themselves: the EH-2 handshake (four
 * components are concatenated under one HKDF), the knock key (a DH with a
 * stranger's one-shot ephemeral) and the cache base of section 10.
 *
 * Several outputs of ONE ECDH (a pair topic and its Announce key) go through
 * `deriveManyWith`: one device call on a HEM instead of one per output.
 */

import { kdf } from './wc.ts'

/** The derivation an identity backend offers beside raw `ecdh`. */
export type Derive = (label: string | Uint8Array, peerPubB64: string, ctx: Uint8Array, len: number, peerKid?: string) => Promise<Uint8Array>
/** One output of a batched derivation. */
export interface DeriveItem { label: string | Uint8Array; ctx: Uint8Array; len: number }
/** Several outputs of one ECDH with one peer, in the order asked. */
export type DeriveMany = (items: DeriveItem[], peerPubB64: string, peerKid?: string) => Promise<Uint8Array[]>

/** What a consumer needs from an identity: raw ecdh, and the derivation when the backend has it. */
export interface Deriving {
  ecdh(peerPubB64: string, peerKid?: string): Promise<Uint8Array>
  derive?: Derive
  deriveMany?: DeriveMany
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

/** Several outputs of one ECDH with one peer: the backend's batch when it has
 *  one, else one derivation each. The bytes are the same either way. */
export async function deriveManyWith(id: Deriving, items: DeriveItem[], peerPubB64: string, peerKid?: string): Promise<Uint8Array[]> {
  if (id.deriveMany) return id.deriveMany(items, peerPubB64, peerKid)
  const out: Uint8Array[] = []
  for (const it of items) out.push(await deriveWith(id, it.label, peerPubB64, it.ctx, it.len, peerKid))
  return out
}

/** The firmware's floor for one HKDF output (`hkdf_len` 16..128) and its batch size. */
const HEM_MIN_LEN = 16
const HEM_BATCH = 8

/**
 * `derive` / `deriveMany` run INSIDE a HEM (firmware 1.3, `ecdhHkdf`): the
 * device computes ECDH(kid, peer) and an HKDF per item, and only the outputs
 * come back - the shared secret never does. Same convention as the client:
 * salt = ctx (none when empty), info = label.
 *
 * The device gives at least 16 bytes. A shorter output (the 4-byte rotation
 * offset) is the first `len` bytes of 16: HKDF-Expand's first block does not
 * depend on L, so they are byte for byte what HKDF with L = len gives. The
 * rest is wiped.
 */
export function hemDerivation(ecdhHkdf: (peer: { pubkey?: Uint8Array; extKid?: string }, items: Array<{ hkdfSalt: Uint8Array | null; hkdfCtx: string | Uint8Array; hkdfLen: number }>) => Promise<Uint8Array[]>, unb64: (s: string) => Uint8Array): { derive: Derive; deriveMany: DeriveMany } {
  const deriveMany: DeriveMany = async (items, peerPubB64, peerKid) => {
    const peer = peerKid ? { extKid: peerKid } : { pubkey: unb64(peerPubB64) }
    const out: Uint8Array[] = []
    for (let i = 0; i < items.length; i += HEM_BATCH) {
      const chunk = items.slice(i, i + HEM_BATCH)
      const okms = await ecdhHkdf(peer, chunk.map((it) => ({
        hkdfSalt: it.ctx.length ? it.ctx : null,
        hkdfCtx: it.label,
        hkdfLen: Math.max(it.len, HEM_MIN_LEN),
      })))
      if (okms.length !== chunk.length) throw new Error(`ecdhHkdf: ${okms.length} outputs for ${chunk.length} items`)
      okms.forEach((okm, j) => {
        const len = chunk[j].len
        if (okm.length === len) { out.push(okm); return }
        if (okm.length < len) throw new Error(`ecdhHkdf: ${okm.length} bytes, asked for ${len}`)
        out.push(okm.slice(0, len)); okm.fill(0)
      })
    }
    return out
  }
  const derive: Derive = async (label, peerPubB64, ctx, len, peerKid) => (await deriveMany([{ label, ctx, len }], peerPubB64, peerKid))[0]
  return { derive, deriveMany }
}
