/**
 * migrate.ts — moving a software profile from one browser to another.
 *
 * ## Why this exists, and why it is not a backup
 *
 * A software profile is a **randomly generated** keypair sealed with a password
 * (`profile.ts`), not a key derived from one. So clearing a browser's data does
 * not lose "some settings" — it loses the identity itself, and typing the same
 * name and password afterwards mints a DIFFERENT key while every contact still
 * holds the old one. There is no way back from that inside the product: the
 * person has to be re-added by everyone who knows them.
 *
 * That makes an export the only honest answer to "I want to use onchato on my
 * other machine" — and it is a **move**, not a copy. onchato is not
 * multi-device: the same identity live in two places is two windows of one
 * identity, which §9.1 resolves by closing both sessions. The wording
 * everywhere says "przenosisz", never "skopiowano", and that is a product
 * decision rather than a phrasing one.
 *
 * ## What travels
 *
 * Everything this profile owns, decided by the same rule Wipeout uses — a key
 * prefixed `ec-` — rather than by a list somebody has to remember to update:
 *
 * - the sealed identity, `ec-soft-id-<name>`,
 * - everything keyed by this identity's KID: contacts, groups, the group cache,
 *   pins, notification mode, image auto-show,
 * - the browser-level settings (language, theme, node list, transport, sidebar).
 *
 * Two exclusions, and both are deliberate:
 *
 * - **`ec-idkey-swept`** is a boot marker this build writes for itself. Carried
 *   into a fresh browser it would assert something about a state that is not
 *   there. (It is also the marker that once made a harness check flaky, which is
 *   how it earned a name in this file.)
 * - **Another identity's data.** A browser can hold several profiles; an export
 *   takes the one being exported, not everything found.
 *
 * ## What the file is
 *
 * One sealed blob and nothing else — the format marker, the version, and the
 * ciphertext. **The profile's name is inside the seal**, not beside it: a file
 * that names its owner is a file that leaks who it belongs to when it travels,
 * and the only thing the name buys outside the seal is showing a conflict one
 * step earlier. The password is the profile's own, so the file is exactly as
 * strong as the profile it carries, and there is no second secret to lose.
 */

import { seal, unseal, isSealedProfile, type SealedProfile } from './profile.ts'

/** The storage this works over. An interface so the logic can be tested
 *  without a browser, and so the harness can seed one directly. */
export interface KV {
  keys(): string[]
  get(key: string): string | null
  set(key: string, value: string): void
}

export const localKV = (): KV => ({
  keys: () => Object.keys(localStorage),
  get: (k) => localStorage.getItem(k),
  set: (k, v) => localStorage.setItem(k, v),
})

/** Written by a running build about itself; means nothing in another browser. */
export const NOT_PORTABLE = ['ec-idkey-swept']

/** Settings that belong to the browser rather than to an identity. They travel
 *  because a move should feel like the same app, and they overwrite — which the
 *  import window says out loud rather than doing quietly. */
export const BROWSER_KEYS = [
  'ec-lang', 'ec-theme', 'ec-nodes', 'ec-transport', 'ec-sidebar-w', 'ec-close-tray',
]

export const FILE_MARK = 'onchato-migration'
export const FILE_EXT = 'ocmig'

/** What is inside the seal. */
export interface Bundle {
  v: 1
  /** The profile's name — the same string that opens it at the login screen. */
  name: string
  /** The identity key state is keyed by, carried so a reader can check that the
   *  keys inside really belong to the identity inside. */
  kid: string
  /** When the export was made (UTC ms), for the "this file is from …" line. */
  made: number
  keys: Record<string, string>
}

/** The file as it lands on disk. */
export interface MigrationFile {
  mark: typeof FILE_MARK
  v: 1
  sealed: SealedProfile
}

export const isMigrationFile = (v: any): v is MigrationFile =>
  !!v && v.mark === FILE_MARK && v.v === 1 && isSealedProfile(v.sealed)

/**
 * Which keys belong to this profile.
 *
 * `kid` matching is a substring test on purpose: state is keyed
 * `ec-<thing>-<kid>` and sometimes `ec-<thing>-<kid>-<room>`, and a rule that
 * had to know every shape would be a rule that misses the next one.
 */
export function collectProfile(store: KV, name: string, kid: string): Record<string, string> {
  const out: Record<string, string> = {}
  const identity = 'ec-soft-id-' + name
  for (const k of store.keys()) {
    if (!k.startsWith('ec-')) continue
    if (NOT_PORTABLE.includes(k)) continue
    const mine = k === identity || (!!kid && k.includes(kid)) || BROWSER_KEYS.includes(k)
    if (!mine) continue
    const v = store.get(k)
    if (v !== null) out[k] = v
  }
  return out
}

/** Build the file. Throws if there is no identity to move — an export with no
 *  key in it is a file that looks like a rescue and is not one. */
export async function exportProfile(
  store: KV, name: string, kid: string, password: string, made: number,
): Promise<MigrationFile> {
  const keys = collectProfile(store, name, kid)
  if (!keys['ec-soft-id-' + name]) throw new Error('no sealed identity for ' + name)
  const bundle: Bundle = { v: 1, name, kid, made, keys }
  return { mark: FILE_MARK, v: 1, sealed: await seal(password, JSON.stringify(bundle)) }
}

/** Open the file. `BadPassword` from `profile.ts` propagates unchanged — the
 *  import screen has to tell a wrong password from a broken file. */
export async function openBundle(file: unknown, password: string): Promise<Bundle> {
  if (!isMigrationFile(file)) throw new Error('not an onchato migration file')
  const bundle = JSON.parse(await unseal(password, file.sealed))
  if (!bundle || bundle.v !== 1 || typeof bundle.name !== 'string' || !bundle.keys) {
    throw new Error('the file opened but does not contain a profile')
  }
  return bundle as Bundle
}

/**
 * Is there room for this profile here?
 *
 * A name already in use is refused, never merged and never overwritten: the
 * thing that would be overwritten is somebody's identity, and one wrong click
 * would end every conversation they have. The caller offers a different name;
 * it does not offer a "replace".
 */
export function conflictsWith(store: KV, bundle: Bundle): string | null {
  const identity = 'ec-soft-id-' + bundle.name
  return store.get(identity) !== null ? bundle.name : null
}

/** Write the profile in. Refuses on a conflict rather than trusting the caller
 *  to have asked. */
export function applyBundle(store: KV, bundle: Bundle): number {
  const clash = conflictsWith(store, bundle)
  if (clash) throw new Error('a profile named ' + clash + ' is already here')
  let n = 0
  for (const [k, v] of Object.entries(bundle.keys)) {
    if (!k.startsWith('ec-') || NOT_PORTABLE.includes(k)) continue // a file is not to be trusted about this
    store.set(k, v); n++
  }
  return n
}
