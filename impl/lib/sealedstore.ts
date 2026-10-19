/**
 * sealedstore.ts - a per-identity record sealed under the §10 cache key, over
 * any KV (localStorage in the app, cli/store.ts in the terminal).
 *
 * Published invites (whose secrets name topics you listen on), the knocks you
 * are still making, the keys you chose to ignore, the terminal's outbox, the
 * preferences, who was last heard and which groups were left live here, each
 * under its name from lib/storenames.ts. One implementation for both
 * clients, so a profile carried between them keeps listening on the same
 * invites.
 *
 * A sealed blob is base64 of iv||ct and never parses as JSON, so the formats
 * tell themselves apart.
 *
 * ## Plain JSON is accepted once, then never (2026-10-14)
 *
 * A store written before §10 reached these keys is plain JSON, and reading it
 * used to be allowed for ever - which made the seal optional for anybody who
 * can write the store: put a plain list where the blob was and it was taken as
 * "an older build's", the same downgrade the contact book's marker closed on
 * 2026-10-12 (un-ignore a key, bring a withdrawn invite back, switch media
 * auto-fetch on). Now `sealPlainStores` runs at sign-in, after the first reads:
 * it seals whatever of this identity's stores is still plain and sets
 * the identity's `sealed` record. From then on plain JSON in a sealed store is ignored.
 */

import { sealLocal, openLocal } from './localstore.ts'
import type { KV } from './migrate.ts'
import type { Names } from './storenames.ts'

/** Every store kept through this module and its salt. One list, so a salt is written once. */
export const SALTS = {
  invites: 'encedo-chat-invites-v1',
  waiting: 'encedo-chat-waiting-v1',
  ignored: 'encedo-chat-ignored-v1',
  outbox: 'encedo-chat-outbox-v1',
  prefs: 'encedo-chat-prefs-v1',
  seen: 'encedo-chat-seen-v1',
  gleft: 'encedo-chat-group-left-v1',
  netkey: 'encedo-chat-netkey-v1',
} as const
export type Store = keyof typeof SALTS
export const STORES = Object.keys(SALTS) as Store[]

/** Set once every store of this identity has been sealed; plain JSON is refused after it. */
export const isSealedOnly = (kv: KV, names: Names) => kv.get(names.fixed.sealed) === '1'

/**
 * Seal whatever of this identity's stores is still plain JSON, then set the
 * marker. Run at sign-in, after the reads that may still take a plain store.
 * Without a base nothing can be sealed and the marker is not set.
 */
export async function sealPlainStores(kv: KV, base: Uint8Array | null, names: Names, log?: (m: string) => void): Promise<number> {
  if (!base) return 0
  let n = 0
  for (const store of STORES) {
    const key = names.fixed[store]
    const raw = kv.get(key)
    if (!raw) continue
    let v: unknown
    try { v = JSON.parse(raw) } catch { continue } // a blob: already sealed
    kv.set(key, await sealLocal(base, SALTS[store], names.kid, v)); n++
  }
  kv.set(names.fixed.sealed, '1')
  if (n) log?.(`sealed ${n} store(s) written in the clear by an older build`)
  return n
}

/** One store of the identity `names` belongs to: sealed under `base`, scoped to its KID. */
export async function readSealedKV<T>(
  kv: KV, base: Uint8Array | null, names: Names, store: Store, isMine: (v: any) => boolean,
  log?: (m: string) => void,
): Promise<T | null> {
  const key = names.fixed[store]
  const raw = kv.get(key)
  if (!raw) return null
  let plain: unknown, isJson = false
  try { plain = JSON.parse(raw); isJson = true } catch {}
  if (isJson) {
    if (isSealedOnly(kv, names)) { log?.(`${store}: plain JSON where a sealed store has been - ignored`); return null }
    return isMine(plain) ? plain as T : null
  }
  if (!base) { log?.(`${store}: no cache base - cannot open the sealed store`); return null }
  return openLocal<T>(base, SALTS[store], names.kid, raw)
}

/** No base, no write: falling back to plaintext would undo the point of sealing. */
export async function writeSealedKV(
  kv: KV, base: Uint8Array | null, names: Names, store: Store, value: unknown,
  log?: (m: string) => void,
): Promise<void> {
  if (!base) { log?.(`${store}: no cache base - NOT persisted`); return }
  try { kv.set(names.fixed[store], await sealLocal(base, SALTS[store], names.kid, value)) }
  catch (e: any) { log?.(`${store}: seal failed - ${e?.message ?? e}`) }
}
