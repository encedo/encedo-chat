/**
 * localbook.ts - the signed local contact book (PROTOCOL.md §4.4), over any KV.
 *
 * It lived in the web app, bound to localStorage. The CLI keeps the same keys
 * in a file (cli/store.ts), and a contact book is the thing that must not have
 * two implementations: a profile carried between the browser and the terminal
 * has to open with the same contacts and the same verdict on its signature.
 *
 *   ec-local-contacts-<idKey>          the book, packed with its MAC (lib/bookmac.ts)
 *   ec-local-contacts-<idKey>-signed   '1' once a signed book has ever been written
 *   ec-gcache-emp-<idKey>              the public half of the §10 cache secret's emp key
 *
 * The verdicts, unchanged from the app: 'ok' and 'unsigned' work (an
 * unsigned book is upgraded on the next write); 'tampered' is evidence and is
 * never written over - the caller shows an empty book that refuses edits.
 *
 * ## Why the marker exists (audit 2026-10-12)
 *
 * `unsigned` is accepted so that a book from before the MAC existed is not
 * refused. Without a memory of having signed, that tolerance was the hole: the
 * attack §4.4 names - something that can write localStorage swaps a `pub` -
 * did not need to forge a MAC at all, it could put a bare array back and be
 * accepted as "pre-MAC", then re-signed. So once this identity has written a
 * signed book, a bare array is `tampered`, not `unsigned`. The marker is set
 * only AFTER the packed, signed text has landed, and the unsigned text is
 * never written first any more, so no crash can leave "marker + bare array"
 * behind an honest write.
 */

import { localContactBook, type ContactBook, type Identity } from './core.ts'
import { checkBook, signBook, pack, type Verdict } from './bookmac.ts'
import { generateX25519 } from './x25519.ts'
import type { KV } from './migrate.ts'

const b64 = (u: Uint8Array) => btoa(String.fromCharCode(...u))

/**
 * The §10 cache master secret ECDH(IK, emp_pub). `emp_pub` is random and kept in
 * the store; IK never leaves its backend. Null when the identity will not do
 * ECDH (a refusing HSM): the book then runs unsigned rather than not at all.
 */
export async function cacheBaseOf(id: Identity, idKey: string, kv: KV, log?: (m: string) => void): Promise<Uint8Array | null> {
  const key = 'ec-gcache-emp-' + idKey
  let empPub = kv.get(key)
  if (!empPub) { empPub = b64((await generateX25519()).pub); kv.set(key, empPub) }
  try { return await id.ecdh(empPub) } catch (e: any) { log?.('cache base: ecdh failed - ' + (e?.message ?? e)); return null }
}

/** Open (or start) the book for `idKey`, checking its signature with `base`. */
export async function openLocalBook(
  idKey: string, kv: KV, base: Uint8Array | null, log?: (m: string) => void,
): Promise<{ book: ContactBook; verdict: Verdict }> {
  const lsKey = 'ec-local-contacts-' + idKey
  const signedKey = lsKey + '-signed'
  if (!base) {
    log?.('contact book: no ECDH base, running unsigned')
    const readRaw = () => { try { return JSON.parse(kv.get(lsKey) || '[]') } catch { return [] } }
    return { book: localContactBook(readRaw, (l) => kv.set(lsKey, JSON.stringify(l))), verdict: 'unsigned' }
  }
  const checked = await checkBook(base, idKey, kv.get(lsKey))
  const body = checked.body
  let verdict: Verdict = checked.verdict
  // A bare array where a signed book has been before is not "pre-MAC", it is
  // the signed book taken away - exactly what swapping a key and dropping the
  // MAC looks like. A signed book that predates the marker sets it now.
  if (verdict === 'unsigned' && kv.get(signedKey) === '1') { verdict = 'tampered'; log?.('contact book: unsigned where a signed one was written before - treating as tampered') }
  if (verdict === 'ok' && kv.get(signedKey) !== '1') kv.set(signedKey, '1')
  let list: Array<{ name: string; pub: string }> = []
  if (verdict !== 'tampered') { try { list = JSON.parse(body) } catch { list = [] } }
  const save = (l: Array<{ name: string; pub: string }>) => {
    if (verdict === 'tampered') throw new Error('contact book failed its signature - refusing to write over it')
    list = l
    const text = JSON.stringify(l)
    // Signed text only ever reaches storage (localContactBook's save is
    // synchronous; reads come from `list` meanwhile). Writing the plain text
    // first and signing after would let a crash in between leave a bare array
    // beside the marker - an honest write read as tampering. A failure to sign
    // is logged and the write is retried by the next one.
    void signBook(base, idKey, text)
      .then((mac) => { kv.set(lsKey, pack(text, mac)); kv.set(signedKey, '1') })
      .catch((e) => log?.('contact book: signing failed - the change stays in memory - ' + (e?.message ?? e)))
  }
  return { book: localContactBook(() => list, save), verdict }
}
