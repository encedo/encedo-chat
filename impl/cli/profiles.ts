/**
 * profiles.ts - software identities for the CLI, in the browser's format.
 *
 * Every piece is the app's own: the identity is lib/core.ts
 * `browserSoftwareIdentity` sealed with lib/profile.ts, stored under
 * `ec-soft-id-<name>`; the strength floor is lib/passmeter.ts; moving a profile
 * is lib/migrate.ts. So a profile created here opens in the browser and the
 * other way round, and the CLI keeps no private key in plaintext (the old
 * test keystore, cli/keystore.ts, stays for the live test scripts only).
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { browserSoftwareIdentity, type Identity } from '../lib/core.ts'
import { seal, unseal, isSealedProfile } from '../lib/profile.ts'
import { assessPassword, ENFORCE_MIN } from '../lib/passmeter.ts'
import { exportProfile, openBundle, applyBundle, conflictsWith, type KV } from '../lib/migrate.ts'
import { kidOf } from '../lib/descr.ts'

export const softKey = (name: string) => 'ec-soft-id-' + name
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0))

/** The KID local state is keyed by - the app's `identityKey`. */
export const identityKey = async (pub: string, kid?: string) => (await kidOf({ kid, pub: unb64(pub) }))!

export const listProfiles = (kv: KV): string[] =>
  kv.keys().filter((k) => k.startsWith('ec-soft-id-')).map((k) => k.slice('ec-soft-id-'.length)).sort()

/** Same floor as the browser (§4.5): the full meter, or no profile. */
export function weakPassword(pw: string): string {
  return assessPassword(pw).score >= ENFORCE_MIN ? ''
    : 'za słabe hasło - miernik musi być pełny (~60 bitów); najprościej dopisać drugie słowo albo wydłużyć do 12+ znaków'
}

export async function createProfile(kv: KV, name: string, password: string): Promise<Identity> {
  if (!name.trim()) throw new Error('profil potrzebuje nazwy')
  if (kv.get(softKey(name)) !== null) throw new Error(`profil "${name}" już tu jest`)
  const weak = weakPassword(password); if (weak) throw new Error(weak)
  let generated = ''
  const id = await browserSoftwareIdentity(name, () => null, (v) => { generated = v })
  kv.set(softKey(name), JSON.stringify(await seal(password, generated)))
  return id
}

export async function openProfile(kv: KV, name: string, password: string): Promise<Identity> {
  const raw = kv.get(softKey(name))
  if (raw === null) throw new Error(`nie ma profilu "${name}" (onchato profile list)`)
  const blob = JSON.parse(raw)
  if (!isSealedProfile(blob)) throw new Error(`profil "${name}" jest w starym, niezaszyfrowanym formacie`)
  const plain = await unseal(password, blob) // BadPassword on a wrong password
  return browserSoftwareIdentity(name, () => plain, () => {})
}

/** Write the app's own move file (.ocmig). Needs the password: the KID is inside the seal. */
export async function exportProfileFile(kv: KV, name: string, password: string, path: string): Promise<void> {
  const id = await openProfile(kv, name, password)
  const file = await exportProfile(kv, name, await identityKey(id.pub), password, Date.now())
  writeFileSync(path, JSON.stringify(file), { mode: 0o600 })
}

/** Bring in a move file from the app. A name already here is refused, never merged. */
export async function importProfileFile(kv: KV, path: string, password: string): Promise<{ name: string; keys: number }> {
  const bundle = await openBundle(JSON.parse(readFileSync(path, 'utf8')), password)
  const clash = conflictsWith(kv, bundle)
  if (clash) throw new Error(`profil "${clash}" już tu jest - usuń go albo zmień nazwę przed importem`)
  return { name: bundle.name, keys: applyBundle(kv, bundle) }
}
