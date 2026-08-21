/**
 * pincache.ts — the few messages somebody chose to keep, sealed at rest.
 *
 * A conversation here is deliberately ephemeral: the transcript lives in RAM,
 * a reload takes it, and nothing on this device remembers what was said. That
 * is a property of the product, not an omission, which is why a general local
 * archive was turned down. Pinning is the narrow exception a person opens by
 * hand, one message at a time, and the interface says so before the first one
 * is written.
 *
 * ## Key schedule — the §10 one, with its own salt
 *
 * Identical construction to `gcache.ts`, and deliberately so:
 *
 *   base   = ECDH(IK, emp_pub)                       // one id.ecdh per session
 *   k_room = HKDF(base, salt="encedo-chat-pin-cache-v1", info=roomId)
 *   blob   = iv ‖ AES-256-GCM(k_room, iv, plaintext)
 *
 * `base` is identity-agnostic — a HEM holds IK in the HSM, a software identity
 * holds it in a sealed profile, and both reach the same secret — so pinning
 * works the same way under either without knowing which is in use.
 *
 * The salt DIFFERS from the group cache's on purpose: same base, same room id,
 * different context, so a pin blob cannot be opened as a group blob (or the
 * reverse) even by us, by accident, after a refactor. And binding the key to
 * `roomId` means one conversation's pins never open another's.
 *
 * ## What it refuses
 *
 * A full list refuses the 33rd pin rather than dropping the oldest. Silently
 * discarding something a person deliberately kept is the worst failure this
 * feature has available; being told "the limit is reached" is merely annoying.
 */

import { subtle, hkdfBits, b64, unb64, randomBytes } from './wc.ts'

/** One kept message. `id` is the message id it was pinned from. */
export interface Pin {
  id: string
  text: string
  /** When it was SAID — pins read in the order of the conversation, not of pinning. */
  ts: number
  /** Sender label for a group; absent in a 1:1, where the header already says who. */
  who?: string
  /** Was it ours — the bubble comes back on the same side it went out on. */
  mine: boolean
  pinnedAt: number
}

/** How many a single conversation may keep. Reached = refuse, never evict. */
export const PIN_LIMIT = 32

const enc = new TextEncoder()
const PIN_SALT = enc.encode('encedo-chat-pin-cache-v1')

async function roomKey(base: Uint8Array, roomId: string): Promise<CryptoKey> {
  const raw = await hkdfBits(base, PIN_SALT, enc.encode(roomId), 32)
  return subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt'])
}

/** Seal a room's pin list → base64(iv ‖ ct). */
export async function sealPins(base: Uint8Array, roomId: string, pins: Pin[]): Promise<string> {
  const key = await roomKey(base, roomId)
  const iv = randomBytes(12)
  const pt = enc.encode(JSON.stringify({ v: 1, pins }))
  const ct = new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv }, key, pt))
  const out = new Uint8Array(iv.length + ct.length)
  out.set(iv); out.set(ct, iv.length)
  return b64(out)
}

/**
 * Open a room's pin list, or `null` if it does not open — wrong identity, wrong
 * room, tampered, or written by a version that meant something else by it.
 *
 * Never throws: this runs while a conversation is being shown, and a cache that
 * cannot be read is a cache that is ignored, not an error the user is handed.
 */
export async function openPins(base: Uint8Array, roomId: string, blob: string): Promise<Pin[] | null> {
  try {
    const bytes = unb64(blob)
    const key = await roomKey(base, roomId)
    const pt = new Uint8Array(await subtle.decrypt({ name: 'AES-GCM', iv: bytes.slice(0, 12) }, key, bytes.slice(12)))
    const obj = JSON.parse(new TextDecoder().decode(pt))
    if (!obj || obj.v !== 1 || !Array.isArray(obj.pins)) return null
    return sortPins(obj.pins.filter(isPin)).slice(0, PIN_LIMIT)
  } catch { return null }
}

const isPin = (p: any): p is Pin =>
  !!p && typeof p.id === 'string' && typeof p.text === 'string' && Number.isFinite(p.ts)

/** In the order the messages were said — which is the order they are read in. */
const sortPins = (pins: Pin[]): Pin[] => [...pins].sort((a, b) => a.ts - b.ts || a.id.localeCompare(b.id))

/**
 * Add one. Returns the new list, the SAME list when that message is already
 * pinned (so the caller can tell nothing changed), or `null` when the room is
 * full — see the refusal note at the top.
 */
export function withPin(pins: Pin[], pin: Pin): Pin[] | null {
  if (pins.some((p) => p.id === pin.id)) return pins
  if (pins.length >= PIN_LIMIT) return null
  return sortPins([...pins, pin])
}

/** Remove one. Unpinning something that is not pinned is not an error. */
export function withoutPin(pins: Pin[], id: string): Pin[] {
  return pins.filter((p) => p.id !== id)
}
