/**
 * localbook.ts - the sealed local contact book (SPEC.md §4.4), over any KV.
 *
 * It lived in the web app, bound to localStorage. The CLI keeps the same keys
 * in a file (cli/store.ts), and a contact book is the thing that must not have
 * two implementations: a profile carried between the browser and the terminal
 * has to open with the same contacts and the same verdict on it.
 *
 *   names.fixed.book          the book, sealed (lib/localstore.ts)
 *   names.fixed.emp           the public half of the §10 cache secret's emp key
 *
 * ## Sealed, and only sealed (0.8.0)
 *
 * The book is AES-GCM under the §10 base: integrity is the property the crypto
 * rests on (swap a `pub` and the app handshakes with the attacker), and the seal
 * also hides WHO this identity knows. A blob that does not open is `tampered`,
 * never "empty": an empty book there would let anybody who can write the store
 * erase someone's contacts without a trace, and the next write would seal the
 * empty list over the evidence.
 *
 * Anything that is not a sealed blob - the plain and MAC'd formats of the
 * builds before 0.7.34 - is `tampered` too. Those formats were sealed on the
 * spot by 0.7.34..0.8.x; their readers are gone with 0.8.2, so a book still in
 * one is either a profile untouched since then or somebody's substitute, and
 * the two cannot be told apart.
 */

import { localContactBook, type ContactBook, type Identity } from './core.ts'
import { sealLocal, openLocal } from './localstore.ts'
import { generateX25519 } from './x25519.ts'
import type { KV } from './migrate.ts'
import type { Names } from './storenames.ts'

const b64 = (u: Uint8Array) => btoa(String.fromCharCode(...u))

/** The book's own salt (SPEC.md §10). */
export const BOOK_SEAL_SALT = 'encedo-chat-contact-book-v2'

/**
 * What opening the book found: `ok` (sealed and opened, or none yet),
 * `unsigned` (no ECDH base, so kept unprotected - an identity that refuses
 * ECDH), `tampered` (present and not a sealed book this identity wrote).
 */
export type Verdict = 'ok' | 'unsigned' | 'tampered'

type Entry = { name: string; pub: string }
const isList = (v: any): v is Entry[] => Array.isArray(v)

/**
 * The §10 cache master secret ECDH(IK, emp_pub). `emp_pub` is random and kept in
 * the store; IK never leaves its backend. Null when the identity will not do
 * ECDH (a refusing HSM): the book then runs unsealed rather than not at all.
 */
export async function cacheBaseOf(id: Identity, names: Names, kv: KV, log?: (m: string) => void): Promise<Uint8Array | null> {
  const key = names.fixed.emp
  let empPub = kv.get(key)
  if (!empPub) { empPub = b64((await generateX25519()).pub); kv.set(key, empPub) }
  try { return await id.ecdh(empPub) } catch (e: any) { log?.('cache base: ecdh failed - ' + (e?.message ?? e)); return null }
}

/** Open (or start) the book of the identity `names` belongs to, sealed under `base`. */
export async function openLocalBook(
  names: Names, kv: KV, base: Uint8Array | null, log?: (m: string) => void,
): Promise<{ book: ContactBook; verdict: Verdict }> {
  const idKey = names.kid
  const lsKey = names.fixed.book
  if (!base) {
    log?.('contact book: no ECDH base, running unsealed')
    const readRaw = () => { try { const v = JSON.parse(kv.get(lsKey) || '[]'); return isList(v) ? v : [] } catch { return [] } }
    return { book: localContactBook(readRaw, (l) => kv.set(lsKey, JSON.stringify(l))), verdict: 'unsigned' }
  }

  const raw = kv.get(lsKey)
  let verdict: Verdict = 'ok'
  let list: Entry[] = []
  if (raw !== null) {
    const opened = await openLocal<Entry[]>(base, BOOK_SEAL_SALT, idKey, raw)
    if (opened && isList(opened)) list = opened
    else { verdict = 'tampered'; log?.('contact book: not a sealed book of this identity - treating as tampered') }
  }

  // Writes are chained: two edits in quick succession must land in the order
  // they were made, and each seal is a separate await.
  let chain: Promise<void> = Promise.resolve()
  const write = (l: Entry[]) => {
    const snapshot = JSON.parse(JSON.stringify(l)) as Entry[]
    chain = chain
      .then(async () => { kv.set(lsKey, await sealLocal(base, BOOK_SEAL_SALT, idKey, snapshot)) })
      .catch((e) => log?.('contact book: sealing failed - the change stays in memory - ' + (e?.message ?? e)))
    return chain
  }

  const save = (l: Entry[]) => {
    if (verdict === 'tampered') throw new Error('contact book failed its check - refusing to write over it')
    list = l
    // Sealed text only ever reaches storage (localContactBook's save is
    // synchronous; reads come from `list` meanwhile). A failure to seal is
    // logged and the write is retried by the next one.
    void write(l)
  }
  return { book: localContactBook(() => list, save), verdict }
}
