/**
 * invites.ts - published invites and knocks for the CLI (CLI-PLAN.md stage 2b).
 *
 * The app's mechanism and the app's storage (PROTOCOL.md §5.7-5.8): an invite
 * carries an inbox secret that names a topic you listen on; whoever opens it
 * KNOCKS there with their key, and accepting the knock makes them a contact.
 * The records are the app's, under the same keys and salts, sealed by
 * lib/sealedstore.ts - so a profile moved between the app and the terminal
 * keeps its invites, its pending knocks and its ignore list.
 *
 *   ec-invites-<kid>   [{ id, label, secret, created, expires? }]     invites you hung up
 *   ec-waiting-<kid>   [[pub, { inbox, name, since, note? }], ...]     knocks you are making
 *   ec-ignored-<kid>   [{ fp, at }]                                     keys whose knocks you dismissed
 */

import { readSealedKV, writeSealedKV } from '../lib/sealedstore.ts'
import { newInboxSecret, inviteLink } from '../lib/invite.ts'
import type { KV } from '../lib/migrate.ts'

export const INVITES_SALT = 'encedo-chat-invites-v1'
export const WAITING_SALT = 'encedo-chat-waiting-v1'
export const IGNORED_SALT = 'encedo-chat-ignored-v1'
const IGNORED_MAX = 512

export interface PubInvite { id: string; label: string; secret: string; created: number; expires?: number }
export interface Waiting { inbox: string; name: string; since: number; note?: string }

export const expired = (inv: PubInvite, now = Date.now()) => !!inv.expires && now >= inv.expires

/** "30m", "24h", "7d" -> ms; anything else is refused. */
export function parseDuration(s: string): number {
  const m = s.trim().match(/^(\d+)\s*([mhd])$/)
  if (!m || Number(m[1]) <= 0) throw new Error(`czas jak 30m, 24h albo 7d - nie „${s}”`)
  return Number(m[1]) * { m: 60_000, h: 3_600_000, d: 86_400_000 }[m[2] as 'm' | 'h' | 'd']
}

/** The link an invite is published as - the app's inviteUrlFor. */
export const publishedLink = (origin: string, path: string, me: { pub: string; handle: string }, inv: PubInvite) =>
  inviteLink(origin, path, { pub: me.pub, name: me.handle, inbox: inv.secret })

export class InviteStore {
  private kv: KV; private base: Uint8Array | null; private kid: string
  constructor(kv: KV, base: Uint8Array | null, kid: string) { this.kv = kv; this.base = base; this.kid = kid }

  private read<T>(key: string, salt: string) { return readSealedKV<T>(this.kv, this.base, this.kid, key + this.kid, salt, Array.isArray) }
  private write(key: string, salt: string, v: unknown) { return writeSealedKV(this.kv, this.base, this.kid, key + this.kid, salt, v) }

  async invites(): Promise<PubInvite[]> { return (await this.read<PubInvite[]>('ec-invites-', INVITES_SALT)) ?? [] }
  saveInvites(list: PubInvite[]) { return this.write('ec-invites-', INVITES_SALT, list) }

  /** A new invite, newest first - the app's btn-new-invite. */
  async create(label: string, ttlMs?: number, now = Date.now()): Promise<PubInvite> {
    if (!this.base) throw new Error('nie da się zapieczętować zaproszenia (brak klucza §10)')
    const inv: PubInvite = { id: Math.random().toString(36).slice(2, 10), label: label.trim() || 'zaproszenie', secret: newInboxSecret(), created: now }
    if (ttlMs) inv.expires = now + ttlMs
    const list = await this.invites()
    list.unshift(inv)
    await this.saveInvites(list)
    return inv
  }

  /** Withdrawing an invite is forgetting its secret: nobody is told, nothing can refuse it. */
  async revoke(id: string): Promise<boolean> {
    const list = await this.invites()
    const keep = list.filter((i) => i.id !== id)
    if (keep.length === list.length) return false
    await this.saveInvites(keep)
    return true
  }

  async waiting(): Promise<Map<string, Waiting>> {
    const v = await this.read<Array<[string, Waiting]>>('ec-waiting-', WAITING_SALT)
    return new Map(Array.isArray(v) ? v : [])
  }
  saveWaiting(m: Map<string, Waiting>) { return this.write('ec-waiting-', WAITING_SALT, [...m]) }

  async ignored(): Promise<Array<{ fp: string; at: number }>> { return (await this.read<Array<{ fp: string; at: number }>>('ec-ignored-', IGNORED_SALT)) ?? [] }
  async ignore(fp: string, now = Date.now()) {
    const list = await this.ignored()
    if (list.some((r) => r.fp === fp)) return
    list.unshift({ fp, at: now })
    if (list.length > IGNORED_MAX) list.length = IGNORED_MAX
    await this.write('ec-ignored-', IGNORED_SALT, list)
  }
}
