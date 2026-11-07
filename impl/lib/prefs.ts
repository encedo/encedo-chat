/**
 * prefs.ts - the per-identity preferences, sealed (SPEC.md 10): the
 * notification mode and whether pictures from a 1:1 peer are fetched by
 * themselves, in one blob under their own salt, read once at sign-in.
 */

import { readSealedKV, writeSealedKV, SALTS } from './sealedstore.ts'
import type { Names } from './storenames.ts'
import type { KV } from './migrate.ts'

export const PREFS_SALT = SALTS.prefs

export interface Prefs {
  /** `lib/notify.ts` mode; absent = off. */
  notify?: string
  /** Fetch pictures and audio from a 1:1 peer without a click (7.5); absent = no. */
  mediaAuto?: boolean
}

export const isPrefs = (v: unknown): v is Prefs =>
  !!v && typeof v === 'object' && !Array.isArray(v)
  && ((v as any).notify === undefined || typeof (v as any).notify === 'string')
  && ((v as any).mediaAuto === undefined || typeof (v as any).mediaAuto === 'boolean')

/** Read the identity's preferences; none stored (or no base to open them) is all defaults. */
export async function loadPrefs(kv: KV, base: Uint8Array | null, names: Names, log?: (m: string) => void): Promise<Prefs> {
  return (await readSealedKV<Prefs>(kv, base, names, 'prefs', isPrefs, log)) ?? {}
}

export async function savePrefs(kv: KV, base: Uint8Array | null, names: Names, prefs: Prefs, log?: (m: string) => void): Promise<void> {
  await writeSealedKV(kv, base, names, 'prefs', prefs, log)
}
