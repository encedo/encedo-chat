/**
 * core.ts — headless core facade. ONE API that both front-ends (web GUI + CLI)
 * consume, so the UIs stay pure UI. Consolidates what used to be duplicated in
 * app.ts / chat-session.ts / bob / alice / ec:
 *   - Identity (HEM or software), the ECDH holder,
 *   - deriveRoom: ss = ECDH(IK_a, IK_b) → topic + interim keys,
 *   - Conversation: transport (peer + relay dial) + join + the typing/away/leave
 *     state machine, behind sendText / noteActivity / leave.
 *
 * The message crypto (Session), rendezvous, and transport layers are unchanged;
 * this is orchestration on top of them. EH-2 / the §13 data plane will slot in
 * here (openConversation) without touching a single UI.
 */

import { topicFromSecret, announceMacKey, todayUTC, rotationOffsetSec, type RvParams } from './rendezvous.ts'
import { joinChat, type RoomKeys, type ChatOpts, type Eh2Options } from './room.ts'
import type { SkdFields, FileMeta } from './envelope.ts'
import type { QuoteRef } from './quote.ts'
import { dhFromEcdh } from './x25519.ts'
import { createPeer, dial } from '../net/peer.ts'
import { createMqttPeer } from '../net/mqtt-node.ts'
import { attachWebRTC, type WebRTCPlane } from '../net/webrtc-plane.ts'
import { watchSelfSessionRotating, type SelfWatch } from './selfsession.ts'
import { watchPresenceRotating, rendezvousDay, type PresenceWatch } from './presence.ts'
import { GroupManager, type AdminGk, type GkBackend } from './group.ts'
import {
  SELF_PREFIX, buildPeerDescr, parsePeerDescr, parseSelfDescr, peerSearchPrefix, peerLabel, hemKid, descrText,
} from './descr.ts'
import { MARKER_SEARCH } from './gmarker.ts'
import { joinGroup, type GroupRoom, type GroupRoomOpts } from './grouproom.ts'
import { b64, unb64 } from './wc.ts'

export interface Identity {
  handle: string
  pub: string // base64
  ecdh(peerPubB64: string, peerKid?: string): Promise<Uint8Array> // raw 32-byte shared secret; peerKid → in-HSM two-KID ECDH
}
export type RoomParams = RvParams
/** A chat peer: raw pubkey, plus an in-HSM `kid` when it's a HEM (imported) contact. */
export interface Peer { pub: string; kid?: string }

/** Build an Identity from an already-authenticated HEM session (browser-safe — no fs). */
export function hemIdentityFrom(hem: any, kid: string, handle: string, pub: string): Identity {
  return {
    handle,
    pub,
    async ecdh(peerPubB64: string, peerKid?: string) {
      const t = await hem.authorizePassword(null, `keymgmt:use:${kid}`) // cached derived key → no re-prompt
      // HEM contact (imported → has a kid): two-KID ECDH, both operands in-device.
      // Local / one-off contact (no kid): raw peer pubkey.
      return peerKid ? hem.ecdhKid(t, kid, peerKid) : hem.ecdh(t, kid, peerPubB64)
    },
  }
}

/**
 * Admin group keys minted INSIDE a HEM (§8, bucket A).
 *
 * What changes versus bucket B: `GK_priv` is generated in the HSM and never
 * exists here, the roster-MAC ECDH runs in the device, and the §10 snapshot
 * stores a KID instead of the scalar — so a stolen cache yields a reference
 * that is useless without the HEM, where before it yielded the key itself.
 *
 * HSM traffic is deliberately small and bounded:
 *   - group creation: `createKeyPair` + one `getPubKey` (createKeyPair returns
 *     only a kid). Twice per group, ever.
 *   - roster MAC: one `ecdh` per member, memoised by the group engine and
 *     epoch-independent, so a membership change costs one call per NEW member
 *     and nothing at all for everyone already there.
 * The tokens are scoped per KID as the HEM requires; `authorizePassword(null,…)`
 * reuses the cached password-derived key, so this is not a re-prompt per call.
 */
export function hemGkBackend(hem: any, adminKid?: string): GkBackend {
  const use = (kid: string) => hem.authorizePassword(null, `keymgmt:use:${kid}`)
  const readPub = pubKeyReader(hem)
  const asB64 = (s: string) => b64(new TextEncoder().encode(s)) // DESCRs go to the HEM base64'd
  const fromKid = (kid: string): AdminGk => ({
    kid,
    async dh(peerPub: Uint8Array) { return new Uint8Array(await hem.ecdh(await use(kid), kid, b64(peerPub))) },
  })
  return {
    adminKid,
    fromKid,
    async create(label: string, descr: string) {
      const gen = await hem.authorizePassword(null, 'keymgmt:gen')
      const { kid } = await hem.createKeyPair(gen, label, 'CURVE25519', asB64(descr))
      const { pubkey } = await hem.getPubKey(await use(kid), kid)
      return { gk: fromKid(kid), pub: unb64(pubkey) }
    },
    // The roster blob is stale the moment the roster moves, and a stale blob
    // reconstructs the OLD member set on a recovering device. One call per
    // membership change — not per member.
    async setMarker(kid: string, label: string, descr: string) {
      await hem.updateKey(await hem.authorizePassword(null, 'keymgmt:upd'), kid, label, asB64(descr))
    },
    // Dissolving a group takes its marker with it: the portable group list is
    // exactly the set of GK entries, so leaving one behind would keep listing a
    // group nobody can rejoin.
    async destroy(kid: string) {
      await hem.deleteKey(await hem.authorizePassword(null, 'keymgmt:del'), kid)
    },
    // A MEMBER's half of the same story: importing GK_pub is what makes being in
    // a group survive this browser. The device stores a public key and a marker
    // and nothing else — `group_secret` and the sender keys stay client-side and
    // forward-secret, so what this recovers is the group's existence, not a word
    // anyone said in it.
    async importPub(pub: Uint8Array, label: string, descr: string) {
      const imp = await hem.authorizePassword(null, 'keymgmt:imp')
      const r = await hem.importPublicKey(imp, label, 'CURVE25519', pub, asB64(descr))
      // Older firmware answers an import with nothing useful; the KID is derived
      // from the key's content, so it is the same value either way.
      return String(r?.kid ?? await hemKid(pub))
    },
    // The portable group list. `MARKER_SEARCH` matches every generation, so a
    // marker written by an older build still turns up here — it simply fails to
    // parse and is skipped, which is what a generation digit is for.
    // One getPubKey per group, as the contact book pays for a contact: GK_pub is
    // what yields the group id, and search does not return public keys yet.
    async listMarkers() {
      const listTok = await hem.authorizePassword(null, 'keymgmt:list')
      const keys: any[] = await hem.searchKeys(listTok, MARKER_SEARCH)
      const out: Array<{ kid: string; pub: Uint8Array; descr: string }> = []
      for (const k of keys) {
        const text = descrText(k.description)
        if (!text) continue
        try {
          out.push({ kid: String(k.kid), pub: unb64(await readPub(k.kid)), descr: text })
        } catch { /* a key we cannot read is not a group we can rejoin */ }
      }
      return out
    },
  }
}

/**
 * Software identity in the browser (dev / no-HEM): a WebCrypto X25519 keypair
 * persisted via injected load/save (per-tab sessionStorage for testing). Same
 * Identity contract; ECDH via crypto.subtle X25519. Not HSM-anchored — for
 * testing and users without a HEM. Interoperates with HEM identities (X25519).
 */
export async function browserSoftwareIdentity(handleHint: string, load: () => string | null, save: (v: string) => void): Promise<Identity> {
  const subtle = globalThis.crypto.subtle
  let handle: string, pub: string, privJwk: JsonWebKey
  const saved = load()
  if (saved) {
    const d = JSON.parse(saved); handle = d.handle; pub = d.pub; privJwk = d.priv
  } else {
    const kp = (await subtle.generateKey({ name: 'X25519' }, true, ['deriveBits'])) as CryptoKeyPair
    pub = b64(new Uint8Array(await subtle.exportKey('raw', kp.publicKey)))
    privJwk = await subtle.exportKey('jwk', kp.privateKey)
    handle = handleHint
    save(JSON.stringify({ handle, pub, priv: privJwk }))
  }
  const priv = await subtle.importKey('jwk', privJwk, { name: 'X25519' }, false, ['deriveBits'])
  return {
    handle,
    pub,
    async ecdh(peerPubB64: string) {
      const peerPub = await subtle.importKey('raw', unb64(peerPubB64), { name: 'X25519' }, false, [])
      return new Uint8Array(await subtle.deriveBits({ name: 'X25519', public: peerPub }, priv, 256))
    },
  }
}

// ---- contact book (peer pubkeys) ----------------------------------------
export interface Contact { name: string; pub: string; kid?: string; source: 'hem' | 'local' }
export interface ContactBook {
  list(): Promise<Contact[]>
  add(name: string, pubB64: string): Promise<void>
  remove(c: Contact): Promise<void>
  /**
   * Change a contact's display name, keeping the key it names.
   *
   * Not add()+remove(): on a HEM that would delete and re-import the key, and
   * the KID is not decoration — it is the roster hint in a group marker (§8)
   * and the operand of a two-KID ECDH. Rewriting the DESCR keeps the identity
   * and costs one call instead of two.
   */
  rename(c: Contact, name: string): Promise<void>
}


/**
 * A token that can read ANY public key, instead of one per key.
 *
 * `getPubKey` is documented as needing `keymgmt:use:<KID>`, and that scope is
 * per-key: loading ten contacts meant ten authorisations, each of them two round
 * trips (a challenge, then the signed assertion) at about 2.5 s. In a measured
 * sign-in the token requests were 43% of all device time, and two of the four
 * existed only to read a public key.
 *
 * `keymgmt:get` is KID-independent — one token, every public key. Firmware that
 * does not know it refuses, so the first attempt decides and the answer is
 * remembered for the session: a device that wants the narrow scope pays what it
 * always paid, and one that does not stops paying per contact.
 *
 * Reading a PUBLIC key is the one operation where a broad scope costs nothing to
 * give away: what it authorises is handing out material that is public by
 * definition. The narrow scopes that matter — `use:<KID>` for an ECDH, `imp`,
 * `del` — are untouched.
 */
export function pubKeyReader(hem: any): (kid: string) => Promise<string> {
  let broad: boolean | null = null // null = not yet known for this device
  return async (kid: string) => {
    if (broad !== false) {
      try {
        const tok = await hem.authorizePassword(null, 'keymgmt:get')
        const { pubkey } = await hem.getPubKey(tok, kid)
        broad = true
        return pubkey
      } catch (e: any) {
        if (broad === true) throw e // it worked before; this is a real failure
        broad = false               // the device wants the per-key scope
      }
    }
    const tok = await hem.authorizePassword(null, `keymgmt:use:${kid}`)
    const { pubkey } = await hem.getPubKey(tok, kid)
    return pubkey
  }
}

/**
 * The contact's key is already in this HEM, under a DIFFERENT identity.
 *
 * A device refuses to hold one public key twice whatever DESCR it sits under —
 * `KID` indexes the key's *content* — so a contact belongs to exactly one
 * identity per device (§4 Proposal). Raised BEFORE the device is touched, so the
 * app can say who holds them instead of surfacing an import failure.
 */
export class ContactHeldByOtherIdentity extends Error {
  // Fields written out rather than declared as constructor parameters: Node
  // strips types, it does not compile them, and a parameter property is syntax
  // it refuses outright.
  readonly ownerKid: string
  readonly ownerHandle: string | null
  readonly contactKid: string
  constructor(ownerKid: string, ownerHandle: string | null, contactKid: string) {
    super(`this key is already a contact of ${ownerHandle ?? ownerKid.slice(0, 8)}`)
    this.name = 'ContactHeldByOtherIdentity'
    this.ownerKid = ownerKid
    this.ownerHandle = ownerHandle
    this.contactKid = contactKid
  }
}

const asB64 = (s: string) => b64(new TextEncoder().encode(s)) // DESCRs go to the HEM base64'd

/**
 * HEM-backed contact book for ONE identity: peers live in the HSM as CURVE25519
 * public keys under `ETSEIC:peer1,<ownerKid>,<name>` — HSM-anchored + portable
 * (same HEM elsewhere = same contacts), and scoped, because `key_search` matches
 * an anchored prefix and `ownerKid` precedes the name.
 *
 * `ownerKid` is the KID of this identity's own IK entry: an id that already
 * exists, is derived from the key's content, and therefore needs neither storage
 * nor a migration to be portable.
 *
 * The pubkey isn't returned by search, so it's fetched per kid.
 */
export function hemContactBook(hem: any, ownerKid: string): ContactBook {
  const readPub = pubKeyReader(hem)
  /** Who owns the key with this KID, if anyone — one broad search, add path only. */
  const findOwner = async (contactKid: string): Promise<{ ownerKid: string } | null> => {
    const listTok = await hem.authorizePassword(null, 'keymgmt:list')
    const all: any[] = await hem.searchKeys(listTok, peerSearchPrefix())
    const hit = all.find((k) => String(k.kid).toLowerCase() === contactKid)
    const owner = hit && parsePeerDescr(hit.description)?.ownerKid
    return owner ? { ownerKid: owner } : null
  }
  /** The handle of an identity on this device, for the message. Null if it has none. */
  const handleOf = async (kid: string): Promise<string | null> => {
    try {
      const listTok = await hem.authorizePassword(null, 'keymgmt:list')
      const selves: any[] = await hem.searchKeys(listTok, SELF_PREFIX)
      const me = selves.find((k) => String(k.kid).toLowerCase() === kid)
      return me ? parseSelfDescr(me.description)?.handle ?? null : null
    } catch { return null }
  }

  return {
    async list() {
      const listTok = await hem.authorizePassword(null, 'keymgmt:list')
      const keys: any[] = await hem.searchKeys(listTok, peerSearchPrefix(ownerKid))
      const out: Contact[] = []
      // one getPubKey per contact — current FW's api/search doesn't return pubkeys.
      // TODO(newer FW): api/search returns the public keys directly → drop this loop
      // and read `pub` straight off the search entry (one call for the whole list).
      for (const k of keys) {
        out.push({ name: parsePeerDescr(k.description)?.name || '(?)', pub: await readPub(k.kid), kid: k.kid, source: 'hem' })
      }
      return out
    },
    async add(name: string, pubB64: string) {
      const descr = buildPeerDescr(ownerKid, name)
      if (!descr) throw new Error('add: this identity has no usable KID')
      // The collision is predictable without touching the device, because the KID
      // is SHA-1 of the very public key we are holding. Checking first turns a
      // firmware error into a sentence about which identity already has them.
      const contactKid = await hemKid(unb64(pubB64))
      const held = await findOwner(contactKid)
      if (held && held.ownerKid !== ownerKid) {
        throw new ContactHeldByOtherIdentity(held.ownerKid, await handleOf(held.ownerKid), contactKid)
      }
      const impTok = await hem.authorizePassword(null, 'keymgmt:imp')
      await hem.importPublicKey(impTok, peerLabel(name), 'CURVE25519', unb64(pubB64), asB64(descr))
    },
    async remove(c: Contact) {
      if (!c.kid) return
      const delTok = await hem.authorizePassword(null, 'keymgmt:del')
      await hem.deleteKey(delTok, c.kid)
    },
    async rename(c: Contact, name: string) {
      if (!c.kid) throw new Error('rename: this contact has no HEM key')
      const descr = buildPeerDescr(ownerKid, name)
      if (!descr) throw new Error('rename: this identity has no usable KID')
      const updTok = await hem.authorizePassword(null, 'keymgmt:upd')
      // Both fields, always: the label is a caption the device shows and the
      // DESCR is what the client reads, and a rename that moved only one of them
      // would leave the two disagreeing about the same contact.
      await hem.updateKey(updTok, c.kid, peerLabel(name), asB64(descr))
    },
  }
}

/**
 * Local contact book (browser-only / one-off): peers kept in injected
 * load/save storage (e.g. localStorage). Nothing leaves the device, nothing is
 * written to the HEM. ECDH still works — it only needs the raw peer pubkey.
 */
export function localContactBook(load: () => Array<{ name: string; pub: string }>, save: (list: Array<{ name: string; pub: string }>) => void): ContactBook {
  return {
    async list() { return load().map((c) => ({ name: c.name, pub: c.pub, source: 'local' as const })) },
    async add(name: string, pubB64: string) {
      const l = load().filter((c) => c.name !== name)
      l.push({ name, pub: pubB64 })
      save(l)
    },
    async remove(c: Contact) { save(load().filter((x) => x.name !== c.name)) },
    async rename(c: Contact, name: string) {
      // Keyed by pub, not by name: renaming to a name that already exists must
      // move THIS contact, not silently merge it with the other one.
      save(load().map((x) => (x.pub === c.pub ? { ...x, name } : x)))
    },
  }
}

export interface ContactManager {
  list(): Promise<Contact[]>
  add(name: string, pubB64: string, persistent: boolean): Promise<void>
  remove(c: Contact): Promise<void>
  rename(c: Contact, name: string): Promise<void>
}

/**
 * Merge a permanent (HEM) and a local book into one: `list()` concatenates both,
 * `add(…, persistent)` routes (HEM vs local), `remove(c)` routes by `c.source`.
 */
export function mergedContactBook(hem: ContactBook, local: ContactBook): ContactManager {
  return {
    async list() { return [...(await hem.list()), ...(await local.list())] },
    add(name: string, pubB64: string, persistent: boolean) { return (persistent ? hem : local).add(name, pubB64) },
    remove(c: Contact) { return (c.source === 'hem' ? hem : local).remove(c) },
    rename(c: Contact, name: string) { return (c.source === 'hem' ? hem : local).rename(c, name) },
  }
}

/** A ContactManager with only a local backend (software identities have no HEM). */
export function localOnlyManager(local: ContactBook): ContactManager {
  return {
    list: () => local.list(),
    add: (name: string, pubB64: string, _persistent: boolean) => local.add(name, pubB64),
    remove: (c: Contact) => local.remove(c),
    rename: (c: Contact, name: string) => local.rename(c, name),
  }
}

/**
 * Derive the day's room for a pair: the topic (§5) plus the content keys.
 *
 * Rendezvous and content use the pair secret differently: topic and Announce MAC
 * key come from `ss = ECDH(IK_a, IK_b)`, while content is sealed by a per-peer
 * EH-2 handshake + ratchet negotiated inside the room (§6–7). So `ss` is used
 * ONLY for rendezvous; the message keys never derive from it.
 */
export async function deriveRoom(
  id: Identity,
  peer: Peer,
  p: RoomParams,
  eh2: { onState?: Eh2Options['onState']; ratchet?: Eh2Options['ratchet']; ss?: Uint8Array } = {},
): Promise<{ topic: string; keys: RoomKeys }> {
  // `ss` may be supplied by a caller that already holds it: on a HEM every one
  // of these is a device round trip of one to two seconds, and the same pair
  // secret is wanted by the presence watch, the rotation offset and the room.
  const ss = eh2.ss ?? await id.ecdh(peer.pub, peer.kid)
  const topic = await topicFromSecret(ss, p)
  const macKey = await announceMacKey(ss, p)
  // The EH-2 DHs run against the peer's EPHEMERAL keys, so no contact `kid`
  // here — just our IK against raw public keys (HEM raw ecdh, §4.3).
  const ik = dhFromEcdh(id.pub, (peerPubB64) => id.ecdh(peerPubB64))
  return { topic, keys: { macKey, eh2: { ik, peerIkPub: unb64(peer.pub), ...eh2 } } }
}

/**
 * The rendezvous half of a pair room, without the EH-2 keys — all the light
 * presence layer needs (`lib/presence.ts`): the pair topic to subscribe to and
 * the Announce MAC key. One `ecdh`, no handshake material.
 */
export async function derivePresence(id: Identity, peer: Peer, p: RoomParams): Promise<{ topic: string; macKey: CryptoKey }> {
  return presenceFromSecret(await id.ecdh(peer.pub, peer.kid), p)
}

/**
 * The presence topic + MAC key from an already-computed pair secret. `ss` is
 * date-independent (only the HKDF `info` carries the date), so a rotating watch
 * computes `ss` once and calls this per day — never a second `ecdh` (an HSM
 * round-trip for a HEM identity).
 */
export async function presenceFromSecret(ss: Uint8Array, p: RoomParams): Promise<{ topic: string; macKey: CryptoKey }> {
  return { topic: await topicFromSecret(ss, p), macKey: await announceMacKey(ss, p) }
}

/**
 * The self-topic (§5.2): the same derivation as a pair topic, with ourselves as
 * the peer. `ss = ECDH(IK, IK_pub)` is computable only by the holder of that IK,
 * so the topic and its Announce key are ours alone — which is what makes
 * anything valid on it another window of *us* (§9.1).
 */
export async function deriveSelfRoom(id: Identity, p: RoomParams): Promise<{ topic: string; macKey: CryptoKey }> {
  const ss = await id.ecdh(id.pub)
  return { topic: await topicFromSecret(ss, p), macKey: await announceMacKey(ss, p) }
}

const TYPING_STOP_MS = 4_000 // stop "typing" after this idle gap
const AWAY_MS = 60_000 // go "away" after this much no activity
const FLUSH_MS = 250 // let the leave reach the relay before teardown

export interface OpenOpts extends ChatOpts {
  relay: string
  /** See `SessionOpts.relays` — ordered relay candidates for failover (libp2p). */
  relays?: string[]
  /** See `SessionOpts` — the fall-back transport, chosen per session. */
  transport?: 'libp2p' | 'mqtt'
  broker?: string
  params?: RoomParams
  webrtc?: boolean // enable the WebRTC direct data plane (browser only)
  /** STUN servers for the direct attempt. Derived from the node list by the
   *  front-end (`lib/ice.ts`) — a node runs STUN as part of being a node — so
   *  core does not know them and must not invent them. Absent or empty means
   *  host candidates only, which is right for a LAN pair and for `?stun=0`. */
  iceServers?: { urls: string }[]
  onWebrtcState?: (s: string) => void // WebRTC conn/ICE state (for a UI badge)
  /** EH-2 handshake progress per peer (for a UI badge). */
  onSecurity?: Eh2Options['onState']
  /** Narration for a UI console (the engine never writes to one itself). */
  onLog?: ChatOpts['onLog']
  /** Delivery confirmations for the message status in the UI. */
  onDelivered?: ChatOpts['onDelivered']
  onUndelivered?: ChatOpts['onUndelivered']
  onLateDelivered?: ChatOpts['onLateDelivered']
  /**
   * Our own transport, as opposed to the peer's presence. `offline` means this
   * client currently has no way to reach the relay at all — a distinction the UI
   * had no way to draw, so a frozen laptop and a peer who left looked identical.
   */
  onLink?: (state: LinkState) => void
  /** Someone in the room is not this contact — usually a second tab on the same identity. */
  onForeign?: ChatOpts['onForeign']
  /**
   * Another window of THIS identity took the session over (§9.1). The transport
   * is already down and the ratchets are gone by the time this fires; the UI
   * should clear what it is showing and say where the session went (§9.2).
   * Omit it and the self-topic watch is not started at all.
   */
  onSessionTakenOver?: (byPeer: string) => void
}
export type LinkState = 'online' | 'reconnecting' | 'offline'

/** A read-only snapshot of the transport, for the Network tab. */
export interface NetStatus {
  transport: 'libp2p' | 'mqtt'
  relay: string      // relay multiaddr (libp2p) or broker url (mqtt)
  self: string       // our ephemeral PeerId
  link: LinkState
  connected: boolean // at least one live connection
  peers: number      // live connections
  topics: string[]   // topics we are subscribed to (pair + self + groups)
}
export interface Conversation {
  peerId: string
  topic: string
  /** This pair's rotation offset in seconds-of-day (§5.4): the topic rotates at
   *  `UTC-midnight + rotationOffsetSec`, so the UI can show the pair's real next
   *  rotation instead of a global midnight. Equals `forcedRotationSec` when set.
   *  Optional because `openRoom` does not know it — `session.open` fills it in. */
  rotationOffsetSec?: number
  sendText(body: string, re?: QuoteRef): string // returns the sent message id (for reactions/replies)
  /** Send a message marked undelivered again, keeping its id. False = nothing to resend. */
  resend(id: string): boolean
  sendReaction(toId: string, emoji: string): void
  /** Replace the text of a message we sent (1:1 only, `lib/edits.ts`). Returns
   *  the correction's own id — delivery is tracked under it, so the UI can show
   *  whether the other side actually got it. */
  sendEdit(toId: string, body: string): string
  /** Ask for attention now. Not queued, not re-sent, not acknowledged. */
  sendKnock(): void
  /** Hand a group's Sender-Key Distribution to this contact over the ratchet (§8). */
  sendGroupSkd(skd: SkdFields): void
  /** Ask this contact to hand ITS sender key for a group over again (§8 repair) —
   *  we hold none and cannot derive one. `gid` is base64, as in the SKD itself. */
  sendGroupSkdReq(gid: string, epoch: number): void
  /** Send a file's metadata — CID, key, manifest. The bytes were encrypted and
   *  uploaded before this; the store never sees any of these fields. */
  sendFile(f: FileMeta): string
  noteActivity(): void // UI calls on user input → drives "typing" + resets "away"
  noteAway(): void // UI calls on blur/tab-hidden → "away" now
  noteBack(): void // UI calls when the window comes back into view — "I'm back" without pretending to type
  refresh(): void | Promise<void> // UI calls when the tab becomes visible again (throttled/frozen)
  who(): string[]
  secured(): string[] // peers with a live EH-2 ratchet (empty in interim mode)
  leave(): Promise<void> // presence:leave last-will + clean transport stop
}

/**
 * A client session: ONE transport, many rooms.
 *
 * Everything that is per-CLIENT rather than per-conversation lives here — the
 * libp2p node, the relay connection and its health, and the §9.1 self-topic
 * watch. Rooms are opened on top of it.
 *
 * That split is not tidiness. The previous shape built a whole node and a whole
 * relay connection *inside* `openConversation`, which was invisible while the UI
 * only ever held one chat: twenty contacts open at once would have meant twenty
 * nodes and twenty WebSockets to the same relay, for twenty topics that one
 * connection carries happily. It also duplicated the takeover watch per room,
 * when "one active session per identity" is by definition a per-identity thing.
 */
export interface ClientSession {
  /** Our ephemeral PeerId for this session. */
  readonly self: string
  /** Open a room with one contact on this session's transport. */
  open(peer: Peer, opts: RoomOpts): Promise<Conversation>
  /**
   * Start the LIGHT presence layer for a set of contacts: a subscribe+announce
   * watch each, so they can see us online and we them, with no handshake. A
   * contact is upgraded to a full conversation by `open`, or automatically when
   * their EH-2 frame arrives (`onWantsConversation` — the app opens the room).
   */
  watchContacts(contacts: Peer[], handlers: {
    onOnline?: (p: Peer) => void
    onOffline?: (p: Peer) => void
    onWantsConversation?: (p: Peer) => void
  }): Promise<void>
  /** Drop one contact's presence watch (e.g. it was removed). */
  unwatch(pub: string): void
  /** This identity's group manager (Sender Keys, §8) — createGroup / applySkd /
   *  skdFor / rekey. Incoming SKDs on any 1:1 room are applied to it automatically. */
  readonly groups: GroupManager
  /** Join an established group's topic (broadcast + dispatch). The group must
   *  already exist in `groups` (created here, or admitted from a received SKD). */
  openGroup(gidHex: string, handlers: GroupRoomOpts): Promise<GroupRoom>
  /** The tab came back: re-dial if needed, then wake every open room. */
  refresh(): Promise<void>
  /**
   * The platform says the network went away or came back (the browser's
   * `offline`/`online` events). Worth wiring: it is immediate and certain,
   * where everything else here has to infer it from silence — and a socket
   * that survives a Wi-Fi drop as a zombie infers it very slowly. Coming back
   * forces a hang-up and a fresh dial, because that zombie is still there.
   */
  setOffline(offline: boolean): void
  /**
   * Replace the failover candidate list on a LIVE session (libp2p only) — the
   * node editor is reachable after login, not just on the way in.
   *
   * A running connection is not torn down for a reorder: the new order simply
   * decides the next sweep, so preferring a different primary costs nothing
   * until something reconnects anyway. The exception is the node we are
   * actually on being dropped from the list — staying on a node the user just
   * removed is the one outcome that would make the editor a lie — so that case
   * hangs up and re-dials immediately.
   */
  setRelays(list: string[]): void
  /** A read-only transport snapshot for the Network tab (relay, link, topics…). */
  netStatus(): NetStatus
  /** Stop every room and the transport. */
  close(): Promise<void>
}

export interface SessionOpts {
  /** libp2p relay multiaddr — ignored when `transport` is `'mqtt'`. */
  relay: string
  /**
   * Ordered relay candidates for failover (libp2p only). When set, every dial —
   * the first one and every re-dial — sweeps this list from the top and the
   * first node that connects wins, so an unreachable or hung node falls through
   * to the next. Sweeping from the top means the primary (index 0) is preferred:
   * once it recovers, the next re-dial returns to it. `relay` stays the
   * single-node shorthand and the fallback when this is empty. Because the
   * relays are meshed, failing over does NOT partition users (a client on the
   * fallback still reaches everyone), which is what makes this safe.
   */
  relays?: string[]
  /**
   * Where admin group keys are minted (§8 GK). `hemGkBackend(hem)` puts GK_priv
   * in the HSM; omitted, groups fall back to a software scalar. The front-end
   * decides, because only it knows whether this identity has a HEM behind it.
   */
  gkBackend?: GkBackend
  /**
   * Which transport carries rendezvous, presence and signalling.
   *
   * `libp2p` (default) is the main one. `mqtt` is the **fall-back**: same
   * engine, same crypto, a broker instead of a GossipSub mesh — see the MQTT
   * section in README.md for what that costs and what it buys.
   */
  transport?: 'libp2p' | 'mqtt'
  /** Broker URL for `transport: 'mqtt'` (`wss://host/mqtt`, or `mqtt://host:1883` in Node). */
  broker?: string
  params?: RoomParams
  /**
   * Force every pair to rotate its topic at this second-of-day (UTC) instead of
   * the per-pair `rotationOffsetSec` (§5.4). For testing the rollover on demand:
   * both ends set the same value (web `?rot=<hour>`) so they share a known
   * instant. Undefined = the real per-pair offset algorithm (the default).
   */
  forcedRotationSec?: number
  onLog?: ChatOpts['onLog']
  /** A group Sender-Key Distribution arrived over some 1:1 room (§8). It is already
   *  applied to `session.groups`; this lets the app react (e.g. surface the group). */
  onGroupSkd?: ChatOpts['onGroupSkd']
  /** A contact cannot open our group frames and asks for our sender key again.
   *  Unlike an SKD there is nothing for core to apply — answering means deciding
   *  whether they are in that group, which is the app's roster to read. `from` is
   *  the sender's IK pub, as for `onGroupSkd` and for the same reason. */
  onGroupSkdReq?: ChatOpts['onGroupSkdReq']
  /** The pair secret, when the caller already holds it — see `deriveRoom`. */
  ss?: Uint8Array
  /** Our own transport state — see `LinkState`. */
  onLink?: (state: LinkState) => void
  /**
   * The active relay changed — a failover to a fallback node, or a return to the
   * preferred one. Carries the new relay multiaddr. Lets the app note it (toast,
   * repaint the Network tab). Not fired when the first dial lands on the primary.
   */
  onRelay?: (addr: string) => void
  /**
   * Another window of THIS identity appeared, so both stand down (§9.1). By the
   * time this fires the transport is gone and every room is stopped; the UI
   * should clear what it shows. Omit it and the self-topic watch is not started.
   */
  onSessionTakenOver?: (byPeer: string) => void
}

/** Per-room options: everything in OpenOpts that is not about the transport. */
export type RoomOpts = Omit<OpenOpts, 'relay' | 'params' | 'onLink' | 'onSessionTakenOver'>

const REDIAL_BACKOFF = [1_000, 2_000, 5_000, 10_000, 20_000, 30_000]
const DIAL_TIMEOUT_MS = 8_000

/**
 * Try each relay candidate in order; the first that connects wins and its addr
 * is returned. A per-dial timeout (an AbortSignal per candidate) means a node
 * that hangs rather than fast-fails — exactly the "operation was aborted"
 * behaviour a blocked path shows — falls through to the next instead of
 * stalling the whole sweep. Throws the last error if none connect. Pure over an
 * injected `dialOne`, so the failover order and time-out fall-through are unit
 * tested without a real transport.
 */
export async function failoverDial(
  candidates: string[],
  dialOne: (addr: string, signal: AbortSignal) => Promise<void>,
  timeoutMs: number = DIAL_TIMEOUT_MS,
): Promise<string> {
  let lastErr: unknown
  for (const addr of candidates) {
    try { await dialOne(addr, AbortSignal.timeout(timeoutMs)); return addr }
    catch (e) { lastErr = e }
  }
  throw lastErr ?? new Error('failoverDial: no relay candidates')
}

export async function startSession(id: Identity, opts: SessionOpts): Promise<ClientSession> {
  const log = opts.onLog ?? (() => {})
  const params = opts.params ?? { networkId: 'main', dateUTC: todayUTC() }
  // Group Sender Keys (§8). Incoming SKDs on any 1:1 room feed this; `openGroup`
  // joins a group's topic. The manager is identity-scoped, like the self-topic watch.
  const groups = new GroupManager(id, params, opts.gkBackend)
  const viaMqtt = opts.transport === 'mqtt'
  if (viaMqtt && !opts.broker) throw new Error('transport "mqtt" needs a broker url')
  const dialT0 = Date.now()
  // Relay candidates for failover (libp2p only). `relays` first, else the single
  // `relay`. `activeRelay` tracks whichever we last connected through — netStatus
  // reports it, and the app shows which node is live.
  // `let`, not `const`: the node editor can replace this on a live session
  // (`setRelays`). Every dial reads it fresh, so a change lands on the next sweep.
  let candidates = (opts.relays?.length ? opts.relays : [opts.relay]).filter(Boolean)
  if (!viaMqtt && candidates.length === 0) throw new Error('startSession: no relay to dial')
  let activeRelay = candidates[0]
  const node: any = viaMqtt
    ? await createMqttPeer({ url: opts.broker!, onLog: opts.onLog })
    : await createPeer()
  /**
   * Dial, or re-dial. MQTT reconnects its one broker; libp2p sweeps the relay
   * candidates (first that connects wins) and remembers which one, so a dead or
   * hung primary fails over to the next and a recovered primary is preferred again.
   */
  const redial = async () => {
    if (viaMqtt) return node.reconnect()
    const connectedTo = await failoverDial(candidates, (addr, signal) => dial(node, addr, { signal }))
    if (connectedTo !== activeRelay) {
      log(`failover: connecting via ${connectedTo.slice(0, 46)}…`)
      activeRelay = connectedTo
      opts.onRelay?.(connectedTo)
    }
  }
  // The FIRST dial must be as resilient as re-dialing. A phone on a flaky/slow
  // mobile link — or one whose battery saver is throttling the tab — routinely
  // drops the opening connection, and a single attempt turned that into a hard
  // "login failed, refresh". Retry with backoff (~15 s budget), then surface the
  // error so a genuinely unreachable relay still fails rather than hanging.
  if (!viaMqtt) {
    const FIRST_DIAL_BACKOFF = [500, 1_000, 2_000, 4_000, 8_000]
    for (let i = 0; ; i++) {
      try { await redial(); break } catch (e: any) {
        if (i >= FIRST_DIAL_BACKOFF.length) throw e
        log(`initial dial failed (${e?.message ?? e}) — retry ${i + 1}/${FIRST_DIAL_BACKOFF.length} in ${FIRST_DIAL_BACKOFF[i]} ms`)
        await new Promise((r) => setTimeout(r, FIRST_DIAL_BACKOFF[i]))
      }
    }
  }
  const self = node.peerId.toString()
  log(`session up over ${viaMqtt ? 'MQTT' : 'libp2p'} in ${Date.now() - dialT0} ms as ${self.slice(0, 12)}…`)

  /** Every room open on this transport — refreshed, flushed and stopped together. */
  interface OpenRoom { refresh(): void; flushPending(): void; stop(): void; sendPresence(s: any): void }
  const rooms = new Set<OpenRoom>()

  // ---- the transport, watched out loud -------------------------------------
  // Losing the relay connection used to be invisible: rooms kept their state,
  // badges stayed green, presence took 90 s to expire, and messages went into a
  // socket that no longer existed. The only thing that noticed was the user,
  // once nothing had arrived for a while. So watch it, say so, and get back on
  // by ourselves instead of waiting for a tab to be focused.
  let link: LinkState = 'online'
  let redialing = false
  let closed = false
  const setLink = (s: LinkState) => {
    if (s === link) return
    link = s
    log(`link: ${s}`)
    opts.onLink?.(s)
  }
  const connected = () => {
    try { return node.getConnections().length > 0 } catch { return false }
  }
  /**
   * `force` is for the case where the transport SAYS it is connected and is not:
   * the connection object is there, nothing has written to it since the network
   * went away, and waiting for `connected()` to turn false would mean waiting
   * for a TCP timeout. Hang up first, then dial.
   */
  const reconnect = async (force = false) => {
    if (redialing || closed) return
    redialing = true
    setLink('reconnecting')
    if (force) {
      for (const c of node.getConnections()) { try { await c.close() } catch {} }
    }
    for (let i = 0; !closed && !connected(); i++) {
      try {
        await redial()
        break
      } catch (e: any) {
        const wait = REDIAL_BACKOFF[Math.min(i, REDIAL_BACKOFF.length - 1)]
        log(`re-dial failed (${e?.message ?? e}) — again in ${wait} ms`)
        // Past the first few tries this is a machine with no network at all;
        // saying "offline" is more honest than an endless "reconnecting".
        if (i >= 2) setLink('offline')
        await new Promise((r) => setTimeout(r, wait))
      }
    }
    redialing = false
    if (closed) return
    if (connected()) {
      setLink('online')
      log('relay connection restored — announcing and flushing what is waiting')
      for (const r of rooms) { r.refresh(); r.flushPending() } // oldest first: an outage must not reorder a backlog
    }
  }
  node.addEventListener?.('connection:close', () => {
    if (!closed && !connected()) { log('lost the relay connection'); void reconnect() }
  })
  // Belt and braces: events can be missed (a frozen tab wakes with a socket that
  // is dead but never fired a close), so look for ourselves as well.
  const linkWatch = setInterval(() => {
    if (closed) return
    if (!connected()) void reconnect()
    else setLink('online')
  }, 10_000)
  ;(linkWatch as any).unref?.()

  // ---- presence layer (light): one subscribe+announce watch per contact -----
  // Being visible to N contacts is N cheap watches on one transport, NOT N
  // handshakes. A contact is upgraded to a full room only on demand (`open`) or
  // when their EH-2 frame arrives (`onWantsConversation`); on `leave` it drops
  // back to a watch.
  interface Watched { peer: Peer; watch: PresenceWatch }
  const presence = new Map<string, Watched>() // key = peer.pub
  // The day a contact's handshake arrived on, remembered until we open the room
  // so it lands on the exact rotating topic the handshake is using (see `open`).
  // Time-bounded: only an upgrade opened promptly should override today, never a
  // handshake seen hours ago on a since-rotated topic.
  const upgradeDate = new Map<string, { date: string; at: number }>()
  const UPGRADE_DATE_TTL = 5 * 60_000
  // Per-pair rotation offset (§5.4), in seconds-of-day. Stable per pair so it is
  // computed once (from the same ss as the topic) and cached; a forced override
  // (`?rot=<hour>`) skips the derivation entirely so both test ends share it.
  const offsetCache = new Map<string, number>()
  /**
   * `ss = ECDH(IK_me, IK_peer)`, once per contact per session.
   *
   * Three things want it — the presence watch, the rotation offset and opening
   * the room — and on a HEM each derivation was a separate device round trip of
   * one to two seconds. A trace of one sign-in showed the identical secret being
   * fetched three times.
   *
   * The PROMISE is cached, not the result, so callers that arrive while the
   * device is still working share that call instead of starting another; that
   * race is what produced two of the three.
   *
   * Holding it for the session widens nothing: `ss` is rendezvous-only and
   * disjoint from every message-key DH (§4.3 note in CLAUDE.md), and the
   * presence watch already keeps it alive for exactly as long.
   */
  const ssCache = new Map<string, Promise<Uint8Array>>()
  const pairSecret = (peer: Peer): Promise<Uint8Array> => {
    let p = ssCache.get(peer.pub)
    if (!p) {
      p = id.ecdh(peer.pub, peer.kid)
      p.catch(() => ssCache.delete(peer.pub)) // a failed call must not be remembered as an answer
      ssCache.set(peer.pub, p)
    }
    return p
  }
  const offsetSecFor = async (peer: Peer): Promise<number> => {
    if (opts.forcedRotationSec != null) return opts.forcedRotationSec
    const cached = offsetCache.get(peer.pub)
    if (cached != null) return cached
    const off = await rotationOffsetSec(await pairSecret(peer), params)
    offsetCache.set(peer.pub, off)
    return off
  }
  let presenceHandlers: {
    onOnline?: (p: Peer) => void
    onOffline?: (p: Peer) => void
    onWantsConversation?: (p: Peer) => void
  } = {}
  const startWatch = async (peer: Peer) => {
    if (closed || presence.has(peer.pub)) return
    try {
      // One ecdh for the pair; the rotating watch derives each day's topic from
      // this secret (date only changes the HKDF info), never a second HSM call.
      // The rotation offset comes from the same secret (or the forced override).
      const ss = await pairSecret(peer)
      const offsetSec = opts.forcedRotationSec ?? await rotationOffsetSec(ss, params)
      offsetCache.set(peer.pub, offsetSec)
      const watch = watchPresenceRotating(node, self, (dateUTC) => presenceFromSecret(ss, { ...params, dateUTC }), {
        offsetMs: offsetSec * 1000,
        onOnline: () => presenceHandlers.onOnline?.(peer),
        onOffline: () => presenceHandlers.onOffline?.(peer),
        onIncomingHandshake: (_f, _from, dateUTC) => { upgradeDate.set(peer.pub, { date: dateUTC, at: Date.now() }); presenceHandlers.onWantsConversation?.(peer) },
        onLog: opts.onLog,
      })
      presence.set(peer.pub, { peer, watch })
    } catch (e: any) { log(`presence watch for ${peer.pub.slice(0, 12)}… failed: ${e?.message ?? e}`) }
  }
  const stopWatch = (pub: string) => { presence.get(pub)?.watch.stop(); presence.delete(pub); upgradeDate.delete(pub) }

  // The §9.1 rotating watch (declared here — shutdown stops it).
  let selfWatch: SelfWatch | null = null

  const shutdown = async (why: string) => {
    if (closed) return
    closed = true
    log(`session closing: ${why}`)
    for (const w of presence.values()) { try { w.watch.stop() } catch {} }
    presence.clear(); upgradeDate.clear()
    selfWatch?.stop()
    clearInterval(linkWatch)
    for (const r of rooms) { try { r.sendPresence('leave') } catch {} }
    await new Promise((r) => setTimeout(r, FLUSH_MS))
    for (const r of rooms) { try { r.stop() } catch {} }
    rooms.clear()
    try { await node.stop() } catch {}
  }

  // ---- §9.1: one active session per identity -------------------------------
  // Best effort by design: if the self-topic cannot be derived (a HEM that
  // refuses an ECDH against its own public key, say) the session runs on without
  // it. Losing the takeover rule is a nuisance; losing the chat is not an
  // acceptable trade for it.
  //
  // The self-DH is done ONCE — for a HEM identity that is the device call — and
  // each active day's topic + MAC key derive from it client-side, so the
  // rotating watch (`watchSelfSessionRotating`, which walks the date so §9.1
  // keeps firing across the rollover) costs no hardware round-trip. The instant
  // is the identity's own, derived from the self-DH the way a pair derives its
  // from the pair secret (§5.4) — every window computes the same one.
  if (opts.onSessionTakenOver) {
    try {
      const selfSs = await id.ecdh(id.pub)
      const selfOffsetMs = (await rotationOffsetSec(selfSs, params)) * 1000
      selfWatch = watchSelfSessionRotating(node, async (dateUTC) => {
        const p = { ...params, dateUTC }
        return { topic: await topicFromSecret(selfSs, p), macKey: await announceMacKey(selfSs, p) }
      }, self, {
        onLog: opts.onLog,
        offsetMs: selfOffsetMs,
        onTakenOver: (byPeer) => {
          void (async () => {
            await shutdown(`a second window of this identity appeared (${byPeer.slice(0, 12)}…)`)
            opts.onSessionTakenOver?.(byPeer)
          })()
        },
      })
    } catch (e: any) {
      log(`self-topic unavailable (${e?.message ?? e}) — running without the §9.1 takeover rule`)
    }
  }

  return {
    self,
    async open(peer: Peer, roomOpts: RoomOpts) {
      // The room's day is the pair's CURRENT rendezvous day (its rotation instant
      // is `midnight + offset`, §5.4), not the session's frozen `params.dateUTC`
      // — a session held across a rotation must open new rooms on the live topic,
      // coherent with the rotating presence watch. On an upgrade we use the day
      // the contact's handshake actually arrived on, so the room lands on the
      // exact topic the handshake is using (within the overlap the two can differ
      // by a day). The session's networkId is preserved.
      const pending = upgradeDate.get(peer.pub)
      upgradeDate.delete(peer.pub)
      const offsetSec = await offsetSecFor(peer) // §5.4 per-pair rotation offset (or forced)
      const dateUTC = pending && Date.now() - pending.at < UPGRADE_DATE_TTL
        ? pending.date
        : rendezvousDay(Date.now(), offsetSec * 1000)
      const liveParams = { ...params, dateUTC }
      // Upgrade: the full room does presence too, so retire the light watch while
      // the conversation is open — but HAND OFF the topic (keep the subscription
      // and its warm mesh) so the room does not have to re-graft. Restore a fresh
      // watch on leave.
      const wasWatched = presence.has(peer.pub)
      presence.get(peer.pub)?.watch.stop(false) // false = handoff, do not unsubscribe
      presence.delete(peer.pub)
      const ss = await pairSecret(peer) // paid for once; the watch and the offset used the same one
      const conv = await openRoom(id, peer, node, self, liveParams, {
        ss,
        ...roomOpts,
        // A group SKD on this 1:1 room feeds the group manager (§8), then the app
        // is told — but only AFTER applySkd resolves: the app's handler calls
        // openGroup, which needs the session applySkd creates. Racing them (fire
        // applySkd, notify synchronously) throws "unknown group" on the invite.
        // applySkd is keyed by the SENDER'S IDENTITY (IK pub), which the group's
        // `receive` uses to find the sender key (senderId = SHA-256(IK_pub)[0:8]).
        // `from` here is the transport PeerId, not the IK pub — so pass peer.pub.
        // EVERY consumer gets peer.pub, not just applySkd: the app compares the
        // sender against the roster (which is IK pubs) to decide whether a
        // metadata change came from the admin, and a PeerId can never match one.
        // Handing two different notions of "who" to two callers is how a group
        // rename silently did nothing.
        onGroupSkd: async (_from, skd) => { await groups.applySkd(peer.pub, skd); roomOpts.onGroupSkd?.(peer.pub, skd); opts.onGroupSkd?.(peer.pub, skd) },
        onGroupSkdReq: (_from, req) => { roomOpts.onGroupSkdReq?.(peer.pub, req); opts.onGroupSkdReq?.(peer.pub, req) },
      }, {
        log,
        onIsolated: () => { setLink('reconnecting'); void reconnect(true) },
        ensureConnected: async () => { if (!connected()) await reconnect() },
        register: (r: OpenRoom) => { rooms.add(r); return () => rooms.delete(r) },
      })
      return {
        ...conv,
        rotationOffsetSec: offsetSec,
        leave: async () => { await conv.leave(); if (wasWatched && !closed) await startWatch(peer) },
      }
    },
    async watchContacts(contacts: Peer[], handlers) {
      presenceHandlers = handlers
      for (const c of contacts) await startWatch(c)
    },
    unwatch(pub: string) { stopWatch(pub) },
    setRelays(list: string[]) {
      if (viaMqtt) return
      const next = list.filter(Boolean)
      if (!next.length) return // an empty list would leave nothing to dial
      candidates = next
      log(`node list updated (${next.length}): ${next.map((a) => a.match(/\/dns[46]\/([^/]+)/)?.[1] ?? a.slice(0, 24)).join(', ')}`)
      // Only being dropped from the list forces a switch. A reorder is a
      // preference for the next sweep, and hanging up a healthy connection to
      // honour it would cost a re-handshake for nothing.
      if (!next.includes(activeRelay)) {
        log('the active node is no longer on the list — re-dialing')
        void reconnect(true)
      }
    },
    netStatus() {
      let topics: string[] = []
      try { topics = [...(node.services?.pubsub?.getTopics?.() ?? [])] } catch {}
      let peers = 0
      try { peers = node.getConnections().length } catch {}
      return { transport: viaMqtt ? 'mqtt' : 'libp2p', relay: viaMqtt ? (opts.broker ?? '') : activeRelay, self, link, connected: connected(), peers, topics }
    },
    groups,
    async openGroup(gidHex: string, handlers: GroupRoomOpts) {
      const gs = groups.session(gidHex)
      if (!gs) throw new Error(`openGroup: unknown group ${gidHex.slice(0, 12)}…`)
      return joinGroup(node, gs, handlers)
    },
    async refresh() {
      if (!connected()) { log('back with no relay connection — re-dialing'); await reconnect() }
      for (const r of rooms) { r.refresh(); r.flushPending() }
      for (const w of presence.values()) w.watch.announce()
    },
    setOffline(offline: boolean) {
      if (offline) {
        log('the platform reports no network')
        setLink('offline')
        return
      }
      log('the platform reports the network is back — re-dialing')
      void reconnect(true)
    },
    close: () => shutdown('closed by the app'),
  }
}

/** What a room needs from the session that owns its transport. */
interface RoomHost {
  log: (m: string, level?: 'info' | 'debug') => void
  onIsolated: () => void
  ensureConnected: () => Promise<void>
  register: (r: { refresh(): void; flushPending(): void; stop(): void; sendPresence(s: any): void }) => () => void
}

/**
 * Join one room on an existing transport, and run the typing/away/leave presence
 * machine. The UI only renders (via the on* callbacks) and feeds intent.
 */
async function openRoom(
  id: Identity, peer: Peer, node: any, self: string, params: RoomParams, opts: RoomOpts, host: RoomHost,
): Promise<Conversation> {
  const log = opts.onLog ?? host.log
  log(`opening conversation: network=${params.networkId} date=${params.dateUTC} webrtc=${!!opts.webrtc}`)
  // In EH-2 mode the WebRTC offer cannot go out before the session exists —
  // signaling rides the room encrypted. So the plane is kicked when the
  // handshake completes, not (only) when presence says the peer joined.
  let plane: WebRTCPlane | null = null
  const onSecurity: Eh2Options['onState'] = (p, state) => {
    log(`security: ${state} with ${p.slice(0, 12)}…`)
    opts.onSecurity?.(p, state)
    if (state === 'established') plane?.onPeer(p)
  }
  const { topic, keys } = await deriveRoom(id, peer, params, { onState: onSecurity, ss: opts.ss })
  log(`room derived: topic ${topic.slice(0, 16)}…`)

  const room = joinChat(node, topic, keys, {
    onMessage: opts.onMessage,
    onTyping: opts.onTyping,
    // The plane is kicked from onSecurity (see above), not on presence 'join':
    // WebRTC signaling needs a live session, which a join does not imply.
    onPresence: opts.onPresence,
    onReaction: opts.onReaction,
    onEdit: opts.onEdit,
    onKnock: opts.onKnock,
    onFile: opts.onFile,
    onSignal: (from, env) => plane?.onSignal(from, env),
    // Group Sender-Key Distribution rides this 1:1 ratchet (it authenticates
    // the invite); without forwarding it the invite reaches the room, decodes,
    // and dies in the default no-op — the receiver never surfaces the group.
    onGroupSkd: opts.onGroupSkd,
    onGroupSkdReq: opts.onGroupSkdReq,
    // The peer reloaded: rebind the data plane onto the PeerId that is alive.
    onPeerReplaced: (old, now) => { log(`peer ${old.slice(0, 12)}… is now ${now.slice(0, 12)}… — rebinding the data plane`); plane?.onPeer(now) },
    heartbeatMs: opts.heartbeatMs,
    onLog: opts.onLog,
    onDelivered: (mid, ms) => { log(`delivered ${mid} in ${ms} ms`); opts.onDelivered?.(mid, ms) },
    onUndelivered: (mid) => { log(`UNDELIVERED ${mid} — peer never confirmed`); opts.onUndelivered?.(mid) },
    onLateDelivered: (mid, ms) => { log(`late: ${mid} arrived after all, ${Math.round(ms / 1000)}s`); opts.onLateDelivered?.(mid, ms) },
    onStall: () => plane?.demote(),
    // Heartbeats reaching nobody is the honest signal that the transport is
    // dead — `getConnections()` still reports a connection nothing has tried to
    // write to, which is why an offline tab used to look perfectly healthy.
    onIsolated: host.onIsolated,
    onForeign: (p) => { log(`foreign peer in the room: ${p.slice(0, 12)}… — its handshake does not verify`); opts.onForeign?.(p) },
  })
  // Feature-detect the webview's WebRTC: WebKitGTK (the Tauri shell on Linux) ships
  // without RTCPeerConnection, so attaching the plane would throw `new
  // RTCPeerConnection` mid-handshake. Without it, content simply stays on the relay
  // (GossipSub) — the fallback the plane would have used anyway.
  const webRtcOk = typeof RTCPeerConnection !== 'undefined'
  if (opts.webrtc && webRtcOk) plane = attachWebRTC(room, self, { iceServers: opts.iceServers, onState: (st) => { log(`webrtc: ${st}`); opts.onWebrtcState?.(st) } })
  else if (opts.webrtc) log('WebRTC unavailable in this webview — content stays on the relay')
  const unregister = host.register(room)

  let typingSent = false
  let away = false
  let tT: any
  let aT: any
  const stopTyping = () => { clearTimeout(tT); if (typingSent) { typingSent = false; room.sendTyping('stop') } }
  const armAway = () => { clearTimeout(aT); aT = setTimeout(() => { away = true; stopTyping(); room.sendPresence('away') }, AWAY_MS) }
  const noteActivity = () => {
    if (away) { away = false; room.sendPresence('active') }
    if (!typingSent) { typingSent = true; room.sendTyping('start') }
    clearTimeout(tT); tT = setTimeout(stopTyping, TYPING_STOP_MS)
    armAway()
  }
  const noteAway = () => { stopTyping(); clearTimeout(aT); if (!away) { away = true; room.sendPresence('away') } }
  // The half of noteActivity that raising the window can honestly claim:
  // presence, without the typing notice. Reported live — coming back from the
  // tray left the peer seeing "away" until the first keystroke, because the
  // only road out of `away` ran through noteActivity, which also says
  // "pisze…" about somebody who has not touched a key.
  const noteBack = () => { if (away) { away = false; room.sendPresence('active') } armAway() }

  return {
    peerId: self,
    topic,
    sendText: (body, re) => { const mid = room.sendText(body, re); stopTyping(); return mid },
    resend: (mid) => room.resend(mid),
    sendReaction: (toId, emoji) => room.sendReaction(toId, emoji),
    sendEdit: (toId, body) => room.sendEdit(toId, body),
    sendKnock: () => room.sendKnock(),
    sendGroupSkd: (skd) => room.sendGroupSkd(skd),
    sendGroupSkdReq: (gid, epoch) => room.sendGroupSkdReq(gid, epoch),
    sendFile: (f) => room.sendFile(f),
    noteActivity,
    noteAway,
    noteBack,
    refresh: async () => {
      // A tab that was hidden for a while may come back with its transport dead:
      // throttling turns into freezing (laptop asleep, app in the background)
      // and the relay connection goes with it. Nothing downstream notices, so
      // the room looks alive while nothing can leave it.
      await host.ensureConnected()
      room.refresh()
      room.flushPending()
      if (away) { away = false; room.sendPresence('active') }
    },
    who: () => room.who(),
    secured: () => room.secured(),
    leave: async () => {
      log(`leaving room ${topic.slice(0, 12)}…`)
      clearTimeout(tT); clearTimeout(aT)
      unregister()
      try { room.sendPresence('leave') } catch {}
      await new Promise((r) => setTimeout(r, FLUSH_MS))
      try { plane?.stop() } catch {}
      try { room.stop() } catch {}
    },
  }
}

/**
 * One conversation on a transport of its own — the shape everything used before
 * sessions existed, kept for the CLI and the tests. `leave()` takes the whole
 * session with it, which is what a single-room caller means by leaving.
 */
export async function openConversation(id: Identity, peer: Peer, opts: OpenOpts): Promise<Conversation> {
  const session = await startSession(id, {
    relay: opts.relay,
    relays: opts.relays,
    transport: opts.transport,
    broker: opts.broker,
    params: opts.params,
    onLog: opts.onLog,
    onLink: opts.onLink,
    onSessionTakenOver: opts.onSessionTakenOver,
  })
  const conv = await session.open(peer, opts)
  return {
    ...conv,
    refresh: () => session.refresh(),
    leave: async () => { await conv.leave(); await session.close() },
  }
}
