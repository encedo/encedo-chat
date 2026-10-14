/**
 * sealedstore.ts - a per-identity record sealed under the §10 cache key, over
 * any KV (localStorage in the app, cli/store.ts in the terminal).
 *
 * Published invites (`ec-invites-<kid>`, whose secrets name topics you listen
 * on), the knocks you are still making (`ec-waiting-<kid>`) and the keys you
 * chose to ignore (`ec-ignored-<kid>`) live here. One implementation for both
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
 * `ec-sealed-<kid>`. From then on plain JSON in a sealed store is ignored.
 */

import { sealLocal, openLocal } from './localstore.ts'
import type { KV } from './migrate.ts'

/** Every store kept through this module, by key prefix (the key is prefix + KID), and its salt. One list, so a salt is written once. */
export const SALTS = {
  invites: 'encedo-chat-invites-v1',
  waiting: 'encedo-chat-waiting-v1',
  ignored: 'encedo-chat-ignored-v1',
  outbox: 'encedo-chat-outbox-v1',
  prefs: 'encedo-chat-prefs-v1',
  seen: 'encedo-chat-seen-v1',
  left: 'encedo-chat-group-left-v1',
} as const
export const STORES: ReadonlyArray<readonly [prefix: string, salt: string]> = [
  ['ec-invites-', SALTS.invites], ['ec-waiting-', SALTS.waiting], ['ec-ignored-', SALTS.ignored],
  ['ec-outbox-', SALTS.outbox], ['ec-prefs-', SALTS.prefs], ['ec-seen-', SALTS.seen], ['ec-gleft-', SALTS.left],
]

/** Set once every store of this identity has been sealed; plain JSON is refused after it. */
export const sealedMarker = (kid: string) => 'ec-sealed-' + kid
export const isSealedOnly = (kv: KV, kid: string) => kv.get(sealedMarker(kid)) === '1'

/**
 * Seal whatever of this identity's stores is still plain JSON, then set the
 * marker. Run at sign-in, after the reads that may still take a plain store.
 * Without a base nothing can be sealed and the marker is not set.
 */
export async function sealPlainStores(kv: KV, base: Uint8Array | null, kid: string, log?: (m: string) => void): Promise<number> {
  if (!base) return 0
  let n = 0
  for (const [prefix, salt] of STORES) {
    const key = prefix + kid
    const raw = kv.get(key)
    if (!raw) continue
    let v: unknown
    try { v = JSON.parse(raw) } catch { continue } // a blob: already sealed
    kv.set(key, await sealLocal(base, salt, kid, v)); n++
  }
  kv.set(sealedMarker(kid), '1')
  if (n) log?.(`sealed ${n} store(s) written in the clear by an older build`)
  return n
}

export async function readSealedKV<T>(
  kv: KV, base: Uint8Array | null, scope: string, key: string, salt: string, isMine: (v: any) => boolean,
  log?: (m: string) => void,
): Promise<T | null> {
  const raw = kv.get(key)
  if (!raw) return null
  let plain: unknown, isJson = false
  try { plain = JSON.parse(raw); isJson = true } catch {}
  if (isJson) {
    if (isSealedOnly(kv, scope)) { log?.(`${key}: plain JSON where a sealed store has been - ignored`); return null }
    return isMine(plain) ? plain as T : null
  }
  if (!base) { log?.(`${key}: no cache base - cannot open the sealed store`); return null }
  return openLocal<T>(base, salt, scope, raw)
}

/** No base, no write: falling back to plaintext would undo the point of sealing. */
export async function writeSealedKV(
  kv: KV, base: Uint8Array | null, scope: string, key: string, salt: string, value: unknown,
  log?: (m: string) => void,
): Promise<void> {
  if (!base) { log?.(`${key}: no cache base - NOT persisted`); return }
  try { kv.set(key, await sealLocal(base, salt, scope, value)) }
  catch (e: any) { log?.(`${key}: seal failed - ${e?.message ?? e}`) }
}
