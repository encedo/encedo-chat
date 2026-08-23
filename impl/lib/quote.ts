/**
 * quote.ts — what a reply carries about the message it answers.
 *
 * A reply is an ordinary message with one optional field, `re` (`envelope.ts`):
 * the id of the message being answered, a hint at who wrote it, and a short
 * copy of what it said. Nothing here touches crypto or transport, and an old
 * client that does not know the field shows the reply as the message it is.
 *
 * ## Why the text travels, rather than the id alone
 *
 * The transcript is ephemeral by design: a reload takes it, and the other side
 * may have joined the room after the quoted message was said. An id-only quote
 * would therefore render as "message unavailable" most of the time it is used,
 * which is worse than not quoting. The snippet is content that already went
 * down this same channel under this same key — quoting it back adds no
 * exposure, only length, which is why it is clamped.
 *
 * ## Why the author is a key hint, not a name
 *
 * The same rule as `mentions.ts`: names are local. My "Ala" is your "Alicja",
 * so a quote that travelled as a name would attribute the words to somebody
 * who, on this device, does not exist. The hint is four bytes of the quoted
 * author's public key; the reader resolves it against the people in THIS
 * conversation and prints their own name for that key. A hint that matches
 * nobody there is left unresolved — the quote shows the words without a name
 * rather than staging the presence of somebody outside the room.
 */

import { pubHint } from './mentions.ts'

/** The quoted message, as it travels inside a reply. */
export interface QuoteRef {
  /** Id of the message being answered — the same id reactions and acks use. */
  id: string
  /** 8 hex chars: the first four bytes of the quoted author's public key. */
  au?: string
  /** What the quoted message looked like, clamped. Plain text, always. */
  text: string
}

/** Code points kept from the quoted message. One line of a bubble, no more. */
export const QUOTE_MAX = 160
/**
 * What a receiver will still accept. Deliberately looser than what we send: a
 * future build may quote a little more, and refusing it would drop the whole
 * quote over a length nobody can see anyway — the UI clips to one line.
 */
export const QUOTE_MAX_WIRE = 400

/**
 * The quoted text as it travels: one line, clamped, plain.
 *
 * Newlines go because a quote is drawn as a single clipped line and a message
 * that arrived with three of them would otherwise decide the height of somebody
 * else's bubble.
 */
export function quoteSnippet(text: string): string {
  const flat = (text ?? '').replace(/\s+/g, ' ').trim()
  const cp = [...flat]
  return cp.length <= QUOTE_MAX ? flat : cp.slice(0, QUOTE_MAX).join('') + '…'
}

/** Build the `re` field. `authorPub` is the quoted message's author, if known. */
export function makeQuote(id: string, text: string, authorPub?: string): QuoteRef {
  const q: QuoteRef = { id, text: quoteSnippet(text) }
  if (authorPub) q.au = pubHint(authorPub)
  return q
}

/**
 * Is this a quote we can render? Used by the envelope decoder, which drops a
 * malformed `re` and keeps the MESSAGE: a broken quote costs its own decoration,
 * never the sentence somebody wrote.
 */
export function isQuoteRef(x: any): x is QuoteRef {
  return !!x && typeof x === 'object'
    && typeof x.id === 'string' && x.id.length > 0 && x.id.length <= 64
    && typeof x.text === 'string' && x.text.length <= QUOTE_MAX_WIRE
    && (x.au === undefined || (typeof x.au === 'string' && /^[0-9a-f]{8}$/.test(x.au)))
}
