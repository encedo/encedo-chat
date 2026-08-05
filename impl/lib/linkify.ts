/**
 * linkify.ts — find URLs in a message, and say what is safe to do with them.
 *
 * The message body is plain text and stays plain text (`format:'plain'`,
 * `envelope.ts`); nothing here produces markup. It returns RANGES, and the UI
 * decides what to draw — which keeps the one rule that matters unbroken: a
 * message is never interpreted as HTML.
 *
 * The display text is deliberately NOT the clickable thing. In this UI the URL
 * stays inert text and a separate arrow opens it, so what you read and what you
 * would visit cannot differ — which is the whole mechanism behind a phishing
 * link. That is a UI decision, but it is why this module has no notion of
 * "link text": there is none to disagree with the target.
 *
 * What it refuses, and why:
 *
 * - **Anything but http/https.** `javascript:` is script execution, `data:` is
 *   an arbitrary document under our own origin's nose, `file:` reads the
 *   device. None of them are things a stranger's message gets to propose.
 * - **Credentials in the authority** (`https://good.com@evil.com`). The part a
 *   human reads as the site is the part before the `@`; the browser goes to the
 *   part after it. There is no honest use of this in a chat message.
 * - It flags, rather than refuses, a **non-ASCII host**: `аpple.com` with a
 *   Cyrillic `а` is a different domain that renders identically. The caller
 *   gets the punycode so it can show what the browser will actually resolve.
 */

/** A URL found in a message body. Offsets are into the original text. */
export interface FoundLink {
  start: number
  end: number
  /** Exactly the substring at [start,end) — what the reader sees. */
  text: string
  /** Where it actually goes. Absent when the URL is one we refuse to open. */
  href?: string
  /** Set when the URL is refused or needs a warning; a short reason. */
  warn?: string
  /** Punycode host when the display host is not ASCII — what the browser resolves. */
  asciiHost?: string
}

// Deliberately narrow: an explicit scheme, no bare "www." or "example.com".
// Guessing a scheme means guessing intent, and getting it wrong here sends
// someone somewhere they did not choose.
const URL_RE = /\bhttps?:\/\/[^\s<>"']+/gi

/** Trailing characters that end a sentence far more often than a URL. */
function trimTrailing(s: string): string {
  let end = s.length
  while (end > 0) {
    const c = s[end - 1]
    if ('.,;:!?'.includes(c)) { end--; continue }
    // A closing bracket is only sentence punctuation if it closes something the
    // URL never opened. `…/X_(Y)` is balanced and keeps its bracket; `(…/x)` is
    // not, and gives it back to the sentence.
    if (c === ')' || c === ']' || c === '}') {
      const open = { ')': '(', ']': '[', '}': '{' }[c]!
      const inner = s.slice(0, end)
      const opens = inner.split(open).length - 1
      const closes = inner.split(c).length - 1
      if (opens < closes) { end--; continue }
    }
    break
  }
  return s.slice(0, end)
}

const isAscii = (s: string) => /^[\x00-\x7F]*$/.test(s)

export function findLinks(text: string): FoundLink[] {
  const out: FoundLink[] = []
  for (const m of text.matchAll(URL_RE)) {
    const raw = trimTrailing(m[0])
    if (!raw) continue
    const start = m.index!
    const found: FoundLink = { start, end: start + raw.length, text: raw }
    let u: URL
    try { u = new URL(raw) } catch { found.warn = 'malformed'; out.push(found); continue }

    if (u.protocol !== 'http:' && u.protocol !== 'https:') {
      found.warn = 'scheme'          // unreachable via URL_RE today; kept as the invariant
    } else if (u.username || u.password) {
      // https://bank.example.com@attacker.tld — reads as one site, visits another.
      found.warn = 'credentials'
    } else {
      found.href = u.toString()
      // `URL` punycodes the host for us. If what was typed is not ASCII, the
      // reader and the resolver are looking at different strings — `аpple.com`
      // with a Cyrillic а renders identically to the real one — so hand back
      // what the browser will actually resolve and let the UI show it.
      const typedHost = raw.slice(raw.indexOf('//') + 2).split(/[/?#]/)[0]
      if (!isAscii(typedHost)) { found.asciiHost = u.hostname; found.warn = 'idn' }
    }
    out.push(found)
  }
  return out
}

/**
 * Split a body into alternating plain and link pieces, in order, covering the
 * whole string. The UI walks this and never has to do arithmetic on offsets.
 */
export function splitByLinks(text: string): Array<{ text: string; link?: FoundLink }> {
  const links = findLinks(text)
  if (!links.length) return [{ text }]
  const parts: Array<{ text: string; link?: FoundLink }> = []
  let at = 0
  for (const l of links) {
    if (l.start > at) parts.push({ text: text.slice(at, l.start) })
    parts.push({ text: l.text, link: l })
    at = l.end
  }
  if (at < text.length) parts.push({ text: text.slice(at) })
  return parts
}
