/**
 * group.ts — group state + wire (docs/PROTOCOL.md §8/§5.3, ECDH-HMAC Proposal).
 *
 * A group is a software layer over the 1:1 mesh: each member has its own sending
 * chain (`lib/senderkey.ts`), everyone broadcasts on a shared topic derived from a
 * client-side `group_secret`, and messages are authenticated by a per-recipient
 * HMAC whose key comes from the pairwise ECDH — no signatures, so deniability is
 * kept (the §8 signature/S3 exception is removed).
 *
 * Derivations here:
 *   group_id  = SHA-256(GK_pub)[0:16]                          (GK = §8 group identity key)
 *   sender_id = SHA-256(IK_pub)[0:8]
 *   topic     = groupTopicFromSecret(group_secret, params)     (§5.3, rendezvous.ts)
 *   mk_ij     = HKDF(ECDH(IK_i,IK_j), "encedo-group-msg-mac"      , gid ‖ epoch)   msg auth
 *   rk_i      = HKDF(ECDH(GK,   IK_i), "encedo-chat-group-roster-mac", gid ‖ epoch)   roster auth
 *
 * Distribution of `group_secret` + each member's sending key rides the 1:1 ratchet
 * (stage 3); this module takes them as inputs and does the crypto/state/wire.
 *
 * Wire (group-msg), broadcast on the topic:
 *   T_GMSG ‖ VERSION ‖ header(32) ‖ macCount(1) ‖ {recipient_id(8) ‖ mac(32)}* ‖ ct
 *   header = group_id(16) ‖ sender_id(8) ‖ epoch(4 BE) ‖ ctr(4 BE)     (also the AEAD AAD)
 */

import { subtle, hkdfBits, sha256, unb64, b64, concat, randomBytes } from './wc.ts'
import type { RvParams } from './rendezvous.ts'
import { groupTopicFromSecret } from './rendezvous.ts'
import { seal, sendChainFrom, newSendChain, SenderReceiver, tag, verify, type SendChain, type ReceiverOpts } from './senderkey.ts'
import { x25519FromPriv } from './x25519.ts'
import type { SkdFields } from './envelope.ts'

const enc = new TextEncoder()
const MSG_MAC_INFO = enc.encode('encedo-group-msg-mac')
const ROSTER_MAC_INFO = enc.encode('encedo-chat-group-roster-mac')

const T_GMSG = 0x20
const VERSION = 1
const HDR_LEN = 16 + 8 + 4 + 4 // 32
const REC_LEN = 8 + 32         // recipient_id ‖ mac

/** Minimal identity contract this module needs (matches core's `Identity`). */
export interface GroupId {
  pub: string // base64 IK_pub
  ecdh(peerPubB64: string, peerKid?: string): Promise<Uint8Array>
}
export interface Member { pub: string; kid?: string }

// ---------------------------------------------------------------------------
// ids & derivations
// ---------------------------------------------------------------------------

export async function groupIdFromGK(gkPub: Uint8Array): Promise<Uint8Array> { return (await sha256(gkPub)).slice(0, 16) }
export async function senderIdOf(pubB64: string): Promise<Uint8Array> { return (await sha256(unb64(pubB64))).slice(0, 8) }

const epochBytes = (epoch: number) => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, epoch, false); return b }
const macInfo = (gid: Uint8Array, epoch: number) => concat(gid, epochBytes(epoch))

/** Per-recipient message MAC key from a pairwise ECDH secret (both members
 *  derive the same value). */
export async function msgMacKeyFromSecret(ss: Uint8Array, gid: Uint8Array, epoch: number): Promise<Uint8Array> {
  return hkdfBits(ss, MSG_MAC_INFO, macInfo(gid, epoch), 32)
}
/** Roster MAC key from ECDH(GK, IK_i) — admin holds GK_priv, member holds GK_pub;
 *  the caller supplies the shared secret. */
export async function rosterMacKeyFromSecret(ss: Uint8Array, gid: Uint8Array, epoch: number): Promise<Uint8Array> {
  return hkdfBits(ss, ROSTER_MAC_INFO, macInfo(gid, epoch), 32)
}

/** Canonical roster bytes for the roster MAC — the member pubs sorted, so the MAC
 *  does not depend on the order the roster happens to be listed in. */
function rosterBytes(roster: string[]): Uint8Array { return enc.encode([...roster].sort().join('\n')) }
/** HMAC(rk_i, roster) — the admin's per-recipient attestation of the membership. */
async function rosterMac(rk: Uint8Array, roster: string[]): Promise<Uint8Array> {
  const key = await subtle.importKey('raw', rk, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  return new Uint8Array(await subtle.sign('HMAC', key, rosterBytes(roster)))
}
async function verifyRosterMac(rk: Uint8Array, roster: string[], mac: Uint8Array): Promise<boolean> {
  const key = await subtle.importKey('raw', rk, { name: 'HMAC', hash: 'SHA-256' }, false, ['verify'])
  return subtle.verify('HMAC', key, mac, rosterBytes(roster))
}

// ---------------------------------------------------------------------------
// header wire
// ---------------------------------------------------------------------------

interface Header { gid: Uint8Array; senderId: Uint8Array; epoch: number; ctr: number }
function encodeHeader(h: Header): Uint8Array {
  const b = new Uint8Array(HDR_LEN)
  b.set(h.gid, 0); b.set(h.senderId, 16)
  const dv = new DataView(b.buffer)
  dv.setUint32(24, h.epoch, false); dv.setUint32(28, h.ctr, false)
  return b
}
function decodeHeader(b: Uint8Array): Header {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength)
  return { gid: b.slice(0, 16), senderId: b.slice(16, 24), epoch: dv.getUint32(24, false), ctr: dv.getUint32(28, false) }
}
const hex = (u: Uint8Array) => Array.from(u, (x) => x.toString(16).padStart(2, '0')).join('')
const bytesEq = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((x, i) => x === b[i])

// ---------------------------------------------------------------------------
// the session
// ---------------------------------------------------------------------------

export interface GroupInit {
  id: GroupId
  gid: Uint8Array
  epoch: number
  groupSecret: Uint8Array
  members: Member[]          // roster INCLUDING self
  mySendKey?: Uint8Array     // seed my sending chain (from re-import); else fresh
  params: RvParams
  receiverOpts?: ReceiverOpts
}

/**
 * One member's live view of one group at one epoch: its sending chain, a
 * receiving chain per other member (seeded by distribution — `setSenderKey`), and
 * the wire codec. Rotating the epoch = building a fresh `GroupSession`.
 */
export class GroupSession {
  readonly gid: Uint8Array
  readonly epoch: number
  private id: GroupId
  private groupSecret: Uint8Array
  private params: RvParams
  private send_: SendChain
  private receivers = new Map<string, SenderReceiver>()   // sender pub → chain
  private receiverOpts?: ReceiverOpts
  private members: Member[] = []
  private byId = new Map<string, Member>()                 // sender_id hex → member
  private senderIdCache = new Map<string, Uint8Array>()    // pub → sender_id
  private macKeyCache = new Map<string, Uint8Array>()      // pub → mk_ij
  private mySenderId!: Uint8Array

  private constructor(init: GroupInit) {
    this.id = init.id
    this.gid = init.gid
    this.epoch = init.epoch
    this.groupSecret = init.groupSecret.slice()
    this.params = init.params
    this.receiverOpts = init.receiverOpts
    this.send_ = init.mySendKey ? sendChainFrom(init.mySendKey) : newSendChain()
  }

  static async create(init: GroupInit): Promise<GroupSession> {
    const s = new GroupSession(init)
    s.mySenderId = await senderIdOf(init.id.pub)
    await s.setMembers(init.members)
    return s
  }

  /** Refresh the roster (sender_id index). Self is included; it is never a receiver. */
  async setMembers(members: Member[]): Promise<void> {
    this.members = members
    this.byId.clear()
    for (const m of members) {
      let sid = this.senderIdCache.get(m.pub)
      if (!sid) { sid = await senderIdOf(m.pub); this.senderIdCache.set(m.pub, sid) }
      this.byId.set(hex(sid), m)
    }
  }

  async topic(): Promise<string> { return groupTopicFromSecret(this.groupSecret, this.params) }

  /** My current sending key — this is what distribution hands to the other members. */
  mySenderKey(): Uint8Array { return this.send_.key.slice() }

  /** Seed a receiving chain for a member (from a SenderKeyDistribution). */
  setSenderKey(memberPub: string, chainKey: Uint8Array): void {
    if (memberPub === this.id.pub) return
    this.receivers.set(memberPub, new SenderReceiver(chainKey, this.receiverOpts))
  }
  hasSenderKey(memberPub: string): boolean { return this.receivers.has(memberPub) }

  /** Full chain state for persistence (§10): my send chain + every receiving
   *  chain. Raw bytes — the manager serializes. Skipped keys are dropped. */
  exportChains(): { send: { key: Uint8Array; n: number }; receivers: { pub: string; key: Uint8Array; n: number }[] } {
    const receivers = [...this.receivers.entries()].map(([pub, r]) => { const s = r.snapshot(); return { pub, key: s.key, n: s.n } })
    return { send: { key: this.send_.key.slice(), n: this.send_.n }, receivers }
  }
  /** Restore the chains produced by exportChains onto a freshly-created session. */
  importChains(state: { send: { key: Uint8Array; n: number }; receivers: { pub: string; key: Uint8Array; n: number }[] }): void {
    this.send_ = sendChainFrom(state.send.key)
    this.send_.n = state.send.n
    this.receivers.clear()
    for (const r of state.receivers) this.receivers.set(r.pub, SenderReceiver.from(r.key, r.n, this.receiverOpts))
  }

  private async macKeyFor(memberPub: string): Promise<Uint8Array> {
    let mk = this.macKeyCache.get(memberPub)
    if (!mk) {
      const member = this.members.find((m) => m.pub === memberPub)
      const ss = await this.id.ecdh(memberPub, member?.kid)
      mk = await msgMacKeyFromSecret(ss, this.gid, this.epoch)
      ss.fill(0)
      this.macKeyCache.set(memberPub, mk)
    }
    return mk
  }

  /** Seal a plaintext into a group-msg frame for broadcast on the topic. */
  async send(plaintext: Uint8Array): Promise<Uint8Array> {
    const ctr = this.send_.n
    const header = encodeHeader({ gid: this.gid, senderId: this.mySenderId, epoch: this.epoch, ctr })
    const { ct } = await seal(this.send_, header, plaintext)
    const recips: Uint8Array[] = []
    for (const m of this.members) {
      if (m.pub === this.id.pub) continue
      const mac = await tag(await this.macKeyFor(m.pub), header, ct)
      recips.push(concat(this.senderIdCache.get(m.pub)!, mac))
    }
    return concat(new Uint8Array([T_GMSG, VERSION]), header, new Uint8Array([recips.length]), ...recips, ct)
  }

  /**
   * Open a group-msg frame. Returns `{ from, pt }` or null (not for us, unknown
   * sender, no sender key yet, a forged MAC, tamper, or replay). Verifies OUR
   * per-recipient MAC before decrypting — an insider holding the sender's chain
   * could re-seal a body but cannot forge that MAC to us.
   */
  async receive(frame: Uint8Array): Promise<{ from: string; pt: Uint8Array } | null> {
    if (frame.length < 2 + HDR_LEN + 1 || frame[0] !== T_GMSG || frame[1] !== VERSION) return null
    let o = 2
    const headerBytes = frame.slice(o, o + HDR_LEN); o += HDR_LEN
    const h = decodeHeader(headerBytes)
    const macCount = frame[o]; o += 1
    if (o + macCount * REC_LEN > frame.length) return null
    const macs = new Map<string, Uint8Array>()
    for (let i = 0; i < macCount; i++) {
      macs.set(hex(frame.slice(o, o + 8)), frame.slice(o + 8, o + REC_LEN)); o += REC_LEN
    }
    const ct = frame.slice(o)

    const sender = this.byId.get(hex(h.senderId))
    if (!sender || sender.pub === this.id.pub) return null // unknown sender, or our own echo
    const mine = macs.get(hex(this.mySenderId))
    if (!mine) return null // not addressed to us
    if (!(await verify(await this.macKeyFor(sender.pub), headerBytes, ct, mine))) return null // forged / tampered
    const recv = this.receivers.get(sender.pub)
    if (!recv) return null // no sender key yet — distribution has not reached us
    const pt = await recv.open(h.ctr, headerBytes, ct)
    return pt ? { from: sender.pub, pt } : null
  }
}

// ---------------------------------------------------------------------------
// manager: all of my groups + the distribution glue
// ---------------------------------------------------------------------------

interface GroupRec { session: GroupSession; gkPub: Uint8Array; secret: Uint8Array; roster: Member[]; epoch: number; gkPriv?: Uint8Array }

/** A group serialized for the persistence cache (§10) — full state, base64 bytes. */
export interface GroupSnapshot {
  gid: string        // group_id
  gkPub: string      // GK_pub
  epoch: number
  secret: string     // group_secret (seeds the topic)
  roster: Member[]
  gkPriv?: string    // GK private half — present only for groups I admin (roster-MAC key); secret
  send: { key: string; n: number }                       // my sending chain
  receivers: { pub: string; key: string; n: number }[]   // every known member's receiving chain
}

/**
 * Holds every group I am in, and turns Sender-Key Distribution in/out. A group is
 * established from its shared material (`admit` — either self-generated by the
 * creator, or received in an SKD); each member then hands its own sending key to
 * the others (`skdFor` → send over 1:1 → `applySkd`). A newer epoch replaces the
 * session (fresh sender key); the same epoch keeps it (just fills sender keys).
 */
export class GroupManager {
  private id: GroupId
  private params: RvParams
  private recs = new Map<string, GroupRec>()

  constructor(id: GroupId, params: RvParams) { this.id = id; this.params = params }

  gidHexOf(gid: Uint8Array): string { return hex(gid) }
  session(gidHex: string): GroupSession | undefined { return this.recs.get(gidHex)?.session }
  groups(): string[] { return [...this.recs.keys()] }

  /** Create a group I own: I generate `group_secret`, take the roster, and get a
   *  fresh sending key. `gkPub` is the group identity key; as admin I also keep
   *  `gkPriv` so I can MAC the roster (per recipient, §8 roster auth). Returns the
   *  gid hex. Holding gkPriv is what makes this rec the admin's. */
  async createGroup(gkPub: Uint8Array, roster: Member[], gkPriv?: Uint8Array): Promise<string> {
    const gid = await groupIdFromGK(gkPub)
    await this.admit({ gid, gkPub, epoch: 0, secret: randomBytes(32), roster, gkPriv })
    return hex(gid)
  }

  /** Establish or update a group from its shared material. New group or a newer
   *  epoch → a fresh session (new sending key). Same epoch → keep the session
   *  (never reset my own chain), only refresh the roster. */
  async admit(m: { gid: Uint8Array; gkPub: Uint8Array; epoch: number; secret: Uint8Array; roster: Member[]; gkPriv?: Uint8Array }): Promise<GroupSession> {
    const gh = hex(m.gid)
    const cur = this.recs.get(gh)
    if (cur && cur.epoch >= m.epoch) {
      // Same-or-older epoch: NOT a roster change. The roster is the admin's,
      // fixed for this epoch — only a valid admin roster-MAC advances it (see
      // applySkd). Keep the session and the trusted roster; a member's sender key
      // is recorded by applySkd, not here.
      return cur.session
    }
    const session = await GroupSession.create({
      id: this.id, gid: m.gid, epoch: m.epoch, groupSecret: m.secret, members: m.roster, params: this.params,
    })
    // Preserve gkPriv across a rekey (admit with a newer epoch): the admin keeps
    // GK for the group's life. Members never have it, so they never become admin.
    this.recs.set(gh, { session, gkPub: m.gkPub, secret: m.secret.slice(), roster: m.roster, epoch: m.epoch, gkPriv: m.gkPriv ?? cur?.gkPriv })
    return session
  }

  /** Apply an SKD received from `from` over a 1:1 session: establish/update the
   *  group, then store `from`'s sending key. */
  async applySkd(from: string, skd: SkdFields): Promise<void> {
    const gid = unb64(skd.gid), gh = hex(gid)
    const cur = this.recs.get(gh)
    if (!cur || skd.epoch > cur.epoch) {
      // Advancing the epoch/roster is the ADMIN's authority. STRICT: require a
      // roster MAC the admin computed for ME — rk from ECDH(IK_me, GK_pub), which
      // equals the admin's ECDH(GK_priv, IK_me). No MAC, or one that does not
      // verify → reject (do not adopt the roster or the new topic). Only the admin
      // holds GK_priv, so no member can forge this to a third member.
      // Bind the group id to its GK: gid == SHA-256(GK_pub)[0:16]. Without this an
      // attacker could pair the real gid with a fake GK it holds the private half
      // of, MAC a forged roster with it, and have it verify — hijacking the group.
      if (!bytesEq(gid, await groupIdFromGK(unb64(skd.gkPub)))) throw new Error('group id does not match its GK — rejected')
      if (!skd.rmac) throw new Error('group SKD advances the epoch without a roster MAC — rejected')
      const ss = await this.id.ecdh(skd.gkPub)
      const rk = await rosterMacKeyFromSecret(ss, gid, skd.epoch)
      if (!(await verifyRosterMac(rk, skd.roster, unb64(skd.rmac)))) throw new Error('group roster MAC does not verify — rejected')
      const session = await this.admit({
        gid, gkPub: unb64(skd.gkPub), epoch: skd.epoch, secret: unb64(skd.secret), roster: skd.roster.map((pub) => ({ pub })),
      })
      session.setSenderKey(from, unb64(skd.chain))
    } else {
      // Same-or-older epoch: a member redistributing its own sending key. It does
      // NOT change the roster (admin authority), and we accept the key only from a
      // sender already in the admin-attested roster.
      if (cur.roster.some((m) => m.pub === from)) cur.session.setSenderKey(from, unb64(skd.chain))
    }
  }

  /**
   * Membership change (admin): bump the epoch, mint a NEW `group_secret` (→ a new
   * topic) and a fresh sending key, and set the new roster. On *remove* pass the
   * roster without the removed member and distribute only to those who remain — the
   * removed member never gets the new epoch, so it cannot derive the new topic
   * (new secret) or open new messages (new sender keys). On *add*, include the
   * newcomer. `admit` does the work (a newer epoch always replaces the session).
   */
  async rekey(gidHex: string, newRoster: Member[]): Promise<void> {
    const rec = this.recs.get(gidHex)
    if (!rec) return
    await this.admit({ gid: rec.session.gid, gkPub: rec.gkPub, epoch: rec.epoch + 1, secret: randomBytes(32), roster: newRoster })
  }

  /** Build the SKD to hand to another member. The body is the same for everyone
   *  (the 1:1 session authenticates delivery); when I am the admin (I hold gkPriv)
   *  and a recipient is named, I also attach that recipient's roster MAC so they
   *  can verify the roster is admin-attested. Null if I am not in that group. */
  async skdFor(gidHex: string, forPub?: string): Promise<SkdFields | null> {
    const rec = this.recs.get(gidHex)
    if (!rec) return null
    const skd: SkdFields = {
      gid: b64(rec.session.gid), gkPub: b64(rec.gkPub), epoch: rec.epoch,
      secret: b64(rec.secret), chain: b64(rec.session.mySenderKey()),
      roster: rec.roster.map((m) => m.pub),
    }
    if (rec.gkPriv && forPub) {
      const gk = await x25519FromPriv(rec.gkPriv)
      const ss = await gk.dh(unb64(forPub))
      const rk = await rosterMacKeyFromSecret(ss, rec.session.gid, rec.epoch)
      skd.rmac = b64(await rosterMac(rk, skd.roster))
    }
    return skd
  }

  /** Every group serialized for the persistence cache (§10) — full state, including
   *  the other members' receiving keys. Synchronous, so it is safe to call from a
   *  pagehide / visibility-hidden flush. The caller stores the JSON (plaintext in
   *  v1; §10-encrypted later — see the web app's persistGroups). */
  snapshot(): GroupSnapshot[] {
    const out: GroupSnapshot[] = []
    for (const rec of this.recs.values()) {
      const c = rec.session.exportChains()
      out.push({
        gid: b64(rec.session.gid), gkPub: b64(rec.gkPub), epoch: rec.epoch, secret: b64(rec.secret),
        roster: rec.roster.map((m) => ({ pub: m.pub, kid: m.kid })),
        gkPriv: rec.gkPriv ? b64(rec.gkPriv) : undefined, // admin only — the roster-MAC key material (§10-encrypted by the caller)
        send: { key: b64(c.send.key), n: c.send.n },
        receivers: c.receivers.map((r) => ({ pub: r.pub, key: b64(r.key), n: r.n })),
      })
    }
    return out
  }

  /** Rebuild every group from a snapshot: admit the material, then restore the
   *  chains (my send position + each member's receiving position). Returns the gid
   *  hexes restored, so the app can re-open (re-subscribe) each. */
  async restore(snaps: GroupSnapshot[]): Promise<string[]> {
    const gids: string[] = []
    for (const s of snaps) {
      const gid = unb64(s.gid)
      const session = await this.admit({ gid, gkPub: unb64(s.gkPub), epoch: s.epoch, secret: unb64(s.secret), roster: s.roster, gkPriv: s.gkPriv ? unb64(s.gkPriv) : undefined })
      session.importChains({
        send: { key: unb64(s.send.key), n: s.send.n },
        receivers: s.receivers.map((r) => ({ pub: r.pub, key: unb64(r.key), n: r.n })),
      })
      gids.push(hex(gid))
    }
    return gids
  }
}
