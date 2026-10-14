/**
 * prefs.ts - the per-identity preferences, sealed (SPEC.md 10).
 *
 * Two settings used to sit beside the sealed stores as plain keys named by
 * the identity: `ec-notify-<KID>` (the notification mode) and
 * `ec-autoimg-<KID>` (whether pictures from a 1:1 peer are fetched by
 * themselves). Neither is a secret, but the rule of 10 is that what can be
 * sealed is sealed, and a key name that says "this KID gets notifications"
 * is one more plain fact about an identity on a disk. They live in one blob
 * now, under their own salt, read once at sign-in; the plain keys are read
 * one last time and removed.
 */

import { readSealedKV, writeSealedKV, isSealedOnly, SALTS } from './sealedstore.ts'
import type { Names } from './storenames.ts'
import type { KV } from './migrate.ts'

export const PREFS_SALT = SALTS.prefs
/** The plain keys of earlier builds, by field. */
export const LEGACY = { notify: 'ec-notify-', mediaAuto: 'ec-autoimg-' } as const

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

/**
 * Read the identity's preferences, folding in (and removing) the plain keys
 * of an earlier build. Without a base nothing can be sealed: the legacy
 * values are still honoured for the session, and left where they are.
 */
export async function loadPrefs(kv: KV, base: Uint8Array | null, names: Names, log?: (m: string) => void): Promise<Prefs> {
  const idKey = names.kid
  const sealed = (await readSealedKV<Prefs>(kv, base, names, 'prefs', isPrefs, log)) ?? {}
  const out: Prefs = { ...sealed }
  let migrated = false
  if (isSealedOnly(kv, names)) {
    // After sign-in has sealed this identity's stores, a plain key here was not
    // written by an older build of ours - it is someone setting a preference.
    kv.remove?.(LEGACY.notify + idKey); kv.remove?.(LEGACY.mediaAuto + idKey)
    return out
  }
  const n = kv.get(LEGACY.notify + idKey)
  if (n !== null) { if (out.notify === undefined) out.notify = n; migrated = true }
  const a = kv.get(LEGACY.mediaAuto + idKey)
  if (a !== null) { if (out.mediaAuto === undefined) out.mediaAuto = a === '1'; migrated = true }
  if (migrated && base) {
    await writeSealedKV(kv, base, names, 'prefs', out, log)
    kv.remove?.(LEGACY.notify + idKey)
    kv.remove?.(LEGACY.mediaAuto + idKey)
    log?.('prefs: plain keys from an older build sealed and removed')
  }
  return out
}

export async function savePrefs(kv: KV, base: Uint8Array | null, names: Names, prefs: Prefs, log?: (m: string) => void): Promise<void> {
  await writeSealedKV(kv, base, names, 'prefs', prefs, log)
}
