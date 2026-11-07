/**
 * storenames.ts - storage names that say nothing (SPEC.md 10).
 *
 * Every per-identity record used to sit under a name that carried the
 * identity's KID - `ec-local-contacts-<kid>`, `ec-gcache-<kid>-<group_id>` -
 * and the KID is SHA-1 of the public key. So the names alone tied a copied
 * device or profile directory to an identity anybody can recognise from its
 * key, and counted and named its groups. The records were sealed; the index
 * was not.
 *
 * ## Key schedule
 *
 *   nk     = HKDF(ECDH(IK, IK_pub), salt = "local storage names",
 *                 info = "onchato-store-names-v1")           // deriveWith, self
 *   idTag  = HMAC-SHA-256(nk, "id")[0:8]                       // hex, 16 chars
 *   name   = "ec-" + idTag + "-" + HMAC-SHA-256(nk, label || 0x00 || scope)[0:16]   // hex, 32 chars
 *
 * `nk` comes through the derivation seam (lib/derive.ts) with the identity's
 * own public key, like the self-topic: only the holder of IK can compute it,
 * a HEM computes it in-device once the firmware derives there, and it does
 * not depend on anything stored - which it must not, because the first name
 * it is needed for is the one `emp_pub` (and with it the §10 base) is under.
 *
 * What a reader of the store still sees: that a set of keys shares an idTag,
 * how many there are and how big. Not which identity, not which store, not
 * which group or room.
 *
 * ## The group index
 *
 * Groups were found by listing `ec-gcache-<kid>-*`. A name that hides the
 * group id cannot be listed by it, so the ids sit in one sealed record (sealed
 * under a key from `nk`, not from `base`, so that the migration below can
 * write it before `base` exists).
 */

import { deriveWith, deriveOverEcdh, type Deriving } from './derive.ts'
import { subtle, hkdfBits } from './wc.ts'
import { sealLocal, openLocal } from './localstore.ts'
import type { KV } from './migrate.ts'

const enc = new TextEncoder()
export const NAMES_LABEL = 'onchato-store-names-v1'
/** The label before 0.8.0. Firmware 1.3 refuses an HKDF info starting with
 *  `encedo-`, so the names moved; this one only finds the records to move. */
export const NAMES_LABEL_PRE_080 = 'encedo-chat-store-names-v1'
const NAMES_CTX = enc.encode('local storage names')
const INDEX_SALT = 'encedo-chat-store-index-v1'

/** The records every identity has one of. */
export const FIXED = ['emp', 'book', 'invites', 'waiting', 'ignored', 'outbox', 'prefs', 'seen', 'gleft', 'groups', 'netkey', 'moved'] as const
/** Markers of the storage migrations removed in 0.8.2 ('book-signed', 'sealed'): only ever deleted. */
const OBSOLETE = ['book-signed', 'sealed'] as const
export type Fixed = typeof FIXED[number]

export interface Names {
  /** The identity's KID - the crypto scope of its records, never part of a name. */
  kid: string
  /** `ec-<idTag>-`: every record of this identity starts with it. */
  prefix: string
  fixed: Record<Fixed, string>
  /** Names of records no build reads any more, deleted at sign-in. */
  obsolete: string[]
  /** One room's pins, one group's state. */
  scoped(kind: 'pin' | 'group', scope: string): Promise<string>
  /** The group ids this identity holds state for (lib/storenames.ts, group index). */
  groups(kv: KV): Promise<string[]>
  setGroups(kv: KV, gids: string[]): Promise<void>
}

const hex = (u: Uint8Array) => [...u].map((b) => b.toString(16).padStart(2, '0')).join('')

/** From the name key itself - what `namesFor` does after deriving it, and what a test does with a random one. */
export async function namesFromKey(nk: Uint8Array, kid: string): Promise<Names> {
  const key = await subtle.importKey('raw', nk, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const mac = async (s: string) => new Uint8Array(await subtle.sign('HMAC', key, enc.encode(s)))
  const prefix = 'ec-' + hex((await mac('id')).slice(0, 8)) + '-'
  const name = async (label: string, scope = '') => prefix + hex((await mac(label + '\0' + scope)).slice(0, 16))
  const fixed = Object.fromEntries(await Promise.all(FIXED.map(async (f) => [f, await name(f)]))) as Record<Fixed, string>
  const obsolete = await Promise.all(OBSOLETE.map((f) => name(f)))
  const indexKey = await hkdfBits(nk, enc.encode(INDEX_SALT), enc.encode(kid), 32)
  return {
    kid, prefix, fixed, obsolete,
    scoped: (kind, scope) => name(kind, scope),
    async groups(kv) {
      const raw = kv.get(fixed.groups)
      const v = raw ? await openLocal<string[]>(indexKey, INDEX_SALT, kid, raw) : null
      return Array.isArray(v) ? v.filter((g) => typeof g === 'string') : []
    },
    async setGroups(kv, gids) {
      const list = [...new Set(gids)].sort()
      if (!list.length) { kv.remove?.(fixed.groups); return }
      kv.set(fixed.groups, await sealLocal(indexKey, INDEX_SALT, kid, list))
    },
  }
}

/** The names of this identity's records. One derivation through the identity backend. */
export async function namesFor(id: Deriving & { pub: string }, kid: string): Promise<Names> {
  const nk = await deriveWith(id, NAMES_LABEL, id.pub, NAMES_CTX, 32)
  try { return await namesFromKey(nk, kid) } finally { nk.fill(0) }
}

/**
 * Move this identity's records from the names of the pre-0.8.0 name key to
 * the current one (0.8.0: the label of `nk` changed, see NAMES_LABEL_PRE_080).
 *
 * The old `nk` is computed the way every build before 0.8.0 computed it: HKDF
 * in the client over the raw `ECDH(IK, IK_pub)`. A software identity always
 * can; a HEM can when it is personalised with the `raw_ecdh_enabled` policy,
 * and when it is not, there is nothing to move (no build could have written
 * those records against that device) and the attempt is recorded as done.
 *
 * Values move unchanged - the seals are keyed by `base` and the KID, neither
 * of which moved - except the group index, which is sealed under a key from
 * `nk` and is re-sealed. Pins are named by a room id this function does not
 * know, so they are moved when their room is first opened (`pinName`); while
 * any old record is left, the old names are returned for that, and the `moved`
 * marker is written only once none is.
 *
 * Returns how many records moved and the old names when some are left.
 */
export async function migrateNamesKey(kv: KV, id: Deriving & { pub: string }, names: Names): Promise<{ moved: number; legacy: Names | null }> {
  for (const n of names.obsolete) kv.remove?.(n)
  if (kv.get(names.fixed.moved) !== null) return { moved: 0, legacy: null }
  let old: Names
  try {
    const nk = await deriveOverEcdh(id.ecdh)(NAMES_LABEL_PRE_080, id.pub, NAMES_CTX, 32)
    try { old = await namesFromKey(nk, names.kid) } finally { nk.fill(0) }
  } catch {
    kv.set(names.fixed.moved, '1') // no raw ECDH: no record of this identity can be under the old names
    return { moved: 0, legacy: null }
  }
  let moved = 0
  const move = (from: string, to: string) => {
    const v = kv.get(from)
    if (v === null) return
    if (kv.get(to) === null) { kv.set(to, v); moved++ }
    kv.remove?.(from)
  }
  for (const f of FIXED) if (f !== 'groups' && f !== 'moved') move(old.fixed[f], names.fixed[f])
  const gids = await old.groups(kv)
  for (const gid of gids) move(await old.scoped('group', gid), await names.scoped('group', gid))
  if (gids.length) await names.setGroups(kv, [...await names.groups(kv), ...gids])
  kv.remove?.(old.fixed.groups)
  for (const n of old.obsolete) kv.remove?.(n)
  const left = kv.keys().some((k) => k.startsWith(old.prefix))
  if (!left) kv.set(names.fixed.moved, '1')
  return { moved, legacy: left ? old : null }
}

/**
 * The name of a room's pins, after moving them there from the pre-0.8.0 name
 * when the old names are still around (`migrateNamesKey`). The one place that
 * knows a room id is the one that opens the room.
 */
export async function pinName(kv: KV, names: Names, roomId: string, legacy: Names | null): Promise<string> {
  const name = await names.scoped('pin', roomId)
  if (legacy && kv.get(name) === null) {
    const from = await legacy.scoped('pin', roomId)
    const v = kv.get(from)
    if (v !== null) { kv.set(name, v); kv.remove?.(from) }
  }
  return name
}
