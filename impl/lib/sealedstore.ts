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
 * Only a sealed blob is read. Plain JSON in its place - the format of the
 * builds before 0.7.34, which 0.7.34..0.8.x sealed at sign-in - is ignored:
 * accepting it would make the seal optional for anybody who can write the
 * store (put a plain list where the blob was: un-ignore a key, bring a
 * withdrawn invite back, switch media auto-fetch on).
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

/** One store of the identity `names` belongs to: sealed under `base`, scoped to its KID. */
export async function readSealedKV<T>(
  kv: KV, base: Uint8Array | null, names: Names, store: Store, isMine: (v: any) => boolean,
  log?: (m: string) => void,
): Promise<T | null> {
  const key = names.fixed[store]
  const raw = kv.get(key)
  if (!raw) return null
  if (!base) { log?.(`${store}: no cache base - cannot open the sealed store`); return null }
  const v = await openLocal<T>(base, SALTS[store], names.kid, raw)
  if (v === null) { log?.(`${store}: not a sealed record of this identity - ignored`); return null }
  return isMine(v) ? v : null
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
