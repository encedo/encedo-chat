/**
 * localbook.ts - the signed local contact book (PROTOCOL.md §4.4), over any KV.
 *
 * It lived in the web app, bound to localStorage. The CLI keeps the same keys
 * in a file (cli/store.ts), and a contact book is the thing that must not have
 * two implementations: a profile carried between the browser and the terminal
 * has to open with the same contacts and the same verdict on its signature.
 *
 *   ec-local-contacts-<idKey>   the book, packed with its MAC (lib/bookmac.ts)
 *   ec-gcache-emp-<idKey>       the public half of the §10 cache secret's emp key
 *
 * The verdicts, unchanged from the app: 'ok' and 'unsigned' work (an
 * unsigned book is upgraded on the next write); 'tampered' is evidence and is
 * never written over - the caller shows an empty book that refuses edits.
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
  if (!base) {
    log?.('contact book: no ECDH base, running unsigned')
    const readRaw = () => { try { return JSON.parse(kv.get(lsKey) || '[]') } catch { return [] } }
    return { book: localContactBook(readRaw, (l) => kv.set(lsKey, JSON.stringify(l))), verdict: 'unsigned' }
  }
  const { verdict, body } = await checkBook(base, idKey, kv.get(lsKey))
  let list: Array<{ name: string; pub: string }> = []
  if (verdict !== 'tampered') { try { list = JSON.parse(body) } catch { list = [] } }
  const save = (l: Array<{ name: string; pub: string }>) => {
    if (verdict === 'tampered') throw new Error('contact book failed its signature - refusing to write over it')
    list = l
    const text = JSON.stringify(l)
    // The text goes down first and the signature follows: a failure to SIGN
    // must not lose the write (localContactBook's save is synchronous).
    kv.set(lsKey, text)
    void signBook(base, idKey, text)
      .then((mac) => kv.set(lsKey, pack(text, mac)))
      .catch((e) => log?.('contact book: signing failed - ' + (e?.message ?? e)))
  }
  return { book: localContactBook(() => list, save), verdict }
}
