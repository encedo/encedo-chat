/**
 * msgsize.ts - how long a message may be before the relay refuses it.
 *
 * GossipSub on the node caps a frame at 65536 bytes (`maxMessageSize` in
 * relay/relay.mjs). Past that the publish is dropped by the transport, and
 * everything the app could say about it afterwards is a guess - so the limit
 * is enforced HERE, where the text still exists and the person is still
 * looking at it.
 *
 * ## Bytes on the wire, not characters on the screen
 *
 * Three things make a character count the wrong measure, and all three are
 * ordinary rather than exotic:
 *
 *   - UTF-8: "ż" is two bytes, an emoji is four.
 *   - JSON: the envelope is `JSON.stringify`d, so every quote and every
 *     newline becomes TWO characters. A message that is mostly line breaks
 *     nearly doubles on the way out - and the multi-line composer made exactly
 *     that shape easy to type.
 *   - The envelope itself: id, timestamp, sequence, format, a reply reference.
 *
 * So the measure is the encoded body, and the budget is what is left of the
 * frame after the envelope and the EH-2 seal. Measured from a real session:
 * a 16-character message goes out as a 162-byte frame, so the fixed cost is
 * about 146 bytes; 1 KB of headroom covers that with room for a reply
 * reference and anything a later envelope field adds.
 */

/** The relay's ceiling. Keep in step with `maxMessageSize` in relay/relay.mjs. */
export const WIRE_MAX = 65_536

/** Envelope + seal, with room to spare over the ~146 bytes measured. */
export const OVERHEAD = 1_024

/** What is left for the text itself, once encoded. */
export const MAX_BODY = WIRE_MAX - OVERHEAD

/** Exactly what the body will occupy inside the envelope. */
export const bodyBytes = (text: string): number =>
  new TextEncoder().encode(JSON.stringify(text)).length

export const fitsOnWire = (text: string): boolean => bodyBytes(text) <= MAX_BODY

/** How far over the limit, in bytes. Zero or less means it fits. */
export const overBy = (text: string): number => bodyBytes(text) - MAX_BODY

/**
 * When to start showing a count at all.
 *
 * Not before: a byte counter over an ordinary sentence is noise, and it would
 * teach people to think about a limit that will never affect them. At nine
 * tenths it stops being noise and starts being a warning.
 */
export const WARN_AT = Math.floor(MAX_BODY * 0.9)

/** Kilobytes, for a person: 63.0 KB. */
export const kb = (bytes: number): string => `${(bytes / 1024).toFixed(1)} KB`
