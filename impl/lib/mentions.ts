/**
 * mentions.ts — "@somebody" in a group message: find them, resolve them.
 *
 * The same rule that shapes `linkify.ts` shapes this: the body is plain text
 * (`format:'plain'`, `envelope.ts`) and stays plain text. Nothing here produces
 * markup — it returns RANGES and the UI decides what to draw.
 *
 * ## What travels
 *
 * `@Ala#3a7f1c02` — the name the SENDER saw, then four bytes of the mentioned
 * member's public key. No envelope field, no protocol change: a mention is a
 * convention about the contents of a message body, and an old client shows it
 * as the readable text it already is.
 *
 * ## Why the key hint is in there at all
 *
 * Names are local. My "Ala" is your "Alicja" and a third member has her under
 * eight characters of a fingerprint, because that is what a contact book is
 * here — see `memberName()` in the UI, which resolves at paint time precisely
 * so a name is never frozen into anything. A mention that travelled as a name
 * would arrive addressed to somebody who, on this device, does not exist.
 *
 * So the hint is what a mention MEANS and the name is only what it looked
 * like: the reader resolves the hint against the group roster and prints their
 * own name for that key. Two consequences, both wanted:
 *
 * - Nobody can make a mention read as somebody they are not. The text says
 *   `@Ala` and the chip says whatever YOUR contact book calls that key.
 * - A hint that matches nobody in the roster is left as **plain text**. It is
 *   not resolved against the wider contact book, and it is not drawn as a chip
 *   — otherwise a message could stage the presence of somebody who is not in
 *   the conversation, which is a claim no message gets to make.
 *
 * Four bytes is not collision-proof, and does not need to be: it is resolved
 * against one roster (single digits of members, not the world), and an
 * ambiguous hint is refused rather than guessed. The same 4-byte-hint,
 * refuse-on-collision shape as the roster blob in `gmarker.ts`.
 */

import { unb64 } from './wc.ts'

/** A mention found in a message body. Offsets are into the original text. */
export interface FoundMention {
  start: number
  end: number
  /** Exactly the substring at [start,end) — what an old client shows. */
  text: string
  /** The name as the sender saw it. Display fallback only; may be empty. */
  name: string
  /** 8 hex chars — the first four bytes of the mentioned public key. */
  hint: string
}

/** The first four bytes of a public key, as 8 lowercase hex chars. */
export function pubHint(pub: string): string {
  const b = unb64(pub)
  let s = ''
  for (let i = 0; i < 4 && i < b.length; i++) s += b[i].toString(16).padStart(2, '0')
  return s
}

/**
 * A name is what the mention looked like, so it travels as typed — minus the
 * two characters that would make the token unparseable, and minus anything
 * that could smuggle a second line into a message body.
 *
 * Exported because the composer writes this same form: what is typed has to be
 * a string `closeMentions` can find again, or the hint never gets attached.
 */
export function mentionName(name: string): string {
  return name.replace(/[@#]/g, '').replace(/\s+/g, ' ').trim().slice(0, 48).trim()
}
const safeName = mentionName

/** Build the text that travels: `@Ala#3a7f1c02`. */
export function mentionText(name: string, pub: string): string {
  return '@' + safeName(name) + '#' + pubHint(pub)
}

// The `@` must open a word — otherwise an email address is a mention of
// whoever comes after the `@`. A leading group instead of a lookbehind: the
// pattern has to hold in every engine this ships to, WebKitGTK included.
//
// The name may hold spaces, because contacts have surnames; it may not hold
// `@` or `#`, which is what keeps two mentions in a row from merging into one.
const MENTION_RE = /(^|[\s([{"'„«])@((?:[^\s@#]|[^\s@#][^@#\n]{0,46}[^\s@#])?)#([0-9a-fA-F]{8})(?![0-9a-zA-Z])/g

export function findMentions(text: string): FoundMention[] {
  const out: FoundMention[] = []
  for (const m of text.matchAll(MENTION_RE)) {
    const start = m.index! + m[1].length
    const raw = m[0].slice(m[1].length)
    out.push({ start, end: start + raw.length, text: raw, name: m[2], hint: m[3].toLowerCase() })
  }
  return out
}

/**
 * Which member a hint means — or nobody.
 *
 * `null` for "not in this group" and `null` for "two members of this group
 * start the same way". A guess would be worse than plain text in both cases.
 */
export function resolveMention(hint: string, pubs: string[]): string | null {
  const want = hint.toLowerCase()
  let hit: string | null = null
  for (const p of pubs) {
    let h: string
    try { h = pubHint(p) } catch { continue } // a malformed key resolves to nothing, it does not throw at paint time
    if (h !== want) continue
    if (hit && hit !== p) return null
    hit = p
  }
  return hit
}

/**
 * Split a body into alternating plain and mention pieces, in order, covering
 * the whole string. The UI walks this and never does arithmetic on offsets.
 */
export function splitByMentions(text: string): Array<{ text: string; mention?: FoundMention }> {
  const found = findMentions(text)
  if (!found.length) return [{ text }]
  const parts: Array<{ text: string; mention?: FoundMention }> = []
  let at = 0
  for (const f of found) {
    if (f.start > at) parts.push({ text: text.slice(at, f.start) })
    parts.push({ text: f.text, mention: f })
    at = f.end
  }
  if (at < text.length) parts.push({ text: text.slice(at) })
  return parts
}

/**
 * Finish the mentions somebody typed by hand: `@Ala` becomes `@Ala#3a7f1c02`
 * when exactly one member of the roster is called that.
 *
 * This is the ONLY place a hint is attached — what is typed, whether by hand or
 * by the picker, is the bare `@Ala` that a person wants to read while writing.
 * It matches the LONGEST roster name that fits at that position (so "Ala Nowak"
 * wins over "Ala" when both are members) and refuses on a tie of that longest
 * name: two people called Ala means the message keeps the plain word, which is
 * what the sender wrote anyway.
 *
 * `picked` is what the composer's picker chose, keyed by the lower-cased name it
 * wrote. It settles exactly that tie — the sender pointed at a row, so which Ala
 * they meant is known rather than guessed — and nothing else: a name that was
 * never picked is still resolved from the roster alone.
 */
export function closeMentions(
  text: string,
  roster: Array<{ pub: string; name: string }>,
  picked?: Map<string, string>,
): string {
  if (!text.includes('@') || !roster.length) return text
  const done = findMentions(text)
  const named = roster.filter((r) => safeName(r.name)).sort((a, b) => b.name.length - a.name.length)
  let out = ''
  let at = 0
  for (const m of text.matchAll(/(^|[\s([{"'„«])@/g)) {
    const start = m.index! + m[1].length
    if (start < at) continue
    if (done.some((d) => d.start === start)) continue // already carries a hint
    const rest = text.slice(start + 1)
    const fits = named.filter((r) => {
      const n = r.name
      if (rest.slice(0, n.length).toLowerCase() !== n.toLowerCase()) return false
      const after = rest[n.length]
      return after === undefined || /[\s.,;:!?)\]}'"]/.test(after)
    })
    if (!fits.length) continue
    const best = fits.filter((r) => r.name.length === fits[0].name.length)
    const chose = picked?.get(safeName(best[0].name).toLowerCase())
    const one = (chose && best.find((r) => r.pub === chose)) ?? best[0]
    // Two people, one name, nobody pointed at either: keep the plain word.
    if (!chose && best.length > 1 && new Set(best.map((r) => r.pub)).size > 1) continue
    out += text.slice(at, start) + mentionText(one.name, one.pub)
    at = start + 1 + one.name.length
  }
  return out + text.slice(at)
}

/** Does this body mention me? Used to light the "somebody called you" mark. */
export function mentionsPub(text: string, pub: string): boolean {
  if (!pub) return false
  const want = pubHint(pub)
  return findMentions(text).some((m) => m.hint === want)
}
