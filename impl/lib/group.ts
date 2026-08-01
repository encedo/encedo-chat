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

import { subtle, hkdfBits, sha256, unb64, concat } from './wc.ts'
import type { RvParams } from './rendezvous.ts'
import { groupTopicFromSecret } from './rendezvous.ts'
import { seal, sendChainFrom, newSendChain, SenderReceiver, tag, verify, type SendChain, type ReceiverOpts } from './senderkey.ts'

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
