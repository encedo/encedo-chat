/**
 * knocks.ts - invites that answer themselves, for every front-end of the CLI
 * (SPEC.md §5.7-5.8; CLI-PLAN.md stage 2b). The interactive client and the
 * daemon share it, so a bot behind the daemon can be invited the way a person
 * in `onchato-cli chat` is.
 *
 * Two directions:
 *   - IN: listen on every live invite we published; a knock is held with its
 *     fingerprint until a person accepts or ignores it. Accepting is always a
 *     decision - an invite is public, anybody who saw it can knock.
 *   - OUT: `knockInvite` knocks on somebody else's invite and keeps a waiting
 *     record; we knock again every 90 s until they appear on the pair topic
 *     (`online`), which is how an acceptance shows. One knock is not enough:
 *     the first one is lost whenever nothing listens at that moment.
 *
 * The records are the app's (cli/invites.ts), so a profile moved between the
 * app and the terminal keeps them.
 */

import type { ClientSession, Contact } from '../lib/core.ts'
import { inboxSecretBytes, type Invite } from '../lib/invite.ts'
import { expired, type InviteStore, type PubInvite, type Waiting } from './invites.ts'
import { fingerprint } from './fp.ts'

/** Under a minute would be rude to the relay; over a few makes the other side wait (the app's value). */
export const KNOCK_EVERY_MS = 90_000
/** How often the list of live invites is re-read (a new one, an expiry, a revoke). */
export const INVITES_EVERY_MS = 30_000

export interface Knock { n: number; ik: string; name: string; note: string; fp: string; inv: PubInvite }

export interface DeskHandlers {
  /** Somebody knocked on one of our invites - say it loudly; the name is only a claim. */
  knock?(k: Knock): void
  /** A knock from a key we already hold - said once per invite, not swallowed. */
  knownKnock?(c: Contact, inv: PubInvite): void
  /** They appeared on the pair topic: a knock of ours was accepted. */
  accepted?(c: Contact | undefined, pub: string): void
}

export interface DeskOpts {
  session: Pick<ClientSession, 'watchInbox' | 'knock'>
  store: InviteStore
  me: { handle: string }
  /** The contacts as they are now. */
  contacts(): Contact[]
  /** Save a contact AND start watching it; returns it as listed. */
  addContact(name: string, pub: string): Promise<Contact>
  on?: DeskHandlers
  log?(m: string): void
  knockEveryMs?: number
  invitesEveryMs?: number
}

const b64 = (u: Uint8Array) => btoa(String.fromCharCode(...u))

export class KnockDesk {
  private o: DeskOpts
  private knocks: Knock[] = []
  private seq = 0
  private inboxes = new Map<string, { stop(): void }>()
  private knownSaid = new Set<string>()
  private waiting = new Map<string, Waiting>()
  private timers: any[] = []

  constructor(o: DeskOpts) { this.o = o }

  /** Load what we are knocking on, listen on our invites, knock once now, then keep at both. */
  async start(): Promise<void> {
    this.waiting = await this.o.store.waiting()
    // A knock sealed to the identity key is opened by nobody since knocks are
    // sealed to the invite's key (the app's loadWaiting drops the same records).
    for (const [pub, w] of [...this.waiting]) if (!w.key) this.waiting.delete(pub)
    await this.watchInvites()
    this.knockAll()
    const every = (f: () => void, ms: number) => { const t = setInterval(f, ms); t.unref?.(); this.timers.push(t) }
    every(() => void this.watchInvites(), this.o.invitesEveryMs ?? INVITES_EVERY_MS)
    every(() => this.knockAll(), this.o.knockEveryMs ?? KNOCK_EVERY_MS)
  }

  stop() {
    for (const t of this.timers) clearInterval(t)
    this.timers = []
    for (const w of this.inboxes.values()) { try { w.stop() } catch {} }
    this.inboxes.clear()
  }

  /** How many of our invites are being listened on. */
  listening(): number { return this.inboxes.size }
  /** Who we are still knocking on. */
  knockingOn(): string[] { return [...this.waiting.values()].map((w) => w.name) }
  /** Knocks waiting for a decision, oldest first. */
  list(): Knock[] { return [...this.knocks] }

  /** Accepting IS adding the contact: they hold our key from the invite, now we hold theirs (§5.8). */
  async accept(n: number): Promise<{ knock: Knock; contact: Contact }> {
    const k = this.take(n)
    const contact = await this.o.addContact(k.name, k.ik)
    return { knock: k, contact }
  }

  /** Dismiss it and every later knock from the same key (the app's ignore list, by fingerprint). */
  async ignore(n: number): Promise<Knock> {
    const k = this.take(n)
    await this.o.store.ignore(k.fp)
    return k
  }

  /**
   * Knock on somebody else's invite (one with an inbox) and keep knocking until
   * they accept. The contact must already be saved. Resolves with how many
   * peers carried the first knock (0 = nobody listened yet; null = unknown).
   */
  async knockInvite(inv: Invite, name: string, note?: string): Promise<number | null> {
    if (!inv.inbox || !inv.key) throw new Error('to zaproszenie nie ma skrzynki - nie ma do czego pukać')
    const w: Waiting = { inbox: inv.inbox, key: inv.key, name, since: Date.now(), ...(note ? { note } : {}) }
    this.waiting.set(inv.pub, w)
    await this.o.store.saveWaiting(this.waiting)
    return this.knockOne(w)
  }

  /** Presence says `pub` is here. True when that ends a knock of ours. */
  online(pub: string): boolean {
    if (!this.waiting.delete(pub)) return false
    void this.o.store.saveWaiting(this.waiting)
    this.o.on?.accepted?.(this.o.contacts().find((c) => c.pub === pub), pub)
    return true
  }

  private take(n: number): Knock {
    const k = this.knocks.find((x) => x.n === n)
    if (!k) throw new Error(`nie ma pukania nr ${n}`)
    this.knocks = this.knocks.filter((x) => x !== k)
    return k
  }

  private knockOne(w: Waiting): Promise<number | null> {
    const raw = inboxSecretBytes({ pub: '', name: '', inbox: w.inbox })
    if (!raw || !w.key) return Promise.resolve(null)
    return this.o.session.knock(raw, w.key, { name: this.o.me.handle, note: w.note })
  }

  private knockAll() {
    for (const w of this.waiting.values()) void this.knockOne(w).catch((e) => this.o.log?.(`pukanie do ${w.name} nie wyszło: ${e?.message ?? e}`))
  }

  private async watchInvites() {
    const list = await this.o.store.invites()
    for (const [id, wt] of this.inboxes) if (!list.some((i) => i.id === id && !expired(i))) { wt.stop(); this.inboxes.delete(id) }
    for (const inv of list) {
      if (this.inboxes.has(inv.id) || expired(inv)) continue
      const raw = inboxSecretBytes({ pub: '', name: '', inbox: inv.secret }); if (!raw) continue
      this.inboxes.set(inv.id, this.o.session.watchInbox(raw, { onKnock: (k) => void this.onKnock(inv, b64(k.ik), k.name, k.note) }))
    }
  }

  /** Exposed for tests: what a knock frame on invite `inv` does. */
  async onKnock(inv: PubInvite, ik: string, name: string, note: string) {
    if (this.knocks.some((x) => x.ik === ik && x.inv.id === inv.id)) return       // a re-knock while waiting
    const known = this.o.contacts().find((c) => c.pub === ik)
    if (known) {
      if (this.knownSaid.has(ik + inv.id)) return   // the app re-knocks every 90 s; say it once
      this.knownSaid.add(ik + inv.id)
      // Said, not swallowed: silence here made a working invite look broken
      // (2026-10-07 - the phone already held this key).
      this.o.on?.knownKnock?.(known, inv)
      return
    }
    const fp = await fingerprint(ik)
    if ((await this.o.store.ignored()).some((r) => r.fp === fp)) return
    if (this.knocks.some((x) => x.ik === ik && x.inv.id === inv.id)) return       // raced the awaits
    const k: Knock = { n: ++this.seq, ik, name: (name || 'bez nazwy').slice(0, 64), note: note ?? '', fp, inv }
    this.knocks.push(k)
    this.o.on?.knock?.(k)
  }
}
