/**
 * groups.ts - groups for the CLI (CLI-PLAN.md stage 6), the app's mechanism.
 *
 * The crypto is lib/group.ts (Sender Keys, PROTOCOL.md §8) behind the session;
 * this is the orchestration app.ts does for the web, written for a terminal:
 *   - an invitation (`group-skd` over a 1:1) joins the group, and we hand our
 *     own sender key to every member once (that is also the admin's receipt);
 *   - a newer epoch (a roster change) reopens the group and hands the fresh key
 *     out again; the name changes only when roster[0], the admin, says so;
 *   - a member asking for our key gets it only if the roster holds them;
 *   - a frame we cannot open asks its sender for their key over the 1:1;
 *   - an admin's invitations are owed until each member's key comes back
 *     (web/src/groupview.ts OwedInvites), re-sent when that member is online;
 *   - state is sealed in the store under the app's keys and format
 *     (`ec-gcache-<kid>-<gidHex>`, {snap, name, owed} through lib/gcache.ts),
 *     so a profile moved between the app and the terminal keeps its groups.
 * Sender keys ride the 1:1, so a member who is not one of our contacts cannot
 * be reached either way (the app says the same thing in its member list).
 */

import type { ClientSession, Conversation, Contact } from '../lib/core.ts'
import type { GroupRoom } from '../lib/grouproom.ts'
import type { MsgEnv, FileEnv, ReactionEnv } from '../lib/envelope.ts'
import { sealCache, openCache } from '../lib/gcache.ts'
import { closeMentions } from '../lib/mentions.ts'
import { OwedInvites } from '../web/src/groupview.ts'
import type { KV } from '../lib/migrate.ts'

const te = new TextEncoder(), td = new TextDecoder()
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0))
const b64 = (u: Uint8Array) => btoa(String.fromCharCode(...u))

export interface GroupInfo { gid: string; name: string; epoch: number; members: string[]; room: GroupRoom | null }

export interface GroupHandlers {
  joined?(g: GroupInfo, how: 'invite' | 'restore' | 'create'): void
  updated?(g: GroupInfo, what: string): void
  message?(g: GroupInfo, fromPub: string, m: MsgEnv): void
  file?(g: GroupInfo, fromPub: string, f: FileEnv): void
  reaction?(g: GroupInfo, fromPub: string, r: ReactionEnv): void
  log?(m: string): void
}

export class Groups {
  private session: ClientSession; private me: string; private kv: KV; private base: Uint8Array | null; private kid: string
  private conv: (pub: string) => Promise<Conversation | null>
  private contacts: () => Contact[]
  private h: GroupHandlers
  readonly owed = new OwedInvites()
  private infos = new Map<string, GroupInfo>()

  constructor(o: {
    session: ClientSession; me: string; kv: KV; base: Uint8Array | null; kid: string
    /** The 1:1 with a member, opened if they are a contact; null otherwise. */
    conv: (pub: string) => Promise<Conversation | null>
    contacts: () => Contact[]
    handlers: GroupHandlers
  }) {
    this.session = o.session; this.me = o.me; this.kv = o.kv; this.base = o.base; this.kid = o.kid
    this.conv = o.conv; this.contacts = o.contacts; this.h = o.handlers
  }

  list(): GroupInfo[] { return [...this.infos.values()] }
  get(gid: string) { return this.infos.get(gid) }
  isAdmin(g: GroupInfo) { return g.members[0] === this.me }
  private log(m: string) { this.h.log?.(m) }
  private prefix() { return 'ec-gcache-' + this.kid + '-' }

  private async open(g: GroupInfo) {
    g.room?.stop()
    g.room = await this.session.openGroup(g.gid, {
      onMessage: (from, m) => this.h.message?.(g, from, m),
      onFile: (from, f) => this.h.file?.(g, from, f),
      onReaction: (from, r) => this.h.reaction?.(g, from, r),
      onNeedSenderKey: (memberPub) => void this.askFor(g, memberPub),
    })
  }

  /** Bring every group back from the sealed cache. */
  async restore() {
    if (!this.base) return
    for (const k of this.kv.keys()) {
      if (!k.startsWith(this.prefix())) continue
      const gid = k.slice(this.prefix().length)
      const pt = await openCache(this.base, gid, this.kv.get(k)!)
      if (!pt) { this.log(`grupa ${gid.slice(0, 8)}…: nie da się otworzyć zapisu`); continue }
      let parsed: any; try { parsed = JSON.parse(td.decode(pt)) } catch { continue }
      try {
        const [gidHex] = await this.session.groups.restore([parsed.snap])
        const g: GroupInfo = { gid: gidHex, name: parsed.name || 'Grupa', epoch: parsed.snap.epoch, members: (parsed.snap.roster as { pub: string }[]).map((m) => m.pub), room: null }
        this.infos.set(gidHex, g)
        this.owed.load(gidHex, parsed.owed)
        await this.open(g)
        this.h.joined?.(g, 'restore')
      } catch (e: any) { this.log(`grupa ${gid.slice(0, 8)}…: ${e?.message ?? e}`) }
    }
    // What was owed before a restart goes out again (queued on each 1:1).
    for (const g of this.infos.values()) for (const p of this.owed.owedFor(g.gid)) void this.distribute(g, p)
  }

  async persist() {
    if (!this.base) { this.log('grupy: brak klucza §10 - NIE zapisano'); return }
    for (const snap of this.session.groups.snapshot()) {
      const gid = this.session.groups.gidHexOf(unb64((snap as any).gid))
      const g = this.infos.get(gid); if (!g) continue
      const blob = await sealCache(this.base, gid, te.encode(JSON.stringify({ snap, name: g.name, owed: this.owed.toJSON(gid) })))
      this.kv.set(this.prefix() + gid, blob)
    }
  }

  /** Hand my sender key for `g` to every member (or to `only`), over the 1:1. */
  async distribute(g: GroupInfo, only?: string) {
    for (const m of g.members) {
      if (m === this.me || (only && m !== only)) continue
      const skd = await this.session.groups.skdFor(g.gid, m); if (!skd) continue
      const conv = await this.conv(m)
      if (!conv) { this.log(`grupa „${g.name}”: ${m.slice(0, 8)}… nie jest Twoim kontaktem - nie przekażę klucza`); continue }
      conv.sendGroupSkd({ ...skd, name: g.name })
    }
  }

  private async askFor(g: GroupInfo, memberPub: string) {
    const gs = this.session.groups.session(g.gid); if (!gs) return
    const conv = await this.conv(memberPub)
    if (conv) conv.sendGroupSkdReq(b64((gs as any).gid), g.epoch)
  }

  /** An SKD arrived over a 1:1 (the engine already applied it). */
  async onInvite(from: string, skd: any) {
    const gid = this.session.groups.gidHexOf(unb64(skd.gid))
    if (this.owed.receipt(gid, from, skd.epoch)) void this.persist()
    let g = this.infos.get(gid)
    if (!g) {
      g = { gid, name: skd.name || 'Grupa', epoch: skd.epoch, members: skd.roster.slice(), room: null }
      this.infos.set(gid, g)
      await this.open(g)
      this.h.joined?.(g, 'invite')
      void this.distribute(g)                 // my key to everyone, once
      void this.session.groups.writeMemberMarker(gid, g.name).catch(() => false)
    } else {
      const changed: string[] = []
      if (skd.roster.join() !== g.members.join()) { g.members = skd.roster.slice(); changed.push('skład') }
      if (skd.name && skd.name !== g.name && from === skd.roster[0]) { g.name = skd.name; changed.push('nazwa') }
      if (skd.epoch > g.epoch) { g.epoch = skd.epoch; await this.open(g); void this.distribute(g); changed.push('epoka') }
      if (changed.length) this.h.updated?.(g, changed.join(', '))
    }
    await this.persist()
  }

  /** A member asks for our key: only roster members get it. */
  async onSkdReq(from: string, req: { gid: string }) {
    const g = this.infos.get(this.session.groups.gidHexOf(unb64(req.gid))); if (!g) return
    if (!g.members.includes(from)) { this.log(`ktoś spoza składu grupy prosił o klucz - zignorowano`); return }
    await this.distribute(g, from)
  }

  /** A contact came online: re-send invitations still owed to them. */
  onOnline(pub: string) {
    for (const gid of this.owed.groupsOwing(pub)) { const g = this.infos.get(gid); if (g) void this.distribute(g, pub) }
  }

  async create(name: string, memberPubs: string[]): Promise<GroupInfo> {
    const roster = [this.me, ...memberPubs.filter((p) => p !== this.me)]
    const gid = await this.session.groups.createGroupWithNewKey(`chat-gk-${name}`.slice(0, 32), roster.map((pub) => ({ pub })), name)
    const g: GroupInfo = { gid, name, epoch: 0, members: roster, room: null }
    this.infos.set(gid, g)
    await this.open(g)
    this.owed.invite(gid, 0, roster.slice(1))
    this.h.joined?.(g, 'create')
    await this.distribute(g)
    await this.persist()
    return g
  }

  /** Send to a group; "@Name" of a member becomes a mention the app resolves. */
  async send(g: GroupInfo, text: string, names: (pub: string) => string): Promise<string> {
    if (!g.room) throw new Error('grupa nie jest otwarta')
    const roster = g.members.filter((p) => p !== this.me).map((pub) => ({ pub, name: names(pub) }))
    return g.room.sendText(closeMentions(text, roster))
  }
}
