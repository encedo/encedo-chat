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
 *     (web/src/groupview.ts OwedInvites), re-sent when that member is online
 *     and, right after they go out, again at 10, 30 and 90 s: a `group-skd`
 *     has no ack, and one sent on a 1:1 that the distribution itself just
 *     opened can beat the handshake's msg3 to the member, who drops it;
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
      onMessage: (from, m) => { this.h.message?.(g, from, m); this.schedulePersist() },
      onFile: (from, f) => { this.h.file?.(g, from, f); this.schedulePersist() },
      onReaction: (from, r) => this.h.reaction?.(g, from, r),
      onNeedSenderKey: (memberPub) => void this.askFor(g, memberPub),
      onLog: (m) => this.log(`grupa „${g.name}”: ${m}`),
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

  /**
   * The chains move with every frame, so the state is saved as the app saves it
   * (app.ts): at once after our own send - a restart that resumed our sending
   * chain from an older counter would send on counters the members have
   * already passed, and they would read nothing - and on a short debounce after
   * a receive.
   */
  private persistTimer: ReturnType<typeof setTimeout> | undefined
  private schedulePersist() {
    clearTimeout(this.persistTimer)
    this.persistTimer = setTimeout(() => void this.persist(), 1500)
    this.persistTimer.unref?.()
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
    // An older epoch's copy (a removed member re-sending its key) speaks for
    // nothing: its roster would put that member back on our list.
    if (g && skd.epoch < g.epoch) return
    if (!g) {
      g = { gid, name: skd.name || 'Grupa', epoch: skd.epoch, members: skd.roster.slice(), room: null }
      this.infos.set(gid, g)
      await this.open(g)
      this.h.joined?.(g, 'invite')
      void this.distribute(g)                 // my key to everyone
      this.redistribute(g)
      void this.session.groups.writeMemberMarker(gid, g.name).catch(() => false)
    } else {
      const changed: string[] = []
      if (skd.roster.join() !== g.members.join()) { g.members = skd.roster.slice(); changed.push('skład') }
      if (skd.name && skd.name !== g.name && from === skd.roster[0]) { g.name = skd.name; changed.push('nazwa') }
      if (skd.epoch > g.epoch) { g.epoch = skd.epoch; await this.open(g); void this.distribute(g); this.redistribute(g); changed.push('epoka') }
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

  /** Re-send what is still owed for `g` a few times (see the header): cheap, idempotent, stops at the receipt. */
  private chase(g: GroupInfo) {
    for (const ms of [10_000, 30_000, 90_000]) {
      const t = setTimeout(() => { for (const p of this.owed.owedFor(g.gid)) void this.distribute(g, p) }, ms)
      t.unref?.()
    }
  }

  /**
   * A member's own key, handed out on joining, meets the same race as an
   * invitation (no ack; a fresh 1:1 can drop it before msg3) and has no receipt
   * to stop at, so it simply goes twice more. A re-sent SKD carries the chain's
   * current counter, so a copy that arrives late breaks nothing.
   */
  private redistribute(g: GroupInfo) {
    const epoch = g.epoch
    for (const ms of [10_000, 30_000]) {
      const t = setTimeout(() => { if (g.epoch === epoch) void this.distribute(g) }, ms)
      t.unref?.()
    }
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
    this.chase(g)
    await this.persist()
    return g
  }

  /**
   * Admin: change the roster (app.ts changeMembers). A rekey: new epoch, new
   * group secret and topic, fresh keys handed only to the NEW roster - a
   * removed member is locked out of everything sent from here on. roster[0]
   * stays the admin.
   */
  async setMembers(g: GroupInfo, members: string[]): Promise<void> {
    if (!this.isAdmin(g)) throw new Error('tylko admin grupy może zmieniać jej skład')
    const roster = [this.me, ...members.filter((p) => p !== this.me)]
    await this.session.groups.rekey(g.gid, roster.map((pub) => ({ pub })))
    g.members = roster
    g.epoch++
    this.owed.invite(g.gid, g.epoch, roster.slice(1))
    await this.open(g)
    await this.distribute(g)
    this.chase(g)
    // The device's marker carries the roster; a stale one would rebuild the old set.
    this.session.groups.writeMarker(g.gid, g.name).catch(() => false)
    await this.persist()
  }
  addMember(g: GroupInfo, pub: string) {
    if (g.members.includes(pub)) throw new Error('już jest w grupie')
    return this.setMembers(g, [...g.members.slice(1), pub])
  }
  removeMember(g: GroupInfo, pub: string) {
    if (pub === this.me) throw new Error('admin nie usuwa samego siebie')
    if (!g.members.includes(pub)) throw new Error('nie ma go/jej w grupie')
    return this.setMembers(g, g.members.slice(1).filter((p) => p !== pub))
  }

  /** Admin: rename (app.ts renameGroup) - no rekey, the name rides a same-epoch handoff. */
  async rename(g: GroupInfo, name: string): Promise<void> {
    if (!this.isAdmin(g)) throw new Error('tylko admin grupy może zmienić jej nazwę')
    const before = g.name
    g.name = name
    try {
      await this.distribute(g)
      this.session.groups.writeMarker(g.gid, name).catch(() => false)
      this.session.groups.writeMemberMarker(g.gid, name).catch(() => false)
      await this.persist()
    } catch (e) { g.name = before; throw e }
  }

  /** Find a group by name (case-insensitive). */
  byName(name: string): GroupInfo | undefined { return this.list().find((g) => g.name.toLowerCase() === name.toLowerCase()) }

  /** Send to a group; "@Name" of a member becomes a mention the app resolves. */
  async send(g: GroupInfo, text: string, names: (pub: string) => string): Promise<string> {
    if (!g.room) throw new Error('grupa nie jest otwarta')
    const roster = g.members.filter((p) => p !== this.me).map((pub) => ({ pub, name: names(pub) }))
    const id = await g.room.sendText(closeMentions(text, roster))
    await this.persist()
    return id
  }
}
