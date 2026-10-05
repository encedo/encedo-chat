/**
 * safety.ts - the safety number of a pair (PROTOCOL.md §4.4.1).
 *
 * One string both people see IDENTICALLY, so verifying a contact is reading
 * one list aloud, not comparing "my key on your screen" with "my key on mine"
 * in both directions. The construction is Signal's numeric fingerprint:
 *
 *   half(pub) = SHA-512 iterated ITERATIONS times over
 *               h0 = SHA-512(LABEL || 0x00 || pub),  h = SHA-512(h || pub)
 *               -> first 30 bytes -> six 5-byte big-endian chunks, each
 *                  mod 100000, zero-padded to 5 digits = 30 digits
 *   number    = the two halves concatenated, the smaller string first
 *
 * Two halves, each pinned to ONE key, and not one hash over both keys: with a
 * single hash a man in the middle needs only two key pairs of his own that
 * collide on the displayed number (a birthday search, the square root of the
 * space); with halves he has to hit the half of a key he does not choose,
 * which costs the whole space times the iteration count. The order makes the
 * result independent of who computes it.
 *
 * Signal mixes a stable identifier (the phone number) into each half. There is
 * none here: the X25519 public key IS the identity (§4), so the label carries
 * the domain separation and the version.
 */

const te = new TextEncoder()
export const SAFETY_LABEL = 'encedo-chat-safety-v1'
export const SAFETY_ITERATIONS = 5200
/** What a safety-number QR code carries: this prefix and the 60 digits. */
export const SAFETY_QR_PREFIX = 'onchato-sn1:'

const sha512 = async (b: Uint8Array) => new Uint8Array(await crypto.subtle.digest('SHA-512', b as BufferSource))

function cat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let o = 0
  for (const p of parts) { out.set(p, o); o += p.length }
  return out
}

/** The 30 digits one key contributes. */
export async function safetyHalf(pub: Uint8Array): Promise<string> {
  if (pub.length !== 32) throw new Error('safety number: a public key is 32 bytes')
  let h = await sha512(cat(te.encode(SAFETY_LABEL), new Uint8Array([0]), pub))
  for (let i = 0; i < SAFETY_ITERATIONS; i++) h = await sha512(cat(h, pub))
  let out = ''
  for (let c = 0; c < 6; c++) {
    // 40 bits fit a double exactly (2^53), so no BigInt is needed.
    let v = 0
    for (let k = 0; k < 5; k++) v = v * 256 + h[c * 5 + k]
    out += String(v % 100000).padStart(5, '0')
  }
  return out
}

/** The pair's 60 digits - the same whichever side computes them. */
export async function safetyNumber(a: Uint8Array, b: Uint8Array): Promise<string> {
  const [x, y] = await Promise.all([safetyHalf(a), safetyHalf(b)])
  return x < y ? x + y : y + x
}

/** Twelve groups of five, the way the number is shown and read aloud. */
export const safetyGroups = (n: string): string[] => n.match(/\d{5}/g) ?? []

/** The QR payload for a number. */
export const safetyQr = (n: string): string => SAFETY_QR_PREFIX + n

/** The 60 digits a scanned code carries, or null when it is not ours. */
export function parseSafetyQr(text: string): string | null {
  const t = text.trim()
  if (!t.startsWith(SAFETY_QR_PREFIX)) return null
  const n = t.slice(SAFETY_QR_PREFIX.length)
  return /^\d{60}$/.test(n) ? n : null
}
