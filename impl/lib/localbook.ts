/**
 * localbook.ts - the sealed local contact book (SPEC.md §4.4), over any KV.
 *
 * It lived in the web app, bound to localStorage. The CLI keeps the same keys
 * in a file (cli/store.ts), and a contact book is the thing that must not have
 * two implementations: a profile carried between the browser and the terminal
 * has to open with the same contacts and the same verdict on it.
 *
 *   names.fixed.book          the book, sealed (lib/localstore.ts)
 *   names.fixed['book-signed'] '1' once a protected book has ever been written
 *   names.fixed.emp           the public half of the §10 cache secret's emp key
 *
 * (names from lib/storenames.ts; they were `ec-local-contacts-<kid>`,
 * `…-signed` and `ec-gcache-emp-<kid>` before 2026-10-14.)
 *
 * ## Sealed, not only signed (2026-10-14)
 *
 * The book used to be plain JSON under a MAC (lib/bookmac.ts): integrity was
 * the property the crypto rests on - swap a `pub` and the app handshakes with
 * the attacker - and confidentiality was judged to buy little. It buys the one
 * thing the rest of local storage already hides: WHO this identity knows. Every
 * other record about people (groups, invites, knocks, pins) was sealed; the
 * book was the social graph in the clear. AES-GCM under the §10 base gives
 * both properties at once, so the MAC is gone from the write path.
 *
 * The verdicts are unchanged, and one rule is stricter than the other sealed
 * stores': a blob that does not open is `tampered`, never "empty". An empty
 * book there would let anybody who can write the store erase someone's
 * contacts without a trace - and the next write would seal the empty list over
 * the evidence.
 *
 * ## Migration - at open, not at the next write
 *
 * A book in an older format (signed, or a bare array from before the MAC) is
 * checked exactly as before and, if it passes, sealed on the spot, before the
 * caller sees it: the point is that the plain list stops being on disk, and a
 * profile that is only ever read would otherwise keep it there for good. What
 * this cannot do is erase it from the storage engine's own history (SQLite
 * WAL, LevelDB compaction) - sealing protects what is written from now on.
 *
 * ## Why the marker exists (audit 2026-10-12)
 *
 * `unsigned` is accepted so that a book from before the MAC existed is not
 * refused. Without a memory of having protected it, that tolerance was the
 * hole: the attack §4.4 names - something that can write localStorage swaps a
 * `pub` - did not need to forge anything, it could put a bare array back and be
 * accepted as "pre-MAC". So once this identity has written a protected book, a
 * bare array is `tampered`, not `unsigned`. The marker is set only AFTER the
 * sealed text has landed, and the plain text is never written, so no crash can
 * leave "marker + bare array" behind an honest write.
 */

import { localContactBook, type ContactBook, type Identity } from './core.ts'
import { checkBook, type Verdict } from './bookmac.ts'
import { sealLocal, openLocal } from './localstore.ts'
import { generateX25519 } from './x25519.ts'
import type { KV } from './migrate.ts'
import type { Names } from './storenames.ts'

const b64 = (u: Uint8Array) => btoa(String.fromCharCode(...u))

/** The book's own salt (SPEC.md §10). v1 named the MAC key; v2 is the seal. */
export const BOOK_SEAL_SALT = 'encedo-chat-contact-book-v2'

type Entry = { name: string; pub: string }
const isList = (v: any): v is Entry[] => Array.isArray(v)

/** Plain JSON (an array, or the v1 `{v, mac, body}` packing) - anything else is a sealed blob. */
function isPlain(raw: string): boolean {
  try { const o = JSON.parse(raw); return Array.isArray(o) || (!!o && typeof o === 'object') } catch { return false }
}

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
  const signedKey = names.fixed['book-signed']
  if (!base) {
    log?.('contact book: no ECDH base, running unsealed')
    const readRaw = () => { try { const v = JSON.parse(kv.get(lsKey) || '[]'); return isList(v) ? v : [] } catch { return [] } }
    return { book: localContactBook(readRaw, (l) => kv.set(lsKey, JSON.stringify(l))), verdict: 'unsigned' }
  }

  const raw = kv.get(lsKey)
  let verdict: Verdict
  let list: Entry[] = []
  let migrate = false
  if (raw !== null && !isPlain(raw)) {
    const opened = await openLocal<Entry[]>(base, BOOK_SEAL_SALT, idKey, raw)
    if (opened && isList(opened)) { verdict = 'ok'; list = opened }
    else { verdict = 'tampered'; log?.('contact book: the sealed book does not open - treating as tampered') }
  } else {
    // The formats before the seal, judged exactly as they were judged then.
    const checked = await checkBook(base, idKey, raw)
    verdict = checked.verdict
    // A bare array where a protected book has been before is not "pre-MAC", it
    // is the protected book taken away - exactly what swapping a key and
    // dropping the MAC looks like.
    if (verdict === 'unsigned' && kv.get(signedKey) === '1') { verdict = 'tampered'; log?.('contact book: unsigned where a protected one was written before - treating as tampered') }
    if (verdict !== 'tampered') {
      try { const v = JSON.parse(checked.body); list = isList(v) ? v : [] } catch { list = [] }
      migrate = raw !== null
    }
  }

  // Writes are chained: two edits in quick succession must land in the order
  // they were made, and each seal is a separate await.
  let chain: Promise<void> = Promise.resolve()
  const write = (l: Entry[]) => {
    const snapshot = JSON.parse(JSON.stringify(l)) as Entry[]
    chain = chain
      .then(async () => { kv.set(lsKey, await sealLocal(base, BOOK_SEAL_SALT, idKey, snapshot)); kv.set(signedKey, '1') })
      .catch((e) => log?.('contact book: sealing failed - the change stays in memory - ' + (e?.message ?? e)))
    return chain
  }
  if (migrate) { await write(list); log?.('contact book: sealed the book written in an older format') }
  else if (verdict === 'ok' && kv.get(signedKey) !== '1') kv.set(signedKey, '1')

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
