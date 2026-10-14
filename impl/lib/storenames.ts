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
 *                 info = "encedo-chat-store-names-v1")       // deriveWith, self
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

import { deriveWith, type Deriving } from './derive.ts'
import { subtle, hkdfBits } from './wc.ts'
import { sealLocal, openLocal } from './localstore.ts'
import type { KV } from './migrate.ts'

const enc = new TextEncoder()
export const NAMES_LABEL = 'encedo-chat-store-names-v1'
const NAMES_CTX = enc.encode('local storage names')
const INDEX_SALT = 'encedo-chat-store-index-v1'

/** The records every identity has one of. */
export const FIXED = ['emp', 'book', 'book-signed', 'sealed', 'invites', 'waiting', 'ignored', 'outbox', 'prefs', 'seen', 'gleft', 'groups'] as const
export type Fixed = typeof FIXED[number]

export interface Names {
  /** The identity's KID - the crypto scope of its records, never part of a name. */
  kid: string
  /** `ec-<idTag>-`: every record of this identity starts with it. */
  prefix: string
  fixed: Record<Fixed, string>
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
  const indexKey = await hkdfBits(nk, enc.encode(INDEX_SALT), enc.encode(kid), 32)
  return {
    kid, prefix, fixed,
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

/** Where each record used to be, keyed by the KID in the clear. */
const LEGACY: Array<[string, Fixed]> = [
  ['ec-gcache-emp-', 'emp'], ['ec-local-contacts-', 'book'], ['ec-sealed-', 'sealed'],
  ['ec-invites-', 'invites'], ['ec-waiting-', 'waiting'], ['ec-ignored-', 'ignored'], ['ec-outbox-', 'outbox'],
  ['ec-prefs-', 'prefs'], ['ec-seen-', 'seen'], ['ec-gleft-', 'gleft'],
]

/**
 * Move every record of this identity from its KID-carrying name to its own.
 * The values move unchanged: the seals are keyed by the KID as their scope,
 * and that did not change. A name already taken keeps what it holds (it was
 * written by this build) and the old copy is dropped. Returns how many moved.
 *
 * Left alone on purpose: the plain preference keys and the B1 group list of
 * older builds, which their own readers fold in and remove at this sign-in.
 */
export async function migrateToNames(kv: KV, names: Names): Promise<number> {
  const kid = names.kid
  let moved = 0
  const move = (from: string, to: string) => {
    const v = kv.get(from)
    if (v === null) return
    if (kv.get(to) === null) { kv.set(to, v); moved++ }
    kv.remove?.(from)
  }
  for (const [p, f] of LEGACY) move(p + kid, names.fixed[f])
  move('ec-local-contacts-' + kid + '-signed', names.fixed['book-signed'])
  const gids: string[] = []
  for (const k of kv.keys()) {
    if (k.startsWith('ec-gcache-' + kid + '-')) {
      const gid = k.slice(('ec-gcache-' + kid + '-').length)
      move(k, await names.scoped('group', gid)); gids.push(gid)
    } else if (k.startsWith('ec-pins-' + kid + '-')) {
      move(k, await names.scoped('pin', k.slice(('ec-pins-' + kid + '-').length)))
    }
  }
  if (gids.length) await names.setGroups(kv, [...await names.groups(kv), ...gids])
  return moved
}
