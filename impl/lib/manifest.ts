/**
 * manifest.ts - the signed release manifest (ARCHITECTURE.md, Distribution).
 *
 * Until this existed the node list's integrity was a CID compiled into the
 * build, and the releases rested on three keys that live in CI. The manifest
 * puts one key above all of that: an Ed25519 key kept OFFLINE by the operator
 * signs, per release, what a client may trust - the web bundle's CID and SRI,
 * the node list's CID, the CI keys that signed the installers - with an
 * expiry, so a stale manifest cannot be replayed forever. The public half is
 * compiled into every client (`infra/root.pub`); refreshing the node list now
 * means fetching the manifest, checking the signature and the date, and only
 * then the list it names, which is checked against its CID as before.
 *
 * Plain Ed25519 over the manifest file's exact bytes - not minisign, whose
 * prehash is BLAKE2b, which WebCrypto does not have. Any Ed25519 library can
 * verify this; `@noble/curves` does it here, in the browser and in Node alike.
 */

import { ed25519 } from '@noble/curves/ed25519'

export interface Manifest {
  v: 1
  /** The release this describes: the client version and the commit it was built from. */
  version: string
  commit: string
  /** When it was signed and until when it may be trusted (epoch ms, UTC). */
  made: number
  expires: number
  web: { cid: string; bundle: string; sri: string }
  nodes: { cid: string }
  ci: { updater_pubkey: string }
}

export type ManifestVerdict =
  | { ok: true; manifest: Manifest }
  | { ok: false; why: 'signature' | 'shape' | 'expired' | 'future' }

/** A signature may not be from the future by more than the clock tolerance. */
const FUTURE_TOLERANCE_MS = 10 * 60_000

const b64d = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0))

export const isManifest = (m: any): m is Manifest =>
  !!m && m.v === 1 && typeof m.version === 'string' && typeof m.commit === 'string'
  && Number.isInteger(m.made) && Number.isInteger(m.expires) && m.expires > m.made
  && !!m.web && typeof m.web.cid === 'string' && typeof m.web.bundle === 'string' && typeof m.web.sri === 'string'
  && !!m.nodes && typeof m.nodes.cid === 'string'
  && !!m.ci && typeof m.ci.updater_pubkey === 'string'

/**
 * Check the signature over the file's exact bytes, then the shape, then the
 * dates. Returns the parsed manifest only when all three hold.
 */
export function verifyManifest(raw: Uint8Array, sigB64: string, rootPubB64: string, now: number): ManifestVerdict {
  let ok = false
  try { ok = ed25519.verify(b64d(sigB64.trim()), raw, b64d(rootPubB64.trim())) } catch { ok = false }
  if (!ok) return { ok: false, why: 'signature' }
  let m: any
  try { m = JSON.parse(new TextDecoder().decode(raw)) } catch { return { ok: false, why: 'shape' } }
  if (!isManifest(m)) return { ok: false, why: 'shape' }
  if (now > m.expires) return { ok: false, why: 'expired' }
  if (m.made > now + FUTURE_TOLERANCE_MS) return { ok: false, why: 'future' }
  return { ok: true, manifest: m }
}

/** Sign the file's exact bytes (the release script; tests). */
export function signManifest(raw: Uint8Array, privB64: string): string {
  return btoa(String.fromCharCode(...ed25519.sign(raw, b64d(privB64.trim()))))
}

export const rootPubOf = (privB64: string): string =>
  btoa(String.fromCharCode(...ed25519.getPublicKey(b64d(privB64.trim()))))
