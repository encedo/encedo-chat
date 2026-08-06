/**
 * invite.ts — "here is my key" as a link.
 *
 * The payload rides in the URL **fragment**, which browsers never send to the
 * server: it is absent from the access log and from the `Referer` of anything
 * the page later opens. Put in the path or the query instead, onchato.com would
 * accumulate a record of who invited whom — a social graph, and the one asset
 * the rest of this architecture exists to not hold.
 *
 * **Nothing here is encrypted, and that is deliberate.** What travels is a
 * public key. The risk is not that someone reads it; it is that someone
 * REPLACES it in transit and becomes a permanent man in the middle. That calls
 * for authenticity, and authenticity is what the fingerprint comparison in the
 * import dialog provides — 64 bits, spoken over a channel the attacker does not
 * control.
 *
 * A six-digit PIN sealing the payload was considered and rejected. The
 * ciphertext would be in the attacker's hands, 20 bits is seconds of offline
 * work at any KDF cost, and after recovering it they can seal THEIR key under
 * the same PIN and forward it — the recipient types the PIN they were told, it
 * opens, and the substitution is complete. It would defend only against a
 * passive observer, of data that is already public, while looking enough like a
 * safeguard to stop anyone checking the fingerprint that actually works.
 *
 * An expiry was rejected for a different reason: it defends nothing. A pair's
 * rendezvous topic is `ECDH(IK_a, IK_b)` (see `deriveRoom`), so someone who
 * imports your key unilaterally cannot reach you — they publish to a topic you
 * never subscribe to, because reaching it needs YOUR copy of THEIR key. An
 * invite that leaks is inert on its own.
 */

/** Longest display name accepted from a link. Long enough for a real name,
 *  short enough that it cannot be used to wreck the contact list. */
export const MAX_NAME = 64

export interface Invite { pub: string; name: string }

const b64urlEncode = (s: string) =>
  btoa(unescape(encodeURIComponent(s))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')

const b64urlDecode = (s: string) =>
  decodeURIComponent(escape(atob(s.replace(/-/g, '+').replace(/_/g, '/'))))

/** The fragment an invite link carries, without the leading `#`. */
export function encodeInvite(inv: Invite): string {
  return 'i=' + b64urlEncode(JSON.stringify({ p: inv.pub, n: inv.name.slice(0, MAX_NAME) }))
}

export function inviteLink(origin: string, path: string, inv: Invite): string {
  return `${origin}${path}#${encodeInvite(inv)}`
}

/**
 * Read an invite out of a fragment, or return null.
 *
 * Everything here arrives from a URL somebody else wrote, so it is all checked:
 * a name is trimmed of control characters and capped before it can reach the
 * contact list, and a key is required to be exactly 32 bytes rather than merely
 * decodable — a wrong-length "key" would otherwise fail much later, inside an
 * ECDH, as something that looks like a broken peer.
 */
export function decodeInvite(hash: string): Invite | null {
  const frag = hash.replace(/^#/, '')
  if (!frag.startsWith('i=')) return null
  let obj: any
  try { obj = JSON.parse(b64urlDecode(frag.slice(2))) } catch { return null }
  if (!obj || typeof obj.p !== 'string' || typeof obj.n !== 'string') return null

  let raw: Uint8Array
  try { raw = Uint8Array.from(atob(obj.p), (c) => c.charCodeAt(0)) } catch { return null }
  if (raw.length !== 32) return null

  // Cc and Cf together: line breaks, and the invisible formatting characters —
  // direction overrides, zero-width spaces, the byte-order mark. A name is
  // something the user is asked to RECOGNISE, so it may not carry text that
  // reorders what they see or takes up space while rendering as nothing. The
  // emptiness check comes AFTER the strip, or a name made only of those
  // characters arrives as a contact with no visible name at all.
  const name = obj.n.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, '').trim().slice(0, MAX_NAME)
  if (!name) return null
  return { pub: obj.p, name }
}
