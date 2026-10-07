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
 * A store written before §10 reached these keys is plain JSON; it is read once
 * and re-sealed by the caller's next write. A sealed blob is base64 of iv||ct
 * and never parses as JSON, so the formats tell themselves apart.
 */

import { sealLocal, openLocal } from './localstore.ts'
import type { KV } from './migrate.ts'

export async function readSealedKV<T>(
  kv: KV, base: Uint8Array | null, scope: string, key: string, salt: string, isMine: (v: any) => boolean,
  log?: (m: string) => void,
): Promise<T | null> {
  const raw = kv.get(key)
  if (!raw) return null
  try { const v = JSON.parse(raw); if (isMine(v)) return v as T } catch {}
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
