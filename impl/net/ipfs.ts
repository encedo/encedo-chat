/**
 * ipfs.ts — putting an encrypted blob somewhere the other side can fetch it.
 *
 * The client talks to **its own origin** (`/f`), which nginx proxies to the
 * IPFS RPC. Three things follow from that, and they are the reason for it:
 *
 * - **No CORS.** Same origin, so no preflight and no allow-list to maintain.
 * - **The IP allow-list on the node stays one address** — the web host's —
 *   instead of having to admit arbitrary phones on mobile networks.
 * - **The browser never learns the node exists.** One less piece of
 *   infrastructure visible to anyone watching a client.
 *
 * It matters that the client cannot reach the RPC directly: Kubo's RPC is an
 * ADMIN api — `config`, `shutdown`, `files`, `key` all live at the same
 * endpoint as `add`. Only `add` and `cat` are proxied, and nothing here should
 * ever be given a URL that reaches further.
 *
 * **The blob is already ciphertext when it arrives here.** This module does no
 * crypto: `lib/filecrypto.ts` encrypts, the key and the manifest travel in the
 * envelope over the ratchet, and the store sees a nameless blob and its size.
 *
 * Lifetime is short by design — the product is a conversation, not a mailbox.
 * The node keeps uploads unpinned under an MFS path named with the upload's
 * epoch, and a job on the node removes entries past the TTL and collects them.
 * So a fetch can legitimately return 404 for a file that existed: the UI must
 * say "expired", not "failed".
 */

/** Where the app's own origin exposes the two operations. */
export const IPFS_PUT = '/f'
export const IPFS_GET = (cid: string) => `/f/${encodeURIComponent(cid)}`

export interface PutResult { cid: string; size: number }

/** A CID as Kubo returns it — base32 CIDv1 or base58 CIDv0. Checked because it
 *  is interpolated into a URL and arrives from the network. */
export function isCid(s: string): boolean {
  return /^(Qm[1-9A-HJ-NP-Za-km-z]{44}|b[a-z2-7]{50,})$/.test(s)
}

export interface PutOpts {
  /** Progress in bytes uploaded, for a file large enough to need a bar. */
  onProgress?: (sent: number, total: number) => void
  signal?: AbortSignal
  /** Injected in tests; defaults to the global. */
  fetchImpl?: typeof fetch
}

/**
 * Upload ciphertext. Returns the CID, which is a hash of exactly these bytes —
 * so the sender puts it in the envelope and the receiver gets integrity of the
 * whole blob for free, authenticated by the channel the envelope travelled on.
 */
export async function putBlob(bytes: Uint8Array | Blob, opts: PutOpts = {}): Promise<PutResult> {
  const f = opts.fetchImpl ?? fetch
  const body = new FormData()
  // Kubo's /add wants multipart. The name is a placeholder: the real one is in
  // the envelope, and the store has no business knowing it.
  body.append('file', bytes instanceof Blob ? bytes : new Blob([bytes as any]), 'b')
  const res = await f(IPFS_PUT, { method: 'POST', body, signal: opts.signal })
  if (!res.ok) throw new Error(`upload failed: HTTP ${res.status}`)
  const text = (await res.text()).trim()
  // /add streams one JSON object per line; the last is the root.
  const last = text.split('\n').filter(Boolean).pop()
  if (!last) throw new Error('upload returned nothing')
  let j: any
  try { j = JSON.parse(last) } catch { throw new Error(`upload returned non-JSON: ${last.slice(0, 120)}`) }
  const cid = j.Hash ?? j.Cid?.['/']
  if (typeof cid !== 'string' || !isCid(cid)) throw new Error(`upload returned no usable CID: ${last.slice(0, 120)}`)
  return { cid, size: Number(j.Size) || 0 }
}

export class ExpiredError extends Error {
  constructor(cid: string) { super(`file is gone: ${cid}`); this.name = 'ExpiredError' }
}

/**
 * Fetch ciphertext by CID.
 *
 * A 404 or 410 is reported as `ExpiredError` rather than a generic failure,
 * because for this store that is the ordinary end of a file's life and the UI
 * has to distinguish it from a network problem: one says "ask them to send it
 * again", the other says "try again".
 */
export async function getBlob(cid: string, opts: { signal?: AbortSignal; fetchImpl?: typeof fetch } = {}): Promise<Uint8Array> {
  if (!isCid(cid)) throw new Error(`not a CID: ${cid}`)
  const f = opts.fetchImpl ?? fetch
  const res = await f(IPFS_GET(cid), { signal: opts.signal })
  if (res.status === 404 || res.status === 410) throw new ExpiredError(cid)
  if (!res.ok) throw new Error(`fetch failed: HTTP ${res.status}`)
  return new Uint8Array(await res.arrayBuffer())
}
