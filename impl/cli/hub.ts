/**
 * hub.ts - the headless engine behind the script mode and the daemon
 * (CLI-PLAN.md stage 4): one session, a presence watch for every contact,
 * rooms opened on demand, and events out.
 *
 * `send` returns once the recipient's client confirms (the ordinary `ack`,
 * SPEC.md delivery contract) or the wait runs out. A message that was not
 * confirmed in time is NOT dropped: the room keeps it and re-sends it when the
 * recipient is back - for as long as this process runs. That is the honest
 * meaning of exit 3 ("queued"): it waits HERE, nowhere else (instant-only).
 */

import type { Names } from '../lib/storenames.ts'
import { startSession, type ClientSession, type Conversation, type ContactManager, type Contact, type Identity } from '../lib/core.ts'
import { prepareFile, saveFile, downloadDir } from './files.ts'
import type { FileMeta } from '../lib/envelope.ts'
import { Groups } from './groups.ts'
import type { KV } from '../lib/migrate.ts'
import { anchorClock } from '../lib/clock.ts'
import { hostOf } from '../lib/ice.ts'
import { inviteFromPaste, inviteLink } from '../lib/invite.ts'
import { InviteStore } from './invites.ts'
import { KnockDesk } from './knocks.ts'
import { fingerprint } from './fp.ts'

export const APP_ORIGIN = 'https://app.onchato.com', APP_PATH = '/'

export type HubEvent =
  | { t: 'msg'; from: string; pub: string; text: string; ts: number; id: string; group?: string }
  | { t: 'file'; from: string; pub: string; name: string; size: number; mime: string; ts: number; id: string; group?: string }
  | { t: 'group'; name: string; members: number; how: string }
  | { t: 'presence'; from: string; pub: string; state: 'online' | 'offline' }
  | { t: 'delivered'; to: string; pub: string; id: string; ms: number }
  | { t: 'link'; state: 'online' | 'reconnecting' | 'offline' }
  /** Somebody knocked on one of our invites; `n` is what `accept` / `ignore` take. */
  | { t: 'knock'; n: number; name: string; fp: string; note: string; invite: string }
  /** A contact appeared in the book: `added` (add/accept) or `accepted` (they took our knock). */
  | { t: 'contact'; name: string; pub: string; fp: string; how: 'added' | 'accepted' }

/** What `addFromLink` did. `reply` is the link to send back when theirs had no inbox. */
export interface AddResult { status: 'added' | 'known'; name: string; fp: string; knock?: number | null; reply?: string }

/** 'sent' is a group: a broadcast has no acks to wait for (SPEC.md §8). */
export interface SendResult { status: 'delivered' | 'queued' | 'sent'; id: string; ms?: number; to: string }

export class Hub {
  readonly id: Identity
  private contacts: ContactManager
  private relays: string[]
  private transport: 'light' | 'libp2p'
  private networkId?: string
  private log: (m: string) => void
  private vault?: { kv: KV; base: Uint8Array | null; names: Names }
  private hem: boolean
  private invites: boolean
  private presence!: { onOnline(p: { pub: string }): void; onOffline(p: { pub: string }): void; onWantsConversation(p: { pub: string }): void }
  /** Invites both ways (cli/knocks.ts) - only with `invites: true`, i.e. in the daemon. */
  desk: KnockDesk | null = null
  groups: Groups | null = null
  session!: ClientSession
  contactList: Contact[] = []
  online = new Set<string>()
  private rooms = new Map<string, Promise<Conversation>>()
  private waiters = new Map<string, (ms: number) => void>()
  private listeners = new Set<(e: HubEvent) => void>()
  /** Received files by message id - the key stays in memory, never in an event. */
  files = new Map<string, FileMeta>()

  constructor(o: {
    id: Identity; contacts: ContactManager; relays: string[]; transport?: 'light' | 'libp2p'; networkId?: string; log?: (m: string) => void
    vault?: { kv: KV; base: Uint8Array | null; names: Names }
    /** New contacts go to the HEM (the identity is a HEM one). */
    hem?: boolean
    /** Listen on our invites and keep knocking on theirs: a long-lived session (the daemon), never a one-shot `send`. */
    invites?: boolean
  }) {
    this.id = o.id; this.contacts = o.contacts; this.relays = o.relays; this.vault = o.vault; this.networkId = o.networkId
    this.transport = o.transport ?? 'light'; this.log = o.log ?? (() => {}); this.hem = !!o.hem; this.invites = !!o.invites
  }

  on(cb: (e: HubEvent) => void): () => void { this.listeners.add(cb); return () => this.listeners.delete(cb) }
  private emit(e: HubEvent) { for (const l of this.listeners) { try { l(e) } catch {} } }

  async start(): Promise<void> {
    this.session = await startSession(this.id, {
      relay: this.relays[0], relays: this.relays, transport: this.transport, networkId: this.networkId, onLog: this.log,
      onLink: (state) => this.emit({ t: 'link', state }),
      onGroupSkd: (from, skd) => { void this.groups?.onInvite(from, skd) },
      onGroupSkdReq: (from, req) => { void this.groups?.onSkdReq(from, req) },
    })
    // The clock anchor (5.4): from the node, now and hourly; a miss keeps the last one.
    const anchor = () => { void anchorClock(this.relays.map(hostOf).filter((h): h is string => !!h), { log: this.log }) }
    anchor(); setInterval(anchor, 3_600_000).unref?.()
    this.contactList = await this.contacts.list()
    // Before presence starts, so an acceptance of our knock that lands at once is recognised.
    if (this.invites && this.vault) {
      this.desk = new KnockDesk({
        session: this.session, store: new InviteStore(this.vault.kv, this.vault.base, this.vault.names), me: this.id,
        contacts: () => this.contactList, addContact: (name, pub) => this.addContact(name, pub), log: this.log,
        on: {
          knock: (k) => this.emit({ t: 'knock', n: k.n, name: k.name, fp: k.fp, note: k.note, invite: k.inv.label }),
          accepted: (c, pub) => void fingerprint(pub).then((fp) => this.emit({ t: 'contact', name: c?.name ?? pub.slice(0, 8), pub, fp, how: 'accepted' })),
        },
      })
      await this.desk.start()
    }
    this.presence = {
      onOnline: (p) => this.setOnline(p.pub, true),
      onOffline: (p) => this.setOnline(p.pub, false),
      // Somebody writes to us: open the room so the handshake completes and the message arrives.
      onWantsConversation: (p) => { const c = this.contactList.find((x) => x.pub === p.pub); if (c) void this.room(c) },
    }
    await this.session.watchContacts(this.contactList.map((c) => ({ pub: c.pub })), this.presence)
    if (this.vault) {
      this.groups = new Groups({
        session: this.session, me: this.id.pub, ...this.vault, contacts: () => this.contactList,
        conv: async (pub) => { const c = this.contactList.find((x) => x.pub === pub); return c ? this.room(c) : null },
        handlers: {
          joined: (g, how) => this.emit({ t: 'group', name: g.name, members: g.members.length, how }),
          message: (g, from, m) => this.emit({ t: 'msg', group: g.name, from: this.nameOf(from), pub: from, text: m.body, ts: m.ts, id: m.id }),
          file: (g, from, f) => {
            this.files.set(f.id, f as unknown as FileMeta)
            this.emit({ t: 'file', group: g.name, from: this.nameOf(from), pub: from, name: f.name, size: f.size, mime: f.mime, ts: f.ts, id: f.id })
          },
          log: this.log,
        },
      })
      await this.groups.restore()
    }
  }

  /** One presence event per change of a contact, whichever layer saw it. */
  private setOnline(pub: string, on: boolean) {
    if (on) {
      if (this.online.has(pub)) return
      this.online.add(pub); this.groups?.onOnline(pub); this.desk?.online(pub)
      this.emit({ t: 'presence', from: this.nameOf(pub), pub, state: 'online' })
    } else if (this.online.delete(pub)) this.emit({ t: 'presence', from: this.nameOf(pub), pub, state: 'offline' })
  }

  /** Save a contact and start watching it - no restart: the daemon's book is live. */
  async addContact(name: string, pub: string): Promise<Contact> {
    await this.contacts.add(name, pub, this.hem)
    await new Promise((r) => setTimeout(r, 150)) // the book's seal follows the write
    this.contactList = await this.contacts.list()
    await this.session.watchContacts([{ pub }], this.presence)
    const c = this.contactList.find((x) => x.pub === pub)
    if (!c) throw new Error('kontakt nie zapisał się w książce')
    this.emit({ t: 'contact', name: c.name, pub, fp: await fingerprint(pub), how: 'added' })
    return c
  }

  /**
   * A contact from a link (identity link or invite, any shape `add` takes). With
   * an inbox: knock, and keep knocking until they accept (needs `invites`).
   * Without one: hand back our reply link - they still need our key.
   * No question asked here: whoever calls decided (the CLI after t/N, a bot after
   * its admin confirmed the fingerprint).
   */
  async addFromLink(link: string, o: { name?: string; note?: string } = {}): Promise<AddResult> {
    const inv = inviteFromPaste(link)
    if (!inv) throw new Error('to nie jest link onchato ani kod zaproszenia')
    if (inv.pub === this.id.pub) throw new Error('to Twój własny klucz')
    const fp = await fingerprint(inv.pub)
    const known = this.contactList.find((c) => c.pub === inv.pub)
    if (known) return { status: 'known', name: known.name, fp }
    const name = (o.name ?? inv.name ?? '').trim().slice(0, 64) || 'bez nazwy'
    if (inv.inbox && inv.key && !this.desk) throw new Error('pukanie wymaga demona (onchato-cli daemon)')
    const c = await this.addContact(name, inv.pub)
    if (inv.inbox && inv.key) return { status: 'added', name: c.name, fp, knock: await this.desk!.knockInvite(inv, c.name, o.note) }
    return { status: 'added', name: c.name, fp, ...(inv.reply ? {} : { reply: inviteLink(APP_ORIGIN, APP_PATH, { pub: this.id.pub, name: this.id.handle, reply: true }) }) }
  }

  nameOf(pub: string) { return this.contactList.find((c) => c.pub === pub)?.name ?? pub.slice(0, 8) }

  /** A contact by name (case-insensitive) or by its public key. */
  find(who: string): Contact | undefined {
    return this.contactList.find((c) => c.name.toLowerCase() === who.toLowerCase() || c.pub === who)
  }

  /** The room for a contact, opened once. */
  room(c: Contact): Promise<Conversation> {
    let r = this.rooms.get(c.pub)
    if (!r) {
      // An open room retires the light watch, so from here the ROOM says who is
      // present - per PeerId (a restarted peer joins under a new one before the
      // old one times out). Without this a contact whose handshake came before
      // its first Announce never went online, and the queue waited for good.
      const here = new Set<string>()
      r = this.session.open({ pub: c.pub }, {
        onPresence: (peer, ev) => {
          if (ev === 'quiet' || ev === 'leave') here.delete(peer); else here.add(peer)
          this.setOnline(c.pub, here.size > 0)
        },
        onMessage: (_from, m) => this.emit({ t: 'msg', from: c.name, pub: c.pub, text: m.body, ts: m.ts, id: m.id }),
        onFile: (_from, f) => {
          this.files.set(f.id, f as unknown as FileMeta)
          this.emit({ t: 'file', from: c.name, pub: c.pub, name: f.name, size: f.size, mime: f.mime, ts: f.ts, id: f.id })
        },
        onDelivered: (id, ms) => { this.waiters.get(id)?.(ms); this.waiters.delete(id); this.emit({ t: 'delivered', to: c.name, pub: c.pub, id, ms }) },
      })
      this.rooms.set(c.pub, r)
    }
    return r
  }

  /** Send, then wait up to `waitMs` for the recipient's confirmation. */
  async send(who: string, text: string, waitMs = 20_000): Promise<SendResult> {
    const g = this.groups?.byName(who)
    if (g) return { status: 'sent', id: await this.groups!.send(g, text, (p) => this.nameOf(p)), to: g.name }
    const c = this.find(who)
    if (!c) throw new Error(`nie ma kontaktu „${who}”`)
    const conv = await this.room(c)
    const id = conv.sendText(text)
    const ms = await this.waitFor(id, waitMs)
    return ms === null ? { status: 'queued', id, to: c.name } : { status: 'delivered', id, ms, to: c.name }
  }

  /** Encrypt, upload and send a file; wait for the recipient's ack like `send`. */
  async sendFile(who: string, path: string, waitMs = 20_000): Promise<SendResult & { name: string }> {
    const c = this.find(who)
    if (!c) throw new Error(`nie ma kontaktu „${who}”`)
    const meta = await prepareFile(path)
    const conv = await this.room(c)
    const id = conv.sendFile(meta)
    const ms = await this.waitFor(id, waitMs)
    return ms === null ? { status: 'queued', id, to: c.name, name: meta.name } : { status: 'delivered', id, ms, to: c.name, name: meta.name }
  }

  /** Save a received file (by message id, or a unique prefix of one). */
  async getFile(id: string, dir = downloadDir()): Promise<string> {
    const hits = [...this.files.keys()].filter((k) => k.startsWith(id))
    if (hits.length !== 1) throw new Error(hits.length ? `id ${id} pasuje do ${hits.length} plików` : `nie ma pliku ${id}`)
    return saveFile(this.files.get(hits[0])!, dir)
  }

  private waitFor(id: string, waitMs: number): Promise<number | null> {
    return new Promise<number | null>((resolve) => {
      this.waiters.set(id, resolve)
      const t = setTimeout(() => { this.waiters.delete(id); resolve(null) }, waitMs); (t as any).unref?.()
    })
  }

  async close(): Promise<void> {
    this.desk?.stop()
    for (const r of this.rooms.values()) { try { await (await r).leave() } catch {} }
    try { await this.session?.close() } catch {}
  }
}
