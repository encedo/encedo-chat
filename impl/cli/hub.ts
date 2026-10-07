/**
 * hub.ts - the headless engine behind the script mode and the daemon
 * (CLI-PLAN.md stage 4): one session, a presence watch for every contact,
 * rooms opened on demand, and events out.
 *
 * `send` returns once the recipient's client confirms (the ordinary `ack`,
 * PROTOCOL.md delivery contract) or the wait runs out. A message that was not
 * confirmed in time is NOT dropped: the room keeps it and re-sends it when the
 * recipient is back - for as long as this process runs. That is the honest
 * meaning of exit 3 ("queued"): it waits HERE, nowhere else (instant-only).
 */

import { startSession, type ClientSession, type Conversation, type ContactManager, type Contact, type Identity } from '../lib/core.ts'

export type HubEvent =
  | { t: 'msg'; from: string; pub: string; text: string; ts: number; id: string }
  | { t: 'presence'; from: string; pub: string; state: 'online' | 'offline' }
  | { t: 'delivered'; to: string; id: string; ms: number }
  | { t: 'link'; state: 'online' | 'reconnecting' | 'offline' }

export interface SendResult { status: 'delivered' | 'queued'; id: string; ms?: number; to: string }

export class Hub {
  readonly id: Identity
  private contacts: ContactManager
  private relays: string[]
  private transport: 'light' | 'libp2p'
  private log: (m: string) => void
  session!: ClientSession
  contactList: Contact[] = []
  online = new Set<string>()
  private rooms = new Map<string, Promise<Conversation>>()
  private waiters = new Map<string, (ms: number) => void>()
  private listeners = new Set<(e: HubEvent) => void>()

  constructor(o: { id: Identity; contacts: ContactManager; relays: string[]; transport?: 'light' | 'libp2p'; log?: (m: string) => void }) {
    this.id = o.id; this.contacts = o.contacts; this.relays = o.relays
    this.transport = o.transport ?? 'light'; this.log = o.log ?? (() => {})
  }

  on(cb: (e: HubEvent) => void): () => void { this.listeners.add(cb); return () => this.listeners.delete(cb) }
  private emit(e: HubEvent) { for (const l of this.listeners) { try { l(e) } catch {} } }

  async start(): Promise<void> {
    this.session = await startSession(this.id, {
      relay: this.relays[0], relays: this.relays, transport: this.transport, onLog: this.log,
      onLink: (state) => this.emit({ t: 'link', state }),
    })
    this.contactList = await this.contacts.list()
    await this.session.watchContacts(this.contactList.map((c) => ({ pub: c.pub })), {
      onOnline: (p) => { if (!this.online.has(p.pub)) { this.online.add(p.pub); this.emit({ t: 'presence', from: this.nameOf(p.pub), pub: p.pub, state: 'online' }) } },
      onOffline: (p) => { if (this.online.delete(p.pub)) this.emit({ t: 'presence', from: this.nameOf(p.pub), pub: p.pub, state: 'offline' }) },
      // Somebody writes to us: open the room so the handshake completes and the message arrives.
      onWantsConversation: (p) => { const c = this.contactList.find((x) => x.pub === p.pub); if (c) void this.room(c) },
    })
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
      r = this.session.open({ pub: c.pub }, {
        onMessage: (_from, m) => this.emit({ t: 'msg', from: c.name, pub: c.pub, text: m.body, ts: m.ts, id: m.id }),
        onDelivered: (id, ms) => { this.waiters.get(id)?.(ms); this.waiters.delete(id); this.emit({ t: 'delivered', to: c.name, id, ms }) },
      })
      this.rooms.set(c.pub, r)
    }
    return r
  }

  /** Send, then wait up to `waitMs` for the recipient's confirmation. */
  async send(who: string, text: string, waitMs = 20_000): Promise<SendResult> {
    const c = this.find(who)
    if (!c) throw new Error(`nie ma kontaktu „${who}”`)
    const conv = await this.room(c)
    const id = conv.sendText(text)
    const ms = await new Promise<number | null>((resolve) => {
      this.waiters.set(id, resolve)
      const t = setTimeout(() => { this.waiters.delete(id); resolve(null) }, waitMs); (t as any).unref?.()
    })
    return ms === null ? { status: 'queued', id, to: c.name } : { status: 'delivered', id, ms, to: c.name }
  }

  async close(): Promise<void> {
    for (const r of this.rooms.values()) { try { await (await r).leave() } catch {} }
    try { await this.session?.close() } catch {}
  }
}
